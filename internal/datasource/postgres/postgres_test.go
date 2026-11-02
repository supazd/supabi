package postgres_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/supazd/supabi/internal/conformance"
	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/datasource"
	_ "github.com/supazd/supabi/internal/datasource/postgres"
	"github.com/supazd/supabi/internal/testdb"
)

func setup(t *testing.T) conformance.Target {
	t.Helper()
	db := testdb.New(t)
	ctx := context.Background()
	// paid_at is a timestamptz: the literal carries Shanghai's offset.
	values := conformance.Values(func(wallClock string) string { return "'" + wallClock + "+08'" })
	if _, err := db.Pool.Exec(ctx, `
		CREATE TABLE orders (
			id int, created_at timestamp, paid_at timestamptz, order_date date,
			amount numeric(18,2), qty int, region text, user_id text, status text, note text
		);
		COMMENT ON TABLE orders IS '订单';
		COMMENT ON COLUMN orders.amount IS '金额';
		INSERT INTO orders VALUES `+values); err != nil {
		t.Fatal(err)
	}
	settings, password := db.Settings()
	conn, err := datasource.Open(ctx, "postgres", datasource.Config{Settings: settings, Password: password, DataTimezone: conformance.DataTimezone})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(conn.Close)
	return conformance.Target{
		Conn:          conn,
		Table:         dataset.Source{Type: "table", Schema: db.Schema, Table: "orders"},
		QualifiedName: db.Schema + ".orders",
		Commented:     true,
	}
}

func TestConformance(t *testing.T) {
	conformance.Run(t, setup(t))
}

func TestReadOnlyAndDescribe(t *testing.T) {
	tg := setup(t)
	ctx := context.Background()
	for _, stmt := range []string{
		"DELETE FROM " + tg.QualifiedName,
		"CREATE TABLE " + tg.QualifiedName + "_copy (a int)",
		"WITH gone AS (DELETE FROM " + tg.QualifiedName + " RETURNING id) SELECT * FROM gone",
	} {
		_, err := tg.Conn.Query(ctx, stmt, nil)
		if err == nil || !strings.Contains(err.Error(), "read-only") {
			t.Errorf("%q: err = %v, want a read-only transaction error", stmt, err)
		}
	}

	columns, err := tg.Conn.Describe(ctx, "SELECT id, created_at, paid_at, order_date, amount, qty::float8 AS ratio, status = 'paid' AS is_paid, note FROM "+tg.QualifiedName+" WHERE id > $1", []any{0})
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
	_, err = tg.Conn.Describe(ctx, "SELECT nope FROM "+tg.QualifiedName, nil)
	var queryErr *datasource.QueryError
	if !errors.As(err, &queryErr) {
		t.Errorf("Describe of invalid SQL: err = %v, want a QueryError", err)
	}
}
