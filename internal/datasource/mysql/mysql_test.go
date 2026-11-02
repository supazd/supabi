package mysql_test

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"strings"
	"testing"

	driver "github.com/go-sql-driver/mysql"

	"github.com/supazd/supabi/internal/conformance"
	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/datasource"
	_ "github.com/supazd/supabi/internal/datasource/mysql"
	"github.com/supazd/supabi/internal/id"
)

// database is one of the databases this driver serves, with what a test
// needs to know to prepare it.
type database struct {
	name string
	// env names the variable holding the DSN of an administrator. Tests are
	// skipped when it is not set; `make test` and `make test-olap` set them.
	env string
	// createTable is the fixture's DDL, with %s for the table's qualified name.
	createTable string
	readOnly    bool
}

// The fixture's wall-clock times are written in the data time zone. MySQL's
// TIMESTAMP stores an instant; the analytical engines only have DATETIME.
var databases = []database{
	{name: "mysql", env: "SUPABI_TEST_MYSQL_DSN", readOnly: true, createTable: `CREATE TABLE %s (
		id int, created_at datetime, paid_at timestamp NULL, order_date date,
		amount decimal(18,2) COMMENT '金额', qty int, region varchar(50), user_id varchar(50), status varchar(50), note varchar(200)
	) CHARACTER SET utf8mb4 COMMENT '订单'`},
	{name: "starrocks", env: "SUPABI_TEST_STARROCKS_DSN", createTable: olapTable},
	{name: "doris", env: "SUPABI_TEST_DORIS_DSN", createTable: olapTable},
}

const olapTable = `CREATE TABLE %s (
	id int, created_at datetime, paid_at datetime, order_date date,
	amount decimal(18,2) COMMENT '金额', qty int, region varchar(50), user_id varchar(50), status varchar(50), note varchar(200) NULL
) DUPLICATE KEY(id) COMMENT '订单' DISTRIBUTED BY HASH(id) BUCKETS 1 PROPERTIES ("replication_num" = "1")`

// setup creates a throwaway database holding the fixture.
func setup(t *testing.T, d database) (conformance.Target, *driver.Config) {
	t.Helper()
	dsn := os.Getenv(d.env)
	if dsn == "" {
		t.Skip(d.env + " is not set")
	}
	admin, err := driver.ParseDSN(dsn)
	if err != nil {
		t.Fatal(err)
	}
	admin.Params = map[string]string{"time_zone": "'" + conformance.DataTimezone + "'"}
	connector, err := driver.NewConnector(admin)
	if err != nil {
		t.Fatal(err)
	}
	db := sql.OpenDB(connector)
	ctx := context.Background()
	name := id.New("test")
	for _, statement := range []string{
		"CREATE DATABASE " + name,
		strings.Replace(d.createTable, "%s", name+".orders", 1),
		"INSERT INTO " + name + ".orders VALUES " + conformance.Values(func(wallClock string) string { return "'" + wallClock + "'" }),
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("%v\n%s", err, statement)
		}
	}

	host, port, _ := strings.Cut(admin.Addr, ":")
	conn, err := datasource.Open(ctx, d.name, datasource.Config{
		Settings:     map[string]string{"host": host, "port": port, "database": name, "user": admin.User, "tls": "false"},
		Password:     admin.Passwd,
		DataTimezone: conformance.DataTimezone,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		conn.Close()
		_, _ = db.ExecContext(ctx, "DROP DATABASE "+name)
		_ = db.Close()
	})
	if err := conn.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	return conformance.Target{
		Conn:          conn,
		Table:         dataset.Source{Type: "table", Table: "orders"},
		QualifiedName: name + ".orders",
		Commented:     true,
		// Doris 2.1 answers with the kind of table instead.
		NoTableComment: d.name == "doris",
	}, admin
}

func TestConformance(t *testing.T) {
	for _, d := range databases {
		t.Run(d.name, func(t *testing.T) {
			tg, _ := setup(t, d)
			if got := tg.Conn.Dialect().Name(); got != d.name {
				t.Fatalf("dialect = %s, want %s", got, d.name)
			}
			conformance.Run(t, tg)
		})
	}
}

func TestDescribe(t *testing.T) {
	for _, d := range databases {
		t.Run(d.name, func(t *testing.T) {
			tg, _ := setup(t, d)
			ctx := context.Background()
			columns, err := tg.Conn.Describe(ctx, "SELECT id, created_at, order_date, amount, CAST(qty AS DOUBLE) AS ratio, note FROM "+tg.QualifiedName+" WHERE id > ?", []any{0})
			if err != nil {
				t.Fatal(err)
			}
			var got []string
			for _, c := range columns {
				got = append(got, c.Name+":"+string(c.Type))
			}
			want := "id:integer created_at:timestamp order_date:date amount:decimal ratio:float note:string"
			if strings.Join(got, " ") != want {
				t.Errorf("Describe:\n got %s\nwant %s", strings.Join(got, " "), want)
			}
			_, err = tg.Conn.Describe(ctx, "SELECT nope FROM "+tg.QualifiedName, nil)
			var queryErr *datasource.QueryError
			if !errors.As(err, &queryErr) {
				t.Errorf("Describe of invalid SQL: err = %v, want a QueryError", err)
			}
		})
	}
}

// MySQL sessions are read-only. StarRocks and Doris have no such setting;
// there the database account is the only safeguard.
func TestReadOnly(t *testing.T) {
	for _, d := range databases {
		if !d.readOnly {
			continue
		}
		t.Run(d.name, func(t *testing.T) {
			tg, _ := setup(t, d)
			ctx := context.Background()
			for _, stmt := range []string{
				"DELETE FROM " + tg.QualifiedName,
				"INSERT INTO " + tg.QualifiedName + " (id) VALUES (99)",
				"CREATE TABLE " + tg.QualifiedName + "_copy (a int)",
			} {
				_, err := tg.Conn.Query(ctx, stmt, nil)
				if err == nil || !strings.Contains(strings.ToLower(err.Error()), "read only") {
					t.Errorf("%q: err = %v, want a read-only transaction error", stmt, err)
				}
			}
			result, err := tg.Conn.Query(ctx, "SELECT COUNT(*) FROM "+tg.QualifiedName, nil)
			if err != nil || len(result.Rows) != 1 || result.Rows[0][0] != int64(len(conformance.Rows)) {
				t.Errorf("row count = %v, %v", result, err)
			}
		})
	}
}

// A wrong password is a failure to reach the database, not a problem with a statement.
func TestConnectionFailureIsNotAQueryError(t *testing.T) {
	d := databases[0]
	_, admin := setup(t, d)
	host, port, _ := strings.Cut(admin.Addr, ":")
	conn, err := datasource.Open(context.Background(), d.name, datasource.Config{
		Settings: map[string]string{"host": host, "port": port, "database": "mysql", "user": admin.User, "tls": "false"},
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
