package app

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"satvey/inspect/internal/handover"
)

// The legacy package importer remains a compatibility test. Production delivery
// is separately exercised through the approval API and durable worker.
type veraTestClient struct {
	t           *testing.T
	base, token string
	http        *http.Client
}

func (c *veraTestClient) call(method, path string, body any, statuses ...int) ([]byte, http.Header, int) {
	c.t.Helper()
	var raw []byte
	if body != nil {
		raw, _ = json.Marshal(body)
	}
	req, err := http.NewRequest(method, c.base+path, bytes.NewReader(raw))
	if err != nil {
		c.t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("X-Test-Control-Key", "dummy-control-secret-only-for-tests")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("X-Stuurgegevens-Referentienummer", "satvey-integration-test")
	response, err := c.http.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		c.t.Fatal(err)
	}
	for _, status := range statuses {
		if response.StatusCode == status {
			return data, response.Header, status
		}
	}
	c.t.Fatalf("VERA %s %s: got %d, expected %v: %s", method, path, response.StatusCode, statuses, data)
	return nil, nil, 0
}

func receiverFixture(t *testing.T) *veraTestClient {
	t.Helper()
	base := strings.TrimRight(os.Getenv("VERA_RECEIVER_URL"), "/")
	if base == "" {
		if os.Getenv("REQUIRE_INTEGRATION") == "1" {
			t.Fatal("VERA_RECEIVER_URL is required in the isolated integration suite")
		}
		t.Skip("Run scripts/test-stack.mjs backend for the disposable VERA receiver")
	}
	if !strings.HasPrefix(base, "https://") {
		t.Fatal("test receiver must use HTTPS")
	}
	certificate, err := os.ReadFile(os.Getenv("VERA_CA_FILE"))
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(certificate) {
		t.Fatal("invalid receiver test CA")
	}
	transport := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}}
	t.Cleanup(transport.CloseIdleConnections)
	c := &veraTestClient{t: t, base: base, http: &http.Client{Transport: transport, Timeout: 30 * time.Second}}
	form := url.Values{"grant_type": {"client_credentials"}}
	tokenRequest, _ := http.NewRequest("POST", base+"/oauth/token", strings.NewReader(form.Encode()))
	tokenRequest.SetBasicAuth("satvey-test", "dummy-client-secret-only-for-tests")
	tokenRequest.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := c.http.Do(tokenRequest)
	if err != nil {
		t.Fatal(err)
	}
	tokenRaw, _ := io.ReadAll(response.Body)
	response.Body.Close()
	var token map[string]any
	if response.StatusCode != 200 || json.Unmarshal(tokenRaw, &token) != nil {
		t.Fatalf("test token failed: %d", response.StatusCode)
	}
	c.token, _ = token["access_token"].(string)
	return c
}

func TestHandoverVERAReceiverRoundTrip(t *testing.T) {
	c := receiverFixture(t)
	base := c.base
	c.call("DELETE", "/_test/state", nil, 204)
	t.Cleanup(func() { c.call("DELETE", "/_test/state", nil, 204) })
	c.call("POST", "/_test/seed", map[string]any{"resource": "/vastgoed/v4/eenheden", "record": map[string]any{"id": "test-unit-42", "code": "42"}}, 201)
	c.call("POST", "/_test/seed", map[string]any{"resource": "/onderhoud/v4/onderhoudsorders", "record": map[string]any{"id": "test-inspection-order"}}, 201)
	f := setup(t)
	path, _ := handoverFixture(f)
	detail := f.request("GET", path+"/handover", nil, 200)
	source := detail["report"].(map[string]any)["sources"].([]any)[0].(map[string]any)["key"].(string)
	draft := handover.Draft{Destination: "VERA integration receiver", Proposals: []handover.Proposal{{ID: id(), SourceKeys: []string{source}, Description: "Herstel de kraan", Location: "Badkamer", Urgency: "soon"}}, VERA: &handover.VERAContext{UnitURI: base + "/vastgoed/v4/eenheden/test-unit-42", Organisation: f.org, Administration: "SATVEY", InspectionOrderID: "test-inspection-order"}}
	f.request("PUT", path+"/handover", draft, 200)
	exportID := id()
	f.request("POST", path+"/handovers", map[string]any{"id": exportID, "version": 1}, 201)
	archive := handoverDownload(f, path+"/handovers/"+exportID+"/export", "zip", 200)
	z, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		t.Fatal(err)
	}
	files := map[string][]byte{}
	for _, entry := range z.File {
		reader, err := entry.Open()
		if err != nil {
			t.Fatal(err)
		}
		files[entry.Name], err = io.ReadAll(reader)
		reader.Close()
		if err != nil {
			t.Fatal(err)
		}
	}
	records := map[string][]map[string]any{}
	for _, name := range []string{"informatieobjecten", "inspectierapporten", "defecten", "onderhoudstaken", "onderhoudsverzoeken"} {
		var rows []map[string]any
		if err = json.Unmarshal(files["vera/"+name+".json"], &rows); err != nil {
			t.Fatal(err)
		}
		records[name] = rows
	}
	var plan struct {
		Documents []struct {
			ID        string `json:"idExtern"`
			Path      string `json:"localPath"`
			Reference string `json:"reference"`
		} `json:"documents"`
	}
	if err = json.Unmarshal(files["vera/transfer-plan.json"], &plan); err != nil {
		t.Fatal(err)
	}
	if len(plan.Documents) < 3 || len(records["defecten"]) == 0 || len(records["onderhoudstaken"]) == 0 {
		t.Fatal("fixture must cover PDF, photo, annotation and maintenance graph")
	}
	c.call("POST", "/_test/faults", map[string]any{"method": "POST", "path": "/dossier/v4/informatieobjecten", "mode": "after_commit", "status": 503, "count": 1}, 201)
	// Source identities and package-local document references must be resolved by
	// the sender, including after a 503 that may have happened after acceptance.
	identities := map[string]string{}
	documentURIs := map[string]string{}
	lookup := func(collection string, row map[string]any) []map[string]any {
		q := url.Values{}
		for _, key := range []string{"idExtern", "idOrganisatie", "idAdministratie"} {
			q.Set(key, row[key].(string))
		}
		raw, _, _ := c.call("GET", collection+"?"+q.Encode(), nil, 200)
		var found []map[string]any
		if json.Unmarshal(raw, &found) != nil || len(found) > 1 {
			t.Fatal("ambiguous source identity")
		}
		return found
	}
	upsert := func(collection string, row map[string]any) map[string]any {
		found := lookup(collection, row)
		if len(found) == 0 {
			raw, headers, status := c.call("POST", collection, row, 201, 503)
			if status == 201 {
				var saved map[string]any
				if err = json.Unmarshal(raw, &saved); err != nil {
					t.Fatal(err)
				}
				if headers.Get("Location") != base+collection+"/"+saved["id"].(string) {
					t.Fatal("missing receiver Location")
				}
				found = []map[string]any{saved}
			} else {
				found = lookup(collection, row)
				if len(found) != 1 {
					t.Fatal("accepted record could not be reconciled after lost acknowledgement")
				}
			}
		} else {
			c.call("PATCH", collection+"/"+found[0]["id"].(string), row, 200)
		}
		receiverID := found[0]["id"].(string)
		if receiverID == row["idExtern"] {
			t.Fatal("sender confused source identity with receiver identity")
		}
		identities[row["idExtern"].(string)] = receiverID
		return found[0]
	}
	var resolve func(any) any
	resolve = func(value any) any {
		switch v := value.(type) {
		case string:
			if uri, exists := documentURIs[v]; exists {
				return uri
			}
			if strings.HasPrefix(v, "urn:satvey:handover:") {
				t.Fatal("unresolved package document")
			}
			return v
		case []any:
			out := []any{}
			for _, item := range v {
				out = append(out, resolve(item))
			}
			return out
		case map[string]any:
			out := map[string]any{}
			for key, item := range v {
				out[key] = resolve(item)
			}
			if external, ok := v["idExtern"].(string); ok {
				if receiverID, exists := identities[external]; exists {
					out["id"] = receiverID
				}
			}
			return out
		default:
			return value
		}
	}
	transfer := func() {
		for _, document := range plan.Documents {
			var row map[string]any
			for _, candidate := range records["informatieobjecten"] {
				if candidate["idExtern"] == document.ID {
					row = copyVERATestRecord(candidate)
					break
				}
			}
			if row == nil {
				t.Fatal("document missing from manifest")
			}
			data, ok := files[document.Path]
			if !ok {
				t.Fatal("document binary missing")
			}
			row["bestand"] = base64.StdEncoding.EncodeToString(data)
			row["bestandsgrootte"] = len(data)
			saved := upsert("/dossier/v4/informatieobjecten", row)
			documentURIs[document.Reference] = base + "/dossier/v4/informatieobjecten/" + saved["id"].(string)
			raw, _, _ := c.call("GET", "/dossier/v4/informatieobjecten/"+saved["id"].(string), nil, 200)
			var read map[string]any
			_ = json.Unmarshal(raw, &read)
			decoded, err := base64.StdEncoding.DecodeString(read["bestand"].(string))
			if err != nil || sha256.Sum256(decoded) != sha256.Sum256(data) {
				t.Fatal("receiver document hash differs from exported evidence")
			}
		}
		// Break cyclic references by creating the report/task first, then linking.
		for _, original := range records["inspectierapporten"] {
			row := copyVERATestRecord(original)
			delete(row, "geconstateerdeDefecten")
			delete(row, "voorgesteldeOnderhoudstaken")
			row = resolve(row).(map[string]any)
			delete(row, "id")
			upsert("/onderhoud/v4/inspectierapporten", row)
		}
		for _, name := range []string{"defecten", "onderhoudstaken", "onderhoudsverzoeken"} {
			for _, original := range records[name] {
				row := copyVERATestRecord(original)
				if name == "onderhoudstaken" {
					delete(row, "onderhoudsverzoek")
				}
				row = resolve(row).(map[string]any)
				delete(row, "id")
				upsert("/onderhoud/v4/"+name, row)
			}
		}
		for _, name := range []string{"onderhoudstaken", "inspectierapporten"} {
			for _, original := range records[name] {
				row := resolve(original).(map[string]any)
				c.call("PATCH", "/onderhoud/v4/"+name+"/"+identities[original["idExtern"].(string)], row, 200)
			}
		}
	}
	transfer()
	transfer() // Repeat the same handover without duplicate records.
	for name, expected := range records {
		domain := "onderhoud"
		if name == "informatieobjecten" {
			domain = "dossier"
		}
		raw, _, _ := c.call("GET", "/"+domain+"/v4/"+name, nil, 200)
		var rows []map[string]any
		_ = json.Unmarshal(raw, &rows)
		if len(rows) != len(expected) {
			t.Fatalf("%s duplicated or missing: %d want %d", name, len(rows), len(expected))
		}
		for _, row := range rows {
			if bytes.Contains(mustVERATestJSON(row), []byte("urn:satvey:handover:")) {
				t.Fatal("receiver accepted unresolved document reference")
			}
			var original map[string]any
			for _, candidate := range expected {
				if candidate["idExtern"] == row["idExtern"] {
					original = candidate
					break
				}
			}
			if original == nil {
				t.Fatal("receiver returned an unknown source record")
			}
			for key, value := range resolve(original).(map[string]any) {
				if !reflect.DeepEqual(value, row[key]) {
					t.Fatalf("%s.%s was not preserved or linked: got %v, want %v", name, key, row[key], value)
				}
			}
		}
	}
	raw, _, _ := c.call("GET", "/_test/state", nil, 200)
	var state map[string]any
	if json.Unmarshal(raw, &state) != nil || len(state["receipts"].([]any)) == 0 {
		t.Fatal("receiver did not record actual acceptance")
	}
	t.Logf("VERA round trip accepted %d documents and %d maintenance records; repeated delivery reconciled without duplicates", len(plan.Documents), len(identities)-len(plan.Documents))
}

func copyVERATestRecord(row map[string]any) map[string]any {
	var result map[string]any
	_ = json.Unmarshal(mustVERATestJSON(row), &result)
	return result
}
func mustVERATestJSON(value any) []byte {
	raw, err := json.Marshal(value)
	if err != nil {
		panic(fmt.Sprintf("test JSON: %v", err))
	}
	return raw
}
