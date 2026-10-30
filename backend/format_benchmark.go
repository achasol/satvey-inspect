package main

import (
	"context"
	"encoding/json"
	"sort"
)

type benchmarkRow struct {
	RuleID        string `json:"ruleId"`
	Room          string `json:"room"`
	Acceptable    int    `json:"acceptable"`
	Unacceptable  int    `json:"unacceptable"`
	NotAssessable int    `json:"notAssessable"`
	NotApplicable int    `json:"notApplicable"`
	Pending       int    `json:"pending"`
}

func (a *app) addFormatBenchmarks(ctx context.Context, org, version string, legacy json.RawMessage) (json.RawMessage, error) {
	rows := []benchmarkRow{}
	if e := json.Unmarshal(legacy, &rows); e != nil {
		return nil, e
	}
	groups := map[string]*benchmarkRow{}
	for i := range rows {
		row := rows[i]
		groups[row.RuleID+":"+row.Room] = &row
	}
	raw, e := list(ctx, a.db, `SELECT r.category_id AS "categoryId",r.generation,r.approved_generation AS approved,f.scopes,(SELECT COALESCE(jsonb_agg(to_jsonb(a)),'[]') FROM (`+answerSelect+` WHERE room_id=r.id AND org_id=r.org_id) a) AS answers FROM rooms r JOIN inspections i ON i.id=r.inspection_id AND i.org_id=r.org_id JOIN format_versions f ON f.id=i.format_version_id AND f.org_id=i.org_id WHERE i.org_id=$1 AND i.norm_version_id=$2`, org, version)
	if e != nil {
		return nil, e
	}
	var rooms []struct {
		CategoryID string `json:"categoryId"`
		Generation int
		Approved   *int
		Scopes     []formatScope
		Answers    []formatAnswer
	}
	if e = json.Unmarshal(raw, &rooms); e != nil {
		return nil, e
	}
	for _, room := range rooms {
		byQ := map[string]formatAnswer{}
		for _, answer := range room.Answers {
			byQ[answer.QuestionID] = answer
		}
		for _, scope := range room.Scopes {
			if scope.ID != room.CategoryID {
				continue
			}
			for _, question := range scope.Questions {
				if question.RuleID == "" || !questionActive(question, scope.Questions, byQ) {
					continue
				}
				key := question.RuleID + ":" + scope.NormRoom
				row := groups[key]
				if row == nil {
					row = &benchmarkRow{RuleID: question.RuleID, Room: scope.NormRoom}
					groups[key] = row
				}
				answer := byQ[question.ID]
				if room.Approved == nil || *room.Approved != room.Generation || (answer.Status != "confirmed" && answer.Status != "unanswerable") {
					row.Pending++
					continue
				}
				if answer.Status == "unanswerable" {
					row.NotAssessable++
					continue
				}
				switch answer.Outcome {
				case "acceptable":
					row.Acceptable++
				case "unacceptable":
					row.Unacceptable++
				case "not_applicable":
					row.NotApplicable++
				default:
					row.NotAssessable++
				}
			}
		}
	}
	rows = []benchmarkRow{}
	for _, row := range groups {
		rows = append(rows, *row)
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].Room == rows[j].Room {
			return rows[i].RuleID < rows[j].RuleID
		}
		return rows[i].Room < rows[j].Room
	})
	return json.Marshal(rows)
}
