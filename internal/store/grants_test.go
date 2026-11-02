package store

import (
	"context"
	"encoding/json"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/supazd/supabi/internal/authz"
)

func TestDashboardGrantsConcurrentReplacement(t *testing.T) {
	pool := migrated(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	scope := Scope{OrgID: DefaultOrgID, WorkspaceID: DefaultWorkspaceID}
	board, err := SaveDashboard(ctx, pool, scope, Dashboard{Name: "board", Spec: json.RawMessage(`{}`), SpecVersion: 1}, nil)
	if err != nil {
		t.Fatal(err)
	}
	var subjects []authz.Subject
	for _, name := range []string{"first", "last"} {
		group, err := SaveGroup(ctx, pool, scope.OrgID, Group{Name: name})
		if err != nil {
			t.Fatal(err)
		}
		subjects = append(subjects, authz.Subject{GroupID: group.ID})
	}
	if err := SetDashboardGrants(ctx, pool, scope, board.ID, []authz.Subject{{Everyone: true}}); err != nil {
		t.Fatal(err)
	}

	// Hold the old grant so both replacements overlap. Without a dashboard
	// lock, both DELETE statements see the old grant but neither sees the
	// other's INSERT, leaving a union instead of the last replacement.
	blocker, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(context.Background())
	if _, err := blocker.Exec(ctx, `SELECT FROM dashboard_grants WHERE dashboard_id = $1 FOR UPDATE`, board.ID); err != nil {
		t.Fatal(err)
	}
	results := make(chan error, 2)
	for _, subject := range subjects {
		// A separate one-connection pool gives each writer a known backend,
		// so synchronization does not depend on arbitrary sleeps or other tests.
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
		go func() { results <- SetDashboardGrants(ctx, writer, scope, board.ID, []authz.Subject{subject}) }()
		for {
			var blocked bool
			if err := pool.QueryRow(ctx, `SELECT cardinality(pg_blocking_pids($1)) > 0`, pid).Scan(&blocked); err != nil {
				t.Fatal(err)
			}
			if blocked {
				break
			}
			select {
			case err := <-results:
				t.Fatalf("replacement finished before the lock was released: %v", err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			case <-time.After(10 * time.Millisecond):
			}
		}
	}
	if err := blocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	for range subjects {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	grants, err := ListDashboardGrants(ctx, pool, scope, board.ID)
	if err != nil {
		t.Fatal(err)
	}
	if want := subjects[1:]; !slices.Equal(grants, want) {
		t.Fatalf("grants = %v, want last replacement %v", grants, want)
	}
}
