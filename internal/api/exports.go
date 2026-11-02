package api

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"mime"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/supazd/supabi/internal/api/gen"
	"github.com/supazd/supabi/internal/audit"
	"github.com/supazd/supabi/internal/authz"
	"github.com/supazd/supabi/internal/blob"
	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/exports"
	"github.com/supazd/supabi/internal/query"
	"github.com/supazd/supabi/internal/store"
)

// exportName is a file name without its extension, as the user gave it.
func exportName(given string) (string, error) {
	name := strings.TrimSpace(given)
	if name == "" || utf8.RuneCountInString(name) > 120 || strings.ContainsAny(name, "/\\") || strings.IndexFunc(name, unicode.IsControl) >= 0 {
		return "", badRequest("export_name_invalid", "provide a file name of up to 120 characters without slashes or controls")
	}
	return name, nil
}

func (s *Server) CreateExport(ctx context.Context, req gen.CreateExportRequestObject) (gen.CreateExportResponseObject, error) {
	in := req.Body
	if in == nil {
		return nil, badRequest("invalid_request", "a request body is required")
	}
	name, err := exportName(in.Name)
	if err != nil {
		return nil, err
	}
	if in.Format != "csv" && in.Format != "xlsx" {
		return nil, badRequest("invalid_request", "format must be csv or xlsx")
	}
	if strings.TrimSpace(in.Sql) == "" || len(in.Sql) > 1_000_000 {
		return nil, badRequest("invalid_request", "SQL is empty or too long")
	}
	spec := dataset.Spec{SpecVersion: dataset.CurrentSpecVersion, Source: dataset.Source{Type: "sql", SQL: in.Sql}, Fields: []dataset.Field{{Key: "export", Label: "export", Column: "export", Type: datasource.String, Role: dataset.Dimension}}}
	if in.Params != nil {
		if err := decodeStrict(*in.Params, &spec.Params, "invalid_spec"); err != nil {
			return nil, err
		}
	}
	if err := spec.Validate(); err != nil {
		return nil, err
	}
	d, err := store.GetDatasource(ctx, s.Pool, s.scope(ctx), in.DatasourceId)
	if err != nil {
		return nil, err
	}
	driver, ok := datasource.Lookup(d.Type)
	if !ok {
		return nil, badRequest("unknown_datasource_type", "the data source driver is unavailable")
	}
	workspace, err := store.GetWorkspace(ctx, s.Pool, s.scope(ctx))
	if err != nil {
		return nil, err
	}
	// Validate required/default parameters before queueing, without querying
	// the database. Workers repeat this against the immutable snapshot.
	if _, err = query.SourceSQL(&spec, query.Options{Dialect: driver.Dialect(), Now: time.Now(), Timezone: workspace.Timezone}); err != nil {
		return nil, err
	}
	raw, err := json.Marshal(exports.Snapshot{Spec: spec, Timezone: workspace.Timezone})
	if err != nil {
		return nil, err
	}
	e, err := store.CreateExport(ctx, s.Pool, s.scope(ctx), store.Export{DatasourceID: in.DatasourceId, Name: name, Format: string(in.Format), SourceSpec: raw})
	if errors.Is(err, store.ErrExportLimit) {
		return nil, &apiError{status: 429, code: "export_queue_full", message: "at most five active exports per user"}
	}
	if err != nil {
		return nil, err
	}
	statement := audit.NewStatement("export", in.DatasourceId, in.Sql, nil)
	detail := map[string]any{"datasourceId": in.DatasourceId, "sql": statement.SQL}
	if statement.SQLClipped {
		detail["sqlClipped"] = true
	}
	if in.Params != nil {
		detail["params"] = *in.Params
	}
	s.recordExport(ctx, "export.create", audit.Success, e, detail)
	return gen.CreateExport202JSONResponse(s.exportResponse(e, "")), nil
}

func downloadable(e store.Export) bool {
	return e.Status == "succeeded" && e.CleanedAt == nil && e.ExpiresAt != nil && time.Now().Before(*e.ExpiresAt)
}

func (s *Server) exportResponse(e store.Export, denied string) gen.Export {
	status := e.Status
	if status == "succeeded" && !downloadable(e) {
		status = "expired"
	}
	out := gen.Export{Id: e.ID, Name: e.Name, Format: gen.ExportFormat(e.Format), Source: gen.ExportSource(e.Source), Status: gen.ExportStatus(status), CreatedAt: e.CreatedAt, StartedAt: e.StartedAt, FinishedAt: e.FinishedAt, ExpiresAt: e.ExpiresAt, Rows: e.Rows, SizeBytes: e.SizeBytes, CancelRequested: e.CancelRequested, ErrorCode: optional(e.ErrorCode), Unseen: e.Unseen, Denied: optional(denied)}
	if e.Source == "chart" {
		out.DashboardName, out.ChartName = &e.DashboardName, &e.ChartName
	}
	return out
}

// exportDenial says why the caller may not download an export's file now,
// or "" when they may. The file is checked as its source would be run.
func (s *Server) exportDenial(ctx context.Context, e store.Export) (string, error) {
	if e.Source == "chart" {
		return s.chartExportDenial(ctx, e.DashboardID, e.ItemID, e.ChartID)
	}
	if !callerFrom(ctx).role.AtLeast(authz.Developer) {
		return deniedRole, nil
	}
	_, err := store.GetDatasource(ctx, s.Pool, s.scope(ctx), e.DatasourceID)
	if errors.Is(err, store.ErrNotFound) {
		return deniedSource, nil
	}
	return "", err
}

// describeExport is an export as its owner sees it, with why its file cannot
// be downloaded now if it cannot. Widgets already checked are not again.
func (s *Server) describeExport(ctx context.Context, e store.Export, checked map[string]string) (gen.Export, error) {
	if !downloadable(e) {
		return s.exportResponse(e, ""), nil
	}
	key := e.Source + ":" + e.DashboardID + ":" + e.ItemID + ":" + e.ChartID + ":" + e.DatasourceID
	denied, ok := checked[key]
	if !ok {
		var err error
		if denied, err = s.exportDenial(ctx, e); err != nil {
			return gen.Export{}, err
		}
		checked[key] = denied
	}
	return s.exportResponse(e, denied), nil
}

func (s *Server) ListExports(ctx context.Context, req gen.ListExportsRequestObject) (gen.ListExportsResponseObject, error) {
	list, err := store.ListExports(ctx, s.Pool, s.scope(ctx), req.Params.Before)
	if err != nil {
		return nil, err
	}
	unseen, err := store.UnseenExports(ctx, s.Pool, s.scope(ctx))
	if err != nil {
		return nil, err
	}
	settings, err := store.SystemSettingsInForce(ctx, s.Pool, s.scope(ctx).OrgID)
	if err != nil {
		return nil, err
	}
	out := gen.ExportPage{Items: make([]gen.Export, len(list)), Unseen: unseen, MaxRows: settings.ExportMaxRows, MaxBytes: settings.ExportMaxBytes,
		RetentionSeconds: int64(settings.ExportRetention.Seconds()), TimeoutSeconds: int64(settings.ExportTimeout.Seconds())}
	checked := map[string]string{}
	for i, e := range list {
		if out.Items[i], err = s.describeExport(ctx, e, checked); err != nil {
			return nil, err
		}
	}
	if len(list) == 50 {
		out.NextBefore = &list[len(list)-1].CreatedAt
	}
	return gen.ListExports200JSONResponse(out), nil
}

func (s *Server) GetExport(ctx context.Context, req gen.GetExportRequestObject) (gen.GetExportResponseObject, error) {
	e, err := store.GetExport(ctx, s.Pool, s.scope(ctx), req.Id)
	if err != nil {
		return nil, err
	}
	out, err := s.describeExport(ctx, e, map[string]string{})
	return gen.GetExport200JSONResponse(out), err
}

func (s *Server) MarkExportsSeen(ctx context.Context, _ gen.MarkExportsSeenRequestObject) (gen.MarkExportsSeenResponseObject, error) {
	if err := store.SeeExports(ctx, s.Pool, s.scope(ctx)); err != nil {
		return nil, err
	}
	return gen.MarkExportsSeen204Response{}, nil
}

func (s *Server) CancelExport(ctx context.Context, req gen.CancelExportRequestObject) (gen.CancelExportResponseObject, error) {
	if err := store.CancelExport(ctx, s.Pool, s.scope(ctx), req.Id); err != nil {
		return nil, err
	}
	return gen.CancelExport204Response{}, nil
}

type exportDownload struct {
	file         blob.File
	name, format string
	request      *http.Request
}

func (d exportDownload) VisitDownloadExportResponse(w http.ResponseWriter) error {
	defer d.file.Close()
	typ := "text/csv; charset=utf-8"
	if d.format == "xlsx" {
		typ = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	}
	w.Header().Set("Content-Type", typ)
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": d.name + "." + d.format}))
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// Served from the store as it is read, with ranges for resumed downloads.
	http.ServeContent(w, d.request, d.name, d.file.ModTime(), d.file)
	return nil
}

func (s *Server) DownloadExport(ctx context.Context, req gen.DownloadExportRequestObject) (gen.DownloadExportResponseObject, error) {
	e, err := store.GetExport(ctx, s.Pool, s.scope(ctx), req.Id)
	if err != nil {
		return nil, err
	}
	if e.Status != "succeeded" || e.FileKey == "" {
		return nil, &apiError{status: 409, code: "export_not_ready", message: "the export is not ready"}
	}
	if !downloadable(e) {
		s.recordExport(ctx, "export.download", audit.Denied, e, map[string]any{"reason": "export_expired"})
		return nil, &apiError{status: 410, code: "export_expired", message: "this export has expired; run another export"}
	}
	// The caller must still be allowed what made the file: an exported
	// snapshot does not become a public attachment.
	denied, err := s.exportDenial(ctx, e)
	if err != nil {
		return nil, err
	}
	if denied != "" {
		s.recordExport(ctx, "export.download", audit.Denied, e, map[string]any{"reason": denied})
		return nil, &apiError{status: 403, code: denied, message: "you may no longer download this export"}
	}
	if s.Exports == nil {
		return nil, errors.New("export files unavailable")
	}
	// Streamed through the API rather than by a presigned URL, which would
	// skip the checks above for as long as it is valid.
	f, err := s.Exports.Files.Open(ctx, e.FileKey)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, &apiError{status: 410, code: "export_file_missing", message: "the export file is no longer available"}
	}
	if err != nil {
		return nil, err
	}
	s.recordExport(ctx, "export.download", audit.Success, e, map[string]any{"rows": e.Rows, "bytes": e.SizeBytes})
	return exportDownload{file: f, name: e.Name, format: e.Format, request: callerFrom(ctx).r}, nil
}
