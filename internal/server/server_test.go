package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
)

func newHandler(readyErr error) http.Handler {
	ready := func(context.Context) error { return readyErr }
	return NewHandler(nil, ready, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func get(t *testing.T, h http.Handler, path string) (int, map[string]string) {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	body := map[string]string{}
	if rec.Code != http.StatusNotFound {
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("GET %s: invalid JSON %q: %v", path, rec.Body.String(), err)
		}
	}
	return rec.Code, body
}

func TestReadyz(t *testing.T) {
	if code, body := get(t, newHandler(nil), "/readyz"); code != http.StatusOK || body["status"] != "ok" {
		t.Fatalf("ready: got %d %v", code, body)
	}
	// Liveness must stay green while a dependency is down, and the response
	// must not leak the underlying error.
	h := newHandler(errors.New("dial tcp 10.0.0.5:5432: connection refused"))
	code, body := get(t, h, "/readyz")
	if code != http.StatusServiceUnavailable || len(body) != 1 || body["status"] != "unavailable" {
		t.Fatalf("not ready: got %d %v", code, body)
	}
	if code, _ := get(t, h, "/healthz"); code != http.StatusOK {
		t.Fatalf("healthz while not ready: got %d", code)
	}
}

func TestHealthz(t *testing.T) {
	code, body := get(t, newHandler(nil), "/healthz")
	if code != http.StatusOK || body["status"] != "ok" {
		t.Fatalf("got %d %v", code, body)
	}
}

func TestUnknownAPIPathIsJSON(t *testing.T) {
	rec := httptest.NewRecorder()
	newHandler(nil).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/nope", nil))
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || rec.Code != http.StatusNotFound || body["code"] != "not_found" {
		t.Fatalf("got %d %q (%v)", rec.Code, rec.Body.String(), err)
	}
}
