package main

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5"
)

func (a *app) worker(ctx context.Context) {
	go a.audioWorker(ctx)
	go a.scopeWorker(ctx)
	go a.propertyWorker(ctx)
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if e := a.processJob(ctx); e != nil && ctx.Err() == nil {
				slog.Error("image processing failed; job retained", "error", e)
			}
			_, _ = a.db.Exec(ctx, "DELETE FROM sessions WHERE expires_at<now(); DELETE FROM oidc_states WHERE expires_at<now(); DELETE FROM identity_links WHERE expires_at<now()")
		}
	}
}
func (a *app) batchPhotos(ctx context.Context, org, batch string, prepare bool) (string, []analysisPhoto, error) {
	var room string
	if e := a.db.QueryRow(ctx, "SELECT r.name FROM batches b JOIN rooms r ON r.id=b.room_id AND r.org_id=b.org_id WHERE b.id=$1 AND b.org_id=$2", batch, org).Scan(&room); e != nil {
		return "", nil, e
	}
	rows, e := a.db.Query(ctx, "SELECT id,mime,object_key FROM media WHERE batch_id=$1 AND org_id=$2 AND kind='photo' ORDER BY created_at", batch, org)
	if e != nil {
		return "", nil, e
	}
	defer rows.Close()
	photos := []analysisPhoto{}
	for rows.Next() {
		var p analysisPhoto
		var key string
		if e = rows.Scan(&p.ID, &p.Mime, &key); e != nil {
			return "", nil, e
		}
		if !prepare {
			photos = append(photos, p)
			continue
		}
		obj, e := a.storage.GetObject(ctx, &s3.GetObjectInput{Bucket: &a.bucket, Key: &key})
		if e != nil {
			return "", nil, fmt.Errorf("bronfoto tijdelijk niet beschikbaar")
		}
		p.Bytes, e = io.ReadAll(io.LimitReader(obj.Body, 20<<20+1))
		obj.Body.Close()
		if e != nil || len(p.Bytes) > 20<<20 {
			return "", nil, fmt.Errorf("bronfoto kon niet worden ingelezen")
		}
		p.Bytes, e = previewPhoto(p.Bytes)
		if e != nil {
			return "", nil, e
		}
		p.Mime = "image/jpeg"
		p.Prepared = true
		photos = append(photos, p)
	}
	return room, photos, rows.Err()
}
func (a *app) processJob(ctx context.Context) error {
	var job, org, inspection, batch, provider string
	var attempt int
	run := id()
	var tenant any
	if a.workerOrg != "" {
		tenant = a.workerOrg
	}
	e := a.db.QueryRow(ctx, `UPDATE processing_jobs SET status='processing',run_token=$1,lease_until=now()+interval '3 minutes',attempts=attempts+1 WHERE id=(SELECT id FROM processing_jobs WHERE ($2::uuid IS NULL OR org_id=$2::uuid) AND ((status='pending' AND next_attempt_at<=now()) OR (status='processing' AND lease_until<now())) ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id,org_id,inspection_id,batch_id,provider,attempts`, run, tenant).Scan(&job, &org, &inspection, &batch, &provider, &attempt)
	if e == pgx.ErrNoRows {
		return nil
	}
	if e != nil {
		return e
	}
	c, cancel := context.WithTimeout(ctx, 130*time.Second)
	defer cancel()
	room, photos, processingError := a.batchPhotos(c, org, batch, provider == "baseten")
	var proposals []proposal
	var checks []normCheck
	var input normAnalysisInput
	var normDoc *normDocument
	assessmentSource := provider
	if provider == "baseten" {
		assessmentSource = "ai"
	}
	if processingError == nil {
		input, normDoc, processingError = a.normInput(c, org, inspection, batch, room, provider == "baseten")
	}
	if processingError == nil {
		if len(photos) == 0 && len(input.Transcripts) == 0 {
			proposals = []proposal{{Title: "", Description: "", Label: "", PhotoIDs: []string{}}}
			assessmentSource = "system"
			for _, rule := range input.Rules {
				checks = append(checks, normCheck{RuleID: rule.ID, Outcome: "not_assessable", Reason: "Geen foto of ingevoerd transcript beschikbaar.", PhotoIDs: []string{}, AudioIDs: []string{}})
			}
		} else {
			var analyzer imageAnalyzer = mockAnalyzer{}
			if provider == "baseten" {
				if a.imageProvider != "baseten" || a.analyzer == nil {
					processingError = fmt.Errorf("beeldanalyse is niet ingesteld; controleer BASETEN_KEY op de server")
				} else {
					analyzer = a.analyzer
				}
			}
			if processingError == nil {
				if normDoc != nil || len(input.Transcripts) > 0 || len(input.Elements) > 0 || input.Property != nil {
					var result normAnalysisResult
					if normative, ok := analyzer.(normsAnalyzer); ok {
						result, processingError = normative.AnalyzeNorms(c, input, photos)
					} else {
						processingError = fmt.Errorf("analyse ondersteunt geen organisatiecontext")
					}
					proposals, checks = result.Findings, result.Checks
				} else {
					proposals, processingError = analyzer.Analyze(c, room, photos)
				}
			}
		}
	}
	tx, e := a.db.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	var inspectionStatus string
	if e = tx.QueryRow(ctx, "SELECT status FROM inspections WHERE id=$1 AND org_id=$2 FOR UPDATE", inspection, org).Scan(&inspectionStatus); e != nil {
		return e
	}
	var currentRun *string
	var status string
	if e = tx.QueryRow(ctx, "SELECT status,run_token FROM processing_jobs WHERE id=$1 FOR UPDATE", job).Scan(&status, &currentRun); e != nil {
		return e
	}
	if status != "processing" || currentRun == nil || *currentRun != run {
		return nil
	}
	var batchStatus string
	if e = tx.QueryRow(ctx, "SELECT status FROM batches WHERE id=$1 AND org_id=$2", batch, org).Scan(&batchStatus); e != nil {
		return e
	}
	if inspectionStatus != "draft" || batchStatus == "excluded" {
		processingError = nil
		proposals = nil
		checks = nil
	}
	if processingError != nil {
		nextStatus := "pending"
		if attempt >= 3 {
			nextStatus = "failed"
		}
		if _, e = tx.Exec(ctx, "UPDATE processing_jobs SET status=$1,last_error=$2,lease_until=NULL,run_token=NULL,next_attempt_at=now()+($3 * interval '20 seconds') WHERE id=$4", nextStatus, processingError.Error(), attempt, job); e != nil {
			return e
		}
		return tx.Commit(ctx)
	}
	var generated bool
	if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM observations WHERE batch_id=$1 AND org_id=$2 AND source IN ('ai','mock'))", batch, org).Scan(&generated); e != nil {
		return e
	}
	if generated {
		proposals = nil
	}
	for _, p := range proposals {
		source := "manual"
		if len(photos) > 0 || len(input.Transcripts) > 0 {
			source = "mock"
			if provider == "baseten" {
				source = "ai"
			}
		}
		if p.PhotoIDs == nil {
			p.PhotoIDs = []string{}
		}
		if p.AudioIDs == nil {
			p.AudioIDs = []string{}
		}
		if _, e = tx.Exec(ctx, "INSERT INTO observations(id,org_id,inspection_id,batch_id,title,description,label,status,source,photo_ids,audio_ids) VALUES($1,$2,$3,$4,$5,$6,$7,'draft',$8,$9,$10)", id(), org, inspection, batch, p.Title, p.Description, p.Label, source, p.PhotoIDs, p.AudioIDs); e != nil {
			return e
		}
	}
	if normDoc != nil {
		if e = writeNormChecks(ctx, tx, org, inspection, batch, normDoc.ID, assessmentSource, input.Transcripts, checks); e != nil {
			return e
		}
	}
	if _, e = tx.Exec(ctx, "UPDATE processing_jobs SET status='done',last_error='',lease_until=NULL,run_token=NULL WHERE id=$1", job); e != nil {
		return e
	}
	if e = reconcileCaptureReviews(ctx, tx, org, inspection); e != nil {
		return e
	}
	return tx.Commit(ctx)
}
func (a *app) retryAnalysis(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Action string `json:"action"`
	}
	if e := readJSON(w, r, &in); e != nil {
		return e
	}
	if in.Action != "retry" && in.Action != "skip" {
		return fail(400, "Ongeldige analyseactie")
	}
	if !validID(r.PathValue("batch")) {
		return fail(400, "Ongeldige opname")
	}
	tx, _, e := a.edit(r)
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	var status string
	if e = tx.QueryRow(r.Context(), "SELECT status FROM processing_jobs WHERE batch_id=$1 AND org_id=$2 AND inspection_id=$3 FOR UPDATE", r.PathValue("batch"), r.PathValue("org"), r.PathValue("inspection")).Scan(&status); e != nil {
		return e
	}
	if status == "done" {
		return fail(409, "Deze analyse is al afgerond")
	}
	next := "pending"
	if in.Action == "skip" {
		next = "done"
	}
	if _, e = tx.Exec(r.Context(), "UPDATE processing_jobs SET status=$1,attempts=0,last_error='',run_token=NULL,lease_until=NULL,next_attempt_at=now() WHERE batch_id=$2 AND org_id=$3", next, r.PathValue("batch"), r.PathValue("org")); e != nil {
		return e
	}
	if in.Action == "skip" {
		if _, e = tx.Exec(r.Context(), "UPDATE norm_assessments SET stale=false,outcome='not_assessable',reason='Nog niet beoordeeld',reviewed_outcome=NULL,review_note='',reviewed_by=NULL,reviewed_at=NULL,version=version+1 WHERE batch_id=$1 AND org_id=$2", r.PathValue("batch"), r.PathValue("org")); e != nil {
			return e
		}
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	send(w, 200, map[string]bool{"ok": true})
	return nil
}
