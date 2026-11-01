// Package veradelivery sends the supported VERA 4.3.3 handover profile.
// It deliberately does not create maintenance orders or change execution state.
package veradelivery

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"time"
)

const MaxRecordBytes = 8 << 20

type Config struct {
	MaxRecordSize       int    `json:"-"`
	OnderhoudURL        string `json:"onderhoudUrl"`
	DossierURL          string `json:"dossierUrl"`
	VastgoedURL         string `json:"vastgoedUrl"`
	TokenURL            string `json:"tokenUrl"`
	ClientID            string `json:"clientId"`
	Scopes              string `json:"scopes"`
	Organisation        string `json:"organisation"`
	Administration      string `json:"administration"`
	ReportTypeCode      string `json:"reportTypeCode"`
	MaintenanceTypeCode string `json:"maintenanceTypeCode"`
}

type Error struct {
	Status     int
	Message    string
	Temporary  bool
	RetryAfter time.Duration
}

func (e *Error) Error() string     { return e.Message }
func blocked(message string) error { return &Error{Message: message} }

type Client struct {
	BeforeRequest     func() error
	Config            Config
	HTTP              *http.Client
	Secret, Reference string
	bearer            string
}

func Endpoint(raw string) error {
	u, e := url.Parse(raw)
	if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return blocked("Gebruik een volledige HTTPS-URL zonder gebruikersgegevens, query of fragment")
	}
	return nil
}

func (c *Client) Authenticate(ctx context.Context) error {
	if c.BeforeRequest != nil {
		if e := c.BeforeRequest(); e != nil {
			return e
		}
	}
	body := url.Values{"grant_type": {"client_credentials"}}
	if c.Config.Scopes != "" {
		body.Set("scope", c.Config.Scopes)
	}
	req, e := http.NewRequestWithContext(ctx, "POST", c.Config.TokenURL, strings.NewReader(body.Encode()))
	if e != nil {
		return blocked("Ongeldig OAuth2-endpoint")
	}
	req.SetBasicAuth(c.Config.ClientID, c.Secret)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, e := c.HTTP.Do(req)
	if e != nil {
		return transportError(e)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return responseError(res)
	}
	var value struct {
		Token string `json:"access_token"`
		Type  string `json:"token_type"`
	}
	if json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&value) != nil || value.Token == "" || !strings.EqualFold(value.Type, "Bearer") {
		return blocked("Het ontvangende systeem gaf een ongeldig tokenantwoord")
	}
	c.bearer = value.Token
	return nil
}

func transportError(err error) error {
	var unknown x509.UnknownAuthorityError
	var hostname x509.HostnameError
	var invalid x509.CertificateInvalidError
	if errors.As(err, &unknown) || errors.As(err, &hostname) || errors.As(err, &invalid) {
		return blocked("Het TLS-certificaat van de VERA-koppeling kan niet worden vertrouwd")
	}
	return &Error{Message: "VERA tijdelijk niet bereikbaar; ontvangst wordt bij de volgende poging gecontroleerd", Temporary: true}
}
func responseError(res *http.Response) error {
	retry := res.StatusCode == 429 || res.StatusCode >= 500
	delay := time.Duration(0)
	if seconds, e := strconv.Atoi(res.Header.Get("Retry-After")); e == nil && seconds > 0 {
		if seconds > 86400 {
			seconds = 86400
		}
		delay = time.Duration(seconds) * time.Second
	} else if at, e := http.ParseTime(res.Header.Get("Retry-After")); e == nil {
		delay = time.Until(at)
		if delay > 24*time.Hour {
			delay = 24 * time.Hour
		}
	}
	return &Error{Status: res.StatusCode, Message: fmt.Sprintf("Het ontvangende systeem gaf HTTP %d; controleer de koppeling of invoer", res.StatusCode), Temporary: retry, RetryAfter: delay}
}

func within(endpoint, base string) bool {
	u, e := url.Parse(endpoint)
	b, be := url.Parse(strings.TrimRight(base, "/") + "/")
	return e == nil && be == nil && u.Scheme == b.Scheme && strings.EqualFold(u.Host, b.Host) && u.User == nil && u.Fragment == "" && strings.HasPrefix(u.EscapedPath(), b.EscapedPath())
}
func (c *Client) resourceURL(collection string) string {
	if strings.HasPrefix(collection, "https://") {
		return strings.TrimRight(collection, "/")
	}
	if collection == "informatieobjecten" {
		return strings.TrimRight(c.Config.DossierURL, "/") + "/" + collection
	}
	if collection == "eenheden" {
		return strings.TrimRight(c.Config.VastgoedURL, "/") + "/" + collection
	}
	return strings.TrimRight(c.Config.OnderhoudURL, "/") + "/" + collection
}

func (c *Client) call(ctx context.Context, method, endpoint string, body any, status int) ([]byte, http.Header, error) {
	if !within(endpoint, c.Config.OnderhoudURL) && !within(endpoint, c.Config.DossierURL) && !within(endpoint, c.Config.VastgoedURL) {
		return nil, nil, blocked("VERA-verwijzing ligt buiten de ingestelde domeinen")
	}
	limit := MaxRecordBytes
	if c.Config.MaxRecordSize >= MaxRecordBytes && c.Config.MaxRecordSize <= 128*1048576 {
		limit = c.Config.MaxRecordSize
	}
	var raw []byte
	if body != nil {
		raw, _ = json.Marshal(body)
		if len(raw) > limit {
			return nil, nil, blocked("Bestand of record is te groot voor het VERA-overdrachtsprofiel (8 MiB)")
		}
	}
	for attempt := 0; attempt < 2; attempt++ {
		if c.bearer == "" {
			if e := c.Authenticate(ctx); e != nil {
				return nil, nil, e
			}
		}
		if c.BeforeRequest != nil {
			if e := c.BeforeRequest(); e != nil {
				return nil, nil, e
			}
		}
		req, e := http.NewRequestWithContext(ctx, method, endpoint, bytes.NewReader(raw))
		if e != nil {
			return nil, nil, blocked("Ongeldig VERA-verzoek")
		}
		req.Header.Set("Authorization", "Bearer "+c.bearer)
		req.Header.Set("Accept", "application/json")
		req.Header.Set("X-Stuurgegevens-Referentienummer", c.Reference)
		req.Header.Set("X-Stuurgegevens-Zender-Organisatie", c.Config.Organisation)
		req.Header.Set("X-Stuurgegevens-Zender-Administratie", c.Config.Administration)
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		res, e := c.HTTP.Do(req)
		if e != nil {
			return nil, nil, transportError(e)
		}
		data, readError := io.ReadAll(io.LimitReader(res.Body, int64(limit)+1))
		res.Body.Close()
		if res.StatusCode == 401 && attempt == 0 {
			c.bearer = ""
			continue
		}
		if res.StatusCode != status {
			return nil, nil, responseError(res)
		}
		if readError != nil || len(data) > limit {
			return nil, nil, &Error{Message: "VERA-antwoord onvolledig of te groot; ontvangst moet worden gecontroleerd", Temporary: true}
		}
		if len(data) > 0 {
			contentType, _, _ := mime.ParseMediaType(res.Header.Get("Content-Type"))
			if contentType != "application/json" || !json.Valid(data) {
				return nil, nil, blocked("Het ontvangende systeem gaf geen geldige JSON")
			}
		}
		return data, res.Header, nil
	}
	return nil, nil, blocked("De VERA-koppeling is niet geautoriseerd")
}

func stringValue(row map[string]any, key string) string { s, _ := row[key].(string); return s }
func (c *Client) Read(ctx context.Context, collection, id string) (map[string]any, error) {
	raw, _, e := c.call(ctx, "GET", c.resourceURL(collection)+"/"+url.PathEscape(id), nil, 200)
	if e != nil {
		return nil, e
	}
	var row map[string]any
	if json.Unmarshal(raw, &row) != nil || row == nil || stringValue(row, "id") != id {
		return nil, blocked("VERA gaf een ongeldig of afwijkend ontvangend kenmerk")
	}
	return row, nil
}
func (c *Client) ValidateUnit(ctx context.Context, uri string) error {
	prefix := c.resourceURL("eenheden") + "/"
	if !strings.HasPrefix(uri, prefix) {
		return blocked("De woningkoppeling hoort niet bij het ingestelde Vastgoed-domein")
	}
	u, e := url.Parse(uri)
	if e != nil || u.RawQuery != "" || u.Fragment != "" {
		return blocked("Ongeldige woningkoppeling")
	}
	escaped := strings.TrimPrefix(uri, prefix)
	id, e := url.PathUnescape(escaped)
	if e != nil || id == "" || strings.Contains(id, "/") {
		return blocked("Ongeldige woningidentiteit")
	}
	_, e = c.Read(ctx, "eenheden", id)
	return e
}

func same(value, expected any) bool {
	if a, ok := expected.(map[string]any); ok {
		b, ok := value.(map[string]any)
		if !ok {
			return false
		}
		for key, v := range a {
			if !same(b[key], v) {
				return false
			}
		}
		return true
	}
	if a, ok := expected.([]any); ok {
		b, ok := value.([]any)
		if !ok {
			return false
		}
		for _, v := range a {
			found := false
			for _, w := range b {
				if same(w, v) {
					found = true
					break
				}
			}
			if !found {
				return false
			}
		}
		return true
	}
	return reflect.DeepEqual(value, expected)
}

func (c *Client) Ensure(ctx context.Context, collection string, row map[string]any) (map[string]any, error) {
	q := url.Values{}
	for _, key := range []string{"idExtern", "idOrganisatie", "idAdministratie"} {
		v := stringValue(row, key)
		if v == "" {
			return nil, blocked("De bronidentiteit van een overdrachtsrecord ontbreekt")
		}
		q.Set(key, v)
	}
	raw, headers, e := c.call(ctx, "GET", c.resourceURL(collection)+"?"+q.Encode(), nil, 200)
	if e != nil {
		return nil, e
	}
	var found []map[string]any
	if json.Unmarshal(raw, &found) != nil || len(found) > 1 || headers.Get("X-Parameters-Cursor") != "" {
		return nil, blocked("De bronidentiteit in het ontvangende systeem is niet eenduidig")
	}
	if len(found) == 1 {
		if stringValue(found[0], "id") == "" {
			return nil, blocked("Het ontvangende record mist een id")
		}
		saved, e := c.Read(ctx, collection, stringValue(found[0], "id"))
		if e != nil {
			return nil, e
		}
		for _, key := range []string{"idExtern", "idOrganisatie", "idAdministratie", "omschrijving", "titel", "bestandsnaam", "eenheid", "eenheden"} {
			if v, ok := row[key]; ok && !same(saved[key], v) {
				return nil, blocked("Een bestaande bronidentiteit bevat afwijkende gegevens; controleer de ontvangen overdracht")
			}
		}
		if binary, ok := row["bestand"].(string); ok {
			actual, ok := saved["bestand"].(string)
			if !ok || sha256.Sum256([]byte(binary)) != sha256.Sum256([]byte(actual)) || !same(saved["bestandsgrootte"], row["bestandsgrootte"]) {
				return nil, blocked("Het reeds ontvangen document wijkt af van de vastgelegde bijlage")
			}
		}
		return saved, nil
	}
	raw, headers, e = c.call(ctx, "POST", c.resourceURL(collection), row, 201)
	if e != nil {
		return nil, e
	}
	var saved map[string]any
	if json.Unmarshal(raw, &saved) != nil || stringValue(saved, "id") == "" || headers.Get("Location") != c.resourceURL(collection)+"/"+url.PathEscape(stringValue(saved, "id")) {
		return nil, &Error{Message: "Ontvangstbevestiging mist een geldige id of Location; ontvangst wordt gecontroleerd", Temporary: true}
	}
	for key, values := range q {
		if stringValue(saved, key) != values[0] {
			return nil, blocked("Ontvangstbevestiging bevat een afwijkende bronidentiteit")
		}
	}
	saved, e = c.Read(ctx, collection, stringValue(saved, "id"))
	if e != nil {
		return nil, e
	}
	for key, value := range row {
		if !same(saved[key], value) {
			return nil, blocked("Het ontvangende systeem heeft niet alle gegevens bevestigd")
		}
	}
	return saved, nil
}

func (c *Client) Link(ctx context.Context, collection, id string, fields map[string]any) error {
	saved, e := c.Read(ctx, collection, id)
	if e != nil {
		return e
	}
	for field, value := range fields {
		values, ok := value.([]any)
		if !ok {
			continue
		}
		// Append associations; do not remove work added by another system.
		existing, _ := saved[field].([]any)
		merged := append([]any{}, existing...)
		for _, v := range values {
			present := false
			for _, old := range merged {
				if same(old, v) {
					present = true
					break
				}
			}
			if !present {
				merged = append(merged, v)
			}
		}
		fields[field] = merged
	}
	fields["id"] = id
	if _, _, e = c.call(ctx, "PATCH", c.resourceURL(collection)+"/"+url.PathEscape(id), fields, 200); e != nil {
		return e
	}
	saved, e = c.Read(ctx, collection, id)
	if e != nil {
		return e
	}
	if !same(saved, fields) {
		return blocked("De onderlinge VERA-verwijzingen zijn niet volledig bevestigd")
	}
	return nil
}

func (c *Client) URI(collection, id string) string {
	return c.resourceURL(collection) + "/" + url.PathEscape(id)
}

func (c *Client) Probe(ctx context.Context) error {
	raw, _, e := c.call(ctx, "GET", c.resourceURL("eenheden"), nil, 200)
	if e != nil {
		return e
	}
	var rows []map[string]any
	if json.Unmarshal(raw, &rows) != nil {
		return blocked("VERA gaf geen geldige woningenlijst")
	}
	return nil
}
