package reporting

import (
	"fmt"
	"math"
	"satvey/inspect/internal/fault"
	"strings"
	"time"
)

type Point struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}
type Annotation struct {
	Tool   string  `json:"tool"`
	Color  string  `json:"color"`
	Points []Point `json:"points"`
}

func ValidateAnnotations(shapes []Annotation) error {
	if shapes == nil || len(shapes) > 200 {
		return fault.New(422, "Maximaal 200 markeringen per foto")
	}
	total := 0
	for _, s := range shapes {
		if s.Tool != "pen" && s.Tool != "arrow" && s.Tool != "ellipse" {
			return fault.New(422, "Onbekend tekengereedschap")
		}
		if s.Color != "#dc2626" && s.Color != "#eab308" && s.Color != "#2563eb" {
			return fault.New(422, "Onbekende markeringskleur")
		}
		if len(s.Points) < 2 || (s.Tool != "pen" && len(s.Points) != 2) {
			return fault.New(422, "Ongeldige markering")
		}
		total += len(s.Points)
		if total > 12000 {
			return fault.New(422, "Te veel tekenpunten; vereenvoudig de markeringen")
		}
		for _, p := range s.Points {
			if math.IsNaN(p.X) || math.IsInf(p.X, 0) || math.IsNaN(p.Y) || math.IsInf(p.Y, 0) || p.X < 0 || p.X > 1 || p.Y < 0 || p.Y > 1 {
				return fault.New(422, "Markering valt buiten de foto")
			}
		}
	}
	return nil
}

type Input struct {
	Name    string    `json:"name"`
	Role    string    `json:"role"`
	Strokes [][]Point `json:"strokes"`
}

type Signature struct {
	Input
	SignedAt    time.Time `json:"signedAt"`
	CollectedBy string    `json:"collectedBy"`
	Path        string    `json:"-"`
	RoleLabel   string    `json:"-"`
	DateLabel   string    `json:"-"`
}

func ValidateSignatures(signatures []Input) error {
	if len(signatures) > 10 {
		return fault.New(422, "Maximaal tien ondertekenaars per inspectie")
	}
	for _, signature := range signatures {
		if strings.TrimSpace(signature.Name) == "" || len(signature.Name) > 120 || (signature.Role != "inspector" && signature.Role != "resident" && signature.Role != "other") {
			return fault.New(422, "Vul de naam en rol van elke ondertekenaar in")
		}
		if len(signature.Strokes) == 0 || len(signature.Strokes) > 100 {
			return fault.New(422, "Zet een handtekening bij elke ondertekenaar")
		}
		total, visible := 0, false
		for _, stroke := range signature.Strokes {
			if len(stroke) < 2 {
				return fault.New(422, "Teken een volledige handtekening")
			}
			total += len(stroke)
			if total > 3000 {
				return fault.New(422, "De handtekening bevat te veel tekenpunten; wis deze en teken opnieuw")
			}
			for _, point := range stroke {
				if math.IsNaN(point.X) || math.IsNaN(point.Y) || math.IsInf(point.X, 0) || math.IsInf(point.Y, 0) || point.X < 0 || point.X > 1 || point.Y < 0 || point.Y > 1 {
					return fault.New(422, "De handtekening valt buiten het tekenveld")
				}
				visible = visible || point != stroke[0]
			}
		}
		if !visible {
			return fault.New(422, "Teken een volledige handtekening")
		}
	}
	return nil
}

func PrepareSignatures(signatures []Signature, reportDate func(time.Time) string) error {
	for i := range signatures {
		s := &signatures[i]
		if err := ValidateSignatures([]Input{s.Input}); err != nil {
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
