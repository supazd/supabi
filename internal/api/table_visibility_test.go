package api

import (
	"fmt"
	"reflect"
	"testing"
)

func TestTableColumnVisibilityWorkflow(t *testing.T) {
	for _, detail := range []bool{true, false} {
		t.Run(fmt.Sprintf("detail=%t", detail), func(t *testing.T) {
			f := newContentFixture(t)
			query := map[string]any{"version": float64(1), "dataset": f.datasetID}
			hidden := []any{"amount"}
			if detail {
				query["mode"] = "detail"
				query["columns"] = []any{"region", "amount", "order_date"}
				query["sort"] = []any{map[string]any{"by": "amount", "desc": true}}
			} else {
				query["dimensions"] = []any{map[string]any{"field": "region"}, map[string]any{"field": "order_date", "grain": "month", "alias": "month"}}
				query["measures"] = []any{
					map[string]any{"field": "revenue", "agg": "sum", "alias": "total"},
					map[string]any{"field": "revenue", "agg": "sum", "alias": "share", "compute": map[string]any{"type": "percent_of_total", "within": []any{"region"}}},
				}
				query["totals"] = []any{[]any{}}
				query["sort"] = []any{map[string]any{"by": "total", "desc": true}}
				hidden = []any{"month", "total"}
			}
			baseline := f.developer.expect("POST", "/query", map[string]any{"query": query}, 200, "")
			input := map[string]any{"name": "隐藏列验收", "spec": map[string]any{"specVersion": 1, "query": query, "viz": map[string]any{"type": "table", "hiddenColumns": hidden}}}
			created := f.developer.expect("POST", "/charts", input, 201, "")
			id := created["id"].(string)
			loaded := f.developer.expect("GET", "/charts/"+id, nil, 200, "")
			spec := loaded["spec"].(map[string]any)
			if !reflect.DeepEqual(spec["query"], query) || !reflect.DeepEqual(spec["viz"].(map[string]any)["hiddenColumns"], hidden) {
				t.Fatalf("save/reopen changed query or visibility: %v", spec)
			}
			boardID := f.developer.expect("POST", "/dashboards", map[string]any{"name": "隐藏列仪表盘", "spec": dashboardSpec(id)}, 201, "")["id"].(string)
			f.share(t, boardID)
			viewerChart := f.viewer.expect("GET", "/charts/"+id, nil, 200, "")
			if !reflect.DeepEqual(viewerChart["spec"], spec) {
				t.Fatal("viewer did not receive the saved visibility settings")
			}
			path := "/dashboards/" + boardID + "/items/wa/data"
			checkData := func() {
				t.Helper()
				data := f.viewer.expect("POST", path, nil, 200, "")
				// Visibility is presentation only: all queried columns remain in
				// the response, including sort keys, grouping and computed values.
				for _, part := range []string{"columns", "rows", "totals"} {
					if !reflect.DeepEqual(data[part], baseline[part]) {
						t.Fatalf("hidden columns changed %s: %v, baseline %v", part, data[part], baseline[part])
					}
				}
				rows := data["rows"].([]any)
				if len(rows) != 3 || rows[0].([]any)[0] != "华南" || rows[1].([]any)[0] != "华东" || rows[2].([]any)[0] != "华东" {
					t.Fatalf("hidden sorting or grouping changed: %v", rows)
				}
			}
			checkData()
			// Showing the columns again persists without altering the query or
			// the dashboard's calculations and ordering.
			delete(spec["viz"].(map[string]any), "hiddenColumns")
			f.developer.editing("PUT", "/charts/"+id, map[string]any{"name": loaded["name"], "spec": spec}, 200, "")
			reopened := f.developer.expect("GET", "/charts/"+id, nil, 200, "")
			if !reflect.DeepEqual(reopened["spec"], spec) {
				t.Fatalf("showing columns did not persist: %v", reopened)
			}
			checkData()
		})
	}
}
