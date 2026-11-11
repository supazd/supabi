package query

// Tests here need no database: they cover what the compiler refuses and how it
// orders arguments. What queries return is covered for every database by
// internal/conformance.

import (
	"encoding/json"
	"errors"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/dialect"
)

func options() Options {
	return Options{
		Dialect:      dialect.Postgres{},
		Now:          time.Date(2026, 3, 10, 9, 0, 0, 0, time.UTC),
		Timezone:     "Asia/Shanghai",
		WeekStart:    dialect.Monday,
		DefaultLimit: 1000,
		MaxLimit:     5000,
	}
}

// parse reads a query the way the API will: from JSON, rejecting unknown keys.
func parse(t *testing.T, body string) *Query {
	t.Helper()
	dec := json.NewDecoder(strings.NewReader(body))
	dec.DisallowUnknownFields()
	q := &Query{}
	if err := dec.Decode(q); err != nil {
		t.Fatalf("invalid test query: %v\n%s", err, body)
	}
	return q
}

func errCode(err error) string {
	var e *dataset.Error
	if errors.As(err, &e) {
		return e.Code
	}
	if err != nil {
		return "other: " + err.Error()
	}
	return ""
}

// These need no database: a query that is wrong must never reach one.
func TestCompileErrors(t *testing.T) {
	spec := &dataset.Spec{
		SpecVersion: 1,
		Source:      dataset.Source{Type: "table", Table: "orders"},
		Fields: []dataset.Field{
			{Key: "region", Label: "region", Column: "region", Type: datasource.String, Role: dataset.Dimension},
			{Key: "amount", Label: "amount", Column: "amount", Type: datasource.Decimal, Role: dataset.Dimension},
			{Key: "day", Label: "day", Column: "day", Type: datasource.Date, Role: dataset.Dimension},
			{Key: "revenue", Label: "revenue", Column: "amount", Type: datasource.Decimal, Role: dataset.MeasureRole},
			{Key: "share", Label: "share", Expr: "SUM(${amount}) / 100", Type: datasource.Decimal, Role: dataset.Metric},
		},
	}
	if err := spec.Validate(); err != nil {
		t.Fatal(err)
	}
	tests := map[string]string{
		`{"version":2,"dataset":"d","measures":[{"field":"revenue","agg":"sum"}]}`: "unsupported_query_version",
		`{"version":1,"dataset":"d"}`: "empty_query",
		`{"version":1,"dataset":"d","mode":"pivot","measures":[{"field":"revenue","agg":"sum"}]}`:                                                                         "invalid_query",
		`{"version":1,"dataset":"d","mode":"detail","columns":["region"],"measures":[{"field":"revenue","agg":"sum"}]}`:                                                   "invalid_query",
		`{"version":1,"dataset":"d","dimensions":[{"field":"nope"}]}`:                                                                                                     "unknown_field",
		`{"version":1,"dataset":"d","measures":[{"field":"region"}]}`:                                                                                                     "agg_required",
		`{"version":1,"dataset":"d","measures":[{"field":"revenue"}]}`:                                                                                                    "agg_required",
		`{"version":1,"dataset":"d","measures":[{"agg":"sum"}]}`:                                                                                                          "invalid_measure",
		`{"version":1,"dataset":"d","measures":[{"field":"nope"}]}`:                                                                                                       "unknown_field",
		`{"version":1,"dataset":"d","dimensions":[{"field":"share"}]}`:                                                                                                    "metric_field",
		`{"version":1,"dataset":"d","mode":"detail","columns":["share"]}`:                                                                                                 "metric_field",
		`{"version":1,"dataset":"d","measures":[{"alias":"x","field":"share","agg":"sum"}]}`:                                                                              "metric_agg",
		`{"version":1,"dataset":"d","measures":[{"field":"share"}],"filter":{"field":"share","op":"gt","value":1}}`:                                                       "metric_field",
		`{"version":1,"dataset":"d","dimensions":[{"field":"region","grain":"month"}]}`:                                                                                   "grain_needs_time",
		`{"version":1,"dataset":"d","dimensions":[{"field":"day","grain":"hour"}]}`:                                                                                       "invalid_grain",
		`{"version":1,"dataset":"d","dimensions":[{"field":"day","grain":"decade"}]}`:                                                                                     "invalid_grain",
		`{"version":1,"dataset":"d","dimensions":[{"field":"day","grain":"month"},{"field":"day","grain":"year"}]}`:                                                       "duplicate_alias",
		`{"version":1,"dataset":"d","dimensions":[{"field":"region","alias":"x\" FROM pg_user --"}]}`:                                                                     "invalid_alias",
		`{"version":1,"dataset":"d","measures":[{"field":"amount","agg":"sum"},{"field":"amount","agg":"avg"}]}`:                                                          "duplicate_alias",
		`{"version":1,"dataset":"d","measures":[{"field":"amount","agg":"sum"},{"field":"amount","agg":"avg","alias":"mean"}]}`:                                           "",
		`{"version":1,"dataset":"d","measures":[{"alias":"x","field":"region","agg":"sum"}]}`:                                                                             "agg_needs_number",
		`{"version":1,"dataset":"d","measures":[{"alias":"x","field":"amount","agg":"median"}]}`:                                                                          "invalid_agg",
		`{"version":1,"dataset":"d","measures":[{"field":"revenue","agg":"sum","compute":{"type":"rank"}}]}`:                                                              "compute_not_supported",
		`{"version":1,"dataset":"d","measures":[{"field":"revenue","agg":"sum"}],"sort":[{"by":"amount"}]}`:                                                               "unknown_sort_column",
		`{"version":1,"dataset":"d","measures":[{"field":"revenue","agg":"sum"}],"having":{"field":"amount","op":"gt","value":1}}`:                                        "unknown_output_measure",
		`{"version":1,"dataset":"d","measures":[{"field":"revenue","agg":"sum"}],"filter":{"field":"nope","op":"gt","value":1}}`:                                          "unknown_field",
		`{"version":1,"dataset":"d","measures":[{"field":"revenue","agg":"sum"}],"filter":{"field":"amount","op":"like","value":"1"}}`:                                    "invalid_filter_value",
		`{"version":1,"dataset":"d","measures":[{"field":"revenue","agg":"sum"}],"filter":{"field":"amount","op":"eq","value":"abc"}}`:                                    "invalid_filter_value",
		`{"version":1,"dataset":"d","measures":[{"field":"revenue","agg":"sum"}],"filter":{"field":"amount","op":"contains","value":"1"}}`:                                "invalid_filter_value",
		`{"version":1,"dataset":"d","measures":[{"field":"revenue","agg":"sum"}],"filter":{"field":"day","op":"eq","value":"2026-13-01"}}`:                                "invalid_filter_value",
		`{"version":1,"dataset":"d","measures":[{"field":"revenue","agg":"sum"}],"filter":{"op":"and","args":[]}}`:                                                        "invalid_filter",
		`{"version":1,"dataset":"d","measures":[{"field":"revenue","agg":"sum"}],"filter":{"field":"region","op":"time","value":{"current":"month"}}}`:                    "time_field_required",
		`{"version":1,"dataset":"d","measures":[{"field":"revenue","agg":"sum"}],"filter":{"field":"day","op":"time","value":"2026-01-01"}}`:                              "invalid_time_range",
		`{"version":1,"dataset":"d","measures":[{"field":"revenue","agg":"sum"}],"filter":{"field":"day","op":"time","value":{}}}`:                                        "invalid_time_range",
		`{"version":1,"dataset":"d","measures":[{"field":"revenue","agg":"sum"}],"filter":{"field":"day","op":"time","value":{"dimension":"day","current":"month"}}}`:     "invalid_time_range",
		`{"version":1,"dataset":"d","measures":[{"field":"revenue","agg":"sum"}],"filter":{"field":"day","op":"time","value":{"current":"month","start":"2026-01-01"}}}`:  "invalid_time_range",
		`{"version":1,"dataset":"d","measures":[{"field":"revenue","agg":"sum"}],"filter":{"field":"day","op":"time","value":{"start":"2026-02-01","end":"2026-01-01"}}}`: "invalid_time_range",
		`{"version":1,"dataset":"d","measures":[{"field":"revenue","agg":"sum"}],"having":{"field":"revenue","op":"time","value":{"current":"month"}}}`:                   "time_field_required",
		`{"version":1,"dataset":"d","measures":[{"field":"revenue","agg":"sum"}],"timezone":"Mars/Olympus"}`:                                                              "invalid_timezone",
		`{"version":1,"dataset":"d","measures":[{"field":"revenue","agg":"sum"}],"timezone":"UTC' ; --"}`:                                                                 "invalid_timezone",
		`{"version":1,"dataset":"d","measures":[{"field":"revenue","agg":"sum"}],"limit":0}`:                                                                              "invalid_query",
		`{"version":1,"dataset":"d","measures":[{"field":"revenue","agg":"sum"}],"offset":-1}`:                                                                            "invalid_query",
	}
	for body, want := range tests {
		_, err := Compile(parse(t, body), spec, options())
		if got := errCode(err); got != want {
			t.Errorf("%s\n  got %q, want %q", body, got, want)
		}
	}
}

// A measure column is labelled like its field, so it says how it was
// aggregated, by default or for this query; a metric's column does not.
func TestMeasureColumnNamesItsAggregation(t *testing.T) {
	spec := &dataset.Spec{
		SpecVersion: 1,
		Source:      dataset.Source{Type: "table", Table: "orders"},
		Fields: []dataset.Field{
			{Key: "amount", Label: "amount", Column: "amount", Type: datasource.Decimal, Role: dataset.MeasureRole},
			{Key: "share", Label: "share", Expr: "SUM(${amount}) / 100", Type: datasource.Decimal, Role: dataset.Metric},
		},
	}
	c, err := Compile(parse(t, `{"version":1,"dataset":"d","measures":[{"field":"amount","agg":"sum"},{"alias":"top","field":"amount","agg":"max"},{"field":"share"}]}`), spec, options())
	if err != nil {
		t.Fatal(err)
	}
	if got := []dataset.Agg{c.Columns[0].Agg, c.Columns[1].Agg, c.Columns[2].Agg}; got[0] != dataset.Sum || got[1] != dataset.Max || got[2] != "" {
		t.Errorf("got %q, want [\"sum\" \"max\" \"\"]", got)
	}
}

// A dimension's column says what its dates were truncated to, so that they
// can be written to that grain; the latest of the dates takes their format.
func TestDateColumns(t *testing.T) {
	written := &dataset.Format{Date: "chinese", Time: "minute"}
	spec := &dataset.Spec{
		SpecVersion: 1,
		Source:      dataset.Source{Type: "table", Table: "orders"},
		Fields: []dataset.Field{
			{Key: "created", Label: "created", Column: "created_at", Type: datasource.Timestamp, Role: dataset.Dimension, Format: written},
			{Key: "region", Label: "region", Column: "region", Type: datasource.String, Role: dataset.Dimension},
		},
	}
	c, err := Compile(parse(t, `{"version":1,"dataset":"d","dimensions":[{"field":"created","grain":"week","alias":"week"},{"field":"region"}],"measures":[{"field":"created","agg":"max","alias":"latest"},{"field":"created","agg":"count","alias":"n"}]}`), spec, options())
	if err != nil {
		t.Fatal(err)
	}
	if got := []dialect.Grain{c.Columns[0].Grain, c.Columns[1].Grain, c.Columns[2].Grain}; got[0] != dialect.Week || got[1] != "" || got[2] != "" {
		t.Errorf("grains: got %q, want [\"week\" \"\" \"\"]", got)
	}
	if c.Columns[0].Format != written || c.Columns[2].Format != written || c.Columns[3].Format != nil {
		t.Errorf("formats: got %v %v %v, want the field's on the week and the latest, none on the count", c.Columns[0].Format, c.Columns[2].Format, c.Columns[3].Format)
	}
}

// The latest of a time is written in the query zone, as the time itself is
// when grouped by. It is the latest moment that is written: having compares
// moments, so it is given the aggregate before it is written.
func TestTimeMeasuresInQueryZone(t *testing.T) {
	spec := &dataset.Spec{
		SpecVersion: 1,
		Source:      dataset.Source{Type: "table", Table: "orders"},
		Fields: []dataset.Field{
			{Key: "created", Label: "created", Column: "created_at", Type: datasource.Timestamp, Role: dataset.Dimension},
			{Key: "region", Label: "region", Column: "region", Type: datasource.String, Role: dataset.Dimension},
			{Key: "qty", Label: "qty", Column: "qty", Type: datasource.Integer, Role: dataset.MeasureRole},
			{Key: "last_seen", Label: "last seen", Expr: "MAX(${created})", Type: datasource.Timestamp, Role: dataset.Metric},
		},
	}
	const (
		latest   = `((MAX(t."created_at"))::timestamptz AT TIME ZONE 'UTC') AS "latest"`
		earliest = `((MIN(t."created_at"))::timestamptz AT TIME ZONE 'UTC') AS "earliest"`
		metric   = `(((MAX((t."created_at"))))::timestamptz AT TIME ZONE 'UTC') AS "last_seen"`
		count    = `COUNT(t."created_at") AS "n"`
	)
	measures := `"measures":[{"field":"created","agg":"max","alias":"latest"},{"field":"created","agg":"min","alias":"earliest"},{"field":"last_seen"},{"field":"created","agg":"count","alias":"n"}]`
	contains := func(c *Compiled, wants ...string) {
		t.Helper()
		for _, want := range wants {
			if !strings.Contains(c.SQL, want) {
				t.Errorf("missing %s in:\n%s", want, c.SQL)
			}
		}
	}
	c, err := Compile(parse(t, `{"version":1,"dataset":"d","dimensions":[{"field":"region"}],`+measures+`,"having":{"field":"latest","op":"gte","value":"2026-03-01"},"sort":[{"by":"latest","desc":true},{"by":"n"}],"timezone":"UTC"}`), spec, options())
	if err != nil {
		t.Fatal(err)
	}
	contains(c, latest, earliest, metric, count, `HAVING (MAX(t."created_at"))::timestamptz >= $1`, `ORDER BY MAX(t."created_at") DESC, "n"`)
	if at, ok := c.Args[0].(time.Time); len(c.Args) != 1 || !ok || !at.Equal(time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)) {
		t.Errorf("args: got %#v, want 2026-03-01 UTC as a time", c.Args)
	}

	// With a percentage beside it, the groups are aggregated in a statement of
	// their own: the moment is kept there, and written by the one around it.
	c, err = Compile(parse(t, `{"version":1,"dataset":"d","dimensions":[{"field":"region"}],"measures":[{"field":"created","agg":"max","alias":"latest"},{"field":"qty","agg":"sum","compute":{"type":"percent_of_total"}}],"having":{"field":"latest","op":"gte","value":"2026-03-01"},"sort":[{"by":"latest"}],"timezone":"UTC"}`), spec, options())
	if err != nil {
		t.Fatal(err)
	}
	contains(c,
		`MAX(t."created_at") AS "latest"`,
		`((pct_rows."latest")::timestamptz AT TIME ZONE 'UTC') AS "latest"`,
		`WHERE (pct_rows."latest")::timestamptz >= $1`,
		`ORDER BY pct_rows."latest"`,
	)

	// Checking what type a field is leaves times as the database gives them.
	opt := options()
	opt.RawTimes = true
	c, err = Compile(parse(t, `{"version":1,"dataset":"d",`+measures+`}`), spec, opt)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(c.SQL, "TIME ZONE") {
		t.Errorf("times written in a zone:\n%s", c.SQL)
	}
	c, err = Compile(parse(t, `{"version":1,"dataset":"d","mode":"detail","columns":["created"]}`), spec, opt)
	if err != nil {
		t.Fatal(err)
	}
	contains(c, `SELECT t."created_at" AS "created"`)

	// ClickHouse gives the latest of no rows as 1970 unless asked otherwise.
	opt = options()
	opt.Dialect = dialect.ClickHouse{}
	c, err = Compile(parse(t, `{"version":1,"dataset":"d",`+measures+`}`), spec, opt)
	if err != nil {
		t.Fatal(err)
	}
	contains(c, "maxOrNull(t.`created_at`)", "minOrNull(t.`created_at`)", "COUNT(t.`created_at`)")
}

// A query can say what its columns are called. A label that was given is the
// whole name, so the column no longer says how it was aggregated.
func TestColumnLabels(t *testing.T) {
	spec := &dataset.Spec{
		SpecVersion: 1,
		Source:      dataset.Source{Type: "table", Table: "orders"},
		Fields: []dataset.Field{
			{Key: "region", Label: "Region", Column: "region", Type: datasource.String, Role: dataset.Dimension},
			{Key: "amount", Label: "Amount", Column: "amount", Type: datasource.Decimal, Role: dataset.MeasureRole},
		},
	}
	labels := func(body string) []string {
		t.Helper()
		c, err := Compile(parse(t, body), spec, options())
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, col := range c.Columns {
			out = append(out, col.Label+"/"+string(col.Agg))
		}
		return out
	}
	got := labels(`{"version":1,"dataset":"d","dimensions":[{"field":"region","label":"Area"}],"measures":[{"field":"amount","agg":"sum","label":"GMV"},{"field":"amount","agg":"sum","alias":"again"},{"alias":"top","label":"Largest","field":"amount","agg":"max"}]}`)
	if want := []string{"Area/", "GMV/", "Amount/sum", "Largest/"}; !slices.Equal(got, want) {
		t.Errorf("got %q, want %q", got, want)
	}
	got = labels(`{"version":1,"dataset":"d","mode":"detail","columns":["region",{"field":"amount","label":"Paid"}]}`)
	if want := []string{"Region/", "Paid/"}; !slices.Equal(got, want) {
		t.Errorf("got %q, want %q", got, want)
	}
	if _, err := Compile(parse(t, `{"version":1,"dataset":"d","measures":[{"field":"amount","agg":"sum","label":"a\nb"}]}`), spec, options()); errCode(err) != "invalid_column_label" {
		t.Errorf("got %q, want invalid_column_label", errCode(err))
	}

	// A column without a label is written as it was read: the field's key.
	q := parse(t, `{"version":1,"dataset":"d","mode":"detail","columns":["region",{"field":"amount","label":"Paid"}]}`)
	if out, _ := json.Marshal(q.Columns); string(out) != `["region",{"field":"amount","label":"Paid"}]` {
		t.Errorf("columns were written as %s", out)
	}
}

// questionMarks is a positional dialect: its placeholders carry no number, so
// arguments must come out in the order they appear in the SQL text.
type questionMarks struct{ dialect.Postgres }

func (questionMarks) Placeholder(int) string { return "?" }

func TestArgumentsFollowTextOrder(t *testing.T) {
	spec := &dataset.Spec{
		SpecVersion: 1,
		Source:      dataset.Source{Type: "sql", SQL: "SELECT * FROM orders WHERE dt = {{day}}"},
		Params:      []dataset.Param{{Name: "day", Type: datasource.Date, Required: true}},
		Fields: []dataset.Field{
			{Key: "region", Label: "region", Column: "region", Type: datasource.String, Role: dataset.Dimension},
			{Key: "paid", Label: "paid", Column: "amount", Type: datasource.Decimal, Role: dataset.MeasureRole},
		},
	}
	opt := options()
	opt.Dialect = questionMarks{}
	q := parse(t, `{"version":1,"dataset":"d","dimensions":[{"field":"region"}],"measures":[{"field":"paid","agg":"sum"}],
		"filter":{"field":"region","op":"ne","value":"x"},"having":{"field":"paid","op":"gt","value":5},"params":{"day":"2026-01-01"}}`)
	c, err := Compile(q, spec, opt)
	if err != nil {
		t.Fatal(err)
	}
	// FROM (parameter), WHERE, HAVING.
	want := []any{"2026-01-01", "x", float64(5)}
	if !reflect.DeepEqual(c.Args, want) || strings.Count(c.SQL, "?") != len(want) {
		t.Errorf("args = %v, want %v\n%s", c.Args, want, c.SQL)
	}
}

// A parameter left out of the query takes its default. Given null or an empty
// list it has none, as an empty filter restricts nothing: its [[ ]] is
// dropped, and a query whose SQL cannot do without it fails.
func TestParamGivenNoValue(t *testing.T) {
	spec := &dataset.Spec{
		SpecVersion: 1,
		Source:      dataset.Source{Type: "sql", SQL: "SELECT * FROM orders WHERE dt = {{day}} [[ AND region = {{region}} ]] [[ AND city IN {{cities}} ]]"},
		Params: []dataset.Param{
			{Name: "day", Type: datasource.Date, Default: map[string]any{"relative": "today-1d"}},
			{Name: "region", Type: datasource.String, Default: "east"},
			{Name: "cities", Type: datasource.String, Multi: true, Default: []any{"a"}},
		},
		Fields: []dataset.Field{{Key: "region", Label: "region", Column: "region", Type: datasource.String, Role: dataset.Dimension}},
	}
	compile := func(params string) (*Compiled, error) {
		return Compile(parse(t, `{"version":1,"dataset":"d","dimensions":[{"field":"region"}],"params":`+params+`}`), spec, options())
	}
	for _, tt := range []struct {
		name, params string
		want         []any
	}{
		{"defaults", `{}`, []any{"2026-03-09", "east", "a"}},
		{"none given", `{"region":null,"cities":[]}`, []any{"2026-03-09"}},
		// A list may name days relative to today, as a dropdown offers them.
		{"relative days in a list", `{"day":{"relative":"today"},"cities":["b","c"]}`, []any{"2026-03-10", "east", "b", "c"}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			c, err := compile(tt.params)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(c.Args, tt.want) {
				t.Errorf("args = %v, want %v\n%s", c.Args, tt.want, c.SQL)
			}
		})
	}
	if _, err := compile(`{"day":null}`); errCode(err) != "missing_param" {
		t.Errorf("a parameter outside [[ ]] given none: %v, want missing_param", err)
	}
	if _, err := compile(`{"cities":[{"relative":"yesterday"}]}`); errCode(err) != "invalid_param_value" {
		t.Errorf("an unreadable relative day: %v, want invalid_param_value", err)
	}
}

// A place in the statement sent to the database is traced back to the place in
// the SQL the author wrote, across parameters of any width and dropped blocks.
func TestSourceLocate(t *testing.T) {
	const written = "\n  SELECT 名称, amount FROM orders\nWHERE d >= {{since}} [[ AND region IN {{regions}} ]] [[ AND qty > {{min_qty}} ]] AND status = {{status}}\nORDER BY created ;\n"
	spec := &dataset.Spec{
		SpecVersion: 1,
		Source:      dataset.Source{Type: "sql", SQL: written},
		Params: []dataset.Param{
			{Name: "since", Type: datasource.Date, Default: "2026-01-01"},
			{Name: "regions", Type: datasource.String, Multi: true, Default: []any{"a", "b", "c"}},
			{Name: "min_qty", Type: datasource.Integer},
			{Name: "status", Type: datasource.String, Default: "paid"},
		},
	}
	for _, d := range []dialect.Dialect{dialect.Postgres{}, dialect.MySQL{}} {
		opt := options()
		opt.Dialect = d
		statement, err := SourceSQL(spec, opt)
		if err != nil {
			t.Fatal(err)
		}
		for _, word := range []string{"SELECT", "名称", "amount", "WHERE", "region", "status", "ORDER", "created"} {
			got, ok := statement.Locate(strings.LastIndex(statement.SQL, word))
			if want := strings.Index(written, word); !ok || got != want {
				t.Errorf("%s: %q is located at %d, %v; want %d\n%s", d.Name(), word, got, ok, want, statement.SQL)
			}
		}
		if strings.Contains(statement.SQL, "qty") {
			t.Errorf("%s: the block without a value was kept:\n%s", d.Name(), statement.SQL)
		}
		// What follows the author's SQL is its end; what precedes it is nowhere in it.
		if got, ok := statement.Locate(len(statement.SQL) - 1); !ok || got != strings.Index(written, ";") {
			t.Errorf("%s: the end is located at %d, %v", d.Name(), got, ok)
		}
		if _, ok := statement.Locate(3); ok {
			t.Errorf("%s: a place before the source SQL was located in it", d.Name())
		}
	}

	table, err := SourceSQL(&dataset.Spec{SpecVersion: 1, Source: dataset.Source{Type: "table", Table: "orders"}}, options())
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := table.Locate(20); ok {
		t.Error("a table source has no SQL to locate anything in")
	}
}

func TestFilterMeasures(t *testing.T) {
	spec := &dataset.Spec{
		SpecVersion: 1,
		Source:      dataset.Source{Type: "table", Table: "orders"},
		Fields: []dataset.Field{
			{Key: "region", Label: "Region", Column: "region", Type: datasource.String, Role: dataset.Dimension},
			{Key: "amount", Label: "Amount", Column: "amount", Type: datasource.Decimal, Role: dataset.MeasureRole},
			{Key: "share", Label: "Share", Expr: "SUM(${amount}) / 100", Type: datasource.Decimal, Role: dataset.Metric},
		},
	}
	q := parse(t, `{"version":1,"dataset":"d","dimensions":[{"field":"region"}],"measures":[{"field":"amount","agg":"sum"}],"filterMeasures":[{"field":"share","alias":"hidden"},{"alias":"min_region","field":"region","agg":"min"}],"having":{"op":"and","args":[{"field":"hidden","op":"gte","value":5},{"field":"min_region","op":"eq","value":"east"}]}}`)
	got, err := Compile(q, spec, options())
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Columns) != 2 || got.Columns[0].Name != "region" || got.Columns[1].Name != "amount" {
		t.Fatalf("filter aggregates leaked as output: %+v", got.Columns)
	}
	if !strings.Contains(got.SQL, `HAVING`) || !strings.Contains(got.SQL, `MIN(t."region") = $2`) || strings.Contains(got.SQL, `AS "hidden"`) {
		t.Fatalf("filter measures were not applied with correct field types: %s", got.SQL)
	}
	if !reflect.DeepEqual(got.Args, []any{float64(5), "east"}) {
		t.Fatalf("wrong bindings: %#v", got.Args)
	}

	tests := []struct{ name, body, want string }{
		{"output collision", `{"version":1,"dataset":"d","dimensions":[{"field":"region"}],"filterMeasures":[{"field":"share","alias":"region"}]}`, "duplicate_alias"},
		{"hidden collision", `{"version":1,"dataset":"d","dimensions":[{"field":"region"}],"filterMeasures":[{"field":"share","alias":"hidden"},{"field":"amount","agg":"sum","alias":"hidden"}]}`, "duplicate_alias"},
		{"invalid alias", `{"version":1,"dataset":"d","dimensions":[{"field":"region"}],"filterMeasures":[{"field":"share","alias":"bad name"}]}`, "invalid_alias"},
		{"detail rejects filter aggregate", `{"version":1,"dataset":"d","mode":"detail","columns":["region"],"filterMeasures":[{"field":"share"}]}`, "invalid_query"},
		{"hidden cannot sort", `{"version":1,"dataset":"d","dimensions":[{"field":"region"}],"filterMeasures":[{"field":"share","alias":"hidden"}],"sort":[{"by":"hidden"}]}`, "unknown_sort_column"},
		{"hidden value type checked", `{"version":1,"dataset":"d","dimensions":[{"field":"region"}],"filterMeasures":[{"field":"share","alias":"hidden"}],"having":{"field":"hidden","op":"gte","value":"oops"}}`, "invalid_filter_value"},
		// Numeric aggregates compare as decimals, as saved charts have always relied on.
		{"integer count against a fraction", `{"version":1,"dataset":"d","dimensions":[{"field":"region"}],"measures":[{"alias":"n","field":"region","agg":"count"}],"having":{"field":"n","op":"gte","value":2.5}}`, ""},
		{"integer count against text", `{"version":1,"dataset":"d","dimensions":[{"field":"region"}],"measures":[{"alias":"n","field":"region","agg":"count"}],"having":{"field":"n","op":"gte","value":"10"}}`, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := Compile(parse(t, tt.body), spec, options()); errCode(err) != tt.want {
				t.Fatalf("got %v, want %s", err, tt.want)
			}
		})
	}
}

// The form measures had before every one named its aggregation is turned
// away, rather than read as a measure of no field.
func TestAdhocMeasureRejected(t *testing.T) {
	var q Query
	err := json.Unmarshal([]byte(`{"version":1,"dataset":"d","measures":[{"alias":"n","adhoc":{"agg":"count","field":"amount"}}]}`), &q)
	if got := errCode(err); got != "invalid_measure" {
		t.Fatalf("got %q (%v), want invalid_measure", got, err)
	}
}
