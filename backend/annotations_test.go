package main

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/jpeg"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAnnotationReviewAndFrozenReport(t *testing.T) {
	f := setup(t)
	path, room := f.inspection()
	batch, photo := id(), id()
	f.request("POST", path+"/batches", map[string]any{"id": batch, "roomId": room, "mediaIds": []string{photo}}, 201)
	var pixels bytes.Buffer
	_ = jpeg.Encode(&pixels, image.NewRGBA(image.Rect(0, 0, 800, 600)), nil)
	f.upload(path+"/batches/"+batch, photo, pixels.Bytes(), "image/jpeg", 201)
	if e := f.a.processJob(context.Background()); e != nil {
		t.Fatal(e)
	}
	d := f.request("GET", path, nil, 200)
	obs := d["observations"].([]any)[0].(map[string]any)
	// One resolved finding is insufficient while another remains undecided.
	manual := id()
	f.request("POST", path+"/batches/"+batch+"/observations", map[string]any{"id": manual, "title": "Tweede punt", "description": "Tweede waarneming", "status": "draft"}, 201)
	f.request("PUT", path+"/observations/"+obs["id"].(string), map[string]any{"version": obs["version"], "title": "Lekkage", "description": "Water onder de kraan.", "status": "approved"}, 200)
	d = f.request("GET", path, nil, 200)
	if d["batches"].([]any)[0].(map[string]any)["status"] != "pending" {
		t.Fatal("undecided finding was bypassed")
	}
	f.request("PUT", path+"/observations/"+manual, map[string]any{"version": 1, "title": "Tweede punt", "description": "Tweede waarneming", "status": "rejected"}, 200)
	d = f.request("GET", path, nil, 200)
	if d["batches"].([]any)[0].(map[string]any)["status"] != "reviewed" {
		t.Fatal("last decision must review capture automatically")
	}
	endpoint := path + "/media/" + photo + "/annotations"
	shapes := []photoAnnotation{{Tool: "arrow", Color: "#dc2626", Points: []annotationPoint{{.1, .2}, {.7, .6}}}, {Tool: "ellipse", Color: "#2563eb", Points: []annotationPoint{{.5, .4}, {.8, .8}}}}
	f.request("PUT", endpoint, map[string]any{"version": 0, "shapes": shapes}, 200)
	f.request("PUT", endpoint, map[string]any{"version": 0, "shapes": shapes}, 409)
	invalid := []photoAnnotation{{Tool: "pen", Color: "url(javascript:bad)", Points: []annotationPoint{{0, 0}, {1, 1}}}}
	f.request("PUT", endpoint, map[string]any{"version": 1, "shapes": invalid}, 422)
	other := setup(t)
	other.request("GET", endpoint, nil, 404)
	original := f.request("GET", endpoint, nil, 200)
	if original["version"] != float64(1) {
		t.Fatal("annotation revision lost")
	}
	// Source object and hash stay identical; annotations never replace evidence.
	var sourceHash string
	if e := f.a.db.QueryRow(context.Background(), `SELECT sha256 FROM media WHERE id=$1`, photo).Scan(&sourceHash); e != nil {
		t.Fatal(e)
	}
	if sourceHash != hash(string(pixels.Bytes())) {
		t.Fatal("source photo changed")
	}
	report := f.request("POST", path+"/report", map[string]any{}, 201)
	raw, _ := json.Marshal(report)
	if !bytes.Contains(raw, []byte(`"annotations"`)) || !bytes.Contains(raw, []byte(`"arrow"`)) {
		t.Fatal("report lost annotation snapshot")
	}
	f.request("PUT", endpoint, map[string]any{"version": 1, "shapes": []photoAnnotation{}}, 409)
	var doc pdfDocument
	_ = json.Unmarshal(raw, &doc)
	if e := preparePDFDocument(&doc); e != nil {
		t.Fatal(e)
	}
	if !strings.HasSuffix(doc.Media[0].File, ".svg") {
		t.Fatal("PDF must use annotated photo")
	}
	// Real Gotenberg rendering, optionally retained for visual/pixel verification.
	if os.Getenv("PDF_ARTIFACT_DIR") != "" {
		pdf, e := f.a.renderReportPDF(context.Background(), f.org, doc)
		if e != nil {
			t.Fatal(e)
		}
		if e = os.WriteFile(filepath.Join(os.Getenv("PDF_ARTIFACT_DIR"), "report-annotated.pdf"), pdf, 0644); e != nil {
			t.Fatal(e)
		}
	}
}

func TestAnnotationGeometryAndLimits(t *testing.T) {
	var photo bytes.Buffer
	_ = jpeg.Encode(&photo, image.NewRGBA(image.Rect(0, 0, 100, 50)), nil)
	shapes := []photoAnnotation{{Tool: "arrow", Color: "#dc2626", Points: []annotationPoint{{.1, .2}, {.8, .9}}}}
	svg, e := annotatedPhotoSVG(photo.Bytes(), shapes)
	if e != nil || !bytes.Contains(svg, []byte(`viewBox="0 0 100 50"`)) || !bytes.Contains(svg, []byte("10.0000 10.0000 L 80.0000 45.0000")) {
		t.Fatalf("incorrect scaled geometry: %v", e)
	}
	shapes[0].Points[0].X = -.1
	if validateAnnotations(shapes) == nil {
		t.Fatal("out-of-bounds coordinates accepted")
	}
	if validateAnnotations(make([]photoAnnotation, 201)) == nil {
		t.Fatal("shape limit bypassed")
	}
	if validateAnnotations([]photoAnnotation{}) != nil {
		t.Fatal("clearing annotations must be allowed")
	}
}

func TestEmptyAnalysisRequiresHumanReview(t *testing.T) {
	f := setup(t)
	path, room := f.inspection()
	batch, photo := id(), id()
	f.request("POST", path+"/batches", map[string]any{"id": batch, "roomId": room, "mediaIds": []string{photo}}, 201)
	var pixels bytes.Buffer
	_ = jpeg.Encode(&pixels, image.NewRGBA(image.Rect(0, 0, 20, 20)), nil)
	f.upload(path+"/batches/"+batch, photo, pixels.Bytes(), "image/jpeg", 201)
	if e := f.a.processJob(context.Background()); e != nil {
		t.Fatal(e)
	}
	ctx := context.Background()
	tx, e := f.a.db.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, `DELETE FROM observations WHERE batch_id=$1 AND org_id=$2`, batch, f.org); e != nil {
		t.Fatal(e)
	}
	iid := strings.Split(path, "/inspections/")[1]
	if e = reconcileCaptureReviews(ctx, tx, f.org, iid); e != nil {
		t.Fatal(e)
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	d := f.request("GET", path, nil, 200)
	b := d["batches"].([]any)[0].(map[string]any)
	if b["status"] != "pending" {
		t.Fatal("an empty analysis is not a human decision")
	}
	f.request("PUT", path+"/batches/"+batch, map[string]any{"status": "reviewed", "version": b["version"]}, 200)
}

func TestRoomSummaryCannotApproveUndecidedFindings(t *testing.T) {
	f := setup(t)
	scope := formatScope{ID: id(), Name: "Badkamer", NormRoom: "Badkamer", Required: true, Questions: []formatQuestion{{ID: id(), Title: "Gecontroleerd", Kind: "boolean", Evidence: "none", Required: true}}}
	property := formatScope{ID: id(), Name: "Woning algemeen", NormRoom: "Woning algemeen", Property: true, Questions: []formatQuestion{}}
	doc, _ := testPublishedFormat(f, []formatScope{property, scope})
	path, _ := testFormatInspection(f, doc)
	room, _ := testRoom(f, path, scope.ID)
	batch, photo := id(), id()
	f.request("POST", path+"/batches", map[string]any{"id": batch, "roomId": room, "mediaIds": []string{photo}}, 201)
	var pixels bytes.Buffer
	_ = jpeg.Encode(&pixels, image.NewRGBA(image.Rect(0, 0, 20, 20)), nil)
	f.upload(path+"/batches/"+batch, photo, pixels.Bytes(), "image/jpeg", 201)
	flushScopeJobs(f)
	answer := testAnswers(f, path, room)[0]
	answer.Value = json.RawMessage("true")
	answer.Status = "confirmed"
	f.request("PUT", path+"/answers/"+answer.ID, answer, 200)
	flushScopeJobs(f)
	d := f.request("GET", path, nil, 200)
	if len(d["observations"].([]any)) == 0 {
		t.Fatal("fixture must propose a finding")
	}
	testApprove(f, path, room, "", 422)
	for _, raw := range d["observations"].([]any) {
		o := raw.(map[string]any)
		f.request("PUT", path+"/observations/"+o["id"].(string), map[string]any{"title": o["title"], "description": o["description"], "status": "rejected", "version": o["version"]}, 200)
	}
	testApprove(f, path, room, "", 200)
}
