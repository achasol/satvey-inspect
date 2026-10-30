package app

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
)

type roomElement struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Rooms       []string `json:"rooms"`
	Aliases     []string `json:"aliases"`
	Archived    bool     `json:"archived"`
	Version     int      `json:"version"`
}

const elementSelect = `SELECT id,name,description,rooms,aliases,archived,version FROM room_elements`

func elementContext(ctx context.Context, q querier, org string) (json.RawMessage, error) {
	return list(ctx, q, elementSelect+" WHERE org_id=$1 AND NOT archived ORDER BY name", org)
}
func (a *app) elements(w http.ResponseWriter, r *http.Request) error {
	if _, _, e := a.require(r, "norms.read"); e != nil {
		return e
	}
	out, e := list(r.Context(), a.db, elementSelect+" WHERE org_id=$1 ORDER BY archived,name", r.PathValue("org"))
	if e != nil {
		return e
	}
	send(w, 200, out)
	return nil
}
func (a *app) saveElement(w http.ResponseWriter, r *http.Request) error {
	if _, e := a.quality(r); e != nil {
		return e
	}
	var in roomElement
	if e := readJSON(w, r, &in); e != nil {
		return e
	}
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" || len(in.Name) > 120 || len(in.Description) > 2000 || len(in.Rooms) == 0 || len(in.Rooms) > 20 || len(in.Aliases) > 20 {
		return fail(400, "Vul een elementnaam en de bijbehorende ruimtes in")
	}
	for _, v := range append(append([]string{}, in.Rooms...), in.Aliases...) {
		if strings.TrimSpace(v) == "" || len(v) > 100 {
			return fail(400, "Controleer ruimtes en andere benamingen")
		}
	}
	if in.Aliases == nil {
		in.Aliases = []string{}
	}
	org := r.PathValue("org")
	if r.Method == "POST" {
		in.Archived = false
		in.ID = id()
		in.Version = 1
		_, e := a.db.Exec(r.Context(), "INSERT INTO room_elements(id,org_id,name,description,rooms,aliases) VALUES($1,$2,$3,$4,$5,$6)", in.ID, org, in.Name, in.Description, in.Rooms, in.Aliases)
		if e != nil {
			return roleConstraint(e)
		}
		send(w, 201, in)
		return nil
	}
	if !validID(r.PathValue("element")) {
		return fail(404, "Element niet gevonden")
	}
	tag, e := a.db.Exec(r.Context(), "UPDATE room_elements SET name=$1,description=$2,rooms=$3,aliases=$4,archived=$5,version=version+1 WHERE id=$6 AND org_id=$7 AND version=$8", in.Name, in.Description, in.Rooms, in.Aliases, in.Archived, r.PathValue("element"), org, in.Version)
	if e != nil {
		return roleConstraint(e)
	}
	if tag.RowsAffected() != 1 {
		return fail(409, "Dit element is gewijzigd. Herlaad de nieuwste versie.")
	}
	send(w, 200, map[string]int{"version": in.Version + 1})
	return nil
}
