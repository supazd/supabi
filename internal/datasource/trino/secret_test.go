package trino_test

import (
	"context"
	"strings"
	"testing"

	"github.com/supazd/supabi/internal/datasource"
	_ "github.com/supazd/supabi/internal/datasource/trino"
)

// What is wrong with the settings is told to whoever tests the connection, and
// goes to the log: the stored password must not be part of it.
func TestSettingErrorsHideThePassword(t *testing.T) {
	const password = "S3cret-Stored-Pw"
	for name, settings := range map[string]map[string]string{
		"a port that is no number": {"host": "trino.internal", "port": "8443x", "user": "bi", "secure": "true"},
		"a port out of range":      {"host": "trino.internal", "port": "70000", "user": "bi", "secure": "true"},
		"a space after the host":   {"host": "trino.internal ", "port": "8443", "user": "bi", "secure": "true"},
		"a host that is no host":   {"host": "trino.internal/%zz", "port": "8443", "user": "bi", "secure": "true"},
	} {
		conn, err := datasource.Open(context.Background(), "trino", datasource.Config{Settings: settings, Password: password})
		if err == nil {
			conn.Close()
			t.Errorf("%s: opened", name)
			continue
		}
		if strings.Contains(err.Error(), password) {
			t.Errorf("%s: the error gives the password away: %v", name, err)
		}
	}
}
