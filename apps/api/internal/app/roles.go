package app

import (
	"errors"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
)

type privilegeInfo struct {
	Key         string `json:"key"`
	Label       string `json:"label"`
	Description string `json:"description"`
	Group       string `json:"group"`
}

var privilegeCatalog = []privilegeInfo{
	{"formats.read", "Inspectiesjablonen bekijken", "Gepubliceerde formats en vereisten openen", "Inspectiesjablonen"},
	{"formats.manage", "Inspectiesjablonen beheren", "Vragen, bewijseisen en spreekhulp maken en publiceren", "Inspectiesjablonen"},
	{"inspections.read", "Inspecties bekijken", "Dossiers, foto's, audio en rapporten openen", "Inspecties"},
	{"inspections.write", "Inspecties bewerken", "Opnemen, transcripties wijzigen, beoordelen en rapporten vastleggen", "Inspecties"},
	{"inspections.archive", "Definitieve dossiers archiveren", "Definitieve dossiers archiveren en dossiers herstellen", "Inspecties"},
	{"inspections.purge", "Dossiers definitief verwijderen", "Gearchiveerde dossiers met reden permanent verwijderen", "Inspecties"},
	{"inspections.plan", "Inspecties plannen", "Inspecteurs toewijzen en afspraken beheren", "Inspecties"},
	{"inspections.review", "Kwaliteitscontrole uitvoeren", "Zelfstandig dossiers controleren en aandachtspunten vastleggen", "Inspecties"},
	{"norms.read", "Kwaliteitskaders bekijken", "Gepubliceerde kaders en voorbeelden openen", "Kwaliteitskaders"},
	{"norms.manage", "Kwaliteitskaders beheren", "Kaders, ruimte-elementen en voorbeelden maken, wijzigen en publiceren", "Kwaliteitskaders"},
	{"benchmarks.read", "Beoordelingsoverzicht bekijken", "Bevestigde kwaliteitsbeoordelingen vergelijken", "Kwaliteitskaders"},
	{"settings.manage", "Organisatie beheren", "Leden, uitnodigingen, SSO, rollen en privileges beheren", "Instellingen"},
}

func (a *app) require(r *http.Request, privilege string) (principal, string, error) {
	u, e := a.user(r)
	if e != nil {
		return u, "", e
	}
	org := r.PathValue("org")
	if !validID(org) {
		return u, "", fail(404, "Organisatie niet gevonden")
	}
	var role string
	var allowed bool
	e = a.db.QueryRow(r.Context(), "SELECT m.role,$3=ANY(ro.privileges) FROM memberships m JOIN organisation_roles ro ON ro.id=m.role_id AND ro.org_id=m.org_id WHERE m.org_id=$1 AND m.user_id=$2", org, u.ID, privilege).Scan(&role, &allowed)
	if e != nil {
		return u, "", fail(404, "Organisatie niet gevonden")
	}
	if !allowed {
		return u, role, fail(403, "Je rol heeft dit privilege niet")
	}
	return u, role, nil
}
func (a *app) hasPrivilege(r *http.Request, privilege string) bool {
	_, _, e := a.require(r, privilege)
	return e == nil
}
func (a *app) roles(w http.ResponseWriter, r *http.Request) error {
	if _, e := a.admin(r); e != nil {
		return e
	}
	out, e := list(r.Context(), a.db, `SELECT ro.id,ro.name,ro.description,ro.privileges,ro.system_key AS "systemKey",ro.version,(SELECT count(*) FROM memberships m WHERE m.org_id=ro.org_id AND m.role_id=ro.id) AS "memberCount",(SELECT count(*) FROM invitations i WHERE i.org_id=ro.org_id AND i.role_id=ro.id) AS "invitationCount" FROM organisation_roles ro WHERE org_id=$1 ORDER BY name`, r.PathValue("org"))
	if e != nil {
		return e
	}
	send(w, 200, map[string]any{"roles": out, "privileges": privilegeCatalog})
	return nil
}

type roleInput struct {
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Privileges  []string `json:"privileges"`
	Version     int      `json:"version"`
}

func validateRole(in roleInput) error {
	if strings.TrimSpace(in.Name) == "" || len(in.Name) > 100 || len(in.Description) > 1000 || len(in.Privileges) > len(privilegeCatalog) {
		return fail(400, "Controleer rolnaam en privileges")
	}
	known := map[string]bool{}
	for _, p := range privilegeCatalog {
		known[p.Key] = true
	}
	set := map[string]bool{}
	for _, p := range in.Privileges {
		if !known[p] || set[p] {
			return fail(400, "Onbekend of dubbel privilege")
		}
		set[p] = true
	}
	if set["formats.manage"] && !set["norms.read"] {
		return fail(422, "Formats beheren vereist ook Kwaliteitskaders bekijken")
	}
	for p, dep := range map[string]string{"inspections.write": "inspections.read", "inspections.archive": "inspections.read", "inspections.purge": "inspections.archive", "inspections.plan": "inspections.read", "inspections.review": "inspections.read", "norms.manage": "norms.read", "formats.manage": "formats.read", "benchmarks.read": "norms.read"} {
		if set[p] && !set[dep] {
			return fail(422, "Bewerk- en benchmarkprivileges vereisen ook het bijbehorende leesprivilege")
		}
	}
	return nil
}
func roleConstraint(e error) error {
	var pg *pgconn.PgError
	if errors.As(e, &pg) && pg.Code == "23505" {
		return fail(409, "Deze naam bestaat al in de organisatie")
	}
	return e
}
func (a *app) createRole(w http.ResponseWriter, r *http.Request) error {
	if _, e := a.admin(r); e != nil {
		return e
	}
	var in roleInput
	if e := readJSON(w, r, &in); e != nil {
		return e
	}
	if e := validateRole(in); e != nil {
		return e
	}
	if in.Privileges == nil {
		in.Privileges = []string{}
	}
	rid := id()
	if _, e := a.db.Exec(r.Context(), "INSERT INTO organisation_roles(id,org_id,name,description,privileges) VALUES($1,$2,$3,$4,$5)", rid, r.PathValue("org"), strings.TrimSpace(in.Name), in.Description, in.Privileges); e != nil {
		return roleConstraint(e)
	}
	send(w, 201, map[string]string{"id": rid})
	return nil
}
func (a *app) updateRole(w http.ResponseWriter, r *http.Request) error {
	u, e := a.admin(r)
	if e != nil {
		return e
	}
	var in roleInput
	if e = readJSON(w, r, &in); e != nil {
		return e
	}
	if e = validateRole(in); e != nil {
		return e
	}
	if !validID(r.PathValue("role")) {
		return fail(404, "Rol niet gevonden")
	}
	if in.Privileges == nil {
		in.Privileges = []string{}
	}
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	org := r.PathValue("org")
	var locked string
	if e = tx.QueryRow(r.Context(), "SELECT id FROM organisations WHERE id=$1 FOR UPDATE", org).Scan(&locked); e != nil {
		return e
	}
	var stillAllowed bool
	if e = tx.QueryRow(r.Context(), "SELECT 'settings.manage'=ANY(ro.privileges) FROM memberships m JOIN organisation_roles ro ON ro.id=m.role_id AND ro.org_id=m.org_id WHERE m.org_id=$1 AND m.user_id=$2", org, u.ID).Scan(&stillAllowed); e != nil || !stillAllowed {
		return fail(403, "Je rol heeft dit privilege niet")
	}
	tag, e := tx.Exec(r.Context(), "UPDATE organisation_roles SET name=$1,description=$2,privileges=$3,version=version+1 WHERE id=$4 AND org_id=$5 AND version=$6", strings.TrimSpace(in.Name), in.Description, in.Privileges, r.PathValue("role"), org, in.Version)
	if e != nil {
		return roleConstraint(e)
	}
	if tag.RowsAffected() != 1 {
		return fail(409, "De rol is gewijzigd. Herlaad de nieuwste versie.")
	}
	var managers int
	if e = tx.QueryRow(r.Context(), "SELECT count(*) FROM memberships m JOIN organisation_roles ro ON ro.id=m.role_id AND ro.org_id=m.org_id WHERE m.org_id=$1 AND 'settings.manage'=ANY(ro.privileges)", org).Scan(&managers); e != nil {
		return e
	}
	if managers == 0 {
		return fail(422, "Minimaal één lid moet het privilege Organisatie beheren behouden")
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	send(w, 200, map[string]int{"version": in.Version + 1})
	return nil
}
func (a *app) deleteRole(w http.ResponseWriter, r *http.Request) error {
	if _, e := a.admin(r); e != nil {
		return e
	}
	if !validID(r.PathValue("role")) {
		return fail(404, "Rol niet gevonden")
	}
	tag, e := a.db.Exec(r.Context(), "DELETE FROM organisation_roles ro WHERE id=$1 AND org_id=$2 AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.role_id=ro.id) AND NOT EXISTS(SELECT 1 FROM invitations i WHERE i.role_id=ro.id)", r.PathValue("role"), r.PathValue("org"))
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return fail(409, "Deze rol is nog gekoppeld aan leden of uitnodigingen")
	}
	send(w, 200, map[string]bool{"ok": true})
	return nil
}
