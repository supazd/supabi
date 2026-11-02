package api

import (
	"testing"

	"github.com/supazd/supabi/internal/dialect"
	"github.com/supazd/supabi/internal/query"
)

func TestComparisonResultMetadata(t *testing.T) {
	cols := resultColumns([]query.Column{{Name: "growth", Compute: query.Compare, Comparison: &query.Comparison{Offset: query.Duration{N: 1, Unit: dialect.Year}, Output: "ratio"}}})
	col := cols[0]
	if col.Compute == nil || *col.Compute != "compare" || col.Comparison == nil || col.Comparison.Output != "ratio" || col.Comparison.Offset.Unit != "year" || col.Comparison.Offset.N != 1 {
		t.Fatalf("%+v", col)
	}
}

func TestDynamicComparisonNamesSurviveSavedAndPreviewQueries(t *testing.T) {
	f := newContentFixture(t)
	input := f.chart("Dynamic comparison names", `{"type":"table"}`)
	spec := input["spec"].(map[string]any)
	q := spec["query"].(map[string]any)
	q["dimensions"] = []any{}
	compute := map[string]any{"type": "compare", "timeField": "order_date", "offset": map[string]any{"n": 1, "unit": "month"}, "output": "value"}
	// Legacy saved dynamic queries used the option label as a final label.
	q["measures"] = []any{map[string]any{"field": "revenue", "agg": "sum", "alias": "metric", "label": "SUM(Revenue)", "compute": compute}}
	spec["dynamics"] = []any{map[string]any{"id": "metric", "kind": "measure", "label": "Metric", "alias": "metric", "options": []any{
		map[string]any{"id": "sum", "field": "revenue", "agg": "sum", "label": "SUM(Revenue)"},
		map[string]any{"id": "avg", "field": "revenue", "agg": "avg", "label": "Average sale"},
	}}}
	spec["filters"] = []any{map[string]any{"id": "period", "field": "order_date", "op": "time", "value": map[string]any{"start": "2026-02-01", "end": "2026-03-01"}}}
	id := f.developer.expect("POST", "/charts", input, 201, "")["id"].(string)
	f.share(t, id)
	for _, choice := range []string{"sum", "avg"} {
		result := f.viewer.expect("POST", "/charts/"+id+"/data", map[string]any{"selections": map[string]string{"metric": choice}}, 200, "")
		col := result["columns"].([]any)[0].(map[string]any)
		label := "SUM(Revenue)"
		if choice == "avg" {
			label = "Average sale"
		}
		if col["label"] != label || col["compute"] != "compare" || col["agg"] != nil || col["comparison"].(map[string]any)["output"] != "value" {
			t.Fatalf("selected metadata: %v", col)
		}
	}
	// The editor preview uses the public query IR after resolving the option.
	q["measures"] = []any{map[string]any{"field": "revenue", "agg": "avg", "alias": "metric", "baseLabel": "Average sale", "compute": compute}}
	q["filter"] = map[string]any{"field": "order_date", "op": "time", "value": map[string]any{"start": "2026-02-01", "end": "2026-03-01"}}
	result := f.developer.expect("POST", "/query", map[string]any{"query": q}, 200, "")
	col := result["columns"].([]any)[0].(map[string]any)
	if col["label"] != "Average sale" || col["compute"] != "compare" || col["comparison"].(map[string]any)["output"] != "value" {
		t.Fatalf("preview metadata: %v", col)
	}
}
