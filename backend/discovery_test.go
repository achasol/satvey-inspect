package main

import (
	"strings"
	"testing"
)

func TestEmailDiscovery(t *testing.T) {
	f := setup(t)
	domain := f.org + ".example.test"
	f.request("PUT", "/orgs/"+f.org+"/sso", map[string]any{"issuer": "https://identity.example.test/realms/test", "clientId": "satvey", "clientSecret": "private-secret", "domains": []string{domain}}, 200)
	known := f.request("POST", "/auth/discover", map[string]any{"email": "  Inspector@" + strings.ToUpper(domain) + " "}, 200)
	if known["method"] != "sso" || !strings.Contains(known["url"].(string), "email=inspector%40") {
		t.Fatalf("expected domain-based SSO with email hint: %v", known)
	}
	unknown := f.request("POST", "/auth/discover", map[string]any{"email": "person@other." + domain}, 200)
	if unknown["method"] != "password" {
		t.Fatal("subdomains must not match automatically")
	}
	f.request("POST", "/auth/discover", map[string]any{"email": "invalid"}, 400)
	settings := f.request("GET", "/orgs/"+f.org+"/sso", nil, 200)
	if _, exists := settings["clientSecret"]; exists {
		t.Fatal("SSO secret leaked")
	}
	f.request("PUT", "/orgs/"+f.org+"/sso", map[string]any{"issuer": "https://identity.example.test/realms/test", "clientId": "satvey", "clientSecret": "", "domains": []string{"https://invalid.example"}}, 400)
	settings = f.request("GET", "/orgs/"+f.org+"/sso", nil, 200)
	if len(settings["domains"].([]any)) != 1 {
		t.Fatal("invalid settings partially overwrote existing domains")
	}
}
