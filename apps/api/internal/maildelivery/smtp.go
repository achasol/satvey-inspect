// Package maildelivery implements bounded SMTP delivery with verified TLS.
package maildelivery

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/mail"
	"net/smtp"
	"strings"
	"time"
)

type Message struct {
	To      string `json:"to"`
	Subject string `json:"subject"`
	Text    string `json:"text"`
}
type Config struct{ Address, From, Username, Password, TLS string }

func (c Config) Send(ctx context.Context, m Message) error {
	from, e := mail.ParseAddress(c.From)
	if e != nil {
		return fmt.Errorf("invalid sender")
	}
	to, e := mail.ParseAddress(m.To)
	if e != nil || strings.ContainsAny(m.To+m.Subject+c.From, "\r\n") {
		return fmt.Errorf("invalid mail headers")
	}
	host, _, e := net.SplitHostPort(c.Address)
	if e != nil {
		return fmt.Errorf("invalid SMTP address")
	}
	tlsConfig := &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12}
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	conn, e := dialer.DialContext(ctx, "tcp", c.Address)
	if e != nil {
		return fmt.Errorf("SMTP unavailable")
	}
	defer conn.Close()
	deadline := time.Now().Add(20 * time.Second)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	_ = conn.SetDeadline(deadline)
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()
	if c.TLS == "implicit" {
		secured := tls.Client(conn, tlsConfig)
		if e = secured.HandshakeContext(ctx); e != nil {
			return fmt.Errorf("SMTP TLS failed")
		}
		conn = secured
	}
	client, e := smtp.NewClient(conn, host)
	if e != nil {
		return fmt.Errorf("SMTP greeting failed")
	}
	defer client.Close()
	if c.TLS == "starttls" {
		if e = client.StartTLS(tlsConfig); e != nil {
			return fmt.Errorf("SMTP STARTTLS failed")
		}
	}
	if c.TLS != "starttls" && c.TLS != "implicit" && c.TLS != "none" {
		return fmt.Errorf("invalid SMTP TLS mode")
	}
	if c.Username != "" {
		if c.TLS == "none" {
			return fmt.Errorf("SMTP authentication requires TLS")
		}
		if e = client.Auth(smtp.PlainAuth("", c.Username, c.Password, host)); e != nil {
			return fmt.Errorf("SMTP authentication failed")
		}
	}
	if e = client.Mail(from.Address); e != nil {
		return fmt.Errorf("SMTP sender refused")
	}
	if e = client.Rcpt(to.Address); e != nil {
		return fmt.Errorf("SMTP recipient refused")
	}
	w, e := client.Data()
	if e != nil {
		return fmt.Errorf("SMTP DATA failed")
	}
	text := strings.ReplaceAll(strings.ReplaceAll(m.Text, "\r\n", "\n"), "\n", "\r\n")
	_, e = fmt.Fprintf(w, "From: %s\r\nTo: %s\r\nSubject: %s\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n%s\r\n", from.String(), to.String(), m.Subject, text)
	if e != nil {
		return fmt.Errorf("SMTP write failed")
	}
	if e = w.Close(); e != nil {
		return fmt.Errorf("SMTP delivery refused")
	}
	_ = client.Quit()
	return nil
}
