// Package api implements the HTTP API defined in api/openapi.yaml.
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/supazd/supabi/internal/api/gen"
	"github.com/supazd/supabi/internal/assistant"
	"github.com/supazd/supabi/internal/audit"
	"github.com/supazd/supabi/internal/buildinfo"
	"github.com/supazd/supabi/internal/config"
	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/exports"
	"github.com/supazd/supabi/internal/qcache"
	"github.com/supazd/supabi/internal/secret"
	"github.com/supazd/supabi/internal/store"
)

const connectTimeout = 10 * time.Second

// statusClientClosed answers a request its client has left, as nginx logs it.
const statusClientClosed = 499

// Server holds what the handlers need. It implements gen.StrictServerInterface.
type Server struct {
	Exports *exports.Service
	Pool    *pgxpool.Pool
	Secrets *secret.Box
	Conns   *datasource.Manager
	// Logins throttles password guessing per email address, across instances.
	Logins *store.LoginThrottle
	Logger *slog.Logger
	// Now is replaceable so tests can pin relative time ranges.
	Now func() time.Time
	// Cache keeps query results and merges identical queries. It is required;
	// qcache.New(nil, logger) keeps nothing but still merges.
	Cache *qcache.Cache
	// CacheTTL is how long results are kept unless a data source says
	// otherwise. Nil reads the system settings; tests replace it to keep
	// nothing.
	CacheTTL func(ctx context.Context) (time.Duration, error)
	// Audit keeps what people did and read; see .agents/design/access-control.md §7.
	Audit audit.Recorder
	// Assistant answers people in their conversations.
	Assistant *assistant.Service
}

var _ gen.StrictServerInterface = (*Server)(nil)

// Register mounts the API on mux under /api/v1, and the endpoints of OAuth
// and MCP beside it.
func (s *Server) Register(mux *http.ServeMux) {
	// The last middleware runs first: authenticate identifies the caller
	// that recordAudit then records.
	strict := gen.NewStrictHandlerWithOptions(s, []gen.StrictMiddlewareFunc{s.recordAudit, s.authenticate}, gen.StrictHTTPServerOptions{
		RequestErrorHandlerFunc: func(w http.ResponseWriter, _ *http.Request, err error) {
			writeError(w, requestError(err))
		},
		ResponseErrorHandlerFunc: func(w http.ResponseWriter, r *http.Request, err error) {
			writeError(w, s.toAPIError(r.Context(), err))
		},
	})
	gen.HandlerWithOptions(strict, gen.StdHTTPServerOptions{
		BaseURL:    "/api/v1",
		BaseRouter: mux,
		ErrorHandlerFunc: func(w http.ResponseWriter, _ *http.Request, err error) {
			writeError(w, &apiError{status: http.StatusBadRequest, code: "invalid_request", message: err.Error()})
		},
	})
	s.registerOAuth(mux)
}

func (s *Server) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *Server) GetVersion(context.Context, gen.GetVersionRequestObject) (gen.GetVersionResponseObject, error) {
	// No build leaves anything out at the moment.
	features := []string{}
	return gen.GetVersion200JSONResponse{Version: buildinfo.Version, Commit: buildinfo.Commit, Features: features}, nil
}

// ---- errors ----

// apiError is an error with a decided HTTP status. Handlers return errors and
// one place turns them into responses, so every error has the same shape.
type apiError struct {
	status  int
	code    string
	message string
	params  map[string]string
	// position is where in the caller's SQL the problem is, in characters.
	position *int
}

func (e *apiError) Error() string { return e.code + ": " + e.message }

// requestError reports a request body that could not be read. One cut off at
// the limit of the startup configuration gets the answer the server gives one
// that says beforehand it is too large: .agents/design/configuration.md 12.
func requestError(err error) *apiError {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		return &apiError{status: http.StatusRequestEntityTooLarge, code: "request_too_large", message: "the request body is larger than the server accepts",
			params: map[string]string{"limit": config.FormatBytes(tooLarge.Limit)}}
	}
	return &apiError{status: http.StatusBadRequest, code: "invalid_request", message: err.Error()}
}

func badRequest(code, message string) *apiError {
	return &apiError{status: http.StatusBadRequest, code: code, message: message}
}

func (s *Server) toAPIError(ctx context.Context, err error) *apiError {
	var (
		apiErr   *apiError
		specErr  *dataset.Error
		queryErr *datasource.QueryError
	)
	switch {
	case errors.As(err, &apiErr):
		return apiErr
	case errors.As(err, &specErr):
		return &apiError{status: http.StatusBadRequest, code: specErr.Code, message: specErr.Message, params: specErr.Params}
	case errors.As(err, &queryErr):
		return &apiError{status: http.StatusUnprocessableEntity, code: "database_error", message: queryErr.Message}
	case errors.Is(err, store.ErrNotFound):
		return &apiError{status: http.StatusNotFound, code: "not_found", message: "not found"}
	case errors.Is(err, store.ErrConflict):
		return &apiError{status: http.StatusConflict, code: "name_taken", message: "the name is already in use"}
	case errors.Is(err, store.ErrDeletedWorkspaceName):
		return &apiError{status: http.StatusConflict, code: "workspace_name_deleted", message: "a deleted workspace still has the name; restore it or delete it now first"}
	case errors.Is(err, store.ErrWorkspaceDeleted):
		return &apiError{status: http.StatusConflict, code: "workspace_deleted", message: "the workspace is already deleted"}
	case errors.Is(err, store.ErrWorkspaceNotDeleted):
		return &apiError{status: http.StatusConflict, code: "workspace_not_deleted", message: "only a deleted workspace can be restored or deleted for good"}
	case errors.Is(err, store.ErrCycle):
		return &apiError{status: http.StatusBadRequest, code: "folder_cycle", message: "a folder cannot be moved into itself"}
	case errors.Is(err, store.ErrInUse):
		return &apiError{status: http.StatusConflict, code: "in_use", message: "it is still used by other objects"}
	case errors.Is(err, store.ErrDatasetChanged):
		return &apiError{status: http.StatusConflict, code: "dataset_revision_conflict", message: "the dataset changed while this content was being saved; reload it before saving again"}
	case errors.Is(err, store.ErrRevisionConflict):
		return &apiError{status: http.StatusConflict, code: "resource_revision_conflict", message: "this resource has changed; compare your draft with the latest version before saving"}
	case errors.Is(err, store.ErrChartChanged):
		return &apiError{status: http.StatusConflict, code: "chart_revision_conflict", message: "a chart changed while this dashboard was being saved; reload it before saving again"}
	case errors.Is(err, store.ErrAssistantNotConfigured):
		return &apiError{status: http.StatusConflict, code: "assistant_not_configured", message: "no model is set for the assistant"}
	case errors.Is(err, store.ErrAssistantBusy):
		return &apiError{status: http.StatusConflict, code: "assistant_busy", message: "an answer is being written in this conversation"}
	case errors.Is(err, store.ErrNotRetryable):
		return &apiError{status: http.StatusConflict, code: "not_retryable", message: "only the last answer can be written again, after it failed"}
	case errors.Is(err, assistant.ErrMessageTooLong):
		return &apiError{status: http.StatusBadRequest, code: "message_too_long", message: "the message is too long for the model"}
	case errors.Is(err, datasource.ErrBusy):
		return &apiError{status: http.StatusServiceUnavailable, code: "datasource_busy", message: "too many queries are waiting for the data source; try again shortly"}
	case errors.Is(err, datasource.ErrQueueTimeout):
		return &apiError{status: http.StatusGatewayTimeout, code: "queue_timeout", message: "the data source was too busy to start the query in time"}
	case errors.Is(err, context.DeadlineExceeded):
		return &apiError{status: http.StatusGatewayTimeout, code: "timeout", message: "the database took too long to answer"}
	case errors.Is(err, context.Canceled):
		// The client left, as pages do with what they no longer need; nobody
		// reads the answer, and nothing went wrong: .agents/design/query-ir.md 6.7.
		return &apiError{status: statusClientClosed, code: "canceled", message: "the request was cancelled"}
	}
	// Anything else is ours to fix; the details stay in the log.
	s.Logger.ErrorContext(ctx, "request failed", "error", err)
	return &apiError{status: http.StatusInternalServerError, code: "internal", message: "internal error"}
}

// databaseError classifies a failure from a user database. What the database
// said about the statement goes back to the caller; a failure to reach it is
// reported as such, without the connection details.
func (s *Server) databaseError(ctx context.Context, datasourceID string, err error) error {
	var queryErr *datasource.QueryError
	if errors.As(err, &queryErr) || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) ||
		errors.Is(err, datasource.ErrBusy) || errors.Is(err, datasource.ErrQueueTimeout) {
		return err
	}
	s.Logger.WarnContext(ctx, "data source unreachable", "datasource", datasourceID, "error", err)
	return &apiError{status: http.StatusBadGateway, code: "datasource_unreachable", message: "cannot reach the data source", params: map[string]string{"id": datasourceID}}
}

func writeError(w http.ResponseWriter, e *apiError) {
	body := gen.Error{Code: e.code, Message: e.message}
	if len(e.params) > 0 {
		body.Params = &e.params
	}
	body.Position = e.position
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(e.status)
	_ = json.NewEncoder(w).Encode(body)
}

// decodeStrict converts a loosely typed JSON object into a typed one, refusing
// keys the type does not know. A misspelt key is then an error instead of
// being silently ignored, which matters most for specs written by AI. A part
// that says what is wrong with it in its own terms keeps them; anything else
// is reported under code.
func decodeStrict(from any, into any, code string) error {
	raw, err := json.Marshal(from)
	if err != nil {
		return badRequest(code, err.Error())
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(into); err != nil {
		var specErr *dataset.Error
		if errors.As(err, &specErr) {
			return specErr
		}
		return badRequest(code, err.Error())
	}
	return nil
}
