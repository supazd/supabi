package api

import (
	"context"
	"encoding/json"
	"testing"
)

func linkSpec(id, source, column, target, field string) map[string]any {
	return map[string]any{"id": id, "label": id, "source": map[string]any{"item": source, "column": column}, "targets": []any{map[string]any{"item": target, "field": field}}}
}

func TestDashboardLinksAcrossDatasetsAndFilters(t *testing.T) {
	f := newContentFixture(t)
	sourceInput := f.chart("source", `{"type":"bar","x":"region","y":["revenue"]}`)
	sourceInput["spec"].(map[string]any)["query"].(map[string]any)["dimensions"] = []any{map[string]any{"field": "region"}}
	source := f.developer.expect("POST", "/charts", sourceInput, 201, "")["id"].(string)
	ds := f.admin.expect("GET", "/datasets/"+f.datasetID, nil, 200, "")
	targetDS := f.admin.spec(func(s map[string]any) {
		for _, entry := range s["fields"].([]any) {
			field := entry.(map[string]any)
			if field["key"] == "region" {
				field["key"] = "area"
			}
		}
	})
	dsID := f.admin.expect("POST", "/datasets", map[string]any{"name": "other", "datasourceId": ds["datasourceId"], "spec": targetDS}, 201, "")["id"].(string)
	targetInput := f.chart("target", `{"type":"table"}`)
	targetSpec := targetInput["spec"].(map[string]any)
	q := targetSpec["query"].(map[string]any)
	q["dataset"] = dsID
	q["dimensions"] = []any{map[string]any{"field": "area"}}
	targetSpec["filters"] = []any{map[string]any{"id": "local", "label": "Area", "field": "area", "op": "in", "control": map[string]any{"type": "select"}, "value": []any{"华东"}}}
	target := f.developer.expect("POST", "/charts", targetInput, 201, "")["id"].(string)
	spec := dashboardSpec(source, target)
	link := linkSpec("region", "wa", "region", "wb", "area")
	spec["links"] = []any{link}
	spec["filters"] = []any{map[string]any{"id": "global", "label": "Area", "op": "in", "control": map[string]any{"type": "select"}, "targets": []any{map[string]any{"item": "wb", "field": "area"}}, "default": []any{"华南"}}}
	saved := f.developer.expect("POST", "/dashboards", map[string]any{"name": "links", "spec": spec}, 201, "")
	id := saved["id"].(string)
	f.share(t, id)
	body := map[string]any{"links": map[string]any{"region": "华东"}}
	assertRows := func(client *client, path string, want string) {
		t.Helper()
		result := client.expect("POST", path, body, 200, "")
		raw, _ := json.Marshal(result["rows"])
		if string(raw) != want {
			t.Fatalf("%s: %s want %s", path, raw, want)
		}
	}
	path := "/dashboards/" + id + "/items/wb/data"
	assertRows(f.viewer, path, `[]`) // AND with the global's south, never takeover.
	body["useChartFilters"] = true
	assertRows(f.viewer, path, `[["华东","300.50"]]`)
	body["chartFilters"] = map[string]any{"local": []any{"华南"}}
	assertRows(f.viewer, path, `[]`)
	body["chartFilters"] = map[string]any{"local": nil}
	assertRows(f.viewer, path, `[["华东","300.50"]]`)
	options := f.viewer.expect("POST", "/dashboards/"+id+"/items/wb/filters/local/options", body, 200, "")
	if raw, _ := json.Marshal(options["values"]); string(raw) != `["华东"]` {
		t.Fatal(string(raw))
	}
	// Source is not narrowed by its own click.
	delete(body, "chartFilters")
	assertRows(f.viewer, "/dashboards/"+id+"/items/wa/data", `[["华东","300.50"],["华南","300.25"]]`)
	body["chartFilters"] = map[string]any{"local": nil}
	body["links"] = map[string]any{"region": nil}
	assertRows(f.viewer, path, `[]`)
	if _, err := f.admin.db.Pool.Exec(context.Background(), "INSERT INTO orders VALUES (4, '2026-02-21', 10, NULL)"); err != nil {
		t.Fatal(err)
	}
	assertRows(f.viewer, path, `[[null,"10.00"]]`)
	body["links"] = map[string]any{"region": "华东"}
	body["spec"] = spec
	assertRows(f.developer, "/dashboards/preview/items/wb/data", `[["华东","300.50"]]`)
	current := f.developer.expect("GET", "/dashboards/"+id, nil, 200, "")
	a, _ := json.Marshal(current)
	b, _ := json.Marshal(saved)
	if string(a) != string(b) {
		t.Fatal("preview saved transient clicks")
	}
	body["links"] = map[string]any{"guessed": "华东"}
	f.viewer.expect("POST", path, body, 400, "unknown_link")
	body["links"] = map[string]any{"region": map[string]any{"field": "amount", "op": "gt", "value": 0}}
	f.viewer.expect("POST", path, body, 400, "invalid_link_value")
	// Changing a source to a chart without clickable categories is rejected.
	sourceInput["spec"].(map[string]any)["viz"] = map[string]any{"type": "line", "x": "region", "y": []any{"revenue"}}
	f.developer.editing("PUT", "/charts/"+source, sourceInput, 409, "filter_in_use")
	// Definitions cannot bind measures, the source widget itself, or incompatible types.
	for _, targetField := range []string{"order_date", "amount"} {
		link["targets"] = []any{map[string]any{"item": "wb", "field": targetField}}
		f.developer.expect("POST", "/dashboards", map[string]any{"name": "bad", "spec": spec}, 400, "invalid_link_target")
	}
	// Even distinct fields cannot be mapped twice on the same target widget.
	link["targets"] = []any{map[string]any{"item": "wb", "field": "area"}, map[string]any{"item": "wb", "field": "amount"}}
	f.developer.expect("POST", "/dashboards", map[string]any{"name": "bad", "spec": spec}, 400, "invalid_link")
	link["targets"] = []any{map[string]any{"item": "wa", "field": "region"}}
	f.developer.expect("POST", "/dashboards", map[string]any{"name": "bad", "spec": spec}, 400, "invalid_link")
}

func TestDashboardDateLinksPreserveComparison(t *testing.T) {
	f := newContentFixture(t)
	sourceInput := f.chart("dates", `{"type":"bar","x":"month","y":["revenue"]}`)
	sourceInput["spec"].(map[string]any)["query"].(map[string]any)["dimensions"] = []any{map[string]any{"field": "order_date", "grain": "month", "alias": "month"}}
	source := f.developer.expect("POST", "/charts", sourceInput, 201, "")["id"].(string)
	input := f.chart("comparison", `{"type":"table"}`)
	spec := input["spec"].(map[string]any)
	q := spec["query"].(map[string]any)
	q["dimensions"] = []any{}
	q["measures"] = []any{map[string]any{"field": "revenue", "agg": "sum", "alias": "current"}, map[string]any{"field": "revenue", "agg": "sum", "alias": "previous", "compute": map[string]any{"type": "compare", "timeField": "order_date", "offset": map[string]any{"n": 1, "unit": "month"}, "output": "value"}}}
	spec["filters"] = []any{map[string]any{"id": "range", "field": "order_date", "op": "time", "value": map[string]any{"start": "2026-01-01", "end": "2026-04-01"}}}
	target := f.developer.expect("POST", "/charts", input, 201, "")["id"].(string)
	board := dashboardSpec(source, target)
	board["links"] = []any{linkSpec("month", "wa", "month", "wb", "order_date")}
	id := f.developer.expect("POST", "/dashboards", map[string]any{"name": "comparison", "spec": board}, 201, "")["id"].(string)
	f.share(t, id)
	result := f.viewer.expect("POST", "/dashboards/"+id+"/items/wb/data", map[string]any{"links": map[string]any{"month": "2026-02-01"}}, 200, "")
	raw, _ := json.Marshal(result["rows"])
	if string(raw) != `[["500.25","100.50"]]` {
		t.Fatal(string(raw))
	}
	result = f.viewer.expect("POST", "/dashboards/"+id+"/items/wb/data", map[string]any{"links": map[string]any{"month": nil}}, 200, "")
	raw, _ = json.Marshal(result["rows"])
	if string(raw) != `[[null,null]]` {
		t.Fatal(string(raw))
	}
}
