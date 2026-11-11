package query

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/dialect"
)

func TestComparisonValidationAndMetadata(t *testing.T) {
	spec := &dataset.Spec{SpecVersion: 1, Source: dataset.Source{Type: "table", Table: "orders"}, Fields: []dataset.Field{
		{Key: "day", Label: "Day", Column: "day", Type: datasource.Date, Role: dataset.Dimension},
		{Key: "qty", Label: "Qty", Column: "qty", Type: datasource.Integer, Role: dataset.MeasureRole, Format: &dataset.Format{Prefix: "$"}},
	}}
	fresh := func() *Query {
		return parse(t, `{"version":1,"dataset":"d","dimensions":[{"field":"day","grain":"month"}],"measures":[{"field":"qty","agg":"sum","compute":{"type":"compare","timeField":"day","offset":{"n":1,"unit":"month"},"output":"ratio"}}],"filter":{"field":"day","op":"time","value":{"current":"month"}}}`)
	}
	for _, tc := range []struct {
		name, code string
		change     func(*Query)
	}{
		{"no offset", "invalid_compare", func(q *Query) { q.Measures[0].Compute.Offset = nil }},
		{"zero offset", "invalid_compare", func(q *Query) { q.Measures[0].Compute.Offset.N = 0 }},
		{"negative offset", "invalid_compare", func(q *Query) { q.Measures[0].Compute.Offset.N = -1 }},
		{"huge offset", "invalid_compare", func(q *Query) { q.Measures[0].Compute.Offset.N = 1001 }},
		{"wrong unit", "invalid_compare", func(q *Query) { q.Measures[0].Compute.Offset.Unit = "hour" }},
		{"wrong output", "invalid_compare", func(q *Query) { q.Measures[0].Compute.Output = "growth" }},
		{"not temporal", "compare_time_field", func(q *Query) { q.Measures[0].Compute.TimeField = "qty" }},
		{"mixed compute", "invalid_compare", func(q *Query) { q.Measures[0].Compute.Within = []string{"day"} }},
		{"absent filter", "compare_time_range", func(q *Query) { q.Filter = nil }},
		{"open range", "compare_time_range", func(q *Query) { q.Filter.Value = TimeRange{Start: "2026-01-01"} }},
		{"null dates", "compare_time_range", func(q *Query) { q.Filter.Value = TimeRange{Current: dialect.Month, IncludeNull: true} }},
		{"special dates", "compare_time_range", func(q *Query) { q.Filter.Value = TimeRange{Special: "not_null"} }},
		{"OR time", "compare_time_range", func(q *Query) {
			q.Filter = &dataset.Filter{Op: "or", Args: []dataset.Filter{*q.Filter, {Field: "qty", Op: "gt", Value: 1}}}
		}},
		{"NOT time", "compare_time_range", func(q *Query) { q.Filter = &dataset.Filter{Op: "not", Args: []dataset.Filter{*q.Filter}} }},
		{"arbitrary time condition", "compare_time_range", func(q *Query) { q.Filter.Op = "gte"; q.Filter.Value = "2026-01-01" }},
		{"unaligned month", "compare_grain", func(q *Query) { q.Measures[0].Compute.Offset.Unit = dialect.Day }},
		{"weekly year", "compare_grain", func(q *Query) { q.Dimensions[0].Grain = dialect.Week; q.Measures[0].Compute.Offset.Unit = dialect.Year }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			q := fresh()
			tc.change(q)
			_, err := Compile(q, spec, options())
			if errCode(err) != tc.code {
				t.Fatalf("got %v want %s", err, tc.code)
			}
		})
	}
	for _, output := range []string{"value", "delta", "ratio"} {
		q := fresh()
		q.Measures[0].Compute.Output = output
		before, _ := json.Marshal(q)
		c, err := Compile(q, spec, options())
		if err != nil {
			t.Fatal(err)
		}
		col := c.Columns[1]
		if col.Compute != Compare || col.Comparison.Output != output || col.Comparison.Offset.N != 1 {
			t.Fatalf("metadata %+v", col)
		}
		if output == "ratio" {
			if col.Format.Style != "percent" || col.Format.Prefix != "" {
				t.Fatal(col.Format)
			}
		} else if col.Format.Prefix != "$" {
			t.Fatal(col.Format)
		}
		total := q.TotalQuery(nil)
		if !reflect.DeepEqual(total.Measures[0].Compute, q.Measures[0].Compute) {
			t.Fatal("total lost comparison")
		}
		after, _ := json.Marshal(q)
		if string(before) != string(after) {
			t.Fatal("compile mutated query")
		}
		q.Measures[0].BaseLabel = "Aggregate name"
		q.Measures[0].Label = "Custom"
		c, err = Compile(q, spec, options())
		if err != nil {
			t.Fatal(err)
		}
		if col := c.Columns[1]; col.Compute != "" || col.Comparison != nil || col.Label != "Custom" {
			t.Fatalf("label %+v", col)
		}
	}
}

func TestCalendarComparisonShift(t *testing.T) {
	loc, _ := time.LoadLocation("America/Los_Angeles")
	for _, tc := range []struct {
		input, want string
		offset      Duration
	}{
		{"2024-03-31T12:30:00", "2024-02-29T12:30:00", Duration{1, dialect.Month}},
		{"2024-02-29T12:30:00", "2023-02-28T12:30:00", Duration{1, dialect.Year}},
		{"2026-01-31T12:30:00", "2025-10-31T12:30:00", Duration{1, dialect.Quarter}},
		{"2026-03-09T00:00:00", "2026-03-08T00:00:00", Duration{1, dialect.Day}},
		{"2026-03-09T00:00:00", "2026-03-02T00:00:00", Duration{1, dialect.Week}},
	} {
		at, _ := time.ParseInLocation("2006-01-02T15:04:05", tc.input, loc)
		got := calendarShift(at, tc.offset)
		if got.Format("2006-01-02T15:04:05") != tc.want {
			t.Errorf("%s => %s want %s", tc.input, got, tc.want)
		}
	}
	for _, tc := range []struct {
		grain, unit dialect.Grain
		n           int
		ok          bool
	}{{dialect.Week, dialect.Day, 7, true}, {dialect.Week, dialect.Week, 52, true}, {dialect.Quarter, dialect.Month, 3, true}, {dialect.Year, dialect.Month, 12, true}, {dialect.Year, dialect.Quarter, 4, true}, {dialect.Quarter, dialect.Month, 1, false}} {
		if comparisonGrain(tc.grain, tc.unit, tc.n) != tc.ok {
			t.Error(tc)
		}
	}
}

func TestDateComparisonUsesCalendarDatesAcrossTimezoneTransitions(t *testing.T) {
	spec := &dataset.Spec{SpecVersion: 1, Source: dataset.Source{Type: "table", Table: "orders"}, Fields: []dataset.Field{
		{Key: "day", Label: "Day", Column: "day", Type: datasource.Date, Role: dataset.Dimension},
		{Key: "qty", Label: "Qty", Column: "qty", Type: datasource.Integer, Role: dataset.MeasureRole},
	}}
	for _, tc := range []struct{ zone, start, end, previousStart, previousEnd string }{
		{"America/Sao_Paulo", "2018-11-04", "2018-11-05", "2018-10-04", "2018-10-05"},
		{"Pacific/Apia", "2011-12-30", "2012-01-01", "2011-11-30", "2011-12-01"},
		// The end is not part of the period, so it follows the last day that
		// is: December 30 alone is compared with November 30, as it is when
		// it is one of several days.
		{"Pacific/Apia", "2011-12-30", "2011-12-31", "2011-11-30", "2011-12-01"},
		// An end on the 31st does not cost the shorter month its last day.
		{"Asia/Shanghai", "2026-05-01", "2026-05-31", "2026-04-01", "2026-05-01"},
		{"Asia/Shanghai", "2026-05-01", "2026-06-01", "2026-04-01", "2026-05-01"},
		{"Asia/Shanghai", "2026-03-31", "2026-04-01", "2026-02-28", "2026-03-01"},
	} {
		t.Run(tc.zone, func(t *testing.T) {
			q := parse(t, `{"version":1,"dataset":"d","timezone":"`+tc.zone+`","measures":[{"field":"qty","agg":"sum","compute":{"type":"compare","timeField":"day","offset":{"n":1,"unit":"month"},"output":"value"}}],"filter":{"field":"day","op":"time","value":{"start":"`+tc.start+`","end":"`+tc.end+`"}}}`)
			c, err := Compile(q, spec, options())
			if err != nil {
				t.Fatal(err)
			}
			want := []any{tc.start, tc.end, tc.previousStart, tc.previousEnd}
			if !reflect.DeepEqual(c.Args, want) {
				t.Fatalf("got %v want %v", c.Args, want)
			}
			// Relative dates still use the query zone's current wall date, not UTC's.
			q.Filter.Value = TimeRange{Current: dialect.Day}
			opt := options()
			opt.Now = time.Date(2026, 1, 1, 1, 0, 0, 0, time.UTC)
			c, err = Compile(q, spec, opt)
			if err != nil {
				t.Fatal(err)
			}
			loc, _ := time.LoadLocation(tc.zone)
			local := opt.Now.In(loc)
			if c.Args[0] != local.Format("2006-01-02") {
				t.Fatalf("relative DATE lost local day: %v", c.Args)
			}
		})
	}
}
