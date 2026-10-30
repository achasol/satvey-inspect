package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type veraObject map[string]json.RawMessage

func veraText(v json.RawMessage) string { var s string; _ = json.Unmarshal(v, &s); return s }
func veraLabel(v json.RawMessage) (string, string) {
	var o veraObject
	if json.Unmarshal(v, &o) != nil {
		return "", ""
	}
	name := veraText(o["naam"])
	if name == "" {
		name = veraText(o["omschrijving"])
	}
	code := veraText(o["code"])
	if name == "" {
		name = code
	}
	return name, code
}

type veraClient struct {
	source        propertySource
	client        *http.Client
	authorization string
	cache         map[string]veraObject
}

func (a *app) newVeraClient(ctx context.Context, org string, s propertySource) (*veraClient, error) {
	if s.Kind != "vera" || !s.Enabled {
		return nil, fmt.Errorf("de VERA-bron is niet ingeschakeld")
	}
	if _, e := propertyURL(s.BaseURL); e != nil {
		return nil, e
	}
	secret, e := decryptPropertySecret(s.Secret, org, s.ID)
	if e != nil {
		return nil, e
	}
	c := &veraClient{source: s, client: &http.Client{Timeout: 20 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
		return fmt.Errorf("doorverwijzingen zijn niet toegestaan")
	}}, cache: map[string]veraObject{}}
	if s.AuthKind == "api_key" {
		c.authorization = secret
		return c, nil
	}
	if _, e = propertyURL(s.TokenURL); e != nil {
		return nil, e
	}
	body := url.Values{"grant_type": {"client_credentials"}}
	if s.Scopes != "" {
		body.Set("scope", s.Scopes)
	}
	req, e := http.NewRequestWithContext(ctx, "POST", s.TokenURL, strings.NewReader(body.Encode()))
	if e != nil {
		return nil, fmt.Errorf("ongeldig token-endpoint")
	}
	req.SetBasicAuth(s.ClientID, secret)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, e := c.client.Do(req)
	if e != nil {
		return nil, fmt.Errorf("OAuth2-token tijdelijk niet beschikbaar")
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("OAuth2-token gaf HTTP %d", res.StatusCode)
	}
	var token struct {
		AccessToken string `json:"access_token"`
		TokenType   string `json:"token_type"`
	}
	if e = json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&token); e != nil || token.AccessToken == "" || !strings.EqualFold(token.TokenType, "Bearer") {
		return nil, fmt.Errorf("ongeldig OAuth2-tokenantwoord")
	}
	c.authorization = token.AccessToken
	return c, nil
}
func (c *veraClient) get(ctx context.Context, endpoint string, out any) (http.Header, error) {
	u, e := url.Parse(endpoint)
	base, _ := url.Parse(c.source.BaseURL)
	if e != nil || u.User != nil || u.Fragment != "" || u.Scheme != base.Scheme || !strings.EqualFold(u.Host, base.Host) || !strings.HasPrefix(u.EscapedPath(), strings.TrimRight(base.EscapedPath(), "/")+"/") {
		return nil, fmt.Errorf("VERA-verwijzing ligt buiten de geconfigureerde bron")
	}
	req, e := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
	if e != nil {
		return nil, fmt.Errorf("ongeldige VERA-verwijzing")
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-Parameters-AantalPerPagina", "25")
	if c.source.AuthKind == "api_key" {
		req.Header.Set("X-API-KEY", c.authorization)
	} else {
		req.Header.Set("Authorization", "Bearer "+c.authorization)
	}
	res, e := c.client.Do(req)
	if e != nil {
		return nil, fmt.Errorf("VERA tijdelijk niet bereikbaar")
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("VERA gaf HTTP %d voor %s", res.StatusCode, strings.Split(strings.TrimPrefix(u.Path, base.Path), "?")[0])
	}
	decoder := json.NewDecoder(io.LimitReader(res.Body, 8<<20))
	if e = decoder.Decode(out); e != nil {
		return nil, fmt.Errorf("VERA gaf ongeldige of te grote JSON")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return nil, fmt.Errorf("VERA gaf ongeldige JSON")
	}
	return res.Header, nil
}
func (c *veraClient) reference(ctx context.Context, raw json.RawMessage, resource string) (veraObject, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	endpoint := ""
	var object veraObject
	if raw[0] == '"' {
		reference := veraText(raw)
		u, e := url.Parse(reference)
		if e != nil {
			return nil, fmt.Errorf("ongeldige VERA-resourceverwijzing")
		}
		base, _ := url.Parse(c.source.BaseURL + "/")
		endpoint = base.ResolveReference(u).String()
	} else {
		if e := json.Unmarshal(raw, &object); e != nil {
			return nil, fmt.Errorf("ongeldige VERA-sleutels")
		}
		// An expanded resource can be used directly. A keys-only association needs a GET.
		for key := range object {
			switch key {
			case "id", "idExtern", "idGegevensbeheerder", "idOrganisatie", "idAdministratie", "code":
			default:
				return object, nil
			}
		}
		remoteID := veraText(object["id"])
		if remoteID == "" {
			return nil, fmt.Errorf("VERA-verwijzing naar %s mist id; idExtern is geen vervanging", resource)
		}
		endpoint = c.source.BaseURL + "/" + resource + "/" + url.PathEscape(remoteID)
	}
	expected, _ := url.Parse(c.source.BaseURL + "/" + resource + "/")
	u, e := url.Parse(endpoint)
	if e != nil || u.Scheme != expected.Scheme || !strings.EqualFold(u.Host, expected.Host) || !strings.HasPrefix(u.EscapedPath(), expected.EscapedPath()) || u.RawQuery != "" {
		return nil, fmt.Errorf("VERA-verwijzing naar %s ligt buiten de geconfigureerde resource", resource)
	}
	if cached, ok := c.cache[endpoint]; ok {
		return cached, nil
	}
	var out veraObject
	if _, e = c.get(ctx, endpoint, &out); e != nil {
		return nil, e
	}
	if object != nil && veraText(out["id"]) != veraText(object["id"]) {
		return nil, fmt.Errorf("VERA-resource %s heeft een afwijkende identiteit", resource)
	}
	c.cache[endpoint] = out
	return out, nil
}
func (c *veraClient) mapUnit(ctx context.Context, unit veraObject) (catalogRow, error) {
	p := catalogRow{SourceObjectID: veraText(unit["id"]), ObjectNumber: veraText(unit["code"])}
	if p.SourceObjectID == "" {
		return p, fmt.Errorf("VERA-eenheid mist id; idExtern wordt afzonderlijk bewaard")
	}
	p.SourceKeys = map[string]string{}
	for _, key := range []string{"id", "idExtern", "idGegevensbeheerder", "idOrganisatie", "idAdministratie", "code"} {
		if v := veraText(unit[key]); v != "" {
			p.SourceKeys[key] = v
		}
	}
	p.ObjectType, p.ObjectTypeCode = veraLabel(unit["detailSoort"])
	if p.ObjectType == "" {
		p.ObjectType, p.ObjectTypeCode = veraLabel(unit["soort"])
	}
	p.SourceStatus, p.SourceStatusCode = veraLabel(unit["status"])
	if len(unit["bouwjaar"]) > 0 && string(unit["bouwjaar"]) != "null" {
		if e := json.Unmarshal(unit["bouwjaar"], &p.BuildYear); e != nil {
			return p, fmt.Errorf("VERA-bouwjaar is ongeldig")
		}
	}
	address, e := c.reference(ctx, unit["adres"], "adressen")
	if e != nil {
		return p, e
	}
	if address == nil {
		return p, fmt.Errorf("VERA-eenheid %s heeft geen hoofdadres", p.SourceObjectID)
	}
	p.Address = veraText(address["adres"])
	if p.Address == "" {
		p.Address = strings.TrimSpace(veraText(address["straatnaam"]) + " " + veraText(address["huisnummer"]) + veraText(address["huisletter"]))
		if suffix := veraText(address["huisnummerToevoeging"]); suffix != "" {
			p.Address += "-" + suffix
		}
	}
	p.Postcode = veraText(address["postcode"])
	if v := address["woonplaats"]; len(v) > 0 {
		// BuitenlandsAdres has a textual city; Eenheidadres has Woonplaats-sleutels.
		if v[0] == '"' && !strings.Contains(veraText(v), "/") {
			p.City = veraText(v)
		} else {
			city, err := c.reference(ctx, v, "woonplaatsen")
			if err != nil {
				return p, err
			}
			p.City = veraText(city["naam"])
		}
	}
	bagAddress, e := c.reference(ctx, address["bag"], "bag-adressen")
	if e != nil {
		return p, e
	}
	p.BagAddressID = veraText(bagAddress["bagNummeraanduidingIdentificatie"])
	bag, e := c.reference(ctx, unit["adresseerbaarObjectBasisregistratie"], "adresseerbare-objecten-basisregistratie")
	if e != nil {
		return p, e
	}
	p.BagObjectID = veraText(bag["bagIdentificatie"])
	var bagPands []json.RawMessage
	if len(bag["bagPandenBasisregistratie"]) > 0 {
		if e = json.Unmarshal(bag["bagPandenBasisregistratie"], &bagPands); e != nil {
			return p, fmt.Errorf("ongeldige BAG-pandverwijzingen")
		}
	}
	if len(bagPands) > 25 {
		return p, fmt.Errorf("meer dan 25 BAG-panden bij één eenheid")
	}
	for _, ref := range bagPands {
		b, err := c.reference(ctx, ref, "bag-panden")
		if err != nil {
			return p, err
		}
		if v := veraText(b["bagIdentificatie"]); v != "" {
			p.BagBuildingIDs = append(p.BagBuildingIDs, v)
		}
	}
	// Keep all measurement definitions; several different surface areas are not interchangeable.
	var surfaces []json.RawMessage
	if raw := unit["oppervlakten"]; len(raw) > 0 {
		if e = json.Unmarshal(raw, &surfaces); e != nil {
			return p, fmt.Errorf("ongeldige oppervlakteverwijzingen")
		}
	}
	if len(surfaces) > 25 {
		return p, fmt.Errorf("meer dan 25 oppervlakten bij één eenheid")
	}
	today := time.Now().UTC().Format("2006-01-02")
	active := []propertyArea{}
	for _, ref := range surfaces {
		surface, err := c.reference(ctx, ref, "oppervlakten")
		if err != nil {
			return p, err
		}
		var value *float64
		if err = json.Unmarshal(surface["waarde"], &value); err != nil || value == nil {
			return p, fmt.Errorf("VERA-oppervlakte mist een geldige waarde")
		}
		kind, code := veraLabel(surface["soort"])
		if kind == "" {
			return p, fmt.Errorf("VERA-oppervlakte mist een meetsoort")
		}
		area := propertyArea{Value: *value, Kind: kind, KindCode: code, Unit: "m²", StartDate: veraText(surface["begindatum"]), EndDate: veraText(surface["einddatum"])}
		for _, date := range []string{area.StartDate, area.EndDate} {
			if date != "" {
				if _, err = time.Parse("2006-01-02", date); err != nil {
					return p, fmt.Errorf("VERA-oppervlakte heeft een ongeldige datum")
				}
			}
		}
		if area.Value < 0 || area.Value > 1e9 {
			return p, fmt.Errorf("ongeldige VERA-oppervlakte")
		}
		p.Areas = append(p.Areas, area)
		if (area.StartDate == "" || area.StartDate <= today) && (area.EndDate == "" || area.EndDate > today) {
			active = append(active, area)
		}
	}
	if len(active) == 1 {
		p.Area = &active[0].Value
		p.AreaType = active[0].Kind
		p.AreaTypeCode = active[0].KindCode
		p.AreaUnit = "m²"
	}
	// Only fall back when the authoritative multi-measurement association is absent.
	if len(surfaces) == 0 {
		if raw := unit["gebruiksoppervlakte"]; len(raw) > 0 && string(raw) != "null" {
			if e = json.Unmarshal(raw, &p.Area); e != nil {
				return p, fmt.Errorf("ongeldige gebruiksoppervlakte")
			}
			p.AreaType = "Gebruiksoppervlakte (verouderd VERA-veld)"
			p.AreaTypeCode = "GO"
			p.AreaUnit = "m²"
		} else if raw := bag["bagOppervlakteVerblijfsobject"]; len(raw) > 0 && string(raw) != "null" {
			if e = json.Unmarshal(raw, &p.Area); e != nil {
				return p, fmt.Errorf("ongeldige BAG-oppervlakte")
			}
			p.AreaType = "BAG gebruiksoppervlakte verblijfsobject"
			p.AreaTypeCode = "BAG"
			p.AreaUnit = "m²"
		}
	}
	var clusters []json.RawMessage
	if len(unit["clusters"]) > 0 {
		if e = json.Unmarshal(unit["clusters"], &clusters); e != nil {
			return p, fmt.Errorf("ongeldige clusterverwijzingen")
		}
	}
	if len(clusters) > 25 {
		return p, fmt.Errorf("meer dan 25 clusters bij één eenheid")
	}
	for _, ref := range clusters {
		cluster, err := c.reference(ctx, ref, "clusters")
		if err != nil {
			return p, err
		}
		kind, code := veraLabel(cluster["soort"])
		p.Clusters = append(p.Clusters, propertyCluster{ID: veraText(cluster["id"]), Code: veraText(cluster["code"]), Name: veraText(cluster["naam"]), Kind: kind, KindCode: code})
	}
	e = normalizeCatalogRow(&p)
	return p, e
}
func (c *veraClient) page(ctx context.Context, cursor string) ([]catalogRow, string, error) {
	endpoint := c.source.BaseURL + "/eenheden"
	query := url.Values{}
	if strings.HasPrefix(cursor, "c:") {
		query.Set("cursor", strings.TrimPrefix(cursor, "c:"))
	} else if strings.HasPrefix(cursor, "p:") {
		query.Set("pagina", strings.TrimPrefix(cursor, "p:"))
	}
	if len(query) > 0 {
		endpoint += "?" + query.Encode()
	}
	var units []veraObject
	headers, e := c.get(ctx, endpoint, &units)
	if e != nil {
		return nil, "", e
	}
	if len(units) > 100 {
		return nil, "", fmt.Errorf("VERA-pagina bevat meer dan 100 eenheden")
	}
	rows := []catalogRow{}
	seen := map[string]bool{}
	for _, unit := range units {
		p, err := c.mapUnit(ctx, unit)
		if err != nil {
			return nil, "", err
		}
		if seen[p.SourceObjectID] {
			return nil, "", fmt.Errorf("dubbele eenheid-ID op VERA-pagina")
		}
		seen[p.SourceObjectID] = true
		rows = append(rows, p)
	}
	next := ""
	if v := strings.TrimSpace(headers.Get("X-Parameters-Cursor")); v != "" {
		if len(v) > 4000 {
			return nil, "", fmt.Errorf("VERA-cursor is te lang")
		}
		next = "c:" + v
	} else if len(units) > 0 {
		page := 1
		if strings.HasPrefix(cursor, "p:") {
			page, _ = strconv.Atoi(strings.TrimPrefix(cursor, "p:"))
		}
		size := 25
		if n, e := strconv.Atoi(headers.Get("X-Parameters-AantalPerPagina")); e == nil && n > 0 {
			size = n
		}
		total, err := strconv.Atoi(headers.Get("X-Parameters-Aantal"))
		if (err == nil && page*size < total) || (err != nil && len(units) >= size) {
			next = "p:" + strconv.Itoa(page+1)
		}
	}
	if len(rows) == 0 && next != "" {
		return nil, "", fmt.Errorf("VERA gaf een lege pagina met een vervolgcaptor")
	}
	return rows, next, nil
}
func (a *app) testPropertySource(w http.ResponseWriter, r *http.Request) error {
	if _, e := a.admin(r); e != nil {
		return e
	}
	org := r.PathValue("org")
	s, e := readPropertySource(r.Context(), a.db, org, r.PathValue("source"))
	if e != nil {
		return e
	}
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	c, e := a.newVeraClient(ctx, org, s)
	if e != nil {
		return fail(422, e.Error())
	}
	rows, _, e := c.page(ctx, "")
	if e != nil {
		return fail(422, e.Error())
	}
	send(w, 200, map[string]any{"ok": true, "sampleCount": len(rows)})
	return nil
}
