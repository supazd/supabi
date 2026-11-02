package store

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func contentValidationFixture(t *testing.T) (*pgxpool.Pool, Scope, Dataset, Chart, Dashboard) {
	t.Helper()
	pool := migrated(t)
	ctx := context.Background()
	scope := Scope{OrgID: DefaultOrgID, WorkspaceID: DefaultWorkspaceID}
	source, err := CreateDatasource(ctx, pool, scope, Datasource{Name: "db", Type: "postgres", Settings: map[string]string{}})
	if err != nil {
		t.Fatal(err)
	}
	ds, err := CreateDataset(ctx, pool, scope, Dataset{Name: "data", DatasourceID: source.ID, Spec: json.RawMessage(`{}`), SpecVersion: 1, ValidationStatus: "valid"})
	if err != nil {
		t.Fatal(err)
	}
	chart, err := CreateChart(ctx, pool, scope, Chart{Name: "chart", DatasetID: ds.ID, Spec: json.RawMessage(`{}`), SpecVersion: 1})
	if err != nil {
		t.Fatal(err)
	}
	board, err := SaveDashboard(ctx, pool, scope, Dashboard{Name: "board", Spec: json.RawMessage(`{}`), SpecVersion: 1}, []string{chart.ID})
	if err != nil {
		t.Fatal(err)
	}
	return pool, scope, ds, chart, board
}

// Give a concurrent writer a known backend so we can wait for its lock rather
// than depend on a delay or inadvertently observe an unrelated test's query.
func contentWriter(t *testing.T, ctx context.Context, pool *pgxpool.Pool) (*pgxpool.Pool, int32) {
	t.Helper()
	cfg := pool.Config()
	cfg.MaxConns, cfg.MinConns = 1, 0
	writer, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(writer.Close)
	var pid int32
	if err := writer.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	return writer, pid
}

func waitForContentLock(t *testing.T, ctx context.Context, pool *pgxpool.Pool, pid int32, done <-chan error) {
	t.Helper()
	for {
		var blocked bool
		if err := pool.QueryRow(ctx, `SELECT cardinality(pg_blocking_pids($1)) > 0`, pid).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			return
		}
		select {
		case err := <-done:
			t.Fatalf("writer finished without waiting for validation lock: %v", err)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(10 * time.Millisecond):
		}
	}
}

func TestChartWriteRejectsDatasetChangedWhileWaiting(t *testing.T) {
	for _, create := range []bool{true, false} {
		name := "update"
		if create {
			name = "create"
		}
		t.Run(name, func(t *testing.T) {
			pool, scope, ds, chart, _ := contentValidationFixture(t)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			blocker, err := pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer blocker.Rollback(context.Background())
			if _, err := blocker.Exec(ctx, `SELECT id FROM datasets WHERE id = $1 FOR UPDATE`, ds.ID); err != nil {
				t.Fatal(err)
			}
			writer, pid := contentWriter(t, ctx, pool)
			chart.Name = "new definition"
			chart.DatasetRevision = ds.Revision
			done := make(chan error, 1)
			go func() {
				if create {
					_, err := CreateChart(ctx, writer, scope, chart)
					done <- err
				} else {
					_, err := UpdateChart(ctx, writer, scope, chart)
					done <- err
				}
			}()
			waitForContentLock(t, ctx, pool, pid, done)
			if _, err := blocker.Exec(ctx, `UPDATE datasets SET revision = revision + 1 WHERE id = $1`, ds.ID); err != nil {
				t.Fatal(err)
			}
			if err := blocker.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			if err := <-done; !errors.Is(err, ErrDatasetChanged) {
				t.Fatalf("stale chart write = %v, want dataset changed", err)
			}
			charts, err := ListCharts(ctx, pool, scope)
			if err != nil || len(charts) != 1 || charts[0].Name != "chart" {
				t.Fatalf("stale write changed charts: %v, %v", charts, err)
			}
		})
	}
}

func TestDashboardLocksChartsBeforeDashboard(t *testing.T) {
	pool, scope, _, chart, board := contentValidationFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	blocker, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(context.Background())
	if _, err := blocker.Exec(ctx, `SELECT id FROM charts WHERE id = $1 FOR UPDATE`, chart.ID); err != nil {
		t.Fatal(err)
	}
	writer, pid := contentWriter(t, ctx, pool)
	board.Name = "edited board"
	done := make(chan error, 1)
	go func() {
		_, err := SaveDashboard(ctx, writer, scope, board, []string{chart.ID})
		done <- err
	}()
	waitForContentLock(t, ctx, pool, pid, done)
	// Dataset impact holds chart locks before locking its dashboards. A board
	// writer waiting on the chart must not already own the dashboard lock.
	if _, err := blocker.Exec(ctx, `SELECT id FROM dashboards WHERE id = $1 FOR UPDATE NOWAIT`, board.ID); err != nil {
		t.Fatalf("dashboard was locked before its charts (would deadlock an impact save): %v", err)
	}
	if err := blocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestDashboardRejectsStaleValidationSnapshots(t *testing.T) {
	pool, scope, ds, chart, board := contentValidationFixture(t)
	ctx := context.Background()
	board.DatasetRevisions = map[string]int{ds.ID: ds.Revision}
	board.ChartUpdatedAt = map[string]time.Time{chart.ID: chart.UpdatedAt}
	chart.Name = "changed chart"
	changed, err := UpdateChart(ctx, pool, scope, chart)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := SaveDashboard(ctx, pool, scope, board, []string{chart.ID}); !errors.Is(err, ErrChartChanged) {
		t.Fatalf("stale chart validation = %v", err)
	}
	board.ChartUpdatedAt[chart.ID] = changed.UpdatedAt
	if _, err := UpdateDataset(ctx, pool, scope, ds); err != nil {
		t.Fatal(err)
	}
	if _, err := SaveDashboard(ctx, pool, scope, board, []string{chart.ID}); !errors.Is(err, ErrDatasetChanged) {
		t.Fatalf("stale dataset validation = %v", err)
	}
	board.DatasetRevisions[ds.ID]++
	if _, err := SaveDashboard(ctx, pool, scope, board, []string{chart.ID}); err != nil {
		t.Fatalf("current validation snapshots failed: %v", err)
	}
}
