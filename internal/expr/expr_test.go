package expr

import (
	"strings"
	"testing"

	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/dialect"
)

var fields = map[string]FieldInfo{
	"amount":  {Key: "amount", Type: datasource.Decimal},
	"qty":     {Key: "qty", Type: datasource.Integer},
	"region":  {Key: "region", Type: datasource.String},
	"day":     {Key: "day", Type: datasource.Date},
	"created": {Key: "created", Type: datasource.Timestamp},
	"paid":    {Key: "paid", Type: datasource.Boolean},
	"arpu":    {Key: "arpu", Type: datasource.Decimal, Metric: true},
}

func scope(name string) (FieldInfo, bool) {
	f, ok := fields[name]
	return f, ok
}

func TestCheck(t *testing.T) {
	tests := []struct {
		expr   string
		metric bool
		// want is the type it gives, or the code of what is wrong with it.
		want string
	}{
		{"${amount} * ${qty}", false, "decimal"},
		{"${qty} + 1", false, "integer"},
		{"${qty} / 2", false, "decimal"},
		{"${qty} / 2.0 + TO_FLOAT(${qty})", false, "float"},
		{"${qty} % 2", false, "integer"},
		{"IF(${paid}, ${amount}, 0)", false, "decimal"},
		{"IF(${qty} > 1, 'a', NULL)", false, "string"},
		{"CASE WHEN ${paid} THEN 'y' ELSE 'n' END", false, "string"},
		{"case ${region} when '华东' then 1 else 2 end", false, "integer"},
		{"${day} >= '2026-01-01'", false, "boolean"},
		{"${region} IN ('a', 'b') AND NOT ${paid}", false, "boolean"},
		{"date_diff('DAY', ${created}, ${day})", false, "integer"},
		{"DATE_ADD(${created}, 1, 'hour')", false, "timestamp"},
		{"DATE_ADD('2026-01-01', ${qty}, 'day')", false, "date"},
		{"COALESCE(${amount}, ${qty}, 0)", false, "decimal"},
		{"NATIVE('json_value({0}, ''$.a'')', ${region})", false, ""},
		{"CONCAT(${region}, NATIVE('version()'))", false, "string"},
		{"SUM(${amount}) / COUNT(DISTINCT ${region})", true, "decimal"},
		{"SUM(${qty})", true, "decimal"},
		{"${arpu} * 100", true, "decimal"},
		{"COUNT(*) + COUNT()", true, "integer"},
		{"MAX(${day})", true, "date"},
		{"NATIVE('quantile(0.9)({0})', ${amount})", true, ""},

		{"", false, "expr_empty"},
		{"${amount} +", false, "expr_incomplete"},
		{"(${amount}", false, "expr_expected"},
		{"${amount} ${qty}", false, "expr_unexpected"},
		{"'abc", false, "expr_unclosed_string"},
		{"${amount", false, "expr_unclosed_reference"},
		{`"abc"`, false, "expr_quote"},
		{"amount * 2", false, "expr_bare_word"},
		{"${nope}", false, "expr_unknown_field"},
		{"NVL(${amount}, 0)", false, "expr_unknown_function"},
		{"ABS()", false, "expr_arguments"},
		{"IF(${paid}, 1)", false, "expr_arguments"},
		{"SUBSTR(${region}, 1, 2, 3)", false, "expr_arguments"},
		{"${region} + 1", false, "expr_wrong_type"},
		{"UPPER(${qty})", false, "expr_wrong_type"},
		{"CONCAT(${region}, ${qty})", false, "expr_wrong_type"},
		{"IF(${qty}, 1, 2)", false, "expr_wrong_type"},
		{"HOUR(${day})", false, "expr_wrong_type"},
		{"${region} = ${qty}", false, "expr_type_mismatch"},
		{"IF(${paid}, 'a', 1)", false, "expr_type_mismatch"},
		{"${day} > 'yesterday'", false, "expr_type_mismatch"},
		{"DATE_TRUNC('hour', ${created})", false, "expr_unit"},
		{"DATE_ADD(${day}, 1, 'hour')", false, "expr_unit"},
		{"DATE_ADD(${day}, 1, ${region})", false, "expr_unit"},
		{"ROUND(${amount}, ${qty})", false, "expr_literal_needed"},
		{"NATIVE(${region})", false, "expr_native_text"},
		{"NATIVE('{1}', ${region})", false, "expr_native_slot"},
		{"SUM(${amount})", false, "expr_aggregate_in_row"},
		{"${arpu} * 2", false, "expr_aggregate_in_row"},
		{"${amount} * 2", true, "expr_metric_needs_aggregate"},
		{"SUM(${amount}) / ${qty}", true, "expr_mixed_levels"},
		{"SUM(AVG(${amount}))", true, "expr_nested_aggregate"},
		{"SUM(${arpu})", true, "expr_nested_aggregate"},
	}
	for _, tt := range tests {
		checked, err := Check(tt.expr, scope, tt.metric)
		got := ""
		if err != nil {
			got = err.Code
			if err.From < 0 || err.To > len(tt.expr) || err.From > err.To {
				t.Errorf("%s: the mistake is at %d to %d, outside the expression", tt.expr, err.From, err.To)
			}
		} else {
			got = string(checked.Type)
		}
		if got != tt.want {
			t.Errorf("%s: got %q (%v), want %q", tt.expr, got, err, tt.want)
		}
	}
}

// Where a mistake is said to be is what the author sees marked.
func TestErrorPosition(t *testing.T) {
	text := "IF(${paid}, UPPER(${qty}), 'x')"
	_, err := Check(text, scope, false)
	if err == nil || text[err.From:err.To] != "${qty}" {
		t.Errorf("err = %+v, want it at ${qty}", err)
	}
	text = "${amount} + NVL(1)"
	if _, err = Check(text, scope, false); err == nil || text[err.From:err.To] != "NVL" {
		t.Errorf("err = %+v, want it at NVL", err)
	}
}

func TestSQL(t *testing.T) {
	env := func(d dialect.Dialect) Env {
		return Env{Dialect: d, Zone: "Asia/Shanghai", WeekStart: dialect.Monday, Today: "2026-03-10", Ref: func(key string) string { return "t." + key }}
	}
	tests := []struct {
		expr    string
		dialect dialect.Dialect
		want    string
	}{
		{"${qty} / 2", dialect.Postgres{}, "(CAST((t.qty) AS numeric) / NULLIF(2, 0))"},
		{"${qty} / 2", dialect.MySQL{}, "((t.qty) / NULLIF(2, 0))"},
		{"${amount} / ${qty}", dialect.ClickHouse{}, "(toDecimal128((t.amount), 10) / NULLIF((t.qty), 0))"},
		{"IF(${paid}, 'it''s', 'a\\b')", dialect.Postgres{}, `CASE WHEN (t.paid) THEN 'it''s' ELSE 'a\b' END`},
		{"IF(${paid}, 'it''s', 'a\\b')", dialect.MySQL{}, `CASE WHEN (t.paid) THEN 'it''s' ELSE 'a\\b' END`},
		{"CONCAT(${region}, '-', 'x')", dialect.Postgres{}, "((t.region) || '-' || 'x')"},
		{"CONCAT(${region}, '-', 'x')", dialect.ClickHouse{}, "CONCAT((t.region), '-', 'x')"},
		{"LENGTH(${region})", dialect.ClickHouse{}, "lengthUTF8((t.region))"},
		{"${day} > '2026-01-01'", dialect.MySQL{}, "((t.day) > CAST('2026-01-01' AS DATE))"},
		{"TODAY()", dialect.ClickHouse{}, "toDate('2026-03-10')"},
		{"YEAR(${created})", dialect.MySQL{}, "YEAR(CONVERT_TZ((t.created), @@session.time_zone, 'Asia/Shanghai'))"},
		{"YEAR(${day})", dialect.Postgres{}, "CAST(EXTRACT(YEAR FROM (t.day)) AS integer)"},
		{"DATE_ADD(${day}, 2, 'week')", dialect.MySQL{}, "DATE_ADD((t.day), INTERVAL (2 * 7) DAY)"},
		{"DATE_ADD(${day}, 2, 'week')", dialect.StarRocks{}, "CAST(DATE_ADD((t.day), INTERVAL (2 * 7) DAY) AS DATE)"},
		{"NATIVE('f({0}, {1}, {0})', ${qty}, 1)", dialect.MySQL{}, "(f((t.qty), 1, (t.qty)))"},
		{"COUNT(*) + COUNT_DISTINCT(${region})", dialect.Postgres{}, "(COUNT(*) + COUNT(DISTINCT (t.region)))"},
		{"${qty} / 2", dialect.Trino{}, "(CAST((t.qty) AS decimal(38, 10)) / NULLIF(2, 0))"},
		{"RIGHT(${region}, 2)", dialect.Trino{}, "substr((t.region), greatest(length((t.region)) - (2) + 1, 1), greatest(2, 0))"},
		{"DATE_ADD(${day}, 2, 'week')", dialect.Trino{}, "date_add('day', (2 * 7), (t.day))"},
	}
	for _, tt := range tests {
		checked, err := Check(tt.expr, scope, strings.Contains(tt.expr, "COUNT"))
		if err != nil {
			t.Errorf("%s: %v", tt.expr, err)
			continue
		}
		if got, err := checked.SQL(env(tt.dialect)); err != nil || got != tt.want {
			t.Errorf("%s on %s:\n got %s (%v)\nwant %s", tt.expr, tt.dialect.Name(), got, err, tt.want)
		}
	}
}

// A database that has no way to compute a function says so, and is not offered it.
func TestAvailability(t *testing.T) {
	checked, err := Check("MEDIAN(${amount})", scope, true)
	if err != nil {
		t.Fatal(err)
	}
	_, err = checked.SQL(Env{Dialect: dialect.MySQL{}, Ref: func(string) string { return "x" }})
	if err == nil || err.Code != "function_unavailable" || err.Params["name"] != "MEDIAN" || err.From != 0 || err.To != len("MEDIAN(${amount})") {
		t.Errorf("err = %+v, want function_unavailable for MEDIAN", err)
	}
	if _, err = checked.SQL(Env{Dialect: dialect.Postgres{}, Ref: func(string) string { return "x" }}); err != nil {
		t.Errorf("postgres: %v", err)
	}

	offered := func(d dialect.Dialect) map[string]bool {
		names := map[string]bool{}
		for _, f := range Functions(d) {
			names[f.Name] = true
		}
		return names
	}
	if mysql := offered(dialect.MySQL{}); mysql["MEDIAN"] || !mysql["SUM"] || !mysql["REGEXP_MATCH"] {
		t.Errorf("mysql is offered %v", mysql)
	}
	// Whatever is not marked as beyond the core is there on every database.
	for _, d := range []dialect.Dialect{dialect.Postgres{}, dialect.MySQL{}, dialect.ClickHouse{}, dialect.StarRocks{}, dialect.StarRocks{Doris: true}} {
		names := offered(d)
		for _, f := range catalogue {
			if !f.Extended && !names[f.Name] {
				t.Errorf("%s lacks %s, which is part of the core", d.Name(), f.Name)
			}
		}
	}
	// Every function says what it is written with, and each of those is known to the dialects.
	for _, f := range catalogue {
		for _, need := range f.needs {
			if _, known := (dialect.Postgres{}).Function(need); !known {
				t.Errorf("%s needs %s, which postgres does not know", f.Name, need)
			}
		}
	}
}

// Nesting is read by the parser calling itself, and a stack that runs out
// ends the process rather than failing the request.
func TestParseLimits(t *testing.T) {
	tests := []struct{ name, expr, want string }{
		{"brackets", strings.Repeat("(", maxDepth+1) + "1" + strings.Repeat(")", maxDepth+1), "expr_too_deep"},
		{"minus signs", strings.Repeat("-", maxDepth+1) + "1", "expr_too_deep"},
		{"NOT", strings.Repeat("NOT ", maxDepth+1) + "TRUE", "expr_too_deep"},
		{"calls", strings.Repeat("ABS(", maxDepth+1) + "1" + strings.Repeat(")", maxDepth+1), "expr_too_deep"},
		{"length", "1" + strings.Repeat(" + 1", maxLength/4), "expr_too_long"},
		{"brackets a person writes", strings.Repeat("(", 20) + "1" + strings.Repeat(")", 20), ""},
		{"a long sum", "1" + strings.Repeat(" + 1", 1000), ""},
	}
	for _, tt := range tests {
		_, err := Parse(tt.expr)
		got := ""
		if err != nil {
			got = err.Code
		}
		if got != tt.want {
			t.Errorf("%s: code = %q, want %q", tt.name, got, tt.want)
		}
	}
}
