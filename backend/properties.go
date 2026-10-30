package main

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// These are source facts, never inspection evidence. Unknown values stay absent.
type propertyCluster struct {
	ID       string `json:"id"`
	Code     string `json:"code"`
	Name     string `json:"name"`
	Kind     string `json:"kind"`
	KindCode string `json:"kindCode"`
}
type propertyDetails struct {
	BagObjectID      string            `json:"bagObjectId,omitempty"`
	BagAddressID     string            `json:"bagAddressId,omitempty"`
	BagBuildingIDs   []string          `json:"bagBuildingIds,omitempty"`
	ComplexID        string            `json:"complexId,omitempty"`
	ComplexName      string            `json:"complexName,omitempty"`
	Clusters         []propertyCluster `json:"clusters,omitempty"`
	ObjectType       string            `json:"objectType,omitempty"`
	ObjectTypeCode   string            `json:"objectTypeCode,omitempty"`
	BuildYear        *int              `json:"buildYear,omitempty"`
	Area             *float64          `json:"area,omitempty"`
	AreaType         string            `json:"areaType,omitempty"`
	AreaTypeCode     string            `json:"areaTypeCode,omitempty"`
	AreaUnit         string            `json:"areaUnit,omitempty"`
	Areas            []propertyArea    `json:"areas,omitempty"`
	SourceStatus     string            `json:"sourceStatus,omitempty"`
	SourceStatusCode string            `json:"sourceStatusCode,omitempty"`
	SourceKeys       map[string]string `json:"sourceKeys,omitempty"`
}
type propertyArea struct {
	Value     float64 `json:"value"`
	Kind      string  `json:"kind"`
	KindCode  string  `json:"kindCode"`
	Unit      string  `json:"unit"`
	StartDate string  `json:"startDate,omitempty"`
	EndDate   string  `json:"endDate,omitempty"`
}
type catalogRow struct {
	SourceObjectID string `json:"sourceObjectId"`
	ObjectNumber   string `json:"objectNumber"`
	Address        string `json:"address"`
	Postcode       string `json:"postcode"`
	City           string `json:"city"`
	propertyDetails
}
type catalogProperty struct {
	ID             string     `json:"id"`
	Address        string     `json:"address"`
	Postcode       string     `json:"postcode"`
	City           string     `json:"city"`
	SourceID       *string    `json:"sourceId"`
	SourceObjectID *string    `json:"sourceObjectId"`
	SourceName     *string    `json:"sourceName"`
	SourceKind     *string    `json:"sourceKind"`
	Administration *string    `json:"administration"`
	ObjectNumber   string     `json:"objectNumber"`
	LinkState      string     `json:"linkState"`
	MergedInto     *string    `json:"mergedInto"`
	FetchedAt      *time.Time `json:"fetchedAt"`
	Revision       int        `json:"revision"`
	propertyDetails
}

func readProperty(ctx context.Context, q querier, org, property string) (catalogProperty, error) {
	var out catalogProperty
	if !validID(property) {
		return out, fail(404, "Woning niet gevonden")
	}
	var raw []byte
	if e := q.QueryRow(ctx, `SELECT property_document(id,org_id) FROM properties WHERE id=$1 AND org_id=$2`, property, org).Scan(&raw); e != nil {
		return out, e
	}
	e := json.Unmarshal(raw, &out)
	return out, e
}
func (a *app) propertyDetail(w http.ResponseWriter, r *http.Request) error {
	if _, _, e := a.access(r, false); e != nil {
		return e
	}
	p, e := readProperty(r.Context(), a.db, r.PathValue("org"), r.PathValue("property"))
	if e != nil {
		return e
	}
	send(w, 200, p)
	return nil
}
func (a *app) catalog(w http.ResponseWriter, r *http.Request) error {
	if _, _, e := a.access(r, false); e != nil {
		return e
	}
	org := r.PathValue("org")
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(query) > 240 {
		return fail(400, "Zoektekst is te lang")
	}
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if page < 1 {
		page = 1
	}
	if page > 1000000 {
		return fail(400, "Ongeldige pagina")
	}
	size := 25
	state := r.URL.Query().Get("state")
	if state != "" && state != "linked" && state != "provisional" {
		return fail(400, "Ongeldige koppelstatus")
	}
	tx, e := a.db.BeginTx(r.Context(), pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	const filter = ` FROM properties p WHERE p.org_id=$1 AND p.link_state<>'merged' AND ($3='' OR p.link_state=$3) AND ($2='' OR strpos(lower(p.object_number||' '||p.address||' '||p.postcode||' '||p.city||' '||COALESCE(p.source_object_id,'')),lower($2))>0 OR strpos(lower(replace(p.postcode,' ','')),lower(replace($2,' ','')))>0)`
	var total int
	if e = tx.QueryRow(r.Context(), `SELECT count(*)`+filter, org, query, state).Scan(&total); e != nil {
		return e
	}
	var items json.RawMessage
	if e = tx.QueryRow(r.Context(), `SELECT COALESCE(jsonb_agg(property_document(q.id,$1)),'[]') FROM (SELECT p.id`+filter+` ORDER BY p.object_number,p.address,p.id LIMIT $4 OFFSET $5) q`, org, query, state, size, (page-1)*size).Scan(&items); e != nil {
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	send(w, 200, map[string]any{"items": items, "total": total, "page": page, "pageSize": size})
	return nil
}
func (a *app) createProvisionalProperty(w http.ResponseWriter, r *http.Request) error {
	if _, _, e := a.access(r, true); e != nil {
		return e
	}
	var in struct {
		ID       string `json:"id"`
		Address  string `json:"address"`
		Postcode string `json:"postcode"`
		City     string `json:"city"`
	}
	if e := readJSON(w, r, &in); e != nil {
		return e
	}
	in.Address = strings.TrimSpace(in.Address)
	in.Postcode = strings.TrimSpace(in.Postcode)
	in.City = strings.TrimSpace(in.City)
	if !validID(in.ID) || in.Address == "" || len(in.Address) > 240 || len(in.Postcode) > 20 || len(in.City) > 120 || strings.ContainsRune(in.Address+in.Postcode+in.City, 0) {
		return fail(400, "Controleer het adres van de voorlopige woning")
	}
	tag, e := a.db.Exec(r.Context(), `INSERT INTO properties(id,org_id,address,postcode,city) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET address=properties.address WHERE properties.org_id=EXCLUDED.org_id AND properties.link_state='provisional' AND properties.address=EXCLUDED.address AND properties.postcode=EXCLUDED.postcode AND properties.city=EXCLUDED.city`, in.ID, r.PathValue("org"), in.Address, in.Postcode, in.City)
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return fail(409, "Deze woning-ID bestaat al met andere gegevens")
	}
	p, e := readProperty(r.Context(), a.db, r.PathValue("org"), in.ID)
	if e != nil {
		return e
	}
	send(w, 201, p)
	return nil
}
func normalizeCatalogRow(p *catalogRow) error {
	p.Address = strings.TrimSpace(p.Address)
	p.Postcode = strings.TrimSpace(p.Postcode)
	p.City = strings.TrimSpace(p.City)
	p.ObjectNumber = strings.TrimSpace(p.ObjectNumber)
	if strings.TrimSpace(p.SourceObjectID) == "" || len(p.SourceObjectID) > 512 || p.Address == "" || len(p.Address) > 240 || len(p.Postcode) > 20 || len(p.City) > 120 || len(p.ObjectNumber) > 160 {
		return fail(422, "Bronobject-ID en adres zijn verplicht; controleer de veldlengtes")
	}
	if p.BuildYear != nil && (*p.BuildYear < 1 || *p.BuildYear > 9999) {
		return fail(422, "Ongeldig bouwjaar")
	}
	if p.Area != nil && (math.IsNaN(*p.Area) || math.IsInf(*p.Area, 0) || *p.Area < 0 || *p.Area > 1e9 || p.AreaType == "" || p.AreaUnit == "") {
		return fail(422, "Oppervlakte vereist een geldige waarde, meetsoort en eenheid")
	}
	texts := []string{p.SourceObjectID, p.ObjectNumber, p.Address, p.Postcode, p.City, p.BagObjectID, p.BagAddressID, p.ComplexID, p.ComplexName, p.ObjectType, p.ObjectTypeCode, p.AreaType, p.AreaTypeCode, p.AreaUnit, p.SourceStatus, p.SourceStatusCode}
	texts = append(texts, p.BagBuildingIDs...)
	for k, v := range p.SourceKeys {
		texts = append(texts, k, v)
	}
	for _, c := range p.Clusters {
		texts = append(texts, c.ID, c.Code, c.Name, c.Kind, c.KindCode)
	}
	for _, a := range p.Areas {
		texts = append(texts, a.Kind, a.KindCode, a.Unit, a.StartDate, a.EndDate)
		if math.IsNaN(a.Value) || math.IsInf(a.Value, 0) || a.Value < 0 || a.Value > 1e9 {
			return fail(422, "Ongeldige oppervlaktemeting")
		}
	}
	for _, text := range texts {
		if strings.ContainsRune(text, 0) {
			return fail(422, "Een vastgoedveld bevat een ongeldig nulkarakter")
		}
	}
	// Resource collections are sets. A different response order must not trigger re-review.
	sort.Strings(p.BagBuildingIDs)
	sort.Slice(p.Clusters, func(i, j int) bool {
		a, _ := json.Marshal(p.Clusters[i])
		b, _ := json.Marshal(p.Clusters[j])
		return string(a) < string(b)
	})
	sort.Slice(p.Areas, func(i, j int) bool {
		a, _ := json.Marshal(p.Areas[i])
		b, _ := json.Marshal(p.Areas[j])
		return string(a) < string(b)
	})
	raw, e := json.Marshal(p.propertyDetails)
	if e != nil {
		return fail(422, "Ongeldige vastgoedkenmerken")
	}
	if len(raw) > 16000 {
		return fail(422, "Te veel vastgoedkenmerken")
	}
	for _, v := range []string{p.BagObjectID, p.BagAddressID, p.ComplexID, p.ComplexName, p.ObjectType, p.ObjectTypeCode, p.AreaType, p.AreaTypeCode, p.AreaUnit, p.SourceStatus, p.SourceStatusCode} {
		if len(v) > 512 {
			return fail(422, "Vastgoedkenmerk is te lang")
		}
	}
	return nil
}
func upsertCatalogRows(ctx context.Context, tx pgx.Tx, org, source string, rows []catalogRow) error {
	for _, p := range rows {
		if e := normalizeCatalogRow(&p); e != nil {
			return e
		}
		details, _ := json.Marshal(p.propertyDetails)
		_, e := tx.Exec(ctx, `INSERT INTO properties(id,org_id,source_id,source_object_id,object_number,address,postcode,city,details,link_state,fetched_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'linked',now())
 ON CONFLICT(org_id,source_id,source_object_id) WHERE source_id IS NOT NULL DO UPDATE SET object_number=EXCLUDED.object_number,address=EXCLUDED.address,postcode=EXCLUDED.postcode,city=EXCLUDED.city,details=EXCLUDED.details,fetched_at=now(),revision=properties.revision+CASE WHEN (properties.object_number,properties.address,properties.postcode,properties.city,properties.details) IS DISTINCT FROM (EXCLUDED.object_number,EXCLUDED.address,EXCLUDED.postcode,EXCLUDED.city,EXCLUDED.details) THEN 1 ELSE 0 END`, id(), org, source, p.SourceObjectID, p.ObjectNumber, p.Address, p.Postcode, p.City, details)
		if e != nil {
			return e
		}
	}
	return nil
}
func catalogFingerprint(ctx context.Context, q querier, org, source string) (string, error) {
	var out string
	e := q.QueryRow(ctx, `SELECT md5(COALESCE(jsonb_agg(jsonb_build_array(id,revision) ORDER BY id)::text,'[]')) FROM properties WHERE org_id=$1 AND source_id=$2`, org, source).Scan(&out)
	return out, e
}
func auditProperty(ctx context.Context, tx pgx.Tx, org, property, inspection, user, action string, detail any) error {
	raw, e := json.Marshal(detail)
	if e != nil {
		return e
	}
	_, e = tx.Exec(ctx, `INSERT INTO property_events(id,org_id,property_id,inspection_id,actor_id,action,detail) VALUES($1,$2,$3,$4,$5,$6,$7)`, id(), org, property, nullableID(inspection), user, action, raw)
	return e
}

// Call with the inspection locked. Revoking leases prevents old-context inference from committing.
func invalidatePropertyContext(ctx context.Context, tx pgx.Tx, org, inspection, provider string) error {
	if provider != "baseten" {
		provider = "mock"
	}
	for _, sql := range []string{
		`UPDATE processing_jobs SET status='pending',attempts=0,last_error='',run_token=NULL,lease_until=NULL,next_attempt_at=now() WHERE org_id=$1 AND inspection_id=$2`,
		`UPDATE norm_assessments SET previous_reviewed_outcome=COALESCE(reviewed_outcome,previous_reviewed_outcome),previous_review_note=CASE WHEN reviewed_outcome IS NOT NULL THEN review_note ELSE previous_review_note END,stale=true,version=version+1 WHERE org_id=$1 AND inspection_id=$2`,
		`UPDATE batches SET status=CASE WHEN status='excluded' THEN status ELSE 'pending' END,version=version+1 WHERE org_id=$1 AND inspection_id=$2`,
		`UPDATE rooms SET generation=generation+1,approved_generation=NULL,reviewed_at=NULL WHERE org_id=$1 AND inspection_id=$2`,
		`UPDATE format_answers SET status=CASE WHEN status='confirmed' THEN 'suggested' ELSE status END,reviewed_at=NULL,version=version+1 WHERE org_id=$1 AND inspection_id=$2`,
	} {
		if _, e := tx.Exec(ctx, sql, org, inspection); e != nil {
			return e
		}
	}
	_, e := tx.Exec(ctx, `INSERT INTO scope_jobs(room_id,org_id,inspection_id,provider) SELECT id,org_id,inspection_id,$3 FROM rooms WHERE org_id=$1 AND inspection_id=$2 AND category_id IS NOT NULL ON CONFLICT(room_id) DO UPDATE SET status='pending',attempts=0,run_token=NULL,lease_until=NULL,next_attempt_at=now(),last_error=''`, org, inspection, provider)
	return e
}
func (a *app) adoptPropertyContext(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		ContextVersion   int `json:"contextVersion"`
		PropertyRevision int `json:"propertyRevision"`
	}
	if e := readJSON(w, r, &in); e != nil {
		return e
	}
	tx, u, e := a.edit(r)
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	org, inspection := r.PathValue("org"), r.PathValue("inspection")
	var pid string
	var version int
	var old json.RawMessage
	if e = tx.QueryRow(r.Context(), `SELECT property_id,property_context_version,property_snapshot FROM inspections WHERE id=$1 AND org_id=$2`, inspection, org).Scan(&pid, &version, &old); e != nil {
		return e
	}
	if version != in.ContextVersion {
		return fail(409, "De inspectiecontext is gewijzigd; vergelijk opnieuw")
	}
	if _, e = tx.Exec(r.Context(), `SELECT id FROM properties WHERE id=$1 AND org_id=$2 FOR SHARE`, pid, org); e != nil {
		return e
	}
	p, e := readProperty(r.Context(), tx, org, pid)
	if e != nil {
		return e
	}
	if p.Revision != in.PropertyRevision {
		return fail(409, "De woninggegevens zijn gewijzigd; vergelijk opnieuw")
	}
	if p.LinkState == "merged" {
		return fail(409, "Deze woning is samengevoegd; herlaad het dossier")
	}
	raw, _ := json.Marshal(p)
	if _, e = tx.Exec(r.Context(), `UPDATE inspections SET property_snapshot=$1,property_context_version=property_context_version+1 WHERE id=$2 AND org_id=$3`, raw, inspection, org); e != nil {
		return e
	}
	if e = invalidatePropertyContext(r.Context(), tx, org, inspection, a.imageProvider); e != nil {
		return e
	}
	if e = auditProperty(r.Context(), tx, org, pid, inspection, u.ID, "adopt_context", map[string]any{"before": old, "after": p}); e != nil {
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	send(w, 200, map[string]int{"contextVersion": version + 1})
	return nil
}
func (a *app) linkProperty(w http.ResponseWriter, r *http.Request) error {
	u, e := a.admin(r)
	if e != nil {
		return e
	}
	var in struct {
		TargetPropertyID string `json:"targetPropertyId"`
		Revision         int    `json:"revision"`
		TargetRevision   int    `json:"targetRevision"`
	}
	if e = readJSON(w, r, &in); e != nil {
		return e
	}
	org, pid := r.PathValue("org"), r.PathValue("property")
	if !validID(pid) || !validID(in.TargetPropertyID) || pid == in.TargetPropertyID {
		return fail(400, "Kies een andere bronwoning")
	}
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	if _, e = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, pid); e != nil {
		return e
	}
	// Lock affected dossiers first, in a stable order, matching ordinary inspection edits.
	rows, e := tx.Query(r.Context(), `SELECT id FROM inspections WHERE org_id=$1 AND property_id=$2 AND status='draft' ORDER BY id FOR UPDATE`, org, pid)
	if e != nil {
		return e
	}
	ids := []string{}
	for rows.Next() {
		var iid string
		if e = rows.Scan(&iid); e != nil {
			rows.Close()
			return e
		}
		ids = append(ids, iid)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	locked, e := tx.Query(r.Context(), `SELECT id FROM properties WHERE org_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE`, org, []string{pid, in.TargetPropertyID})
	if e != nil {
		return e
	}
	for locked.Next() {
		var v string
		if e = locked.Scan(&v); e != nil {
			locked.Close()
			return e
		}
	}
	e = locked.Err()
	locked.Close()
	if e != nil {
		return e
	}
	before, e := readProperty(r.Context(), tx, org, pid)
	if e != nil {
		return e
	}
	target, e := readProperty(r.Context(), tx, org, in.TargetPropertyID)
	if e != nil {
		return e
	}
	if before.LinkState != "provisional" || target.LinkState != "linked" || before.Revision != in.Revision || target.Revision != in.TargetRevision {
		return fail(409, "De woning of koppeling is gewijzigd; vergelijk opnieuw")
	}
	raw, _ := json.Marshal(target)
	for _, iid := range ids {
		var original json.RawMessage
		if e = tx.QueryRow(r.Context(), `SELECT property_snapshot FROM inspections WHERE id=$1 AND org_id=$2`, iid, org).Scan(&original); e != nil {
			return e
		}
		if _, e = tx.Exec(r.Context(), `UPDATE inspections SET property_id=$1,property_snapshot=$2,property_context_version=property_context_version+1 WHERE id=$3 AND org_id=$4`, target.ID, raw, iid, org); e != nil {
			return e
		}
		if e = invalidatePropertyContext(r.Context(), tx, org, iid, a.imageProvider); e != nil {
			return e
		}
		if e = auditProperty(r.Context(), tx, org, pid, iid, u.ID, "link_inspection", map[string]any{"before": original, "after": target}); e != nil {
			return e
		}
	}
	if _, e = tx.Exec(r.Context(), `UPDATE properties SET link_state='merged',merged_into=$1,revision=revision+1 WHERE id=$2 AND org_id=$3`, target.ID, pid, org); e != nil {
		return e
	}
	if e = auditProperty(r.Context(), tx, org, pid, "", u.ID, "link_property", map[string]any{"before": before, "after": target, "inspections": ids}); e != nil {
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	send(w, 200, map[string]any{"propertyId": target.ID, "inspections": len(ids)})
	return nil
}
