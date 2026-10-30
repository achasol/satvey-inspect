package app

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func pdfResponse(f *fixture, path string, status int) []byte {
	f.t.Helper()
	req, _ := http.NewRequest("POST", f.server.URL+"/api/v1"+path+"/report/pdf", strings.NewReader("{}"))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Satvey-Request", "1")
	res, e := f.client.Do(req)
	if e != nil {
		f.t.Fatal(e)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode != status {
		f.t.Fatalf("PDF got %d want %d: %s", res.StatusCode, status, raw)
	}
	if status == 200 && (!strings.HasPrefix(res.Header.Get("Content-Type"), "application/pdf") || !strings.Contains(res.Header.Get("Content-Disposition"), "attachment;") || res.Header.Get("Cache-Control") != "no-store") {
		f.t.Fatal("incorrect download headers")
	}
	return raw
}

func TestPDFSnapshotAndRendererContract(t *testing.T) {
	f := setup(t)
	outsider := setup(t)
	path, room := f.inspection()
	iid := strings.Split(path, "/inspections/")[1]
	batch, photo, audio := id(), id(), id()
	f.request("POST", path+"/batches", map[string]any{"id": batch, "roomId": room, "mediaIds": []string{photo, audio}}, 201)
	var img bytes.Buffer
	_ = jpeg.Encode(&img, image.NewRGBA(image.Rect(0, 0, 12, 8)), nil)
	f.upload(path+"/batches/"+batch, photo, img.Bytes(), "image/jpeg", 201)
	wav := make([]byte, 48)
	copy(wav, []byte("RIFF"))
	copy(wav[8:], []byte("WAVEfmt "))
	f.upload(path+"/batches/"+batch, audio, wav, "audio/wav", 201)
	f.request("POST", path+"/media/"+audio+"/transcription", map[string]any{"action": "skip", "reason": "Testfixture bevat geen spraak"}, 200)
	if e := f.a.processJob(context.Background()); e != nil {
		t.Fatal(e)
	}
	data := f.request("GET", path, nil, 200)
	o := data["observations"].([]any)[0].(map[string]any)
	f.request("PUT", path+"/observations/"+o["id"].(string), map[string]any{"version": o["version"], "status": "approved", "title": "Lekkage bij de kraan", "description": "Zichtbare druppels. <script>alert('unsafe')</script>", "label": "Herstel"}, 200)
	data = f.request("GET", path, nil, 200)
	version := data["batches"].([]any)[0].(map[string]any)["version"]
	f.request("PUT", path+"/batches/"+batch, map[string]any{"version": version, "status": "reviewed"}, 200)
	calls := 0
	wantDraft := true
	renderer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/forms/chromium/convert/html" || r.Header.Get("Cookie") != "" {
			t.Error("wrong renderer request")
		}
		if e := r.ParseMultipartForm(32 << 20); e != nil {
			t.Error(e)
			http.Error(w, "bad", 400)
			return
		}
		defer r.MultipartForm.RemoveAll()
		for _, field := range []string{"generateDocumentOutline", "generateTaggedPdf", "printBackground", "failOnResourceLoadingFailed"} {
			if r.FormValue(field) != "true" {
				t.Errorf("missing renderer option: %s", field)
			}
		}
		files := map[string][]byte{}
		for _, file := range r.MultipartForm.File["files"] {
			part, e := file.Open()
			if e != nil {
				t.Error(e)
				continue
			}
			files[file.Filename], _ = io.ReadAll(part)
			part.Close()
		}
		html := string(files["index.html"])
		if !strings.Contains(html, "Lekkage bij de kraan") || !strings.Contains(html, "2.1 Badkamer") || !strings.Contains(html, "Integration Test") {
			t.Error("report content or room outline missing")
		}
		if strings.Contains(html, "<script>") || !strings.Contains(html, "&lt;script&gt;") {
			t.Error("report HTML must be escaped")
		}
		if strings.Contains(html, audio) || strings.Contains(html, "Nieuw organisatielabel") || strings.Contains(html, "Nieuw adres") {
			t.Error("internal audio or mutable data leaked into report")
		}
		if wantDraft != strings.Contains(html, "Concept — nog niet definitief.") {
			t.Error("wrong draft status")
		}
		if !bytes.HasPrefix(files["photo-"+photo+".jpg"], []byte{0xff, 0xd8}) || len(files["dm-sans-regular.ttf"]) == 0 {
			t.Error("report did not embed its photo and font")
		}
		if !strings.Contains(string(files["footer.html"]), "pageNumber") || !strings.Contains(string(files["header.html"]), "INSPECTIERAPPORT") {
			t.Error("running header/footer missing")
		}
		w.Header().Set("Content-Type", "application/pdf")
		_, _ = w.Write([]byte("%PDF-1.7\nfixture\n%%EOF"))
	}))
	defer renderer.Close()
	f.a.pdfURL = renderer.URL
	// Draft export leaves the inspection editable.
	pdfResponse(f, path, 200)
	f.request("POST", path+"/report", map[string]any{}, 201)
	wantDraft = false
	if _, e := f.a.db.Exec(context.Background(), "UPDATE organisations SET name='Nieuw organisatielabel' WHERE id=$1", f.org); e != nil {
		t.Fatal(e)
	}
	if _, e := f.a.db.Exec(context.Background(), "UPDATE properties SET address='Nieuw adres' WHERE id=(SELECT property_id FROM inspections WHERE id=$1)", iid); e != nil {
		t.Fatal(e)
	}
	pdfResponse(f, path, 200)
	before := calls
	pdfResponse(outsider, path, 404)
	if calls != before {
		t.Fatal("unauthorised export reached renderer")
	}
	if _, e := f.a.db.Exec(context.Background(), "UPDATE memberships SET role='viewer' WHERE user_id=$1 AND org_id=$2", f.uid, f.org); e != nil {
		t.Fatal(e)
	}
	pdfResponse(f, path, 200) // Read-only roles can download saved reports.
	broken := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "private-renderer-error", 503) }))
	defer broken.Close()
	f.a.pdfURL = broken.URL
	if raw := pdfResponse(f, path, 503); bytes.Contains(raw, []byte("private-renderer-error")) {
		t.Fatal("renderer failure leaked")
	}
}

func TestPDFDraftFiltersUnreviewedContent(t *testing.T) {
	f := setup(t)
	path, room := f.inspection()
	batch := id()
	f.request("POST", path+"/batches", map[string]any{"id": batch, "roomId": room, "mediaIds": []string{id()}}, 201)
	f.request("POST", path+"/batches/"+batch+"/observations", map[string]any{"id": id(), "title": "NEVER_EXPORT_PENDING", "description": "Unreviewed content", "status": "approved"}, 201)
	renderer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseMultipartForm(4 << 20)
		defer r.MultipartForm.RemoveAll()
		part, e := r.MultipartForm.File["files"][0].Open()
		if e != nil {
			t.Error(e)
			return
		}
		html, _ := io.ReadAll(part)
		part.Close()
		if bytes.Contains(html, []byte("NEVER_EXPORT_PENDING")) {
			t.Error("unreviewed capture exported")
		}
		_, _ = w.Write([]byte("%PDF-1.7\n%%EOF"))
	}))
	defer renderer.Close()
	f.a.pdfURL = renderer.URL
	pdfResponse(f, path, 200)
}

// Actual Chromium output is inspected independently by scripts/check-pdf.py.
func TestPDFActualRendering(t *testing.T) {
	if os.Getenv("PDF_RENDERER_URL") == "" {
		if os.Getenv("REQUIRE_INTEGRATION") == "1" {
			t.Fatal("PDF renderer required")
		}
		t.Skip("requires the Docker PDF renderer")
	}
	f := setup(t)
	path, room := f.inspection()
	iid := strings.Split(path, "/inspections/")[1]
	batch, photo := id(), id()
	photos := []string{photo, id(), id(), id()}
	f.request("POST", path+"/batches", map[string]any{"id": batch, "roomId": room, "mediaIds": photos}, 201)
	imageBytes, e := os.ReadFile("testdata/report-house.jpg")
	if e != nil {
		var img bytes.Buffer
		painting := image.NewRGBA(image.Rect(0, 0, 640, 420))
		for y := 0; y < 420; y++ {
			for x := 0; x < 640; x++ {
				painting.Set(x, y, color.RGBA{uint8(x / 3), uint8(y / 2), 90, 255})
			}
		}
		_ = jpeg.Encode(&img, painting, nil)
		imageBytes = img.Bytes()
	}
	f.upload(path+"/batches/"+batch, photo, imageBytes, "image/jpeg", 201)
	for index, dimensions := range [][2]int{{180, 600}, {1000, 240}, {360, 360}} {
		painting := image.NewRGBA(image.Rect(0, 0, dimensions[0], dimensions[1]))
		for y := 0; y < dimensions[1]; y++ {
			for x := 0; x < dimensions[0]; x++ {
				painting.Set(x, y, color.RGBA{uint8(x % 200), uint8(y % 200), 100, 255})
			}
		}
		var encoded bytes.Buffer
		_ = jpeg.Encode(&encoded, painting, nil)
		f.upload(path+"/batches/"+batch, photos[index+1], encoded.Bytes(), "image/jpeg", 201)
	}
	makeDoc := func(final bool, long bool) pdfDocument {
		status := "draft"
		if final {
			status = "final"
		}
		doc := pdfDocument{ID: id(), CreatedAt: time.Date(2026, 10, 29, 9, 30, 0, 0, time.UTC), Inspection: pdfInspection{ID: iid, Address: "Lindelaan 42", Postcode: "3511 AB", City: "Utrecht", Kind: "pre", Status: status}, Organisation: reportPerson{Name: "Woningcorporatie Voorbeeld"}, CreatedBy: reportPerson{Name: "Sanne de Vries"}, Rooms: []pdfRoom{{ID: room, Name: "Badkamer"}}, Batches: []pdfBatch{{ID: batch, RoomID: room, Status: "reviewed"}}, Media: []pdfPhoto{{ID: photo, BatchID: batch, Kind: "photo", Name: "Woningoverzicht.jpg"}}, Observations: []pdfObservation{{ID: id(), BatchID: batch, Title: "Lekkage bij de wastafelkraan", Description: "Tijdens de controle zijn druppels zichtbaar bij de aansluiting van de wastafelkraan. Laat de aansluiting controleren en leg het resultaat van de herstelcontrole vast.", Label: "Herstel beoordelen", PhotoIDs: []string{photo}}}}
		if final {
			doc.FinalisedBy = reportPerson{Name: "Sanne de Vries"}
		}
		rules, _ := baselineNorms()
		doc.Norms = &normDocument{Name: "Basiskwaliteit woningen", Number: 1, Rules: rules[:1]}
		doc.Assessments = []pdfAssessment{{RuleID: rules[0].ID, BatchID: batch, Outcome: "unacceptable", Reason: "De inspecteur bevestigt de zichtbare vochtsporen. De oorzaak is met deze opname niet vastgesteld.", PhotoIDs: []string{photo}}}
		if long {
			for index, photoID := range photos[1:] {
				doc.Media = append(doc.Media, pdfPhoto{ID: photoID, BatchID: batch, Kind: "photo", Name: fmt.Sprintf("Detailbeeld-%d.jpg", index+2)})
			}
			doc.Observations[0].PhotoIDs = photos
			// One finding spans pages; many rooms test heading continuation and bookmarks.
			for i, name := range []string{"Keuken", "Woonkamer", "Slaapkamer", "Entree", "Buitenruimte"} {
				rid, bid := id(), id()
				doc.Rooms = append(doc.Rooms, pdfRoom{ID: rid, Name: name})
				doc.Batches = append(doc.Batches, pdfBatch{ID: bid, RoomID: rid, Status: "reviewed"})
				for j := 0; j < 3; j++ {
					text := strings.Repeat("De afwerking heeft zichtbare gebruikssporen. De inspecteur controleert de aansluiting en de bevestiging. ", 9)
					if i == 0 && j == 0 {
						text = strings.Repeat("Doorlopende inspectietekst om paginaovergangen te controleren. ", 145)
					}
					doc.Observations = append(doc.Observations, pdfObservation{ID: id(), BatchID: bid, Title: fmtReportFinding(i, j), Description: text})
				}
			}
			doc.Observations[len(doc.Observations)-1].Description += " EINDE-CONTROLE-98765"
		}
		return doc
	}
	for _, sample := range []struct {
		name        string
		final, long bool
	}{{"report-short", true, false}, {"report-long", true, true}, {"report-draft", false, false}} {
		doc := makeDoc(sample.final, sample.long)
		if e = preparePDFDocument(&doc); e != nil {
			t.Fatal(e)
		}
		raw, e := f.a.renderReportPDF(context.Background(), f.org, doc)
		if e != nil {
			t.Fatalf("%s: %v", sample.name, e)
		}
		if dir := os.Getenv("PDF_ARTIFACT_DIR"); dir != "" {
			if e = os.MkdirAll(dir, 0755); e != nil {
				t.Fatal(e)
			}
			if e = os.WriteFile(filepath.Join(dir, sample.name+".pdf"), raw, 0644); e != nil {
				t.Fatal(e)
			}
			html, err := executePDFTemplate("index.html", doc)
			if err != nil {
				t.Fatal(err)
			}
			if e = os.WriteFile(filepath.Join(dir, sample.name+".html"), html, 0644); e != nil {
				t.Fatal(e)
			}
		}
		t.Logf("%s: %d PDF bytes", sample.name, len(raw))
	}
}
func fmtReportFinding(room, finding int) string {
	return fmt.Sprintf("Bevinding %c-%d", 'A'+room, finding+1)
}

func TestPDFTemplateEscaping(t *testing.T) {
	// Template parsing is also checked for all three independent Chromium documents.
	doc := pdfDocument{Inspection: pdfInspection{ID: id(), Address: "Straat & huis <42>"}}
	if e := preparePDFDocument(&doc); e != nil {
		t.Fatal(e)
	}
	for _, name := range []string{"index.html", "header.html", "footer.html"} {
		raw, e := executePDFTemplate(name, doc)
		if e != nil {
			t.Fatal(e)
		}
		if bytes.Contains(raw, []byte("<42>")) {
			t.Fatal("unescaped address")
		}
	}
}

func TestPDFPhotoOrientation(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 40, 20))
	for y := 0; y < 20; y++ {
		for x := 0; x < 40; x++ {
			c := color.RGBA{230, 20, 20, 255}
			if x >= 20 {
				c = color.RGBA{20, 230, 20, 255}
			}
			img.Set(x, y, c)
		}
	}
	var source bytes.Buffer
	_ = jpeg.Encode(&source, img, &jpeg.Options{Quality: 95})
	exif := []byte{0xff, 0xe1, 0, 0x22, 'E', 'x', 'i', 'f', 0, 0, 'I', 'I', 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0}
	original := source.Bytes()
	withOrientation := append(append(append([]byte{}, original[:2]...), exif...), original[2:]...)
	raw, e := reportPhotoJPEG(withOrientation)
	if e != nil {
		t.Fatal(e)
	}
	corrected, e := jpeg.Decode(bytes.NewReader(raw))
	if e != nil {
		t.Fatal(e)
	}
	if corrected.Bounds().Dx() != 20 || corrected.Bounds().Dy() != 40 {
		t.Fatalf("phone photo not rotated: %v", corrected.Bounds())
	}
	r, g, _, _ := corrected.At(10, 5).RGBA()
	if r <= g {
		t.Fatal("incorrect top of rotated photo")
	}
	r, g, _, _ = corrected.At(10, 35).RGBA()
	if g <= r {
		t.Fatal("incorrect bottom of rotated photo")
	}
	if _, e = reportPhotoJPEG([]byte("invalid photo")); e == nil {
		t.Fatal("unreadable photo accepted")
	}
}
