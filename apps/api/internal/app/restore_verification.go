package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"

	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5"
)

// verifyRestore reads restored data without starting HTTP listeners or workers.
func (a *app) verifyRestore(ctx context.Context) error {
	if err := a.checkStoredSecrets(ctx); err != nil {
		return err
	}
	rows, e := a.db.Query(ctx, `SELECT object_key,size,sha256 FROM media ORDER BY created_at DESC LIMIT 100`)
	if e != nil {
		return e
	}
	type object struct {
		key    string
		digest string
		size   int64
	}
	var objects []object
	for rows.Next() {
		var o object
		if e = rows.Scan(&o.key, &o.size, &o.digest); e != nil {
			rows.Close()
			return e
		}
		objects = append(objects, o)
	}
	rows.Close()
	if e = rows.Err(); e != nil {
		return e
	}
	for _, o := range objects {
		response, e := a.storage.GetObject(ctx, &s3.GetObjectInput{Bucket: &a.bucket, Key: &o.key})
		if e != nil {
			return fmt.Errorf("restored evidence unavailable")
		}
		digest := sha256.New()
		n, e := io.Copy(digest, io.LimitReader(response.Body, o.size+1))
		response.Body.Close()
		if e != nil || n != o.size || hex.EncodeToString(digest.Sum(nil)) != o.digest {
			return fmt.Errorf("restored evidence content mismatch")
		}
	}
	var org, inspection string
	e = a.db.QueryRow(ctx, `SELECT org_id,inspection_id FROM reports ORDER BY created_at DESC LIMIT 1`).Scan(&org, &inspection)
	if e == pgx.ErrNoRows && os.Getenv("VERIFY_ALLOW_EMPTY") == "true" {
		slog.Info("empty installation restore verified")
		return nil
	}
	if e != nil {
		return fmt.Errorf("restore verification requires an existing final report")
	}
	r, _ := http.NewRequestWithContext(ctx, "GET", "http://api/internal-restore-verification", nil)
	r.SetPathValue("org", org)
	r.SetPathValue("inspection", inspection)
	doc, e := a.pdfSource(r)
	if e != nil {
		return e
	}
	pdf, e := a.renderReportPDF(ctx, org, doc)
	if e != nil {
		return e
	}
	if !strings.HasPrefix(string(pdf), "%PDF-") {
		return fmt.Errorf("restored report did not render as PDF")
	}
	slog.Info("restore verified", "sampled_objects", len(objects), "report_pdf_bytes", len(pdf))
	return nil
}
