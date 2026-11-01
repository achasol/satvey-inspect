// Package maildelivery implements bounded SMTP delivery with verified TLS.
package maildelivery

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"mime"
	"mime/multipart"
	"net"
	"net/mail"
	"net/smtp"
	"net/textproto"
	"strings"
	"time"
)

type Message struct {
	ID          string       `json:"id,omitempty"`
	To          string       `json:"to"`
	Subject     string       `json:"subject"`
	Text        string       `json:"text"`
	Attachments []Attachment `json:"attachments,omitempty"`
}
type Attachment struct {
	Name string `json:"name"`
	MIME string `json:"mime"`
	Data []byte `json:"data"`
}

func wireMessage(from, to string, m Message) ([]byte, error) {
	var result bytes.Buffer
	fmt.Fprintf(&result, "From: %s\r\nTo: %s\r\nSubject: %s\r\nMIME-Version: 1.0\r\n", from, to, mime.QEncoding.Encode("utf-8", m.Subject))
	if m.ID != "" {
		if strings.ContainsAny(m.ID, "\r\n<> ") {
			return nil, fmt.Errorf("invalid message id")
		}
		fmt.Fprintf(&result, "Message-ID: <%s@satvey.inspect>\r\n", m.ID)
	}
	if len(m.Attachments) == 0 {
		fmt.Fprintf(&result, "Content-Type: text/plain; charset=UTF-8\r\n\r\n%s\r\n", strings.ReplaceAll(strings.ReplaceAll(m.Text, "\r\n", "\n"), "\n", "\r\n"))
		return result.Bytes(), nil
	}
	parts := multipart.NewWriter(&result)
	fmt.Fprintf(&result, "Content-Type: multipart/mixed; boundary=%q\r\n\r\n", parts.Boundary())
	body, err := parts.CreatePart(textproto.MIMEHeader{"Content-Type": {"text/plain; charset=UTF-8"}, "Content-Transfer-Encoding": {"base64"}})
	if err != nil {
		return nil, err
	}
	writeBase64(body, []byte(m.Text))
	for _, a := range m.Attachments {
		if a.Name == "" || strings.ContainsAny(a.Name+a.MIME, "\r\n") || len(a.Data) > 25<<20 {
			return nil, fmt.Errorf("invalid attachment")
		}
		part, e := parts.CreatePart(textproto.MIMEHeader{"Content-Type": {mime.FormatMediaType(a.MIME, map[string]string{"name": a.Name})}, "Content-Disposition": {mime.FormatMediaType("attachment", map[string]string{"filename": a.Name})}, "Content-Transfer-Encoding": {"base64"}})
		if e != nil {
			return nil, e
		}
		writeBase64(part, a.Data)
	}
	if err = parts.Close(); err != nil {
		return nil, err
	}
	return result.Bytes(), nil
}
func writeBase64(w interface{ Write([]byte) (int, error) }, data []byte) {
	encoded := base64.StdEncoding.EncodeToString(data)
	for len(encoded) > 0 {
		n := 76
		if len(encoded) < n {
			n = len(encoded)
		}
		_, _ = w.Write([]byte(encoded[:n] + "\r\n"))
		encoded = encoded[n:]
	}
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
	wire, encodeErr := wireMessage(from.String(), to.String(), m)
	if encodeErr != nil {
		return encodeErr
	}
	_, e = w.Write(wire)
	if e != nil {
		return fmt.Errorf("SMTP write failed")
	}
	if e = w.Close(); e != nil {
		var refused *textproto.Error
		if errors.As(e, &refused) {
			return fmt.Errorf("SMTP message refused")
		}
		return fmt.Errorf("delivery uncertain: SMTP acknowledgement unavailable")
	}
	_ = client.Quit()
	return nil
}
