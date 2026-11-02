package query

import (
	"testing"

	"github.com/supazd/supabi/internal/dataset"
)

func TestHiddenFields(t *testing.T) {
	opt := options()
	opt.Hidden = map[string]bool{"amount": true}
	refused := map[string]string{
		"as a measure":        `{"version":1,"dataset":"d","measures":[{"field":"amount","agg":"sum"}]}`,
		"as a dimension":      `{"version":1,"dataset":"d","dimensions":[{"field":"amount"}]}`,
		"as a detail column":  `{"version":1,"dataset":"d","mode":"detail","columns":[{"field":"amount"}]}`,
		"in a filter":         `{"version":1,"dataset":"d","dimensions":[{"field":"name"}],"filter":{"field":"amount","op":"gt","value":1}}`,
		"inside a logical op": `{"version":1,"dataset":"d","dimensions":[{"field":"name"}],"filter":{"op":"or","args":[{"field":"name","op":"eq","value":"a"},{"field":"amount","op":"gt","value":1}]}}`,
		"in a share's total":  `{"version":1,"dataset":"d","dimensions":[{"field":"name"}],"measures":[{"field":"amount","agg":"sum","compute":{"type":"percent_of_total"}}]}`,
	}
	for name, body := range refused {
		if _, err := Compile(parse(t, body), extensionDataset(), opt); errCode(err) != "hidden_field" {
			t.Errorf("%s: err = %v, want hidden_field", name, err)
		}
	}
	// The row filter is the server's and may name a hidden field.
	opt.RowFilter = &dataset.Filter{Field: "amount", Op: "gt", Value: float64(1)}
	if _, err := Compile(parse(t, `{"version":1,"dataset":"d","dimensions":[{"field":"name"}]}`), extensionDataset(), opt); err != nil {
		t.Errorf("a row filter on a hidden field: %v", err)
	}
	if _, err := Compile(parse(t, `{"version":1,"dataset":"d","dimensions":[{"field":"day","grain":"month"}],"measures":[{"field":"name","agg":"count","compute":{"type":"compare","timeField":"day","offset":{"n":1,"unit":"month"},"output":"value"}}],"filter":{"field":"day","op":"time","value":{"start":"2026-01-01","end":"2026-03-01"}}}`), extensionDataset(), opt); err != nil {
		t.Errorf("a row filter on a hidden field inside a comparison: %v", err)
	}
}
