package main

import (
	"github.com/jackc/pgx/v5"
	"net/http"
	"net/url"
	"strings"
)

func validDomain(domain string) bool {
	if len(domain) > 253 || !strings.Contains(domain, ".") {
		return false
	}
	for _, part := range strings.Split(domain, ".") {
		if len(part) == 0 || len(part) > 63 || part[0] == '-' || part[len(part)-1] == '-' {
			return false
		}
		for _, c := range part {
			if !strings.ContainsRune("abcdefghijklmnopqrstuvwxyz0123456789-", c) {
				return false
			}
		}
	}
	return true
}

func (a *app) discoverLogin(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Email string `json:"email"`
	}
	if e := readJSON(w, r, &in); e != nil {
		return e
	}
	in.Email = strings.ToLower(strings.TrimSpace(in.Email))
	if !validEmail(in.Email) {
		return fail(400, "Vul een geldig e-mailadres in")
	}
	var slug string
	e := a.db.QueryRow(r.Context(), "SELECT o.slug FROM organisation_domains d JOIN organisations o ON o.id=d.org_id WHERE d.domain=$1 AND o.oidc_issuer<>'' AND o.oidc_client_id<>''", strings.Split(in.Email, "@")[1]).Scan(&slug)
	if e == pgx.ErrNoRows {
		send(w, 200, map[string]string{"method": "password"})
		return nil
	}
	if e != nil {
		return e
	}
	send(w, 200, map[string]string{"method": "sso", "url": "/api/v1/auth/oidc/start?org=" + url.QueryEscape(slug) + "&email=" + url.QueryEscape(in.Email)})
	return nil
}
func (a *app) ssoSettings(w http.ResponseWriter, r *http.Request) error {
	if _, e := a.admin(r); e != nil {
		return e
	}
	var issuer, client string
	if e := a.db.QueryRow(r.Context(), "SELECT oidc_issuer,oidc_client_id FROM organisations WHERE id=$1", r.PathValue("org")).Scan(&issuer, &client); e != nil {
		return e
	}
	domains := []string{}
	rows, e := a.db.Query(r.Context(), "SELECT domain FROM organisation_domains WHERE org_id=$1 ORDER BY domain", r.PathValue("org"))
	if e != nil {
		return e
	}
	defer rows.Close()
	for rows.Next() {
		var domain string
		if e = rows.Scan(&domain); e != nil {
			return e
		}
		domains = append(domains, domain)
	}
	if e = rows.Err(); e != nil {
		return e
	}
	send(w, 200, map[string]any{"issuer": issuer, "clientId": client, "domains": domains})
	return nil
}
