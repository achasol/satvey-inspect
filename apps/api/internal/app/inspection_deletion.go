package app

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5"
)

func (a *app) deleteInspection(w http.ResponseWriter, r *http.Request) error {
	if _, _, err := a.access(r, true); err != nil {
		return err
	}
	inspection, org := r.PathValue("inspection"), r.PathValue("org")
	if !validID(inspection) {
		return fail(404, "Inspectie niet gevonden")
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	var locked string
	// The same lock used by uploads, reviews and worker result commits prevents
	// new evidence from being added while the dossier is removed.
	if err = tx.QueryRow(r.Context(), "SELECT id FROM inspections WHERE id=$1 AND org_id=$2 FOR UPDATE", inspection, org).Scan(&locked); err != nil {
		return err
	}
	if _, err = tx.Exec(r.Context(), `INSERT INTO inspection_file_deletions(object_key,org_id)
	 SELECT object_key,org_id FROM media WHERE inspection_id=$1 AND org_id=$2 ON CONFLICT DO NOTHING`, inspection, org); err != nil {
		return err
	}
	for _, table := range []string{"property_events", "format_review_events", "scope_jobs", "format_answers", "transcription_jobs", "norm_assessments", "reports", "observations", "processing_jobs", "media", "batches", "rooms"} {
		if _, err = tx.Exec(r.Context(), "DELETE FROM "+table+" WHERE inspection_id=$1 AND org_id=$2", inspection, org); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(r.Context(), "DELETE FROM inspections WHERE id=$1 AND org_id=$2", inspection, org); err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (a *app) processInspectionFileDeletion(ctx context.Context) (bool, error) {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	var key string
	var tenant *string
	if a.workerOrg != "" {
		tenant = &a.workerOrg
	}
	err = tx.QueryRow(ctx, `SELECT object_key FROM inspection_file_deletions
	 WHERE next_attempt_at<=now() AND ($1::uuid IS NULL OR org_id=$1)
	 ORDER BY next_attempt_at,object_key FOR UPDATE SKIP LOCKED LIMIT 1`, tenant).Scan(&key)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	storageCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	_, storageErr := a.storage.DeleteObject(storageCtx, &s3.DeleteObjectInput{Bucket: &a.bucket, Key: &key})
	if storageErr != nil {
		_, err = tx.Exec(ctx, "UPDATE inspection_file_deletions SET attempts=attempts+1,next_attempt_at=now()+interval '30 seconds' WHERE object_key=$1", key)
	} else {
		_, err = tx.Exec(ctx, "DELETE FROM inspection_file_deletions WHERE object_key=$1", key)
	}
	if err != nil {
		return false, err
	}
	if err = tx.Commit(ctx); err != nil {
		return false, err
	}
	return true, storageErr
}

func (a *app) inspectionDeletionWorker(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			for n := 0; n < 20; n++ {
				processed, err := a.processInspectionFileDeletion(ctx)
				if err != nil {
					slog.Error("inspection file deletion retained for retry", "error", err)
					break
				}
				if !processed {
					break
				}
			}
		}
	}
}
