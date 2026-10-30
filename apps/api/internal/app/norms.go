package app

import (
	"context"
	"encoding/json"
	"net/http"
	"satvey/inspect/internal/quality"
	"strings"

	"github.com/jackc/pgx/v5"
)

func (a *app) quality(r *http.Request) (principal, error) {
	u, _, e := a.require(r, "norms.manage")
	return u, e
}
func (a *app) normAssetsValid(ctx context.Context, q querier, org string, rules []normRule) error {
	for _, rule := range rules {
		if rule.ElementID != "" {
			if !validID(rule.ElementID) {
				return fail(400, "Ongeldig element")
			}
			var exists bool
			if e := q.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM room_elements WHERE id=$1 AND org_id=$2 AND NOT archived)", rule.ElementID, org).Scan(&exists); e != nil {
				return e
			}
			if !exists {
				return fail(422, "Kies een actief element uit deze organisatie")
			}
		}
		for _, ex := range rule.Examples {
			if ex.AssetID != "" {
				var exists bool
				if e := q.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM norm_assets WHERE id=$1 AND org_id=$2)", ex.AssetID, org).Scan(&exists); e != nil {
					return e
				}
				if !exists {
					return fail(400, "Voorbeeldbestand hoort niet bij deze organisatie")
				}
			}
		}
	}
	return nil
}
func readNorm(ctx context.Context, q querier, org, version string) (normDocument, error) {
	var d normDocument
	if !validID(version) {
		return d, fail(404, "Normenkader niet gevonden")
	}
	var rules, sources []byte
	e := q.QueryRow(ctx, `SELECT id,framework_id,number,name,description,status,revision,rules,sources FROM norm_versions WHERE id=$1 AND org_id=$2`, version, org).Scan(&d.ID, &d.FrameworkID, &d.Number, &d.Name, &d.Description, &d.Status, &d.Revision, &rules, &sources)
	if e != nil {
		return d, e
	}
	if e = json.Unmarshal(rules, &d.Rules); e != nil {
		return d, e
	}
	e = json.Unmarshal(sources, &d.Sources)
	return d, e
}
func (a *app) normsList(w http.ResponseWriter, r *http.Request) error {
	_, _, e := a.require(r, "norms.read")
	if e != nil {
		return e
	}
	out, e := list(r.Context(), a.db, `SELECT id,framework_id AS "frameworkId",number,name,description,status,revision,jsonb_array_length(rules) AS "ruleCount",published_at AS "publishedAt" FROM norm_versions WHERE org_id=$1 AND (status='published' OR $2) ORDER BY created_at DESC,number DESC`, r.PathValue("org"), a.hasPrivilege(r, "norms.manage"))
	if e != nil {
		return e
	}
	send(w, 200, out)
	return nil
}
func (a *app) normDetail(w http.ResponseWriter, r *http.Request) error {
	_, _, e := a.require(r, "norms.read")
	if e != nil {
		return e
	}
	d, e := readNorm(r.Context(), a.db, r.PathValue("org"), r.PathValue("norm"))
	if e != nil {
		return e
	}
	if d.Status != "published" && !a.hasPrivilege(r, "norms.manage") {
		return fail(404, "Normenkader niet gevonden")
	}
	send(w, 200, d)
	return nil
}
func (a *app) createNorm(w http.ResponseWriter, r *http.Request) error {
	u, e := a.quality(r)
	if e != nil {
		return e
	}
	var in struct {
		Name     string `json:"name"`
		Baseline bool   `json:"baseline"`
	}
	if e = readJSON(w, r, &in); e != nil {
		return e
	}
	d := normDocument{ID: id(), FrameworkID: id(), Number: 1, Name: strings.TrimSpace(in.Name), Status: "draft", Rules: []normRule{}, Sources: []normSource{}}
	if in.Baseline {
		d.Rules, d.Sources = baselineNorms()
		d.Description = "Voorstel voor eigen organisatiebeleid, op basis van openbare inspectie- en onderhoudsinformatie. Controleer de criteria en voorbeelden vóór publicatie. Dit is geen NEN-conditiescore of juridisch oordeel."
	}
	if e = validateNorms(d, false); e != nil {
		return e
	}
	rules, _ := json.Marshal(d.Rules)
	sources, _ := json.Marshal(d.Sources)
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	if _, e = tx.Exec(r.Context(), "INSERT INTO norm_frameworks(id,org_id) VALUES($1,$2)", d.FrameworkID, r.PathValue("org")); e != nil {
		return e
	}
	if _, e = tx.Exec(r.Context(), "INSERT INTO norm_versions(id,org_id,framework_id,number,name,description,rules,sources,created_by) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8)", d.ID, r.PathValue("org"), d.FrameworkID, d.Name, d.Description, rules, sources, u.ID); e != nil {
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	d.Revision = 1
	send(w, 201, d)
	return nil
}
func (a *app) updateNorm(w http.ResponseWriter, r *http.Request) error {
	if _, e := a.quality(r); e != nil {
		return e
	}
	var in normDocument
	if e := readJSON(w, r, &in); e != nil {
		return e
	}
	if e := validateNorms(in, false); e != nil {
		return e
	}
	if !validID(r.PathValue("norm")) {
		return fail(404, "Normenkader niet gevonden")
	}
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	if e = a.normAssetsValid(r.Context(), tx, r.PathValue("org"), in.Rules); e != nil {
		return e
	}
	rules, _ := json.Marshal(in.Rules)
	tag, e := tx.Exec(r.Context(), "UPDATE norm_versions SET name=$1,description=$2,rules=$3,revision=revision+1 WHERE id=$4 AND org_id=$5 AND status='draft' AND revision=$6", strings.TrimSpace(in.Name), in.Description, rules, r.PathValue("norm"), r.PathValue("org"), in.Revision)
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return fail(409, "Het kader is gewijzigd of gepubliceerd. Herlaad de nieuwste versie.")
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	send(w, 200, map[string]int{"revision": in.Revision + 1})
	return nil
}
func (a *app) publishNorm(w http.ResponseWriter, r *http.Request) error {
	u, e := a.quality(r)
	if e != nil {
		return e
	}
	var in struct {
		Revision int `json:"revision"`
	}
	if e = readJSON(w, r, &in); e != nil {
		return e
	}
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	if !validID(r.PathValue("norm")) {
		return fail(404, "Normenkader niet gevonden")
	}
	if _, e = tx.Exec(r.Context(), "SELECT id FROM norm_versions WHERE id=$1 AND org_id=$2 FOR UPDATE", r.PathValue("norm"), r.PathValue("org")); e != nil {
		return e
	}
	d, e := readNorm(r.Context(), tx, r.PathValue("org"), r.PathValue("norm"))
	if e != nil {
		return e
	}
	if d.Status != "draft" || d.Revision != in.Revision {
		return fail(409, "Herlaad de nieuwste conceptversie")
	}
	if e = validateNorms(d, true); e != nil {
		return e
	}
	if e = a.normAssetsValid(r.Context(), tx, r.PathValue("org"), d.Rules); e != nil {
		return e
	}
	if _, e = tx.Exec(r.Context(), "UPDATE norm_versions SET status='published',published_at=now(),published_by=$1,revision=revision+1 WHERE id=$2 AND org_id=$3", u.ID, d.ID, r.PathValue("org")); e != nil {
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	send(w, 200, map[string]bool{"ok": true})
	return nil
}
func (a *app) reviseNorm(w http.ResponseWriter, r *http.Request) error {
	u, e := a.quality(r)
	if e != nil {
		return e
	}
	org := r.PathValue("org")
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	d, e := readNorm(r.Context(), tx, org, r.PathValue("norm"))
	if e != nil {
		return e
	}
	if d.Status != "published" {
		return fail(409, "Alleen een gepubliceerd kader krijgt een nieuwe versie")
	}
	var locked string
	if e = tx.QueryRow(r.Context(), "SELECT id FROM norm_frameworks WHERE id=$1 AND org_id=$2 FOR UPDATE", d.FrameworkID, org).Scan(&locked); e != nil {
		return e
	}
	var existing string
	e = tx.QueryRow(r.Context(), "SELECT id FROM norm_versions WHERE framework_id=$1 AND org_id=$2 AND status='draft'", d.FrameworkID, org).Scan(&existing)
	if e == nil {
		send(w, 200, map[string]string{"id": existing})
		return nil
	}
	if e != pgx.ErrNoRows {
		return e
	}
	var number int
	if e = tx.QueryRow(r.Context(), "SELECT max(number)+1 FROM norm_versions WHERE framework_id=$1 AND org_id=$2", d.FrameworkID, org).Scan(&number); e != nil {
		return e
	}
	newID := id()
	rules, _ := json.Marshal(d.Rules)
	sources, _ := json.Marshal(d.Sources)
	if _, e = tx.Exec(r.Context(), "INSERT INTO norm_versions(id,org_id,framework_id,number,name,description,rules,sources,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", newID, org, d.FrameworkID, number, d.Name, d.Description, rules, sources, u.ID); e != nil {
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	send(w, 201, map[string]string{"id": newID})
	return nil
}

type normExample = quality.Example
type normRule = quality.Rule
type normSource = quality.Source
type normDocument = quality.Norms

func validateNorms(d normDocument, publish bool) error { return quality.ValidateNorms(d, publish) }
func validOutcome(s string) bool                       { return quality.ValidOutcome(s) }
func safeSource(s string) bool                         { return quality.SafeSource(s) }
