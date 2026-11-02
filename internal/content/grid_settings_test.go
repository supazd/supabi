package content

import (
	"encoding/json"
	"math"
	"testing"
)

func TestDashboardGridSettings(t *testing.T) {
	for _, tt := range []struct {
		name   string
		change func(*DashboardSpec)
		valid  bool
	}{
		{"defaults", func(s *DashboardSpec) {}, true},
		{"custom", func(s *DashboardSpec) {
			s.Layout.Columns = 24
			s.Layout.Grid.RowHeight = 12
			s.Layout.Grid.ColumnGap = 3
			s.Layout.Grid.RowGap = 4
			s.Layout.Grid.ContainerGap = 2
			s.Layout.Grid.AutoCompact = false
		}, true},
		{"minimum", func(s *DashboardSpec) {
			s.Layout.Columns = 12
			s.Layout.Grid.RowHeight = 4
			s.Layout.Grid.ColumnGap = 0
			s.Layout.Grid.RowGap = 0
		}, true},
		{"maximum", func(s *DashboardSpec) {
			s.Layout.Columns = 192
			s.Layout.Grid.RowHeight = 64
			s.Layout.Grid.ColumnGap = 24
			s.Layout.Grid.RowGap = 24
			s.Layout.Grid.ContainerGap = 24
		}, true},
		{"too few columns", func(s *DashboardSpec) { s.Layout.Columns = 11 }, false},
		{"too many columns", func(s *DashboardSpec) { s.Layout.Columns = 193 }, false},
		{"zero height", func(s *DashboardSpec) { s.Layout.Grid.RowHeight = 0 }, false},
		{"invalid precision", func(s *DashboardSpec) { s.Layout.Grid.RowGap = 1.2 }, false},
		{"negative gap", func(s *DashboardSpec) { s.Layout.Grid.ColumnGap = -1 }, false},
		{"too much clearance", func(s *DashboardSpec) { s.Layout.Grid.ContainerGap = 25 }, false},
		{"nonfinite", func(s *DashboardSpec) { s.Layout.Grid.RowHeight = math.NaN() }, false},
		{"outside custom columns", func(s *DashboardSpec) {
			s.Layout.Columns = 24
			s.Layout.Items = []Item{{ID: "w1", Type: ItemChart, ChartID: "chart", W: 25, H: 16}}
		}, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			s := DashboardSpec{SpecVersion: 1, Layout: Layout{Columns: 96, Grid: &GridSettings{RowHeight: 8, ColumnGap: 1.5, RowGap: 1.5, AutoCompact: true}}}
			tt.change(&s)
			if err := s.Validate(); (err == nil) != tt.valid {
				t.Fatalf("Validate() = %v, valid = %v", err, tt.valid)
			}
			if !tt.valid {
				return
			}
			encoded, err := json.Marshal(s)
			if err != nil {
				t.Fatal(err)
			}
			var decoded DashboardSpec
			if err := json.Unmarshal(encoded, &decoded); err != nil {
				t.Fatal(err)
			}
			if decoded.Layout.Columns != s.Layout.Columns || *decoded.Layout.Grid != *s.Layout.Grid {
				t.Fatalf("settings lost: %s", encoded)
			}
		})
	}
}
