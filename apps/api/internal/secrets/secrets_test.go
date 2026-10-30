package secrets

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestAuthenticatedPurposeBoundEncryption(t *testing.T) {
	key := base64.StdEncoding.EncodeToString(make([]byte, 32))
	encrypted, e := Encrypt(key, "oidc:org-a", "private-client-secret")
	if e != nil {
		t.Fatal(e)
	}
	if strings.Contains(encrypted, "private-client-secret") {
		t.Fatal("plaintext retained")
	}
	plain, e := Decrypt(key, "oidc:org-a", encrypted)
	if e != nil || plain != "private-client-secret" {
		t.Fatal(plain, e)
	}
	for _, purpose := range []string{"oidc:org-b", "mail:org-a"} {
		if _, e = Decrypt(key, purpose, encrypted); e == nil {
			t.Fatal("secret crossed tenant/purpose boundary")
		}
	}
	other, _ := Encrypt(key, "oidc:org-a", "private-client-secret")
	if other == encrypted {
		t.Fatal("nonce reused")
	}
	for _, broken := range []string{"", "v2:invalid", "v1:bad", encrypted[:len(encrypted)-4] + "AAAA"} {
		if _, e = Decrypt(key, "oidc:org-a", broken); e == nil {
			t.Fatal("tampered secret accepted")
		}
	}
	if _, e = Encrypt("invalid", "purpose", "secret"); e == nil {
		t.Fatal("invalid key accepted")
	}
	wrong := base64.StdEncoding.EncodeToString([]byte("01234567890123456789012345678901"))
	if _, e = Decrypt(wrong, "oidc:org-a", encrypted); e == nil {
		t.Fatal("wrong key accepted")
	}
}
