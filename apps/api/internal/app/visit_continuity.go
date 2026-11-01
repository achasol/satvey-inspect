package app

import (
	"encoding/json"
	"github.com/jackc/pgx/v5"
	"net/http"
	"strings"
	"time"
)

type previousRoom struct {
	Name     string `json:"name"`
	Category string `json:"category"`
}

func readFormatForRooms(r *http.Request, tx pgx.Tx, org, inspection string) ([]previousRoom, error) {
	raw, err := list(r.Context(), tx, `SELECT name,COALESCE(category_id::text,'') AS category FROM rooms WHERE org_id=$1 AND inspection_id=$2 ORDER BY name`, org, inspection)
	if err != nil {
		return nil, err
	}
	var rooms []previousRoom
	if err = json.Unmarshal(raw, &rooms); err != nil {
		return nil, err
	}
	format, err := inspectionFormat(r.Context(), tx, org, inspection)
	if err != nil {
		return nil, err
	}
	if format != nil {
		for i := range rooms {
			for _, scope := range format.Scopes {
				if rooms[i].Category == scope.ID {
					rooms[i].Category = scope.NormRoom
					break
				}
			}
		}
	}
	return rooms, nil
}

func (a *app) followupInspection(w http.ResponseWriter, r *http.Request) error {
	u, _, err := a.access(r, true)
	if err != nil {
		return err
	}
	var in struct {
		ID              string     `json:"id"`
		Version         int        `json:"version"`
		FormatVersionID string     `json:"formatVersionId"`
		Reference       string     `json:"reference"`
		ScheduledAt     *time.Time `json:"scheduledAt"`
	}
	if err = readJSON(w, r, &in); err != nil {
		return err
	}
	if !validID(in.ID) || !validID(in.FormatVersionID) || in.Version < 1 || len(in.Reference) > 240 {
		return fail(422, "Controleer de vervolginspectie")
	}
	org, old := r.PathValue("org"), r.PathValue("inspection")
	if !validID(old) {
		return fail(404, "Inspectie niet gevonden")
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	var property, status string
	var version int
	var caseID *string
	var archived bool
	if err = tx.QueryRow(r.Context(), `SELECT property_id,status,revision,mutation_case_id,archived_at IS NOT NULL FROM inspections WHERE id=$1 AND org_id=$2 FOR UPDATE`, old, org).Scan(&property, &status, &version, &caseID, &archived); err != nil {
		return err
	}
	var exists bool
	if err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM inspections WHERE id=$1 AND org_id=$2 AND predecessor_id=$3 AND format_version_id=$4)`, in.ID, org, old, in.FormatVersionID).Scan(&exists); err != nil {
		return err
	}
	if exists {
		send(w, 200, map[string]string{"id": in.ID})
		return nil
	}
	if status != "final" || archived || version != in.Version {
		return fail(409, "Start vanuit het actuele definitieve dossier")
	}
	format, err := readFormat(r.Context(), tx, org, in.FormatVersionID)
	if err != nil {
		return err
	}
	if format.Status != "published" {
		return fail(422, "Kies een gepubliceerd inspectiesjabloon")
	}
	if caseID == nil {
		cid := id()
		caseID = &cid
		if _, err = tx.Exec(r.Context(), `INSERT INTO mutation_cases(id,org_id,property_id,reference) VALUES($1,$2,$3,$4)`, cid, org, property, strings.TrimSpace(in.Reference)); err != nil {
			return err
		}
		if _, err = tx.Exec(r.Context(), `UPDATE inspections SET mutation_case_id=$3,revision=revision+1 WHERE id=$1 AND org_id=$2`, old, org, cid); err != nil {
			return err
		}
	}
	var same bool
	if err = tx.QueryRow(r.Context(), `SELECT property_id=$3 FROM mutation_cases WHERE id=$1 AND org_id=$2`, *caseID, org, property).Scan(&same); err != nil {
		return err
	}
	if !same {
		return fail(409, "De zaak hoort bij een andere woning")
	}
	if err = setActor(r.Context(), tx, u.ID); err != nil {
		return err
	}
	elements, err := elementContext(r.Context(), tx, org)
	if err != nil {
		return err
	}
	if _, err = tx.Exec(r.Context(), `INSERT INTO inspections(id,org_id,property_id,kind,scheduled_at,created_by,norm_version_id,format_version_id,element_context,mutation_case_id,predecessor_id,external_reference) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, in.ID, org, property, format.Kind, in.ScheduledAt, u.ID, format.NormVersionID, format.ID, elements, caseID, old, strings.TrimSpace(in.Reference)); err != nil {
		return err
	}
	// Match by the explicit template room category, never infer condition answers.
	previous, err := readFormatForRooms(r, tx, org, old)
	if err != nil {
		return err
	}
	for _, category := range format.Scopes {
		names := []string{}
		for _, room := range previous {
			if (room.Category == category.NormRoom || room.Name == category.Name) && !category.Property {
				if len(names) == 0 {
					names = append(names, room.Name)
				} else if !contains(names, room.Name) {
					names = append(names, room.Name)
				}
			}
		}
		if len(names) == 0 && (category.Required || category.Property) {
			names = append(names, category.Name)
		}
		for _, name := range names {
			if err = instantiateScope(r.Context(), tx, org, in.ID, id(), name, category); err != nil {
				return err
			}
		}
	}
	if _, err = tx.Exec(r.Context(), `INSERT INTO inspection_agreements(id,org_id,inspection_id,source_agreement_id,description,responsibility,due_date,status,note) SELECT gen_random_uuid(),org_id,$1,id,description,responsibility,due_date,status,note FROM inspection_agreements WHERE inspection_id=$2 AND org_id=$3 AND status IN ('open','disputed')`, in.ID, old, org); err != nil {
		return err
	}
	if err = recordEvent(r.Context(), tx, org, in.ID, u.ID, "followup_created", map[string]string{"previousInspectionId": old}); err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	send(w, 201, map[string]string{"id": in.ID})
	return nil
}

func (a *app) propertyHistory(w http.ResponseWriter, r *http.Request) error {
	if _, _, err := a.access(r, false); err != nil {
		return err
	}
	property := r.PathValue("property")
	if !validID(property) {
		return fail(404, "Woning niet gevonden")
	}
	out, err := list(r.Context(), a.db, inspectionSelect+` WHERE i.org_id=$1 AND i.property_id=$2 ORDER BY i.created_at DESC,i.id LIMIT 250`, r.PathValue("org"), property)
	if err != nil {
		return err
	}
	send(w, 200, out)
	return nil
}
