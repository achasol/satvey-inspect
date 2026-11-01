package veradelivery

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func testClient(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	server := httptest.NewTLSServer(handler)
	t.Cleanup(server.Close)
	return &Client{HTTP: server.Client(), Secret: "test-client-secret", Config: Config{OnderhoudURL: server.URL + "/onderhoud/v4", DossierURL: server.URL + "/dossier/v4", VastgoedURL: server.URL + "/vastgoed/v4", TokenURL: server.URL + "/oauth/token", ClientID: "test", Organisation: "SATVEY", Administration: "TEST"}}
}
func respond(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if value != nil {
		_ = json.NewEncoder(w).Encode(value)
	}
}
func sourceRecord() map[string]any {
	return map[string]any{"idExtern": "source", "idOrganisatie": "SATVEY", "idAdministratie": "TEST", "omschrijving": "Herstel kraan"}
}

func TestRevokedDuringAuthenticationStopsResourceRequest(t *testing.T) {
	var revoked atomic.Bool
	var resources atomic.Int32
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/oauth/token" {
			revoked.Store(true)
			respond(w, 200, map[string]string{"access_token": "token", "token_type": "Bearer"})
			return
		}
		resources.Add(1)
		respond(w, 200, map[string]any{"id": "unit"})
	})
	c.BeforeRequest = func() error {
		if revoked.Load() {
			return blocked("Bestemming uitgeschakeld")
		}
		return nil
	}
	if _, e := c.Read(context.Background(), "eenheden", "unit"); e == nil || !revoked.Load() || resources.Load() != 0 {
		t.Fatal("sent a resource request after revocation during token acquisition")
	}
}

func TestTokenRefreshAndScopeFailures(t *testing.T) {
	tokens := 0
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/oauth/token" {
			client, secret, _ := r.BasicAuth()
			if client != "test" || secret != "test-client-secret" {
				t.Error("missing token credentials")
			}
			tokens++
			respond(w, 200, map[string]any{"access_token": []string{"one", "two"}[min(tokens-1, 1)], "token_type": "Bearer"})
			return
		}
		if _, _, ok := r.BasicAuth(); ok {
			t.Error("client secret leaked to resource endpoint")
		}
		if r.Header.Get("Authorization") == "Bearer one" {
			w.WriteHeader(401)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/forbidden") {
			w.WriteHeader(403)
			return
		}
		respond(w, 200, map[string]any{"id": "unit"})
	})
	if e := c.ValidateUnit(context.Background(), c.resourceURL("eenheden")+"/unit"); e != nil {
		t.Fatal(e)
	}
	if tokens != 2 {
		t.Fatalf("refreshed %d times", tokens)
	}
	_, e := c.Read(context.Background(), "eenheden", "forbidden")
	var remote *Error
	if !errors.As(e, &remote) || remote.Temporary || tokens != 2 {
		t.Fatal("scope failure was retried or token repeatedly refreshed")
	}
}

func TestLostAcknowledgementReconcilesWithoutAnotherCreate(t *testing.T) {
	var saved map[string]any
	posts := 0
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/oauth/token":
			respond(w, 200, map[string]string{"access_token": "token", "token_type": "Bearer"})
		case r.Method == "POST":
			posts++
			_ = json.NewDecoder(r.Body).Decode(&saved)
			saved["id"] = "receiver-42"
			w.Header().Set("Retry-After", "7")
			respond(w, 503, map[string]string{"code": "AFTER_COMMIT"})
		case r.URL.RawQuery != "":
			if saved == nil {
				respond(w, 200, []any{})
			} else {
				respond(w, 200, []any{saved})
			}
		default:
			respond(w, 200, saved)
		}
	})
	_, e := c.Ensure(context.Background(), "onderhoudstaken", sourceRecord())
	var remote *Error
	if !errors.As(e, &remote) || !remote.Temporary || remote.RetryAfter != 7*time.Second {
		t.Fatalf("wrong retry classification: %v", e)
	}
	row, e := c.Ensure(context.Background(), "onderhoudstaken", sourceRecord())
	if e != nil || row["id"] != "receiver-42" || posts != 1 {
		t.Fatalf("duplicated accepted create: posts=%d error=%v", posts, e)
	}
	changed := sourceRecord()
	changed["omschrijving"] = "Ander werk"
	if _, e = c.Ensure(context.Background(), "onderhoudstaken", changed); e == nil {
		t.Fatal("silently reused a conflicting source identity")
	}
}

func TestLinkPreservesReceiverAssociationsAndExecutionStatus(t *testing.T) {
	stored := map[string]any{"id": "request", "status": map[string]any{"code": "IN_UITVOERING"}, "onderhoudstaken": []any{map[string]any{"id": "external-task"}}}
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/oauth/token" {
			respond(w, 200, map[string]string{"access_token": "token", "token_type": "Bearer"})
			return
		}
		if r.Method == "PATCH" {
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if _, ok := body["status"]; ok {
				t.Error("execution status was overwritten")
			}
			for k, v := range body {
				stored[k] = v
			}
			w.WriteHeader(200)
			return
		}
		respond(w, 200, stored)
	})
	if e := c.Link(context.Background(), "onderhoudsverzoeken", "request", map[string]any{"onderhoudstaken": []any{map[string]any{"id": "satvey-task"}}}); e != nil {
		t.Fatal(e)
	}
	if len(stored["onderhoudstaken"].([]any)) != 2 || stored["status"].(map[string]any)["code"] != "IN_UITVOERING" {
		t.Fatal("receiver-owned work was removed or reset")
	}
}

func TestAmbiguousIdentityAndUntrustedLocationAreRejected(t *testing.T) {
	posts := 0
	ambiguous := true
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/oauth/token" {
			respond(w, 200, map[string]string{"access_token": "token", "token_type": "Bearer"})
			return
		}
		if r.Method == "GET" {
			if ambiguous {
				respond(w, 200, []any{map[string]string{"id": "one"}, map[string]string{"id": "two"}})
			} else {
				respond(w, 200, []any{})
			}
			return
		}
		posts++
		row := sourceRecord()
		row["id"] = "receiver"
		w.Header().Set("Location", "https://other.example/stolen")
		respond(w, 201, row)
	})
	if _, e := c.Ensure(context.Background(), "defecten", sourceRecord()); e == nil || posts != 0 {
		t.Fatal("ambiguous keys caused a create")
	}
	ambiguous = false
	if _, e := c.Ensure(context.Background(), "defecten", sourceRecord()); e == nil || posts != 1 {
		t.Fatal("untrusted Location accepted")
	}
}
