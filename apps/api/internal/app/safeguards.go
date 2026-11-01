package app

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
)

func setActor(ctx context.Context, tx pgx.Tx, user string) error {
	_, err := tx.Exec(ctx, `SELECT set_config('satvey.actor_id',$1,true)`, user)
	return err
}

func recordEvent(ctx context.Context, tx pgx.Tx, org, inspection, user, action string, detail any) error {
	raw, err := json.Marshal(detail)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO inspection_events(org_id,inspection_id,actor_id,action,detail) VALUES($1,$2,$3,$4,$5)`, org, inspection, nullableID(user), action, raw)
	return err
}

type dossierAction struct {
	Reason  string `json:"reason"`
	Version int    `json:"version"`
}

func readDossierAction(w http.ResponseWriter, r *http.Request) (dossierAction, error) {
	var in dossierAction
	if err := readJSON(w, r, &in); err != nil {
		return in, err
	}
	in.Reason = strings.TrimSpace(in.Reason)
	if in.Reason == "" || len(in.Reason) > 2000 || in.Version < 1 {
		return in, fail(422, "Geef een reden en de actuele dossierversie op")
	}
	return in, nil
}

func (a *app) archiveInspection(w http.ResponseWriter, r *http.Request) error {
	u, _, err := a.require(r, "inspections.read")
	if err != nil {
		return err
	}
	in, err := readDossierAction(w, r)
	if err != nil {
		return err
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
	var status string
	var version int
	var archived bool
	if err = tx.QueryRow(r.Context(), `SELECT status,revision,archived_at IS NOT NULL FROM inspections WHERE id=$1 AND org_id=$2 FOR UPDATE`, iid, org).Scan(&status, &version, &archived); err != nil {
		return err
	}
	restore := r.PathValue("action") == "restore" || strings.HasSuffix(r.URL.Path, "/restore")
	if restore || status == "final" {
		if _, _, err = a.require(r, "inspections.archive"); err != nil {
			return err
		}
	} else if _, _, err = a.access(r, true); err != nil {
		return err
	}
	if in.Version != version {
		return fail(409, "Het dossier is gewijzigd. Herlaad de nieuwste versie.")
	}
	if restore == !archived {
		send(w, 200, map[string]int{"version": version})
		return nil
	}
	var active bool
	if err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM handover_deliveries WHERE org_id=$1 AND inspection_id=$2 AND status NOT IN ('accepted','manual'))`, org, iid).Scan(&active); err != nil {
		return err
	}
	if active && !restore {
		return fail(409, "Rond eerst de actieve overdracht af")
	}
	action := "archived"
	if restore {
		action = "restored"
		_, err = tx.Exec(r.Context(), `UPDATE inspections SET archived_at=NULL,archived_by=NULL,archive_reason='',revision=revision+1 WHERE id=$1 AND org_id=$2`, iid, org)
	} else {
		_, err = tx.Exec(r.Context(), `UPDATE inspections SET archived_at=now(),archived_by=$3,archive_reason=$4,revision=revision+1 WHERE id=$1 AND org_id=$2`, iid, org, u.ID, in.Reason)
	}
	if err != nil {
		return err
	}
	if err = recordEvent(r.Context(), tx, org, iid, u.ID, action, map[string]string{"reason": in.Reason}); err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	send(w, 200, map[string]int{"version": version + 1})
	return nil
}

func (a *app) inspectionHistory(w http.ResponseWriter, r *http.Request) error {
	if _, _, err := a.access(r, false); err != nil {
		return err
	}
	if !validID(r.PathValue("inspection")) {
		return fail(404, "Inspectie niet gevonden")
	}
	out, err := list(r.Context(), a.db, `SELECT e.id,e.action,e.detail,e.created_at AS "createdAt",COALESCE(u.name,'Systeem') AS actor FROM inspection_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.org_id=$1 AND e.inspection_id=$2 ORDER BY e.id DESC LIMIT 250`, r.PathValue("org"), r.PathValue("inspection"))
	if err != nil {
		return err
	}
	send(w, 200, out)
	return nil
}
