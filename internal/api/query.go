package api

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/supazd/supabi/internal/api/gen"
	"github.com/supazd/supabi/internal/authz"
	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/id"
	"github.com/supazd/supabi/internal/qcache"
	"github.com/supazd/supabi/internal/query"
	"github.com/supazd/supabi/internal/store"
)

func (s *Server) RunQuery(ctx context.Context, req gen.RunQueryRequestObject) (gen.RunQueryResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("invalid_request", "a request body is required")
	}
	var q query.Query
	if err := decodeStrict(req.Body.Query, &q, "invalid_query"); err != nil {
		return nil, err
	}
	if q.Dataset == "" {
		return nil, badRequest("invalid_query", "the query names no dataset")
	}
	noteObject(ctx, "dataset", q.Dataset)
	if o := req.Body.Options; o != nil && o.Cache != nil {
		mode := qcache.Mode(*o.Cache)
		if !mode.Valid() {
			return nil, badRequest("invalid_request", "options.cache must be default, refresh or bypass")
		}
		ctx = withCacheMode(ctx, mode)
	}
	if o := req.Body.Options; o != nil && o.MaxAge != nil {
		if o.Cache != nil && qcache.Mode(*o.Cache) != qcache.Default {
			return nil, badRequest("invalid_request", "options.maxAge goes only with the default cache mode")
		}
		var err error
		if ctx, err = withMaxAge(ctx, *o.MaxAge); err != nil {
			return nil, err
		}
	}
	stored, spec, err := s.loadDataset(ctx, q.Dataset)
	if errors.Is(err, store.ErrNotFound) {
		return nil, &apiError{status: 404, code: "dataset_not_found", message: "the dataset does not exist", params: map[string]string{"id": q.Dataset}}
	}
	if err != nil {
		return nil, err
	}
	if req.Body.Options != nil {
		ctx, err = withQueryDiagnostics(ctx, req.Body.Options.Diagnostics)
		if err != nil {
			return nil, err
		}
	}
	result, err := s.execute(ctx, stored, spec, &q)
	if err != nil {
		return nil, err
	}
	return gen.RunQuery200JSONResponse(result), nil
}

// ResolveTimeRange says which dates a filter's time range keeps now, as a
// query in this workspace would resolve it.
func (s *Server) ResolveTimeRange(ctx context.Context, req gen.ResolveTimeRangeRequestObject) (gen.ResolveTimeRangeResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("invalid_request", "a request body is required")
	}
	var tr query.TimeRange
	if err := decodeStrict(req.Body.Range, &tr, "invalid_time_range"); err != nil {
		return nil, err
	}
	workspace, err := store.GetWorkspace(ctx, s.Pool, s.scope(ctx))
	if err != nil {
		return nil, err
	}
	start, end, err := query.ResolveTimeRange(&tr, s.now(), workspace.Timezone, workspace.WeekStart)
	if err != nil {
		return nil, err
	}
	const wall = "2006-01-02T15:04:05"
	var out gen.TimeRangeDates
	if !start.IsZero() {
		out.Start = new(start.Format(wall))
	}
	if !end.IsZero() {
		out.End = new(end.Format(wall))
	}
	return gen.ResolveTimeRange200JSONResponse(out), nil
}

func (s *Server) loadDataset(ctx context.Context, datasetID string) (store.Dataset, *dataset.Spec, error) {
	stored, err := store.GetDataset(ctx, s.Pool, s.scope(ctx), datasetID)
	if err != nil {
		return stored, nil, err
	}
	var spec dataset.Spec
	return stored, &spec, json.Unmarshal(stored.Spec, &spec)
}

// execute compiles a query against a dataset and runs it on the dataset's
// data source, in the workspace's time zone, limited to what the caller may
// see of the dataset.
func (s *Server) execute(ctx context.Context, stored store.Dataset, spec *dataset.Spec, q *query.Query) (gen.QueryResult, error) {
	var scope dataScope
	if c := callerFrom(ctx); !c.role.AtLeast(authz.Developer) {
		d, err := s.datasetDialect(ctx, stored)
		if err != nil {
			return gen.QueryResult{}, err
		}
		if scope, err = s.scopeFor(ctx, c.role, c.principal.UserID, stored.ID, spec, d); err != nil {
			return gen.QueryResult{}, err
		}
	}
	result, err := s.run(ctx, stored, spec, q, scope)
	return result, s.datasetFieldError(ctx, stored.ID, err)
}

// run is execute limited to the scope given.
func (s *Server) run(ctx context.Context, stored store.Dataset, spec *dataset.Spec, q *query.Query, scope dataScope) (gen.QueryResult, error) {
	var out gen.QueryResult
	if enabled, _ := ctx.Value(queryDiagnosticsKey{}).(bool); enabled {
		out.Diagnostics = &gen.QueryDiagnostics{RequestId: id.New("qry"), RequestedAt: s.now(), Statements: []gen.QueryStatement{}}
	}
	source, err := store.GetDatasource(ctx, s.Pool, s.scope(ctx), stored.DatasourceID)
	if err != nil {
		return out, err
	}
	workspace, err := store.GetWorkspace(ctx, s.Pool, s.scope(ctx))
	if err != nil {
		return out, err
	}
	settings, err := store.SystemSettingsInForce(ctx, s.Pool, s.scope(ctx).OrgID)
	if err != nil {
		return out, err
	}
	conn, err := s.connect(ctx, source)
	if err != nil {
		return out, err
	}
	options := query.Options{
		Dialect:      conn.Dialect(),
		Now:          s.now(),
		Timezone:     workspace.Timezone,
		WeekStart:    workspace.WeekStart,
		DefaultLimit: settings.QueryDefaultRows,
		MaxLimit:     settings.QueryMaxRows,
		RowFilter:    scope.rows,
		Hidden:       scope.hidden,
	}
	compiled, err := query.Compile(q, spec, options)
	if err != nil {
		return out, err
	}
	// Cancelling the request (the user leaves the page) cancels the statement.
	ctx, cancel := context.WithTimeout(ctx, settings.QueryTimeout)
	defer cancel()
	result, outcome, err := s.fetch(ctx, source, conn, compiled, settings)
	noteStatement(ctx, auditStatement(gen.Main, stored.ID, source, compiled, result, outcome, err))
	if err != nil {
		return out, s.databaseError(ctx, source.ID, err)
	}
	appendQueryStatement(out.Diagnostics, gen.Main, nil, compiled, result, outcome)

	out.Rows = result.Rows
	out.Columns = resultColumns(result.Columns)
	out.Meta.Truncated = result.Meta.Truncated
	out.Meta.DurationMs = result.Meta.DurationMs
	// Cached only when every part was; fetched as long ago as the oldest part.
	out.Meta.Cached = outcome.Hit
	cachedAt := outcome.At
	out.Meta.CachedAt = &cachedAt // moved earlier by the totals below
	if len(q.Totals) == 0 {
		return out, nil
	}
	// A condition on aggregated results would mean something else over coarser groups.
	if q.Having != nil {
		out.Meta.TotalsOmitted = new(true)
		return out, nil
	}
	totals := make([]gen.QueryTotal, len(q.Totals))
	// Totals say no limit of their own, and are worth little with groups left
	// out: they take all the rows there may be, not the default.
	options.DefaultLimit = options.MaxLimit
	for i, keep := range q.Totals {
		tq := q.TotalQuery(keep)
		compiled, err := query.Compile(&tq, spec, options)
		if err != nil {
			return out, err
		}
		total, outcome, err := s.fetch(ctx, source, conn, compiled, settings)
		kind := gen.Total
		if len(keep) > 0 {
			kind = gen.Subtotal
		}
		noteStatement(ctx, auditStatement(kind, stored.ID, source, compiled, total, outcome, err))
		if err != nil {
			return out, s.databaseError(ctx, source.ID, err)
		}
		appendQueryStatement(out.Diagnostics, kind, keep, compiled, total, outcome)
		totals[i] = gen.QueryTotal{By: append([]string{}, keep...), Columns: resultColumns(total.Columns), Rows: total.Rows}
		out.Meta.DurationMs += total.Meta.DurationMs
		out.Meta.Cached = out.Meta.Cached && outcome.Hit
		if outcome.At.Before(cachedAt) {
			cachedAt = outcome.At
		}
	}
	out.Totals = &totals
	return out, nil
}

type queryDiagnosticsKey struct{}

// SQL and arguments are authoring information. Viewers can request chart
// data, but cannot opt into diagnostics, even when the rows are cached.
func withQueryDiagnostics(ctx context.Context, requested *bool) (context.Context, error) {
	if requested == nil || !*requested {
		return ctx, nil
	}
	if !callerFrom(ctx).role.AtLeast(authz.Developer) {
		return ctx, &apiError{status: 403, code: "forbidden", message: "query diagnostics require the developer role"}
	}
	return context.WithValue(ctx, queryDiagnosticsKey{}, true), nil
}

// Capture the exact compiled statement at the same point its rows are
// accepted. Do not compile again: relative dates and parameters must agree.
func appendQueryStatement(d *gen.QueryDiagnostics, kind gen.QueryStatementKind, by []string, compiled *query.Compiled, result *query.Result, outcome qcache.Outcome) {
	if d == nil {
		return
	}
	d.Statements = append(d.Statements, gen.QueryStatement{
		Kind: kind, By: append([]string{}, by...), Sql: compiled.SQL, Args: append([]any{}, compiled.Args...),
		DurationMs: result.Meta.DurationMs, Cached: outcome.Hit, Shared: outcome.Shared,
		FetchedAt: outcome.At, RowCount: len(result.Rows), Truncated: result.Meta.Truncated,
	})
}

func resultColumns(columns []query.Column) []gen.ResultColumn {
	out := make([]gen.ResultColumn, len(columns))
	for i, c := range columns {
		col := gen.ResultColumn{Name: c.Name, Type: gen.LogicalType(c.Type), Role: gen.ResultColumnRole(c.Role)}
		if c.Label != "" {
			col.Label = &c.Label
		}
		col.Format = displayFormat(c.Format)
		if c.Grain != "" {
			col.Grain = new(gen.ResultColumnGrain(c.Grain))
		}
		if c.Comparison != nil {
			col.Comparison = &gen.Comparison{Output: gen.ComparisonOutput(c.Comparison.Output)}
			col.Comparison.Offset.N = c.Comparison.Offset.N
			col.Comparison.Offset.Unit = gen.ComparisonOffsetUnit(c.Comparison.Offset.Unit)
		}
		if c.Compute != "" {
			col.Compute = new(gen.ResultColumnCompute(c.Compute))
		}
		if c.Agg != "" {
			col.Agg = &c.Agg
		}
		out[i] = col
	}
	return out
}

func displayFormat(f *dataset.Format) *gen.DisplayFormat {
	if f == nil {
		return nil
	}
	out := &gen.DisplayFormat{Decimals: f.Decimals, Grouping: f.Grouping}
	if f.Style != "" {
		out.Style = new(gen.DisplayFormatStyle(f.Style))
	}
	if f.Unit != "" {
		out.Unit = new(gen.DisplayFormatUnit(f.Unit))
	}
	if f.Prefix != "" {
		out.Prefix = &f.Prefix
	}
	if f.Suffix != "" {
		out.Suffix = &f.Suffix
	}
	if f.Date != "" {
		out.Date = new(gen.DisplayFormatDate(f.Date))
	}
	if f.Time != "" {
		out.Time = new(gen.DisplayFormatTime(f.Time))
	}
	if f.Week != "" {
		out.Week = new(gen.DisplayFormatWeek(f.Week))
	}
	return out
}
