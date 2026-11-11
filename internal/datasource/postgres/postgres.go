// Package postgres is the PostgreSQL data source driver.
package postgres

import (
	"context"
	sqldriver "database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net"
	"net/url"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/dialect"
)

func init() { datasource.Register(driver{}) }

type driver struct{}

func (driver) Name() string { return "postgres" }

func (driver) Category() datasource.Category { return datasource.OLTP }

func (driver) Dialect() dialect.Dialect { return dialect.Postgres{} }

func (driver) Settings() []datasource.SettingField {
	return []datasource.SettingField{
		{Name: "host", Required: true},
		{Name: "port", Default: "5432"},
		{Name: "database", Required: true},
		{Name: "user", Required: true},
		{Name: "sslmode", Default: "prefer", Options: []string{"disable", "prefer", "require", "verify-ca", "verify-full"}},
	}
}

func (driver) Open(ctx context.Context, cfg datasource.Config) (datasource.Conn, error) {
	s := cfg.Settings
	if s["host"] == "" || s["database"] == "" || s["user"] == "" {
		return nil, fmt.Errorf("postgres: host, database and user are required")
	}
	port := s["port"]
	if port == "" {
		port = "5432"
	}
	zone := cfg.DataTimezone
	if zone == "" {
		zone = "UTC"
	}
	if _, err := time.LoadLocation(zone); err != nil {
		return nil, fmt.Errorf("postgres: invalid data time zone %q", zone)
	}
	query := url.Values{}
	if s["sslmode"] != "" {
		query.Set("sslmode", s["sslmode"])
	}
	u := url.URL{
		Scheme:   "postgres",
		User:     url.UserPassword(s["user"], cfg.Password),
		Host:     net.JoinHostPort(s["host"], port),
		Path:     "/" + s["database"],
		RawQuery: query.Encode(),
	}
	poolCfg, err := pgxpool.ParseConfig(u.String())
	if err != nil {
		return nil, fmt.Errorf("postgres: invalid connection settings")
	}
	// The dialect's time functions depend on this; see dialect.Postgres.
	poolCfg.ConnConfig.RuntimeParams["timezone"] = zone
	// A second line of defence behind the read-only database account.
	poolCfg.ConnConfig.RuntimeParams["default_transaction_read_only"] = "on"
	poolCfg.ConnConfig.RuntimeParams["application_name"] = "supabi"

	pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		return nil, err
	}
	return &conn{pool: pool}, nil
}

type conn struct {
	pool *pgxpool.Pool
}

func (*conn) Dialect() dialect.Dialect { return dialect.Postgres{} }

func (c *conn) Ping(ctx context.Context) error { return c.pool.Ping(ctx) }

func (c *conn) Close() { c.pool.Close() }

func (c *conn) Query(ctx context.Context, sql string, args []any) (*datasource.Result, error) {
	return datasource.Collect(ctx, c, sql, args)
}

func (c *conn) Stream(ctx context.Context, sql string, args []any, out datasource.RowWriter) error {
	rows, err := c.pool.Query(ctx, sql, args...)
	if err != nil {
		return classify(err, sql)
	}
	defer rows.Close()

	columns := c.columns(rows.FieldDescriptions())
	if err := out.Start(columns); err != nil {
		return err
	}
	for rows.Next() {
		values, err := rows.Values()
		if err != nil {
			return err
		}
		for i, v := range values {
			values[i] = normalize(v, columns[i].Type)
		}
		if err := out.WriteRow(values); err != nil {
			return err
		}
	}
	return classify(rows.Err(), sql)
}

// classify separates errors the database reported about the statement from
// failures to reach it.
func classify(err error, sql string) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return &datasource.QueryError{Message: pgErr.Message, Position: bytePosition(sql, int(pgErr.Position))}
	}
	return err
}

// bytePosition converts a position the server counted in characters.
func bytePosition(sql string, chars int) int {
	if chars < 1 {
		return 0
	}
	n := 1
	for i := range sql {
		if n == chars {
			return i + 1
		}
		n++
	}
	if n == chars {
		return len(sql) + 1 // just past the end: something is missing there
	}
	return 0
}

const probePrefix = "SELECT * FROM ("

func (c *conn) Describe(ctx context.Context, sql string, args []any) ([]datasource.Column, error) {
	probe := probePrefix + sql + ") AS supabi_probe LIMIT 0"
	rows, err := c.pool.Query(ctx, probe, args...)
	if err != nil {
		return nil, datasource.Inner(classify(err, probe), len(probePrefix))
	}
	defer rows.Close()
	for rows.Next() {
	}
	if err := rows.Err(); err != nil {
		return nil, datasource.Inner(classify(err, probe), len(probePrefix))
	}
	return c.columns(rows.FieldDescriptions()), nil
}

// Tables in the session's own schema are listed without it, since that is
// how statements name them. Where they are is the database and the schema.
const tablesSQL = `
SELECT current_database(), n.nspname, CASE WHEN n.nspname = current_schema() THEN '' ELSE n.nspname END, c.relname, a.attname, format_type(a.atttypid, a.atttypmod),
       COALESCE(obj_description(c.oid, 'pg_class'), ''), COALESCE(col_description(c.oid, a.attnum), '')
FROM pg_catalog.pg_attribute a
JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'v', 'm', 'p', 'f')
  AND a.attnum > 0 AND NOT a.attisdropped
  AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\_%'
  AND has_schema_privilege(n.oid, 'USAGE') AND has_table_privilege(c.oid, 'SELECT')
ORDER BY 3, 4, a.attnum
LIMIT $1`

func (c *conn) Tables(ctx context.Context) ([]datasource.Table, error) {
	rows, err := c.pool.Query(ctx, tablesSQL, datasource.MaxCatalogColumns)
	if err != nil {
		return nil, classify(err, tablesSQL)
	}
	defer rows.Close()
	var list []datasource.CatalogRow
	for rows.Next() {
		var r datasource.CatalogRow
		if err := rows.Scan(&r.Catalog, &r.Namespace, &r.Schema, &r.Table, &r.Column, &r.DBType, &r.TableComment, &r.Comment); err != nil {
			return nil, err
		}
		list = append(list, r)
	}
	return datasource.GroupTables(list), classify(rows.Err(), tablesSQL)
}

func (c *conn) columns(fields []pgconn.FieldDescription) []datasource.Column {
	typeMap := pgtype.NewMap()
	columns := make([]datasource.Column, len(fields))
	for i, f := range fields {
		dbType := fmt.Sprintf("oid %d", f.DataTypeOID)
		if t, ok := typeMap.TypeForOID(f.DataTypeOID); ok {
			dbType = t.Name
		}
		columns[i] = datasource.Column{Name: f.Name, Type: logicalType(f.DataTypeOID), DBType: dbType}
	}
	return columns
}

func logicalType(oid uint32) datasource.Type {
	switch oid {
	case pgtype.Int2OID, pgtype.Int4OID, pgtype.Int8OID:
		return datasource.Integer
	case pgtype.NumericOID:
		return datasource.Decimal
	case pgtype.Float4OID, pgtype.Float8OID:
		return datasource.Float
	case pgtype.BoolOID:
		return datasource.Boolean
	case pgtype.DateOID:
		return datasource.Date
	case pgtype.TimestampOID, pgtype.TimestamptzOID:
		return datasource.Timestamp
	default:
		// Text and everything without a closer match (uuid, json, arrays…).
		return datasource.String
	}
}

// normalize converts a pgx value into the small set of types Result promises.
func normalize(v any, t datasource.Type) any {
	switch x := v.(type) {
	case nil:
		return nil
	case bool, int64, string:
		return x
	case int16:
		return int64(x)
	case int32:
		return int64(x)
	case float32:
		return finite(float64(x))
	case float64:
		return finite(x)
	case pgtype.Numeric:
		if !x.Valid {
			return nil
		}
		if x.NaN || x.InfinityModifier != pgtype.Finite {
			return nil // as finite does for a float
		}
		if b, err := x.MarshalJSON(); err == nil {
			return string(b) // digits only: numeric marshals as a bare JSON number
		}
	case time.Time:
		if t == datasource.Date {
			return x.Format("2006-01-02")
		}
		// Timestamps reach here already as wall-clock time in the query zone.
		return x.Format("2006-01-02T15:04:05")
	case []byte:
		return string(x)
	case [16]byte:
		return uuidText(x)
	case pgtype.Time:
		if !x.Valid {
			return nil
		}
		// As psql shows it: fractions of a second only when there are any.
		clock := time.Duration(x.Microseconds) * time.Microsecond
		text := time.Time{}.Add(clock).Format("15:04:05.999999")
		if x.Microseconds == 24*3600*1e6 {
			text = "24:00:00"
		}
		return text
	case map[string]any, []any:
		// json and jsonb, and arrays: written as JSON, which tells the
		// elements apart where Go's own formatting would not.
		if b, err := json.Marshal(plain(x)); err == nil {
			return string(b)
		}
	case sqldriver.Valuer:
		// time, interval, ranges and the like: as PostgreSQL writes them.
		if text, err := x.Value(); err == nil {
			if text == nil {
				return nil
			}
			if s, ok := text.(string); ok {
				return s
			}
		}
	}
	return fmt.Sprint(v)
}

func uuidText(b [16]byte) string {
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// plain makes the elements of an array or a JSON value ones that marshal as
// they read: a uuid inside an array is still sixteen bytes.
func plain(v any) any {
	switch x := v.(type) {
	case []any:
		out := make([]any, len(x))
		for i, item := range x {
			out[i] = plain(item)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, item := range x {
			out[k] = plain(item)
		}
		return out
	case nil, bool, string, int64, json.Number:
		return x
	case float64:
		return finite(x)
	case float32:
		return finite(float64(x))
	case pgtype.Numeric:
		return normalize(x, datasource.Decimal)
	case time.Time:
		return x.Format(time.RFC3339Nano)
	}
	if _, isJSON := v.(json.Marshaler); isJSON {
		return v
	}
	return normalize(v, datasource.String)
}

// JSON has no NaN or Infinity.
func finite(f float64) any {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return nil
	}
	return f
}
