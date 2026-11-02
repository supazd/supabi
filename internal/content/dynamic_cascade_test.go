package content

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/dialect"
	"github.com/supazd/supabi/internal/query"
)

func dynamicChart(t *testing.T) *ChartSpec {
	return chartSpec(t, `{"specVersion":1,"query":{"version":1,"dataset":"d","dimensions":[{"field":"region","alias":"category"}],"measures":[{"field":"revenue","agg":"sum","alias":"value"}]},"viz":{"type":"bar","x":"category","y":["value"]},"dynamics":[{"id":"group","kind":"dimension","label":"Group","alias":"category","allowEmpty":true,"options":[{"id":"region","field":"region"},{"id":"month","field":"created","grain":"month","label":"Month"}]},{"id":"metric","kind":"measure","label":"Measure","alias":"value","options":[{"id":"sum","field":"revenue","agg":"sum"},{"id":"avg","field":"revenue","agg":"avg","label":"Average"}]}]}`)
}

func TestDynamicFieldsResolveAndValidate(t *testing.T) {
	chart := dynamicChart(t)
	before, _ := json.Marshal(chart)
	if err := chart.Validate(orders, dialect.Postgres{}); err != nil {
		t.Fatal(err)
	}
	resolved, err := chart.ResolveDynamics(map[string]string{"group": "month", "metric": "avg"})
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Query.Dimensions[0].Field != "created" || resolved.Query.Dimensions[0].Alias != "category" || resolved.Query.Measures[0].Agg != dataset.Avg || resolved.Query.Measures[0].Alias != "value" {
		t.Fatalf("wrong resolved query: %+v", resolved.Query)
	}
	if resolved.Viz.X != "category" || resolved.Viz.Y[0] != "value" {
		t.Fatal("dynamic selection changed stable output names")
	}
	chart.Viz.Formats = map[string]dataset.Format{"value": {Unit: "wan"}}
	before, _ = json.Marshal(chart)
	empty, err := chart.ResolveDynamics(map[string]string{"group": ""})
	if err != nil || len(empty.Query.Dimensions) != 0 || empty.Viz.Type != Table {
		t.Fatalf("empty dimension: %+v %v", empty, err)
	}
	if empty.Viz.Formats["value"].Unit != "wan" {
		t.Fatal("falling back to a table lost the display formats")
	}
	for _, selected := range []map[string]string{{"unknown": "sum"}, {"metric": "bad"}, {"metric": ""}} {
		if _, err := chart.ResolveDynamics(selected); err == nil {
			t.Fatalf("accepted selection: %v", selected)
		}
	}
	after, _ := json.Marshal(chart)
	if string(before) != string(after) {
		t.Fatal("resolving choices mutated the chart")
	}
	chart.Dynamics[1].Options[1].Field = "missing"
	if got := code(chart.Validate(orders, dialect.Postgres{})); got != "unknown_field" {
		t.Fatalf("invalid non-default candidate: %s", got)
	}
}

func TestDynamicTableVisibilityKeepsRemainingColumns(t *testing.T) {
	chart := dynamicChart(t)
	chart.Viz = Viz{Type: Table, HiddenColumns: []string{"category"}}
	if err := chart.Validate(orders, dialect.Postgres{}); err != nil {
		t.Fatal(err)
	}
	before, _ := json.Marshal(chart)
	changed, err := chart.ResolveDynamics(map[string]string{"group": "month", "metric": "avg"})
	if err != nil || !reflect.DeepEqual(changed.Viz.HiddenColumns, []string{"category"}) {
		t.Fatalf("visibility lost on selection: %+v %v", changed, err)
	}
	empty, err := chart.ResolveDynamics(map[string]string{"group": ""})
	if err != nil || len(empty.Viz.HiddenColumns) != 0 {
		t.Fatalf("removed dimension still hidden: %+v %v", empty, err)
	}
	after, _ := json.Marshal(chart)
	if string(before) != string(after) {
		t.Fatal("resolving visibility mutated saved chart")
	}
	chart.Viz.HiddenColumns = []string{"value"}
	if got := code(chart.Validate(orders, dialect.Postgres{})); got != "viz_needs_visible_column" {
		t.Fatalf("optional dimension is the only visible column: %s", got)
	}
}

func TestGlobalFilterFollowsDynamicMeasure(t *testing.T) {
	chart := dynamicChart(t)
	dashboard := DashboardSpec{Filters: []Filter{{ID: "minimum", Label: "Minimum", Op: "gte", Control: Control{Type: ControlNumber}, Default: float64(5), Targets: []FilterTarget{{Item: "w", Measure: "value"}}}}, Layout: Layout{Items: []Item{{ID: "w", ChartID: "c"}}}}
	if err := dashboard.CheckFilters(func(string) (*ChartSpec, *dataset.Spec, bool) { return chart, orders, true }); err != nil {
		t.Fatal(err)
	}
	resolved, err := chart.ResolveDynamics(map[string]string{"metric": "avg"})
	if err != nil {
		t.Fatal(err)
	}
	q, err := dashboard.QueryForViewer(Item{ID: "w"}, &resolved, orders, nil, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	if q.Having == nil || q.Having.Args[0].Field != "value" || q.Measures[0].Agg != dataset.Avg {
		t.Fatalf("global filter did not follow selection: %+v", q)
	}
	chart.Dynamics[1].Options[1].Agg = dataset.Count
	if got := code(dashboard.CheckFilters(func(string) (*ChartSpec, *dataset.Spec, bool) { return chart, orders, true })); got != "filter_targets_differ" {
		t.Fatalf("accepted incompatible dynamic output: %s", got)
	}
}

func TestAggregatedChartFiltersRemainSeparateFromRowFilters(t *testing.T) {
	chart := dynamicChart(t)
	chart.Filters = []ChartFilter{{ID: "row", Field: "revenue", Op: "gte", Value: float64(1)}, {ID: "aggregate", Field: "revenue", Aggregation: dataset.Sum, Op: "gte", Value: float64(100)}}
	if err := chart.Validate(orders, dialect.Postgres{}); err != nil {
		t.Fatal(err)
	}
	q, err := chart.Filtered(nil, orders)
	if err != nil || q.Filter == nil || q.Having == nil {
		t.Fatalf("row/aggregate scopes: %+v %v", q, err)
	}
	dashboard := DashboardSpec{Filters: []Filter{{ID: "g", Op: "lte", Control: Control{Type: ControlNumber}, Default: float64(200), Targets: []FilterTarget{{Item: "w", Field: "revenue", Aggregation: dataset.Sum}}}}}
	q, err = dashboard.QueryForViewer(Item{ID: "w"}, chart, orders, nil, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(q.Filter.Args) != 1 || len(q.Having.Args) != 1 || q.Having.Args[0].Op != "lte" {
		t.Fatalf("global aggregate took over the wrong scope: %+v", q)
	}
}

func TestCascadeOptionsUseAncestorsAndReverseRelatedSelections(t *testing.T) {
	chart := chartSpec(t, `{"specVersion":1,"query":{"version":1,"dataset":"d","dimensions":[{"field":"region"}],"filter":{"field":"amount","op":"gt","value":0}},"viz":{"type":"table"},"filters":[{"id":"region","field":"region","op":"in","label":"Region","control":{"type":"tiles","multi":true}},{"id":"revenue","field":"revenue","op":"in","label":"Revenue","control":{"type":"select","multi":true},"dependsOn":["region"]},{"id":"fixed","field":"created","op":"not_null"}]}`)
	if err := chart.Validate(orders, dialect.Postgres{}); err != nil {
		t.Fatal(err)
	}
	values := map[string]any{"region": []any{"west"}, "revenue": []any{float64(20)}}
	q, _, err := chart.OptionsQuery("revenue", values, orders, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(q.Filter.Args) != 3 || q.Filter.Args[1].Field != "region" || q.Filter.Args[2].Field != "created" {
		t.Fatalf("ancestor/fixed conditions not kept: %+v", q.Filter)
	}
	q, _, err = chart.OptionsQuery("region", values, orders, true)
	if err != nil || q.Filter.Args[1].Field != "revenue" {
		t.Fatalf("reverse matching missing child: %+v %v", q.Filter, err)
	}
	q, _, err = chart.OptionsQuery("region", values, orders, false)
	if err != nil || len(q.Filter.Args) != 2 {
		t.Fatalf("root should only retain immutable conditions: %+v %v", q.Filter, err)
	}
	if _, _, err := chart.OptionsQuery("region", map[string]any{"fixed": nil}, orders, false); code(err) != "filter_not_interactive" {
		t.Fatalf("accepted fixed override: %v", err)
	}
	chart.Filters[0].DependsOn = []string{"revenue"}
	if got := code(chart.Validate(orders, dialect.Postgres{})); got != "invalid_cascade" {
		t.Fatalf("accepted cycle: %s", got)
	}
}

func TestFilterExtendedConditions(t *testing.T) {
	chartText := dynamicChart(t)
	chartText.Filters = []ChartFilter{{ID: "text", Field: "region", Op: "ne", Label: "Region", Control: &Control{Type: ControlText}, Value: "west"}}
	if err := chartText.Validate(orders, dialect.Postgres{}); err != nil {
		t.Fatal(err)
	}
	boardText := DashboardSpec{Layout: Layout{Items: []Item{{ID: "w", ChartID: "c"}}}, Filters: []Filter{{ID: "text", Label: "Region", Op: "ne", Control: Control{Type: ControlText}, Default: "west", Targets: []FilterTarget{{Item: "w", Field: "region"}}}}}
	if err := boardText.CheckFilters(func(string) (*ChartSpec, *dataset.Spec, bool) { return chartText, orders, true }); err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct {
		op       string
		value    any
		want     string
		restrict bool
	}{
		{"between", map[string]any{"min": float64(5), "includeMin": false}, "gt", true},
		{"not_between", map[string]any{"max": float64(10), "includeMax": false}, "gte", true},
		{"between", map[string]any{}, "between", false},
		{"time", map[string]any{"bounds": map[string]any{}}, "time", false},
		{"time", map[string]any{"grain": "month", "includeNull": true, "weekStart": float64(2)}, "time", false},
		{"time", map[string]any{"bounds": map[string]any{}, "grain": "week"}, "time", false},
		{"time", map[string]any{"current": "month", "grain": "month"}, "time", true},
		{"is_empty", nil, "is_empty", true},
	} {
		condition, restrict, err := (ChartFilter{ID: "f", Field: "amount", Op: tt.op}).Condition(tt.value)
		if err != nil || condition.Op != tt.want || restrict != tt.restrict {
			t.Fatalf("%s: %+v %v %v", tt.op, condition, restrict, err)
		}
	}
	chart := dynamicChart(t)
	chart.Filters = []ChartFilter{{ID: "f", Field: "region", Op: "not_in", Control: &Control{Type: ControlTiles}, Label: "Region", Value: []any{"west"}}}
	if err := chart.Validate(orders, dialect.Postgres{}); err != nil {
		t.Fatal(err)
	}
	q, _ := chart.Filtered(nil, orders)
	compiled, err := query.Compile(&q, orders, query.Options{Dialect: dialect.Postgres{}, DefaultLimit: 5, MaxLimit: 10})
	if err != nil || !strings.Contains(compiled.SQL, "NOT IN") || !reflect.DeepEqual(compiled.Args, []any{"west"}) {
		t.Fatalf("tiles exclusion: %+v %v", compiled, err)
	}
}

func TestHeatmapWithoutADynamicDimensionIsATable(t *testing.T) {
	chart := chartSpec(t, `{"specVersion":1,"query":{"version":1,"dataset":"d","dimensions":[{"field":"region","alias":"category"},{"field":"created","grain":"month","alias":"month"}],"measures":[{"field":"revenue","agg":"sum","alias":"value"}]},"viz":{"type":"heatmap","rows":["category"],"columns":["month"],"y":["value"]},"dynamics":[{"id":"group","kind":"dimension","label":"Group","alias":"category","allowEmpty":true,"options":[{"id":"region","field":"region"}]}]}`)
	if err := chart.Validate(orders, dialect.Postgres{}); err != nil {
		t.Fatal(err)
	}
	resolved, err := chart.ResolveDynamics(map[string]string{"group": ""})
	if err != nil || resolved.Viz.Type != Table || len(resolved.Query.Dimensions) != 1 {
		t.Fatalf("heatmap without its rows: %+v %v", resolved.Viz, err)
	}
}

func TestRemovedDynamicDimensionLeavesTheTotals(t *testing.T) {
	chart := chartSpec(t, `{"specVersion":1,"query":{"version":1,"dataset":"d","dimensions":[{"field":"region","alias":"category"},{"field":"created","grain":"month","alias":"month"},{"field":"amount"}],"measures":[{"field":"revenue","agg":"sum","alias":"value"}],"totals":[["category","month"],["month","amount"]]},"viz":{"type":"sankey","levels":["category","month","amount"],"y":["value"]},"dynamics":[{"id":"group","kind":"dimension","label":"Group","alias":"category","allowEmpty":true,"options":[{"id":"region","field":"region"}]}]}`)
	if err := chart.Validate(orders, dialect.Postgres{}); err != nil {
		t.Fatal(err)
	}
	resolved, err := chart.ResolveDynamics(map[string]string{"group": ""})
	if err != nil {
		t.Fatal(err)
	}
	// Two levels are left, and the totals no longer name the one taken away.
	if !reflect.DeepEqual(resolved.Viz.Levels, []string{"month", "amount"}) || !reflect.DeepEqual(resolved.Query.Totals, [][]string{{"month"}}) {
		t.Fatalf("levels %v, totals %v", resolved.Viz.Levels, resolved.Query.Totals)
	}
	if !reflect.DeepEqual(chart.Query.Totals, [][]string{{"category", "month"}, {"month", "amount"}}) {
		t.Fatal("resolving changed the chart's totals")
	}
}

func TestDynamicPercentageKeepsComputationAndPrunesOnlyRemovedGroups(t *testing.T) {
	chart := dynamicChart(t)
	chart.Query.Measures[0].Compute = &query.Compute{Type: query.PercentOfTotal, Within: []string{"category"}}
	before, _ := json.Marshal(chart)
	if err := chart.Validate(orders, dialect.Postgres{}); err != nil {
		t.Fatal(err)
	}
	resolved, err := chart.ResolveDynamics(map[string]string{"group": "month", "metric": "avg"})
	if err != nil {
		t.Fatal(err)
	}
	if m := resolved.Query.Measures[0]; m.Agg != dataset.Avg || m.Compute == nil || !reflect.DeepEqual(m.Compute.Within, []string{"category"}) {
		t.Fatalf("resolved measure: %+v", m)
	}
	empty, err := chart.ResolveDynamics(map[string]string{"group": "", "metric": "avg"})
	if err != nil {
		t.Fatal(err)
	}
	if m := empty.Query.Measures[0]; m.Compute == nil || len(m.Compute.Within) != 0 {
		t.Fatalf("removed group: %+v", m)
	}
	after, _ := json.Marshal(chart)
	if string(before) != string(after) {
		t.Fatal("resolving percentage mutated saved chart")
	}
}

func TestComparisonCandidateQueriesKeepOnlyRequiredAggregates(t *testing.T) {
	chart := chartSpec(t, `{"specVersion":1,"query":{"version":1,"dataset":"d","dimensions":[{"field":"region"}],"measures":[{"field":"revenue","agg":"sum","compute":{"type":"compare","timeField":"created","offset":{"n":1,"unit":"month"},"output":"ratio"}}]},"viz":{"type":"table"},"filters":[{"id":"date","label":"Date","field":"created","op":"time","value":{"current":"month"},"control":{"type":"date_range"}},{"id":"region","label":"Region","field":"region","op":"in","control":{"type":"select","multi":true}},{"id":"min","field":"revenue","aggregation":"sum","op":"gte","value":10}]}`)
	if err := chart.Validate(orders, dialect.Postgres{}); err != nil {
		t.Fatal(err)
	}
	before, _ := json.Marshal(chart)
	q, _, err := chart.OptionsQuery("region", nil, orders, false)
	if err != nil {
		t.Fatal(err)
	}
	if q.Filter != nil {
		t.Fatalf("independent choices unexpectedly restricted by date: %+v", q.Filter)
	}
	if len(q.Measures) != 0 || len(q.FilterMeasures) != 1 {
		t.Fatalf("unused compare not pruned: %+v", q)
	}
	if _, err = query.Compile(&q, orders, query.Options{Dialect: dialect.Postgres{}, Now: time.Date(2026, 3, 10, 0, 0, 0, 0, time.UTC), DefaultLimit: 10, MaxLimit: 10}); err != nil {
		t.Fatal(err)
	}
	after, _ := json.Marshal(chart)
	if string(before) != string(after) {
		t.Fatal("candidate planning mutated chart")
	}

	// A result filter that actually references the comparison needs its date
	// range, including the viewer's selected value rather than the default.
	chart.Query.Having = &dataset.Filter{Field: "revenue", Op: "gt", Value: float64(0)}
	values := map[string]any{"date": map[string]any{"start": "2026-02-01", "end": "2026-03-01"}, "region": []any{"west"}}
	q, _, err = chart.OptionsQuery("region", values, orders, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(q.Measures) != 1 || q.Measures[0].Compute == nil {
		t.Fatal("required comparison removed")
	}
	compiled, err := query.Compile(&q, orders, query.Options{Dialect: dialect.Postgres{}, Now: time.Date(2026, 3, 10, 0, 0, 0, 0, time.UTC), DefaultLimit: 10, MaxLimit: 10})
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(compiled.Args)
	if !strings.Contains(string(encoded), "2026-02-01") || strings.Contains(string(encoded), "west") {
		t.Fatalf("wrong candidate filters: %s", encoded)
	}
}

func TestDynamicComparisonRetainsOptionNameAndCalculationMetadata(t *testing.T) {
	chart := dynamicChart(t)
	chart.Dynamics[1].Options[0].Label = "SUM(Revenue)"
	chart.Query.Measures[0].Compute = &query.Compute{Type: query.Compare, TimeField: "created", Offset: &query.Duration{N: 1, Unit: dialect.Year}, Output: "value"}
	chart.Filters = []ChartFilter{{ID: "date", Field: "created", Op: "time", Value: query.TimeRange{Current: dialect.Month}}}
	for _, output := range []string{"value", "delta", "ratio"} {
		chart.Query.Measures[0].Compute.Output = output
		for _, choice := range []string{"sum", "avg"} {
			resolved, err := chart.ResolveDynamics(map[string]string{"metric": choice})
			if err != nil {
				t.Fatal(err)
			}
			q, err := resolved.Filtered(nil, orders)
			if err != nil {
				t.Fatal(err)
			}
			compiled, err := query.Compile(&q, orders, query.Options{Dialect: dialect.Postgres{}, Now: time.Date(2026, 3, 10, 0, 0, 0, 0, time.UTC), DefaultLimit: 10, MaxLimit: 10})
			if err != nil {
				t.Fatal(err)
			}
			col := compiled.Columns[1]
			label := "SUM(Revenue)"
			if choice == "avg" {
				label = "Average"
			}
			if col.Label != label || col.Agg != "" || col.Compute != query.Compare || col.Comparison == nil || col.Comparison.Output != output {
				t.Fatalf("%s/%s metadata: %+v", choice, output, col)
			}
		}
	}
}

func TestDynamicRunningTotal(t *testing.T) {
	chart := dynamicChart(t)
	chart.Query.Measures[0].Compute = &query.Compute{Type: query.Cumulative, Along: "category"}
	// Every option of the measure is checked, not only the one shown first.
	if got := code(chart.Validate(orders, dialect.Postgres{})); got != "cumulative_agg" {
		t.Fatalf("an average among the options: %s", got)
	}
	chart.Dynamics[1].Options[1].Agg = dataset.Max
	if err := chart.Validate(orders, dialect.Postgres{}); err != nil {
		t.Fatal(err)
	}
	resolved, err := chart.ResolveDynamics(map[string]string{"group": "month", "metric": "avg"})
	if err != nil || resolved.Query.Measures[0].Compute == nil || resolved.Query.Measures[0].Compute.Along != "category" {
		t.Fatalf("switched: %+v %v", resolved.Query.Measures, err)
	}
	// Without the dimension it runs along, the measure is its plain aggregate.
	empty, err := chart.ResolveDynamics(map[string]string{"group": ""})
	if err != nil || empty.Query.Measures[0].Compute != nil {
		t.Fatalf("empty: %+v %v", empty.Query.Measures, err)
	}
	if chart.Query.Measures[0].Compute == nil {
		t.Fatal("resolving changed the chart")
	}
}
