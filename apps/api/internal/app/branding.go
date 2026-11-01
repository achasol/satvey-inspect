package app

import (
	"net/http"
	"regexp"
	"strings"
)

func (a *app) reportIdentity(w http.ResponseWriter, r *http.Request) error {
	if _, err := a.admin(r); err != nil {
		return err
	}
	org := r.PathValue("org")
	if r.Method == "GET" {
		var name, tint string
		var logo *string
		var version int
		if err := a.db.QueryRow(r.Context(), `SELECT report_name,logo_asset_id,settings_version,brand_tint FROM organisations WHERE id=$1`, org).Scan(&name, &logo, &version, &tint); err != nil {
			return err
		}
		send(w, 200, map[string]any{"name": name, "logoAssetId": logo, "version": version, "tint": tint})
		return nil
	}
	var in struct {
		Tint        string  `json:"tint"`
		Name        string  `json:"name"`
		LogoAssetID *string `json:"logoAssetId"`
		Version     int     `json:"version"`
	}
	if err := readJSON(w, r, &in); err != nil {
		return err
	}
	if len(in.Name) > 160 || in.Version < 1 || (in.Tint != "" && !regexp.MustCompile(`^#[0-9a-fA-F]{6}$`).MatchString(in.Tint)) {
		return fail(422, "Controleer de rapportidentiteit")
	}
	if in.LogoAssetID != nil {
		var ok bool
		if !validID(*in.LogoAssetID) {
			return fail(422, "Ongeldig logo")
		}
		if err := a.db.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM norm_assets WHERE id=$1 AND org_id=$2 AND kind='photo' AND size<=1048576)`, *in.LogoAssetID, org).Scan(&ok); err != nil {
			return err
		}
		if !ok {
			return fail(422, "Gebruik een afbeeldingslogo van maximaal 1 MiB uit deze organisatie")
		}
	}
	tag, err := a.db.Exec(r.Context(), `UPDATE organisations SET report_name=$2,logo_asset_id=$3,settings_version=settings_version+1,brand_tint=$5 WHERE id=$1 AND settings_version=$4`, org, strings.TrimSpace(in.Name), in.LogoAssetID, in.Version, in.Tint)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return fail(409, "Instellingen gewijzigd; herlaad")
	}
	send(w, 200, map[string]int{"version": in.Version + 1})
	return nil
}
