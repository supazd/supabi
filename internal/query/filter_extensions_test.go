package query

import (
	"reflect"
	"strings"
	"testing"

	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/dialect"
)

func extensionDataset() *dataset.Spec {
	return &dataset.Spec{
		SpecVersion: 1,
		Source:      dataset.Source{Type: "table", Table: "orders"},
		Fields: []dataset.Field{
			{Key: "name", Label: "Name", Column: "name", Type: datasource.String, Role: dataset.Dimension},
			{Key: "amount", Label: "Amount", Column: "amount", Type: datasource.Decimal, Role: dataset.MeasureRole},
			{Key: "day", Label: "Day", Column: "day", Type: datasource.Date, Role: dataset.Dimension},
			{Key: "created", Label: "Created", Column: "created", Type: datasource.Timestamp, Role: dataset.Dimension},
		},
	}
}

func TestExtendedFilterOperators(t *testing.T) {
	tests := []struct {
		filter, sql string
		args        []any
	}{
		{`{"field":"name","op":"like","value":"a%_"}`, `t."name" LIKE $1 ESCAPE '!'`, []any{"a%_"}},
		{`{"field":"name","op":"not_like","value":"a%_"}`, `NOT (t."name" LIKE $1 ESCAPE '!')`, []any{"a%_"}},
		{`{"field":"name","op":"not_contains","value":"a%_"}`, `NOT (t."name" LIKE $1 ESCAPE '!')`, []any{"%a!%!_%"}},
		{`{"field":"name","op":"ends_with","value":"a%_"}`, `t."name" LIKE $1 ESCAPE '!'`, []any{"%a!%!_"}},
		{`{"field":"name","op":"is_empty"}`, `t."name" = $1`, []any{""}},
		{`{"field":"name","op":"not_empty"}`, `t."name" <> $1`, []any{""}},
		{`{"field":"amount","op":"between","value":[1,10]}`, `t."amount" BETWEEN $1 AND $2`, []any{float64(1), float64(10)}},
		{`{"field":"amount","op":"not_between","value":[1,10]}`, `t."amount" NOT BETWEEN $1 AND $2`, []any{float64(1), float64(10)}},
		{`{"field":"amount","op":"between","value":{"min":1,"max":10}}`, `t."amount" BETWEEN $1 AND $2`, []any{float64(1), float64(10)}},
		{`{"field":"amount","op":"between","value":{"min":1,"max":10,"includeMin":false}}`, `(t."amount" > $1 AND t."amount" <= $2)`, []any{float64(1), float64(10)}},
		{`{"field":"amount","op":"not_between","value":{"min":1,"max":10,"includeMin":false,"includeMax":false}}`, `NOT (t."amount" > $1 AND t."amount" < $2)`, []any{float64(1), float64(10)}},
	}
	for _, tt := range tests {
		t.Run(tt.filter, func(t *testing.T) {
			q := parse(t, `{"version":1,"dataset":"d","dimensions":[{"field":"name"}],"filter":`+tt.filter+`}`)
			got, err := Compile(q, extensionDataset(), options())
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(got.SQL, tt.sql) || !reflect.DeepEqual(got.Args, tt.args) {
				t.Fatalf("got %s / %#v; want condition %s / %#v", got.SQL, got.Args, tt.sql, tt.args)
			}
		})
	}
}

func TestExtendedFiltersRejectInvalidValues(t *testing.T) {
	for _, filter := range []string{
		`{"field":"amount","op":"is_empty"}`,
		`{"field":"amount","op":"not_like","value":"%"}`,
		`{"field":"name","op":"like","value":12}`,
		`{"field":"amount","op":"not_between","value":[1]}`,
		`{"field":"amount","op":"between","value":{"min":1}}`,
		`{"field":"amount","op":"between","value":{"min":null,"max":10}}`,
		`{"field":"amount","op":"between","value":{"min":1,"max":10,"includeMax":"false"}}`,
		`{"field":"amount","op":"between","value":{"min":1,"max":10,"extra":true}}`,
	} {
		q := parse(t, `{"version":1,"dataset":"d","dimensions":[{"field":"name"}],"filter":`+filter+`}`)
		if _, err := Compile(q, extensionDataset(), options()); errCode(err) != "invalid_filter_value" {
			t.Errorf("%s: got %v, want invalid_filter_value", filter, err)
		}
	}
}

func TestAggregateOpenRangeUsesHaving(t *testing.T) {
	q := parse(t, `{"version":1,"dataset":"d","measures":[{"field":"amount","agg":"sum"}],"having":{"field":"amount","op":"between","value":{"min":1,"max":10,"includeMax":false}}}`)
	opt := options()
	opt.Dialect = questionMarks{}
	got, err := Compile(q, extensionDataset(), opt)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got.SQL, `HAVING (SUM(t."amount") >= ? AND SUM(t."amount") < ?)`) || !reflect.DeepEqual(got.Args, []any{float64(1), float64(10)}) {
		t.Fatalf("unexpected aggregate range: %s / %#v", got.SQL, got.Args)
	}
}

// Trino puts OFFSET first, and compares text only with text: a date bound as
// text is cast to one.
func TestTrinoPagingAndTypedText(t *testing.T) {
	q := parse(t, `{"version":1,"dataset":"d","mode":"detail","columns":["name"],"filter":{"op":"and","args":[{"field":"day","op":"gte","value":"2026-01-01"},{"field":"amount","op":"gt","value":"0.5"}]},"limit":2,"offset":5}`)
	opt := options()
	opt.Dialect = dialect.Trino{}
	compiled, err := Compile(q, extensionDataset(), opt)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`t."day" >= CAST(? AS date)`, `t."amount" > CAST(? AS decimal(38, 10))`} {
		if !strings.Contains(compiled.SQL, want) {
			t.Errorf("missing %s: %s", want, compiled.SQL)
		}
	}
	if !strings.HasSuffix(compiled.SQL, "\nOFFSET 5 LIMIT 3") {
		t.Errorf("paging: %s", compiled.SQL)
	}
	opt.Dialect = dialect.Postgres{}
	if compiled, err = Compile(q, extensionDataset(), opt); err != nil || !strings.HasSuffix(compiled.SQL, "\nLIMIT 3 OFFSET 5") || strings.Contains(compiled.SQL, "CAST($1") {
		t.Errorf("paging and arguments elsewhere: %s (%v)", compiled.SQL, err)
	}
}
