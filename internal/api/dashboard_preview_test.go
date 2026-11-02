package api

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestDashboardPreviewDoesNotSave(t *testing.T) {
	f := newContentFixture(t)
	chart := f.chart("preview chart", `{"type":"table"}`)
	chartSpec := chart["spec"].(map[string]any)
	chartSpec["query"].(map[string]any)["dimensions"] = []any{map[string]any{"field": "region"}}
	chartSpec["filters"] = []any{map[string]any{"id": "area", "field": "region", "op": "in", "value": []any{"华东"}, "label": "地区", "control": map[string]any{"type": "select"}}}
	chartID := f.developer.expect("POST", "/charts", chart, 201, "")["id"].(string)
	saved := f.developer.expect("POST", "/dashboards", map[string]any{"name": "saved", "spec": dashboardSpec(chartID)}, 201, "")
	id := saved["id"].(string)
	spec := dashboardSpec(chartID)
	spec["filters"] = []any{map[string]any{"id": "g", "label": "地区", "op": "in", "control": map[string]any{"type": "select"}, "default": []any{"华南"}, "targets": []any{map[string]any{"item": "wa", "field": "region"}}}}
	body := map[string]any{"spec": spec}
	checkRows := func(want string) {
		t.Helper()
		result := f.developer.expect("POST", "/dashboards/preview/items/wa/data", body, 200, "")
		rows, _ := json.Marshal(result["rows"])
		if string(rows) != want {
			t.Errorf("preview rows = %s, want %s", rows, want)
		}
	}
	checkRows(`[["华南","300.25"]]`)
	body["chartFilters"] = map[string]any{"area": []any{"华东"}}
	checkRows(`[["华南","300.25"]]`)
	body["useChartFilters"] = true
	checkRows(`[["华东","300.50"]]`)
	body["useChartFilters"] = false
	body["filters"] = map[string]any{"g": nil}
	checkRows(`[["华东","300.50"],["华南","300.25"]]`)
	delete(body, "filters")
	options := f.developer.expect("POST", "/dashboards/preview/filters/g/options", body, 200, "")
	if values, _ := json.Marshal(options["values"]); string(values) != `["华东","华南"]` {
		t.Errorf("draft options = %s", values)
	}
	body["search"] = "南"
	options = f.developer.expect("POST", "/dashboards/preview/filters/g/options", body, 200, "")
	if values, _ := json.Marshal(options["values"]); string(values) != `["华南"]` {
		t.Errorf("searched draft options = %s", values)
	}
	current := f.developer.expect("GET", "/dashboards/"+id, nil, 200, "")
	if !reflect.DeepEqual(current, saved) {
		t.Errorf("preview changed the saved dashboard: before=%v after=%v", saved, current)
	}
	_, dashboards := f.developer.do("GET", "/dashboards", nil)
	if len(dashboards.([]any)) != 1 {
		t.Errorf("preview created a dashboard: %v", dashboards)
	}
	f.viewer.expect("POST", "/dashboards/preview/items/wa/data", body, 403, "forbidden")
	f.viewer.expect("POST", "/dashboards/preview/filters/g/options", body, 403, "forbidden")
	f.developer.expect("POST", "/dashboards/preview/items/missing/data", body, 404, "not_found")
	f.developer.expect("POST", "/dashboards/preview/filters/missing/options", body, 404, "not_found")
	f.developer.expect("POST", "/dashboards/preview/items/wa/data", map[string]any{"spec": dashboardSpec("ch_missing")}, 400, "unknown_chart")
	spec["unexpected"] = true
	f.developer.expect("POST", "/dashboards/preview/items/wa/data", body, 400, "invalid_spec")
}

func TestDashboardPreviewAggregateFilters(t *testing.T) {
	f := newContentFixture(t)
	ds := f.admin.expect("GET", "/datasets/"+f.datasetID, nil, 200, "")
	dsSpec := f.admin.spec(func(spec map[string]any) {
		spec["fields"] = append(spec["fields"].([]any),
			map[string]any{"key": "last_order", "label": "最近下单", "expr": "MAX(${order_date})", "type": "date", "role": "metric"},
			map[string]any{"key": "last_region", "label": "最后地区", "expr": "MAX(${region})", "type": "string", "role": "metric"},
			map[string]any{"key": "all_large", "label": "均为大额", "expr": "BOOL_AND(${amount} > 150)", "type": "boolean", "role": "metric"})
	})
	f.admin.editing("PUT", "/datasets/"+f.datasetID, map[string]any{"name": "订单", "datasourceId": ds["datasourceId"], "spec": dsSpec}, 200, "")
	chart := f.chart("aggregates", `{"type":"table"}`)
	q := chart["spec"].(map[string]any)["query"].(map[string]any)
	q["dimensions"] = []any{map[string]any{"field": "region"}}
	q["measures"] = []any{map[string]any{"field": "revenue", "agg": "sum", "alias": "sales"}}
	chartID := f.developer.expect("POST", "/charts", chart, 201, "")["id"].(string)
	for _, tt := range []struct {
		name, kind, field, op, control, want string
		value                                any
	}{
		{"measure", "measure", "sales", "gte", "number", `[["华东","300.50"]]`, 300.4},
		{"date", "field", "last_order", "time", "date", `[["华南","300.25"]]`, map[string]any{"start": "2026-02-20", "end": "2026-02-21"}},
		{"text", "field", "last_region", "eq", "text", `[["华南","300.25"]]`, "华南"},
		{"boolean", "field", "all_large", "in", "select", `[["华南","300.25"]]`, []any{true}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			spec := dashboardSpec(chartID)
			spec["filters"] = []any{map[string]any{"id": "g", "label": "聚合", "op": tt.op, "control": map[string]any{"type": tt.control}, "default": tt.value, "targets": []any{map[string]any{"item": "wa", tt.kind: tt.field}}}}
			body := map[string]any{"spec": spec}
			result := f.developer.expect("POST", "/dashboards/preview/items/wa/data", body, 200, "")
			if rows, _ := json.Marshal(result["rows"]); string(rows) != tt.want || len(result["columns"].([]any)) != 2 {
				t.Errorf("aggregate preview = %s, columns=%v", rows, result["columns"])
			}
			if tt.control == "select" {
				options := f.developer.expect("POST", "/dashboards/preview/filters/g/options", body, 200, "")
				if values, _ := json.Marshal(options["values"]); string(values) != `[false,true]` {
					t.Errorf("boolean options = %s", values)
				}
			} else {
				f.developer.expect("POST", "/dashboards/preview/filters/g/options", body, 400, "invalid_filter_options")
			}
		})
	}
}

func TestDashboardQueryContainerRoundTrip(t *testing.T) {
	f := newContentFixture(t)
	chartID := f.developer.expect("POST", "/charts", f.chart("query container chart", `{"type":"table"}`), 201, "")["id"].(string)
	spec := dashboardSpec(chartID)
	spec["layout"].(map[string]any)["columns"] = 96
	spec["filters"] = []any{map[string]any{"id": "g", "label": "地区", "op": "in", "control": map[string]any{"type": "select"}, "default": []any{"华南"}, "targets": []any{map[string]any{"item": "wa", "field": "region"}}}}
	spec["queryContainer"] = map[string]any{"x": 48, "y": 4, "w": 48, "h": 33}
	spec["queryMode"] = "manual"
	spec["queryHeightMode"] = "manual"
	spec["filterStyle"] = map[string]any{"layout": "vertical", "density": "compact"}
	created := f.developer.expect("POST", "/dashboards", map[string]any{"name": "container", "spec": spec}, 201, "")
	id := created["id"].(string)
	check := func(want string) {
		t.Helper()
		loaded := f.developer.expect("GET", "/dashboards/"+id, nil, 200, "")
		if loaded["spec"].(map[string]any)["queryMode"] != "manual" {
			t.Fatalf("query mode was not preserved: %v", loaded["spec"])
		}
		if loaded["spec"].(map[string]any)["queryHeightMode"] != "manual" {
			t.Fatalf("query height mode not preserved: %v", loaded)
		}
		box, _ := json.Marshal(loaded["spec"].(map[string]any)["queryContainer"])
		style, _ := json.Marshal(loaded["spec"].(map[string]any)["filterStyle"])
		if string(style) != `{"density":"compact","layout":"vertical"}` {
			t.Fatalf("saved filter style = %s", style)
		}
		if string(box) != want {
			t.Fatalf("saved query container = %s, want %s", box, want)
		}
	}
	check(`{"h":33,"w":48,"x":48,"y":4}`)
	f.developer.expect("POST", "/dashboards/preview/items/wa/data", map[string]any{"spec": spec}, 200, "")
	spec["queryContainer"] = map[string]any{"x": 0, "y": 0, "w": 96, "h": 11}
	f.developer.editing("PUT", "/dashboards/"+id, map[string]any{"name": "container", "spec": spec}, 200, "")
	check(`{"h":11,"w":96,"x":0,"y":0}`)
	spec["queryContainer"] = map[string]any{"x": 80, "y": 0, "w": 48, "h": 11}
	f.developer.editing("PUT", "/dashboards/"+id, map[string]any{"name": "container", "spec": spec}, 400, "invalid_layout")
	check(`{"h":11,"w":96,"x":0,"y":0}`)
}

func TestDashboardGridSettingsRoundTrip(t *testing.T) {
	f := newContentFixture(t)
	chartID := f.developer.expect("POST", "/charts", f.chart("grid chart", `{"type":"table"}`), 201, "")["id"].(string)
	spec := dashboardSpec(chartID)
	layout := spec["layout"].(map[string]any)
	layout["columns"] = 48
	grid := map[string]any{"rowHeight": 12, "columnGap": 3, "rowGap": 4, "containerGap": 2, "autoCompact": false}
	layout["grid"] = grid
	created := f.developer.expect("POST", "/dashboards", map[string]any{"name": "grid settings", "spec": spec}, 201, "")
	id := created["id"].(string)
	f.share(t, id)
	check := func() {
		t.Helper()
		loaded := f.viewer.expect("GET", "/dashboards/"+id, nil, 200, "")
		saved := loaded["spec"].(map[string]any)["layout"].(map[string]any)
		want, _ := json.Marshal(grid)
		got, _ := json.Marshal(saved["grid"])
		if saved["columns"] != float64(layout["columns"].(int)) || string(got) != string(want) {
			t.Fatalf("grid settings lost: %v", saved)
		}
	}
	check()
	f.developer.expect("POST", "/dashboards/preview/items/wa/data", map[string]any{"spec": spec}, 200, "")
	layout["columns"] = 192
	grid["autoCompact"] = true
	grid["columnGap"] = 0
	f.developer.editing("PUT", "/dashboards/"+id, map[string]any{"name": "grid settings", "spec": spec}, 200, "")
	check()
	grid["rowHeight"] = 0
	f.developer.editing("PUT", "/dashboards/"+id, map[string]any{"name": "grid settings", "spec": spec}, 400, "invalid_layout")
	grid["rowHeight"] = 12
	check()
}
