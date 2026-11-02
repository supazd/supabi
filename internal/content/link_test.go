package content

import "testing"

func TestLinkTargetsUseOneFieldPerWidget(t *testing.T) {
	for _, tt := range []struct {
		name    string
		targets []FilterTarget
		want    string
	}{
		{"different widgets", []FilterTarget{{Item: "b", Field: "region"}, {Item: "c", Field: "area"}}, ""},
		{"different fields on same widget", []FilterTarget{{Item: "b", Field: "region"}, {Item: "b", Field: "city"}}, "invalid_link"},
		{"duplicate field", []FilterTarget{{Item: "b", Field: "region"}, {Item: "b", Field: "region"}}, "invalid_link"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			spec := DashboardSpec{Layout: Layout{Items: []Item{{ID: "a", Type: ItemChart, ChartID: "ch_a"}, {ID: "b", Type: ItemChart, ChartID: "ch_b"}, {ID: "c", Type: ItemChart, ChartID: "ch_c"}}}, Links: []Link{{ID: "region", Label: "Region", Source: LinkSource{Item: "a", Column: "region"}, Targets: tt.targets}}}
			if got := code(spec.validateLinks()); got != tt.want {
				t.Fatalf("got %q, want %q", got, tt.want)
			}
		})
	}
}
