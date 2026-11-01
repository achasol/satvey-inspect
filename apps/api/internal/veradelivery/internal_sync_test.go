package veradelivery

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
)

func TestInternalSynchronizationReconcilesAndUpdatesOnlyOwnedFields(t *testing.T) {
	var record map[string]any
	creates, patches := 0, 0
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/oauth/token" {
			respond(w, 200, map[string]string{"access_token": "token", "token_type": "Bearer"})
			return
		}
		if r.Method == "GET" {
			if r.URL.RawQuery != "" {
				rows := []map[string]any{}
				if record != nil {
					rows = append(rows, record)
				}
				respond(w, 200, rows)
			} else {
				respond(w, 200, record)
			}
			return
		}
		if r.Method == "POST" {
			creates++
			_ = json.NewDecoder(r.Body).Decode(&record)
			record["id"] = "received"
			record["receiverOnly"] = "keep"
			w.Header().Set("Location", "https://"+r.Host+r.URL.Path+"/received")
			respond(w, 201, record)
			return
		}
		if r.Method == "PATCH" {
			patches++
			var fields map[string]any
			_ = json.NewDecoder(r.Body).Decode(&fields)
			for key, value := range fields {
				record[key] = value
			}
			respond(w, 200, record)
			return
		}
		t.Errorf("unexpected method %s", r.Method)
	})
	resource := c.Config.DossierURL + "/informatieobjecten"
	row := sourceRecord()
	row["score"] = 3
	if _, err := c.SynchronizeResource(context.Background(), resource, row); err != nil {
		t.Fatal(err)
	}
	if _, err := c.SynchronizeResource(context.Background(), resource, row); err != nil {
		t.Fatal(err)
	}
	row["omschrijving"] = "Nieuwe bevestigde waarneming"
	if _, err := c.SynchronizeResource(context.Background(), resource, row); err != nil {
		t.Fatal(err)
	}
	if creates != 1 || patches != 1 || record["receiverOnly"] != "keep" {
		t.Fatalf("not idempotent or receiver fields lost: creates=%d patches=%d record=%#v", creates, patches, record)
	}
}
func TestCapabilityProbeDoesNotWriteAndPreservesPermissionEvidence(t *testing.T) {
	writes := 0
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/oauth/token" {
			respond(w, 200, map[string]string{"access_token": "token", "token_type": "Bearer"})
			return
		}
		if r.Method != "GET" {
			writes++
		}
		respond(w, 403, map[string]string{"error": "denied"})
	})
	err := c.ProbeResource(context.Background(), c.Config.DossierURL+"/informatieobjecten")
	var remote *Error
	if !errors.As(err, &remote) || remote.Status != 403 || remote.Temporary || writes != 0 {
		t.Fatalf("probe lost permission evidence or wrote data: %v", err)
	}
	if err = c.ProbeResource(context.Background(), "https://unconfigured.example/data"); err == nil || !strings.Contains(err.Error(), "buiten") {
		t.Fatal("probe escaped configured domains")
	}
}
