// Package handover defines the portable, versioned boundary between an approved
// inspection and the systems that authorize and execute maintenance.
package handover

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"sort"
	"strings"
	"time"
	"unicode"

	"satvey/inspect/internal/catalog"
	"satvey/inspect/internal/fault"
	"satvey/inspect/internal/reporting"
)

const SchemaVersion = "satvey.handover/1"

type Source struct {
	Key         string          `json:"key"`
	Kind        string          `json:"kind"`
	Title       string          `json:"title"`
	Description string          `json:"description"`
	Location    string          `json:"location"`
	PhotoIDs    []string        `json:"photoIds"`
	Value       json.RawMessage `json:"value,omitempty"`
	Outcome     string          `json:"outcome,omitempty"`
}

type Photo struct {
	ID          string                 `json:"id"`
	BatchID     string                 `json:"batchId"`
	Kind        string                 `json:"kind"`
	Name        string                 `json:"name"`
	Annotations []reporting.Annotation `json:"annotations,omitempty"`
}

type Report struct {
	ID           string           `json:"id"`
	InspectionID string           `json:"inspectionId"`
	Kind         string           `json:"kind"`
	CreatedAt    time.Time        `json:"createdAt"`
	Organisation string           `json:"organisation"`
	Author       string           `json:"author"`
	Property     catalog.Property `json:"property"`
	Sources      []Source         `json:"sources"`
	Photos       []Photo          `json:"photos"`
}

type Proposal struct {
	ID          string   `json:"id"`
	SourceKeys  []string `json:"sourceKeys"`
	Description string   `json:"description"`
	Location    string   `json:"location"`
	Urgency     string   `json:"urgency"`
	ElementCode string   `json:"elementCode"`
	Quantity    *float64 `json:"quantity,omitempty"`
	Unit        string   `json:"unit"`
}

type Draft struct {
	DestinationID     string       `json:"destinationId,omitempty"`
	Version           int          `json:"version"`
	Destination       string       `json:"destination"`
	ExternalReference string       `json:"externalReference"`
	Proposals         []Proposal   `json:"proposals"`
	VERA              *VERAContext `json:"vera,omitempty"`
}

type Attachment struct {
	Path     string `json:"path"`
	MIME     string `json:"mime"`
	MediaID  string `json:"mediaId,omitempty"`
	SHA256   string `json:"sha256,omitempty"`
	Bytes    int    `json:"bytes,omitempty"`
	Original bool   `json:"original,omitempty"`
}

type Bundle struct {
	SchemaVersion     string       `json:"schemaVersion"`
	ID                string       `json:"id"`
	CreatedAt         time.Time    `json:"createdAt"`
	DraftVersion      int          `json:"draftVersion"`
	Destination       string       `json:"destination"`
	ExternalReference string       `json:"externalReference"`
	Report            Report       `json:"report"`
	Proposals         []Proposal   `json:"proposals"`
	Attachments       []Attachment `json:"attachments"`
	VERA              *VERAContext `json:"vera,omitempty"`
}

// ReadReport deliberately projects the private report snapshot onto a whitelist.
// In particular, format answers' audio IDs and transcript provenance never leave
// the inspection boundary, even if a legacy snapshot contains those fields.
func ReadReport(raw []byte) (Report, error) {
	var in struct {
		ID         string    `json:"id"`
		CreatedAt  time.Time `json:"createdAt"`
		Inspection struct {
			ID, Kind, Status string
			PropertySnapshot catalog.Property `json:"propertySnapshot"`
		} `json:"inspection"`
		Organisation struct{ Name string } `json:"organisation"`
		CreatedBy    struct{ Name string } `json:"createdBy"`
		FinalisedBy  struct{ Name string } `json:"finalisedBy"`
		Rooms        []struct {
			ID, Name           string
			Generation         int
			ApprovedGeneration *int `json:"approvedGeneration"`
		} `json:"rooms"`
		Batches      []struct{ ID, RoomID, Status string } `json:"batches"`
		Media        []Photo                               `json:"media"`
		Observations []struct {
			ID, BatchID, Title, Description string
			PhotoIDs                        []string `json:"photoIds"`
		} `json:"observations"`
		Answers []struct {
			ID, RoomID, QuestionID, Status, Reason, Outcome string
			Value                                           json.RawMessage `json:"value"`
			PhotoIDs                                        []string        `json:"photoIds"`
		} `json:"answers"`
		Assessments []struct {
			RuleID, BatchID, Outcome, Reason string
			PhotoIDs                         []string `json:"photoIds"`
		} `json:"assessments"`
		Format *struct {
			Scopes []struct{ Questions []struct{ ID, Title string } }
		} `json:"format"`
		Norms *struct{ Rules []struct{ ID, Title string } } `json:"norms"`
	}
	if err := json.Unmarshal(raw, &in); err != nil {
		return Report{}, err
	}
	if in.Inspection.Status != "final" || in.ID == "" || in.Inspection.PropertySnapshot.LinkState != "linked" {
		return Report{}, fault.New(422, "Leg eerst het rapport vast met een gekoppeld vastgoedobject")
	}
	out := Report{ID: in.ID, InspectionID: in.Inspection.ID, Kind: in.Inspection.Kind, CreatedAt: in.CreatedAt,
		Organisation: in.Organisation.Name, Author: in.FinalisedBy.Name, Property: in.Inspection.PropertySnapshot,
		Sources: []Source{}, Photos: []Photo{}}
	if out.Author == "" {
		out.Author = in.CreatedBy.Name
	}
	rooms, reviewedRooms, batches := map[string]string{}, map[string]bool{}, map[string]string{}
	for _, room := range in.Rooms {
		rooms[room.ID] = room.Name
		reviewedRooms[room.ID] = room.ApprovedGeneration != nil && *room.ApprovedGeneration == room.Generation
	}
	for _, b := range in.Batches {
		if b.Status == "reviewed" {
			batches[b.ID] = b.RoomID
		}
	}
	photos := map[string]Photo{}
	for _, p := range in.Media {
		if p.Kind == "photo" && batches[p.BatchID] != "" {
			photos[p.ID] = p
		}
	}
	photoIDs := func(ids []string) []string {
		result := []string{}
		seen := map[string]bool{}
		for _, id := range ids {
			if _, ok := photos[id]; ok && !seen[id] {
				result = append(result, id)
				seen[id] = true
			}
		}
		sort.Strings(result)
		return result
	}
	for _, o := range in.Observations {
		room, ok := batches[o.BatchID]
		if !ok {
			continue
		}
		ids := o.PhotoIDs
		if len(ids) == 0 {
			for _, p := range in.Media {
				if p.BatchID == o.BatchID {
					ids = append(ids, p.ID)
				}
			}
		}
		out.Sources = append(out.Sources, Source{Key: "observation:" + o.ID, Kind: "observation", Title: o.Title, Description: o.Description, Location: rooms[room], PhotoIDs: photoIDs(ids)})
	}
	questions, rules := map[string]string{}, map[string]string{}
	if in.Format != nil {
		for _, scope := range in.Format.Scopes {
			for _, q := range scope.Questions {
				questions[q.ID] = q.Title
			}
		}
	}
	if in.Norms != nil {
		for _, rule := range in.Norms.Rules {
			rules[rule.ID] = rule.Title
		}
	}
	for _, answer := range in.Answers {
		if !reviewedRooms[answer.RoomID] || (answer.Status != "confirmed" && answer.Status != "unanswerable") {
			continue
		}
		out.Sources = append(out.Sources, Source{Key: "answer:" + answer.ID, Kind: "answer", Title: questions[answer.QuestionID], Description: answer.Reason,
			Location: rooms[answer.RoomID], PhotoIDs: photoIDs(answer.PhotoIDs), Value: answer.Value, Outcome: answer.Outcome})
	}
	for _, assessment := range in.Assessments {
		room, ok := batches[assessment.BatchID]
		if !ok {
			continue
		}
		out.Sources = append(out.Sources, Source{Key: "assessment:" + assessment.BatchID + ":" + assessment.RuleID, Kind: "assessment", Title: rules[assessment.RuleID],
			Description: assessment.Reason, Location: rooms[room], PhotoIDs: photoIDs(assessment.PhotoIDs), Outcome: assessment.Outcome})
	}
	sort.Slice(out.Sources, func(i, j int) bool { return out.Sources[i].Key < out.Sources[j].Key })
	used := map[string]bool{}
	for _, s := range out.Sources {
		for _, p := range s.PhotoIDs {
			used[p] = true
		}
	}
	for id, p := range photos {
		if used[id] {
			out.Photos = append(out.Photos, p)
		}
	}
	sort.Slice(out.Photos, func(i, j int) bool { return out.Photos[i].ID < out.Photos[j].ID })
	return out, nil
}

func ValidateDraft(d *Draft, report Report) error {
	d.Destination = strings.TrimSpace(d.Destination)
	d.ExternalReference = strings.TrimSpace(d.ExternalReference)
	if d.Version < 0 || len(d.Destination) > 160 || len(d.ExternalReference) > 512 || len(d.Proposals) > 200 {
		return fault.New(422, "Controleer bestemming, referentie en het aantal onderhoudsvoorstellen")
	}
	known := map[string]bool{}
	for _, s := range report.Sources {
		known[s.Key] = true
	}
	seen := map[string]bool{}
	for i := range d.Proposals {
		p := &d.Proposals[i]
		p.Description = strings.TrimSpace(p.Description)
		p.Location = strings.TrimSpace(p.Location)
		if len(p.ID) != 36 || seen[p.ID] || len(p.SourceKeys) == 0 || len(p.SourceKeys) > 100 || p.Description == "" || len(p.Description) > 6000 || len(p.Location) > 240 || len(p.ElementCode) > 160 || len(p.Unit) > 40 {
			return fault.New(422, "Geef elk onderhoudsvoorstel een unieke ID, bron en werkomschrijving")
		}
		seen[p.ID] = true
		if p.Urgency != "unspecified" && p.Urgency != "routine" && p.Urgency != "soon" && p.Urgency != "urgent" {
			return fault.New(422, "Kies een geldige urgentie")
		}
		refs := map[string]bool{}
		for _, key := range p.SourceKeys {
			if !known[key] || refs[key] {
				return fault.New(422, "Een onderhoudsvoorstel verwijst naar een onbekende of dubbele rapportbron")
			}
			refs[key] = true
		}
		if (p.Quantity == nil && p.Unit != "") || (p.Quantity != nil && (math.IsNaN(*p.Quantity) || math.IsInf(*p.Quantity, 0) || *p.Quantity <= 0 || *p.Quantity > 1e9 || strings.TrimSpace(p.Unit) == "")) {
			return fault.New(422, "Een hoeveelheid vereist een positieve waarde en een eenheid")
		}
		for _, value := range []string{p.Description, p.Location, p.ElementCode, p.Unit, p.ID} {
			if strings.ContainsRune(value, 0) {
				return fault.New(422, "Ongeldige tekst in onderhoudsvoorstel")
			}
		}
	}
	if strings.ContainsRune(d.Destination+d.ExternalReference, 0) {
		return fault.New(422, "Ongeldige bestemming of referentie")
	}
	if d.Proposals == nil {
		d.Proposals = []Proposal{}
	}
	if d.VERA != nil {
		if err := ValidateVERA(*d.VERA); err != nil {
			return err
		}
	}
	return nil
}

// CSV cells are text, including when a finding begins with a spreadsheet formula.
func csvText(s string) string {
	trimmed := strings.TrimLeftFunc(s, unicode.IsSpace)
	if strings.ContainsAny(s, "\t\r") || (trimmed != "" && strings.ContainsRune("=+-@", rune(trimmed[0]))) {
		return "'" + s
	}
	return s
}

func WriteCSV(w io.Writer, b Bundle) error {
	c := csv.NewWriter(w)
	if err := c.Write([]string{"proposalId", "reportId", "sourceObjectId", "administration", "destination", "externalReference", "location", "description", "urgency", "elementCode", "quantity", "unit", "sourceKeys"}); err != nil {
		return err
	}
	value := func(s *string) string {
		if s == nil {
			return ""
		}
		return *s
	}
	for _, p := range b.Proposals {
		quantity := ""
		if p.Quantity != nil {
			quantity = fmt.Sprint(*p.Quantity)
		}
		row := []string{p.ID, b.Report.ID, value(b.Report.Property.SourceObjectID), value(b.Report.Property.Administration), b.Destination, b.ExternalReference, p.Location, p.Description, p.Urgency, p.ElementCode, quantity, p.Unit, strings.Join(p.SourceKeys, "|")}
		for i := range row {
			row[i] = csvText(row[i])
		}
		if err := c.Write(row); err != nil {
			return err
		}
	}
	c.Flush()
	return c.Error()
}
