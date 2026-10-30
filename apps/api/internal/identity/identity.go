package identity

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"satvey/inspect/internal/fault"
	"strings"

	"golang.org/x/crypto/argon2"
)

func ValidID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, c := range s {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return false
			}
		} else if !strings.ContainsRune("0123456789abcdef", c) {
			return false
		}
	}
	return true
}
func Hash(password string) (string, error) {
	if len(password) < 12 || len(password) > 256 {
		return "", fault.New(400, "Gebruik een wachtwoord van 12 tot 256 tekens")
	}
	salt := make([]byte, 16)
	if _, e := rand.Read(salt); e != nil {
		return "", e
	}
	key := argon2.IDKey([]byte(password), salt, 2, 64*1024, 2, 32)
	return base64.RawStdEncoding.EncodeToString(salt) + ":" + base64.RawStdEncoding.EncodeToString(key), nil
}
func Matches(encoded, password string) bool {
	parts := strings.Split(encoded, ":")
	if len(parts) != 2 || len(password) > 256 {
		return false
	}
	salt, e := base64.RawStdEncoding.DecodeString(parts[0])
	if e != nil || len(salt) != 16 {
		return false
	}
	key, e := base64.RawStdEncoding.DecodeString(parts[1])
	if e != nil || len(key) != 32 {
		return false
	}
	actual := argon2.IDKey([]byte(password), salt, 2, 64*1024, 2, 32)
	return subtle.ConstantTimeCompare(key, actual) == 1
}
func ValidEmail(s string) bool {
	return len(s) <= 254 && strings.Count(s, "@") == 1 && !strings.ContainsAny(s, " \r\n\t") && strings.Index(s, "@") > 0 && strings.Index(s, "@") < len(s)-1
}
func ValidDomain(domain string) bool {
	if len(domain) > 253 || !strings.Contains(domain, ".") {
		return false
	}
	for _, part := range strings.Split(domain, ".") {
		if len(part) == 0 || len(part) > 63 || part[0] == '-' || part[len(part)-1] == '-' {
			return false
		}
		for _, c := range part {
			if !strings.ContainsRune("abcdefghijklmnopqrstuvwxyz0123456789-", c) {
				return false
			}
		}
	}
	return true
}
