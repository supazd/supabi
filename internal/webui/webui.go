// Package webui serves the single-page frontend from the binary.
package webui

import (
	"bytes"
	"compress/gzip"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strconv"
	"strings"
)

// Handler serves the embedded frontend, or reports that there is none.
func Handler() http.Handler {
	return newHandler(assets())
}

func newHandler(fsys fs.FS) http.Handler {
	if fsys == nil {
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "This build does not include the web interface. Build with `make build`, or run the Vite dev server from web/.", http.StatusNotFound)
		})
	}
	shell, err := fs.ReadFile(fsys, "index.html")
	if err != nil {
		panic("webui: embedded frontend has no index.html: " + err.Error())
	}
	files := http.FileServerFS(fsys)
	gz := precompress(fsys)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, http.StatusText(http.StatusMethodNotAllowed), http.StatusMethodNotAllowed)
			return
		}
		name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		// index.html is only ever served as the app shell below: the file
		// server would answer a direct request for it with a redirect.
		if info, err := fs.Stat(fsys, name); name != "" && name != "index.html" && err == nil && !info.IsDir() {
			if strings.HasPrefix(name, "assets/") {
				// Vite puts a content hash in these file names.
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			}
			if z, ok := gz[name]; ok {
				w.Header().Add("Vary", "Accept-Encoding")
				// A range is of the bytes sent, so the file server answers those.
				if acceptsGzip(r) && r.Header.Get("Range") == "" {
					writeGzip(w, r, mime.TypeByExtension(path.Ext(name)), z)
					return
				}
			}
			files.ServeHTTP(w, r)
			return
		}
		// A missing file with an extension is a real 404; anything else is a
		// client-side route and gets the app shell.
		if name != "index.html" && path.Ext(name) != "" {
			http.NotFound(w, r)
			return
		}
		// Written directly: the file-serving helpers redirect any path ending
		// in /index.html and reject paths containing "..".
		w.Header().Set("Cache-Control", "no-cache")
		if z, ok := gz["index.html"]; ok {
			w.Header().Add("Vary", "Accept-Encoding")
			if acceptsGzip(r) {
				writeGzip(w, r, "text/html; charset=utf-8", z)
				return
			}
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		if r.Method == http.MethodGet {
			_, _ = w.Write(shell)
		}
	})
}

// compressible are the kinds of file worth gzipping: images and fonts are
// compressed already. Each has a Content-Type Go knows without sniffing.
var compressible = map[string]bool{
	".js": true, ".mjs": true, ".css": true, ".html": true,
	".svg": true, ".json": true, ".xml": true, ".wasm": true,
}

// precompress gzips the text files once, when the handler is made: they never
// change, so no request pays for it. A file that would not shrink is left out.
func precompress(fsys fs.FS) map[string][]byte {
	out := map[string][]byte{}
	_ = fs.WalkDir(fsys, ".", func(name string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !compressible[path.Ext(name)] {
			return nil
		}
		data, err := fs.ReadFile(fsys, name)
		if err != nil {
			return nil
		}
		var buf bytes.Buffer
		zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
		_, _ = zw.Write(data)
		_ = zw.Close()
		if buf.Len() < len(data) {
			out[name] = buf.Bytes()
		}
		return nil
	})
	return out
}

// acceptsGzip reports whether the client listed gzip, and not with q=0.
func acceptsGzip(r *http.Request) bool {
	for _, part := range strings.Split(strings.Join(r.Header.Values("Accept-Encoding"), ","), ",") {
		coding, params, _ := strings.Cut(part, ";")
		if !strings.EqualFold(strings.TrimSpace(coding), "gzip") {
			continue
		}
		q, err := strconv.ParseFloat(strings.TrimPrefix(strings.TrimSpace(params), "q="), 64)
		return err != nil || q > 0
	}
	return false
}

func writeGzip(w http.ResponseWriter, r *http.Request, contentType string, body []byte) {
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Encoding", "gzip")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	if r.Method == http.MethodGet {
		_, _ = w.Write(body)
	}
}
