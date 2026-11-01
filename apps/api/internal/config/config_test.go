package config

import (
	"encoding/base64"
	"strings"
	"testing"
)

func production() map[string]string {
	return map[string]string{
		"LEGAL_ENTITY": "Satvey", "HOSTING_REGION": "EU", "SUPPORT_EMAIL": "support@example.org", "PRIVACY_POLICY_URL": "https://inspect.example.org/privacy-policy",
		"APP_ENV": "production", "APP_URL": "https://inspect.example.org", "ALLOW_HTTP_OIDC": "false", "ALLOW_HTTP_PROPERTY_API": "false", "ALLOW_MOCK_ANALYSIS": "false",
		"APP_ENCRYPTION_KEY": base64.StdEncoding.EncodeToString(make([]byte, 32)), "PROPERTY_ENCRYPTION_KEY": base64.StdEncoding.EncodeToString(make([]byte, 32)),
		"DATABASE_URL": "postgres://satvey:a-long-random-database-password@postgres/satvey", "S3_ENDPOINT": "http://rustfs:9000", "S3_BUCKET": "evidence", "S3_ACCESS_KEY": "deployment-key", "S3_SECRET_KEY": "a-long-random-object-password",
		"IMAGE_ANALYSIS_PROVIDER": "baseten", "TRANSCRIPTION_PROVIDER": "baseten", "BASETEN_KEY": "configured", "PDF_RENDERER_URL": "http://pdf:3000", "SMTP_ADDR": "smtp.example.org:587", "SMTP_FROM": "inspect@example.org", "SMTP_TLS": "starttls", "TRUSTED_PROXY_CIDRS": "172.30.0.3/32",
	}
}
func TestProductionValidation(t *testing.T) {
	for _, tc := range []struct{ name, key, value string }{
		{"missing operator", "LEGAL_ENTITY", ""}, {"invalid privacy", "PRIVACY_POLICY_URL", "http://example.org"}, {"missing support", "SUPPORT_EMAIL", ""},
		{"http origin", "APP_URL", "http://inspect.example.org"}, {"origin path", "APP_URL", "https://inspect.example.org/app"}, {"origin credentials", "APP_URL", "https://user:pass@inspect.example.org"}, {"wildcard origin", "TRUSTED_ORIGINS", "*"},
		{"mock", "IMAGE_ANALYSIS_PROVIDER", "mock"}, {"auto", "IMAGE_ANALYSIS_PROVIDER", "auto"}, {"missing inference", "BASETEN_KEY", ""}, {"disabled transcription", "TRANSCRIPTION_PROVIDER", "disabled"},
		{"http oidc", "ALLOW_HTTP_OIDC", "true"}, {"unset flag", "ALLOW_MOCK_ANALYSIS", ""}, {"http property", "ALLOW_HTTP_PROPERTY_API", "true"},
		{"bad key", "APP_ENCRYPTION_KEY", "secret"}, {"property key", "PROPERTY_ENCRYPTION_KEY", ""}, {"default database", "DATABASE_URL", "postgres://satvey:satvey-local-db@postgres/satvey"},
		{"default storage", "S3_SECRET_KEY", "satvey-local-secret-change-me"}, {"missing storage", "S3_BUCKET", ""}, {"bad SMTP", "SMTP_ADDR", "mail"}, {"plaintext SMTP", "SMTP_TLS", "none"}, {"invalid sender", "SMTP_FROM", "bad"},
		{"trust every proxy", "TRUSTED_PROXY_CIDRS", "0.0.0.0/0"}, {"invalid proxy", "TRUSTED_PROXY_CIDRS", "host"}, {"renderer", "PDF_RENDERER_URL", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			values := production()
			values[tc.key] = tc.value
			if e := Validate(func(k string) string { return values[k] }, "serve"); e == nil {
				t.Fatal("unsafe production configuration accepted")
			}
		})
	}
	values := production()
	if e := Validate(func(k string) string { return values[k] }, "serve"); e != nil {
		t.Fatal(e)
	}
}
func TestMaintenanceDoesNotRequireInferenceOrSMTP(t *testing.T) {
	values := production()
	for _, k := range []string{"BASETEN_KEY", "SMTP_ADDR", "SMTP_FROM", "PDF_RENDERER_URL"} {
		delete(values, k)
	}
	for _, command := range []string{"migrate", "bootstrap", "storage-init"} {
		if e := Validate(func(k string) string { return values[k] }, command); e != nil {
			t.Fatalf("%s: %v", command, e)
		}
	}
}
func TestUnknownModesAndCommands(t *testing.T) {
	if Validate(func(string) string { return "" }, "destroy") == nil {
		t.Fatal("unknown command accepted")
	}
	if Validate(func(k string) string {
		if k == "APP_ENV" {
			return "prod"
		}
		return ""
	}, "serve") == nil {
		t.Fatal("unknown mode accepted")
	}
}
func TestErrorsDoNotContainCredentials(t *testing.T) {
	v := production()
	v["DATABASE_URL"] = "postgres://user:short-secret@postgres/db"
	e := Validate(func(k string) string { return v[k] }, "serve")
	if e == nil || strings.Contains(e.Error(), "short-secret") {
		t.Fatal("credential disclosure")
	}
}
