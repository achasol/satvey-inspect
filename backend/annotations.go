package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"math"
	"net/http"

	"github.com/jackc/pgx/v5"
)

type annotationPoint struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}
type photoAnnotation struct {
	Tool   string            `json:"tool"`
	Color  string            `json:"color"`
	Points []annotationPoint `json:"points"`
}

func validateAnnotations(shapes []photoAnnotation) error {
	if shapes == nil || len(shapes) > 200 {
		return fail(422, "Maximaal 200 markeringen per foto")
	}
	total := 0
	for _, s := range shapes {
		if s.Tool != "pen" && s.Tool != "arrow" && s.Tool != "ellipse" {
			return fail(422, "Onbekend tekengereedschap")
		}
		if s.Color != "#dc2626" && s.Color != "#eab308" && s.Color != "#2563eb" {
			return fail(422, "Onbekende markeringskleur")
		}
		if len(s.Points) < 2 || (s.Tool != "pen" && len(s.Points) != 2) {
			return fail(422, "Ongeldige markering")
		}
		total += len(s.Points)
		if total > 12000 {
			return fail(422, "Te veel tekenpunten; vereenvoudig de markeringen")
		}
		for _, p := range s.Points {
			if math.IsNaN(p.X) || math.IsInf(p.X, 0) || math.IsNaN(p.Y) || math.IsInf(p.Y, 0) || p.X < 0 || p.X > 1 || p.Y < 0 || p.Y > 1 {
				return fail(422, "Markering valt buiten de foto")
			}
		}
	}
	return nil
}

func (a *app) photoAnnotations(w http.ResponseWriter, r *http.Request) error {
	org, inspection, mid := r.PathValue("org"), r.PathValue("inspection"), r.PathValue("media")
	if !validID(mid) || !validID(inspection) {
		return fail(404, "Foto niet gevonden")
	}
	if r.Method == "GET" {
		if _, _, e := a.access(r, false); e != nil {
			return e
		}
		var shapes json.RawMessage
		var version int
		e := a.db.QueryRow(r.Context(), `SELECT annotations,annotation_version FROM media WHERE id=$1 AND org_id=$2 AND inspection_id=$3 AND kind='photo'`, mid, org, inspection).Scan(&shapes, &version)
		if e != nil {
			return e
		}
		send(w, 200, map[string]any{"shapes": shapes, "version": version})
		return nil
	}
	var in struct {
		Shapes  []photoAnnotation `json:"shapes"`
		Version int               `json:"version"`
	}
	if e := readJSON(w, r, &in); e != nil {
		return e
	}
	if e := validateAnnotations(in.Shapes); e != nil {
		return e
	}
	tx, user, e := a.edit(r)
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	raw, _ := json.Marshal(in.Shapes)
	tag, e := tx.Exec(r.Context(), `UPDATE media SET annotations=$1,annotation_version=annotation_version+1,annotated_by=$2,annotated_at=now() WHERE id=$3 AND org_id=$4 AND inspection_id=$5 AND kind='photo' AND annotation_version=$6`, raw, user.ID, mid, org, inspection, in.Version)
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return fail(409, "De fotomarkeringen zijn gewijzigd of de foto is niet beschikbaar. Vergelijk met de nieuwste versie.")
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	send(w, 200, map[string]int{"version": in.Version + 1})
	return nil
}

// Photo decisions and format approval are independent. Empty AI results require an explicit human action.
func reconcileCaptureReviews(ctx context.Context, tx pgx.Tx, org, inspection string) error {
	if _, e := tx.Exec(ctx, `UPDATE batches b SET status='pending',version=version+1 WHERE b.org_id=$1 AND b.inspection_id=$2 AND b.status='reviewed' AND EXISTS(SELECT 1 FROM observations o WHERE o.batch_id=b.id AND o.org_id=b.org_id AND o.status='draft')`, org, inspection); e != nil {
		return e
	}
	_, e := tx.Exec(ctx, `UPDATE batches b SET status='reviewed',version=version+1
	WHERE b.org_id=$1 AND b.inspection_id=$2 AND b.status='pending'
	AND EXISTS(SELECT 1 FROM observations o WHERE o.batch_id=b.id AND o.org_id=b.org_id)
	AND NOT EXISTS(SELECT 1 FROM observations o WHERE o.batch_id=b.id AND o.org_id=b.org_id AND o.status='draft')
	AND cardinality(b.expected_media)=(SELECT count(*) FROM media m WHERE m.batch_id=b.id AND m.org_id=b.org_id)
	AND NOT EXISTS(SELECT 1 FROM processing_jobs j WHERE j.batch_id=b.id AND j.org_id=b.org_id AND j.status<>'done')
	AND NOT EXISTS(SELECT 1 FROM scope_jobs j WHERE j.room_id=b.room_id AND j.org_id=b.org_id AND j.status<>'done')
	AND NOT EXISTS(SELECT 1 FROM transcription_jobs j JOIN media m ON m.id=j.media_id AND m.org_id=j.org_id WHERE m.batch_id=b.id AND j.org_id=b.org_id AND j.status NOT IN ('done','skipped'))`, org, inspection)
	return e
}

// Only validated numeric geometry and allowlisted colours enter SVG. Original pixels are never modified.
func annotatedPhotoSVG(jpeg []byte, shapes []photoAnnotation) ([]byte, error) {
	if e := validateAnnotations(shapes); e != nil {
		return nil, e
	}
	cfg, _, e := image.DecodeConfig(bytes.NewReader(jpeg))
	if e != nil {
		return nil, e
	}
	w, h := float64(cfg.Width), float64(cfg.Height)
	stroke := math.Min(w, h) * 0.006
	var out bytes.Buffer
	fmt.Fprintf(&out, `<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d"><image width="%d" height="%d" href="data:image/jpeg;base64,%s"/>`, cfg.Width, cfg.Height, cfg.Width, cfg.Height, cfg.Width, cfg.Height, base64.StdEncoding.EncodeToString(jpeg))
	for _, s := range shapes {
		a, b := s.Points[0], s.Points[len(s.Points)-1]
		fmt.Fprintf(&out, `<g fill="none" stroke="%s" stroke-width="%.4f" stroke-linecap="round" stroke-linejoin="round">`, s.Color, stroke)
		switch s.Tool {
		case "pen":
			out.WriteString(`<polyline points="`)
			for _, p := range s.Points {
				fmt.Fprintf(&out, "%.4f,%.4f ", p.X*w, p.Y*h)
			}
			out.WriteString(`"/>`)
		case "ellipse":
			fmt.Fprintf(&out, `<ellipse cx="%.4f" cy="%.4f" rx="%.4f" ry="%.4f"/>`, (a.X+b.X)*w/2, (a.Y+b.Y)*h/2, math.Abs(a.X-b.X)*w/2, math.Abs(a.Y-b.Y)*h/2)
		case "arrow":
			angle := math.Atan2((b.Y-a.Y)*h, (b.X-a.X)*w)
			length := stroke * 4
			fmt.Fprintf(&out, `<path d="M %.4f %.4f L %.4f %.4f M %.4f %.4f L %.4f %.4f L %.4f %.4f"/>`, a.X*w, a.Y*h, b.X*w, b.Y*h, b.X*w-length*math.Cos(angle-.5), b.Y*h-length*math.Sin(angle-.5), b.X*w, b.Y*h, b.X*w-length*math.Cos(angle+.5), b.Y*h-length*math.Sin(angle+.5))
		}
		out.WriteString(`</g>`)
	}
	out.WriteString(`</svg>`)
	return out.Bytes(), nil
}
