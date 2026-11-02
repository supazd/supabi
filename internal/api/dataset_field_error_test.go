package api

import (
	"context"
	"encoding/json"
	"slices"
	"testing"

	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/store"
)

// saveFieldHistory bypasses HTTP impact confirmation so these tests can also
// exercise old broken definitions and restrictions retained after a deletion.
func saveFieldHistory(t *testing.T, f *contentFixture, change func(*dataset.Spec)) {
	t.Helper()
	ctx := context.Background()
	scope := store.Scope{OrgID: store.DefaultOrgID, WorkspaceID: store.DefaultWorkspaceID}
	stored, err := store.GetDataset(ctx, f.admin.db.Pool, scope, f.datasetID)
	if err != nil {
		t.Fatal(err)
	}
	var spec dataset.Spec
	if err := json.Unmarshal(stored.Spec, &spec); err != nil {
		t.Fatal(err)
	}
	change(&spec)
	stored.Spec, err = json.Marshal(spec)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.UpdateDataset(ctx, f.admin.db.Pool, scope, stored); err != nil {
		t.Fatal(err)
	}
}

func expectMissingField(t *testing.T, c *client, method, path string, body any, key, label string) {
	t.Helper()
	request := c.expect
	if method == "PUT" {
		request = c.editing
	}
	result := request(method, path, body, 400, "unknown_field")
	params := result["params"].(map[string]any)
	if params["key"] != key {
		t.Fatalf("%s: missing key = %v, want %s", path, params, key)
	}
	if label == "" {
		if _, exists := params["label"]; exists {
			t.Fatalf("%s: unexpected historical label: %v", path, params)
		}
	} else if params["label"] != label {
		t.Fatalf("%s: missing field label = %v, want %s", path, params, label)
	}
}

func TestMissingDatasetFieldNamesUseLatestRevision(t *testing.T) {
	f := newContentFixture(t)
	chart := f.chart("Historical chart", `{"type":"table"}`)
	chartID := f.developer.expect("POST", "/charts", chart, 201, "")["id"].(string)
	boardID := f.developer.expect("POST", "/dashboards", map[string]any{"name": "Historical board", "spec": dashboardSpec(chartID)}, 201, "")["id"].(string)
	f.share(t, boardID)
	saveFieldHistory(t, f, func(spec *dataset.Spec) {
		for i := range spec.Fields {
			if spec.Fields[i].Key == "revenue" {
				spec.Fields[i].Label = "实际销售额"
			}
		}
	})
	saveFieldHistory(t, f, func(spec *dataset.Spec) {
		spec.Fields = slices.DeleteFunc(spec.Fields, func(field dataset.Field) bool { return field.Key == "revenue" })
	})
	for _, c := range []*client{f.viewer, f.developer} {
		for _, path := range []string{"/charts/" + chartID + "/data", "/dashboards/" + boardID + "/items/wa/data"} {
			expectMissingField(t, c, "POST", path, nil, "revenue", "实际销售额")
		}
	}
	expectMissingField(t, f.developer, "POST", "/query", map[string]any{"query": chart["spec"].(map[string]any)["query"]}, "revenue", "实际销售额")
	expectMissingField(t, f.developer, "PUT", "/charts/"+chartID, chart, "revenue", "实际销售额")
	expectMissingField(t, f.developer, "POST", "/query", map[string]any{"query": map[string]any{"version": 1, "dataset": f.datasetID, "dimensions": []any{map[string]any{"field": "never_existed"}}}}, "never_existed", "")
}

func TestMissingDatasetFieldNamesInFilterPaths(t *testing.T) {
	f := newContentFixture(t)
	chart := f.chart("Filtered history", `{"type":"table"}`)
	chartSpec := chart["spec"].(map[string]any)
	chartSpec["filters"] = []any{map[string]any{"id": "amount", "field": "amount", "op": "in", "label": "金额", "control": map[string]any{"type": "select"}}}
	chartID := f.developer.expect("POST", "/charts", chart, 201, "")["id"].(string)
	board := dashboardSpec(chartID)
	board["filters"] = []any{map[string]any{"id": "amount", "label": "金额", "op": "in", "control": map[string]any{"type": "select"}, "targets": []any{map[string]any{"item": "wa", "field": "amount"}}}}
	boardID := f.developer.expect("POST", "/dashboards", map[string]any{"name": "Filtered history", "spec": board}, 201, "")["id"].(string)
	f.share(t, boardID)
	saveFieldHistory(t, f, func(spec *dataset.Spec) {
		spec.Fields = slices.DeleteFunc(spec.Fields, func(field dataset.Field) bool { return field.Key == "amount" })
	})
	for _, path := range []string{
		"/charts/" + chartID + "/data",
		"/charts/" + chartID + "/filters/amount/options",
		"/dashboards/" + boardID + "/items/wa/data",
		"/dashboards/" + boardID + "/filters/amount/options",
		"/dashboards/" + boardID + "/items/wa/filters/amount/options",
	} {
		expectMissingField(t, f.viewer, "POST", path, map[string]any{}, "amount", "金额")
	}
	for _, path := range []string{"/charts/" + chartID + "/filters/amount/options", "/dashboards/" + boardID + "/filters/amount/options"} {
		expectMissingField(t, f.viewer, "GET", path, nil, "amount", "金额")
	}
	expectMissingField(t, f.developer, "POST", "/charts/preview/filters/amount/options", map[string]any{"spec": chartSpec}, "amount", "金额")
	for _, path := range []string{
		"/dashboards/preview/items/wa/data",
		"/dashboards/preview/filters/amount/options",
		"/dashboards/preview/items/wa/filters/amount/options",
	} {
		expectMissingField(t, f.developer, "POST", path, map[string]any{"spec": board}, "amount", "金额")
	}
	expectMissingField(t, f.developer, "PUT", "/dashboards/"+boardID, map[string]any{"name": "Filtered history", "spec": board}, "amount", "金额")
}

func TestMissingDatasetFieldNamesRespectColumnPermissions(t *testing.T) {
	for _, dependency := range []bool{false, true} {
		name := "direct"
		if dependency {
			name = "calculated dependency"
		}
		t.Run(name, func(t *testing.T) {
			f := newContentFixture(t)
			key := "revenue"
			if dependency {
				key = "derived_revenue"
				saveFieldHistory(t, f, func(spec *dataset.Spec) {
					spec.Fields = append(spec.Fields, dataset.Field{Key: key, Label: "机密销售额", Expr: "${revenue} * 2", Type: datasource.Decimal, Role: dataset.MeasureRole})
				})
			}
			chart := f.chart("Restricted history", `{"type":"table"}`)
			chart["spec"].(map[string]any)["query"].(map[string]any)["measures"] = []any{map[string]any{"field": key, "agg": "sum"}}
			chartID := f.developer.expect("POST", "/charts", chart, 201, "")["id"].(string)
			f.share(t, chartID)
			f.admin.expect("PUT", "/datasets/"+f.datasetID+"/policy", map[string]any{"unmatched": "all", "rows": []any{}, "columns": []any{map[string]any{"fields": []string{"revenue"}, "visibleTo": []any{}}}}, 200, "")
			saveFieldHistory(t, f, func(spec *dataset.Spec) {
				spec.Fields = slices.DeleteFunc(spec.Fields, func(field dataset.Field) bool { return field.Key == key })
			})
			expectMissingField(t, f.viewer, "POST", "/charts/"+chartID+"/data", nil, key, "")
			label := "销售额"
			if dependency {
				label = "机密销售额"
			}
			expectMissingField(t, f.developer, "POST", "/charts/"+chartID+"/data", nil, key, label)
		})
	}
}
