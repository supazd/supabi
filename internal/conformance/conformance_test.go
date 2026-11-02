package conformance

import (
	"testing"

	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/query"
)

// The suite is only as good as its comparison: it must treat equal numbers as
// equal whatever their representation, and nothing else as equal.
func TestCanon(t *testing.T) {
	columns := []query.Column{{Type: datasource.String}, {Type: datasource.Decimal}, {Type: datasource.Integer}}
	base := canon([][]any{{"a", "1.50", int64(2)}}, columns)

	same := [][][]any{
		{{"a", 1.5, "2"}},
		{{"a", "1.5000000", "2.0"}},
		{{"a", "1.5", float64(2)}},
	}
	for _, rows := range same {
		if got := canon(rows, columns); got != base {
			t.Errorf("%v should equal the base: %s vs %s", rows, got, base)
		}
	}
	different := [][][]any{
		{{"a", "1.51", 2}},
		{{"a", "1.5", 3}},
		{{"b", "1.5", 2}},
		{{"a", nil, 2}},
		{{"a", "1.5", 2}, {"a", "1.5", 2}},
		{},
	}
	for _, rows := range different {
		if got := canon(rows, columns); got == base {
			t.Errorf("%v should differ from the base", rows)
		}
	}
	// Text that happens to look like a number is not touched.
	text := []query.Column{{Type: datasource.String}}
	if canon([][]any{{"007"}}, text) == canon([][]any{{"7"}}, text) {
		t.Error("string columns must be compared as text")
	}
}
