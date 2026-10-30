package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestForwardedClientIdentityTrustBoundary(t *testing.T) {
	t.Setenv("TRUSTED_PROXY_CIDRS", "172.30.0.2/32,172.30.0.3/32")
	for _, tc := range []struct{ peer, forwarded, want string }{{"198.51.100.2:1234", "1.2.3.4", "198.51.100.2"}, {"172.30.0.3:1234", "198.51.100.2, 172.30.0.2", "198.51.100.2"}, {"172.30.0.3:1234", "1.2.3.4, 198.51.100.2", "198.51.100.2"}, {"172.30.0.3:1234", "bad", "172.30.0.3"}, {"[::1]:1234", "1.2.3.4", "::1"}} {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = tc.peer
		r.Header.Set("X-Forwarded-For", tc.forwarded)
		if got := clientIP(r); got != tc.want {
			t.Fatalf("got %s want %s", got, tc.want)
		}
	}
}
func TestLivenessDoesNotRequireDependenciesAndRequestIDsAreUnique(t *testing.T) {
	a := &app{}
	var previous string
	for range 2 {
		r := httptest.NewRequest("GET", "/api/v1/health/live", nil)
		w := httptest.NewRecorder()
		a.routes().ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatal(w.Code)
		}
		current := w.Header().Get("X-Request-ID")
		if !validID(current) || current == previous {
			t.Fatal("invalid request identity")
		}
		previous = current
	}
}
func TestPanicReturnsSafeError(t *testing.T) {
	a := &app{}
	h := a.observe(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("secret-token") }))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/", nil))
	if w.Code != 500 || strings.Contains(w.Body.String(), "secret-token") {
		t.Fatal(w.Code, w.Body.String())
	}
}
func TestHashingConcurrencyIsBounded(t *testing.T) {
	var releases []func()
	for range cap(hashingSlots) {
		release, e := acquireHash(context.Background())
		if e != nil {
			t.Fatal(e)
		}
		releases = append(releases, release)
	}
	defer func() {
		for _, release := range releases {
			release()
		}
	}()
	if _, e := acquireHash(context.Background()); e == nil {
		t.Fatal("unbounded password hashing")
	}
}
func TestStrictJSONAndBodyLimits(t *testing.T) {
	for _, tc := range []struct {
		content, body string
		want          int
	}{{"application/jsonp", "{}", 415}, {"application/json", "{} {}", 400}, {"application/json", `{"unknown":true}`, 400}, {"application/json", `{"title":"` + strings.Repeat("x", 1<<20) + `"}`, 413}} {
		r := httptest.NewRequest("POST", "/", strings.NewReader(tc.body))
		r.Header.Set("Content-Type", tc.content)
		var value struct {
			Title string `json:"title"`
		}
		e := readJSON(httptest.NewRecorder(), r, &value)
		if e == nil {
			t.Fatal("invalid JSON accepted")
		}
		if status, ok := e.(apiError); !ok || status.Status != tc.want {
			t.Fatal(e)
		}
	}
}
