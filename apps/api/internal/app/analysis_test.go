package app

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/jpeg"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestBasetenImageContract(t *testing.T) {
	photoID := id()
	var img bytes.Buffer
	if e := jpeg.Encode(&img, image.NewRGBA(image.Rect(0, 0, 32, 20)), nil); e != nil {
		t.Fatal(e)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-key" {
			t.Error("missing authentication")
		}
		var body map[string]any
		if e := json.NewDecoder(r.Body).Decode(&body); e != nil {
			t.Fatal(e)
		}
		if body["model"] != "zai-org/GLM-5.3-Flash" {
			t.Error("wrong model")
		}
		raw, _ := json.Marshal(body)
		if !bytes.Contains(raw, []byte("data:image/jpeg;base64,")) || !bytes.Contains(raw, []byte(photoID)) {
			t.Error("missing image or source reference")
		}
		content, _ := json.Marshal(map[string]any{"findings": []proposal{{Title: "Scheur in gevel", Description: "Een scheur is zichtbaar naast het raam; de oorzaak is niet vast te stellen op deze foto.", Label: "Scheurvorming", PhotoIDs: []string{photoID}}}})
		send(w, 200, map[string]any{"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]string{"content": string(content)}}}})
	}))
	defer server.Close()
	b := basetenAnalyzer{key: "test-key", model: "zai-org/GLM-5.3-Flash", endpoint: server.URL, client: server.Client()}
	proposals, e := b.Analyze(context.Background(), "Gevel", []analysisPhoto{{ID: photoID, Mime: "image/jpeg", Bytes: img.Bytes()}})
	if e != nil || len(proposals) != 1 || proposals[0].PhotoIDs[0] != photoID {
		t.Fatalf("unexpected proposals: %v, %v", proposals, e)
	}
}
func TestVisionValidation(t *testing.T) {
	p := []analysisPhoto{{ID: id()}}
	if _, e := parseProposals(`{"findings":[{"title":"A","description":"B","label":"C","photoIds":["unknown"]}]}`, p); e == nil {
		t.Fatal("accepted unknown evidence")
	}
	if _, e := parseProposals(`{"findings":[]}`, p); e == nil {
		t.Fatal("accepted empty inference")
	}
	if _, e := previewPhoto([]byte("not a photo")); e == nil {
		t.Fatal("accepted invalid image")
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "secret test-key", 429) }))
	defer server.Close()
	var img bytes.Buffer
	_ = jpeg.Encode(&img, image.NewRGBA(image.Rect(0, 0, 2, 2)), nil)
	b := basetenAnalyzer{key: "test-key", endpoint: server.URL, client: server.Client()}
	_, e := b.Analyze(context.Background(), "Room", []analysisPhoto{{ID: id(), Bytes: img.Bytes()}})
	if e == nil || strings.Contains(e.Error(), "test-key") {
		t.Fatal("failure must not leak provider response or credentials")
	}
}
