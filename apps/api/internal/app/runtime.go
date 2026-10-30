package app

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"satvey/inspect/internal/networkpolicy"

	"github.com/aws/aws-sdk-go-v2/service/s3"
)

func integrationPolicy() networkpolicy.Policy {
	return networkpolicy.Policy{AllowedHosts: strings.Split(os.Getenv("INTEGRATION_ALLOWED_HOSTS"), ","), PrivateHosts: strings.Split(os.Getenv("INTEGRATION_PRIVATE_HOSTS"), ",")}
}
func integrationClient(timeout time.Duration) *http.Client {
	if os.Getenv("APP_ENV") == "production" {
		return integrationPolicy().Client(timeout)
	}
	return &http.Client{Timeout: timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return fmt.Errorf("doorverwijzingen zijn niet toegestaan") }}
}

func trustedProxy(ip netip.Addr) bool {
	for _, raw := range strings.Split(os.Getenv("TRUSTED_PROXY_CIDRS"), ",") {
		p, e := netip.ParsePrefix(strings.TrimSpace(raw))
		if e == nil && p.Contains(ip.Unmap()) {
			return true
		}
	}
	return false
}
func clientIP(r *http.Request) string {
	host, _, e := net.SplitHostPort(r.RemoteAddr)
	if e != nil {
		host = r.RemoteAddr
	}
	peer, e := netip.ParseAddr(host)
	if e != nil {
		return "unknown"
	}
	peer = peer.Unmap()
	if !trustedProxy(peer) {
		return peer.String()
	}
	chain := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
	if len(chain) > 16 {
		return peer.String()
	}
	for i := len(chain) - 1; i >= 0; i-- {
		next, e := netip.ParseAddr(strings.TrimSpace(chain[i]))
		if e != nil {
			return peer.String()
		}
		peer = next.Unmap()
		if !trustedProxy(peer) {
			break
		}
	}
	return peer.String()
}

var hashingSlots = make(chan struct{}, 4)

func acquireHash(ctx context.Context) (func(), error) {
	select {
	case hashingSlots <- struct{}{}:
		return func() { <-hashingSlots }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
		return nil, fail(429, "Te veel aanvragen. Probeer later opnieuw.")
	}
}

type httpMetrics struct {
	requests, failures atomic.Uint64
	active             atomic.Int64
}
type trackedResponse struct {
	http.ResponseWriter
	status int
}

func (w *trackedResponse) WriteHeader(code int) {
	if w.status != 0 {
		return
	}
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}
func (w *trackedResponse) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(200)
	}
	return w.ResponseWriter.Write(b)
}
func (w *trackedResponse) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (a *app) observe(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		a.metrics.requests.Add(1)
		a.metrics.active.Add(1)
		requestID := id()
		w.Header().Set("X-Request-ID", requestID)
		tw := &trackedResponse{ResponseWriter: w}
		defer func() {
			if recovered := recover(); recovered != nil {
				if tw.status == 0 {
					send(tw, 500, map[string]string{"error": "Er ging iets mis. Probeer opnieuw."})
				}
				slog.Error("request panic", "request_id", requestID)
			}
			a.metrics.active.Add(-1)
			status := tw.status
			if status == 0 {
				status = 200
			}
			if status >= 500 {
				a.metrics.failures.Add(1)
			}
			// Log route templates, never invitation/reset tokens, request bodies or query strings.
			slog.Info("http request", "request_id", requestID, "method", r.Method, "route", r.Pattern, "status", status, "duration_ms", time.Since(started).Milliseconds())
		}()
		next.ServeHTTP(tw, r)
	})
}
func (a *app) live(w http.ResponseWriter, r *http.Request) error {
	send(w, 200, map[string]string{"status": "ok"})
	return nil
}
func (a *app) ready(w http.ResponseWriter, r *http.Request) error {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	if a.db == nil || a.db.Ping(ctx) != nil {
		return fail(503, "Database niet beschikbaar")
	}
	if _, e := a.storage.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: &a.bucket}); e != nil {
		return fail(503, "Opslag niet beschikbaar")
	}
	endpoint := a.pdfURL
	if endpoint == "" {
		endpoint = os.Getenv("PDF_RENDERER_URL")
	}
	if endpoint != "" {
		req, _ := http.NewRequestWithContext(ctx, "GET", strings.TrimRight(endpoint, "/")+"/health", nil)
		if req == nil {
			return fail(503, "PDF niet beschikbaar")
		}
		res, e := (&http.Client{Timeout: 3 * time.Second}).Do(req)
		if e != nil {
			return fail(503, "PDF niet beschikbaar")
		}
		res.Body.Close()
		if res.StatusCode != 200 {
			return fail(503, "PDF niet beschikbaar")
		}
	}
	send(w, 200, map[string]string{"status": "ok"})
	return nil
}
func (a *app) metricsHandler(w http.ResponseWriter, r *http.Request) error {
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	var b strings.Builder
	fmt.Fprintf(&b, "satvey_http_requests_total %d\nsatvey_http_failures_total %d\nsatvey_http_active %d\n", a.metrics.requests.Load(), a.metrics.failures.Load(), a.metrics.active.Load())
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	rows, e := a.db.Query(ctx, `SELECT kind,status,count(*),COALESCE(EXTRACT(EPOCH FROM now()-min(queued_at)),0)::float8 FROM (
 SELECT 'image' AS kind,status,next_attempt_at AS queued_at FROM processing_jobs WHERE status IN ('pending','processing','failed')
 UNION ALL SELECT 'scope',status,next_attempt_at FROM scope_jobs WHERE status IN ('pending','processing','failed')
 UNION ALL SELECT 'audio',status,next_attempt_at FROM transcription_jobs WHERE status IN ('pending','processing','failed')
 UNION ALL SELECT 'mail',status,next_attempt_at FROM mail_jobs WHERE status IN ('pending','processing','failed')
 UNION ALL SELECT 'property',status,next_attempt_at FROM property_sync_jobs WHERE status IN ('pending','processing','failed')) j GROUP BY kind,status`)
	if e != nil {
		return e
	}
	defer rows.Close()
	for rows.Next() {
		var kind, status string
		var count int
		var age float64
		if e = rows.Scan(&kind, &status, &count, &age); e != nil {
			return e
		}
		fmt.Fprintf(&b, "satvey_jobs{kind=%s,status=%s} %d\nsatvey_job_oldest_seconds{kind=%s,status=%s} %.0f\n", strconv.Quote(kind), strconv.Quote(status), count, strconv.Quote(kind), strconv.Quote(status), max(0, age))
	}
	if e = rows.Err(); e != nil {
		return e
	}
	_, e = w.Write([]byte(b.String()))
	return e
}
