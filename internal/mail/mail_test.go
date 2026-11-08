package mail

import (
	"context"
	"errors"
	"net"
	netmail "net/mail"
	"strings"
	"testing"
	"time"

	"github.com/supazd/supabi/internal/mail/mailtest"
	"github.com/supazd/supabi/internal/store"
)

// serverFor sends to f, signing in as it expects.
func serverFor(f *mailtest.Server, security string) Server {
	return Server{Host: "127.0.0.1", Port: f.Port, Security: security, Username: f.Username, Password: f.Password,
		From: netmail.Address{Name: "SupaBI", Address: "bi@example.com"}}
}

var hello = Message{To: []string{"ann@example.com"}, Subject: "Hello", Text: "It works."}

// STARTTLS encrypts before signing in, with PLAIN when the server offers it.
func TestSendStartTLS(t *testing.T) {
	f := &mailtest.Server{StartTLS: true, Auth: "PLAIN LOGIN", Username: "bi", Password: "secret"}
	f.Start(t)
	if err := send(context.Background(), serverFor(f, StartTLS), hello, f.Roots); err != nil {
		t.Fatal(err)
	}
	got := f.Next(t)
	if got.SignedIn != "bi" || got.From != "bi@example.com" || len(got.To) != 1 || got.To[0] != "ann@example.com" || !strings.Contains(got.Data, "It works.") {
		t.Errorf("received %+v", got)
	}
}

// Microsoft Exchange offers LOGIN and not PLAIN.
func TestSendTLSWithLogin(t *testing.T) {
	f := &mailtest.Server{ImplicitTLS: true, Auth: "LOGIN XOAUTH2", Username: "bi@example.com", Password: "secret"}
	f.Start(t)
	if err := send(context.Background(), serverFor(f, TLS), hello, f.Roots); err != nil {
		t.Fatal(err)
	}
	if got := f.Next(t); got.SignedIn != "bi@example.com" {
		t.Errorf("signed in as %q", got.SignedIn)
	}
}

// A relay inside the network takes mail in plain text, without signing in.
func TestSendWithoutEncryption(t *testing.T) {
	f := &mailtest.Server{}
	f.Start(t)
	if err := send(context.Background(), serverFor(f, None), hello, nil); err != nil {
		t.Fatal(err)
	}
	if got := f.Next(t); got.SignedIn != "" || !strings.Contains(got.Data, "Subject: Hello") {
		t.Errorf("received %+v", got)
	}
}

// Each failure names its stage, in the server's words where it gave any,
// and nothing is sent after it.
func TestSendFailures(t *testing.T) {
	closed, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	closedPort := closed.Addr().(*net.TCPAddr).Port
	closed.Close()

	for _, c := range []struct {
		name     string
		server   mailtest.Server
		security string
		// untrusted verifies against the system's roots.
		untrusted bool
		port      int
		// password, when set, is sent instead of the right one.
		password string
		stage    Stage
		says     string
	}{
		{name: "nothing listens", port: closedPort, security: None, stage: StageConnect},
		{name: "STARTTLS not offered", server: mailtest.Server{Auth: "PLAIN", Username: "bi", Password: "pw"}, security: StartTLS, stage: StageNoStartTLS},
		{name: "certificate not trusted", server: mailtest.Server{StartTLS: true}, security: StartTLS, untrusted: true, stage: StageTLS},
		{name: "not TLS from the start", server: mailtest.Server{}, security: TLS, stage: StageTLS},
		{name: "wrong password", server: mailtest.Server{StartTLS: true, Auth: "PLAIN", Username: "bi", Password: "pw"}, security: StartTLS, password: "wrong", stage: StageAuth, says: "535 5.7.8"},
		{name: "no sign-in offered", server: mailtest.Server{StartTLS: true, Username: "bi", Password: "pw"}, security: StartTLS, stage: StageNoAuth},
		{name: "no known sign-in", server: mailtest.Server{StartTLS: true, Auth: "CRAM-MD5", Username: "bi", Password: "pw"}, security: StartTLS, stage: StageNoAuth, says: "CRAM-MD5"},
		{name: "recipient refused", server: mailtest.Server{RejectRecipient: true}, security: None, stage: StageRecipient, says: "550 5.1.1 No such user here"},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := c.server
			f.Start(t)
			s := serverFor(&f, c.security)
			if c.port != 0 {
				s.Port = c.port
			}
			if c.password != "" {
				s.Password = c.password
			}
			roots := f.Roots
			if c.untrusted {
				roots = nil
			}
			err := send(context.Background(), s, hello, roots)
			var failure *Error
			if !errors.As(err, &failure) || failure.Stage != c.stage || !strings.Contains(failure.Reason(), c.says) {
				t.Fatalf("got %v; want stage %s saying %q", err, c.stage, c.says)
			}
			f.None(t)
		})
	}
}

// A server that never answers is given up on when the time runs out.
func TestSendGivesUp(t *testing.T) {
	f := &mailtest.Server{Silent: true}
	f.Start(t)
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	start := time.Now()
	err := send(ctx, serverFor(f, None), hello, nil)
	var failure *Error
	if !errors.As(err, &failure) || failure.Stage != StageConnect || !strings.Contains(err.Error(), "in time") {
		t.Errorf("got %v", err)
	}
	if waited := time.Since(start); waited > 900*time.Millisecond {
		t.Errorf("waited %s", waited)
	}
}

// No password goes out in plain text, even when asked to.
func TestSendNeverSignsInUnencrypted(t *testing.T) {
	f := &mailtest.Server{Auth: "PLAIN LOGIN", Username: "bi", Password: "pw"}
	f.Start(t)
	if err := send(context.Background(), serverFor(f, None), hello, nil); err == nil {
		t.Error("sent")
	}
	f.None(t)
}

func TestServerAddr(t *testing.T) {
	for _, c := range []struct {
		s    Server
		want string
	}{
		{Server{Host: "smtp.example.com", Security: StartTLS}, "smtp.example.com:587"},
		{Server{Host: "smtp.example.com", Security: TLS}, "smtp.example.com:465"},
		{Server{Host: "10.0.0.5", Security: None}, "10.0.0.5:25"},
		{Server{Host: "::1", Port: 2525, Security: None}, "[::1]:2525"},
	} {
		if got := c.s.Addr(); got != c.want {
			t.Errorf("%+v: %s, want %s", c.s, got, c.want)
		}
	}
}

func TestParseAddress(t *testing.T) {
	for text, want := range map[string]bool{
		"bi@example.com": true, " bi@example.com ": true, "张三@example.com": true,
		"": false, "bi": false, "BI <bi@example.com>": false, "<bi@example.com>": false, "bi@example.com\r\nBcc: x@y.z": false,
	} {
		if _, ok := ParseAddress(text); ok != want {
			t.Errorf("%q: %v, want %v", text, ok, want)
		}
	}
}

func TestSecurities(t *testing.T) {
	for _, s := range Securities {
		if DefaultPorts[s] == 0 {
			t.Errorf("%s has no default port", s)
		}
	}
	if len(DefaultPorts) != len(Securities) {
		t.Errorf("ports for %v", DefaultPorts)
	}
}

type sealer struct{}

func (sealer) Seal(plaintext string) []byte { return []byte("sealed:" + plaintext) }
func (sealer) Open(sealed []byte) (string, error) {
	text, ok := strings.CutPrefix(string(sealed), "sealed:")
	if !ok {
		return "", errors.New("wrong key")
	}
	return text, nil
}

// Stored settings become a server with the password opened and the default
// sender name filled in.
func TestServerOf(t *testing.T) {
	s, err := ServerOf(store.EmailSettings{Host: "h", Security: TLS, Username: "u", Password: []byte("sealed:pw"), FromAddress: "bi@example.com"}, sealer{})
	if err != nil || s.Password != "pw" || s.From.Name != DefaultFromName || s.From.Address != "bi@example.com" || s.Addr() != "h:465" {
		t.Errorf("%+v, %v", s, err)
	}
	if _, err := ServerOf(store.EmailSettings{Host: "h", Password: []byte("other")}, sealer{}); err == nil {
		t.Error("opened a password sealed with another key")
	}
}
