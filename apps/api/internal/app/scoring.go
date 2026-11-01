package app

import (
	"context"
	"strings"
)

type scoreDetail struct {
	Score                *int   `json:"score"`
	RepairResponsibility string `json:"repairResponsibility"`
	CostResponsibility   string `json:"costResponsibility"`
	Note                 string `json:"note"`
}

func validateScored(ctx context.Context, q querier, org, inspection, ruleID, outcome, status string, detail *scoreDetail) error {
	if ruleID == "" {
		if detail != nil && detail.Score != nil {
			return fail(422, "Deze vraag heeft geen scoreschaal")
		}
		return nil
	}
	var version *string
	if err := q.QueryRow(ctx, `SELECT norm_version_id FROM inspections WHERE id=$1 AND org_id=$2`, inspection, org).Scan(&version); err != nil {
		return err
	}
	if version == nil {
		return nil
	}
	document, err := readNorm(ctx, q, org, *version)
	if err != nil {
		return err
	}
	for _, rule := range document.Rules {
		if rule.ID != ruleID {
			continue
		}
		if len(rule.ScoreLevels) == 0 {
			if detail != nil && detail.Score != nil {
				return fail(422, "Dit criterium gebruikt geen numerieke score")
			}
			return nil
		}
		if status == "unanswerable" || outcome == "not_assessable" || outcome == "not_applicable" {
			if detail != nil && detail.Score != nil {
				return fail(422, "Gebruik geen score bij een niet te beoordelen of niet toepasselijke uitkomst")
			}
			return nil
		}
		if detail == nil || detail.Score == nil {
			return fail(422, "Bevestig een score voor "+rule.Title)
		}
		for _, level := range rule.ScoreLevels {
			if level.Score != *detail.Score {
				continue
			}
			if outcome != level.Outcome {
				return fail(422, "De uitkomst moet overeenkomen met het vastgelegde scorebeleid")
			}
			if detail.RepairResponsibility == "" {
				detail.RepairResponsibility = level.RepairResponsibility
			}
			if detail.CostResponsibility == "" {
				detail.CostResponsibility = level.CostResponsibility
			}
			valid := func(value string) bool { return contains([]string{"corporation", "resident", "undetermined"}, value) }
			if !valid(detail.RepairResponsibility) || !valid(detail.CostResponsibility) || len(detail.Note) > 2000 {
				return fail(422, "Controleer de herstel- en kostenverantwoordelijkheid")
			}
			if (detail.RepairResponsibility != level.RepairResponsibility || detail.CostResponsibility != level.CostResponsibility) && strings.TrimSpace(detail.Note) == "" {
				return fail(422, "Licht een afwijking van het verantwoordelijkheidsbeleid toe")
			}
			return nil
		}
		return fail(422, "Kies een score van 1 tot en met 6")
	}
	return fail(422, "Criterium ontbreekt in het vastgelegde kwaliteitskader")
}
