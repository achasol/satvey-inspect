package app

import (
	"net/http"
	"strings"
	"time"
)

func (a *app) planningMembers(w http.ResponseWriter, r *http.Request) error {
	if _, _, err := a.access(r, false); err != nil {
		return err
	}
	out, err := list(r.Context(), a.db, `SELECT u.id,u.name,('inspections.review'=ANY(ro.privileges)) AS reviewer,('inspections.write'=ANY(ro.privileges)) AS writer FROM memberships m JOIN users u ON u.id=m.user_id JOIN organisation_roles ro ON ro.id=m.role_id AND ro.org_id=m.org_id WHERE m.org_id=$1 ORDER BY u.name`, r.PathValue("org"))
	if err != nil {
		return err
	}
	send(w, 200, out)
	return nil
}

func (a *app) planInspection(w http.ResponseWriter, r *http.Request) error {
	u, _, err := a.require(r, "inspections.plan")
	if err != nil {
		return err
	}
	var in struct {
		Version     int        `json:"version"`
		AssignedTo  *string    `json:"assignedTo"`
		ScheduledAt *time.Time `json:"scheduledAt"`
		VisitedAt   *time.Time `json:"visitedAt"`
		Priority    string     `json:"priority"`
		Outcome     string     `json:"visitOutcome"`
		Reference   string     `json:"externalReference"`
	}
	if err = readJSON(w, r, &in); err != nil {
		return err
	}
	if in.Version < 1 || !contains([]string{"normal", "high", "urgent"}, in.Priority) || !contains([]string{"scheduled", "visited", "no_access", "cancelled"}, in.Outcome) || len(in.Reference) > 240 {
		return fail(422, "Controleer de planning")
	}
	if in.Outcome == "visited" && in.VisitedAt == nil {
		return fail(422, "Vul de werkelijke bezoekdatum in")
	}
	org, iid := r.PathValue("org"), r.PathValue("inspection")
	if !validID(iid) {
		return fail(404, "Inspectie niet gevonden")
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	if in.AssignedTo != nil {
		var ok bool
		if !validID(*in.AssignedTo) {
			return fail(422, "Kies een inspecteur")
		}
		if err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM memberships m JOIN organisation_roles ro ON ro.id=m.role_id AND ro.org_id=m.org_id WHERE m.org_id=$1 AND m.user_id=$2 AND 'inspections.write'=ANY(ro.privileges))`, org, *in.AssignedTo).Scan(&ok); err != nil {
			return err
		}
		if !ok {
			return fail(422, "De inspecteur moet bewerkrechten in deze organisatie hebben")
		}
	}
	tag, err := tx.Exec(r.Context(), `UPDATE inspections SET assigned_to=$3,scheduled_at=$4,visited_at=$5,priority=$6,visit_outcome=$7,external_reference=$8,revision=revision+1 WHERE id=$1 AND org_id=$2 AND revision=$9 AND status='draft' AND archived_at IS NULL`, iid, org, in.AssignedTo, in.ScheduledAt, in.VisitedAt, in.Priority, in.Outcome, strings.TrimSpace(in.Reference), in.Version)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return fail(409, "Het dossier is gewijzigd, vastgelegd of gearchiveerd")
	}
	if err = recordEvent(r.Context(), tx, org, iid, u.ID, "planning_updated", map[string]any{"assignedTo": in.AssignedTo, "outcome": in.Outcome}); err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	send(w, 200, map[string]int{"version": in.Version + 1})
	return nil
}

func (a *app) qualityReview(w http.ResponseWriter, r *http.Request) error {
	u, _, err := a.require(r, "inspections.review")
	if err != nil {
		return err
	}
	var in struct {
		Version int    `json:"version"`
		Action  string `json:"action"`
		Note    string `json:"note"`
	}
	if err = readJSON(w, r, &in); err != nil {
		return err
	}
	if !contains([]string{"approved", "changes_requested"}, in.Action) || len(in.Note) > 4000 || (in.Action == "changes_requested" && strings.TrimSpace(in.Note) == "") {
		return fail(422, "Leg de controle en eventuele aandachtspunten vast")
	}
	org, iid := r.PathValue("org"), r.PathValue("inspection")
	if !validID(iid) {
		return fail(404, "Dossier niet gevonden")
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	tag, err := tx.Exec(r.Context(), `UPDATE inspections SET reviewer_id=$3,review_status=$4,review_note=$5 WHERE id=$1 AND org_id=$2 AND revision=$6 AND archived_at IS NULL`, iid, org, u.ID, in.Action, strings.TrimSpace(in.Note), in.Version)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return fail(409, "Controleer de nieuwste dossierversie")
	}
	if err = recordEvent(r.Context(), tx, org, iid, u.ID, "quality_"+in.Action, map[string]string{"note": strings.TrimSpace(in.Note)}); err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	send(w, 200, map[string]bool{"ok": true})
	return nil
}

type agreementInput struct {
	ID             string   `json:"id"`
	Description    string   `json:"description"`
	Responsibility string   `json:"responsibility"`
	DueDate        *string  `json:"dueDate"`
	Status         string   `json:"status"`
	Note           string   `json:"note"`
	PhotoIDs       []string `json:"photoIds"`
	Version        int      `json:"version"`
}

func (a *app) saveAgreement(w http.ResponseWriter, r *http.Request) error {
	var in agreementInput
	if err := readJSON(w, r, &in); err != nil {
		return err
	}
	if (r.PathValue("agreement") != "" && r.PathValue("agreement") != in.ID) || !validID(in.ID) || strings.TrimSpace(in.Description) == "" || len(in.Description) > 4000 || len(in.Note) > 4000 || !contains([]string{"resident", "corporation"}, in.Responsibility) || !contains([]string{"open", "completed", "disputed", "withdrawn"}, in.Status) || in.Version < 0 || len(in.PhotoIDs) > 30 {
		return fail(422, "Controleer de afspraak")
	}
	if in.DueDate != nil {
		if _, err := time.Parse("2006-01-02", *in.DueDate); err != nil {
			return fail(422, "Ongeldige deadline")
		}
	}
	if (in.Status == "disputed" || in.Status == "withdrawn") && strings.TrimSpace(in.Note) == "" {
		return fail(422, "Licht de status toe")
	}
	tx, u, err := a.edit(r)
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	org, iid := r.PathValue("org"), r.PathValue("inspection")
	for _, pid := range in.PhotoIDs {
		var ok bool
		if !validID(pid) {
			return fail(422, "Ongeldig bronbewijs")
		}
		if err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM media m JOIN batches b ON b.id=m.batch_id AND b.org_id=m.org_id WHERE m.id=$1 AND m.org_id=$2 AND m.inspection_id=$3 AND m.kind='photo' AND b.status<>'excluded')`, pid, org, iid).Scan(&ok); err != nil {
			return err
		}
		if !ok {
			return fail(422, "Kies foto's uit dit dossier")
		}
	}
	if in.Status == "completed" && len(in.PhotoIDs) == 0 && strings.TrimSpace(in.Note) == "" {
		return fail(422, "Voeg bewijs of een controletoelichting toe")
	}
	if in.PhotoIDs == nil {
		in.PhotoIDs = []string{}
	}
	tag, err := tx.Exec(r.Context(), `INSERT INTO inspection_agreements(id,org_id,inspection_id,description,responsibility,due_date,status,note,photo_ids) SELECT $1,$2,$3,$4,$5,$6::date,$7,$8,$9 WHERE $10=0 ON CONFLICT(id) DO UPDATE SET description=EXCLUDED.description,responsibility=EXCLUDED.responsibility,due_date=EXCLUDED.due_date,status=EXCLUDED.status,note=EXCLUDED.note,photo_ids=EXCLUDED.photo_ids,version=inspection_agreements.version+1 WHERE inspection_agreements.org_id=$2 AND inspection_agreements.inspection_id=$3 AND inspection_agreements.version=$10`, in.ID, org, iid, strings.TrimSpace(in.Description), in.Responsibility, in.DueDate, in.Status, in.Note, in.PhotoIDs, in.Version)
	// UPDATE needs a candidate row too; handle existing agreements explicitly.
	if err != nil {
		return err
	}
	if in.Version > 0 {
		tag, err = tx.Exec(r.Context(), `UPDATE inspection_agreements SET description=$4,responsibility=$5,due_date=$6::date,status=$7,note=$8,photo_ids=$9,version=version+1 WHERE id=$1 AND org_id=$2 AND inspection_id=$3 AND version=$10`, in.ID, org, iid, strings.TrimSpace(in.Description), in.Responsibility, in.DueDate, in.Status, in.Note, in.PhotoIDs, in.Version)
		if err != nil {
			return err
		}
	}
	if tag.RowsAffected() != 1 {
		return fail(409, "De afspraak is gewijzigd. Herlaad de nieuwste versie.")
	}
	_ = u
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	send(w, 200, map[string]int{"version": in.Version + 1})
	return nil
}
