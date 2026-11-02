// Package datasource connects to the databases users analyse. A database is
// supported by registering a Driver; nothing else in the system names a
// specific database.
package datasource

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sort"
	"sync"

	"github.com/supazd/supabi/internal/dialect"
)

// Type is the logical type every database type is mapped to. See
// .agents/design/dataset.md §5.1.
type Type string

const (
	String    Type = "string"
	Integer   Type = "integer"
	Decimal   Type = "decimal"
	Float     Type = "float"
	Boolean   Type = "boolean"
	Date      Type = "date"
	Timestamp Type = "timestamp"
)

func (t Type) Valid() bool {
	switch t {
	case String, Integer, Decimal, Float, Boolean, Date, Timestamp:
		return true
	}
	return false
}

func (t Type) Numeric() bool  { return t == Integer || t == Decimal || t == Float }
func (t Type) Temporal() bool { return t == Date || t == Timestamp }

// Column describes one column of a result.
type Column struct {
	Name string
	Type Type
	// DBType is the database's own type name, kept for display and debugging.
	DBType string
}

// Result holds rows whose values are already normalised for JSON:
// nil, bool, int64, float64, or string. Decimals are strings so they keep
// their precision; dates are "2006-01-02" and timestamps "2006-01-02T15:04:05".
type Result struct {
	Columns []Column
	Rows    [][]any
}

// Config is what a driver needs to connect.
type Config struct {
	// Settings are the non-secret, driver-specific connection settings.
	Settings map[string]string
	// Password is kept apart so it can be stored encrypted.
	Password string
	// DataTimezone is the IANA zone of timestamps stored without one.
	DataTimezone string
}

// SettingField describes one connection setting, so that a form for a new
// kind of database can be drawn without changing the frontend.
type SettingField struct {
	Name     string
	Required bool
	Default  string
	// Options lists the allowed values when the setting is a choice.
	Options []string
}

// Category is what a kind of database is built for. The kinds are grouped by
// it where one is chosen.
type Category string

const (
	// OLTP databases keep the records of an application, row by row.
	OLTP Category = "oltp"
	// OLAP databases are built to aggregate over many rows.
	OLAP Category = "olap"
)

// Driver opens connections to one kind of database.
type Driver interface {
	Name() string
	Category() Category
	Settings() []SettingField
	// Dialect is available without connecting, for validating definitions.
	Dialect() dialect.Dialect
	Open(ctx context.Context, cfg Config) (Conn, error)
}

// Builtin reports whether data sources of this type are created by the system
// rather than by users.
func Builtin(d Driver) bool {
	b, ok := d.(interface{ Builtin() bool })
	return ok && b.Builtin()
}

// QueryError is an error the database itself reported about a statement
// (bad SQL, unknown column, a write in a read-only session), as opposed to a
// failure to reach the database. Its message is safe to show to the author
// of the statement.
type QueryError struct {
	Message string
	// Position is where in the statement the database found the problem: a
	// byte offset counted from 1, or 0 when the database did not say.
	Position int
}

func (e *QueryError) Error() string { return e.Message }

// ConnectError is a failure to connect that the driver recognises and can
// explain, such as a server too old for the SQL the dialect writes. Code
// names it, with Params, for a client to say in the reader's language;
// Message says the same in English.
type ConnectError struct {
	Code    string
	Params  map[string]string
	Message string
}

func (e *ConnectError) Error() string { return e.Message }

// Inner restates the position of a QueryError about a statement that a driver
// built around the caller's own, which starts after prefix bytes. A position
// before the caller's statement is dropped.
func Inner(err error, prefix int) error {
	var queryErr *QueryError
	if errors.As(err, &queryErr) && queryErr.Position > 0 {
		queryErr.Position = max(queryErr.Position-prefix, 0)
	}
	return err
}

// Table is a table or view that statements can read from.
type Table struct {
	// Path is where the table is, outermost first: the catalog and the
	// schema, or the one level a database with two-part names has. Unlike
	// Schema it is given even when a statement need not write it, so that
	// tables can be shown as a tree. It is empty when there are no levels.
	Path []string
	// Catalog is empty when the table can be named without one, which is
	// always so but for a database that lists more than one.
	Catalog string
	// Schema is empty when the table can be named without one.
	Schema string
	Name   string
	// Comment is what the database's owners wrote about the table, if anything.
	Comment string
	Columns []TableColumn
}

type TableColumn struct {
	Name string
	// DBType is the database's own type name.
	DBType string
	// Comment is what the database's owners wrote about the column, if anything.
	Comment string
}

// MaxCatalogColumns is how many columns Tables reports at most. A warehouse
// can hold far more than an editor has any use for.
const MaxCatalogColumns = 5000

// CatalogRow is one column of one table, the form in which databases list
// what they hold.
type CatalogRow struct {
	// Catalog and Namespace become the table's Path; either may be empty.
	Catalog, Namespace            string
	Schema, Table, Column, DBType string
	// TableComment and Comment are what was written about the table and the column.
	TableComment, Comment string
}

// GroupTables assembles tables from their columns, which must arrive with
// the columns of a table next to each other.
func GroupTables(rows []CatalogRow) []Table {
	var tables []Table
	for _, r := range rows {
		path := make([]string, 0, 2)
		for _, level := range []string{r.Catalog, r.Namespace} {
			if level != "" {
				path = append(path, level)
			}
		}
		if n := len(tables); n == 0 || tables[n-1].Schema != r.Schema || tables[n-1].Name != r.Table || !slices.Equal(tables[n-1].Path, path) {
			tables = append(tables, Table{Path: path, Schema: r.Schema, Name: r.Table, Comment: r.TableComment})
		}
		last := &tables[len(tables)-1]
		last.Columns = append(last.Columns, TableColumn{Name: r.Column, DBType: r.DBType, Comment: r.Comment})
	}
	return tables
}

// Conn is an open, pooled connection to a user database. It is safe for
// concurrent use. Cancelling ctx must cancel the running statement.
type Conn interface {
	Dialect() dialect.Dialect
	Ping(ctx context.Context) error
	// Query runs a read-only statement.
	Query(ctx context.Context, sql string, args []any) (*Result, error)
	// Describe returns the columns a statement would produce without fetching rows.
	Describe(ctx context.Context, sql string, args []any) ([]Column, error)
	// Tables lists what a statement can read, to help an author write one.
	// It stops after MaxCatalogColumns columns.
	Tables(ctx context.Context) ([]Table, error)
	Close()
}

var (
	mu      sync.RWMutex
	drivers = map[string]Driver{}
)

// Register makes a driver available. Drivers call it from an init function.
func Register(d Driver) {
	mu.Lock()
	defer mu.Unlock()
	if _, dup := drivers[d.Name()]; dup {
		panic("datasource: driver registered twice: " + d.Name())
	}
	drivers[d.Name()] = d
}

// Open connects using the named driver.
func Open(ctx context.Context, driver string, cfg Config) (Conn, error) {
	mu.RLock()
	d, ok := drivers[driver]
	mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("unknown data source type %q", driver)
	}
	return d.Open(ctx, cfg)
}

// Drivers lists the registered drivers by name.
func Drivers() []Driver {
	mu.RLock()
	defer mu.RUnlock()
	list := make([]Driver, 0, len(drivers))
	for _, d := range drivers {
		list = append(list, d)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Name() < list[j].Name() })
	return list
}

// Lookup returns the named driver.
func Lookup(name string) (Driver, bool) {
	mu.RLock()
	defer mu.RUnlock()
	d, ok := drivers[name]
	return d, ok
}

// CheckSettings rejects unknown settings and missing required ones, and
// returns the settings with defaults filled in.
func CheckSettings(d Driver, settings map[string]string) (map[string]string, error) {
	out := map[string]string{}
	known := map[string]bool{}
	for _, f := range d.Settings() {
		known[f.Name] = true
		value := settings[f.Name]
		if value == "" {
			value = f.Default
		}
		if value == "" {
			if f.Required {
				return nil, fmt.Errorf("setting %q is required", f.Name)
			}
			continue
		}
		if len(f.Options) > 0 && !slices.Contains(f.Options, value) {
			return nil, fmt.Errorf("setting %q must be one of %v", f.Name, f.Options)
		}
		out[f.Name] = value
	}
	for name := range settings {
		if !known[name] {
			return nil, fmt.Errorf("unknown setting %q", name)
		}
	}
	return out, nil
}
