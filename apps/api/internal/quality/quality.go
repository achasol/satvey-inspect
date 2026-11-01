package quality

import (
	"net/url"
	"satvey/inspect/internal/fault"
	"satvey/inspect/internal/identity"
	"strings"
)

type Condition struct {
	QuestionID string `json:"questionId"`
	Equals     string `json:"equals"`
}
type Question struct {
	ID            string     `json:"id"`
	Title         string     `json:"title"`
	Kind          string     `json:"kind"`
	Required      bool       `json:"required"`
	Instruction   string     `json:"instruction"`
	TalkingPrompt string     `json:"talkingPrompt"`
	RuleID        string     `json:"ruleId"`
	ElementID     string     `json:"elementId"`
	Choices       []string   `json:"choices"`
	Unit          string     `json:"unit"`
	Evidence      string     `json:"evidence"`
	MinPhotos     int        `json:"minPhotos"`
	Condition     *Condition `json:"condition,omitempty"`
}
type Scope struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	NormRoom   string     `json:"normRoom"`
	Property   bool       `json:"property"`
	Required   bool       `json:"required"`
	Repeatable bool       `json:"repeatable"`
	Questions  []Question `json:"questions"`
}
type Format struct {
	SigningPolicy   string  `json:"signingPolicy"`
	Acknowledgement string  `json:"acknowledgement"`
	ID              string  `json:"id"`
	FormatID        string  `json:"formatId"`
	Number          int     `json:"number"`
	Name            string  `json:"name"`
	Description     string  `json:"description"`
	Kind            string  `json:"kind"`
	NormVersionID   *string `json:"normVersionId"`
	Status          string  `json:"status"`
	Revision        int     `json:"revision"`
	Scopes          []Scope `json:"scopes"`
}

type Example struct {
	ID         string `json:"id"`
	Outcome    string `json:"outcome"`
	Caption    string `json:"caption"`
	Transcript string `json:"transcript,omitempty"`
	AssetID    string `json:"assetId,omitempty"`
}
type ScoreReference struct {
	ID      string `json:"id"`
	AssetID string `json:"assetId"`
	Name    string `json:"name"`
	MIME    string `json:"mime"`
	Caption string `json:"caption"`
}
type ScoreLevel struct {
	Score                int              `json:"score"`
	Label                string           `json:"label"`
	Description          string           `json:"description"`
	Outcome              string           `json:"outcome"`
	RepairResponsibility string           `json:"repairResponsibility"`
	CostResponsibility   string           `json:"costResponsibility"`
	References           []ScoreReference `json:"references"`
}
type Rule struct {
	ScoreLevels  []ScoreLevel `json:"scoreLevels,omitempty"`
	ElementID    string       `json:"elementId,omitempty"`
	ID           string       `json:"id"`
	Code         string       `json:"code"`
	Title        string       `json:"title"`
	Rooms        []string     `json:"rooms"`
	ObjectType   string       `json:"objectType"`
	Acceptable   string       `json:"acceptable"`
	Unacceptable string       `json:"unacceptable"`
	AIGuidance   string       `json:"aiGuidance"`
	Modalities   []string     `json:"modalities"`
	Priority     string       `json:"priority"`
	SourceURLs   []string     `json:"sourceUrls"`
	Examples     []Example    `json:"examples"`
}
type Source struct {
	Title     string `json:"title"`
	URL       string `json:"url"`
	CheckedAt string `json:"checkedAt"`
}
type Norms struct {
	ID          string   `json:"id"`
	FrameworkID string   `json:"frameworkId"`
	Number      int      `json:"number"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Status      string   `json:"status"`
	Revision    int      `json:"revision"`
	Rules       []Rule   `json:"rules"`
	Sources     []Source `json:"sources"`
}

func ValidateFormat(d *Format, norm *Norms, publish bool) error {
	if strings.TrimSpace(d.Name) == "" || len(d.Name) > 160 || len(d.Description) > 3000 || (d.Kind != "pre" && d.Kind != "final") || len(d.Scopes) == 0 || len(d.Scopes) > 40 {
		return fault.New(422, "Controleer naam, type en ruimtes")
	}
	if publish && (norm == nil || norm.Status != "published") {
		return fault.New(422, "Koppel eerst een gepubliceerd normenkader")
	}
	rules := map[string]Rule{}
	if norm != nil {
		for _, rule := range norm.Rules {
			rules[rule.ID] = rule
		}
	}
	ids := map[string]bool{}
	propertyCount, requiredCount, total := 0, 0, 0
	for _, s := range d.Scopes {
		if !identity.ValidID(s.ID) || ids[s.ID] || strings.TrimSpace(s.Name) == "" || len(s.Name) > 100 || len(s.NormRoom) > 100 || len(s.Questions) > 80 {
			return fault.New(422, "Controleer de ruimtecategorieën en unieke IDs")
		}
		ids[s.ID] = true
		if s.Property {
			propertyCount++
			if s.Repeatable {
				return fault.New(422, "Woning algemeen kan niet herhaald worden")
			}
		}
		if s.Required || s.Property {
			for _, q := range s.Questions {
				if q.Required {
					requiredCount++
				}
			}
		}
		preceding := map[string]Question{}
		linked := map[string]bool{}
		for _, q := range s.Questions {
			total++
			if !identity.ValidID(q.ID) || ids[q.ID] || strings.TrimSpace(q.Title) == "" || len(q.Title) > 240 || len(q.Instruction) > 3000 || len(q.TalkingPrompt) > 500 || len(q.Unit) > 40 || q.MinPhotos < 0 || q.MinPhotos > 20 {
				return fault.New(422, "Controleer de vragen en instructies")
			}
			ids[q.ID] = true
			if !Contains([]string{"boolean", "choice", "number", "text", "quality", "evidence"}, q.Kind) || !Contains([]string{"none", "photo", "statement", "photo_statement", "any"}, q.Evidence) {
				return fault.New(422, "Ongeldig antwoord- of bewijstype")
			}
			if q.Kind == "choice" {
				seen := map[string]bool{}
				if len(q.Choices) < 2 || len(q.Choices) > 20 {
					return fault.New(422, "Voeg 2 tot 20 antwoordopties toe")
				}
				for _, c := range q.Choices {
					if strings.TrimSpace(c) == "" || len(c) > 160 || seen[c] {
						return fault.New(422, "Antwoordopties moeten uniek en ingevuld zijn")
					}
					seen[c] = true
				}
			}
			if q.ElementID != "" && !identity.ValidID(q.ElementID) {
				return fault.New(422, "Ongeldig element")
			}
			if q.RuleID != "" {
				rule, ok := rules[q.RuleID]
				if !ok || linked[q.RuleID] {
					return fault.New(422, "Koppel elke norm maximaal eenmaal per ruimte, uit het gekozen kader")
				}
				if publish && !s.Property && !RuleApplies(rule, s.NormRoom) {
					return fault.New(422, "Een gekoppelde norm geldt niet voor deze ruimtecategorie")
				}
				linked[q.RuleID] = true
			}
			if q.Kind == "quality" && q.RuleID == "" {
				return fault.New(422, "Koppel een norm aan de kwaliteitsvraag")
			}
			if q.Condition != nil {
				parent, ok := preceding[q.Condition.QuestionID]
				if !ok || (parent.Kind != "boolean" && parent.Kind != "choice") || !parent.Required {
					return fault.New(422, "Een voorwaarde moet verwijzen naar een eerdere verplichte ja/nee- of keuzevraag")
				}
				if parent.Kind == "boolean" && !Contains([]string{"true", "false"}, q.Condition.Equals) || parent.Kind == "choice" && !Contains(parent.Choices, q.Condition.Equals) {
					return fault.New(422, "Kies een geldig antwoord voor de voorwaarde")
				}
			}
			preceding[q.ID] = q
		}
	}
	if propertyCount != 1 || total > 300 || publish && requiredCount == 0 {
		return fault.New(422, "Gebruik één categorie Woning algemeen en ten minste één verplichte vraag")
	}
	return nil
}
func Contains(values []string, value string) bool {
	for _, s := range values {
		if s == value {
			return true
		}
	}
	return false
}
func ValidOutcome(s string) bool {
	return s == "acceptable" || s == "unacceptable" || s == "not_assessable" || s == "not_applicable"
}
func SafeSource(raw string) bool {
	u, e := url.Parse(raw)
	return e == nil && u.Scheme == "https" && u.Host != "" && u.User == nil
}
func ValidateNorms(in Norms, publish bool) error {
	if strings.TrimSpace(in.Name) == "" || len(in.Name) > 160 || len(in.Description) > 3000 || len(in.Rules) > 40 {
		return fault.New(400, "Gebruik een naam en maximaal 40 maatregelen per kader")
	}
	if publish && len(in.Rules) == 0 {
		return fault.New(422, "Voeg minimaal één maatregel toe")
	}
	seen, codes, examples := map[string]bool{}, map[string]bool{}, map[string]bool{}
	for _, r := range in.Rules {
		if !identity.ValidID(r.ID) || seen[r.ID] || strings.TrimSpace(r.Code) == "" || len(r.Code) > 40 || codes[strings.ToLower(r.Code)] || strings.TrimSpace(r.Title) == "" || len(r.Title) > 160 || len(r.Rooms) == 0 || len(r.Rooms) > 20 || strings.TrimSpace(r.ObjectType) == "" || len(r.ObjectType) > 120 || len(r.Modalities) == 0 || len(r.Modalities) > 2 || len(r.Examples) > 6 {
			return fault.New(400, "Controleer codes, ruimtes, objecten en voorbeelden van de maatregelen")
		}
		if len(r.ScoreLevels) != 0 && len(r.ScoreLevels) != 6 {
			return fault.New(422, "Gebruik precies zes scoreniveaus")
		}
		levels := map[int]bool{}
		for _, level := range r.ScoreLevels {
			if level.Score < 1 || level.Score > 6 || levels[level.Score] || len(level.Label) > 100 || len(level.Description) > 3000 || len(level.References) > 6 {
				return fault.New(422, "Controleer de zes unieke scoreniveaus en referentiebestanden")
			}
			levels[level.Score] = true
			responsibility := func(value string) bool {
				return value == "corporation" || value == "resident" || value == "undetermined"
			}
			if !responsibility(level.RepairResponsibility) || !responsibility(level.CostResponsibility) {
				return fault.New(422, "Kies afzonderlijk wie herstelt en wie de kosten draagt")
			}
			if level.Outcome != "" && level.Outcome != "acceptable" && level.Outcome != "unacceptable" {
				return fault.New(422, "Kies acceptabel of niet acceptabel per scoreniveau")
			}
			if publish && (strings.TrimSpace(level.Label) == "" || strings.TrimSpace(level.Description) == "" || level.Outcome == "") {
				return fault.New(422, "Vul naam, omschrijving en uitkomst in voor ieder scoreniveau")
			}
			for _, ref := range level.References {
				if !identity.ValidID(ref.ID) || !identity.ValidID(ref.AssetID) || len(ref.Name) > 240 || len(ref.Caption) > 2000 || !(strings.HasPrefix(ref.MIME, "image/") || ref.MIME == "application/pdf") {
					return fault.New(422, "Controleer de scorereferenties")
				}
			}
		}
		seen[r.ID] = true
		codes[strings.ToLower(r.Code)] = true
		for _, room := range r.Rooms {
			if strings.TrimSpace(room) == "" || len(room) > 100 {
				return fault.New(400, "Gebruik ruimtenamen of * voor alle ruimtes")
			}
		}
		for _, m := range r.Modalities {
			if m != "photo" && m != "audio" {
				return fault.New(400, "Kies foto of audio als bewijssoort")
			}
		}
		if r.Priority != "low" && r.Priority != "medium" && r.Priority != "high" {
			return fault.New(400, "Kies een prioriteit")
		}
		if len(r.Acceptable) > 3000 || len(r.Unacceptable) > 3000 || len(r.AIGuidance) > 6500 || len(r.SourceURLs) > 8 {
			return fault.New(400, "De maatregel is te lang")
		}
		if publish && (strings.TrimSpace(r.Acceptable) == "" || strings.TrimSpace(r.Unacceptable) == "" || strings.TrimSpace(r.AIGuidance) == "") {
			return fault.New(422, "Vul acceptabel, niet acceptabel en AI-aandachtspunten in")
		}
		for _, u := range r.SourceURLs {
			if !SafeSource(u) {
				return fault.New(400, "Bronlinks moeten HTTPS gebruiken")
			}
		}
		accepted, rejected := false, false
		for _, ex := range r.Examples {
			if !identity.ValidID(ex.ID) || examples[ex.ID] || !ValidOutcome(ex.Outcome) || strings.TrimSpace(ex.Caption) == "" || len(ex.Caption) > 2000 || len(ex.Transcript) > 6000 || (ex.AssetID != "" && !identity.ValidID(ex.AssetID)) {
				return fault.New(400, "Controleer de voorbeelden")
			}
			examples[ex.ID] = true
			accepted = accepted || ex.Outcome == "acceptable"
			rejected = rejected || ex.Outcome == "unacceptable"
		}
		if publish && (!accepted || !rejected) {
			return fault.New(422, "Geef bij elke maatregel een acceptabel en een niet-acceptabel voorbeeld")
		}
	}
	return nil
}

func RuleApplies(rule Rule, room string) bool {
	for _, name := range rule.Rooms {
		if strings.TrimSpace(name) == "*" || strings.EqualFold(strings.TrimSpace(name), strings.TrimSpace(room)) {
			return true
		}
	}
	return false
}
