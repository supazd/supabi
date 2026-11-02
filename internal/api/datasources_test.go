package api

import (
	"errors"
	"fmt"
	"testing"

	"github.com/supazd/supabi/internal/datasource"
)

func TestFailedConnectionTestCarriesTheCode(t *testing.T) {
	known := &datasource.ConnectError{Code: "mysql_version", Params: map[string]string{"version": "5.7.44", "required": "8.0"}, Message: "SupaBI needs MySQL 8.0 or later; this server is 5.7.44"}
	out := failedTest(fmt.Errorf("ping: %w", known))
	if out.Ok || out.Code == nil || string(*out.Code) != "mysql_version" || out.Params == nil || (*out.Params)["version"] != "5.7.44" || *out.Message == "" {
		t.Fatalf("recognised failure: %+v", out)
	}
	// Any other failure is told as the database put it.
	out = failedTest(errors.New("dial tcp: connection refused"))
	if out.Code != nil || out.Params != nil || *out.Message != "dial tcp: connection refused" {
		t.Fatalf("other failure: %+v", out)
	}
}
