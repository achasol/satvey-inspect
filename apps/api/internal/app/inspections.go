package app

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type querier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func list(ctx context.Context, q querier, sql string, args ...any) (json.RawMessage, error) {
	var out json.RawMessage
	e := q.QueryRow(ctx, "SELECT COALESCE(jsonb_agg(to_jsonb(q)),'[]') FROM ("+sql+") q", args...).Scan(&out)
	return out, e
}
func (a *app) edit(r *http.Request) (pgx.Tx, principal, error) {
	u, _, e := a.access(r, true)
	if e != nil {
		return nil, u, e
	}
	if !validID(r.PathValue("inspection")) {
		return nil, u, fail(404, "Inspectie niet gevonden")
	}
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		return nil, u, e
	}
	var status string
	var archived bool
	e = tx.QueryRow(r.Context(), "SELECT status,archived_at IS NOT NULL FROM inspections WHERE id=$1 AND org_id=$2 FOR UPDATE", r.PathValue("inspection"), r.PathValue("org")).Scan(&status, &archived)
	if e != nil {
		tx.Rollback(r.Context())
		return nil, u, e
	}
	if archived || status != "draft" {
		tx.Rollback(r.Context())
		return nil, u, fail(409, "Open Bewerken bij het rapport om een nieuwe versie binnen dit dossier te maken")
	}
	if e = setActor(r.Context(), tx, u.ID); e != nil {
		tx.Rollback(r.Context())
		return nil, u, e
	}
	return tx, u, nil
}

const inspectionSelect = `SELECT i.id,(SELECT name FROM users WHERE id=COALESCE(i.assigned_to,i.created_by)) AS "inspectorName",i.kind,i.status,i.revision,i.latest_report_id AS "latestReportId",i.retention_hold AS "retentionHold",i.retention_hold_reason AS "retentionHoldReason",i.assigned_to AS "assignedTo",i.reviewer_id AS "reviewerId",i.review_status AS "reviewStatus",i.review_note AS "reviewNote",i.priority,i.visit_outcome AS "visitOutcome",i.visited_at AS "visitedAt",i.external_reference AS "externalReference",i.mutation_case_id AS "mutationCaseId",i.predecessor_id AS "predecessorId",i.created_by AS "createdBy",i.archived_at AS "archivedAt",i.archive_reason AS "archiveReason",i.corrects_inspection_id AS "correctsInspectionId",i.correction_reason AS "correctionReason",i.superseded_by AS "supersededBy",i.scheduled_at AS "scheduledAt",i.created_at AS "createdAt",p.id AS "propertyId",i.norm_version_id AS "normVersionId",i.format_version_id AS "formatVersionId",COALESCE(i.property_snapshot->>'address',p.address) AS address,COALESCE(i.property_snapshot->>'postcode',p.postcode) AS postcode,COALESCE(i.property_snapshot->>'city',p.city) AS city,i.property_snapshot AS "propertySnapshot",i.property_context_version AS "propertyContextVersion",(i.status='draft' AND p.revision<>COALESCE((i.property_snapshot->>'revision')::integer,0)) AS "propertyChanged" FROM inspections i JOIN properties p ON p.id=i.property_id AND p.org_id=i.org_id`

func (a *app) inspections(w http.ResponseWriter, r *http.Request) error {
	u, _, e := a.access(r, false)
	if e != nil {
		return e
	}
	limit, offset := 50, 0
	if value := r.URL.Query().Get("limit"); value != "" {
		n, e := strconv.Atoi(value)
		if e != nil || n < 1 || n > 100 {
			return fail(400, "Ongeldige paginagrootte")
		}
		limit = n
	}
	if value := r.URL.Query().Get("offset"); value != "" {
		n, e := strconv.Atoi(value)
		if e != nil || n < 0 || n > 1000000 {
			return fail(400, "Ongeldige pagina")
		}
		offset = n
	}
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(query) > 200 {
		return fail(400, "Zoekopdracht te lang")
	}
	view := r.URL.Query().Get("view")
	if !contains([]string{"", "all", "mine", "today", "overdue", "unassigned", "review", "delivery", "archived"}, view) {
		return fail(400, "Onbekende weergave")
	}
	archived := view == "archived" || r.URL.Query().Get("archived") == "true"
	filter := ` WHERE i.org_id=$1 AND (i.archived_at IS NOT NULL)=$5
 AND ($2='' OR strpos(regexp_replace(lower(COALESCE(i.property_snapshot->>'address',p.address)||' '||COALESCE(i.property_snapshot->>'city',p.city)||' '||COALESCE(i.property_snapshot->>'postcode',p.postcode)||' '||p.object_number||' '||COALESCE(p.source_object_id,'')||' '||i.external_reference),'[[:space:]]','','g'),regexp_replace(lower($2),'[[:space:]]','','g'))>0)
 AND ($7 IN ('','all','archived') OR ($7='mine' AND i.assigned_to=$6::uuid) OR ($7='today' AND (i.scheduled_at AT TIME ZONE 'Europe/Amsterdam')::date=(now() AT TIME ZONE 'Europe/Amsterdam')::date)
 OR ($7='overdue' AND i.status='draft' AND i.visit_outcome<>'cancelled' AND i.scheduled_at<now()) OR ($7='unassigned' AND i.assigned_to IS NULL AND i.status='draft')
 OR ($7='review' AND i.review_status<>'approved') OR ($7='delivery' AND EXISTS(SELECT 1 FROM internal_sync_jobs s WHERE s.inspection_id=i.id AND s.org_id=i.org_id AND s.status IN ('blocked','retrying'))) OR ($7='delivery' AND EXISTS(SELECT 1 FROM handover_deliveries d WHERE d.inspection_id=i.id AND d.org_id=i.org_id AND d.status IN ('blocked','retrying'))) OR ($7='delivery' AND EXISTS(SELECT 1 FROM report_deliveries rd JOIN mail_jobs mj ON mj.id=rd.mail_job_id WHERE rd.org_id=i.org_id AND rd.inspection_id=i.id AND mj.status='failed')))`
	out, e := list(r.Context(), a.db, inspectionSelect+filter+` ORDER BY (i.status='draft') DESC,CASE i.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,i.scheduled_at NULLS LAST,i.created_at DESC,i.id LIMIT $3 OFFSET $4`, r.PathValue("org"), query, limit, offset, archived, u.ID, view)
	if e != nil {
		return e
	}
	if strings.HasSuffix(r.URL.Path, "/inspection-page") {
		var total, open int
		if e = a.db.QueryRow(r.Context(), `SELECT count(*),count(*) FILTER(WHERE i.status='draft') FROM inspections i JOIN properties p ON p.id=i.property_id AND p.org_id=i.org_id`+filter+` AND $3::integer>0 AND $4::integer>=0`, r.PathValue("org"), query, limit, offset, archived, u.ID, view).Scan(&total, &open); e != nil {
			return e
		}
		send(w, 200, map[string]any{"items": out, "total": total, "open": open})
	} else {
		send(w, 200, out)
	}
	return nil
}
func (a *app) createInspection(w http.ResponseWriter, r *http.Request) error {
	u, _, e := a.access(r, true)
	if e != nil {
		return e
	}
	var in struct {
		ID              string     `json:"id"`
		PropertyID      string     `json:"propertyId"`
		Kind            string     `json:"kind"`
		ScheduledAt     *time.Time `json:"scheduledAt"`
		NormVersionID   *string    `json:"normVersionId"`
		FormatVersionID *string    `json:"formatVersionId"`
	}
	if e = readJSON(w, r, &in); e != nil {
		return e
	}
	if !validID(in.ID) || !validID(in.PropertyID) || (in.Kind != "pre" && in.Kind != "final") {
		return fail(400, "Controleer de inspectiegegevens")
	}
	org := r.PathValue("org")
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	var exists bool
	if _, e = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, in.PropertyID); e != nil {
		return e
	}
	if e = tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM properties WHERE id=$1 AND org_id=$2 AND link_state<>'merged')", in.PropertyID, org).Scan(&exists); e != nil {
		return e
	}
	if !exists {
		return fail(404, "Woning niet gevonden")
	}
	var format *formatDocument
	if in.FormatVersionID == nil || !validID(*in.FormatVersionID) {
		return fail(422, "Kies een gepubliceerd inspectieformat")
	}
	format, e = readFormat(r.Context(), tx, org, *in.FormatVersionID)
	if e != nil {
		return e
	}
	if format.Status != "published" || format.Kind != in.Kind {
		return fail(422, "Kies een gepubliceerd format voor dit inspectietype")
	}
	in.NormVersionID = format.NormVersionID
	if in.NormVersionID != nil {
		if !validID(*in.NormVersionID) {
			return fail(400, "Ongeldig normenkader")
		}
		var published bool
		if e = tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM norm_versions WHERE id=$1 AND org_id=$2 AND status='published')", *in.NormVersionID, org).Scan(&published); e != nil {
			return e
		}
		if !published {
			return fail(400, "Kies een gepubliceerd kader uit deze organisatie")
		}
	}
	elements, e := elementContext(r.Context(), tx, org)
	if e != nil {
		return e
	}
	tag, e := tx.Exec(r.Context(), "INSERT INTO inspections(id,org_id,property_id,kind,scheduled_at,created_by,norm_version_id,element_context,format_version_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING", in.ID, org, in.PropertyID, in.Kind, in.ScheduledAt, u.ID, in.NormVersionID, elements, in.FormatVersionID)
	if e != nil {
		return e
	}
	if tag.RowsAffected() == 0 {
		var matches bool
		if e = tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM inspections WHERE id=$1 AND org_id=$2 AND property_id=$3 AND kind=$4 AND scheduled_at IS NOT DISTINCT FROM $5::timestamptz AND norm_version_id IS NOT DISTINCT FROM $6::uuid AND format_version_id=$7::uuid)", in.ID, org, in.PropertyID, in.Kind, in.ScheduledAt, in.NormVersionID, in.FormatVersionID).Scan(&matches); e != nil {
			return e
		}
		if !matches {
			return fail(409, "Inspectie-ID al in gebruik")
		}
	} else {
		for _, category := range format.Scopes {
			if category.Required || category.Property {
				if e = instantiateScope(r.Context(), tx, org, in.ID, id(), category.Name, category); e != nil {
					return e
				}
			}
		}

	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	send(w, 201, map[string]string{"id": in.ID})
	return nil
}
func detail(ctx context.Context, q querier, org, inspection string) (map[string]any, error) {
	var info json.RawMessage
	e := q.QueryRow(ctx, "SELECT to_jsonb(q) FROM ("+inspectionSelect+" WHERE i.id=$1 AND i.org_id=$2) q", inspection, org).Scan(&info)
	if e != nil {
		return nil, e
	}
	out := map[string]any{"inspection": info}
	queries := map[string]string{
		"rooms":        `SELECT id,name,category_id AS "categoryId",generation,approved_generation AS "approvedGeneration" FROM rooms WHERE inspection_id=$1 AND org_id=$2 ORDER BY category_id IS NOT NULL DESC,name`,
		"batches":      `SELECT id,room_id AS "roomId",status,version,created_at AS "createdAt" FROM batches WHERE inspection_id=$1 AND org_id=$2 ORDER BY created_at`,
		"media":        `SELECT id,batch_id AS "batchId",kind,name,mime,size,duration,content_deleted_at AS "contentDeletedAt",annotations,annotation_version AS "annotationVersion",transcript,transcript_version AS "transcriptVersion" FROM media WHERE inspection_id=$1 AND org_id=$2 ORDER BY created_at`,
		"observations": `SELECT id,batch_id AS "batchId",title,description,label,status,source,version,photo_ids AS "photoIds",audio_ids AS "audioIds" FROM observations WHERE inspection_id=$1 AND org_id=$2 ORDER BY id`,
		"jobs":         `SELECT batch_id AS "batchId",status,provider,last_error AS "error" FROM processing_jobs WHERE inspection_id=$1 AND org_id=$2`,
	}
	for key, sql := range queries {
		raw, e := list(ctx, q, sql, inspection, org)
		if e != nil {
			return nil, e
		}
		out[key] = raw
	}
	norms, e := readInspectionNorms(ctx, q, org, inspection)
	if e != nil {
		return nil, e
	}
	out["norms"] = norms
	format, e := inspectionFormat(ctx, q, org, inspection)
	if e != nil {
		return nil, e
	}
	out["format"] = format
	answers, e := readAnswers(ctx, q, org, inspection, "")
	if e != nil {
		return nil, e
	}
	out["answers"] = answers
	for key, sql := range map[string]string{
		"scopeJobs":         `SELECT room_id AS "roomId",status,provider,last_error AS error FROM scope_jobs WHERE inspection_id=$1 AND org_id=$2`,
		"transcriptionJobs": `SELECT media_id AS "mediaId",status,last_error AS error FROM transcription_jobs WHERE inspection_id=$1 AND org_id=$2`,
	} {
		raw, err := list(ctx, q, sql, inspection, org)
		if err != nil {
			return nil, err
		}
		out[key] = raw
	}

	assessments, e := list(ctx, q, `SELECT id,batch_id AS "batchId",rule_id AS "ruleId",norm_version_id AS "normVersionId",outcome,reason,photo_ids AS "photoIds",audio_ids AS "audioIds",source,reviewed_outcome AS "reviewedOutcome",review_note AS "reviewNote",previous_reviewed_outcome AS "previousReviewedOutcome",previous_review_note AS "previousReviewNote",score_detail AS "scoreDetail",proposed_score AS "proposedScore",stale,version FROM norm_assessments WHERE inspection_id=$1 AND org_id=$2 ORDER BY rule_id`, inspection, org)
	if e != nil {
		return nil, e
	}
	agreements, err := list(ctx, q, `SELECT id,description,responsibility,due_date::text AS "dueDate",status,note,photo_ids AS "photoIds",version,source_agreement_id AS "sourceAgreementId" FROM inspection_agreements WHERE org_id=$1 AND inspection_id=$2 ORDER BY due_date NULLS LAST,id`, org, inspection)
	if err != nil {
		return nil, err
	}
	out["agreements"] = agreements
	out["assessments"] = assessments
	return out, nil
}
func (a *app) inspection(w http.ResponseWriter, r *http.Request) error {
	if _, _, e := a.access(r, false); e != nil {
		return e
	}
	if !validID(r.PathValue("inspection")) {
		return fail(404, "Inspectie niet gevonden")
	}
	tx, e := a.db.BeginTx(r.Context(), pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	out, e := detail(r.Context(), tx, r.PathValue("org"), r.PathValue("inspection"))
	if e != nil {
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	send(w, 200, out)
	return nil
}
func (a *app) createRoom(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		ID         string `json:"id"`
		Name       string `json:"name"`
		CategoryID string `json:"categoryId"`
	}
	if e := readJSON(w, r, &in); e != nil {
		return e
	}
	if !validID(in.ID) || strings.TrimSpace(in.Name) == "" || len(in.Name) > 100 {
		return fail(400, "Vul een ruimtenaam in")
	}
	tx, _, e := a.edit(r)
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	format, e := inspectionFormat(r.Context(), tx, r.PathValue("org"), r.PathValue("inspection"))
	if e != nil {
		return e
	}
	if format != nil {
		var category *formatScope
		for _, s := range format.Scopes {
			if s.ID == in.CategoryID {
				copy := s
				category = &copy
			}
		}
		if category == nil || category.Property {
			return fail(422, "Kies een ruimtecategorie uit het format")
		}
		// The inspector records the actual room inventory, including additional
		// kitchens or toilets. Each instance retains the pinned category questions.
		if e = instantiateScope(r.Context(), tx, r.PathValue("org"), r.PathValue("inspection"), in.ID, strings.TrimSpace(in.Name), *category); e != nil {
			return e
		}
		if e = tx.Commit(r.Context()); e != nil {
			return e
		}
		send(w, 201, in)
		return nil
	}
	tag, e := tx.Exec(r.Context(), "INSERT INTO rooms(id,org_id,inspection_id,name) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET name=rooms.name WHERE rooms.org_id=EXCLUDED.org_id AND rooms.inspection_id=EXCLUDED.inspection_id AND rooms.name=EXCLUDED.name", in.ID, r.PathValue("org"), r.PathValue("inspection"), strings.TrimSpace(in.Name))
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return fail(409, "Ruimte-ID al in gebruik")
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	send(w, 201, in)
	return nil
}
func (a *app) createBatch(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		ID               string   `json:"id"`
		RoomID           string   `json:"roomId"`
		MediaIDs         []string `json:"mediaIds"`
		AnalysisProvider string   `json:"analysisProvider"`
	}
	if e := readJSON(w, r, &in); e != nil {
		return e
	}
	if !validID(in.ID) || !validID(in.RoomID) || len(in.MediaIDs) == 0 || len(in.MediaIDs) > 30 {
		return fail(400, "Voeg 1 tot 30 bestanden toe")
	}
	provider := a.imageProvider
	if provider == "" {
		provider = "mock"
	}
	if in.AnalysisProvider != "" {
		if in.AnalysisProvider != "mock" || env("ALLOW_MOCK_ANALYSIS", "false") != "true" {
			return fail(400, "Analyseprovider kan niet worden gekozen")
		}
		provider = "mock"
	}
	seen := map[string]bool{}
	for _, mid := range in.MediaIDs {
		if !validID(mid) || seen[mid] {
			return fail(400, "Ongeldige media-ID")
		}
		seen[mid] = true
	}
	tx, _, e := a.edit(r)
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	var exists bool
	if e = tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM rooms WHERE id=$1 AND org_id=$2 AND inspection_id=$3)", in.RoomID, r.PathValue("org"), r.PathValue("inspection")).Scan(&exists); e != nil {
		return e
	}
	if !exists {
		return fail(404, "Ruimte niet gevonden")
	}
	tag, e := tx.Exec(r.Context(), "INSERT INTO batches(id,org_id,inspection_id,room_id,expected_media,analysis_provider) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING", in.ID, r.PathValue("org"), r.PathValue("inspection"), in.RoomID, in.MediaIDs, provider)
	if e != nil {
		return e
	}
	if tag.RowsAffected() == 0 {
		var matches bool
		if e = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM batches WHERE id=$1 AND org_id=$2 AND inspection_id=$3 AND room_id=$4 AND expected_media=$5)`, in.ID, r.PathValue("org"), r.PathValue("inspection"), in.RoomID, in.MediaIDs).Scan(&matches); e != nil {
			return e
		}
		if !matches {
			return fail(409, "Opname-ID al in gebruik")
		}
	} else {
		format, err := inspectionFormat(r.Context(), tx, r.PathValue("org"), r.PathValue("inspection"))
		if err != nil {
			return err
		}
		if format != nil {
			if e = invalidateFormatScope(r.Context(), tx, r.PathValue("org"), r.PathValue("inspection"), in.RoomID, provider); e != nil {
				return e
			}
		} else if e = seedAssessments(r.Context(), tx, r.PathValue("org"), r.PathValue("inspection"), in.ID); e != nil {
			return e
		}
	}

	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	send(w, 201, map[string]string{"id": in.ID})
	return nil
}
func (a *app) updateBatch(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Status  string `json:"status"`
		Version int    `json:"version"`
	}
	if e := readJSON(w, r, &in); e != nil {
		return e
	}
	if !validID(r.PathValue("batch")) || (in.Status != "pending" && in.Status != "reviewed" && in.Status != "excluded") {
		return fail(400, "Ongeldige status")
	}
	tx, _, e := a.edit(r)
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	org, inspection, batch := r.PathValue("org"), r.PathValue("inspection"), r.PathValue("batch")
	format, err := inspectionFormat(r.Context(), tx, org, inspection)
	if err != nil {
		return err
	}
	if in.Status == "reviewed" {
		var ready bool
		e = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM batches b WHERE id=$1 AND org_id=$2 AND cardinality(expected_media)=(SELECT count(*) FROM media WHERE batch_id=b.id AND org_id=b.org_id)) AND NOT EXISTS(SELECT 1 FROM observations WHERE batch_id=$1 AND org_id=$2 AND status='draft') AND NOT EXISTS(SELECT 1 FROM processing_jobs WHERE batch_id=$1 AND org_id=$2 AND status<>'done') AND NOT EXISTS(SELECT 1 FROM scope_jobs j JOIN batches b ON b.room_id=j.room_id AND b.org_id=j.org_id WHERE b.id=$1 AND b.org_id=$2 AND j.status<>'done') AND NOT EXISTS(SELECT 1 FROM transcription_jobs j JOIN media m ON m.id=j.media_id AND m.org_id=j.org_id WHERE m.batch_id=$1 AND m.org_id=$2 AND j.status NOT IN ('done','skipped'))`, batch, org).Scan(&ready)
		if e != nil {
			return e
		}
		if !ready {
			return fail(422, "Beoordeel eerst alle voorstellen en wacht tot de verwerking klaar is")
		}
	}
	tag, e := tx.Exec(r.Context(), "UPDATE batches SET status=$1,version=version+1 WHERE id=$2 AND org_id=$3 AND inspection_id=$4 AND version=$5", in.Status, batch, org, inspection, in.Version)
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return fail(409, "De opname is gewijzigd. Herlaad en beoordeel de nieuwste versie.")
	}
	if format != nil && in.Status != "reviewed" {
		var room, provider string
		if e = tx.QueryRow(r.Context(), `SELECT room_id,analysis_provider FROM batches WHERE id=$1 AND org_id=$2`, batch, org).Scan(&room, &provider); e != nil {
			return e
		}
		if e = invalidateFormatScope(r.Context(), tx, org, inspection, room, provider); e != nil {
			return e
		}
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	send(w, 200, map[string]int{"version": in.Version + 1})
	return nil
}

type observationInput struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Label       string `json:"label"`
	Status      string `json:"status"`
	Version     int    `json:"version"`
}

func validateObservation(in observationInput) error {
	if in.Status == "approved" && strings.HasPrefix(in.Description, "Voorbeeldvoorstel bij") {
		return fail(422, "Vervang de voorbeeldtekst door je eigen waarneming")
	}
	if len(in.Title) > 160 || len(in.Description) > 10000 || len(in.Label) > 100 || (in.Status != "draft" && in.Status != "approved" && in.Status != "rejected") {
		return fail(400, "Controleer de bevinding")
	}
	if in.Status == "approved" && (strings.TrimSpace(in.Title) == "" || strings.TrimSpace(in.Description) == "") {
		return fail(422, "Vul een korte titel en beschrijving in")
	}
	return nil
}
func (a *app) createObservation(w http.ResponseWriter, r *http.Request) error {
	var in observationInput
	if e := readJSON(w, r, &in); e != nil {
		return e
	}
	if !validID(in.ID) || !validID(r.PathValue("batch")) {
		return fail(400, "Ongeldige bevinding")
	}
	if in.Status == "" {
		in.Status = "draft"
	}
	if e := validateObservation(in); e != nil {
		return e
	}
	tx, _, e := a.edit(r)
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	var exists bool
	if e = tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM batches WHERE id=$1 AND org_id=$2 AND inspection_id=$3 AND status<>'excluded')", r.PathValue("batch"), r.PathValue("org"), r.PathValue("inspection")).Scan(&exists); e != nil {
		return e
	}
	if !exists {
		return fail(404, "Opname niet gevonden of uitgesloten")
	}
	tag, e := tx.Exec(r.Context(), "INSERT INTO observations(id,org_id,inspection_id,batch_id,title,description,label,status,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'manual') ON CONFLICT(id) DO NOTHING", in.ID, r.PathValue("org"), r.PathValue("inspection"), r.PathValue("batch"), in.Title, in.Description, in.Label, in.Status)
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return fail(409, "Bevinding-ID bestaat al")
	}
	if _, e = tx.Exec(r.Context(), "UPDATE batches SET status='pending',version=version+1 WHERE id=$1 AND org_id=$2", r.PathValue("batch"), r.PathValue("org")); e != nil {
		return e
	}
	if _, e = tx.Exec(r.Context(), `UPDATE rooms SET approved_generation=NULL,reviewed_at=NULL WHERE org_id=$1 AND id=(SELECT room_id FROM batches WHERE id=$2 AND org_id=$1)`, r.PathValue("org"), r.PathValue("batch")); e != nil {
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	send(w, 201, map[string]string{"id": in.ID})
	return nil
}
func (a *app) updateObservation(w http.ResponseWriter, r *http.Request) error {
	var in observationInput
	if e := readJSON(w, r, &in); e != nil {
		return e
	}
	if !validID(r.PathValue("observation")) {
		return fail(404, "Bevinding niet gevonden")
	}
	if e := validateObservation(in); e != nil {
		return e
	}
	tx, _, e := a.edit(r)
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	var batch string
	e = tx.QueryRow(r.Context(), "UPDATE observations SET title=$1,description=$2,label=$3,status=$4,version=version+1 WHERE id=$5 AND org_id=$6 AND inspection_id=$7 AND version=$8 RETURNING batch_id", in.Title, in.Description, in.Label, in.Status, r.PathValue("observation"), r.PathValue("org"), r.PathValue("inspection"), in.Version).Scan(&batch)
	if e == pgx.ErrNoRows {
		return fail(409, "De bevinding is gewijzigd. Herlaad de nieuwste versie voordat je opslaat.")
	}
	if e != nil {
		return e
	}
	if _, e = tx.Exec(r.Context(), "UPDATE batches SET status=CASE WHEN status='excluded' THEN status ELSE 'pending' END,version=version+1 WHERE id=$1 AND org_id=$2", batch, r.PathValue("org")); e != nil {
		return e
	}
	if _, e = tx.Exec(r.Context(), `UPDATE rooms SET approved_generation=NULL,reviewed_at=NULL WHERE org_id=$1 AND id=(SELECT room_id FROM batches WHERE id=$2 AND org_id=$1)`, r.PathValue("org"), batch); e != nil {
		return e
	}
	if e = reconcileCaptureReviews(r.Context(), tx, r.PathValue("org"), r.PathValue("inspection")); e != nil {
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	send(w, 200, map[string]int{"version": in.Version + 1})
	return nil
}
func (a *app) finalise(w http.ResponseWriter, r *http.Request) error {
	tx, u, e := a.edit(r)
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	var in struct {
		Signatures       []signatureInput  `json:"signatures"`
		Version          int               `json:"version"`
		SigningException *signingException `json:"signingException"`
		Disagreement     string            `json:"disagreement"`
	}
	if r.ContentLength != 0 {
		if e = readJSON(w, r, &in); e != nil {
			return e
		}
	}
	if e = validateSignatures(in.Signatures); e != nil {
		return e
	}
	org, inspection := r.PathValue("org"), r.PathValue("inspection")
	var linked bool
	if e = tx.QueryRow(r.Context(), `SELECT p.link_state='linked' AND i.property_snapshot->>'linkState'='linked' AND i.property_snapshot->>'sourceId'=p.source_id::text AND i.property_snapshot->>'sourceObjectId'=p.source_object_id FROM inspections i JOIN properties p ON p.id=i.property_id AND p.org_id=i.org_id WHERE i.id=$1 AND i.org_id=$2`, inspection, org).Scan(&linked); e != nil {
		return e
	}
	if !linked {
		return fail(422, "Koppel de voorlopige woning eerst aan een bronobject voordat je het rapport vastlegt")
	}
	format, err := inspectionFormat(r.Context(), tx, org, inspection)
	if err != nil {
		return err
	}
	var correction bool
	if e = tx.QueryRow(r.Context(), `SELECT corrects_inspection_id IS NOT NULL FROM inspections WHERE id=$1 AND org_id=$2`, inspection, org).Scan(&correction); e != nil {
		return e
	}
	var reissue bool
	if e = tx.QueryRow(r.Context(), `SELECT latest_report_id IS NOT NULL FROM inspections WHERE id=$1 AND org_id=$2`, inspection, org).Scan(&reissue); e != nil {
		return e
	}
	strictSigning := reissue || correction || (format != nil && format.SigningPolicy == "resident_or_exception")
	if strictSigning {
		var revision int
		var visited *time.Time
		if e = tx.QueryRow(r.Context(), `SELECT revision,visited_at FROM inspections WHERE id=$1 AND org_id=$2`, inspection, org).Scan(&revision, &visited); e != nil {
			return e
		}
		if in.Version != revision {
			return fail(409, "De inhoud is gewijzigd. Controleer het rapport en verzamel opnieuw de handtekeningen.")
		}
		if visited == nil {
			return fail(422, "Vul eerst de werkelijke bezoekdatum in")
		}
		if e = validateSigningPolicy(in.Signatures, in.SigningException, in.Disagreement); e != nil {
			return e
		}
	}
	if format != nil {
		if e = validateFormatCompletion(r.Context(), tx, org, inspection); e != nil {
			return e
		}
	} else {
		var ready bool
		e = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM batches WHERE inspection_id=$1 AND org_id=$2) AND NOT EXISTS(SELECT 1 FROM batches b WHERE inspection_id=$1 AND org_id=$2 AND (status='pending' OR (status='reviewed' AND cardinality(expected_media)<>(SELECT count(*) FROM media m WHERE m.batch_id=b.id AND m.org_id=b.org_id)) OR (status='reviewed' AND (NOT EXISTS(SELECT 1 FROM media m WHERE m.batch_id=b.id AND m.org_id=b.org_id) OR EXISTS(SELECT 1 FROM observations o WHERE o.batch_id=b.id AND o.org_id=b.org_id AND o.status='draft'))))) AND NOT EXISTS(SELECT 1 FROM processing_jobs j JOIN batches b ON b.id=j.batch_id WHERE j.inspection_id=$1 AND j.org_id=$2 AND j.status<>'done' AND b.status<>'excluded')`, inspection, org).Scan(&ready)
		if e != nil {
			return e
		}
		if !ready {
			return fail(422, "Beoordeel of sluit alle opnamen uit voordat je het rapport vastlegt")
		}
		var normsReady bool
		if e = tx.QueryRow(r.Context(), "SELECT NOT EXISTS(SELECT 1 FROM norm_assessments a JOIN batches b ON b.id=a.batch_id AND b.org_id=a.org_id WHERE a.inspection_id=$1 AND a.org_id=$2 AND b.status<>'excluded' AND (a.reviewed_outcome IS NULL OR a.stale))", inspection, org).Scan(&normsReady); e != nil {
			return e
		}
		if !normsReady {
			return fail(422, "Bevestig alle normbeoordelingen voordat je het rapport vastlegt")
		}
	}
	snapshot, e := reportSnapshot(r.Context(), tx, org, inspection)
	if e != nil {
		return e
	}
	snapshot["finalisedBy"], _ = json.Marshal(map[string]string{"name": u.Name})
	now := time.Now().UTC()
	signatures := make([]reportSignature, 0, len(in.Signatures))
	for _, signature := range in.Signatures {
		signature.Name = strings.TrimSpace(signature.Name)
		signatures = append(signatures, reportSignature{Input: signature, SignedAt: now, CollectedBy: u.ID})
	}
	acknowledgement := ""
	if strictSigning {
		acknowledgement = defaultSigningAcknowledgement
		if format != nil && strings.TrimSpace(format.Acknowledgement) != "" {
			acknowledgement = format.Acknowledgement
		}
	}
	snapshot["acknowledgement"], _ = json.Marshal(acknowledgement)
	snapshot["signatures"], _ = json.Marshal(signatures)
	snapshot["signingException"], _ = json.Marshal(in.SigningException)
	snapshot["disagreement"], _ = json.Marshal(in.Disagreement)
	var frozenInspection map[string]any
	if e = json.Unmarshal(snapshot["inspection"], &frozenInspection); e != nil {
		return e
	}
	frozenInspection["status"] = "final"
	snapshot["inspection"], _ = json.Marshal(frozenInspection)
	snapshot["createdAt"], _ = json.Marshal(now)
	reportID := id()
	snapshot["id"], _ = json.Marshal(reportID)
	var reportNumber int
	if e = tx.QueryRow(r.Context(), `SELECT COALESCE(max(number),0)+1 FROM reports WHERE org_id=$1 AND inspection_id=$2`, org, inspection).Scan(&reportNumber); e != nil {
		return e
	}
	snapshot["number"], _ = json.Marshal(reportNumber)
	snapshot["rendererVersion"], _ = json.Marshal(2)
	raw, _ := json.Marshal(snapshot)
	if _, e = tx.Exec(r.Context(), "INSERT INTO reports(id,org_id,inspection_id,snapshot,created_by,number) VALUES($1,$2,$3,$4,$5,$6)", reportID, org, inspection, raw, u.ID, reportNumber); e != nil {
		return e
	}
	if _, e = tx.Exec(r.Context(), `INSERT INTO report_artifacts(report_id,org_id,inspection_id,object_key) VALUES($1,$2,$3,$4)`, reportID, org, inspection, org+"/reports/"+reportID+".pdf"); e != nil {
		return e
	}
	if _, e = tx.Exec(r.Context(), "UPDATE inspections SET status='final',latest_report_id=$3 WHERE id=$1 AND org_id=$2", inspection, org, reportID); e != nil {
		return e
	}
	if _, e = tx.Exec(r.Context(), `UPDATE inspections SET superseded_by=$1,revision=revision+1 WHERE id=(SELECT corrects_inspection_id FROM inspections WHERE id=$1 AND org_id=$2) AND org_id=$2`, inspection, org); e != nil {
		return e
	}
	if e = recordEvent(r.Context(), tx, org, inspection, u.ID, "report_finalised", map[string]string{"reportId": reportID}); e != nil {
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	send(w, 201, json.RawMessage(raw))
	return nil
}
func (a *app) report(w http.ResponseWriter, r *http.Request) error {
	if _, _, e := a.access(r, false); e != nil {
		return e
	}
	if !validID(r.PathValue("inspection")) {
		return fail(404, "Rapport niet gevonden")
	}
	var raw json.RawMessage
	reportID := r.URL.Query().Get("reportId")
	if reportID != "" && !validID(reportID) {
		return fail(404, "Rapportversie niet gevonden")
	}
	e := a.db.QueryRow(r.Context(), `SELECT snapshot FROM reports WHERE inspection_id=$1 AND org_id=$2 AND ($3='' OR id::text=$3) ORDER BY number DESC LIMIT 1`, r.PathValue("inspection"), r.PathValue("org"), reportID).Scan(&raw)
	if e != nil {
		return e
	}
	send(w, 200, raw)
	return nil
}
