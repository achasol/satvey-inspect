package app

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"satvey/inspect/internal/maildelivery"
	"satvey/inspect/internal/secrets"

	"github.com/jackc/pgx/v5"
)

func (a *app) queueMail(ctx context.Context, tx pgx.Tx, org, invitation, user, purpose string, m maildelivery.Message) (string, error) {
	if os.Getenv("SMTP_ADDR") == "" && a.deliver == nil {
		return "manual", nil
	}
	jid := m.ID
	if jid == "" {
		jid = id()
	}
	body, e := json.Marshal(m)
	if e != nil {
		return "", e
	}
	encrypted, e := secrets.Encrypt(os.Getenv("APP_ENCRYPTION_KEY"), "mail:"+jid, string(body))
	if e != nil {
		return "", e
	}
	_, e = tx.Exec(ctx, `INSERT INTO mail_jobs(id,org_id,invitation_id,user_id,purpose,payload) VALUES($1,$2,$3,$4,$5,$6)`, jid, nullableID(org), nullableID(invitation), nullableID(user), purpose, encrypted)
	return "pending", e
}

func (a *app) forgotPassword(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Email string `json:"email"`
	}
	if e := readJSON(w, r, &in); e != nil {
		return e
	}
	in.Email = strings.ToLower(strings.TrimSpace(in.Email))
	if !a.limiter.allow("forgot-ip:"+clientIP(r)) || !a.limiter.allow("forgot-account:"+hash(in.Email)) {
		return fail(429, "Te veel aanvragen. Probeer later opnieuw.")
	}
	if !validEmail(in.Email) {
		return fail(400, "Vul een geldig e-mailadres in")
	}
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	var uid string
	// An SSO-only account cannot gain a password through the recovery endpoint.
	e = tx.QueryRow(r.Context(), `SELECT id FROM users WHERE email=$1 AND COALESCE(password_hash,'')<>'' FOR UPDATE`, in.Email).Scan(&uid)
	if e != nil && e != pgx.ErrNoRows {
		return e
	}
	if e == nil {
		t := token()
		for _, statement := range []string{`DELETE FROM password_resets WHERE user_id=$1`, `UPDATE mail_jobs SET status='cancelled',payload='',run_token=NULL WHERE user_id=$1 AND purpose='password_reset' AND status IN ('pending','processing','failed')`} {
			if _, e = tx.Exec(r.Context(), statement, uid); e != nil {
				return e
			}
		}
		if _, e = tx.Exec(r.Context(), `INSERT INTO password_resets(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')`, hash(t), uid); e != nil {
			return e
		}
		if _, e = a.queueMail(r.Context(), tx, "", "", uid, "password_reset", maildelivery.Message{To: in.Email, Subject: "Satvey: wachtwoord herstellen", Text: "Open deze link om je wachtwoord te herstellen. De link is een uur geldig en werkt een keer.\n\n" + a.origin + "/reset-password#token=" + t + "\n\nHeb je dit niet aangevraagd? Dan kun je dit bericht negeren."}); e != nil {
			return e
		}
		if _, e = tx.Exec(r.Context(), `INSERT INTO security_events(user_id,action) VALUES($1,'password_reset_requested')`, uid); e != nil {
			return e
		}
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	send(w, 202, map[string]bool{"ok": true})
	return nil
}

func (a *app) resetPassword(w http.ResponseWriter, r *http.Request) error {
	if !a.limiter.allow("reset-ip:" + clientIP(r)) {
		return fail(429, "Te veel aanvragen")
	}
	var in struct {
		Token    string `json:"token"`
		Password string `json:"password"`
	}
	if e := readJSON(w, r, &in); e != nil {
		return e
	}
	if len(in.Token) != 64 {
		return fail(400, "Herstellink verlopen of al gebruikt")
	}
	release, e := acquireHash(r.Context())
	if e != nil {
		return e
	}
	defer release()
	h, e := passwordHash(in.Password)
	if e != nil {
		return e
	}
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	var uid string
	if e = tx.QueryRow(r.Context(), `SELECT user_id FROM password_resets WHERE token_hash=$1 AND expires_at>now()`, hash(in.Token)).Scan(&uid); e != nil {
		if e == pgx.ErrNoRows {
			return fail(400, "Herstellink verlopen of al gebruikt")
		}
		return e
	}
	var locked string
	if e = tx.QueryRow(r.Context(), `SELECT id FROM users WHERE id=$1 FOR UPDATE`, uid).Scan(&locked); e != nil {
		return e
	}
	tag, e := tx.Exec(r.Context(), `DELETE FROM password_resets WHERE token_hash=$1 AND expires_at>now()`, hash(in.Token))
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return fail(400, "Herstellink verlopen of al gebruikt")
	}
	if _, e = tx.Exec(r.Context(), `UPDATE users SET password_hash=$1 WHERE id=$2`, h, uid); e != nil {
		return e
	}
	for _, statement := range []string{`DELETE FROM sessions WHERE user_id=$1`, `DELETE FROM password_resets WHERE user_id=$1`, `UPDATE mail_jobs SET status='cancelled',payload='',run_token=NULL WHERE user_id=$1 AND purpose='password_reset' AND status IN ('pending','processing','failed')`, `INSERT INTO security_events(user_id,action) VALUES($1,'password_reset_completed')`} {
		if _, e = tx.Exec(r.Context(), statement, uid); e != nil {
			return e
		}
	}

	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	http.SetCookie(w, &http.Cookie{Name: "satvey_session", Value: "", Path: "/", MaxAge: -1, HttpOnly: true, Secure: a.secure, SameSite: http.SameSiteLaxMode})
	send(w, 200, map[string]bool{"ok": true})
	return nil
}

func (a *app) invitationsList(w http.ResponseWriter, r *http.Request) error {
	if _, e := a.admin(r); e != nil {
		return e
	}
	out, e := list(r.Context(), a.db, `SELECT i.id,i.email,i.role_id AS "roleId",i.expires_at AS "expiresAt",COALESCE((SELECT m.status FROM mail_jobs m WHERE m.invitation_id=i.id ORDER BY created_at DESC LIMIT 1),'manual') AS delivery FROM invitations i WHERE org_id=$1 AND accepted_at IS NULL ORDER BY expires_at DESC LIMIT 100`, r.PathValue("org"))
	if e != nil {
		return e
	}
	send(w, 200, out)
	return nil
}
func (a *app) resendInvitation(w http.ResponseWriter, r *http.Request) error {
	u, e := a.admin(r)
	if e != nil {
		return e
	}
	if !a.limiter.allow("resend:" + u.ID) {
		return fail(429, "Te veel aanvragen")
	}
	org, iid := r.PathValue("org"), r.PathValue("invitation")
	if !validID(iid) {
		return fail(404, "Uitnodiging niet gevonden")
	}
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	var email string
	if e = tx.QueryRow(r.Context(), `SELECT email FROM invitations WHERE id=$1 AND org_id=$2 AND accepted_at IS NULL FOR UPDATE`, iid, org).Scan(&email); e != nil {
		return e
	}
	t := token()
	if _, e = tx.Exec(r.Context(), `UPDATE mail_jobs SET status='cancelled',payload='',run_token=NULL WHERE invitation_id=$1 AND status IN ('pending','processing','failed')`, iid); e != nil {
		return e
	}
	if _, e = tx.Exec(r.Context(), `UPDATE invitations SET token_hash=$1,expires_at=now()+interval '7 days' WHERE id=$2`, hash(t), iid); e != nil {
		return e
	}
	delivery, e := a.queueMail(r.Context(), tx, org, iid, "", "invitation", maildelivery.Message{To: email, Subject: "Satvey: uitnodiging", Text: "Je bent uitgenodigd voor Satvey. Deze link is 7 dagen geldig:\n\n" + a.origin + "/invite?token=" + t})
	if e != nil {
		return e
	}
	if _, e = tx.Exec(r.Context(), `INSERT INTO security_events(org_id,user_id,action) VALUES($1,$2,'invitation_resent')`, org, u.ID); e != nil {
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	send(w, 200, map[string]string{"id": iid, "url": a.origin + "/invite?token=" + t, "delivery": delivery})
	return nil
}

func (a *app) mailWorker(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if e := a.processMail(ctx); e != nil && ctx.Err() == nil {
				slog.Error("mail worker failed; job retained")
			}
		}
	}
}
func (a *app) processMail(ctx context.Context) error {
	// A crash after DATA may already have delivered a report. Require an explicit
	// operator resend rather than silently producing another attachment email.
	if _, err := a.db.Exec(ctx, `UPDATE mail_jobs SET status='failed',last_error='Verzending onzeker: controleer de verzending voordat je opnieuw verstuurt',run_token=NULL,lease_until=NULL WHERE purpose='inspection_report' AND status='processing' AND lease_until<now() AND ($1::uuid IS NULL OR org_id=$1)`, nullableID(a.workerOrg)); err != nil {
		return err
	}
	var jid, payload, run string
	var attempts int
	run = id()
	e := a.db.QueryRow(ctx, `UPDATE mail_jobs SET status='processing',run_token=$1,lease_until=now()+interval '1 minute',attempts=attempts+1 WHERE id=(SELECT id FROM mail_jobs WHERE ($2::uuid IS NULL OR org_id=$2 OR user_id=$3) AND ((status='pending' AND next_attempt_at<=now()) OR (status='processing' AND lease_until<now())) ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id,payload,attempts`, run, nullableID(a.workerOrg), nullableID(a.workerUser)).Scan(&jid, &payload, &attempts)
	if e == pgx.ErrNoRows {
		return nil
	}
	if e != nil {
		return e
	}
	plain, e := secrets.Decrypt(os.Getenv("APP_ENCRYPTION_KEY"), "mail:"+jid, payload)
	var m maildelivery.Message
	if e == nil {
		e = json.Unmarshal([]byte(plain), &m)
	}
	if e == nil {
		c, cancel := context.WithTimeout(ctx, 25*time.Second)
		if a.deliver != nil {
			e = a.deliver(c, m)
		} else {
			e = (maildelivery.Config{Address: os.Getenv("SMTP_ADDR"), From: os.Getenv("SMTP_FROM"), Username: os.Getenv("SMTP_USERNAME"), Password: os.Getenv("SMTP_PASSWORD"), TLS: env("SMTP_TLS", "none")}).Send(c, m)
		}
		cancel()
	}
	status, message := "done", ""
	if e != nil {
		status = "pending"
		message = "E-mail tijdelijk niet bezorgd. Controleer de SMTP-configuratie."
		if strings.Contains(fmt.Sprint(e), "delivery uncertain") {
			status = "failed"
			message = "Verzending onzeker: controleer de verzending voordat je opnieuw verstuurt"
		}
		if attempts >= 5 {
			status = "failed"
		}
	}
	// Delivery can repeat after a crash; the linked credentials themselves are single-use.
	_, err := a.db.Exec(ctx, `UPDATE mail_jobs SET status=$1,last_error=$2,payload=CASE WHEN $1='done' THEN '' ELSE payload END,finished_at=CASE WHEN $1='done' THEN now() ELSE NULL END,run_token=NULL,lease_until=NULL,next_attempt_at=now()+($3*interval '30 seconds') WHERE id=$4 AND status='processing' AND run_token=$5`, status, message, attempts*attempts, jid, run)
	return err
}

func (a *app) convertSSOSecrets(ctx context.Context) error {
	tx, e := a.db.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(8273652)`); e != nil {
		return e
	}
	rows, e := tx.Query(ctx, `SELECT id,oidc_client_secret FROM organisations WHERE oidc_client_secret<>'' FOR UPDATE`)
	if e != nil {
		return e
	}
	type item struct{ id, plain string }
	var items []item
	for rows.Next() {
		var i item
		if e = rows.Scan(&i.id, &i.plain); e != nil {
			rows.Close()
			return e
		}
		items = append(items, i)
	}
	rows.Close()
	if e = rows.Err(); e != nil {
		return e
	}
	for _, i := range items {
		encrypted, e := secrets.Encrypt(os.Getenv("APP_ENCRYPTION_KEY"), "oidc:"+i.id, i.plain)
		if e != nil {
			return fmt.Errorf("APP_ENCRYPTION_KEY required to convert existing SSO secrets")
		}
		if _, e = tx.Exec(ctx, `UPDATE organisations SET oidc_client_secret_encrypted=$1,oidc_client_secret='' WHERE id=$2`, encrypted, i.id); e != nil {
			return e
		}
	}
	return tx.Commit(ctx)
}

func (a *app) rotateSecrets(ctx context.Context) error {
	oldKey, newKey := os.Getenv("APP_ENCRYPTION_KEY"), os.Getenv("APP_ENCRYPTION_KEY_NEW")
	if _, e := secrets.Encrypt(newKey, "rotation", "check"); e != nil {
		return e
	}
	tx, e := a.db.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(8273652)`); e != nil {
		return e
	}
	for _, spec := range []struct{ query, update, prefix string }{{`SELECT id,oidc_client_secret_encrypted FROM organisations WHERE oidc_client_secret_encrypted<>'' FOR UPDATE`, `UPDATE organisations SET oidc_client_secret_encrypted=$1 WHERE id=$2`, "oidc:"}, {`SELECT id,payload FROM mail_jobs WHERE payload<>'' FOR UPDATE`, `UPDATE mail_jobs SET payload=$1 WHERE id=$2`, "mail:"}} {
		rows, e := tx.Query(ctx, spec.query)
		if e != nil {
			return e
		}
		type item struct{ id, encrypted string }
		var items []item
		for rows.Next() {
			var i item
			if e = rows.Scan(&i.id, &i.encrypted); e != nil {
				rows.Close()
				return e
			}
			items = append(items, i)
		}
		rows.Close()
		if e = rows.Err(); e != nil {
			return e
		}
		for _, i := range items {
			plain, e := secrets.Decrypt(oldKey, spec.prefix+i.id, i.encrypted)
			if e != nil {
				return e
			}
			encrypted, e := secrets.Encrypt(newKey, spec.prefix+i.id, plain)
			if e != nil {
				return e
			}
			if _, e = tx.Exec(ctx, spec.update, encrypted, i.id); e != nil {
				return e
			}
		}
	}
	return tx.Commit(ctx)
}

// Validate restored/deployed keys before starting any worker or accepting writes.
func (a *app) checkStoredSecrets(ctx context.Context) error {
	var plaintext bool
	if e := a.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM organisations WHERE oidc_client_secret<>'')`).Scan(&plaintext); e != nil {
		return e
	}
	if plaintext {
		return fmt.Errorf("run migrations to convert legacy SSO secrets before serving")
	}
	rows, e := a.db.Query(ctx, `SELECT 'oidc:'||id::text,oidc_client_secret_encrypted FROM organisations WHERE oidc_client_secret_encrypted<>'' UNION ALL SELECT 'mail:'||id::text,payload FROM mail_jobs WHERE payload<>''`)
	if e != nil {
		return e
	}
	for rows.Next() {
		var purpose, encrypted string
		if e = rows.Scan(&purpose, &encrypted); e != nil {
			rows.Close()
			return e
		}
		if _, e = secrets.Decrypt(os.Getenv("APP_ENCRYPTION_KEY"), purpose, encrypted); e != nil {
			rows.Close()
			return fmt.Errorf("APP_ENCRYPTION_KEY cannot decrypt existing secrets")
		}
	}
	rows.Close()
	if e = rows.Err(); e != nil {
		return e
	}
	rows, e = a.db.Query(ctx, `SELECT org_id,id::text,secret FROM property_sources WHERE secret<>'' UNION ALL SELECT org_id,'handover:'||id::text,secret FROM handover_destinations WHERE secret<>''`)
	if e != nil {
		return e
	}
	defer rows.Close()
	for rows.Next() {
		var org, source, encrypted string
		if e = rows.Scan(&org, &source, &encrypted); e != nil {
			return e
		}
		if _, e = decryptPropertySecret(encrypted, org, source); e != nil {
			return fmt.Errorf("PROPERTY_ENCRYPTION_KEY cannot decrypt existing source credentials")
		}
	}
	return rows.Err()
}
