package api

import (
	"encoding/json"
	"fmt"
	"slices"
	"testing"
)

// paramChart sums revenue from a dataset reading orders since a day, of the
// east unless told otherwise. Viewers type the day in and pick the regions.
func (f *contentFixture) paramChart(t *testing.T) (datasetID string, input map[string]any) {
	t.Helper()
	ds := f.admin.expect("GET", "/datasets/"+f.datasetID, nil, 200, "")
	spec := f.admin.spec(func(spec map[string]any) {
		spec["source"] = map[string]any{"type": "sql", "sql": fmt.Sprintf("SELECT * FROM %s.orders WHERE order_date >= {{since}} [[ AND region IN {{regions}} ]]", f.admin.db.Schema)}
		spec["params"] = []any{
			map[string]any{"name": "since", "type": "date", "required": true, "default": "2026-01-01"},
			map[string]any{"name": "regions", "type": "string", "multi": true, "default": []any{"华东"}},
		}
	})
	datasetID = f.admin.expect("POST", "/datasets", map[string]any{"name": "按参数取的订单", "datasourceId": ds["datasourceId"], "spec": spec}, 201, "")["id"].(string)
	raw := `{"specVersion":1,"query":{"version":1,"dataset":"` + datasetID + `","measures":[{"field":"revenue","agg":"sum"}]},"viz":{"type":"kpi","y":["revenue"]},"filters":[
		{"id":"region","field":"region","op":"in","label":"地区","control":{"type":"select","multi":true}},
		{"id":"p_since","param":"since","label":"起始日","control":{"type":"input"}},
		{"id":"p_regions","param":"regions","label":"大区","control":{"type":"select"},"options":["华南"]}]}`
	var chart map[string]any
	if err := json.Unmarshal([]byte(raw), &chart); err != nil {
		t.Fatal(err)
	}
	return datasetID, map[string]any{"name": "参数", "spec": chart}
}

func TestChartParamFilters(t *testing.T) {
	f := newContentFixture(t)
	datasetID, input := f.paramChart(t)
	created := f.developer.expect("POST", "/charts", input, 201, "")
	id := created["id"].(string)

	// Viewers learn from the chart what they cannot read in the dataset.
	params, _ := json.Marshal(f.developer.expect("GET", "/charts/"+id, nil, 200, "")["params"])
	if want := `{"p_regions":{"default":["华东"],"multi":true,"options":["华东","华南"],"type":"string"},"p_since":{"default":"2026-01-01","needsValue":true,"type":"date"}}`; string(params) != want {
		t.Fatalf("params = %s\nwant %s", params, want)
	}

	data := func(values map[string]any, status int, code string) string {
		t.Helper()
		got := f.developer.expect("POST", "/charts/"+id+"/data", map[string]any{"filters": values}, status, code)
		if status != 200 {
			return ""
		}
		return rowsOf(t, got)
	}
	for _, tt := range []struct {
		name   string
		values map[string]any
		want   string
	}{
		{"defaults", nil, `[["300.50"]]`},
		{"picked", map[string]any{"p_regions": []any{"华南"}}, `[["300.25"]]`},
		{"none picked", map[string]any{"p_regions": []any{}}, `[["600.75"]]`},
		{"typed in", map[string]any{"p_since": "2026-02-01", "p_regions": []any{}}, `[["500.25"]]`},
	} {
		if got := data(tt.values, 200, ""); got != tt.want {
			t.Errorf("%s: %s, want %s", tt.name, got, tt.want)
		}
	}
	data(map[string]any{"p_regions": []any{"华北"}}, 400, "invalid_param_value")
	data(map[string]any{"p_since": nil}, 400, "missing_param")

	// A field filter's options come from the data as the parameters shape it.
	options := func(values map[string]any) []any {
		t.Helper()
		return f.developer.expect("POST", "/charts/"+id+"/filters/region/options", map[string]any{"filters": values}, 200, "")["values"].([]any)
	}
	if got := options(nil); !slices.Equal(got, []any{"华东"}) {
		t.Errorf("options by default: %v", got)
	}
	if got := options(map[string]any{"p_regions": []any{}}); len(got) != 2 {
		t.Errorf("options of every region: %v", got)
	}
	f.developer.expect("POST", "/charts/"+id+"/filters/p_regions/options", map[string]any{}, 404, "")

	// On a dashboard, viewers set them the same way.
	board := dashboardSpec(id)
	board["filters"] = []any{map[string]any{"id": "g_region", "label": "地区", "op": "in", "control": map[string]any{"type": "select", "multi": true}, "targets": []any{map[string]any{"item": "wa", "field": "region"}}, "default": []any{}}}
	boardID := f.developer.expect("POST", "/dashboards", map[string]any{"name": "参数", "spec": board}, 201, "")["id"].(string)
	f.share(t, boardID)
	shown := f.viewer.expect("GET", "/dashboards/"+boardID, nil, 200, "")
	if shown["charts"].([]any)[0].(map[string]any)["params"] == nil {
		t.Fatal("the dashboard's chart lacks its parameters")
	}
	item := f.viewer.expect("POST", "/dashboards/"+boardID+"/items/wa/data", map[string]any{"chartFilters": map[string]any{"p_regions": []any{"华南"}}}, 200, "")
	if got := rowsOf(t, item); got != `[["300.25"]]` {
		t.Errorf("dashboard: %s", got)
	}
	global := f.viewer.expect("POST", "/dashboards/"+boardID+"/filters/g_region/options", map[string]any{"chartFilters": map[string]any{"p_regions": []any{"华南"}}}, 200, "")
	if got := global["values"].([]any); !slices.Equal(got, []any{"华南"}) {
		t.Errorf("global options: %v", got)
	}
	f.viewer.expect("POST", "/dashboards/"+boardID+"/items/wa/data", map[string]any{"chartFilters": map[string]any{"p_regions": []any{"华北"}}}, 400, "invalid_param_value")

	// Removing the regions touches the chart giving them a value, and no other.
	f.developer.expect("POST", "/charts", map[string]any{"name": "不用参数", "spec": map[string]any{"specVersion": 1, "query": map[string]any{"version": 1, "dataset": datasetID, "measures": []any{map[string]any{"field": "revenue", "agg": "sum"}}}, "viz": map[string]any{"type": "kpi", "y": []any{"revenue"}}}}, 201, "")
	current := f.admin.expect("GET", "/datasets/"+datasetID, nil, 200, "")
	spec := current["spec"].(map[string]any)
	spec["source"].(map[string]any)["sql"] = fmt.Sprintf("SELECT * FROM %s.orders WHERE order_date >= {{since}}", f.admin.db.Schema)
	spec["params"] = spec["params"].([]any)[:1]
	impact := f.admin.editing("POST", "/datasets/"+datasetID+"/impact", map[string]any{"name": current["name"], "datasourceId": current["datasourceId"], "spec": spec}, 200, "")
	charts := impact["charts"].([]any)
	if len(charts) != 1 || charts[0].(map[string]any)["id"] != id {
		t.Fatalf("impact: %v", impact)
	}
}
