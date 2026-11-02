package webui

import (
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func request(h http.Handler, method, target string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(method, target, nil))
	return rec
}

func TestHandlerServesAppShellAndAssets(t *testing.T) {
	h := newHandler(fstest.MapFS{
		"index.html":    {Data: []byte("<html>shell</html>")},
		"assets/app.js": {Data: []byte("console.log(1)")},
	})
	tests := []struct {
		target    string
		status    int
		body      string
		cache     string
		typPrefix string
	}{
		{"/", 200, "<html>shell</html>", "no-cache", "text/html"},
		{"/dashboards/42", 200, "<html>shell</html>", "no-cache", "text/html"},
		{"/assets/app.js", 200, "console.log(1)", "public, max-age=31536000, immutable", "text/javascript"},
		{"/assets/missing.js", 404, "", "", ""},
		{"/favicon.ico", 404, "", "", ""},
		{"/index.html", 200, "<html>shell</html>", "no-cache", "text/html"},
		{"/assets/../index.html", 200, "<html>shell</html>", "no-cache", "text/html"},
		{"/assets", 200, "<html>shell</html>", "no-cache", "text/html"},
	}
	for _, tt := range tests {
		rec := request(h, http.MethodGet, tt.target)
		if rec.Code != tt.status {
			t.Errorf("GET %s: status %d, want %d", tt.target, rec.Code, tt.status)
			continue
		}
		if tt.status != 200 {
			continue
		}
		if got := rec.Body.String(); got != tt.body {
			t.Errorf("GET %s: body %q, want %q", tt.target, got, tt.body)
		}
		if tt.cache != "" && rec.Header().Get("Cache-Control") != tt.cache {
			t.Errorf("GET %s: Cache-Control %q, want %q", tt.target, rec.Header().Get("Cache-Control"), tt.cache)
		}
		if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, tt.typPrefix) {
			t.Errorf("GET %s: Content-Type %q, want prefix %q", tt.target, ct, tt.typPrefix)
		}
	}
	if rec := request(h, http.MethodPost, "/"); rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST /: status %d, want 405", rec.Code)
	}
}

func TestHandlerGzipsTextAssets(t *testing.T) {
	script := strings.Repeat("console.log('supabi');\n", 200)
	image := strings.Repeat("\x89PNG", 200)
	h := newHandler(fstest.MapFS{
		"index.html":      {Data: []byte("<html>shell</html>")},
		"assets/app.js":   {Data: []byte(script)},
		"assets/logo.png": {Data: []byte(image)},
	})
	get := func(target, accept string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, target, nil)
		if accept != "" {
			req.Header.Set("Accept-Encoding", accept)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}

	rec := get("/assets/app.js", "br, gzip")
	if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding %q, want gzip", got)
	}
	if rec.Body.Len() >= len(script) {
		t.Errorf("sent %d bytes for a script of %d", rec.Body.Len(), len(script))
	}
	zr, err := gzip.NewReader(rec.Body)
	if err != nil {
		t.Fatal(err)
	}
	if body, _ := io.ReadAll(zr); string(body) != script {
		t.Errorf("the script does not survive the round trip")
	}
	for header, want := range map[string]string{
		"Vary":          "Accept-Encoding",
		"Cache-Control": "public, max-age=31536000, immutable",
	} {
		if got := rec.Header().Get(header); got != want {
			t.Errorf("%s %q, want %q", header, got, want)
		}
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/javascript") {
		t.Errorf("Content-Type %q, want text/javascript", ct)
	}

	// Not asked for, or refused: the file as it is, and caches told why.
	for _, accept := range []string{"", "identity", "gzip;q=0"} {
		rec := get("/assets/app.js", accept)
		if rec.Header().Get("Content-Encoding") != "" || rec.Body.String() != script {
			t.Errorf("Accept-Encoding %q: the script was not sent as it is", accept)
		}
		if rec.Header().Get("Vary") != "Accept-Encoding" {
			t.Errorf("Accept-Encoding %q: Vary %q", accept, rec.Header().Get("Vary"))
		}
	}

	// Images are compressed already, and the shell here is too short to shrink.
	for _, target := range []string{"/assets/logo.png", "/"} {
		if rec := get(target, "gzip"); rec.Header().Get("Content-Encoding") != "" {
			t.Errorf("GET %s was gzipped", target)
		}
	}
}

func TestHandlerWithoutFrontend(t *testing.T) {
	rec := request(newHandler(nil), http.MethodGet, "/")
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "does not include the web interface") {
		t.Errorf("got %d %q", rec.Code, rec.Body.String())
	}
}
