package api

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/supazd/supabi/internal/store"
)

func TestQueryCache(t *testing.T) {
	f := newContentFixture(t)
	sourceID := f.sourceID(t)
	settings := f.admin.datasourceInput("db")

	// A data source says how long its results are kept, within bounds.
	for _, bad := range []map[string]any{{"cacheTtlSeconds": 30}, {"cacheTtlSeconds": 90000}} {
		f.admin.expect("PUT", "/datasources/"+sourceID, merge(settings, bad), 400, "invalid_cache_ttl")
	}
	for _, bad := range []map[string]any{{"maxConcurrentQueries": 0}, {"maxConcurrentQueries": 65}} {
		f.admin.expect("PUT", "/datasources/"+sourceID, merge(settings, bad), 400, "invalid_max_concurrent_queries")
	}
	updated := f.admin.expect("PUT", "/datasources/"+sourceID, merge(settings, map[string]any{"cacheTtlSeconds": 600, "maxConcurrentQueries": 2}), 200, "")
	if updated["cacheTtlSeconds"] != 600.0 || updated["maxConcurrentQueries"] != 2.0 {
		t.Fatalf("data source = %v", updated)
	}

	query := map[string]any{"version": 1, "dataset": f.datasetID, "dimensions": []any{map[string]any{"field": "region"}}, "measures": []any{map[string]any{"field": "revenue", "agg": "sum"}}, "totals": []any{[]any{}}}
	ask := func(c *client, mode string) (rows string, meta map[string]any) {
		t.Helper()
		body := map[string]any{"query": query}
		if mode != "" {
			body["options"] = map[string]any{"cache": mode}
		}
		result := c.expect("POST", "/query", body, 200, "")
		raw, _ := json.Marshal([]any{result["rows"], result["totals"].([]any)[0].(map[string]any)["rows"]})
		return string(raw), result["meta"].(map[string]any)
	}
	const before, after = `[[["华东","300.50"],["华南","300.25"]],[["600.75"]]]`, `[[["华东","300.50"],["华南","300.25"],["西南","1.00"]],[["601.75"]]]`

	rows, meta := ask(f.developer, "")
	if rows != before || meta["cached"] != false || meta["cachedAt"] == nil {
		t.Fatalf("first run: %s %v", rows, meta)
	}
	if _, err := f.admin.db.Pool.Exec(context.Background(), `INSERT INTO orders VALUES (4, '2026-03-01', 1.00, '西南')`); err != nil {
		t.Fatal(err)
	}
	rows, meta2 := ask(f.developer, "")
	if rows != before || meta2["cached"] != true || meta2["cachedAt"] != meta["cachedAt"] {
		t.Errorf("asked again: %s %v", rows, meta2)
	}
	if rows, meta = ask(f.developer, "refresh"); rows != after || meta["cached"] != false {
		t.Errorf("refreshed: %s %v", rows, meta)
	}
	if rows, meta = ask(f.developer, ""); rows != after || meta["cached"] != true {
		t.Errorf("after refreshing: %s %v", rows, meta)
	}
	if _, meta = ask(f.developer, "bypass"); meta["cached"] != false {
		t.Errorf("bypassed: %v", meta)
	}
	f.developer.expect("POST", "/query", map[string]any{"query": query, "options": map[string]any{"cache": "sometimes"}}, 400, "")

	// Labels come from the dataset as it is now, not as it was when the result was kept.
	f.developer.editing("PUT", "/datasets/"+f.datasetID, map[string]any{"name": "订单", "datasourceId": sourceID, "spec": f.admin.spec(func(spec map[string]any) {
		spec["fields"].([]any)[2].(map[string]any)["label"] = "大区"
	})}, 200, "")
	result := f.developer.expect("POST", "/query", map[string]any{"query": query}, 200, "")
	if label := result["columns"].([]any)[0].(map[string]any)["label"]; label != "大区" || result["meta"].(map[string]any)["cached"] != true {
		t.Errorf("renamed field: label %v, meta %v", label, result["meta"])
	}
}

// A kept result is shared only by people who would run the same statement:
// data permissions are part of it.
func TestQueryCacheKeepsDataPermissions(t *testing.T) {
	f := newContentFixture(t)
	sourceID := f.sourceID(t)
	f.admin.expect("PUT", "/datasources/"+sourceID, merge(f.admin.datasourceInput("db"), map[string]any{"cacheTtlSeconds": 600}), 200, "")

	chart := f.chart("按地区", `{"type":"table"}`)
	chart["spec"].(map[string]any)["query"].(map[string]any)["dimensions"] = []any{map[string]any{"field": "region"}}
	chartID := f.developer.expect("POST", "/charts", chart, 201, "")["id"].(string)
	board := f.developer.expect("POST", "/dashboards", map[string]any{"name": "销售", "spec": dashboardSpec(chartID)}, 201, "")["id"].(string)
	f.share(t, board)
	f.admin.expect("POST", "/users", map[string]any{"email": "wang@example.com", "displayName": "wang", "password": memberPassword}, 201, "")
	f.admin.expect("POST", "/members", map[string]any{"userId": userID(t, f.admin, "wang@example.com"), "role": "viewer"}, 201, "")
	wang := f.admin.signedIn("wang@example.com", memberPassword)
	east := f.admin.expect("POST", "/groups", map[string]any{"name": "华东组", "userIds": []string{userID(t, f.admin, "viewer@example.com")}}, 201, "")["id"].(string)
	policy := "/datasets/" + f.datasetID + "/policy"
	rule := map[string]any{"subjects": []any{map[string]any{"group": east}}, "filter": map[string]any{"field": "region", "op": "eq", "value": "华东"}}

	data := func(c *client, refresh bool) (string, bool) {
		t.Helper()
		var body any
		if refresh {
			body = map[string]any{"refresh": true}
		}
		result := c.expect("POST", "/dashboards/"+board+"/items/wa/data", body, 200, "")
		got, _ := json.Marshal(result["rows"])
		return string(got), result["meta"].(map[string]any)["cached"].(bool)
	}
	const all, eastOnly = `[["华东","300.50"],["华南","300.25"]]`, `[["华东","300.50"]]`

	f.developer.expect("PUT", policy, map[string]any{"unmatched": "all", "rows": []any{rule}, "columns": []any{}}, 200, "")
	if rows, _ := data(wang, false); rows != all {
		t.Fatalf("wang: %s", rows)
	}
	// Same statement as wang's, so it is shared.
	if rows, cached := data(f.developer, false); rows != all || !cached {
		t.Errorf("developer after wang: %s, cached %v", rows, cached)
	}
	// The viewer's rule makes another statement: wang's result is not theirs.
	if rows, cached := data(f.viewer, false); rows != eastOnly || cached {
		t.Errorf("viewer limited to 华东: %s, cached %v", rows, cached)
	}
	if rows, cached := data(f.viewer, false); rows != eastOnly || !cached {
		t.Errorf("viewer again: %s, cached %v", rows, cached)
	}
	// Lifting the rule takes effect at once, without anyone clearing the cache.
	f.developer.expect("PUT", policy, map[string]any{"unmatched": "all", "rows": []any{}, "columns": []any{}}, 200, "")
	if rows, cached := data(f.viewer, false); rows != all || !cached {
		t.Errorf("viewer without a rule: %s, cached %v", rows, cached)
	}
	// Viewers may ask for fresh data.
	if rows, cached := data(f.viewer, true); rows != all || cached {
		t.Errorf("viewer refreshing: %s, cached %v", rows, cached)
	}
	result := f.viewer.expect("POST", "/charts/"+chartID+"/data", map[string]any{"refresh": true}, 200, "")
	if result["meta"].(map[string]any)["cached"] != false {
		t.Errorf("chart refreshed: %v", result["meta"])
	}
}

func merge(a, b map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range a {
		out[k] = v
	}
	for k, v := range b {
		out[k] = v
	}
	return out
}

// sourceID is the fixture's one data source.
func (f *contentFixture) sourceID(t *testing.T) string {
	t.Helper()
	status, list := f.admin.do("GET", "/datasources", nil)
	if status != 200 {
		t.Fatalf("list data sources: %d", status)
	}
	return list.([]any)[0].(map[string]any)["id"].(string)
}

// Filter candidates are cached like any query, and refreshed on request.
func TestQueryCacheRefreshesFilterOptions(t *testing.T) {
	f := newContentFixture(t)
	f.admin.expect("PUT", "/datasources/"+f.sourceID(t), merge(f.admin.datasourceInput("db"), map[string]any{"cacheTtlSeconds": 600}), 200, "")
	chart := f.chart("按地区", `{"type":"table"}`)
	chart["spec"].(map[string]any)["query"].(map[string]any)["dimensions"] = []any{map[string]any{"field": "region"}}
	chart["spec"].(map[string]any)["filters"] = []any{map[string]any{"id": "region", "field": "region", "op": "in", "label": "地区", "control": map[string]any{"type": "select", "multi": true}}}
	chartID := f.developer.expect("POST", "/charts", chart, 201, "")["id"].(string)
	f.share(t, chartID)

	options := func(body map[string]any) string {
		t.Helper()
		got, _ := json.Marshal(f.viewer.expect("POST", "/charts/"+chartID+"/filters/region/options", body, 200, "")["values"])
		return string(got)
	}
	if got := options(map[string]any{}); got != `["华东","华南"]` {
		t.Fatalf("options: %s", got)
	}
	if _, err := f.admin.db.Pool.Exec(context.Background(), `INSERT INTO orders VALUES (4, '2026-03-01', 1.00, '西南')`); err != nil {
		t.Fatal(err)
	}
	if got := options(map[string]any{}); got != `["华东","华南"]` {
		t.Errorf("kept options: %s", got)
	}
	if got := options(map[string]any{"refresh": true}); got != `["华东","华南","西南"]` {
		t.Errorf("refreshed options: %s", got)
	}
}

// A dashboard's timed refresh accepts a kept result that started less than
// maxAge seconds ago, and asks the database again for an older one.
func TestQueryCacheMaxAge(t *testing.T) {
	f := newContentFixture(t)
	f.admin.expect("PUT", "/datasources/"+f.sourceID(t), merge(f.admin.datasourceInput("db"), map[string]any{"cacheTtlSeconds": 600}), 200, "")
	chartID := f.developer.expect("POST", "/charts", f.chart("按月", `{"type":"table"}`), 201, "")["id"].(string)
	spec := dashboardSpec(chartID)
	spec["filters"] = []any{map[string]any{"id": "g", "label": "地区", "op": "in", "control": map[string]any{"type": "select", "multi": true}, "targets": []any{map[string]any{"item": "wa", "field": "region"}}}}
	board := f.developer.expect("POST", "/dashboards", map[string]any{"name": "经营", "spec": spec}, 201, "")["id"].(string)
	f.share(t, board)
	data := func(body map[string]any) (rows int, cached bool) {
		t.Helper()
		result := f.viewer.expect("POST", "/dashboards/"+board+"/items/wa/data", body, 200, "")
		return len(result["rows"].([]any)), result["meta"].(map[string]any)["cached"].(bool)
	}
	if rows, cached := data(map[string]any{}); rows != 3 || cached {
		t.Fatalf("first: %d rows, cached %v", rows, cached)
	}
	if _, err := f.admin.db.Pool.Exec(context.Background(), `INSERT INTO orders VALUES (4, '2026-03-01', 1.00, '西南')`); err != nil {
		t.Fatal(err)
	}
	if rows, cached := data(map[string]any{"maxAge": 3600}); rows != 3 || !cached {
		t.Errorf("young enough: %d rows, cached %v", rows, cached)
	}
	time.Sleep(1100 * time.Millisecond)
	if rows, cached := data(map[string]any{"maxAge": 1}); rows != 4 || cached {
		t.Errorf("too old: %d rows, cached %v", rows, cached)
	}
	if rows, cached := data(map[string]any{}); rows != 4 || !cached {
		t.Errorf("the newer result was not kept: %d rows, cached %v", rows, cached)
	}
	for _, bad := range []map[string]any{{"maxAge": 0}, {"maxAge": 86401}, {"maxAge": 60, "refresh": true}} {
		f.viewer.expect("POST", "/dashboards/"+board+"/items/wa/data", bad, 400, "invalid_request")
		f.viewer.expect("POST", "/dashboards/"+board+"/filters/g/options", bad, 400, "invalid_request")
	}

	query := map[string]any{"version": 1, "dataset": f.datasetID, "dimensions": []any{map[string]any{"field": "region"}}, "measures": []any{map[string]any{"field": "revenue", "agg": "sum"}}}
	f.developer.expect("POST", "/query", map[string]any{"query": query}, 200, "")
	if meta := f.developer.expect("POST", "/query", map[string]any{"query": query, "options": map[string]any{"maxAge": 3600}}, 200, "")["meta"].(map[string]any); meta["cached"] != true {
		t.Errorf("query with maxAge: %v", meta)
	}
	f.developer.expect("POST", "/query", map[string]any{"query": query, "options": map[string]any{"cache": "refresh", "maxAge": 60}}, 400, "invalid_request")
}

func TestDatasourceVersionIgnoresTimeZone(t *testing.T) {
	at := time.Date(2026, 10, 17, 9, 0, 0, 123456789, time.UTC)
	shanghai, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	if datasourceVersion(store.Datasource{UpdatedAt: at}) != datasourceVersion(store.Datasource{UpdatedAt: at.In(shanghai)}) {
		t.Error("the same moment read in another time zone is another version")
	}
	if datasourceVersion(store.Datasource{UpdatedAt: at}) == datasourceVersion(store.Datasource{UpdatedAt: at.Add(time.Microsecond)}) {
		t.Error("a later change has the same version")
	}
}
