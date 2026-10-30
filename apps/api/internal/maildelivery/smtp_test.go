package maildelivery

import (
	"bufio"
	"context"
	"io"
	"net"
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
