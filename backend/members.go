package main

import "net/http"

func (a *app) updateMember(w http.ResponseWriter, r *http.Request) error {
	u, e := a.admin(r)
	if e != nil {
		return e
	}
	var in struct {
		Role   string `json:"role"`
		RoleID string `json:"roleId"`
	}
	if e = readJSON(w, r, &in); e != nil {
		return e
	}
	if !validID(r.PathValue("user")) {
		return fail(404, "Lid niet gevonden")
	}
	org, target := r.PathValue("org"), r.PathValue("user")
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	var lock string
	if e = tx.QueryRow(r.Context(), "SELECT id FROM organisations WHERE id=$1 FOR UPDATE", org).Scan(&lock); e != nil {
		return e
	}
	var allowed bool
	if e = tx.QueryRow(r.Context(), "SELECT 'settings.manage'=ANY(ro.privileges) FROM memberships m JOIN organisation_roles ro ON ro.id=m.role_id AND ro.org_id=m.org_id WHERE m.org_id=$1 AND m.user_id=$2", org, u.ID).Scan(&allowed); e != nil || !allowed {
		return fail(403, "Je rol heeft dit privilege niet")
	}
	var count int
	if in.Role == "remove" {
		tag, e := tx.Exec(r.Context(), "DELETE FROM memberships WHERE org_id=$1 AND user_id=$2", org, target)
		if e != nil {
			return e
		}
		if tag.RowsAffected() != 1 {
			return fail(404, "Lid niet gevonden")
		}
	} else {
		var roleID, legacy string
		if in.RoleID != "" {
			if !validID(in.RoleID) {
				return fail(400, "Ongeldige rol")
			}
			e = tx.QueryRow(r.Context(), "SELECT id,COALESCE(system_key,'viewer') FROM organisation_roles WHERE id=$1 AND org_id=$2", in.RoleID, org).Scan(&roleID, &legacy)
		} else {
			e = tx.QueryRow(r.Context(), "SELECT id,system_key FROM organisation_roles WHERE system_key=$1 AND org_id=$2", in.Role, org).Scan(&roleID, &legacy)
		}
		if e != nil {
			return fail(400, "Kies een rol uit deze organisatie")
		}
		tag, e := tx.Exec(r.Context(), "UPDATE memberships SET role=$1,role_id=$2 WHERE org_id=$3 AND user_id=$4", legacy, roleID, org, target)
		if e != nil {
			return e
		}
		if tag.RowsAffected() != 1 {
			return fail(404, "Lid niet gevonden")
		}
	}
	if e = tx.QueryRow(r.Context(), "SELECT count(*) FROM memberships m JOIN organisation_roles ro ON ro.id=m.role_id AND ro.org_id=m.org_id WHERE m.org_id=$1 AND 'settings.manage'=ANY(ro.privileges)", org).Scan(&count); e != nil {
		return e
	}
	if count == 0 {
		return fail(422, "Minimaal een lid moet het privilege Organisatie beheren behouden")
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	send(w, 200, map[string]bool{"ok": true})
	return nil
}
