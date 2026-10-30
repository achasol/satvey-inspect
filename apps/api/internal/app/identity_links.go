package app

import (
	"net/http"
)

func (a *app) identityLinkInfo(w http.ResponseWriter, r *http.Request) error {
	c, e := r.Cookie("satvey_link")
	if e != nil {
		return fail(400, "SSO-koppeling verlopen")
	}
	var email string
	e = a.db.QueryRow(r.Context(), "SELECT u.email FROM identity_links l JOIN users u ON u.id=l.user_id WHERE l.token_hash=$1 AND l.expires_at>now()", hash(c.Value)).Scan(&email)
	if e != nil {
		return fail(400, "SSO-koppeling verlopen")
	}
	send(w, 200, map[string]string{"email": email})
	return nil
}
func (a *app) completeIdentityLink(w http.ResponseWriter, r *http.Request) error {
	ip := clientIP(r)
	if !a.limiter.allow("link:" + ip) {
		return fail(429, "Te veel pogingen. Probeer later opnieuw.")
	}
	c, e := r.Cookie("satvey_link")
	if e != nil {
		return fail(400, "SSO-koppeling verlopen")
	}
	var in struct {
		Password string `json:"password"`
	}
	if e = readJSON(w, r, &in); e != nil {
		return e
	}
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	var uid, issuer, subject, h string
	e = tx.QueryRow(r.Context(), "SELECT l.user_id,l.issuer,l.subject,u.password_hash FROM identity_links l JOIN users u ON u.id=l.user_id WHERE l.token_hash=$1 AND l.expires_at>now() FOR UPDATE OF l", hash(c.Value)).Scan(&uid, &issuer, &subject, &h)
	if e != nil {
		return fail(400, "SSO-koppeling verlopen")
	}
	release, err := acquireHash(r.Context())
	if err != nil {
		return err
	}
	defer release()
	if !passwordMatches(h, in.Password) {
		return fail(401, "Wachtwoord onjuist")
	}
	tag, e := tx.Exec(r.Context(), "INSERT INTO identities(issuer,subject,user_id) VALUES($1,$2,$3) ON CONFLICT(issuer,subject) DO UPDATE SET user_id=identities.user_id WHERE identities.user_id=EXCLUDED.user_id", issuer, subject, uid)
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return fail(409, "SSO-identiteit is al aan een ander account gekoppeld")
	}
	if _, e = tx.Exec(r.Context(), "DELETE FROM identity_links WHERE token_hash=$1", hash(c.Value)); e != nil {
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	if e = a.newSession(w, r, uid); e != nil {
		return e
	}
	http.SetCookie(w, &http.Cookie{Name: "satvey_link", Value: "", Path: "/api/v1/auth/oidc/link", MaxAge: -1, HttpOnly: true, Secure: a.secure, SameSite: http.SameSiteLaxMode})
	send(w, 200, map[string]bool{"ok": true})
	return nil
}
