package app

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/s3"
)

func (a *app) exportOrganisation(w http.ResponseWriter, r *http.Request, org string) error {
	limit := 10
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, e := strconv.Atoi(raw)
		if e != nil || n < 1 || n > 25 {
			return fail(400, "Kies 1 tot 25 dossiers per exportdeel")
		}
		limit = n
	}
	after := r.URL.Query().Get("after")
	if after != "" && !validID(after) {
		return fail(400, "Ongeldige exportcursor")
	}
	cutoff := time.Now().UTC()
	if raw := r.URL.Query().Get("before"); raw != "" {
		var err error
		cutoff, err = time.Parse(time.RFC3339Nano, raw)
		if err != nil || cutoff.After(time.Now().Add(time.Minute)) {
			return fail(400, "Ongeldige exportdatum")
		}
	}
	raw, err := list(r.Context(), a.db, `SELECT id FROM inspections WHERE org_id=$1 AND ($2='' OR id::text>$2) AND created_at<=$3 ORDER BY id LIMIT $4`, org, after, cutoff, limit+1)
	if err != nil {
		return err
	}
	var records []struct{ ID string }
	if err = json.Unmarshal(raw, &records); err != nil {
		return err
	}
	more := len(records) > limit
	if more {
		records = records[:limit]
	}
	file, err := os.CreateTemp("", "satvey-exit-*.zip")
	if err != nil {
		return err
	}
	defer file.Close()
	defer os.Remove(file.Name())
	z := zip.NewWriter(file)
	defer z.Close()
	var bytes int64
	add := func(name string, value any) error {
		part, e := z.Create(name)
		if e != nil {
			return e
		}
		return json.NewEncoder(part).Encode(value)
	}
	addObject := func(name, key string) error {
		object, e := a.storage.GetObject(r.Context(), &s3.GetObjectInput{Bucket: &a.bucket, Key: &key})
		if e != nil {
			return fail(503, "Een bronbestand is tijdelijk niet beschikbaar; het exportdeel is niet voltooid")
		}
		defer object.Body.Close()
		part, e := z.Create(name)
		if e != nil {
			return e
		}
		n, e := io.Copy(part, io.LimitReader(object.Body, (2<<30)-bytes+1))
		bytes += n
		if bytes > 2<<30 {
			return fail(413, "Dit exportdeel is groter dan 2 GiB. Kies minder dossiers per deel.")
		}
		return e
	}
	for _, table := range []string{"format_versions", "norm_versions", "room_elements", "mutation_cases", "properties", "inspection_formats", "norm_frameworks", "organisation_roles", "norm_assets", "retention_policies", "internal_sync_profiles"} {
		data, e := list(r.Context(), a.db, `SELECT * FROM `+table+` WHERE org_id=$1`, org)
		if e != nil {
			return e
		}
		if e = add("configuration/"+table+".json", json.RawMessage(data)); e != nil {
			return e
		}
	}
	for name, query := range map[string]string{
		"organisation":               `SELECT id,slug,name,report_name,logo_asset_id,brand_tint,offline_hours FROM organisations WHERE id=$1`,
		"members":                    `SELECT m.user_id,m.role_id,u.name,u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.org_id=$1`,
		"property_sources":           `SELECT id,name,administration,kind,base_url,enabled,revision,last_synced_at FROM property_sources WHERE org_id=$1`,
		"handover_property_mappings": `SELECT * FROM handover_property_mappings WHERE org_id=$1`,
	} {
		data, e := list(r.Context(), a.db, query, org)
		if e != nil {
			return e
		}
		if e = add("configuration/"+name+".json", json.RawMessage(data)); e != nil {
			return e
		}
	}

	assets, e := a.db.Query(r.Context(), `SELECT id,object_key FROM norm_assets WHERE org_id=$1`, org)
	if e != nil {
		return e
	}
	type asset struct{ ID, Key string }
	assetList := []asset{}
	for assets.Next() {
		var value asset
		if e = assets.Scan(&value.ID, &value.Key); e != nil {
			assets.Close()
			return e
		}
		assetList = append(assetList, value)
	}
	assets.Close()
	for _, asset := range assetList {
		if err = addObject("configuration/assets/"+asset.ID, asset.Key); err != nil {
			return err
		}
	}
	for _, record := range records {
		dossier, e := detail(r.Context(), a.db, org, record.ID)
		if e != nil {
			return e
		}
		prefix := "inspections/" + record.ID + "/"
		for _, table := range []string{"inspection_activity", "internal_sync_jobs"} {
			rows, err := list(r.Context(), a.db, `SELECT * FROM `+table+` WHERE org_id=$1 AND inspection_id=$2`, org, record.ID)
			if err != nil {
				return err
			}
			if err = add(prefix+table+".json", json.RawMessage(rows)); err != nil {
				return err
			}
		}

		if e = add(prefix+"dossier.json", dossier); e != nil {
			return e
		}
		snapshot, e := list(r.Context(), a.db, `SELECT snapshot FROM reports WHERE org_id=$1 AND inspection_id=$2`, org, record.ID)
		if e != nil {
			return e
		}
		if e = add(prefix+"reports.json", json.RawMessage(snapshot)); e != nil {
			return e
		}
		history, e := list(r.Context(), a.db, `SELECT id,actor_id,action,detail,created_at FROM inspection_events WHERE org_id=$1 AND inspection_id=$2 ORDER BY id`, org, record.ID)
		if e != nil {
			return e
		}
		if e = add(prefix+"history.json", json.RawMessage(history)); e != nil {
			return e
		}
		handovers, e := list(r.Context(), a.db, `SELECT id,draft_version,status,snapshot,report_snapshot,accepted_at FROM handover_deliveries WHERE org_id=$1 AND inspection_id=$2`, org, record.ID)
		if e != nil {
			return e
		}
		if e = add(prefix+"handovers.json", json.RawMessage(handovers)); e != nil {
			return e
		}
		for name, query := range map[string]string{
			"manual_handovers":  `SELECT * FROM manual_handovers WHERE org_id=$1 AND inspection_id=$2`,
			"measurements":      `SELECT * FROM inspection_measurements WHERE org_id=$1 AND inspection_id=$2`,
			"email_history":     `SELECT d.id,d.report_id,d.recipient,d.created_at,m.status,m.last_error FROM report_deliveries d JOIN mail_jobs m ON m.id=d.mail_job_id WHERE d.org_id=$1 AND d.inspection_id=$2`,
			"report_artifacts":  `SELECT report_id,status,sha256,size FROM report_artifacts WHERE org_id=$1 AND inspection_id=$2`,
			"handover_receipts": `SELECT it.* FROM handover_delivery_items it JOIN handover_deliveries d ON d.id=it.delivery_id AND d.org_id=it.org_id WHERE d.org_id=$1 AND d.inspection_id=$2`,
		} {
			data, e := list(r.Context(), a.db, query, org, record.ID)
			if e != nil {
				return e
			}
			if e = add(prefix+name+".json", json.RawMessage(data)); e != nil {
				return e
			}
		}
		// A completed export must include the exact final PDF, even for old reports
		// that predate durable PDF artifacts. Fail the part if it cannot be prepared.
		reportRows, e := list(r.Context(), a.db, `SELECT snapshot FROM reports WHERE org_id=$1 AND inspection_id=$2`, org, record.ID)
		if e != nil {
			return e
		}
		var frozen []struct{ Snapshot json.RawMessage }
		if e = json.Unmarshal(reportRows, &frozen); e != nil {
			return e
		}
		for _, record := range frozen {
			var doc pdfDocument
			if e = json.Unmarshal(record.Snapshot, &doc); e != nil {
				return e
			}
			if e = preparePDFDocument(&doc); e != nil {
				return e
			}
			pdf, e := a.frozenReportPDF(r.Context(), org, doc)
			if e != nil {
				return e
			}
			part, e := z.Create(prefix + "reports/" + doc.ID + ".pdf")
			if e != nil {
				return e
			}
			if _, e = part.Write(pdf); e != nil {
				return e
			}
			bytes += int64(len(pdf))
			if bytes > 2<<30 {
				return fail(413, "Kies minder dossiers per exportdeel")
			}
		}

		media, e := a.db.Query(r.Context(), `SELECT id::text,object_key FROM media WHERE org_id=$1 AND inspection_id=$2 AND content_deleted_at IS NULL`, org, record.ID)
		if e != nil {
			return e
		}
		objects := []asset{}
		for media.Next() {
			var value asset
			if e = media.Scan(&value.ID, &value.Key); e != nil {
				media.Close()
				return e
			}
			objects = append(objects, value)
		}
		media.Close()
		for _, object := range objects {
			if e = addObject(prefix+"evidence/"+object.ID, object.Key); e != nil {
				return e
			}
		}
	}
	last := after
	if len(records) > 0 {
		last = records[len(records)-1].ID
	}
	if err = add("manifest.json", map[string]any{"organisationId": org, "before": cutoff.Format(time.RFC3339Nano), "after": after, "lastInspectionId": last, "hasMore": more, "inspectionCount": len(records), "format": "satvey-exit-v1", "consistency": "Pause organisation writes for a consistent multi-part exit. Each part contains current drafts and immutable finalized reports. Continue with the same before value and lastInspectionId as after until hasMore is false. Credentials are excluded."}); err != nil {
		return err
	}
	if err = z.Close(); err != nil {
		return err
	}
	if _, err = file.Seek(0, 0); err != nil {
		return err
	}
	info, err := file.Stat()
	if err != nil {
		return err
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="satvey-exit.zip"`)
	w.Header().Set("Content-Length", fmt.Sprint(info.Size()))
	_, err = io.Copy(w, file)
	return err
}
