package app

import (
	"net/http"
	"os"
	"strings"
)

func (a *app) publicInformation(w http.ResponseWriter, r *http.Request) error {
	send(w, 200, map[string]string{"app": "Satvey Inspect", "entity": os.Getenv("LEGAL_ENTITY"), "supportEmail": os.Getenv("SUPPORT_EMAIL"), "privacyURL": os.Getenv("PRIVACY_POLICY_URL"), "hostingRegion": os.Getenv("HOSTING_REGION")})
	return nil
}
func (a *app) deleteAccount(w http.ResponseWriter, r *http.Request) error {
	u, err := a.user(r)
	if err != nil {
		return err
	}
	var in struct {
		Confirmation string `json:"confirmation"`
	}
	if err = readJSON(w, r, &in); err != nil {
		return err
	}
	if in.Confirmation != u.Email {
		return fail(422, "Bevestig de accountverwijdering met je e-mailadres")
	}
	credential, kind := sessionCredential(r)
	var recent bool
	if err = a.db.QueryRow(r.Context(), `SELECT expires_at>now()+CASE WHEN kind='native' THEN interval '30 days' ELSE interval '24 hours' END-interval '10 minutes' FROM sessions WHERE token_hash=$1 AND kind=$2`, hash(credential), kind).Scan(&recent); err != nil {
		return err
	}
	if !recent {
		return fail(401, "Meld je opnieuw aan voordat je het account verwijdert")
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	// Lock organisations in a stable order, matching role/member administration.
	rows, err := tx.Query(r.Context(), `SELECT o.id FROM organisations o JOIN memberships m ON m.org_id=o.id WHERE m.user_id=$1 ORDER BY o.id FOR UPDATE OF o`, u.ID)
	if err != nil {
		return err
	}
	for rows.Next() {
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	var lastAdmin bool
	if err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM memberships m JOIN organisation_roles ro ON ro.id=m.role_id AND ro.org_id=m.org_id WHERE m.user_id=$1 AND 'settings.manage'=ANY(ro.privileges) AND NOT EXISTS(SELECT 1 FROM memberships other JOIN organisation_roles role ON role.id=other.role_id AND role.org_id=other.org_id WHERE other.org_id=m.org_id AND other.user_id<>$1 AND 'settings.manage'=ANY(role.privileges)))`, u.ID).Scan(&lastAdmin); err != nil {
		return err
	}
	if lastAdmin {
		return fail(422, "Draag eerst het organisatiebeheer over aan een andere beheerder")
	}
	for _, sql := range []string{
		`INSERT INTO account_deletion_requests(id,user_id,status,completed_at) VALUES(gen_random_uuid(),$1,'completed',now())`,
		`DELETE FROM sessions WHERE user_id=$1`, `DELETE FROM identities WHERE user_id=$1`, `DELETE FROM password_resets WHERE user_id=$1`,
		`UPDATE mail_jobs SET status='cancelled',payload='' WHERE user_id=$1 AND purpose IN ('password_reset','invitation')`,
		`DELETE FROM memberships WHERE user_id=$1`,
		`UPDATE users SET email='deleted+'||id::text||'@satvey.invalid',name='Verwijderd account',password_hash=NULL WHERE id=$1`,
		`INSERT INTO security_events(user_id,action) VALUES($1,'account_deleted')`,
	} {
		if _, err = tx.Exec(r.Context(), sql, u.ID); err != nil {
			return err
		}
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	send(w, 200, map[string]string{"status": "deleted", "note": "Het account en de aanmeldgegevens zijn verwijderd. Corporatiedossiers en historische rapporten volgen het afgesproken bewaarbeleid."})
	return nil
}

func (a *app) organisationExit(w http.ResponseWriter, r *http.Request) error {
	if _, err := a.admin(r); err != nil {
		return err
	}
	// Stream the export to disk so a large tenant cannot exhaust API memory.
	return a.exportOrganisation(w, r, strings.TrimSpace(r.PathValue("org")))
}
