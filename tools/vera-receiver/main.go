// vera-receiver is a disposable integration-test service. It is never linked
// into the Satvey production API.
package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"satvey/vera-receiver/receiver"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	if os.Getenv("VERA_RECEIVER_TEST_MODE") != "1" {
		return fmt.Errorf("set VERA_RECEIVER_TEST_MODE=1 to run this test-only service")
	}
	origin := os.Getenv("VERA_RECEIVER_BASE_URL")
	if origin == "" {
		origin = "https://localhost:8090"
	}
	handler, err := receiver.New(receiver.Config{BaseURL: origin, ClientID: os.Getenv("VERA_RECEIVER_CLIENT_ID"), ClientSecret: os.Getenv("VERA_RECEIVER_CLIENT_SECRET"), ControlKey: os.Getenv("VERA_RECEIVER_CONTROL_KEY"), APIKey: os.Getenv("VERA_RECEIVER_API_KEY")})
	if err != nil {
		return err
	}
	certificate, key := os.Getenv("VERA_RECEIVER_TLS_CERT"), os.Getenv("VERA_RECEIVER_TLS_KEY")
	if (certificate == "") != (key == "") {
		return fmt.Errorf("configure both VERA_RECEIVER_TLS_CERT and VERA_RECEIVER_TLS_KEY")
	}
	if certificate == "" {
		u, _ := url.Parse(origin)
		certificate = filepath.Join(os.TempDir(), "vera-receiver-ca.pem")
		key = filepath.Join(os.TempDir(), "vera-receiver-key.pem")
		if directory := os.Getenv("VERA_RECEIVER_TLS_DIR"); directory != "" {
			certificate = directory + "/vera-receiver-ca.pem"
			key = directory + "/vera-receiver-key.pem"
		}
		if err = generateCertificate(certificate, key, u.Hostname()); err != nil {
			return err
		}
	}
	listen := os.Getenv("VERA_RECEIVER_LISTEN")
	if listen == "" {
		listen = "127.0.0.1:8090"
	}
	server := &http.Server{Addr: listen, Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 << 10, TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12}}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		deadline, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(deadline)
	}()
	log.Printf("VERA handover TEST receiver %s at %s; ephemeral data; certificate %s", receiver.Version, origin, certificate)
	err = server.ListenAndServeTLS(certificate, key)
	if err == http.ErrServerClosed {
		return nil
	}
	return err
}

func generateCertificate(certPath, keyPath, host string) error {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return err
	}
	now := time.Now()
	certificate := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "Satvey VERA test receiver"}, NotBefore: now.Add(-time.Minute), NotAfter: now.Add(7 * 24 * time.Hour), KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, BasicConstraintsValid: true, IsCA: true}
	for _, name := range []string{host, "localhost"} {
		if ip := net.ParseIP(name); ip != nil {
			certificate.IPAddresses = append(certificate.IPAddresses, ip)
		} else if strings.TrimSpace(name) != "" {
			certificate.DNSNames = append(certificate.DNSNames, name)
		}
	}
	certificate.IPAddresses = append(certificate.IPAddresses, net.ParseIP("127.0.0.1"))
	data, err := x509.CreateCertificate(rand.Reader, certificate, certificate, &key.PublicKey, key)
	if err != nil {
		return err
	}
	private, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return err
	}
	if err = os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: private}), 0600); err != nil {
		return err
	}
	return os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: data}), 0644)
}
