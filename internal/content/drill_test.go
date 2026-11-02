package content

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/dialect"
	"github.com/supazd/supabi/internal/query"
)

var places = &dataset.Spec{
	SpecVersion: 1,
	Source:      dataset.Source{Type: "table", Table: "orders"},
	Fields: []dataset.Field{
		{Key: "created", Label: "created", Column: "created_at", Type: datasource.Timestamp, Role: dataset.Dimension},
		{Key: "day", Label: "day", Column: "day", Type: datasource.Date, Role: dataset.Dimension},
		{Key: "region", Label: "region", Column: "region", Type: datasource.String, Role: dataset.Dimension},
		{Key: "city", Label: "city", Column: "city", Type: datasource.String, Role: dataset.Dimension},
		{Key: "district", Label: "district", Column: "district", Type: datasource.String, Role: dataset.Dimension},
		{Key: "category", Label: "category", Column: "category", Type: datasource.String, Role: dataset.Dimension},
		{Key: "amount", Label: "amount", Column: "amount", Type: datasource.Decimal, Role: dataset.Dimension},
		{Key: "revenue", Label: "revenue", Column: "amount", Type: datasource.Decimal, Role: dataset.MeasureRole},
	},
}

// drillChart is revenue by dims, drawn as viz, drilled as drill.
func drillChart(t *testing.T, dims, viz, drill string) *ChartSpec {
	t.Helper()
	return chartSpec(t, `{"specVersion":1,"query":{"version":1,"dataset":"d","dimensions":`+dims+`,"measures":[{"field":"revenue","agg":"sum"}]},"viz":`+viz+`,"drill":`+drill+`}`)
}

func TestDrillValidate(t *testing.T) {
	const (
		byRegion = `[{"field":"region"}]`
		byYear   = `[{"field":"created","grain":"year","alias":"year"}]`
		bar      = `{"type":"bar","x":"region","y":["revenue"]}`
		yearBar  = `{"type":"bar","x":"year","y":["revenue"]}`
		cities   = `{"alias":"region","levels":[{"field":"city","label":"城市"},{"field":"district"}]}`
	)
	grains := func(grains ...string) string {
		var levels []string
		for _, grain := range grains {
			levels = append(levels, `{"field":"created","grain":"`+grain+`"}`)
		}
		return `{"alias":"year","levels":[` + strings.Join(levels, ",") + `]}`
	}
	tests := []struct {
		name, dims, viz, drill, want string
	}{
		{"places", byRegion, bar, cities, ""},
		{"line", byRegion, `{"type":"line","x":"region","y":["revenue"]}`, cities, ""},
		{"pie", byRegion, `{"type":"pie","x":"region","y":["revenue"]}`, cities, ""},
		{"any table column", `[{"field":"category"},{"field":"region"}]`, `{"type":"table"}`, cities, ""},
		{"down the calendar", byYear, yearBar, grains("quarter", "month", "day", "hour", "minute"), ""},
		{"skipping grains", byYear, yearBar, grains("month", "minute"), ""},
		{"to another field", byYear, yearBar, `{"alias":"year","levels":[{"field":"region"},{"field":"created","grain":"month"}]}`, ""},
		{"week to days", `[{"field":"created","grain":"week","alias":"year"}]`, yearBar, grains("day"), ""},
		{"months into weeks", byYear, yearBar, grains("month", "week"), "invalid_drill"},
		{"weeks into months", `[{"field":"created","grain":"week","alias":"year"}]`, yearBar, grains("month"), "invalid_drill"},
		{"back up the calendar", byYear, yearBar, grains("month", "quarter"), "invalid_drill"},
		{"below a whole timestamp", `[{"field":"created","alias":"year"}]`, yearBar, grains("day"), "invalid_drill"},
		{"a date without a grain", byYear, yearBar, `{"alias":"year","levels":[{"field":"created"}]}`, "invalid_drill"},
		{"a grain on text", byRegion, bar, `{"alias":"region","levels":[{"field":"city","grain":"month"}]}`, "invalid_drill"},
		{"a level twice", byRegion, bar, `{"alias":"region","levels":[{"field":"city"},{"field":"city"}]}`, "invalid_drill"},
		{"back to the first", byRegion, bar, `{"alias":"region","levels":[{"field":"city"},{"field":"region"}]}`, "invalid_drill"},
		{"another column", `[{"field":"category"},{"field":"region"}]`, `{"type":"table"}`, `{"alias":"region","levels":[{"field":"category"}]}`, "invalid_drill"},
		{"a measure", byRegion, bar, `{"alias":"region","levels":[{"field":"revenue"}]}`, "invalid_drill"},
		{"unknown field", byRegion, bar, `{"alias":"region","levels":[{"field":"nope"}]}`, "unknown_field"},
		{"no levels", byRegion, bar, `{"alias":"region","levels":[]}`, "invalid_drill"},
		{"eight levels", byRegion, bar, `{"alias":"region","levels":[{"field":"city"},{"field":"district"},{"field":"category"},{"field":"created","grain":"year"},{"field":"created","grain":"quarter"},{"field":"created","grain":"month"},{"field":"created","grain":"day"},{"field":"created","grain":"hour"}]}`, "invalid_drill"},
		{"seven levels", byRegion, bar, `{"alias":"region","levels":[{"field":"city"},{"field":"district"},{"field":"category"},{"field":"created","grain":"year"},{"field":"created","grain":"quarter"},{"field":"created","grain":"month"},{"field":"created","grain":"day"}]}`, ""},
		{"not a dimension of the query", byRegion, bar, `{"alias":"city","levels":[{"field":"district"}]}`, "invalid_drill"},
		{"the series", `[{"field":"created","grain":"year","alias":"year"},{"field":"region"}]`, `{"type":"bar","x":"year","y":["revenue"],"series":"region"}`, cities, "invalid_drill"},
		{"a hidden column", `[{"field":"category"},{"field":"region"}]`, `{"type":"table","hiddenColumns":["region"]}`, cities, "invalid_drill"},
		{"a scatter chart", byRegion, `{"type":"scatter","x":"region","y":["revenue","revenue"]}`, cities, "invalid_drill"},
		{"a pivot table", byRegion, `{"type":"pivot","rows":["region"],"y":["revenue"]}`, cities, "invalid_drill"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			chart := drillChart(t, tt.dims, tt.viz, tt.drill)
			if got := code(chart.Validate(places, dialect.Postgres{})); got != tt.want {
				t.Fatalf("got %q, want %q", got, tt.want)
			}
		})
	}

	detail := chartSpec(t, `{"specVersion":1,"query":{"version":1,"dataset":"d","mode":"detail","columns":[{"field":"region"}]},"viz":{"type":"table"},"drill":`+cities+`}`)
	if got := code(detail.Validate(places, dialect.Postgres{})); got != "invalid_drill" {
		t.Fatalf("detail table drilled: %q", got)
	}
	dynamic := drillChart(t, byRegion, bar, cities)
	dynamic.Dynamics = []DynamicField{{ID: "group", Kind: "dimension", Label: "Group", Alias: "region", Options: []DynamicOption{{ID: "region", Field: "region"}, {ID: "category", Field: "category"}}}}
	if got := code(dynamic.Validate(places, dialect.Postgres{})); got != "invalid_drill" {
		t.Fatalf("dynamic dimension drilled: %q", got)
	}
	// Every level compiles, not only the first: a DATE has no hours, which
	// is found when the chart is saved, not when the day is clicked.
	hours := drillChart(t, `[{"field":"day","grain":"month","alias":"year"}]`, yearBar, `{"alias":"year","levels":[{"field":"day","grain":"day"},{"field":"day","grain":"hour"}]}`)
	if got := code(hours.Validate(places, dialect.Postgres{})); got != "invalid_grain" {
		t.Fatalf("hours of a date: %q", got)
	}
}

func TestDrilledKeepsTheColumnAndAddsConditions(t *testing.T) {
	chart := drillChart(t, `[{"field":"region"}]`, `{"type":"bar","x":"region","y":["revenue"]}`, `{"alias":"region","levels":[{"field":"city","label":"城市"},{"field":"created","grain":"month","label":"月"},{"field":"created","grain":"day"}]}`)
	before, _ := json.Marshal(chart)

	same, conditions, err := chart.Drilled(nil, places, "Asia/Shanghai", 1)
	if err != nil || conditions != nil || !reflect.DeepEqual(same.Query, chart.Query) {
		t.Fatalf("no path: %+v %v %v", same.Query, conditions, err)
	}

	city, conditions, err := chart.Drilled([]any{"华东"}, places, "Asia/Shanghai", 1)
	if err != nil {
		t.Fatal(err)
	}
	if got := city.Query.Dimensions; !reflect.DeepEqual(got, []query.Dimension{{Field: "city", Alias: "region", Label: "城市"}}) {
		t.Fatalf("dimensions: %+v", got)
	}
	if city.Viz.X != "region" {
		t.Fatal("the column was renamed")
	}
	if !reflect.DeepEqual(conditions, []dataset.Filter{{Field: "region", Op: "eq", Value: "华东"}}) {
		t.Fatalf("conditions: %+v", conditions)
	}

	// A missing city is clicked as null, a month as the date that starts it.
	days, conditions, err := chart.Drilled([]any{"华东", nil, "2026-02-01T00:00:00"}, places, "Asia/Shanghai", 1)
	if err != nil {
		t.Fatal(err)
	}
	if got := days.Query.Dimensions[0]; got.Field != "created" || got.Grain != dialect.Day || got.Alias != "region" {
		t.Fatalf("day level: %+v", got)
	}
	if len(conditions) != 3 || conditions[1].Op != "is_null" || conditions[1].Field != "city" || conditions[2].Op != query.OpTime {
		t.Fatalf("conditions: %+v", conditions)
	}
	if b := conditions[2].Value.(query.TimeRange).Bounds; b.Start.Fixed != "2026-02-01T00:00:00+08:00" || b.End.Fixed != "2026-03-01T00:00:00+08:00" {
		t.Fatalf("month: %+v %+v", b.Start, b.End)
	}

	for name, path := range map[string][]any{
		"too deep":       {"华东", "杭州", "2026-02-01", "2026-02-03"},
		"not a scalar":   {map[string]any{"field": "amount"}},
		"a date as text": {"华东", "杭州", 20260201.0},
		"not a date":     {"华东", "杭州", "February"},
	} {
		if _, _, err := chart.Drilled(path, places, "Asia/Shanghai", 1); code(err) != "invalid_drill" {
			t.Fatalf("%s: %v", name, err)
		}
	}
	plain := drillChart(t, `[{"field":"region"}]`, `{"type":"bar","x":"region","y":["revenue"]}`, `null`)
	if _, _, err := plain.Drilled([]any{"华东"}, places, "Asia/Shanghai", 1); code(err) != "invalid_drill" {
		t.Fatalf("a chart without a drill: %v", err)
	}
	after, _ := json.Marshal(chart)
	if string(before) != string(after) {
		t.Fatal("drilling mutated the chart")
	}
}

func TestDrilledFormatsHoldWhileTheTypeDoes(t *testing.T) {
	chart := drillChart(t, `[{"field":"created","grain":"year","alias":"year"}]`, `{"type":"table","formats":{"year":{"date":"chinese"}},"style":{}}`, `{"alias":"year","levels":[{"field":"created","grain":"month"},{"field":"amount"},{"field":"region"}]}`)
	one := 1.0
	chart.Viz.Style.Highlights = map[string][]Highlight{"year": {{Op: "gt", Value: &one, Color: Hues[0]}}}
	month, _, err := chart.Drilled([]any{"2026-01-01"}, places, "UTC", 1)
	if err != nil || month.Viz.Formats["year"].Date != "chinese" {
		t.Fatalf("a month lost the date format: %+v %v", month.Viz.Formats, err)
	}
	amount, _, err := chart.Drilled([]any{"2026-01-01", "2026-01-01"}, places, "UTC", 1)
	if err != nil || len(amount.Viz.Formats) != 0 || amount.Viz.Style.Highlights["year"] == nil {
		t.Fatalf("a number: %+v %+v %v", amount.Viz.Formats, amount.Viz.Style, err)
	}
	region, _, err := chart.Drilled([]any{"2026-01-01", "2026-01-01", 12.5}, places, "UTC", 1)
	if err != nil || len(region.Viz.Formats) != 0 || len(region.Viz.Style.Highlights) != 0 {
		t.Fatalf("text: %+v %+v %v", region.Viz.Formats, region.Viz.Style, err)
	}
	if chart.Viz.Formats["year"].Date != "chinese" || chart.Viz.Style.Highlights["year"] == nil {
		t.Fatal("drilling mutated the chart's formats")
	}
}
