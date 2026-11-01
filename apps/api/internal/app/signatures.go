package app

import (
	"satvey/inspect/internal/reporting"
	"strings"
)

const defaultSigningAcknowledgement = "Ondertekenaars bevestigen kennis te hebben genomen van de vastgelegde waarnemingen, afspraken en eventuele bezwaren."

type signingException struct {
	Outcome string `json:"outcome"`
	Note    string `json:"note"`
}

func validateSigningPolicy(signatures []signatureInput, exception *signingException, disagreement string) error {
	inspector, resident := false, false
	for _, s := range signatures {
		inspector = inspector || s.Role == "inspector"
		resident = resident || s.Role == "resident"
	}
	if !inspector {
		return fail(422, "De handtekening van de inspecteur is verplicht")
	}
	if len(disagreement) > 4000 {
		return fail(422, "Gebruik maximaal 4000 tekens voor het bezwaar")
	}
	if exception != nil {
		if resident || !contains([]string{"absent", "refused", "unable"}, exception.Outcome) || strings.TrimSpace(exception.Note) == "" || len(exception.Note) > 2000 {
			return fail(422, "Leg de reden voor niet ondertekenen vast; combineer deze niet met een bewonershandtekening")
		}
	} else if !resident {
		return fail(422, "Laat de bewoner tekenen of leg een ondertekenuitzondering vast")
	}
	return nil
}

type signatureInput = reporting.Input
type reportSignature = reporting.Signature

func validateSignatures(s []signatureInput) error { return reporting.ValidateSignatures(s) }
func prepareSignatures(s []reportSignature) error { return reporting.PrepareSignatures(s, reportDate) }
