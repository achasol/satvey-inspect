package app

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"satvey/inspect/internal/catalog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type propertySource struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	Administration string `json:"administration"`
	Kind           string `json:"kind"`
	BaseURL        string `json:"baseUrl"`
	TokenURL       string `json:"tokenUrl"`
	AuthKind       string `json:"authKind"`
	ClientID       string `json:"clientId"`
	Scopes         string `json:"scopes"`
	Enabled        bool   `json:"enabled"`
	Revision       int    `json:"revision"`
	Secret         string `json:"-"`
}

const sourceColumns = `id,name,administration,kind,base_url,token_url,auth_kind,client_id,scopes,enabled,revision,secret`

func readPropertySource(ctx context.Context, q querier, org, source string) (propertySource, error) {
	var s propertySource
	if !validID(source) {
		return s, fail(404, "Vastgoedbron niet gevonden")
	}
	e := q.QueryRow(ctx, `SELECT `+sourceColumns+` FROM property_sources WHERE id=$1 AND org_id=$2`, source, org).Scan(&s.ID, &s.Name, &s.Administration, &s.Kind, &s.BaseURL, &s.TokenURL, &s.AuthKind, &s.ClientID, &s.Scopes, &s.Enabled, &s.Revision, &s.Secret)
	return s, e
}
func propertyCipher() (cipher.AEAD, error) {
	key, e := base64.StdEncoding.DecodeString(os.Getenv("PROPERTY_ENCRYPTION_KEY"))
	if e != nil || len(key) != 32 {
		return nil, fail(422, "Configureer PROPERTY_ENCRYPTION_KEY op de server (32 willekeurige bytes, base64)")
	}
	block, e := aes.NewCipher(key)
	if e != nil {
		return nil, e
	}
	return cipher.NewGCM(block)
}
func encryptPropertySecret(secret, org, source string) (string, error) {
	aead, e := propertyCipher()
	if e != nil {
		return "", e
	}
	nonce := make([]byte, aead.NonceSize())
	if _, e = rand.Read(nonce); e != nil {
		return "", e
	}
	return base64.StdEncoding.EncodeToString(aead.Seal(nonce, nonce, []byte(secret), []byte(org+":"+source))), nil
}
func decryptPropertySecret(secret, org, source string) (string, error) {
	aead, e := propertyCipher()
	if e != nil {
		return "", e
	}
	raw, e := base64.StdEncoding.DecodeString(secret)
	if e != nil || len(raw) < aead.NonceSize() {
		return "", fmt.Errorf("vastgoedsleutel kan niet worden ontsleuteld")
	}
	plain, e := aead.Open(nil, raw[:aead.NonceSize()], raw[aead.NonceSize():], []byte(org+":"+source))
	if e != nil {
		return "", fmt.Errorf("vastgoedsleutel kan niet worden ontsleuteld")
	}
	return string(plain), nil
}
func propertyURL(raw string) (*url.URL, error) {
	u, e := url.Parse(raw)
	if e != nil || u.Host == "" || u.User != nil || u.Fragment != "" || u.RawQuery != "" || (u.Scheme != "https" && !(u.Scheme == "http" && os.Getenv("ALLOW_HTTP_PROPERTY_API") == "true")) {
		return nil, fail(422, "Gebruik een volledige HTTPS-bron-URL zonder gebruikersgegevens, query of fragment")
	}
	if os.Getenv("APP_ENV") == "production" {
		if e := integrationPolicy().Validate(raw); e != nil {
			return nil, fail(422, "Bronhost is niet toegestaan in de serverconfiguratie")
		}
	}
	return u, nil
}
func (a *app) propertySources(w http.ResponseWriter, r *http.Request) error {
	if _, e := a.admin(r); e != nil {
		return e
	}
	sources, e := list(r.Context(), a.db, `SELECT id,name,administration,kind,base_url AS "baseUrl",token_url AS "tokenUrl",auth_kind AS "authKind",client_id AS "clientId",scopes,enabled,revision,(secret<>'') AS "secretConfigured",last_synced_at AS "lastSyncedAt",last_error AS "lastError",next_sync_at AS "nextSyncAt" FROM property_sources WHERE org_id=$1 ORDER BY name,id`, r.PathValue("org"))
	if e != nil {
		return e
	}
	jobs, e := list(r.Context(), a.db, `SELECT j.id,j.source_id AS "sourceId",s.name AS "sourceName",j.property_id AS "propertyId",j.status,j.attempts,j.processed,j.last_error AS error,j.created_at AS "createdAt",j.finished_at AS "finishedAt" FROM property_sync_jobs j JOIN property_sources s ON s.id=j.source_id AND s.org_id=j.org_id WHERE j.org_id=$1 ORDER BY j.created_at DESC LIMIT 30`, r.PathValue("org"))
	if e != nil {
		return e
	}
	send(w, 200, map[string]any{"sources": sources, "jobs": jobs})
	return nil
}
func (a *app) savePropertySource(w http.ResponseWriter, r *http.Request) error {
	if _, e := a.admin(r); e != nil {
		return e
	}
	var in struct {
		ID             string `json:"id"`
		Name           string `json:"name"`
		Administration string `json:"administration"`
		Kind           string `json:"kind"`
		BaseURL        string `json:"baseUrl"`
		TokenURL       string `json:"tokenUrl"`
		AuthKind       string `json:"authKind"`
		ClientID       string `json:"clientId"`
		Scopes         string `json:"scopes"`
		Secret         string `json:"secret"`
		Enabled        bool   `json:"enabled"`
		Revision       int    `json:"revision"`
	}
	if e := readJSON(w, r, &in); e != nil {
		return e
	}
	source := r.PathValue("source")
	creating := source == ""
	if creating {
		source = in.ID
	}
	in.Name = strings.TrimSpace(in.Name)
	in.Administration = strings.TrimSpace(in.Administration)
	in.BaseURL = strings.TrimRight(strings.TrimSpace(in.BaseURL), "/")
	in.TokenURL = strings.TrimSpace(in.TokenURL)
	if !validID(source) || in.Name == "" || len(in.Name) > 120 || in.Administration == "" || len(in.Administration) > 160 || (in.Kind != "csv" && in.Kind != "vera") || len(in.Secret) > 8000 || len(in.ClientID) > 512 || len(in.Scopes) > 2000 || len(in.BaseURL) > 2000 || len(in.TokenURL) > 2000 || strings.ContainsRune(in.Name+in.Administration+in.ClientID+in.Scopes, 0) {
		return fail(422, "Controleer bron, administratie en aanleverroute")
	}
	if in.AuthKind == "" {
		in.AuthKind = "api_key"
	}
	if in.AuthKind != "api_key" && in.AuthKind != "oauth2" {
		return fail(422, "Kies API-key of OAuth2")
	}
	if in.Kind == "vera" {
		if _, e := propertyURL(in.BaseURL); e != nil {
			return e
		}
		if in.AuthKind == "oauth2" {
			if _, e := propertyURL(in.TokenURL); e != nil {
				return e
			}
			if strings.TrimSpace(in.ClientID) == "" {
				return fail(422, "OAuth2 vereist een client-ID")
			}
		}
	}
	org := r.PathValue("org")
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	secret := ""
	if !creating {
		if _, e = tx.Exec(r.Context(), `SELECT id FROM property_sources WHERE id=$1 AND org_id=$2 FOR UPDATE`, source, org); e != nil {
			return e
		}
		old, err := readPropertySource(r.Context(), tx, org, source)
		if err != nil {
			return err
		}
		if old.Revision != in.Revision {
			return fail(409, "Deze bronconfiguratie is gewijzigd; herlaad de instellingen")
		}
		if old.Kind != in.Kind || old.Administration != in.Administration {
			return fail(422, "De administratie en aanleverroute van een bestaande bron staan vast; maak hiervoor een nieuwe bron")
		}
		// Changing an endpoint could silently give existing IDs a different meaning.
		if old.BaseURL != in.BaseURL && in.Kind == "vera" {
			var used bool
			if e = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM properties WHERE org_id=$1 AND source_id=$2)`, org, source).Scan(&used); e != nil {
				return e
			}
			if used {
				return fail(422, "Deze bron bevat woningen; maak voor een ander API-adres een nieuwe bron")
			}
		}
		secret = old.Secret
	}
	if in.Kind == "vera" {
		if in.Secret != "" {
			secret, e = encryptPropertySecret(in.Secret, org, source)
			if e != nil {
				return e
			}
		}
		if secret == "" {
			return fail(422, "Vul de API-key of het client secret in")
		}
	} else {
		secret = ""
		in.BaseURL = ""
		in.TokenURL = ""
		in.ClientID = ""
		in.Scopes = ""
	}
	if creating {
		_, e = tx.Exec(r.Context(), `INSERT INTO property_sources(id,org_id,name,administration,kind,base_url,token_url,auth_kind,client_id,scopes,secret,enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, source, org, in.Name, in.Administration, in.Kind, in.BaseURL, in.TokenURL, in.AuthKind, in.ClientID, in.Scopes, secret, in.Enabled)
	} else {
		_, e = tx.Exec(r.Context(), `UPDATE property_sources SET name=$1,base_url=$2,token_url=$3,auth_kind=$4,client_id=$5,scopes=$6,secret=$7,enabled=$8,revision=revision+1,next_sync_at=now() WHERE id=$9 AND org_id=$10`, in.Name, in.BaseURL, in.TokenURL, in.AuthKind, in.ClientID, in.Scopes, secret, in.Enabled, source, org)
		if e == nil {
			_, e = tx.Exec(r.Context(), `UPDATE property_sync_jobs SET status='failed',run_token=NULL,lease_until=NULL,last_error='Bronconfiguratie gewijzigd; start opnieuw',finished_at=now() WHERE source_id=$1 AND org_id=$2 AND status IN ('pending','processing')`, source, org)
		}
		if e == nil {
			_, e = tx.Exec(r.Context(), `DELETE FROM property_sync_seen WHERE job_id IN (SELECT id FROM property_sync_jobs WHERE source_id=$1 AND org_id=$2 AND status='failed')`, source, org)
		}
	}
	if e != nil {
		var constraint *pgconn.PgError
		if errors.As(e, &constraint) && constraint.Code == "23505" {
			return fail(409, "Deze bronadministratie of bron-ID bestaat al")
		}
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	send(w, 200, map[string]string{"id": source})
	return nil
}

var propertyCSVColumns = catalog.CSVColumns

func (a *app) propertyCSVTemplate(w http.ResponseWriter, r *http.Request) error {
	if _, e := a.admin(r); e != nil {
		return e
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="satvey-vastgoed.csv"`)
	writer := csv.NewWriter(w)
	_ = writer.Write(propertyCSVColumns)
	writer.Flush()
	return writer.Error()
}
func (a *app) previewPropertyImport(w http.ResponseWriter, r *http.Request) error {
	u, e := a.admin(r)
	if e != nil {
		return e
	}
	var in struct {
		CSV string `json:"csv"`
	}
	if e = readJSON(w, r, &in); e != nil {
		return e
	}
	org, source := r.PathValue("org"), r.PathValue("source")
	tx, e := a.db.BeginTx(r.Context(), pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	s, e := readPropertySource(r.Context(), tx, org, source)
	if e != nil {
		return e
	}
	if s.Kind != "csv" || !s.Enabled {
		return fail(422, "Kies een ingeschakelde CSV-bron; VERA-bronnen worden via hun API beheerd")
	}
	rows, validation := parsePropertyCSV(in.CSV)
	if len(validation) > 0 {
		send(w, 200, map[string]any{"errors": validation, "rows": len(rows)})
		return nil
	}
	fingerprint, e := catalogFingerprint(r.Context(), tx, org, source)
	if e != nil {
		return e
	}
	created, updated, unchanged := 0, 0, 0
	changes := []map[string]any{}
	for _, row := range rows {
		var oldID string
		err := tx.QueryRow(r.Context(), `SELECT id FROM properties WHERE org_id=$1 AND source_id=$2 AND source_object_id=$3`, org, source, row.SourceObjectID).Scan(&oldID)
		if err == pgx.ErrNoRows {
			created++
			if len(changes) < 100 {
				changes = append(changes, map[string]any{"before": nil, "after": row})
			}
			continue
		}
		if err != nil {
			return err
		}
		old, err := readProperty(r.Context(), tx, org, oldID)
		if err != nil {
			return err
		}
		before := catalogRow{SourceObjectID: *old.SourceObjectID, ObjectNumber: old.ObjectNumber, Address: old.Address, Postcode: old.Postcode, City: old.City, Details: old.Details}
		b, _ := json.Marshal(before)
		after, _ := json.Marshal(row)
		if string(b) == string(after) {
			unchanged++
		} else {
			updated++
			if len(changes) < 100 {
				changes = append(changes, map[string]any{"before": before, "after": row})
			}
		}
	}
	importID := id()
	raw, _ := json.Marshal(rows)
	if _, e = tx.Exec(r.Context(), `INSERT INTO property_imports(id,org_id,source_id,actor_id,source_revision,catalog_fingerprint,rows) VALUES($1,$2,$3,$4,$5,$6,$7)`, importID, org, source, u.ID, s.Revision, fingerprint, raw); e != nil {
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	send(w, 200, map[string]any{"id": importID, "errors": []string{}, "rows": len(rows), "created": created, "updated": updated, "unchanged": unchanged, "changes": changes, "changesTruncated": created+updated > len(changes)})
	return nil
}
func (a *app) confirmPropertyImport(w http.ResponseWriter, r *http.Request) error {
	u, e := a.admin(r)
	if e != nil {
		return e
	}
	org, source, importID := r.PathValue("org"), r.PathValue("source"), r.PathValue("import")
	if !validID(importID) || !validID(source) {
		return fail(404, "Import niet gevonden")
	}
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	if _, e = tx.Exec(r.Context(), `SELECT id FROM property_sources WHERE id=$1 AND org_id=$2 FOR UPDATE`, source, org); e != nil {
		return e
	}
	s, e := readPropertySource(r.Context(), tx, org, source)
	if e != nil {
		return e
	}
	if s.Kind != "csv" || !s.Enabled {
		return fail(422, "Deze bron accepteert geen CSV-import")
	}
	var raw []byte
	var revision int
	var fingerprint string
	var expires time.Time
	var confirmed *time.Time
	if e = tx.QueryRow(r.Context(), `SELECT rows,source_revision,catalog_fingerprint,expires_at,confirmed_at FROM property_imports WHERE id=$1 AND org_id=$2 AND source_id=$3 FOR UPDATE`, importID, org, source).Scan(&raw, &revision, &fingerprint, &expires, &confirmed); e != nil {
		return e
	}
	if confirmed != nil {
		send(w, 200, map[string]bool{"ok": true})
		return nil
	}
	current, e := catalogFingerprint(r.Context(), tx, org, source)
	if e != nil {
		return e
	}
	if revision != s.Revision || current != fingerprint || time.Now().After(expires) {
		return fail(409, "Bron of catalogus is gewijzigd, of de import is verlopen; valideer het bestand opnieuw")
	}
	var rows []catalogRow
	if e = json.Unmarshal(raw, &rows); e != nil {
		return e
	}
	if e = upsertCatalogRows(r.Context(), tx, org, source, rows); e != nil {
		return e
	}
	if _, e = tx.Exec(r.Context(), `UPDATE property_imports SET confirmed_at=now() WHERE id=$1;`, importID); e != nil {
		return e
	}
	if _, e = tx.Exec(r.Context(), `UPDATE property_sources SET last_synced_at=now(),last_error='' WHERE id=$1 AND org_id=$2`, source, org); e != nil {
		return e
	}
	// The confirming administrator is recorded even if another administrator prepared the preview.
	if _, e = tx.Exec(r.Context(), `UPDATE property_imports SET actor_id=$1 WHERE id=$2`, u.ID, importID); e != nil {
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	send(w, 200, map[string]bool{"ok": true})
	return nil
}

func parsePropertyCSV(raw string) ([]catalogRow, []string) { return catalog.ParseCSV(raw) }
