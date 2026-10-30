package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/jpeg"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func decodeNorm(t *testing.T, data map[string]any) normDocument {
	t.Helper()
	raw, _ := json.Marshal(data)
	var doc normDocument
	if e := json.Unmarshal(raw, &doc); e != nil {
		t.Fatal(e)
	}
	return doc
}

func TestFlexiblePrivilegesAndTenantRoles(t *testing.T) {
	other := setup(t)
	f := setup(t)
	base := "/orgs/" + f.org
	ctx := context.Background()
	roles := f.request("GET", base+"/roles", nil, 200)
	if len(roles["privileges"].([]any)) != len(privilegeCatalog) {
		t.Fatal("privilege catalog missing")
	}
	created := f.request("POST", base+"/roles", roleInput{Name: "Policy author", Privileges: []string{"norms.read", "norms.manage"}}, 201)
	rid := created["id"].(string)
	f.request("POST", base+"/roles", roleInput{Name: "Bad dependency", Privileges: []string{"norms.manage"}}, 422)
	f.request("POST", base+"/roles", roleInput{Name: "Bad privilege", Privileges: []string{"superadmin"}}, 400)
	f.request("POST", base+"/roles", roleInput{Name: "Policy author"}, 409)
	other.request("PUT", base+"/roles/"+rid, roleInput{Name: "Tampered", Version: 1}, 404)
	otherRole := other.request("POST", "/orgs/"+other.org+"/roles", roleInput{Name: "Foreign"}, 201)["id"].(string)
	f.request("POST", base+"/invitations", map[string]any{"email": "invite@test.invalid", "roleId": otherRole}, 400)
	// An actual member must retain organisation management, regardless of role name.
	var adminID string
	if e := f.a.db.QueryRow(ctx, "SELECT role_id FROM memberships WHERE org_id=$1 AND user_id=$2", f.org, f.uid).Scan(&adminID); e != nil {
		t.Fatal(e)
	}
	f.request("PUT", base+"/roles/"+adminID, roleInput{Name: "Beheerder", Version: 1, Privileges: []string{"norms.read"}}, 422)
	f.request("PUT", base+"/members/"+f.uid, map[string]any{"roleId": rid}, 422)
	// Custom-role invitations retain the selected privileges on acceptance.
	invitation := f.request("POST", base+"/invitations", map[string]any{"email": other.email, "roleId": rid}, 201)
	inviteToken := strings.Split(invitation["url"].(string), "token=")[1]
	other.request("POST", "/invitations/accept", map[string]any{"token": inviteToken}, 200)
	other.request("POST", base+"/norms", map[string]any{"name": "Policy draft", "baseline": true}, 201)
	other.request("POST", base+"/properties", map[string]any{"id": id(), "address": "Forbidden"}, 403)
	other.request("GET", base+"/roles", nil, 403)
	other.request("GET", base+"/norms/benchmark?normVersionId="+id(), nil, 403)
	f.request("DELETE", base+"/roles/"+rid, nil, 409)
	// Role edits take effect on the existing session immediately, including grants.
	edited := roleInput{Name: "Custom inspector", Version: 1, Privileges: []string{"inspections.read", "inspections.write"}}
	f.request("PUT", base+"/roles/"+rid, edited, 200)
	f.request("PUT", base+"/roles/"+rid, edited, 409)
	other.request("POST", base+"/properties", map[string]any{"id": id(), "address": "Allowed"}, 201)
	other.request("POST", base+"/norms", map[string]any{"name": "Forbidden"}, 403)
	// Keep cleanup ownership local to the fixture, even after failures.
	t.Cleanup(func() {
		_, _ = f.a.db.Exec(ctx, "DELETE FROM memberships WHERE org_id=$1 AND user_id=$2", f.org, other.uid)
	})
}

func TestNormLifecycleTranscriptAndBenchmark(t *testing.T) {
	f := setup(t)
	outsider := setup(t)
	base := "/orgs/" + f.org
	ctx := context.Background()
	doc := decodeNorm(t, f.request("POST", base+"/norms", map[string]any{"name": "Corporate quality", "baseline": true}, 201))
	if len(doc.Rules) != 12 || len(doc.Sources) != 4 {
		t.Fatal("baseline incomplete")
	}
	// Keep one measure for an end-to-end audio-only inspection.
	doc.Rules = doc.Rules[:1]
	doc.Rules[0].Rooms = []string{"*"}
	doc.Rules[0].Modalities = []string{"audio"}
	doc.Rules[0].Examples = doc.Rules[0].Examples[:1]
	f.request("PUT", base+"/norms/"+doc.ID, map[string]any{"name": doc.Name, "rules": doc.Rules, "revision": 1}, 200)
	f.request("POST", base+"/norms/"+doc.ID+"/publish", map[string]any{"revision": 2}, 422)
	doc.Rules[0].Examples = append(doc.Rules[0].Examples, normExample{ID: id(), Outcome: "unacceptable", Caption: "Zichtbare aantasting"})
	f.request("PUT", base+"/norms/"+doc.ID, map[string]any{"name": doc.Name, "rules": doc.Rules, "revision": 2}, 200)
	f.request("POST", base+"/norms/"+doc.ID+"/publish", map[string]any{"revision": 3}, 200)
	f.request("PUT", base+"/norms/"+doc.ID, map[string]any{"name": "Overwrite", "rules": doc.Rules, "revision": 4}, 409)
	if _, e := f.a.db.Exec(ctx, "UPDATE norm_versions SET name='forbidden' WHERE id=$1", doc.ID); e == nil {
		t.Fatal("published database version was mutable")
	}
	next := f.request("POST", base+"/norms/"+doc.ID+"/revisions", map[string]any{}, 201)
	same := f.request("POST", base+"/norms/"+doc.ID+"/revisions", map[string]any{}, 200)
	if next["id"] != same["id"] {
		t.Fatal("duplicate revision draft")
	}
	outsider.request("GET", base+"/norms/"+doc.ID, nil, 404)
	pid, iid := id(), id()
	f.request("POST", base+"/properties", map[string]any{"id": pid, "address": "Norm test"}, 201)
	f.request("POST", base+"/inspections", map[string]any{"id": iid, "propertyId": pid, "kind": "pre", "normVersionId": next["id"]}, 422)
	f.legacyInspection(iid, pid, &doc.ID)
	path := base + "/inspections/" + iid
	data := f.request("GET", path, nil, 200)
	if data["norms"].(map[string]any)["id"] != doc.ID {
		t.Fatal("inspection lost pinned version")
	}
	room := data["rooms"].([]any)[0].(map[string]any)["id"].(string)
	batch, audio := id(), id()
	f.request("POST", path+"/batches", map[string]any{"id": batch, "roomId": room, "mediaIds": []string{audio}}, 201)
	data = f.request("GET", path, nil, 200)
	assessment := data["assessments"].([]any)[0].(map[string]any)
	aid := assessment["id"].(string)
	f.request("PUT", path+"/assessments/"+aid, map[string]any{"version": 1, "outcome": "acceptable", "note": "Before analysis"}, 409)
	wav := make([]byte, 48)
	copy(wav, []byte("RIFF"))
	copy(wav[8:], []byte("WAVEfmt "))
	f.upload(path+"/batches/"+batch, audio, wav, "audio/wav", 201)
	if e := f.a.processJob(ctx); e != nil {
		t.Fatal(e)
	}
	f.request("PUT", path+"/media/"+audio+"/transcript", map[string]any{"version": 1, "transcript": "De inspecteur meldt vochtsporen bij de kraan."}, 200)
	f.request("PUT", path+"/media/"+audio+"/transcript", map[string]any{"version": 1, "transcript": "stale"}, 409)
	data = f.request("GET", path, nil, 200)
	assessment = data["assessments"].([]any)[0].(map[string]any)
	if assessment["stale"] != true {
		t.Fatal("transcript did not invalidate assessment")
	}
	f.request("POST", path+"/report", map[string]any{}, 422)
	if e := f.a.processJob(ctx); e != nil {
		t.Fatal(e)
	}
	data = f.request("GET", path, nil, 200)
	assessment = data["assessments"].([]any)[0].(map[string]any)
	benchmark := f.request("GET", base+"/norms/benchmark?normVersionId="+doc.ID, nil, 200)
	row := benchmark["rows"].([]any)[0].(map[string]any)
	if row["acceptable"] != float64(0) || row["pending"] != float64(1) {
		t.Fatal("unconfirmed results affected benchmark")
	}
	review := map[string]any{"version": assessment["version"], "outcome": "acceptable", "note": ""}
	f.request("PUT", path+"/assessments/"+aid, review, 422)
	review["note"] = "Inspecteur heeft dit gecontroleerd"
	f.request("PUT", path+"/assessments/"+aid, review, 200)
	f.request("PUT", path+"/assessments/"+aid, review, 409)
	benchmark = f.request("GET", base+"/norms/benchmark?normVersionId="+doc.ID, nil, 200)
	row = benchmark["rows"].([]any)[0].(map[string]any)
	if row["acceptable"] != float64(1) || row["pending"] != float64(0) {
		t.Fatal("confirmed assessment missing from benchmark")
	}
	f.request("PUT", path+"/media/"+audio+"/transcript", map[string]any{"version": 2, "transcript": "Nieuwe verklaring"}, 200)
	benchmark = f.request("GET", base+"/norms/benchmark?normVersionId="+doc.ID, nil, 200)
	row = benchmark["rows"].([]any)[0].(map[string]any)
	if row["acceptable"] != float64(0) || row["pending"] != float64(1) {
		t.Fatal("stale assessment still benchmarked as pass")
	}
	// Explicit manual fallback can be reviewed, but requires an explanation.
	f.request("POST", path+"/batches/"+batch+"/analysis", map[string]any{"action": "skip"}, 200)
	data = f.request("GET", path, nil, 200)
	assessment = data["assessments"].([]any)[0].(map[string]any)
	f.request("PUT", path+"/assessments/"+aid, map[string]any{"version": assessment["version"], "outcome": "not_assessable", "note": "Geen bruikbaar bewijs"}, 200)
	data = f.request("GET", path, nil, 200)
	for _, v := range data["observations"].([]any) {
		o := v.(map[string]any)
		f.request("PUT", path+"/observations/"+o["id"].(string), map[string]any{"version": o["version"], "status": "rejected"}, 200)
	}
	data = f.request("GET", path, nil, 200)
	f.request("PUT", path+"/batches/"+batch, map[string]any{"version": data["batches"].([]any)[0].(map[string]any)["version"], "status": "reviewed"}, 200)
	report := f.request("POST", path+"/report", map[string]any{}, 201)
	raw, _ := json.Marshal(report)
	if bytes.Contains(raw, []byte(audio)) || bytes.Contains(raw, []byte("Nieuwe verklaring")) {
		t.Fatal("internal transcript leaked into report")
	}
	if report["norms"].(map[string]any)["id"] != doc.ID {
		t.Fatal("report lost norm version")
	}
	f.request("PUT", path+"/media/"+audio+"/transcript", map[string]any{"version": 3, "transcript": "late edit"}, 409)
}

func TestRoomElementsAndPrivateExamples(t *testing.T) {
	f := setup(t)
	other := setup(t)
	base := "/orgs/" + f.org
	element := roomElement{Name: "Douchekraan", Description: "Mengkraan in de douche", Rooms: []string{"Badkamer"}, Aliases: []string{"faucet"}, AIGuidance: "Controleer de zichtbare aansluiting"}
	created := f.request("POST", base+"/elements", element, 201)
	eid := created["id"].(string)
	path, roomID := f.inspection()
	var room string
	if e := f.a.db.QueryRow(context.Background(), "SELECT name FROM rooms WHERE id=$1", roomID).Scan(&room); e != nil {
		t.Fatal(e)
	}
	// A bathroom-specific element must never be injected into an unrelated room.
	input, _, e := f.a.normInput(context.Background(), f.org, strings.Split(path, "/inspections/")[1], id(), room, false)
	if e != nil {
		t.Fatal(e)
	}
	for _, el := range input.Elements {
		if el.ID == eid && room != "Badkamer" {
			t.Fatal("room context leaked")
		}
	}
	before, _, e := f.a.normInput(context.Background(), f.org, strings.Split(path, "/inspections/")[1], id(), "Badkamer", false)
	if e != nil {
		t.Fatal(e)
	}
	element.ID = eid
	element.Version = 1
	element.AIGuidance = "Changed guidance"
	element.Archived = true
	f.request("PUT", base+"/elements/"+eid, element, 200)
	f.request("PUT", base+"/elements/"+eid, element, 409)
	other.request("PUT", base+"/elements/"+eid, element, 404)
	after, _, e := f.a.normInput(context.Background(), f.org, strings.Split(path, "/inspections/")[1], id(), "Badkamer", false)
	if e != nil {
		t.Fatal(e)
	}
	rawBefore, _ := json.Marshal(before.Elements)
	rawAfter, _ := json.Marshal(after.Elements)
	if !bytes.Equal(rawBefore, rawAfter) || !bytes.Contains(rawAfter, []byte("Controleer de zichtbare aansluiting")) {
		t.Fatal("inspection context changed after catalog edit")
	}
	asset := id()
	png, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=")
	req, _ := http.NewRequest("PUT", f.server.URL+"/api/v1"+base+"/norm-assets/"+asset, bytes.NewReader(png))
	req.Header.Set("Content-Type", "image/png")
	req.Header.Set("X-Satvey-Request", "1")
	res, e := f.client.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	res.Body.Close()
	if res.StatusCode != 201 {
		t.Fatalf("example upload: %d", res.StatusCode)
	}
	req, _ = http.NewRequest("GET", f.server.URL+"/api/v1"+base+"/norm-assets/"+asset, nil)
	res, e = f.client.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	got, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 || !bytes.Equal(got, png) {
		t.Fatal("example storage round trip")
	}
	other.request("GET", base+"/norm-assets/"+asset, nil, 404)
}

func TestNormAIContextAndEvidenceValidation(t *testing.T) {
	rules, _ := baselineNorms()
	rules = rules[:1]
	photo, audio := id(), id()
	in := normAnalysisInput{Room: "Badkamer", Rules: rules, Elements: []roomElement{{ID: id(), Name: "Kraan", Rooms: []string{"Badkamer"}, AIGuidance: "VISIBLE_JOINT"}}, Transcripts: []audioTranscript{{MediaID: audio, Text: "INSPECTOR_TEST", Version: 2}}}
	var img bytes.Buffer
	_ = jpeg.Encode(&img, image.NewRGBA(image.Rect(0, 0, 2, 2)), nil)
	in.References = []referencePhoto{{RuleID: rules[0].ID, Caption: "REFERENCE_ONLY", Outcome: "unacceptable", Bytes: img.Bytes()}}
	result := normAnalysisResult{Findings: []proposal{}, Checks: []normCheck{{RuleID: rules[0].ID, Outcome: "unacceptable", Reason: "Volgens de vastgelegde proef", PhotoIDs: []string{photo}, AudioIDs: []string{audio}}}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		for _, value := range []string{"VISIBLE_JOINT", "INSPECTOR_TEST", "REFERENCE_ONLY", rules[0].Acceptable, rules[0].Unacceptable, rules[0].Examples[0].Caption} {
			if !bytes.Contains(raw, []byte(value)) {
				t.Errorf("missing AI context: %s", value)
			}
		}
		content, _ := json.Marshal(result)
		send(w, 200, map[string]any{"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]string{"content": string(content)}}}})
	}))
	defer server.Close()
	analyzer := basetenAnalyzer{key: "test", model: "zai-org/GLM-5.3-Flash", endpoint: server.URL, client: server.Client()}
	photos := []analysisPhoto{{ID: photo, Bytes: img.Bytes()}}
	if _, e := analyzer.AnalyzeNorms(context.Background(), in, photos); e != nil {
		t.Fatal(e)
	}
	for _, modify := range []func(*normAnalysisResult){
		func(r *normAnalysisResult) { r.Checks[0].PhotoIDs = []string{"reference-photo"} },
		func(r *normAnalysisResult) { r.Checks[0].AudioIDs = []string{"unrelated-audio"} },
		func(r *normAnalysisResult) { r.Checks[0].PhotoIDs = nil; r.Checks[0].AudioIDs = nil },
		func(r *normAnalysisResult) { r.Checks = nil },
		func(r *normAnalysisResult) { r.Checks[0].RuleID = id() },
	} {
		raw, _ := json.Marshal(result)
		var invalid normAnalysisResult
		_ = json.Unmarshal(raw, &invalid)
		modify(&invalid)
		raw, _ = json.Marshal(invalid)
		if _, e := parseNormAnalysis(string(raw), in, photos); e == nil {
			t.Fatal("invalid norm evidence accepted")
		}
	}
}

func TestNormOnlyReportRetainsSourcePhotos(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	base := "/orgs/" + f.org
	doc := decodeNorm(t, f.request("POST", base+"/norms", map[string]any{"name": "Photo evidence", "baseline": true}, 201))
	doc.Rules = doc.Rules[:1]
	doc.Rules[0].Rooms = []string{"*"}
	f.request("PUT", base+"/norms/"+doc.ID, map[string]any{"name": doc.Name, "rules": doc.Rules, "revision": 1}, 200)
	f.request("POST", base+"/norms/"+doc.ID+"/publish", map[string]any{"revision": 2}, 200)
	path, room := f.inspection()
	iid := strings.Split(path, "/inspections/")[1]
	if _, e := f.a.db.Exec(ctx, "UPDATE inspections SET norm_version_id=$1 WHERE id=$2 AND org_id=$3", doc.ID, iid, f.org); e != nil {
		t.Fatal(e)
	}
	photo, batch := id(), id()
	// Provider returns a norm assessment with source evidence and no generic finding.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		result := normAnalysisResult{Findings: []proposal{}, Checks: []normCheck{{RuleID: doc.Rules[0].ID, Outcome: "unacceptable", Reason: "Zichtbare vochtplek", PhotoIDs: []string{photo}, AudioIDs: []string{}}}}
		raw, _ := json.Marshal(result)
		send(w, 200, map[string]any{"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]string{"content": string(raw)}}}})
	}))
	defer server.Close()
	f.a.imageProvider = "baseten"
	f.a.analyzer = basetenAnalyzer{key: "test", model: "test", endpoint: server.URL, client: server.Client()}
	f.request("POST", path+"/batches", map[string]any{"id": batch, "roomId": room, "mediaIds": []string{photo}}, 201)
	var img bytes.Buffer
	_ = jpeg.Encode(&img, image.NewRGBA(image.Rect(0, 0, 8, 8)), nil)
	f.upload(path+"/batches/"+batch, photo, img.Bytes(), "image/jpeg", 201)
	if e := f.a.processJob(ctx); e != nil {
		t.Fatal(e)
	}
	data := f.request("GET", path, nil, 200)
	a := data["assessments"].([]any)[0].(map[string]any)
	if a["source"] != "ai" || len(data["observations"].([]any)) != 0 {
		t.Fatal("norm provider pipeline lost its result")
	}
	f.request("PUT", path+"/assessments/"+a["id"].(string), map[string]any{"version": a["version"], "outcome": "unacceptable", "note": ""}, 200)
	data = f.request("GET", path, nil, 200)
	f.request("PUT", path+"/batches/"+batch, map[string]any{"version": data["batches"].([]any)[0].(map[string]any)["version"], "status": "reviewed"}, 200)
	report := f.request("POST", path+"/report", map[string]any{}, 201)
	if len(report["media"].([]any)) != 1 || report["media"].([]any)[0].(map[string]any)["id"] != photo {
		t.Fatal("source photo absent from norm-only report")
	}
	if report["assessments"].([]any)[0].(map[string]any)["photoIds"].([]any)[0] != photo {
		t.Fatal("assessment evidence reference lost")
	}
}

func TestEmptyAnalysisStillRequiresCaptureReview(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	path, room := f.inspection()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		send(w, 200, map[string]any{"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]string{"content": `{"findings":[],"checks":[]}`}}}})
	}))
	defer server.Close()
	f.a.imageProvider = "baseten"
	f.a.analyzer = basetenAnalyzer{key: "test", model: "test", endpoint: server.URL, client: server.Client()}
	batch, photo := id(), id()
	f.request("POST", path+"/batches", map[string]any{"id": batch, "roomId": room, "mediaIds": []string{photo}}, 201)
	var img bytes.Buffer
	_ = jpeg.Encode(&img, image.NewRGBA(image.Rect(0, 0, 8, 8)), nil)
	f.upload(path+"/batches/"+batch, photo, img.Bytes(), "image/jpeg", 201)
	if e := f.a.processJob(ctx); e != nil {
		t.Fatal(e)
	}
	data := f.request("GET", path, nil, 200)
	if len(data["observations"].([]any)) != 0 {
		t.Fatal("invented a finding for an empty analysis")
	}
	f.request("POST", path+"/report", map[string]any{}, 422)
	f.request("PUT", path+"/batches/"+batch, map[string]any{"version": data["batches"].([]any)[0].(map[string]any)["version"], "status": "reviewed"}, 200)
	f.request("POST", path+"/report", map[string]any{}, 201)
}
