package app

import (
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"time"
)

type activityInput struct {
	ID           string    `json:"id"`
	InspectionID string    `json:"inspectionId"`
	SessionID    string    `json:"sessionId"`
	RoomID       *string   `json:"roomId"`
	Phase        string    `json:"phase"`
	StartedAt    time.Time `json:"startedAt"`
	EndedAt      time.Time `json:"endedAt"`
}

func (a *app) activityEvents(w http.ResponseWriter, r *http.Request) error {
	u, _, err := a.access(r, true)
	if err != nil {
		return err
	}
	var in struct {
		Events []activityInput `json:"events"`
	}
	if err = readJSON(w, r, &in); err != nil {
		return err
	}
	if len(in.Events) == 0 || len(in.Events) > 128 {
		return fail(422, "Gebruik 1 tot 128 activiteitsfragmenten")
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	org := r.PathValue("org")
	now := time.Now()
	for _, event := range in.Events {
		duration := event.EndedAt.Sub(event.StartedAt)
		if !validID(event.ID) || !validID(event.InspectionID) || !validID(event.SessionID) || event.RoomID != nil && !validID(*event.RoomID) || !contains([]string{"capture", "review", "report"}, event.Phase) || duration <= 0 || duration > 30*time.Second || event.EndedAt.After(now.Add(5*time.Minute)) || event.StartedAt.Before(now.Add(-31*24*time.Hour)) {
			return fail(422, "Ongeldig automatisch activiteitsfragment")
		}
		var exists bool
		if err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM inspections i WHERE i.id=$1 AND i.org_id=$2 AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM rooms r WHERE r.id=$3 AND r.org_id=$2 AND r.inspection_id=i.id)))`, event.InspectionID, org, event.RoomID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return fail(404, "Dossier of ruimte niet gevonden")
		}
		// A duplicate must be the same event and actor, never another tenant's ID.
		var conflict bool
		if err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM inspection_activity WHERE id=$1 AND (org_id<>$2 OR user_id IS DISTINCT FROM $3::uuid OR inspection_id<>$4::uuid OR session_id<>$5::uuid OR phase<>$6 OR started_at<>$7 OR ended_at<>$8 OR room_id IS DISTINCT FROM $9::uuid))`, event.ID, org, u.ID, event.InspectionID, event.SessionID, event.Phase, event.StartedAt, event.EndedAt, event.RoomID).Scan(&conflict); err != nil {
			return err
		}
		if conflict {
			return fail(409, "Activiteits-id bestaat al met andere gegevens")
		}
		if _, err = tx.Exec(r.Context(), `INSERT INTO inspection_activity(id,org_id,inspection_id,user_id,session_id,room_id,phase,started_at,ended_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`, event.ID, org, event.InspectionID, u.ID, event.SessionID, event.RoomID, event.Phase, event.StartedAt, event.EndedAt); err != nil {
			return err
		}
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	send(w, 200, map[string]int{"accepted": len(in.Events)})
	return nil
}

type analyticsTime struct {
	UserID       string  `json:"userId"`
	InspectionID string  `json:"inspectionId"`
	Name         string  `json:"name"`
	Phase        string  `json:"phase"`
	Day          string  `json:"day"`
	Seconds      float64 `json:"seconds"`
}
type analyticsInspector struct {
	ID            string  `json:"id"`
	Name          string  `json:"name"`
	Visits        int     `json:"visits"`
	Reports       int     `json:"reports"`
	Versions      int     `json:"versions"`
	ActiveMinutes float64 `json:"activeMinutes"`
	MedianMinutes float64 `json:"medianMinutes"`
}
type propertyIssue struct {
	PropertyID   string `json:"propertyId"`
	Address      string `json:"address"`
	InspectionID string `json:"inspectionId"`
	Room         string `json:"room"`
	Criterion    string `json:"criterion"`
	Element      string `json:"element"`
	Score        *int   `json:"score"`
	Date         string `json:"date"`
}

func (a *app) analytics(w http.ResponseWriter, r *http.Request) error {
	if _, err := a.admin(r); err != nil {
		return err
	}
	zone, _ := time.LoadLocation("Europe/Amsterdam")
	if zone == nil {
		zone = time.UTC
	}
	now := time.Now().In(zone)
	from := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, zone).AddDate(0, 0, -29)
	to := time.Date(now.Year(), now.Month(), now.Day()+1, 0, 0, 0, 0, zone)
	if raw := r.URL.Query().Get("from"); raw != "" {
		value, err := time.ParseInLocation("2006-01-02", raw, zone)
		if err != nil {
			return fail(422, "Ongeldige begindatum")
		}
		from = value
	}
	if raw := r.URL.Query().Get("to"); raw != "" {
		value, err := time.ParseInLocation("2006-01-02", raw, zone)
		if err != nil {
			return fail(422, "Ongeldige einddatum")
		}
		to = value.AddDate(0, 0, 1)
	}
	if !to.After(from) || to.Sub(from) > 367*24*time.Hour {
		return fail(422, "Kies een periode van maximaal één jaar")
	}
	kind, inspector, property, complex := r.URL.Query().Get("kind"), r.URL.Query().Get("inspector"), strings.TrimSpace(r.URL.Query().Get("property")), strings.TrimSpace(r.URL.Query().Get("complex"))
	if kind != "" && !contains([]string{"pre", "final"}, kind) || inspector != "" && !validID(inspector) || len(property) > 240 || len(complex) > 240 {
		return fail(422, "Controleer de analyticsfilters")
	}
	org := r.PathValue("org")
	args := []any{org, from, to, kind, inspector, property, complex}
	const filter = ` i.org_id=$1 AND ($4='' OR i.kind=$4) AND ($6='' OR strpos(lower(COALESCE(i.property_snapshot->>'address',p.address)||' '||p.object_number),lower($6))>0 OR i.property_id::text=$6) AND ($7='' OR strpos(lower(COALESCE(i.property_snapshot->>'complexName','')),lower($7))>0) `
	// Sweep interval boundaries and assign overlapping seconds to one phase and
	// dossier per person. Two tabs/devices must never double the same labour time.
	sql := `WITH events AS MATERIALIZED(SELECT a.id,a.user_id,a.inspection_id,a.phase,greatest(a.started_at,$2) AS start,least(a.ended_at,$3) AS finish FROM inspection_activity a JOIN inspections i ON i.id=a.inspection_id AND i.org_id=a.org_id JOIN properties p ON p.id=i.property_id AND p.org_id=i.org_id WHERE ` + filter + ` AND a.started_at<$3 AND a.ended_at>$2 AND ($5='' OR a.user_id::text=$5)),
 boundaries AS(SELECT user_id,start AS at FROM events UNION SELECT user_id,finish FROM events UNION SELECT DISTINCT e.user_id,d.day AT TIME ZONE 'Europe/Amsterdam' FROM events e CROSS JOIN generate_series($2::timestamptz AT TIME ZONE 'Europe/Amsterdam',$3::timestamptz AT TIME ZONE 'Europe/Amsterdam',interval '1 day') d(day)),
 spans AS(SELECT user_id,at,lead(at) OVER(PARTITION BY user_id ORDER BY at) AS finish FROM boundaries),
 observed AS(SELECT chosen.user_id,chosen.inspection_id,chosen.phase,s.at,s.finish FROM spans s JOIN LATERAL(SELECT e.* FROM events e WHERE e.user_id=s.user_id AND e.start<=s.at AND e.finish>=s.finish ORDER BY CASE e.phase WHEN 'capture' THEN 1 WHEN 'review' THEN 2 ELSE 3 END,e.start DESC,e.id DESC LIMIT 1) chosen ON true WHERE s.finish>s.at)
 SELECT o.user_id AS "userId",o.inspection_id AS "inspectionId",COALESCE(u.name,'Voormalige gebruiker') AS name,o.phase,to_char(o.at AT TIME ZONE 'Europe/Amsterdam','YYYY-MM-DD') AS day,sum(extract(epoch FROM(o.finish-o.at)))::float8 AS seconds FROM observed o LEFT JOIN users u ON u.id=o.user_id GROUP BY o.user_id,o.inspection_id,u.name,o.phase,day ORDER BY day`
	raw, err := list(r.Context(), a.db, sql, args...)
	if err != nil {
		return err
	}
	times := []analyticsTime{}
	if err = json.Unmarshal(raw, &times); err != nil {
		return err
	}
	inspectors := map[string]*analyticsInspector{}
	perVisit := map[string]map[string]float64{}
	phaseSeconds := map[string]float64{}
	trend := map[string]map[string]float64{}
	totalSeconds := 0.0
	for _, row := range times {
		if inspectors[row.UserID] == nil {
			inspectors[row.UserID] = &analyticsInspector{ID: row.UserID, Name: row.Name}
		}
		inspectors[row.UserID].ActiveMinutes += row.Seconds / 60
		totalSeconds += row.Seconds
		phaseSeconds[row.Phase] += row.Seconds
		if trend[row.Day] == nil {
			trend[row.Day] = map[string]float64{}
		}
		trend[row.Day][row.Phase] += row.Seconds / 60
		if perVisit[row.UserID] == nil {
			perVisit[row.UserID] = map[string]float64{}
		}
		perVisit[row.UserID][row.InspectionID] += row.Seconds / 60
	}
	reports, err := list(r.Context(), a.db, `SELECT r.snapshot,r.inspection_id AS "inspectionId",r.created_by AS "userId",u.name,r.number,r.created_at AS "createdAt",i.property_id AS "propertyId",COALESCE(i.property_snapshot->>'address',p.address) AS address FROM reports r JOIN inspections i ON i.id=r.inspection_id AND i.org_id=r.org_id JOIN properties p ON p.id=i.property_id AND p.org_id=i.org_id JOIN users u ON u.id=r.created_by WHERE `+filter+` AND r.created_at>=$2 AND r.created_at<$3 AND ($5='' OR r.created_by::text=$5) ORDER BY r.created_at`, args...)
	if err != nil {
		return err
	}
	var reportRows []struct {
		Snapshot                                        json.RawMessage
		InspectionID, UserID, Name, PropertyID, Address string
		Number                                          int
		CreatedAt                                       time.Time
	}
	if err = json.Unmarshal(reports, &reportRows); err != nil {
		return err
	}
	completedByDay := map[string]int{}
	completed := map[string]bool{}
	latest := map[string]int{}
	revisions := 0
	for index, row := range reportRows {
		if inspectors[row.UserID] == nil {
			inspectors[row.UserID] = &analyticsInspector{ID: row.UserID, Name: row.Name}
		}
		if row.Number == 1 {
			inspectors[row.UserID].Reports++
			completed[row.InspectionID] = true
			completedByDay[row.CreatedAt.In(zone).Format("2006-01-02")]++
		} else {
			inspectors[row.UserID].Versions++
			revisions++
		}
		latest[row.InspectionID] = index
	}
	issues := []propertyIssue{}
	issueCounts := map[string]int{}
	roomCounts := map[string]int{}
	properties := map[string]map[string]any{}
	for _, index := range latest {
		row := reportRows[index]
		var doc struct {
			Inspection  struct{ ID string }
			Rooms       []struct{ ID, Name string }
			Batches     []pdfBatch
			Answers     []formatAnswer
			Assessments []pdfAssessment
			Norms       *normDocument
			Format      *formatDocument
		}
		if err = json.Unmarshal(row.Snapshot, &doc); err != nil {
			return err
		}
		seen := map[string]bool{}
		add := func(roomID, ruleID, title string, score *scoreDetail) {
			key := roomID + ":" + ruleID
			if seen[key] {
				return
			}
			seen[key] = true
			roomName, element := roomID, ""
			for _, room := range doc.Rooms {
				if room.ID == roomID {
					roomName = room.Name
				}
			}
			if doc.Norms != nil {
				for _, rule := range doc.Norms.Rules {
					if rule.ID == ruleID {
						title = rule.Title
						element = rule.ObjectType
					}
				}
			}
			var rating *int
			if score != nil {
				rating = score.Score
			}
			issues = append(issues, propertyIssue{PropertyID: row.PropertyID, Address: row.Address, InspectionID: row.InspectionID, Room: roomName, Criterion: title, Element: element, Score: rating, Date: row.CreatedAt.In(zone).Format("2006-01-02")})
			issueCounts[title]++
			roomCounts[roomName]++
			if properties[row.PropertyID] == nil {
				properties[row.PropertyID] = map[string]any{"id": row.PropertyID, "address": row.Address, "issues": 0}
			}
			properties[row.PropertyID]["issues"] = properties[row.PropertyID]["issues"].(int) + 1
		}
		for _, answer := range doc.Answers {
			if answer.Status != "confirmed" || answer.Outcome != "unacceptable" {
				continue
			}
			ruleID, title := answer.QuestionID, "Inspectieresultaat"
			if doc.Format != nil {
				for _, scope := range doc.Format.Scopes {
					for _, question := range scope.Questions {
						if question.ID == answer.QuestionID {
							title = question.Title
							if question.RuleID != "" {
								ruleID = question.RuleID
							}
						}
					}
				}
			}
			add(answer.RoomID, ruleID, title, answer.ScoreDetail)
		}
		for _, assessment := range doc.Assessments {
			if assessment.Outcome != "unacceptable" {
				continue
			}
			room := ""
			for _, batch := range doc.Batches {
				if batch.ID == assessment.BatchID {
					room = batch.RoomID
				}
			}
			add(room, assessment.RuleID, "Kwaliteitsbeoordeling", assessment.ScoreDetail)
		}
	}
	listInspectors := []*analyticsInspector{}
	for key, row := range inspectors {
		values := []float64{}
		for _, minutes := range perVisit[key] {
			values = append(values, minutes)
		}
		sort.Float64s(values)
		row.Visits = len(values)
		if len(values) > 0 {
			row.MedianMinutes = (values[(len(values)-1)/2] + values[len(values)/2]) / 2
		}
		listInspectors = append(listInspectors, row)
	}
	sort.Slice(listInspectors, func(i, j int) bool { return listInspectors[i].Name < listInspectors[j].Name })
	days := []map[string]any{}
	for day := from; day.Before(to); day = day.AddDate(0, 0, 1) {
		label := day.Format("2006-01-02")
		days = append(days, map[string]any{"day": label, "completed": completedByDay[label], "capture": trend[label]["capture"], "review": trend[label]["review"], "report": trend[label]["report"]})
	}
	propertyList := []map[string]any{}
	for _, p := range properties {
		propertyList = append(propertyList, p)
	}
	sort.Slice(propertyList, func(i, j int) bool { return propertyList[i]["issues"].(int) > propertyList[j]["issues"].(int) })
	var agreements int
	if err = a.db.QueryRow(r.Context(), `SELECT count(*) FROM inspection_agreements ag JOIN inspections i ON i.id=ag.inspection_id AND i.org_id=ag.org_id JOIN properties p ON p.id=i.property_id AND p.org_id=i.org_id WHERE `+filter+` AND ($5='' OR COALESCE(i.assigned_to,i.created_by)::text=$5) AND ag.status IN ('open','disputed') AND i.created_at<$3 AND i.created_at>=$2`, args...).Scan(&agreements); err != nil {
		return err
	}
	send(w, 200, map[string]any{"generatedAt": time.Now(), "from": from.Format("2006-01-02"), "to": to.AddDate(0, 0, -1).Format("2006-01-02"), "summary": map[string]any{"completedVisits": len(completed), "activeMinutes": totalSeconds / 60, "reportRevisions": revisions, "propertyIssues": len(issues), "openAgreements": agreements, "measuredVisits": len(uniqueMeasured(times))}, "inspectors": listInspectors, "trend": days, "phaseSeconds": phaseSeconds, "criteria": issueCounts, "rooms": roomCounts, "properties": propertyList, "issues": issues})
	return nil
}
func uniqueMeasured(rows []analyticsTime) map[string]bool {
	out := map[string]bool{}
	for _, row := range rows {
		out[row.InspectionID] = true
	}
	return out
}
