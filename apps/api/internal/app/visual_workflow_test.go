package app

import (
	"context"
	"encoding/json"
	"net/http"
	"satvey/inspect/internal/quality"
	"strings"
	"testing"
	"time"
)

func TestReportVersionsStayInSameDossier(t *testing.T) {
	f := setup(t)
	path, iid := modernInspection(f)
	body := map[string]any{"version": dossierVersion(f, path), "signatures": []signatureInput{inspectorSignature()}, "signingException": map[string]string{"outcome": "absent", "note": "Bewoner afwezig"}}
	original := f.request("POST", path+"/report", body, 201)
	originalID := original["id"].(string)
	version := dossierVersion(f, path)
	f.request("POST", path+"/report/reopen", map[string]any{"version": version - 1, "reportId": originalID}, 409)
	f.request("POST", path+"/report/reopen", map[string]any{"version": version, "reportId": originalID}, 200)
	f.request("POST", path+"/report/reopen", map[string]any{"version": version, "reportId": originalID}, 200)
	if f.request("GET", path, nil, 200)["inspection"].(map[string]any)["id"] != iid {
		t.Fatal("editing created another dossier")
	}
	f.request("POST", path+"/report", map[string]any{"version": dossierVersion(f, path)}, 422)
	body["version"] = dossierVersion(f, path)
	updated := f.request("POST", path+"/report", body, 201)
	if updated["number"].(float64) != 2 || updated["id"] == originalID {
		t.Fatal("new report version missing")
	}
	historical := f.request("GET", path+"/report?reportId="+originalID, nil, 200)
	if historical["id"] != originalID || historical["createdAt"] != original["createdAt"] {
		t.Fatal("historical report changed")
	}
	var count int
	if err := f.a.db.QueryRow(context.Background(), `SELECT count(*) FROM report_artifacts WHERE org_id=$1 AND inspection_id=$2`, f.org, iid).Scan(&count); err != nil || count != 2 {
		t.Fatal("report artifacts not preserved", err)
	}
	outsider := setup(t)
	outsider.request("GET", path+"/report?reportId="+originalID, nil, 404)
}

func TestAutomaticActivityIsIdempotentAndDoesNotDoubleTime(t *testing.T) {
	f := setup(t)
	path, room := f.inspection()
	iid := strings.Split(path, "/inspections/")[1]
	now := time.Now().UTC().Truncate(time.Second).Add(-time.Minute)
	first := activityInput{ID: id(), InspectionID: iid, SessionID: id(), RoomID: &room, Phase: "capture", StartedAt: now, EndedAt: now.Add(15 * time.Second)}
	second := first
	second.ID = id()
	second.SessionID = id()
	second.Phase = "review"
	before := dossierVersion(f, path)
	payload := map[string]any{"events": []activityInput{first, second}}
	f.request("POST", "/orgs/"+f.org+"/activity-events", payload, 200)
	f.request("POST", "/orgs/"+f.org+"/activity-events", payload, 200)
	data := f.request("GET", "/orgs/"+f.org+"/analytics", nil, 200)
	summary := data["summary"].(map[string]any)
	if summary["activeMinutes"].(float64) != .25 {
		t.Fatalf("overlapping devices double counted: %#v", summary)
	}
	second.EndedAt = second.EndedAt.Add(time.Second)
	f.request("POST", "/orgs/"+f.org+"/activity-events", map[string]any{"events": []activityInput{second}}, 409)
	if before != dossierVersion(f, path) {
		t.Fatal("telemetry changed dossier revision")
	}
	if _, err := f.a.db.Exec(context.Background(), `UPDATE memberships SET role='viewer',role_id=(SELECT id FROM organisation_roles WHERE org_id=$1 AND system_key='viewer') WHERE org_id=$1 AND user_id=$2`, f.org, f.uid); err != nil {
		t.Fatal(err)
	}
	f.request("GET", "/orgs/"+f.org+"/analytics", nil, http.StatusForbidden)
}

func TestScoringUsesPerCriterionPolicyAndIndependentResponsibilities(t *testing.T) {
	f := setup(t)
	path, _ := f.inspection()
	iid := strings.Split(path, "/inspections/")[1]
	document := decodeNorm(t, f.request("POST", "/orgs/"+f.org+"/norms", map[string]any{"name": "Scores", "baseline": true}, 201))
	rule := &document.Rules[0]
	for score := 1; score <= 6; score++ {
		outcome := "acceptable"
		if score >= 3 {
			outcome = "unacceptable"
		}
		rule.ScoreLevels = append(rule.ScoreLevels, quality.ScoreLevel{Score: score, Label: "Niveau", Description: "Vastgelegd criterium", Outcome: outcome, RepairResponsibility: "corporation", CostResponsibility: "resident", References: []quality.ScoreReference{}})
	}
	f.request("PUT", "/orgs/"+f.org+"/norms/"+document.ID, document, 200)
	f.request("POST", "/orgs/"+f.org+"/norms/"+document.ID+"/publish", map[string]any{"revision": 2}, 200)
	if _, err := f.a.db.Exec(context.Background(), `UPDATE inspections SET norm_version_id=$3 WHERE id=$1 AND org_id=$2`, iid, f.org, document.ID); err != nil {
		t.Fatal(err)
	}
	score := 3
	detail := &scoreDetail{Score: &score}
	if err := validateScored(context.Background(), f.a.db, f.org, iid, rule.ID, "unacceptable", "confirmed", detail); err != nil {
		t.Fatal(err)
	}
	if detail.RepairResponsibility != "corporation" || detail.CostResponsibility != "resident" {
		t.Fatal("responsibilities were conflated")
	}
	if err := validateScored(context.Background(), f.a.db, f.org, iid, rule.ID, "acceptable", "confirmed", detail); err == nil {
		t.Fatal("global 1–3 threshold overrode criterion")
	}
	if err := validateScored(context.Background(), f.a.db, f.org, iid, rule.ID, "unacceptable", "confirmed", nil); err == nil {
		t.Fatal("scored assessment allowed missing score")
	}
	if err := validateScored(context.Background(), f.a.db, f.org, iid, rule.ID, "not_assessable", "unanswerable", nil); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(detail)
	if !strings.Contains(string(raw), "costResponsibility") {
		t.Fatal("score wire fields missing")
	}
}

func TestQualityFeedbackNeverBlocksInspectorFinalization(t *testing.T) {
	f, reviewer := setup(t), setup(t)
	path, _ := modernInspection(f)
	if _, err := f.a.db.Exec(context.Background(), `INSERT INTO memberships(org_id,user_id,role) VALUES($1,$2,'admin')`, f.org, reviewer.uid); err != nil {
		t.Fatal(err)
	}
	reviewer.request("POST", path+"/quality-review", map[string]any{"version": dossierVersion(f, path), "action": "changes_requested", "note": "Aandachtspunt voor opvolging"}, 200)
	f.request("POST", path+"/report", map[string]any{"version": dossierVersion(f, path), "signatures": []signatureInput{inspectorSignature()}, "signingException": map[string]string{"outcome": "absent", "note": "Bewoner afwezig"}}, 201)
	reviewer.request("POST", path+"/quality-review", map[string]any{"version": dossierVersion(f, path), "action": "approved", "note": "Achteraf gecontroleerd"}, 200)
}

func TestInternalSyncProfileUsesConfiguredCategoriesAndRejectsProductionWriteTests(t *testing.T) {
	c := receiverFixture(t)
	c.call("DELETE", "/_test/state", nil, 204)
	t.Cleanup(func() { c.call("DELETE", "/_test/state", nil, 204) })
	f := setup(t)
	f.a.workerOrg = f.org
	path, _ := f.inspection()
	destination := destinationFixture(f, c)
	base := "/orgs/" + f.org
	profile := map[string]any{"destinationId": destination, "enabled": true, "environment": "production", "revision": 0, "openApiUrl": "", "categories": map[string]any{"status": map[string]any{"enabled": true, "resource": c.base + "/dossier/v4/informatieobjecten", "fields": map[string]string{"omschrijving": "description", "bestand": "file.base64", "bestandsgrootte": "file.size", "bestandsnaam": "file.name"}, "testPayload": map[string]any{}}}}
	f.request("PUT", base+"/sync-profiles/"+destination, profile, 200)
	f.request("POST", base+"/sync-profiles/"+destination+"/test", map[string]string{"mode": "sandbox"}, 422)
	f.request("POST", base+"/sync-profiles/"+destination+"/test", map[string]string{"mode": "read"}, 200)
	if err := f.a.enqueueInternalSync(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := f.a.processInternalSync(context.Background()); err != nil {
		t.Fatal(err)
	}
	var status, message string
	if err := f.a.db.QueryRow(context.Background(), `SELECT status,error FROM internal_sync_jobs WHERE org_id=$1 AND category='status'`, f.org).Scan(&status, &message); err != nil || status != "done" {
		t.Fatalf("automatic internal sync failed: status=%s error=%s db=%v", status, message, err)
	}
	before := dossierVersion(f, path)
	if err := f.a.enqueueInternalSync(context.Background()); err != nil {
		t.Fatal(err)
	}
	var count int
	_ = f.a.db.QueryRow(context.Background(), `SELECT count(*) FROM internal_sync_jobs WHERE org_id=$1`, f.org).Scan(&count)
	if count != 1 || dossierVersion(f, path) != before {
		t.Fatal("synchronization duplicated a job or modified dossier content")
	}
}

func TestTranscriptAuditKeepsVersionWithoutRetainingRawText(t *testing.T) {
	f := setup(t)
	path, room := f.inspection()
	batch, mid := id(), id()
	f.request("POST", path+"/batches", map[string]any{"id": batch, "roomId": room, "mediaIds": []string{mid}}, 201)
	wav := make([]byte, 48)
	copy(wav, []byte("RIFF"))
	copy(wav[8:], []byte("WAVEfmt "))
	f.upload(path+"/batches/"+batch, mid, wav, "audio/wav", 201)
	media := f.request("GET", path, nil, 200)["media"].([]any)[0].(map[string]any)
	const text = "Private raw transcript must follow its own retention term"
	f.request("PUT", path+"/media/"+mid+"/transcript", map[string]any{"version": media["transcriptVersion"], "transcript": text}, 200)
	var detail string
	if err := f.a.db.QueryRow(context.Background(), `SELECT detail::text FROM inspection_events WHERE org_id=$1 AND detail->>'recordId'=$2 AND action='media_update' ORDER BY created_at DESC LIMIT 1`, f.org, mid).Scan(&detail); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(detail, text) || strings.Contains(detail, `"transcript":`) {
		t.Fatal("audit retained raw transcript text")
	}
	if !strings.Contains(detail, "transcript_version") {
		t.Fatal("audit lost transcript change context")
	}
}
