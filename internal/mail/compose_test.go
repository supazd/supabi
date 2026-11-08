package mail

import (
	"io"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	netmail "net/mail"
	"strings"
	"testing"
	"time"
)

var from = netmail.Address{Name: "SupaBI 报表", Address: "bi@example.com"}

// Headers in any language are encoded, lines end in CRLF, and the body
// comes back as written.
func TestComposeText(t *testing.T) {
	now := time.Date(2026, 11, 8, 9, 30, 0, 0, time.UTC)
	text := "第一行\n.a line that starts with a dot\n" + strings.Repeat("long ", 40)
	raw, err := compose(from, Message{To: []string{"ann@example.com", "张三@example.com"}, Subject: "测试邮件", Text: text}, now)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.ReplaceAll(string(raw), "\r\n", ""), "\n") {
		t.Error("a line ends without CR")
	}
	for _, line := range strings.Split(string(raw), "\r\n") {
		if len(line) > 78 {
			t.Errorf("line of %d bytes: %q", len(line), line)
		}
	}
	m, err := netmail.ReadMessage(strings.NewReader(string(raw)))
	if err != nil {
		t.Fatal(err)
	}
	decoder := new(mime.WordDecoder)
	subject, _ := decoder.DecodeHeader(m.Header.Get("Subject"))
	sender, _ := m.Header.AddressList("From")
	to, _ := m.Header.AddressList("To")
	if subject != "测试邮件" || len(sender) != 1 || sender[0].Name != "SupaBI 报表" || len(to) != 2 || to[1].Address != "张三@example.com" {
		t.Errorf("headers: %q %v %v", subject, sender, to)
	}
	if date, err := m.Header.Date(); err != nil || !date.Equal(now) {
		t.Errorf("date: %v, %v", date, err)
	}
	if id := m.Header.Get("Message-ID"); !strings.HasSuffix(id, "@example.com>") || len(id) < 30 {
		t.Errorf("message ID %q", id)
	}
	if m.Header.Get("Content-Type") != "text/plain; charset=utf-8" || m.Header.Get("Content-Transfer-Encoding") != "quoted-printable" {
		t.Errorf("content: %v", m.Header)
	}
	body, _ := io.ReadAll(quotedprintable.NewReader(m.Body))
	if got := strings.ReplaceAll(string(body), "\r\n", "\n"); got != text {
		t.Errorf("body: %q", got)
	}
}

// With HTML, the text comes first, for clients that do not show HTML.
func TestComposeHTML(t *testing.T) {
	raw, err := compose(from, Message{To: []string{"ann@example.com"}, Subject: "Report", Text: "See the report.", HTML: "<p>See the <b>report</b>.</p>"}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	m, err := netmail.ReadMessage(strings.NewReader(string(raw)))
	if err != nil {
		t.Fatal(err)
	}
	mediaType, params, err := mime.ParseMediaType(m.Header.Get("Content-Type"))
	if err != nil || mediaType != "multipart/alternative" {
		t.Fatalf("content type %q, %v", mediaType, err)
	}
	parts := multipart.NewReader(m.Body, params["boundary"])
	var got []string
	for {
		p, err := parts.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(p) // NextPart decodes quoted-printable itself
		got = append(got, p.Header.Get("Content-Type")+" "+string(body))
	}
	want := []string{"text/plain; charset=utf-8 See the report.", "text/html; charset=utf-8 <p>See the <b>report</b>.</p>"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("parts %q", got)
	}
}

// Nothing from outside adds a header of its own.
func TestComposeRefusesHeaderInjection(t *testing.T) {
	for name, c := range map[string]struct {
		from netmail.Address
		m    Message
	}{
		"subject":      {from, Message{To: []string{"a@example.com"}, Subject: "Hi\r\nBcc: x@example.com"}},
		"sender name":  {netmail.Address{Name: "BI\nBcc: x@example.com", Address: "bi@example.com"}, Message{To: []string{"a@example.com"}}},
		"recipient":    {from, Message{To: []string{"a@example.com\r\nBcc: x@example.com"}}},
		"no recipient": {from, Message{Subject: "Hi"}},
		"sender":       {netmail.Address{Address: "not an address"}, Message{To: []string{"a@example.com"}}},
	} {
		if _, err := compose(c.from, c.m, time.Now()); err == nil {
			t.Errorf("%s: composed", name)
		}
	}
}
