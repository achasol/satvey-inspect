package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrations embed.FS

type app struct {
	transcribe     func(context.Context, string, string, string) (transcriptionResult, error) // Injectable shared-API adapter for worker tests.
	db             *pgxpool.Pool
	storage        *s3.Client
	bucket, origin string
	secure         bool
	limiter        loginLimiter
	analyzer       imageAnalyzer
	imageProvider  string
	workerOrg      string // Tests can restrict processing to their disposable tenant.
	pdfURL         string // Injectable renderer endpoint for contract tests.
}
type apiError struct {
	Status  int
	Message string
}

func (e apiError) Error() string            { return e.Message }
func fail(status int, message string) error { return apiError{status, message} }
func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
func id() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	h := hex.EncodeToString(b)
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}
func token() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
func hash(s string) string { v := sha256.Sum256([]byte(s)); return hex.EncodeToString(v[:]) }
func validID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, c := range s {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return false
			}
		} else if !strings.ContainsRune("0123456789abcdef", c) {
			return false
		}
	}
	return true
}
func send(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if data != nil {
		_ = json.NewEncoder(w).Encode(data)
	}
}
func readJSON(w http.ResponseWriter, r *http.Request, v any) error {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		return fail(415, "JSON verwacht")
	}
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	d.DisallowUnknownFields()
	if d.Decode(v) != nil {
		return fail(400, "Ongeldige invoer")
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		return fail(400, "Ongeldige invoer")
	}
	return nil
}

type handler func(http.ResponseWriter, *http.Request) error

func (a *app) wrap(fn handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		if r.Method != "GET" && r.Method != "HEAD" {
			origin := r.Header.Get("Origin")
			allowed := origin == "" || origin == a.origin
			for _, trusted := range strings.Split(os.Getenv("TRUSTED_ORIGINS"), ",") {
				if trusted != "" && origin == trusted {
					allowed = true
				}
			}
			if r.Header.Get("X-Satvey-Request") != "1" || !allowed {
				send(w, 403, map[string]string{"error": "Verzoek niet toegestaan"})
				return
			}
		}
		if err := fn(w, r); err != nil {
			var e apiError
			switch {
			case errors.As(err, &e):
			case errors.Is(err, pgx.ErrNoRows):
				e = apiError{404, "Niet gevonden"}
			default:
				slog.Error("request failed", "method", r.Method, "path", r.URL.Path, "error", err)
				e = apiError{500, "Opslaan mislukt. Probeer opnieuw."}
			}
			send(w, e.Status, map[string]string{"error": e.Message})
		}
	}
}
func (a *app) routes() http.Handler {
	m := http.NewServeMux()
	m.HandleFunc("GET /api/v1/health", a.wrap(func(w http.ResponseWriter, r *http.Request) error {
		if err := a.db.Ping(r.Context()); err != nil {
			return err
		}
		send(w, 200, map[string]string{"status": "ok"})
		return nil
	}))
	m.HandleFunc("POST /api/v1/auth/login", a.wrap(a.login))
	m.HandleFunc("POST /api/v1/auth/discover", a.wrap(a.discoverLogin))
	m.HandleFunc("POST /api/v1/auth/logout", a.wrap(a.logout))
	m.HandleFunc("GET /api/v1/me", a.wrap(a.me))
	m.HandleFunc("POST /api/v1/auth/password", a.wrap(a.changePassword))
	m.HandleFunc("GET /api/v1/auth/oidc/start", a.wrap(a.oidcStart))
	m.HandleFunc("GET /api/v1/auth/oidc/callback", a.wrap(a.oidcCallback))
	m.HandleFunc("GET /api/v1/auth/oidc/link", a.wrap(a.identityLinkInfo))
	m.HandleFunc("POST /api/v1/auth/oidc/link", a.wrap(a.completeIdentityLink))
	m.HandleFunc("GET /api/v1/invitations/{token}", a.wrap(a.invitationInfo))
	m.HandleFunc("POST /api/v1/invitations/accept", a.wrap(a.acceptInvitation))
	m.HandleFunc("GET /api/v1/orgs/{org}/members", a.wrap(a.members))
	m.HandleFunc("GET /api/v1/orgs/{org}/roles", a.wrap(a.roles))
	m.HandleFunc("POST /api/v1/orgs/{org}/roles", a.wrap(a.createRole))
	m.HandleFunc("PUT /api/v1/orgs/{org}/roles/{role}", a.wrap(a.updateRole))
	m.HandleFunc("DELETE /api/v1/orgs/{org}/roles/{role}", a.wrap(a.deleteRole))
	m.HandleFunc("PUT /api/v1/orgs/{org}/members/{user}", a.wrap(a.updateMember))
	m.HandleFunc("POST /api/v1/orgs/{org}/invitations", a.wrap(a.invite))
	m.HandleFunc("PUT /api/v1/orgs/{org}/sso", a.wrap(a.configureSSO))
	m.HandleFunc("GET /api/v1/orgs/{org}/sso", a.wrap(a.ssoSettings))
	m.HandleFunc("GET /api/v1/orgs/{org}/properties", a.wrap(a.catalog))
	m.HandleFunc("GET /api/v1/orgs/{org}/properties/{property}", a.wrap(a.propertyDetail))
	m.HandleFunc("POST /api/v1/orgs/{org}/properties/{property}/refresh", a.wrap(a.refreshProperty))
	m.HandleFunc("POST /api/v1/orgs/{org}/properties/{property}/link", a.wrap(a.linkProperty))
	m.HandleFunc("GET /api/v1/orgs/{org}/property-sources", a.wrap(a.propertySources))
	m.HandleFunc("POST /api/v1/orgs/{org}/property-sources", a.wrap(a.savePropertySource))
	m.HandleFunc("PUT /api/v1/orgs/{org}/property-sources/{source}", a.wrap(a.savePropertySource))
	m.HandleFunc("POST /api/v1/orgs/{org}/property-sources/{source}/test", a.wrap(a.testPropertySource))
	m.HandleFunc("POST /api/v1/orgs/{org}/property-sources/{source}/sync", a.wrap(a.syncPropertySource))
	m.HandleFunc("GET /api/v1/orgs/{org}/property-import-template", a.wrap(a.propertyCSVTemplate))
	m.HandleFunc("POST /api/v1/orgs/{org}/property-sources/{source}/imports", a.wrap(a.previewPropertyImport))
	m.HandleFunc("POST /api/v1/orgs/{org}/property-sources/{source}/imports/{import}/confirm", a.wrap(a.confirmPropertyImport))
	m.HandleFunc("POST /api/v1/orgs/{org}/inspections/{inspection}/property-context", a.wrap(a.adoptPropertyContext))
	m.HandleFunc("GET /api/v1/orgs/{org}/elements", a.wrap(a.elements))
	m.HandleFunc("POST /api/v1/orgs/{org}/elements", a.wrap(a.saveElement))
	m.HandleFunc("PUT /api/v1/orgs/{org}/elements/{element}", a.wrap(a.saveElement))
	m.HandleFunc("GET /api/v1/orgs/{org}/formats", a.wrap(a.formatsList))
	m.HandleFunc("POST /api/v1/orgs/{org}/formats", a.wrap(a.createFormat))
	m.HandleFunc("GET /api/v1/orgs/{org}/formats/{format}", a.wrap(a.formatDetail))
	m.HandleFunc("PUT /api/v1/orgs/{org}/formats/{format}", a.wrap(a.updateFormat))
	m.HandleFunc("POST /api/v1/orgs/{org}/formats/{format}/publish", a.wrap(a.publishFormat))
	m.HandleFunc("POST /api/v1/orgs/{org}/formats/{format}/revisions", a.wrap(a.reviseFormat))
	m.HandleFunc("PUT /api/v1/orgs/{org}/inspections/{inspection}/answers/{answer}", a.wrap(a.saveFormatAnswer))
	m.HandleFunc("PUT /api/v1/orgs/{org}/inspections/{inspection}/rooms/{room}/approval", a.wrap(a.approveFormatScope))
	m.HandleFunc("POST /api/v1/orgs/{org}/inspections/{inspection}/rooms/{room}/analysis", a.wrap(a.formatScopeAction))
	m.HandleFunc("POST /api/v1/orgs/{org}/inspections/{inspection}/media/{media}/transcription", a.wrap(a.transcriptionAction))
	m.HandleFunc("GET /api/v1/orgs/{org}/norms", a.wrap(a.normsList))
	m.HandleFunc("POST /api/v1/orgs/{org}/norms", a.wrap(a.createNorm))
	m.HandleFunc("GET /api/v1/orgs/{org}/norms/benchmark", a.wrap(a.normBenchmark))
	m.HandleFunc("GET /api/v1/orgs/{org}/norms/{norm}", a.wrap(a.normDetail))
	m.HandleFunc("PUT /api/v1/orgs/{org}/norms/{norm}", a.wrap(a.updateNorm))
	m.HandleFunc("POST /api/v1/orgs/{org}/norms/{norm}/publish", a.wrap(a.publishNorm))
	m.HandleFunc("POST /api/v1/orgs/{org}/norms/{norm}/revisions", a.wrap(a.reviseNorm))
	m.HandleFunc("PUT /api/v1/orgs/{org}/norm-assets/{asset}", a.wrap(a.uploadNormAsset))
	m.HandleFunc("GET /api/v1/orgs/{org}/norm-assets/{asset}", a.wrap(a.downloadNormAsset))
	m.HandleFunc("PUT /api/v1/orgs/{org}/inspections/{inspection}/assessments/{assessment}", a.wrap(a.reviewNormAssessment))
	m.HandleFunc("PUT /api/v1/orgs/{org}/inspections/{inspection}/media/{media}/transcript", a.wrap(a.saveTranscript))
	m.HandleFunc("POST /api/v1/orgs/{org}/properties", a.wrap(a.createProvisionalProperty))
	m.HandleFunc("GET /api/v1/orgs/{org}/inspections", a.wrap(a.inspections))
	m.HandleFunc("POST /api/v1/orgs/{org}/inspections", a.wrap(a.createInspection))
	m.HandleFunc("GET /api/v1/orgs/{org}/inspections/{inspection}", a.wrap(a.inspection))
	m.HandleFunc("DELETE /api/v1/orgs/{org}/inspections/{inspection}", a.wrap(a.deleteInspection))
	m.HandleFunc("POST /api/v1/orgs/{org}/inspections/{inspection}/rooms", a.wrap(a.createRoom))
	m.HandleFunc("POST /api/v1/orgs/{org}/inspections/{inspection}/batches", a.wrap(a.createBatch))
	m.HandleFunc("PUT /api/v1/orgs/{org}/inspections/{inspection}/batches/{batch}", a.wrap(a.updateBatch))
	m.HandleFunc("POST /api/v1/orgs/{org}/inspections/{inspection}/batches/{batch}/analysis", a.wrap(a.retryAnalysis))
	m.HandleFunc("PUT /api/v1/orgs/{org}/inspections/{inspection}/batches/{batch}/media/{media}", a.wrap(a.upload))
	m.HandleFunc("GET /api/v1/orgs/{org}/inspections/{inspection}/media/{media}/annotations", a.wrap(a.photoAnnotations))
	m.HandleFunc("PUT /api/v1/orgs/{org}/inspections/{inspection}/media/{media}/annotations", a.wrap(a.photoAnnotations))
	m.HandleFunc("GET /api/v1/orgs/{org}/media/{media}", a.wrap(a.download))
	m.HandleFunc("POST /api/v1/orgs/{org}/inspections/{inspection}/batches/{batch}/observations", a.wrap(a.createObservation))
	m.HandleFunc("PUT /api/v1/orgs/{org}/inspections/{inspection}/observations/{observation}", a.wrap(a.updateObservation))
	m.HandleFunc("POST /api/v1/orgs/{org}/inspections/{inspection}/report", a.wrap(a.finalise))
	m.HandleFunc("GET /api/v1/orgs/{org}/inspections/{inspection}/report", a.wrap(a.report))
	m.HandleFunc("POST /api/v1/orgs/{org}/inspections/{inspection}/report/pdf", a.wrap(a.reportPDF))
	return m
}
func migrate(ctx context.Context, db *pgxpool.Pool) error {
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(8273651)"); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"); err != nil {
		return err
	}
	files, _ := migrations.ReadDir("migrations")
	for _, f := range files {
		var exists bool
		if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE name=$1)", f.Name()).Scan(&exists); err != nil {
			return err
		}
		if exists {
			continue
		}
		b, _ := migrations.ReadFile("migrations/" + f.Name())
		if _, err = tx.Exec(ctx, string(b)); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, "INSERT INTO schema_migrations(name) VALUES($1)", f.Name()); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	db, err := pgxpool.New(ctx, env("DATABASE_URL", "postgres://satvey:satvey@localhost:5432/satvey?sslmode=disable"))
	if err != nil {
		return err
	}
	defer db.Close()
	origin := strings.TrimRight(env("APP_URL", "http://localhost:5173"), "/")
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return fmt.Errorf("invalid APP_URL")
	}
	a := &app{db: db, origin: origin, secure: u.Scheme == "https", bucket: env("S3_BUCKET", "satvey-evidence")}
	a.imageProvider, a.analyzer, err = configuredAnalyzer()
	if err != nil {
		return err
	}
	a.storage = s3.New(s3.Options{Region: env("S3_REGION", "us-east-1"), BaseEndpoint: aws.String(env("S3_ENDPOINT", "http://localhost:9000")), UsePathStyle: true, Credentials: credentials.NewStaticCredentialsProvider(env("S3_ACCESS_KEY", "satvey-local"), env("S3_SECRET_KEY", "satvey-local-secret-change-me"), "")})
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "migrate":
			return migrate(ctx, db)
		case "storage-init":
			_, err := a.storage.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: &a.bucket})
			if err == nil {
				return nil
			}
			_, err = a.storage.CreateBucket(ctx, &s3.CreateBucketInput{Bucket: &a.bucket})
			return err
		case "bootstrap":
			return a.bootstrap(ctx)
		default:
			return fmt.Errorf("unknown command")
		}
	}
	if err = db.Ping(ctx); err != nil {
		return err
	}
	go a.worker(ctx)
	srv := &http.Server{Addr: ":8080", Handler: a.routes(), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 3 * time.Minute, WriteTimeout: 3 * time.Minute, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16384}
	go func() {
		<-ctx.Done()
		c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(c)
	}()
	slog.Info("API listening", "address", ":8080")
	err = srv.ListenAndServe()
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
func main() {
	if err := run(); err != nil {
		slog.Error("startup failed", "error", err)
		os.Exit(1)
	}
}
