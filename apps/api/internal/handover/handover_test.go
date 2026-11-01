package handover

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

const snapshotFixture = `{
 "id":"report-1","createdAt":"2026-10-31T10:00:00Z",
 "inspection":{"id":"inspection-1","status":"final","kind":"pre","propertySnapshot":{"id":"property-1","linkState":"linked","sourceObjectId":"source-42","administration":"ADM","address":"Teststraat 24"}},
 "organisation":{"name":"Corporatie"},"createdBy":{"name":"Maker"},"finalisedBy":{"name":"Inspecteur"},
 "rooms":[{"id":"room","name":"Badkamer","generation":3,"approvedGeneration":3},{"id":"stale-room","name":"Zolder","generation":2,"approvedGeneration":1}],
 "batches":[{"id":"batch","roomId":"room","status":"reviewed"},{"id":"pending","roomId":"room","status":"pending"}],
 "media":[{"id":"photo","kind":"photo","batchId":"batch","name":"foto.jpg"},{"id":"audio","kind":"audio","batchId":"batch","transcript":"NEVER_EXPORT"},{"id":"pending-photo","kind":"photo","batchId":"pending"}],
 "observations":[{"id":"finding","batchId":"batch","title":"Lekkage","description":"Kraan lekt","photoIds":["photo"]},{"id":"unreviewed","batchId":"pending","title":"NEVER_EXPORT"}],
 "format":{"scopes":[{"questions":[{"id":"q","title":"Is ventilatie in orde?"}]}]},
 "answers":[{"id":"answer","roomId":"room","questionId":"q","status":"confirmed","value":false,"outcome":"unacceptable","reason":"Werkt niet","photoIds":["photo"],"audioIds":["NEVER_EXPORT"],"transcriptVersions":{"NEVER_EXPORT":3}},
 {"id":"suggested","roomId":"room","status":"suggested","reason":"NEVER_EXPORT"},{"id":"stale","roomId":"stale-room","status":"confirmed","reason":"NEVER_EXPORT"}],
 "norms":{"rules":[{"id":"rule","title":"Lekkage beoordelen"}]},
 "assessments":[{"ruleId":"rule","batchId":"batch","outcome":"unacceptable","reason":"Herstel nodig","photoIds":["photo"]}],
 "jobs":[{"error":"NEVER_EXPORT"}],"rawTranscript":"NEVER_EXPORT"
}`

func exampleBundle(t *testing.T) Bundle {
	t.Helper()
	report, err := ReadReport([]byte(snapshotFixture))
	if err != nil {
		t.Fatal(err)
	}
	return Bundle{SchemaVersion: SchemaVersion, ID: "11111111-1111-4111-8111-111111111111", CreatedAt: time.Date(2026, 10, 31, 10, 0, 0, 0, time.UTC), DraftVersion: 1, Destination: "ERP", Report: report,
		Proposals:   []Proposal{{ID: "22222222-2222-4222-8222-222222222222", SourceKeys: []string{"answer:answer"}, Description: "Herstel ventilatie", Location: "Badkamer", Urgency: "soon"}},
		Attachments: []Attachment{{Path: "report.pdf", MIME: "application/pdf"}, {Path: "photos/photo.jpg", MIME: "image/jpeg", MediaID: "photo"}},
		VERA:        &VERAContext{UnitURI: "https://vastgoed.example/v4/eenheden/receiver-42", Organisation: "SATVEY-PILOT", Administration: "INSPECT", InspectionOrderID: "receiver-inspection-7", ReportTypeCode: "PRE", ReportStatusCode: "FINAL", TaskStatusCode: "PROPOSED", RequestStatusCode: "REGISTERED", MaintenanceTypeCode: "MUT"}}
}

func TestReportProjectionIncludesConfirmedAnswersAndExcludesPrivateEvidence(t *testing.T) {
	b := exampleBundle(t)
	if len(b.Report.Sources) != 3 || len(b.Report.Photos) != 1 || b.Report.Author != "Inspecteur" {
		t.Fatalf("unexpected report: %+v", b.Report)
	}
	raw, _ := json.Marshal(b)
	for _, word := range []string{"NEVER_EXPORT", "audioIds", "transcriptVersions", "jobs", "rawTranscript"} {
		if bytes.Contains(raw, []byte(word)) {
			t.Fatalf("private or unreviewed evidence leaked: %s", word)
		}
	}
	var answer Source
	for _, s := range b.Report.Sources {
		if s.Key == "answer:answer" {
			answer = s
		}
	}
	if answer.Title != "Is ventilatie in orde?" || string(answer.Value) != "false" || answer.Location != "Badkamer" || len(answer.PhotoIDs) != 1 {
		t.Fatalf("lost confirmed answer: %+v", answer)
	}
	for _, replacement := range []string{strings.Replace(snapshotFixture, `"status":"final"`, `"status":"draft"`, 1), strings.Replace(snapshotFixture, `"linkState":"linked"`, `"linkState":"provisional"`, 1)} {
		if _, err := ReadReport([]byte(replacement)); err == nil {
			t.Fatal("accepted unfinished or unidentified report")
		}
	}
}

func TestDraftRequiresApprovedSourceAndValidWork(t *testing.T) {
	b := exampleBundle(t)
	d := Draft{Destination: " ERP ", Proposals: b.Proposals}
	if err := ValidateDraft(&d, b.Report); err != nil {
		t.Fatal(err)
	}
	if d.Destination != "ERP" {
		t.Fatal("destination not normalized")
	}
	for _, change := range []func(*Draft){
		func(d *Draft) { d.Proposals[0].SourceKeys = []string{"answer:suggested"} },
		func(d *Draft) { d.Proposals[0].Description = " " },
		func(d *Draft) { d.Proposals[0].Urgency = "made-up" },
		func(d *Draft) { n := 0.0; d.Proposals[0].Quantity = &n; d.Proposals[0].Unit = "m2" },
		func(d *Draft) { d.Proposals[0].Unit = "m2" },
		func(d *Draft) { d.Proposals = append(d.Proposals, d.Proposals[0]) },
	} {
		var candidate Draft
		raw, _ := json.Marshal(d)
		_ = json.Unmarshal(raw, &candidate)
		change(&candidate)
		if err := ValidateDraft(&candidate, b.Report); err == nil {
			t.Fatalf("accepted invalid draft: %+v", candidate)
		}
	}
}

func TestCSVDoesNotExecuteSpreadsheetFormulas(t *testing.T) {
	b := exampleBundle(t)
	b.Destination = " =HYPERLINK(\"https://bad.invalid\")"
	b.Proposals[0].Description = "@SUM(1+1)\nHerstel, kraan"
	b.Proposals[0].Location = "\t=1+1"
	var out bytes.Buffer
	if err := WriteCSV(&out, b); err != nil {
		t.Fatal(err)
	}
	rows, err := csv.NewReader(&out).ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	for _, index := range []int{4, 6, 7} {
		if !strings.HasPrefix(rows[1][index], "'") {
			t.Fatalf("unsafe spreadsheet cell: %q", rows[1][index])
		}
	}
	if !strings.Contains(rows[1][7], "\nHerstel, kraan") {
		t.Fatal("lost multiline work description")
	}
}

func TestVERARecordsFollowPublishedSchemasAndKeepReceiverIdentitySeparate(t *testing.T) {
	b := exampleBundle(t)
	files, err := VERAFiles(b)
	if err != nil {
		t.Fatal(err)
	}
	var contract map[string]struct {
		Schemas map[string]any `json:"schemas"`
	}
	raw, err := os.ReadFile("testdata/vera-contract.json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(raw, &contract); err != nil {
		t.Fatal(err)
	}
	models := map[string]string{"informatieobjecten.json": "Informatieobjectbericht", "inspectierapporten.json": "Inspectierapportbericht", "defecten.json": "Defectbericht", "onderhoudstaken.json": "Onderhoudstaakbericht", "onderhoudsverzoeken.json": "Onderhoudsverzoekbericht"}
	for _, f := range files {
		name := strings.TrimPrefix(f.Path, "vera/")
		model, ok := models[name]
		if !ok {
			continue
		}
		var records []any
		if err = json.Unmarshal(f.Data, &records); err != nil {
			t.Fatal(err)
		}
		domain := "Onderhoud"
		if name == "informatieobjecten.json" {
			domain = "Dossier"
		}
		for _, r := range records {
			validatePublishedShape(t, r, contract[domain].Schemas[model], contract[domain].Schemas, name)
		}
		if bytes.Contains(f.Data, []byte(`"id": "source-42"`)) || bytes.Contains(f.Data, []byte(`"id": "report-1"`)) {
			t.Fatal("source identity was used as a receiver ID")
		}
		if name == "inspectierapporten.json" {
			r := records[0].(map[string]any)
			if r["inspectieOrder"].(map[string]any)["id"] != "receiver-inspection-7" || r["idExtern"] != "report-1" {
				t.Fatal("inspection order and report identities confused")
			}
			if _, ok := r["eenheid"]; ok {
				t.Fatal("invented property association on Inspectierapport")
			}
		}
		if name == "defecten.json" && records[0].(map[string]any)["eenheid"] != b.VERA.UnitURI {
			t.Fatal("wrong receiving unit URI")
		}
	}
	b.VERA.ReportStatusCode = ""
	b.VERA.TaskStatusCode = ""
	b.VERA.InspectionOrderID = ""
	files, err = VERAFiles(b)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		if strings.HasSuffix(f.Path, "inspectierapporten.json") && (bytes.Contains(f.Data, []byte(`"status"`)) || bytes.Contains(f.Data, []byte(`"inspectieOrder"`))) {
			t.Fatal("invented unknown receiver codes or order")
		}
	}
	for _, uri := range []string{"/eenheden/42", "https://user:secret@example.org/eenheden/42", "http://example.org/eenheden/42"} {
		c := *b.VERA
		c.UnitURI = uri
		if ValidateVERA(c) == nil {
			t.Fatalf("accepted invalid unit URI: %s", uri)
		}
	}
	b.Proposals = []Proposal{}
	files, err = VERAFiles(b)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		if strings.HasSuffix(f.Path, "onderhoudsverzoeken.json") && string(f.Data) != "[]" {
			t.Fatal("report-only export created maintenance request")
		}
	}
}

// Validate only fields that are actually emitted against the checked-in primary
// source definitions. Missing optional fields are allowed. Unknown wire fields
// fail, even though VERA's schemas permit unspecified properties by default.
func validatePublishedShape(t *testing.T, value, schema any, schemas map[string]any, path string) {
	t.Helper()
	def, ok := schema.(map[string]any)
	if !ok {
		t.Fatalf("missing published schema at %s", path)
	}
	if ref, ok := def["$ref"].(string); ok {
		validatePublishedShape(t, value, schemas[strings.TrimPrefix(ref, "#/components/schemas/")], schemas, path)
		return
	}
	properties := map[string]any{}
	var collect func(map[string]any)
	collect = func(d map[string]any) {
		if ref, ok := d["$ref"].(string); ok {
			collect(schemas[strings.TrimPrefix(ref, "#/components/schemas/")].(map[string]any))
		}
		if p, ok := d["properties"].(map[string]any); ok {
			for k, v := range p {
				properties[k] = v
			}
		}
		if parts, ok := d["allOf"].([]any); ok {
			for _, p := range parts {
				collect(p.(map[string]any))
			}
		}
	}
	if _, ok := value.(map[string]any); ok {
		collect(def)
	}
	switch v := value.(type) {
	case map[string]any:
		for k, child := range v {
			childDef, ok := properties[k]
			if !ok {
				t.Fatalf("non-VERA field %s.%s", path, k)
			}
			validatePublishedShape(t, child, childDef, schemas, path+"."+k)
		}
	case []any:
		if def["type"] != "array" {
			t.Fatalf("expected array schema at %s", path)
		}
		for i, child := range v {
			validatePublishedShape(t, child, def["items"], schemas, fmt.Sprintf("%s[%d]", path, i))
		}
	case string:
		if def["type"] != "string" {
			t.Fatalf("wrong string field %s", path)
		}
		if def["format"] == "uri" {
			u, err := url.Parse(v)
			if err != nil || u.Scheme == "" {
				t.Fatalf("invalid URI at %s", path)
			}
		}
	case bool:
		if def["type"] != "boolean" {
			t.Fatalf("wrong boolean field %s", path)
		}
	case float64:
		if def["type"] != "integer" && def["type"] != "number" {
			t.Fatalf("wrong number field %s", path)
		}
	default:
		t.Fatalf("unexpected type at %s", path)
	}
}
