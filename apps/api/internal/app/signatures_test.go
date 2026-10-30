package app

import (
	"bytes"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func testSignature(name, role string) signatureInput {
	return signatureInput{Name: name, Role: role, Strokes: [][]annotationPoint{{{X: .1, Y: .6}, {X: .4, Y: .2}, {X: .8, Y: .6}}}}
}

func TestSignatureValidation(t *testing.T) {
	if err := validateSignatures(nil); err != nil {
		t.Fatal("signatures must remain optional", err)
	}
	for _, role := range []string{"inspector", "resident", "other"} {
		if err := validateSignatures([]signatureInput{testSignature("Sanne", role)}); err != nil {
			t.Fatal(err)
		}
	}
	for _, change := range []func(*signatureInput){
		func(s *signatureInput) { s.Name = " " },
		func(s *signatureInput) { s.Name = strings.Repeat("A", 121) },
		func(s *signatureInput) { s.Role = "invalid" },
		func(s *signatureInput) { s.Strokes = nil },
		func(s *signatureInput) { s.Strokes[0] = s.Strokes[0][:1] },
		func(s *signatureInput) { s.Strokes[0] = []annotationPoint{{X: .3, Y: .3}, {X: .3, Y: .3}} },
		func(s *signatureInput) { s.Strokes[0][0].X = 2 },
		func(s *signatureInput) { s.Strokes[0][0].Y = math.NaN() },
		func(s *signatureInput) { s.Strokes[0] = make([]annotationPoint, 3001) },
	} {
		signature := testSignature("Sanne", "inspector")
		change(&signature)
		if err := validateSignatures([]signatureInput{signature}); err == nil {
			t.Fatal("invalid signature accepted")
		}
	}
	if err := validateSignatures(make([]signatureInput, 11)); err == nil {
		t.Fatal("too many signers accepted")
	}
}

func TestSignaturesFrozenInReportAndPDF(t *testing.T) {
	f := setup(t)
	path, room := f.inspection()
	batch := id()
	f.request("POST", path+"/batches", map[string]any{"id": batch, "roomId": room, "mediaIds": []string{id()}}, 201)
	f.request("PUT", path+"/batches/"+batch, map[string]any{"version": 1, "status": "excluded"}, 200)
	f.request("POST", path+"/report", map[string]any{"signatures": []signatureInput{testSignature("", "resident")}}, 422)
	// Caller-supplied timestamps and collector identities are never accepted.
	f.request("POST", path+"/report", map[string]any{"signatures": []any{map[string]any{"name": "Bewoner", "role": "resident", "strokes": testSignature("", "").Strokes, "signedAt": "2000-01-01T00:00:00Z"}}}, 400)
	start := time.Now().UTC().Add(-time.Second)
	input := []signatureInput{testSignature("Inspecteur & collega", "inspector"), testSignature("Bewoner <script>", "resident"), testSignature("Getuige", "other")}
	created := f.request("POST", path+"/report", map[string]any{"signatures": input}, 201)
	raw, _ := json.Marshal(created["signatures"])
	var signatures []reportSignature
	if err := json.Unmarshal(raw, &signatures); err != nil || len(signatures) != 3 {
		t.Fatalf("missing signatures: %s, %v", raw, err)
	}
	for i, signature := range signatures {
		if signature.Name != input[i].Name || signature.Role != input[i].Role || signature.CollectedBy != f.uid || signature.SignedAt.Before(start) || signature.SignedAt.After(time.Now().UTC()) {
			t.Fatal("signature identity, role or server timestamp missing")
		}
		want, _ := json.Marshal(input[i].Strokes)
		got, _ := json.Marshal(signature.Strokes)
		if !bytes.Equal(want, got) {
			t.Fatal("signature strokes changed")
		}
	}
	f.request("POST", path+"/report", map[string]any{"signatures": []signatureInput{testSignature("Changed", "other")}}, 409)
	stored := f.request("GET", path+"/report", nil, 200)
	again, _ := json.Marshal(stored["signatures"])
	if !bytes.Equal(raw, again) {
		t.Fatal("final signatures were modified")
	}
	renderer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseMultipartForm(32 << 20); err != nil {
			t.Error(err)
			w.WriteHeader(500)
			return
		}
		defer r.MultipartForm.RemoveAll()
		var html string
		for _, file := range r.MultipartForm.File["files"] {
			if file.Filename != "index.html" {
				continue
			}
			part, _ := file.Open()
			body, _ := io.ReadAll(part)
			part.Close()
			html = string(body)
		}
		for _, text := range []string{"Handtekeningen", "Inspecteur &amp; collega", "Bewoner &lt;script&gt;", "Overige aanwezige", "M60.00 108.00", "Vastgelegd op"} {
			if !strings.Contains(html, text) {
				t.Errorf("signed PDF missing %s", text)
			}
		}
		if strings.Contains(html, "<script>") {
			t.Error("unsafe signer name rendered as HTML")
		}
		w.Header().Set("Content-Type", "application/pdf")
		_, _ = w.Write([]byte("%PDF-1.7\nfixture\n%%EOF"))
	}))
	defer renderer.Close()
	f.a.pdfURL = renderer.URL
	pdfResponse(f, path, 200)
}
