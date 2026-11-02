// Command seed loads the same sample data into each of the development
// databases of compose.yaml, as `make dev-seed` and `make dev-seed-olap` do.
// It is safe to run again: it rebuilds the database demo, or the schema demo
// in PostgreSQL, from scratch.
//
// Connect SupaBI to it as a data source with the user supabi_demo, password
// demo and data time zone Asia/Shanghai, at host 127.0.0.1 and:
//
//	PostgreSQL  port 15432, database supabi (the tables are in the schema demo)
//	MySQL       port 13306, database demo
//	ClickHouse  port 19000, database demo
//	StarRocks   port 19030, database demo
//	Doris       port 19031, database demo
//
// supabi_demo can only read the sample data, which is how a real data
// source account should be set up.
//
// The rows are drawn once, from a fixed seed, and written to every database,
// so a question asked of each of them has the same answer. They depend only
// on the day: loads on the same day are identical. Orders run from the first
// day of the month 18 months ago to the end of yesterday, Shanghai time.
package main

import (
	"context"
	"database/sql"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	_ "github.com/ClickHouse/clickhouse-go/v2" // registers the clickhouse driver
	_ "github.com/go-sql-driver/mysql"         // registers the mysql driver
	"github.com/jackc/pgx/v5"
)

func main() {
	dsns := map[string]*string{
		"postgres":   flag.String("postgres", "postgres://supabi:supabi@127.0.0.1:15432/supabi", "PostgreSQL to load into, as its superuser"),
		"mysql":      flag.String("mysql", "root:supabi@tcp(127.0.0.1:13306)/", "MySQL to load into, as root"),
		"clickhouse": flag.String("clickhouse", "clickhouse://supabi:supabi@127.0.0.1:19000", "ClickHouse to load into, as a user that can create users"),
		"starrocks":  flag.String("starrocks", "root@tcp(127.0.0.1:19030)/", "StarRocks to load into, as root"),
		"doris":      flag.String("doris", "root@tcp(127.0.0.1:19031)/", "Doris to load into, as root"),
	}
	flag.Usage = func() {
		fmt.Fprintln(flag.CommandLine.Output(), "Usage: go run ./dev/seed [flags] postgres|mysql|clickhouse|starrocks|doris ...")
		flag.PrintDefaults()
	}
	flag.Parse()
	if flag.NArg() == 0 {
		flag.Usage()
		os.Exit(2)
	}

	now := time.Now().In(shanghai)
	tables := generate(time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC))
	want := expected(tables)
	for _, name := range flag.Args() {
		dsn, ok := dsns[name]
		if !ok {
			fmt.Fprintf(os.Stderr, "seed: unknown database %q\n", name)
			os.Exit(2)
		}
		start := time.Now()
		if err := load(context.Background(), name, *dsn, tables, want); err != nil {
			fmt.Fprintf(os.Stderr, "seed: %s: %v\n", name, err)
			os.Exit(1)
		}
		fmt.Printf("%-10s %s (%.1fs)\n", name, want, time.Since(start).Seconds())
	}
}

// totals sum up the orders, to check that a database holds what was written.
type totals struct {
	count        int64
	amount, cost int64 // cents
	last         string
}

func (t totals) String() string {
	return fmt.Sprintf("%d orders, amount %s, cost %s, last at %s", t.count, yuan(t.amount), yuan(t.cost), t.last)
}

func expected(tables []table) totals {
	var t totals
	for _, row := range tables[3].rows { // orders
		t.count++
		t.amount += row[9].(int64)
		if cost, ok := row[10].(int64); ok {
			t.cost += cost
		}
		t.last = max(t.last, row[1].(time.Time).Format("2006-01-02 15:04"))
	}
	return t
}

func load(ctx context.Context, name, dsn string, tables []table, want totals) error {
	d := map[string]dialect{"postgres": postgres, "mysql": mysql, "clickhouse": clickhouse, "starrocks": starrocks, "doris": doris}[name]
	c, err := open(ctx, name, dsn)
	if err != nil {
		return err
	}
	defer c.close()

	stmts := d.setup
	for _, t := range tables {
		stmts = append(stmts, d.create(t)...)
		stmts = append(stmts, d.inserts(t)...)
	}
	for _, stmt := range append(stmts, d.grant...) {
		if err := c.exec(ctx, stmt); err != nil {
			return fmt.Errorf("%w\n%s", err, head(stmt))
		}
	}

	var got totals
	var amount, cost string
	if err := c.queryRow(ctx, d.totals, &got.count, &amount, &cost, &got.last); err != nil {
		return fmt.Errorf("check the load: %w", err)
	}
	if got.amount, err = cents(amount); err == nil {
		got.cost, err = cents(cost)
	}
	if err != nil || got != want {
		return fmt.Errorf("the database holds %s, not the %s written", got, want)
	}
	return nil
}

// head is the start of a statement, for an error message.
func head(stmt string) string {
	if i := strings.Index(stmt, "\n("); i > 0 {
		return stmt[:i] + " ..."
	}
	return stmt
}

// cents reads a sum such as 1234.50 or 1234.5.
func cents(s string) (int64, error) {
	whole, frac, _ := strings.Cut(s, ".")
	frac = (frac + "00")[:2]
	var n int64
	if _, err := fmt.Sscanf(whole+frac, "%d", &n); err != nil {
		return 0, fmt.Errorf("read %q as a sum of money: %w", s, err)
	}
	return n, nil
}

// conn runs statements on a single connection.
type conn interface {
	exec(ctx context.Context, stmt string) error
	queryRow(ctx context.Context, query string, dest ...any) error
	close()
}

func open(ctx context.Context, name, dsn string) (conn, error) {
	if name == "postgres" {
		c, err := pgx.Connect(ctx, dsn)
		if err != nil {
			return nil, err
		}
		return pgConn{c}, nil
	}
	driver := "mysql"
	if name == "clickhouse" {
		driver = "clickhouse"
	}
	db, err := sql.Open(driver, dsn)
	if err != nil {
		return nil, err
	}
	// One connection, so that nothing depends on which one a statement gets.
	db.SetMaxOpenConns(1)
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, err
	}
	return sqlConn{db}, nil
}

type pgConn struct{ c *pgx.Conn }

func (p pgConn) exec(ctx context.Context, stmt string) error {
	_, err := p.c.Exec(ctx, stmt)
	return err
}

func (p pgConn) queryRow(ctx context.Context, query string, dest ...any) error {
	return p.c.QueryRow(ctx, query).Scan(dest...)
}

func (p pgConn) close() { p.c.Close(context.Background()) }

type sqlConn struct{ db *sql.DB }

func (s sqlConn) exec(ctx context.Context, stmt string) error {
	_, err := s.db.ExecContext(ctx, stmt)
	return err
}

func (s sqlConn) queryRow(ctx context.Context, query string, dest ...any) error {
	return s.db.QueryRowContext(ctx, query).Scan(dest...)
}

func (s sqlConn) close() { s.db.Close() }
