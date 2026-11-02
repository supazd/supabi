// Package server is the HTTP server of the api role.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"time"

	"github.com/supazd/supabi/internal/webui"
)

type Server struct {
	addr            string
	handler         http.Handler
	logger          *slog.Logger
	shutdownTimeout time.Duration
}

// ReadyFunc reports whether the server's dependencies are usable.
type ReadyFunc func(ctx context.Context) error

// Routes mounts handlers on the server's mux.
type Routes func(mux *http.ServeMux)

func New(addr string, shutdownTimeout time.Duration, api Routes, ready ReadyFunc, logger *slog.Logger) *Server {
	return &Server{addr: addr, handler: NewHandler(api, ready, logger), logger: logger, shutdownTimeout: shutdownTimeout}
}

// NewHandler builds the route table. It is exported so tests can exercise it
// without a listener.
func NewHandler(api Routes, ready ReadyFunc, logger *slog.Logger) http.Handler {
	mux := http.NewServeMux()
	// Liveness: the process is up. Must not depend on anything external.
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	// Readiness: the process can serve requests.
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := ready(ctx); err != nil {
			logger.Warn("readiness check failed", "error", err)
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "unavailable"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	if api != nil {
		api(mux)
	}
	// An unknown API path is an API error, never the frontend's HTML.
	mux.HandleFunc("/api/", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusNotFound, map[string]string{"code": "not_found"})
	})
	mux.Handle("/", webui.Handler())
	return mux
}

// Run serves until ctx is cancelled, then shuts down gracefully.
func (s *Server) Run(ctx context.Context) error {
	ln, err := net.Listen("tcp", s.addr)
	if err != nil {
		return err
	}
	srv := &http.Server{Handler: s.handler, ReadHeaderTimeout: 10 * time.Second}
	s.logger.Info("api listening", "addr", ln.Addr().String())

	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(ln) }()

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), s.shutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return err
	}
	if err := <-errc; !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
