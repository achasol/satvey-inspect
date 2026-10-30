package catalog

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"satvey/inspect/internal/fault"
	"sort"
	"strconv"
	"strings"
	"time"
)

// These are source facts, never inspection evidence. Unknown values stay absent.
type Cluster struct {
	ID       string `json:"id"`
	Code     string `json:"code"`
	Name     string `json:"name"`
	Kind     string `json:"kind"`
	KindCode string `json:"kindCode"`
}
type Details struct {
	BagObjectID      string            `json:"bagObjectId,omitempty"`
	BagAddressID     string            `json:"bagAddressId,omitempty"`
	BagBuildingIDs   []string          `json:"bagBuildingIds,omitempty"`
	ComplexID        string            `json:"complexId,omitempty"`
	ComplexName      string            `json:"complexName,omitempty"`
	Clusters         []Cluster         `json:"clusters,omitempty"`
	ObjectType       string            `json:"objectType,omitempty"`
	ObjectTypeCode   string            `json:"objectTypeCode,omitempty"`
	BuildYear        *int              `json:"buildYear,omitempty"`
	Area             *float64          `json:"area,omitempty"`
	AreaType         string            `json:"areaType,omitempty"`
	AreaTypeCode     string            `json:"areaTypeCode,omitempty"`
	AreaUnit         string            `json:"areaUnit,omitempty"`
	Areas            []Area            `json:"areas,omitempty"`
	SourceStatus     string            `json:"sourceStatus,omitempty"`
	SourceStatusCode string            `json:"sourceStatusCode,omitempty"`
	SourceKeys       map[string]string `json:"sourceKeys,omitempty"`
}
type Area struct {
	Value     float64 `json:"value"`
	Kind      string  `json:"kind"`
	KindCode  string  `json:"kindCode"`
	Unit      string  `json:"unit"`
	StartDate string  `json:"startDate,omitempty"`
	EndDate   string  `json:"endDate,omitempty"`
}
type Row struct {
	SourceObjectID string `json:"sourceObjectId"`
	ObjectNumber   string `json:"objectNumber"`
	Address        string `json:"address"`
	Postcode       string `json:"postcode"`
	City           string `json:"city"`
	Details
}
type Property struct {
	ID             string     `json:"id"`
	Address        string     `json:"address"`
	Postcode       string     `json:"postcode"`
	City           string     `json:"city"`
	SourceID       *string    `json:"sourceId"`
	SourceObjectID *string    `json:"sourceObjectId"`
	SourceName     *string    `json:"sourceName"`
	SourceKind     *string    `json:"sourceKind"`
	Administration *string    `json:"administration"`
	ObjectNumber   string     `json:"objectNumber"`
	LinkState      string     `json:"linkState"`
	MergedInto     *string    `json:"mergedInto"`
	FetchedAt      *time.Time `json:"fetchedAt"`
	Revision       int        `json:"revision"`
	Details
}

func NormalizeRow(p *Row) error {
	p.Address = strings.TrimSpace(p.Address)
	p.Postcode = strings.TrimSpace(p.Postcode)
	p.City = strings.TrimSpace(p.City)
	p.ObjectNumber = strings.TrimSpace(p.ObjectNumber)
	if strings.TrimSpace(p.SourceObjectID) == "" || len(p.SourceObjectID) > 512 || p.Address == "" || len(p.Address) > 240 || len(p.Postcode) > 20 || len(p.City) > 120 || len(p.ObjectNumber) > 160 {
		return fault.New(422, "Bronobject-ID en adres zijn verplicht; controleer de veldlengtes")
	}
	if p.BuildYear != nil && (*p.BuildYear < 1 || *p.BuildYear > 9999) {
		return fault.New(422, "Ongeldig bouwjaar")
	}
	if p.Area != nil && (math.IsNaN(*p.Area) || math.IsInf(*p.Area, 0) || *p.Area < 0 || *p.Area > 1e9 || p.AreaType == "" || p.AreaUnit == "") {
		return fault.New(422, "Oppervlakte vereist een geldige waarde, meetsoort en eenheid")
	}
	texts := []string{p.SourceObjectID, p.ObjectNumber, p.Address, p.Postcode, p.City, p.BagObjectID, p.BagAddressID, p.ComplexID, p.ComplexName, p.ObjectType, p.ObjectTypeCode, p.AreaType, p.AreaTypeCode, p.AreaUnit, p.SourceStatus, p.SourceStatusCode}
	texts = append(texts, p.BagBuildingIDs...)
	for k, v := range p.SourceKeys {
		texts = append(texts, k, v)
	}
	for _, c := range p.Clusters {
		texts = append(texts, c.ID, c.Code, c.Name, c.Kind, c.KindCode)
	}
	for _, a := range p.Areas {
		texts = append(texts, a.Kind, a.KindCode, a.Unit, a.StartDate, a.EndDate)
		if math.IsNaN(a.Value) || math.IsInf(a.Value, 0) || a.Value < 0 || a.Value > 1e9 {
			return fault.New(422, "Ongeldige oppervlaktemeting")
		}
	}
	for _, text := range texts {
		if strings.ContainsRune(text, 0) {
			return fault.New(422, "Een vastgoedveld bevat een ongeldig nulkarakter")
		}
	}
	// Resource collections are sets. A different response order must not trigger re-review.
	sort.Strings(p.BagBuildingIDs)
	sort.Slice(p.Clusters, func(i, j int) bool {
		a, _ := json.Marshal(p.Clusters[i])
		b, _ := json.Marshal(p.Clusters[j])
		return string(a) < string(b)
	})
	sort.Slice(p.Areas, func(i, j int) bool {
		a, _ := json.Marshal(p.Areas[i])
		b, _ := json.Marshal(p.Areas[j])
		return string(a) < string(b)
	})
	raw, e := json.Marshal(p.Details)
	if e != nil {
		return fault.New(422, "Ongeldige vastgoedkenmerken")
	}
	if len(raw) > 16000 {
		return fault.New(422, "Te veel vastgoedkenmerken")
	}
	for _, v := range []string{p.BagObjectID, p.BagAddressID, p.ComplexID, p.ComplexName, p.ObjectType, p.ObjectTypeCode, p.AreaType, p.AreaTypeCode, p.AreaUnit, p.SourceStatus, p.SourceStatusCode} {
		if len(v) > 512 {
			return fault.New(422, "Vastgoedkenmerk is te lang")
		}
	}
	return nil
}
func ParseCSV(raw string) ([]Row, []string) {
	errors := []string{}
	rows := []Row{}
	reader := csv.NewReader(strings.NewReader(strings.TrimPrefix(raw, "\ufeff")))
	reader.FieldsPerRecord = -1
	header, e := reader.Read()
	if e != nil {
		return rows, []string{"CSV-kopregel ontbreekt"}
	}
	columns := map[string]int{}
	known := map[string]bool{}
	for _, c := range CSVColumns {
		known[c] = true
	}
	for i, h := range header {
		h = strings.TrimSpace(h)
		if !known[h] {
			errors = append(errors, "Onbekende kolom: "+h)
		}
		if _, ok := columns[h]; ok {
			errors = append(errors, "Dubbele kolom: "+h)
		}
		columns[h] = i
	}
	for _, h := range []string{"sourceObjectId", "address"} {
		if _, ok := columns[h]; !ok {
			errors = append(errors, "Verplichte kolom ontbreekt: "+h)
		}
	}
	if len(errors) > 0 {
		return rows, errors
	}
	seen := map[string]bool{}
	for line := 2; ; line++ {
		record, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return rows, append(errors, fmt.Sprintf("Rij %d: ongeldige CSV", line))
		}
		if line > 10001 {
			return rows, append(errors, "Importeer maximaal 10.000 woningen per bestand")
		}
		if len(record) != len(header) {
			errors = append(errors, fmt.Sprintf("Rij %d: aantal velden wijkt af van de kopregel", line))
			continue
		}
		get := func(key string) string {
			index, ok := columns[key]
			if !ok {
				return ""
			}
			return strings.TrimSpace(record[index])
		}
		p := Row{SourceObjectID: record[columns["sourceObjectId"]], ObjectNumber: get("objectNumber"), Address: get("address"), Postcode: get("postcode"), City: get("city"), Details: Details{BagObjectID: get("bagObjectId"), BagAddressID: get("bagAddressId"), ComplexID: get("complexId"), ComplexName: get("complexName"), ObjectType: get("objectType"), ObjectTypeCode: get("objectTypeCode"), AreaType: get("areaType"), AreaTypeCode: get("areaTypeCode"), AreaUnit: get("areaUnit"), SourceStatus: get("sourceStatus"), SourceStatusCode: get("sourceStatusCode")}}
		if get("bagBuildingIds") != "" {
			p.BagBuildingIDs = strings.Split(get("bagBuildingIds"), "|")
		}
		if v := get("buildYear"); v != "" {
			n, err := strconv.Atoi(v)
			if err != nil {
				errors = append(errors, fmt.Sprintf("Rij %d: ongeldig bouwjaar", line))
			} else {
				p.BuildYear = &n
			}
		}
		if v := get("area"); v != "" {
			n, err := strconv.ParseFloat(v, 64)
			if err != nil {
				errors = append(errors, fmt.Sprintf("Rij %d: ongeldige oppervlakte (gebruik een decimale punt)", line))
			} else {
				p.Area = &n
			}
		}
		if err := NormalizeRow(&p); err != nil {
			errors = append(errors, fmt.Sprintf("Rij %d: %s", line, err.Error()))
		}
		if seen[p.SourceObjectID] {
			errors = append(errors, fmt.Sprintf("Rij %d: dubbele bronobject-ID", line))
		}
		seen[p.SourceObjectID] = true
		rows = append(rows, p)
		if len(errors) >= 100 {
			errors = append(errors, "Los eerst deze fouten op en valideer opnieuw")
			break
		}
	}
	if len(rows) == 0 && len(errors) == 0 {
		errors = append(errors, "Het bestand bevat geen woningen")
	}
	return rows, errors
}

var CSVColumns = []string{"sourceObjectId", "objectNumber", "address", "postcode", "city", "bagObjectId", "bagAddressId", "bagBuildingIds", "complexId", "complexName", "objectType", "objectTypeCode", "buildYear", "area", "areaType", "areaTypeCode", "areaUnit", "sourceStatus", "sourceStatusCode"}
