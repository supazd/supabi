package api

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/supazd/supabi/internal/api/gen"
	"github.com/supazd/supabi/internal/audit"
	"github.com/supazd/supabi/internal/content"
	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/exports"
	"github.com/supazd/supabi/internal/query"
	"github.com/supazd/supabi/internal/store"
)

// chartExportSnapshot is what a chart export runs: the widget's query as it
// resolved for the values given when the export was made, and the columns to
// write. Data permissions are not part of it; they apply as of each run.
type chartExportSnapshot struct {
	DatasetID string         `json:"datasetId"`
	Query     query.Query    `json:"query"`
	Columns   []exportColumn `json:"columns"`
	Timezone  string         `json:"timezone"`
	WeekStart int            `json:"weekStart"`
}

type exportColumn struct {
	Name   string `json:"name"`
	Header string `json:"header"`
}

// Why an export cannot be downloaded, or run, now. See .agents/design/exports.md §4.
const (
	deniedRole      = "export_role"
	deniedDisabled  = "export_chart_disabled"
	deniedDashboard = "export_dashboard_unavailable"
	deniedSource    = "export_source_missing"
)

func (s *Server) CreateDashboardExport(ctx context.Context, req gen.CreateDashboardExportRequestObject) (gen.CreateDashboardExportResponseObject, error) {
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
	dc, err := s.loadDashboard(ctx, req.Id, func(*content.DashboardSpec) []string { return []string{req.ItemId} })
	if err != nil {
		return nil, err
	}
	item, ok := dc.spec.ItemByID(req.ItemId)
	if !ok || item.ChartID == "" {
		return nil, store.ErrNotFound
	}
	if chart, found := dc.charts[item.ChartID]; !found {
		return nil, store.ErrNotFound
	} else if !chart.AllowExport {
		return nil, &apiError{status: 403, code: deniedDisabled, message: "this chart does not allow exports"}
	}
	q, chart, target, err := s.dashboardItemQuery(ctx, dc, req.ItemId, gen.DashboardDataRequest{
		Filters: in.Filters, ChartFilters: in.ChartFilters, Selections: in.Selections, UseChartFilters: in.UseChartFilters, Links: in.Links, Drill: in.Drill,
	})
	if err != nil {
		return nil, err
	}
	workspace, err := store.GetWorkspace(ctx, s.Pool, s.scope(ctx))
	if err != nil {
		return nil, err
	}
	settings, err := store.SystemSettingsInForce(ctx, s.Pool, s.scope(ctx).OrgID)
	if err != nil {
		return nil, err
	}
	// Compiling now rejects what would fail anyway, a field the caller may
	// not see among them, before anything is queued.
	compiled, err := s.compileExport(ctx, target.stored, target.spec, &q, time.Now(), workspace.Timezone, workspace.WeekStart, settings.ExportMaxRows)
	if err != nil {
		return nil, s.datasetFieldError(ctx, target.stored.ID, err)
	}
	snapshot := chartExportSnapshot{DatasetID: target.stored.ID, Query: q, Timezone: workspace.Timezone, WeekStart: workspace.WeekStart}
	var hidden []string
	if chart.Viz.Type == "table" {
		hidden = chart.Viz.HiddenColumns
	}
	headers := map[string]string{}
	if in.Headers != nil {
		headers = *in.Headers
	}
	for _, column := range compiled.Columns {
		if slices.Contains(hidden, column.Name) {
			continue
		}
		snapshot.Columns = append(snapshot.Columns, exportColumn{Name: column.Name, Header: exportHeader(headers[column.Name], column)})
	}
	raw, err := json.Marshal(snapshot)
	if err != nil {
		return nil, err
	}
	e, err := store.CreateExport(ctx, s.Pool, s.scope(ctx), store.Export{
		DatasourceID: target.stored.DatasourceID, Name: name, Format: string(in.Format), SourceSpec: raw,
		Source: "chart", DashboardID: req.Id, ItemID: req.ItemId, ChartID: item.ChartID, DashboardName: dc.name, ChartName: dc.names[item.ChartID],
	})
	if errors.Is(err, store.ErrExportLimit) {
		return nil, &apiError{status: 429, code: "export_queue_full", message: "at most five active exports per user"}
	}
	if err != nil {
		return nil, err
	}
	s.recordExport(ctx, "export.create", audit.Success, e, map[string]any{
		"dashboardId": req.Id, "itemId": req.ItemId, "chartId": item.ChartID, "datasetId": target.stored.ID, "dashboardName": dc.name, "chartName": dc.names[item.ChartID],
		"values": map[string]any{"filters": in.Filters, "chartFilters": in.ChartFilters, "selections": in.Selections, "useChartFilters": in.UseChartFilters, "links": in.Links, "drill": in.Drill},
	})
	return gen.CreateDashboardExport202JSONResponse(s.exportResponse(e, "")), nil
}

// exportHeader is what the page called a column, if it said, and else the
// dataset's name for it.
func exportHeader(given string, column query.OutputColumn) string {
	given = strings.TrimSpace(given)
	if given != "" && utf8.RuneCountInString(given) <= 200 && strings.IndexFunc(given, unicode.IsControl) < 0 {
		return given
	}
	if column.Label != "" {
		return column.Label
	}
	return column.Name
}

// compileExport compiles a chart export's query as the caller may see the
// dataset. Without a row limit of its own the query asks for one more row than
// an export may have, so an oversized result fails instead of being cut off.
func (s *Server) compileExport(ctx context.Context, stored store.Dataset, spec *dataset.Spec, q *query.Query, now time.Time, timezone string, weekStart int, maxRows int64) (*query.Compiled, error) {
	d, err := s.datasetDialect(ctx, stored)
	if err != nil {
		return nil, err
	}
	c := callerFrom(ctx)
	scope, err := s.scopeFor(ctx, c.role, c.principal.UserID, stored.ID, spec, d)
	if err != nil {
		return nil, err
	}
	return query.Compile(q, spec, query.Options{
		Dialect: d, Now: now, Timezone: timezone, WeekStart: weekStart,
		DefaultLimit: int(maxRows) + 1, MaxLimit: int(maxRows) + 1,
		RowFilter: scope.rows, Hidden: scope.hidden,
	})
}

// chartExportDenial says why the caller may not export the chart on the
// widget now, or "" when they may.
func (s *Server) chartExportDenial(ctx context.Context, dashboardID, itemID, chartID string) (string, error) {
	denied, _, err := s.exportedChart(ctx, dashboardID, itemID, chartID)
	return denied, err
}

// exportedChart is the chart on the widget, with why the caller may not
// export it now, or "" when they may.
func (s *Server) exportedChart(ctx context.Context, dashboardID, itemID, chartID string) (string, store.Chart, error) {
	d, err := s.getDashboard(ctx, dashboardID)
	if errors.Is(err, store.ErrNotFound) {
		return deniedDashboard, store.Chart{}, nil
	}
	if err != nil {
		return "", store.Chart{}, err
	}
	var spec content.DashboardSpec
	if err := json.Unmarshal(d.Spec, &spec); err != nil {
		return "", store.Chart{}, err
	}
	if item, ok := spec.ItemByID(itemID); !ok || item.ChartID != chartID {
		return deniedDashboard, store.Chart{}, nil
	}
	chart, err := store.GetChart(ctx, s.Pool, s.scope(ctx), chartID)
	if errors.Is(err, store.ErrNotFound) {
		return deniedDashboard, store.Chart{}, nil
	}
	if err != nil {
		return "", chart, err
	}
	var chartSpec content.ChartSpec
	if err := json.Unmarshal(chart.Spec, &chartSpec); err != nil {
		return "", chart, err
	}
	if !chartSpec.AllowExport {
		return deniedDisabled, chart, nil
	}
	return "", chart, nil
}

// asOwner acts as the owner of an export as they are now, for a worker that
// has no session of theirs.
func (s *Server) asOwner(ctx context.Context, e store.Export) (context.Context, error) {
	p, role, err := store.ExportOwner(ctx, s.Pool, store.Scope{OrgID: e.OrgID, WorkspaceID: e.WorkspaceID, UserID: e.UserID})
	if err != nil {
		return nil, err
	}
	if role == "" {
		return nil, exports.ErrForbidden
	}
	return context.WithValue(ctx, callerKey{}, &caller{principal: &p, role: role}), nil
}

// ChartExport implements exports.Charts.
func (s *Server) ChartExport(ctx context.Context, e store.Export, now time.Time, maxRows int64) (exports.ChartStatement, error) {
	ctx, err := s.asOwner(ctx, e)
	if err != nil {
		return exports.ChartStatement{}, err
	}
	denied, chart, err := s.exportedChart(ctx, e.DashboardID, e.ItemID, e.ChartID)
	switch {
	case err != nil:
		return exports.ChartStatement{}, err
	case denied == deniedDisabled:
		return exports.ChartStatement{}, exports.ErrChartDisabled
	case denied != "":
		return exports.ChartStatement{}, exports.ErrForbidden
	}
	var snapshot chartExportSnapshot
	if err := json.Unmarshal(e.SourceSpec, &snapshot); err != nil {
		return exports.ChartStatement{}, err
	}
	// Viewers reach a dataset through the charts on their dashboards. Once
	// the chart reads another one, the snapshot's is no longer theirs to read.
	if chart.DatasetID != snapshot.DatasetID {
		return exports.ChartStatement{}, exports.ErrForbidden
	}
	stored, spec, err := s.loadDataset(ctx, snapshot.DatasetID)
	if err != nil {
		return exports.ChartStatement{}, err
	}
	compiled, err := s.compileExport(ctx, stored, spec, &snapshot.Query, now, snapshot.Timezone, snapshot.WeekStart, maxRows)
	if err != nil {
		return exports.ChartStatement{}, err
	}
	out := exports.ChartStatement{DatasourceID: stored.DatasourceID, SQL: compiled.SQL, Args: compiled.Args, Limit: int64(compiled.Limit)}
	for _, column := range snapshot.Columns {
		at := -1
		for i, output := range compiled.Columns {
			if output.Name == column.Name {
				at = i
				break
			}
		}
		if at < 0 {
			return exports.ChartStatement{}, errors.New("an exported column is no longer in the query")
		}
		out.Columns = append(out.Columns, at)
		out.Headers = append(out.Headers, column.Header)
	}
	return out, nil
}
