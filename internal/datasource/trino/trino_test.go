package trino_test

import (
	"context"
	"database/sql"
	"errors"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	driver "github.com/trinodb/trino-go-client/trino"

	"github.com/supazd/supabi/internal/conformance"
	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/datasource"
	_ "github.com/supazd/supabi/internal/datasource/trino"
	"github.com/supazd/supabi/internal/id"
)

// The catalog the tests create their tables in. It must allow creating
// schemas and tables, and inserting rows, which the memory connector does.
const catalog = "memory"

func server(t *testing.T) *url.URL {
	t.Helper()
	raw := os.Getenv("SUPABI_TEST_TRINO_URL")
	if raw == "" {
		t.Skip("SUPABI_TEST_TRINO_URL is not set")
	}
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

// setup creates a throwaway schema holding the fixture. Tests are skipped
// unless SUPABI_TEST_TRINO_URL is set; `make test-olap` sets it.
func setup(t *testing.T) conformance.Target {
	t.Helper()
	u := server(t)
	connector, err := driver.NewConnector(&driver.Config{ServerURI: u.String()})
	if err != nil {
		t.Fatal(err)
	}
	admin := sql.OpenDB(connector)
	ctx := context.Background()
	name := id.New("test")
	exec := func(statement string) {
		t.Helper()
		if _, err := admin.ExecContext(ctx, statement); err != nil {
			t.Fatalf("%v\n%s", err, statement)
		}
	}
	exec("CREATE SCHEMA " + catalog + "." + name)
	exec(`CREATE TABLE ` + catalog + `.` + name + `.orders (
		id integer, created_at timestamp(3), paid_at timestamp(3) with time zone, order_date date,
		amount decimal(18, 2) COMMENT '金额', qty integer, region varchar, user_id varchar, status varchar, note varchar
	) COMMENT '订单'`)
	// Text is not taken for a time or a date unless cast.
	exec(`INSERT INTO ` + catalog + `.` + name + `.orders
		SELECT id, CAST(created_at AS timestamp(3)), paid_at, CAST(order_date AS date), amount, qty, region, user_id, status, note
		FROM (VALUES ` + conformance.Values(func(wallClock string) string {
		return "TIMESTAMP '" + wallClock + " " + conformance.DataTimezone + "'"
	}) + `) AS v (id, created_at, paid_at, order_date, amount, qty, region, user_id, status, note)`)

	conn, err := datasource.Open(ctx, "trino", datasource.Config{
		Settings:     map[string]string{"host": u.Hostname(), "port": u.Port(), "user": u.User.Username(), "catalog": catalog, "schema": name},
		DataTimezone: conformance.DataTimezone,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		conn.Close()
		_, _ = admin.ExecContext(ctx, "DROP TABLE "+catalog+"."+name+".orders")
		_, _ = admin.ExecContext(ctx, "DROP SCHEMA "+catalog+"."+name)
		_ = admin.Close()
	})
	if err := conn.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	return conformance.Target{
		Conn:          conn,
		Table:         dataset.Source{Type: "table", Table: "orders"},
		QualifiedName: name + ".orders",
		Commented:     true,
		// Decimal division keeps the larger scale, rounded: 350.25 / 2 would be 175.13.
		AverageExpr: "CAST(SUM(${amount}) AS double) / NULLIF(COUNT(${order_id}), 0)",
	}
}

func TestConformance(t *testing.T) {
	conformance.Run(t, setup(t))
}

func TestDescribeAndArguments(t *testing.T) {
	tg := setup(t)
	ctx := context.Background()

	columns, err := tg.Conn.Describe(ctx, "SELECT id, created_at, paid_at, order_date, amount, qty / 3e0 AS ratio, status = 'paid' AS is_paid, note FROM "+tg.QualifiedName+" WHERE id > ?", []any{0})
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, c := range columns {
		got = append(got, c.Name+":"+string(c.Type))
	}
	want := "id:integer created_at:timestamp paid_at:timestamp order_date:date amount:decimal ratio:float is_paid:boolean note:string"
	if strings.Join(got, " ") != want {
		t.Errorf("Describe:\n got %s\nwant %s", strings.Join(got, " "), want)
	}

	// A ? in a string, a quoted name or a comment is not an argument, and an
	// argument's quotes are its own.
	result, err := tg.Conn.Query(ctx, `SELECT '?' AS "what?", note -- why?
		FROM `+tg.QualifiedName+` /* ? */ WHERE note = ? OR region = ?`, []any{"50% off", "it's'; DROP"})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Rows) != 1 || result.Rows[0][0] != "?" || result.Rows[0][1] != "50% off" {
		t.Errorf("rows = %v", result.Rows)
	}

	// A statement with arguments can be explained.
	if _, err := tg.Conn.Query(ctx, "EXPLAIN SELECT * FROM "+tg.QualifiedName+" WHERE id > ?", []any{1}); err != nil {
		t.Errorf("explain: %v", err)
	}

	// A mistake after an argument is found where it is in the statement given.
	broken := "SELECT id FROM " + tg.QualifiedName + " WHERE region = ? AND nope = 1"
	_, err = tg.Conn.Query(ctx, broken, []any{"华东华东华东"})
	var queryErr *datasource.QueryError
	if !errors.As(err, &queryErr) {
		t.Fatalf("err = %v, want a QueryError", err)
	}
	if want := strings.Index(broken, "nope") + 1; queryErr.Position != want || strings.HasPrefix(queryErr.Message, "line ") {
		t.Errorf("position = %d, want %d: %s", queryErr.Position, want, queryErr.Message)
	}
}

// Every catalog is listed, the default one first, and a table is named the
// way a statement has to name it.
func TestTablesInEveryCatalog(t *testing.T) {
	tg := setup(t)
	tables, err := tg.Conn.Tables(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(tables) == 0 || tables[0].Path[0] != catalog {
		t.Fatalf("the default catalog does not come first: %v", tables)
	}
	schema, _, _ := strings.Cut(tg.QualifiedName, ".")
	for _, table := range tables {
		if table.Path[0] == "system" {
			t.Errorf("the system catalog is listed: %v", table.Path)
		}
		inDefault := table.Path[0] == catalog
		if inDefault != (table.Catalog == "") || (inDefault && table.Path[1] == schema) != (table.Schema == "") {
			t.Errorf("%v.%s is named with catalog %q and schema %q", table.Path, table.Name, table.Catalog, table.Schema)
		}
	}
}

// A wrong password and a password over plain HTTP are not problems with a statement.
func TestConnectionSettings(t *testing.T) {
	u := server(t)
	_, err := datasource.Open(context.Background(), "trino", datasource.Config{
		Settings: map[string]string{"host": u.Hostname(), "port": u.Port(), "user": "supabi"},
		Password: "secret",
	})
	if err == nil || !strings.Contains(err.Error(), "encrypted") {
		t.Errorf("a password over plain HTTP: err = %v", err)
	}
	conn, err := datasource.Open(context.Background(), "trino", datasource.Config{
		Settings: map[string]string{"host": u.Hostname(), "port": "1", "user": "supabi"},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	// The client tries a server it cannot reach again until the time is up,
	// which for a connection test is the caller's to set.
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	err = conn.Ping(ctx)
	var queryErr *datasource.QueryError
	if err == nil || errors.As(err, &queryErr) {
		t.Errorf("no server: err = %v, want a failure to connect", err)
	}
}
