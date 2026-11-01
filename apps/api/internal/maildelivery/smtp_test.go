package maildelivery

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"io"
	"mime"
	"mime/multipart"
	"net"
	"net/mail"
	"strings"
	"testing"
)

func TestSMTPDeliveryAndHeaderValidation(t *testing.T) {
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer listener.Close()
	message := make(chan string, 1)
	go func() {
		conn, e := listener.Accept()
		if e != nil {
			return
		}
		defer conn.Close()
		reader := bufio.NewReader(conn)
		io.WriteString(conn, "220 test SMTP\r\n")
		var body strings.Builder
		inData := false
		for {
			line, e := reader.ReadString('\n')
			if e != nil {
				return
			}
			if inData {
				if line == ".\r\n" {
					message <- body.String()
					io.WriteString(conn, "250 accepted\r\n")
					inData = false
				} else {
					body.WriteString(line)
				}
				continue
			}
			switch {
			case strings.HasPrefix(line, "EHLO"):
				io.WriteString(conn, "250 test\r\n")
			case strings.HasPrefix(line, "DATA"):
				io.WriteString(conn, "354 send message\r\n")
				inData = true
			case strings.HasPrefix(line, "QUIT"):
				io.WriteString(conn, "221 bye\r\n")
				return
			default:
				io.WriteString(conn, "250 ok\r\n")
			}
		}
	}()
	cfg := Config{Address: listener.Addr().String(), From: "inspect@example.org", TLS: "none"}
	if e = cfg.Send(context.Background(), Message{To: "person@example.org", Subject: "Satvey invitation", Text: "Single-use link\nhttps://inspect.example.org/invite?token=test"}); e != nil {
		t.Fatal(e)
	}
	if body := <-message; !strings.Contains(body, "Subject: Satvey invitation") || !strings.Contains(body, "Single-use link\r\n") {
		t.Fatal(body)
	}
	if e = cfg.Send(context.Background(), Message{To: "person@example.org", Subject: "bad\r\nBcc: attacker@example.org"}); e == nil {
		t.Fatal("header injection accepted")
	}
}

func TestPDFMIMEPreservesAttachmentBytesAndMessageIdentity(t *testing.T) {
	pdf := append([]byte("%PDF-1.7\n"), bytes.Repeat([]byte{0, 1, 128, 255}, 100)...)
	raw, err := wireMessage("inspect@example.org", "resident@example.org", Message{ID: "delivery-42", Subject: "Inspectie", Text: "Bijgevoegd rapport", Attachments: []Attachment{{Name: "inspectierapport.pdf", MIME: "application/pdf", Data: pdf}}})
	if err != nil {
		t.Fatal(err)
	}
	message, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	if message.Header.Get("Message-ID") != "<delivery-42@satvey.inspect>" {
		t.Fatal("missing stable message identity")
	}
	_, parameters, err := mime.ParseMediaType(message.Header.Get("Content-Type"))
	if err != nil {
		t.Fatal(err)
	}
	parts := multipart.NewReader(message.Body, parameters["boundary"])
	if _, err = parts.NextPart(); err != nil {
		t.Fatal(err)
	}
	attachment, err := parts.NextPart()
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := io.ReadAll(base64.NewDecoder(base64.StdEncoding, attachment))
	if err != nil || !bytes.Equal(decoded, pdf) {
		t.Fatal("PDF was changed by MIME encoding", err)
	}
}
