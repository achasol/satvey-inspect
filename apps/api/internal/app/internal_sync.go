package app

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"net/http"
	"net/url"
	"regexp"
	"satvey/inspect/internal/veradelivery"
	"strings"
	"time"
)

var syncCategories = []string{"property", "status", "rooms", "findings", "assessments", "agreements", "photos", "reports", "audio", "transcripts"}

type syncMapping struct {
	Enabled     bool              `json:"enabled"`
	Resource    string            `json:"resource"`
	Fields      map[string]string `json:"fields"`
	TestPayload map[string]any    `json:"testPayload"`
}
type syncProfile struct {
	DestinationID string                 `json:"destinationId"`
	Enabled       bool                   `json:"enabled"`
	Environment   string                 `json:"environment"`
	Revision      int                    `json:"revision"`
	OpenAPIURL    string                 `json:"openApiUrl"`
	Categories    map[string]syncMapping `json:"categories"`
	Tests         json.RawMessage        `json:"tests"`
	TestedAt      *time.Time             `json:"testedAt"`
}
type syncCapability struct {
	Category    string `json:"category"`
	State       string `json:"state"`
	Declared    bool   `json:"declared"`
	ReadTested  bool   `json:"readTested"`
	WriteTested bool   `json:"writeTested"`
	Message     string `json:"message"`
	ReceiverID  string `json:"receiverId,omitempty"`
	Cleanup     string `json:"cleanup,omitempty"`
}

func readSyncProfile(ctx context.Context, q querier, org, destination string) (syncProfile, error) {
	p := syncProfile{DestinationID: destination, Environment: "production", Categories: map[string]syncMapping{}, Tests: json.RawMessage("[]")}
	var raw []byte
	err := q.QueryRow(ctx, `SELECT config,revision,tests,tested_at FROM internal_sync_profiles WHERE org_id=$1 AND destination_id=$2`, org, destination).Scan(&raw, &p.Revision, &p.Tests, &p.TestedAt)
	if err != nil {
		return p, err
	}
	revision, tests, at := p.Revision, p.Tests, p.TestedAt
	err = json.Unmarshal(raw, &p)
	p.Revision = revision
	p.Tests = tests
	p.TestedAt = at
	return p, err
}
func validResource(raw string, d handoverDestination) bool {
	u, err := url.Parse(raw)
	if err != nil || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		return false
	}
	for _, base := range []string{d.DossierURL, d.OnderhoudURL, d.VastgoedURL} {
		b, e := url.Parse(strings.TrimRight(base, "/") + "/")
		if e == nil && u.Scheme == b.Scheme && strings.EqualFold(u.Host, b.Host) && strings.HasPrefix(u.EscapedPath(), b.EscapedPath()) {
			return true
		}
	}
	return false
}
func (a *app) syncProfile(w http.ResponseWriter, r *http.Request) error {
	if _, err := a.admin(r); err != nil {
		return err
	}
	org, destination := r.PathValue("org"), r.PathValue("destination")
	d, err := readHandoverDestination(r.Context(), a.db, org, destination)
	if err != nil {
		return err
	}
	if r.Method == "GET" {
		p, err := readSyncProfile(r.Context(), a.db, org, destination)
		if err != nil && !isNotFound(err) {
			return err
		}
		send(w, 200, p)
		return nil
	}
	var p syncProfile
	if err = readJSON(w, r, &p); err != nil {
		return err
	}
	if !contains([]string{"production", "sandbox"}, p.Environment) || len(p.Categories) > len(syncCategories) || p.OpenAPIURL != "" && !validResource(p.OpenAPIURL, d) {
		return fail(422, "Controleer omgeving en de API-specificatie binnen de ingestelde domeinen")
	}
	for category, m := range p.Categories {
		if !contains(syncCategories, category) || len(m.Fields) > 60 || len(m.Resource) > 2000 {
			return fail(422, "Onbekende categorie of te veel veldtoewijzingen")
		}
		if m.Enabled && (!validResource(m.Resource, d) || len(m.Fields) == 0) {
			return fail(422, "Stel per ingeschakelde categorie een resource en veldtoewijzing in")
		}
		if strings.Contains(strings.ToLower(m.Resource), "onderhoudsorder") || strings.Contains(strings.ToLower(m.Resource), "opdracht") {
			return fail(422, "Deze koppeling synchroniseert inspectiegegevens en maakt geen onderhoudsopdrachten")
		}
		for target, source := range m.Fields {
			if !regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,79}$`).MatchString(target) || len(source) > 200 || !regexp.MustCompile(`^[A-Za-z0-9_.]+$`).MatchString(source) {
				return fail(422, "Gebruik geldige veldnamen en bronpaden")
			}
		}
	}
	p.DestinationID = destination
	p.Tests = nil
	p.TestedAt = nil
	raw, _ := json.Marshal(p)
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	tag, err := tx.Exec(r.Context(), `INSERT INTO internal_sync_profiles(destination_id,org_id,enabled,environment,config) SELECT $1,$2,$3,$4,$5 WHERE $6=0 ON CONFLICT(destination_id) DO UPDATE SET enabled=EXCLUDED.enabled,environment=EXCLUDED.environment,config=EXCLUDED.config,revision=internal_sync_profiles.revision+1,tests='[]',tested_at=NULL WHERE internal_sync_profiles.org_id=$2 AND internal_sync_profiles.revision=$6`, destination, org, p.Enabled, p.Environment, raw, p.Revision)
	if p.Revision > 0 {
		tag, err = tx.Exec(r.Context(), `UPDATE internal_sync_profiles SET enabled=$3,environment=$4,config=$5,revision=revision+1,tests='[]',tested_at=NULL WHERE destination_id=$1 AND org_id=$2 AND revision=$6`, destination, org, p.Enabled, p.Environment, raw, p.Revision)
	}
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return fail(409, "Koppeling gewijzigd; herlaad")
	}
	if _, err = tx.Exec(r.Context(), `UPDATE internal_sync_jobs SET status='cancelled',error='Configuratie gewijzigd',run_token=NULL WHERE org_id=$1 AND destination_id=$2 AND status NOT IN ('done','cancelled')`, org, destination); err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	p, err = readSyncProfile(r.Context(), a.db, org, destination)
	if err != nil {
		return err
	}
	send(w, 200, p)
	return nil
}
func isNotFound(err error) bool { return errors.Is(err, pgx.ErrNoRows) }

func (a *app) testSyncProfile(w http.ResponseWriter, r *http.Request) error {
	if _, err := a.admin(r); err != nil {
		return err
	}
	org, destination := r.PathValue("org"), r.PathValue("destination")
	var in struct {
		Mode string `json:"mode"`
	}
	if err := readJSON(w, r, &in); err != nil {
		return err
	}
	if in.Mode != "read" && in.Mode != "sandbox" {
		return fail(422, "Kies een leestest of sandboxproef")
	}
	p, err := readSyncProfile(r.Context(), a.db, org, destination)
	if err != nil {
		return err
	}
	if in.Mode == "sandbox" && p.Environment != "sandbox" {
		return fail(422, "Een schrijfproef is uitsluitend beschikbaar op een sandboxbestemming")
	}
	d, err := readHandoverDestination(r.Context(), a.db, org, destination)
	if err != nil {
		return err
	}
	d.Enabled = true
	client, err := a.newHandoverClient(r.Context(), org, d)
	if err != nil {
		return err
	}
	var spec map[string]any
	if p.OpenAPIURL != "" {
		spec, _ = client.Specification(r.Context(), p.OpenAPIURL)
	}
	results := []syncCapability{}
	for _, category := range syncCategories {
		mapping := p.Categories[category]
		result := syncCapability{Category: category, State: "unknown", Message: "Geen resource ingesteld"}
		if mapping.Resource == "" {
			results = append(results, result)
			continue
		}
		if paths, ok := spec["paths"].(map[string]any); ok {
			for path, operations := range paths {
				if strings.HasSuffix(mapping.Resource, path) {
					if methods, ok := operations.(map[string]any); ok {
						_, result.Declared = methods["get"]
					}
				}
			}
		}
		if err = client.ProbeResource(r.Context(), mapping.Resource); err != nil {
			result.Message = err.Error()
			var remote *veradelivery.Error
			if errors.As(err, &remote) {
				if remote.Status == 401 || remote.Status == 403 {
					result.State = "permission_denied"
				}
				if remote.Status == 405 {
					result.State = "unsupported"
				}
			}
			results = append(results, result)
			continue
		}
		result.State = "read_tested"
		result.ReadTested = true
		result.Message = "Leestoegang geslaagd; schrijftoegang nog niet bewezen"
		if in.Mode == "sandbox" {
			if len(mapping.TestPayload) == 0 {
				result.Message = "Leestest geslaagd. Stel een geldig leveranciers-testrecord in voor de schrijfproef."
			} else {
				row := map[string]any{}
				for key, value := range mapping.TestPayload {
					row[key] = value
				}
				external := "SATVEY-TEST-" + id()
				row["idExtern"] = external
				row["idOrganisatie"] = d.Organisation
				row["idAdministratie"] = d.Administration
				receiver, e := client.SynchronizeResource(r.Context(), mapping.Resource, row)
				if e != nil {
					result.Message = e.Error()
				} else {
					result.State = "write_tested"
					result.WriteTested = true
					result.ReceiverID = receiver
					result.Message = "Schrijven en teruglezen geslaagd"
					if e = client.DeleteTestResource(r.Context(), mapping.Resource, receiver, external); e != nil {
						result.Cleanup = "Handmatig opruimen nodig: " + e.Error()
					} else {
						result.Cleanup = "Testrecord verwijderd"
					}
				}
			}
		}
		results = append(results, result)
	}
	raw, _ := json.Marshal(results)
	tag, err := a.db.Exec(r.Context(), `UPDATE internal_sync_profiles SET tests=$3,tested_at=now() WHERE org_id=$1 AND destination_id=$2 AND revision=$4 AND EXISTS(SELECT 1 FROM handover_destinations d WHERE d.id=$2 AND d.org_id=$1 AND d.revision=$5)`, org, destination, raw, p.Revision, d.Revision)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return fail(409, "Configuratie gewijzigd tijdens de test")
	}
	send(w, 200, map[string]any{"revision": p.Revision, "results": results})
	return nil
}
func (a *app) syncStatus(w http.ResponseWriter, r *http.Request) error {
	if _, _, err := a.access(r, false); err != nil {
		return err
	}
	rows, err := list(r.Context(), a.db, `SELECT j.id,j.category,j.source_revision AS "sourceRevision",j.status,j.error,j.created_at AS "createdAt",j.completed_at AS "completedAt",d.name AS destination FROM internal_sync_jobs j JOIN handover_destinations d ON d.id=j.destination_id WHERE j.org_id=$1 AND ($2='' OR j.inspection_id::text=$2) ORDER BY j.created_at DESC LIMIT 100`, r.PathValue("org"), r.PathValue("inspection"))
	if err != nil {
		return err
	}
	send(w, 200, rows)
	return nil
}
func (a *app) retrySync(w http.ResponseWriter, r *http.Request) error {
	if _, err := a.admin(r); err != nil {
		return err
	}
	tag, err := a.db.Exec(r.Context(), `UPDATE internal_sync_jobs SET status='pending',next_attempt_at=now(),error='',run_token=NULL WHERE id::text=$1 AND org_id=$2 AND status IN ('blocked','retrying')`, r.PathValue("job"), r.PathValue("org"))
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return fail(409, "Deze synchronisatie kan niet opnieuw worden gestart")
	}
	send(w, 200, map[string]bool{"ok": true})
	return nil
}
