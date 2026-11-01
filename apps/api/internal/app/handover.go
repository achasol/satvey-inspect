package app

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"time"

	"satvey/inspect/internal/handover"

	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5"
)

// Locking the inspection also serializes handover edits with dossier deletion.
func (a *app) handoverReport(ctx context.Context, tx pgx.Tx, org, inspection string, lock bool) (handover.Report, []byte, error) {
	if !validID(inspection) {
		return handover.Report{}, nil, fail(404, "Inspectie niet gevonden")
	}
	query := "SELECT id FROM inspections WHERE id=$1 AND org_id=$2"
	if lock {
		query = "SELECT id FROM inspections WHERE id=$1 AND org_id=$2 AND archived_at IS NULL FOR UPDATE"
	}
	var found string
	if err := tx.QueryRow(ctx, query, inspection, org).Scan(&found); err != nil {
		return handover.Report{}, nil, err
	}
	var raw []byte
	if err := tx.QueryRow(ctx, "SELECT snapshot FROM reports WHERE inspection_id=$1 AND org_id=$2 ORDER BY number DESC LIMIT 1", inspection, org).Scan(&raw); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return handover.Report{}, nil, fail(422, "Leg eerst het rapport vast voordat je onderhoud overdraagt")
		}
		return handover.Report{}, nil, err
	}
	var snapshot map[string]json.RawMessage
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		return handover.Report{}, nil, err
	}
	if err := fillReportMetadata(ctx, tx, org, inspection, snapshot); err != nil {
		return handover.Report{}, nil, err
	}
	raw, err := json.Marshal(snapshot)
	if err != nil {
		return handover.Report{}, nil, err
	}
	report, err := handover.ReadReport(raw)
	return report, raw, err
}

func readHandoverDraft(ctx context.Context, q querier, org, inspection string) (handover.Draft, error) {
	draft := handover.Draft{Proposals: []handover.Proposal{}}
	var raw []byte
	err := q.QueryRow(ctx, "SELECT content FROM handover_drafts WHERE inspection_id=$1 AND org_id=$2", inspection, org).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return draft, nil
	}
	if err == nil {
		err = json.Unmarshal(raw, &draft)
	}
	return draft, err
}

func (a *app) handoverDetail(w http.ResponseWriter, r *http.Request) error {
	if _, _, err := a.access(r, false); err != nil {
		return err
	}
	tx, err := a.db.BeginTx(r.Context(), pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	org, inspection := r.PathValue("org"), r.PathValue("inspection")
	report, _, err := a.handoverReport(r.Context(), tx, org, inspection, false)
	if err != nil {
		return err
	}
	draft, err := readHandoverDraft(r.Context(), tx, org, inspection)
	if err != nil {
		return err
	}
	exports, err := list(r.Context(), tx, `SELECT id,draft_version AS "draftVersion",snapshot->>'destination' AS destination,created_at AS "createdAt",last_download_at AS "lastDownloadAt",jsonb_array_length(snapshot->'proposals') AS "proposalCount" FROM handover_exports WHERE org_id=$1 AND inspection_id=$2 ORDER BY created_at DESC,id LIMIT 100`, org, inspection)
	if err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	choices, err := a.handoverChoices(r.Context(), a.db, org, report.Property)
	if err != nil {
		return err
	}
	deliveries, err := a.handoverDeliveryList(r.Context(), a.db, org, inspection)
	if err != nil {
		return err
	}
	send(w, 200, map[string]any{"report": report, "draft": draft, "exports": exports, "destinations": choices, "deliveries": deliveries})
	return nil
}

func (a *app) saveHandoverDraft(w http.ResponseWriter, r *http.Request) error {
	u, _, err := a.access(r, true)
	if err != nil {
		return err
	}
	var in handover.Draft
	if err = readJSON(w, r, &in); err != nil {
		return err
	}
	for _, p := range in.Proposals {
		if !validID(p.ID) {
			return fail(422, "Ongeldige onderhoudsvoorstel-ID")
		}
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	org, inspection := r.PathValue("org"), r.PathValue("inspection")
	report, _, err := a.handoverReport(r.Context(), tx, org, inspection, true)
	if err != nil {
		return err
	}
	if err = handover.ValidateDraft(&in, report); err != nil {
		return err
	}
	if in.DestinationID != "" {
		if _, err = readHandoverDestination(r.Context(), tx, org, in.DestinationID); err != nil {
			return err
		}
	}
	if err = immutableHandoverProposals(r.Context(), tx, org, inspection, in.Proposals); err != nil {
		return err
	}
	old, err := readHandoverDraft(r.Context(), tx, org, inspection)
	if err != nil {
		return err
	}
	if old.Version != in.Version {
		return fail(409, "De onderhoudsvoorstellen zijn gewijzigd. Je invoer blijft staan; herlaad om te vergelijken.")
	}
	in.Version++
	raw, err := json.Marshal(in)
	if err != nil {
		return err
	}
	_, err = tx.Exec(r.Context(), `INSERT INTO handover_drafts(inspection_id,org_id,version,content,updated_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(inspection_id) DO UPDATE SET version=EXCLUDED.version,content=EXCLUDED.content,updated_by=EXCLUDED.updated_by,updated_at=now()`, inspection, org, in.Version, raw, u.ID)
	if err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	send(w, 200, in)
	return nil
}

func (a *app) prepareHandover(w http.ResponseWriter, r *http.Request) error {
	u, _, err := a.access(r, true)
	if err != nil {
		return err
	}
	var in struct {
		ID      string `json:"id"`
		Version int    `json:"version"`
	}
	if err = readJSON(w, r, &in); err != nil {
		return err
	}
	if !validID(in.ID) || in.Version < 1 {
		return fail(422, "Bewaar eerst de onderhoudsvoorstellen")
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	org, inspection := r.PathValue("org"), r.PathValue("inspection")
	report, reportSnapshot, err := a.handoverReport(r.Context(), tx, org, inspection, true)
	if err != nil {
		return err
	}
	// Both a lost response and two devices preparing the same revision converge.
	var existing string
	var revision int
	err = tx.QueryRow(r.Context(), `SELECT id,draft_version FROM handover_exports WHERE org_id=$1 AND inspection_id=$2 AND (id=$3 OR (report_id=$4 AND draft_version=$5)) ORDER BY (id=$3) DESC LIMIT 1`, org, inspection, in.ID, report.ID, in.Version).Scan(&existing, &revision)
	if err == nil {
		if revision != in.Version {
			return fail(409, "Deze overdracht-ID hoort bij een andere versie")
		}
		send(w, 200, map[string]string{"id": existing})
		return nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	draft, err := readHandoverDraft(r.Context(), tx, org, inspection)
	if err != nil {
		return err
	}
	if draft.Version != in.Version {
		return fail(409, "De onderhoudsvoorstellen zijn gewijzigd. Herlaad voor het vastleggen.")
	}
	if err = handover.ValidateDraft(&draft, report); err != nil {
		return err
	}
	if draft.Destination == "" {
		return fail(422, "Vul de ontvangende organisatie of het ontvangende systeem in")
	}
	if draft.VERA != nil {
		if err = handover.ValidateVERA(*draft.VERA); err != nil {
			return err
		}
	}
	bundle := handover.Bundle{SchemaVersion: handover.SchemaVersion, ID: in.ID, CreatedAt: time.Now().UTC(), DraftVersion: draft.Version, Destination: draft.Destination, ExternalReference: draft.ExternalReference, Report: report, Proposals: draft.Proposals, Attachments: []handover.Attachment{{Path: "report.pdf", MIME: "application/pdf"}}, VERA: draft.VERA}
	for _, photo := range report.Photos {
		bundle.Attachments = append(bundle.Attachments, handover.Attachment{Path: "photos/" + photo.ID + ".jpg", MIME: "image/jpeg", MediaID: photo.ID})
		if len(photo.Annotations) > 0 {
			bundle.Attachments = append(bundle.Attachments, handover.Attachment{Path: "photos/" + photo.ID + "-annotated.svg", MIME: "image/svg+xml", MediaID: photo.ID})
		}
	}
	raw, err := json.Marshal(bundle)
	if err != nil {
		return err
	}
	tag, err := tx.Exec(r.Context(), `INSERT INTO handover_exports(id,org_id,inspection_id,report_id,draft_version,snapshot,report_snapshot,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING`, bundle.ID, org, inspection, report.ID, draft.Version, raw, reportSnapshot, u.ID, bundle.CreatedAt)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return fail(409, "Deze overdracht-ID is al in gebruik")
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	send(w, 201, map[string]string{"id": bundle.ID})
	return nil
}

func (a *app) exportHandover(w http.ResponseWriter, r *http.Request) error {
	if _, _, err := a.access(r, false); err != nil {
		return err
	}
	if !validID(r.PathValue("handover")) || !validID(r.PathValue("inspection")) {
		return fail(404, "Overdracht niet gevonden")
	}
	format := r.URL.Query().Get("format")
	if format == "" {
		format = "zip"
	}
	if format != "json" && format != "csv" && format != "zip" {
		return fail(400, "Kies ZIP, JSON of CSV")
	}
	ctx, cancel := context.WithTimeout(r.Context(), 180*time.Second)
	defer cancel()
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	org, inspection := r.PathValue("org"), r.PathValue("inspection")
	var locked string
	if err = tx.QueryRow(ctx, "SELECT id FROM inspections WHERE id=$1 AND org_id=$2 FOR SHARE", inspection, org).Scan(&locked); err != nil {
		return err
	}
	var raw, reportSnapshot []byte
	if err = tx.QueryRow(ctx, `SELECT snapshot,report_snapshot FROM handover_exports WHERE id=$1 AND org_id=$2 AND inspection_id=$3`, r.PathValue("handover"), org, inspection).Scan(&raw, &reportSnapshot); err != nil {
		return err
	}
	var bundle handover.Bundle
	if err = json.Unmarshal(raw, &bundle); err != nil {
		return err
	}
	var content io.ReadSeeker
	var closeFile func()
	var size int64
	contentType := "application/json"
	if format == "zip" {
		file, err := a.handoverArchive(ctx, org, reportSnapshot, bundle)
		if err != nil {
			return err
		}
		closeFile = func() { file.Close(); os.Remove(file.Name()) }
		defer closeFile()
		stat, err := file.Stat()
		if err != nil {
			return err
		}
		size = stat.Size()
		content = file
		contentType = "application/zip"
	} else {
		var data []byte
		if format == "csv" {
			var b bytes.Buffer
			if err = handover.WriteCSV(&b, bundle); err != nil {
				return err
			}
			data = b.Bytes()
			contentType = "text/csv; charset=utf-8"
		} else {
			data, err = json.MarshalIndent(bundle, "", "  ")
			if err != nil {
				return err
			}
		}
		size = int64(len(data))
		content = bytes.NewReader(data)
	}
	if _, err = tx.Exec(ctx, "UPDATE handover_exports SET last_download_at=now() WHERE id=$1 AND org_id=$2", bundle.ID, org); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": "satvey-overdracht-" + bundle.ID + "." + format}))
	w.Header().Set("Content-Length", fmt.Sprint(size))
	_, _ = io.Copy(w, content)
	return nil
}

func (a *app) handoverArchive(ctx context.Context, org string, snapshot []byte, bundle handover.Bundle) (*os.File, error) {
	file, err := os.CreateTemp("", "satvey-handover-*.zip")
	if err != nil {
		return nil, err
	}
	success := false
	defer func() {
		if !success {
			file.Close()
			os.Remove(file.Name())
		}
	}()
	z := zip.NewWriter(file)
	var total int
	add := func(name, mimeType, mediaID string, data []byte) error {
		total += len(data)
		if total > 160<<20 {
			return fail(413, "Het overdrachtspakket bevat meer dan 160 MB. Download JSON en CSV afzonderlijk.")
		}
		header := &zip.FileHeader{Name: name, Method: zip.Deflate}
		header.SetModTime(bundle.CreatedAt)
		part, err := z.CreateHeader(header)
		if err != nil {
			return err
		}
		if _, err = part.Write(data); err != nil {
			return err
		}
		if mimeType != "" {
			sum := sha256.Sum256(data)
			for i := range bundle.Attachments {
				if bundle.Attachments[i].Path == name {
					bundle.Attachments[i].SHA256 = hex.EncodeToString(sum[:])
					bundle.Attachments[i].Bytes = len(data)
				}
			}
		}
		return nil
	}
	var doc pdfDocument
	if err = json.Unmarshal(snapshot, &doc); err != nil {
		return nil, err
	}
	if doc.ID != bundle.Report.ID {
		return nil, fail(409, "Het rapport hoort niet bij deze overdracht")
	}
	if err = preparePDFDocument(&doc); err != nil {
		return nil, err
	}
	doc.GeneratedAt = reportDate(bundle.CreatedAt)
	pdf, err := a.frozenReportPDF(ctx, org, doc)
	if err != nil {
		return nil, err
	}
	if err = add("report.pdf", "application/pdf", "", pdf); err != nil {
		return nil, err
	}
	for _, photo := range bundle.Report.Photos {
		if !validID(photo.ID) {
			return nil, fail(422, "Ongeldige rapportfoto")
		}
		var key string
		if err = a.db.QueryRow(ctx, `SELECT object_key FROM media WHERE id=$1 AND org_id=$2 AND inspection_id=$3 AND kind='photo'`, photo.ID, org, bundle.Report.InspectionID).Scan(&key); err != nil {
			return nil, fail(503, "Een rapportfoto is niet beschikbaar")
		}
		object, err := a.storage.GetObject(ctx, &s3.GetObjectInput{Bucket: &a.bucket, Key: &key})
		if err != nil {
			return nil, fail(503, "Een rapportfoto is tijdelijk niet beschikbaar")
		}
		data, err := io.ReadAll(io.LimitReader(object.Body, (20<<20)+1))
		object.Body.Close()
		if err != nil || len(data) > 20<<20 {
			return nil, fail(503, "Een rapportfoto kon niet volledig worden gelezen")
		}
		data, err = reportPhotoJPEG(data)
		if err != nil {
			return nil, fail(422, "Een rapportfoto is onleesbaar")
		}
		if err = add("photos/"+photo.ID+".jpg", "image/jpeg", photo.ID, data); err != nil {
			return nil, err
		}
		if len(photo.Annotations) > 0 {
			marked, err := annotatedPhotoSVG(data, photo.Annotations)
			if err != nil {
				return nil, err
			}
			if err = add("photos/"+photo.ID+"-annotated.svg", "image/svg+xml", photo.ID, marked); err != nil {
				return nil, err
			}
		}
	}
	manifest, err := json.MarshalIndent(bundle, "", "  ")
	if err != nil {
		return nil, err
	}
	if err = add("handover.json", "", "", manifest); err != nil {
		return nil, err
	}
	var csv bytes.Buffer
	if err = handover.WriteCSV(&csv, bundle); err != nil {
		return nil, err
	}
	if err = add("work-proposals.csv", "", "", csv.Bytes()); err != nil {
		return nil, err
	}
	if bundle.VERA != nil {
		files, err := handover.VERAFiles(bundle)
		if err != nil {
			return nil, err
		}
		for _, entry := range files {
			if err = add(entry.Path, "", "", entry.Data); err != nil {
				return nil, err
			}
		}
	}
	readme := "Satvey overdracht\n\nDit pakket bevat een vastgesteld inspectierapport en afzonderlijk beoordeelde onderhoudsvoorstellen. Onderhoudsvoorstellen zijn geen gegunde onderhoudsorders. De ontvangende organisatie beoordeelt en autoriseert de uitvoering.\n\nEen download bevestigt geen ontvangst of acceptatie in een ander systeem.\n\nhandover.json: versie, vastgoedidentiteit, rapportbronnen, onderhoudsvoorstellen en SHA-256-bestandscontrole.\nwork-proposals.csv: onderhoudsvoorstellen voor handmatige verwerking.\nreport.pdf: het vastgestelde rapport, inclusief handtekeningen en fotomarkeringen.\nphotos/: georiënteerde foto's zonder EXIF-metadata en, waar aanwezig, afzonderlijke markeringen als zelfstandige SVG.\n\nVERA-bestanden, indien aanwezig, zijn importgegevens voor een afgestemde koppeling. Raadpleeg vera/README.txt voor het oplossen van verwijzingen en ontbrekende leverancierscodes. Het pakket verstuurt zelf geen API-verzoeken.\n"
	if err = add("README.txt", "", "", []byte(readme)); err != nil {
		return nil, err
	}
	if err = z.Close(); err != nil {
		return nil, err
	}
	if _, err = file.Seek(0, 0); err != nil {
		return nil, err
	}
	success = true
	return file, nil
}
