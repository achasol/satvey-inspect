package app

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

func readableReportTint(tint string) string {
	if len(tint) != 7 || !strings.HasPrefix(tint, "#") {
		return "#536044"
	}
	value, err := strconv.ParseUint(tint[1:], 16, 24)
	if err != nil {
		return "#536044"
	}
	rgb := []float64{float64(value >> 16), float64((value >> 8) & 255), float64(value & 255)}
	contrast := func() float64 {
		linear := []float64{}
		for _, v := range rgb {
			c := v / 255
			if c <= .04045 {
				linear = append(linear, c/12.92)
			} else {
				linear = append(linear, math.Pow((c+.055)/1.055, 2.4))
			}
		}
		return 1.05 / (linear[0]*.2126 + linear[1]*.7152 + linear[2]*.0722 + .05)
	}
	for contrast() < 4.5 {
		for index := range rgb {
			rgb[index] *= .9
		}
	}
	return fmt.Sprintf("#%02x%02x%02x", int(math.Round(rgb[0])), int(math.Round(rgb[1])), int(math.Round(rgb[2])))
}
func responsibilityLabel(value string) string {
	switch value {
	case "corporation":
		return "Corporatie"
	case "resident":
		return "Bewoner"
	default:
		return "Nog te bepalen"
	}
}
func (s scoreDetail) RepairLabel() string { return responsibilityLabel(s.RepairResponsibility) }
func (s scoreDetail) CostLabel() string   { return responsibilityLabel(s.CostResponsibility) }

// Give each embedded photo one stable destination and keep the gallery for
// photos that are not already illustrated beside a result or agreement.
// Legacy reports retain their original gallery-only rendering.
func prepareIllustratedEvidence(doc *pdfDocument) {
	used := map[string]bool{}
	anchor := func(photos []pdfPhoto) {
		for index := range photos {
			photo := &photos[index]
			if !used[photo.ID] {
				photo.Anchor = "photo-" + photo.ID
				used[photo.ID] = true
			}
		}
	}
	for i := range doc.Sections {
		room := &doc.Sections[i]
		for j := range room.Answers {
			anchor(room.Answers[j].Photos)
		}
		for j := range room.Observations {
			anchor(room.Observations[j].Photos)
		}
		for j := range room.Assessments {
			anchor(room.Assessments[j].Photos)
		}
	}
	for i := range doc.AgreementSections {
		anchor(doc.AgreementSections[i].Photos)
	}
	for i := range doc.Sections {
		room := &doc.Sections[i]
		remaining := []pdfPhoto{}
		for _, photo := range room.Photos {
			if !used[photo.ID] {
				remaining = append(remaining, photo)
			}
		}
		room.Photos = remaining
		room.PhotoRows = nil
		for first := 0; first < len(remaining); first += 2 {
			end := first + 2
			if end > len(remaining) {
				end = len(remaining)
			}
			room.PhotoRows = append(room.PhotoRows, remaining[first:end])
		}
	}
}
