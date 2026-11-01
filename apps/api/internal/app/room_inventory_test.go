package app

import (
	"encoding/json"
	"testing"
)

func TestAdditionalRoomTypesPreserveQuestionsAndCustomNamesInFollowups(t *testing.T) {
	f := setup(t)
	property := formatScope{ID: id(), Name: "Woning algemeen", Property: true, Questions: []formatQuestion{}}
	kitchen := formatScope{ID: id(), Name: "Keuken", NormRoom: "Keuken", Required: true, Repeatable: false, Questions: []formatQuestion{{ID: id(), Title: "Keuken controleren", Kind: "text", Required: true, Evidence: "none"}}}
	doc, _ := testPublishedFormat(f, []formatScope{property, kitchen})
	path, _ := testFormatInspection(f, doc)
	first, gen := testRoom(f, path, kitchen.ID)
	f.request("PUT", path+"/rooms/"+first, map[string]any{"name": "Keuken beneden", "generation": gen}, 200)
	second := id()
	f.request("POST", path+"/rooms", map[string]any{"id": second, "name": "Keuken op zolder", "categoryId": kitchen.ID}, 201)
	f.request("POST", path+"/rooms", map[string]any{"id": second, "name": "Keuken op zolder", "categoryId": kitchen.ID}, 201)
	f.request("POST", path+"/rooms", map[string]any{"id": id(), "name": "Onbekend", "categoryId": id()}, 422)
	f.request("POST", path+"/rooms", map[string]any{"id": id(), "name": "Extra woning", "categoryId": property.ID}, 422)
	d := f.request("GET", path, nil, 200)
	if len(d["rooms"].([]any)) != 3 {
		t.Fatal("additional room was duplicated or lost")
	}
	for _, raw := range d["rooms"].([]any) {
		room := raw.(map[string]any)
		rid := room["id"].(string)
		answers := testAnswers(f, path, rid)
		if rid == first || rid == second {
			if room["categoryId"] != kitchen.ID || len(answers) != 1 || answers[0].QuestionID != kitchen.Questions[0].ID {
				t.Fatal("room lost its template type or questions")
			}
			for _, answer := range answers {
				answer.Status = "confirmed"
				answer.Value = json.RawMessage(`"Gecontroleerd"`)
				f.request("PUT", path+"/answers/"+answer.ID, answer, 200)
			}
		}
		testApprove(f, path, rid, "", 200)
	}
	f.request("POST", path+"/report", map[string]any{}, 201)
	follow := f.request("POST", path+"/followups", map[string]any{"id": id(), "version": dossierVersion(f, path), "formatVersionId": doc.ID}, 201)
	next := f.request("GET", "/orgs/"+f.org+"/inspections/"+follow["id"].(string), nil, 200)
	if len(next["rooms"].([]any)) != 3 {
		t.Fatal("followup changed the actual room inventory")
	}
	names := map[string]bool{}
	for _, raw := range next["rooms"].([]any) {
		names[raw.(map[string]any)["name"].(string)] = true
	}
	if !names["Keuken beneden"] || !names["Keuken op zolder"] || names["Keuken"] {
		t.Fatal("followup lost custom names or added a phantom default room")
	}
}
