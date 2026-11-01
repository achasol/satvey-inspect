package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5"
	"io"
	"log/slog"
	"satvey/inspect/internal/veradelivery"
	"strings"
	"time"
)

func (a *app) internalSyncWorker(ctx context.Context) {
	timer := time.NewTicker(2 * time.Second)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			if err := a.enqueueInternalSync(ctx); err != nil && ctx.Err() == nil {
				slog.Error("Internal sync scheduling failed")
			}
			if err := a.processInternalSync(ctx); err != nil && ctx.Err() == nil {
				slog.Error("Internal sync job retained")
			}
		}
	}
}
func (a *app) enqueueInternalSync(ctx context.Context) error {
	var org, destination, iid string
	var profileRevision, destinationRevision int
	err := a.db.QueryRow(ctx, `SELECT p.org_id,p.destination_id,i.id,p.revision,d.revision FROM internal_sync_profiles p JOIN handover_destinations d ON d.id=p.destination_id AND d.org_id=p.org_id JOIN inspections i ON i.org_id=p.org_id LEFT JOIN internal_sync_cursors c ON c.destination_id=p.destination_id AND c.inspection_id=i.id WHERE p.enabled AND d.enabled AND i.archived_at IS NULL AND ($1::uuid IS NULL OR i.org_id=$1) AND (c.source_revision IS DISTINCT FROM i.revision OR c.profile_revision IS DISTINCT FROM p.revision OR c.destination_revision IS DISTINCT FROM d.revision) ORDER BY i.created_at LIMIT 1`, nullableID(a.workerOrg)).Scan(&org, &destination, &iid, &profileRevision, &destinationRevision)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	p, err := readSyncProfile(ctx, a.db, org, destination)
	if err != nil {
		return err
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var revision int
	if err = tx.QueryRow(ctx, `SELECT revision FROM inspections WHERE id=$1 AND org_id=$2 FOR SHARE`, iid, org).Scan(&revision); err != nil {
		return err
	}
	snapshot, err := reportSnapshot(ctx, tx, org, iid)
	if err != nil {
		return err
	}
	var inspection map[string]any
	_ = json.Unmarshal(snapshot["inspection"], &inspection)
	var unitURI string
	if err = tx.QueryRow(ctx, `SELECT COALESCE((SELECT unit_uri FROM handover_property_mappings WHERE org_id=$1 AND destination_id=$2 AND property_id=$3),'')`, org, destination, inspection["propertyId"]).Scan(&unitURI); err != nil {
		return err
	}
	rows := map[string][]map[string]any{}
	decode := func(key string) []map[string]any {
		var result []map[string]any
		_ = json.Unmarshal(snapshot[key], &result)
		return result
	}
	if property, ok := inspection["propertySnapshot"].(map[string]any); ok {
		rows["property"] = []map[string]any{property}
	}
	status := map[string]any{}
	for _, key := range []string{"id", "kind", "status", "revision", "scheduledAt", "visitedAt", "visitOutcome", "assignedTo", "externalReference", "latestReportId"} {
		status[key] = inspection[key]
	}
	rows["status"] = []map[string]any{status}
	for category, key := range map[string]string{"rooms": "rooms", "findings": "observations", "assessments": "assessments", "agreements": "agreements", "photos": "media"} {
		rows[category] = decode(key)
	}
	for _, category := range []string{"audio", "transcripts"} {
		if !p.Categories[category].Enabled {
			continue
		}
		raw, e := list(ctx, tx, `SELECT m.id,m.name,m.mime,m.transcript,m.transcript_version AS "transcriptVersion" FROM media m JOIN batches b ON b.id=m.batch_id AND b.org_id=m.org_id WHERE m.org_id=$1 AND m.inspection_id=$2 AND m.kind='audio' AND b.status='reviewed' AND ($3='transcripts' OR m.content_deleted_at IS NULL)`, org, iid, category)
		if e != nil {
			return e
		}
		var decoded []map[string]any
		_ = json.Unmarshal(raw, &decoded)
		if category == "audio" {
			for _, record := range decoded {
				delete(record, "transcript")
				delete(record, "transcriptVersion")
			}
		}
		rows[category] = decoded
	}
	if report, ok := inspection["latestReportId"].(string); ok && validID(report) {
		rows["reports"] = []map[string]any{{"id": report, "title": "Vastgesteld inspectierapport"}}
	}
	for _, category := range syncCategories {
		mapping := p.Categories[category]
		if !mapping.Enabled || len(rows[category]) == 0 {
			continue
		}
		records := []map[string]any{}
		for index, row := range rows[category] {
			recordID, _ := row["id"].(string)
			if recordID == "" {
				recordID = fmt.Sprint(index)
			}
			record := map[string]any{"id": recordID, "inspectionId": iid, "propertyId": inspection["propertyId"], "unitUri": unitURI, "revision": revision, "title": fmt.Sprintf("%s · %v", category, inspection["address"]), "description": fmt.Sprintf("Satvey %s · dossierversie %d", category, revision), "data": row}
			if category == "photos" || category == "audio" {
				record["mediaId"] = row["id"]
			}
			if category == "reports" {
				record["reportId"] = row["id"]
			}
			records = append(records, record)
		}
		raw, _ := json.Marshal(records)
		if _, err = tx.Exec(ctx, `INSERT INTO internal_sync_jobs(id,org_id,inspection_id,destination_id,category,source_revision,profile_revision,destination_revision,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`, id(), org, iid, destination, category, revision, profileRevision, destinationRevision, raw); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(ctx, `INSERT INTO internal_sync_cursors(destination_id,inspection_id,source_revision,profile_revision,destination_revision) VALUES($1,$2,$3,$4,$5) ON CONFLICT(destination_id,inspection_id) DO UPDATE SET source_revision=$3,profile_revision=$4,destination_revision=$5`, destination, iid, revision, profileRevision, destinationRevision); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func sourcePath(data map[string]any, path string) (any, bool) {
	var value any = data
	for _, key := range strings.Split(path, ".") {
		object, ok := value.(map[string]any)
		if !ok {
			return nil, false
		}
		value, ok = object[key]
		if !ok {
			return nil, false
		}
	}
	return value, true
}
func (a *app) syncRecordFile(ctx context.Context, org, iid string, record map[string]any) ([]byte, string, string, error) {
	if mid, ok := record["mediaId"].(string); ok {
		var key, mime, name string
		err := a.db.QueryRow(ctx, `SELECT object_key,mime,name FROM media WHERE id::text=$1 AND org_id=$2 AND inspection_id=$3 AND content_deleted_at IS NULL`, mid, org, iid).Scan(&key, &mime, &name)
		if err != nil {
			return nil, "", "", err
		}
		object, err := a.storage.GetObject(ctx, &s3.GetObjectInput{Bucket: &a.bucket, Key: &key})
		if err != nil {
			return nil, "", "", err
		}
		defer object.Body.Close()
		raw, err := io.ReadAll(io.LimitReader(object.Body, 50*1048576+1))
		if len(raw) > 50*1048576 {
			return nil, "", "", fmt.Errorf("Bestand overschrijdt de ingestelde uploadlimiet")
		}
		return raw, mime, name, err
	}
	if report, ok := record["reportId"].(string); ok {
		var raw []byte
		if err := a.db.QueryRow(ctx, `SELECT snapshot FROM reports WHERE id::text=$1 AND org_id=$2 AND inspection_id=$3`, report, org, iid).Scan(&raw); err != nil {
			return nil, "", "", err
		}
		var doc pdfDocument
		if err := json.Unmarshal(raw, &doc); err != nil {
			return nil, "", "", err
		}
		if err := preparePDFDocument(&doc); err != nil {
			return nil, "", "", err
		}
		raw, err := a.frozenReportPDF(ctx, org, doc)
		return raw, "application/pdf", "inspectierapport.pdf", err
	}
	raw, err := json.Marshal(record["data"])
	return raw, "application/json", "inspectiegegevens.json", err
}
func (a *app) processInternalSync(parent context.Context) error {
	ctx, cancel := context.WithTimeout(parent, 3*time.Minute)
	defer cancel()
	token := id()
	var job, org, iid, destination, category string
	var profileRevision, destinationRevision, attempts int
	var raw, receiptsRaw []byte
	err := a.db.QueryRow(ctx, `UPDATE internal_sync_jobs SET status='processing',run_token=$1,lease_until=now()+interval '4 minutes',attempts=attempts+1 WHERE id=(SELECT j.id FROM internal_sync_jobs j WHERE ($2::uuid IS NULL OR j.org_id=$2) AND ((j.status IN ('pending','retrying') AND j.next_attempt_at<=now()) OR (j.status='processing' AND j.lease_until<now())) AND NOT EXISTS(SELECT 1 FROM internal_sync_jobs older WHERE older.destination_id=j.destination_id AND older.inspection_id=j.inspection_id AND older.category=j.category AND older.created_at<j.created_at AND older.status NOT IN ('done','cancelled')) ORDER BY j.created_at,j.id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id,org_id,inspection_id,destination_id,category,profile_revision,destination_revision,payload,receipts,attempts`, token, nullableID(a.workerOrg)).Scan(&job, &org, &iid, &destination, &category, &profileRevision, &destinationRevision, &raw, &receiptsRaw, &attempts)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	work := func() error {
		p, err := readSyncProfile(ctx, a.db, org, destination)
		if err != nil {
			return err
		}
		d, err := readHandoverDestination(ctx, a.db, org, destination)
		if err != nil {
			return err
		}
		mapping := p.Categories[category]
		if !p.Enabled || !d.Enabled || !mapping.Enabled || p.Revision != profileRevision || d.Revision != destinationRevision {
			return fmt.Errorf("Configuratie gewijzigd of uitgeschakeld; controleer de koppeling")
		}
		client, err := a.newHandoverClient(ctx, org, d)
		if err != nil {
			return err
		}
		client.Config.MaxRecordSize = 96 * 1048576
		client.BeforeRequest = func() error {
			var valid bool
			err := a.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM internal_sync_jobs j JOIN internal_sync_profiles p ON p.destination_id=j.destination_id JOIN handover_destinations d ON d.id=j.destination_id WHERE j.id=$1 AND j.run_token=$2 AND p.enabled AND d.enabled AND p.revision=$3 AND d.revision=$4)`, job, token, profileRevision, destinationRevision).Scan(&valid)
			if err != nil {
				return err
			}
			if !valid {
				return fmt.Errorf("Synchronisatie onderbroken door een configuratiewijziging")
			}
			return nil
		}
		records := []map[string]any{}
		receipts := map[string]string{}
		if err = json.Unmarshal(raw, &records); err != nil {
			return err
		}
		_ = json.Unmarshal(receiptsRaw, &receipts)
		for _, record := range records {
			recordID := fmt.Sprint(record["id"])
			if receipts[recordID] != "" {
				continue
			}
			// Load binary evidence only if a configured mapping actually requests it.
			for _, source := range mapping.Fields {
				if strings.HasPrefix(source, "file.") {
					bytes, mime, name, err := a.syncRecordFile(ctx, org, iid, record)
					if err != nil {
						return err
					}
					record["file"] = map[string]any{"base64": base64.StdEncoding.EncodeToString(bytes), "size": len(bytes), "mime": mime, "name": name}
					break
				}
			}
			row := map[string]any{"idExtern": iid + ":" + category + ":" + recordID, "idOrganisatie": d.Organisation, "idAdministratie": d.Administration}
			for target, source := range mapping.Fields {
				value, ok := sourcePath(record, source)
				if !ok {
					return fmt.Errorf("Bronpad %s ontbreekt voor categorie %s", source, category)
				}
				if target != "idExtern" && target != "idOrganisatie" && target != "idAdministratie" {
					row[target] = value
				}
			}
			receiver, err := client.SynchronizeResource(ctx, mapping.Resource, row)
			if err != nil {
				return err
			}
			receipts[recordID] = receiver
			checkpoint, _ := json.Marshal(receipts)
			if _, err = a.db.Exec(ctx, `UPDATE internal_sync_jobs SET receipts=$3 WHERE id=$1 AND run_token=$2`, job, token, checkpoint); err != nil {
				return err
			}
		}
		return nil
	}
	err = work()
	status, message := "done", ""
	if err != nil {
		status = "blocked"
		message = err.Error()
		var remote *veradelivery.Error
		if errors.As(err, &remote) && remote.Temporary {
			status = "retrying"
		}
	}
	_, saveErr := a.db.Exec(parent, `UPDATE internal_sync_jobs SET status=$3,error=$4,completed_at=CASE WHEN $3='done' THEN now() ELSE NULL END,next_attempt_at=now()+make_interval(secs=>LEAST(3600,30*$5)),run_token=NULL,lease_until=NULL WHERE id=$1 AND run_token=$2`, job, token, status, message, attempts)
	return saveErr
}
