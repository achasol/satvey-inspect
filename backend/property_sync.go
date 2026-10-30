package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"time"

	"github.com/jackc/pgx/v5"
)

func (a *app) enqueuePropertySync(ctx context.Context, org, source string, property *string) (string, error) {
	if !validID(source) {
		return "", fail(404, "Vastgoedbron niet gevonden")
	}
	tx, e := a.db.Begin(ctx)
	if e != nil {
		return "", e
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, `SELECT id FROM property_sources WHERE id=$1 AND org_id=$2 FOR UPDATE`, source, org); e != nil {
		return "", e
	}
	s, e := readPropertySource(ctx, tx, org, source)
	if e != nil {
		return "", e
	}
	if s.Kind != "vera" || !s.Enabled {
		return "", fail(422, "Deze bron is geen ingeschakelde VERA-koppeling")
	}
	var existing string
	var target *string
	e = tx.QueryRow(ctx, `SELECT id,property_id FROM property_sync_jobs WHERE source_id=$1 AND org_id=$2 AND status IN ('pending','processing')`, source, org).Scan(&existing, &target)
	if e == nil {
		if target != nil && (property == nil || *target != *property) {
			return "", fail(409, "Er wordt al een andere woning uit deze bron ververst; probeer na afloop opnieuw")
		}
		return existing, nil
	}
	if e != pgx.ErrNoRows {
		return "", e
	}
	job := id()
	if _, e = tx.Exec(ctx, `INSERT INTO property_sync_jobs(id,org_id,source_id,source_revision,property_id) VALUES($1,$2,$3,$4,$5)`, job, org, source, s.Revision, property); e != nil {
		return "", e
	}
	if property == nil {
		if _, e = tx.Exec(ctx, `UPDATE property_sources SET next_sync_at=now()+interval '1 hour' WHERE id=$1 AND org_id=$2`, source, org); e != nil {
			return "", e
		}
	}
	if e = tx.Commit(ctx); e != nil {
		return "", e
	}
	return job, nil
}
func (a *app) syncPropertySource(w http.ResponseWriter, r *http.Request) error {
	if _, e := a.admin(r); e != nil {
		return e
	}
	job, e := a.enqueuePropertySync(r.Context(), r.PathValue("org"), r.PathValue("source"), nil)
	if e != nil {
		return e
	}
	send(w, 202, map[string]string{"jobId": job})
	return nil
}
func (a *app) refreshProperty(w http.ResponseWriter, r *http.Request) error {
	if _, _, e := a.access(r, true); e != nil {
		return e
	}
	p, e := readProperty(r.Context(), a.db, r.PathValue("org"), r.PathValue("property"))
	if e != nil {
		return e
	}
	if p.LinkState != "linked" || p.SourceID == nil {
		return fail(422, "Koppel deze woning eerst aan een bronobject")
	}
	job, e := a.enqueuePropertySync(r.Context(), r.PathValue("org"), *p.SourceID, &p.ID)
	if e != nil {
		return e
	}
	send(w, 202, map[string]string{"jobId": job})
	return nil
}
func (a *app) propertyWorker(ctx context.Context) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if e := a.schedulePropertySyncs(ctx); e != nil && ctx.Err() == nil {
				slog.Error("property scheduling retained", "error", e)
			}
			if e := a.processPropertySync(ctx); e != nil && ctx.Err() == nil {
				slog.Error("property sync retained", "error", e)
			}
		}
	}
}
func (a *app) schedulePropertySyncs(ctx context.Context) error {
	_, e := a.db.Exec(ctx, `WITH due AS (SELECT s.id,s.org_id,s.revision FROM property_sources s WHERE s.kind='vera' AND s.enabled AND s.next_sync_at<=now() AND ($1::uuid IS NULL OR s.org_id=$1) AND NOT EXISTS(SELECT 1 FROM property_sync_jobs j WHERE j.source_id=s.id AND j.status IN ('pending','processing')) ORDER BY s.next_sync_at FOR UPDATE OF s SKIP LOCKED LIMIT 10), queued AS (INSERT INTO property_sync_jobs(id,org_id,source_id,source_revision) SELECT gen_random_uuid(),org_id,id,revision FROM due ON CONFLICT DO NOTHING RETURNING source_id) UPDATE property_sources SET next_sync_at=now()+interval '1 hour' WHERE id IN (SELECT source_id FROM queued)`, nullableID(a.workerOrg))
	return e
}
func (a *app) processPropertySync(ctx context.Context) error {
	var job, org, source, cursor string
	var target *string
	var revision, attempt, processed int
	var seenCursors []string
	run := id()
	e := a.db.QueryRow(ctx, `UPDATE property_sync_jobs SET status='processing',attempts=attempts+1,run_token=$1,lease_until=now()+interval '3 minutes' WHERE id=(SELECT id FROM property_sync_jobs WHERE ($2::uuid IS NULL OR org_id=$2) AND ((status='pending' AND next_attempt_at<=now()) OR (status='processing' AND lease_until<now())) ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id,org_id,source_id,property_id,source_revision,cursor,attempts,processed,seen_cursors`, run, nullableID(a.workerOrg)).Scan(&job, &org, &source, &target, &revision, &cursor, &attempt, &processed, &seenCursors)
	if e == pgx.ErrNoRows {
		return nil
	}
	if e != nil {
		return e
	}
	c, cancel := context.WithTimeout(ctx, 150*time.Second)
	defer cancel()
	s, processingError := readPropertySource(c, a.db, org, source)
	if attempt > 3 {
		processingError = fmt.Errorf("synchronisatie kon na drie pogingen niet worden afgerond; start opnieuw")
	}
	var client *veraClient
	rows := []catalogRow{}
	next := ""
	if processingError == nil && s.Revision != revision {
		processingError = fmt.Errorf("bronconfiguratie gewijzigd; start opnieuw")
	}
	if processingError == nil {
		client, processingError = a.newVeraClient(c, org, s)
	}
	if processingError == nil {
		if target == nil {
			rows, next, processingError = client.page(c, cursor)
		} else {
			var p catalogProperty
			p, processingError = readProperty(c, a.db, org, *target)
			if processingError == nil && (p.SourceID == nil || *p.SourceID != source || p.SourceObjectID == nil) {
				processingError = fmt.Errorf("woning heeft geen geldige bronidentiteit")
			}
			if processingError == nil {
				var unit veraObject
				_, processingError = client.get(c, s.BaseURL+"/eenheden/"+url.PathEscape(*p.SourceObjectID), &unit)
				if processingError == nil {
					if veraText(unit["id"]) != *p.SourceObjectID {
						processingError = fmt.Errorf("VERA gaf een andere eenheid-ID terug")
					} else {
						var row catalogRow
						row, processingError = client.mapUnit(c, unit)
						rows = append(rows, row)
					}
				}
			}
		}
	}
	if next != "" {
		for _, seen := range append(seenCursors, cursor) {
			if next == seen {
				processingError = fmt.Errorf("VERA herhaalt een cursor; synchronisatie gestopt")
			}
		}
	}
	if processed+len(rows) > 1000000 {
		processingError = fmt.Errorf("meer dan 1.000.000 eenheden in één synchronisatie")
	}
	tx, e := a.db.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	// Same lock order as configuration changes and CSV commits.
	if _, e = tx.Exec(ctx, `SELECT id FROM property_sources WHERE id=$1 AND org_id=$2 FOR UPDATE`, source, org); e != nil {
		return e
	}
	var active bool
	if e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM property_sync_jobs WHERE id=$1 AND org_id=$2 AND status='processing' AND run_token=$3)`, job, org, run).Scan(&active); e != nil {
		return e
	}
	if !active {
		return nil
	}
	current, e := readPropertySource(ctx, tx, org, source)
	if e != nil {
		return e
	}
	if current.Revision != revision || !current.Enabled {
		processingError = fmt.Errorf("bronconfiguratie gewijzigd; start opnieuw")
		attempt = 3
	}
	if processingError == nil {
		for _, p := range rows {
			var exists bool
			if e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM property_sync_seen WHERE job_id=$1 AND source_object_id=$2)`, job, p.SourceObjectID).Scan(&exists); e != nil {
				return e
			}
			if exists {
				processingError = fmt.Errorf("VERA herhaalt een eerder ontvangen eenheid-ID; controleer paginering")
				break
			}
		}
	}
	if processingError == nil {
		// A savepoint lets us retain a bounded retry/error state even for a database validation failure.
		pageTx, err := tx.Begin(ctx)
		if err != nil {
			return err
		}
		err = upsertCatalogRows(ctx, pageTx, org, source, rows)
		if err == nil {
			for _, p := range rows {
				if _, err = pageTx.Exec(ctx, `INSERT INTO property_sync_seen(job_id,source_object_id) VALUES($1,$2)`, job, p.SourceObjectID); err != nil {
					break
				}
			}
		}
		if err != nil {
			if e = pageTx.Rollback(ctx); e != nil {
				return e
			}
			processingError = fmt.Errorf("VERA-pagina kon niet worden opgeslagen; controleer de brongegevens")
		} else if e = pageTx.Commit(ctx); e != nil {
			return e
		}
	}
	if processingError != nil {
		state := "pending"
		if attempt >= 3 {
			state = "failed"
		}
		if _, e = tx.Exec(ctx, `UPDATE property_sync_jobs SET status=$1,last_error=$2,run_token=NULL,lease_until=NULL,next_attempt_at=now()+($3*interval '20 seconds'),finished_at=CASE WHEN $1='failed' THEN now() ELSE NULL END WHERE id=$4 AND org_id=$5`, state, processingError.Error(), attempt, job, org); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, `UPDATE property_sources SET last_error=$1 WHERE id=$2 AND org_id=$3`, processingError.Error(), source, org); e != nil {
			return e
		}
		if state == "failed" {
			if e = clearPropertySyncScratch(ctx, tx, job); e != nil {
				return e
			}
		}
		return tx.Commit(ctx)
	}
	state := "done"
	if next != "" {
		state = "pending"
	}
	if _, e = tx.Exec(ctx, `UPDATE property_sync_jobs SET status=$1,cursor=$2,seen_cursors=array_append(seen_cursors,$3),processed=processed+$4,attempts=0,run_token=NULL,lease_until=NULL,last_error='',next_attempt_at=now(),finished_at=CASE WHEN $1='done' THEN now() ELSE NULL END WHERE id=$5 AND org_id=$6`, state, next, cursor, len(rows), job, org); e != nil {
		return e
	}
	if state == "done" && target == nil {
		if _, e = tx.Exec(ctx, `UPDATE property_sources SET last_synced_at=now(),last_error='' WHERE id=$1 AND org_id=$2`, source, org); e != nil {
			return e
		}
	}
	if state == "done" {
		if e = clearPropertySyncScratch(ctx, tx, job); e != nil {
			return e
		}
	}
	return tx.Commit(ctx)
}

// IDs and cursor history are only needed while resuming an active job, not for every hourly run forever.
func clearPropertySyncScratch(ctx context.Context, tx pgx.Tx, job string) error {
	if _, e := tx.Exec(ctx, `DELETE FROM property_sync_seen WHERE job_id=$1`, job); e != nil {
		return e
	}
	_, e := tx.Exec(ctx, `UPDATE property_sync_jobs SET seen_cursors='{}' WHERE id=$1`, job)
	return e
}
