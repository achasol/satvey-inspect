package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
)

type formatCondition struct {
	QuestionID string `json:"questionId"`
	Equals     string `json:"equals"`
}
type formatQuestion struct {
	ID            string           `json:"id"`
	Title         string           `json:"title"`
	Kind          string           `json:"kind"`
	Required      bool             `json:"required"`
	Instruction   string           `json:"instruction"`
	TalkingPrompt string           `json:"talkingPrompt"`
	RuleID        string           `json:"ruleId"`
	ElementID     string           `json:"elementId"`
	Choices       []string         `json:"choices"`
	Unit          string           `json:"unit"`
	Evidence      string           `json:"evidence"`
	MinPhotos     int              `json:"minPhotos"`
	Condition     *formatCondition `json:"condition,omitempty"`
}
type formatScope struct {
	ID         string           `json:"id"`
	Name       string           `json:"name"`
	NormRoom   string           `json:"normRoom"`
	Property   bool             `json:"property"`
	Required   bool             `json:"required"`
	Repeatable bool             `json:"repeatable"`
	Questions  []formatQuestion `json:"questions"`
}
type formatDocument struct {
	ID            string        `json:"id"`
	FormatID      string        `json:"formatId"`
	Number        int           `json:"number"`
	Name          string        `json:"name"`
	Description   string        `json:"description"`
	Kind          string        `json:"kind"`
	NormVersionID *string       `json:"normVersionId"`
	Status        string        `json:"status"`
	Revision      int           `json:"revision"`
	Scopes        []formatScope `json:"scopes"`
}

func readFormat(ctx context.Context, q querier, org, version string) (*formatDocument, error) {
	if !validID(version) {
		return nil, fail(404, "Format niet gevonden")
	}
	var d formatDocument
	var raw []byte
	e := q.QueryRow(ctx, `SELECT id,format_id,number,name,description,kind,norm_version_id,status,revision,scopes FROM format_versions WHERE id=$1 AND org_id=$2`, version, org).Scan(&d.ID, &d.FormatID, &d.Number, &d.Name, &d.Description, &d.Kind, &d.NormVersionID, &d.Status, &d.Revision, &raw)
	if e == nil {
		e = json.Unmarshal(raw, &d.Scopes)
	}
	return &d, e
}
func inspectionFormat(ctx context.Context, q querier, org, inspection string) (*formatDocument, error) {
	var version *string
	e := q.QueryRow(ctx, `SELECT format_version_id FROM inspections WHERE id=$1 AND org_id=$2`, inspection, org).Scan(&version)
	if e != nil || version == nil {
		return nil, e
	}
	return readFormat(ctx, q, org, *version)
}
func (a *app) formatsList(w http.ResponseWriter, r *http.Request) error {
	if _, _, e := a.require(r, "formats.read"); e != nil {
		return e
	}
	out, e := list(r.Context(), a.db, `SELECT id,format_id AS "formatId",number,name,description,kind,norm_version_id AS "normVersionId",status,revision,scopes FROM format_versions WHERE org_id=$1 AND (status='published' OR $2) ORDER BY name,number DESC`, r.PathValue("org"), a.hasPrivilege(r, "formats.manage"))
	if e != nil {
		return e
	}
	send(w, 200, out)
	return nil
}
func (a *app) formatDetail(w http.ResponseWriter, r *http.Request) error {
	if _, _, e := a.require(r, "formats.read"); e != nil {
		return e
	}
	d, e := readFormat(r.Context(), a.db, r.PathValue("org"), r.PathValue("format"))
	if e != nil {
		return e
	}
	if d.Status != "published" && !a.hasPrivilege(r, "formats.manage") {
		return fail(404, "Format niet gevonden")
	}
	send(w, 200, d)
	return nil
}
func starterScopes() []formatScope {
	scopes := []formatScope{}
	for _, name := range []string{"Woning algemeen", "Entree", "Woonkamer", "Keuken", "Badkamer", "Slaapkamer", "Buitenruimte"} {
		property := name == "Woning algemeen"
		s := formatScope{ID: id(), Name: name, NormRoom: name, Property: property, Required: !property && name != "Buitenruimte", Repeatable: name == "Slaapkamer", Questions: []formatQuestion{}}
		if !property {
			s.Questions = append(s.Questions, formatQuestion{ID: id(), Title: "Overzicht en zichtbare staat", Kind: "text", Required: true, Evidence: "photo", MinPhotos: 1, TalkingPrompt: "Beschrijf wat je ziet, waar eventuele beschadigingen zitten en wat je nog niet kon controleren.", Instruction: "Maak een overzichtsfoto en beschrijf de zichtbare staat.", Choices: []string{}})
		}
		scopes = append(scopes, s)
	}
	return scopes
}
func (a *app) createFormat(w http.ResponseWriter, r *http.Request) error {
	u, _, e := a.require(r, "formats.manage")
	if e != nil {
		return e
	}
	if !a.hasPrivilege(r, "norms.read") {
		return fail(403, "Normen bekijken is nodig om een format te beheren")
	}
	var in struct {
		Name          string  `json:"name"`
		Kind          string  `json:"kind"`
		NormVersionID *string `json:"normVersionId"`
	}
	if e = readJSON(w, r, &in); e != nil {
		return e
	}
	if strings.TrimSpace(in.Name) == "" || len(in.Name) > 160 || (in.Kind != "pre" && in.Kind != "final") {
		return fail(422, "Vul een naam en inspectietype in")
	}
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	fid, vid := id(), id()
	org := r.PathValue("org")
	if in.NormVersionID != nil {
		if !validID(*in.NormVersionID) {
			return fail(422, "Ongeldig normenkader")
		}
		var ok bool
		if e = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM norm_versions WHERE id=$1 AND org_id=$2 AND status='published')`, *in.NormVersionID, org).Scan(&ok); e != nil {
			return e
		}
		if !ok {
			return fail(422, "Kies een gepubliceerd normenkader")
		}
	}
	if _, e = tx.Exec(r.Context(), `INSERT INTO inspection_formats(id,org_id) VALUES($1,$2)`, fid, org); e != nil {
		return e
	}
	raw, _ := json.Marshal(starterScopes())
	if _, e = tx.Exec(r.Context(), `INSERT INTO format_versions(id,org_id,format_id,number,name,kind,norm_version_id,scopes,created_by) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8)`, vid, org, fid, strings.TrimSpace(in.Name), in.Kind, in.NormVersionID, raw, u.ID); e != nil {
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	send(w, 201, map[string]string{"id": vid})
	return nil
}
func validateFormat(d *formatDocument, norm *normDocument, publish bool) error {
	if strings.TrimSpace(d.Name) == "" || len(d.Name) > 160 || len(d.Description) > 3000 || (d.Kind != "pre" && d.Kind != "final") || len(d.Scopes) == 0 || len(d.Scopes) > 40 {
		return fail(422, "Controleer naam, type en ruimtes")
	}
	if publish && (norm == nil || norm.Status != "published") {
		return fail(422, "Koppel eerst een gepubliceerd normenkader")
	}
	rules := map[string]normRule{}
	if norm != nil {
		for _, rule := range norm.Rules {
			rules[rule.ID] = rule
		}
	}
	ids := map[string]bool{}
	propertyCount, requiredCount, total := 0, 0, 0
	for _, s := range d.Scopes {
		if !validID(s.ID) || ids[s.ID] || strings.TrimSpace(s.Name) == "" || len(s.Name) > 100 || len(s.NormRoom) > 100 || len(s.Questions) > 80 {
			return fail(422, "Controleer de ruimtecategorieën en unieke IDs")
		}
		ids[s.ID] = true
		if s.Property {
			propertyCount++
			if s.Repeatable {
				return fail(422, "Woning algemeen kan niet herhaald worden")
			}
		}
		if s.Required || s.Property {
			for _, q := range s.Questions {
				if q.Required {
					requiredCount++
				}
			}
		}
		preceding := map[string]formatQuestion{}
		linked := map[string]bool{}
		for _, q := range s.Questions {
			total++
			if !validID(q.ID) || ids[q.ID] || strings.TrimSpace(q.Title) == "" || len(q.Title) > 240 || len(q.Instruction) > 3000 || len(q.TalkingPrompt) > 500 || len(q.Unit) > 40 || q.MinPhotos < 0 || q.MinPhotos > 20 {
				return fail(422, "Controleer de vragen en instructies")
			}
			ids[q.ID] = true
			if !contains([]string{"boolean", "choice", "number", "text", "quality", "evidence"}, q.Kind) || !contains([]string{"none", "photo", "statement", "photo_statement", "any"}, q.Evidence) {
				return fail(422, "Ongeldig antwoord- of bewijstype")
			}
			if q.Kind == "choice" {
				seen := map[string]bool{}
				if len(q.Choices) < 2 || len(q.Choices) > 20 {
					return fail(422, "Voeg 2 tot 20 antwoordopties toe")
				}
				for _, c := range q.Choices {
					if strings.TrimSpace(c) == "" || len(c) > 160 || seen[c] {
						return fail(422, "Antwoordopties moeten uniek en ingevuld zijn")
					}
					seen[c] = true
				}
			}
			if q.ElementID != "" && !validID(q.ElementID) {
				return fail(422, "Ongeldig element")
			}
			if q.RuleID != "" {
				rule, ok := rules[q.RuleID]
				if !ok || linked[q.RuleID] {
					return fail(422, "Koppel elke norm maximaal eenmaal per ruimte, uit het gekozen kader")
				}
				if publish && !s.Property && !ruleApplies(rule, s.NormRoom) {
					return fail(422, "Een gekoppelde norm geldt niet voor deze ruimtecategorie")
				}
				linked[q.RuleID] = true
			}
			if q.Kind == "quality" && q.RuleID == "" {
				return fail(422, "Koppel een norm aan de kwaliteitsvraag")
			}
			if q.Condition != nil {
				parent, ok := preceding[q.Condition.QuestionID]
				if !ok || (parent.Kind != "boolean" && parent.Kind != "choice") || !parent.Required {
					return fail(422, "Een voorwaarde moet verwijzen naar een eerdere verplichte ja/nee- of keuzevraag")
				}
				if parent.Kind == "boolean" && !contains([]string{"true", "false"}, q.Condition.Equals) || parent.Kind == "choice" && !contains(parent.Choices, q.Condition.Equals) {
					return fail(422, "Kies een geldig antwoord voor de voorwaarde")
				}
			}
			preceding[q.ID] = q
		}
	}
	if propertyCount != 1 || total > 300 || publish && requiredCount == 0 {
		return fail(422, "Gebruik één categorie Woning algemeen en ten minste één verplichte vraag")
	}
	return nil
}
func contains(values []string, value string) bool {
	for _, s := range values {
		if s == value {
			return true
		}
	}
	return false
}
func (a *app) updateFormat(w http.ResponseWriter, r *http.Request) error {
	if _, _, e := a.require(r, "formats.manage"); e != nil {
		return e
	}
	if !a.hasPrivilege(r, "norms.read") {
		return fail(403, "Normen bekijken is nodig")
	}
	var in formatDocument
	if e := readJSON(w, r, &in); e != nil {
		return e
	}
	org := r.PathValue("org")
	var norm *normDocument
	var e error
	if in.NormVersionID != nil {
		if !validID(*in.NormVersionID) {
			return fail(422, "Ongeldig kader")
		}
		n, err := readNorm(r.Context(), a.db, org, *in.NormVersionID)
		if err != nil {
			return err
		}
		norm = &n
	}
	if e = validateFormat(&in, norm, false); e != nil {
		return e
	}
	raw, _ := json.Marshal(in.Scopes)
	// Published rows are excluded before the immutability trigger is reached.
	tag, e := a.db.Exec(r.Context(), `UPDATE format_versions SET name=$1,description=$2,kind=$3,norm_version_id=$4,scopes=$5,revision=revision+1 WHERE id=$6 AND org_id=$7 AND status='draft' AND revision=$8`, strings.TrimSpace(in.Name), in.Description, in.Kind, in.NormVersionID, raw, r.PathValue("format"), org, in.Revision)
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return fail(409, "Het format is gewijzigd of gepubliceerd. Herlaad de nieuwste versie.")
	}
	send(w, 200, map[string]int{"revision": in.Revision + 1})
	return nil
}
func (a *app) publishFormat(w http.ResponseWriter, r *http.Request) error {
	if _, _, e := a.require(r, "formats.manage"); e != nil {
		return e
	}
	var in struct {
		Revision int `json:"revision"`
	}
	if e := readJSON(w, r, &in); e != nil {
		return e
	}
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	org := r.PathValue("org")
	var lock string
	if e = tx.QueryRow(r.Context(), `SELECT id FROM format_versions WHERE id=$1 AND org_id=$2 FOR UPDATE`, r.PathValue("format"), org).Scan(&lock); e != nil {
		return e
	}
	d, e := readFormat(r.Context(), tx, org, lock)
	if e != nil {
		return e
	}
	if d.Status != "draft" || d.Revision != in.Revision {
		return fail(409, "Het format is gewijzigd of al gepubliceerd")
	}
	var norm *normDocument
	if d.NormVersionID != nil {
		n, err := readNorm(r.Context(), tx, org, *d.NormVersionID)
		if err != nil {
			return err
		}
		norm = &n
	}
	if e = validateFormat(d, norm, true); e != nil {
		return e
	}
	for _, scope := range d.Scopes {
		for _, q := range scope.Questions {
			if q.ElementID != "" {
				var ok bool
				if e = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM room_elements WHERE id=$1 AND org_id=$2 AND NOT archived)`, q.ElementID, org).Scan(&ok); e != nil {
					return e
				}
				if !ok {
					return fail(422, "Een gekozen element bestaat niet meer of is gearchiveerd")
				}
			}
		}
	}
	if _, e = tx.Exec(r.Context(), `UPDATE format_versions SET status='published',published_at=now() WHERE id=$1 AND org_id=$2`, d.ID, org); e != nil {
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	send(w, 200, map[string]string{"id": d.ID})
	return nil
}
func (a *app) reviseFormat(w http.ResponseWriter, r *http.Request) error {
	u, _, e := a.require(r, "formats.manage")
	if e != nil {
		return e
	}
	org := r.PathValue("org")
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	d, e := readFormat(r.Context(), tx, org, r.PathValue("format"))
	if e != nil {
		return e
	}
	if d.Status != "published" {
		return fail(422, "Publiceer eerst deze versie")
	}
	var lock string
	if e = tx.QueryRow(r.Context(), `SELECT id FROM inspection_formats WHERE id=$1 AND org_id=$2 FOR UPDATE`, d.FormatID, org).Scan(&lock); e != nil {
		return e
	}
	var draft string
	e = tx.QueryRow(r.Context(), `SELECT id FROM format_versions WHERE format_id=$1 AND org_id=$2 AND status='draft'`, d.FormatID, org).Scan(&draft)
	if e == pgx.ErrNoRows {
		draft = id()
		raw, _ := json.Marshal(d.Scopes)
		_, e = tx.Exec(r.Context(), `INSERT INTO format_versions(id,org_id,format_id,number,name,description,kind,norm_version_id,scopes,created_by) SELECT $1,$2,$3,max(number)+1,$4,$5,$6,$7,$8,$9 FROM format_versions WHERE format_id=$3 AND org_id=$2`, draft, org, d.FormatID, d.Name, d.Description, d.Kind, d.NormVersionID, raw, u.ID)
	}
	if e != nil {
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	send(w, 201, map[string]string{"id": draft})
	return nil
}
func instantiateScope(ctx context.Context, tx pgx.Tx, org, inspection, room, name string, s formatScope) error {
	tag, e := tx.Exec(ctx, `INSERT INTO rooms(id,org_id,inspection_id,name,category_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING`, room, org, inspection, name, s.ID)
	if e != nil {
		return e
	}
	if tag.RowsAffected() == 0 {
		var ok bool
		if e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM rooms WHERE id=$1 AND org_id=$2 AND inspection_id=$3 AND category_id=$4 AND name=$5)`, room, org, inspection, s.ID, name).Scan(&ok); e != nil {
			return e
		}
		if !ok {
			return fail(409, "Ruimte-ID al in gebruik")
		}
		return nil
	}
	if len(s.Questions) == 0 {
		if _, e = tx.Exec(ctx, `UPDATE rooms SET approved_generation=generation WHERE id=$1 AND org_id=$2`, room, org); e != nil {
			return e
		}
	}
	for _, q := range s.Questions {
		if _, e = tx.Exec(ctx, `INSERT INTO format_answers(id,org_id,inspection_id,room_id,question_id) VALUES($1,$2,$3,$4,$5)`, id(), org, inspection, room, q.ID); e != nil {
			return e
		}
	}
	return nil
}
