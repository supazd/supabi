package content

import (
	"encoding/json"
	"slices"
	"testing"

	"github.com/supazd/supabi/internal/dialect"
)

func TestChartFilterStyle(t *testing.T) {
	for _, layout := range []string{"horizontal", "vertical"} {
		for _, density := range []string{"comfortable", "normal", "compact"} {
			spec := chartSpec(t, `{"specVersion":1,"query":{"version":1,"dataset":"d","measures":[{"field":"revenue","agg":"sum"}]},"viz":{"type":"table"}}`)
			spec.FilterStyle = &FilterStyle{Layout: layout, Density: density}
			if err := spec.Validate(orders, dialect.Postgres{}); err != nil {
				t.Fatal(err)
			}
			raw, err := json.Marshal(spec)
			if err != nil {
				t.Fatal(err)
			}
			var restored ChartSpec
			if err := json.Unmarshal(raw, &restored); err != nil {
				t.Fatal(err)
			}
			if restored.FilterStyle == nil || *restored.FilterStyle != *spec.FilterStyle {
				t.Fatalf("style lost: %s", raw)
			}
		}
	}
	for _, style := range []FilterStyle{{Layout: "diagonal", Density: "normal"}, {Layout: "vertical", Density: "tiny"}} {
		spec := ChartSpec{FilterStyle: &style}
		if got := code(spec.Validate(orders, dialect.Postgres{})); got != "invalid_filter_style" {
			t.Fatalf("got %s", got)
		}
	}
}

func TestDashboardFilterStyle(t *testing.T) {
	for _, layout := range []string{"horizontal", "vertical"} {
		for _, density := range []string{"compact", "normal", "comfortable"} {
			spec := DashboardSpec{SpecVersion: 1, Layout: Layout{Columns: 12}, FilterStyle: &FilterStyle{Layout: layout, Density: density}}
			if err := spec.Validate(); err != nil {
				t.Fatal(err)
			}
		}
	}
	spec := DashboardSpec{SpecVersion: 1, Layout: Layout{Columns: 12}, FilterStyle: &FilterStyle{Layout: "diagonal", Density: "compact"}}
	if got := code(spec.Validate()); got != "invalid_filter_style" {
		t.Fatalf("got %s", got)
	}
}

func TestDashboardQueryMode(t *testing.T) {
	for _, mode := range []string{"", "auto", "manual", "unknown"} {
		spec := DashboardSpec{SpecVersion: 1, Layout: Layout{Columns: GridColumns}, QueryMode: mode}
		err := spec.Validate()
		if mode == "unknown" {
			if code(err) != "invalid_query_mode" {
				t.Fatalf("mode %q: %v", mode, err)
			}
		} else if err != nil {
			t.Fatalf("mode %q: %v", mode, err)
		}
	}
}

func TestDashboardAutoRefresh(t *testing.T) {
	for _, seconds := range []int{0, 60, 300, 900, 1800, 3600, 30, 120, 7200, -60} {
		spec := DashboardSpec{SpecVersion: 1, Layout: Layout{Columns: GridColumns}, AutoRefresh: seconds}
		err := spec.Validate()
		if seconds == 0 || slices.Contains(AutoRefreshIntervals, seconds) {
			if err != nil {
				t.Fatalf("%ds: %v", seconds, err)
			}
		} else if code(err) != "invalid_auto_refresh" {
			t.Fatalf("%ds: %v", seconds, err)
		}
	}
}

func TestDashboardQueryHeightMode(t *testing.T) {
	for _, mode := range []string{"", "auto", "manual", "unknown"} {
		spec := DashboardSpec{SpecVersion: 1, Layout: Layout{Columns: GridColumns}, QueryHeightMode: mode}
		err := spec.Validate()
		if mode == "unknown" {
			if code(err) != "invalid_query_height_mode" {
				t.Fatalf("mode %q: %v", mode, err)
			}
		} else if err != nil {
			t.Fatalf("mode %q: %v", mode, err)
		}
	}
}
