package receiver

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"reflect"
	"sort"
	"strconv"
	"strings"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/getkin/kin-openapi/openapi3filter"
)

// Receipt records acceptance, even when the test deliberately loses the reply.
type Receipt struct {
	Method     string `json:"method"`
	Path       string `json:"path"`
	ID         string `json:"id"`
	Reference  string `json:"reference,omitempty"`
	AcceptedAt string `json:"acceptedAt"`
}

func clone(record map[string]any) map[string]any {
	raw, _ := json.Marshal(record)
	var result map[string]any
	_ = json.Unmarshal(raw, &result)
	return result
}

func textField(record map[string]any, key string) string {
	value, _ := record[key].(string)
	return value
}

func sourceKey(record map[string]any) string {
	if textField(record, "idExtern") == "" || textField(record, "idOrganisatie") == "" || textField(record, "idAdministratie") == "" {
		return ""
	}
	raw, _ := json.Marshal([]string{textField(record, "idOrganisatie"), textField(record, "idAdministratie"), textField(record, "idExtern")})
	return string(raw)
}

func (r *Receiver) resolve(path string, key map[string]any) (string, bool) {
	id := textField(key, "id")
	if id != "" {
		row, ok := r.rows[path][id]
		if !ok {
			return "", false
		}
		for _, field := range []string{"idExtern", "idOrganisatie", "idAdministratie"} {
			if value, exists := key[field]; exists && !reflect.DeepEqual(value, row[field]) {
				return "", false
			}
		}
		return id, true
	}
	source := sourceKey(key)
	if source == "" {
		return "", false
	}
	for id, row := range r.rows[path] {
		if sourceKey(row) == source {
			return id, true
		}
	}
	return "", false
}

func (r *Receiver) process(input *openapi3filter.RequestValidationInput, res resource, body map[string]any) reply {
	req := input.Request
	fail := func(status int, code, message string) reply { return errorReply(input, status, code, message) }
	path := res.path()
	id := input.PathParams["id"]
	if req.Method == "GET" {
		if id != "" {
			row, ok := r.rows[path][id]
			if !ok {
				return fail(404, "NOT_FOUND", "Record does not exist")
			}
			return jsonReply(200, row)
		}
		return r.list(input, res)
	}
	candidate := clone(body)
	creating := req.Method == "POST"
	if creating {
		if textField(body, "id") != "" {
			return fail(422, "RECEIVER_OWNS_ID", "Omit id when creating; the receiver assigns its own key")
		}
		r.nextID++
		id = fmt.Sprintf("vr-%08d", r.nextID)
	} else {
		if id != "" {
			if bodyID := textField(body, "id"); bodyID != "" && bodyID != id {
				return fail(409, "KEY_MISMATCH", "Path and body identifiers disagree")
			}
			key := clone(body)
			key["id"] = id
			if _, ok := r.resolve(path, key); !ok {
				return fail(404, "NOT_FOUND", "Record or source namespace does not match")
			}
		} else {
			var ok bool
			id, ok = r.resolve(path, body)
			if !ok {
				return fail(404, "NOT_FOUND", "Supply an existing receiver id or complete source key")
			}
		}
		old := r.rows[path][id]
		if req.Method == "PATCH" {
			candidate = clone(old)
			for k, v := range body {
				candidate[k] = v
			}
		}
		// Source identity is immutable in this test profile, including full replacement.
		for _, field := range []string{"idExtern", "idOrganisatie", "idAdministratie"} {
			if value, exists := body[field]; exists && !reflect.DeepEqual(value, old[field]) {
				return fail(409, "KEY_MISMATCH", "Source identity cannot be changed")
			}
			if value, exists := old[field]; exists {
				candidate[field] = value
			}
		}
	}
	candidate["id"] = id
	if sourceKey(candidate) == "" {
		return fail(422, "SOURCE_KEY_REQUIRED", "The handover profile requires idExtern, idOrganisatie and idAdministratie")
	}
	for existing, row := range r.rows[path] {
		if existing != id && sourceKey(row) == sourceKey(candidate) {
			return fail(409, "DUPLICATE_SOURCE_KEY", "This source identity already exists; look it up before retrying")
		}
	}
	if err := r.validateRecord(res, candidate); err != nil {
		return fail(422, "PROFILE_VALIDATION", err.Error())
	}
	raw, _ := json.Marshal(candidate)
	previous, _ := json.Marshal(r.rows[path][id])
	previousSize := 0
	if r.rows[path][id] != nil {
		previousSize = len(previous)
	}
	if (creating && len(r.rows[path]) >= 1000) || r.bytes-previousSize+len(raw) > 32<<20 {
		return fail(507, "TEST_CAPACITY", "Receiver test storage capacity reached; reset it")
	}
	result := reply{status: 200, header: http.Header{}}
	if creating {
		result = jsonReply(201, candidate)
		result.header.Set("Location", r.cfg.BaseURL+path+"/"+url.PathEscape(id))
	}
	// Never commit a row if our successful acknowledgement would violate VERA.
	if err := validateReply(req.Context(), input, result); err != nil {
		return fail(500, "RECEIVER_CONTRACT_ERROR", "Acceptance response failed contract validation")
	}
	r.rows[path][id] = candidate
	r.bytes = r.bytes - previousSize + len(raw)
	r.revisions[path]++
	r.writes = append(r.writes, Receipt{Method: req.Method, Path: path, ID: id, Reference: req.Header.Get("X-Stuurgegevens-Referentienummer"), AcceptedAt: r.cfg.Now().UTC().Format("2006-01-02T15:04:05.999999999Z07:00")})
	if len(r.writes) > 1000 {
		r.writes = r.writes[len(r.writes)-1000:]
	}
	return result
}

func (r *Receiver) validateRecord(res resource, record map[string]any) error {
	schema := r.contracts[res.domain].doc.Components.Schemas[res.model]
	options := append(schemaOptions(), openapi3.VisitAsRequest())
	if err := schema.Value.VisitJSON(record, options...); err != nil {
		return fmt.Errorf("Record does not match the pinned VERA schema")
	}
	if strings.Contains(string(mustJSON(record)), "urn:satvey:handover:") {
		return fmt.Errorf("Resolve package-local handover URNs before sending")
	}
	// These relationship checks are receiver profile rules, not additional VERA
	// schema requirements. References outside this profile are not dereferenced.
	links := map[string]string{"eenheid": "/vastgoed/v4/eenheden", "eenheden": "/vastgoed/v4/eenheden", "informatieobjecten": "/dossier/v4/informatieobjecten"}
	for field, target := range links {
		value, exists := record[field]
		if !exists {
			continue
		}
		values := []any{value}
		if array, ok := value.([]any); ok {
			values = array
		}
		for _, item := range values {
			uri, ok := item.(string)
			if !ok {
				return fmt.Errorf("%s must contain URI references", field)
			}
			prefix := r.cfg.BaseURL + target + "/"
			if !strings.HasPrefix(uri, prefix) {
				return fmt.Errorf("%s must resolve to a seeded or accepted receiver resource", field)
			}
			id := strings.TrimPrefix(uri, prefix)
			if _, ok := r.rows[target][id]; !ok {
				return fmt.Errorf("%s refers to an unknown resource", field)
			}
		}
	}
	keys := map[string]string{"inspectierapport": "inspectierapporten", "inspectieOrder": "onderhoudsorders", "geconstateerdeDefecten": "defecten", "voorgesteldeOnderhoudstaken": "onderhoudstaken", "defecten": "defecten", "onderhoudstaken": "onderhoudstaken", "onderhoudsverzoek": "onderhoudsverzoeken", "onderhoudsverzoeken": "onderhoudsverzoeken"}
	for field, target := range keys {
		value, exists := record[field]
		if !exists {
			continue
		}
		values := []any{value}
		if array, ok := value.([]any); ok {
			values = array
		}
		for _, item := range values {
			key, ok := item.(map[string]any)
			if !ok {
				return fmt.Errorf("%s must contain key objects", field)
			}
			if _, ok = r.resolve("/onderhoud/v4/"+target, key); !ok {
				return fmt.Errorf("%s refers to an unknown or mismatched receiver key", field)
			}
		}
	}
	if res.name == "informatieobjecten" {
		encoded, ok := record["bestand"].(string)
		if !ok || encoded == "" {
			return fmt.Errorf("The handover profile requires inline base64 bestand content")
		}
		data, err := base64.StdEncoding.Strict().DecodeString(encoded)
		if err != nil {
			return fmt.Errorf("Invalid base64 bestand")
		}
		size, ok := record["bestandsgrootte"].(float64)
		if !ok || size != float64(len(data)) {
			return fmt.Errorf("bestandsgrootte must equal the decoded byte count")
		}
		if textField(record, "bestandsnaam") == "" {
			return fmt.Errorf("The handover profile requires bestandsnaam")
		}
	}
	return nil
}

func mustJSON(value any) []byte { raw, _ := json.Marshal(value); return raw }

func (r *Receiver) list(input *openapi3filter.RequestValidationInput, res resource) reply {
	req := input.Request
	query := req.URL.Query()
	bad := func(message string) reply { return errorReply(input, 400, "UNSUPPORTED_QUERY", message) }
	if req.Header.Get("X-Parameters-PeiltijdstipMaterieel") != "" {
		return bad("Historical queries are outside this test profile")
	}
	filters := url.Values{}
	for key, values := range query {
		if len(values) != 1 {
			return bad("Supply each query parameter once")
		}
		switch key {
		case "cursor", "pagina":
			continue
		case "id", "idExtern", "idOrganisatie", "idAdministratie", "code":
		default:
			return bad("Only id, idExtern, idOrganisatie, idAdministratie and code filters are supported")
		}
		filters[key] = values
	}
	page := 1
	if value := query.Get("pagina"); value != "" {
		var err error
		page, err = strconv.Atoi(value)
		if err != nil || page < 1 || page > 1000000 {
			return bad("pagina must be between 1 and 1000000")
		}
	}
	size := 100
	if value := req.Header.Get("X-Parameters-AantalPerPagina"); value != "" {
		var err error
		size, err = strconv.Atoi(value)
		if err != nil || size < 1 || size > 100 {
			return bad("Page size must be between 1 and 100")
		}
	}
	fingerprint := sha256.Sum256([]byte(res.path() + "?" + filters.Encode() + "#" + strconv.Itoa(size)))
	if cursor := query.Get("cursor"); cursor != "" {
		if query.Has("pagina") {
			return bad("Choose cursor or pagina")
		}
		raw, err := base64.RawURLEncoding.DecodeString(cursor)
		var saved struct {
			Page, Revision int
			Filter         string
		}
		if err != nil || json.Unmarshal(raw, &saved) != nil || saved.Page < 1 || saved.Page > 1000000 || saved.Revision != r.revisions[res.path()] || saved.Filter != hex.EncodeToString(fingerprint[:]) {
			return bad("Invalid, stale or mismatched cursor; restart the query")
		}
		page = saved.Page
	}
	ids := []string{}
	for id, row := range r.rows[res.path()] {
		match := true
		for key, values := range filters {
			if textField(row, key) != values[0] {
				match = false
				break
			}
		}
		if match {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	rows := []map[string]any{}
	start := (page - 1) * size
	for i := start; i < len(ids) && i < start+size; i++ {
		rows = append(rows, r.rows[res.path()][ids[i]])
	}
	out := jsonReply(200, rows)
	out.header.Set("X-Parameters-Aantal", strconv.Itoa(len(ids)))
	out.header.Set("X-Parameters-AantalPerPagina", strconv.Itoa(size))
	out.header.Set("X-Parameters-Pagina", strconv.Itoa(page))
	if start+size < len(ids) {
		raw := mustJSON(struct {
			Page, Revision int
			Filter         string
		}{page + 1, r.revisions[res.path()], hex.EncodeToString(fingerprint[:])})
		out.header.Set("X-Parameters-Cursor", base64.RawURLEncoding.EncodeToString(raw))
	}
	return out
}
