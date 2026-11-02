// Package mysql is the data source driver for MySQL and for the databases
// that speak its protocol: StarRocks and Apache Doris.
package mysql

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"net"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	driver "github.com/go-sql-driver/mysql"

	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/dialect"
)

func init() {
	datasource.Register(variant{name: "mysql", category: datasource.OLTP, port: "3306", readOnly: true, needsZoneTables: true, minMajor: 8,
		dialect: func(string) dialect.Dialect { return dialect.MySQL{} }})
	datasource.Register(variant{name: "starrocks", category: datasource.OLAP, port: "9030",
		dialect: func(zone string) dialect.Dialect { return dialect.StarRocks{DataTimezone: zone} }})
	datasource.Register(variant{name: "doris", category: datasource.OLAP, port: "9030", noTableComments: true,
		dialect: func(zone string) dialect.Dialect { return dialect.StarRocks{Doris: true, DataTimezone: zone} }})
}

// variant is one of the databases that speak the MySQL protocol. They share
// the connection and the reading of results, and differ in dialect and in
// what their sessions can be told.
type variant struct {
	name     string
	category datasource.Category
	port     string
	// dialect builds the dialect for a data time zone.
	dialect func(zone string) dialect.Dialect
	// readOnly: the server can make a session read-only.
	readOnly bool
	// minMajor is the oldest major version the dialect's SQL runs on, which a
	// connection test checks: MySQL 8.0 has the window functions, CAST(… AS
	// DOUBLE) and REGEXP_LIKE it writes. Zero where the version is not
	// checked: StarRocks and Doris report a MySQL version of their own.
	minMajor int
	// needsZoneTables: converting between named zones depends on tables that
	// an installation may not have loaded.
	needsZoneTables bool
	// noTableComments: where the comment of a table is asked for, the server
	// gives the kind of table it is ("OLAP") for every table.
	noTableComments bool
}

func (v variant) Name() string { return v.name }

func (v variant) Category() datasource.Category { return v.category }

func (v variant) Dialect() dialect.Dialect { return v.dialect("") }

func (v variant) Settings() []datasource.SettingField {
	return []datasource.SettingField{
		{Name: "host", Required: true},
		{Name: "port", Default: v.port},
		{Name: "database", Required: true},
		{Name: "user", Required: true},
		{Name: "tls", Default: "preferred", Options: []string{"false", "preferred", "true", "skip-verify"}},
	}
}

func (v variant) Open(_ context.Context, cfg datasource.Config) (datasource.Conn, error) {
	s := cfg.Settings
	if s["host"] == "" || s["database"] == "" || s["user"] == "" {
		return nil, fmt.Errorf("%s: host, database and user are required", v.name)
	}
	port := s["port"]
	if port == "" {
		port = v.port
	}
	zone := cfg.DataTimezone
	if zone == "" {
		zone = "UTC"
	}
	loc, err := time.LoadLocation(zone)
	if err != nil || strings.ContainsAny(zone, "'\\") {
		return nil, fmt.Errorf("%s: invalid data time zone %q", v.name, zone)
	}

	c := driver.NewConfig()
	c.User, c.Passwd = s["user"], cfg.Password
	c.Net, c.Addr = "tcp", net.JoinHostPort(s["host"], port)
	c.DBName = s["database"]
	c.TLSConfig = s["tls"]
	// Times are exchanged as wall-clock time in the data time zone; see dialect.MySQL.
	c.ParseTime, c.Loc = true, loc
	c.Params = map[string]string{"time_zone": "'" + zone + "'"}
	if v.readOnly {
		// A second line of defence behind the read-only database account.
		c.Params["transaction_read_only"] = "ON"
	} else {
		// These engines have no read-only sessions, and their support for
		// server-side prepared statements varies by version, so arguments are
		// escaped and placed into the statement by the client.
		c.InterpolateParams = true
	}
	connector, err := driver.NewConnector(c)
	if err != nil {
		return nil, fmt.Errorf("%s: invalid connection settings", v.name)
	}
	db := sql.OpenDB(connector)
	db.SetMaxOpenConns(10)
	db.SetConnMaxLifetime(30 * time.Minute)
	return &conn{db: db, dialect: v.dialect(zone), minMajor: v.minMajor, needsZoneTables: v.needsZoneTables, noTableComments: v.noTableComments}, nil
}

type conn struct {
	db              *sql.DB
	dialect         dialect.Dialect
	minMajor        int
	needsZoneTables bool
	noTableComments bool
}

func (c *conn) Dialect() dialect.Dialect { return c.dialect }

func (c *conn) Close() { _ = c.db.Close() }

// Ping also checks what a server needs for the queries written for it: a
// version the dialect's SQL runs on, and, where they can be missing, the
// tables to convert between named time zones. Without those CONVERT_TZ
// returns NULL instead of failing, and every time-based result would
// silently be wrong. Ping is how a connection is tested, so this is where an
// author learns of it; queries are not stopped.
func (c *conn) Ping(ctx context.Context) error {
	if c.minMajor == 0 && !c.needsZoneTables {
		return classify(c.db.PingContext(ctx))
	}
	var version string
	var converted sql.NullString
	if err := c.db.QueryRowContext(ctx, `SELECT VERSION(), CONVERT_TZ('2000-01-01 00:00:00', 'UTC', 'Asia/Shanghai')`).Scan(&version, &converted); err != nil {
		return c.explain(err)
	}
	if major, ok := majorVersion(version); ok && major < c.minMajor {
		return &datasource.ConnectError{
			Code:    "mysql_version",
			Params:  map[string]string{"version": version, "required": minimum(c.minMajor)},
			Message: fmt.Sprintf("SupaBI needs MySQL %s or later; this server is %s", minimum(c.minMajor), version),
		}
	}
	if c.needsZoneTables && !converted.Valid {
		return errors.New("the MySQL server has no time zone tables loaded; load them with mysql_tzinfo_to_sql so that times can be converted between zones")
	}
	return nil
}

func minimum(major int) string { return strconv.Itoa(major) + ".0" }

// majorVersion reads the major version from what VERSION() returns, such as
// 8.0.36 or 5.7.44-log. MariaDB numbers its versions apart from MySQL, so
// 10.6.12-MariaDB says nothing about the MySQL it can stand in for.
func majorVersion(version string) (int, bool) {
	if strings.Contains(strings.ToLower(version), "mariadb") {
		return 0, false
	}
	major, _, _ := strings.Cut(version, ".")
	n, err := strconv.Atoi(major)
	return n, err == nil
}

// explain tells a server too old for the dialect's SQL apart from a wrong
// address or password, where it fails before its version can be read: MySQL
// 5.7 built with an old OpenSSL offers no key exchange that Go still uses by
// default, and before 5.7.20 MySQL has no transaction_read_only to set.
func (c *conn) explain(err error) error {
	if c.minMajor == 0 {
		return classify(err)
	}
	required := minimum(c.minMajor)
	// The server turning down every key exchange or TLS version offered, or
	// offering only versions too old to accept. A certificate that fails to
	// verify is another matter, which its own message makes plain.
	var remote *net.OpError
	refused := errors.As(err, &remote) && remote.Op == "remote error" &&
		(strings.HasSuffix(remote.Err.Error(), "handshake failure") || strings.HasSuffix(remote.Err.Error(), "protocol version not supported"))
	if refused || strings.Contains(err.Error(), "tls: server selected unsupported protocol version") {
		return &datasource.ConnectError{
			Code:    "mysql_tls",
			Params:  map[string]string{"error": err.Error(), "required": required},
			Message: fmt.Sprintf("the encrypted connection could not be set up (%v); the server may be MySQL 5.7 or older, or its encryption settings too old, and SupaBI needs MySQL %s or later", err, required),
		}
	}
	var mysqlErr *driver.MySQLError
	if errors.As(err, &mysqlErr) && mysqlErr.Number == 1193 && strings.Contains(mysqlErr.Message, "transaction_read_only") {
		return &datasource.ConnectError{
			Code:    "mysql_too_old",
			Params:  map[string]string{"required": required},
			Message: fmt.Sprintf("SupaBI needs MySQL %s or later; this server does not know transaction_read_only, so it is older than MySQL 5.7.20 or not MySQL", required),
		}
	}
	return classify(err)
}

func (c *conn) Query(ctx context.Context, query string, args []any) (*datasource.Result, error) {
	return datasource.Collect(ctx, c, query, args)
}

func (c *conn) Stream(ctx context.Context, query string, args []any, out datasource.RowWriter) error {
	rows, err := c.db.QueryContext(ctx, query, args...)
	if err != nil {
		return locate(classify(err), query)
	}
	defer rows.Close()
	columns, err := columnsOf(rows)
	if err != nil {
		return err
	}
	if err := out.Start(columns); err != nil {
		return err
	}
	for rows.Next() {
		values := make([]any, len(columns))
		targets := make([]any, len(columns))
		for i := range values {
			targets[i] = &values[i]
		}
		if err := rows.Scan(targets...); err != nil {
			return err
		}
		for i, v := range values {
			values[i] = normalize(v, columns[i].Type)
		}
		if err := out.WriteRow(values); err != nil {
			return err
		}
	}
	return classify(rows.Err())
}

func (c *conn) Describe(ctx context.Context, query string, args []any) ([]datasource.Column, error) {
	probe := probePrefix + query + ") AS supabi_probe LIMIT 0"
	rows, err := c.db.QueryContext(ctx, probe, args...)
	if err != nil {
		return nil, datasource.Inner(locate(classify(err), probe), len(probePrefix))
	}
	defer rows.Close()
	return columnsOf(rows)
}

const probePrefix = "SELECT * FROM ("

// Tables in the session's own database are listed without it, since that is
// how statements name them, and come first. The databases left out are the
// servers' own. Where a table is has one level, the database: only the
// catalog the session is in is listed, so there is no catalog to tell apart.
func (c *conn) Tables(ctx context.Context) ([]datasource.Table, error) {
	rows, err := c.db.QueryContext(ctx, `
		SELECT table_schema, IF(table_schema = DATABASE(), '', table_schema) AS db, table_name, column_name, column_type, COALESCE(column_comment, '') FROM information_schema.columns
		WHERE table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys', '_statistics_', '__internal_schema')
		ORDER BY db, table_name, ordinal_position
		LIMIT `+strconv.Itoa(datasource.MaxCatalogColumns))
	if err != nil {
		return nil, classify(err)
	}
	defer rows.Close()
	var list []datasource.CatalogRow
	for rows.Next() {
		var r datasource.CatalogRow
		if err := rows.Scan(&r.Namespace, &r.Schema, &r.Table, &r.Column, &r.DBType, &r.Comment); err != nil {
			return nil, err
		}
		list = append(list, r)
	}
	if err := rows.Err(); err != nil {
		return nil, classify(err)
	}
	tables := datasource.GroupTables(list)
	c.tableComments(ctx, tables)
	return tables, nil
}

// tableComments fills in what was written about each table. The tables are
// worth listing without it, so a server that will not say is not asked twice
// and is not an error.
func (c *conn) tableComments(ctx context.Context, tables []datasource.Table) {
	if c.noTableComments {
		return
	}
	rows, err := c.db.QueryContext(ctx, `
		SELECT table_schema, table_name, table_comment FROM information_schema.tables
		WHERE table_comment <> '' AND table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys', '_statistics_', '__internal_schema')`)
	if err != nil {
		return
	}
	defer rows.Close()
	comments := map[[2]string]string{}
	for rows.Next() {
		var schema, table, comment string
		if rows.Scan(&schema, &table, &comment) != nil {
			return
		}
		comments[[2]string{schema, table}] = comment
	}
	for i, t := range tables {
		if len(t.Path) > 0 {
			tables[i].Comment = comments[[2]string{t.Path[0], t.Name}]
		}
	}
}

func columnsOf(rows *sql.Rows) ([]datasource.Column, error) {
	types, err := rows.ColumnTypes()
	if err != nil {
		return nil, err
	}
	columns := make([]datasource.Column, len(types))
	for i, t := range types {
		columns[i] = datasource.Column{Name: t.Name(), Type: logicalType(t.DatabaseTypeName()), DBType: strings.ToLower(t.DatabaseTypeName())}
	}
	return columns, nil
}

func logicalType(dbType string) datasource.Type {
	switch strings.TrimPrefix(dbType, "UNSIGNED ") {
	case "TINYINT", "SMALLINT", "MEDIUMINT", "INT", "BIGINT", "YEAR", "BOOLEAN":
		// MySQL's BOOLEAN is TINYINT(1) and cannot be told apart here.
		return datasource.Integer
	case "DECIMAL":
		return datasource.Decimal
	case "FLOAT", "DOUBLE":
		return datasource.Float
	case "DATE":
		return datasource.Date
	case "DATETIME", "TIMESTAMP":
		return datasource.Timestamp
	default:
		return datasource.String
	}
}

// normalize converts a driver value into the small set of types Result
// promises. Without bound arguments the driver uses the text protocol and
// returns numbers as bytes, so the column's type decides how to read them.
func normalize(v any, t datasource.Type) any {
	switch x := v.(type) {
	case nil:
		return nil
	case int64:
		return x
	case uint64:
		if x > math.MaxInt64 {
			return strconv.FormatUint(x, 10)
		}
		return int64(x)
	case float32:
		return finite(float64(x))
	case float64:
		return finite(x)
	case time.Time:
		if t == datasource.Date {
			return x.Format("2006-01-02")
		}
		// Already wall-clock time in the zone the query asked for.
		return x.Format("2006-01-02T15:04:05")
	case []byte:
		s := string(x)
		switch t {
		case datasource.Integer:
			if n, err := strconv.ParseInt(s, 10, 64); err == nil {
				return n
			}
		case datasource.Float:
			if f, err := strconv.ParseFloat(s, 64); err == nil {
				return finite(f)
			}
		}
		return s
	case string:
		return x
	}
	return fmt.Sprint(v)
}

// JSON has no NaN or Infinity.
func finite(f float64) any {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return nil
	}
	return f
}

// A syntax error ends by quoting the statement from the offending word on,
// cut short when that is long, and naming the line the word is on.
var nearPattern = regexp.MustCompile(`(?s) near '(.*)' at line (\d+)$`)

// The analytical engines name the line and how many characters into it the
// offending word starts, counted from 0: StarRocks as "at line 2, column 14",
// Doris as "(line 2, pos 14)".
var columnPattern = regexp.MustCompile(`line (\d+), (?:column|pos) (\d+)`)

// lineStart returns where the n-th line of a statement starts, counting
// lines from 1, or -1 when it has fewer lines.
func lineStart(sent string, n int) int {
	start := 0
	for ; n > 1; n-- {
		newline := strings.IndexByte(sent[start:], '\n')
		if newline < 0 {
			return -1
		}
		start += newline + 1
	}
	return start
}

// locate works out the position of a syntax error in the statement that was
// sent. The server gives no position for other errors.
func locate(err error, sent string) error {
	var queryErr *datasource.QueryError
	if !errors.As(err, &queryErr) {
		return err
	}
	m := nearPattern.FindStringSubmatch(queryErr.Message)
	if m == nil {
		if m = columnPattern.FindStringSubmatch(queryErr.Message); m != nil {
			line, _ := strconv.Atoi(m[1])
			column, _ := strconv.Atoi(m[2])
			// The column counts characters; a position counts bytes.
			if at := lineStart(sent, line); at >= 0 {
				for ; column > 0 && at < len(sent) && sent[at] != '\n'; column-- {
					_, size := utf8.DecodeRuneInString(sent[at:])
					at += size
				}
				if column == 0 {
					queryErr.Position = at + 1
				}
			}
		}
		return err
	}
	near := m[1]
	if strings.HasSuffix(sent, near) {
		queryErr.Position = len(sent) - len(near) + 1
		return err
	}
	// Cut short: look for it from the start of the line the server named.
	line, _ := strconv.Atoi(m[2])
	start := lineStart(sent, line)
	if start < 0 {
		return err
	}
	if at := strings.Index(sent[start:], near); at >= 0 {
		queryErr.Position = start + at + 1
	}
	return err
}

// classify separates errors the server reported about the statement from
// failures to reach it.
func classify(err error) error {
	var mysqlErr *driver.MySQLError
	if errors.As(err, &mysqlErr) {
		// Access and connection problems are reported with error numbers too,
		// but they are about reaching the database, not about the statement.
		switch mysqlErr.Number {
		case 1040, 1044, 1045, 1049, 1129, 1130:
			return err
		}
		return &datasource.QueryError{Message: mysqlErr.Message}
	}
	return err
}
