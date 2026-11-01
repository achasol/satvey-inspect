package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5/pgxpool"
)

type fixture struct {
	a               *app
	server          *httptest.Server
	client          *http.Client
	org, uid, email string
	t               *testing.T
}

func setup(t *testing.T) *fixture {
	t.Helper()
	if os.Getenv("DATABASE_URL") == "" {
		if os.Getenv("REQUIRE_INTEGRATION") == "1" {
			t.Fatal("integration services are required")
		}
		t.Skip("integration tests require the isolated test stack")
	}
	if os.Getenv("APP_ENV") != "test" {
		t.Fatal("integration tests require APP_ENV=test; never use the live stack")
	}
	parsedDB, err := url.Parse(os.Getenv("DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	databaseName := strings.TrimPrefix(parsedDB.Path, "/")
	if name := os.Getenv("TEST_DATABASE_NAME"); name != "" {
		databaseName = name
	}
	if !strings.HasPrefix(databaseName, "satvey_test") || !strings.HasPrefix(os.Getenv("S3_BUCKET"), "satvey-test") {
		t.Fatal("integration database/bucket must have satvey_test / satvey-test prefixes")
	}
	ctx := context.Background()
	databaseURL := os.Getenv("DATABASE_URL")
	if name := os.Getenv("TEST_DATABASE_NAME"); name != "" {
		parsed, err := url.Parse(databaseURL)
		if err != nil {
			t.Fatal(err)
		}
		parsed.Path = "/" + name
		databaseURL = parsed.String()
	}
	db, e := pgxpool.New(ctx, databaseURL)
	if e != nil {
		t.Fatal(e)
	}
	if e = migrate(ctx, db); e != nil {
		t.Fatal(e)
	}
	a := &app{db: db, bucket: env("S3_BUCKET", "satvey-evidence"), origin: "http://localhost:5173"}
	a.storage = s3.New(s3.Options{Region: "us-east-1", BaseEndpoint: aws.String(os.Getenv("S3_ENDPOINT")), UsePathStyle: true, Credentials: credentials.NewStaticCredentialsProvider(os.Getenv("S3_ACCESS_KEY"), os.Getenv("S3_SECRET_KEY"), "")})
	f := &fixture{a: a, t: t, org: id(), uid: id(), email: id() + "@test.invalid"}
	a.workerOrg = f.org
	a.workerUser = f.uid
	h, e := passwordHash("integration-password-2026")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = db.Exec(ctx, "INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,'Test Inspector',$3)", f.uid, f.email, h); e != nil {
		t.Fatal(e)
	}
	if _, e = db.Exec(ctx, "INSERT INTO organisations(id,slug,name) VALUES($1,$2,'Integration Test')", f.org, "test-"+f.org); e != nil {
		t.Fatal(e)
	}
	if _, e = db.Exec(ctx, "INSERT INTO memberships(org_id,user_id,role) VALUES($1,$2,'admin')", f.org, f.uid); e != nil {
		t.Fatal(e)
	}
	f.server = httptest.NewServer(a.routes())
	jar, _ := cookiejar.New(nil)
	f.client = &http.Client{Jar: jar}
	t.Cleanup(func() {
		f.server.Close()
		rows, e := db.Query(ctx, "SELECT object_key FROM media WHERE org_id=$1 UNION ALL SELECT object_key FROM norm_assets WHERE org_id=$1 UNION ALL SELECT object_key FROM inspection_file_deletions WHERE org_id=$1 UNION ALL SELECT object_key FROM handover_artifacts WHERE org_id=$1 UNION ALL SELECT object_key FROM report_artifacts WHERE org_id=$1", f.org)
		if e == nil {
			for rows.Next() {
				var key string
				_ = rows.Scan(&key)
				_, _ = a.storage.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: &a.bucket, Key: &key})
			}
			rows.Close()
		}
		tx, e := db.Begin(ctx)
		if e == nil {
			_, _ = tx.Exec(ctx, `UPDATE organisations SET logo_asset_id=NULL WHERE id=$1`, f.org)
			for _, table := range []string{"manual_handovers", "inspection_measurements", "retention_policies", "report_deliveries", "report_artifacts", "inspection_events", "inspection_agreements", "security_events", "mail_jobs", "inspection_file_deletions", "property_events", "property_imports", "property_sync_jobs", "format_review_events", "scope_jobs", "format_answers", "transcription_jobs", "transcription_cache", "norm_assessments", "reports", "observations", "processing_jobs", "media", "batches", "rooms", "inspections", "mutation_cases", "properties", "property_sources", "memberships", "invitations", "oidc_states", "organisation_domains", "format_versions", "inspection_formats", "norm_versions", "norm_frameworks", "norm_assets", "room_elements", "organisation_roles"} {
				_, _ = tx.Exec(ctx, "DELETE FROM "+table+" WHERE org_id=$1", f.org)
			}
			_, _ = tx.Exec(ctx, "DELETE FROM organisations WHERE id=$1", f.org)
			_, _ = tx.Exec(ctx, "DELETE FROM sessions WHERE user_id=$1", f.uid)
			_, _ = tx.Exec(ctx, "DELETE FROM mobile_login_requests WHERE user_id=$1", f.uid)
			_, _ = tx.Exec(ctx, "DELETE FROM users WHERE id=$1", f.uid)
			_ = tx.Commit(ctx)
		}
		db.Close()
	})
	f.request("POST", "/auth/login", map[string]any{"email": f.email, "password": "integration-password-2026"}, 200)
	return f
}
func (f *fixture) request(method, path string, body any, status int) map[string]any {
	f.t.Helper()
	var reader io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		reader = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, f.server.URL+"/api/v1"+path, reader)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Satvey-Request", "1")
	res, e := f.client.Do(req)
	if e != nil {
		f.t.Fatal(e)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	if res.StatusCode != status {
		f.t.Fatalf("%s %s: got %d want %d: %s", method, path, res.StatusCode, status, b)
	}
	var out map[string]any
	_ = json.Unmarshal(b, &out)
	return out
}
func (f *fixture) inspection() (string, string) {
	f.t.Helper()
	pid, iid := id(), id()
	base := "/orgs/" + f.org
	f.request("POST", base+"/properties", map[string]any{"id": pid, "address": "Teststraat 24", "postcode": "1234 AB", "city": "Utrecht"}, 201)
	// Represents an inspection created before mandatory formats were introduced.
	f.legacyInspection(iid, pid, nil)
	d := f.request("GET", base+"/inspections/"+iid, nil, 200)
	return base + "/inspections/" + iid, d["rooms"].([]any)[0].(map[string]any)["id"].(string)
}
func (f *fixture) legacyInspection(iid, pid string, norm *string) {
	f.t.Helper()
	f.confirmFixtureProperty(pid)
	ctx := context.Background()
	elements, e := elementContext(ctx, f.a.db, f.org)
	if e != nil {
		f.t.Fatal(e)
	}
	if _, e = f.a.db.Exec(ctx, `INSERT INTO inspections(id,org_id,property_id,kind,created_by,norm_version_id,element_context) VALUES($1,$2,$3,'pre',$4,$5,$6)`, iid, f.org, pid, f.uid, norm, elements); e != nil {
		f.t.Fatal(e)
	}
	for _, name := range []string{"Entree", "Woonkamer", "Keuken", "Badkamer", "Slaapkamer", "Buitenruimte"} {
		if _, e = f.a.db.Exec(ctx, `INSERT INTO rooms(id,org_id,inspection_id,name) VALUES($1,$2,$3,$4)`, id(), f.org, iid, name); e != nil {
			f.t.Fatal(e)
		}
	}
}

// Unrelated inspection tests start with a confirmed catalog identity.
func (f *fixture) confirmFixtureProperty(pid string) {
	f.t.Helper()
	ctx := context.Background()
	source := id()
	tx, e := f.a.db.Begin(ctx)
	if e != nil {
		f.t.Fatal(e)
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, `INSERT INTO property_sources(id,org_id,name,administration,kind) VALUES($1,$2,'Test catalog',$3,'csv')`, source, f.org, source); e != nil {
		f.t.Fatal(e)
	}
	if _, e = tx.Exec(ctx, `UPDATE properties SET source_id=$1,source_object_id=id::text,link_state='linked' WHERE id=$2 AND org_id=$3 AND link_state='provisional'`, source, pid, f.org); e != nil {
		f.t.Fatal(e)
	}
	if e = tx.Commit(ctx); e != nil {
		f.t.Fatal(e)
	}
}
func (f *fixture) upload(path, mid string, body []byte, typ string, status int) {
	f.t.Helper()
	req, _ := http.NewRequest("PUT", f.server.URL+"/api/v1"+path+"/media/"+mid, bytes.NewReader(body))
	req.Header.Set("Content-Type", typ)
	req.Header.Set("X-Satvey-Request", "1")
	req.Header.Set("X-File-Name", "test.png")
	res, e := f.client.Do(req)
	if e != nil {
		f.t.Fatal(e)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	if res.StatusCode != status {
		f.t.Fatalf("upload got %d want %d: %s", res.StatusCode, status, b)
	}
}
func TestCaptureReportAndIsolation(t *testing.T) {
	f := setup(t)
	path, room := f.inspection()
	batch, photo, audio := id(), id(), id()
	payload := map[string]any{"id": batch, "roomId": room, "mediaIds": []string{photo, audio}}
	f.request("POST", path+"/batches", payload, 201)
	f.request("POST", path+"/batches", payload, 201)
	f.request("POST", path+"/report", map[string]any{}, 422)
	png, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=")
	f.upload(path+"/batches/"+batch, photo, []byte("not an image"), "image/png", 415)
	f.upload(path+"/batches/"+batch, photo, png, "image/png", 201)
	f.upload(path+"/batches/"+batch, photo, png, "image/png", 200)
	f.upload(path+"/batches/"+batch, photo, append(png, 1), "image/png", 409)
	f.request("PUT", path+"/batches/"+batch, map[string]any{"status": "reviewed", "version": 1}, 422)
	wav := make([]byte, 48)
	copy(wav, []byte("RIFF"))
	copy(wav[8:], []byte("WAVEfmt "))
	f.upload(path+"/batches/"+batch, audio, wav, "audio/wav", 201)
	f.request("POST", path+"/media/"+audio+"/transcription", map[string]any{"action": "skip", "reason": "Testfixture bevat geen spraak"}, 200)
	for i := 0; i < 20; i++ {
		if e := f.a.processJob(context.Background()); e != nil {
			t.Fatal(e)
		}
		d := f.request("GET", path, nil, 200)
		if len(d["observations"].([]any)) > 0 {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	d := f.request("GET", path, nil, 200)
	observations := d["observations"].([]any)
	if len(observations) != 1 {
		t.Fatalf("expected one mock observation, got %v", observations)
	}
	o := observations[0].(map[string]any)
	oid := o["id"].(string)
	if o["source"] != "mock" || o["status"] != "draft" {
		t.Fatal("mock must stay a draft")
	}
	update := map[string]any{"title": "Beschadigde wand", "description": "Beschadiging naast het raam.", "label": "Herstel", "status": "approved", "version": 1}
	f.request("PUT", path+"/observations/"+oid, update, 200)
	f.request("PUT", path+"/observations/"+oid, update, 409)
	d = f.request("GET", path, nil, 200)
	version := d["batches"].([]any)[0].(map[string]any)["version"]
	f.request("PUT", path+"/batches/"+batch, map[string]any{"status": "reviewed", "version": version}, 200)
	report := f.request("POST", path+"/report", map[string]any{}, 201)
	reportJSON, _ := json.Marshal(report)
	if bytes.Contains(reportJSON, []byte(audio)) {
		t.Fatal("audio leaked into report")
	}
	if !bytes.Contains(reportJSON, []byte(photo)) {
		t.Fatal("report lost photo")
	}
	f.request("PUT", path+"/observations/"+oid, update, 409)
	f.upload(path+"/batches/"+batch, photo, png, "image/png", 409)
	stored := f.request("GET", path+"/report", nil, 200)
	storedJSON, _ := json.Marshal(stored)
	if !bytes.Equal(reportJSON, storedJSON) {
		t.Fatal("snapshot changed")
	}
	req, _ := http.NewRequest("GET", f.server.URL+"/api/v1/orgs/"+f.org+"/media/"+photo, nil)
	res, e := f.client.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	got, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 || !bytes.Equal(png, got) {
		t.Fatal("object storage round trip failed")
	}
	outsider := setup(t)
	outsider.request("GET", "/orgs/"+f.org+"/inspections", nil, 404)
	outsider.request("GET", "/orgs/"+f.org+"/media/"+photo, nil, 404)
	f.request("PUT", "/orgs/"+f.org+"/members/"+f.uid, map[string]any{"role": "viewer"}, 422)
	if _, e = f.a.db.Exec(context.Background(), "UPDATE memberships SET role='viewer' WHERE org_id=$1 AND user_id=$2", f.org, f.uid); e != nil {
		t.Fatal(e)
	}
	f.request("POST", "/orgs/"+f.org+"/properties", map[string]any{"id": id(), "address": "Forbidden"}, 403)
}
func TestSessionInvitationAndCSRF(t *testing.T) {
	f := setup(t)
	r, _ := http.NewRequest("POST", f.server.URL+"/api/v1/auth/logout", strings.NewReader("{}"))
	res, e := f.client.Do(r)
	if e != nil {
		t.Fatal(e)
	}
	res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatal("mutation without custom header accepted")
	}
	r, _ = http.NewRequest("POST", f.server.URL+"/api/v1/auth/logout", strings.NewReader("{}"))
	r.Header.Set("X-Satvey-Request", "1")
	r.Header.Set("Origin", "https://attacker.invalid")
	res, e = f.client.Do(r)
	if e != nil {
		t.Fatal(e)
	}
	res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatal("foreign origin accepted")
	}
	invitation := f.request("POST", "/orgs/"+f.org+"/invitations", map[string]any{"email": f.email, "role": "inspector"}, 201)
	link := invitation["url"].(string)
	tok := strings.Split(link, "token=")[1]
	f.request("GET", "/invitations/"+tok, nil, 200)
	f.request("POST", "/invitations/accept", map[string]any{"token": tok, "name": "", "password": ""}, 200)
	f.request("POST", "/invitations/accept", map[string]any{"token": tok}, 404)
	f.request("POST", "/auth/logout", map[string]any{}, 200)
	f.request("GET", "/me", nil, 401)
	f.request("POST", "/auth/login", map[string]any{"email": f.email, "password": "incorrect"}, 401)
}
func TestInputValidation(t *testing.T) {
	if passwordMatches("broken", "anything") {
		t.Fatal("broken password accepted")
	}
	h, e := passwordHash("long-test-password")
	if e != nil || !passwordMatches(h, "long-test-password") || passwordMatches(h, "wrong") {
		t.Fatal("password hash check failed")
	}
	if _, e = passwordHash("short"); e == nil {
		t.Fatal("short password accepted")
	}
	if !validID(id()) || validID("invalid") {
		t.Fatal("uuid validation failed")
	}
	if e = validateObservation(observationInput{Status: "approved"}); e == nil {
		t.Fatal("empty approval accepted")
	}
	if e = validateObservation(observationInput{Title: "Fake", Description: "Voorbeeldvoorstel bij mock", Status: "approved"}); e == nil {
		t.Fatal("mock placeholder accepted into report")
	}
}
