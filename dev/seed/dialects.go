package main

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

type kind int

const (
	integer   kind = iota // 32 bits
	bigint                // 64 bits
	text                  // up to size characters
	timestamp             // Shanghai wall-clock time, to the minute
	date
	money // yuan to the cent, size digits in all; the values are cents
)

type column struct {
	name, comment string
	kind          kind
	size          int
	null          bool
}

type table struct {
	name, comment string
	columns       []column
	key           []string // the primary key; the duplicate key of StarRocks and Doris
	sortKey       []string // ClickHouse's ORDER BY, when not the key
	index         string   // a column with an index of its own, in PostgreSQL and MySQL
	rows          [][]any
}

// A dialect writes the sample data into one kind of database, in the
// database demo, or the schema demo in PostgreSQL.
type dialect struct {
	// setup drops what an earlier load left and creates the database and the
	// read-only user; grant runs after the tables are loaded.
	setup, grant []string
	create       func(t table) []string
	// backslashes is whether a backslash in a string literal escapes.
	backslashes bool
	// epochTimes writes timestamps as seconds since 1970, for ClickHouse,
	// whose DateTime is a point in time: a string would be read in the
	// server's time zone.
	epochTimes bool
	// totals selects, as text, the orders' count, sums of amount and cost,
	// and last time to the minute, for checking the load.
	totals string
}

var postgres = dialect{
	setup: []string{
		"BEGIN",
		"DROP SCHEMA IF EXISTS demo CASCADE",
		"CREATE SCHEMA demo",
		`DO $$ BEGIN
			IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'supabi_demo') THEN
				CREATE ROLE supabi_demo LOGIN PASSWORD 'demo';
			END IF;
		END $$`,
	},
	grant: []string{
		"GRANT USAGE ON SCHEMA demo TO supabi_demo",
		"GRANT SELECT ON ALL TABLES IN SCHEMA demo TO supabi_demo",
		"COMMIT",
	},
	create: func(t table) []string {
		var cols []string
		for _, c := range t.columns {
			cols = append(cols, c.name+" "+postgresType(c)+notNull(c))
		}
		cols = append(cols, "PRIMARY KEY ("+strings.Join(t.key, ", ")+")")
		stmts := []string{
			fmt.Sprintf("CREATE TABLE demo.%s (\n  %s\n)", t.name, strings.Join(cols, ",\n  ")),
			fmt.Sprintf("COMMENT ON TABLE demo.%s IS %s", t.name, quote(t.comment, false)),
		}
		for _, c := range t.columns {
			stmts = append(stmts, fmt.Sprintf("COMMENT ON COLUMN demo.%s.%s IS %s", t.name, c.name, quote(c.comment, false)))
		}
		if t.index != "" {
			stmts = append(stmts, fmt.Sprintf("CREATE INDEX %[1]s_%[2]s_idx ON demo.%[1]s (%[2]s)", t.name, t.index))
		}
		return stmts
	},
	totals: "SELECT count(*), sum(amount)::text, sum(cost)::text, to_char(max(created_at), 'YYYY-MM-DD HH24:MI') FROM demo.orders",
}

func postgresType(c column) string {
	return [...]string{integer: "int", bigint: "bigint", text: "text", timestamp: "timestamp", date: "date", money: fmt.Sprintf("numeric(%d, 2)", c.size)}[c.kind]
}

var mysql = dialect{
	setup: []string{
		"DROP DATABASE IF EXISTS demo",
		"CREATE DATABASE demo CHARACTER SET utf8mb4",
		"CREATE USER IF NOT EXISTS 'supabi_demo'@'%' IDENTIFIED BY 'demo'",
	},
	grant: []string{"GRANT SELECT ON demo.* TO 'supabi_demo'@'%'"},
	create: func(t table) []string {
		var cols []string
		for _, c := range t.columns {
			cols = append(cols, c.name+" "+mysqlType(c, 1)+notNull(c)+" COMMENT "+quote(c.comment, true))
		}
		cols = append(cols, "PRIMARY KEY ("+strings.Join(t.key, ", ")+")")
		if t.index != "" {
			cols = append(cols, fmt.Sprintf("KEY %s_%s_idx (%[2]s)", t.name, t.index))
		}
		return []string{fmt.Sprintf("CREATE TABLE demo.%s (\n  %s\n) COMMENT %s", t.name, strings.Join(cols, ",\n  "), quote(t.comment, true))}
	},
	backslashes: true,
	totals:      "SELECT COUNT(*), CAST(SUM(amount) AS CHAR), CAST(SUM(cost) AS CHAR), DATE_FORMAT(MAX(created_at), '%Y-%m-%d %H:%i') FROM demo.orders",
}

// mysqlType is a column's type in MySQL, StarRocks and Doris. The last two
// measure a varchar in bytes, which bytesPerChar converts to.
func mysqlType(c column, bytesPerChar int) string {
	switch c.kind {
	case text:
		return fmt.Sprintf("varchar(%d)", c.size*bytesPerChar)
	case money:
		return fmt.Sprintf("decimal(%d, 2)", c.size)
	}
	return [...]string{integer: "int", bigint: "bigint", timestamp: "datetime", date: "date"}[c.kind]
}

// olap is StarRocks or Doris: tables with a duplicate key, in one bucket
// with one replica, as their single-node containers need.
func olap(grant string) dialect {
	return dialect{
		setup: []string{
			"DROP DATABASE IF EXISTS demo",
			"CREATE DATABASE demo",
			"CREATE USER IF NOT EXISTS 'supabi_demo'@'%' IDENTIFIED BY 'demo'",
		},
		grant: []string{grant},
		create: func(t table) []string {
			var cols []string
			for _, c := range t.columns {
				cols = append(cols, c.name+" "+mysqlType(c, 4)+notNull(c)+" COMMENT "+quote(c.comment, true))
			}
			return []string{fmt.Sprintf("CREATE TABLE demo.%s (\n  %s\n) DUPLICATE KEY (%s) COMMENT %s DISTRIBUTED BY HASH (%s) BUCKETS 1 PROPERTIES (\"replication_num\" = \"1\")",
				t.name, strings.Join(cols, ",\n  "), strings.Join(t.key, ", "), quote(t.comment, true), t.key[0])}
		},
		backslashes: true,
		totals:      "SELECT count(*), CAST(sum(amount) AS VARCHAR), CAST(sum(cost) AS VARCHAR), date_format(max(created_at), '%Y-%m-%d %H:%i') FROM demo.orders",
	}
}

var (
	starrocks = olap("GRANT SELECT ON ALL TABLES IN DATABASE demo TO USER 'supabi_demo'@'%'")
	doris     = olap("GRANT SELECT_PRIV ON internal.demo.* TO 'supabi_demo'@'%'")
)

var clickhouse = dialect{
	setup: []string{
		"DROP DATABASE IF EXISTS demo",
		"CREATE DATABASE demo",
		"CREATE USER IF NOT EXISTS supabi_demo IDENTIFIED BY 'demo'",
	},
	grant: []string{"GRANT SELECT ON demo.* TO supabi_demo"},
	create: func(t table) []string {
		var cols []string
		for _, c := range t.columns {
			cols = append(cols, c.name+" "+clickhouseType(c)+" COMMENT "+quote(c.comment, true))
		}
		order := t.sortKey
		if order == nil {
			order = t.key
		}
		return []string{fmt.Sprintf("CREATE TABLE demo.%s (\n  %s\n) ENGINE = MergeTree ORDER BY (%s) COMMENT %s",
			t.name, strings.Join(cols, ",\n  "), strings.Join(order, ", "), quote(t.comment, true))}
	},
	backslashes: true,
	epochTimes:  true,
	totals:      "SELECT count(), toString(sum(amount)), toString(sum(cost)), formatDateTime(max(created_at), '%Y-%m-%d %H:%i', 'Asia/Shanghai') FROM demo.orders",
}

func clickhouseType(c column) string {
	t := [...]string{integer: "Int32", bigint: "Int64", text: "String", timestamp: "DateTime", date: "Date", money: fmt.Sprintf("Decimal(%d, 2)", c.size)}[c.kind]
	if c.null {
		return "Nullable(" + t + ")"
	}
	return t
}

func notNull(c column) string {
	if c.null {
		return ""
	}
	return " NOT NULL"
}

// inserts writes a table's rows as INSERT statements of a few thousand rows
// each: StarRocks and Doris make each statement a load of its own.
func (d dialect) inserts(t table) []string {
	names := make([]string, len(t.columns))
	for i, c := range t.columns {
		names[i] = c.name
	}
	var stmts []string
	for start := 0; start < len(t.rows); start += 5000 {
		var b strings.Builder
		fmt.Fprintf(&b, "INSERT INTO demo.%s (%s) VALUES", t.name, strings.Join(names, ", "))
		for i, row := range t.rows[start:min(start+5000, len(t.rows))] {
			if i > 0 {
				b.WriteByte(',')
			}
			b.WriteString("\n(")
			for j, v := range row {
				if j > 0 {
					b.WriteString(", ")
				}
				b.WriteString(d.literal(t.columns[j], v))
			}
			b.WriteByte(')')
		}
		stmts = append(stmts, b.String())
	}
	return stmts
}

func (d dialect) literal(c column, v any) string {
	if v == nil {
		return "NULL"
	}
	switch c.kind {
	case text:
		return quote(v.(string), d.backslashes)
	case timestamp:
		t := v.(time.Time)
		if d.epochTimes {
			return strconv.FormatInt(t.Unix()-8*60*60, 10) // the wall clock is Shanghai's
		}
		return "'" + t.Format("2006-01-02 15:04:05") + "'"
	case date:
		return "'" + v.(time.Time).Format("2006-01-02") + "'"
	case money:
		return yuan(v.(int64))
	}
	return strconv.FormatInt(v.(int64), 10)
}

func quote(s string, backslashes bool) string {
	if backslashes {
		s = strings.ReplaceAll(s, `\`, `\\`)
	}
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}

// yuan writes cents as yuan with two decimals.
func yuan(cents int64) string {
	sign := ""
	if cents < 0 {
		sign, cents = "-", -cents
	}
	return fmt.Sprintf("%s%d.%02d", sign, cents/100, cents%100)
}
