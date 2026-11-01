package app

import (
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/url"
	"strings"
	"time"
)

func (a *app) mobileLoginStart(w http.ResponseWriter, r *http.Request) error {
	if !a.limiter.allow("mobile-login:" + clientIP(r)) {
		return fail(429, "Probeer later opnieuw")
	}
	var in struct {
		Challenge string `json:"challenge"`
		State     string `json:"state"`
	}
	if err := readJSON(w, r, &in); err != nil {
		return err
	}
	challenge, err := base64.RawURLEncoding.DecodeString(in.Challenge)
	if err != nil || len(challenge) != 32 || len(in.State) < 32 || len(in.State) > 128 {
		return fail(422, "Ongeldige appaanmelding")
	}
	request := token()
	if _, err = a.db.Exec(r.Context(), `INSERT INTO mobile_login_requests(token_hash,challenge,state,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')`, hash(request), in.Challenge, in.State); err != nil {
		return err
	}
	send(w, 200, map[string]string{"url": a.origin + "/app?mobileRequest=" + url.QueryEscape(request)})
	return nil
}
func (a *app) mobileLoginAuthorize(w http.ResponseWriter, r *http.Request) error {
	u, err := a.user(r)
	if err != nil {
		return err
	}
	var in struct {
		Request string `json:"request"`
	}
	if err = readJSON(w, r, &in); err != nil {
		return err
	}
	if len(in.Request) != 64 {
		return fail(422, "Ongeldige aanmelding")
	}
	code := token()
	var state string
	if err = a.db.QueryRow(r.Context(), `UPDATE mobile_login_requests SET code_hash=$2,user_id=$3,authorised_at=now() WHERE token_hash=$1 AND expires_at>now() AND authorised_at IS NULL RETURNING state`, hash(in.Request), hash(code), u.ID).Scan(&state); err != nil {
		return fail(409, "Deze appaanmelding is verlopen of al gebruikt")
	}
	send(w, 200, map[string]string{"url": "nl.satvey.inspect://auth/callback?code=" + url.QueryEscape(code) + "&state=" + url.QueryEscape(state)})
	return nil
}
func (a *app) mobileLoginExchange(w http.ResponseWriter, r *http.Request) error {
	if !a.limiter.allow("mobile-exchange:" + clientIP(r)) {
		return fail(429, "Probeer later opnieuw")
	}
	var in struct {
		Code     string `json:"code"`
		Verifier string `json:"verifier"`
	}
	if err := readJSON(w, r, &in); err != nil {
		return err
	}
	if len(in.Code) != 64 || len(in.Verifier) < 43 || len(in.Verifier) > 128 {
		return fail(422, "Ongeldige appaanmelding")
	}
	sum := sha256.Sum256([]byte(in.Verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	var uid string
	if err = tx.QueryRow(r.Context(), `UPDATE mobile_login_requests SET consumed_at=now() WHERE code_hash=$1 AND challenge=$2 AND consumed_at IS NULL AND expires_at>now() AND authorised_at>now()-interval '2 minutes' RETURNING user_id`, hash(in.Code), challenge).Scan(&uid); err != nil {
		return fail(401, "De appaanmelding is verlopen of ongeldig")
	}
	session := token()
	expires := time.Now().UTC().Add(30 * 24 * time.Hour)
	if _, err = tx.Exec(r.Context(), `INSERT INTO sessions(token_hash,user_id,expires_at,kind) VALUES($1,$2,$3,'native')`, hash(session), uid, expires); err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	send(w, 200, map[string]any{"token": session, "expiresAt": expires, "userId": uid})
	return nil
}
func (a *app) offlineGrant(w http.ResponseWriter, r *http.Request) error {
	u, _, err := a.access(r, false)
	if err != nil {
		return err
	}
	var hours int
	if err = a.db.QueryRow(r.Context(), `SELECT offline_hours FROM organisations WHERE id=$1`, r.PathValue("org")).Scan(&hours); err != nil {
		return err
	}
	send(w, 200, map[string]any{"userId": u.ID, "orgId": r.PathValue("org"), "authorizedAt": time.Now().UTC(), "expiresAt": time.Now().UTC().Add(time.Duration(hours) * time.Hour)})
	return nil
}
func (a *app) offlineSettings(w http.ResponseWriter, r *http.Request) error {
	if _, err := a.admin(r); err != nil {
		return err
	}
	if r.Method == "GET" {
		var hours, version int
		if err := a.db.QueryRow(r.Context(), `SELECT offline_hours,settings_version FROM organisations WHERE id=$1`, r.PathValue("org")).Scan(&hours, &version); err != nil {
			return err
		}
		send(w, 200, map[string]int{"hours": hours, "version": version})
		return nil
	}
	var in struct {
		Hours   int `json:"hours"`
		Version int `json:"version"`
	}
	if err := readJSON(w, r, &in); err != nil {
		return err
	}
	if in.Hours < 1 || in.Hours > 168 {
		return fail(422, "Kies 1 tot 168 uur")
	}
	tag, err := a.db.Exec(r.Context(), `UPDATE organisations SET offline_hours=$2,settings_version=settings_version+1 WHERE id=$1 AND settings_version=$3`, r.PathValue("org"), in.Hours, in.Version)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return fail(409, "Instellingen gewijzigd; herlaad de nieuwste versie")
	}
	send(w, 200, map[string]int{"version": in.Version + 1})
	return nil
}
func sessionCredential(r *http.Request) (string, string) {
	if authorization := r.Header.Get("Authorization"); strings.HasPrefix(authorization, "Bearer ") {
		return strings.TrimPrefix(authorization, "Bearer "), "native"
	}
	if cookie, err := r.Cookie("satvey_session"); err == nil {
		return cookie.Value, "web"
	}
	return "", "web"
}
