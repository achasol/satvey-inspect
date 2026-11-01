package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
)

type formatAnswer struct {
	ProposedScore      *int            `json:"proposedScore,omitempty"`
	ScoreDetail        *scoreDetail    `json:"scoreDetail,omitempty"`
	ID                 string          `json:"id"`
	RoomID             string          `json:"roomId"`
	QuestionID         string          `json:"questionId"`
	Value              json.RawMessage `json:"value"`
	Outcome            string          `json:"outcome"`
	Reason             string          `json:"reason"`
	Status             string          `json:"status"`
	PhotoIDs           []string        `json:"photoIds"`
	AudioIDs           []string        `json:"audioIds"`
	TranscriptVersions map[string]int  `json:"transcriptVersions"`
	Human              bool            `json:"human"`
	Version            int             `json:"version"`
}

const answerSelect = `SELECT id,room_id AS "roomId",question_id AS "questionId",value,outcome,reason,status,photo_ids AS "photoIds",audio_ids AS "audioIds",transcript_versions AS "transcriptVersions",score_detail AS "scoreDetail",proposed_score AS "proposedScore",human,version FROM format_answers`

func readAnswers(ctx context.Context, q querier, org, inspection, room string) ([]formatAnswer, error) {
	raw, e := list(ctx, q, answerSelect+` WHERE org_id=$1 AND inspection_id=$2 AND ($3::uuid IS NULL OR room_id=$3::uuid) ORDER BY id`, org, inspection, nullableID(room))
	if e != nil {
		return nil, e
	}
	out := []formatAnswer{}
	e = json.Unmarshal(raw, &out)
	return out, e
}
func nullableID(s string) any {
	if s == "" {
		return nil
	}
	return s
}
func readScope(ctx context.Context, q querier, org, inspection, room string) (formatScope, *formatDocument, int, error) {
	d, e := inspectionFormat(ctx, q, org, inspection)
	if e != nil {
		return formatScope{}, nil, 0, e
	}
	if d == nil {
		return formatScope{}, nil, 0, fail(422, "Deze inspectie gebruikt geen format")
	}
	var category string
	var generation int
	e = q.QueryRow(ctx, `SELECT category_id,generation FROM rooms WHERE id=$1 AND org_id=$2 AND inspection_id=$3`, room, org, inspection).Scan(&category, &generation)
	if e != nil {
		return formatScope{}, d, 0, e
	}
	for _, s := range d.Scopes {
		if s.ID == category {
			return s, d, generation, nil
		}
	}
	return formatScope{}, d, 0, fail(422, "Ruimtecategorie ontbreekt in het vastgelegde format")
}
func questionActive(q formatQuestion, questions []formatQuestion, answers map[string]formatAnswer) bool {
	if q.Condition == nil {
		return true
	}
	parent, ok := answers[q.Condition.QuestionID]
	if !ok || parent.Status == "unanswerable" {
		return true
	}
	for _, p := range questions {
		if p.ID == q.Condition.QuestionID && !questionActive(p, questions, answers) {
			return false
		}
	}
	if parent.Status != "confirmed" {
		return true
	} // An unapproved parent never hides a mandatory branch.
	var v any
	_ = json.Unmarshal(parent.Value, &v)
	return fmt.Sprint(v) == q.Condition.Equals
}
func validAnswerValue(q formatQuestion, value json.RawMessage) bool {
	var v any
	if len(value) == 0 || json.Unmarshal(value, &v) != nil || v == nil {
		return false
	}
	switch q.Kind {
	case "boolean":
		_, ok := v.(bool)
		return ok
	case "number":
		_, ok := v.(float64)
		return ok
	case "choice":
		s, ok := v.(string)
		return ok && contains(q.Choices, s)
	case "quality":
		s, ok := v.(string)
		return ok && validOutcome(s)
	case "text", "evidence":
		s, ok := v.(string)
		return ok && strings.TrimSpace(s) != "" && len(s) <= 10000
	}
	return false
}

type scopeEvidence struct {
	Photos map[string]bool
	Audio  map[string]int
}

func readScopeEvidence(ctx context.Context, q querier, org, inspection, room string, property bool) (scopeEvidence, error) {
	raw, e := list(ctx, q, `SELECT m.id,m.kind,m.transcript,m.transcript_version AS version FROM media m JOIN batches b ON b.id=m.batch_id AND b.org_id=m.org_id WHERE m.org_id=$1 AND m.inspection_id=$2 AND b.status<>'excluded' AND ($4 OR b.room_id=$3)`, org, inspection, room, property)
	out := scopeEvidence{Photos: map[string]bool{}, Audio: map[string]int{}}
	if e != nil {
		return out, e
	}
	var rows []struct {
		ID, Kind, Transcript string
		Version              int
	}
	if e = json.Unmarshal(raw, &rows); e != nil {
		return out, e
	}
	for _, m := range rows {
		if m.Kind == "photo" {
			out.Photos[m.ID] = true
		} else if strings.TrimSpace(m.Transcript) != "" {
			out.Audio[m.ID] = m.Version
		}
	}
	return out, nil
}
func validateAnswerEvidence(q formatQuestion, a formatAnswer, ev scopeEvidence) error {
	if len(a.Reason) > 3000 || len(a.PhotoIDs) > 60 || len(a.AudioIDs) > 30 {
		return fail(422, "De toelichting of bronverwijzingen zijn te lang")
	}
	if a.Status == "unanswerable" {
		if strings.TrimSpace(a.Reason) == "" {
			return fail(422, "Licht toe waarom deze vraag niet te beantwoorden is")
		}
		return nil
	}
	if !validAnswerValue(q, a.Value) {
		return fail(422, "Vul een geldig antwoord in: "+q.Title)
	}
	seen := map[string]bool{}
	for _, p := range a.PhotoIDs {
		if !ev.Photos[p] || seen[p] {
			return fail(422, "Een bronfoto ontbreekt, is uitgesloten of hoort niet bij deze ruimte")
		}
		seen[p] = true
	}
	for _, p := range a.AudioIDs {
		v, ok := ev.Audio[p]
		if !ok || seen[p] || a.TranscriptVersions[p] != v {
			return fail(422, "Een audiobron ontbreekt of het transcript is gewijzigd")
		}
		seen[p] = true
	}
	if q.Evidence == "photo" || q.Evidence == "photo_statement" {
		min := q.MinPhotos
		if min < 1 {
			min = 1
		}
		if len(a.PhotoIDs) < min {
			return fail(422, "Voeg de vereiste foto's toe: "+q.Title)
		}
	}
	var writtenValue string
	if q.Kind == "text" || q.Kind == "evidence" {
		_ = json.Unmarshal(a.Value, &writtenValue)
	}
	hasStatement := strings.TrimSpace(a.Reason) != "" || strings.TrimSpace(writtenValue) != ""
	if q.Evidence == "statement" || q.Evidence == "photo_statement" {
		if len(a.AudioIDs) == 0 && !hasStatement {
			return fail(422, "Voeg een gesproken of geschreven waarneming toe: "+q.Title)
		}
	}
	if q.Evidence == "any" && len(a.PhotoIDs)+len(a.AudioIDs) == 0 && !hasStatement {
		return fail(422, "Voeg bewijs of een geschreven waarneming toe: "+q.Title)
	}
	if q.Kind == "quality" {
		var value string
		_ = json.Unmarshal(a.Value, &value)
		if value != a.Outcome {
			return fail(422, "Het antwoord en het normoordeel moeten overeenkomen")
		}
	}
	if q.RuleID != "" {
		if !validOutcome(a.Outcome) {
			return fail(422, "Beoordeel de gekoppelde norm: "+q.Title)
		}
		if a.Outcome == "not_assessable" || a.Outcome == "not_applicable" {
			return fail(422, "Markeer deze vraag expliciet als niet te beantwoorden met toelichting")
		}
		if len(a.PhotoIDs)+len(a.AudioIDs) == 0 && !hasStatement {
			return fail(422, "Onderbouw het normoordeel")
		}
	}
	return nil
}
func invalidateFormatScope(ctx context.Context, tx pgx.Tx, org, inspection, room, provider string) error {
	d, e := inspectionFormat(ctx, tx, org, inspection)
	if e != nil || d == nil {
		return e
	}
	categories := []string{}
	for _, s := range d.Scopes {
		if s.Property && len(s.Questions) > 0 {
			categories = append(categories, s.ID)
		}
	}
	raw, e := list(ctx, tx, `SELECT id FROM rooms WHERE org_id=$1 AND inspection_id=$2 AND (id=$3 OR category_id=ANY($4::uuid[]))`, org, inspection, room, categories)
	if e != nil {
		return e
	}
	var rooms []struct{ ID string }
	if e = json.Unmarshal(raw, &rooms); e != nil {
		return e
	}
	for _, r := range rooms {
		if _, e = tx.Exec(ctx, `UPDATE rooms SET generation=generation+1,approved_generation=NULL,reviewed_at=NULL WHERE id=$1 AND org_id=$2`, r.ID, org); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, `UPDATE format_answers SET status=CASE WHEN status='confirmed' THEN 'suggested' ELSE status END,reviewed_at=NULL,version=version+1 WHERE room_id=$1 AND org_id=$2`, r.ID, org); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, `INSERT INTO scope_jobs(room_id,org_id,inspection_id,provider) VALUES($1,$2,$3,$4) ON CONFLICT(room_id) DO UPDATE SET status='pending',provider=EXCLUDED.provider,attempts=0,run_token=NULL,lease_until=NULL,next_attempt_at=now()+interval '2 seconds',last_error=''`, r.ID, org, inspection, provider); e != nil {
			return e
		}
	}
	return nil
}
func auditFormat(ctx context.Context, tx pgx.Tx, org, inspection, room, user, action string, detail any) error {
	raw, _ := json.Marshal(detail)
	_, e := tx.Exec(ctx, `INSERT INTO format_review_events(id,org_id,inspection_id,room_id,user_id,action,detail) VALUES($1,$2,$3,$4,$5,$6,$7)`, id(), org, inspection, room, user, action, raw)
	return e
}
func (a *app) saveFormatAnswer(w http.ResponseWriter, r *http.Request) error {
	var in formatAnswer
	if e := readJSON(w, r, &in); e != nil {
		return e
	}
	if !validID(r.PathValue("answer")) {
		return fail(404, "Antwoord niet gevonden")
	}
	if in.Status != "confirmed" && in.Status != "unanswerable" {
		return fail(422, "Bevestig het antwoord of markeer niet te beantwoorden")
	}
	tx, u, e := a.edit(r)
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	org, inspection := r.PathValue("org"), r.PathValue("inspection")
	var room, qid string
	if e = tx.QueryRow(r.Context(), `SELECT room_id,question_id FROM format_answers WHERE id=$1 AND org_id=$2 AND inspection_id=$3`, r.PathValue("answer"), org, inspection).Scan(&room, &qid); e != nil {
		return e
	}
	s, _, _, e := readScope(r.Context(), tx, org, inspection, room)
	if e != nil {
		return e
	}
	var question formatQuestion
	for _, q := range s.Questions {
		if q.ID == qid {
			question = q
		}
	}
	ev, e := readScopeEvidence(r.Context(), tx, org, inspection, room, s.Property)
	if e != nil {
		return e
	}
	in.TranscriptVersions = map[string]int{}
	for _, mid := range in.AudioIDs {
		in.TranscriptVersions[mid] = ev.Audio[mid]
	}
	if in.Status == "unanswerable" {
		in.Value = json.RawMessage("null")
		in.Outcome = "not_assessable"
		in.PhotoIDs = []string{}
		in.AudioIDs = []string{}
		in.TranscriptVersions = map[string]int{}
	}
	if e = validateAnswerEvidence(question, in, ev); e != nil {
		return e
	}
	if in.PhotoIDs == nil {
		in.PhotoIDs = []string{}
	}
	if in.AudioIDs == nil {
		in.AudioIDs = []string{}
	}
	if e = validateScored(r.Context(), tx, org, inspection, question.RuleID, in.Outcome, in.Status, in.ScoreDetail); e != nil {
		return e
	}
	scoreJSON, _ := json.Marshal(in.ScoreDetail)
	versions, _ := json.Marshal(in.TranscriptVersions)
	tag, e := tx.Exec(r.Context(), `UPDATE format_answers SET value=$1,outcome=$2,reason=$3,status=$4,photo_ids=$5,audio_ids=$6,transcript_versions=$7,human=true,reviewed_by=$8,reviewed_at=now(),version=version+1,score_detail=$13 WHERE id=$9 AND org_id=$10 AND inspection_id=$11 AND version=$12`, in.Value, in.Outcome, strings.TrimSpace(in.Reason), in.Status, in.PhotoIDs, in.AudioIDs, versions, u.ID, r.PathValue("answer"), org, inspection, in.Version, scoreJSON)
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return fail(409, "Dit antwoord is gewijzigd. Herlaad en vergelijk de nieuwste versie.")
	}
	// Conditions use human-approved values. Changing a parent invalidates all dependent answers.
	dependencies := map[string]bool{qid: true}
	for _, q := range s.Questions {
		if q.Condition != nil && dependencies[q.Condition.QuestionID] {
			dependencies[q.ID] = true
			status, reason := "missing", ""
			if in.Status == "unanswerable" {
				status = "unanswerable"
				reason = "Vervolgvraag niet te beantwoorden: " + in.Reason
			}
			if _, e = tx.Exec(r.Context(), `UPDATE format_answers SET status=$1,value='null',outcome='',reason=$2,photo_ids='{}',audio_ids='{}',transcript_versions='{}',human=true,reviewed_at=NULL,version=version+1 WHERE room_id=$3 AND org_id=$4 AND question_id=$5`, status, reason, room, org, q.ID); e != nil {
				return e
			}
		}
	}
	if _, e = tx.Exec(r.Context(), `UPDATE rooms SET approved_generation=NULL,reviewed_at=NULL WHERE id=$1 AND org_id=$2`, room, org); e != nil {
		return e
	}
	if question.Kind == "boolean" || question.Kind == "choice" {
		if _, e = tx.Exec(r.Context(), `UPDATE scope_jobs SET status='pending',run_token=NULL,lease_until=NULL,attempts=0,next_attempt_at=now() WHERE room_id=$1 AND org_id=$2 AND status<>'failed'`, room, org); e != nil {
			return e
		}
	}
	if e = auditFormat(r.Context(), tx, org, inspection, room, u.ID, "answer", in); e != nil {
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	send(w, 200, map[string]int{"version": in.Version + 1})
	return nil
}
func scopeProcessingReady(ctx context.Context, q querier, org, inspection, room string, property bool) error {
	var ready bool
	e := q.QueryRow(ctx, `SELECT NOT EXISTS(SELECT 1 FROM batches b WHERE b.org_id=$1 AND b.inspection_id=$2 AND b.status<>'excluded' AND ($4 OR b.room_id=$3) AND cardinality(b.expected_media)<>(SELECT count(*) FROM media m WHERE m.batch_id=b.id AND m.org_id=b.org_id)) AND NOT EXISTS(SELECT 1 FROM transcription_jobs t JOIN media m ON m.id=t.media_id AND m.org_id=t.org_id JOIN batches b ON b.id=m.batch_id AND b.org_id=m.org_id WHERE t.org_id=$1 AND t.inspection_id=$2 AND ($4 OR b.room_id=$3) AND b.status<>'excluded' AND t.status NOT IN ('done','skipped')) AND NOT EXISTS(SELECT 1 FROM scope_jobs WHERE room_id=$3 AND org_id=$1 AND status<>'done')`, org, inspection, room, property).Scan(&ready)
	if e != nil {
		return e
	}
	if !ready {
		return fail(422, "Wacht op upload, transcriptie en analyse of kies handmatig verder")
	}
	return nil
}
func (a *app) approveFormatScope(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Generation          int            `json:"generation"`
		Versions            map[string]int `json:"versions"`
		ObservationVersions map[string]int `json:"observationVersions"`
		Exception           string         `json:"exception"`
	}
	if e := readJSON(w, r, &in); e != nil {
		return e
	}
	tx, u, e := a.edit(r)
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	org, inspection, room := r.PathValue("org"), r.PathValue("inspection"), r.PathValue("room")
	s, _, generation, e := readScope(r.Context(), tx, org, inspection, room)
	if e != nil {
		return e
	}
	if generation != in.Generation {
		return fail(409, "De opnamen zijn gewijzigd. Controleer de nieuwste samenvatting")
	}
	if len(in.Exception) > 3000 {
		return fail(422, "Toelichting te lang")
	}
	if strings.TrimSpace(in.Exception) == "" {
		if e = scopeProcessingReady(r.Context(), tx, org, inspection, room, s.Property); e != nil {
			return e
		}
	}
	answers, e := readAnswers(r.Context(), tx, org, inspection, room)
	if e != nil {
		return e
	}
	byQuestion := map[string]formatAnswer{}
	for _, v := range answers {
		if in.Versions[v.ID] != v.Version {
			return fail(409, "Een antwoord is gewijzigd. Controleer de nieuwste samenvatting")
		}
		byQuestion[v.QuestionID] = v
	}
	ev, e := readScopeEvidence(r.Context(), tx, org, inspection, room, s.Property)
	if e != nil {
		return e
	}
	// Approve parents first so false branches become inactive in this same explicit room review.
	for _, q := range s.Questions {
		v := byQuestion[q.ID]
		active := questionActive(q, s.Questions, byQuestion)
		if in.Exception != "" {
			v.Status = "unanswerable"
			v.Value = json.RawMessage("null")
			v.Outcome = "not_assessable"
			v.Reason = in.Exception
			v.PhotoIDs = []string{}
			v.AudioIDs = []string{}
			v.TranscriptVersions = map[string]int{}
		}
		if !active && in.Exception == "" {
			continue
		}
		if v.Status == "missing" {
			if q.Required {
				return fail(422, "Nog niet beantwoord: "+q.Title)
			}
			continue
		}
		if e = validateScored(r.Context(), tx, org, inspection, q.RuleID, v.Outcome, v.Status, v.ScoreDetail); e != nil {
			return e
		}
		if e = validateAnswerEvidence(q, v, ev); e != nil {
			if q.Required || v.Status != "missing" {
				return e
			}
			continue
		}
		if v.Status != "unanswerable" {
			v.Status = "confirmed"
		}
		byQuestion[q.ID] = v
		versions, _ := json.Marshal(v.TranscriptVersions)
		if v.PhotoIDs == nil {
			v.PhotoIDs = []string{}
		}
		if v.AudioIDs == nil {
			v.AudioIDs = []string{}
		}
		if _, e = tx.Exec(r.Context(), `UPDATE format_answers SET status=$1,value=$2,outcome=$3,reason=$4,photo_ids=$5,audio_ids=$6,transcript_versions=$7,reviewed_by=$8,reviewed_at=now(),human=human OR $9,version=version+1 WHERE id=$10 AND org_id=$11`, v.Status, v.Value, v.Outcome, v.Reason, v.PhotoIDs, v.AudioIDs, versions, u.ID, in.Exception != "", v.ID, org); e != nil {
			return e
		}
	}
	if in.Exception != "" {
		if e = invalidateFormatScope(r.Context(), tx, org, inspection, room, a.imageProvider); e != nil {
			return e
		}
		if _, e = tx.Exec(r.Context(), `UPDATE format_answers SET status='unanswerable',reason=$1,human=true,reviewed_by=$2,reviewed_at=now() WHERE room_id=$3 AND org_id=$4`, in.Exception, u.ID, room, org); e != nil {
			return e
		}
		// Cancelling this scope's job prevents a late result from replacing the explicit room exception.
		if _, e = tx.Exec(r.Context(), `UPDATE scope_jobs SET status='done',run_token=NULL,lease_until=NULL,last_error='' WHERE room_id=$1 AND org_id=$2`, room, org); e != nil {
			return e
		}
	}
	rawFindings, err := list(r.Context(), tx, `SELECT o.id,o.title,o.description,o.label,o.status,o.version FROM observations o JOIN batches b ON b.id=o.batch_id AND b.org_id=o.org_id WHERE b.room_id=$1 AND b.org_id=$2 AND b.status<>'excluded'`, room, org)
	if err != nil {
		return err
	}
	var findings []struct {
		ID, Title, Description, Label, Status string
		Version                               int
	}
	if e = json.Unmarshal(rawFindings, &findings); e != nil {
		return e
	}
	for _, finding := range findings {
		if in.ObservationVersions[finding.ID] != finding.Version {
			return fail(409, "Een bevinding is gewijzigd. Controleer de nieuwste samenvatting")
		}
		if finding.Status == "draft" && in.Exception == "" {
			return fail(422, "Keur eerst elke bevinding goed of wijs deze af")
		}
	}

	if _, e = tx.Exec(r.Context(), `UPDATE rooms SET approved_generation=generation,reviewed_by=$1,reviewed_at=now() WHERE id=$2 AND org_id=$3`, u.ID, room, org); e != nil {
		return e
	}
	// A room exemption excludes its captures, rather than allowing incomplete or unreviewed media into the report.
	if in.Exception != "" {
		if _, e = tx.Exec(r.Context(), `UPDATE batches SET status='excluded',version=version+1 WHERE room_id=$1 AND org_id=$2`, room, org); e != nil {
			return e
		}
	} else {
		if _, e = tx.Exec(r.Context(), `UPDATE batches SET status='reviewed',version=version+1 WHERE room_id=$1 AND org_id=$2 AND status<>'excluded'`, room, org); e != nil {
			return e
		}
	}
	if e = auditFormat(r.Context(), tx, org, inspection, room, u.ID, "approve_scope", in); e != nil {
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	send(w, 200, map[string]bool{"ok": true})
	return nil
}
func (a *app) formatScopeAction(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Action string `json:"action"`
		Reason string `json:"reason"`
	}
	if e := readJSON(w, r, &in); e != nil {
		return e
	}
	if len(in.Reason) > 3000 {
		return fail(422, "Toelichting te lang")
	}
	if in.Action != "retry" && in.Action != "skip" {
		return fail(422, "Ongeldige actie")
	}
	if in.Action == "skip" && strings.TrimSpace(in.Reason) == "" {
		return fail(422, "Licht toe waarom je handmatig verdergaat")
	}
	tx, u, e := a.edit(r)
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	org, inspection, room := r.PathValue("org"), r.PathValue("inspection"), r.PathValue("room")
	if _, _, _, e = readScope(r.Context(), tx, org, inspection, room); e != nil {
		return e
	}
	status := "pending"
	if in.Action == "skip" {
		status = "done"
	}
	if _, e = tx.Exec(r.Context(), `UPDATE scope_jobs SET status=$1,run_token=NULL,lease_until=NULL,attempts=0,next_attempt_at=now(),last_error='' WHERE room_id=$2 AND org_id=$3`, status, room, org); e != nil {
		return e
	}
	if _, e = tx.Exec(r.Context(), `UPDATE rooms SET approved_generation=NULL WHERE id=$1 AND org_id=$2`, room, org); e != nil {
		return e
	}
	if e = auditFormat(r.Context(), tx, org, inspection, room, u.ID, "analysis_"+in.Action, in); e != nil {
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	send(w, 200, map[string]bool{"ok": true})
	return nil
}
func validateFormatCompletion(ctx context.Context, q querier, org, inspection string) error {
	d, e := inspectionFormat(ctx, q, org, inspection)
	if e != nil || d == nil {
		return e
	}
	raw, e := list(ctx, q, `SELECT id,name,generation,approved_generation AS approved FROM rooms WHERE org_id=$1 AND inspection_id=$2`, org, inspection)
	if e != nil {
		return e
	}
	var rooms []struct {
		ID, Name   string
		Generation int
		Approved   *int
	}
	if e = json.Unmarshal(raw, &rooms); e != nil {
		return e
	}
	for _, room := range rooms {
		if room.Approved == nil || *room.Approved != room.Generation {
			return fail(422, "Controleer of markeer niet te beantwoorden: "+room.Name)
		}
		s, _, _, err := readScope(ctx, q, org, inspection, room.ID)
		if err != nil {
			return err
		}
		answers, err := readAnswers(ctx, q, org, inspection, room.ID)
		if err != nil {
			return err
		}
		byQ := map[string]formatAnswer{}
		for _, v := range answers {
			byQ[v.QuestionID] = v
		}
		ev, err := readScopeEvidence(ctx, q, org, inspection, room.ID, s.Property)
		if err != nil {
			return err
		}
		for _, question := range s.Questions {
			if !question.Required || !questionActive(question, s.Questions, byQ) {
				continue
			}
			v := byQ[question.ID]
			if v.Status != "confirmed" && v.Status != "unanswerable" {
				return fail(422, "Bevestig: "+question.Title)
			}
			if err = validateScored(ctx, q, org, inspection, question.RuleID, v.Outcome, v.Status, v.ScoreDetail); err != nil {
				return err
			}
			if err = validateAnswerEvidence(question, v, ev); err != nil {
				return err
			}
		}
	}
	var safe bool
	if e = q.QueryRow(ctx, `SELECT NOT EXISTS(SELECT 1 FROM batches b WHERE b.org_id=$1 AND b.inspection_id=$2 AND (b.status='pending' OR (b.status='reviewed' AND cardinality(b.expected_media)<>(SELECT count(*) FROM media m WHERE m.batch_id=b.id AND m.org_id=b.org_id)))) AND NOT EXISTS(SELECT 1 FROM observations o JOIN batches b ON b.id=o.batch_id AND b.org_id=o.org_id WHERE o.org_id=$1 AND o.inspection_id=$2 AND b.status<>'excluded' AND o.status='draft') AND NOT EXISTS(SELECT 1 FROM scope_jobs j JOIN rooms r ON r.id=j.room_id AND r.org_id=j.org_id WHERE j.org_id=$1 AND j.inspection_id=$2 AND j.status<>'done' AND EXISTS(SELECT 1 FROM batches b WHERE b.room_id=r.id AND b.org_id=r.org_id AND b.status<>'excluded')) AND NOT EXISTS(SELECT 1 FROM transcription_jobs t JOIN media m ON m.id=t.media_id AND m.org_id=t.org_id JOIN batches b ON b.id=m.batch_id AND b.org_id=m.org_id WHERE t.org_id=$1 AND t.inspection_id=$2 AND b.status<>'excluded' AND t.status NOT IN ('done','skipped'))`, org, inspection).Scan(&safe); e != nil {
		return e
	}
	if !safe {
		return fail(422, "Er zijn nog opnamen, transcripties of bevindingen te beoordelen")
	}
	return nil
}
