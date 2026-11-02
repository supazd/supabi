package api

import (
	"context"
	"slices"
	"testing"
)

func expectOptionValues(t *testing.T, c *client, path string, body any, want ...string) {
	t.Helper()
	result := c.expect("POST", path, body, 200, "")
	values := []string{}
	for _, value := range result["values"].([]any) {
		values = append(values, value.(string))
	}
	slices.Sort(values)
	want = slices.Clone(want)
	slices.Sort(want)
	if !slices.Equal(values, want) {
		t.Fatalf("%s values=%v want=%v", path, values, want)
	}
}

func TestFilterOptionsKeepOriginalAggregateGroups(t *testing.T) {
	for _, fixed := range []bool{false, true} {
		name := "query HAVING"
		if fixed {
			name = "fixed aggregate chart filter"
		}
		t.Run(name, func(t *testing.T) {
			f := newContentFixture(t)
			input := f.chart("Monthly result", `{"type":"table"}`)
			spec := input["spec"].(map[string]any)
			q := spec["query"].(map[string]any)
			q["dimensions"] = []any{map[string]any{"field": "order_date", "grain": "month", "alias": "month"}}
			filters := []any{map[string]any{"id": "region", "field": "region", "op": "in", "label": "Region", "control": map[string]any{"type": "select", "multi": true}}}
			if fixed {
				filters = append(filters, map[string]any{"id": "minimum", "field": "revenue", "aggregation": "sum", "op": "gt", "value": 400})
			} else {
				q["having"] = map[string]any{"field": "revenue", "op": "gt", "value": 400}
			}
			spec["filters"] = filters
			id := f.developer.expect("POST", "/charts", input, 201, "")["id"].(string)
			f.share(t, id)
			data := f.viewer.expect("POST", "/charts/"+id+"/data", nil, 200, "")
			if got := encoded(t, data["rows"]); got != `[["2026-02-01","500.25"]]` {
				t.Fatalf("unexpected chart groups: %s", got)
			}
			expectOptionValues(t, f.viewer, "/charts/"+id+"/filters/region/options", map[string]any{}, "华东", "华南")
			// Search narrows only the projected choices; it must not change the
			// sum of the original month to the subtotal of the matching region.
			expectOptionValues(t, f.viewer, "/charts/"+id+"/filters/region/options", map[string]any{"search": "华南"}, "华南")
			expectOptionValues(t, f.developer, "/charts/preview/filters/region/options", map[string]any{"spec": spec}, "华东", "华南")

			board := dashboardSpec(id)
			board["filters"] = []any{map[string]any{"id": "region", "label": "Region", "op": "in", "control": map[string]any{"type": "select", "multi": true}, "targets": []any{map[string]any{"item": "wa", "field": "region"}}}}
			boardID := f.developer.expect("POST", "/dashboards", map[string]any{"name": "Monthly board", "spec": board}, 201, "")["id"].(string)
			f.share(t, boardID)
			expectOptionValues(t, f.viewer, "/dashboards/"+boardID+"/filters/region/options", map[string]any{}, "华东", "华南")
			expectOptionValues(t, f.viewer, "/dashboards/"+boardID+"/filters/region/options", map[string]any{"search": "华南"}, "华南")
			expectOptionValues(t, f.viewer, "/dashboards/"+boardID+"/items/wa/filters/region/options", map[string]any{}, "华东", "华南")
			expectOptionValues(t, f.developer, "/dashboards/preview/filters/region/options", map[string]any{"spec": board}, "华东", "华南")
			expectOptionValues(t, f.developer, "/dashboards/preview/items/wa/filters/region/options", map[string]any{"spec": board}, "华东", "华南")
		})
	}
}

func TestFilterOptionsPreserveNullGroupsAndIgnoreOriginalPagination(t *testing.T) {
	f := newContentFixture(t)
	if _, err := f.admin.db.Pool.Exec(context.Background(), `INSERT INTO orders VALUES
		(4, NULL, 50, 'null_day_a'), (5, NULL, 60, 'null_day_b'),
		(6, '2026-03-01', NULL, 'null_amount'), (7, '2026-03-02', NULL, NULL)`); err != nil {
		t.Fatal(err)
	}
	input := f.chart("Null groups", `{"type":"table"}`)
	spec := input["spec"].(map[string]any)
	q := spec["query"].(map[string]any)
	// The source SQL parameter normally excludes NULL order dates. Keep all
	// rows here so a NULL grouping key actually reaches the option join.
	original := f.admin.expect("GET", "/datasets/"+f.datasetID, nil, 200, "")
	datasetSpec := original["spec"].(map[string]any)
	datasetSpec["source"].(map[string]any)["sql"] = "SELECT * FROM " + f.admin.db.Schema + ".orders"
	datasetSpec["params"] = []any{}
	f.admin.editing("PUT", "/datasets/"+f.datasetID, map[string]any{"name": "订单", "datasourceId": original["datasourceId"], "spec": datasetSpec}, 200, "")
	q["dimensions"] = []any{map[string]any{"field": "order_date", "grain": "month", "alias": "month"}}
	q["limit"], q["offset"] = 1, 1
	q["having"] = map[string]any{"field": "revenue", "op": "gt", "value": 100}
	spec["filters"] = []any{map[string]any{"id": "region", "field": "region", "op": "in", "label": "Region", "control": map[string]any{"type": "select", "multi": true}}}
	id := f.developer.expect("POST", "/charts", input, 201, "")["id"].(string)
	path := "/charts/" + id + "/filters/region/options"
	f.share(t, id)
	expectOptionValues(t, f.viewer, path, map[string]any{}, "华东", "华南", "null_day_a", "null_day_b")

	// The all-NULL sum group passes IS NULL. Its NULL candidate is omitted,
	// while the non-NULL region in the same group remains selectable.
	q["having"] = map[string]any{"field": "revenue", "op": "is_null"}
	f.developer.editing("PUT", "/charts/"+id, input, 200, "")
	expectOptionValues(t, f.viewer, path, map[string]any{}, "null_amount")

	// Without dimensions, the single aggregate gates all source rows. A
	// rejected aggregate yields no options; a matching one yields all values.
	q["dimensions"] = []any{}
	q["having"] = map[string]any{"field": "revenue", "op": "gt", "value": 700}
	f.developer.editing("PUT", "/charts/"+id, input, 200, "")
	expectOptionValues(t, f.viewer, path, map[string]any{}, "华东", "华南", "null_day_a", "null_day_b", "null_amount")
	q["having"] = map[string]any{"field": "revenue", "op": "gt", "value": 1000}
	f.developer.editing("PUT", "/charts/"+id, input, 200, "")
	expectOptionValues(t, f.viewer, path, map[string]any{})
}

func TestWidgetOptionsApplyGlobalAggregateAtOriginalGrain(t *testing.T) {
	f := newContentFixture(t)
	input := f.chart("Global aggregate", `{"type":"table"}`)
	spec := input["spec"].(map[string]any)
	spec["query"].(map[string]any)["dimensions"] = []any{map[string]any{"field": "order_date", "grain": "month", "alias": "month"}}
	spec["filters"] = []any{map[string]any{"id": "region", "field": "region", "op": "in", "label": "Region", "control": map[string]any{"type": "select", "multi": true}}}
	id := f.developer.expect("POST", "/charts", input, 201, "")["id"].(string)
	board := dashboardSpec(id)
	board["filters"] = []any{map[string]any{"id": "minimum", "label": "Minimum", "op": "gt", "control": map[string]any{"type": "number"}, "default": 400, "targets": []any{map[string]any{"item": "wa", "measure": "revenue"}}}}
	boardID := f.developer.expect("POST", "/dashboards", map[string]any{"name": "Global aggregate", "spec": board}, 201, "")["id"].(string)
	f.share(t, boardID)
	path := "/dashboards/" + boardID + "/items/wa/filters/region/options"
	expectOptionValues(t, f.viewer, path, map[string]any{}, "华东", "华南")
	expectOptionValues(t, f.viewer, path, map[string]any{"search": "华南"}, "华南")
	expectOptionValues(t, f.viewer, path, map[string]any{"filters": map[string]any{"minimum": 600}})
	expectOptionValues(t, f.viewer, path, map[string]any{"filters": map[string]any{"minimum": 600}, "useChartFilters": true}, "华东", "华南")
}

func TestDraftOptionsCanUseResultFilterBeforeSelectingOutputs(t *testing.T) {
	f := newContentFixture(t)
	input := f.chart("Unfinished draft", `{"type":"table"}`)
	spec := input["spec"].(map[string]any)
	q := spec["query"].(map[string]any)
	q["dimensions"], q["measures"] = []any{}, []any{}
	spec["filters"] = []any{
		map[string]any{"id": "region", "field": "region", "op": "in", "label": "Region", "control": map[string]any{"type": "select", "multi": true}},
		map[string]any{"id": "minimum", "field": "revenue", "aggregation": "sum", "op": "gt", "value": 600},
	}
	expectOptionValues(t, f.developer, "/charts/preview/filters/region/options", map[string]any{"spec": spec}, "华东", "华南")
}

func TestComparisonFilterOptionsAcrossChartAndDashboard(t *testing.T) {
	for _, compareHaving := range []bool{false, true} {
		name := "raw result filter"
		if compareHaving {
			name = "comparison result filter"
		}
		t.Run(name, func(t *testing.T) {
			f := newContentFixture(t)
			input := f.chart("Comparison options", `{"type":"table"}`)
			spec := input["spec"].(map[string]any)
			q := spec["query"].(map[string]any)
			q["dimensions"] = []any{map[string]any{"field": "order_date", "grain": "month", "alias": "month"}}
			q["measures"] = []any{map[string]any{"field": "revenue", "agg": "sum", "compute": map[string]any{"type": "compare", "timeField": "order_date", "offset": map[string]any{"n": 1, "unit": "month"}, "output": "ratio"}}}
			spec["filters"] = []any{
				map[string]any{"id": "period", "field": "order_date", "op": "time", "label": "Period", "value": map[string]any{"start": "2026-02-01", "end": "2026-03-01"}, "control": map[string]any{"type": "relative"}},
				map[string]any{"id": "region", "field": "region", "op": "in", "label": "Region", "control": map[string]any{"type": "select", "multi": true}},
				map[string]any{"id": "minimum", "field": "revenue", "aggregation": "sum", "op": "gt", "value": 400},
			}
			if compareHaving {
				q["having"] = map[string]any{"field": "revenue", "op": "gt", "value": 0}
			}
			id := f.developer.expect("POST", "/charts", input, 201, "")["id"].(string)
			f.share(t, id)
			expectOptionValues(t, f.viewer, "/charts/"+id+"/filters/region/options", map[string]any{}, "华东", "华南")
			expectOptionValues(t, f.developer, "/charts/preview/filters/region/options", map[string]any{"spec": spec}, "华东", "华南")
			board := dashboardSpec(id)
			board["filters"] = []any{map[string]any{"id": "region", "label": "Region", "op": "in", "control": map[string]any{"type": "select", "multi": true}, "targets": []any{map[string]any{"item": "wa", "field": "region"}}}}
			boardID := f.developer.expect("POST", "/dashboards", map[string]any{"name": "Comparison board", "spec": board}, 201, "")["id"].(string)
			f.share(t, boardID)
			expectOptionValues(t, f.viewer, "/dashboards/"+boardID+"/filters/region/options", map[string]any{}, "华东", "华南")
			expectOptionValues(t, f.viewer, "/dashboards/"+boardID+"/items/wa/filters/region/options", map[string]any{}, "华东", "华南")
			expectOptionValues(t, f.developer, "/dashboards/preview/filters/region/options", map[string]any{"spec": board}, "华东", "华南")
			expectOptionValues(t, f.developer, "/dashboards/preview/items/wa/filters/region/options", map[string]any{"spec": board}, "华东", "华南")
			if compareHaving {
				// A viewer changing the comparison period also changes the candidate
				// groups. January has no previous-period data in this fixture.
				expectOptionValues(t, f.viewer, "/charts/"+id+"/filters/region/options", map[string]any{"filters": map[string]any{"period": map[string]any{"start": "2026-01-01", "end": "2026-02-01"}}})
			}
		})
	}
}
