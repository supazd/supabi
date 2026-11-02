package api

import (
	"encoding/json"
	"testing"
)

// drilledChart is revenue by region, drilled to months and then days.
func (f *contentFixture) drilledChart() map[string]any {
	input := f.chart("下钻", `{"type":"bar","x":"region","y":["revenue"]}`)
	spec := input["spec"].(map[string]any)
	spec["query"].(map[string]any)["dimensions"] = []any{map[string]any{"field": "region"}}
	spec["drill"] = map[string]any{"alias": "region", "levels": []any{
		map[string]any{"field": "order_date", "grain": "month", "label": "月"},
		map[string]any{"field": "order_date", "grain": "day", "label": "日"},
	}}
	return input
}

func rowsOf(t *testing.T, result map[string]any) string {
	t.Helper()
	raw, _ := json.Marshal(result["rows"])
	return string(raw)
}

func TestChartDrill(t *testing.T) {
	f := newContentFixture(t)
	input := f.drilledChart()
	id := f.developer.expect("POST", "/charts", input, 201, "")["id"].(string)
	if got := f.developer.expect("GET", "/charts/"+id, nil, 200, "")["spec"].(map[string]any)["drill"]; got == nil {
		t.Fatal("the drill is not saved")
	}
	path := "/charts/" + id + "/data"
	data := func(drill ...any) map[string]any {
		return f.developer.expect("POST", path, map[string]any{"drill": drill}, 200, "")
	}

	if got := rowsOf(t, data()); got != `[["华东","300.50"],["华南","300.25"]]` {
		t.Fatalf("first level: %s", got)
	}
	// The months of the east keep the column's name, under the level's label.
	months := data("华东")
	if got := rowsOf(t, months); got != `[["2026-01-01","100.50"],["2026-02-01","200.00"]]` {
		t.Fatalf("months: %s", got)
	}
	if column := months["columns"].([]any)[0].(map[string]any); column["name"] != "region" || column["label"] != "月" {
		t.Fatalf("column: %v", column)
	}
	if got := rowsOf(t, data("华东", "2026-02-01")); got != `[["2026-02-10","200.00"]]` {
		t.Fatalf("days: %s", got)
	}
	if got := rowsOf(t, data(nil)); got != `[]` {
		t.Fatalf("a missing region: %s", got)
	}
	// Only values the saved levels can take, no deeper than they go.
	for _, drill := range [][]any{{"华东", "2026-02-01", "2026-02-10"}, {"华东", "February"}, {map[string]any{"field": "amount", "op": "gt", "value": 0}}} {
		f.developer.expect("POST", path, map[string]any{"drill": drill}, 400, "invalid_drill")
	}
	plain := f.developer.expect("POST", "/charts", f.chart("不下钻", `{"type":"bar","x":"month","y":["revenue"],"series":"region"}`), 201, "")["id"].(string)
	f.developer.expect("POST", "/charts/"+plain+"/data", map[string]any{"drill": []any{"华东"}}, 400, "invalid_drill")

	// The chart editor asks for an unsaved chart the same way, as an author.
	preview := map[string]any{"spec": input["spec"], "drill": []any{"华东"}, "diagnostics": true}
	previewed := f.developer.expect("POST", "/charts/preview/data", preview, 200, "")
	if got := rowsOf(t, previewed); got != `[["2026-01-01","100.50"],["2026-02-01","200.00"]]` {
		t.Fatalf("preview: %s", got)
	}
	if previewed["diagnostics"] == nil {
		t.Fatal("the preview's diagnostics are missing")
	}
	f.viewer.expect("POST", "/charts/preview/data", preview, 403, "forbidden")
	preview["drill"] = []any{"华东", "2026-02-01", "2026-02-10"}
	f.developer.expect("POST", "/charts/preview/data", preview, 400, "invalid_drill")

	// Saving checks the levels, and so does a preview.
	bad := f.drilledChart()
	bad["spec"].(map[string]any)["drill"].(map[string]any)["levels"] = []any{map[string]any{"field": "revenue"}}
	f.developer.expect("POST", "/charts", bad, 400, "invalid_drill")
	f.developer.expect("POST", "/charts/preview/data", map[string]any{"spec": bad["spec"]}, 400, "invalid_drill")
	bad["spec"].(map[string]any)["drill"].(map[string]any)["levels"] = []any{map[string]any{"field": "order_date", "grain": "hour"}}
	f.developer.expect("POST", "/charts", bad, 400, "invalid_grain")
}

func TestDashboardDrill(t *testing.T) {
	f := newContentFixture(t)
	w := testExportWorker(f.admin)
	input := f.drilledChart()
	input["spec"].(map[string]any)["allowExport"] = true
	chart := f.developer.expect("POST", "/charts", input, 201, "")["id"].(string)
	spec := dashboardSpec(chart)
	board := f.developer.expect("POST", "/dashboards", map[string]any{"name": "下钻", "spec": spec}, 201, "")["id"].(string)
	f.share(t, board)

	body := map[string]any{"drill": []any{"华南"}}
	if got := rowsOf(t, f.viewer.expect("POST", "/dashboards/"+board+"/items/wa/data", body, 200, "")); got != `[["2026-02-01","300.25"]]` {
		t.Fatalf("viewer: %s", got)
	}
	// Drilling keeps within whatever else restricts the chart.
	body["filters"] = map[string]any{}
	body["chartFilters"] = map[string]any{}
	body["drill"] = []any{"华东", "2026-01-01"}
	if got := rowsOf(t, f.viewer.expect("POST", "/dashboards/"+board+"/items/wa/data", body, 200, "")); got != `[["2026-01-10","100.50"]]` {
		t.Fatalf("days: %s", got)
	}
	body["spec"] = spec
	if got := rowsOf(t, f.developer.expect("POST", "/dashboards/preview/items/wa/data", body, 200, "")); got != `[["2026-01-10","100.50"]]` {
		t.Fatalf("preview: %s", got)
	}

	// An export is of the level shown.
	id := f.viewer.expect("POST", "/dashboards/"+board+"/items/wa/exports", map[string]any{"format": "csv", "name": "华东", "drill": []any{"华东"}}, 202, "")["id"].(string)
	processExport(t, w)
	if got, _ := json.Marshal(downloadCSV(t, f.viewer, id)); string(got) != `[["月","销售额"],["2026-01-01","100.50"],["2026-02-01","200.00"]]` {
		t.Fatalf("export: %s", got)
	}
}

// A date clicked on the way down moves with a comparison, as a date link does.
func TestDrillPreservesComparison(t *testing.T) {
	f := newContentFixture(t)
	input := f.chart("同比", `{"type":"bar","x":"month","y":["current","previous"]}`)
	spec := input["spec"].(map[string]any)
	q := spec["query"].(map[string]any)
	q["dimensions"] = []any{map[string]any{"field": "order_date", "grain": "month", "alias": "month"}}
	q["measures"] = []any{map[string]any{"field": "revenue", "agg": "sum", "alias": "current"}, map[string]any{"field": "revenue", "agg": "sum", "alias": "previous", "compute": map[string]any{"type": "compare", "timeField": "order_date", "offset": map[string]any{"n": 1, "unit": "month"}, "output": "value"}}}
	spec["filters"] = []any{map[string]any{"id": "range", "field": "order_date", "op": "time", "value": map[string]any{"start": "2026-01-01", "end": "2026-04-01"}}}
	spec["drill"] = map[string]any{"alias": "month", "levels": []any{map[string]any{"field": "region"}}}
	id := f.developer.expect("POST", "/charts", input, 201, "")["id"].(string)
	result := f.developer.expect("POST", "/charts/"+id+"/data", map[string]any{"drill": []any{"2026-02-01"}}, 200, "")
	if got := rowsOf(t, result); got != `[["华东","200.00","100.50"],["华南","300.25",null]]` {
		t.Fatal(got)
	}
}
