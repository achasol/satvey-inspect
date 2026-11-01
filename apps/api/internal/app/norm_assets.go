package app

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"mime"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"

	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5"
)

func (a *app) uploadNormAsset(w http.ResponseWriter, r *http.Request) error {
	u, e := a.quality(r)
	if e != nil {
		return e
	}
	asset, org := r.PathValue("asset"), r.PathValue("org")
	if !validID(asset) {
		return fail(400, "Ongeldig voorbeeldbestand")
	}
	typ, _, e := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if e != nil {
		return fail(415, "Bestandstype niet ondersteund")
	}
	kind := ""
	switch typ {
	case "image/jpeg", "image/png", "image/webp":
		kind = "photo"
	case "application/pdf":
		kind = "document"
	case "audio/webm", "audio/mp4", "audio/ogg", "audio/wav", "audio/mpeg":
		kind = "audio"
	default:
		return fail(415, "Gebruik JPG, PNG, WebP, PDF of audio")
	}
	limit := int64(20 << 20)
	if kind == "audio" {
		limit = 50 << 20
	}
	body, e := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if e != nil {
		return fail(413, "Voorbeeld te groot: maximaal 20 MB per foto of 50 MB per audio")
	}
	if len(body) == 0 {
		return fail(400, "Het bestand is leeg")
	}
	sniff := http.DetectContentType(body)
	if sniff != typ && !(typ == "audio/webm" && sniff == "video/webm") && !(typ == "audio/mp4" && sniff == "video/mp4") && !(typ == "audio/ogg" && sniff == "application/ogg") && !(typ == "audio/wav" && sniff == "audio/wave") {
		return fail(415, "De bestandsinhoud komt niet overeen met het bestandstype")
	}
	name, e := url.PathUnescape(r.Header.Get("X-File-Name"))
	if e != nil {
		return fail(400, "Ongeldige bestandsnaam")
	}
	name = filepath.Base(name)
	if name == "" || name == "." {
		name = "voorbeeld"
	}
	if len(name) > 240 {
		return fail(400, "Bestandsnaam te lang")
	}
	sum := sha256.Sum256(body)
	digest := hex.EncodeToString(sum[:])
	var old string
	e = a.db.QueryRow(r.Context(), "SELECT sha256 FROM norm_assets WHERE id=$1 AND org_id=$2", asset, org).Scan(&old)
	if e == nil {
		if old != digest {
			return fail(409, "Voorbeeld-ID is al in gebruik")
		}
		send(w, 200, map[string]string{"id": asset})
		return nil
	}
	if e != pgx.ErrNoRows {
		return e
	}
	key := org + "/norm-examples/" + asset + "/" + id()
	size := int64(len(body))
	if _, e = a.storage.PutObject(r.Context(), &s3.PutObjectInput{Bucket: &a.bucket, Key: &key, ContentType: &typ, ContentLength: &size, Body: bytes.NewReader(body)}); e != nil {
		return fail(503, "Voorbeeld uploaden mislukt")
	}
	if _, e = a.db.Exec(r.Context(), "INSERT INTO norm_assets(id,org_id,name,mime,kind,object_key,sha256,size,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", asset, org, name, typ, kind, key, digest, size, u.ID); e != nil {
		_, _ = a.storage.DeleteObject(r.Context(), &s3.DeleteObjectInput{Bucket: &a.bucket, Key: &key})
		return e
	}
	send(w, 201, map[string]string{"id": asset})
	return nil
}
func (a *app) downloadNormAsset(w http.ResponseWriter, r *http.Request) error {
	if _, _, e := a.require(r, "norms.read"); e != nil {
		if _, _, readErr := a.access(r, false); readErr != nil {
			return readErr
		}
		var logo bool
		if err := a.db.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM organisations WHERE id=$1 AND logo_asset_id::text=$2) OR EXISTS(SELECT 1 FROM reports WHERE org_id=$1 AND snapshot->'organisation'->>'logoAssetId'=$2)`, r.PathValue("org"), r.PathValue("asset")).Scan(&logo); err != nil {
			return err
		}
		if !logo {
			return e
		}
	}
	if !validID(r.PathValue("asset")) {
		return fail(404, "Voorbeeld niet gevonden")
	}
	var key, typ, name string
	if e := a.db.QueryRow(r.Context(), "SELECT object_key,mime,name FROM norm_assets WHERE id=$1 AND org_id=$2", r.PathValue("asset"), r.PathValue("org")).Scan(&key, &typ, &name); e != nil {
		return e
	}
	input := &s3.GetObjectInput{Bucket: &a.bucket, Key: &key}
	if h := r.Header.Get("Range"); h != "" {
		input.Range = &h
	}
	obj, e := a.storage.GetObject(r.Context(), input)
	if e != nil {
		return fail(503, "Voorbeeld tijdelijk niet beschikbaar")
	}
	defer obj.Body.Close()
	w.Header().Set("Content-Type", typ)
	w.Header().Set("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": name}))
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	w.Header().Set("Accept-Ranges", "bytes")
	if obj.ContentLength != nil {
		w.Header().Set("Content-Length", strconv.FormatInt(*obj.ContentLength, 10))
	}
	if obj.ContentRange != nil {
		w.Header().Set("Content-Range", *obj.ContentRange)
		w.WriteHeader(206)
	}
	_, _ = io.Copy(w, obj.Body)
	return nil
}
