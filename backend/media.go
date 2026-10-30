package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"math"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5"
)

func (a *app) upload(w http.ResponseWriter, r *http.Request) error {
	if !validID(r.PathValue("batch")) || !validID(r.PathValue("media")) {
		return fail(400, "Ongeldige media-ID")
	}
	if _, _, e := a.access(r, true); e != nil {
		return e
	}
	typ, _, e := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if e != nil {
		return fail(415, "Bestandstype niet ondersteund")
	}
	allowed := map[string]string{"image/jpeg": "photo", "image/png": "photo", "image/webp": "photo", "audio/webm": "audio", "audio/ogg": "audio", "audio/mp4": "audio", "audio/wav": "audio", "audio/mpeg": "audio"}
	kind := allowed[typ]
	if kind == "" {
		return fail(415, "Gebruik JPG, PNG, WebP of een ondersteund audiobestand")
	}
	limit := int64(20 << 20)
	if kind == "audio" {
		limit = 50 << 20
	}
	f, e := os.CreateTemp("", "satvey-upload-*")
	if e != nil {
		return e
	}
	defer os.Remove(f.Name())
	defer f.Close()
	digest := sha256.New()
	size, e := io.Copy(io.MultiWriter(f, digest), http.MaxBytesReader(w, r.Body, limit))
	if e != nil {
		return fail(413, "Bestand te groot: maximaal 20 MB per foto en 50 MB per audio-opname")
	}
	if size == 0 {
		return fail(400, "Het bestand is leeg")
	}
	_, _ = f.Seek(0, 0)
	head := make([]byte, 512)
	n, _ := f.Read(head)
	sniff := http.DetectContentType(head[:n])
	if sniff != typ && !(typ == "audio/webm" && sniff == "video/webm") && !(typ == "audio/mp4" && (sniff == "video/mp4" || sniff == "application/octet-stream")) && !(typ == "audio/ogg" && sniff == "application/ogg") && !(typ == "audio/wav" && sniff == "audio/wave") {
		return fail(415, "Bestandsinhoud komt niet overeen met het bestandstype")
	}
	_, _ = f.Seek(0, 0)
	sha := hex.EncodeToString(digest.Sum(nil))
	name, decodeError := url.PathUnescape(r.Header.Get("X-File-Name"))
	if decodeError != nil {
		return fail(400, "Ongeldige bestandsnaam")
	}
	name = filepath.Base(name)
	if name == "" || name == "." {
		name = "opname"
	}
	if len(name) > 240 {
		return fail(400, "Bestandsnaam te lang")
	}
	duration, _ := strconv.ParseFloat(r.Header.Get("X-Audio-Duration"), 64)
	if duration < 0 || duration > 601 || math.IsNaN(duration) || math.IsInf(duration, 0) {
		duration = 0
	}
	tx, _, e := a.edit(r)
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	org, inspection, batch, mid := r.PathValue("org"), r.PathValue("inspection"), r.PathValue("batch"), r.PathValue("media")
	var oldHash, oldBatch string
	e = tx.QueryRow(r.Context(), "SELECT sha256,batch_id FROM media WHERE id=$1 AND org_id=$2 AND inspection_id=$3", mid, org, inspection).Scan(&oldHash, &oldBatch)
	if e == nil {
		if oldHash != sha || oldBatch != batch {
			return fail(409, "Media-ID bestaat al met andere inhoud")
		}
		send(w, 200, map[string]string{"id": mid})
		return nil
	}
	if e != pgx.ErrNoRows {
		return e
	}
	var eligible bool
	e = tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM batches WHERE id=$1 AND org_id=$2 AND inspection_id=$3 AND status='pending' AND $4::uuid=ANY(expected_media))", batch, org, inspection, mid).Scan(&eligible)
	if e != nil {
		return e
	}
	if !eligible {
		return fail(409, "Opname niet gevonden, al beoordeeld of media niet aangemeld")
	}
	key := org + "/" + inspection + "/" + mid + "/" + id()
	_, e = a.storage.PutObject(r.Context(), &s3.PutObjectInput{Bucket: &a.bucket, Key: &key, Body: f, ContentLength: &size, ContentType: &typ})
	if e != nil {
		return fail(503, "Upload mislukt. De opname blijft op je apparaat.")
	}
	committed := false
	defer func() {
		if !committed {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_, _ = a.storage.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: &a.bucket, Key: &key})
		}
	}()
	if _, e = tx.Exec(r.Context(), "INSERT INTO media(id,org_id,inspection_id,batch_id,kind,name,mime,size,object_key,sha256,duration) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", mid, org, inspection, batch, kind, name, typ, size, key, sha, duration); e != nil {
		return e
	}
	var complete bool
	if e = tx.QueryRow(r.Context(), "SELECT cardinality(expected_media)=(SELECT count(*) FROM media WHERE batch_id=$1 AND org_id=$2) FROM batches WHERE id=$1 AND org_id=$2", batch, org).Scan(&complete); e != nil {
		return e
	}
	format, err := inspectionFormat(r.Context(), tx, org, inspection)
	if err != nil {
		return err
	}
	if kind == "audio" {
		if _, e = tx.Exec(r.Context(), `INSERT INTO transcription_jobs(media_id,org_id,inspection_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, mid, org, inspection); e != nil {
			return e
		}
	}
	if complete && format == nil {
		if _, e = tx.Exec(r.Context(), "INSERT INTO processing_jobs(id,org_id,inspection_id,batch_id,provider) SELECT $1,$2,$3,$4,analysis_provider FROM batches WHERE id=$4 AND org_id=$2 ON CONFLICT(batch_id) DO NOTHING", id(), org, inspection, batch); e != nil {
			return e
		}
	}

	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	committed = true
	send(w, 201, map[string]string{"id": mid})
	return nil
}
func (a *app) download(w http.ResponseWriter, r *http.Request) error {
	if _, _, e := a.access(r, false); e != nil {
		return e
	}
	if !validID(r.PathValue("media")) {
		return fail(404, "Bestand niet gevonden")
	}
	var key, typ, name string
	e := a.db.QueryRow(r.Context(), "SELECT object_key,mime,name FROM media WHERE id=$1 AND org_id=$2", r.PathValue("media"), r.PathValue("org")).Scan(&key, &typ, &name)
	if e != nil {
		return e
	}
	input := &s3.GetObjectInput{Bucket: &a.bucket, Key: &key}
	if h := r.Header.Get("Range"); h != "" {
		input.Range = &h
	}
	obj, e := a.storage.GetObject(r.Context(), input)
	if e != nil {
		if input.Range != nil {
			return fail(416, "Ongeldig bereik")
		}
		return fail(503, "Bestand tijdelijk niet beschikbaar")
	}
	defer obj.Body.Close()
	w.Header().Set("Content-Type", typ)
	w.Header().Set("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": name}))
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	if obj.ContentLength != nil {
		w.Header().Set("Content-Length", fmt.Sprint(*obj.ContentLength))
	}
	if obj.ContentRange != nil {
		w.Header().Set("Content-Range", aws.ToString(obj.ContentRange))
		w.WriteHeader(206)
	}
	_, e = io.Copy(w, obj.Body)
	if e != nil {
		slog.Warn("download interrupted", "error", e)
	}
	return nil
}
