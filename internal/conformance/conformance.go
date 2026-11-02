// Package conformance is the test suite every data source driver must pass.
// It runs one set of queries, written in the query IR, against a fixture and
// compares the results, so that the same question gets the same answer from
// every supported database. Supporting a new database means implementing the
// driver and dialect and making this suite pass.
package conformance

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/dialect"
	"github.com/supazd/supabi/internal/query"
)

// DataTimezone is the zone of the fixture's wall-clock times. Connections
// under test must be opened with it as their data time zone.
const DataTimezone = "Asia/Shanghai"

// Columns describes the fixture table, in order:
//
//	id          integer
//	created_at  timestamp stored without a zone (Shanghai wall-clock time)
//	paid_at     timestamp stored as an instant, the same moments as created_at
//	order_date  date
//	amount      decimal with two fractional digits and at least 15 digits in all
//	qty         integer
//	region, user_id, status, note   text; note may be null
//
// Rows holds the values as SQL literals for a VALUES list, apart from
// paid_at, which each database writes its own way: use PaidAt for the
// wall-clock value in DataTimezone. 2026-03-08 is a Sunday.
var Rows = []struct {
	ID        int
	CreatedAt string
	PaidAt    string
	OrderDate string
	Amount    string
	Qty       int
	Region    string
	UserID    string
	Status    string
	Note      string // empty means NULL
}{
	{1, "2026-01-31 23:30:00", "2026-01-31 23:30:00", "2026-01-31", "100.50", 1, "华东", "u1", "paid", "50% off"},
	{2, "2026-02-01 00:30:00", "2026-02-01 00:30:00", "2026-02-01", "200.00", 2, "华东", "u2", "paid", ""},
	{3, "2026-02-15 12:00:00", "2026-02-15 12:00:00", "2026-02-15", "300.25", 3, "华南", "u1", "refunded", "a_b"},
	{4, "2026-03-08 10:00:00", "2026-03-08 10:00:00", "2026-03-08", "9999999999999.99", 1, "华北", "u3", "paid", "axb"},
	{5, "2026-03-09 10:00:00", "2026-03-09 10:00:00", "2026-03-09", "50.00", 5, "华南", "u3", "paid", ""},
}

// Values renders Rows as a VALUES list. paidAt turns a wall-clock time in
// DataTimezone into the database's literal for that instant.
func Values(paidAt func(wallClock string) string) string {
	var rows []string
	for _, r := range Rows {
		note := "NULL"
		if r.Note != "" {
			note = "'" + r.Note + "'"
		}
		rows = append(rows, fmt.Sprintf("(%d, '%s', %s, '%s', %s, %d, '%s', '%s', '%s', %s)",
			r.ID, r.CreatedAt, paidAt(r.PaidAt), r.OrderDate, r.Amount, r.Qty, r.Region, r.UserID, r.Status, note))
	}
	return strings.Join(rows, ",\n")
}

// Target is a database holding the fixture.
type Target struct {
	Conn datasource.Conn
	// Table is the fixture as a dataset's table source.
	Table dataset.Source
	// QualifiedName is how SQL written for this database names the fixture table.
	QualifiedName string
	// AverageExpr overrides the expression of the avg_order field. A
	// dataset's expressions are written in its database's own SQL, and
	// dividing decimals is one place where databases differ: some keep the
	// scale of the dividend and would round the quotient.
	AverageExpr string
	// Commented says the fixture table carries the comment "订单" and its
	// amount column "金额", for databases whose comments are read.
	Commented bool
	// NoTableComment: the database does not say what was written about a
	// table, only about its columns.
	NoTableComment bool
}

// money is the display format of the amounts.
var money = &dataset.Format{Decimals: new(2), Prefix: "¥"}

func (tg Target) spec() *dataset.Spec {
	average := tg.AverageExpr
	if average == "" {
		average = "SUM(${amount}) / NULLIF(COUNT(${order_id}), 0)"
	}
	return &dataset.Spec{
		SpecVersion: 1,
		Source:      tg.Table,
		Fields: []dataset.Field{
			{Key: "order_id", Label: "订单号", Column: "id", Type: datasource.Integer, Role: dataset.Dimension},
			{Key: "created", Label: "下单时间", Column: "created_at", Type: datasource.Timestamp, Role: dataset.Dimension},
			{Key: "paid", Label: "支付时间", Column: "paid_at", Type: datasource.Timestamp, Role: dataset.Dimension},
			{Key: "order_date", Label: "下单日期", Column: "order_date", Type: datasource.Date, Role: dataset.Dimension},
			{Key: "region", Label: "地区", Column: "region", Type: datasource.String, Role: dataset.Dimension},
			{Key: "user_id", Label: "用户", Column: "user_id", Type: datasource.String, Role: dataset.Dimension},
			{Key: "status", Label: "状态", Column: "status", Type: datasource.String, Role: dataset.Dimension},
			{Key: "note", Label: "备注", Column: "note", Type: datasource.String, Role: dataset.Dimension},
			{Key: "tier", Label: "档位", Expr: "CASE WHEN ${amount} >= 200 THEN 'high' ELSE 'low' END", Type: datasource.String, Role: dataset.Dimension},

			// Measures over a column, with each kind of default aggregation.
			{Key: "amount", Label: "金额", Column: "amount", Type: datasource.Decimal, Role: dataset.MeasureRole, Format: money},
			{Key: "qty", Label: "件数", Column: "qty", Type: datasource.Integer, Role: dataset.MeasureRole},
			{Key: "revenue", Label: "销售额", Column: "amount", Type: datasource.Decimal, Role: dataset.MeasureRole, Format: money},
			{Key: "orders", Label: "订单数", Column: "id", Type: datasource.Integer, Role: dataset.MeasureRole},
			{Key: "buyers", Label: "购买人数", Column: "user_id", Type: datasource.String, Role: dataset.Dimension},
			// A measure calculated per row, then aggregated: a conditional sum.
			{Key: "paid_revenue", Label: "已付销售额", Expr: "CASE WHEN ${status} = 'paid' THEN ${amount} END", Type: datasource.Decimal,
				Role: dataset.MeasureRole},
			// A measure that aggregates by itself.
			{Key: "avg_order", Label: "单均", Expr: average, Type: datasource.Decimal, Role: dataset.Metric},
		},
	}
}

func (tg Target) options() query.Options {
	return query.Options{
		Dialect:      tg.Conn.Dialect(),
		Now:          time.Date(2026, 3, 10, 9, 0, 0, 0, time.UTC), // 17:00 on a Tuesday in Shanghai
		Timezone:     DataTimezone,
		WeekStart:    dialect.Monday,
		DefaultLimit: 1000,
		MaxLimit:     5000,
	}
}

func parse(t *testing.T, body string) *query.Query {
	t.Helper()
	dec := json.NewDecoder(strings.NewReader(body))
	dec.DisallowUnknownFields()
	q := &query.Query{}
	if err := dec.Decode(q); err != nil {
		t.Fatalf("invalid query in the suite: %v\n%s", err, body)
	}
	return q
}

func (tg Target) run(t *testing.T, opt query.Options, spec *dataset.Spec, body string) *query.Result {
	t.Helper()
	compiled, err := query.Compile(parse(t, body), spec, opt)
	if err != nil {
		t.Fatalf("compile: %v\n%s", err, body)
	}
	result, err := query.Run(context.Background(), tg.Conn, compiled)
	if err != nil {
		t.Fatalf("run: %v\n%s\nargs: %v", err, compiled.SQL, compiled.Args)
	}
	return result
}

// canon makes results comparable across databases, which agree on values but
// not always on representation: the sum of an integer column is an integer
// in one and a decimal in another, and a quotient has a different number of
// trailing zeros. Numbers, whether sent as numbers or as decimal strings, are
// reduced to an exact fraction; everything else is left alone.
func canon(rows [][]any, columns []query.Column) string {
	out := make([][]any, len(rows))
	for i, row := range rows {
		out[i] = make([]any, len(row))
		for j, v := range row {
			out[i][j] = v
			if j < len(columns) && !columns[j].Type.Numeric() {
				continue
			}
			if r, ok := new(big.Rat).SetString(fmt.Sprint(v)); ok && v != nil {
				out[i][j] = json.Number(r.FloatString(4))
			}
		}
	}
	b, _ := json.Marshal(out)
	return string(b)
}

// expect canonicalises a literal expectation the same way.
func expect(t *testing.T, name string, result *query.Result, want string) {
	t.Helper()
	var wanted [][]any
	dec := json.NewDecoder(strings.NewReader(want))
	dec.UseNumber()
	if err := dec.Decode(&wanted); err != nil {
		t.Fatalf("%s: invalid expectation %s: %v", name, want, err)
	}
	for i, row := range wanted {
		for j, v := range row {
			if n, ok := v.(json.Number); ok {
				wanted[i][j] = n.String()
			}
		}
	}
	if got, want := canon(result.Rows, result.Columns), canon(wanted, result.Columns); got != want {
		t.Errorf("%s:\n got %s\nwant %s", name, got, want)
	}
}

// Run executes the whole suite against a target.
func Run(t *testing.T, tg Target) {
	t.Run("comparisons", func(t *testing.T) { comparisons(t, tg) })
	t.Run("percentages", func(t *testing.T) { percentages(t, tg) })
	t.Run("running totals", func(t *testing.T) { runningTotals(t, tg) })
	t.Run("aggregate", func(t *testing.T) { aggregate(t, tg) })
	t.Run("time zones and grains", func(t *testing.T) { zonesAndGrains(t, tg) })
	t.Run("time ranges", func(t *testing.T) { timeRanges(t, tg) })
	t.Run("source parameters", func(t *testing.T) { sourceParams(t, tg) })
	t.Run("row filter", func(t *testing.T) { rowFilter(t, tg) })
	t.Run("column names", func(t *testing.T) { columnNames(t, tg) })
	t.Run("expressions", func(t *testing.T) { expressions(t, tg) })
	t.Run("detail and limits", func(t *testing.T) { detailAndLimits(t, tg) })
	t.Run("tables and error positions", func(t *testing.T) { tablesAndPositions(t, tg) })
}

// What helps an author write a source: the tables there are to read, and
// where the database found a mistake.
func tablesAndPositions(t *testing.T, tg Target) {
	ctx := context.Background()
	tables, err := tg.Conn.Tables(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var found *datasource.Table
	for i, table := range tables {
		if table.Name == "orders" && (table.Schema == "" || table.Schema == tg.Table.Schema) {
			found = &tables[i]
		}
	}
	if found == nil {
		t.Fatalf("the fixture table is not among %d tables", len(tables))
	}
	// A table that is in a schema says so, even when it can be named without it.
	if tg.Table.Schema != "" && (len(found.Path) == 0 || found.Path[len(found.Path)-1] != tg.Table.Schema) {
		t.Errorf("path = %v, want it to end in %q", found.Path, tg.Table.Schema)
	}
	var names []string
	for _, column := range found.Columns {
		names = append(names, column.Name)
		if column.DBType == "" {
			t.Errorf("column %s has no type", column.Name)
		}
	}
	if got, want := strings.Join(names, " "), "id created_at paid_at order_date amount qty region user_id status note"; got != want {
		t.Errorf("columns = %s\n    want %s", got, want)
	}

	if tg.Commented {
		var amount string
		for _, column := range found.Columns {
			if column.Name == "amount" {
				amount = column.Comment
			}
		}
		table := "订单"
		if tg.NoTableComment {
			table = ""
		}
		if found.Comment != table || amount != "金额" {
			t.Errorf("comments = %q on the table, %q on amount; want %q and 金额", found.Comment, amount, table)
		}
	}

	// How a statement would be run can be asked for as any other question.
	plan, err := tg.Conn.Query(ctx, "EXPLAIN SELECT region, SUM(amount) FROM "+tg.QualifiedName+" GROUP BY region", nil)
	if err != nil {
		t.Fatalf("explain: %v", err)
	}
	if len(plan.Rows) == 0 || len(plan.Columns) == 0 {
		t.Errorf("explain returned %d rows of %d columns", len(plan.Rows), len(plan.Columns))
	}

	// The misspelt FROM makes the table name the first thing that cannot be
	// read. Chinese before it shows the position is counted in bytes.
	broken := "SELECT '华东' AS area, '东' AS east,\n  amount FORM " + tg.QualifiedName
	_, err = tg.Conn.Describe(ctx, broken, nil)
	var queryErr *datasource.QueryError
	if !errors.As(err, &queryErr) {
		t.Fatalf("err = %v, want a QueryError", err)
	}
	if want := strings.Index(broken, tg.QualifiedName) + 1; queryErr.Position != want {
		t.Errorf("position = %d, want %d: %s", queryErr.Position, want, queryErr.Message)
	}

	// The same with Chinese on the line of the mistake, before it: a database
	// that counts characters into the line still gives a position in bytes.
	// Here the column has its name already, so the misspelt word is what cannot be read.
	broken = "SELECT amount,\n  '华东' AS area FORM " + tg.QualifiedName
	_, err = tg.Conn.Describe(ctx, broken, nil)
	if !errors.As(err, &queryErr) {
		t.Fatalf("err = %v, want a QueryError", err)
	}
	if want := strings.Index(broken, "FORM") + 1; queryErr.Position != want {
		t.Errorf("position = %d, want %d: %s", queryErr.Position, want, queryErr.Message)
	}
}

func aggregate(t *testing.T, tg Target) {
	tests := []struct{ name, query, want string }{
		{"group and sort; decimals keep full precision",
			`{"version":1,"dataset":"d","dimensions":[{"field":"region"}],"measures":[{"field":"revenue","agg":"sum"},{"field":"orders","agg":"count"}],"sort":[{"by":"revenue","desc":true}]}`,
			`[["华北",9999999999999.99,1],["华南",350.25,2],["华东",300.50,2]]`},
		{"no dimensions gives one row",
			`{"version":1,"dataset":"d","measures":[{"field":"orders","agg":"count"},{"field":"buyers","agg":"count_distinct"}]}`,
			`[[5,3]]`},
		{"filtered measure, expression measure and ad hoc measure",
			`{"version":1,"dataset":"d","dimensions":[{"field":"region"}],"measures":[{"field":"paid_revenue","agg":"sum"},{"field":"avg_order"},{"alias":"units","field":"qty","agg":"sum"}],"filter":{"field":"region","op":"eq","value":"华南"}}`,
			`[["华南",50.00,175.125,8]]`},
		{"calculated field as a dimension",
			`{"version":1,"dataset":"d","dimensions":[{"field":"tier"}],"measures":[{"field":"orders","agg":"count"}]}`,
			`[["high",3],["low",2]]`},
		{"dimensions only lists distinct values in a stable order",
			`{"version":1,"dataset":"d","dimensions":[{"field":"status"}]}`,
			`[["paid"],["refunded"]]`},
		{"having on a measure of the query",
			`{"version":1,"dataset":"d","dimensions":[{"field":"qty"}],"measures":[{"field":"orders","agg":"count"}],"having":{"field":"orders","op":"gte","value":2}}`,
			`[[1,2]]`},
		{"in, not and or",
			`{"version":1,"dataset":"d","measures":[{"field":"orders","agg":"count"}],"filter":{"op":"and","args":[{"field":"region","op":"in","value":["华东","华南"]},{"op":"not","args":[{"op":"or","args":[{"field":"status","op":"eq","value":"refunded"},{"field":"qty","op":"gt","value":4}]}]}]}}`,
			`[[2]]`},
		{"an empty in-list matches nothing",
			`{"version":1,"dataset":"d","measures":[{"field":"orders","agg":"count"}],"filter":{"field":"region","op":"in","value":[]}}`,
			`[[0]]`},
		{"contains treats % and _ literally",
			`{"version":1,"dataset":"d","dimensions":[{"field":"note"}],"filter":{"op":"or","args":[{"field":"note","op":"contains","value":"%"},{"field":"note","op":"contains","value":"_"}]}}`,
			`[["50% off"],["a_b"]]`},
		{"starts_with, ends_with, between and null checks",
			`{"version":1,"dataset":"d","dimensions":[{"field":"order_id"}],"filter":{"op":"or","args":[{"field":"note","op":"starts_with","value":"ax"},{"field":"note","op":"ends_with","value":"_b"},{"op":"and","args":[{"field":"note","op":"is_null"},{"field":"amount","op":"between","value":[100,"250.00"]}]}]}}`,
			`[[2],[3],[4]]`},
		{"not_contains leaves out nulls, as SQL does",
			`{"version":1,"dataset":"d","dimensions":[{"field":"order_id"}],"filter":{"field":"note","op":"not_contains","value":"x"}}`,
			`[[1],[3]]`},
		{"the escape character itself matches literally",
			`{"version":1,"dataset":"d","measures":[{"field":"orders","agg":"count"}],"filter":{"op":"or","args":[{"field":"note","op":"contains","value":"!"},{"field":"note","op":"contains","value":"0!%"}]}}`,
			`[[0]]`},
		{"a hostile value is only ever data",
			`{"version":1,"dataset":"d","measures":[{"field":"orders","agg":"count"}],"filter":{"field":"region","op":"eq","value":"x'; DROP TABLE orders; --"}}`,
			`[[0]]`},
		{"a backslash in a value is only ever data",
			`{"version":1,"dataset":"d","measures":[{"field":"orders","agg":"count"}],"filter":{"op":"or","args":[{"field":"note","op":"contains","value":"\\"},{"field":"region","op":"eq","value":"\\' OR 1=1 -- "}]}}`,
			`[[0]]`},
	}
	for _, tt := range tests {
		expect(t, tt.name, tg.run(t, tg.options(), tg.spec(), tt.query), tt.want)
	}

	// Column metadata comes from the dataset; dimension types as declared.
	r := tg.run(t, tg.options(), tg.spec(), `{"version":1,"dataset":"d","dimensions":[{"field":"created","grain":"month","alias":"month"}],"measures":[{"field":"revenue","agg":"sum"},{"field":"orders","agg":"count"},{"field":"amount","agg":"count","alias":"amount_count"}]}`)
	// The count of an amount is not an amount, so it does not take its format.
	want := []query.Column{
		{Name: "month", Type: datasource.Timestamp, Role: "dimension", Label: "下单时间", Grain: dialect.Month},
		{Name: "revenue", Type: datasource.Decimal, Role: "measure", Label: "销售额", Format: money, Agg: "sum"},
		{Name: "orders", Type: datasource.Integer, Role: "measure", Label: "订单数", Agg: "count"},
		{Name: "amount_count", Type: datasource.Integer, Role: "measure", Label: "金额", Agg: "count"},
	}
	if !reflect.DeepEqual(r.Columns, want) {
		t.Errorf("columns:\n got %+v\nwant %+v", r.Columns, want)
	}
	// Decimals travel as strings, so that no digit is lost on the way.
	if s, ok := r.Rows[2][1].(string); !ok || !strings.HasPrefix(s, "10000000000049.99") {
		t.Errorf("a large decimal sum arrived as %T %v, want the string 10000000000049.99", r.Rows[2][1], r.Rows[2][1])
	}
}

func zonesAndGrains(t *testing.T, tg Target) {
	monthly := func(field, zone string) *query.Result {
		return tg.run(t, tg.options(), tg.spec(), fmt.Sprintf(
			`{"version":1,"dataset":"d","dimensions":[{"field":%q,"grain":"month","alias":"m"}],"measures":[{"field":"orders","agg":"count"}],"timezone":%q}`, field, zone))
	}
	// Orders 1 and 2 straddle midnight on 1 Feb in Shanghai. Seen from UTC both
	// fall in January; seen from Tokyo both fall in February.
	want := map[string]string{
		"Asia/Shanghai": `[["2026-01-01T00:00:00",1],["2026-02-01T00:00:00",2],["2026-03-01T00:00:00",2]]`,
		"UTC":           `[["2026-01-01T00:00:00",2],["2026-02-01T00:00:00",1],["2026-03-01T00:00:00",2]]`,
		"Asia/Tokyo":    `[["2026-02-01T00:00:00",3],["2026-03-01T00:00:00",2]]`,
	}
	for zone, expected := range want {
		// A column stored without a zone and one stored as an instant must agree.
		for _, field := range []string{"created", "paid"} {
			expect(t, field+" by month in "+zone, monthly(field, zone), expected)
		}
	}

	grains := map[string]string{
		"year":    `[["2026-01-01T00:00:00",5]]`,
		"quarter": `[["2026-01-01T00:00:00",5]]`,
		"day":     `[["2026-01-31T00:00:00",1],["2026-02-01T00:00:00",1],["2026-02-15T00:00:00",1],["2026-03-08T00:00:00",1],["2026-03-09T00:00:00",1]]`,
		"hour":    `[["2026-01-31T23:00:00",1],["2026-02-01T00:00:00",1],["2026-02-15T12:00:00",1],["2026-03-08T10:00:00",1],["2026-03-09T10:00:00",1]]`,
		"minute":  `[["2026-01-31T23:30:00",1],["2026-02-01T00:30:00",1],["2026-02-15T12:00:00",1],["2026-03-08T10:00:00",1],["2026-03-09T10:00:00",1]]`,
	}
	for grain, expected := range grains {
		q := fmt.Sprintf(`{"version":1,"dataset":"d","dimensions":[{"field":"created","grain":%q,"alias":"g"}],"measures":[{"field":"orders","agg":"count"}]}`, grain)
		expect(t, "created by "+grain, tg.run(t, tg.options(), tg.spec(), q), expected)
	}
	dateGrains := map[string]string{
		"year":    `[["2026-01-01",5]]`,
		"quarter": `[["2026-01-01",5]]`,
		"month":   `[["2026-01-01",1],["2026-02-01",2],["2026-03-01",2]]`,
	}
	for grain, expected := range dateGrains {
		q := fmt.Sprintf(`{"version":1,"dataset":"d","dimensions":[{"field":"order_date","grain":%q,"alias":"g"}],"measures":[{"field":"orders","agg":"count"}]}`, grain)
		expect(t, "order_date by "+grain, tg.run(t, tg.options(), tg.spec(), q), expected)
	}

	weekly := `{"version":1,"dataset":"d","dimensions":[{"field":"order_date","grain":"week","alias":"w"}],"measures":[{"field":"orders","agg":"count"}],"filter":{"field":"order_date","op":"gte","value":"2026-03-01"}}`
	opt := tg.options()
	expect(t, "weeks starting Monday", tg.run(t, opt, tg.spec(), weekly), `[["2026-03-02",1],["2026-03-09",1]]`)
	opt.WeekStart = dialect.Sunday
	expect(t, "weeks starting Sunday", tg.run(t, opt, tg.spec(), weekly), `[["2026-03-08",2]]`)
	weeklyTS := `{"version":1,"dataset":"d","dimensions":[{"field":"created","grain":"week","alias":"w"}],"measures":[{"field":"orders","agg":"count"}],"filter":{"field":"created","op":"gte","value":"2026-03-01"}}`
	expect(t, "timestamp weeks starting Sunday", tg.run(t, opt, tg.spec(), weeklyTS), `[["2026-03-08T00:00:00",2]]`)
	opt.WeekStart = dialect.Monday
	expect(t, "timestamp weeks starting Monday", tg.run(t, opt, tg.spec(), weeklyTS), `[["2026-03-02T00:00:00",1],["2026-03-09T00:00:00",1]]`)

	// Detail rows show timestamps in the query zone, however the column is stored.
	detail := `{"version":1,"dataset":"d","mode":"detail","columns":["created","paid","order_date"],"filter":{"field":"order_id","op":"eq","value":1},"timezone":"UTC"}`
	expect(t, "detail in UTC", tg.run(t, tg.options(), tg.spec(), detail), `[["2026-01-31T15:30:00","2026-01-31T15:30:00","2026-01-31"]]`)
	// A timestamp filter value is wall-clock time in the query zone.
	cutoff := `{"version":1,"dataset":"d","measures":[{"field":"orders","agg":"count"}],"filter":{"field":%q,"op":"lt","value":"2026-01-31T16:00:00"},"timezone":%q}`
	for _, field := range []string{"created", "paid"} {
		for zone, want := range map[string]string{"UTC": `[[1]]`, "Asia/Shanghai": `[[0]]`} {
			expect(t, field+" < 16:00 in "+zone, tg.run(t, tg.options(), tg.spec(), fmt.Sprintf(cutoff, field, zone)), want)
		}
	}

	// The earliest and latest of a time are written in the query zone, as the
	// rows they come from are: order 1 is the earliest, order 5 the latest. So
	// is a metric that is a time.
	spec := tg.spec()
	spec.Fields = append(spec.Fields, dataset.Field{Key: "last_paid", Label: "最后支付", Expr: "MAX(${paid})", Syntax: dataset.Standard, Type: datasource.Timestamp, Role: dataset.Metric})
	if err := spec.Validate(); err != nil {
		t.Fatal(err)
	}
	extremes := `{"version":1,"dataset":"d","measures":[{"field":"created","agg":"min","alias":"a"},{"field":"created","agg":"max","alias":"b"},{"field":"paid","agg":"min","alias":"c"},{"field":"paid","agg":"max","alias":"d"},{"field":"last_paid"}],"timezone":%q}`
	for zone, want := range map[string]string{
		"UTC":        `[["2026-01-31T15:30:00","2026-03-09T02:00:00","2026-01-31T15:30:00","2026-03-09T02:00:00","2026-03-09T02:00:00"]]`,
		"Asia/Tokyo": `[["2026-02-01T00:30:00","2026-03-09T11:00:00","2026-02-01T00:30:00","2026-03-09T11:00:00","2026-03-09T11:00:00"]]`,
	} {
		expect(t, "earliest and latest in "+zone, tg.run(t, tg.options(), spec, fmt.Sprintf(extremes, zone)), want)
	}
	// Having compares the latest moment with a time in the query zone. Order
	// 5 is the latest in 华南, at 02:00 UTC, 16:00 the day before in Honolulu;
	// the condition is an hour before it. The time as written would be read
	// as a moment hours earlier, which fails it. The same holds when a
	// percentage beside it has the groups aggregated in a statement of their own.
	latest := `{"version":1,"dataset":"d","dimensions":[{"field":"region"}],"measures":[{"field":%q,"agg":"max","alias":"latest"}%s],"having":{"field":"latest","op":"gte","value":"2026-03-08T15:00:00"},"timezone":"Pacific/Honolulu"}`
	// Sorted by it, the regions go by their latest moment: the two latest.
	top := `{"version":1,"dataset":"d","dimensions":[{"field":"region"}],"measures":[{"field":%q,"agg":"max","alias":"latest"}%s],"sort":[{"by":"latest","desc":true}],"limit":2,"timezone":"UTC"}`
	share := `,{"field":"qty","agg":"sum","compute":{"type":"percent_of_total"}}`
	for _, field := range []string{"created", "paid"} {
		expect(t, "having on the latest "+field, tg.run(t, tg.options(), tg.spec(), fmt.Sprintf(latest, field, "")), `[["华南","2026-03-08T16:00:00"]]`)
		expect(t, "having on the latest "+field+" beside a percentage", tg.run(t, tg.options(), tg.spec(), fmt.Sprintf(latest, field, share)), `[["华南","2026-03-08T16:00:00",0.66666667]]`)
		expect(t, "top by the latest "+field, tg.run(t, tg.options(), tg.spec(), fmt.Sprintf(top, field, "")), `[["华南","2026-03-09T02:00:00"],["华北","2026-03-08T02:00:00"]]`)
		expect(t, "top by the latest "+field+" beside a percentage", tg.run(t, tg.options(), tg.spec(), fmt.Sprintf(top, field, share)), `[["华南","2026-03-09T02:00:00",0.66666667],["华北","2026-03-08T02:00:00",0.08333333]]`)
	}

	// A total is a query of its own, which writes the latest the same way.
	q := parse(t, `{"version":1,"dataset":"d","dimensions":[{"field":"region"}],"measures":[{"field":"created","agg":"max","alias":"latest"},{"field":"qty","agg":"sum"}],"timezone":"UTC"}`)
	total := q.TotalQuery(nil)
	compiled, err := query.Compile(&total, tg.spec(), tg.options())
	if err != nil {
		t.Fatal(err)
	}
	result, err := query.Run(context.Background(), tg.Conn, compiled)
	if err != nil {
		t.Fatalf("run: %v\n%s", err, compiled.SQL)
	}
	expect(t, "the latest in a total", result, `[["2026-03-09T02:00:00",12]]`)

	// Of no rows there is no earliest or latest, nor least amount, on any
	// database. West of UTC a time of 0 would not even stay in 1970.
	none := `{"version":1,"dataset":"d","measures":[{"field":"created","agg":"max","alias":"a"},{"field":"paid","agg":"min","alias":"b"},{"field":"last_paid"},{"field":"amount","agg":"min","alias":"c"}],"filter":{"field":"order_id","op":"lt","value":0},"timezone":"Pacific/Honolulu"}`
	expect(t, "the latest of no rows", tg.run(t, tg.options(), spec, none), `[[null,null,null,null]]`)
}

func timeRanges(t *testing.T, tg Target) {
	tests := []struct{ name, field, timeRange, want string }{
		{"last complete month", "created", `{"last":{"n":1,"unit":"month"}}`, `[[2],[3]]`},
		{"last two months including this one", "created", `{"last":{"n":2,"unit":"month"},"includeCurrent":true}`, `[[2],[3],[4],[5]]`},
		{"this week", "created", `{"current":"week"}`, `[[5]]`},
		{"this year", "created", `{"current":"year"}`, `[[1],[2],[3],[4],[5]]`},
		{"explicit range, end exclusive", "created", `{"start":"2026-02-01","end":"2026-02-15T12:00:00"}`, `[[2]]`},
		{"open start", "created", `{"end":"2026-02-01"}`, `[[1]]`},
		{"on a date field", "order_date", `{"start":"2026-02-01","end":"2026-03-09"}`, `[[2],[3],[4]]`},
		{"on a field stored as an instant", "paid", `{"last":{"n":1,"unit":"month"}}`, `[[2],[3]]`},
	}
	for _, tt := range tests {
		q := `{"version":1,"dataset":"d","dimensions":[{"field":"order_id"}],"filter":{"field":"` + tt.field + `","op":"time","value":` + tt.timeRange + `}}`
		expect(t, tt.name, tg.run(t, tg.options(), tg.spec(), q), tt.want)
	}
	// "This month" depends on the zone. At 03:00 UTC on 1 March it is already
	// March in Shanghai, but still February in Honolulu, where February runs
	// from 18:00 on 1 Feb to 18:00 on 1 Mar Shanghai time: order 2 (00:30 on
	// 1 Feb) falls just before it, order 3 inside it.
	opt := tg.options()
	opt.Now = time.Date(2026, 3, 1, 3, 0, 0, 0, time.UTC)
	q := `{"version":1,"dataset":"d","dimensions":[{"field":"order_id"}],"filter":{"field":"created","op":"time","value":{"current":"month"}},"timezone":%q}`
	for zone, want := range map[string]string{"Asia/Shanghai": `[[4],[5]]`, "Pacific/Honolulu": `[[3]]`} {
		expect(t, "current month in "+zone, tg.run(t, opt, tg.spec(), fmt.Sprintf(q, zone)), want)
	}
}

func sourceParams(t *testing.T, tg Target) {
	spec := tg.spec()
	spec.Source = dataset.Source{Type: "sql", SQL: "SELECT * FROM " + tg.QualifiedName +
		" WHERE order_date >= {{since}} [[ AND region IN {{regions}} ]] [[ AND qty >= {{min_qty}} ]];"}
	spec.Params = []dataset.Param{
		{Name: "since", Type: datasource.Date, Required: true, Default: map[string]any{"relative": "today-30d"}},
		{Name: "regions", Type: datasource.String, Multi: true},
		{Name: "min_qty", Type: datasource.Integer},
	}
	if err := spec.Validate(); err != nil {
		t.Fatal(err)
	}
	// The source's parameters come before the query's filter and HAVING in
	// the SQL text, which exercises the numbering of placeholders.
	base := `{"version":1,"dataset":"d","dimensions":[{"field":"order_id"}],"measures":[{"field":"paid_revenue","agg":"sum"}],"having":{"field":"paid_revenue","op":"gt","value":0},"filter":{"field":"status","op":"eq","value":"paid"}`
	tests := []struct{ name, params, want string }{
		{"default is today-30d in the query zone (2026-02-08)", ``, `[[4,9999999999999.99],[5,50]]`},
		{"explicit value", `,"params":{"since":"2026-01-01"}`, `[[1,100.5],[2,200],[4,9999999999999.99],[5,50]]`},
		{"optional blocks", `,"params":{"since":"2026-01-01","regions":["华东","华北"],"min_qty":2}`, `[[2,200]]`},
		{"an empty list drops the block", `,"params":{"since":"2026-01-01","regions":[]}`, `[[1,100.5],[2,200],[4,9999999999999.99],[5,50]]`},
	}
	for _, tt := range tests {
		expect(t, tt.name, tg.run(t, tg.options(), spec, base+tt.params+"}"), tt.want)
	}

	failures := map[string]string{
		`,"params":{"nope":1}`:               "unknown_param",
		`,"params":{"since":"yesterday"}`:    "invalid_param_value",
		`,"params":{"since":["2026-01-01"]}`: "invalid_param_value",
		`,"params":{"min_qty":"2; DELETE"}`:  "invalid_param_value",
		`,"params":{"regions":["华东",7]}`:     "invalid_param_value",
	}
	for params, want := range failures {
		_, err := query.Compile(parse(t, base+params+"}"), spec, tg.options())
		var specErr *dataset.Error
		if !errors.As(err, &specErr) || specErr.Code != want {
			t.Errorf("%s: err = %v, want %s", params, err, want)
		}
	}
}

func rowFilter(t *testing.T, tg Target) {
	opt := tg.options()
	opt.RowFilter = &dataset.Filter{Field: "region", Op: "eq", Value: "华东"}
	// The query tries to reach other regions with OR; the row filter still applies.
	q := `{"version":1,"dataset":"d","dimensions":[{"field":"region"}],"measures":[{"field":"orders","agg":"count"}],"filter":{"op":"or","args":[{"field":"region","op":"eq","value":"华北"},{"field":"qty","op":"gte","value":0}]}}`
	expect(t, "row filter", tg.run(t, opt, tg.spec(), q), `[["华东",2]]`)
	// Whoever may see no row gets none, and a total of none.
	opt.RowFilter = &dataset.Filter{Op: "false"}
	expect(t, "no rows", tg.run(t, opt, tg.spec(), q), `[]`)
	expect(t, "no rows in a total", tg.run(t, opt, tg.spec(), `{"version":1,"dataset":"d","measures":[{"field":"orders","agg":"count"}]}`), `[[0]]`)
}

// A column can be called anything the database lets it be: in another
// script, with spaces, with the characters each database quotes names with.
// A field names its column as the source does, and the dialect quotes it.
func columnNames(t *testing.T, tg Target) {
	quote := tg.Conn.Dialect().QuoteIdent
	names := []string{"订单id", "订单 金额 (元)", "Mixed Case", `it's "so" ` + "`called`"}
	spec := tg.spec()
	spec.Source = dataset.Source{Type: "sql", SQL: "SELECT id AS " + quote(names[0]) + ", amount AS " + quote(names[1]) + ", region AS " + quote(names[2]) + ", qty AS " + quote(names[3]) + " FROM " + tg.QualifiedName}
	spec.Fields = []dataset.Field{
		{Key: "id", Label: "订单", Column: names[0], Type: datasource.Integer, Role: dataset.Dimension},
		{Key: "amount", Label: "金额", Column: names[1], Type: datasource.Decimal, Role: dataset.MeasureRole},
		{Key: "region", Label: "地区", Column: names[2], Type: datasource.String, Role: dataset.Dimension},
		{Key: "qty", Label: "件数", Column: names[3], Type: datasource.Integer, Role: dataset.MeasureRole},
		// An expression reaches such a column through the field that reads it.
		{Key: "double", Label: "两倍", Expr: "${qty} * 2", Type: datasource.Integer, Role: dataset.MeasureRole},
	}
	if err := spec.Validate(); err != nil {
		t.Fatal(err)
	}
	q := `{"version":1,"dataset":"d","dimensions":[{"field":"region"}],"measures":[{"field":"qty","agg":"sum"},{"field":"double","agg":"sum"}],"filter":{"field":"id","op":"lte","value":3}}`
	expect(t, "grouped, aggregated and filtered by them", tg.run(t, tg.options(), spec, q), `[["华东",3,6],["华南",3,6]]`)
	q = `{"version":1,"dataset":"d","mode":"detail","columns":["id","amount"],"filter":{"field":"id","op":"eq","value":1}}`
	expect(t, "read as they are", tg.run(t, tg.options(), spec, q), `[[1,100.5]]`)
}

func detailAndLimits(t *testing.T, tg Target) {
	r := tg.run(t, tg.options(), tg.spec(), `{"version":1,"dataset":"d","mode":"detail","columns":["order_id","amount","note"],"sort":[{"by":"order_id","desc":true}],"limit":2,"offset":1}`)
	expect(t, "detail page", r, `[[4,9999999999999.99,"axb"],[3,300.25,"a_b"]]`)
	if !r.Meta.Truncated {
		t.Error("a page with more rows after it should be marked truncated")
	}
	r = tg.run(t, tg.options(), tg.spec(), `{"version":1,"dataset":"d","mode":"detail","columns":["order_id"],"limit":5}`)
	if len(r.Rows) != 5 || r.Meta.Truncated {
		t.Errorf("exactly at the limit: %d rows, truncated=%v", len(r.Rows), r.Meta.Truncated)
	}
	opt := tg.options()
	opt.MaxLimit = 3
	r = tg.run(t, opt, tg.spec(), `{"version":1,"dataset":"d","mode":"detail","columns":["order_id"],"limit":100}`)
	if len(r.Rows) != 3 || !r.Meta.Truncated {
		t.Errorf("server maximum: %d rows, truncated=%v", len(r.Rows), r.Meta.Truncated)
	}
	// A null stays a null.
	r = tg.run(t, tg.options(), tg.spec(), `{"version":1,"dataset":"d","mode":"detail","columns":["note"],"filter":{"field":"order_id","op":"eq","value":2}}`)
	if len(r.Rows) != 1 || r.Rows[0][0] != nil {
		t.Errorf("null note = %#v", r.Rows)
	}
}
