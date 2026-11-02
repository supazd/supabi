package api

import (
	"encoding/json"
	"testing"
)

func encoded(t *testing.T, value any) string {
	t.Helper()
	out, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

func TestChartUpdatePreservesCascadeBindingValidation(t *testing.T) {
	f := newContentFixture(t)
	first := f.chart("First", `{"type":"table"}`)
	firstID := f.developer.expect("POST", "/charts", first, 201, "")["id"].(string)
	secondID := f.developer.expect("POST", "/charts", f.chart("Second", `{"type":"table"}`), 201, "")["id"].(string)
	board := dashboardSpec(firstID, secondID)
	board["filters"] = []any{
		map[string]any{"id": "region", "label": "Region", "op": "in", "control": map[string]any{"type": "select"}, "optionsFrom": "wb", "targets": []any{map[string]any{"item": "wb", "field": "region"}}},
		map[string]any{"id": "amount", "label": "Amount", "op": "in", "control": map[string]any{"type": "select"}, "dependsOn": []string{"region"}, "optionsFrom": "wb", "targets": []any{map[string]any{"item": "wa", "field": "amount"}, map[string]any{"item": "wb", "field": "amount"}}},
	}
	f.developer.expect("POST", "/dashboards", map[string]any{"name": "Connected", "spec": board}, 201, "")
	first["name"] = "Renamed"
	f.developer.editing("PUT", "/charts/"+firstID, first, 200, "")

	original := f.admin.expect("GET", "/datasets/"+f.datasetID, nil, 200, "")
	withoutAmount := f.admin.spec(func(spec map[string]any) {
		fields := []any{}
		for _, field := range spec["fields"].([]any) {
			if field.(map[string]any)["key"] != "amount" {
				fields = append(fields, field)
			}
		}
		spec["fields"] = fields
	})
	datasetID := f.admin.expect("POST", "/datasets", map[string]any{"name": "Without amount", "datasourceId": original["datasourceId"], "spec": withoutAmount}, 201, "")["id"].(string)
	first["spec"].(map[string]any)["query"].(map[string]any)["dataset"] = datasetID
	f.developer.editing("PUT", "/charts/"+firstID, first, 409, "filter_in_use")
}

func TestDynamicSelectionsThroughChartDashboardAndPreview(t *testing.T) {
	f := newContentFixture(t)
	input := f.chart("Dynamic chart", `{"type":"bar","x":"category","y":["metric"]}`)
	spec := input["spec"].(map[string]any)
	q := spec["query"].(map[string]any)
	q["dimensions"] = []any{map[string]any{"field": "region", "alias": "category"}}
	q["measures"] = []any{map[string]any{"field": "revenue", "agg": "sum", "alias": "metric"}}
	spec["dynamics"] = []any{
		map[string]any{"id": "group", "kind": "dimension", "label": "Group", "alias": "category", "allowEmpty": true, "options": []any{map[string]any{"id": "region", "field": "region"}, map[string]any{"id": "month", "field": "order_date", "grain": "month"}}},
		map[string]any{"id": "measure", "kind": "measure", "label": "Measure", "alias": "metric", "options": []any{map[string]any{"id": "sum", "field": "revenue", "agg": "sum"}, map[string]any{"id": "max", "field": "revenue", "agg": "max"}}},
	}
	spec["filters"] = []any{
		map[string]any{"id": "local_sum", "field": "revenue", "aggregation": "sum", "op": "gte", "label": "Sum", "control": map[string]any{"type": "number"}},
		map[string]any{"id": "local_max", "field": "revenue", "aggregation": "max", "op": "gte", "label": "Max", "control": map[string]any{"type": "number"}},
	}
	chartID := f.developer.expect("POST", "/charts", input, 201, "")["id"].(string)
	f.share(t, chartID)
	result := f.viewer.expect("POST", "/charts/"+chartID+"/data", map[string]any{"selections": map[string]string{"measure": "max"}}, 200, "")
	if got := encoded(t, result["rows"]); got != `[["华东","200.00"],["华南","300.25"]]` {
		t.Fatalf("selected chart data: %s", got)
	}
	result = f.viewer.expect("POST", "/charts/"+chartID+"/data", map[string]any{"selections": map[string]string{"group": "", "measure": "max"}}, 200, "")
	if got := encoded(t, result["rows"]); got != `[["300.25"]]` {
		t.Fatalf("empty dimension: %s", got)
	}
	f.viewer.expect("POST", "/charts/"+chartID+"/data", map[string]any{"selections": map[string]string{"measure": ""}}, 400, "invalid_dynamic_selection")
	f.viewer.expect("POST", "/charts/"+chartID+"/data", map[string]any{"selections": map[string]string{"private": "revenue"}}, 400, "unknown_dynamic")
	dashboard := dashboardSpec(chartID)
	dashboard["filters"] = []any{map[string]any{"id": "minimum", "label": "Minimum", "op": "gt", "control": map[string]any{"type": "number"}, "default": 250, "targets": []any{map[string]any{"item": "wa", "measure": "metric"}}}}
	id := f.developer.expect("POST", "/dashboards", map[string]any{"name": "Dynamic board", "spec": dashboard}, 201, "")["id"].(string)
	f.share(t, id)
	result = f.viewer.expect("POST", "/dashboards/"+id+"/items/wa/data", map[string]any{"selections": map[string]string{"measure": "max"}}, 200, "")
	if got := encoded(t, result["rows"]); got != `[["华南","300.25"]]` {
		t.Fatalf("dynamic global threshold: %s", got)
	}
	if got := encoded(t, result["meta"].(map[string]any)["overriddenFilters"]); got != `["local_max"]` {
		t.Fatalf("dynamic takeover metadata: %s", got)
	}
	personal := f.viewer.expect("POST", "/dashboards/"+id+"/items/wa/data", map[string]any{"useChartFilters": true}, 200, "")
	if got := encoded(t, personal["meta"].(map[string]any)["overriddenFilters"]); got != `[]` {
		t.Fatalf("restored filter metadata: %s", got)
	}
	result = f.developer.expect("POST", "/dashboards/preview/items/wa/data", map[string]any{"spec": dashboard, "selections": map[string]string{"measure": "max"}}, 200, "")
	if got := encoded(t, result["rows"]); got != `[["华南","300.25"]]` {
		t.Fatalf("preview selection: %s", got)
	}
	stored := f.viewer.expect("GET", "/charts/"+chartID, nil, 200, "")
	if encoded(t, stored["spec"]) != encoded(t, spec) {
		t.Fatal("viewer selection changed saved chart")
	}
}

func TestCascadeOptionsAcrossChartDashboardAndDraftEndpoints(t *testing.T) {
	f := newContentFixture(t)
	input := f.chart("Cascading chart", `{"type":"table"}`)
	spec := input["spec"].(map[string]any)
	spec["query"].(map[string]any)["dimensions"] = []any{map[string]any{"field": "region"}}
	spec["filters"] = []any{
		map[string]any{"id": "region", "field": "region", "op": "in", "label": "Region", "control": map[string]any{"type": "tiles", "multi": true}},
		map[string]any{"id": "amount", "field": "amount", "op": "in", "label": "Amount", "control": map[string]any{"type": "select", "multi": true}, "dependsOn": []string{"region"}},
		map[string]any{"id": "fixed", "field": "order_date", "op": "time", "value": map[string]any{"start": "2026-02-01", "end": "2026-03-01"}},
	}
	chartID := f.developer.expect("POST", "/charts", input, 201, "")["id"].(string)
	check := func(c *client, path string, body any, want string) {
		t.Helper()
		result := c.expect("POST", path, body, 200, "")
		if got := encoded(t, result["values"]); got != want {
			t.Fatalf("%s values=%s want=%s", path, got, want)
		}
	}
	f.share(t, chartID)
	check(f.viewer, "/charts/"+chartID+"/filters/amount/options", map[string]any{"filters": map[string]any{"region": []any{"华东"}}}, `["200.00"]`)
	check(f.viewer, "/charts/"+chartID+"/filters/region/options", map[string]any{"filters": map[string]any{"amount": []any{300.25}}, "related": true}, `["华南"]`)
	check(f.developer, "/charts/preview/filters/amount/options", map[string]any{"spec": spec, "filters": map[string]any{"region": []any{"华东"}}}, `["200.00"]`)
	f.viewer.expect("POST", "/charts/preview/filters/amount/options", map[string]any{"spec": spec}, 403, "forbidden")
	f.viewer.expect("POST", "/charts/"+chartID+"/filters/amount/options", map[string]any{"filters": map[string]any{"fixed": nil}}, 400, "filter_not_interactive")
	dashboard := dashboardSpec(chartID)
	dashboard["filters"] = []any{
		map[string]any{"id": "g_region", "label": "Region", "op": "in", "control": map[string]any{"type": "select", "multi": true}, "targets": []any{map[string]any{"item": "wa", "field": "region"}}},
		map[string]any{"id": "g_amount", "label": "Amount", "op": "in", "control": map[string]any{"type": "tiles", "multi": true}, "dependsOn": []string{"g_region"}, "targets": []any{map[string]any{"item": "wa", "field": "amount"}}},
	}
	id := f.developer.expect("POST", "/dashboards", map[string]any{"name": "Cascade board", "spec": dashboard}, 201, "")["id"].(string)
	f.share(t, id)
	check(f.viewer, "/dashboards/"+id+"/filters/g_amount/options", map[string]any{"filters": map[string]any{"g_region": []any{"华东"}}}, `["200.00"]`)
	check(f.viewer, "/dashboards/"+id+"/filters/g_region/options", map[string]any{"filters": map[string]any{"g_amount": []any{300.25}}, "related": true}, `["华南"]`)
	check(f.viewer, "/dashboards/"+id+"/items/wa/filters/amount/options", map[string]any{"filters": map[string]any{"g_region": []any{"华南"}}, "chartFilters": map[string]any{"region": []any{"华东"}}}, `["300.25"]`)
	check(f.viewer, "/dashboards/"+id+"/items/wa/filters/amount/options", map[string]any{"filters": map[string]any{"g_region": []any{"华南"}}, "chartFilters": map[string]any{"region": []any{"华东"}}, "useChartFilters": true}, `["200.00"]`)
	check(f.developer, "/dashboards/preview/filters/g_amount/options", map[string]any{"spec": dashboard, "filters": map[string]any{"g_region": []any{"华东"}}}, `["200.00"]`)
	check(f.developer, "/dashboards/preview/items/wa/filters/amount/options", map[string]any{"spec": dashboard, "filters": map[string]any{"g_region": []any{"华南"}}}, `["300.25"]`)
	f.viewer.expect("POST", "/dashboards/"+id+"/filters/g_region/options", map[string]any{"filters": map[string]any{"private": []any{"x"}}}, 400, "unknown_filter")
}
