package exports

import (
	"context"
	"encoding/json"
	"errors"
	"path"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/supazd/supabi/internal/blob"
	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/query"
	"github.com/supazd/supabi/internal/source"
	"github.com/supazd/supabi/internal/store"
)

var ErrForbidden = errors.New("export_forbidden")
var ErrChartDisabled = errors.New("export_chart_disabled")

// errEnough stops a query once a chart's own row limit has been written.
var errEnough = errors.New("enough rows")

// Snapshot keeps relative date parameters and displayed timestamps in the
// workspace time zone chosen when the export was submitted.
type Snapshot struct {
	dataset.Spec
	Timezone string `json:"exportTimezone,omitempty"`
}

// ChartStatement is a chart export compiled for its owner as they are now.
type ChartStatement struct {
	DatasourceID string
	SQL          string
	Args         []any
	// Columns are the positions in the query's output to write, in order,
	// under Headers.
	Columns []int
	Headers []string
	// Limit is the most rows to write: the chart's own row limit, or one
	// more than an export allows when it has none.
	Limit int64
}

// Charts compiles chart exports. Dashboards, charts and data permissions are
// the API server's business, so it implements this.
type Charts interface {
	// ChartExport checks that the owner may still export the chart on the
	// widget, failing with ErrForbidden or ErrChartDisabled, and compiles its
	// snapshot with the owner's data permissions, relative dates as of now,
	// for at most maxRows rows and one more to tell that there are too many.
	ChartExport(ctx context.Context, e store.Export, now time.Time, maxRows int64) (ChartStatement, error)
}

type Service struct {
	Pool    *pgxpool.Pool
	Sources source.Connections
	Charts  Charts
	// Files is where export files are kept, never in a public HTTP
	// directory.
	Files blob.Store
}

// view is what of a query's output goes into the file. The zero view is
// all of it.
type view struct {
	picks   []int // nil for every column, under the names the database gave
	headers []string
	limit   int64 // 0 for no limit of its own
}

type progressWriter struct {
	*Writer
	view
	ctx    context.Context
	rows   *atomic.Int64
	cancel func()
	err    error
}

func (w *progressWriter) Start(columns []datasource.Column) error {
	if w.picks == nil {
		return w.fail(w.Writer.Start(columns))
	}
	picked := make([]datasource.Column, len(w.picks))
	for i, at := range w.picks {
		if at >= len(columns) {
			return w.fail(errors.New("the query returned fewer columns than compiled"))
		}
		picked[i] = columns[at]
		picked[i].Name = w.headers[i]
	}
	return w.fail(w.Writer.Start(picked))
}

func (w *progressWriter) WriteRow(row []any) error {
	if err := w.ctx.Err(); err != nil {
		return w.fail(err)
	}
	if w.limit > 0 && w.Rows >= w.limit {
		return w.fail(errEnough)
	}
	if w.picks != nil {
		picked := make([]any, len(w.picks))
		for i, at := range w.picks {
			picked[i] = row[at]
		}
		row = picked
	}
	err := w.Writer.WriteRow(row)
	w.rows.Store(w.Rows)
	return w.fail(err)
}

// fail stops the query with the writer's first error. Drivers otherwise read
// the rest of the result, up to the row limit, just to discard it on close.
func (w *progressWriter) fail(err error) error {
	if err != nil && w.err == nil {
		w.err = err
		w.cancel()
	}
	return err
}

// streamTo writes what v shows of the result of sql to w, reporting the
// writer's own error rather than the cancellation it caused.
func streamTo(ctx context.Context, conn datasource.StreamingConn, sql string, args []any, v view, w *Writer, progress *atomic.Int64) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	out := &progressWriter{Writer: w, view: v, ctx: ctx, rows: progress, cancel: cancel}
	err := conn.Stream(ctx, sql, args, out)
	if errors.Is(out.err, errEnough) {
		return nil
	}
	if out.err != nil {
		return out.err
	}
	return err
}

// plan is how an export of either source is run: what to stream from where,
// and how to check, before publishing, that its owner may still have it.
type plan struct {
	conn    datasource.StreamingConn
	sql     string
	args    []any
	view    view
	recheck func(context.Context) error
}

func streaming(conn datasource.Conn) (datasource.StreamingConn, error) {
	stream, ok := conn.(datasource.StreamingConn)
	if !ok {
		return nil, errors.New("streaming unavailable")
	}
	return stream, nil
}

// Execute runs a job of exports. An export keeps to the limits of settings,
// read as its attempt began: .agents/design/configuration.md 10.2.
func (s *Service) Execute(ctx context.Context, j store.Job, settings store.SystemSettings, progress *atomic.Int64) (store.ExportFile, error) {
	if j.Kind == "export_cleanup" {
		return store.ExportFile{}, s.Cleanup(ctx, j.OrgID)
	}
	e, err := store.LoadJobExport(ctx, s.Pool, j)
	if err != nil {
		return store.ExportFile{}, err
	}
	var p plan
	if e.Source == "chart" {
		p, err = s.chartPlan(ctx, j, e, settings.ExportMaxRows)
	} else {
		p, err = s.sqlPlan(ctx, j, e, settings.ExportMaxRows)
	}
	if err != nil {
		return store.ExportFile{}, err
	}
	// Each attempt writes to a key of its own, so a late worker cannot
	// overwrite the file of the attempt that took over from it.
	key := strings.Join([]string{e.OrgID, e.WorkspaceID, e.ID, j.LeaseToken, "result." + e.Format}, "/")
	f, err := s.Files.Create(ctx, key, settings.ExportMaxBytes)
	if err != nil {
		return store.ExportFile{}, err
	}
	defer f.Abort()
	w, err := NewWriter(f, e.Format, settings.ExportMaxRows, settings.ExportMaxBytes)
	if err != nil {
		return store.ExportFile{}, err
	}
	if err = streamTo(ctx, p.conn, p.sql, p.args, p.view, w, progress); err != nil {
		return store.ExportFile{}, err
	}
	if err = w.Close(); err != nil {
		return store.ExportFile{}, err
	}
	if err = p.recheck(ctx); err != nil {
		return store.ExportFile{}, err
	}
	if err = ctx.Err(); err != nil {
		return store.ExportFile{}, err
	}
	if err = f.Commit(ctx); err != nil {
		// A commit that timed out may still have put the file in place.
		_ = s.Remove(context.WithoutCancel(ctx), key)
		return store.ExportFile{}, err
	}
	return store.ExportFile{Key: key, Rows: w.Rows, Bytes: w.Bytes(), Retention: settings.ExportRetention}, nil
}

// sqlPlan reruns a data exploration snapshot, which only developers may.
func (s *Service) sqlPlan(ctx context.Context, j store.Job, e store.Export, maxRows int64) (plan, error) {
	scope := store.Scope{OrgID: e.OrgID, WorkspaceID: e.WorkspaceID, UserID: e.UserID}
	recheck := func(ctx context.Context) error {
		allowed, err := store.ExportAllowed(ctx, s.Pool, scope)
		if err == nil && !allowed {
			err = ErrForbidden
		}
		return err
	}
	if err := recheck(ctx); err != nil {
		return plan{}, err
	}
	d, err := store.GetDatasource(ctx, s.Pool, scope, e.DatasourceID)
	if err != nil {
		return plan{}, err
	}
	conn, err := s.Sources.Connect(ctx, scope, d)
	if err != nil {
		return plan{}, err
	}
	stream, err := streaming(conn)
	if err != nil {
		return plan{}, err
	}
	var snapshot Snapshot
	if err = json.Unmarshal(e.SourceSpec, &snapshot); err != nil {
		return plan{}, err
	}
	if snapshot.Timezone == "" {
		snapshot.Timezone = "UTC"
	}
	statement, err := query.SourceSQL(&snapshot.Spec, query.Options{Dialect: conn.Dialect(), Now: j.CreatedAt, Timezone: snapshot.Timezone})
	if err != nil {
		return plan{}, err
	}
	columns, err := conn.Describe(ctx, statement.SQL, statement.Args)
	if err != nil {
		return plan{}, err
	}
	// Match exploration's timestamp display without changing column names or
	// numeric types. DATE values remain calendar dates in every time zone.
	sql := statement.SQL
	dialect := conn.Dialect()
	// PostgreSQL permits duplicate (including unnamed) source columns. Give
	// each position a unique internal name before applying time conversions,
	// then restore the original headings in the output. The other drivers
	// require named source columns.
	positional := dialect.Name() == "postgres"
	aliases := make([]string, len(columns))
	selects, hasTime := make([]string, len(columns)), false
	for i, column := range columns {
		name := dialect.QuoteIdent(column.Name)
		aliases[i] = name
		if positional {
			aliases[i] = dialect.QuoteIdent("column_" + strconv.Itoa(i))
		}
		value := "exported." + aliases[i]
		if column.Type == datasource.Timestamp {
			value = dialect.LocalTime(value, snapshot.Timezone)
			hasTime = true
		}
		selects[i] = value + " AS " + name
	}
	if hasTime {
		sql = "SELECT " + strings.Join(selects, ", ") + " FROM (" + sql + "\n) AS exported"
		if positional {
			sql += "(" + strings.Join(aliases, ", ") + ")"
		}
	}
	// Stream the complete result, preserving any LIMIT in the author's SQL.
	// One extra row detects an oversized export instead of silently truncating.
	sql += " LIMIT " + strconv.FormatInt(maxRows+1, 10)
	return plan{conn: stream, sql: sql, args: statement.Args, recheck: recheck}, nil
}

// chartPlan compiles a chart export for its owner as they are now.
func (s *Service) chartPlan(ctx context.Context, j store.Job, e store.Export, maxRows int64) (plan, error) {
	if s.Charts == nil {
		return plan{}, errors.New("chart exports unavailable")
	}
	statement, err := s.Charts.ChartExport(ctx, e, j.CreatedAt, maxRows)
	if err != nil {
		return plan{}, err
	}
	scope := store.Scope{OrgID: e.OrgID, WorkspaceID: e.WorkspaceID, UserID: e.UserID}
	d, err := store.GetDatasource(ctx, s.Pool, scope, statement.DatasourceID)
	if err != nil {
		return plan{}, err
	}
	conn, err := s.Sources.Connect(ctx, scope, d)
	if err != nil {
		return plan{}, err
	}
	stream, err := streaming(conn)
	if err != nil {
		return plan{}, err
	}
	return plan{conn: stream, sql: statement.SQL, args: statement.Args,
		view: view{picks: statement.Columns, headers: statement.Headers, limit: statement.Limit},
		recheck: func(ctx context.Context) error {
			_, err := s.Charts.ChartExport(ctx, e, j.CreatedAt, maxRows)
			return err
		}}, nil
}

func FailureCode(err error) string {
	if err == nil {
		return ""
	}
	for _, known := range []error{ErrForbidden, ErrChartDisabled, ErrRowLimit, ErrFileLimit, ErrCellLimit, ErrColumnLimit} {
		if errors.Is(err, known) {
			return known.Error()
		}
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, datasource.ErrQueueTimeout) {
		return "export_timeout"
	}
	if errors.Is(err, store.ErrNotFound) {
		return "export_source_missing"
	}
	var specErr *dataset.Error
	if errors.As(err, &specErr) {
		// The chart uses a field its owner may not see, as a dashboard
		// would show by saying they have no permission.
		if specErr.Code == "hidden_field" {
			return ErrForbidden.Error()
		}
		return "export_parameters"
	}
	var queryErr *datasource.QueryError
	if errors.As(err, &queryErr) {
		return "export_query_failed"
	}
	return "export_failed"
}

// Remove deletes the file at key, if there is a key. It gives up after a
// while, leaving what remains for a later cleanup.
func (s *Service) Remove(ctx context.Context, key string) error {
	if key == "" {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, removeTimeout)
	defer cancel()
	return s.Files.Remove(ctx, key)
}

const removeTimeout = 10 * time.Second

// RemoveWorkspace deletes every export file of a workspace that is being
// purged, published or not. A job still writing one was cancelled when the
// workspace was deleted, and throws its file away when it stops.
func (s *Service) RemoveWorkspace(ctx context.Context, orgID, workspaceID string) error {
	// A cutoff ahead of now takes what was written a moment ago too, though
	// S3 keeps the time of a write only to the second.
	return s.Files.Sweep(ctx, orgID+"/"+workspaceID+"/", time.Now().Add(time.Hour), func(string) bool { return false })
}

func (s *Service) Cleanup(ctx context.Context, orgID string) error {
	for {
		list, err := store.ExpiredExports(ctx, s.Pool, orgID)
		if err != nil {
			return err
		}
		for _, e := range list {
			if err = ctx.Err(); err != nil {
				return err
			}
			if err = s.Remove(ctx, e.FileKey); err != nil {
				return err
			}
			if err = store.MarkExportCleaned(ctx, s.Pool, e.ID, e.FileKey); err != nil {
				return err
			}
		}
		if len(list) < 200 {
			break
		}
	}
	if err := store.PruneExportHistory(ctx, s.Pool, orgID); err != nil {
		return err
	}
	files, attempts, err := store.ReferencedExportFiles(ctx, s.Pool, orgID)
	if err != nil {
		return err
	}
	// A grace period leaves just-created files safe even if this cleanup's
	// snapshot predates their job. Active leases protect arbitrarily long jobs.
	return s.sweep(ctx, orgID, files, attempts, time.Now().Add(-time.Hour))
}

// sweep removes the org's files and unfinished writes from before cutoff
// that are neither a published file nor written by a live attempt.
func (s *Service) sweep(ctx context.Context, orgID string, files, attempts map[string]bool, cutoff time.Time) error {
	return s.Files.Sweep(ctx, orgID+"/", cutoff, func(key string) bool {
		return files[key] || attempts[path.Dir(key)]
	})
}
