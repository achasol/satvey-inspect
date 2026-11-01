package app

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"reflect"
	"strings"
	"time"

	"satvey/inspect/internal/catalog"
	"satvey/inspect/internal/veradelivery"

	"github.com/jackc/pgx/v5"
)

type handoverDestination struct {
	ID               string `json:"id"`
	Name             string `json:"name"`
	Enabled          bool   `json:"enabled"`
	Revision         int    `json:"revision"`
	SecretConfigured bool   `json:"secretConfigured"`
	veradelivery.Config
	secret string
}

func readHandoverDestination(ctx context.Context, q querier, org, destination string) (handoverDestination, error) {
	var d handoverDestination
	var raw []byte
	if !validID(destination) {
		return d, fail(404, "VERA-bestemming niet gevonden")
	}
	err := q.QueryRow(ctx, `SELECT id,name,enabled,revision,config,secret FROM handover_destinations WHERE id=$1 AND org_id=$2`, destination, org).Scan(&d.ID, &d.Name, &d.Enabled, &d.Revision, &raw, &d.secret)
	if err == nil {
		err = json.Unmarshal(raw, &d.Config)
	}
	d.SecretConfigured = d.secret != ""
	return d, err
}

func (a *app) handoverDestinations(w http.ResponseWriter, r *http.Request) error {
	if _, err := a.admin(r); err != nil {
		return err
	}
	ids, err := handoverRows(r.Context(), a.db, `SELECT id FROM handover_destinations WHERE org_id=$1 ORDER BY name,id`, r.PathValue("org"))
	if err != nil {
		return err
	}
	rows := []handoverDestination{}
	for _, v := range ids {
		d, err := readHandoverDestination(r.Context(), a.db, r.PathValue("org"), v["id"].(string))
		if err != nil {
			return err
		}
		rows = append(rows, d)
	}
	mappings, err := list(r.Context(), a.db, `SELECT m.destination_id AS "destinationId",m.property_id AS "propertyId",m.unit_uri AS "unitUri",p.address FROM handover_property_mappings m JOIN properties p ON p.id=m.property_id AND p.org_id=m.org_id WHERE m.org_id=$1 ORDER BY p.address`, r.PathValue("org"))
	if err != nil {
		return err
	}
	jobs, err := a.handoverDeliveryList(r.Context(), a.db, r.PathValue("org"), "")
	if err != nil {
		return err
	}
	send(w, 200, map[string]any{"destinations": rows, "mappings": mappings, "deliveries": jobs})
	return nil
}

func validateHandoverConfig(d *handoverDestination) error {
	d.Name = strings.TrimSpace(d.Name)
	if d.Name == "" || len(d.Name) > 120 || strings.ContainsRune(d.Name, 0) {
		return fail(422, "Vul een bestemmingsnaam in (maximaal 120 tekens)")
	}
	for _, value := range []*string{&d.OnderhoudURL, &d.DossierURL, &d.VastgoedURL, &d.TokenURL} {
		if *value == "" && (value == &d.OnderhoudURL || value == &d.VastgoedURL) {
			continue
		}
		*value = strings.TrimRight(strings.TrimSpace(*value), "/")
		if len(*value) > 2000 {
			return fail(422, "De VERA-URL is te lang")
		}
		if e := veradelivery.Endpoint(*value); e != nil {
			return fail(422, e.Error())
		}
		if os.Getenv("APP_ENV") == "production" {
			if e := integrationPolicy().Validate(*value); e != nil {
				return fail(422, "De VERA-host is niet toegestaan in de serverconfiguratie")
			}
		}
	}
	for _, value := range []string{d.ClientID, d.Scopes, d.Organisation, d.Administration, d.ReportTypeCode, d.MaintenanceTypeCode} {
		if len(value) > 2000 || strings.ContainsRune(value, 0) {
			return fail(422, "Controleer de VERA-identificatie en referentiecodes")
		}
	}
	if strings.TrimSpace(d.ClientID) == "" || strings.TrimSpace(d.Organisation) == "" || strings.TrimSpace(d.Administration) == "" {
		return fail(422, "Vul client-ID, bronorganisatie en bronadministratie in")
	}
	return nil
}

func (a *app) saveHandoverDestination(w http.ResponseWriter, r *http.Request) error {
	if _, e := a.admin(r); e != nil {
		return e
	}
	var in struct {
		handoverDestination
		Secret string `json:"secret"`
	}
	if e := readJSON(w, r, &in); e != nil {
		return e
	}
	d := in.handoverDestination
	org := r.PathValue("org")
	if !validID(d.ID) || len(in.Secret) > 8000 {
		return fail(422, "Controleer de bestemming")
	}
	if e := validateHandoverConfig(&d); e != nil {
		return e
	}
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	if _, e = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "vera-destination:"+d.ID); e != nil {
		return e
	}
	old, e := readHandoverDestination(r.Context(), tx, org, d.ID)
	if e != nil && e != pgx.ErrNoRows {
		return e
	}
	creating := e == pgx.ErrNoRows
	if creating && d.Revision != 0 || !creating && old.Revision != d.Revision {
		return fail(409, "De VERA-bestemming is gewijzigd; herlaad de instellingen")
	}
	if !creating {
		var used bool
		if e = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM handover_deliveries WHERE org_id=$1 AND destination_id=$2)`, org, d.ID).Scan(&used); e != nil {
			return e
		}
		before, after := old.Config, d.Config
		before.TokenURL = after.TokenURL
		before.ClientID = after.ClientID
		before.Scopes = after.Scopes
		if used && !reflect.DeepEqual(before, after) {
			return fail(422, "Deze bestemming heeft overdrachten. Domeinen, bronidentiteit en inhoudelijke mappings staan vast; maak een nieuwe bestemming voor een andere koppeling")
		}
		d.secret = old.secret
	}
	if in.Secret != "" {
		d.secret, e = encryptPropertySecret(in.Secret, org, "handover:"+d.ID)
		if e != nil {
			return e
		}
	}
	if d.secret == "" {
		return fail(422, "Vul het OAuth2-clientgeheim in")
	}
	d.Revision++
	d.SecretConfigured = true
	raw, _ := json.Marshal(d.Config)
	tag, e := tx.Exec(r.Context(), `INSERT INTO handover_destinations(id,org_id,name,config,secret,enabled,revision) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,config=EXCLUDED.config,secret=EXCLUDED.secret,enabled=EXCLUDED.enabled,revision=EXCLUDED.revision WHERE handover_destinations.org_id=EXCLUDED.org_id`, d.ID, org, d.Name, raw, d.secret, d.Enabled, d.Revision)
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return fail(409, "Deze bestemmings-ID is al in gebruik")
	}
	// Capability evidence belongs to the exact endpoint and credential configuration.
	if _, e = tx.Exec(r.Context(), `UPDATE internal_sync_profiles SET tests='[]',tested_at=NULL WHERE org_id=$1 AND destination_id=$2`, org, d.ID); e != nil {
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	send(w, 200, d)
	return nil
}

func (a *app) newHandoverClient(ctx context.Context, org string, d handoverDestination) (*veradelivery.Client, error) {
	if !d.Enabled {
		return nil, fail(422, "De VERA-bestemming is uitgeschakeld")
	}
	if e := validateHandoverConfig(&d); e != nil {
		return nil, e
	}
	secret, e := decryptPropertySecret(d.secret, org, "handover:"+d.ID)
	if e != nil {
		return nil, e
	}
	client := integrationClient(30 * time.Second)
	if file := os.Getenv("VERA_CA_FILE"); file != "" {
		raw, e := os.ReadFile(file)
		if e != nil {
			return nil, fail(422, "Het VERA-vertrouwenscertificaat is niet beschikbaar")
		}
		roots, e := x509.SystemCertPool()
		if e != nil {
			roots = x509.NewCertPool()
		}
		if !roots.AppendCertsFromPEM(raw) {
			return nil, fail(422, "Ongeldig VERA-vertrouwenscertificaat")
		}
		if os.Getenv("APP_ENV") == "production" {
			client = integrationPolicy().ClientWithRoots(30*time.Second, roots)
		} else {
			transport := http.DefaultTransport.(*http.Transport).Clone()
			transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots}
			client.Transport = transport
		}
	}
	return &veradelivery.Client{Config: d.Config, HTTP: client, Secret: secret}, nil
}

func (a *app) testHandoverDestination(w http.ResponseWriter, r *http.Request) error {
	if _, e := a.admin(r); e != nil {
		return e
	}
	org := r.PathValue("org")
	d, e := readHandoverDestination(r.Context(), a.db, org, r.PathValue("destination"))
	if e != nil {
		return e
	}
	client, e := a.newHandoverClient(r.Context(), org, d)
	if e != nil {
		return e
	}
	if e = client.Probe(r.Context()); e != nil {
		return fail(422, e.Error())
	}
	send(w, 200, map[string]string{"message": "TLS, OAuth2 en Vastgoed-leestoegang geslaagd. Gebruik Mogelijkheden testen voor de capabilitymatrix en een afzonderlijke sandbox-schrijfproef."})
	return nil
}

func (a *app) mapHandoverProperty(w http.ResponseWriter, r *http.Request) error {
	if _, e := a.admin(r); e != nil {
		return e
	}
	var in struct {
		PropertyID string `json:"propertyId"`
		UnitURI    string `json:"unitUri"`
	}
	if e := readJSON(w, r, &in); e != nil {
		return e
	}
	org, destination := r.PathValue("org"), r.PathValue("destination")
	property, e := readProperty(r.Context(), a.db, org, in.PropertyID)
	if e != nil {
		return e
	}
	if property.LinkState != "linked" {
		return fail(422, "Koppel de voorlopige woning eerst aan een vastgoedbron")
	}
	d, e := readHandoverDestination(r.Context(), a.db, org, destination)
	if e != nil {
		return e
	}
	client, e := a.newHandoverClient(r.Context(), org, d)
	if e != nil {
		return e
	}
	if e = client.ValidateUnit(r.Context(), in.UnitURI); e != nil {
		return fail(422, e.Error())
	}
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	if _, e = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "vera-destination:"+d.ID); e != nil {
		return e
	}
	var revision int
	if e = tx.QueryRow(r.Context(), `SELECT revision FROM handover_destinations WHERE id=$1 AND org_id=$2 FOR UPDATE`, d.ID, org).Scan(&revision); e != nil {
		return e
	}
	if revision != d.Revision {
		return fail(409, "De bestemming is gewijzigd")
	}
	var used bool
	if e = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM handover_deliveries WHERE org_id=$1 AND destination_id=$2 AND snapshot->'report'->'property'->>'id'=$3)`, org, destination, in.PropertyID).Scan(&used); e != nil {
		return e
	}
	if used {
		return fail(422, "De woningkoppeling van een gebruikte bestemming staat vast")
	}
	_, e = tx.Exec(r.Context(), `INSERT INTO handover_property_mappings(destination_id,org_id,property_id,unit_uri) VALUES($1,$2,$3,$4) ON CONFLICT(destination_id,property_id) DO UPDATE SET unit_uri=EXCLUDED.unit_uri WHERE handover_property_mappings.org_id=EXCLUDED.org_id`, destination, org, in.PropertyID, in.UnitURI)
	if e != nil {
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	send(w, 200, map[string]bool{"ok": true})
	return nil
}

func (a *app) receivingUnit(ctx context.Context, q querier, org string, d handoverDestination, p catalog.Property) (string, error) {
	var uri string
	e := q.QueryRow(ctx, `SELECT unit_uri FROM handover_property_mappings WHERE org_id=$1 AND destination_id=$2 AND property_id=$3`, org, d.ID, p.ID).Scan(&uri)
	if e == nil {
		return uri, nil
	}
	if e != pgx.ErrNoRows {
		return "", e
	}
	if p.SourceID != nil && p.SourceObjectID != nil && p.SourceKind != nil && *p.SourceKind == "vera" {
		source, e := readPropertySource(ctx, q, org, *p.SourceID)
		if e != nil {
			return "", e
		}
		if strings.TrimRight(source.BaseURL, "/") == d.VastgoedURL {
			return d.VastgoedURL + "/eenheden/" + url.PathEscape(*p.SourceObjectID), nil
		}
	}
	return "", fail(422, "Een beheerder moet deze woning eerst aan de VERA-bestemming koppelen")
}

func (a *app) handoverChoices(ctx context.Context, q querier, org string, p catalog.Property) ([]map[string]any, error) {
	rows, e := handoverRows(ctx, q, `SELECT id,name,enabled FROM handover_destinations WHERE org_id=$1 ORDER BY name,id`, org)
	if e != nil {
		return nil, e
	}
	for _, row := range rows {
		d, e := readHandoverDestination(ctx, q, org, fmt.Sprint(row["id"]))
		if e != nil {
			return nil, e
		}
		_, mappingError := a.receivingUnit(ctx, q, org, d, p)
		row["ready"] = d.Enabled && mappingError == nil
		row["reason"] = ""
		if !d.Enabled {
			row["reason"] = "Bestemming uitgeschakeld"
		} else if mappingError != nil {
			row["reason"] = "Woningkoppeling ontbreekt"
		}
	}
	return rows, nil
}

func handoverRows(ctx context.Context, q querier, query string, args ...any) ([]map[string]any, error) {
	raw, e := list(ctx, q, query, args...)
	if e != nil {
		return nil, e
	}
	var rows []map[string]any
	e = json.Unmarshal(raw, &rows)
	return rows, e
}
