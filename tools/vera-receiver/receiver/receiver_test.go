package receiver

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

type harness struct {
	t      *testing.T
	r      *Receiver
	client *http.Client
	server *httptest.Server
	bearer string
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	r, err := New(Config{BaseURL: "https://receiver.test", ClientID: "satvey-test", ClientSecret: "test-client-secret", ControlKey: "test-control-secret"})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewUnstartedServer(r)
	server.EnableHTTP2 = true
	server.StartTLS()
	t.Cleanup(server.Close)
	h := &harness{t: t, r: r, server: server, client: server.Client()}
	h.bearer = h.token("", 200)
	return h
}

func (h *harness) call(method, path string, body any, headers map[string]string, status int) ([]byte, http.Header) {
	h.t.Helper()
	var raw []byte
	if body != nil {
		raw = mustJSON(body)
	}
	req, err := http.NewRequest(method, h.server.URL+path, bytes.NewReader(raw))
	if err != nil {
		h.t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+h.bearer)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	response, err := h.client.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		h.t.Fatal(err)
	}
	if response.StatusCode != status {
		h.t.Fatalf("%s %s: got %d want %d: %s", method, path, response.StatusCode, status, data)
	}
	return data, response.Header
}

func (h *harness) token(scope string, status int) string {
	h.t.Helper()
	form := url.Values{"grant_type": {"client_credentials"}, "scope": {scope}}
	req, _ := http.NewRequest("POST", h.server.URL+"/oauth/token", strings.NewReader(form.Encode()))
	req.SetBasicAuth("satvey-test", "test-client-secret")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := h.client.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer response.Body.Close()
	data, _ := io.ReadAll(response.Body)
	if response.StatusCode != status {
		h.t.Fatalf("token: got %d want %d: %s", response.StatusCode, status, data)
	}
	var result map[string]any
	_ = json.Unmarshal(data, &result)
	value, _ := result["access_token"].(string)
	return value
}

func (h *harness) control(method, path string, body any, status int) []byte {
	data, _ := h.call(method, "/_test/"+path, body, map[string]string{"X-Test-Control-Key": "test-control-secret"}, status)
	return data
}
func record(id string) map[string]any {
	return map[string]any{"idExtern": id, "idOrganisatie": "SATVEY", "idAdministratie": "TEST", "omschrijving": "Inspectie"}
}
func decodeRecord(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	var row map[string]any
	if err := json.Unmarshal(raw, &row); err != nil {
		t.Fatal(err)
	}
	return row
}

func TestPinnedContractsAndDiscovery(t *testing.T) {
	h := newHarness(t)
	for _, domain := range []string{"Onderhoud", "Dossier", "Vastgoed"} {
		raw, _ := h.call("GET", "/openapi/"+domain+".json", nil, nil, 200)
		doc := decodeRecord(t, raw)
		if doc["info"].(map[string]any)["version"] != Version {
			t.Fatal("wrong version")
		}
	}
	for _, res := range supported {
		h.call("GET", res.path(), nil, nil, 200)
	}
	h.call("GET", "/onderhoud/v4/ping", nil, nil, 200)
	h.call("POST", "/vastgoed/v4/eenheden", record("x"), nil, 405)
	h.call("GET", "/onderhoud/v4/standaardprijzen", nil, nil, 405)
	h.call("GET", "/not-vera", nil, nil, 404)
}

func TestSpecificationProvenance(t *testing.T) {
	var provenance struct {
		Revision string
		Files    []struct{ File, Source, SHA256 string }
	}
	raw, err := contracts.ReadFile("specs/provenance.json")
	if err != nil || json.Unmarshal(raw, &provenance) != nil {
		t.Fatal("missing specification provenance")
	}
	if len(provenance.Revision) != 40 || len(provenance.Files) != 3 {
		t.Fatal("pin the upstream commit and all three domain files")
	}
	for _, entry := range provenance.Files {
		raw, err = contracts.ReadFile("specs/" + entry.File)
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(raw)
		if hex.EncodeToString(sum[:]) != entry.SHA256 || !strings.Contains(entry.Source, "/"+provenance.Revision+"/") {
			t.Fatalf("upstream specification changed without provenance update: %s", entry.File)
		}
	}
}

func TestAuthenticationAndLiteralScopes(t *testing.T) {
	h := newHarness(t)
	path := "/onderhoud/v4/defecten"
	h.call("GET", path, nil, map[string]string{"Authorization": ""}, 401)
	limited := h.token("Onderhoud.Defecten.Read", 200)
	h.call("GET", path, nil, map[string]string{"Authorization": "Bearer " + limited}, 403)
	full := h.token("Onderhoud.All.ReadWrite", 200)
	h.call("GET", path, nil, map[string]string{"Authorization": "Bearer " + full}, 200)
	h.token("not-a-scope", 400)
	now := time.Now().Add(2 * time.Hour)
	h.r.cfg.Now = func() time.Time { return now }
	h.call("GET", path, nil, nil, 401)
	h.call("GET", "/_test/state", nil, nil, 401)
}

func TestCRUDIdentityAndStrictValidation(t *testing.T) {
	h := newHarness(t)
	path := "/onderhoud/v4/defecten"
	invalid := record("invalid")
	invalid["melddatum"] = "2026-02-30T12:00:00Z"
	h.call("POST", path, invalid, nil, 400)
	for _, value := range []string{"2026-10-31T12:00:00,123Z", "2026-10-31T12:00:00+24:00"} {
		invalid["melddatum"] = value
		h.call("POST", path, invalid, nil, 400)
	}
	valid := record("valid-date")
	valid["melddatum"] = "2026-10-31t12:00:00z"
	h.call("POST", path, valid, nil, 201)
	invalid = record("invalid")
	invalid["eenheid"] = "relative/path"
	h.call("POST", path, invalid, nil, 400)
	invalid = record("invalid")
	invalid["omschrijving"] = 7
	h.call("POST", path, invalid, nil, 400)
	invalid = record("invalid")
	invalid["id"] = "source-id"
	h.call("POST", path, invalid, nil, 422)
	h.call("POST", path, map[string]any{"omschrijving": "no source key"}, nil, 422)
	row := record("source-1")
	row["code"] = "old"
	row["supplierExtension"] = "allowed by upstream"
	raw, headers := h.call("POST", path, row, map[string]string{"X-Stuurgegevens-Referentienummer": "test-acceptance"}, 201)
	created := decodeRecord(t, raw)
	id := created["id"].(string)
	if id == "source-1" || headers.Get("Location") != "https://receiver.test"+path+"/"+id {
		t.Fatal("wrong receiver identity or Location")
	}
	h.call("POST", path, row, nil, 409)
	other := clone(row)
	other["idAdministratie"] = "OTHER"
	h.call("POST", path, other, nil, 201)
	raw, _ = h.call("GET", path+"?idExtern=source-1&idOrganisatie=SATVEY&idAdministratie=TEST", nil, nil, 200)
	var matches []map[string]any
	_ = json.Unmarshal(raw, &matches)
	if len(matches) != 1 || matches[0]["id"] != id {
		t.Fatal("source key lookup crossed namespaces")
	}
	patch := map[string]any{"id": id, "omschrijving": "updated"}
	raw, _ = h.call("PATCH", path, patch, nil, 200)
	if len(raw) != 0 {
		t.Fatal("VERA patch response must be empty")
	}
	raw, _ = h.call("GET", path+"/"+id, nil, nil, 200)
	if decodeRecord(t, raw)["code"] != "old" {
		t.Fatal("patch replaced unspecified attributes")
	}
	h.call("PUT", path+"/"+id, map[string]any{"omschrijving": "replacement"}, nil, 200)
	raw, _ = h.call("GET", path+"/"+id, nil, nil, 200)
	if _, ok := decodeRecord(t, raw)["code"]; ok {
		t.Fatal("PUT did not replace")
	}
	h.call("PATCH", path+"/"+id, map[string]any{"id": "wrong"}, nil, 409)
	h.call("PATCH", path+"/"+id, map[string]any{"idAdministratie": "OTHER"}, nil, 404)
	h.call("PATCH", path, map[string]any{"id": "missing"}, nil, 404)
	h.call("GET", path+"/missing", nil, nil, 404)
	h.call("GET", path+"?omschrijving=ignored", nil, nil, 400)
	h.call("GET", path, nil, map[string]string{"X-Stuurgegevens-Tijdstip-Bericht": "not-a-date"}, 400)
}

func TestAttachmentsAndRelationshipGraph(t *testing.T) {
	h := newHarness(t)
	h.control("POST", "seed", map[string]any{"resource": "/vastgoed/v4/eenheden", "record": map[string]any{"id": "unit-42", "code": "42"}}, 201)
	h.control("POST", "seed", map[string]any{"resource": "/onderhoud/v4/onderhoudsorders", "record": map[string]any{"id": "order-42"}}, 201)
	unit := "https://receiver.test/vastgoed/v4/eenheden/unit-42"
	doc := record("document")
	delete(doc, "omschrijving")
	doc["bestandsnaam"] = "report.pdf"
	doc["bestand"] = base64.StdEncoding.EncodeToString([]byte("PDF bytes"))
	doc["bestandsgrootte"] = 9
	doc["eenheden"] = []string{unit}
	bad := clone(doc)
	bad["bestand"] = "not base64"
	h.call("POST", "/dossier/v4/informatieobjecten", bad, nil, 400)
	bad = clone(doc)
	bad["bestandsgrootte"] = 8
	h.call("POST", "/dossier/v4/informatieobjecten", bad, nil, 422)
	raw, headers := h.call("POST", "/dossier/v4/informatieobjecten", doc, nil, 201)
	saved := decodeRecord(t, raw)
	if saved["bestand"] != doc["bestand"] {
		t.Fatal("changed binary")
	}
	report := record("report")
	report["informatieobjecten"] = []string{headers.Get("Location")}
	report["inspectieOrder"] = map[string]string{"id": "order-42"}
	raw, _ = h.call("POST", "/onderhoud/v4/inspectierapporten", report, nil, 201)
	reportID := decodeRecord(t, raw)["id"]
	defect := record("defect")
	defect["eenheid"] = unit
	defect["inspectierapport"] = map[string]any{"id": reportID}
	defect["informatieobjecten"] = []string{headers.Get("Location")}
	bad = clone(defect)
	bad["eenheid"] = "https://receiver.test/vastgoed/v4/eenheden/unknown"
	h.call("POST", "/onderhoud/v4/defecten", bad, nil, 422)
	bad = clone(defect)
	bad["informatieobjecten"] = []string{"urn:satvey:handover:local"}
	h.call("POST", "/onderhoud/v4/defecten", bad, nil, 422)
	raw, _ = h.call("POST", "/onderhoud/v4/defecten", defect, nil, 201)
	defectID := decodeRecord(t, raw)["id"]
	task := record("task")
	task["defecten"] = []map[string]any{{"id": defectID}}
	raw, _ = h.call("POST", "/onderhoud/v4/onderhoudstaken", task, nil, 201)
	taskID := decodeRecord(t, raw)["id"]
	request := record("request")
	request["onderhoudstaken"] = []map[string]any{{"id": taskID}}
	request["defecten"] = []map[string]any{{"id": defectID}}
	raw, _ = h.call("POST", "/onderhoud/v4/onderhoudsverzoeken", request, nil, 201)
	requestID := decodeRecord(t, raw)["id"]
	h.call("PATCH", "/onderhoud/v4/onderhoudstaken/"+taskID.(string), map[string]any{"onderhoudsverzoek": map[string]any{"id": requestID}}, nil, 200)
	h.call("PATCH", "/onderhoud/v4/inspectierapporten/"+reportID.(string), map[string]any{"geconstateerdeDefecten": []map[string]any{{"id": defectID}}, "voorgesteldeOnderhoudstaken": []map[string]any{{"id": taskID}}}, nil, 200)
	state := h.control("GET", "state", nil, 200)
	if bytes.Contains(state, []byte(doc["bestand"].(string))) || !bytes.Contains(state, []byte("sha256")) {
		t.Fatal("state must expose hashes instead of binary content")
	}
}

func TestPaginationAndFailureReconciliation(t *testing.T) {
	h := newHarness(t)
	path := "/onderhoud/v4/defecten"
	for _, source := range []string{"one", "two", "three"} {
		h.call("POST", path, record(source), nil, 201)
	}
	_, headers := h.call("GET", path, nil, map[string]string{"X-Parameters-AantalPerPagina": "2"}, 200)
	if headers.Get("X-Parameters-Aantal") != "3" || headers.Get("X-Parameters-Cursor") == "" {
		t.Fatal("missing pagination headers")
	}
	cursor := headers.Get("X-Parameters-Cursor")
	raw, _ := h.call("GET", path+"?cursor="+url.QueryEscape(cursor), nil, map[string]string{"X-Parameters-AantalPerPagina": "2"}, 200)
	var rows []any
	_ = json.Unmarshal(raw, &rows)
	if len(rows) != 1 {
		t.Fatal("incorrect next page")
	}
	h.call("GET", path, nil, map[string]string{"X-Parameters-AantalPerPagina": "101"}, 400)
	h.control("POST", "faults", Fault{Method: "POST", Path: path, Mode: "before", Status: 503, Count: 1}, 201)
	h.call("POST", path, record("four"), nil, 503)
	h.call("GET", path+"?cursor="+url.QueryEscape(cursor), nil, map[string]string{"X-Parameters-AantalPerPagina": "2"}, 200)
	h.control("POST", "faults", Fault{Method: "POST", Path: path, Mode: "after_commit", Status: 503, Count: 1}, 201)
	h.call("POST", path, record("four"), nil, 503)
	h.call("GET", path+"?cursor="+url.QueryEscape(cursor), nil, map[string]string{"X-Parameters-AantalPerPagina": "2"}, 400)
	raw, _ = h.call("GET", path+"?idExtern=four&idOrganisatie=SATVEY&idAdministratie=TEST", nil, nil, 200)
	_ = json.Unmarshal(raw, &rows)
	if len(rows) != 1 {
		t.Fatal("lost acknowledgement also lost accepted record")
	}
	h.call("POST", path, record("four"), nil, 409)
	h.control("POST", "faults", Fault{Method: "POST", Path: path, Mode: "disconnect_after_commit", Count: 1}, 201)
	req, _ := http.NewRequest("POST", h.server.URL+path, bytes.NewReader(mustJSON(record("five"))))
	req.Header.Set("Authorization", "Bearer "+h.bearer)
	req.Header.Set("Content-Type", "application/json")
	response, err := h.client.Do(req)
	if err == nil {
		response.Body.Close()
		t.Fatal("expected connection loss")
	}
	raw, _ = h.call("GET", path+"?idExtern=five", nil, nil, 200)
	_ = json.Unmarshal(raw, &rows)
	if len(rows) != 1 {
		t.Fatal("disconnect failed to commit")
	}
	h.control("DELETE", "state", nil, 204)
	raw, _ = h.call("GET", path, nil, nil, 200)
	if string(raw) != "[]" {
		t.Fatal("reset did not empty receiver")
	}
}

func TestConcurrentDuplicatesAreAtomic(t *testing.T) {
	h := newHarness(t)
	var wg sync.WaitGroup
	statuses := make(chan int, 8)
	for i := 0; i < 8; i++ {
		wg.Go(func() {
			req, _ := http.NewRequest("POST", h.server.URL+"/onderhoud/v4/defecten", bytes.NewReader(mustJSON(record("same"))))
			req.Header.Set("Authorization", "Bearer "+h.bearer)
			req.Header.Set("Content-Type", "application/json")
			res, err := h.client.Do(req)
			if err != nil {
				statuses <- 0
				return
			}
			res.Body.Close()
			statuses <- res.StatusCode
		})
	}
	wg.Wait()
	close(statuses)
	accepted := 0
	for status := range statuses {
		if status == 201 {
			accepted++
		} else if status != 409 {
			t.Fatalf("unexpected status %d", status)
		}
	}
	if accepted != 1 {
		t.Fatalf("accepted %d copies", accepted)
	}
}
