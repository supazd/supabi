package store

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"testing/fstest"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/supazd/supabi/internal/testdb"
)

func newTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	return testdb.New(t).Pool
}

func sqlFS(files map[string]string) fstest.MapFS {
	fsys := fstest.MapFS{}
	for name, body := range files {
		fsys[name] = &fstest.MapFile{Data: []byte(body)}
	}
	return fsys
}

func tableExists(t *testing.T, pool *pgxpool.Pool, name string) bool {
	t.Helper()
	var exists bool
	err := pool.QueryRow(context.Background(), `SELECT to_regclass($1) IS NOT NULL`, name).Scan(&exists)
	if err != nil {
		t.Fatal(err)
	}
	return exists
}

func TestMigrateCoreIsIdempotent(t *testing.T) {
	pool := newTestPool(t)
	ctx := context.Background()

	files, err := loadMigrations(CoreMigrations().FS)
	if err != nil {
		t.Fatal(err)
	}
	n, err := Migrate(ctx, pool, CoreMigrations())
	if err != nil {
		t.Fatal(err)
	}
	if n != len(files) || n == 0 {
		t.Fatalf("applied %d migrations, want %d", n, len(files))
	}
	for _, table := range []string{"sessions", "orgs", "users", "user_groups", "user_group_members",
		"workspaces", "workspace_members", "datasources", "datasets", "dataset_revisions", "charts", "dashboards", "dashboard_charts"} {
		if !tableExists(t, pool, table) {
			t.Errorf("table %s was not created", table)
		}
	}
	if n, err := Migrate(ctx, pool, CoreMigrations()); err != nil || n != 0 {
		t.Fatalf("second run applied %d, err %v; want 0, nil", n, err)
	}
}

// The schema documents itself: every table and column carries a COMMENT.
func TestMigrateCoreCommentsEveryColumn(t *testing.T) {
	pool := newTestPool(t)
	ctx := context.Background()
	if _, err := Migrate(ctx, pool, CoreMigrations()); err != nil {
		t.Fatal(err)
	}
	rows, err := pool.Query(ctx, `
		SELECT c.relname FROM pg_class c
		WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r'
		  AND obj_description(c.oid, 'pg_class') IS NULL
		UNION ALL
		SELECT c.relname || '.' || a.attname FROM pg_class c
		JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
		WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r'
		  AND col_description(c.oid, a.attnum) IS NULL
		ORDER BY 1`)
	if err != nil {
		t.Fatal(err)
	}
	missing, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		t.Fatal(err)
	}
	if len(missing) > 0 {
		t.Errorf("no COMMENT on: %s", strings.Join(missing, ", "))
	}
}

func TestMigrateAppliesOnlyNewFiles(t *testing.T) {
	pool := newTestPool(t)
	ctx := context.Background()
	files := map[string]string{"0001_a.sql": `CREATE TABLE a (x int); CREATE TABLE a2 (x int);`}

	if n, err := Migrate(ctx, pool, Source{Name: "s", FS: sqlFS(files)}); err != nil || n != 1 {
		t.Fatalf("got %d, %v", n, err)
	}
	files["0002_b.sql"] = `CREATE TABLE b (x int);`
	if n, err := Migrate(ctx, pool, Source{Name: "s", FS: sqlFS(files)}); err != nil || n != 1 {
		t.Fatalf("got %d, %v", n, err)
	}
	for _, table := range []string{"a", "a2", "b"} {
		if !tableExists(t, pool, table) {
			t.Errorf("table %s missing", table)
		}
	}
}

func TestMigrateRejectsModifiedMigration(t *testing.T) {
	pool := newTestPool(t)
	ctx := context.Background()
	if _, err := Migrate(ctx, pool, Source{Name: "s", FS: sqlFS(map[string]string{"0001_a.sql": `CREATE TABLE a (x int);`})}); err != nil {
		t.Fatal(err)
	}
	_, err := Migrate(ctx, pool, Source{Name: "s", FS: sqlFS(map[string]string{"0001_a.sql": `CREATE TABLE a (x bigint);`})})
	if err == nil || !strings.Contains(err.Error(), "modified after it was applied") {
		t.Fatalf("err = %v, want a modified-migration error", err)
	}
}

func TestMigrateRejectsOutOfOrderAndUnknownVersions(t *testing.T) {
	pool := newTestPool(t)
	ctx := context.Background()
	two := map[string]string{"0002_b.sql": `CREATE TABLE b (x int);`}
	if _, err := Migrate(ctx, pool, Source{Name: "s", FS: sqlFS(two)}); err != nil {
		t.Fatal(err)
	}

	withOlder := map[string]string{"0001_a.sql": `CREATE TABLE a (x int);`, "0002_b.sql": two["0002_b.sql"]}
	if _, err := Migrate(ctx, pool, Source{Name: "s", FS: sqlFS(withOlder)}); err == nil || !strings.Contains(err.Error(), "must be added in order") {
		t.Fatalf("err = %v, want an out-of-order error", err)
	}
	if tableExists(t, pool, "a") {
		t.Error("out-of-order migration was applied")
	}

	if _, err := Migrate(ctx, pool, Source{Name: "s", FS: sqlFS(map[string]string{})}); err == nil || !strings.Contains(err.Error(), "newer version") {
		t.Fatalf("err = %v, want a newer-version error", err)
	}
}

func TestMigrateRollsBackFailedMigration(t *testing.T) {
	pool := newTestPool(t)
	ctx := context.Background()
	bad := map[string]string{"0001_a.sql": `CREATE TABLE a (x int); CREATE TABLE b (x no_such_type);`}
	if _, err := Migrate(ctx, pool, Source{Name: "s", FS: sqlFS(bad)}); err == nil {
		t.Fatal("expected an error")
	}
	if tableExists(t, pool, "a") {
		t.Error("partial migration was not rolled back")
	}
	good := map[string]string{"0001_a.sql": `CREATE TABLE a (x int);`}
	if n, err := Migrate(ctx, pool, Source{Name: "s", FS: sqlFS(good)}); err != nil || n != 1 {
		t.Fatalf("retry after fixing the file: got %d, %v", n, err)
	}
}

func TestMigrateSourcesAreVersionedIndependently(t *testing.T) {
	pool := newTestPool(t)
	ctx := context.Background()
	core := Source{Name: "core", FS: sqlFS(map[string]string{"0001_a.sql": `CREATE TABLE a (x int);`})}
	ee := Source{Name: "enterprise", FS: sqlFS(map[string]string{"0001_e.sql": `CREATE TABLE e (a_x int);`})}
	if n, err := Migrate(ctx, pool, core, ee); err != nil || n != 2 {
		t.Fatalf("got %d, %v", n, err)
	}
	if n, err := Migrate(ctx, pool, core, ee); err != nil || n != 0 {
		t.Fatalf("got %d, %v", n, err)
	}
}

func TestMigrateConcurrently(t *testing.T) {
	pool := newTestPool(t)
	ctx := context.Background()
	const workers = 8
	var wg sync.WaitGroup
	counts := make([]int, workers)
	errs := make([]error, workers)
	for i := range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			counts[i], errs[i] = Migrate(ctx, pool, CoreMigrations())
		}()
	}
	wg.Wait()

	files, _ := loadMigrations(CoreMigrations().FS)
	total := 0
	for i := range workers {
		if errs[i] != nil {
			t.Errorf("worker %d: %v", i, errs[i])
		}
		total += counts[i]
	}
	if total != len(files) {
		t.Errorf("migrations applied %d times in total, want %d", total, len(files))
	}
}

func TestBootstrap(t *testing.T) {
	pool := newTestPool(t)
	ctx := context.Background()
	if _, err := Migrate(ctx, pool, CoreMigrations()); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO orgs (id, name) VALUES ('org_other', 'Other')`); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := Bootstrap(ctx, pool); err != nil {
			t.Fatal(err)
		}
	}

	var orgs, workspaces int
	if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM orgs), (SELECT count(*) FROM workspaces)`).Scan(&orgs, &workspaces); err != nil {
		t.Fatal(err)
	}
	if orgs != 2 || workspaces != 1 {
		t.Fatalf("orgs = %d, workspaces = %d; want 2 and 1", orgs, workspaces)
	}

	// Once purged, the default workspace stays gone, even when another has
	// taken its name since.
	if _, err := pool.Exec(ctx, `DELETE FROM workspaces WHERE id = $1`, DefaultWorkspaceID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO workspaces (id, org_id, name) VALUES ('ws_new', $1, 'Default')`, DefaultOrgID); err != nil {
		t.Fatal(err)
	}
	if err := Bootstrap(ctx, pool); err != nil {
		t.Fatalf("starting again after the default workspace was purged: %v", err)
	}
	var ids []string
	rows, err := pool.Query(ctx, `SELECT id FROM workspaces ORDER BY id`)
	if err == nil {
		ids, err = pgx.CollectRows(rows, pgx.RowTo[string])
	}
	if err != nil || len(ids) != 1 || ids[0] != "ws_new" {
		t.Errorf("workspaces after starting again: %v, %v", ids, err)
	}
}

// The schema itself must refuse references that cross an org or workspace
// boundary, independently of application code.
func TestSchemaRejectsCrossTenantReferences(t *testing.T) {
	pool := newTestPool(t)
	ctx := context.Background()
	if _, err := Migrate(ctx, pool, CoreMigrations()); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO orgs (id, name) VALUES ('org_a', 'A'), ('org_b', 'B');
		INSERT INTO users (id, org_id, email, display_name) VALUES ('user_a', 'org_a', 'a@example.com', 'A'), ('user_b', 'org_b', 'b@example.com', 'B');
		INSERT INTO workspaces (id, org_id, name) VALUES ('ws_a1', 'org_a', 'One'), ('ws_a2', 'org_a', 'Two');
		INSERT INTO datasources (id, org_id, workspace_id, name, type) VALUES ('src_a1', 'org_a', 'ws_a1', 'pg', 'postgres');
	`); err != nil {
		t.Fatal(err)
	}

	const foreignKeyViolation, checkViolation, uniqueViolation = "23503", "23514", "23505"
	tests := []struct {
		name string
		sql  string
		code string // empty: must succeed
	}{
		{"member from the same org", `INSERT INTO workspace_members (id, org_id, workspace_id, user_id, role) VALUES ('wm_1', 'org_a', 'ws_a1', 'user_a', 'viewer')`, ""},
		{"member who belongs to another org", `INSERT INTO workspace_members (id, org_id, workspace_id, user_id, role) VALUES ('wm_2', 'org_a', 'ws_a2', 'user_b', 'viewer')`, foreignKeyViolation},
		{"member with a role that does not exist", `INSERT INTO workspace_members (id, org_id, workspace_id, user_id, role) VALUES ('wm_3', 'org_a', 'ws_a2', 'user_a', 'owner')`, checkViolation},
		{"member that is neither user nor group", `INSERT INTO workspace_members (id, org_id, workspace_id, role) VALUES ('wm_4', 'org_a', 'ws_a2', 'viewer')`, checkViolation},
		{"same user twice in a workspace", `INSERT INTO workspace_members (id, org_id, workspace_id, user_id, role) VALUES ('wm_5', 'org_a', 'ws_a1', 'user_a', 'viewer')`, uniqueViolation},
		{"same email in two orgs", `INSERT INTO users (id, org_id, email, display_name) VALUES ('user_b2', 'org_b', 'A@example.com', 'A')`, ""},
		{"same email in one org, different case", `INSERT INTO users (id, org_id, email, display_name) VALUES ('user_a2', 'org_a', 'A@Example.com', 'A')`, uniqueViolation},
		{"dataset in its datasource's workspace", `INSERT INTO datasets (id, org_id, workspace_id, datasource_id, name, spec, spec_version) VALUES ('ds_1', 'org_a', 'ws_a1', 'src_a1', 'd', '{}', 1)`, ""},
		{"dataset using a datasource of another workspace", `INSERT INTO datasets (id, org_id, workspace_id, datasource_id, name, spec, spec_version) VALUES ('ds_2', 'org_a', 'ws_a2', 'src_a1', 'd', '{}', 1)`, foreignKeyViolation},
		{"workspace claiming another org's creator", `INSERT INTO workspaces (id, org_id, name, created_by) VALUES ('ws_a3', 'org_a', 'Three', 'user_b')`, foreignKeyViolation},
	}
	for _, tt := range tests {
		_, err := pool.Exec(ctx, tt.sql)
		var pgErr *pgconn.PgError
		switch {
		case tt.code == "" && err != nil:
			t.Errorf("%s: unexpected error %v", tt.name, err)
		case tt.code != "" && (!errors.As(err, &pgErr) || pgErr.Code != tt.code):
			t.Errorf("%s: err = %v, want SQLSTATE %s", tt.name, err, tt.code)
		}
	}
}
