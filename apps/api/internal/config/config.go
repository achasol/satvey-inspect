// Package config validates deployment configuration without opening network connections.
package config

import (
	"encoding/base64"
	"fmt"
	"net"
	"net/mail"
	"net/url"
	"strings"
)

type Lookup func(string) string

func Validate(get Lookup, command string) error {
	switch command {
	case "serve", "migrate", "bootstrap", "storage-init", "check-config", "rotate-secrets", "verify-restore":
	default:
		return fmt.Errorf("unknown command %q", command)
	}
	mode := get("APP_ENV")
	if mode != "" && mode != "development" && mode != "test" && mode != "production" {
		return fmt.Errorf("APP_ENV must be development, test or production")
	}
	if mode != "production" {
		return nil
	}
	for _, name := range []string{"ALLOW_HTTP_OIDC", "ALLOW_HTTP_PROPERTY_API", "ALLOW_MOCK_ANALYSIS"} {
		if get(name) != "false" {
			return fmt.Errorf("production requires %s=false", name)
		}
	}
	u, err := url.Parse(get("APP_URL"))
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return fmt.Errorf("production requires an HTTPS APP_URL containing only the public origin")
	}
	for _, origin := range strings.Split(get("TRUSTED_ORIGINS"), ",") {
		if origin != "" && strings.TrimRight(origin, "/") != strings.TrimRight(get("APP_URL"), "/") {
			return fmt.Errorf("production TRUSTED_ORIGINS must match APP_URL")
		}
	}
	for _, name := range []string{"APP_ENCRYPTION_KEY", "PROPERTY_ENCRYPTION_KEY"} {
		key, e := base64.StdEncoding.DecodeString(get(name))
		if e != nil || len(key) != 32 {
			return fmt.Errorf("%s must be 32 random bytes encoded as base64", name)
		}
	}
	if command == "rotate-secrets" {
		key, e := base64.StdEncoding.DecodeString(get("APP_ENCRYPTION_KEY_NEW"))
		if e != nil || len(key) != 32 {
			return fmt.Errorf("APP_ENCRYPTION_KEY_NEW must be a base64 32-byte key")
		}
	}
	if command != "storage-init" {
		db, e := url.Parse(get("DATABASE_URL"))
		if e != nil || (db.Scheme != "postgres" && db.Scheme != "postgresql") || db.Hostname() == "" || db.User == nil {
			return fmt.Errorf("DATABASE_URL is required")
		}
		password, _ := db.User.Password()
		if weak(password) {
			return fmt.Errorf("DATABASE_URL requires a non-default password of at least 20 characters")
		}
	}
	if command == "storage-init" || command == "serve" || command == "check-config" {
		if get("S3_ENDPOINT") == "" || get("S3_BUCKET") == "" || get("S3_ACCESS_KEY") == "" || get("S3_ACCESS_KEY") == "satvey-local" || weak(get("S3_SECRET_KEY")) {
			return fmt.Errorf("explicit non-default S3 credentials and endpoint/bucket are required")
		}
	}
	if command != "serve" && command != "check-config" {
		return nil
	}
	if get("IMAGE_ANALYSIS_PROVIDER") != "baseten" || get("TRANSCRIPTION_PROVIDER") != "baseten" || get("BASETEN_KEY") == "" && get("BASETEN_API_KEY") == "" {
		return fmt.Errorf("production requires configured Baseten image and transcription providers")
	}
	if get("PDF_RENDERER_URL") == "" {
		return fmt.Errorf("PDF_RENDERER_URL is required")
	}
	if _, _, e := net.SplitHostPort(get("SMTP_ADDR")); e != nil {
		return fmt.Errorf("SMTP_ADDR must be host:port")
	}
	if get("SMTP_TLS") != "starttls" && get("SMTP_TLS") != "implicit" {
		return fmt.Errorf("production SMTP_TLS must be starttls or implicit")
	}
	from, e := mail.ParseAddress(get("SMTP_FROM"))
	if e != nil || strings.ContainsAny(from.String(), "\r\n") {
		return fmt.Errorf("SMTP_FROM must be an email address")
	}
	for _, cidr := range strings.Split(get("TRUSTED_PROXY_CIDRS"), ",") {
		if cidr == "" {
			return fmt.Errorf("TRUSTED_PROXY_CIDRS is required")
		}
		_, network, e := net.ParseCIDR(cidr)
		if e != nil {
			return fmt.Errorf("invalid TRUSTED_PROXY_CIDRS")
		}
		ones, _ := network.Mask.Size()
		if ones == 0 {
			return fmt.Errorf("trust specific proxy networks, never every address")
		}
	}
	return nil
}

func weak(value string) bool {
	return len(value) < 20 || strings.Contains(strings.ToLower(value), "change-me") || strings.HasPrefix(value, "satvey-local")
}
