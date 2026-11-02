package conformance

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/expr"
	"github.com/supazd/supabi/internal/query"
)

// calculated is the fixture's dataset with one more field, written in the
// platform's language.
func (tg Target) calculated(t *testing.T, text string, kind datasource.Type, role dataset.Role) *dataset.Spec {
	t.Helper()
	spec := tg.spec()
	field := dataset.Field{Key: "x", Label: "x", Expr: text, Syntax: dataset.Standard, Type: kind, Role: role}
	spec.Fields = append(spec.Fields, field)
	if err := spec.Validate(); err != nil {
		t.Fatalf("%s: %v", text, err)
	}
	return spec
}

// The platform's language means the same on every database: each expression
// here gives these values for the five rows of the fixture, in order, whatever
// database works them out.
func expressions(t *testing.T, tg Target) {
	const (
		str     = datasource.String
		integer = datasource.Integer
		dec     = datasource.Decimal
		date    = datasource.Date
		ts      = datasource.Timestamp
	)
	rows := []struct {
		expr string
		kind datasource.Type
		zone string
		want string
	}{
		// Arithmetic. Dividing keeps the fraction and survives a zero.
		{"${amount} / ${qty}", dec, "", `100.5, 100, 100.0833, 9999999999999.99, 10`},
		{"${qty} / 2", dec, "", `0.5, 1, 1.5, 0.5, 2.5`},
		{"${qty} / (${qty} - 1)", dec, "", `null, 2, 1.5, null, 1.25`},
		{"${qty} % 2 + MOD(${qty}, 3)", integer, "", `2, 2, 1, 2, 3`},
		{"MOD(${qty}, ${qty} - 1)", integer, "", `null, 0, 1, null, 1`},
		{"-${qty} * 2 + 10", integer, "", `8, 6, 4, 8, 0`},
		{"ROUND(${amount} / 3, 2)", dec, "", `33.5, 66.67, 100.08, 3333333333333.33, 16.67`},
		{"ROUND(${amount})", dec, "", `101, 200, 300, 10000000000000, 50`},
		{"FLOOR(${amount}) + CEIL(${amount})", integer, "", `201, 400, 601, 19999999999999, 100`},
		{"ABS(${qty} - 3)", integer, "", `2, 1, 0, 2, 2`},
		{"POWER(${qty}, 2) + SQRT(${qty} * ${qty})", datasource.Float, "", `2, 6, 12, 2, 30`},

		// Conditions.
		{"IF(${amount} >= 200, 'high', 'low')", str, "", `"low", "high", "high", "high", "low"`},
		{"CASE WHEN ${qty} > 3 THEN 'many' WHEN ${qty} > 1 THEN 'some' ELSE 'one' END", str, "", `"one", "some", "some", "one", "many"`},
		{"CASE ${status} WHEN 'paid' THEN 1 ELSE 0 END", integer, "", `1, 1, 0, 1, 1`},
		{"IF(${region} IN ('华东', '华北') AND NOT ${qty} BETWEEN 2 AND 3, 'y', 'n')", str, "", `"y", "n", "n", "y", "n"`},
		{"IF(${note} IS NULL OR ${qty} NOT IN (1, 3), 'y', 'n')", str, "", `"n", "y", "n", "n", "y"`},
		{"COALESCE(${note}, '-')", str, "", `"50% off", "-", "a_b", "axb", "-"`},
		{"IFNULL(NULLIF(${qty}, 1), 0)", integer, "", `0, 2, 3, 0, 5`},

		// Text. Lengths and places are counted in characters.
		{"CONCAT(${region}, '-', ${note})", str, "", `"华东-50% off", null, "华南-a_b", "华北-axb", null`},
		{"CONCAT(${status}, ' it''s \\ ok')", str, "", `"paid it's \\ ok", "paid it's \\ ok", "refunded it's \\ ok", "paid it's \\ ok", "paid it's \\ ok"`},
		{"LENGTH(${region}) + LENGTH(${status})", integer, "", `6, 6, 10, 6, 6`},
		{"CONCAT(UPPER(${status}), LOWER('ABC'), TRIM('  x '))", str, "", `"PAIDabcx", "PAIDabcx", "REFUNDEDabcx", "PAIDabcx", "PAIDabcx"`},
		{"SUBSTR(${note}, 2, 3)", str, "", `"0% ", null, "_b", "xb", null`},
		{"CONCAT(SUBSTR(${region}, 2), LEFT(${region}, 1), RIGHT(${user_id}, 1))", str, "", `"东华1", "东华2", "南华1", "北华3", "南华3"`},
		{"REPLACE(${note}, '_', '-')", str, "", `"50% off", null, "a-b", "axb", null`},
		{"IF(CONTAINS(${note}, '%'), 'y', 'n')", str, "", `"y", "n", "n", "n", "n"`},
		{"IF(STARTS_WITH(${note}, 'a') AND ENDS_WITH(${note}, 'b'), 'y', 'n')", str, "", `"n", "n", "y", "y", "n"`},

		// Dates. A time is read in the zone of the query.
		{"YEAR(${order_date}) * 10000 + MONTH(${order_date}) * 100 + DAY(${order_date})", integer, "", `20260131, 20260201, 20260215, 20260308, 20260309`},
		{"QUARTER(${order_date}) * 10 + WEEKDAY(${order_date})", integer, "", `16, 17, 17, 17, 11`},
		{"HOUR(${created}) * 100 + MINUTE(${created})", integer, "", `2330, 30, 1200, 1000, 1000`},
		{"HOUR(${created}) * 100 + MINUTE(${created})", integer, "UTC", `1530, 1630, 400, 200, 200`},
		{"HOUR(${paid}) * 100 + DAY(${paid})", integer, "UTC", `1531, 1631, 415, 208, 209`},
		{"DATE(${created})", date, "UTC", `"2026-01-31", "2026-01-31", "2026-02-15", "2026-03-08", "2026-03-09"`},
		{"DATE(${paid})", date, "", `"2026-01-31", "2026-02-01", "2026-02-15", "2026-03-08", "2026-03-09"`},
		{"DATE_TRUNC('month', ${paid})", date, "UTC", `"2026-01-01", "2026-01-01", "2026-02-01", "2026-03-01", "2026-03-01"`},
		{"DATE_TRUNC('week', ${order_date})", date, "", `"2026-01-26", "2026-01-26", "2026-02-09", "2026-03-02", "2026-03-09"`},
		{"DATE_TRUNC('quarter', ${order_date})", date, "", `"2026-01-01", "2026-01-01", "2026-01-01", "2026-01-01", "2026-01-01"`},
		{"DATE_ADD(${order_date}, 1, 'month')", date, "", `"2026-02-28", "2026-03-01", "2026-03-15", "2026-04-08", "2026-04-09"`},
		{"DATE_ADD(${order_date}, -${qty}, 'week')", date, "", `"2026-01-24", "2026-01-18", "2026-01-25", "2026-03-01", "2026-02-02"`},
		{"DATE_ADD(DATE_ADD(${order_date}, 1, 'quarter'), 1, 'year')", date, "", `"2027-04-30", "2027-05-01", "2027-05-15", "2027-06-08", "2027-06-09"`},
		{"DATE_ADD(${created}, 90, 'minute')", ts, "", `"2026-02-01T01:00:00", "2026-02-01T02:00:00", "2026-02-15T13:30:00", "2026-03-08T11:30:00", "2026-03-09T11:30:00"`},
		{"DATE_ADD(${paid}, 1, 'hour')", ts, "UTC", `"2026-01-31T16:30:00", "2026-01-31T17:30:00", "2026-02-15T05:00:00", "2026-03-08T03:00:00", "2026-03-09T03:00:00"`},
		{"DATE_DIFF('day', ${order_date}, '2026-03-10')", integer, "", `38, 37, 23, 2, 1`},
		{"DATE_DIFF('day', ${created}, ${order_date})", integer, "UTC", `0, 1, 0, 0, 0`},
		// Today is 10 March 2026, a Tuesday, in Shanghai.
		{"DATE_DIFF('month', ${order_date}, TODAY())", integer, "", `2, 1, 1, 0, 0`},
		{"DATE_DIFF('week', ${paid}, TODAY())", integer, "", `6, 6, 4, 1, 0`},
		{"DATE_DIFF('quarter', DATE('2025-12-31'), ${order_date}) * 10 + DATE_DIFF('year', DATE('2025-12-31'), ${order_date})", integer, "", `11, 11, 11, 11, 11`},
		{"IF(${order_date} >= '2026-03-01' AND ${paid} >= ${created}, 'new', 'old')", str, "", `"old", "old", "old", "new", "new"`},

		// Conversions. A number made whole loses its fraction, without rounding.
		{"CONCAT(TO_STRING(${order_date}), '#', TO_STRING(${qty}))", str, "", `"2026-01-31#1", "2026-02-01#2", "2026-02-15#3", "2026-03-08#1", "2026-03-09#5"`},
		{"TO_INTEGER(${amount} + 0.49) + TO_INTEGER('40')", integer, "", `140, 240, 340, 10000000000040, 90`},
		{"TO_INTEGER(0 - ${amount})", integer, "", `-100, -200, -300, -9999999999999, -50`},
		{"TO_DECIMAL('1.5') * ${qty} + TO_FLOAT(${qty}) / 4", datasource.Float, "", `1.75, 3.5, 5.25, 1.75, 8.75`},

		// A piece of the database's own SQL, where the language runs out.
		{"NATIVE('{0} + {1}', ${qty}, 1) * 2", integer, "", `4, 6, 8, 4, 12`},
	}
	for _, tt := range rows {
		spec := tg.calculated(t, tt.expr, tt.kind, dataset.Dimension)
		// The rows are sorted by a column that is not compared, so it is asked for and dropped.
		q := `{"version":1,"dataset":"d","mode":"detail","columns":["order_id","x"],"sort":[{"by":"order_id"}]`
		if tt.zone != "" {
			q += fmt.Sprintf(`,"timezone":%q`, tt.zone)
		}
		q += "}"
		result := tg.run(t, tg.options(), spec, q)
		for i, row := range result.Rows {
			result.Rows[i] = row[1:]
		}
		result.Columns = result.Columns[1:]
		expect(t, tt.expr, result, "[["+strings.ReplaceAll(tt.want, ", ", "],[")+"]]")
	}

	// Metrics aggregate in their own expression.
	metrics := []struct{ expr, want string }{
		{"SUM(${amount}) / COUNT(${order_id})", `[["华东",150.25],["华南",175.125],["华北",9999999999999.99]]`},
		{"COUNT_DISTINCT(${user_id}) * 100 + COUNT(DISTINCT ${status}) * 10 + COUNT() + COUNT(*)", `[["华北",112],["华东",214],["华南",224]]`},
		{"SUM(IF(${status} = 'paid', ${amount}, 0))", `[["华南",50],["华东",300.5],["华北",9999999999999.99]]`},
		{"MAX(${qty}) - MIN(${qty}) + AVG(${qty})", `[["华北",1],["华东",2.5],["华南",6]]`},
		{"COUNT(${note}) / COUNT() + SUM(${qty})", `[["华北",2],["华东",3.5],["华南",8.5]]`},
		// A sum of whole numbers divided keeps its fraction too, though some
		// databases sum them into a whole number.
		{"SUM(${qty}) / SUM(${qty} + 1)", `[["华北",0.5],["华东",0.6],["华南",0.8]]`},
		{"SUM(${qty}) / COUNT()", `[["华北",1],["华东",1.5],["华南",4]]`},
		// A metric made of another, and of a field written in the database's own SQL.
		{"${avg_order} * 2 + SUM(${paid_revenue}) * 0", `[["华东",300.5],["华南",350.25],["华北",19999999999999.98]]`},
	}
	for _, tt := range metrics {
		spec := tg.calculated(t, tt.expr, datasource.Decimal, dataset.Metric)
		q := `{"version":1,"dataset":"d","dimensions":[{"field":"region"}],"measures":[{"field":"x"}],"sort":[{"by":"x"}]}`
		expect(t, tt.expr, tg.run(t, tg.options(), spec, q), tt.want)
	}

	// A field is used like any other: aggregated, grouped by, filtered by, and
	// referred to from a field written in the database's own SQL.
	spec := tg.calculated(t, "IF(${qty} >= 2, ${amount}, 0)", datasource.Decimal, dataset.MeasureRole)
	spec.Fields = append(spec.Fields,
		dataset.Field{Key: "half", Label: "half", Expr: "${x} * 5", Type: datasource.Decimal, Role: dataset.MeasureRole},
		dataset.Field{Key: "month", Label: "month", Expr: "MONTH(${order_date})", Syntax: dataset.Standard, Type: datasource.Integer, Role: dataset.Dimension})
	if err := spec.Validate(); err != nil {
		t.Fatal(err)
	}
	q := `{"version":1,"dataset":"d","dimensions":[{"field":"month"}],"measures":[{"field":"x","agg":"max"},{"field":"half","agg":"sum"}],"filter":{"field":"month","op":"gte","value":2},"sort":[{"by":"month"}]}`
	expect(t, "used as a measure, a dimension and a filter", tg.run(t, tg.options(), spec, q), `[[2,300.25,2501.25],[3,50,250]]`)

	// Beyond the core, a database either computes a function or says it cannot.
	extended := []struct {
		expr string
		kind datasource.Type
		role dataset.Role
		want string
	}{
		{"MEDIAN(${qty})", datasource.Float, dataset.Metric, `[[2]]`},
		{"IF(REGEXP_MATCH(${note}, '^a.b$'), 1, 0)", datasource.Integer, dataset.MeasureRole, `[[1]]`},
	}
	for _, tt := range extended {
		name, _, _ := strings.Cut(strings.TrimPrefix(tt.expr, "IF("), "(")
		f, _ := expr.Lookup(name)
		spec := tg.calculated(t, tt.expr, tt.kind, tt.role)
		q := `{"version":1,"dataset":"d","measures":[{"field":"x"}]}`
		if tt.role == dataset.MeasureRole {
			q = `{"version":1,"dataset":"d","measures":[{"field":"x","agg":"max"}]}`
		}
		if f.Available(tg.Conn.Dialect()) {
			expect(t, tt.expr, tg.run(t, tg.options(), spec, q), tt.want)
			continue
		}
		_, err := query.Compile(parse(t, q), spec, tg.options())
		var specErr *dataset.Error
		if !errors.As(err, &specErr) || specErr.Code != "function_unavailable" || specErr.Params["name"] != name {
			t.Errorf("%s: err = %v, want function_unavailable for %s", tt.expr, err, name)
		}
	}
}
