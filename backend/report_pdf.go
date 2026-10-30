package main

import (
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"html/template"
	"image"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"
	_ "time/tzdata"
	"unicode"

	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/disintegration/imaging"
	"github.com/jackc/pgx/v5"
)

//go:embed report_assets/*.html report_assets/*.ttf
var reportAssets embed.FS

type reportPerson struct {
	Name string `json:"name"`
}
type pdfInspection struct {
	PropertySnapshot *catalogProperty `json:"propertySnapshot"`
	ID               string           `json:"id"`
	Address          string           `json:"address"`
	Postcode         string           `json:"postcode"`
	City             string           `json:"city"`
	Kind             string           `json:"kind"`
	Status           string           `json:"status"`
	ScheduledAt      *time.Time       `json:"scheduledAt"`
	CreatedAt        time.Time        `json:"createdAt"`
}
type pdfBatch struct {
	ID     string `json:"id"`
	RoomID string `json:"roomId"`
	Status string `json:"status"`
}
type pdfObservation struct {
	ID          string   `json:"id"`
	BatchID     string   `json:"batchId"`
	Title       string   `json:"title"`
	Description string   `json:"description"`
	Label       string   `json:"label"`
	PhotoIDs    []string `json:"photoIds"`
	Photos      []pdfPhoto
}
type pdfAssessment struct {
	RuleID              string   `json:"ruleId"`
	BatchID             string   `json:"batchId"`
	Outcome             string   `json:"outcome"`
	Reason              string   `json:"reason"`
	PhotoIDs            []string `json:"photoIds"`
	Code, Title, Result string
	Photos              []pdfPhoto
}
type pdfPhoto struct {
	ID           string `json:"id"`
	BatchID      string `json:"batchId"`
	Kind         string `json:"kind"`
	Name         string `json:"name"`
	File, Number string
	Annotations  []photoAnnotation `json:"annotations"`
}
type pdfFormatAnswer struct {
	Title, Value, Reason, Outcome, Result string
	PhotoIDs                              []string
	Photos                                []pdfPhoto
}
type pdfRoom struct {
	CategoryID                  string `json:"categoryId"`
	ApprovedGeneration          *int   `json:"approvedGeneration"`
	Generation                  int    `json:"generation"`
	Answers                     []pdfFormatAnswer
	ID                          string `json:"id"`
	Name                        string `json:"name"`
	Anchor, Number, Coverage    string
	Reviewed, Pending, Excluded int
	NormCount                   int
	Observations                []pdfObservation
	Assessments                 []pdfAssessment
	Photos                      []pdfPhoto
	PhotoRows                   [][]pdfPhoto
}
type pdfDocument struct {
	Signatures                                                                   []reportSignature `json:"signatures"`
	Format                                                                       *formatDocument   `json:"format"`
	Answers                                                                      []formatAnswer    `json:"answers"`
	ID                                                                           string            `json:"id"`
	CreatedAt                                                                    time.Time         `json:"createdAt"`
	Inspection                                                                   pdfInspection     `json:"inspection"`
	Organisation                                                                 reportPerson      `json:"organisation"`
	CreatedBy                                                                    reportPerson      `json:"createdBy"`
	FinalisedBy                                                                  reportPerson      `json:"finalisedBy"`
	Rooms                                                                        []pdfRoom         `json:"rooms"`
	Batches                                                                      []pdfBatch        `json:"batches"`
	Media                                                                        []pdfPhoto        `json:"media"`
	Observations                                                                 []pdfObservation  `json:"observations"`
	Assessments                                                                  []pdfAssessment   `json:"assessments"`
	Norms                                                                        *normDocument     `json:"norms"`
	Sections                                                                     []pdfRoom
	Final                                                                        bool
	Status, Kind, Reference, Date, GeneratedAt, Appointment                      string
	Reviewed, Pending, Excluded, Acceptable, Unacceptable, Unknown, Inapplicable int
}

func reportDate(value time.Time) string {
	if value.IsZero() {
		return "Niet vastgelegd"
	}
	zone, e := time.LoadLocation("Europe/Amsterdam")
	if e != nil {
		zone = time.UTC
	}
	return value.In(zone).Format("02-01-2006 15:04")
}
func preparePDFDocument(doc *pdfDocument) error {
	if err := prepareSignatures(doc.Signatures); err != nil {
		return err
	}
	if !validID(doc.Inspection.ID) {
		return fmt.Errorf("ongeldig rapport")
	}
	doc.Final = doc.Inspection.Status == "final"
	doc.Status = "Concept"
	if doc.Final {
		doc.Status = "Vastgelegd"
	}
	doc.Kind = "Voorinspectie"
	if doc.Inspection.Kind == "final" {
		doc.Kind = "Eindinspectie"
	}
	doc.Reference = strings.ToUpper(doc.Inspection.ID[:8])
	if validID(doc.ID) {
		doc.Reference = strings.ToUpper(doc.ID[:8])
	}
	doc.Date = reportDate(doc.CreatedAt)
	doc.GeneratedAt = reportDate(time.Now())
	doc.Appointment = "Niet ingepland"
	if doc.Inspection.ScheduledAt != nil {
		doc.Appointment = reportDate(*doc.Inspection.ScheduledAt)
	}
	sort.SliceStable(doc.Rooms, func(i, j int) bool { return strings.ToLower(doc.Rooms[i].Name) < strings.ToLower(doc.Rooms[j].Name) })
	batchRooms := map[string]string{}
	included := map[string]bool{}
	for _, b := range doc.Batches {
		batchRooms[b.ID] = b.RoomID
		if b.Status == "reviewed" {
			included[b.ID] = true
			doc.Reviewed++
		} else if b.Status == "excluded" {
			doc.Excluded++
		} else {
			doc.Pending++
		}
	}
	photos := map[string]pdfPhoto{}
	for _, p := range doc.Media {
		if p.Kind == "photo" && included[p.BatchID] {
			p.File = "photo-" + p.ID + ".jpg"
			if len(p.Annotations) > 0 {
				p.File = "photo-" + p.ID + ".svg"
			}
			photos[p.ID] = p
		}
	}
	doc.Media = []pdfPhoto{}
	number := 0
	for index := range doc.Rooms {
		room := &doc.Rooms[index]
		room.Anchor = "room-" + room.ID
		for _, b := range doc.Batches {
			if b.RoomID == room.ID {
				switch b.Status {
				case "reviewed":
					room.Reviewed++
				case "excluded":
					room.Excluded++
				default:
					room.Pending++
				}
			}
		}
		room.Coverage = "Niet opgenomen"
		if room.Pending > 0 {
			room.Coverage = "Nog te beoordelen"
		} else if room.Reviewed > 0 {
			room.Coverage = "Beoordeeld"
		} else if room.Excluded > 0 {
			room.Coverage = "Uitgesloten"
		}
		if doc.Format != nil {
			scopeAnswers := []formatAnswer{}
			byQuestion := map[string]formatAnswer{}
			for _, a := range doc.Answers {
				if a.RoomID == room.ID {
					scopeAnswers = append(scopeAnswers, a)
					byQuestion[a.QuestionID] = a
				}
			}
			for _, category := range doc.Format.Scopes {
				if category.ID != room.CategoryID {
					continue
				}
				for _, q := range category.Questions {
					a, ok := byQuestion[q.ID]
					if !ok || !questionActive(q, category.Questions, byQuestion) {
						continue
					}
					if a.Status != "confirmed" && a.Status != "unanswerable" {
						continue
					}
					v := pdfFormatAnswer{Title: q.Title, Reason: a.Reason, Outcome: a.Outcome, PhotoIDs: a.PhotoIDs}
					var value any
					_ = json.Unmarshal(a.Value, &value)
					if a.Status == "unanswerable" {
						v.Value = "Niet te beantwoorden"
						v.Outcome = "not_assessable"
					} else {
						switch val := value.(type) {
						case bool:
							if val {
								v.Value = "Ja"
							} else {
								v.Value = "Nee"
							}
						case nil:
							v.Value = "Niet vastgelegd"
						default:
							v.Value = fmt.Sprint(val)
						}
						if q.Unit != "" {
							v.Value += " " + q.Unit
						}
					}
					switch v.Outcome {
					case "acceptable":
						v.Result = "Acceptabel"
						doc.Acceptable++
					case "unacceptable":
						v.Result = "Niet acceptabel"
						doc.Unacceptable++
					case "not_applicable":
						v.Result = "Niet van toepassing"
						doc.Inapplicable++
					case "not_assessable":
						if q.RuleID != "" {
							v.Result = "Niet te beoordelen"
							doc.Unknown++
						}
					}
					if q.Kind == "quality" && a.Status != "unanswerable" {
						v.Value = v.Result
					}
					if q.RuleID != "" {
						room.NormCount++
					}
					room.Answers = append(room.Answers, v)
				}
			}
			if room.ApprovedGeneration != nil && *room.ApprovedGeneration == room.Generation {
				room.Coverage = "Beoordeeld"
				allWaived := len(scopeAnswers) > 0
				for _, a := range scopeAnswers {
					allWaived = allWaived && a.Status == "unanswerable"
				}
				if allWaived {
					room.Coverage = "Niet te beantwoorden ? toegelicht"
				}
			}
		}
		if room.Reviewed == 0 && len(room.Answers) == 0 {
			continue
		}
		// Stable numbering and one copy of each source photo per room.
		roomPhotos := []pdfPhoto{}
		for _, p := range photos {
			if batchRooms[p.BatchID] == room.ID {
				roomPhotos = append(roomPhotos, p)
			}
		}
		sort.Slice(roomPhotos, func(i, j int) bool { return roomPhotos[i].ID < roomPhotos[j].ID })
		for _, p := range roomPhotos {
			number++
			p.Number = fmt.Sprintf("F%02d", number)
			photos[p.ID] = p
			room.Photos = append(room.Photos, p)
			doc.Media = append(doc.Media, p)
		}
		refs := func(ids []string, batch string, all bool) []pdfPhoto {
			out := []pdfPhoto{}
			for _, p := range room.Photos {
				if p.BatchID != batch && doc.Format == nil {
					continue
				}
				if all && len(ids) == 0 {
					out = append(out, p)
					continue
				}
				for _, id := range ids {
					if id == p.ID {
						out = append(out, p)
						break
					}
				}
			}
			return out
		}
		for _, o := range doc.Observations {
			if included[o.BatchID] && batchRooms[o.BatchID] == room.ID {
				o.Photos = refs(o.PhotoIDs, o.BatchID, true)
				room.Observations = append(room.Observations, o)
			}
		}
		for _, a := range doc.Assessments {
			if !included[a.BatchID] || batchRooms[a.BatchID] != room.ID {
				continue
			}
			if doc.Norms != nil {
				for _, rule := range doc.Norms.Rules {
					if rule.ID == a.RuleID {
						a.Code = rule.Code
						a.Title = rule.Title
						break
					}
				}
			}
			if a.Title == "" {
				a.Title = "Normbeoordeling"
			}
			switch a.Outcome {
			case "acceptable":
				a.Result = "Acceptabel"
				doc.Acceptable++
			case "unacceptable":
				a.Result = "Niet acceptabel"
				doc.Unacceptable++
			case "not_applicable":
				a.Result = "Niet van toepassing"
				doc.Inapplicable++
			default:
				a.Result = "Niet te beoordelen"
				doc.Unknown++
			}
			a.Photos = refs(a.PhotoIDs, a.BatchID, false)
			room.Assessments = append(room.Assessments, a)
		}
		room.NormCount += len(room.Assessments)
		for i := 0; i < len(room.Photos); i += 2 {
			end := i + 2
			if end > len(room.Photos) {
				end = len(room.Photos)
			}
			room.PhotoRows = append(room.PhotoRows, room.Photos[i:end])
		}
		room.Number = fmt.Sprintf("2.%d", len(doc.Sections)+1)
		doc.Sections = append(doc.Sections, *room)
	}
	// Resolve structured evidence after numbering all rooms, including whole-property references.
	for i := range doc.Sections {
		for j := range doc.Sections[i].Answers {
			answer := &doc.Sections[i].Answers[j]
			for _, pid := range answer.PhotoIDs {
				if photo, ok := photos[pid]; ok && photo.Number != "" {
					answer.Photos = append(answer.Photos, photo)
				}
			}
		}
	}
	return nil
}

func (a *app) pdfSource(r *http.Request) (pdfDocument, error) {
	var doc pdfDocument
	tx, e := a.db.BeginTx(r.Context(), pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if e != nil {
		return doc, e
	}
	defer tx.Rollback(r.Context())
	var status string
	org, inspection := r.PathValue("org"), r.PathValue("inspection")
	if e = tx.QueryRow(r.Context(), "SELECT status FROM inspections WHERE id=$1 AND org_id=$2", inspection, org).Scan(&status); e != nil {
		return doc, e
	}
	var snapshot map[string]json.RawMessage
	if status == "final" {
		var raw []byte
		if e = tx.QueryRow(r.Context(), "SELECT snapshot FROM reports WHERE inspection_id=$1 AND org_id=$2", inspection, org).Scan(&raw); e != nil {
			return doc, e
		}
		if e = json.Unmarshal(raw, &snapshot); e != nil {
			return doc, e
		}
		if e = fillReportMetadata(r.Context(), tx, org, inspection, snapshot); e != nil {
			return doc, e
		}
	} else {
		snapshot, e = reportSnapshot(r.Context(), tx, org, inspection)
		if e != nil {
			return doc, e
		}
		snapshot["createdAt"], _ = json.Marshal(time.Now())
	}
	raw, _ := json.Marshal(snapshot)
	if e = json.Unmarshal(raw, &doc); e != nil {
		return doc, e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return doc, e
	}
	if e = preparePDFDocument(&doc); e != nil {
		return doc, e
	}
	return doc, nil
}

func (a *app) reportPDF(w http.ResponseWriter, r *http.Request) error {
	if _, _, e := a.access(r, false); e != nil {
		return e
	}
	if !validID(r.PathValue("inspection")) {
		return fail(404, "Rapport niet gevonden")
	}
	var in struct{}
	if e := readJSON(w, r, &in); e != nil {
		return e
	}
	doc, e := a.pdfSource(r)
	if e != nil {
		return e
	}
	pdf, e := a.renderReportPDF(r.Context(), r.PathValue("org"), doc)
	if e != nil {
		return e
	}
	name := strings.Map(func(c rune) rune {
		if unicode.IsLetter(c) || unicode.IsDigit(c) || c == '-' {
			return c
		}
		return '-'
	}, doc.Inspection.Address)
	if len([]rune(name)) > 80 {
		name = string([]rune(name)[:80])
	}
	filename := "satvey-" + strings.ToLower(doc.Kind) + "-" + strings.Trim(name, "-") + "-" + strings.ToLower(doc.Status) + ".pdf"
	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": filename}))
	w.Header().Set("Content-Length", fmt.Sprint(len(pdf)))
	w.Header().Set("X-Satvey-Report-Status", doc.Inspection.Status)
	_, _ = w.Write(pdf)
	return nil
}

func executePDFTemplate(name string, doc pdfDocument) ([]byte, error) {
	t, e := template.ParseFS(reportAssets, "report_assets/"+name)
	if e != nil {
		return nil, e
	}
	var out bytes.Buffer
	e = t.Execute(&out, doc)
	return out.Bytes(), e
}
func (a *app) renderReportPDF(ctx context.Context, org string, doc pdfDocument) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 140*time.Second)
	defer cancel()
	payload, e := os.CreateTemp("", "satvey-pdf-*.multipart")
	if e != nil {
		return nil, e
	}
	defer os.Remove(payload.Name())
	defer payload.Close()
	form := multipart.NewWriter(payload)
	add := func(name string, data []byte) error {
		part, e := form.CreateFormFile("files", name)
		if e != nil {
			return e
		}
		_, e = part.Write(data)
		return e
	}
	for _, name := range []string{"index.html", "header.html", "footer.html"} {
		data, e := executePDFTemplate(name, doc)
		if e != nil {
			return nil, e
		}
		if e = add(name, data); e != nil {
			return nil, e
		}
	}
	for _, name := range []string{"dm-sans-regular.ttf", "dm-sans-semibold.ttf", "dm-sans-bold.ttf"} {
		font, e := reportAssets.ReadFile("report_assets/" + name)
		if e != nil {
			return nil, e
		}
		if e = add(name, font); e != nil {
			return nil, e
		}
	}
	for _, p := range doc.Media {
		if !validID(p.ID) {
			return nil, fail(503, "Een bronfoto kon niet worden gecontroleerd. De PDF is niet gemaakt.")
		}
		var key string
		if e = a.db.QueryRow(ctx, "SELECT object_key FROM media WHERE id=$1 AND org_id=$2 AND inspection_id=$3 AND kind='photo'", p.ID, org, doc.Inspection.ID).Scan(&key); e != nil {
			return nil, fail(503, "Een bronfoto is niet beschikbaar. De PDF is niet gemaakt.")
		}
		object, e := a.storage.GetObject(ctx, &s3.GetObjectInput{Bucket: &a.bucket, Key: &key})
		if e != nil {
			return nil, fail(503, "Een bronfoto is tijdelijk niet beschikbaar. Probeer de PDF opnieuw te maken.")
		}
		data, e := io.ReadAll(io.LimitReader(object.Body, (20<<20)+1))
		object.Body.Close()
		if e != nil || len(data) > 20<<20 {
			return nil, fail(503, "Een bronfoto kon niet worden ingelezen.")
		}
		data, e = reportPhotoJPEG(data)
		if e != nil {
			return nil, fail(422, "Een bronfoto is onleesbaar. Controleer de foto voordat je de PDF maakt.")
		}
		if len(p.Annotations) > 0 {
			data, e = annotatedPhotoSVG(data, p.Annotations)
			if e != nil {
				return nil, fail(422, "Fotomarkeringen konden niet worden gerenderd")
			}
		}
		if e = add(p.File, data); e != nil {
			return nil, e
		}
		if size, e := payload.Stat(); e != nil || size.Size() > 120<<20 {
			return nil, fail(413, "Het rapport bevat te veel fotogegevens voor één PDF.")
		}
	}
	for key, value := range map[string]string{"paperWidth": "210mm", "paperHeight": "297mm", "marginTop": "20mm", "marginBottom": "20mm", "marginLeft": "18mm", "marginRight": "18mm", "printBackground": "true", "generateDocumentOutline": "true", "generateTaggedPdf": "true", "failOnConsoleExceptions": "true", "failOnResourceLoadingFailed": "true", "waitForExpression": "document.fonts.check('400 12px \"DM Sans\"') && document.fonts.check('600 12px \"DM Sans\"') && document.fonts.check('700 12px \"DM Sans\"') && Array.from(document.images).every(image => image.complete && image.naturalWidth > 0)"} {
		if e = form.WriteField(key, value); e != nil {
			return nil, e
		}
	}
	if e = form.Close(); e != nil {
		return nil, e
	}
	size, e := payload.Stat()
	if e != nil {
		return nil, e
	}
	if _, e = payload.Seek(0, 0); e != nil {
		return nil, e
	}
	endpoint := a.pdfURL
	if endpoint == "" {
		endpoint = env("PDF_RENDERER_URL", "http://pdf:3000")
	}
	req, e := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(endpoint, "/")+"/forms/chromium/convert/html", payload)
	if e != nil {
		return nil, e
	}
	req.ContentLength = size.Size()
	req.Header.Set("Content-Type", form.FormDataContentType())
	res, e := (&http.Client{Timeout: 130 * time.Second}).Do(req)
	if e != nil {
		return nil, fail(503, "PDF-generatie is tijdelijk niet beschikbaar. Probeer opnieuw.")
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, fail(503, "De PDF kon niet volledig worden gemaakt. Probeer opnieuw.")
	}
	data, e := io.ReadAll(io.LimitReader(res.Body, (64<<20)+1))
	if e != nil || len(data) > 64<<20 || !bytes.HasPrefix(data, []byte("%PDF-")) || !bytes.HasSuffix(bytes.TrimSpace(data), []byte("%%EOF")) {
		return nil, fail(503, "De PDF is niet volledig ontvangen. Probeer opnieuw.")
	}
	return data, nil
}

// Resolve phone-camera EXIF orientation before resizing and stripping metadata.
func reportPhotoJPEG(data []byte) ([]byte, error) {
	cfg, _, e := image.DecodeConfig(bytes.NewReader(data))
	if e != nil || cfg.Width <= 0 || cfg.Height <= 0 || int64(cfg.Width)*int64(cfg.Height) > 40_000_000 {
		return nil, fmt.Errorf("foto kan niet veilig worden ingelezen")
	}
	img, e := imaging.Decode(bytes.NewReader(data), imaging.AutoOrientation(true))
	if e != nil {
		return nil, e
	}
	return encodePhotoJPEG(img, 90)
}
