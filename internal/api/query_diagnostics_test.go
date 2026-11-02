package api

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"
)

func diagnosticStatements(t *testing.T, result map[string]any) []map[string]any {
	t.Helper()
	d, ok := result["diagnostics"].(map[string]any)
	if !ok {
		t.Fatalf("missing diagnostics: %v", result)
	}
	if !strings.HasPrefix(d["requestId"].(string), "qry_") || d["requestedAt"] != "2026-03-10T09:00:00Z" {
		t.Errorf("request identity: %v", d)
	}
	var statements []map[string]any
	for _, raw := range d["statements"].([]any) {
		statements = append(statements, raw.(map[string]any))
	}
	return statements
}

func TestQueryDiagnostics(t *testing.T) {
	f := newContentFixture(t)
	f.admin.expect("PUT", "/datasources/"+f.sourceID(t), merge(f.admin.datasourceInput("db"), map[string]any{"cacheTtlSeconds": 600}), 200, "")
	q := map[string]any{
		"version": 1, "dataset": f.datasetID,
		"dimensions": []any{map[string]any{"field": "order_date", "grain": "month", "alias": "month"}, map[string]any{"field": "region"}},
		"measures":   []any{map[string]any{"field": "revenue", "agg": "sum"}},
		"filter":     map[string]any{"field": "region", "op": "in", "value": []any{"华东", "华南"}},
		"params":     map[string]any{"since": "2026-02-01"}, "limit": 1,
		"totals": []any{[]any{}, []any{"region"}},
	}
	ask := func(options map[string]any) map[string]any {
		return f.developer.expect("POST", "/query", map[string]any{"query": q, "options": options}, 200, "")
	}
	plain := ask(map[string]any{})
	if _, ok := plain["diagnostics"]; ok {
		t.Fatal("diagnostics were not requested")
	}
	first := ask(map[string]any{"diagnostics": true, "cache": "refresh"})
	statements := diagnosticStatements(t, first)
	if len(statements) != 3 {
		t.Fatalf("statements = %v", statements)
	}
	var duration float64
	for i, statement := range statements {
		kind := []string{"main", "total", "subtotal"}[i]
		if statement["kind"] != kind || statement["cached"] != false || statement["shared"] != false {
			t.Errorf("statement %d: %v", i, statement)
		}
		wantBy := []any{}
		if i == 2 {
			wantBy = []any{"region"}
		}
		if !reflect.DeepEqual(statement["by"], wantBy) {
			t.Errorf("grouping: %v", statement)
		}
		sql := statement["sql"].(string)
		args := statement["args"].([]any)
		if !strings.Contains(sql, "$1") || strings.Contains(sql, "2026-02-01") || strings.Contains(sql, "华东") {
			t.Errorf("SQL does not retain bound placeholders: %s", sql)
		}
		if !reflect.DeepEqual(args, []any{"2026-02-01", "华东", "华南"}) {
			t.Errorf("bound arguments: %v", args)
		}
		if _, err := time.Parse(time.RFC3339Nano, statement["fetchedAt"].(string)); err != nil {
			t.Errorf("fetchedAt: %v", err)
		}
		if statement["truncated"] != (i == 0) || statement["rowCount"] != []float64{1, 1, 2}[i] {
			t.Errorf("returned rows: %v", statement)
		}
		// The recorded SQL and arguments are directly executable, including
		// the extra row used to detect truncation.
		rows, err := f.admin.db.Pool.Query(context.Background(), sql, args...)
		if err != nil {
			t.Fatal(err)
		}
		count := 0
		for rows.Next() {
			count++
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		rows.Close()
		want := int(statement["rowCount"].(float64))
		if statement["truncated"] == true {
			want++
		}
		if count != want {
			t.Errorf("SQL returned %d rows, want %d", count, want)
		}
		duration += statement["durationMs"].(float64)
	}
	if duration != first["meta"].(map[string]any)["durationMs"] {
		t.Error("statement durations disagree with the result")
	}

	second := ask(map[string]any{"diagnostics": true})
	cached := diagnosticStatements(t, second)
	if second["diagnostics"].(map[string]any)["requestId"] == first["diagnostics"].(map[string]any)["requestId"] {
		t.Error("a cached result reused the previous request identity")
	}
	for i, statement := range cached {
		if statement["cached"] != true || statement["fetchedAt"] != statements[i]["fetchedAt"] || statement["durationMs"] != statements[i]["durationMs"] {
			t.Errorf("cache metadata: %v", statement)
		}
	}
	// A different row limit changes only the main statement. A response can
	// contain both fresh and cached statements, which must stay distinct.
	q["limit"] = 2
	mixed := diagnosticStatements(t, ask(map[string]any{"diagnostics": true}))
	if mixed[0]["cached"] != false || mixed[1]["cached"] != true || mixed[2]["cached"] != true || mixed[0]["truncated"] != false {
		t.Errorf("mixed cache hits: %v", mixed)
	}
	q["params"] = map[string]any{"since": "2026-01-01"}
	changed := diagnosticStatements(t, ask(map[string]any{"diagnostics": true}))
	for _, statement := range changed {
		if statement["cached"] != false || statement["args"].([]any)[0] != "2026-01-01" {
			t.Errorf("stale parameters: %v", statement)
		}
	}
	if result := ask(map[string]any{"diagnostics": false}); result["diagnostics"] != nil {
		t.Error("diagnostics leaked from the cache into an ordinary response")
	}
}

func TestQueryDiagnosticsOmittedTotalsAndEmptyArgs(t *testing.T) {
	f := newContentFixture(t)
	f.admin.editing("PUT", "/datasets/"+f.datasetID, map[string]any{
		"name": "订单", "datasourceId": f.sourceID(t), "spec": f.admin.spec(func(spec map[string]any) {
			spec["source"] = map[string]any{"type": "sql", "sql": "SELECT * FROM " + f.admin.db.Schema + ".orders"}
			delete(spec, "params")
		}),
	}, 200, "")
	q := map[string]any{
		"version": 1, "dataset": f.datasetID, "dimensions": []any{map[string]any{"field": "region"}},
		"measures": []any{map[string]any{"field": "revenue", "agg": "sum"}}, "totals": []any{[]any{}},
	}
	run := func() map[string]any {
		return f.developer.expect("POST", "/query", map[string]any{"query": q, "options": map[string]any{"diagnostics": true}}, 200, "")
	}
	for _, statement := range diagnosticStatements(t, run()) {
		if !reflect.DeepEqual(statement["args"], []any{}) {
			t.Errorf("no arguments must be an empty array: %v", statement)
		}
	}
	q["having"] = map[string]any{"field": "revenue", "op": "gt", "value": 0}
	result := run()
	if statements := diagnosticStatements(t, result); len(statements) != 1 || statements[0]["kind"] != "main" || result["meta"].(map[string]any)["totalsOmitted"] != true {
		t.Errorf("unexecuted totals were reported: %v", result)
	}
}

func TestChartDiagnosticsRequireAuthorAndFollowFilters(t *testing.T) {
	f := newContentFixture(t)
	f.admin.expect("PUT", "/datasources/"+f.sourceID(t), merge(f.admin.datasourceInput("db"), map[string]any{"cacheTtlSeconds": 600}), 200, "")
	chart := f.chart("地区销售", `{"type":"table"}`)
	chart["spec"].(map[string]any)["filters"] = []any{map[string]any{
		"id": "region", "field": "region", "op": "in", "label": "地区", "control": map[string]any{"type": "select"},
	}}
	chartID := f.developer.expect("POST", "/charts", chart, 201, "")["id"].(string)
	f.share(t, chartID)
	path := "/charts/" + chartID + "/data"
	for _, region := range []string{"华东", "华南"} {
		body := map[string]any{"diagnostics": true, "filters": map[string]any{"region": []any{region}}}
		for _, author := range []*client{f.developer, f.admin} {
			result := author.expect("POST", path, body, 200, "")
			statements := diagnosticStatements(t, result)
			args, _ := json.Marshal(statements[0]["args"])
			if len(statements) != 1 || !strings.Contains(string(args), region) {
				t.Errorf("runtime filters missing from diagnostics: %v", statements)
			}
		}
		f.viewer.expect("POST", path, body, 403, "forbidden")
		delete(body, "diagnostics")
		result := f.viewer.expect("POST", path, body, 200, "")
		if result["diagnostics"] != nil || result["meta"].(map[string]any)["cached"] != true {
			t.Errorf("viewer received author diagnostics from a cached query: %v", result)
		}
	}
}
