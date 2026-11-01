package app

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

func (a *app) manualHandover(w http.ResponseWriter, r *http.Request) error {
	u, _, err := a.access(r, true)
	if err != nil {
		return err
	}
	var in struct {
		ID             string `json:"id"`
		ReportID       string `json:"reportId"`
		Recipient      string `json:"recipient"`
		Channel        string `json:"channel"`
		Reference      string `json:"reference"`
		Note           string `json:"note"`
		Acknowledged   bool   `json:"acknowledged"`
		Reconciliation string `json:"reconciliation"`
	}
	if err = readJSON(w, r, &in); err != nil {
		return err
	}
	if !validID(in.ID) || !validID(in.ReportID) || strings.TrimSpace(in.Recipient) == "" || strings.TrimSpace(in.Channel) == "" || strings.TrimSpace(in.Reference) == "" || len(in.Recipient) > 240 || len(in.Channel) > 100 || len(in.Reference) > 240 || len(in.Note) > 4000 || len(in.Reconciliation) > 4000 {
		return fail(422, "Vul ontvanger, kanaal en ontvangend kenmerk in")
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	org, iid := r.PathValue("org"), r.PathValue("inspection")
	if !validID(iid) {
		return fail(404, "Inspectie niet gevonden")
	}
	var unlocked bool
	if err = tx.QueryRow(r.Context(), `SELECT pg_try_advisory_xact_lock(hashtextextended($1,0))`, "vera-inspection:"+iid).Scan(&unlocked); err != nil {
		return err
	}
	if !unlocked {
		return fail(409, "Wacht tot de actieve VERA-poging is afgerond")
	}
	var report string
	if err = tx.QueryRow(r.Context(), `SELECT r.id FROM reports r JOIN inspections i ON i.id=r.inspection_id AND i.org_id=r.org_id WHERE i.id=$1 AND i.org_id=$2 AND r.id=i.latest_report_id AND i.archived_at IS NULL FOR UPDATE OF i`, iid, org).Scan(&report); err != nil {
		return err
	}
	if report != in.ReportID {
		return fail(409, "Kies de juiste definitieve rapportversie")
	}
	var exists bool
	if err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM manual_handovers WHERE id=$1 AND org_id=$2 AND inspection_id=$3 AND report_id=$4 AND recipient=$5 AND channel=$6 AND reference=$7 AND acknowledged=$8 AND note=$9)`, in.ID, org, iid, report, in.Recipient, in.Channel, in.Reference, in.Acknowledged, in.Note).Scan(&exists); err != nil {
		return err
	}
	if exists {
		send(w, 200, map[string]string{"id": in.ID})
		return nil
	}
	var used bool
	if err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM manual_handovers WHERE id=$1)`, in.ID).Scan(&used); err != nil {
		return err
	}
	if used {
		return fail(409, "Deze registratie bestaat met andere gegevens; controleer de historie")
	}
	var active bool
	if err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM handover_deliveries WHERE org_id=$1 AND inspection_id=$2 AND status NOT IN ('accepted','manual'))`, org, iid).Scan(&active); err != nil {
		return err
	}
	if active {
		if _, err = a.admin(r); err != nil {
			return err
		}
		if strings.TrimSpace(in.Reconciliation) == "" {
			return fail(422, "Controleer eerst wat al ontvangen is en leg de afstemming vast")
		}
		if _, err = tx.Exec(r.Context(), `UPDATE handover_deliveries SET status='manual',run_token=NULL,lease_until=NULL,last_error='Handmatig afgehandeld na expliciete afstemming' WHERE org_id=$1 AND inspection_id=$2 AND status NOT IN ('accepted','manual')`, org, iid); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(r.Context(), `INSERT INTO manual_handovers(id,org_id,inspection_id,report_id,recipient,channel,reference,note,acknowledged,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, in.ID, org, iid, report, in.Recipient, in.Channel, in.Reference, in.Note, in.Acknowledged, u.ID); err != nil {
		return err
	}
	if err = recordEvent(r.Context(), tx, org, iid, u.ID, "manual_handover_recorded", map[string]any{"reportId": report, "reference": in.Reference, "acknowledged": in.Acknowledged, "reconciliation": in.Reconciliation}); err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	send(w, 201, map[string]string{"id": in.ID})
	return nil
}
func (a *app) manualHandoverHistory(w http.ResponseWriter, r *http.Request) error {
	if _, _, err := a.access(r, false); err != nil {
		return err
	}
	out, err := list(r.Context(), a.db, `SELECT id,report_id AS "reportId",recipient,channel,reference,note,acknowledged,created_at AS "createdAt" FROM manual_handovers WHERE org_id=$1 AND inspection_id=$2 ORDER BY created_at DESC LIMIT 100`, r.PathValue("org"), r.PathValue("inspection"))
	if err != nil {
		return err
	}
	send(w, 200, out)
	return nil
}

type measurement struct {
	Capture float64 `json:"captureMinutes"`
	Review  float64 `json:"reviewMinutes"`
	Report  float64 `json:"reportMinutes"`
	Reentry float64 `json:"reentryMinutes"`
	Support float64 `json:"supportMinutes"`
	Note    string  `json:"note"`
	Version int     `json:"version"`
}

func (a *app) measurement(w http.ResponseWriter, r *http.Request) error {
	u, _, err := a.access(r, r.Method != "GET")
	if err != nil {
		return err
	}
	org, iid := r.PathValue("org"), r.PathValue("inspection")
	if !validID(iid) {
		return fail(404, "Inspectie niet gevonden")
	}
	if r.Method == "GET" {
		out, err := list(r.Context(), a.db, `SELECT capture_minutes AS "captureMinutes",review_minutes AS "reviewMinutes",report_minutes AS "reportMinutes",reentry_minutes AS "reentryMinutes",support_minutes AS "supportMinutes",note,version FROM inspection_measurements WHERE org_id=$1 AND inspection_id=$2`, org, iid)
		if err != nil {
			return err
		}
		send(w, 200, out)
		return nil
	}
	var in measurement
	if err = readJSON(w, r, &in); err != nil {
		return err
	}
	total := 0.0
	for _, v := range []float64{in.Capture, in.Review, in.Report, in.Reentry, in.Support} {
		if v < 0 || v > 1440 {
			return fail(422, "Gebruik minuten tussen 0 en 1440")
		}
		total += v
	}
	if total > 1440 || in.Version < 0 || len(in.Note) > 1000 {
		return fail(422, "Controleer de meting")
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	var locked string
	if err = tx.QueryRow(r.Context(), `SELECT id FROM inspections WHERE id=$1 AND org_id=$2 AND archived_at IS NULL FOR UPDATE`, iid, org).Scan(&locked); err != nil {
		return err
	}
	if in.Version == 0 {
		tag, e := tx.Exec(r.Context(), `INSERT INTO inspection_measurements(org_id,inspection_id,capture_minutes,review_minutes,report_minutes,reentry_minutes,support_minutes,note,measured_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`, org, iid, in.Capture, in.Review, in.Report, in.Reentry, in.Support, in.Note, u.ID)
		if e != nil {
			return e
		}
		if tag.RowsAffected() != 1 {
			return fail(409, "De meting bestaat al; herlaad")
		}
	} else {
		tag, e := tx.Exec(r.Context(), `UPDATE inspection_measurements SET capture_minutes=$3,review_minutes=$4,report_minutes=$5,reentry_minutes=$6,support_minutes=$7,note=$8,measured_by=$9,measured_at=now(),version=version+1 WHERE org_id=$1 AND inspection_id=$2 AND version=$10`, org, iid, in.Capture, in.Review, in.Report, in.Reentry, in.Support, in.Note, u.ID, in.Version)
		if e != nil {
			return e
		}
		if tag.RowsAffected() != 1 {
			return fail(409, "De meting is gewijzigd; herlaad")
		}
	}
	if err = recordEvent(r.Context(), tx, org, iid, u.ID, "pilot_measurement", map[string]any{"version": in.Version + 1}); err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	send(w, 200, map[string]int{"version": in.Version + 1})
	return nil
}
func (a *app) pilotMetrics(w http.ResponseWriter, r *http.Request) error {
	if _, _, err := a.require(r, "inspections.plan"); err != nil {
		return err
	}
	rows, err := list(r.Context(), a.db, `SELECT i.id,i.kind,i.status,i.visit_outcome AS "visitOutcome",i.corrects_inspection_id IS NOT NULL AS correction,i.review_status AS "reviewStatus",i.created_at AS "createdAt",m.capture_minutes AS "captureMinutes",m.review_minutes AS "reviewMinutes",m.report_minutes AS "reportMinutes",m.reentry_minutes AS "reentryMinutes",m.support_minutes AS "supportMinutes",((SELECT count(*) FROM handover_deliveries d WHERE d.org_id=i.org_id AND d.inspection_id=i.id AND d.status IN ('blocked','retrying'))+(SELECT count(*) FROM report_deliveries rd JOIN mail_jobs mj ON mj.id=rd.mail_job_id WHERE rd.org_id=i.org_id AND rd.inspection_id=i.id AND mj.status='failed')+(SELECT count(*) FROM report_artifacts ra WHERE ra.org_id=i.org_id AND ra.inspection_id=i.id AND ra.status='failed')) AS "deliveryProblems",((SELECT count(*) FROM processing_jobs j WHERE j.org_id=i.org_id AND j.inspection_id=i.id AND j.status='failed')+(SELECT count(*) FROM scope_jobs sj WHERE sj.org_id=i.org_id AND sj.inspection_id=i.id AND sj.status='failed')+(SELECT count(*) FROM transcription_jobs tj WHERE tj.org_id=i.org_id AND tj.inspection_id=i.id AND tj.status='failed')) AS "processingFailures" FROM inspections i LEFT JOIN inspection_measurements m ON m.org_id=i.org_id AND m.inspection_id=i.id WHERE i.org_id=$1 ORDER BY i.created_at DESC`, r.PathValue("org"))
	if err != nil {
		return err
	}
	send(w, 200, map[string]any{"rows": json.RawMessage(rows), "generatedAt": time.Now().UTC(), "measurement": "Handmatig gemeten actieve minuten; wachttijd afzonderlijk registreren."})
	return nil
}
