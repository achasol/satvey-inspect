package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/mail"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"satvey/inspect/internal/maildelivery"
)

func (a *app) frozenReportPDF(ctx context.Context, org string, doc pdfDocument) ([]byte, error) {
	if !doc.Final || !validID(doc.ID) {
		return nil, fail(422, "Een definitief rapport is vereist")
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "report-pdf:"+doc.ID); err != nil {
		return nil, err
	}
	var inspection string
	if err = tx.QueryRow(ctx, `SELECT i.id FROM reports r JOIN inspections i ON i.id=r.inspection_id AND i.org_id=r.org_id WHERE r.id=$1 AND r.org_id=$2 FOR SHARE OF i`, doc.ID, org).Scan(&inspection); err != nil {
		return nil, err
	}
	key := org + "/reports/" + doc.ID + ".pdf"
	if _, err = tx.Exec(ctx, `INSERT INTO report_artifacts(report_id,org_id,inspection_id,object_key) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, doc.ID, org, inspection, key); err != nil {
		return nil, err
	}
	var status, digest string
	var size int64
	if err = tx.QueryRow(ctx, `SELECT object_key,status,sha256,size FROM report_artifacts WHERE report_id=$1 AND org_id=$2`, doc.ID, org).Scan(&key, &status, &digest, &size); err != nil {
		return nil, err
	}
	var pdf []byte
	if status == "ready" {
		object, e := a.storage.GetObject(ctx, &s3.GetObjectInput{Bucket: &a.bucket, Key: &key})
		if e != nil {
			return nil, fail(503, "Het vastgelegde PDF-bestand is tijdelijk niet beschikbaar")
		}
		defer object.Body.Close()
		pdf, err = io.ReadAll(io.LimitReader(object.Body, 160<<20))
		if err != nil {
			return nil, err
		}
		sum := sha256.Sum256(pdf)
		if int64(len(pdf)) != size || hex.EncodeToString(sum[:]) != digest {
			return nil, fail(503, "Integriteitscontrole van het PDF-bestand mislukt")
		}
	} else {
		pdf, err = a.renderReportPDF(ctx, org, doc)
		if err != nil {
			return nil, err
		}
		sum := sha256.Sum256(pdf)
		if _, err = a.storage.PutObject(ctx, &s3.PutObjectInput{Bucket: &a.bucket, Key: &key, Body: bytes.NewReader(pdf), ContentType: aws.String("application/pdf")}); err != nil {
			return nil, err
		}
		if _, err = tx.Exec(ctx, `UPDATE report_artifacts SET status='ready',sha256=$2,size=$3,last_error='' WHERE report_id=$1`, doc.ID, hex.EncodeToString(sum[:]), len(pdf)); err != nil {
			return nil, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return pdf, nil
}

func (a *app) reportArtifactWorker(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			var raw []byte
			var org, report string
			err := a.db.QueryRow(ctx, `SELECT r.snapshot,r.org_id,r.id FROM report_artifacts f JOIN reports r ON r.id=f.report_id WHERE f.status<>'ready' AND f.next_attempt_at<=now() AND ($1::uuid IS NULL OR r.org_id=$1) ORDER BY f.next_attempt_at LIMIT 1`, nullableID(a.workerOrg)).Scan(&raw, &org, &report)
			if err != nil {
				continue
			}
			var doc pdfDocument
			err = json.Unmarshal(raw, &doc)
			if err == nil {
				err = preparePDFDocument(&doc)
			}
			if err == nil {
				_, err = a.frozenReportPDF(ctx, org, doc)
			}
			if err != nil {
				_, _ = a.db.Exec(ctx, `UPDATE report_artifacts SET status='failed',attempts=attempts+1,last_error='PDF kon niet worden gemaakt',next_attempt_at=now()+interval '5 minutes' WHERE report_id=$1 AND status<>'ready'`, report)
			}
		}
	}
}

func (a *app) reportDeliveryHistory(w http.ResponseWriter, r *http.Request) error {
	if _, _, err := a.access(r, false); err != nil {
		return err
	}
	out, err := list(r.Context(), a.db, `SELECT d.id,d.report_id AS "reportId",d.recipient,d.created_at AS "createdAt",CASE WHEN m.status='done' THEN 'accepted' WHEN m.last_error LIKE 'Verzending onzeker%' THEN 'uncertain' ELSE m.status END AS status,m.last_error AS error FROM report_deliveries d JOIN mail_jobs m ON m.id=d.mail_job_id WHERE d.org_id=$1 AND d.inspection_id=$2 ORDER BY d.created_at DESC LIMIT 100`, r.PathValue("org"), r.PathValue("inspection"))
	if err != nil {
		return err
	}
	send(w, 200, out)
	return nil
}

func (a *app) emailReport(w http.ResponseWriter, r *http.Request) error {
	u, _, err := a.access(r, true)
	if err != nil {
		return err
	}
	var in struct {
		ID        string `json:"id"`
		Recipient string `json:"recipient"`
		ReportID  string `json:"reportId"`
	}
	if err = readJSON(w, r, &in); err != nil {
		return err
	}
	recipient, err := mail.ParseAddress(in.Recipient)
	if err != nil || recipient.Address != strings.TrimSpace(in.Recipient) || strings.ContainsAny(in.Recipient, "\r\n") || !validID(in.ID) || !validID(in.ReportID) {
		return fail(422, "Controleer het e-mailadres en rapport")
	}
	if os.Getenv("SMTP_ADDR") == "" && a.deliver == nil {
		return fail(503, "Rapportmail is niet geconfigureerd; gebruik de vastgelegde handmatige verzending")
	}
	doc, err := a.pdfSource(r)
	if err != nil {
		return err
	}
	if !doc.Final || doc.ID != in.ReportID {
		return fail(409, "Kies het actuele definitieve rapport")
	}
	pdf, err := a.frozenReportPDF(r.Context(), r.PathValue("org"), doc)
	if err != nil {
		return err
	}
	maxMB, _ := strconv.Atoi(env("REPORT_ATTACHMENT_MAX_MB", "10"))
	if maxMB < 1 || maxMB > 25 {
		maxMB = 10
	}
	if len(pdf) > maxMB<<20 {
		return fail(413, fmt.Sprintf("De PDF is groter dan %d MiB. Download en registreer een andere verzendwijze.", maxMB))
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	org, iid := r.PathValue("org"), r.PathValue("inspection")
	var locked string
	if err = tx.QueryRow(r.Context(), `SELECT id FROM inspections WHERE id=$1 AND org_id=$2 AND archived_at IS NULL FOR UPDATE`, iid, org).Scan(&locked); err != nil {
		return err
	}
	var existing bool
	if err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM report_deliveries WHERE id=$1 AND org_id=$2 AND inspection_id=$3 AND report_id=$4 AND recipient=$5)`, in.ID, org, iid, in.ReportID, recipient.Address).Scan(&existing); err != nil {
		return err
	}
	if existing {
		send(w, 202, map[string]string{"id": in.ID})
		return nil
	}
	var used bool
	if err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM report_deliveries WHERE id=$1)`, in.ID).Scan(&used); err != nil {
		return err
	}
	if used {
		return fail(409, "Deze verzendaanvraag bestaat met andere gegevens; controleer de verzendhistorie")
	}
	message := maildelivery.Message{ID: in.ID, To: recipient.Address, Subject: "Inspectierapport · " + doc.Inspection.Address, Text: "Bijgevoegd vindt u het definitieve inspectierapport. Neem bij vragen contact op met uw woningcorporatie.", Attachments: []maildelivery.Attachment{{Name: "inspectierapport.pdf", MIME: "application/pdf", Data: pdf}}}
	if _, err = a.queueMail(r.Context(), tx, org, "", u.ID, "inspection_report", message); err != nil {
		return err
	}
	if _, err = tx.Exec(r.Context(), `INSERT INTO report_deliveries(id,org_id,inspection_id,report_id,recipient,mail_job_id,created_by) VALUES($1,$2,$3,$4,$5,$1,$6)`, in.ID, org, iid, in.ReportID, recipient.Address, u.ID); err != nil {
		return err
	}
	if err = recordEvent(r.Context(), tx, org, iid, u.ID, "report_email_queued", map[string]string{"reportId": doc.ID, "deliveryId": in.ID}); err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	send(w, 202, map[string]string{"id": in.ID})
	return nil
}
