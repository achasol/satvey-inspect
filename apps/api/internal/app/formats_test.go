package app

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/jpeg"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
)

func testPublishedFormat(f *fixture, scopes []formatScope) (formatDocument, normDocument) {
	f.t.Helper()
	base := "/orgs/" + f.org
	norm := decodeNorm(f.t, f.request("POST", base+"/norms", map[string]any{"name": "Format test norms", "baseline": true}, 201))
	f.request("POST", base+"/norms/"+norm.ID+"/publish", map[string]any{"revision": norm.Revision}, 200)
	raw := f.request("POST", base+"/formats", map[string]any{"name": "Format test", "kind": "pre", "normVersionId": norm.ID}, 201)
	docRaw := f.request("GET", base+"/formats/"+raw["id"].(string), nil, 200)
	encoded, _ := json.Marshal(docRaw)
	var doc formatDocument
	_ = json.Unmarshal(encoded, &doc)
	if scopes != nil {
		doc.Scopes = scopes
	}
	doc.SigningPolicy = "legacy" // Unrelated cases retain their original fixture contract.
	f.request("PUT", base+"/formats/"+doc.ID, doc, 200)
	doc.Revision++
	f.request("POST", base+"/formats/"+doc.ID+"/publish", map[string]any{"revision": doc.Revision}, 200)
	doc.Status = "published"
	return doc, norm
}
func testFormatInspection(f *fixture, doc formatDocument) (string, string) {
	f.t.Helper()
	base := "/orgs/" + f.org
	pid, iid := id(), id()
	f.request("POST", base+"/properties", map[string]any{"id": pid, "address": "Formatstraat 42"}, 201)
	f.confirmFixtureProperty(pid)
	f.request("POST", base+"/inspections", map[string]any{"id": iid, "propertyId": pid, "kind": "pre", "formatVersionId": doc.ID}, 201)
	return base + "/inspections/" + iid, iid
}
func testAnswers(f *fixture, path, room string) []formatAnswer {
	f.t.Helper()
	d := f.request("GET", path, nil, 200)
	raw, _ := json.Marshal(d["answers"])
	var answers []formatAnswer
	_ = json.Unmarshal(raw, &answers)
	out := []formatAnswer{}
	for _, a := range answers {
		if a.RoomID == room {
			out = append(out, a)
		}
	}
	return out
}
func testRoom(f *fixture, path, category string) (string, int) {
	f.t.Helper()
	d := f.request("GET", path, nil, 200)
	for _, v := range d["rooms"].([]any) {
		r := v.(map[string]any)
		if r["categoryId"] == category {
			return r["id"].(string), int(r["generation"].(float64))
		}
	}
	f.t.Fatal("category not instantiated")
	return "", 0
}
func testApprove(f *fixture, path, room, exception string, status int) {
	f.t.Helper()
	d := f.request("GET", path, nil, 200)
	versions := map[string]int{}
	for _, a := range testAnswers(f, path, room) {
		versions[a.ID] = a.Version
	}
	generation := 0
	for _, v := range d["rooms"].([]any) {
		r := v.(map[string]any)
		if r["id"] == room {
			generation = int(r["generation"].(float64))
		}
	}
	ov := map[string]int{}
	batches := map[string]bool{}
	for _, v := range d["batches"].([]any) {
		b := v.(map[string]any)
		if b["roomId"] == room && b["status"] != "excluded" {
			batches[b["id"].(string)] = true
		}
	}
	for _, v := range d["observations"].([]any) {
		o := v.(map[string]any)
		if batches[o["batchId"].(string)] {
			ov[o["id"].(string)] = int(o["version"].(float64))
		}
	}
	f.request("PUT", path+"/rooms/"+room+"/approval", map[string]any{"generation": generation, "versions": versions, "observationVersions": ov, "exception": exception}, status)
}
func flushScopeJobs(f *fixture) {
	f.t.Helper()
	ctx := context.Background()
	if _, e := f.a.db.Exec(ctx, `UPDATE scope_jobs SET next_attempt_at=now() WHERE org_id=$1`, f.org); e != nil {
		f.t.Fatal(e)
	}
	for i := 0; i < 10; i++ {
		if e := f.a.processScopeJob(ctx); e != nil {
			f.t.Fatal(e)
		}
	}
}
func TestFormatCoverageConditionsAndFrozenReports(t *testing.T) {
	f := setup(t)
	other := setup(t)
	ctx := context.Background()
	base := "/orgs/" + f.org
	prop := formatScope{ID: id(), Name: "Woning algemeen", NormRoom: "Woning algemeen", Property: true, Questions: []formatQuestion{{ID: id(), Title: "Sleutels ontvangen?", Kind: "boolean", Required: true, Evidence: "none"}}}
	kitchen := formatScope{ID: id(), Name: "Keuken", NormRoom: "Keuken", Required: true, Questions: []formatQuestion{{ID: id(), Title: "Is schade aanwezig?", Kind: "boolean", Required: true, Evidence: "none"}}}
	kitchen.Questions = append(kitchen.Questions, formatQuestion{ID: id(), Title: "Detailfoto schade", Kind: "evidence", Required: true, Evidence: "photo", MinPhotos: 1, Condition: &formatCondition{QuestionID: kitchen.Questions[0].ID, Equals: "true"}})
	bath := formatScope{ID: id(), Name: "Badkamer", NormRoom: "Badkamer", Required: true, Repeatable: true, Questions: []formatQuestion{{ID: id(), Title: "Overzicht", Kind: "text", Required: true, Evidence: "photo", MinPhotos: 1}}}
	doc, _ := testPublishedFormat(f, []formatScope{prop, kitchen, bath})
	other.request("GET", base+"/formats/"+doc.ID, nil, 404)
	f.request("PUT", base+"/formats/"+doc.ID, doc, 409)
	if _, e := f.a.db.Exec(ctx, `UPDATE format_versions SET name='tampered' WHERE id=$1`, doc.ID); e == nil {
		t.Fatal("published format was mutable")
	}
	path, iid := testFormatInspection(f, doc)
	d := f.request("GET", path, nil, 200)
	if len(d["rooms"].([]any)) != 3 || len(d["answers"].([]any)) != 4 {
		t.Fatal("coverage must exist before any capture")
	}
	f.request("POST", path+"/report", map[string]any{}, 422)
	proom, _ := testRoom(f, path, prop.ID)
	kroom, _ := testRoom(f, path, kitchen.ID)
	broom, _ := testRoom(f, path, bath.ID)
	a := testAnswers(f, path, proom)[0]
	a.Value = json.RawMessage("true")
	a.Status = "confirmed"
	f.request("PUT", path+"/answers/"+a.ID, a, 200)
	testApprove(f, path, proom, "", 200)
	for _, a = range testAnswers(f, path, kroom) {
		if a.QuestionID == kitchen.Questions[0].ID {
			a.Value = json.RawMessage("false")
			a.Status = "confirmed"
			f.request("PUT", path+"/answers/"+a.ID, a, 200)
		}
	}
	testApprove(f, path, kroom, "", 200) // Explicit false disables its mandatory follow-up.
	testApprove(f, path, broom, "", 422)
	testApprove(f, path, broom, "Geen toegang tot afgesloten badkamer", 200)
	// Removing room evidence makes property-level reviews current only after reapproval.
	flushScopeJobs(f)
	testApprove(f, path, proom, "", 200)
	snapshot, e := reportSnapshot(ctx, f.a.db, f.org, iid)
	if e != nil {
		t.Fatal(e)
	}
	var pdf pdfDocument
	raw, _ := json.Marshal(snapshot)
	_ = json.Unmarshal(raw, &pdf)
	if e = preparePDFDocument(&pdf); e != nil {
		t.Fatal(e)
	}
	foundException := false
	for _, room := range pdf.Sections {
		for _, a := range room.Answers {
			foundException = foundException || a.Value == "Niet te beantwoorden" && strings.Contains(a.Reason, "afgesloten")
		}
	}
	if !foundException {
		t.Fatal("report lost the inaccessible room")
	}
	report := f.request("POST", path+"/report", map[string]any{}, 201)
	if report["format"].(map[string]any)["id"] != doc.ID {
		t.Fatal("format version not frozen")
	}
	f.request("POST", base+"/formats/"+doc.ID+"/revisions", map[string]any{}, 201)
	a.Status = "confirmed"
	f.request("PUT", path+"/answers/"+a.ID, a, 409)
	pid := id()
	f.request("POST", base+"/properties", map[string]any{"id": pid, "address": "New address"}, 201)
	f.request("POST", base+"/inspections", map[string]any{"id": id(), "propertyId": pid, "kind": "pre"}, 422)
	f.request("POST", base+"/inspections", map[string]any{"id": id(), "propertyId": pid, "kind": "final", "formatVersionId": doc.ID}, 422)
}
func TestFormatEvidenceReviewAndBenchmark(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	base := "/orgs/" + f.org
	// Construct then revise the draft before publication so its quality question links the generated norm ID.
	norm := decodeNorm(t, f.request("POST", base+"/norms", map[string]any{"name": "Photo norms", "baseline": true}, 201))
	f.request("POST", base+"/norms/"+norm.ID+"/publish", map[string]any{"revision": 1}, 200)
	raw := f.request("POST", base+"/formats", map[string]any{"name": "Evidence", "kind": "pre", "normVersionId": norm.ID}, 201)
	encoded, _ := json.Marshal(f.request("GET", base+"/formats/"+raw["id"].(string), nil, 200))
	var doc formatDocument
	_ = json.Unmarshal(encoded, &doc)
	prop := formatScope{ID: id(), Name: "Woning algemeen", NormRoom: "Woning algemeen", Property: true, Questions: []formatQuestion{}}
	roomScope := formatScope{ID: id(), Name: "Keuken", NormRoom: "Keuken", Required: true, Questions: []formatQuestion{{ID: id(), Title: "Wandkwaliteit", Kind: "quality", Required: true, RuleID: norm.Rules[0].ID, Evidence: "photo", MinPhotos: 1}}}
	doc.Scopes = []formatScope{prop, roomScope}
	doc.SigningPolicy = "legacy"
	f.request("PUT", base+"/formats/"+doc.ID, doc, 200)
	f.request("POST", base+"/formats/"+doc.ID+"/publish", map[string]any{"revision": 2}, 200)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		result := normAnalysisResult{Findings: []proposal{}, Checks: []normCheck{{RuleID: norm.Rules[0].ID, Outcome: "not_assessable", Reason: "Test response", PhotoIDs: []string{}, AudioIDs: []string{}}}, Answers: []formatSuggestion{}}
		raw, _ := json.Marshal(result)
		send(w, 200, map[string]any{"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]string{"content": string(raw)}}}})
	}))
	defer server.Close()
	f.a.imageProvider = "baseten"
	f.a.analyzer = basetenAnalyzer{key: "test", model: "test", endpoint: server.URL, client: server.Client()}
	path, _ := testFormatInspection(f, doc)
	room, _ := testRoom(f, path, roomScope.ID)
	batch, photo := id(), id()
	f.request("POST", path+"/batches", map[string]any{"id": batch, "roomId": room, "mediaIds": []string{photo}}, 201)
	var img bytes.Buffer
	_ = jpeg.Encode(&img, image.NewRGBA(image.Rect(0, 0, 8, 8)), nil)
	f.upload(path+"/batches/"+batch, photo, img.Bytes(), "image/jpeg", 201)
	flushScopeJobs(f)
	answer := testAnswers(f, path, room)[0]
	answer.Status = "confirmed"
	answer.Value = json.RawMessage(`"acceptable"`)
	answer.Outcome = "acceptable"
	answer.Reason = "Wand visueel gecontroleerd"
	answer.PhotoIDs = []string{id()}
	f.request("PUT", path+"/answers/"+answer.ID, answer, 422)
	answer.PhotoIDs = []string{photo}
	f.request("PUT", path+"/answers/"+answer.ID, answer, 200)
	f.request("PUT", path+"/answers/"+answer.ID, answer, 409)
	testApprove(f, path, room, "", 200)
	benchmark := f.request("GET", base+"/norms/benchmark?normVersionId="+norm.ID, nil, 200)
	row := benchmark["rows"].([]any)[0].(map[string]any)
	if row["acceptable"] != float64(1) {
		t.Fatal("confirmed scope not benchmarked")
	}
	// A second photo invalidates review, but does not replace the inspector's answer.
	secondBatch, secondPhoto := id(), id()
	f.request("POST", path+"/batches", map[string]any{"id": secondBatch, "roomId": room, "mediaIds": []string{secondPhoto}}, 201)
	f.upload(path+"/batches/"+secondBatch, secondPhoto, img.Bytes(), "image/jpeg", 201)
	flushScopeJobs(f)
	answer = testAnswers(f, path, room)[0]
	if !answer.Human || string(answer.Value) != `"acceptable"` || answer.Status != "suggested" {
		t.Fatal("manual correction was overwritten or remained approved")
	}
	f.request("POST", path+"/report", map[string]any{}, 422)
	testApprove(f, path, room, "", 200)
	benchmark = f.request("GET", base+"/norms/benchmark?normVersionId="+norm.ID, nil, 200)
	if benchmark["rows"].([]any)[0].(map[string]any)["acceptable"] != float64(1) {
		t.Fatal("duplicate photos inflated benchmark")
	}
	// Excluding the supporting photo cannot be used to bypass evidence requirements.
	d := f.request("GET", path, nil, 200)
	for _, v := range d["batches"].([]any) {
		b := v.(map[string]any)
		if b["id"] == batch {
			f.request("PUT", path+"/batches/"+batch, map[string]any{"version": b["version"], "status": "excluded"}, 200)
		}
	}
	flushScopeJobs(f)
	testApprove(f, path, room, "", 422)
	answer = testAnswers(f, path, room)[0]
	answer.PhotoIDs = []string{secondPhoto}
	answer.Status = "confirmed"
	f.request("PUT", path+"/answers/"+answer.ID, answer, 200)
	testApprove(f, path, room, "", 200)
	report := f.request("POST", path+"/report", map[string]any{}, 201)
	if len(report["media"].([]any)) != 1 {
		t.Fatal("structured-only source photo missing from frozen report")
	}
	// Real Chromium PDF, including structured results and no generic finding.
	pdf := pdfResponse(f, path, 200)
	if len(pdf) < 10000 {
		t.Fatal("structured report PDF empty")
	}
	if e := os.MkdirAll("/artifacts", 0755); e == nil {
		_ = os.WriteFile("/artifacts/report-format.pdf", pdf, 0644)
	}
	_ = ctx
}
func TestFormatConditionalValidationAndStaleAudio(t *testing.T) {
	norm := normDocument{Status: "published"}
	scope := formatScope{ID: id(), Name: "Woning algemeen", Property: true, Questions: []formatQuestion{{ID: id(), Title: "Test", Kind: "boolean", Required: true, Evidence: "none"}}}
	scope.Questions = append(scope.Questions, formatQuestion{ID: id(), Title: "Vervolg", Kind: "text", Required: true, Evidence: "none", Condition: &formatCondition{QuestionID: scope.Questions[0].ID, Equals: "true"}})
	d := formatDocument{Name: "Test", Kind: "pre", Scopes: []formatScope{scope}}
	if e := validateFormat(&d, &norm, true); e != nil {
		t.Fatal(e)
	}
	q := scope.Questions[1]
	d.Scopes[0].Questions[0].Condition = &formatCondition{QuestionID: q.ID, Equals: "true"}
	if validateFormat(&d, &norm, true) == nil {
		t.Fatal("forward/cyclic condition accepted")
	}
	audio := id()
	a := formatAnswer{Status: "confirmed", Value: json.RawMessage(`"Werking getest"`), AudioIDs: []string{audio}, TranscriptVersions: map[string]int{audio: 1}}
	q.Condition = nil
	q.Evidence = "statement"
	if validateAnswerEvidence(q, a, scopeEvidence{Photos: map[string]bool{}, Audio: map[string]int{audio: 2}}) == nil {
		t.Fatal("stale transcript accepted")
	}
	a.Status = "unanswerable"
	if validateAnswerEvidence(q, a, scopeEvidence{}) == nil {
		t.Fatal("unexplained exception accepted")
	}
}

func TestWrittenAnswerDoesNotRequireDuplicateStatement(t *testing.T) {
	photo := id()
	evidence := scopeEvidence{Photos: map[string]bool{photo: true}, Audio: map[string]int{}}
	for _, kind := range []string{"text", "evidence"} {
		q := formatQuestion{Title: "Waarneming", Kind: kind, Evidence: "statement"}
		answer := formatAnswer{Status: "confirmed", Value: json.RawMessage(`"Ik heb de kraan geopend en geen lekkage waargenomen."`)}
		if err := validateAnswerEvidence(q, answer, evidence); err != nil {
			t.Fatalf("written observation should not need duplicate text: %v", err)
		}
		q.Evidence = "photo_statement"
		q.MinPhotos = 1
		if validateAnswerEvidence(q, answer, evidence) == nil {
			t.Fatal("written text replaced a mandatory photograph")
		}
		answer.PhotoIDs = []string{photo}
		if err := validateAnswerEvidence(q, answer, evidence); err != nil {
			t.Fatal(err)
		}
		answer.Status = "unanswerable"
		if validateAnswerEvidence(q, answer, evidence) == nil {
			t.Fatal("a waiver still requires an explicit reason")
		}
	}
	for _, kind := range []string{"boolean", "number"} {
		value := json.RawMessage(`true`)
		if kind == "number" {
			value = json.RawMessage(`0`)
		}
		q := formatQuestion{Title: "Resultaat", Kind: kind, Evidence: "statement"}
		answer := formatAnswer{Status: "confirmed", Value: value}
		if validateAnswerEvidence(q, answer, evidence) == nil {
			t.Fatal("a bare yes/no or number must not replace a statement")
		}
	}
}
func TestHostedTranscriptionContractAndAudioConversion(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		if !bytes.Contains(raw, []byte(hostedTranscriptionModel)) || !bytes.Contains(raw, []byte("audio_url")) || bytes.Contains(raw, []byte("deployment")) {
			t.Error("must use shared hosted audio model")
		}
		send(w, 200, map[string]any{"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]string{"content": "De kraan lekt niet."}}}, "usage": map[string]int{"prompt_tokens": 12, "completion_tokens": 7}})
	}))
	defer server.Close()
	result, e := transcriptionRequest(context.Background(), server.Client(), server.URL, "test-key", []byte("audio"))
	if e != nil || result.Text != "De kraan lekt niet." || result.InputTokens != 12 {
		t.Fatal("transcription contract", result, e)
	}
	if _, e = exec.LookPath("ffmpeg"); e != nil {
		t.Fatal("FFmpeg must be available inside Go tooling container")
	}
	wav, e := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "1", "-f", "wav", "pipe:1").Output()
	if e != nil {
		t.Fatal(e)
	}
	dir, parts, e := prepareAudio(context.Background(), wav)
	if e != nil {
		t.Fatal(e)
	}
	defer os.RemoveAll(dir)
	if len(parts) != 1 {
		t.Fatal("audio chunk missing")
	}
	flac, _ := os.ReadFile(parts[0])
	if !bytes.HasPrefix(flac, []byte("fLaC")) {
		t.Fatal("expected supported FLAC format")
	}

	// Real browser WebM is streamed without a seekable duration header.
	webm, e := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", "1", "-c:a", "libopus", "-f", "webm", "pipe:1").Output()
	if e != nil {
		t.Fatal(e)
	}
	webmDir, webmParts, e := prepareAudio(context.Background(), webm)
	if e != nil {
		t.Fatal("valid streamed browser recording rejected", e)
	}
	defer os.RemoveAll(webmDir)
	if len(webmParts) != 1 {
		t.Fatal("browser recording chunk missing")
	}
}

func TestTranscriptionWorkerPreservesConcurrentCorrection(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	doc, _ := testPublishedFormat(f, []formatScope{{ID: id(), Name: "Woning algemeen", NormRoom: "Woning algemeen", Property: true, Questions: []formatQuestion{{ID: id(), Title: "Waarneming", Kind: "text", Evidence: "statement", Required: true}}}})
	path, _ := testFormatInspection(f, doc)
	room, _ := testRoom(f, path, doc.Scopes[0].ID)
	f.a.imageProvider = "baseten"
	batch, mid := id(), id()
	f.request("POST", path+"/batches", map[string]any{"id": batch, "roomId": room, "mediaIds": []string{mid}}, 201)
	wav := make([]byte, 48)
	copy(wav, []byte("RIFF"))
	copy(wav[8:], []byte("WAVEfmt "))
	f.upload(path+"/batches/"+batch, mid, wav, "audio/wav", 201)
	f.a.transcribe = func(context.Context, string, string, string) (transcriptionResult, error) {
		// The inspector saves while the remote inference request is in progress.
		f.request("PUT", path+"/media/"+mid+"/transcript", map[string]any{"version": 1, "transcript": "De inspecteur corrigeert: geen lekkage."}, 200)
		return transcriptionResult{Text: "late automatic text", InputTokens: 12, OutputTokens: 3}, nil
	}
	if e := f.a.processTranscription(ctx); e != nil {
		t.Fatal(e)
	}
	var transcript, status string
	if e := f.a.db.QueryRow(ctx, `SELECT m.transcript,t.status FROM media m JOIN transcription_jobs t ON t.media_id=m.id AND t.org_id=m.org_id WHERE m.id=$1 AND m.org_id=$2`, mid, f.org).Scan(&transcript, &status); e != nil {
		t.Fatal(e)
	}
	if transcript != "De inspecteur corrigeert: geen lekkage." || status != "skipped" {
		t.Fatal("late transcription overwrote a manual edit", transcript, status)
	}
	testApprove(f, path, room, "", 422)
}

func TestFormatAIPrefillUsesAccumulatedEvidenceAndPinnedContext(t *testing.T) {
	f := setup(t)
	base := "/orgs/" + f.org
	fact := formatQuestion{ID: id(), Title: "Beschrijf de afwerking", Kind: "text", Required: true, Evidence: "photo_statement", MinPhotos: 2, Instruction: "Beschrijf alleen zichtbare afwerking", TalkingPrompt: "Benoem de plaats van de beschadiging."}
	category := formatScope{ID: id(), Name: "Keuken", NormRoom: "Keuken", Required: true, Questions: []formatQuestion{fact}}
	doc, norm := testPublishedFormat(f, []formatScope{{ID: id(), Name: "Woning algemeen", NormRoom: "Woning algemeen", Property: true, Questions: []formatQuestion{}}, category})
	next := f.request("POST", base+"/formats/"+doc.ID+"/revisions", map[string]any{}, 201)
	encoded, _ := json.Marshal(f.request("GET", base+"/formats/"+next["id"].(string), nil, 200))
	_ = json.Unmarshal(encoded, &doc)
	quality := formatQuestion{ID: id(), Title: "Wandnorm", Kind: "quality", Required: true, Evidence: "photo", MinPhotos: 1, RuleID: norm.Rules[0].ID}
	doc.Scopes[1].Questions = append(doc.Scopes[1].Questions, quality)
	doc.SigningPolicy = "legacy"
	f.request("PUT", base+"/formats/"+doc.ID, doc, 200)
	f.request("POST", base+"/formats/"+doc.ID+"/publish", map[string]any{"revision": 2}, 200)
	photo1, photo2, audio := id(), id(), id()
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		raw, _ := io.ReadAll(r.Body)
		for _, expected := range []string{fact.ID, quality.ID, fact.Instruction, fact.TalkingPrompt, norm.Rules[0].Acceptable, norm.Rules[0].Examples[0].Caption, photo1, photo2, "INSPECTOR_TEST", "Kraan"} {
			if !bytes.Contains(raw, []byte(expected)) {
				t.Errorf("prefill missing pinned context or evidence: %s", expected)
			}
		}
		result := normAnalysisResult{Findings: []proposal{}, Checks: []normCheck{{RuleID: norm.Rules[0].ID, Outcome: "unacceptable", Reason: "Zichtbare schade", PhotoIDs: []string{photo1, photo2}, AudioIDs: []string{audio}}}, Answers: []formatSuggestion{
			{QuestionID: fact.ID, Value: json.RawMessage(`"Beschadigde wand naast het aanrecht"`), Reason: "Volgens de gesproken waarneming", PhotoIDs: []string{photo1, photo2}, AudioIDs: []string{audio}, Ready: true},
			{QuestionID: quality.ID, Value: json.RawMessage(`"unacceptable"`), Reason: "Zichtbare schade", PhotoIDs: []string{photo1}, AudioIDs: []string{}, Ready: true},
		}}
		content, _ := json.Marshal(result)
		send(w, 200, map[string]any{"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]string{"content": string(content)}}}})
	}))
	defer server.Close()
	f.a.imageProvider = "baseten"
	f.a.analyzer = basetenAnalyzer{key: "test", model: "test", endpoint: server.URL, client: server.Client()}
	path, _ := testFormatInspection(f, doc)
	room, _ := testRoom(f, path, category.ID)
	var img bytes.Buffer
	_ = jpeg.Encode(&img, image.NewRGBA(image.Rect(0, 0, 8, 8)), nil)
	batch1, batch2 := id(), id()
	f.request("POST", path+"/batches", map[string]any{"id": batch1, "roomId": room, "mediaIds": []string{photo1}}, 201)
	f.upload(path+"/batches/"+batch1, photo1, img.Bytes(), "image/jpeg", 201)
	f.request("POST", path+"/batches", map[string]any{"id": batch2, "roomId": room, "mediaIds": []string{photo2, audio}}, 201)
	f.upload(path+"/batches/"+batch2, photo2, img.Bytes(), "image/jpeg", 201)
	wav := make([]byte, 48)
	copy(wav, []byte("RIFF"))
	copy(wav[8:], []byte("WAVEfmt "))
	f.upload(path+"/batches/"+batch2, audio, wav, "audio/wav", 201)
	f.request("PUT", path+"/media/"+audio+"/transcript", map[string]any{"version": 1, "transcript": "INSPECTOR_TEST: de wand naast het aanrecht is beschadigd."}, 200)
	flushScopeJobs(f)
	if calls != 1 {
		t.Fatal("uploads should coalesce into one aggregate analysis", calls)
	}
	answers := testAnswers(f, path, room)
	for _, a := range answers {
		if a.Status != "suggested" || a.Human {
			t.Fatal("AI suggestion must await human approval", a)
		}
		if a.QuestionID == fact.ID && (len(a.PhotoIDs) != 2 || a.TranscriptVersions[audio] != 2) {
			t.Fatal("accumulated evidence provenance lost", a)
		}
	}
	testApprove(f, path, room, "", 200)
	f.request("PUT", path+"/media/"+audio+"/transcript", map[string]any{"version": 2, "transcript": "INSPECTOR_TEST: gecorrigeerde plaatsbeschrijving."}, 200)
	f.request("POST", path+"/report", map[string]any{}, 422)
}
