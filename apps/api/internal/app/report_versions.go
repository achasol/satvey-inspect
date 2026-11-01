package app

import (
	"encoding/json"
	"net/http"
)

func (a *app) reportVersions(w http.ResponseWriter, r *http.Request) error {
	if _, _, err := a.access(r, false); err != nil {
		return err
	}
	if !validID(r.PathValue("inspection")) {
		return fail(404, "Dossier niet gevonden")
	}
	rows, err := list(r.Context(), a.db, `SELECT r.id,r.number,r.created_at AS "createdAt",u.name AS "createdBy" FROM reports r JOIN users u ON u.id=r.created_by WHERE r.org_id=$1 AND r.inspection_id=$2 ORDER BY r.number DESC`, r.PathValue("org"), r.PathValue("inspection"))
	if err != nil {
		return err
	}
	send(w, 200, rows)
	return nil
}

func (a *app) reopenReport(w http.ResponseWriter, r *http.Request) error {
	u, _, err := a.access(r, true)
	if err != nil {
		return err
	}
	var in struct {
		Version  int    `json:"version"`
		ReportID string `json:"reportId"`
	}
	if err = readJSON(w, r, &in); err != nil {
		return err
	}
	org, iid := r.PathValue("org"), r.PathValue("inspection")
	if !validID(iid) || in.Version < 1 {
		return fail(422, "Open de actuele versie van het dossier")
	}
	// Materialize the original PDF before enabling edits. It must never be rebuilt
	// from mutable working evidence after the dossier has reopened.
	var raw []byte
	var current string
	if err = a.db.QueryRow(r.Context(), `SELECT r.snapshot,r.id FROM reports r JOIN inspections i ON i.latest_report_id=r.id AND i.org_id=r.org_id WHERE i.id=$1 AND i.org_id=$2`, iid, org).Scan(&raw, &current); err != nil {
		return err
	}
	if in.ReportID != "" && in.ReportID != current {
		return fail(409, "Het vastgestelde rapport is gewijzigd; herlaad")
	}
	var doc pdfDocument
	if err = json.Unmarshal(raw, &doc); err != nil {
		return err
	}
	if err = preparePDFDocument(&doc); err != nil {
		return err
	}
	if _, err = a.frozenReportPDF(r.Context(), org, doc); err != nil {
		return err
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	var status string
	var revision int
	var archived bool
	var report string
	if err = tx.QueryRow(r.Context(), `SELECT status,revision,archived_at IS NOT NULL,latest_report_id::text FROM inspections WHERE id=$1 AND org_id=$2 FOR UPDATE`, iid, org).Scan(&status, &revision, &archived, &report); err != nil {
		return err
	}
	if archived {
		return fail(409, "Herstel eerst het gearchiveerde dossier")
	}
	if report != current {
		return fail(409, "Controleer de nieuwste rapportversie")
	}
	if status == "draft" && revision == in.Version+1 {
		send(w, 200, map[string]int{"version": revision})
		return nil
	}
	if status != "final" || revision != in.Version {
		return fail(409, "Het dossier is gewijzigd; herlaad voordat je bewerkt")
	}
	if _, err = tx.Exec(r.Context(), `UPDATE inspections SET status='draft',revision=revision+1 WHERE id=$1 AND org_id=$2`, iid, org); err != nil {
		return err
	}
	if err = recordEvent(r.Context(), tx, org, iid, u.ID, "report_editing_started", map[string]any{"reportId": current, "before": "final", "after": "draft"}); err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	send(w, 200, map[string]int{"version": revision + 1})
	return nil
}
