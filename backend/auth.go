package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/argon2"
	"golang.org/x/oauth2"
)

type oidcBackchannel struct{ base, public *url.URL }

func (t oidcBackchannel) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Scheme == t.public.Scheme && r.URL.Host == t.public.Host {
		clone := r.Clone(r.Context())
		u := *r.URL
		u.Scheme = t.base.Scheme
		u.Host = t.base.Host
		clone.URL = &u
		clone.Host = ""
		r = clone
	}
	return http.DefaultTransport.RoundTrip(r)
}
func (a *app) oidcContext(ctx context.Context) context.Context {
	public, _ := url.Parse(os.Getenv("OIDC_PUBLIC_ISSUER"))
	base, _ := url.Parse(os.Getenv("OIDC_INTERNAL_BASE_URL"))
	if public != nil && base != nil && public.Host != "" && base.Host != "" {
		return oidc.ClientContext(ctx, &http.Client{Transport: oidcBackchannel{base: base, public: public}, Timeout: 20 * time.Second})
	}
	return ctx
}

type principal struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Name  string `json:"name"`
}
type membership struct {
	ID         string   `json:"id"`
	Slug       string   `json:"slug"`
	Name       string   `json:"name"`
	Role       string   `json:"role"`
	RoleID     string   `json:"roleId"`
	RoleName   string   `json:"roleName"`
	Privileges []string `json:"privileges"`
}
type loginLimiter struct {
	sync.Mutex
	entries map[string][]time.Time
}

func (l *loginLimiter) reset(key string) { l.Lock(); defer l.Unlock(); delete(l.entries, key) }

func (l *loginLimiter) allow(key string) bool {
	l.Lock()
	defer l.Unlock()
	if l.entries == nil {
		l.entries = map[string][]time.Time{}
	}
	now := time.Now()
	if len(l.entries) > 10000 {
		for k, v := range l.entries {
			if len(v) == 0 || now.Sub(v[len(v)-1]) > 15*time.Minute {
				delete(l.entries, k)
			}
		}
	}
	var recent []time.Time
	for _, t := range l.entries[key] {
		if now.Sub(t) < 15*time.Minute {
			recent = append(recent, t)
		}
	}
	if len(recent) >= 15 {
		return false
	}
	l.entries[key] = append(recent, now)
	return true
}
func passwordHash(password string) (string, error) {
	if len(password) < 12 || len(password) > 256 {
		return "", fail(400, "Gebruik een wachtwoord van 12 tot 256 tekens")
	}
	salt := make([]byte, 16)
	if _, e := rand.Read(salt); e != nil {
		return "", e
	}
	key := argon2.IDKey([]byte(password), salt, 2, 64*1024, 2, 32)
	return base64.RawStdEncoding.EncodeToString(salt) + ":" + base64.RawStdEncoding.EncodeToString(key), nil
}
func passwordMatches(encoded, password string) bool {
	parts := strings.Split(encoded, ":")
	if len(parts) != 2 || len(password) > 256 {
		return false
	}
	salt, e := base64.RawStdEncoding.DecodeString(parts[0])
	if e != nil || len(salt) != 16 {
		return false
	}
	key, e := base64.RawStdEncoding.DecodeString(parts[1])
	if e != nil || len(key) != 32 {
		return false
	}
	actual := argon2.IDKey([]byte(password), salt, 2, 64*1024, 2, 32)
	return subtle.ConstantTimeCompare(key, actual) == 1
}
func validEmail(s string) bool {
	return len(s) <= 254 && strings.Count(s, "@") == 1 && !strings.ContainsAny(s, " \r\n\t") && strings.Index(s, "@") > 0 && strings.Index(s, "@") < len(s)-1
}
func (a *app) user(r *http.Request) (principal, error) {
	var u principal
	c, e := r.Cookie("satvey_session")
	if e != nil {
		return u, fail(401, "Log in om verder te gaan")
	}
	e = a.db.QueryRow(r.Context(), "SELECT u.id,u.email,u.name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()", hash(c.Value)).Scan(&u.ID, &u.Email, &u.Name)
	if e != nil {
		return u, fail(401, "Log opnieuw in")
	}
	return u, nil
}
func (a *app) access(r *http.Request, write bool) (principal, string, error) {
	p := "inspections.read"
	if write {
		p = "inspections.write"
	}
	return a.require(r, p)
}
func (a *app) admin(r *http.Request) (principal, error) {
	u, _, e := a.require(r, "settings.manage")
	return u, e
}
func (a *app) newSession(w http.ResponseWriter, r *http.Request, userID string) error {
	t := token()
	_, e := a.db.Exec(r.Context(), "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '24 hours')", hash(t), userID)
	if e != nil {
		return e
	}
	http.SetCookie(w, &http.Cookie{Name: "satvey_session", Value: t, Path: "/", HttpOnly: true, Secure: a.secure, SameSite: http.SameSiteLaxMode, MaxAge: 86400})
	return nil
}
func (a *app) login(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if e := readJSON(w, r, &in); e != nil {
		return e
	}
	ip, _, _ := net.SplitHostPort(r.RemoteAddr)
	limitKey := ip + ":" + hash(strings.ToLower(strings.TrimSpace(in.Email)))
	if !a.limiter.allow(limitKey) {
		return fail(429, "Te veel pogingen. Probeer over 15 minuten opnieuw.")
	}
	var uid, encoded string
	e := a.db.QueryRow(r.Context(), "SELECT id,COALESCE(password_hash,'') FROM users WHERE email=$1", strings.ToLower(strings.TrimSpace(in.Email))).Scan(&uid, &encoded)
	if e != nil || encoded == "" {
		encoded = "MDAwMDAwMDAwMDAwMDAwMA:MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA"
	}
	matches := passwordMatches(encoded, in.Password)
	if e != nil || !matches {
		return fail(401, "E-mailadres of wachtwoord onjuist")
	}
	a.limiter.reset(limitKey)
	if e = a.newSession(w, r, uid); e != nil {
		return e
	}
	send(w, 200, map[string]bool{"ok": true})
	return nil
}
func (a *app) logout(w http.ResponseWriter, r *http.Request) error {
	if c, e := r.Cookie("satvey_session"); e == nil {
		if _, e = a.db.Exec(r.Context(), "DELETE FROM sessions WHERE token_hash=$1", hash(c.Value)); e != nil {
			return e
		}
	}
	http.SetCookie(w, &http.Cookie{Name: "satvey_session", Value: "", Path: "/", HttpOnly: true, Secure: a.secure, SameSite: http.SameSiteLaxMode, MaxAge: -1})
	send(w, 200, map[string]bool{"ok": true})
	return nil
}
func (a *app) me(w http.ResponseWriter, r *http.Request) error {
	u, e := a.user(r)
	if e != nil {
		return e
	}
	rows, e := a.db.Query(r.Context(), "SELECT o.id,o.slug,o.name,m.role,ro.id,ro.name,ro.privileges FROM memberships m JOIN organisations o ON o.id=m.org_id JOIN organisation_roles ro ON ro.id=m.role_id AND ro.org_id=m.org_id WHERE m.user_id=$1 ORDER BY o.name", u.ID)
	if e != nil {
		return e
	}
	defer rows.Close()
	orgs := []membership{}
	for rows.Next() {
		var o membership
		if e = rows.Scan(&o.ID, &o.Slug, &o.Name, &o.Role, &o.RoleID, &o.RoleName, &o.Privileges); e != nil {
			return e
		}
		orgs = append(orgs, o)
	}
	if e = rows.Err(); e != nil {
		return e
	}
	send(w, 200, map[string]any{"user": u, "organisations": orgs})
	return nil
}
func (a *app) changePassword(w http.ResponseWriter, r *http.Request) error {
	u, e := a.user(r)
	if e != nil {
		return e
	}
	var in struct {
		Current  string `json:"current"`
		Password string `json:"password"`
	}
	if e = readJSON(w, r, &in); e != nil {
		return e
	}
	var old string
	if e = a.db.QueryRow(r.Context(), "SELECT COALESCE(password_hash,'') FROM users WHERE id=$1", u.ID).Scan(&old); e != nil {
		return e
	}
	if old != "" && !passwordMatches(old, in.Current) {
		return fail(403, "Huidig wachtwoord onjuist")
	}
	h, e := passwordHash(in.Password)
	if e != nil {
		return e
	}
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	if _, e = tx.Exec(r.Context(), "UPDATE users SET password_hash=$1 WHERE id=$2", h, u.ID); e != nil {
		return e
	}
	if _, e = tx.Exec(r.Context(), "DELETE FROM sessions WHERE user_id=$1", u.ID); e != nil {
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	return a.newSession(w, r, u.ID)
}
func (a *app) bootstrap(ctx context.Context) error {
	email := strings.ToLower(strings.TrimSpace(os.Getenv("BOOTSTRAP_EMAIL")))
	if !validEmail(email) {
		return fmt.Errorf("set BOOTSTRAP_EMAIL")
	}
	h, e := passwordHash(os.Getenv("BOOTSTRAP_PASSWORD"))
	if e != nil {
		return e
	}
	slug := env("BOOTSTRAP_ORG", "satvey")
	for _, c := range slug {
		if !strings.ContainsRune("abcdefghijklmnopqrstuvwxyz0123456789-", c) {
			return fmt.Errorf("invalid BOOTSTRAP_ORG slug")
		}
	}
	tx, e := a.db.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	uid, org := id(), id()
	if _, e = tx.Exec(ctx, "INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)", uid, email, env("BOOTSTRAP_NAME", "Beheerder"), h); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, "INSERT INTO organisations(id,slug,name) VALUES($1,$2,$3)", org, slug, env("BOOTSTRAP_ORG_NAME", "Satvey")); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, "INSERT INTO memberships(org_id,user_id,role) VALUES($1,$2,'admin')", org, uid); e != nil {
		return e
	}
	return tx.Commit(ctx)
}
func (a *app) members(w http.ResponseWriter, r *http.Request) error {
	if _, e := a.admin(r); e != nil {
		return e
	}
	rows, e := a.db.Query(r.Context(), "SELECT u.id,u.email,u.name,m.role,ro.id,ro.name FROM memberships m JOIN users u ON u.id=m.user_id JOIN organisation_roles ro ON ro.id=m.role_id AND ro.org_id=m.org_id WHERE m.org_id=$1 ORDER BY u.name", r.PathValue("org"))
	if e != nil {
		return e
	}
	defer rows.Close()
	out := []map[string]string{}
	for rows.Next() {
		var uid, email, name, role, roleID, roleName string
		if e = rows.Scan(&uid, &email, &name, &role, &roleID, &roleName); e != nil {
			return e
		}
		out = append(out, map[string]string{"id": uid, "email": email, "name": name, "role": role, "roleId": roleID, "roleName": roleName})
	}
	if e = rows.Err(); e != nil {
		return e
	}
	send(w, 200, out)
	return nil
}
func (a *app) invite(w http.ResponseWriter, r *http.Request) error {
	if _, e := a.admin(r); e != nil {
		return e
	}
	var in struct {
		Email  string `json:"email"`
		Role   string `json:"role"`
		RoleID string `json:"roleId"`
	}
	if e := readJSON(w, r, &in); e != nil {
		return e
	}
	in.Email = strings.ToLower(strings.TrimSpace(in.Email))
	if !validEmail(in.Email) {
		return fail(400, "Controleer het e-mailadres")
	}
	var roleID, legacy string
	if in.RoleID != "" {
		if !validID(in.RoleID) {
			return fail(400, "Ongeldige rol")
		}
		e := a.db.QueryRow(r.Context(), "SELECT id,COALESCE(system_key,'viewer') FROM organisation_roles WHERE id=$1 AND org_id=$2", in.RoleID, r.PathValue("org")).Scan(&roleID, &legacy)
		if e != nil {
			return fail(400, "Kies een rol uit deze organisatie")
		}
	} else {
		e := a.db.QueryRow(r.Context(), "SELECT id,system_key FROM organisation_roles WHERE system_key=$1 AND org_id=$2", in.Role, r.PathValue("org")).Scan(&roleID, &legacy)
		if e != nil {
			return fail(400, "Kies een geldige rol")
		}
	}
	t := token()
	if _, e := a.db.Exec(r.Context(), "INSERT INTO invitations(token_hash,org_id,email,role,role_id,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '7 days')", hash(t), r.PathValue("org"), in.Email, legacy, roleID); e != nil {
		return e
	}
	send(w, 201, map[string]string{"url": a.origin + "/invite?token=" + t})
	return nil
}
func (a *app) invitationInfo(w http.ResponseWriter, r *http.Request) error {
	var email, name, role string
	e := a.db.QueryRow(r.Context(), "SELECT i.email,o.name,i.role FROM invitations i JOIN organisations o ON o.id=i.org_id WHERE token_hash=$1 AND accepted_at IS NULL AND expires_at>now()", hash(r.PathValue("token"))).Scan(&email, &name, &role)
	if e != nil {
		return fail(404, "Uitnodiging verlopen of al gebruikt")
	}
	send(w, 200, map[string]string{"email": email, "organisation": name, "role": role})
	return nil
}
func (a *app) acceptInvitation(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Token    string `json:"token"`
		Name     string `json:"name"`
		Password string `json:"password"`
	}
	if e := readJSON(w, r, &in); e != nil {
		return e
	}
	ip, _, _ := net.SplitHostPort(r.RemoteAddr)
	if !a.limiter.allow("invite:" + ip) {
		return fail(429, "Te veel pogingen")
	}
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	var org, email, role, roleID string
	e = tx.QueryRow(r.Context(), "SELECT org_id,email,role,role_id FROM invitations WHERE token_hash=$1 AND accepted_at IS NULL AND expires_at>now() FOR UPDATE", hash(in.Token)).Scan(&org, &email, &role, &roleID)
	if e != nil {
		return fail(404, "Uitnodiging verlopen of al gebruikt")
	}
	u, authErr := a.user(r)
	if authErr != nil {
		if strings.TrimSpace(in.Name) == "" || len(in.Name) > 160 {
			return fail(400, "Vul je naam in")
		}
		h, e := passwordHash(in.Password)
		if e != nil {
			return e
		}
		u = principal{ID: id(), Email: email, Name: strings.TrimSpace(in.Name)}
		var exists bool
		if e = tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM users WHERE email=$1)", email).Scan(&exists); e != nil {
			return e
		}
		if exists {
			return fail(409, "Dit account bestaat al. Log eerst in en open de uitnodiging opnieuw.")
		}
		if _, e = tx.Exec(r.Context(), "INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)", u.ID, u.Email, u.Name, h); e != nil {
			return e
		}
	} else if u.Email != email {
		return fail(403, "Log in met het uitgenodigde e-mailadres")
	}
	if _, e = tx.Exec(r.Context(), "INSERT INTO memberships(org_id,user_id,role,role_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", org, u.ID, role, roleID); e != nil {
		return e
	}
	if _, e = tx.Exec(r.Context(), "UPDATE invitations SET accepted_at=now() WHERE token_hash=$1", hash(in.Token)); e != nil {
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	if authErr != nil {
		if e = a.newSession(w, r, u.ID); e != nil {
			return e
		}
	}
	send(w, 200, map[string]bool{"ok": true})
	return nil
}
func (a *app) configureSSO(w http.ResponseWriter, r *http.Request) error {
	if _, e := a.admin(r); e != nil {
		return e
	}
	var in struct {
		Issuer       string   `json:"issuer"`
		ClientID     string   `json:"clientId"`
		ClientSecret string   `json:"clientSecret"`
		Domains      []string `json:"domains"`
	}
	if e := readJSON(w, r, &in); e != nil {
		return e
	}
	if in.Issuer != "" {
		u, e := url.Parse(in.Issuer)
		if e != nil || u.Host == "" || (u.Scheme != "https" && !(env("ALLOW_HTTP_OIDC", "false") == "true" && u.Scheme == "http")) || in.ClientID == "" {
			return fail(400, "Gebruik een geldige HTTPS issuer en client-ID")
		}
	}
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	if _, e = tx.Exec(r.Context(), "UPDATE organisations SET oidc_issuer=$1,oidc_client_id=$2,oidc_client_secret=CASE WHEN $3='' THEN oidc_client_secret ELSE $3 END WHERE id=$4", strings.TrimRight(in.Issuer, "/"), in.ClientID, in.ClientSecret, r.PathValue("org")); e != nil {
		return e
	}
	if _, e = tx.Exec(r.Context(), "DELETE FROM organisation_domains WHERE org_id=$1", r.PathValue("org")); e != nil {
		return e
	}
	seen := map[string]bool{}
	for _, domain := range in.Domains {
		domain = strings.ToLower(strings.TrimSpace(domain))
		if domain == "" || seen[domain] {
			continue
		}
		if !validDomain(domain) {
			return fail(400, "Gebruik domeinen zoals organisatie.nl, zonder @ of URL")
		}
		seen[domain] = true
		tag, e := tx.Exec(r.Context(), "INSERT INTO organisation_domains(domain,org_id) VALUES($1,$2) ON CONFLICT DO NOTHING", domain, r.PathValue("org"))
		if e != nil {
			return e
		}
		if tag.RowsAffected() != 1 {
			return fail(409, "Een van deze domeinen is al gekoppeld aan een andere organisatie")
		}
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	send(w, 200, map[string]bool{"ok": true})
	return nil
}
func (a *app) oidcConfig(ctx context.Context, org string) (*oidc.Provider, *oauth2.Config, error) {
	var issuer, client, secret string
	if e := a.db.QueryRow(ctx, "SELECT oidc_issuer,oidc_client_id,oidc_client_secret FROM organisations WHERE id=$1", org).Scan(&issuer, &client, &secret); e != nil {
		return nil, nil, e
	}
	if issuer == "" {
		return nil, nil, fail(400, "SSO is niet ingesteld voor deze organisatie")
	}
	c, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	p, e := oidc.NewProvider(a.oidcContext(c), issuer)
	if e != nil {
		return nil, nil, fail(502, "Identiteitsprovider niet bereikbaar")
	}
	return p, &oauth2.Config{ClientID: client, ClientSecret: secret, Endpoint: p.Endpoint(), RedirectURL: a.origin + "/api/v1/auth/oidc/callback", Scopes: []string{oidc.ScopeOpenID, "profile", "email"}}, nil
}
func (a *app) oidcStart(w http.ResponseWriter, r *http.Request) error {
	var org string
	if e := a.db.QueryRow(r.Context(), "SELECT id FROM organisations WHERE slug=$1", r.URL.Query().Get("org")).Scan(&org); e != nil {
		return fail(404, "Organisatie niet gevonden")
	}
	_, cfg, e := a.oidcConfig(r.Context(), org)
	if e != nil {
		return e
	}
	state, nonce, verifier := token(), token(), oauth2.GenerateVerifier()
	var userID *string
	if r.URL.Query().Get("link") == "true" {
		u, e := a.user(r)
		if e != nil {
			return e
		}
		userID = &u.ID
	}
	if _, e = a.db.Exec(r.Context(), "INSERT INTO oidc_states(token_hash,org_id,user_id,verifier,nonce,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes')", hash(state), org, userID, verifier, nonce); e != nil {
		return e
	}
	http.SetCookie(w, &http.Cookie{Name: "satvey_oidc", Value: state, Path: "/api/v1/auth/oidc", HttpOnly: true, Secure: a.secure, SameSite: http.SameSiteLaxMode, MaxAge: 600})
	options := []oauth2.AuthCodeOption{oidc.Nonce(nonce), oauth2.S256ChallengeOption(verifier)}
	if email := r.URL.Query().Get("email"); validEmail(email) {
		options = append(options, oauth2.SetAuthURLParam("login_hint", email))
	}
	http.Redirect(w, r, cfg.AuthCodeURL(state, options...), 302)
	return nil
}
func (a *app) oidcCallback(w http.ResponseWriter, r *http.Request) error {
	state := r.URL.Query().Get("state")
	cookie, e := r.Cookie("satvey_oidc")
	if e != nil || subtle.ConstantTimeCompare([]byte(cookie.Value), []byte(state)) != 1 {
		return fail(400, "SSO-aanvraag verlopen")
	}
	var org, verifier, nonce string
	var linked *string
	e = a.db.QueryRow(r.Context(), "DELETE FROM oidc_states WHERE token_hash=$1 AND expires_at>now() RETURNING org_id,user_id,verifier,nonce", hash(state)).Scan(&org, &linked, &verifier, &nonce)
	if e != nil {
		return fail(400, "SSO-aanvraag verlopen")
	}
	provider, cfg, e := a.oidcConfig(r.Context(), org)
	if e != nil {
		return e
	}
	ctx, cancel := context.WithTimeout(a.oidcContext(r.Context()), 20*time.Second)
	defer cancel()
	tok, e := cfg.Exchange(ctx, r.URL.Query().Get("code"), oauth2.VerifierOption(verifier))
	if e != nil {
		return fail(401, "SSO-aanmelding mislukt")
	}
	raw, ok := tok.Extra("id_token").(string)
	if !ok {
		return fail(401, "SSO-token ontbreekt")
	}
	verified, e := provider.Verifier(&oidc.Config{ClientID: cfg.ClientID}).Verify(ctx, raw)
	if e != nil || verified.Nonce != nonce {
		return fail(401, "Ongeldig SSO-token")
	}
	var claims struct {
		Email    string `json:"email"`
		Name     string `json:"name"`
		Verified bool   `json:"email_verified"`
	}
	if e = verified.Claims(&claims); e != nil || !claims.Verified || !validEmail(claims.Email) {
		return fail(403, "SSO vereist een bevestigd e-mailadres")
	}
	claims.Email = strings.ToLower(claims.Email)
	var uid string
	e = a.db.QueryRow(ctx, "SELECT user_id FROM identities WHERE issuer=$1 AND subject=$2", verified.Issuer, verified.Subject).Scan(&uid)
	if e != nil && e != pgx.ErrNoRows {
		return e
	}
	if linked != nil {
		u, e := a.user(r)
		if e != nil || u.ID != *linked {
			return fail(401, "Log opnieuw in voordat je SSO koppelt")
		}
		if uid != "" && uid != u.ID {
			return fail(409, "Deze SSO-identiteit is al gekoppeld")
		}
		uid = u.ID
		_, e = a.db.Exec(ctx, "INSERT INTO identities(issuer,subject,user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", verified.Issuer, verified.Subject, uid)
		if e != nil {
			return e
		}
	} else if uid == "" {
		tx, e := a.db.Begin(ctx)
		if e != nil {
			return e
		}
		defer tx.Rollback(ctx)
		var exists bool
		if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM users WHERE email=$1)", claims.Email).Scan(&exists); e != nil {
			return e
		}
		if exists {
			var existingUser string
			if e = tx.QueryRow(ctx, "SELECT id FROM users WHERE email=$1 AND password_hash IS NOT NULL", claims.Email).Scan(&existingUser); e != nil {
				return fail(409, "Koppel SSO vanuit je bestaande aangemelde account")
			}
			linkToken := token()
			if _, e = tx.Exec(ctx, "INSERT INTO identity_links(token_hash,user_id,issuer,subject,expires_at) VALUES($1,$2,$3,$4,now()+interval '10 minutes')", hash(linkToken), existingUser, verified.Issuer, verified.Subject); e != nil {
				return e
			}
			if e = tx.Commit(ctx); e != nil {
				return e
			}
			http.SetCookie(w, &http.Cookie{Name: "satvey_link", Value: linkToken, Path: "/api/v1/auth/oidc/link", HttpOnly: true, Secure: a.secure, SameSite: http.SameSiteLaxMode, MaxAge: 600})
			http.Redirect(w, r, "/app?link_sso=1", 302)
			return nil
		}
		uid = id()
		if claims.Name == "" {
			claims.Name = claims.Email
		}
		if _, e = tx.Exec(ctx, "INSERT INTO users(id,email,name) VALUES($1,$2,$3)", uid, claims.Email, claims.Name); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, "INSERT INTO identities(issuer,subject,user_id) VALUES($1,$2,$3)", verified.Issuer, verified.Subject, uid); e != nil {
			return e
		}
		if e = tx.Commit(ctx); e != nil {
			return e
		}
	}
	if e = a.newSession(w, r, uid); e != nil {
		return e
	}
	http.SetCookie(w, &http.Cookie{Name: "satvey_oidc", Value: "", Path: "/api/v1/auth/oidc", MaxAge: -1, HttpOnly: true, Secure: a.secure, SameSite: http.SameSiteLaxMode})
	http.Redirect(w, r, "/app", 302)
	return nil
}
