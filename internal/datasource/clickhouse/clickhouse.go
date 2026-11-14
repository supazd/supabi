// Package clickhouse is the ClickHouse data source driver.
package clickhouse

import (
	"context"
	"crypto/tls"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"net"
	"regexp"
	"strconv"
	"strings"
	"time"

	driver "github.com/ClickHouse/clickhouse-go/v2"

	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/dialect"
)

func init() { datasource.Register(clickhouseDriver{}) }

type clickhouseDriver struct{}

func (clickhouseDriver) Name() string { return "clickhouse" }

func (clickhouseDriver) Category() datasource.Category { return datasource.OLAP }

func (clickhouseDriver) Dialect() dialect.Dialect { return dialect.ClickHouse{} }

func (clickhouseDriver) Settings() []datasource.SettingField {
	return []datasource.SettingField{
		{Name: "host", Required: true},
		{Name: "port", Default: "9000"},
		{Name: "database", Default: "default", Inside: true},
		{Name: "user", Default: "default"},
		{Name: "secure", Default: "false", Options: []string{"false", "true"}},
	}
}

func (clickhouseDriver) Open(_ context.Context, cfg datasource.Config) (datasource.Conn, error) {
	s := cfg.Settings
	if s["host"] == "" {
		return nil, fmt.Errorf("clickhouse: host is required")
	}
	port := s["port"]
	if port == "" {
		port = "9000"
	}
	zone := cfg.DataTimezone
	if zone == "" {
		zone = "UTC"
	}
	loc, err := time.LoadLocation(zone)
	if err != nil {
		return nil, fmt.Errorf("clickhouse: invalid data time zone %q", zone)
	}
	options := &driver.Options{
		Addr: []string{net.JoinHostPort(s["host"], port)},
		Auth: driver.Auth{Database: s["database"], Username: s["user"], Password: cfg.Password},
		Settings: driver.Settings{
			// Text without a zone, such as a literal in a dataset's SQL, is read in the data time zone.
			"session_timezone": zone,
			// 2: reading only, but settings such as the one above may still be set.
			// A second line of defence behind the read-only database account.
			"readonly": 2,
		},
		DialTimeout: 10 * time.Second,
	}
	if s["secure"] == "true" {
		options.TLS = &tls.Config{ServerName: s["host"], MinVersion: tls.VersionTLS12}
	}
	db := driver.OpenDB(options)
	datasource.SizePool(db, cfg)
	return &conn{db: db, loc: loc}, nil
}

type conn struct {
	db *sql.DB
	// loc is the data time zone, which is also the session's.
	loc *time.Location
}

// inSessionZone restates time arguments in the session's zone. The client
// library writes a time in UTC as text without a zone, which the server would
// then read in the session's zone, moving the instant.
func (c *conn) inSessionZone(args []any) []any {
	out := make([]any, len(args))
	for i, arg := range args {
		if t, ok := arg.(time.Time); ok {
			arg = t.In(c.loc)
		}
		out[i] = arg
	}
	return out
}

func (*conn) Dialect() dialect.Dialect { return dialect.ClickHouse{} }

func (c *conn) Close() { _ = c.db.Close() }

func (c *conn) Ping(ctx context.Context) error { return classify(c.db.PingContext(ctx)) }

func (c *conn) Query(ctx context.Context, query string, args []any) (*datasource.Result, error) {
	return datasource.Collect(ctx, c, query, args)
}

func (c *conn) Stream(ctx context.Context, query string, args []any, out datasource.RowWriter) error {
	rows, err := c.db.QueryContext(ctx, query, c.inSessionZone(args)...)
	if err != nil {
		return locate(classify(err), query, args)
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
	rows, err := c.db.QueryContext(ctx, probe, c.inSessionZone(args)...)
	if err != nil {
		return nil, datasource.Inner(locate(classify(err), probe, args), len(probePrefix))
	}
	defer rows.Close()
	return columnsOf(rows)
}

const probePrefix = "SELECT * FROM ("

// Tables in the session's own database are listed without it, since that is
// how statements name them, and come first. Where a table is has one level,
// the database.
func (c *conn) Tables(ctx context.Context) ([]datasource.Table, error) {
	rows, err := c.db.QueryContext(ctx, `
		SELECT c.database, if(c.database = currentDatabase(), '', c.database) AS db, c.table, c.name, c.type, t.comment, c.comment
		FROM system.columns AS c
		LEFT JOIN system.tables AS t ON t.database = c.database AND t.name = c.table
		WHERE c.database NOT IN ('system', 'information_schema', 'INFORMATION_SCHEMA')
		ORDER BY db, c.table, c.position
		LIMIT `+strconv.Itoa(datasource.MaxCatalogColumns))
	if err != nil {
		return nil, classify(err)
	}
	defer rows.Close()
	var list []datasource.CatalogRow
	for rows.Next() {
		var r datasource.CatalogRow
		if err := rows.Scan(&r.Namespace, &r.Schema, &r.Table, &r.Column, &r.DBType, &r.TableComment, &r.Comment); err != nil {
			return nil, err
		}
		list = append(list, r)
	}
	return datasource.GroupTables(list), classify(rows.Err())
}

func columnsOf(rows *sql.Rows) ([]datasource.Column, error) {
	types, err := rows.ColumnTypes()
	if err != nil {
		return nil, err
	}
	columns := make([]datasource.Column, len(types))
	for i, t := range types {
		columns[i] = datasource.Column{Name: t.Name(), Type: logicalType(t.DatabaseTypeName()), DBType: t.DatabaseTypeName()}
	}
	return columns, nil
}

var wrapper = regexp.MustCompile(`^(Nullable|LowCardinality)\((.*)\)$`)

// logicalType reads a ClickHouse type name such as Nullable(Decimal(18, 2)).
func logicalType(dbType string) datasource.Type {
	for {
		m := wrapper.FindStringSubmatch(dbType)
		if m == nil {
			break
		}
		dbType = m[2]
	}
	base, _, _ := strings.Cut(dbType, "(")
	switch {
	case strings.HasPrefix(base, "Int"), strings.HasPrefix(base, "UInt"):
		return datasource.Integer
	case strings.HasPrefix(base, "Decimal"):
		return datasource.Decimal
	case strings.HasPrefix(base, "Float"):
		return datasource.Float
	case base == "Bool":
		return datasource.Boolean
	case base == "Date", base == "Date32":
		return datasource.Date
	case base == "DateTime", base == "DateTime64":
		return datasource.Timestamp
	}
	return datasource.String
}

// normalize converts a driver value into the small set of types Result promises.
func normalize(v any, t datasource.Type) any {
	switch x := v.(type) {
	case nil:
		return nil
	case bool, string, int64:
		return x
	case int8:
		return int64(x)
	case int16:
		return int64(x)
	case int32:
		return int64(x)
	case uint8:
		return int64(x)
	case uint16:
		return int64(x)
	case uint32:
		return int64(x)
	case uint64:
		if x > math.MaxInt64 {
			return fmt.Sprint(x)
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
		// Truncated and localised values are labelled UTC and hold wall-clock time.
		return x.Format("2006-01-02T15:04:05")
	case fmt.Stringer:
		// Decimals and big integers: their text keeps every digit.
		return x.String()
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

var positionPattern = regexp.MustCompile(`failed at position (\d+)`)

// locate reads the position out of a syntax error. The server gives none for
// other errors.
func locate(err error, sent string, args []any) error {
	var queryErr *datasource.QueryError
	if !errors.As(err, &queryErr) {
		return err
	}
	m := positionPattern.FindStringSubmatch(queryErr.Message)
	if m == nil {
		return err
	}
	position, _ := strconv.Atoi(m[1])
	// The client library writes arguments into the statement, so beyond the
	// first one the server is counting in a text that is not ours.
	if first := strings.IndexByte(sent, '?'); len(args) > 0 && first >= 0 && position > first {
		return err
	}
	queryErr.Position = position
	return err
}

// classify separates errors the server reported about the statement from
// failures to reach it.
func classify(err error) error {
	var exception *driver.Exception
	if errors.As(err, &exception) {
		switch exception.Code {
		case 516, 192, 193, 194, 81: // authentication failed, unknown user, wrong password, required password, unknown database
			return err
		}
		return &datasource.QueryError{Message: firstLine(exception.Message)}
	}
	return err
}

// ClickHouse appends a stack trace to its messages.
func firstLine(message string) string {
	if i := strings.Index(message, "Stack trace:"); i >= 0 {
		message = message[:i]
	}
	return strings.TrimSpace(message)
}
