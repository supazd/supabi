package server

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
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

func TestLimitBody(t *testing.T) {
	const limit = 1 << 10
	var read int
	var readErr error
	h := limitBody(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var b []byte
		b, readErr = io.ReadAll(r.Body)
		read = len(b)
	}), limit)
	serve := func(body string, length int64) *httptest.ResponseRecorder {
		read, readErr = -1, nil
		req := httptest.NewRequest(http.MethodPost, "/api/v1/query", strings.NewReader(body))
		req.ContentLength = length
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}

	if serve(strings.Repeat("x", limit), limit); read != limit || readErr != nil {
		t.Errorf("at the limit: read %d, %v", read, readErr)
	}
	// A length over the limit is refused before the handler reads anything.
	rec := serve(strings.Repeat("x", limit+1), limit+1)
	var body struct {
		Code   string
		Params map[string]string
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || rec.Code != http.StatusRequestEntityTooLarge ||
		body.Code != "request_too_large" || body.Params["limit"] != "1KB" || read != -1 {
		t.Errorf("declared too large: %d %q, handler read %d", rec.Code, rec.Body.String(), read)
	}
	// With no length, the body is cut off where it passes the limit.
	var tooLarge *http.MaxBytesError
	if serve(strings.Repeat("x", 2*limit), -1); !errors.As(readErr, &tooLarge) || tooLarge.Limit != limit {
		t.Errorf("undeclared too large: read %d, %v", read, readErr)
	}
}

// A client that says it will send too much is answered at once, without the
// server waiting for the body.
func TestLimitBodyAnswersBeforeTheBody(t *testing.T) {
	srv := httptest.NewServer(limitBody(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("the handler ran")
	}), 1<<20))
	defer srv.Close()
	conn, err := net.Dial("tcp", srv.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.WriteString(conn, "POST /api/v1/query HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 67108864\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Errorf("got %s", resp.Status)
	}
}
