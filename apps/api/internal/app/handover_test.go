package app

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"image"
	"image/jpeg"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"satvey/inspect/internal/handover"
)

func handoverFixture(f *fixture) (string, string) {
	f.t.Helper()
	path, room := f.inspection()
	f.request("GET", path+"/handover", nil, 422)
	batch, photo := id(), id()
	f.request("POST", path+"/batches", map[string]any{"id": batch, "roomId": room, "mediaIds": []string{photo}}, 201)
	var img bytes.Buffer
	_ = jpeg.Encode(&img, image.NewRGBA(image.Rect(0, 0, 12, 8)), nil)
	f.upload(path+"/batches/"+batch, photo, img.Bytes(), "image/jpeg", 201)
	f.request("PUT", path+"/media/"+photo+"/annotations", map[string]any{"version": 0, "shapes": []any{map[string]any{"tool": "arrow", "color": "#dc2626", "points": []any{map[string]float64{"x": 0.1, "y": 0.2}, map[string]float64{"x": 0.7, "y": 0.8}}}}}, 200)
	if err := f.a.processJob(context.Background()); err != nil {
		f.t.Fatal(err)
	}
	d := f.request("GET", path, nil, 200)
	observation := d["observations"].([]any)[0].(map[string]any)
	f.request("PUT", path+"/observations/"+observation["id"].(string), map[string]any{"version": observation["version"], "status": "approved", "title": "Kraan lekt", "description": "Zichtbare lekkage", "label": "Herstel"}, 200)
	d = f.request("GET", path, nil, 200)
	f.request("PUT", path+"/batches/"+batch, map[string]any{"version": d["batches"].([]any)[0].(map[string]any)["version"], "status": "reviewed"}, 200)
	f.request("POST", path+"/report", map[string]any{}, 201)
	return path, photo
}

func handoverDownload(f *fixture, path, format string, status int) []byte {
	f.t.Helper()
	res, err := f.client.Get(f.server.URL + "/api/v1" + path + "?format=" + format)
	if err != nil {
		f.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		f.t.Fatal(err)
	}
	if res.StatusCode != status {
		f.t.Fatalf("handover download got %d want %d: %s", res.StatusCode, status, raw)
	}
	if status == 200 && (!strings.Contains(res.Header.Get("Content-Disposition"), "attachment;") || res.Header.Get("Cache-Control") != "no-store") {
		f.t.Fatal("incorrect handover download headers")
	}
	return raw
}

func TestHandoverRevisionIsolationArchiveAndDeletion(t *testing.T) {
	f := setup(t)
	outsider := setup(t)
	path, photo := handoverFixture(f)
	detail := f.request("GET", path+"/handover", nil, 200)
	if detail["draft"].(map[string]any)["version"] != float64(0) {
		t.Fatal("unexpected initial revision")
	}
	source := detail["report"].(map[string]any)["sources"].([]any)[0].(map[string]any)["key"].(string)
	draft := handover.Draft{Destination: "Corporatie ERP", Proposals: []handover.Proposal{{ID: id(), SourceKeys: []string{source}, Description: "Herstel de kraan", Location: "Badkamer", Urgency: "soon"}},
		VERA: &handover.VERAContext{UnitURI: "https://vastgoed.example/v4/eenheden/42", Organisation: "SATVEY", Administration: "INSPECT"}}
	f.request("PUT", path+"/handover", draft, 200)
	f.request("PUT", path+"/handover", draft, 409)
	outsider.request("GET", path+"/handover", nil, 404)
	outsider.request("PUT", path+"/handover", draft, 404)
	export := id()
	body := map[string]any{"id": export, "version": 1}
	f.request("POST", path+"/handovers", body, 201)
	if result := f.request("POST", path+"/handovers", body, 200); result["id"] != export {
		t.Fatal("lost-response retry duplicated export")
	}
	if result := f.request("POST", path+"/handovers", map[string]any{"id": id(), "version": 1}, 200); result["id"] != export {
		t.Fatal("two preparations duplicated a revision")
	}
	endpoint := path + "/handovers/" + export + "/export"
	before := handoverDownload(f, endpoint, "json", 200)
	var bundle handover.Bundle
	if err := json.Unmarshal(before, &bundle); err != nil {
		t.Fatal(err)
	}
	if bundle.SchemaVersion != handover.SchemaVersion || bundle.DraftVersion != 1 || len(bundle.Proposals) != 1 {
		t.Fatalf("bad export: %s", before)
	}
	draft.Version = 1
	draft.Proposals[0].Description = "Gewijzigd werkvoorstel"
	f.request("PUT", path+"/handover", draft, 200)
	if !bytes.Equal(before, handoverDownload(f, endpoint, "json", 200)) {
		t.Fatal("old handover changed with its draft")
	}
	f.request("POST", path+"/handovers", map[string]any{"id": export, "version": 2}, 409)
	f.request("PUT", path+"/handover", handover.Draft{Version: 2, Destination: "ERP", Proposals: []handover.Proposal{{ID: id(), SourceKeys: []string{"answer:" + id()}, Description: "Not approved", Urgency: "routine"}}}, 422)
	outsider.request("POST", path+"/handovers", body, 404)
	handoverDownload(outsider, endpoint, "json", 404)
	// File generation is all-or-nothing. JSON/CSV remain independently available.
	renderer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("%PDF-1.7\nTest handover\n%%EOF\n"))
	}))
	defer renderer.Close()
	f.a.pdfURL = renderer.URL
	archive := handoverDownload(f, endpoint, "zip", 200)
	z, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		t.Fatal(err)
	}
	files := map[string][]byte{}
	for _, file := range z.File {
		reader, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		files[file.Name], err = io.ReadAll(reader)
		reader.Close()
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"report.pdf", "handover.json", "work-proposals.csv", "photos/" + photo + ".jpg", "photos/" + photo + "-annotated.svg", "vera/inspectierapporten.json", "vera/onderhoudstaken.json", "vera/transfer-plan.json"} {
		if len(files[name]) == 0 {
			t.Fatalf("missing archive entry %s", name)
		}
	}
	if err = json.Unmarshal(files["handover.json"], &bundle); err != nil {
		t.Fatal(err)
	}
	for _, a := range bundle.Attachments {
		sum := sha256.Sum256(files[a.Path])
		if a.Bytes != len(files[a.Path]) || a.SHA256 != hex.EncodeToString(sum[:]) {
			t.Fatalf("bad attachment integrity metadata: %+v", a)
		}
	}
	if !bytes.Contains(files["photos/"+photo+"-annotated.svg"], []byte("<svg")) || !bytes.Contains(files["work-proposals.csv"], []byte("Herstel de kraan")) {
		t.Fatal("lost frozen proposal or annotations")
	}
	if _, err = f.a.db.Exec(context.Background(), "UPDATE media SET object_key='unavailable-photo' WHERE id=$1", photo); err != nil {
		t.Fatal(err)
	}
	failed := handoverDownload(f, endpoint, "zip", 503)
	if bytes.HasPrefix(failed, []byte("PK")) {
		t.Fatal("returned partial ZIP after evidence failure")
	}
	handoverDownload(f, endpoint, "csv", 200)
	// Viewers can read/export frozen handovers, but cannot change or prepare one.
	f.request("PUT", "/orgs/"+f.org+"/members/"+f.uid, map[string]any{"role": "inspector"}, 422) // last administrator protection
	if _, err = f.a.db.Exec(context.Background(), "UPDATE memberships SET role='viewer' WHERE org_id=$1 AND user_id=$2", f.org, f.uid); err != nil {
		t.Fatal(err)
	}
	f.request("PUT", path+"/handover", draft, 403)
	f.request("POST", path+"/handovers", body, 403)
	handoverDownload(f, endpoint, "json", 200)
	if _, err = f.a.db.Exec(context.Background(), "UPDATE memberships SET role='admin' WHERE org_id=$1 AND user_id=$2", f.org, f.uid); err != nil {
		t.Fatal(err)
	}
	f.archiveAndPurge(path)
	var remaining int
	if err = f.a.db.QueryRow(context.Background(), "SELECT (SELECT count(*) FROM handover_exports WHERE org_id=$1)+(SELECT count(*) FROM handover_drafts WHERE org_id=$1)", f.org).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatalf("handover data survived deletion: %d %v", remaining, err)
	}
	handoverDownload(f, endpoint, "json", 404)
}
