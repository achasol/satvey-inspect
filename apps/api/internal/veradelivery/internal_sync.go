package veradelivery

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
)

func (c *Client) ProbeResource(ctx context.Context, resource string) error {
	_, _, err := c.call(ctx, "GET", c.resourceURL(resource)+"?limit=1", nil, 200)
	return err
}
func (c *Client) Specification(ctx context.Context, endpoint string) (map[string]any, error) {
	raw, _, err := c.call(ctx, "GET", endpoint, nil, 200)
	if err != nil {
		return nil, err
	}
	var spec map[string]any
	err = json.Unmarshal(raw, &spec)
	return spec, err
}

// Only mapped fields owned by Satvey are updated. Receiver identities are
// reconciled before creating, including after a lost create acknowledgement.
func (c *Client) SynchronizeResource(ctx context.Context, resource string, row map[string]any) (string, error) {

	// Compare JSON values in their wire representation (for example int file
	// sizes become float64 after the receiver decodes JSON).
	wire, err := json.Marshal(row)
	if err != nil {
		return "", blocked("Ongeldige synchronisatiegegevens")
	}
	var canonical map[string]any
	if err = json.Unmarshal(wire, &canonical); err != nil {
		return "", err
	}
	row = canonical
	q := url.Values{}
	for _, key := range []string{"idExtern", "idOrganisatie", "idAdministratie"} {
		value, _ := row[key].(string)
		if value == "" {
			return "", blocked("Bronidentiteit ontbreekt")
		}
		q.Set(key, value)
	}
	raw, headers, err := c.call(ctx, "GET", c.resourceURL(resource)+"?"+q.Encode(), nil, 200)
	if err != nil {
		return "", err
	}
	var found []map[string]any
	if json.Unmarshal(raw, &found) != nil || len(found) > 1 || headers.Get("X-Parameters-Cursor") != "" {
		return "", blocked("Bronidentiteit is niet eenduidig")
	}
	if len(found) == 0 {
		saved, err := c.Ensure(ctx, resource, row)
		if err != nil {
			return "", err
		}
		return stringValue(saved, "id"), nil
	}
	receiver := stringValue(found[0], "id")
	if receiver == "" {
		return "", blocked("Ontvanger gaf geen record-id")
	}
	saved, err := c.Read(ctx, resource, receiver)
	if err != nil {
		return "", err
	}
	for key, values := range q {
		if stringValue(saved, key) != values[0] {
			return "", blocked("Ontvangen bronidentiteit wijkt af")
		}
	}
	identical := true
	for key, value := range row {
		if !same(saved[key], value) {
			identical = false
			break
		}
	}
	if identical {
		return receiver, nil
	}
	if _, _, err = c.call(ctx, "PATCH", c.resourceURL(resource)+"/"+url.PathEscape(receiver), row, 200); err != nil {
		return "", err
	}
	saved, err = c.Read(ctx, resource, receiver)
	if err != nil {
		return "", err
	}
	for key, value := range row {
		if !same(saved[key], value) {
			return "", blocked(fmt.Sprintf("Ontvanger bevestigt veld %s niet", key))
		}
	}
	return receiver, nil
}
func (c *Client) DeleteTestResource(ctx context.Context, resource, id, external string) error {
	saved, err := c.Read(ctx, resource, id)
	if err != nil {
		return err
	}
	if stringValue(saved, "idExtern") != external {
		return blocked("Alleen het zojuist gemaakte testrecord mag worden opgeruimd")
	}
	_, _, err = c.call(ctx, http.MethodDelete, c.resourceURL(resource)+"/"+url.PathEscape(id), nil, 204)
	return err
}
