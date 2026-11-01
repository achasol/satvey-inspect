package handover

import (
	"encoding/json"
	"net/url"
	"satvey/inspect/internal/fault"
	"sort"
	"strings"
)

// VERAContext captures a destination mapping, separately from source identity.
type VERAContext struct {
	UnitURI             string `json:"unitUri"`
	Organisation        string `json:"organisation"`
	Administration      string `json:"administration"`
	InspectionOrderID   string `json:"inspectionOrderId"`
	ReportTypeCode      string `json:"reportTypeCode"`
	ReportStatusCode    string `json:"reportStatusCode"`
	TaskStatusCode      string `json:"taskStatusCode"`
	RequestStatusCode   string `json:"requestStatusCode"`
	MaintenanceTypeCode string `json:"maintenanceTypeCode"`
}

func ValidateVERA(c VERAContext) error {
	u, err := url.Parse(c.UnitURI)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Fragment != "" || len(c.UnitURI) > 2000 || strings.TrimSpace(c.Organisation) == "" || strings.TrimSpace(c.Administration) == "" {
		return fault.New(422, "VERA vereist de HTTPS-eenheid-URI en de afgesproken bronorganisatie en bronadministratie")
	}
	for _, v := range []string{c.UnitURI, c.Organisation, c.Administration, c.InspectionOrderID, c.ReportTypeCode, c.ReportStatusCode, c.TaskStatusCode, c.RequestStatusCode, c.MaintenanceTypeCode} {
		if len(v) > 2000 || strings.ContainsRune(v, 0) {
			return fault.New(422, "Controleer de VERA-identificatie en referentiecodes")
		}
	}
	return nil
}

type File struct {
	Path string
	Data []byte
}

// VERAFiles emits VERA 4.3.3 records and a transfer plan. URNs are explicitly
// package-local placeholders. An importer must resolve them and attach bytes;
// these files do not pretend a receiving system has already accepted anything.
func VERAFiles(b Bundle) ([]File, error) {
	if b.VERA == nil {
		return nil, nil
	}
	c := *b.VERA
	if err := ValidateVERA(c); err != nil {
		return nil, err
	}
	key := func(id string) map[string]any {
		return map[string]any{"idExtern": id, "idOrganisatie": c.Organisation, "idAdministratie": c.Administration}
	}
	code := func(record map[string]any, field, value string) {
		if value != "" {
			record[field] = map[string]string{"code": value}
		}
	}
	docURN := func(path string) string { return "urn:satvey:handover:" + b.ID + ":" + url.PathEscape(path) }
	documents := []map[string]any{}
	transfer := []map[string]any{}
	allDocumentRefs := []string{}
	for i, a := range b.Attachments {
		id := b.ID + ":" + a.Path
		doc := key(id)
		doc["titel"] = a.Path
		doc["bestandsnaam"] = a.Path
		doc["auteur"] = b.Report.Author
		doc["eenheden"] = []string{c.UnitURI}
		doc["externePublicatie"] = false
		doc["beschrijving"] = "Bewijs bij inspectierapport " + b.Report.ID
		if a.Bytes > 0 {
			doc["bestandsgrootte"] = a.Bytes
		}
		documents = append(documents, doc)
		allDocumentRefs = append(allDocumentRefs, docURN(a.Path))
		transfer = append(transfer, map[string]any{"index": i, "idExtern": id, "localPath": a.Path, "mime": a.MIME, "reference": docURN(a.Path), "binaryField": "bestand", "binaryEncoding": "base64"})
	}
	known := map[string]Source{}
	for _, s := range b.Report.Sources {
		known[s.Key] = s
	}
	selected := map[string]bool{}
	for _, p := range b.Proposals {
		for _, source := range p.SourceKeys {
			selected[source] = true
		}
	}
	defects := []map[string]any{}
	defectKeys := []map[string]any{}
	keys := []string{}
	for k := range selected {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		s, ok := known[k]
		if !ok {
			return nil, fault.New(422, "Onbekende rapportbron in VERA-overdracht")
		}
		d := key(b.Report.ID + ":" + s.Key)
		defectKeys = append(defectKeys, key(b.Report.ID+":"+s.Key))
		d["omschrijving"] = strings.TrimSpace(s.Title + "\n" + s.Description)
		d["eenheid"] = c.UnitURI
		d["inspectierapport"] = key(b.Report.ID)
		refs := []string{docURN("report.pdf")}
		photos := map[string]bool{}
		for _, id := range s.PhotoIDs {
			photos[id] = true
		}
		for _, a := range b.Attachments {
			if photos[a.MediaID] {
				refs = append(refs, docURN(a.Path))
			}
		}
		d["informatieobjecten"] = refs
		defects = append(defects, d)
	}
	tasks := []map[string]any{}
	taskKeys := []map[string]any{}
	for _, p := range b.Proposals {
		task := key(p.ID)
		taskKeys = append(taskKeys, key(p.ID))
		task["omschrijving"] = strings.TrimSpace(p.Location + ": " + p.Description)
		task["onderhoudsverzoek"] = key(b.ID)
		refs := []map[string]any{}
		for _, s := range p.SourceKeys {
			refs = append(refs, key(b.Report.ID+":"+s))
		}
		task["defecten"] = refs
		code(task, "status", c.TaskStatusCode)
		tasks = append(tasks, task)
	}
	report := key(b.Report.ID)
	report["omschrijving"] = "Vastgesteld inspectierapport: " + b.Report.Property.Address
	report["geconstateerdeDefecten"] = defectKeys
	report["voorgesteldeOnderhoudstaken"] = taskKeys
	report["informatieobjecten"] = allDocumentRefs
	if c.InspectionOrderID != "" {
		report["inspectieOrder"] = map[string]string{"id": c.InspectionOrderID}
	}
	code(report, "soort", c.ReportTypeCode)
	code(report, "status", c.ReportStatusCode)
	requests := []map[string]any{}
	if len(tasks) > 0 {
		request := key(b.ID)
		request["omschrijving"] = "Onderhoudsvoorstellen bij inspectierapport " + b.Report.ID
		request["onderhoudstaken"] = taskKeys
		request["defecten"] = defectKeys
		request["informatieobjecten"] = []string{docURN("report.pdf")}
		code(request, "status", c.RequestStatusCode)
		code(request, "onderhoudSoort", c.MaintenanceTypeCode)
		requests = append(requests, request)
	}
	plan := map[string]any{"schemaVersion": "satvey.vera-transfer/1", "onderhoudVersion": "4.3.3+261002.6", "dossierVersion": "4.3.3+261002.6", "documents": transfer,
		"resources": []map[string]string{{"file": "informatieobjecten.json", "domain": "Dossier", "collection": "/informatieobjecten"}, {"file": "defecten.json", "domain": "Onderhoud", "collection": "/defecten"}, {"file": "onderhoudstaken.json", "domain": "Onderhoud", "collection": "/onderhoudstaken"}, {"file": "onderhoudsverzoeken.json", "domain": "Onderhoud", "collection": "/onderhoudsverzoeken"}, {"file": "inspectierapporten.json", "domain": "Onderhoud", "collection": "/inspectierapporten"}}}
	entries := []struct {
		name  string
		value any
	}{{"informatieobjecten.json", documents}, {"defecten.json", defects}, {"onderhoudstaken.json", tasks}, {"onderhoudsverzoeken.json", requests}, {"inspectierapporten.json", []map[string]any{report}}, {"transfer-plan.json", plan}}
	out := []File{}
	for _, e := range entries {
		raw, err := json.MarshalIndent(e.value, "", "  ")
		if err != nil {
			return nil, err
		}
		out = append(out, File{Path: "vera/" + e.name, Data: raw})
	}
	out = append(out, File{Path: "vera/README.txt", Data: []byte(veraReadme)})
	return out, nil
}

const veraReadme = `VERA interne overdracht — gegevensprofiel 4.3.3

Deze bestanden bereiden overdracht aan interne onderhouds- en dossiersystemen voor. Er zijn geen API-verzoeken verstuurd.

1. Stem writable endpoints, authenticatie, referentiecodes, validatie en create/update-gedrag met de ontvangende leverancier af.
2. Lees transfer-plan.json. Vul bij informatieobjecten het veld bestand met base64 van het lokale bestand. Vervang alle pakket-URNs door de werkelijk ontvangen informatieobject-URI; de URN is geen downloadadres.
3. Los sleutelverwijzingen op met idExtern + idOrganisatie + idAdministratie. Dit zijn bronidentiteiten; vul id uitsluitend met de sleutel uit het ontvangende systeem. Onderlinge verwijzingen kunnen een aanmaak- en koppelpassage vereisen.
4. Verstuur elk record afzonderlijk naar het afgestemde endpoint. Verwerk bestaande bronidentiteiten via het afgesproken updatepad; voorkom dubbele records bij herimport of herhaalde versies.
5. Registreer per document, defect, onderhoudstaak, verzoek en inspectierapport de ontvangen sleutel en de daadwerkelijke acceptatie.

Onbekende referentiecodes blijven afwezig. Urgentie, hoeveelheid, eenheid en elementcode blijven beschikbaar in handover.json en work-proposals.csv; deze hebben in dit profiel geen onbewezen VERA-mapping. Er worden geen onderhoudsorders aangemaakt.

Bron: https://github.com/Aedes-datastandaarden/vera-openapi (Informatiedomeinen/Onderhoud.yaml en Dossier.yaml, versie 4.3.3+261002.6, geraadpleegd 2026-10-31).
`
