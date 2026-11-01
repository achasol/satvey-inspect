package app

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/jpeg"
	"io"
	"net/http"
	"net/url"
	"satvey/inspect/internal/maildelivery"
	"satvey/inspect/internal/reporting"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/s3"
)

func dossierVersion(f *fixture, path string) int {
	f.t.Helper()
	return int(f.request("GET", path, nil, 200)["inspection"].(map[string]any)["revision"].(float64))
}
func TestArchiveRestoreAndPurgeSafeguards(t *testing.T) {
	f := setup(t)
	path, _ := f.inspection()
	version := dossierVersion(f, path)
	f.request("POST", path+"/archive", map[string]any{"reason": "Dubbele opdracht", "version": version - 1}, 409)
	f.request("POST", path+"/archive", map[string]any{"reason": "Dubbele opdracht", "version": version}, 200)
	f.request("POST", path+"/rooms", map[string]any{"id": id(), "name": "Nieuwe ruimte"}, 409)
	f.request("POST", path+"/restore", map[string]any{"reason": "Toch nodig", "version": version + 1}, 200)
	if f.request("GET", path, nil, 200)["inspection"].(map[string]any)["archivedAt"] != nil {
		t.Fatal("restore did not reopen dossier")
	}
	f.request("DELETE", path+"/purge", map[string]any{"reason": "Test", "version": version + 2}, 409)
	f.request("POST", path+"/archive", map[string]any{"reason": "Test", "version": version + 2}, 200)
	f.request("PUT", path+"/retention-hold", map[string]any{"hold": true, "reason": "Lopend bezwaar", "version": version + 3}, 200)
	f.request("DELETE", path+"/purge", map[string]any{"reason": "Test", "version": version + 4}, 409)
	f.request("PUT", path+"/retention-hold", map[string]any{"hold": false, "reason": "Bezwaar afgehandeld", "version": version + 4}, 200)
	f.request("DELETE", path+"/purge", map[string]any{"reason": "Test", "version": version + 5}, 204)
	var events int
	if err := f.a.db.QueryRow(context.Background(), `SELECT count(*) FROM inspection_events WHERE org_id=$1 AND action='purged'`, f.org).Scan(&events); err != nil || events != 1 {
		t.Fatal("minimal purge receipt missing", err)
	}
}
func modernInspection(f *fixture) (string, string) {
	f.t.Helper()
	base := "/orgs/" + f.org
	norm := decodeNorm(f.t, f.request("POST", base+"/norms", map[string]any{"name": "Bezoeknormen", "baseline": true}, 201))
	f.request("POST", base+"/norms/"+norm.ID+"/publish", map[string]any{"revision": norm.Revision}, 200)
	created := f.request("POST", base+"/formats", map[string]any{"name": "Ondertekend bezoek", "kind": "pre", "normVersionId": norm.ID}, 201)
	raw := f.request("GET", base+"/formats/"+created["id"].(string), nil, 200)
	encoded, _ := json.Marshal(raw)
	var doc formatDocument
	_ = json.Unmarshal(encoded, &doc)
	doc.Scopes = []formatScope{{ID: id(), Name: "Woning algemeen", NormRoom: "Woning algemeen", Property: true, Required: true, Questions: []formatQuestion{{ID: id(), Title: "Bezoek uitgevoerd?", Kind: "boolean", Required: true, Evidence: "none"}}}}
	f.request("PUT", base+"/formats/"+doc.ID, doc, 200)
	f.request("POST", base+"/formats/"+doc.ID+"/publish", map[string]any{"revision": 2}, 200)
	path, iid := testFormatInspection(f, doc)
	room, _ := testRoom(f, path, doc.Scopes[0].ID)
	answer := testAnswers(f, path, room)[0]
	answer.Value = json.RawMessage("true")
	answer.Status = "confirmed"
	f.request("PUT", path+"/answers/"+answer.ID, answer, 200)
	testApprove(f, path, room, "", 200)
	f.request("PUT", path+"/visit", map[string]any{"version": dossierVersion(f, path), "visitedAt": time.Now().UTC(), "visitOutcome": "visited"}, 200)
	return path, iid
}
func inspectorSignature() signatureInput {
	return signatureInput{Name: "Inspecteur", Role: "inspector", Strokes: [][]reporting.Point{{{X: .1, Y: .2}, {X: .8, Y: .7}}}}
}
func TestSigningPolicyAndOptionalQualityReview(t *testing.T) {
	f, reviewer := setup(t), setup(t)
	ctx := context.Background()
	path, _ := modernInspection(f)
	if _, err := f.a.db.Exec(ctx, `INSERT INTO memberships(org_id,user_id,role) VALUES($1,$2,'admin')`, f.org, reviewer.uid); err != nil {
		t.Fatal(err)
	}
	reviewer.request("POST", path+"/quality-review", map[string]any{"version": dossierVersion(f, path), "action": "requested", "note": "Eigen inspectie"}, 422)
	reviewer.request("POST", path+"/quality-review", map[string]any{"version": dossierVersion(f, path), "action": "changes_requested", "note": "Steekproef"}, 200)
	body := map[string]any{"version": dossierVersion(f, path), "signatures": []signatureInput{inspectorSignature()}, "signingException": map[string]string{"outcome": "absent", "note": "Bewoner afwezig"}}
	reviewer.request("POST", path+"/quality-review", map[string]any{"version": dossierVersion(f, path), "action": "approved", "note": "Gecontroleerd"}, 200)
	body["version"] = dossierVersion(f, path) - 1
	f.request("POST", path+"/report", body, 409)
	body["version"] = dossierVersion(f, path)
	body["signatures"] = []signatureInput{}
	f.request("POST", path+"/report", body, 422)
	body["signatures"] = []signatureInput{inspectorSignature()}
	report := f.request("POST", path+"/report", body, 201)
	if report["signingException"].(map[string]any)["outcome"] != "absent" {
		t.Fatal("signing exception lost")
	}
	f.request("PUT", path+"/retention-hold", map[string]any{"hold": true, "reason": "Dossier bewaren", "version": dossierVersion(f, path)}, 200)
	current := f.request("GET", path, nil, 200)["inspection"].(map[string]any)
	if current["reviewStatus"] != "approved" {
		t.Fatal("operational metadata invalidated the finalized quality approval")
	}
}
func TestCorrectionAndFollowupPreserveOriginal(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	path, iid := modernInspection(f)
	f.request("PUT", path+"/agreements", agreementInput{ID: id(), Description: "Deur herstellen", Responsibility: "resident", Status: "open", PhotoIDs: []string{}}, 200)
	// An agreement changes the content revision, but not room evidence approval.
	report := f.request("POST", path+"/report", map[string]any{"version": dossierVersion(f, path), "signatures": []signatureInput{inspectorSignature()}, "signingException": map[string]string{"outcome": "refused", "note": "Bewoner wil niet tekenen"}}, 201)
	before, _ := json.Marshal(report)
	correction := f.request("POST", path+"/corrections", map[string]any{"version": dossierVersion(f, path), "reason": "Onjuiste omschrijving"}, 201)
	next := "/orgs/" + f.org + "/inspections/" + correction["id"].(string)
	d := f.request("GET", next, nil, 200)
	if d["inspection"].(map[string]any)["correctsInspectionId"] != iid || len(d["agreements"].([]any)) != 1 {
		t.Fatal("correction lost lineage or agreements")
	}
	after, _ := json.Marshal(f.request("GET", path+"/report", nil, 200))
	if !bytes.Equal(before, after) {
		t.Fatal("correction changed original report")
	}
	f.request("POST", next+"/report", map[string]any{}, 409) // New policy requires current content binding.
	var format string
	if err := f.a.db.QueryRow(ctx, `SELECT format_version_id FROM inspections WHERE id=$1`, iid).Scan(&format); err != nil {
		t.Fatal(err)
	}
	follow := f.request("POST", path+"/followups", map[string]any{"id": id(), "version": dossierVersion(f, path), "formatVersionId": format, "reference": "MUT-42"}, 201)
	followData := f.request("GET", "/orgs/"+f.org+"/inspections/"+follow["id"].(string), nil, 200)
	if len(followData["media"].([]any)) != 0 || len(followData["agreements"].([]any)) != 1 {
		t.Fatal("followup reused condition evidence or lost actions")
	}
}
func TestCorrectionOwnsIndependentEvidence(t *testing.T) {
	f := setup(t)
	path, room := f.inspection()
	batch, photo := id(), id()
	f.request("POST", path+"/batches", map[string]any{"id": batch, "roomId": room, "mediaIds": []string{photo}}, 201)
	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, image.NewRGBA(image.Rect(0, 0, 10, 10)), nil); err != nil {
		t.Fatal(err)
	}
	photoBytes := encoded.Bytes()
	f.upload(path+"/batches/"+batch, photo, photoBytes, "image/jpeg", 201)
	ctx := context.Background()
	_, _ = f.a.db.Exec(ctx, `UPDATE processing_jobs SET status='done' WHERE batch_id=$1`, batch)
	_, _ = f.a.db.Exec(ctx, `UPDATE batches SET status='reviewed' WHERE id=$1`, batch)
	f.request("POST", path+"/report", map[string]any{}, 201)
	corrected := f.request("POST", path+"/corrections", map[string]any{"version": dossierVersion(f, path), "reason": "Correctie"}, 201)
	var originalKey, newKey string
	if err := f.a.db.QueryRow(ctx, `SELECT object_key FROM media WHERE id=$1`, photo).Scan(&originalKey); err != nil {
		t.Fatal(err)
	}
	if err := f.a.db.QueryRow(ctx, `SELECT object_key FROM media WHERE inspection_id=$1`, corrected["id"]).Scan(&newKey); err != nil {
		t.Fatal(err)
	}
	f.request("POST", "/orgs/"+f.org+"/inspections/"+corrected["id"].(string)+"/report", map[string]any{}, 409)
	if originalKey == newKey {
		t.Fatal("correction shares deletion ownership")
	}
	if _, err := f.a.storage.HeadObject(ctx, &s3.HeadObjectInput{Bucket: &f.a.bucket, Key: &newKey}); err != nil {
		t.Fatal("evidence was not copied", err)
	}
}
func TestRemapRecordIncludesTranscriptKeys(t *testing.T) {
	value := map[string]any{"photos": []any{"photo"}, "versions": map[string]any{"photo": float64(3)}}
	result := remapRecord(value, map[string]string{"photo": "copy"}).(map[string]any)
	if result["photos"].([]any)[0] != "copy" || result["versions"].(map[string]any)["copy"] != float64(3) {
		t.Fatal("incomplete source remapping")
	}
}

func TestNativeLoginPKCEAndSessionIsolation(t *testing.T) {
	f := setup(t)
	verifier := strings.Repeat("v", 64)
	sum := sha256.Sum256([]byte(verifier))
	state := strings.Repeat("s", 64)
	start := f.request("POST", "/auth/mobile/start", map[string]any{"challenge": base64.RawURLEncoding.EncodeToString(sum[:]), "state": state}, 200)
	launch, _ := url.Parse(start["url"].(string))
	authorised := f.request("POST", "/auth/mobile/authorize", map[string]any{"request": launch.Query().Get("mobileRequest")}, 200)
	callback, _ := url.Parse(authorised["url"].(string))
	code := callback.Query().Get("code")
	if callback.Scheme != "nl.satvey.inspect" || callback.Query().Get("state") != state {
		t.Fatal("invalid callback")
	}
	f.request("POST", "/auth/mobile/exchange", map[string]any{"code": code, "verifier": strings.Repeat("x", 64)}, 401)
	session := f.request("POST", "/auth/mobile/exchange", map[string]any{"code": code, "verifier": verifier}, 200)
	f.request("POST", "/auth/mobile/exchange", map[string]any{"code": code, "verifier": verifier}, 401)
	req, _ := http.NewRequest("GET", f.server.URL+"/api/v1/me", nil)
	req.Header.Set("Authorization", "Bearer "+session["token"].(string))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("native token rejected: %d", res.StatusCode)
	}
	req.Header.Del("Authorization")
	req.AddCookie(&http.Cookie{Name: "satvey_session", Value: session["token"].(string)})
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 401 {
		t.Fatal("native token accepted as browser cookie")
	}
}
func TestRetentionRequiresExplicitActivationAndCurrentVersion(t *testing.T) {
	f := setup(t)
	path := "/orgs/" + f.org + "/retention"
	initial := f.request("GET", path, nil, 200)
	if initial["policy"].(map[string]any)["enabled"] != false {
		t.Fatal("retention enabled by default")
	}
	f.request("PUT", path, map[string]any{"version": 3, "enabled": true, "audioDays": 30}, 409)
	f.request("PUT", path, map[string]any{"version": 0, "enabled": false, "audioDays": 30}, 200)
	f.request("PUT", path, map[string]any{"version": 0, "enabled": true, "audioDays": 30}, 409)
	f.request("PUT", path, map[string]any{"version": 1, "enabled": true}, 422)
	f.request("PUT", path, map[string]any{"version": 1, "enabled": true, "audioDays": 30}, 200)
}

func TestReportEmailUsesFrozenAttachmentAndIdempotentRequest(t *testing.T) {
	f := setup(t)
	path, _ := handoverFixture(f)
	report := f.request("GET", path+"/report", nil, 200)
	var messages []maildelivery.Message
	f.a.deliver = func(_ context.Context, m maildelivery.Message) error { messages = append(messages, m); return nil }
	body := map[string]any{"id": id(), "reportId": report["id"], "recipient": "resident@example.invalid"}
	f.request("POST", path+"/report/email", body, 202)
	f.request("POST", path+"/report/email", body, 202)
	if err := f.a.processMail(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(messages) != 1 || len(messages[0].Attachments) != 1 || !bytes.HasPrefix(messages[0].Attachments[0].Data, []byte("%PDF")) {
		t.Fatal("expected exactly one PDF attachment")
	}
	var size int
	if err := f.a.db.QueryRow(context.Background(), `SELECT size FROM report_artifacts WHERE report_id=$1`, report["id"]).Scan(&size); err != nil || size != len(messages[0].Attachments[0].Data) {
		t.Fatal("attachment is not retained report", err)
	}
	f.request("POST", path+"/manual-handovers", map[string]any{"id": id(), "reportId": report["id"], "recipient": "Klant onderhoud", "channel": "Klantportaal", "reference": "CASE-42", "note": "In portaal geregistreerd", "acknowledged": true}, 201)
	version := dossierVersion(f, path)
	f.request("POST", path+"/archive", map[string]any{"reason": "Voltooid", "version": version}, 200)
	f.request("POST", path+"/report/email", map[string]any{"id": id(), "reportId": report["id"], "recipient": "resident@example.invalid"}, 404)
}
func TestInspectionPageSearchAndAssignmentQueue(t *testing.T) {
	f := setup(t)
	path, _ := f.inspection()
	page := "/orgs/" + f.org + "/inspection-page"
	r := f.request("GET", page+"?q=1234AB", nil, 200)
	if r["total"].(float64) != 1 {
		t.Fatal("postcode search did not normalize spaces")
	}
	f.request("PUT", path+"/planning", map[string]any{"version": dossierVersion(f, path), "assignedTo": f.uid, "priority": "high", "visitOutcome": "scheduled", "externalReference": "MUT-42"}, 200)
	r = f.request("GET", page+"?view=mine&q=MUT-42", nil, 200)
	if r["total"].(float64) != 1 {
		t.Fatal("assigned queue missing inspection")
	}
	r = f.request("GET", page+"?view=unassigned", nil, 200)
	if r["total"].(float64) != 0 {
		t.Fatal("assigned inspection remained unassigned")
	}
}

func TestTenantExitIncludesFrozenPDFAndCatalogWithoutCredentials(t *testing.T) {
	f := setup(t)
	path, _ := handoverFixture(f)
	report := f.request("GET", path+"/report", nil, 200)
	response, err := f.client.Get(f.server.URL + "/api/v1/orgs/" + f.org + "/exit-export?limit=1")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(response.Body)
	if response.StatusCode != 200 {
		t.Fatalf("exit status %d: %s", response.StatusCode, raw)
	}
	archive, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatal(err)
	}
	files := map[string][]byte{}
	for _, file := range archive.File {
		r, e := file.Open()
		if e != nil {
			t.Fatal(e)
		}
		files[file.Name], e = io.ReadAll(r)
		r.Close()
		if e != nil {
			t.Fatal(e)
		}
	}
	if !bytes.Contains(files["configuration/properties.json"], []byte("Teststraat")) {
		t.Fatal("exit omitted catalog")
	}
	prefix := "inspections/" + strings.TrimPrefix(path, "/orgs/"+f.org+"/inspections/") + "/"
	if !bytes.HasPrefix(files[prefix+"reports/"+report["id"].(string)+".pdf"], []byte("%PDF")) {
		t.Fatal("exit omitted frozen PDF")
	}
	if _, ok := files[prefix+"history.json"]; !ok {
		t.Fatal("exit omitted history")
	}
	if bytes.Contains(files["configuration/members.json"], []byte("password_hash")) {
		t.Fatal("exit contains login credentials")
	}
	if _, ok := files["manifest.json"]; !ok {
		t.Fatal("exit missing cursor manifest")
	}
}
func TestAccountDeletionRequiresAdminTransferAndRevokesLogin(t *testing.T) {
	f := setup(t)
	f.request("POST", "/account/delete", map[string]any{"confirmation": f.email}, 422)
	other := id()
	ctx := context.Background()
	if _, err := f.a.db.Exec(ctx, `INSERT INTO users(id,email,name) VALUES($1,$2,'Beheerder twee')`, other, other+"@test.invalid"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = f.a.db.Exec(ctx, `DELETE FROM memberships WHERE user_id=$1`, other)
		_, _ = f.a.db.Exec(ctx, `DELETE FROM users WHERE id=$1`, other)
	})
	if _, err := f.a.db.Exec(ctx, `INSERT INTO memberships(org_id,user_id,role) VALUES($1,$2,'admin')`, f.org, other); err != nil {
		t.Fatal(err)
	}
	f.request("POST", "/account/delete", map[string]any{"confirmation": f.email}, 200)
	f.request("GET", "/me", nil, 401)
	var name, email string
	if err := f.a.db.QueryRow(ctx, `SELECT name,email FROM users WHERE id=$1`, f.uid).Scan(&name, &email); err != nil {
		t.Fatal(err)
	}
	if name != "Verwijderd account" || email == f.email {
		t.Fatal("login identity was not pseudonymized")
	}
}

func TestMoveEvidencePreservesFilesAndInvalidatesSourceReview(t *testing.T) {
	f := setup(t)
	path, room := f.inspection()
	batch := id()
	photos := []string{id(), id()}
	f.request("POST", path+"/batches", map[string]any{"id": batch, "roomId": room, "mediaIds": photos}, 201)
	var encoded bytes.Buffer
	_ = jpeg.Encode(&encoded, image.NewRGBA(image.Rect(0, 0, 8, 8)), nil)
	for _, photo := range photos {
		f.upload(path+"/batches/"+batch, photo, encoded.Bytes(), "image/jpeg", 201)
	}
	if _, err := f.a.db.Exec(context.Background(), `UPDATE processing_jobs SET status='done' WHERE batch_id=$1`, batch); err != nil {
		t.Fatal(err)
	}
	destination := id()
	f.request("POST", path+"/rooms", map[string]any{"id": destination, "name": "Andere ruimte"}, 201)
	data := f.request("GET", path, nil, 200)
	version := data["batches"].([]any)[0].(map[string]any)["version"]
	f.request("POST", path+"/batches/"+batch+"/move", map[string]any{"version": version, "roomId": destination, "mediaIds": photos[:1]}, 200)
	data = f.request("GET", path, nil, 200)
	if len(data["batches"].([]any)) != 2 || len(data["media"].([]any)) != 2 {
		t.Fatal("move lost source files")
	}
	var movedRoom, originalRoom string
	if err := f.a.db.QueryRow(context.Background(), `SELECT b.room_id FROM media m JOIN batches b ON b.id=m.batch_id WHERE m.id=$1`, photos[0]).Scan(&movedRoom); err != nil {
		t.Fatal(err)
	}
	if err := f.a.db.QueryRow(context.Background(), `SELECT b.room_id FROM media m JOIN batches b ON b.id=m.batch_id WHERE m.id=$1`, photos[1]).Scan(&originalRoom); err != nil {
		t.Fatal(err)
	}
	if movedRoom != destination || originalRoom != room {
		t.Fatal("move changed the wrong room")
	}
}

func TestActivatedAudioRetentionHonorsHoldAndPreservesTranscript(t *testing.T) {
	f := setup(t)
	path, room := f.inspection()
	batch, mid := id(), id()
	f.request("POST", path+"/batches", map[string]any{"id": batch, "roomId": room, "mediaIds": []string{mid}}, 201)
	wav := make([]byte, 48)
	copy(wav, []byte("RIFF"))
	copy(wav[8:], []byte("WAVEfmt "))
	f.upload(path+"/batches/"+batch, mid, wav, "audio/wav", 201)
	ctx := context.Background()
	for _, query := range []string{`UPDATE processing_jobs SET status='done' WHERE batch_id=$1`, `UPDATE transcription_jobs SET status='skipped' WHERE media_id IN(SELECT id FROM media WHERE batch_id=$1)`, `UPDATE batches SET status='reviewed' WHERE id=$1`, `UPDATE media SET created_at=now()-interval '2 days',transcript='Bewaarde tekst' WHERE batch_id=$1`} {
		if _, err := f.a.db.Exec(ctx, query, batch); err != nil {
			t.Fatal(err)
		}
	}
	f.request("POST", path+"/report", map[string]any{}, 201)
	f.request("PUT", path+"/retention-hold", map[string]any{"hold": true, "reason": "Bezwaar", "version": dossierVersion(f, path)}, 200)
	policy := "/orgs/" + f.org + "/retention"
	f.request("PUT", policy, map[string]any{"version": 0, "enabled": true, "audioDays": 1}, 200)
	_ = f.a.runRetention(ctx, f.org)
	var held bool
	if err := f.a.db.QueryRow(ctx, `SELECT content_deleted_at IS NULL FROM media WHERE id=$1`, mid).Scan(&held); err != nil || !held {
		t.Fatal("hold did not protect audio", err)
	}
	f.request("PUT", path+"/retention-hold", map[string]any{"hold": false, "reason": "Afgehandeld", "version": dossierVersion(f, path)}, 200)
	if err := f.a.runRetention(ctx, f.org); err != nil {
		t.Fatal(err)
	}
	var retired bool
	var transcript string
	if err := f.a.db.QueryRow(ctx, `SELECT content_deleted_at IS NOT NULL,transcript FROM media WHERE id=$1`, mid).Scan(&retired, &transcript); err != nil || !retired || transcript != "Bewaarde tekst" {
		t.Fatal("audio and transcript policies were not independent", err)
	}
	response, err := f.client.Get(f.server.URL + "/api/v1/orgs/" + f.org + "/media/" + mid)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 410 {
		t.Fatal("retired raw evidence was still served")
	}
}
