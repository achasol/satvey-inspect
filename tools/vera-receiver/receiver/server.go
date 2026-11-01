package receiver

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/getkin/kin-openapi/openapi3filter"
)

const maxBody = 8 << 20

type Config struct {
	BaseURL, ClientID, ClientSecret, ControlKey, APIKey string
	Now                                                 func() time.Time
}

type Receiver struct {
	cfg       Config
	contracts map[string]contract
	mu        sync.Mutex
	tokens    map[string]token
	rows      map[string]map[string]map[string]any
	revisions map[string]int
	faults    []Fault
	writes    []Receipt
	nextID    uint64
	bytes     int
	scopes    map[string]bool
}

type token struct {
	expires time.Time
	scopes  map[string]bool
}

func New(cfg Config) (*Receiver, error) {
	u, err := url.Parse(cfg.BaseURL)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return nil, fmt.Errorf("BaseURL must be an HTTPS origin")
	}
	if cfg.ClientID == "" || len(cfg.ClientSecret) < 12 || len(cfg.ControlKey) < 12 {
		return nil, fmt.Errorf("configure test client ID and client/control secrets of at least 12 characters")
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	cfg.BaseURL = strings.TrimRight(cfg.BaseURL, "/")
	docs, err := loadContracts()
	if err != nil {
		return nil, err
	}
	r := &Receiver{cfg: cfg, contracts: docs, tokens: map[string]token{}, rows: map[string]map[string]map[string]any{}, revisions: map[string]int{}, scopes: map[string]bool{}}
	for _, c := range docs {
		for scope := range c.doc.Components.SecuritySchemes["OAuth2"].Value.Flows.ClientCredentials.Scopes {
			r.scopes[scope] = true
		}
	}
	for _, res := range supported {
		r.rows[res.path()] = map[string]map[string]any{}
	}
	return r, nil
}

func (r *Receiver) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	switch {
	case req.URL.Path == "/healthz" && req.Method == "GET":
		resources := []string{}
		for _, res := range supported {
			resources = append(resources, res.path())
		}
		r.write(w, nil, jsonReply(200, map[string]any{"status": "ok", "contractVersion": Version, "profile": "satvey-handover-test", "resources": resources}))
		return
	case req.URL.Path == "/oauth/token":
		r.issueToken(w, req)
		return
	case strings.HasPrefix(req.URL.Path, "/_test/"):
		r.control(w, req)
		return
	case strings.HasPrefix(req.URL.Path, "/openapi/"):
		r.openapi(w, req)
		return
	}
	var c contract
	for domain, doc := range r.contracts {
		if strings.HasPrefix(req.URL.Path, "/"+strings.ToLower(domain)+"/v4/") {
			c = doc
			break
		}
	}
	if c.router == nil {
		r.write(w, nil, jsonReply(404, map[string]string{"code": "NOT_FOUND", "omschrijving": "Unsupported receiver route"}))
		return
	}
	route, params, err := c.router.FindRoute(req)
	if err != nil {
		r.write(w, nil, jsonReply(404, map[string]string{"code": "NOT_FOUND", "omschrijving": "Unsupported VERA operation"}))
		return
	}
	authStatus := 0
	input := &openapi3filter.RequestValidationInput{Request: req, Route: route, PathParams: params}
	input.Options = validationOptions(func(_ context.Context, a *openapi3filter.AuthenticationInput) error {
		status := r.authorize(a)
		authStatus = status
		if status != 0 {
			return errors.New("test credentials or scopes are insufficient")
		}
		return nil
	})
	raw, err := io.ReadAll(http.MaxBytesReader(w, req.Body, maxBody))
	if err != nil {
		r.write(w, input, errorReply(input, 413, "TOO_LARGE", "Request exceeds the receiver's 8 MiB test limit"))
		return
	}
	req.Body = io.NopCloser(bytes.NewReader(raw))
	if err = openapi3filter.ValidateRequest(req.Context(), input); err != nil {
		status := 400
		code := "VERA_VALIDATION"
		message := "Request does not match the pinned VERA contract"
		if authStatus != 0 {
			status = authStatus
			code = "AUTHORIZATION"
			message = "Test credentials or requested scopes are insufficient"
			w.Header().Set("WWW-Authenticate", `Bearer realm="vera-test"`)
		}
		r.write(w, input, errorReply(input, status, code, message))
		return
	}
	if route.Path == "/ping" {
		r.write(w, input, reply{status: 200, header: http.Header{}})
		return
	}
	var res *resource
	for i := range supported {
		s := &supported[i]
		if strings.HasPrefix(req.URL.Path, s.path()) && (route.Path == "/"+s.name || route.Path == "/"+s.name+"/{id}") {
			res = s
			break
		}
	}
	if res == nil || (!res.writable && req.Method != "GET") {
		r.write(w, input, errorReply(input, 405, "UNSUPPORTED_OPERATION", "This operation is outside the receiver's documented test profile"))
		return
	}
	var body map[string]any
	if req.Method != "GET" {
		if err = json.Unmarshal(raw, &body); err != nil || body == nil {
			r.write(w, input, errorReply(input, 400, "JSON_OBJECT_REQUIRED", "Supply one JSON object"))
			return
		}
	}
	r.mu.Lock()
	fault := r.takeFault(req.Method, req.URL.Path)
	if fault != nil && fault.Mode == "before" {
		r.mu.Unlock()
		r.write(w, input, errorReply(input, fault.Status, "TEST_FAULT", "Configured failure before processing"))
		return
	}
	out := r.process(input, *res, body)
	r.mu.Unlock()
	if fault != nil && out.status >= 200 && out.status < 300 && fault.Mode == "after_commit" {
		out = errorReply(input, fault.Status, "TEST_FAULT_AFTER_COMMIT", "Record accepted before the configured acknowledgement failure")
	}
	if fault != nil && out.status >= 200 && out.status < 300 && fault.Mode == "disconnect_after_commit" {
		// net/http closes HTTP/1 connections and resets HTTP/2 streams for this
		// sentinel, preserving the accepted row without writing a response.
		panic(http.ErrAbortHandler)
	}
	r.write(w, input, out)
}

func (r *Receiver) authorize(a *openapi3filter.AuthenticationInput) int {
	if a.SecuritySchemeName == "ApiKeyAuth" {
		if r.cfg.APIKey != "" && subtle.ConstantTimeCompare([]byte(a.RequestValidationInput.Request.Header.Get("X-API-KEY")), []byte(r.cfg.APIKey)) == 1 {
			return 0
		}
		return 401
	}
	header := a.RequestValidationInput.Request.Header.Get("Authorization")
	if !strings.HasPrefix(header, "Bearer ") {
		return 401
	}
	r.mu.Lock()
	t, ok := r.tokens[strings.TrimPrefix(header, "Bearer ")]
	r.mu.Unlock()
	if !ok || !r.cfg.Now().Before(t.expires) {
		return 401
	}
	// Scope lists are interpreted literally as AND, as required by OpenAPI.
	// All.ReadWrite grants expand to the explicit domain/resource scopes.
	for _, scope := range a.Scopes {
		if !t.scopes[scope] {
			return 403
		}
	}
	return 0
}

func (r *Receiver) issueToken(w http.ResponseWriter, req *http.Request) {
	if req.Method != "POST" {
		w.WriteHeader(405)
		return
	}
	req.Body = http.MaxBytesReader(w, req.Body, 16<<10)
	if err := req.ParseForm(); err != nil {
		r.write(w, nil, jsonReply(400, map[string]string{"error": "invalid_request"}))
		return
	}
	client, secret, ok := req.BasicAuth()
	if !ok {
		client = req.PostForm.Get("client_id")
		secret = req.PostForm.Get("client_secret")
	}
	if subtle.ConstantTimeCompare([]byte(client), []byte(r.cfg.ClientID)) != 1 || subtle.ConstantTimeCompare([]byte(secret), []byte(r.cfg.ClientSecret)) != 1 {
		w.Header().Set("WWW-Authenticate", `Basic realm="vera-test"`)
		r.write(w, nil, jsonReply(401, map[string]string{"error": "invalid_client"}))
		return
	}
	if req.PostForm.Get("grant_type") != "client_credentials" {
		r.write(w, nil, jsonReply(400, map[string]string{"error": "unsupported_grant_type"}))
		return
	}
	granted := map[string]bool{}
	requested := strings.Fields(req.PostForm.Get("scope"))
	if len(requested) == 0 {
		for s := range r.scopes {
			requested = append(requested, s)
		}
	}
	for _, s := range requested {
		if !r.scopes[s] {
			r.write(w, nil, jsonReply(400, map[string]string{"error": "invalid_scope"}))
			return
		}
		granted[s] = true
	}
	for scope := range granted {
		if strings.HasSuffix(scope, ".All.ReadWrite") {
			domain := strings.Split(scope, ".")[0]
			for s := range r.scopes {
				if strings.HasPrefix(s, domain+".") {
					granted[s] = true
				}
			}
		}
	}
	data := make([]byte, 32)
	if _, err := rand.Read(data); err != nil {
		w.WriteHeader(500)
		return
	}
	value := hex.EncodeToString(data)
	r.mu.Lock()
	for k, t := range r.tokens {
		if !r.cfg.Now().Before(t.expires) {
			delete(r.tokens, k)
		}
	}
	if len(r.tokens) >= 128 {
		r.mu.Unlock()
		r.write(w, nil, jsonReply(429, map[string]string{"error": "temporarily_unavailable"}))
		return
	}
	r.tokens[value] = token{expires: r.cfg.Now().Add(time.Hour), scopes: granted}
	r.mu.Unlock()
	scopes := []string{}
	for s := range granted {
		scopes = append(scopes, s)
	}
	sort.Strings(scopes)
	w.Header().Set("Pragma", "no-cache")
	r.write(w, nil, jsonReply(200, map[string]any{"access_token": value, "token_type": "Bearer", "expires_in": 3600, "scope": strings.Join(scopes, " ")}))
}

func (r *Receiver) openapi(w http.ResponseWriter, req *http.Request) {
	if req.Method != "GET" {
		w.WriteHeader(405)
		return
	}
	name := strings.TrimSuffix(strings.TrimPrefix(req.URL.Path, "/openapi/"), ".json")
	for domain, c := range r.contracts {
		if strings.EqualFold(name, domain) {
			// Discovery documents expose exactly the supported profile. Original
			// upstream contracts and hashes remain available in the repository.
			copy := *c.doc
			copy.Paths = openapi3.NewPaths()
			for _, s := range supported {
				if s.domain != domain {
					continue
				}
				for _, path := range []string{"/" + s.name, "/" + s.name + "/{id}"} {
					item := *c.doc.Paths.Value(path)
					if !s.writable {
						item.Post = nil
						item.Put = nil
						item.Patch = nil
					}
					copy.Paths.Set(path, &item)
				}
			}
			copy.Paths.Set("/ping", c.doc.Paths.Value("/ping"))
			raw, err := json.Marshal(&copy)
			if err != nil {
				w.WriteHeader(500)
				return
			}
			r.write(w, nil, reply{status: 200, header: http.Header{"Content-Type": []string{"application/json"}}, body: raw})
			return
		}
	}
	w.WriteHeader(404)
}
