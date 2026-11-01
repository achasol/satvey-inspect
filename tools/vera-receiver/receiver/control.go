package receiver

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
)

type Fault struct {
	Method string `json:"method"`
	Path   string `json:"path"`
	Mode   string `json:"mode"`
	Status int    `json:"status"`
	Count  int    `json:"count"`
}

var seedID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

func (r *Receiver) takeFault(method, path string) *Fault {
	for i := range r.faults {
		f := &r.faults[i]
		if f.Count > 0 && f.Method == method && f.Path == path {
			f.Count--
			copy := *f
			return &copy
		}
	}
	return nil
}

func (r *Receiver) control(w http.ResponseWriter, req *http.Request) {
	if subtle.ConstantTimeCompare([]byte(req.Header.Get("X-Test-Control-Key")), []byte(r.cfg.ControlKey)) != 1 {
		w.WriteHeader(401)
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	fail := func(message string) { r.write(w, nil, jsonReply(400, map[string]string{"error": message})) }
	switch {
	case req.URL.Path == "/_test/state" && req.Method == "GET":
		counts := map[string]int{}
		records := map[string][]map[string]any{}
		for path, rows := range r.rows {
			counts[path] = len(rows)
			records[path] = []map[string]any{}
			for _, row := range rows {
				item := clone(row)
				if encoded, ok := item["bestand"].(string); ok {
					data, _ := base64.StdEncoding.DecodeString(encoded)
					sum := sha256.Sum256(data)
					delete(item, "bestand")
					item["_testFile"] = map[string]any{"bytes": len(data), "sha256": hex.EncodeToString(sum[:])}
				}
				records[path] = append(records[path], item)
			}
		}
		r.write(w, nil, jsonReply(200, map[string]any{"counts": counts, "records": records, "receipts": r.writes, "faults": r.faults, "storedBytes": r.bytes}))
		return
	case req.URL.Path == "/_test/state" && req.Method == "DELETE":
		for path := range r.rows {
			r.rows[path] = map[string]map[string]any{}
			r.revisions[path]++
		}
		r.bytes = 0
		r.faults = nil
		r.writes = nil
		// IDs are never reused after reset, so old references cannot silently match.
		w.WriteHeader(204)
		return
	case req.URL.Path == "/_test/seed" && req.Method == "POST":
		var seed struct {
			Resource string         `json:"resource"`
			Record   map[string]any `json:"record"`
		}
		if !decodeControl(w, req, &seed) {
			return
		}
		var res *resource
		for i := range supported {
			if supported[i].path() == seed.Resource && !supported[i].writable {
				res = &supported[i]
				break
			}
		}
		if res == nil || seed.Record == nil {
			fail("Seed only /vastgoed/v4/eenheden or /onderhoud/v4/onderhoudsorders")
			return
		}
		id := textField(seed.Record, "id")
		if !seedID.MatchString(id) {
			fail("Supply a simple receiver id")
			return
		}
		if _, exists := r.rows[res.path()][id]; exists {
			fail("Seed id already exists")
			return
		}
		// Read-only fixtures must satisfy the same upstream message schema.
		if err := r.contracts[res.domain].doc.Components.Schemas[res.model].Value.VisitJSON(seed.Record, schemaOptions()...); err != nil {
			fail("Seed does not match the pinned VERA schema")
			return
		}
		raw := mustJSON(seed.Record)
		if len(r.rows[res.path()]) >= 1000 || r.bytes+len(raw) > 32<<20 {
			fail("Test storage capacity reached")
			return
		}
		r.rows[res.path()][id] = clone(seed.Record)
		r.bytes += len(raw)
		r.revisions[res.path()]++
		out := jsonReply(201, seed.Record)
		out.header.Set("Location", r.cfg.BaseURL+res.path()+"/"+id)
		r.write(w, nil, out)
		return
	case req.URL.Path == "/_test/faults" && req.Method == "POST":
		var fault Fault
		if !decodeControl(w, req, &fault) {
			return
		}
		if fault.Mode != "before" && fault.Mode != "after_commit" && fault.Mode != "disconnect_after_commit" {
			fail("Unknown fault mode")
			return
		}
		if fault.Status == 0 {
			fault.Status = 503
		}
		if fault.Count < 1 || fault.Count > 20 || (fault.Status != 429 && fault.Status != 503 && fault.Status != 504) {
			fail("Use count 1..20 and status 429, 503 or 504")
			return
		}
		if fault.Method != "POST" && fault.Method != "PATCH" && fault.Method != "PUT" {
			fail("Faults apply to writes only")
			return
		}
		valid := false
		for _, res := range supported {
			if res.writable && (fault.Path == res.path() || strings.HasPrefix(fault.Path, res.path()+"/")) {
				valid = true
			}
		}
		if !valid {
			fail("Fault path is outside the supported writable resources")
			return
		}
		active := []Fault{}
		for _, f := range r.faults {
			if f.Count > 0 {
				active = append(active, f)
			}
		}
		if len(active) >= 32 {
			fail("Too many fault rules")
			return
		}
		r.faults = append(active, fault)
		r.write(w, nil, jsonReply(201, fault))
		return
	}
	w.WriteHeader(404)
}

func decodeControl(w http.ResponseWriter, req *http.Request, value any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, req.Body, maxBody))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		http.Error(w, fmt.Sprint("Invalid test control request"), 400)
		return false
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		http.Error(w, "Supply one test control object", 400)
		return false
	}
	return true
}
