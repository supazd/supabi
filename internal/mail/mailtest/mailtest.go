// Package mailtest is an SMTP server for tests, which speaks enough SMTP to
// be sent to and offers what a test asks for.
package mailtest

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"math/big"
	"net"
	"net/textproto"
	"strings"
	"testing"
	"time"
)

// Server is what the server offers. Start it with Start.
type Server struct {
	// StartTLS offers STARTTLS; ImplicitTLS encrypts from the first byte.
	StartTLS, ImplicitTLS bool
	// Auth is what AUTH offers, such as "PLAIN LOGIN"; empty offers no sign-in.
	Auth               string
	Username, Password string
	RejectRecipient    bool
	// Silent never greets, as a server that hangs.
	Silent bool

	// Port is where it listens on 127.0.0.1, once started.
	Port int
	// Roots trusts its certificate.
	Roots *x509.CertPool
	// Received has each message it accepted.
	Received chan Received

	cert tls.Certificate
}

// Received is a message as the server took it.
type Received struct {
	SignedIn string
	From     string
	To       []string
	// Data is the message, its lines ending in LF.
	Data string
}

// Start listens until the test ends.
func (f *Server) Start(t *testing.T) {
	t.Helper()
	f.cert, f.Roots = certificate(t)
	f.Received = make(chan Received, 4)
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	f.Port = l.Addr().(*net.TCPAddr).Port
	go func() {
		for {
			conn, err := l.Accept()
			if err != nil {
				return
			}
			go f.serve(conn)
		}
	}()
}

// Next is the message received next, failing the test if none comes soon.
func (f *Server) Next(t *testing.T) Received {
	t.Helper()
	select {
	case m := <-f.Received:
		return m
	case <-time.After(5 * time.Second):
		t.Fatal("no message received")
		return Received{}
	}
}

// None fails the test if a message was received.
func (f *Server) None(t *testing.T) {
	t.Helper()
	select {
	case m := <-f.Received:
		t.Errorf("received %+v", m)
	default:
	}
}

// certificate is one for 127.0.0.1 and the pool that trusts it.
func certificate(t *testing.T) (tls.Certificate, *x509.CertPool) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "mailtest"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, IsCA: true, BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(parsed)
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, roots
}

func (f *Server) serve(conn net.Conn) {
	defer conn.Close()
	if f.Silent {
		time.Sleep(time.Second)
		return
	}
	encrypted := f.ImplicitTLS
	config := &tls.Config{Certificates: []tls.Certificate{f.cert}}
	if encrypted {
		conn = tls.Server(conn, config)
	}
	tp := textproto.NewConn(conn)
	_ = tp.PrintfLine("220 mailtest ESMTP")
	var got Received
	for {
		line, err := tp.ReadLine()
		if err != nil {
			return
		}
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		switch strings.ToUpper(fields[0]) {
		case "EHLO":
			lines := []string{"mailtest"}
			if f.StartTLS && !encrypted {
				lines = append(lines, "STARTTLS")
			}
			if f.Auth != "" {
				lines = append(lines, "AUTH "+f.Auth)
			}
			for i, l := range lines {
				separator := "-"
				if i == len(lines)-1 {
					separator = " "
				}
				_ = tp.PrintfLine("250%s%s", separator, l)
			}
		case "STARTTLS":
			_ = tp.PrintfLine("220 2.0.0 Ready to start TLS")
			conn = tls.Server(conn, config)
			tp = textproto.NewConn(conn)
			encrypted = true
		case "AUTH":
			var user, password string
			switch strings.ToUpper(fields[1]) {
			case "PLAIN":
				if len(fields) > 2 {
					decoded, _ := base64.StdEncoding.DecodeString(fields[2])
					if parts := strings.Split(string(decoded), "\x00"); len(parts) == 3 {
						user, password = parts[1], parts[2]
					}
				}
			case "LOGIN":
				user = ask(tp, "Username:")
				password = ask(tp, "Password:")
			}
			if user != f.Username || password != f.Password {
				_ = tp.PrintfLine("535 5.7.8 Authentication credentials invalid")
				continue
			}
			got.SignedIn = user
			_ = tp.PrintfLine("235 2.7.0 Authentication successful")
		case "MAIL":
			got.From = strings.Trim(strings.TrimPrefix(fields[1], "FROM:"), "<>")
			_ = tp.PrintfLine("250 2.1.0 OK")
		case "RCPT":
			if f.RejectRecipient {
				_ = tp.PrintfLine("550 5.1.1 No such user here")
				continue
			}
			got.To = append(got.To, strings.Trim(strings.TrimPrefix(fields[1], "TO:"), "<>"))
			_ = tp.PrintfLine("250 2.1.5 OK")
		case "DATA":
			_ = tp.PrintfLine("354 Go ahead")
			data, err := tp.ReadDotBytes()
			if err != nil {
				return
			}
			got.Data = string(data)
			_ = tp.PrintfLine("250 2.0.0 Queued")
			f.Received <- got
			got = Received{}
		case "QUIT":
			_ = tp.PrintfLine("221 2.0.0 Bye")
			return
		default:
			_ = tp.PrintfLine("502 5.5.2 Unknown command")
		}
	}
}

func ask(tp *textproto.Conn, question string) string {
	_ = tp.PrintfLine("334 %s", base64.StdEncoding.EncodeToString([]byte(question)))
	line, _ := tp.ReadLine()
	answer, _ := base64.StdEncoding.DecodeString(line)
	return string(answer)
}
