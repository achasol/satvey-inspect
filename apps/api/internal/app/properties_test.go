package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func testCSVSource(f *fixture) string {
	f.t.Helper()
	source := id()
	f.request("POST", "/orgs/"+f.org+"/property-sources", map[string]any{"id": source, "name": "Corporatie vastgoed", "administration": source, "kind": "csv", "enabled": true}, 200)
	return source
}
func testImport(f *fixture, source, text string) map[string]any {
	f.t.Helper()
	path := "/orgs/" + f.org + "/property-sources/" + source + "/imports"
	out := f.request("POST", path, map[string]any{"csv": text}, 200)
	if len(out["errors"].([]any)) > 0 {
		f.t.Fatalf("CSV rejected: %v", out)
	}
	f.request("POST", path+"/"+out["id"].(string)+"/confirm", map[string]any{}, 200)
	return out
}
func testCatalog(f *fixture, q string) []map[string]any {
	f.t.Helper()
	out := f.request("GET", "/orgs/"+f.org+"/properties"+q, nil, 200)
	items := []map[string]any{}
	for _, v := range out["items"].([]any) {
		items = append(items, v.(map[string]any))
	}
	return items
}
func TestPropertyCSVValidation(t *testing.T) {
	rows, errors := parsePropertyCSV("sourceObjectId,address\n 0001 ,Teststraat 1\n")
	if len(errors) > 0 || len(rows) != 1 || rows[0].SourceObjectID != " 0001 " {
		t.Fatal("opaque source identity was normalised", rows, errors)
	}
	for _, tc := range []struct {
		name, text string
		valid      bool
	}{
		{"minimal", "sourceObjectId,address\nu1,Teststraat 1\n", true},
		{"bom quoted", "\ufeffsourceObjectId,address,city\nu1,\"Straat, nummer 1\",Utrecht\n", true},
		{"missing identity", "address\nTeststraat 1\n", false},
		{"duplicate IDs", "sourceObjectId,address\nu1,A\nu1,B\n", false},
		{"unknown columns", "sourceObjectId,address,resident\nu1,A,X\n", false},
		{"duplicate columns", "sourceObjectId,address,address\nu1,A,B\n", false},
		{"nan", "sourceObjectId,address,area,areaType,areaUnit\nu1,A,NaN,GO,m2\n", false},
		{"ambiguous area", "sourceObjectId,address,area\nu1,A,80\n", false},
		{"bad year", "sourceObjectId,address,buildYear\nu1,A,abc\n", false},
		{"nul", "sourceObjectId,address\nu1,Bad\x00value\n", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, errors := parsePropertyCSV(tc.text)
			if (len(errors) == 0) != tc.valid {
				t.Fatalf("validation: %v", errors)
			}
		})
	}
}
func TestPropertyImportIdentityAndIsolation(t *testing.T) {
	f := setup(t)
	other := setup(t)
	ctx := context.Background()
	source := testCSVSource(f)
	csv := "sourceObjectId,objectNumber,address,postcode,city,buildYear,area,areaType,areaUnit\nunit-a,VHE-01,Teststraat 1,1234 AB,Utrecht,1980,81.5,GO,m2\nunit-b,VHE-02,Teststraat 1,1234 AB,Utrecht,,,,\n"
	first := testImport(f, source, csv)
	if first["created"] != float64(2) {
		t.Fatal(first)
	}
	items := testCatalog(f, "")
	if len(items) != 2 || items[0]["id"] == items[1]["id"] {
		t.Fatalf("identical addresses were merged: %v", items)
	}
	second := testImport(f, source, csv)
	if second["unchanged"] != float64(2) {
		t.Fatal(second)
	}
	current := testCatalog(f, "")
	if current[0]["id"] != items[0]["id"] || current[0]["revision"] != items[0]["revision"] {
		t.Fatal("idempotent import changed identity or revision")
	}
	updated := testImport(f, source, strings.Replace(csv, "Teststraat 1", "Nieuwe straat 9", 1))
	if updated["updated"] != float64(1) {
		t.Fatal(updated)
	}
	if got := testCatalog(f, "?q=VHE-01"); len(got) != 1 || got[0]["id"] != items[0]["id"] || got[0]["revision"] != float64(2) {
		t.Fatal(got)
	}
	if got := testCatalog(f, "?q=1234AB"); len(got) != 2 {
		t.Fatal("postcode normalization failed")
	}
	other.request("GET", "/orgs/"+f.org+"/properties", nil, 404)
	other.request("GET", "/orgs/"+other.org+"/properties/"+items[0]["id"].(string), nil, 404)
	// Same remote ID in another administration is a different property.
	source2 := testCSVSource(f)
	testImport(f, source2, "sourceObjectId,address\nunit-a,Teststraat 1\n")
	if len(testCatalog(f, "")) != 3 {
		t.Fatal("source namespace lost")
	}
	// A stale preview must not overwrite a newer catalog.
	path := "/orgs/" + f.org + "/property-sources/" + source + "/imports"
	preview := f.request("POST", path, map[string]any{"csv": csv}, 200)
	testImport(f, source, strings.Replace(csv, "Teststraat 1", "Later adres 2", 1))
	f.request("POST", path+"/"+preview["id"].(string)+"/confirm", map[string]any{}, 409)
	// Duplicate rows reject the entire preview and leave all existing rows intact.
	invalid := f.request("POST", path, map[string]any{"csv": "sourceObjectId,address\nnew,A\nnew,B\n"}, 200)
	if len(invalid["errors"].([]any)) == 0 {
		t.Fatal("duplicate import accepted")
	}
	var count int
	if e := f.a.db.QueryRow(ctx, `SELECT count(*) FROM properties WHERE org_id=$1 AND source_object_id='new'`, f.org).Scan(&count); e != nil || count != 0 {
		t.Fatalf("partial import: %d %v", count, e)
	}
}
func TestPropertyProvisionalLinkSnapshotAndReport(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	base := "/orgs/" + f.org
	source := testCSVSource(f)
	testImport(f, source, "sourceObjectId,objectNumber,address,buildYear\nu1,VHE-1,Bronstraat 12,1981\n")
	target := testCatalog(f, "")[0]
	pid, iid := id(), id()
	f.request("POST", base+"/properties", map[string]any{"id": pid, "address": "Handmatig 12"}, 201)
	// Use a genuine pre-format dossier, deliberately leaving the property provisional.
	if _, e := f.a.db.Exec(ctx, `INSERT INTO inspections(id,org_id,property_id,kind,created_by) VALUES($1,$2,$3,'pre',$4)`, iid, f.org, pid, f.uid); e != nil {
		t.Fatal(e)
	}
	path := base + "/inspections/" + iid
	f.request("POST", path+"/report", map[string]any{}, 422)
	f.request("POST", base+"/properties/"+pid+"/link", map[string]any{"targetPropertyId": target["id"], "revision": 2, "targetRevision": 1}, 409)
	f.request("POST", base+"/properties/"+pid+"/link", map[string]any{"targetPropertyId": target["id"], "revision": 1, "targetRevision": 1}, 200)
	d := f.request("GET", path, nil, 200)
	info := d["inspection"].(map[string]any)
	snapshot := info["propertySnapshot"].(map[string]any)
	if info["propertyId"] != target["id"] || snapshot["linkState"] != "linked" || info["address"] != "Bronstraat 12" {
		t.Fatal(info)
	}
	if e := f.a.db.QueryRow(ctx, `SELECT count(*) FROM property_events WHERE org_id=$1`, f.org).Scan(new(int)); e != nil {
		t.Fatal(e)
	}
	// Updating the source does not rewrite an inspection's address or pinned AI facts.
	testImport(f, source, "sourceObjectId,objectNumber,address,buildYear\nu1,VHE-1,Bronstraat 14,1982\n")
	d = f.request("GET", path, nil, 200)
	info = d["inspection"].(map[string]any)
	if info["address"] != "Bronstraat 12" || info["propertyChanged"] != true {
		t.Fatal(info)
	}
	input, _, e := f.a.normInput(ctx, f.org, iid, id(), "Keuken", false)
	if e != nil {
		t.Fatal(e)
	}
	if input.Property == nil || input.Property.Address != "Bronstraat 12" || *input.Property.BuildYear != 1981 {
		t.Fatal(input.Property)
	}
	// Context adoption is optimistic and records a new generation.
	f.request("POST", path+"/property-context", map[string]any{"contextVersion": 1, "propertyRevision": 2}, 409)
	f.request("POST", path+"/property-context", map[string]any{"contextVersion": 2, "propertyRevision": 2}, 200)
	d = f.request("GET", path, nil, 200)
	info = d["inspection"].(map[string]any)
	if info["address"] != "Bronstraat 14" || info["propertyChanged"] != false {
		t.Fatal(info)
	}
	// A reviewed excluded capture permits legacy finalisation; the frozen address survives another import.
	room, batch := id(), id()
	if _, e = f.a.db.Exec(ctx, `INSERT INTO rooms(id,org_id,inspection_id,name) VALUES($1,$2,$3,'Keuken')`, room, f.org, iid); e != nil {
		t.Fatal(e)
	}
	if _, e = f.a.db.Exec(ctx, `INSERT INTO batches(id,org_id,inspection_id,room_id,expected_media,status) VALUES($1,$2,$3,$4,'{}','excluded')`, batch, f.org, iid, room); e != nil {
		t.Fatal(e)
	}
	report := f.request("POST", path+"/report", map[string]any{}, 201)
	testImport(f, source, "sourceObjectId,address\nu1,Nieuw adres 99\n")
	frozen := f.request("GET", path+"/report", nil, 200)
	a, _ := json.Marshal(report)
	b, _ := json.Marshal(frozen)
	if !bytes.Equal(a, b) {
		t.Fatal("report mutated after import")
	}
	f.request("POST", path+"/property-context", map[string]any{"contextVersion": 3, "propertyRevision": 3}, 409)
}
func TestPropertyEncryption(t *testing.T) {
	t.Setenv("PROPERTY_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{42}, 32)))
	encrypted, e := encryptPropertySecret("top-secret", "org", "source")
	if e != nil || strings.Contains(encrypted, "top-secret") {
		t.Fatal(e)
	}
	decrypted, e := decryptPropertySecret(encrypted, "org", "source")
	if e != nil || decrypted != "top-secret" {
		t.Fatal(e)
	}
	if _, e = decryptPropertySecret(encrypted, "another-org", "source"); e == nil {
		t.Fatal("secret was not bound to tenant")
	}
}
func testVeraSource(f *fixture, endpoint, kind, tokenURL string) string {
	f.t.Helper()
	source := id()
	f.request("POST", "/orgs/"+f.org+"/property-sources", map[string]any{"id": source, "name": "VERA test", "administration": source, "kind": "vera", "baseUrl": endpoint + "/v4", "authKind": kind, "clientId": "client", "tokenUrl": tokenURL, "secret": "test-secret", "enabled": true}, 200)
	return source
}
func TestPropertyVERASyncResumeAndReferences(t *testing.T) {
	t.Setenv("PROPERTY_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{24}, 32)))
	t.Setenv("ALLOW_HTTP_PROPERTY_API", "true")
	f := setup(t)
	ctx := context.Background()
	var mu sync.Mutex
	failSecond := true
	requests := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		requests = append(requests, r.URL.String())
		if r.Header.Get("X-API-KEY") != "test-secret" {
			t.Error("missing API authentication")
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v4/eenheden":
			if r.URL.Query().Get("cursor") == "next" {
				if failSecond {
					w.WriteHeader(503)
					return
				}
				fmt.Fprint(w, `[{"id":"unit-b","code":"VHE-2","adres":{"id":"address-b"}}]`)
			} else {
				w.Header().Set("X-Parameters-Cursor", "next")
				fmt.Fprint(w, `[{"id":"unit-a","idExtern":"different-target-id","code":"VHE-1","bouwjaar":1978,"detailSoort":{"code":"TW","naam":"Tussenwoning"},"status":{"code":"VER","naam":"Verhuurd"},"adres":{"id":"address-a"},"adresseerbaarObjectBasisregistratie":{"id":"bag-a"},"oppervlakten":[{"id":"area-a"}],"clusters":[{"id":"cluster-a"}]}]`)
			}
		case "/v4/adressen/address-a", "/v4/adressen/address-b":
			fmt.Fprint(w, `{"id":"`+strings.TrimPrefix(r.URL.Path, "/v4/adressen/")+`","adres":"Teststraat 1","postcode":"1234 AB","woonplaats":{"id":"city-a"},"bag":{"id":"ba-a"}}`)
		case "/v4/woonplaatsen/city-a":
			fmt.Fprint(w, `{"id":"city-a","naam":"Utrecht"}`)
		case "/v4/bag-adressen/ba-a":
			fmt.Fprint(w, `{"id":"ba-a","bagNummeraanduidingIdentificatie":"1234567890123456"}`)
		case "/v4/adresseerbare-objecten-basisregistratie/bag-a":
			fmt.Fprint(w, `{"id":"bag-a","bagIdentificatie":"0987654321098765","bagPandenBasisregistratie":[{"id":"bp-a"}]}`)
		case "/v4/bag-panden/bp-a":
			fmt.Fprint(w, `{"id":"bp-a","bagIdentificatie":"1111222233334444"}`)
		case "/v4/oppervlakten/area-a":
			fmt.Fprint(w, `{"id":"area-a","waarde":82.5,"soort":{"code":"GO","naam":"Gebruiksoppervlakte"}}`)
		case "/v4/clusters/cluster-a":
			fmt.Fprint(w, `{"id":"cluster-a","code":"C-1","naam":"Parkbuurt","soort":{"code":"ONH","naam":"Onderhoudscluster"}}`)
		default:
			t.Errorf("unexpected endpoint %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	source := testVeraSource(f, server.URL, "api_key", "")
	path := "/orgs/" + f.org + "/property-sources/" + source
	f.request("POST", path+"/test", map[string]any{}, 200)
	if len(testCatalog(f, "")) != 0 {
		t.Fatal("connection test imported data")
	}
	job := f.request("POST", path+"/sync", map[string]any{}, 202)["jobId"].(string)
	same := f.request("POST", path+"/sync", map[string]any{}, 202)["jobId"].(string)
	if same != job {
		t.Fatal("overlapping full jobs")
	}
	if e := f.a.processPropertySync(ctx); e != nil {
		t.Fatal(e)
	}
	items := testCatalog(f, "")
	if len(items) != 1 || items[0]["sourceObjectId"] != "unit-a" || items[0]["bagObjectId"] != "0987654321098765" || items[0]["area"] != 82.5 {
		t.Fatal(items)
	}
	keys := items[0]["sourceKeys"].(map[string]any)
	if keys["idExtern"] != "different-target-id" {
		t.Fatal(keys)
	}
	if e := f.a.processPropertySync(ctx); e != nil {
		t.Fatal(e)
	}
	var state, cursor string
	if e := f.a.db.QueryRow(ctx, `SELECT status,cursor FROM property_sync_jobs WHERE id=$1`, job).Scan(&state, &cursor); e != nil || state != "pending" || cursor != "c:next" {
		t.Fatalf("failed page lost resume: %s %s %v", state, cursor, e)
	}
	mu.Lock()
	failSecond = false
	mu.Unlock()
	if _, e := f.a.db.Exec(ctx, `UPDATE property_sync_jobs SET next_attempt_at=now() WHERE id=$1`, job); e != nil {
		t.Fatal(e)
	}
	if e := f.a.processPropertySync(ctx); e != nil {
		t.Fatal(e)
	}
	if len(testCatalog(f, "")) != 2 {
		t.Fatal("resume did not import second page")
	}
	if e := f.a.db.QueryRow(ctx, `SELECT status FROM property_sync_jobs WHERE id=$1`, job).Scan(&state); e != nil || state != "done" {
		t.Fatal(state, e)
	}
	var scratch int
	if e := f.a.db.QueryRow(ctx, `SELECT count(*) FROM property_sync_seen WHERE job_id=$1`, job).Scan(&scratch); e != nil || scratch != 0 {
		t.Fatal("completed sync retained per-object scratch data", scratch, e)
	}
	settings := f.request("GET", "/orgs/"+f.org+"/property-sources", nil, 200)
	raw, _ := json.Marshal(settings)
	if bytes.Contains(raw, []byte("test-secret")) || bytes.Contains(raw, []byte(`"secret":`)) {
		t.Fatal("credentials exposed")
	}
	f.request("POST", path+"/imports", map[string]any{"csv": "sourceObjectId,address\nu1,A\n"}, 422)
}
func TestPropertyVERAOAuthAndExternalReferences(t *testing.T) {
	t.Setenv("PROPERTY_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{24}, 32)))
	t.Setenv("ALLOW_HTTP_PROPERTY_API", "true")
	f := setup(t)
	ctx := context.Background()
	leaked := false
	external := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked = true; fmt.Fprint(w, `{"id":"x"}`) }))
	defer external.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/oauth/token" {
			user, password, ok := r.BasicAuth()
			if !ok || user != "client" || password != "test-secret" {
				t.Error("bad client credentials")
			}
			_ = r.ParseForm()
			if r.Form.Get("grant_type") != "client_credentials" {
				t.Error("bad token grant")
			}
			fmt.Fprint(w, `{"access_token":"access-secret","token_type":"Bearer"}`)
			return
		}
		if r.Header.Get("Authorization") != "Bearer access-secret" {
			t.Error("missing bearer token")
		}
		fmt.Fprintf(w, `[{"id":"u1","adres":%q}]`, external.URL+"/adressen/x")
	}))
	defer server.Close()
	source := testVeraSource(f, server.URL, "oauth2", server.URL+"/oauth/token")
	s, e := readPropertySource(ctx, f.a.db, f.org, source)
	if e != nil {
		t.Fatal(e)
	}
	client, e := f.a.newVeraClient(ctx, f.org, s)
	if e != nil {
		t.Fatal(e)
	}
	if _, _, e = client.page(ctx, ""); e == nil {
		t.Fatal("external reference accepted")
	}
	if leaked {
		t.Fatal("source credentials sent to external server")
	}
	// Explicit redirects are rejected as well, even if the target would answer successfully.
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, external.URL+"/adressen/x", 302) }))
	defer redirect.Close()
	client.source.BaseURL = redirect.URL + "/v4"
	if _, _, e = client.page(ctx, ""); e == nil {
		t.Fatal("redirect accepted")
	}
	if leaked {
		t.Fatal("redirect leaked credentials")
	}
}

func TestPropertyContextInvalidatesLeasesAndPreservesHumanCorrections(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	whole := formatScope{ID: id(), Name: "Woning algemeen", NormRoom: "Woning algemeen", Property: true}
	kitchen := formatScope{ID: id(), Name: "Keuken", NormRoom: "Keuken", Required: true, Questions: []formatQuestion{{ID: id(), Title: "Toestand", Kind: "text", Required: true, Evidence: "none"}}}
	doc, norm := testPublishedFormat(f, []formatScope{whole, kitchen})
	path, iid := testFormatInspection(f, doc)
	room, _ := testRoom(f, path, kitchen.ID)
	batch, job, run := id(), id(), id()
	if _, e := f.a.db.Exec(ctx, `INSERT INTO batches(id,org_id,inspection_id,room_id,status,expected_media) VALUES($1,$2,$3,$4,'reviewed','{}')`, batch, f.org, iid, room); e != nil {
		t.Fatal(e)
	}
	if _, e := f.a.db.Exec(ctx, `INSERT INTO processing_jobs(id,org_id,inspection_id,batch_id,status,run_token,lease_until) VALUES($1,$2,$3,$4,'processing',$5,now()+interval '3 minutes')`, job, f.org, iid, batch, run); e != nil {
		t.Fatal(e)
	}
	if _, e := f.a.db.Exec(ctx, `INSERT INTO scope_jobs(room_id,org_id,inspection_id,provider,status,run_token) VALUES($1,$2,$3,'mock','processing',$4)`, room, f.org, iid, id()); e != nil {
		t.Fatal(e)
	}
	if _, e := f.a.db.Exec(ctx, `UPDATE format_answers SET value='"Eigen antwoord"',reason='Zelf gecontroleerd',human=true,status='confirmed' WHERE room_id=$1`, room); e != nil {
		t.Fatal(e)
	}
	if _, e := f.a.db.Exec(ctx, `UPDATE rooms SET approved_generation=generation WHERE id=$1`, room); e != nil {
		t.Fatal(e)
	}
	aid := id()
	if _, e := f.a.db.Exec(ctx, `INSERT INTO norm_assessments(id,org_id,inspection_id,batch_id,norm_version_id,rule_id,outcome,reason,source,reviewed_outcome,review_note) VALUES($1,$2,$3,$4,$5,$6,'not_assessable','Voorstel','mock','acceptable','Eigen onderbouwing')`, aid, f.org, iid, batch, norm.ID, norm.Rules[0].ID); e != nil {
		t.Fatal(e)
	}
	d := f.request("GET", path, nil, 200)
	pid := d["inspection"].(map[string]any)["propertyId"].(string)
	if _, e := f.a.db.Exec(ctx, `UPDATE properties SET address='Gewijzigd 1',revision=revision+1 WHERE id=$1`, pid); e != nil {
		t.Fatal(e)
	}
	f.request("POST", path+"/property-context", map[string]any{"contextVersion": 1, "propertyRevision": 2}, 200)
	var status string
	var lease *string
	if e := f.a.db.QueryRow(ctx, `SELECT status,run_token FROM processing_jobs WHERE id=$1`, job).Scan(&status, &lease); e != nil || status != "pending" || lease != nil {
		t.Fatalf("old image lease survived: %s %v %v", status, lease, e)
	}
	if e := f.a.db.QueryRow(ctx, `SELECT status,run_token FROM scope_jobs WHERE room_id=$1`, room).Scan(&status, &lease); e != nil || status != "pending" || lease != nil {
		t.Fatalf("old scope lease survived: %s %v %v", status, lease, e)
	}
	var human bool
	var answer, reason string
	if e := f.a.db.QueryRow(ctx, `SELECT human,value::text,reason,status FROM format_answers WHERE room_id=$1`, room).Scan(&human, &answer, &reason, &status); e != nil || !human || answer != `"Eigen antwoord"` || reason != "Zelf gecontroleerd" || status != "suggested" {
		t.Fatalf("human answer discarded: %s %s %s %v", answer, reason, status, e)
	}
	var stale bool
	var previous, previousNote string
	if e := f.a.db.QueryRow(ctx, `SELECT stale,previous_reviewed_outcome,previous_review_note FROM norm_assessments WHERE id=$1`, aid).Scan(&stale, &previous, &previousNote); e != nil || !stale || previous != "acceptable" || previousNote != "Eigen onderbouwing" {
		t.Fatalf("human judgment discarded: %v %s %s %v", stale, previous, previousNote, e)
	}
	// A fresh AI result still requires confirmation while retaining the human's earlier judgment.
	tx, e := f.a.db.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(ctx)
	if e = writeNormChecks(ctx, tx, f.org, iid, batch, norm.ID, "mock", nil, []normCheck{{RuleID: norm.Rules[0].ID, Outcome: "not_assessable", Reason: "Nieuwe analyse"}}); e != nil {
		t.Fatal(e)
	}
	var reviewed *string
	if e = tx.QueryRow(ctx, `SELECT reviewed_outcome,previous_reviewed_outcome,previous_review_note FROM norm_assessments WHERE id=$1`, aid).Scan(&reviewed, &previous, &previousNote); e != nil || reviewed != nil || previous != "acceptable" || previousNote != "Eigen onderbouwing" {
		t.Fatal("reanalysis overwrote previous human correction", e)
	}
}

func TestPropertySourceChangeRevokesRunningSync(t *testing.T) {
	t.Setenv("PROPERTY_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{24}, 32)))
	t.Setenv("ALLOW_HTTP_PROPERTY_API", "true")
	f := setup(t)
	ctx := context.Background()
	started, release := make(chan struct{}), make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-release
		fmt.Fprint(w, `[{"id":"u1","adres":{"adres":"Test 1"}}]`)
	}))
	defer server.Close()
	source := testVeraSource(f, server.URL, "api_key", "")
	job, e := f.a.enqueuePropertySync(ctx, f.org, source, nil)
	if e != nil {
		t.Fatal(e)
	}
	finished := make(chan error, 1)
	go func() { finished <- f.a.processPropertySync(ctx) }()
	<-started
	f.request("PUT", "/orgs/"+f.org+"/property-sources/"+source, map[string]any{"name": "Disabled", "administration": source, "kind": "vera", "baseUrl": server.URL + "/v4", "authKind": "api_key", "enabled": false, "revision": 1}, 200)
	close(release)
	if e = <-finished; e != nil {
		t.Fatal(e)
	}
	if len(testCatalog(f, "")) != 0 {
		t.Fatal("old configuration wrote catalog data")
	}
	var status string
	if e = f.a.db.QueryRow(ctx, `SELECT status FROM property_sync_jobs WHERE id=$1`, job).Scan(&status); e != nil || status != "failed" {
		t.Fatal(status, e)
	}
}

func TestPropertySyncSchedulingAndBoundedFailures(t *testing.T) {
	t.Setenv("PROPERTY_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{24}, 32)))
	t.Setenv("ALLOW_HTTP_PROPERTY_API", "true")
	f := setup(t)
	ctx := context.Background()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "upstream secret must not be exposed", 503)
	}))
	defer server.Close()
	source := testVeraSource(f, server.URL, "api_key", "")
	if e := f.a.schedulePropertySyncs(ctx); e != nil {
		t.Fatal(e)
	}
	if e := f.a.schedulePropertySyncs(ctx); e != nil {
		t.Fatal(e)
	}
	var count int
	if e := f.a.db.QueryRow(ctx, `SELECT count(*) FROM property_sync_jobs WHERE source_id=$1`, source).Scan(&count); e != nil || count != 1 {
		t.Fatal("overlapping scheduled jobs", count, e)
	}
	for i := 0; i < 3; i++ {
		if _, e := f.a.db.Exec(ctx, `UPDATE property_sync_jobs SET next_attempt_at=now(),lease_until=now()-interval '1 second' WHERE source_id=$1`, source); e != nil {
			t.Fatal(e)
		}
		if e := f.a.processPropertySync(ctx); e != nil {
			t.Fatal(e)
		}
	}
	var state, lastError string
	var attempts int
	if e := f.a.db.QueryRow(ctx, `SELECT status,attempts,last_error FROM property_sync_jobs WHERE source_id=$1`, source).Scan(&state, &attempts, &lastError); e != nil || state != "failed" || attempts != 3 || strings.Contains(lastError, "secret") {
		t.Fatal(state, attempts, lastError, e)
	}
	if len(testCatalog(f, "")) != 0 {
		t.Fatal("failed source added properties")
	}
}

func TestPropertyManagementRequiresPrivilege(t *testing.T) {
	f := setup(t)
	inspector := setup(t)
	base := "/orgs/" + f.org
	source := testCSVSource(f)
	testImport(f, source, "sourceObjectId,address\nu1,Test 1\n")
	invitation := f.request("POST", base+"/invitations", map[string]any{"email": inspector.email, "role": "inspector"}, 201)
	inviteToken := strings.Split(invitation["url"].(string), "token=")[1]
	inspector.request("POST", "/invitations/accept", map[string]any{"token": inviteToken}, 200)
	t.Cleanup(func() {
		_, _ = f.a.db.Exec(context.Background(), `DELETE FROM memberships WHERE org_id=$1 AND user_id=$2`, f.org, inspector.uid)
	})
	inspector.request("GET", base+"/properties", nil, 200)
	inspector.request("GET", base+"/property-sources", nil, 403)
	inspector.request("POST", base+"/property-sources", map[string]any{}, 403)
	inspector.request("POST", base+"/property-sources/"+source+"/imports", map[string]any{}, 403)
	inspector.request("POST", base+"/properties/"+id()+"/link", map[string]any{}, 403)
}

func TestPropertyContextReachesAIWithoutBecomingEvidence(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Messages []struct {
				Role    string          `json:"role"`
				Content json.RawMessage `json:"content"`
			} `json:"messages"`
		}
		if e := json.NewDecoder(r.Body).Decode(&body); e != nil {
			t.Error(e)
		}
		if len(body.Messages) != 2 || !bytes.Contains(body.Messages[0].Content, []byte("geen bewijs")) || !bytes.Contains(body.Messages[1].Content, []byte("propertyContext")) || !bytes.Contains(body.Messages[1].Content, []byte("1976")) {
			t.Error("missing source context or evidence boundary")
		}
		send(w, 200, map[string]any{"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]string{"content": `{"findings":[],"checks":[]}`}}}})
	}))
	defer server.Close()
	year := 1976
	analyzer := basetenAnalyzer{key: "test", endpoint: server.URL, model: "test", client: server.Client()}
	_, e := analyzer.AnalyzeNorms(context.Background(), normAnalysisInput{Room: "Keuken", Property: &catalogProperty{Address: "Test 1", LinkState: "linked", Details: propertyDetails{BuildYear: &year}}, PropertyContextVersion: 2}, nil)
	if e != nil {
		t.Fatal(e)
	}
}
