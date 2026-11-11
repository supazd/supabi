package content

import (
	"strings"
	"testing"

	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/dialect"
	"github.com/supazd/supabi/internal/query"
)

func metricDataset() *dataset.Spec {
	ds := *orders
	ds.Fields = append(append([]dataset.Field(nil), orders.Fields...), dataset.Field{
		Key: "share", Label: "Share", Expr: "SUM(${amount}) / 100", Type: datasource.Decimal, Role: dataset.Metric,
	}, dataset.Field{Key: "row_count", Label: "Rows", Expr: "COUNT(${amount})", Type: datasource.Integer, Role: dataset.Metric})
	return &ds
}

func compileChartQuery(t *testing.T, q query.Query, ds *dataset.Spec) *query.Compiled {
	t.Helper()
	got, err := query.Compile(&q, ds, query.Options{Dialect: dialect.Postgres{}, DefaultLimit: 10, MaxLimit: 10})
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func TestGlobalFieldsOverrideOperationsAndRestore(t *testing.T) {
	chart := chartSpec(t, `{"query":{"version":1,"dataset":"d","measures":[{"field":"revenue","agg":"sum"}],"filter":{"field":"amount","op":"gt","value":0}},"filters":[
		{"id":"amount","field":"amount","op":"lte","value":10,"label":"Amount","control":{"type":"number"}},
		{"id":"fixed","field":"amount","op":"gte","value":1},
		{"id":"region","field":"region","op":"in","value":["east"],"label":"Region","control":{"type":"select"}}]}`)
	item := Item{ID: "w1", ChartID: "c"}
	dash := DashboardSpec{Filters: []Filter{{ID: "global", Op: "gte", Control: Control{Type: ControlNumber}, Default: float64(20), Targets: []FilterTarget{{Item: "w1", Field: "amount"}}}}}
	q, err := dash.QueryForViewer(item, chart, orders, nil, map[string]any{"amount": float64(2), "region": []any{"west"}}, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(q.Filter.Args) != 3 || q.Filter.Args[0].Op != "gt" || q.Filter.Args[1].Op != "gte" || q.Filter.Args[1].Value != float64(20) || q.Filter.Args[2].Field != "region" {
		t.Fatalf("global should replace both local amount conditions, retain query policy and own region: %+v", q.Filter)
	}
	compileChartQuery(t, q, orders)
	q, err = dash.QueryForViewer(item, chart, orders, map[string]any{"global": nil}, nil, false)
	if err != nil || len(q.Filter.Args) != 2 || q.Filter.Args[1].Field != "region" {
		t.Fatalf("empty global must still take over local amount: %+v, %v", q.Filter, err)
	}
	q, err = dash.QueryForViewer(item, chart, orders, map[string]any{"global": float64(100)}, map[string]any{"amount": float64(3)}, true)
	if err != nil || len(q.Filter.Args) != 4 || q.Filter.Args[1].Op != "lte" || q.Filter.Args[1].Value != float64(3) || q.Filter.Args[2].Op != "gte" {
		t.Fatalf("chart mode must restore chart operations and own values: %+v, %v", q.Filter, err)
	}
	if chart.Filters[0].Value != float64(10) || chart.Query.Filter.Op != "gt" {
		t.Fatal("viewer must not mutate chart defaults")
	}
	for _, own := range []map[string]any{{"fixed": 1}, {"unknown": 1}} {
		if _, err := dash.QueryForViewer(item, chart, orders, nil, own, false); code(err) != "filter_not_interactive" {
			t.Fatalf("invalid own value: %v", err)
		}
	}
	if _, err := dash.QueryForViewer(item, chart, orders, map[string]any{"unknown": 1}, nil, true); code(err) != "unknown_filter" {
		t.Fatalf("unknown global: %v", err)
	}
}

func TestGlobalDatasetMetricAndChartMeasures(t *testing.T) {
	ds := metricDataset()
	chart := chartSpec(t, `{"query":{"version":1,"dataset":"d","dimensions":[{"field":"region"}],"measures":[{"field":"revenue","agg":"sum","alias":"total"}]},"filters":[
		{"id":"raw","field":"revenue","op":"gte","value":5},
		{"id":"metric","field":"share","op":"lte","value":10,"label":"Share","control":{"type":"number"}}]}`)
	dash := DashboardSpec{Filters: []Filter{
		{ID: "metric", Op: "gte", Control: Control{Type: ControlNumber}, Default: float64(20), Targets: []FilterTarget{{Item: "w", Field: "share"}}},
		{ID: "total", Op: "lte", Control: Control{Type: ControlNumber}, Default: float64(5000), Targets: []FilterTarget{{Item: "w", Measure: "total"}}},
	}}
	q, err := dash.QueryForViewer(Item{ID: "w"}, chart, ds, nil, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	compiled := compileChartQuery(t, q, ds)
	if len(compiled.Columns) != 2 || compiled.Columns[1].Name != "total" {
		t.Fatalf("hidden metric leaked into result: %+v", compiled.Columns)
	}
	if len(q.FilterMeasures) != 1 || q.FilterMeasures[0].Field != "share" {
		t.Fatalf("missing unselected dataset metric: %+v", q.FilterMeasures)
	}
	if q.Filter == nil || q.Filter.Args[0].Field != "revenue" {
		t.Fatalf("aggregate target must not override raw measure filter: %+v", q.Filter)
	}
	if len(q.Having.Args) != 2 || q.Having.Args[0].Op != "gte" || q.Having.Args[1].Field != "total" {
		t.Fatalf("metric override and measure target: %+v", q.Having)
	}
	if !strings.Contains(compiled.SQL, "HAVING") || !strings.Contains(compiled.SQL, `SUM(t."amount")`) {
		t.Fatalf("missing aggregate predicates: %s", compiled.SQL)
	}
	if len(chart.Query.FilterMeasures) != 0 {
		t.Fatal("query mutated")
	}
}

func TestChartMetricFilterPreservesOutputAndHaving(t *testing.T) {
	ds := metricDataset()
	chart := chartSpec(t, `{"specVersion":1,"query":{"version":1,"dataset":"d","dimensions":[{"field":"region","alias":"filter_measure_1"}],"measures":[{"field":"revenue","agg":"sum"}],"having":{"field":"revenue","op":"gt","value":0}},"viz":{"type":"table"},"filters":[{"id":"share","field":"share","op":"gte","value":10,"label":"Share","control":{"type":"number"}}]}`)
	if err := chart.Validate(ds, dialect.Postgres{}); err != nil {
		t.Fatal(err)
	}
	q, err := chart.ForViewer(nil, ds)
	if err != nil {
		t.Fatal(err)
	}
	if q.Filter != nil || q.FilterMeasures[0].Alias != "filter_measure_2" || len(q.Having.Args) != 2 || q.Having.Args[0].Field != "revenue" {
		t.Fatalf("wrong hidden metric or lost original HAVING: %+v", q)
	}
	if got := compileChartQuery(t, q, ds); len(got.Columns) != 2 {
		t.Fatalf("extra columns: %+v", got.Columns)
	}
	// Reuse an already selected metric under its output alias.
	chart.Query.Measures = append(chart.Query.Measures, query.Measure{Field: "share", Alias: "percentage"})
	q, err = chart.ForViewer(nil, ds)
	if err != nil || len(q.FilterMeasures) != 0 || q.Having.Args[1].Field != "percentage" {
		t.Fatalf("did not reuse selected metric: %+v %v", q, err)
	}
}

func TestGlobalTargetNormalizationAndCompatibility(t *testing.T) {
	ds := metricDataset()
	chart := chartSpec(t, `{"query":{"version":1,"dataset":"d","measures":[{"field":"share","alias":"percentage"},{"field":"revenue","agg":"sum","alias":"total"}]},"filters":[{"id":"legacy","field":"region","op":"in","control":{"type":"select"}}]}`)
	lookup := func(string) (*ChartSpec, *dataset.Spec, bool) { return chart, ds, true }
	dash := DashboardSpec{SpecVersion: 1, Layout: Layout{Columns: 12, Items: []Item{{ID: "w", Type: ItemChart, ChartID: "c", W: 1, H: 1}}}, Filters: []Filter{
		{ID: "legacy", Label: "Region", Control: Control{Type: ControlSelect}, Targets: []FilterTarget{{Item: "w", Filter: "legacy"}}},
		{ID: "metric", Label: "Share", Op: "gte", Control: Control{Type: ControlNumber}, Targets: []FilterTarget{{Item: "w", Measure: "percentage"}}},
	}}
	if err := dash.CheckFilters(lookup); err != nil {
		t.Fatal(err)
	}
	if dash.Filters[0].Op != "in" || dash.Filters[0].Targets[0].Field != "region" || dash.Filters[0].Targets[0].Filter != "" || dash.Filters[1].Targets[0].Field != "share" {
		t.Fatalf("normalization: %+v", dash.Filters)
	}
	metric := dash.Filters[1]
	metric.ID = "duplicate"
	metric.Targets = []FilterTarget{{Item: "w", Measure: "percentage"}}
	dash.Filters = append(dash.Filters, metric)
	if err := dash.CheckFilters(lookup); err != nil {
		t.Fatalf("multiple global conditions on the same metric must remain valid: %v", err)
	}

	cases := []struct {
		name    string
		targets []FilterTarget
		control Control
		op      string
		want    string
	}{
		{"same raw+aggregate in global", []FilterTarget{{Item: "w", Field: "revenue"}, {Item: "other", Measure: "total"}}, Control{Type: ControlNumber}, "gte", "filter_targets_differ"},
		{"same numeric type on different fields", []FilterTarget{{Item: "w", Field: "revenue"}, {Item: "other", Field: "amount"}}, Control{Type: ControlNumber}, "gte", ""},
		{"integer and decimal aggregates", []FilterTarget{{Item: "w", Field: "row_count"}, {Item: "other", Field: "share"}}, Control{Type: ControlNumber}, "gte", "filter_targets_differ"},
		{"unknown measure", []FilterTarget{{Item: "w", Measure: "gone"}}, Control{Type: ControlNumber}, "gte", "unknown_output_measure"},
		{"aggregate enumerator", []FilterTarget{{Item: "w", Field: "share"}}, Control{Type: ControlSelect}, "in", "invalid_filter_control"},
		{"direct hidden field", []FilterTarget{{Item: "w", Field: "created"}}, Control{Type: ControlDate}, "time", ""},
		{"ambiguous target", []FilterTarget{{Item: "w", Field: "share", Measure: "percentage"}}, Control{Type: ControlNumber}, "gte", "invalid_filter_target"},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			dash.Filters = []Filter{{ID: "test", Label: "Test", Op: tt.op, Control: tt.control, Targets: tt.targets}}
			dash.Layout.Items = append(dash.Layout.Items, Item{ID: "other", ChartID: "c"})
			if got := code(dash.CheckFilters(lookup)); got != tt.want {
				t.Fatalf("got %q want %q", got, tt.want)
			}
		})
	}
	chart.Query.Mode = query.ModeDetail
	if _, err := ResolveFilterTarget(chart, ds, FilterTarget{Field: "share"}); code(err) != "invalid_filter_target" {
		t.Fatalf("detail aggregate: %v", err)
	}
}

func TestAggregateTargetIdentity(t *testing.T) {
	chart := chartSpec(t, `{"query":{"measures":[{"field":"revenue","agg":"sum","alias":"default_sum"},{"alias":"explicit_sum","field":"revenue","agg":"sum"},{"alias":"avg","field":"revenue","agg":"avg"}]}}`)
	a, _ := ResolveFilterTarget(chart, orders, FilterTarget{Measure: "default_sum"})
	b, _ := ResolveFilterTarget(chart, orders, FilterTarget{Measure: "explicit_sum"})
	c, _ := ResolveFilterTarget(chart, orders, FilterTarget{Measure: "avg"})
	if a.Identity != b.Identity || a.Identity == c.Identity || c.Measure.Field != "revenue" || c.Measure.Agg != dataset.Avg {
		t.Fatalf("wrong identities: %+v %+v %+v", a, b, c)
	}
}

func TestChartMetricControls(t *testing.T) {
	ds := metricDataset()
	for _, tt := range []struct {
		name, op, control, want string
		value                   any
	}{
		{"select", "in", ControlSelect, "invalid_filter_control", nil},
		{"search select", "in", ControlSearchSelect, "invalid_filter_control", nil},
		{"text", "eq", ControlText, "invalid_filter_control", nil},
		{"date", "time", ControlDate, "invalid_filter_control", nil},
		{"number", "gte", ControlNumber, "", float64(1)},
		{"range", "between", ControlNumberRange, "", []any{float64(1), float64(3)}},
		{"fixed comparison", "lte", "", "", float64(3)},
		{"fixed null", "is_null", "", "", nil},
	} {
		t.Run(tt.name, func(t *testing.T) {
			chart := chartSpec(t, `{"specVersion":1,"query":{"version":1,"dataset":"d","measures":[{"field":"revenue","agg":"sum"}]},"viz":{"type":"table"}}`)
			f := ChartFilter{ID: "rows", Field: "row_count", Op: tt.op, Value: tt.value, Label: "Rows"}
			if tt.control != "" {
				f.Control = &Control{Type: tt.control}
			}
			chart.Filters = []ChartFilter{f}
			if got := code(chart.Validate(ds, dialect.Postgres{})); got != tt.want {
				t.Fatalf("got %q want %q", got, tt.want)
			}
		})
	}
}

func TestAggregateControlsForEveryResultType(t *testing.T) {
	ds := metricDataset()
	ds.Fields = append(ds.Fields,
		dataset.Field{Key: "first_region", Label: "First region", Expr: "MIN(${region})", Type: datasource.String, Role: dataset.Metric},
		dataset.Field{Key: "last_created", Label: "Last created", Expr: "MAX(${created})", Type: datasource.Timestamp, Role: dataset.Metric},
		dataset.Field{Key: "has_orders", Label: "Has orders", Expr: "COUNT(${amount}) > 0", Type: datasource.Boolean, Role: dataset.Metric},
	)
	if err := ds.Validate(); err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct {
		field, op string
		control   Control
		value     any
		sql       string
	}{
		{"first_region", "contains", Control{Type: ControlText}, "east", "LIKE"},
		{"last_created", "time", Control{Type: ControlDateRange}, map[string]any{"start": "2026-10-01", "end": "2026-10-02"}, "::timestamptz"},
		{"has_orders", "in", Control{Type: ControlSelect}, []any{true}, " > 0)) IN"},
		{"has_orders", "in", Control{Type: ControlSearchSelect, Multi: true}, []any{true, false}, " > 0)) IN"},
	} {
		t.Run(tt.field+tt.control.Type, func(t *testing.T) {
			chart := chartSpec(t, `{"specVersion":1,"query":{"version":1,"dataset":"d","dimensions":[{"field":"region"}],"measures":[{"field":"revenue","agg":"sum"}]},"viz":{"type":"table"}}`)
			chart.Filters = []ChartFilter{{ID: "own", Field: tt.field, Op: tt.op, Label: "Metric", Control: &tt.control, Value: tt.value}}
			if err := chart.Validate(ds, dialect.Postgres{}); err != nil {
				t.Fatal(err)
			}
			q, err := chart.ForViewer(nil, ds)
			if err != nil {
				t.Fatal(err)
			}
			compiled := compileChartQuery(t, q, ds)
			if q.Filter != nil || q.Having == nil || len(compiled.Columns) != 2 || !strings.Contains(compiled.SQL, tt.sql) {
				t.Fatalf("invalid typed HAVING: %s, %+v", compiled.SQL, compiled.Columns)
			}
			dash := DashboardSpec{Layout: Layout{Items: []Item{{ID: "w", ChartID: "c"}}}, Filters: []Filter{{ID: "global", Label: "Metric", Op: tt.op, Control: tt.control, Default: tt.value, Targets: []FilterTarget{{Item: "w", Field: tt.field}}}}}
			if err := dash.CheckFilters(func(string) (*ChartSpec, *dataset.Spec, bool) { return chart, ds, true }); err != nil {
				t.Fatal(err)
			}
			q, err = dash.QueryForViewer(Item{ID: "w"}, chart, ds, nil, nil, false)
			if err != nil || len(q.Having.Args) != 1 {
				t.Fatalf("global must override local metric once: %+v %v", q, err)
			}
			compileChartQuery(t, q, ds)
		})
	}
	for _, typ := range []datasource.Type{datasource.String, datasource.Integer, datasource.Decimal, datasource.Timestamp} {
		for _, control := range []string{ControlSelect, ControlSearchSelect} {
			if (Control{Type: control}).aggregateFits("in", typ) {
				t.Fatalf("aggregate %s cannot enumerate group values with %s", typ, control)
			}
		}
	}
}

func TestGlobalConditionsShareFieldsAndWidgets(t *testing.T) {
	chart := chartSpec(t, `{"specVersion":1,"query":{"version":1,"dataset":"d","measures":[{"field":"revenue","agg":"sum"}]},"viz":{"type":"table"},"filters":[{"id":"lower","field":"amount","op":"gte","value":5,"label":"Minimum","control":{"type":"number"}},{"id":"upper","field":"amount","op":"lte","value":100,"label":"Maximum","control":{"type":"number"}}]}`)
	dash := DashboardSpec{SpecVersion: 1, Layout: Layout{Columns: 12, Items: []Item{{ID: "w", Type: ItemChart, ChartID: "c", W: 1, H: 1}}}, Filters: []Filter{
		{ID: "min", Label: "Minimum", Control: Control{Type: ControlNumber}, Default: float64(10), Targets: []FilterTarget{{Item: "w", Filter: "lower"}}},
		{ID: "max", Label: "Maximum", Control: Control{Type: ControlNumber}, Default: float64(30), Targets: []FilterTarget{{Item: "w", Filter: "upper"}}},
	}}
	lookup := func(string) (*ChartSpec, *dataset.Spec, bool) { return chart, orders, true }
	if err := dash.Validate(); err != nil {
		t.Fatal(err)
	}
	if err := dash.CheckFilters(lookup); err != nil {
		t.Fatal(err)
	}
	if err := dash.Validate(); err != nil {
		t.Fatalf("normalized legacy conditions must remain valid: %v", err)
	}
	q, err := dash.QueryForViewer(dash.Layout.Items[0], chart, orders, nil, nil, false)
	if err != nil || len(q.Filter.Args) != 2 || q.Filter.Args[0].Op != "gte" || q.Filter.Args[0].Value != float64(10) || q.Filter.Args[1].Op != "lte" || q.Filter.Args[1].Value != float64(30) {
		t.Fatalf("all global conditions must be ANDed, local conditions replaced: %+v %v", q.Filter, err)
	}
	compileChartQuery(t, q, orders)
	// One global control can apply the same condition to two fields of a widget.
	dash.Filters = []Filter{{ID: "both", Label: "Minimum", Op: "gte", Control: Control{Type: ControlNumber}, Default: float64(20), Targets: []FilterTarget{{Item: "w", Field: "amount"}, {Item: "w", Field: "revenue"}}}}
	if err := dash.CheckFilters(lookup); err != nil {
		t.Fatal(err)
	}
	q, err = dash.QueryForViewer(dash.Layout.Items[0], chart, orders, nil, nil, false)
	if err != nil || len(q.Filter.Args) != 2 || q.Filter.Args[0].Field != "amount" || q.Filter.Args[1].Field != "revenue" {
		t.Fatalf("same widget multiple fields: %+v %v", q.Filter, err)
	}
	compileChartQuery(t, q, orders)
}

func TestAggregateTemporalAndStringFilterTargets(t *testing.T) {
	chart := chartSpec(t, `{"query":{"version":1,"dataset":"d","measures":[{"alias":"first_region","field":"region","agg":"min"},{"alias":"last_created","field":"created","agg":"max"}]}}`)
	dash := DashboardSpec{Layout: Layout{Items: []Item{{ID: "w", ChartID: "c"}}}, Filters: []Filter{
		{ID: "name", Label: "First region", Op: "starts_with", Control: Control{Type: ControlText}, Default: "e", Targets: []FilterTarget{{Item: "w", Measure: "first_region"}}},
		{ID: "time", Label: "Last created", Op: "time", Control: Control{Type: ControlDate}, Default: map[string]any{"start": "2026-10-01", "end": "2026-10-02"}, Targets: []FilterTarget{{Item: "w", Measure: "last_created"}}},
	}}
	if err := dash.CheckFilters(func(string) (*ChartSpec, *dataset.Spec, bool) { return chart, orders, true }); err != nil {
		t.Fatal(err)
	}
	q, err := dash.QueryForViewer(Item{ID: "w"}, chart, orders, nil, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	compiled := compileChartQuery(t, q, orders)
	if len(q.FilterMeasures) != 0 || len(q.Having.Args) != 2 || !strings.Contains(compiled.SQL, `(MAX(t."created_at"))::timestamptz`) || !strings.Contains(compiled.SQL, `MIN(t."region") LIKE`) {
		t.Fatalf("typed chart aggregate predicates: %s", compiled.SQL)
	}
}
