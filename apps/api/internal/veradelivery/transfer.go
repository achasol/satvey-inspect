package veradelivery

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"

	"satvey/inspect/internal/handover"
)

type Receipt struct{ Key, ReceiverID, URI string }
type Blob struct {
	Path string
	Data []byte
}

// Transfer is repeatable after any interruption. Source identities are scoped
// by resource and remain stable across delivery revisions of the same report.
func (c *Client) Transfer(ctx context.Context, bundle handover.Bundle, blobs []Blob, checkpoint func(Receipt) error) error {
	if bundle.VERA == nil {
		return blocked("De VERA-woningkoppeling ontbreekt")
	}
	if e := c.ValidateUnit(ctx, bundle.VERA.UnitURI); e != nil {
		return e
	}
	bundle.ID = bundle.Report.ID // Stable document and maintenance-request identities.
	files, e := handover.VERAFiles(bundle)
	if e != nil {
		return e
	}
	records := map[string][]map[string]any{}
	for _, file := range files {
		var name string
		if _, e := fmt.Sscanf(file.Path, "vera/%s", &name); e != nil {
			continue
		}
		if len(name) < 6 || name[len(name)-5:] != ".json" || name == "transfer-plan.json" {
			continue
		}
		var rows []map[string]any
		if json.Unmarshal(file.Data, &rows) != nil {
			return blocked("Ongeldige interne VERA-projectie")
		}
		records[name[:len(name)-5]] = rows
	}
	ids := map[string]map[string]string{}
	for name := range records {
		ids[name] = map[string]string{}
	}
	documentURIs := map[string]string{}
	binary := map[string][]byte{}
	for _, blob := range blobs {
		binary[blob.Path] = blob.Data
	}
	var plan struct {
		Documents []struct {
			External  string `json:"idExtern"`
			Path      string `json:"localPath"`
			Reference string `json:"reference"`
		} `json:"documents"`
	}
	for _, file := range files {
		if file.Path == "vera/transfer-plan.json" {
			if json.Unmarshal(file.Data, &plan) != nil {
				return blocked("Ongeldige interne documentverwijzingen")
			}
		}
	}
	accept := func(collection string, row map[string]any) (string, error) {
		saved, e := c.Ensure(ctx, collection, row)
		if e != nil {
			return "", e
		}
		receiver := stringValue(saved, "id")
		external := stringValue(row, "idExtern")
		ids[collection][external] = receiver
		return receiver, checkpoint(Receipt{Key: collection + ":" + external, ReceiverID: receiver, URI: c.URI(collection, receiver)})
	}
	for _, document := range plan.Documents {
		data, ok := binary[document.Path]
		if !ok {
			return blocked("Een vastgelegde rapportbijlage ontbreekt")
		}
		var row map[string]any
		for _, item := range records["informatieobjecten"] {
			if stringValue(item, "idExtern") == document.External {
				row = item
				break
			}
		}
		if row == nil {
			return blocked("Document niet in de rapportprojectie gevonden")
		}
		row["bestand"] = base64.StdEncoding.EncodeToString(data)
		row["bestandsgrootte"] = float64(len(data))
		receiver, e := accept("informatieobjecten", row)
		if e != nil {
			return e
		}
		documentURIs[document.Reference] = c.URI("informatieobjecten", receiver)
	}
	targets := map[string]string{"inspectierapport": "inspectierapporten", "geconstateerdeDefecten": "defecten", "voorgesteldeOnderhoudstaken": "onderhoudstaken", "defecten": "defecten", "onderhoudstaken": "onderhoudstaken", "onderhoudsverzoek": "onderhoudsverzoeken"}
	resolve := func(original map[string]any, omit ...string) (map[string]any, error) {
		row := map[string]any{}
		for field, value := range original {
			skip := false
			for _, name := range omit {
				if field == name {
					skip = true
				}
			}
			if skip {
				continue
			}
			if field == "informatieobjecten" {
				refs, _ := value.([]any)
				resolved := []any{}
				for _, ref := range refs {
					uri, ok := documentURIs[ref.(string)]
					if !ok {
						return nil, blocked("Onopgeloste documentverwijzing")
					}
					resolved = append(resolved, uri)
				}
				row[field] = resolved
				continue
			}
			if collection, ok := targets[field]; ok {
				key := func(v any) (any, error) {
					source, ok := v.(map[string]any)
					if !ok {
						return nil, blocked("Ongeldige sleutelverwijzing")
					}
					receiver := ids[collection][stringValue(source, "idExtern")]
					if receiver == "" {
						return nil, blocked("Onopgeloste ontvangende VERA-sleutel")
					}
					return map[string]any{"id": receiver}, nil
				}
				if values, ok := value.([]any); ok {
					resolved := []any{}
					for _, v := range values {
						item, e := key(v)
						if e != nil {
							return nil, e
						}
						resolved = append(resolved, item)
					}
					row[field] = resolved
				} else {
					item, e := key(value)
					if e != nil {
						return nil, e
					}
					row[field] = item
				}
				continue
			}
			row[field] = value
		}
		return row, nil
	}
	for _, original := range records["inspectierapporten"] {
		row, e := resolve(original, "geconstateerdeDefecten", "voorgesteldeOnderhoudstaken")
		if e != nil {
			return e
		}
		if _, e = accept("inspectierapporten", row); e != nil {
			return e
		}
	}
	for _, collection := range []string{"defecten", "onderhoudstaken", "onderhoudsverzoeken"} {
		for _, original := range records[collection] {
			omit := []string{}
			if collection == "onderhoudstaken" {
				omit = append(omit, "onderhoudsverzoek")
			}
			row, e := resolve(original, omit...)
			if e != nil {
				return e
			}
			if _, e = accept(collection, row); e != nil {
				return e
			}
		}
	}
	for _, collection := range []string{"onderhoudsverzoeken", "onderhoudstaken", "inspectierapporten"} {
		for _, original := range records[collection] {
			row, e := resolve(original)
			if e != nil {
				return e
			}
			fields := map[string]any{}
			for _, field := range []string{"geconstateerdeDefecten", "voorgesteldeOnderhoudstaken", "defecten", "onderhoudstaken", "onderhoudsverzoek", "informatieobjecten"} {
				if value, ok := row[field]; ok {
					fields[field] = value
				}
			}
			receiver := ids[collection][stringValue(original, "idExtern")]
			if e = c.Link(ctx, collection, receiver, fields); e != nil {
				return e
			}
			if e = checkpoint(Receipt{Key: "links:" + collection + ":" + stringValue(original, "idExtern"), ReceiverID: receiver, URI: c.URI(collection, receiver)}); e != nil {
				return e
			}
		}
	}
	return nil
}
