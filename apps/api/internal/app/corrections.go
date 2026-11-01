package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5"
)

// Remap keys as well as values: transcript version maps use media IDs as keys.
func remapRecord(value any, ids map[string]string) any {
	switch v := value.(type) {
	case string:
		if replacement, ok := ids[v]; ok {
			return replacement
		}
		return v
	case []any:
		for i := range v {
			v[i] = remapRecord(v[i], ids)
		}
		return v
	case map[string]any:
		out := map[string]any{}
		for key, item := range v {
			if replacement, ok := ids[key]; ok {
				key = replacement
			}
			out[key] = remapRecord(item, ids)
		}
		return out
	default:
		return value
	}
}

func (a *app) correctInspection(w http.ResponseWriter, r *http.Request) error {
	u, _, err := a.access(r, true)
	if err != nil {
		return err
	}
	in, err := readDossierAction(w, r)
	if err != nil {
		return err
	}
	org, old := r.PathValue("org"), r.PathValue("inspection")
	if !validID(old) {
		return fail(404, "Inspectie niet gevonden")
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	var status string
	var revision int
	var archived bool
	if err = tx.QueryRow(r.Context(), `SELECT status,revision,archived_at IS NOT NULL FROM inspections WHERE id=$1 AND org_id=$2 FOR UPDATE`, old, org).Scan(&status, &revision, &archived); err != nil {
		return err
	}
	if archived || status != "final" || revision != in.Version {
		return fail(409, "Open het actuele definitieve dossier om een correctie te starten")
	}
	var existing string
	if err = tx.QueryRow(r.Context(), `SELECT id FROM inspections WHERE corrects_inspection_id=$1 AND org_id=$2`, old, org).Scan(&existing); err == nil {
		send(w, 200, map[string]string{"id": existing})
		return nil
	} else if err != pgx.ErrNoRows {
		return err
	}
	next := id()
	if err = setActor(r.Context(), tx, u.ID); err != nil {
		return err
	}
	_, err = tx.Exec(r.Context(), `INSERT INTO inspections(id,org_id,property_id,kind,scheduled_at,created_by,norm_version_id,element_context,format_version_id,corrects_inspection_id,correction_reason,visited_at,visit_outcome,assigned_to,mutation_case_id,external_reference)
 SELECT $1,org_id,property_id,kind,scheduled_at,$4,norm_version_id,element_context,format_version_id,id,$5,visited_at,visit_outcome,assigned_to,mutation_case_id,external_reference FROM inspections WHERE id=$2 AND org_id=$3`, next, old, org, u.ID, in.Reason)
	if err != nil {
		return err
	}
	// Keep the historical property context; only explicit adoption may change it.
	if _, err = tx.Exec(r.Context(), `UPDATE inspections n SET property_snapshot=o.property_snapshot,property_context_version=o.property_context_version FROM inspections o WHERE n.id=$1 AND o.id=$2 AND n.org_id=$3`, next, old, org); err != nil {
		return err
	}
	ids := map[string]string{old: next}
	records := map[string][]map[string]any{}
	tables := []string{"rooms", "batches", "media", "observations", "norm_assessments", "format_answers", "inspection_agreements"}
	for _, table := range tables {
		raw, e := list(r.Context(), tx, `SELECT * FROM `+table+` WHERE org_id=$1 AND inspection_id=$2`, org, old)
		if e != nil {
			return e
		}
		var rows []map[string]any
		if e = json.Unmarshal(raw, &rows); e != nil {
			return e
		}
		records[table] = rows
		for _, row := range records[table] {
			key, _ := row["id"].(string)
			ids[key] = id()
		}
	}
	// Object copies have separate ownership. Deleting a correction cannot delete
	// evidence belonging to the original report. Failed transactions queue cleanup.
	copied := []string{}
	committed := false
	defer func() {
		if !committed {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			for _, key := range copied {
				_, _ = a.db.Exec(ctx, `INSERT INTO inspection_file_deletions(object_key,org_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, key, org)
			}
		}
	}()
	for _, table := range tables {
		for _, record := range records[table] {
			row := remapRecord(record, ids).(map[string]any)
			switch table {
			case "inspection_agreements":
				row["version"] = 1
			case "rooms":
				row["approved_generation"] = nil
				row["reviewed_by"] = nil
				row["reviewed_at"] = nil
			case "batches":
				if row["status"] != "excluded" {
					row["status"] = "pending"
				}
				row["version"] = 1
			case "observations":
				if row["status"] != "rejected" {
					row["status"] = "draft"
				}
				row["version"] = 1
			case "norm_assessments":
				row["reviewed_outcome"] = nil
				row["reviewed_by"] = nil
				row["reviewed_at"] = nil
				row["stale"] = false
				row["version"] = 1
			case "format_answers":
				if row["status"] == "confirmed" || row["status"] == "unanswerable" {
					row["status"] = "suggested"
				}
				row["reviewed_by"] = nil
				row["reviewed_at"] = nil
				row["version"] = 1
			case "media":
				source, _ := record["object_key"].(string)
				key := fmt.Sprintf("%s/%s/corrections/%s", org, next, row["id"])
				if record["content_deleted_at"] != nil {
					row["object_key"] = key
					break
				}
				copied = append(copied, key)
				_, err = a.storage.CopyObject(r.Context(), &s3.CopyObjectInput{Bucket: &a.bucket, Key: aws.String(key), CopySource: aws.String(a.bucket + "/" + source)})
				if err != nil {
					return fail(503, "Bronbewijs kon niet worden gekopieerd. Het oorspronkelijke rapport is ongewijzigd.")
				}
				row["object_key"] = key
			}
			raw, e := json.Marshal(row)
			if e != nil {
				return e
			}
			if _, e = tx.Exec(r.Context(), `INSERT INTO `+table+` SELECT * FROM jsonb_populate_record(NULL::`+table+`,$1::jsonb)`, raw); e != nil {
				return e
			}
		}
	}
	if _, err = tx.Exec(r.Context(), `INSERT INTO processing_jobs(id,org_id,inspection_id,batch_id,status,provider) SELECT gen_random_uuid(),org_id,inspection_id,id,'done',analysis_provider FROM batches WHERE inspection_id=$1 AND org_id=$2`, next, org); err != nil {
		return err
	}
	if err = recordEvent(r.Context(), tx, org, next, u.ID, "correction_started", map[string]string{"originalInspectionId": old, "reason": in.Reason}); err != nil {
		return err
	}
	if err = recordEvent(r.Context(), tx, org, old, u.ID, "correction_draft_created", map[string]string{"inspectionId": next, "reason": in.Reason}); err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	committed = true
	send(w, 201, map[string]string{"id": next})
	return nil
}
