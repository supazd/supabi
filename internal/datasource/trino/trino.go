// Package trino is the Trino data source driver.
package trino

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	driver "github.com/trinodb/trino-go-client/trino"

	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/dialect"
	"github.com/supazd/supabi/internal/sqlrefs"
)

func init() { datasource.Register(trinoDriver{}) }

// minVersion is the oldest Trino the driver is known to work with.
const minVersion = 418

type trinoDriver struct{}

func (trinoDriver) Name() string { return "trino" }

func (trinoDriver) Category() datasource.Category { return datasource.OLAP }

func (trinoDriver) Dialect() dialect.Dialect { return dialect.Trino{} }

func (trinoDriver) Settings() []datasource.SettingField {
	return []datasource.SettingField{
		{Name: "host", Required: true},
		{Name: "port", Default: "8080"},
		{Name: "user", Required: true},
		{Name: "secure", Default: "false", Options: []string{"false", "true"}},
		{Name: "catalog"},
		{Name: "schema"},
	}
}

func (trinoDriver) Open(_ context.Context, cfg datasource.Config) (datasource.Conn, error) {
	s := cfg.Settings
	if s["host"] == "" || s["user"] == "" {
		return nil, fmt.Errorf("trino: host and user are required")
	}
	if s["schema"] != "" && s["catalog"] == "" {
		return nil, fmt.Errorf("trino: a schema needs a catalog")
	}
	scheme := "http"
	if s["secure"] == "true" {
		scheme = "https"
	} else if cfg.Password != "" {
		return nil, fmt.Errorf("trino: a password is only sent over an encrypted connection; turn it on")
	}
	port := s["port"]
	if port == "" {
		port = "8080"
	}
	if n, err := strconv.Atoi(port); err != nil || n < 1 || n > 65535 {
		return nil, fmt.Errorf("trino: the port must be a number from 1 to 65535")
	}
	zone := cfg.DataTimezone
	if zone == "" {
		zone = "UTC"
	}
	loc, err := time.LoadLocation(zone)
	if err != nil {
		return nil, fmt.Errorf("trino: invalid data time zone %q", zone)
	}
	user := url.User(s["user"])
	if cfg.Password != "" {
		user = url.UserPassword(s["user"], cfg.Password)
	}
	server := url.URL{Scheme: scheme, User: user, Host: net.JoinHostPort(s["host"], port)}
	connector, err := driver.NewConnector(&driver.Config{
		ServerURI: server.String(),
		// Names the queries in the coordinator's list.
		Source:  "supabi",
		Catalog: s["catalog"],
		Schema:  s["schema"],
		// The dialect's time functions depend on this; see dialect.Trino.
		TimeZone: zone,
	})
	if err != nil {
		// Not the driver's own error: it quotes the address it could not
		// read, and the password is part of that address.
		return nil, fmt.Errorf("trino: invalid connection settings")
	}
	db := sql.OpenDB(connector)
	db.SetMaxOpenConns(10)
	db.SetConnMaxLifetime(30 * time.Minute)
	return &conn{db: db, loc: loc, catalog: s["catalog"], schema: s["schema"]}, nil
}

type conn struct {
	db *sql.DB
	// loc is the data time zone, which is also the session's.
	loc *time.Location
	// catalog and schema are where names without them are looked up.
	catalog, schema string
}

func (*conn) Dialect() dialect.Dialect { return dialect.Trino{} }

func (c *conn) Close() { _ = c.db.Close() }

// Ping also checks the server's version, which is how an author learns of a
// server too old for the SQL written for it. Queries are not stopped.
func (c *conn) Ping(ctx context.Context) error {
	sqlConn, err := c.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer sqlConn.Close()
	var info driver.ServerInfo
	err = sqlConn.Raw(func(dc any) error {
		info, err = dc.(*driver.Conn).ServerInfo(ctx)
		return err
	})
	if err != nil {
		return err
	}
	if version, ok := majorVersion(info.NodeVersion); ok && version < minVersion {
		return &datasource.ConnectError{
			Code:    "trino_version",
			Params:  map[string]string{"version": info.NodeVersion, "required": strconv.Itoa(minVersion)},
			Message: fmt.Sprintf("SupaBI needs Trino %d or later; this server is %s", minVersion, info.NodeVersion),
		}
	}
	// The version is there without signing in; a statement is not.
	var one int
	return classify(sqlConn.QueryRowContext(ctx, "SELECT 1").Scan(&one), "SELECT 1", nil)
}

// majorVersion reads what a server says it is: 483 for Trino, and 413-e.12
// for a Starburst release built on Trino 413.
func majorVersion(version string) (int, bool) {
	end := strings.IndexFunc(version, func(r rune) bool { return r < '0' || r > '9' })
	if end < 0 {
		end = len(version)
	}
	n, err := strconv.Atoi(version[:end])
	return n, err == nil
}

func (c *conn) Query(ctx context.Context, query string, args []any) (*datasource.Result, error) {
	return datasource.Collect(ctx, c, query, args)
}

func (c *conn) Stream(ctx context.Context, query string, args []any, out datasource.RowWriter) error {
	sent, written, err := bind(query, args)
	if err != nil {
		return err
	}
	rows, err := c.db.QueryContext(ctx, sent)
	if err != nil {
		return classify(err, sent, written)
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
			values[i] = c.normalize(v, columns[i])
		}
		if err := out.WriteRow(values); err != nil {
			return err
		}
	}
	return classify(rows.Err(), sent, written)
}

func (c *conn) Describe(ctx context.Context, query string, args []any) ([]datasource.Column, error) {
	probe := probePrefix + query + ") AS supabi_probe LIMIT 0"
	sent, written, err := bind(probe, args)
	if err != nil {
		return nil, err
	}
	rows, err := c.db.QueryContext(ctx, sent)
	if err != nil {
		return nil, datasource.Inner(classify(err, sent, written), len(probePrefix))
	}
	defer rows.Close()
	columns, err := columnsOf(rows)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
	}
	return columns, datasource.Inner(classify(rows.Err(), sent, written), len(probePrefix))
}

const probePrefix = "SELECT * FROM ("

// literal is an argument written into a statement in place of its marker.
type literal struct {
	at   int // where the marker was, in bytes
	size int // how long the value written is
}

// bind writes the arguments into the statement as literals, the way the
// client library writes them after EXECUTE ... USING. Sending the statement
// with the arguments separately would have Trino report the positions of
// mistakes wrongly, and fail to explain it.
func bind(query string, args []any) (string, []literal, error) {
	if len(args) == 0 {
		return query, nil, nil
	}
	markers := sqlrefs.Placeholders(query, dialect.Trino{}.Lexis())
	if len(markers) != len(args) {
		return "", nil, fmt.Errorf("trino: the statement has %d argument markers for %d arguments", len(markers), len(args))
	}
	var b strings.Builder
	written := make([]literal, len(args))
	from := 0
	for i, at := range markers {
		value, err := driver.Serial(args[i])
		if err != nil {
			return "", nil, fmt.Errorf("trino: argument %d: %w", i+1, err)
		}
		b.WriteString(query[from:at])
		written[i] = literal{at: b.Len(), size: len(value)}
		b.WriteString(value)
		from = at + 1
	}
	b.WriteString(query[from:])
	return b.String(), written, nil
}

// unbind finds a position in the statement that was sent in the one that was
// given. A position inside a literal is where its marker was.
func unbind(position int, written []literal) int {
	shift := 0
	for _, w := range written {
		if position <= w.at {
			break
		}
		if position <= w.at+w.size {
			return w.at - shift + 1
		}
		shift += w.size - 1
	}
	return position - shift
}

// Tables lists every catalog the account can see but the system's own, the
// default catalog first. Each is asked for on its own, so that one whose
// source cannot be reached, or that the account may not read, is left out
// rather than keeping the others from being listed.
func (c *conn) Tables(ctx context.Context) ([]datasource.Table, error) {
	catalogs, err := c.catalogs(ctx)
	if err != nil {
		return nil, err
	}
	var tables []datasource.Table
	columns := 0
	for _, catalog := range catalogs {
		if columns >= datasource.MaxCatalogColumns {
			break
		}
		found, n, err := c.catalogTables(ctx, catalog, datasource.MaxCatalogColumns-columns)
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			continue
		}
		tables = append(tables, found...)
		columns += n
	}
	return tables, nil
}

func (c *conn) catalogs(ctx context.Context) ([]string, error) {
	rows, err := c.db.QueryContext(ctx, "SHOW CATALOGS")
	if err != nil {
		return nil, classify(err, "SHOW CATALOGS", nil)
	}
	defer rows.Close()
	var catalogs []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		if name != "system" {
			catalogs = append(catalogs, name)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, classify(err, "SHOW CATALOGS", nil)
	}
	slices.SortStableFunc(catalogs, func(a, b string) int {
		switch {
		case a == c.catalog:
			return -1
		case b == c.catalog:
			return 1
		}
		return strings.Compare(a, b)
	})
	return catalogs, nil
}

// catalogTables lists up to limit columns of the tables in a catalog. Tables
// are named as statements would name them: without the catalog in the
// default one, and without the schema too in the default schema.
func (c *conn) catalogTables(ctx context.Context, catalog string, limit int) ([]datasource.Table, int, error) {
	query, args := `
		SELECT table_schem, table_name, column_name, type_name, COALESCE(remarks, '') FROM system.jdbc.columns
		WHERE table_cat = ? AND table_schem <> 'information_schema'
		ORDER BY table_schem, table_name, ordinal_position
		LIMIT `+strconv.Itoa(limit), []any{catalog}
	sent, written, err := bind(query, args)
	if err != nil {
		return nil, 0, err
	}
	rows, err := c.db.QueryContext(ctx, sent)
	if err != nil {
		return nil, 0, classify(err, sent, written)
	}
	defer rows.Close()
	var list []datasource.CatalogRow
	for rows.Next() {
		r := datasource.CatalogRow{Catalog: catalog}
		if err := rows.Scan(&r.Namespace, &r.Table, &r.Column, &r.DBType, &r.Comment); err != nil {
			return nil, 0, err
		}
		if catalog != c.catalog || r.Namespace != c.schema {
			r.Schema = r.Namespace
		}
		list = append(list, r)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, classify(err, sent, written)
	}
	tables := datasource.GroupTables(list)
	for i := range tables {
		if catalog != c.catalog {
			tables[i].Catalog = catalog
		}
	}
	c.tableComments(ctx, catalog, tables)
	return tables, len(list), nil
}

// tableComments fills in what was written about each table. The tables are
// worth listing without it, so a catalog that will not say is not an error.
func (c *conn) tableComments(ctx context.Context, catalog string, tables []datasource.Table) {
	sent, _, err := bind(`
		SELECT schema_name, table_name, comment FROM system.metadata.table_comments
		WHERE catalog_name = ? AND comment IS NOT NULL AND comment <> ''`, []any{catalog})
	if err != nil {
		return
	}
	rows, err := c.db.QueryContext(ctx, sent)
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
		tables[i].Comment = comments[[2]string{t.Path[len(t.Path)-1], t.Name}]
	}
}

func columnsOf(rows *sql.Rows) ([]datasource.Column, error) {
	types, err := rows.ColumnTypes()
	if err != nil {
		return nil, err
	}
	columns := make([]datasource.Column, len(types))
	for i, t := range types {
		dbType := strings.ToLower(t.DatabaseTypeName())
		columns[i] = datasource.Column{Name: t.Name(), Type: logicalType(dbType), DBType: dbType}
	}
	return columns, nil
}

// logicalType reads a Trino type name without its parameters, such as
// decimal or timestamp with time zone.
func logicalType(dbType string) datasource.Type {
	switch {
	case dbType == "tinyint", dbType == "smallint", dbType == "integer", dbType == "bigint":
		return datasource.Integer
	case dbType == "decimal", dbType == "number":
		return datasource.Decimal
	case dbType == "real", dbType == "double":
		return datasource.Float
	case dbType == "boolean":
		return datasource.Boolean
	case dbType == "date":
		return datasource.Date
	case strings.HasPrefix(dbType, "timestamp"):
		return datasource.Timestamp
	}
	return datasource.String
}

// normalize converts a driver value into the small set of types Result promises.
func (c *conn) normalize(v any, column datasource.Column) any {
	switch x := v.(type) {
	case nil:
		return nil
	case bool, int64, string:
		// Decimals come as text, which keeps every digit.
		return x
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) {
			return nil // JSON has no NaN or Infinity
		}
		return x
	case time.Time:
		if column.Type == datasource.Date {
			return x.Format("2006-01-02")
		}
		if column.Type == datasource.Timestamp {
			// A time without a zone is read in the session's zone, which is
			// the data time zone; one with a zone is shown in that zone too.
			return x.In(c.loc).Format("2006-01-02T15:04:05")
		}
		return x.Format("15:04:05.999999999")
	case []byte:
		return string(x)
	}
	// Arrays, maps and rows.
	if b, err := json.Marshal(v); err == nil {
		return string(b)
	}
	return fmt.Sprint(v)
}

// A message starts by naming where the mistake is, which the position says
// in terms of the statement given rather than the one sent.
var locationPrefix = regexp.MustCompile(`^line \d+:\d+: `)

// classify separates errors the server reported about the statement from
// failures to reach it, and works out where in the statement the server
// found the mistake.
func classify(err error, sent string, written []literal) error {
	var trinoErr *driver.ErrTrino
	if !errors.As(err, &trinoErr) {
		return err
	}
	queryErr := &datasource.QueryError{Message: locationPrefix.ReplaceAllString(trinoErr.Message, "")}
	if at := position(sent, trinoErr.ErrorLocation.LineNumber, trinoErr.ErrorLocation.ColumnNumber); at > 0 {
		queryErr.Position = unbind(at, written)
	}
	return queryErr
}

// position turns a line and a column, both counted from 1 and the column in
// characters, into a byte offset counted from 1, or 0 when there is none.
func position(sent string, line, column int) int {
	if line < 1 || column < 1 {
		return 0
	}
	at := 0
	for ; line > 1; line-- {
		newline := strings.IndexByte(sent[at:], '\n')
		if newline < 0 {
			return 0
		}
		at += newline + 1
	}
	for ; column > 1; column-- {
		if at >= len(sent) || sent[at] == '\n' {
			return 0
		}
		_, size := utf8.DecodeRuneInString(sent[at:])
		at += size
	}
	return at + 1
}
