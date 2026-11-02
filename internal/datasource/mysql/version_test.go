package mysql

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"net"
	"testing"

	driver "github.com/go-sql-driver/mysql"

	"github.com/supazd/supabi/internal/datasource"
)

func TestMajorVersion(t *testing.T) {
	for _, tt := range []struct {
		version string
		major   int
		ok      bool
	}{
		{"8.0.36", 8, true},
		{"8.4.3", 8, true},
		{"5.7.44-log", 5, true},
		{"5.7.44-0ubuntu0.18.04.1", 5, true},
		{"5.6.51", 5, true},
		// MariaDB's 10 is not MySQL's.
		{"10.6.12-MariaDB-0ubuntu0.22.04.1", 0, false},
		{"", 0, false},
	} {
		if major, ok := majorVersion(tt.version); major != tt.major || ok != tt.ok {
			t.Errorf("%q: %d %v, want %d %v", tt.version, major, ok, tt.major, tt.ok)
		}
	}
}

func TestExplainOldServers(t *testing.T) {
	mysql := &conn{minMajor: 8}
	code := func(c *conn, err error) string {
		var known *datasource.ConnectError
		if errors.As(c.explain(err), &known) {
			return known.Code
		}
		return ""
	}
	for _, tt := range []struct {
		name string
		err  error
		want string
	}{
		{"no key exchange in common", &net.OpError{Op: "remote error", Err: errors.New("tls: handshake failure")}, "mysql_tls"},
		{"TLS versions turned down", &net.OpError{Op: "remote error", Err: errors.New("tls: protocol version not supported")}, "mysql_tls"},
		{"only old TLS versions offered", errors.New("tls: server selected unsupported protocol version 302"), "mysql_tls"},
		{"before 5.7.20", &driver.MySQLError{Number: 1193, Message: "Unknown system variable 'transaction_read_only'"}, "mysql_too_old"},
		// Not about the server's age.
		{"certificate", &tls.CertificateVerificationError{Err: x509.UnknownAuthorityError{}}, ""},
		{"wrong password", &driver.MySQLError{Number: 1045, Message: "Access denied for user 'u'"}, ""},
		{"unreachable", &net.OpError{Op: "dial", Err: errors.New("connection refused")}, ""},
	} {
		if got := code(mysql, tt.err); got != tt.want {
			t.Errorf("%s: %q, want %q", tt.name, got, tt.want)
		}
	}
	// StarRocks and Doris are not held to MySQL's versions.
	if got := code(&conn{}, &net.OpError{Op: "remote error", Err: errors.New("tls: handshake failure")}); got != "" {
		t.Errorf("starrocks: %q", got)
	}
}
