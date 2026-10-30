package app

import (
	"context"
	"encoding/json"
	"net/http"
	"satvey/inspect/internal/quality"
	"strings"

	"github.com/jackc/pgx/v5"
)

func writeNormChecks(ctx context.Context, tx pgx.Tx, org, inspection, batch, version, source string, transcripts []audioTranscript, checks []normCheck) error {
	provenance := map[string]int{}
	for _, t := range transcripts {
		provenance[t.MediaID] = t.Version
	}
	raw, _ := json.Marshal(provenance)
	for _, c := range checks {
		if c.PhotoIDs == nil {
			c.PhotoIDs = []string{}
		}
		if c.AudioIDs == nil {
			c.AudioIDs = []string{}
		}
		if _, e := tx.Exec(ctx, "INSERT INTO norm_assessments(id,org_id,inspection_id,batch_id,norm_version_id,rule_id,outcome,reason,photo_ids,audio_ids,source,transcript_versions) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(batch_id,rule_id) DO UPDATE SET outcome=EXCLUDED.outcome,reason=EXCLUDED.reason,photo_ids=EXCLUDED.photo_ids,audio_ids=EXCLUDED.audio_ids,source=EXCLUDED.source,transcript_versions=EXCLUDED.transcript_versions,stale=false,reviewed_outcome=NULL,review_note='',reviewed_by=NULL,reviewed_at=NULL,version=norm_assessments.version+1", id(), org, inspection, batch, version, c.RuleID, c.Outcome, c.Reason, c.PhotoIDs, c.AudioIDs, source, raw); e != nil {
			return e
		}
	}
	return nil
}

func ruleApplies(rule normRule, room string) bool { return quality.RuleApplies(rule, room) }
func seedAssessments(ctx context.Context, tx pgx.Tx, org, inspection, batch string) error {
	var version *string
	var room string
	e := tx.QueryRow(ctx, "SELECT i.norm_version_id,r.name FROM inspections i JOIN batches b ON b.inspection_id=i.id AND b.org_id=i.org_id JOIN rooms r ON r.id=b.room_id AND r.org_id=b.org_id WHERE i.id=$1 AND i.org_id=$2 AND b.id=$3", inspection, org, batch).Scan(&version, &room)
	if e != nil {
		return e
	}
	if version == nil {
		return nil
	}
	d, e := readNorm(ctx, tx, org, *version)
	if e != nil {
		return e
	}
	for _, rule := range d.Rules {
		if ruleApplies(rule, room) {
			if _, e = tx.Exec(ctx, "INSERT INTO norm_assessments(id,org_id,inspection_id,batch_id,norm_version_id,rule_id,outcome,reason,source) VALUES($1,$2,$3,$4,$5,$6,'not_assessable','Nog niet beoordeeld','system') ON CONFLICT(batch_id,rule_id) DO NOTHING", id(), org, inspection, batch, *version, rule.ID); e != nil {
				return e
			}
		}
	}
	return nil
}
func (a *app) reviewNormAssessment(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Outcome string `json:"outcome"`
		Note    string `json:"note"`
		Version int    `json:"version"`
	}
	if e := readJSON(w, r, &in); e != nil {
		return e
	}
	if !validID(r.PathValue("assessment")) || !validOutcome(in.Outcome) || len(in.Note) > 3000 {
		return fail(400, "Controleer de normbeoordeling")
	}
	tx, u, e := a.edit(r)
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	var aiOutcome, reason string
	var stale bool
	if e = tx.QueryRow(r.Context(), "SELECT outcome,reason,stale FROM norm_assessments WHERE id=$1 AND org_id=$2 AND inspection_id=$3", r.PathValue("assessment"), r.PathValue("org"), r.PathValue("inspection")).Scan(&aiOutcome, &reason, &stale); e != nil {
		return e
	}
	var processing bool
	if e = tx.QueryRow(r.Context(), "SELECT NOT EXISTS(SELECT 1 FROM processing_jobs j JOIN norm_assessments a ON a.batch_id=j.batch_id AND a.org_id=j.org_id WHERE a.id=$1 AND a.org_id=$2 AND j.status='done')", r.PathValue("assessment"), r.PathValue("org")).Scan(&processing); e != nil {
		return e
	}
	if processing {
		return fail(409, "Wacht op de analyse of kies Handmatig verder voordat je de normbeoordeling bevestigt")
	}
	if stale {
		return fail(409, "Het transcript is gewijzigd. Wacht op een nieuwe analyse of beoordeel handmatig met toelichting.")
	}
	if (in.Outcome != aiOutcome || reason == "Nog niet beoordeeld") && strings.TrimSpace(in.Note) == "" {
		return fail(422, "Licht een handmatige of afwijkende beoordeling toe")
	}
	tag, e := tx.Exec(r.Context(), "UPDATE norm_assessments SET reviewed_outcome=$1,review_note=$2,previous_reviewed_outcome=NULL,previous_review_note='',reviewed_by=$3,reviewed_at=now(),version=version+1 WHERE id=$4 AND org_id=$5 AND inspection_id=$6 AND version=$7", in.Outcome, in.Note, u.ID, r.PathValue("assessment"), r.PathValue("org"), r.PathValue("inspection"), in.Version)
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return fail(409, "De normbeoordeling is gewijzigd. Herlaad de nieuwste versie.")
	}
	if _, e = tx.Exec(r.Context(), "UPDATE batches SET status=CASE WHEN status='excluded' THEN status ELSE 'pending' END,version=version+1 WHERE id=(SELECT batch_id FROM norm_assessments WHERE id=$1 AND org_id=$2)", r.PathValue("assessment"), r.PathValue("org")); e != nil {
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	send(w, 200, map[string]int{"version": in.Version + 1})
	return nil
}
func (a *app) normBenchmark(w http.ResponseWriter, r *http.Request) error {
	if _, _, e := a.require(r, "benchmarks.read"); e != nil {
		return e
	}
	version := r.URL.Query().Get("normVersionId")
	d, e := readNorm(r.Context(), a.db, r.PathValue("org"), version)
	if e != nil {
		return e
	}
	if d.Status != "published" {
		return fail(404, "Gepubliceerd kader niet gevonden")
	}
	rows, e := list(r.Context(), a.db, `SELECT a.rule_id AS "ruleId",r.name AS room,count(*) FILTER(WHERE a.reviewed_outcome='acceptable' AND NOT a.stale) AS acceptable,count(*) FILTER(WHERE a.reviewed_outcome='unacceptable' AND NOT a.stale) AS unacceptable,count(*) FILTER(WHERE a.reviewed_outcome='not_assessable' AND NOT a.stale) AS "notAssessable",count(*) FILTER(WHERE a.reviewed_outcome='not_applicable' AND NOT a.stale) AS "notApplicable",count(*) FILTER(WHERE a.reviewed_outcome IS NULL OR a.stale) AS pending FROM norm_assessments a JOIN batches b ON b.id=a.batch_id AND b.org_id=a.org_id JOIN rooms r ON r.id=b.room_id AND r.org_id=b.org_id WHERE a.org_id=$1 AND a.norm_version_id=$2 AND b.status<>'excluded' GROUP BY a.rule_id,r.name ORDER BY r.name,a.rule_id`, r.PathValue("org"), version)
	if e != nil {
		return e
	}
	rows, e = a.addFormatBenchmarks(r.Context(), r.PathValue("org"), version, rows)
	if e != nil {
		return e
	}
	send(w, 200, map[string]any{"norms": d, "rows": rows})
	return nil
}
func (a *app) saveTranscript(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Transcript string `json:"transcript"`
		Version    int    `json:"version"`
	}
	if e := readJSON(w, r, &in); e != nil {
		return e
	}
	if !validID(r.PathValue("media")) || len(in.Transcript) > 20000 {
		return fail(400, "Gebruik een transcript van maximaal 20.000 tekens")
	}
	tx, _, e := a.edit(r)
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	var batch string
	e = tx.QueryRow(r.Context(), "UPDATE media SET transcript=$1,transcript_version=transcript_version+1 WHERE id=$2 AND org_id=$3 AND inspection_id=$4 AND kind='audio' AND transcript_version=$5 RETURNING batch_id", strings.TrimSpace(in.Transcript), r.PathValue("media"), r.PathValue("org"), r.PathValue("inspection"), in.Version).Scan(&batch)
	if e == pgx.ErrNoRows {
		return fail(409, "Dit transcript is gewijzigd. Herlaad de nieuwste versie.")
	}
	if e != nil {
		return e
	}
	if _, e = tx.Exec(r.Context(), `UPDATE transcription_jobs SET status='skipped',run_token=NULL,lease_until=NULL,last_error='Transcript handmatig opgeslagen' WHERE media_id=$1 AND org_id=$2`, r.PathValue("media"), r.PathValue("org")); e != nil {
		return e
	}
	var room, provider string
	if e = tx.QueryRow(r.Context(), `SELECT room_id,analysis_provider FROM batches WHERE id=$1 AND org_id=$2`, batch, r.PathValue("org")).Scan(&room, &provider); e != nil {
		return e
	}
	if e = invalidateFormatScope(r.Context(), tx, r.PathValue("org"), r.PathValue("inspection"), room, provider); e != nil {
		return e
	}
	if _, e = tx.Exec(r.Context(), "UPDATE norm_assessments SET stale=true,version=version+1 WHERE batch_id=$1 AND org_id=$2", batch, r.PathValue("org")); e != nil {
		return e
	}
	if _, e = tx.Exec(r.Context(), "UPDATE processing_jobs SET status='pending',attempts=0,last_error='',run_token=NULL,lease_until=NULL,next_attempt_at=now() WHERE batch_id=$1 AND org_id=$2", batch, r.PathValue("org")); e != nil {
		return e
	}
	if _, e = tx.Exec(r.Context(), "UPDATE batches SET status=CASE WHEN status='excluded' THEN status ELSE 'pending' END,version=version+1 WHERE id=$1 AND org_id=$2", batch, r.PathValue("org")); e != nil {
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	send(w, 200, map[string]int{"version": in.Version + 1})
	return nil
}
func readInspectionNorms(ctx context.Context, q querier, org, inspection string) (*normDocument, error) {
	var version *string
	if e := q.QueryRow(ctx, "SELECT norm_version_id FROM inspections WHERE id=$1 AND org_id=$2", inspection, org).Scan(&version); e != nil {
		return nil, e
	}
	if version == nil {
		return nil, nil
	}
	d, e := readNorm(ctx, q, org, *version)
	return &d, e
}
