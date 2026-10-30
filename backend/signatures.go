package main

import (
	"fmt"
	"math"
	"strings"
	"time"
)

type signatureInput struct {
	Name    string              `json:"name"`
	Role    string              `json:"role"`
	Strokes [][]annotationPoint `json:"strokes"`
}

type reportSignature struct {
	signatureInput
	SignedAt    time.Time `json:"signedAt"`
	CollectedBy string    `json:"collectedBy"`
	Path        string    `json:"-"`
	RoleLabel   string    `json:"-"`
	DateLabel   string    `json:"-"`
}

func validateSignatures(signatures []signatureInput) error {
	if len(signatures) > 10 {
		return fail(422, "Maximaal tien ondertekenaars per inspectie")
	}
	for _, signature := range signatures {
		if strings.TrimSpace(signature.Name) == "" || len(signature.Name) > 120 || (signature.Role != "inspector" && signature.Role != "resident" && signature.Role != "other") {
			return fail(422, "Vul de naam en rol van elke ondertekenaar in")
		}
		if len(signature.Strokes) == 0 || len(signature.Strokes) > 100 {
			return fail(422, "Zet een handtekening bij elke ondertekenaar")
		}
		total, visible := 0, false
		for _, stroke := range signature.Strokes {
			if len(stroke) < 2 {
				return fail(422, "Teken een volledige handtekening")
			}
			total += len(stroke)
			if total > 3000 {
				return fail(422, "De handtekening bevat te veel tekenpunten; wis deze en teken opnieuw")
			}
			for _, point := range stroke {
				if math.IsNaN(point.X) || math.IsNaN(point.Y) || math.IsInf(point.X, 0) || math.IsInf(point.Y, 0) || point.X < 0 || point.X > 1 || point.Y < 0 || point.Y > 1 {
					return fail(422, "De handtekening valt buiten het tekenveld")
				}
				visible = visible || point != stroke[0]
			}
		}
		if !visible {
			return fail(422, "Teken een volledige handtekening")
		}
	}
	return nil
}

func prepareSignatures(signatures []reportSignature) error {
	for i := range signatures {
		s := &signatures[i]
		if err := validateSignatures([]signatureInput{s.signatureInput}); err != nil {
			return err
		}
		var path strings.Builder
		for _, stroke := range s.Strokes {
			for n, point := range stroke {
				command := "L"
				if n == 0 {
					command = "M"
				}
				fmt.Fprintf(&path, "%s%.2f %.2f ", command, point.X*600, point.Y*180)
			}
		}
		s.Path = path.String()
		s.RoleLabel = map[string]string{"inspector": "Inspecteur", "resident": "Bewoner", "other": "Overige aanwezige"}[s.Role]
		s.DateLabel = reportDate(s.SignedAt)
	}
	return nil
}
