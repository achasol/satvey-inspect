package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5"
)

type formatSuggestion struct {
	QuestionID string          `json:"questionId"`
	Value      json.RawMessage `json:"value"`
	Reason     string          `json:"reason"`
	PhotoIDs   []string        `json:"photoIds"`
	AudioIDs   []string        `json:"audioIds"`
	Ready      bool            `json:"ready"`
}

func validateFormatSuggestions(answers []formatSuggestion, in normAnalysisInput, photos []analysisPhoto) error {
	known := map[string]formatQuestion{}
	for _, q := range in.Questions {
		known[q.ID] = q
	}
	seen := map[string]bool{}
	ev := scopeEvidence{Photos: map[string]bool{}, Audio: map[string]int{}}
	for _, p := range photos {
		ev.Photos[p.ID] = true
	}
	for _, t := range in.Transcripts {
		ev.Audio[t.MediaID] = t.Version
	}
	for _, v := range answers {
		q, ok := known[v.QuestionID]
		if !ok || seen[v.QuestionID] || len(v.Reason) > 3000 {
			return fmt.Errorf("analyse gaf ongeldige vraagverwijzingen")
		}
		seen[v.QuestionID] = true
		ids := map[string]bool{}
		for _, p := range v.PhotoIDs {
			if !ev.Photos[p] || ids[p] {
				return fmt.Errorf("analyse verwees naar een ongeldige foto")
			}
			ids[p] = true
		}
		for _, p := range v.AudioIDs {
			if ev.Audio[p] == 0 || ids[p] {
				return fmt.Errorf("analyse verwees naar een ongeldig transcript")
			}
			ids[p] = true
		}
		if v.Ready && (!validAnswerValue(q, v.Value) || len(v.PhotoIDs)+len(v.AudioIDs) == 0) {
			return fmt.Errorf("analyse gaf een antwoord zonder passend bronbewijs")
		}
	}
	return nil
}
func (a *app) audioWorker(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if e := a.processTranscription(ctx); e != nil && ctx.Err() == nil {
				slog.Error("transcription job retained", "error", e)
			}
		}
	}
}
func (a *app) scopeWorker(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if e := a.processScopeJob(ctx); e != nil && ctx.Err() == nil {
				slog.Error("scope analysis job retained", "error", e)
			}
		}
	}
}
func (a *app) scopeInput(ctx context.Context, org, inspection, room string, scope formatScope, provider string) (normAnalysisInput, []analysisPhoto, map[string]string, error) {
	// normInput supplies the pinned ontology and reference examples using the canonical room category.
	input, _, e := a.normInput(ctx, org, inspection, "00000000-0000-0000-0000-000000000000", scope.NormRoom, false)
	if e != nil {
		return input, nil, nil, e
	}
	if scope.Property {
		var raw []byte
		if e = a.db.QueryRow(ctx, `SELECT element_context FROM inspections WHERE id=$1 AND org_id=$2`, inspection, org).Scan(&raw); e != nil {
			return input, nil, nil, e
		}
		if e = json.Unmarshal(raw, &input.Elements); e != nil {
			return input, nil, nil, e
		}
	}
	input.Questions = scope.Questions
	input.Room = scope.Name
	input.CurrentAnswers, e = readAnswers(ctx, a.db, org, inspection, room)
	if e != nil {
		return input, nil, nil, e
	}
	norm, e := readInspectionNorms(ctx, a.db, org, inspection)
	if e != nil {
		return input, nil, nil, e
	}
	input.Rules = []normRule{}
	if norm != nil {
		for _, rule := range norm.Rules {
			for _, q := range scope.Questions {
				if q.RuleID == rule.ID {
					input.Rules = append(input.Rules, rule)
					break
				}
			}
		}
	}
	if provider == "baseten" {
		if e = a.addNormReferences(ctx, org, &input); e != nil {
			return input, nil, nil, e
		}
	}
	// Whole-property questions can use evidence from every room. Room questions are strictly local.
	rows, e := a.db.Query(ctx, `SELECT m.id,m.kind,m.object_key,m.mime,m.transcript,m.transcript_version,m.batch_id FROM media m JOIN batches b ON b.id=m.batch_id AND b.org_id=m.org_id WHERE m.org_id=$1 AND m.inspection_id=$2 AND b.status<>'excluded' AND ($4 OR b.room_id=$3) ORDER BY m.created_at`, org, inspection, room, scope.Property)
	if e != nil {
		return input, nil, nil, e
	}
	type source struct {
		ID, Kind, Key, Mime, Text, Batch string
		Version                          int
	}
	sources := []source{}
	for rows.Next() {
		var m source
		if e = rows.Scan(&m.ID, &m.Kind, &m.Key, &m.Mime, &m.Text, &m.Version, &m.Batch); e != nil {
			rows.Close()
			return input, nil, nil, e
		}
		sources = append(sources, m)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return input, nil, nil, e
	}
	photos := []analysisPhoto{}
	batches := map[string]string{}
	for _, m := range sources {
		batches[m.ID] = m.Batch
		if m.Kind == "audio" {
			if m.Text != "" {
				input.Transcripts = append(input.Transcripts, audioTranscript{MediaID: m.ID, Text: m.Text, Version: m.Version})
			}
			continue
		}
		if len(photos) >= 60 {
			return input, nil, nil, fmt.Errorf("meer dan 60 foto's in deze analyse; beoordeel handmatig of beperk de opgenomen foto's")
		}
		p := analysisPhoto{ID: m.ID, Mime: m.Mime}
		if provider == "baseten" {
			obj, err := a.storage.GetObject(ctx, &s3.GetObjectInput{Bucket: &a.bucket, Key: &m.Key})
			if err != nil {
				return input, nil, nil, fmt.Errorf("bronfoto tijdelijk niet beschikbaar")
			}
			data, err := io.ReadAll(io.LimitReader(obj.Body, 20<<20+1))
			obj.Body.Close()
			if err != nil || len(data) > 20<<20 {
				return input, nil, nil, fmt.Errorf("bronfoto te groot")
			}
			p.Bytes, err = previewPhoto(data)
			if err != nil {
				return input, nil, nil, err
			}
			p.Prepared = true
			p.Mime = "image/jpeg"
		}
		photos = append(photos, p)
	}
	return input, photos, batches, nil
}
func (a *app) processScopeJob(ctx context.Context) error {
	var room, org, inspection, provider string
	var attempt int
	run := id()
	e := a.db.QueryRow(ctx, `UPDATE scope_jobs SET status='processing',attempts=attempts+1,run_token=$1,lease_until=now()+interval '3 minutes' WHERE room_id=(
 SELECT j.room_id FROM scope_jobs j JOIN inspections i ON i.id=j.inspection_id AND i.org_id=j.org_id JOIN rooms r ON r.id=j.room_id AND r.org_id=j.org_id JOIN format_versions f ON f.id=i.format_version_id AND f.org_id=i.org_id JOIN LATERAL jsonb_array_elements(f.scopes) AS category(value) ON category.value->>'id'=r.category_id::text
 WHERE ($2::uuid IS NULL OR j.org_id=$2) AND i.status='draft' AND ((j.status='pending' AND j.next_attempt_at<=now()) OR (j.status='processing' AND j.lease_until<now()))
 AND NOT EXISTS(SELECT 1 FROM batches b WHERE b.inspection_id=j.inspection_id AND b.org_id=j.org_id AND b.status<>'excluded' AND (b.room_id=j.room_id OR (category.value->>'property')::boolean) AND cardinality(expected_media)<>(SELECT count(*) FROM media m WHERE m.batch_id=b.id AND m.org_id=b.org_id))
 AND NOT EXISTS(SELECT 1 FROM transcription_jobs t JOIN media m ON m.id=t.media_id AND m.org_id=t.org_id JOIN batches b ON b.id=m.batch_id AND b.org_id=m.org_id WHERE t.inspection_id=j.inspection_id AND t.org_id=j.org_id AND b.status<>'excluded' AND (b.room_id=j.room_id OR (category.value->>'property')::boolean) AND t.status NOT IN ('done','skipped'))
 ORDER BY j.next_attempt_at FOR UPDATE OF j SKIP LOCKED LIMIT 1) RETURNING room_id,org_id,inspection_id,provider,attempts`, run, nullableID(a.workerOrg)).Scan(&room, &org, &inspection, &provider, &attempt)
	if e == pgx.ErrNoRows {
		return nil
	}
	if e != nil {
		return e
	}
	c, cancel := context.WithTimeout(ctx, 130*time.Second)
	defer cancel()
	scope, _, generation, processingError := readScope(c, a.db, org, inspection, room)
	var input normAnalysisInput
	var photos []analysisPhoto
	var batches map[string]string
	result := normAnalysisResult{}
	if processingError == nil {
		input, photos, batches, processingError = a.scopeInput(c, org, inspection, room, scope, provider)
	}
	if processingError == nil && provider == "baseten" && (len(photos) > 0 || len(input.Transcripts) > 0) && len(scope.Questions) > 0 {
		normative, ok := a.analyzer.(normsAnalyzer)
		if !ok || a.imageProvider != "baseten" {
			processingError = fmt.Errorf("beeldanalyse is niet ingesteld")
		} else {
			result, processingError = normative.AnalyzeNorms(c, input, photos)
		}
	}
	if processingError == nil && provider == "mock" && len(photos) > 0 && len(scope.Questions) > 0 {
		result, processingError = (mockAnalyzer{}).AnalyzeNorms(c, input, photos)
	}
	tx, e := a.db.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	var status string
	if e = tx.QueryRow(ctx, `SELECT status FROM inspections WHERE id=$1 AND org_id=$2 FOR UPDATE`, inspection, org).Scan(&status); e != nil {
		return e
	}
	var active bool
	if e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM scope_jobs WHERE room_id=$1 AND org_id=$2 AND run_token=$3 AND status='processing')`, room, org, run).Scan(&active); e != nil {
		return e
	}
	if !active || status != "draft" {
		return nil
	}
	var current int
	if e = tx.QueryRow(ctx, `SELECT generation FROM rooms WHERE id=$1 AND org_id=$2`, room, org).Scan(&current); e != nil {
		return e
	}
	if current != generation {
		return nil
	}
	if processingError != nil {
		next := "pending"
		if attempt >= 3 {
			next = "failed"
		}
		if _, e = tx.Exec(ctx, `UPDATE scope_jobs SET status=$1,last_error=$2,run_token=NULL,lease_until=NULL,next_attempt_at=now()+($3*interval '20 seconds') WHERE room_id=$4 AND org_id=$5`, next, processingError.Error(), attempt, room, org); e != nil {
			return e
		}
		return tx.Commit(ctx)
	}
	checks := map[string]normCheck{}
	for _, check := range result.Checks {
		checks[check.RuleID] = check
	}
	versions := map[string]int{}
	for _, t := range input.Transcripts {
		versions[t.MediaID] = t.Version
	}
	for _, suggestion := range result.Answers {
		if !suggestion.Ready {
			continue
		}
		var question formatQuestion
		for _, q := range scope.Questions {
			if q.ID == suggestion.QuestionID {
				question = q
			}
		}
		outcome := ""
		if question.RuleID != "" {
			outcome = checks[question.RuleID].Outcome
			if question.Kind == "quality" {
				suggestion.Value, _ = json.Marshal(outcome)
			}
		}
		if suggestion.PhotoIDs == nil {
			suggestion.PhotoIDs = []string{}
		}
		if suggestion.AudioIDs == nil {
			suggestion.AudioIDs = []string{}
		}
		sourceVersions := map[string]int{}
		for _, mid := range suggestion.AudioIDs {
			sourceVersions[mid] = versions[mid]
		}
		raw, _ := json.Marshal(sourceVersions)
		// Compare the read revision as well as human flag: edits made during inference always win.
		var version int
		for _, old := range input.CurrentAnswers {
			if old.QuestionID == question.ID {
				version = old.Version
			}
		}
		if _, e = tx.Exec(ctx, `UPDATE format_answers SET value=$1,outcome=$2,reason=$3,status='suggested',photo_ids=$4,audio_ids=$5,transcript_versions=$6,version=version+1 WHERE room_id=$7 AND org_id=$8 AND question_id=$9 AND NOT human AND version=$10`, suggestion.Value, outcome, suggestion.Reason, suggestion.PhotoIDs, suggestion.AudioIDs, raw, room, org, question.ID, version); e != nil {
			return e
		}
	}
	// Findings remain editable. A new aggregate run replaces only untouched AI drafts, preserving human decisions.
	if !scope.Property {
		if _, e = tx.Exec(ctx, `DELETE FROM observations o USING batches b WHERE o.batch_id=b.id AND o.org_id=b.org_id AND b.room_id=$1 AND b.org_id=$2 AND o.source IN ('ai','mock') AND o.status='draft' AND o.version=1`, room, org); e != nil {
			return e
		}
		for _, p := range result.Findings {
			anchor := ""
			for _, mid := range append(append([]string{}, p.PhotoIDs...), p.AudioIDs...) {
				if batches[mid] != "" {
					anchor = batches[mid]
					break
				}
			}
			if anchor == "" {
				continue
			}
			if p.PhotoIDs == nil {
				p.PhotoIDs = []string{}
			}
			if p.AudioIDs == nil {
				p.AudioIDs = []string{}
			}
			// Evidence-identical findings already reviewed by an inspector are not reintroduced.
			var exists bool
			if e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM observations o JOIN batches b ON b.id=o.batch_id AND b.org_id=o.org_id WHERE b.room_id=$1 AND b.org_id=$2 AND (o.status<>'draft' OR o.version>1) AND o.photo_ids&&$3::uuid[])`, room, org, p.PhotoIDs).Scan(&exists); e != nil {
				return e
			}
			if exists {
				continue
			}
			if _, e = tx.Exec(ctx, `INSERT INTO observations(id,org_id,inspection_id,batch_id,title,description,label,status,source,photo_ids,audio_ids) VALUES($1,$2,$3,$4,$5,$6,$7,'draft',$10,$8,$9)`, id(), org, inspection, anchor, p.Title, p.Description, p.Label, p.PhotoIDs, p.AudioIDs, func() string {
				if provider == "mock" {
					return "mock"
				}
				return "ai"
			}()); e != nil {
				return e
			}
		}
	}
	if _, e = tx.Exec(ctx, `UPDATE scope_jobs SET status='done',last_error='',run_token=NULL,lease_until=NULL WHERE room_id=$1 AND org_id=$2`, room, org); e != nil {
		return e
	}
	if e = reconcileCaptureReviews(ctx, tx, org, inspection); e != nil {
		return e
	}
	return tx.Commit(ctx)
}
