// Package networkpolicy limits configurable integrations, including DNS rebinding.
package networkpolicy

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
)

type Policy struct{ AllowedHosts, PrivateHosts []string }

func contains(hosts []string, host string) bool {
	for _, h := range hosts {
		if strings.EqualFold(strings.TrimSpace(h), host) {
			return true
		}
	}
	return false
}

func (p Policy) Validate(raw string) error {
	u, e := url.Parse(raw)
	if e != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Fragment != "" || !contains(p.AllowedHosts, u.Hostname()) {
		return fmt.Errorf("integration destination is not an approved HTTPS host")
	}
	if port := u.Port(); port != "" && port != "443" {
		return fmt.Errorf("integration HTTPS port must be 443")
	}
	return nil
}

func PublicAddress(ip net.IP) bool {
	a, ok := netip.AddrFromSlice(ip)
	if !ok {
		return false
	}
	a = a.Unmap()
	if !a.IsGlobalUnicast() || a.IsPrivate() || a.IsLoopback() || a.IsLinkLocalUnicast() {
		return false
	}
	for _, block := range []string{"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "2001:db8::/32", "64:ff9b::/96"} {
		if netip.MustParsePrefix(block).Contains(a) {
			return false
		}
	}
	return true
}

type policyTransport struct {
	policy    Policy
	transport *http.Transport
}

func (t policyTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if e := t.policy.Validate(r.URL.String()); e != nil {
		return nil, e
	}
	return t.transport.RoundTrip(r)
}

func (p Policy) Client(timeout time.Duration) *http.Client {
	dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	t := &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}, MaxIdleConns: 20, IdleConnTimeout: 60 * time.Second, TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: timeout}
	t.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, e := net.SplitHostPort(address)
		if e != nil {
			return nil, e
		}
		if !contains(p.AllowedHosts, host) {
			return nil, fmt.Errorf("integration host not allowed")
		}
		ips, e := net.DefaultResolver.LookupIPAddr(ctx, host)
		if e != nil {
			return nil, fmt.Errorf("integration DNS lookup failed")
		}
		if len(ips) == 0 {
			return nil, fmt.Errorf("integration DNS returned no addresses")
		}
		for _, ip := range ips {
			if !PublicAddress(ip.IP) && !contains(p.PrivateHosts, host) {
				return nil, fmt.Errorf("integration resolved to an unapproved private or special address")
			}
		}
		for _, ip := range ips {
			c, err := dialer.DialContext(ctx, network, net.JoinHostPort(ip.IP.String(), port))
			if err == nil {
				return c, nil
			}
		}
		return nil, fmt.Errorf("integration connection failed")
	}
	return &http.Client{Timeout: timeout, Transport: policyTransport{p, t}, CheckRedirect: func(*http.Request, []*http.Request) error { return fmt.Errorf("integration redirects are not allowed") }}
}
