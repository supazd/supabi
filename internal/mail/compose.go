package mail

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	netmail "net/mail"
	"net/textproto"
	"strings"
	"time"
)

// compose writes the message as it goes over the wire: headers encoded for
// any language, UTF-8 bodies in quoted-printable, lines ending in CRLF. With
// an HTML body the message is multipart/alternative, the text first.
func compose(from netmail.Address, m Message, now time.Time) ([]byte, error) {
	// A line break would let text from outside add headers of its own.
	if strings.ContainsAny(m.Subject, "\r\n") || strings.ContainsAny(from.Name, "\r\n") {
		return nil, errors.New("a subject or a sender name cannot hold a line break")
	}
	sender, ok := ParseAddress(from.Address)
	if !ok {
		return nil, errors.New("the sender address is not valid")
	}
	if len(m.To) == 0 {
		return nil, errors.New("a message needs a recipient")
	}
	to := make([]string, len(m.To))
	for i, address := range m.To {
		a, ok := ParseAddress(address)
		if !ok {
			return nil, errors.New("a recipient address is not valid")
		}
		to[i] = (&netmail.Address{Address: a}).String()
	}

	var b bytes.Buffer
	header := func(name, value string) { b.WriteString(name + ": " + value + "\r\n") }
	header("Date", now.Format(time.RFC1123Z))
	header("From", (&netmail.Address{Name: from.Name, Address: sender}).String())
	header("To", strings.Join(to, ", "))
	header("Subject", mime.QEncoding.Encode("utf-8", m.Subject))
	header("Message-ID", messageID(sender))
	header("MIME-Version", "1.0")
	if m.HTML == "" {
		header("Content-Type", "text/plain; charset=utf-8")
		header("Content-Transfer-Encoding", "quoted-printable")
		b.WriteString("\r\n")
		if err := writeQuoted(&b, m.Text); err != nil {
			return nil, err
		}
		return b.Bytes(), nil
	}
	parts := multipart.NewWriter(&b)
	header("Content-Type", "multipart/alternative; boundary="+parts.Boundary())
	b.WriteString("\r\n")
	for _, part := range []struct{ contentType, body string }{{"text/plain", m.Text}, {"text/html", m.HTML}} {
		w, err := parts.CreatePart(textproto.MIMEHeader{
			"Content-Type":              {part.contentType + "; charset=utf-8"},
			"Content-Transfer-Encoding": {"quoted-printable"},
		})
		if err != nil {
			return nil, err
		}
		if err := writeQuoted(w, part.body); err != nil {
			return nil, err
		}
	}
	if err := parts.Close(); err != nil {
		return nil, err
	}
	return b.Bytes(), nil
}

// writeQuoted writes text in quoted-printable, which keeps lines short and
// any byte safe, its line breaks as CRLF.
func writeQuoted(w io.Writer, text string) error {
	q := quotedprintable.NewWriter(w)
	if _, err := q.Write([]byte(text)); err != nil {
		return err
	}
	return q.Close()
}

// messageID is unique to the message, on the sender's domain.
func messageID(sender string) string {
	random := make([]byte, 16)
	_, _ = rand.Read(random) // never fails; see crypto/rand
	return "<" + hex.EncodeToString(random) + "@" + sender[strings.LastIndexByte(sender, '@')+1:] + ">"
}
