package app

import (
	"satvey/inspect/internal/reporting"
)

type signatureInput = reporting.Input
type reportSignature = reporting.Signature

func validateSignatures(s []signatureInput) error { return reporting.ValidateSignatures(s) }
func prepareSignatures(s []reportSignature) error { return reporting.PrepareSignatures(s, reportDate) }
