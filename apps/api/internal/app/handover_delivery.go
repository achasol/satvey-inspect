package app

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"time"

	"satvey/inspect/internal/handover"

	"github.com/jackc/pgx/v5"
)

func (a *app) handoverDeliveryList(ctx context.Context, q querier, org, inspection string) (json.RawMessage, error) {
	return list(ctx, q, `SELECT d.id,d.inspection_id AS "inspectionId",d.destination_id AS "destinationId",d.snapshot->>'destination' AS destination,d.draft_version AS "draftVersion",d.status,d.attempts,d.last_error AS error,d.created_at AS "createdAt",d.accepted_at AS "acceptedAt",d.next_attempt_at AS "nextAttemptAt",
 (SELECT count(*) FROM handover_delivery_items i WHERE i.delivery_id=d.id AND i.item_key NOT LIKE 'links:%') AS "acceptedCount",
 COALESCE((SELECT jsonb_agg(jsonb_build_object('key',i.item_key,'receiverId',i.receiver_id,'uri',i.resource_uri,'acceptedAt',i.accepted_at) ORDER BY i.accepted_at) FROM handover_delivery_items i WHERE i.delivery_id=d.id AND i.item_key NOT LIKE 'links:%'),'[]') AS receipts,
 d.snapshot->'proposals' AS proposals
 FROM handover_deliveries d WHERE d.org_id=$1 AND ($2='' OR d.inspection_id::text=$2) ORDER BY d.created_at DESC,d.id LIMIT 100`, org, inspection)
}

func immutableHandoverProposals(ctx context.Context, q querier, org, inspection string, proposals []handover.Proposal) error {
	rows, e := handoverRows(ctx, q, `SELECT snapshot->'proposals' AS proposals FROM handover_deliveries WHERE org_id=$1 AND inspection_id=$2`, org, inspection)
	if e != nil {
		return e
	}
	proposed := map[string]handover.Proposal{}
	for _, p := range proposals {
		proposed[p.ID] = p
	}
	for _, row := range rows {
		raw, _ := json.Marshal(row["proposals"])
		var approved []handover.Proposal
		if e = json.Unmarshal(raw, &approved); e != nil {
			return e
		}
		for _, p := range approved {
			if current, ok := proposed[p.ID]; !ok || !reflect.DeepEqual(current, p) {
				return fail(409, "Goedgekeurde onderhoudsvoorstellen staan vast. Voeg een nieuw voorstel toe; wijzig ontvangen werkzaamheden in het ontvangende systeem")
			}
		}
	}
	return nil
}

func deliveryBundle(report handover.Report, draft handover.Draft, deliveryID string, vera handover.VERAContext) handover.Bundle {
	b := handover.Bundle{SchemaVersion: handover.SchemaVersion, ID: deliveryID, CreatedAt: time.Now().UTC(), DraftVersion: draft.Version, Destination: draft.Destination, ExternalReference: draft.ExternalReference, Report: report, Proposals: draft.Proposals, VERA: &vera, Attachments: []handover.Attachment{{Path: "report.pdf", MIME: "application/pdf"}}}
	for _, photo := range report.Photos {
		b.Attachments = append(b.Attachments, handover.Attachment{Path: "photos/" + photo.ID + ".jpg", MIME: "image/jpeg", MediaID: photo.ID})
		if len(photo.Annotations) > 0 {
			b.Attachments = append(b.Attachments, handover.Attachment{Path: "photos/" + photo.ID + "-annotated.svg", MIME: "image/svg+xml", MediaID: photo.ID})
		}
	}
	return b
}

func (a *app) approveHandover(w http.ResponseWriter, r *http.Request) error {
	user, _, e := a.access(r, true)
	if e != nil {
		return e
	}
	var in struct {
		ID            string `json:"id"`
		Version       int    `json:"version"`
		DestinationID string `json:"destinationId"`
	}
	if e = readJSON(w, r, &in); e != nil {
		return e
	}
	if !validID(in.ID) || !validID(in.DestinationID) || in.Version < 1 {
		return fail(422, "Bewaar de overdracht en kies een VERA-bestemming")
	}
	org, inspection := r.PathValue("org"), r.PathValue("inspection")
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	report, snapshot, e := a.handoverReport(r.Context(), tx, org, inspection, true)
	if e != nil {
		return e
	}
	var existing string
	var revision int
	var existingDestination string
	e = tx.QueryRow(r.Context(), `SELECT id,draft_version,destination_id FROM handover_deliveries WHERE org_id=$1 AND inspection_id=$2 AND (id=$3 OR (draft_version=$4 AND destination_id=$5)) ORDER BY (id=$3) DESC LIMIT 1`, org, inspection, in.ID, in.Version, in.DestinationID).Scan(&existing, &revision, &existingDestination)
	if e == nil {
		if revision != in.Version || existingDestination != in.DestinationID {
			return fail(409, "Deze goedkeuring hoort bij een andere overdrachtsversie")
		}
		send(w, 202, map[string]string{"id": existing})
		return nil
	}
	if e != pgx.ErrNoRows {
		return e
	}
	var manual bool
	if e = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM manual_handovers WHERE org_id=$1 AND inspection_id=$2)`, org, inspection).Scan(&manual); e != nil {
		return e
	}
	if manual {
		return fail(409, "Dit rapport is handmatig overgedragen. Stem aanvullingen af in het ontvangende systeem om dubbel werk te voorkomen.")
	}
	var active bool
	if e = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM handover_deliveries WHERE org_id=$1 AND inspection_id=$2 AND status NOT IN ('accepted','manual'))`, org, inspection).Scan(&active); e != nil {
		return e
	}
	if active {
		return fail(409, "Rond de eerdere overdracht eerst af of herstel de koppeling")
	}
	draft, e := readHandoverDraft(r.Context(), tx, org, inspection)
	if e != nil {
		return e
	}
	if draft.Version != in.Version || draft.DestinationID != in.DestinationID {
		return fail(409, "De overdracht is gewijzigd; controleer de nieuwste versie")
	}
	if e = handover.ValidateDraft(&draft, report); e != nil {
		return e
	}
	if e = immutableHandoverProposals(r.Context(), tx, org, inspection, draft.Proposals); e != nil {
		return e
	}
	if _, e = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "vera-destination:"+in.DestinationID); e != nil {
		return e
	}
	d, e := readHandoverDestination(r.Context(), tx, org, in.DestinationID)
	if e != nil {
		return e
	}
	if !d.Enabled {
		return fail(422, "Deze VERA-bestemming is uitgeschakeld")
	}
	unit, e := a.receivingUnit(r.Context(), tx, org, d, report.Property)
	if e != nil {
		return e
	}
	draft.Destination = d.Name
	vera := handover.VERAContext{UnitURI: unit, Organisation: d.Organisation, Administration: d.Administration, ReportTypeCode: d.ReportTypeCode, MaintenanceTypeCode: d.MaintenanceTypeCode}
	bundle := deliveryBundle(report, draft, in.ID, vera)
	raw, _ := json.Marshal(bundle)
	tag, e := tx.Exec(r.Context(), `INSERT INTO handover_deliveries(id,org_id,inspection_id,destination_id,destination_revision,draft_version,snapshot,report_snapshot,approved_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING`, in.ID, org, inspection, d.ID, d.Revision, draft.Version, raw, snapshot, user.ID)
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return fail(409, "Deze goedkeurings-ID is al in gebruik")
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	send(w, 202, map[string]string{"id": in.ID})
	return nil
}

func (a *app) retryHandover(w http.ResponseWriter, r *http.Request) error {
	if _, _, e := a.access(r, true); e != nil {
		return e
	}
	org, inspection, delivery := r.PathValue("org"), r.PathValue("inspection"), r.PathValue("delivery")
	if !validID(delivery) {
		return fail(404, "Overdracht niet gevonden")
	}
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	var destination, status string
	e = tx.QueryRow(r.Context(), `SELECT destination_id,status FROM handover_deliveries WHERE id=$1 AND org_id=$2 AND inspection_id=$3 FOR UPDATE`, delivery, org, inspection).Scan(&destination, &status)
	if e != nil {
		return e
	}
	d, e := readHandoverDestination(r.Context(), tx, org, destination)
	if e != nil {
		return e
	}
	if !d.Enabled {
		return fail(422, "Schakel de VERA-bestemming eerst in")
	}
	if status == "blocked" || status == "retrying" {
		_, e = tx.Exec(r.Context(), `UPDATE handover_deliveries SET status='queued',attempts=0,next_attempt_at=now(),last_error='',destination_revision=$2 WHERE id=$1`, delivery, d.Revision)
		if e != nil {
			return e
		}
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	send(w, 202, map[string]string{"id": delivery})
	return nil
}
