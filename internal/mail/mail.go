// Package mail sends email through the SMTP server an organization set up.
// It makes one attempt per message; how messages are queued and retried is
// for the features that send them to decide. See .agents/design/email.md.
package mail

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	netmail "net/mail"
	"net/smtp"
	"net/textproto"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/supazd/supabi/internal/store"
)

// How the connection to the server is encrypted: .agents/design/email.md 3.
const (
	// StartTLS connects in plain text, then has the server encrypt; a server
	// that cannot is an error, never a reason to go on in plain text.
	StartTLS = "starttls"
	// TLS encrypts from the first byte.
	TLS = "tls"
	// None never signs in, so that no password goes out in plain text.
	None = "none"
)

// Securities are the encryptions there are, in the order they are offered.
var Securities = []string{StartTLS, TLS, None}

// DefaultPorts are the usual port of each encryption, used when the
// settings name none.
var DefaultPorts = map[string]int{StartTLS: 587, TLS: 465, None: 25}

// DefaultFromName is shown with the sender address when the settings name
// no other.
const DefaultFromName = "SupaBI"

// A server that takes longer than this is misconfigured or unreachable.
const (
	connectTimeout = 10 * time.Second
	sendTimeout    = 30 * time.Second
)

// ErrNotConfigured means the organization has set no server or no sender
// address, so email is off.
var ErrNotConfigured = errors.New("email is not set up")

// Server is where messages go, and whom they are from.
type Server struct {
	Host string
	// Port is 0 to follow Security.
	Port     int
	Security string
	// Username is empty to send without signing in.
	Username, Password string
	From               netmail.Address
}

// Addr is the host and port to connect to.
func (s Server) Addr() string {
	port := s.Port
	if port == 0 {
		port = DefaultPorts[s.Security]
	}
	return net.JoinHostPort(s.Host, strconv.Itoa(port))
}

// Message is one email.
type Message struct {
	To      []string
	Subject string
	// Text is the body in plain text. With HTML, it is what mail clients that
	// do not show HTML show instead.
	Text string
	HTML string
}

// Stage is where sending failed.
type Stage string

const (
	StageConnect    Stage = "connect"
	StageTLS        Stage = "tls"
	StageNoStartTLS Stage = "no_starttls"
	StageAuth       Stage = "auth"
	StageNoAuth     Stage = "no_auth"
	StageSender     Stage = "sender"
	StageRecipient  Stage = "recipient"
	StageData       Stage = "data"
)

// Error is a failure to send, at a stage, in the server's own words when it
// gave any.
type Error struct {
	Stage Stage
	Err   error
}

func (e *Error) Error() string { return string(e.Stage) + ": " + e.Reason() }
func (e *Error) Unwrap() error { return e.Err }

// Reason is what went wrong, a reply of the server as it wrote it, such as
// "535 5.7.8 Authentication credentials invalid".
func (e *Error) Reason() string {
	if reply, ok := e.Err.(*textproto.Error); ok {
		return fmt.Sprintf("%03d %s", reply.Code, reply.Msg)
	}
	return e.Err.Error()
}

// Configured is the organization's server, with its password opened;
// ErrNotConfigured while email is off.
func Configured(ctx context.Context, pool *pgxpool.Pool, key store.Sealer, orgID string) (Server, error) {
	v, err := store.GetEmailSettings(ctx, pool, orgID)
	if err != nil {
		return Server{}, err
	}
	if v.Host == "" || v.FromAddress == "" {
		return Server{}, ErrNotConfigured
	}
	return ServerOf(v, key)
}

// ServerOf is the server stored settings describe, with the password opened.
func ServerOf(v store.EmailSettings, key store.Sealer) (Server, error) {
	s := Server{Host: v.Host, Port: v.Port, Security: v.Security, Username: v.Username, From: netmail.Address{Name: v.FromName, Address: v.FromAddress}}
	if s.From.Name == "" {
		s.From.Name = DefaultFromName
	}
	if len(v.Password) > 0 {
		password, err := key.Open(v.Password)
		if err != nil {
			return Server{}, err
		}
		s.Password = password
	}
	return s, nil
}

// ParseAddress is a bare address such as bi@example.com, without a name or
// angle brackets, and whether it is one.
func ParseAddress(text string) (string, bool) {
	text = strings.TrimSpace(text)
	a, err := netmail.ParseAddress(text)
	if err != nil || a.Name != "" || a.Address != text {
		return "", false
	}
	return a.Address, true
}

// Send hands one message to the server, and returns once the server has
// accepted or refused it.
func Send(ctx context.Context, s Server, m Message) error {
	return send(ctx, s, m, nil)
}

// send trusts roots for the server's certificate, or the system's when nil.
func send(ctx context.Context, s Server, m Message, roots *x509.CertPool) error {
	if s.Security == None && s.Username != "" {
		return errors.New("a password is never sent without encryption")
	}
	body, err := compose(s.From, m, time.Now())
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, sendTimeout)
	defer cancel()
	fail := func(stage Stage, err error) error {
		if ctx.Err() != nil || errors.Is(err, os.ErrDeadlineExceeded) {
			err = fmt.Errorf("the server did not answer in time: %w", err)
		}
		return &Error{Stage: stage, Err: err}
	}

	dialer := net.Dialer{Timeout: connectTimeout}
	raw, err := dialer.DialContext(ctx, "tcp", s.Addr())
	if err != nil {
		return fail(StageConnect, err)
	}
	defer raw.Close()
	if deadline, ok := ctx.Deadline(); ok {
		_ = raw.SetDeadline(deadline)
	}
	// The server may stop answering mid-sentence; the deadline ends that.
	stop := context.AfterFunc(ctx, func() { raw.Close() })
	defer stop()

	tlsConfig := &tls.Config{ServerName: s.Host, RootCAs: roots, MinVersion: tls.VersionTLS12}
	conn := raw
	if s.Security == TLS {
		encrypted := tls.Client(raw, tlsConfig)
		if err := encrypted.HandshakeContext(ctx); err != nil {
			return fail(StageTLS, err)
		}
		conn = encrypted
	}
	c, err := smtp.NewClient(conn, s.Host)
	if err != nil {
		return fail(StageConnect, err)
	}
	defer c.Close()
	if err := c.Hello(helloName()); err != nil {
		return fail(StageConnect, err)
	}
	if s.Security == StartTLS {
		if ok, _ := c.Extension("STARTTLS"); !ok {
			return fail(StageNoStartTLS, errors.New("the server does not offer STARTTLS"))
		}
		if err := c.StartTLS(tlsConfig); err != nil {
			return fail(StageTLS, err)
		}
	}
	if s.Username != "" {
		_, offered := c.Extension("AUTH")
		auth := chooseAuth(offered, s)
		if auth == nil {
			if offered == "" {
				return fail(StageNoAuth, errors.New("the server offers no way to sign in"))
			}
			return fail(StageNoAuth, fmt.Errorf("the server offers neither PLAIN nor LOGIN, only %s", offered))
		}
		if err := c.Auth(auth); err != nil {
			return fail(StageAuth, err)
		}
	}
	if err := c.Mail(s.From.Address); err != nil {
		return fail(StageSender, err)
	}
	for _, to := range m.To {
		if err := c.Rcpt(to); err != nil {
			return fail(StageRecipient, err)
		}
	}
	w, err := c.Data()
	if err != nil {
		return fail(StageData, err)
	}
	if _, err := w.Write(body); err != nil {
		return fail(StageData, err)
	}
	if err := w.Close(); err != nil {
		return fail(StageData, err)
	}
	// The server has the message; how it says goodbye changes nothing.
	_ = c.Quit()
	return nil
}

// helloName is how this machine introduces itself to the server.
func helloName() string {
	name, err := os.Hostname()
	if err != nil || name == "" || strings.ContainsAny(name, " \r\n") {
		return "localhost"
	}
	return name
}

// chooseAuth picks PLAIN, else LOGIN, from the mechanisms the server
// offers; nil when it offers neither. Microsoft Exchange offers LOGIN and
// not PLAIN.
func chooseAuth(offered string, s Server) smtp.Auth {
	mechanisms := strings.Fields(strings.ToUpper(offered))
	switch {
	case slices.Contains(mechanisms, "PLAIN"):
		return smtp.PlainAuth("", s.Username, s.Password, s.Host)
	case slices.Contains(mechanisms, "LOGIN"):
		return loginAuth{username: s.Username, password: s.Password}
	}
	return nil
}

// loginAuth is the LOGIN mechanism, which net/smtp lacks: the server asks
// for the username and then the password.
type loginAuth struct{ username, password string }

func (a loginAuth) Start(server *smtp.ServerInfo) (string, []byte, error) {
	if !server.TLS {
		return "", nil, errors.New("unencrypted connection")
	}
	return "LOGIN", nil, nil
}

func (a loginAuth) Next(fromServer []byte, more bool) ([]byte, error) {
	if !more {
		return nil, nil
	}
	prompt := strings.ToLower(strings.TrimSpace(string(fromServer)))
	switch {
	case strings.HasPrefix(prompt, "user"):
		return []byte(a.username), nil
	case strings.HasPrefix(prompt, "pass"):
		return []byte(a.password), nil
	}
	return nil, fmt.Errorf("unexpected question from the server: %q", fromServer)
}
