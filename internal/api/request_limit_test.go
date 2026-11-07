package api

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A body that the server in front cuts off at its limit is reported as too
// large, not as malformed: .agents/design/configuration.md 12. Decoding comes
// before authentication, so nothing here reaches the database.
func TestBodyCutOffAtTheLimit(t *testing.T) {
	api := &Server{Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	mux := http.NewServeMux()
	api.Register(mux)
	// What internal/server does for a body that does not say its length.
	limited := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, 1<<10)
		mux.ServeHTTP(w, r)
	})
	post := func(body string) (int, map[string]any) {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.ContentLength = -1
		rec := httptest.NewRecorder()
		limited.ServeHTTP(rec, req)
		var decoded map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &decoded); err != nil {
			t.Fatalf("invalid JSON %q", rec.Body.String())
		}
		return rec.Code, decoded
	}

	code, body := post(`{"email":"` + strings.Repeat("x", 2<<10) + `","password":"p"}`)
	if params, _ := body["params"].(map[string]any); code != http.StatusRequestEntityTooLarge || body["code"] != "request_too_large" || params["limit"] != "1KB" {
		t.Errorf("cut off: %d %v", code, body)
	}
	if code, body := post(`{"email":`); code != http.StatusBadRequest || body["code"] != "invalid_request" {
		t.Errorf("malformed within the limit: %d %v", code, body)
	}
}
