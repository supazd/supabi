package api

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"io"
	"strings"
	"testing"

	"github.com/supazd/supabi/internal/worker"
)

// downloadCSV fetches an export's file as c and reads it.
func downloadCSV(t *testing.T, c *client, id string) [][]string {
	t.Helper()
	response, err := c.http.Get(c.server.URL + "/api/v1/exports/" + id + "/file")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 200 {
		t.Fatalf("download: %d %s", response.StatusCode, raw)
	}
	rows, err := csv.NewReader(strings.NewReader(strings.TrimPrefix(string(raw), "\ufeff"))).ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	return rows
}

func jobOf(t *testing.T, w *worker.Worker, id string) (status, code string) {
	t.Helper()
	if err := w.Pool.QueryRow(context.Background(), `SELECT status,error_code FROM background_jobs WHERE id=$1`, id).Scan(&status, &code); err != nil {
		t.Fatal(err)
	}
	return status, code
}

func TestChartExports(t *testing.T) {
	f := newContentFixture(t)
	w := testExportWorker(f.admin)
	// Revenue by month and region; the table hides the region it groups by.
	input := func(allow bool, limit int) map[string]any {
		chart := f.chart("月度销售额", `{"type":"table","hiddenColumns":["region"]}`)
		spec := chart["spec"].(map[string]any)
		if allow {
			spec["allowExport"] = true
		}
		if limit > 0 {
			spec["query"].(map[string]any)["limit"] = limit
		}
		return chart
	}
	chartID := f.developer.expect("POST", "/charts", input(false, 0), 201, "")["id"].(string)
	board := f.developer.expect("POST", "/dashboards", map[string]any{"name": "经营仪表盘", "spec": dashboardSpec(chartID)}, 201, "")["id"].(string)
	exportPath := "/dashboards/" + board + "/items/wa/exports"
	request := map[string]any{"format": "csv", "name": "月度销售额", "headers": map[string]any{"month": "月份"}}

	// Not shared yet: viewers cannot learn the dashboard exists.
	f.viewer.expect("POST", exportPath, request, 404, "not_found")
	f.share(t, board)
	// The switch is off by default, for every role.
	for _, c := range []*client{f.viewer, f.developer, f.admin} {
		c.expect("POST", exportPath, request, 403, "export_chart_disabled")
	}
	f.developer.editing("PUT", "/charts/"+chartID, input(true, 0), 200, "")
	if f.viewer.expect("GET", "/charts/"+chartID, nil, 200, "")["spec"].(map[string]any)["allowExport"] != true {
		t.Fatal("the switch is not saved")
	}
	f.viewer.expect("POST", "/dashboards/"+board+"/items/nope/exports", request, 404, "not_found")
	f.viewer.expect("POST", exportPath, map[string]any{"format": "csv", "name": "a/b"}, 400, "export_name_invalid")

	// Without a row limit of its own the whole result goes in, past what a
	// widget shows, under the page's headings; hidden columns stay out.
	created := f.viewer.expect("POST", exportPath, request, 202, "")
	id := created["id"].(string)
	if created["source"] != "chart" || created["dashboardName"] != "经营仪表盘" || created["chartName"] != "月度销售额" {
		t.Fatalf("created: %v", created)
	}
	processExport(t, w)
	rows := downloadCSV(t, f.viewer, id)
	want := `[["月份","销售额"],["2026-01-01","100.50"],["2026-02-01","200.00"],["2026-02-01","300.25"]]`
	if got, _ := json.Marshal(rows); string(got) != want {
		t.Fatalf("rows: %s", got)
	}

	// Data permissions apply as the person exporting.
	east := f.admin.expect("POST", "/groups", map[string]any{"name": "华东组", "userIds": []string{userID(t, f.admin, "viewer@example.com")}}, 201, "")["id"].(string)
	rule := map[string]any{"subjects": []any{map[string]any{"group": east}}, "filter": map[string]any{"field": "region", "op": "eq", "value": "华东"}}
	f.developer.expect("PUT", "/datasets/"+f.datasetID+"/policy", map[string]any{"unmatched": "none", "rows": []any{rule}, "columns": []any{}}, 200, "")
	id = f.viewer.expect("POST", exportPath, request, 202, "")["id"].(string)
	processExport(t, w)
	if got := downloadCSV(t, f.viewer, id); len(got) != 3 || got[1][1] != "100.50" || got[2][1] != "200.00" {
		t.Fatalf("viewer's rows: %v", got)
	}
	f.developer.expect("PUT", "/datasets/"+f.datasetID+"/policy", map[string]any{"unmatched": "all", "rows": []any{}, "columns": []any{}}, 200, "")

	// The chart's own row limit is part of what it asks.
	f.developer.editing("PUT", "/charts/"+chartID, input(true, 2), 200, "")
	id = f.viewer.expect("POST", exportPath, map[string]any{"format": "csv", "name": "前两行"}, 202, "")["id"].(string)
	processExport(t, w)
	if got := downloadCSV(t, f.viewer, id); len(got) != 3 || got[0][0] != "下单日期" {
		t.Fatalf("limited rows: %v", got)
	}

	// Turning the switch off stops files already made from being downloaded,
	// and exports still queued from running.
	queued := f.viewer.expect("POST", exportPath, request, 202, "")["id"].(string)
	f.developer.editing("PUT", "/charts/"+chartID, input(false, 2), 200, "")
	f.viewer.expect("GET", "/exports/"+id+"/file", nil, 403, "export_chart_disabled")
	if got := f.viewer.expect("GET", "/exports/"+id, nil, 200, ""); got["denied"] != "export_chart_disabled" || got["status"] != "succeeded" {
		t.Fatalf("disabled: %v", got)
	}
	processExport(t, w)
	if status, code := jobOf(t, w, queued); status != "failed" || code != "export_chart_disabled" {
		t.Fatalf("disabled chart exported: %s %s", status, code)
	}

	// A chart that now reads another dataset no longer leads to the one an
	// export queued before still names.
	f.developer.editing("PUT", "/charts/"+chartID, input(true, 0), 200, "")
	queued = f.viewer.expect("POST", exportPath, request, 202, "")["id"].(string)
	other := f.admin.expect("POST", "/datasets", map[string]any{"name": "订单副本", "datasourceId": f.sourceID(t), "spec": f.admin.spec(nil)}, 201, "")["id"].(string)
	moved := input(true, 0)
	moved["spec"].(map[string]any)["query"].(map[string]any)["dataset"] = other
	f.developer.editing("PUT", "/charts/"+chartID, moved, 200, "")
	processExport(t, w)
	if status, code := jobOf(t, w, queued); status != "failed" || code != "export_forbidden" {
		t.Fatalf("export read the chart's former dataset: %s %s", status, code)
	}

	// Losing the dashboard does the same.
	f.developer.editing("PUT", "/charts/"+chartID, input(true, 0), 200, "")
	queued = f.viewer.expect("POST", exportPath, request, 202, "")["id"].(string)
	f.admin.expect("PUT", "/dashboards/"+board+"/grants", map[string]any{"subjects": []any{}}, 200, "")
	processExport(t, w)
	if status, code := jobOf(t, w, queued); status != "failed" || code != "export_forbidden" {
		t.Fatalf("hidden dashboard exported: %s %s", status, code)
	}
	f.viewer.expect("GET", "/exports/"+id+"/file", nil, 403, "export_dashboard_unavailable")
	// Their list still says what happened, which results are new, and where
	// each came from.
	page := f.viewer.expect("GET", "/exports", nil, 200, "")
	items := page["items"].([]any)
	if page["unseen"] != float64(len(items)) || len(items) != 6 {
		t.Fatalf("viewer's exports: %v", page)
	}
	for _, raw := range items {
		item := raw.(map[string]any)
		if item["source"] != "chart" || item["dashboardName"] != "经营仪表盘" || item["unseen"] != true {
			t.Fatalf("export: %v", item)
		}
		if item["status"] == "succeeded" && item["denied"] != "export_dashboard_unavailable" {
			t.Fatalf("denial: %v", item)
		}
	}

	// A field the person may not see makes the chart theirs to see no more,
	// so it cannot be exported either.
	f.share(t, board)
	f.developer.expect("PUT", "/datasets/"+f.datasetID+"/policy", map[string]any{"unmatched": "all", "rows": []any{}, "columns": []any{map[string]any{"fields": []string{"revenue"}, "visibleTo": []any{}}}}, 200, "")
	f.viewer.expect("POST", exportPath, request, 400, "hidden_field")
}
