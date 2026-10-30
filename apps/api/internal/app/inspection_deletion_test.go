package app

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

func TestDeleteInspectionDossierAndFiles(t *testing.T) {
	for _, status := range []string{"draft", "final"} {
		t.Run(status, func(t *testing.T) {
			f, outsider := setup(t), setup(t)
			ctx := context.Background()
			doc, norm := testPublishedFormat(f, nil)
			path, iid := testFormatInspection(f, doc)
			data := f.request("GET", path, nil, 200)
			pid := data["inspection"].(map[string]any)["propertyId"].(string)
			room := data["rooms"].([]any)[0].(map[string]any)["id"].(string)
			batch, photo := id(), id()
			f.request("POST", path+"/batches", map[string]any{"id": batch, "roomId": room, "mediaIds": []string{photo}}, 201)
			png, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=")
			f.upload(path+"/batches/"+batch, photo, png, "image/png", 201)
			exec := func(sql string, args ...any) {
				t.Helper()
				if _, err := f.a.db.Exec(ctx, sql, args...); err != nil {
					t.Fatal(err)
				}
			}
			exec("INSERT INTO observations(id,org_id,inspection_id,batch_id,source) VALUES($1,$2,$3,$4,'manual')", id(), f.org, iid, batch)
			exec("INSERT INTO norm_assessments(id,org_id,inspection_id,batch_id,norm_version_id,rule_id,outcome,reason,source) VALUES($1,$2,$3,$4,$5,$6,'not_assessable','Test','system') ON CONFLICT DO NOTHING", id(), f.org, iid, batch, norm.ID, norm.Rules[0].ID)
			exec("INSERT INTO format_review_events(id,org_id,inspection_id,room_id,user_id,action,detail) VALUES($1,$2,$3,$4,$5,'test','{}')", id(), f.org, iid, room, f.uid)
			exec("INSERT INTO property_events(id,org_id,inspection_id,property_id,actor_id,action,detail) VALUES($1,$2,$3,$4,$5,'test','{}')", id(), f.org, iid, pid, f.uid)
			if status == "final" {
				exec("UPDATE inspections SET status='final' WHERE id=$1", iid)
				exec("INSERT INTO reports(id,org_id,inspection_id,snapshot,created_by) VALUES($1,$2,$3,'{}',$4)", id(), f.org, iid, f.uid)
			}
			// Deleting an inspection must leave the property and its other inspections.
			sibling := id()
			f.request("POST", "/orgs/"+f.org+"/inspections", map[string]any{"id": sibling, "propertyId": pid, "kind": "pre", "formatVersionId": doc.ID}, 201)
			outsider.request("DELETE", path, nil, 404)
			f.request("DELETE", "/orgs/"+f.org+"/inspections/invalid", nil, 404)
			var roleID string
			var privileges []string
			if err := f.a.db.QueryRow(ctx, "SELECT ro.id,ro.privileges FROM organisation_roles ro JOIN memberships m ON m.role_id=ro.id WHERE m.org_id=$1 AND m.user_id=$2", f.org, f.uid).Scan(&roleID, &privileges); err != nil {
				t.Fatal(err)
			}
			exec("UPDATE organisation_roles SET privileges=ARRAY['inspections.read'] WHERE id=$1", roleID)
			f.request("DELETE", path, nil, 403)
			exec("UPDATE organisation_roles SET privileges=$1 WHERE id=$2", privileges, roleID)
			var key string
			if err := f.a.db.QueryRow(ctx, "SELECT object_key FROM media WHERE id=$1", photo).Scan(&key); err != nil {
				t.Fatal(err)
			}
			f.request("DELETE", path, nil, 204)
			for _, suffix := range []string{"", "/report"} {
				f.request("GET", path+suffix, nil, 404)
			}
			f.request("GET", "/orgs/"+f.org+"/media/"+photo, nil, 404)
			f.request("DELETE", path, nil, 404)
			f.request("GET", "/orgs/"+f.org+"/properties/"+pid, nil, 200)
			f.request("GET", "/orgs/"+f.org+"/inspections/"+sibling, nil, 200)
			for _, table := range []string{"property_events", "format_review_events", "scope_jobs", "format_answers", "transcription_jobs", "norm_assessments", "reports", "observations", "processing_jobs", "media", "batches", "rooms"} {
				var count int
				if err := f.a.db.QueryRow(ctx, "SELECT count(*) FROM "+table+" WHERE inspection_id=$1", iid).Scan(&count); err != nil || count != 0 {
					t.Fatalf("%s retained deleted data: %d, %v", table, count, err)
				}
			}
			// Storage failures retain a durable retry after the dossier is gone.
			storage := f.a.storage
			failedStorage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) }))
			defer failedStorage.Close()
			f.a.storage = s3.New(s3.Options{Region: "us-east-1", BaseEndpoint: aws.String(failedStorage.URL), UsePathStyle: true, Credentials: aws.AnonymousCredentials{}, RetryMaxAttempts: 1})
			processed, err := f.a.processInspectionFileDeletion(ctx)
			f.a.storage = storage
			if !processed || err == nil {
				t.Fatal("failed file deletion was not retained")
			}
			var attempts int
			if err := f.a.db.QueryRow(ctx, "SELECT attempts FROM inspection_file_deletions WHERE object_key=$1", key).Scan(&attempts); err != nil || attempts != 1 {
				t.Fatalf("missing retry: %d, %v", attempts, err)
			}
			exec("UPDATE inspection_file_deletions SET next_attempt_at=now() WHERE org_id=$1", f.org)
			if processed, err = f.a.processInspectionFileDeletion(ctx); !processed || err != nil {
				t.Fatalf("file cleanup failed: %v", err)
			}
			if _, err = storage.HeadObject(ctx, &s3.HeadObjectInput{Bucket: &f.a.bucket, Key: &key}); err == nil {
				t.Fatal("deleted inspection file remains in storage")
			}
			if processed, err = f.a.processInspectionFileDeletion(ctx); processed || err != nil {
				t.Fatalf("queue did not drain: %v", err)
			}
			// Delayed uploads cannot recreate a deleted dossier.
			f.request("POST", path+"/batches", map[string]any{"id": id(), "roomId": room, "mediaIds": []string{id()}}, 404)
		})
	}
}
