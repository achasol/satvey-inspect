// Package receiver implements a test double for the VERA handover API profile.
// Request and response validation uses the complete, pinned upstream contracts;
// the receiver's supported operations and business rules are deliberately explicit.
package receiver

import (
	"context"
	"embed"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/dlclark/regexp2"
	"github.com/getkin/kin-openapi/openapi3"
	"github.com/getkin/kin-openapi/openapi3filter"
	"github.com/getkin/kin-openapi/routers"
	"github.com/getkin/kin-openapi/routers/legacy"
)

//go:embed specs/*.yaml specs/LICENSE specs/provenance.json
var contracts embed.FS

const Version = "4.3.3+261002.6"

type resource struct {
	domain, name, model string
	writable            bool
}

var supported = []resource{
	{"Onderhoud", "defecten", "Defectbericht", true},
	{"Onderhoud", "inspectierapporten", "Inspectierapportbericht", true},
	{"Onderhoud", "onderhoudstaken", "Onderhoudstaakbericht", true},
	{"Onderhoud", "onderhoudsverzoeken", "Onderhoudsverzoekbericht", true},
	{"Onderhoud", "onderhoudsorders", "Onderhoudsorderbericht", false},
	{"Dossier", "informatieobjecten", "Informatieobjectbericht", true},
	{"Vastgoed", "eenheden", "Eenheidbericht", false},
}

func (r resource) path() string { return "/" + strings.ToLower(r.domain) + "/v4/" + r.name }

type contract struct {
	doc    *openapi3.T
	router routers.Router
}

func loadContracts() (map[string]contract, error) {
	out := map[string]contract{}
	for _, domain := range []string{"Onderhoud", "Dossier", "Vastgoed"} {
		raw, err := contracts.ReadFile("specs/" + domain + ".yaml")
		if err != nil {
			return nil, err
		}
		loader := openapi3.NewLoader() // External references/network access remain disabled.
		doc, err := loader.LoadFromData(raw)
		if err != nil {
			return nil, fmt.Errorf("load %s: %w", domain, err)
		}
		if doc.Info.Version != Version {
			return nil, fmt.Errorf("unexpected %s version %s", domain, doc.Info.Version)
		}
		if err = doc.Validate(context.Background(), openapi3.SetRegexCompiler(compilePattern)); err != nil {
			return nil, fmt.Errorf("validate %s: %w", domain, err)
		}
		// Only the deployment URL changes. The embedded upstream schemas, methods,
		// parameters, security requirements and response definitions stay intact.
		doc.Servers = openapi3.Servers{{URL: "/" + strings.ToLower(domain) + "/v4"}}
		router, err := legacy.NewRouter(doc)
		if err != nil {
			return nil, err
		}
		out[domain] = contract{doc: doc, router: router}
	}
	return out, nil
}

var dateTimeSyntax = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt][0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?([Zz]|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$`)

func schemaOptions() []openapi3.SchemaValidationOption {
	return []openapi3.SchemaValidationOption{
		openapi3.SetSchemaRegexCompiler(compilePattern),
		openapi3.EnableFormatValidation(),
		openapi3.DisableSchemaErrorDetails(),
		openapi3.WithStringFormatValidator("uri", openapi3.NewCallbackValidator(func(value string) error {
			u, err := url.Parse(value)
			if err != nil || !u.IsAbs() {
				return fmt.Errorf("expected an absolute URI")
			}
			for _, c := range value {
				if c <= 32 || c > 126 || strings.ContainsRune("<>\"{}|\\^`", c) {
					return fmt.Errorf("URI must use valid URI characters and escaping")
				}
			}
			return nil
		})),
		openapi3.WithStringFormatValidator("byte", openapi3.NewCallbackValidator(func(value string) error {
			if strings.ContainsAny(value, "\r\n") {
				return fmt.Errorf("base64 must not contain line breaks")
			}
			_, err := base64.StdEncoding.Strict().DecodeString(value)
			return err
		})),
		openapi3.WithStringFormatValidator("date", openapi3.NewCallbackValidator(func(value string) error { _, err := time.Parse("2006-01-02", value); return err })),
		openapi3.WithStringFormatValidator("date-time", openapi3.NewCallbackValidator(func(value string) error {
			if !dateTimeSyntax.MatchString(value) {
				return fmt.Errorf("expected RFC3339 date-time")
			}
			value = strings.ToUpper(value)
			// RFC3339 permits leap seconds. Normalize only for calendar validation.
			if len(value) >= 19 && value[17:19] == "60" {
				value = value[:17] + "59" + value[19:]
			}
			_, err := time.Parse(time.RFC3339Nano, value)
			return err
		})),
	}
}

// Upstream uses ECMAScript lookahead (e.g. ISO 8601 durations), which Go's
// RE2 engine cannot express. Preserve those patterns and bound match time.
type patternMatcher struct{ expression *regexp2.Regexp }

func (m patternMatcher) MatchString(value string) bool {
	match, err := m.expression.MatchString(value)
	return err == nil && match
}
func compilePattern(pattern string) (openapi3.RegexMatcher, error) {
	expression, err := regexp2.Compile(pattern, regexp2.ECMAScript)
	if err != nil {
		return nil, err
	}
	expression.MatchTimeout = 50 * time.Millisecond
	return patternMatcher{expression}, nil
}

func validationOptions(auth openapi3filter.AuthenticationFunc) *openapi3filter.Options {
	return &openapi3filter.Options{AuthenticationFunc: auth, IncludeResponseStatus: true,
		RejectWhenRequestBodyNotSpecified: true, SkipSettingDefaults: true, RegexCompiler: compilePattern, SchemaValidationOptions: schemaOptions()}
}

type reply struct {
	status int
	header http.Header
	body   []byte
}

func jsonReply(status int, value any) reply {
	data, _ := json.Marshal(value)
	return reply{status: status, header: http.Header{"Content-Type": []string{"application/json"}}, body: data}
}

func errorReply(input *openapi3filter.RequestValidationInput, status int, code, message string) reply {
	// Several upstream error statuses (notably 401/404) declare no body.
	// Follow that contract instead of inventing a Satvey-shaped error envelope.
	if input != nil {
		response := input.Route.Operation.Responses.Status(status)
		if response == nil {
			response = input.Route.Operation.Responses.Default()
		}
		if response != nil && len(response.Value.Content) == 0 {
			return reply{status: status, header: http.Header{}}
		}
	}
	return jsonReply(status, map[string]string{"code": code, "omschrijving": message})
}

func validateReply(ctx context.Context, input *openapi3filter.RequestValidationInput, out reply) error {
	check := (&openapi3filter.ResponseValidationInput{RequestValidationInput: input, Status: out.status, Header: out.header, Options: validationOptions(nil)}).SetBodyBytes(out.body)
	return openapi3filter.ValidateResponse(ctx, check)
}

func (r *Receiver) write(w http.ResponseWriter, input *openapi3filter.RequestValidationInput, out reply) {
	if input != nil {
		if err := validateReply(input.Request.Context(), input, out); err != nil {
			out = errorReply(input, 500, "RECEIVER_CONTRACT_ERROR", "Receiver response did not match the pinned VERA contract")
		}
	}
	for k, values := range out.header {
		for _, v := range values {
			w.Header().Add(k, v)
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(out.status)
	if len(out.body) > 0 {
		_, _ = w.Write(out.body)
	}
}
