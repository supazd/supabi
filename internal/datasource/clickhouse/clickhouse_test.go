package clickhouse_test

import (
	"context"
	"database/sql"
	"errors"
	"net/url"
	"os"
	"strings"
	"testing"

	driver "github.com/ClickHouse/clickhouse-go/v2"

	"github.com/supazd/supabi/internal/conformance"
	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/datasource"
	_ "github.com/supazd/supabi/internal/datasource/clickhouse"
	"github.com/supazd/supabi/internal/id"
)

// setup creates a throwaway database holding the fixture. Tests are skipped
// unless SUPABI_TEST_CLICKHOUSE_URL is set; `make test` sets it.
func setup(t *testing.T) conformance.Target {
	t.Helper()
	raw := os.Getenv("SUPABI_TEST_CLICKHOUSE_URL")
	if raw == "" {
		t.Skip("SUPABI_TEST_CLICKHOUSE_URL is not set")
	}
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	password, _ := u.User.Password()
	admin := driver.OpenDB(&driver.Options{
		Addr: []string{u.Host},
		Auth: driver.Auth{Username: u.User.Username(), Password: password},
		// The fixture's wall-clock times are written in the data time zone.
		Settings: driver.Settings{"session_timezone": conformance.DataTimezone},
	})
	ctx := context.Background()
	name := id.New("test")
	exec := func(db *sql.DB, statement string) {
		t.Helper()
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("%v\n%s", err, statement)
		}
	}
	exec(admin, "CREATE DATABASE "+name)
	// created_at has no zone of its own; paid_at is pinned to UTC, so the two
	// columns show different wall-clock times for the same instants.
	exec(admin, `CREATE TABLE `+name+`.orders (
		id Int32, created_at DateTime, paid_at DateTime('UTC'), order_date Date,
		amount Decimal(18, 2) COMMENT '金额', qty Int32, region String, user_id String, status String, note Nullable(String)
	) ENGINE = MergeTree ORDER BY id COMMENT '订单'`)
	exec(admin, "INSERT INTO "+name+".orders VALUES "+conformance.Values(func(wallClock string) string {
		return "toDateTime('" + wallClock + "', '" + conformance.DataTimezone + "')"
	}))

	conn, err := datasource.Open(ctx, "clickhouse", datasource.Config{
		Settings:     map[string]string{"host": u.Hostname(), "port": u.Port(), "database": name, "user": u.User.Username()},
		Password:     password,
		DataTimezone: conformance.DataTimezone,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		conn.Close()
		_, _ = admin.ExecContext(ctx, "DROP DATABASE "+name)
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
		// Decimal division in ClickHouse keeps the dividend's scale: 350.25 / 2 would be 175.12.
		AverageExpr: "toFloat64(SUM(${amount})) / NULLIF(COUNT(${order_id}), 0)",
	}
}

func TestConformance(t *testing.T) {
	conformance.Run(t, setup(t))
}

func TestReadOnlyAndDescribe(t *testing.T) {
	tg := setup(t)
	ctx := context.Background()
	for _, stmt := range []string{
		"ALTER TABLE " + tg.QualifiedName + " DELETE WHERE 1",
		"INSERT INTO " + tg.QualifiedName + " (id) VALUES (99)",
		"CREATE TABLE " + tg.QualifiedName + "_copy (a Int32) ENGINE = Memory",
		"DROP TABLE " + tg.QualifiedName,
	} {
		_, err := tg.Conn.Query(ctx, stmt, nil)
		if err == nil || !strings.Contains(strings.ToLower(err.Error()), "readonly") {
			t.Errorf("%q: err = %v, want a readonly error", stmt, err)
		}
	}
	result, err := tg.Conn.Query(ctx, "SELECT count() FROM "+tg.QualifiedName, nil)
	if err != nil || len(result.Rows) != 1 || result.Rows[0][0] != int64(len(conformance.Rows)) {
		t.Errorf("row count = %v, %v", result, err)
	}

	columns, err := tg.Conn.Describe(ctx, "SELECT id, created_at, paid_at, order_date, amount, qty / 3 AS ratio, status = 'paid' AS is_paid, note, toLowCardinality(region) AS r FROM "+tg.QualifiedName+" WHERE id > ?", []any{0})
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, c := range columns {
		got = append(got, c.Name+":"+string(c.Type))
	}
	want := "id:integer created_at:timestamp paid_at:timestamp order_date:date amount:decimal ratio:float is_paid:integer note:string r:string"
	if strings.Join(got, " ") != want {
		t.Errorf("Describe:\n got %s\nwant %s", strings.Join(got, " "), want)
	}
	_, err = tg.Conn.Describe(ctx, "SELECT nope FROM "+tg.QualifiedName, nil)
	var queryErr *datasource.QueryError
	if !errors.As(err, &queryErr) || strings.Contains(queryErr.Message, "Stack trace") {
		t.Errorf("Describe of invalid SQL: err = %v, want a QueryError without a stack trace", err)
	}
}

// A wrong password is a failure to reach the database, not a problem with a statement.
func TestConnectionFailureIsNotAQueryError(t *testing.T) {
	raw := os.Getenv("SUPABI_TEST_CLICKHOUSE_URL")
	if raw == "" {
		t.Skip("SUPABI_TEST_CLICKHOUSE_URL is not set")
	}
	u, _ := url.Parse(raw)
	conn, err := datasource.Open(context.Background(), "clickhouse", datasource.Config{
		Settings: map[string]string{"host": u.Hostname(), "port": u.Port(), "user": u.User.Username()},
		Password: "not-the-password",
	})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	err = conn.Ping(context.Background())
	var queryErr *datasource.QueryError
	if err == nil || errors.As(err, &queryErr) {
		t.Errorf("Ping with a wrong password: err = %v, want a non-query error", err)
	}
}
