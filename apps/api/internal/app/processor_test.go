package app

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestExpiredJobLeaseIsRecoveredOnce(t *testing.T) {
	f := setup(t)
	path, room := f.inspection()
	batch := id()
	f.request("POST", path+"/batches", map[string]any{"id": batch, "roomId": room, "mediaIds": []string{id()}}, 201)
	inspection := path[strings.LastIndex(path, "/")+1:]
	ctx := context.Background()
	if _, e := f.a.db.Exec(ctx, "INSERT INTO processing_jobs(id,org_id,inspection_id,batch_id,status,lease_until,run_token) VALUES($1,$2,$3,$4,'processing',now()-interval '1 minute',$5)", id(), f.org, inspection, batch, id()); e != nil {
		t.Fatal(e)
	}
	for i := 0; i < 20; i++ {
		if e := f.a.processJob(ctx); e != nil {
			t.Fatal(e)
		}
		var status string
		if e := f.a.db.QueryRow(ctx, "SELECT status FROM processing_jobs WHERE batch_id=$1", batch).Scan(&status); e != nil {
			t.Fatal(e)
		}
		if status == "done" {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if e := f.a.processJob(ctx); e != nil {
		t.Fatal(e)
	}
	var count int
	if e := f.a.db.QueryRow(ctx, "SELECT count(*) FROM observations WHERE batch_id=$1 AND org_id=$2", batch, f.org).Scan(&count); e != nil {
		t.Fatal(e)
	}
	if count != 1 {
		t.Fatalf("recovered lease produced %d proposals instead of one", count)
	}
}
