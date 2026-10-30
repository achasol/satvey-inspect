package networkpolicy

import (
	"net"
	"net/http"
	"testing"
	"time"
)

func TestIntegrationDestinationPolicy(t *testing.T) {
	p := Policy{AllowedHosts: []string{"identity.example.org", "property.internal"}, PrivateHosts: []string{"property.internal"}}
	for _, url := range []string{"https://identity.example.org/realms/one", "https://property.internal/v4"} {
		if e := p.Validate(url); e != nil {
			t.Fatal(e)
		}
	}
	for _, url := range []string{"http://identity.example.org", "https://evil.example.org", "https://identity.example.org.evil.org", "https://user:secret@identity.example.org", "https://identity.example.org:8080", "https://identity.example.org/#fragment", "file:///tmp/secret"} {
		if e := p.Validate(url); e == nil {
			t.Fatalf("accepted %s", url)
		}
	}
	client := p.Client(time.Second)
	if _, e := client.Get("http://127.0.0.1:9/secret"); e == nil {
		t.Fatal("unapproved request allowed")
	}
	if e := client.CheckRedirect(&http.Request{}, nil); e == nil {
		t.Fatal("redirect allowed")
	}
}
func TestPrivateAndSpecialAddressesAreRejected(t *testing.T) {
	for _, ip := range []string{"127.0.0.1", "10.1.1.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "192.0.2.1", "224.0.0.1", "::1", "::ffff:127.0.0.1", "fd00::1", "fe80::1", "2001:db8::1", "64:ff9b::7f00:1"} {
		if PublicAddress(net.ParseIP(ip)) {
			t.Fatal("accepted " + ip)
		}
	}
	for _, ip := range []string{"8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"} {
		if !PublicAddress(net.ParseIP(ip)) {
			t.Fatal("rejected " + ip)
		}
	}
}
