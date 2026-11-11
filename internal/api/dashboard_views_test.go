package api

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/supazd/supabi/internal/store"
)

func TestDashboardViews(t *testing.T) {
	f := newContentFixture(t)
	ctx := context.Background()
	chartID := f.developer.expect("POST", "/charts", f.chart("按月", `{"type":"table"}`), 201, "")["id"].(string)
	board := f.developer.expect("POST", "/dashboards", map[string]any{"name": "经营", "spec": dashboardSpec(chartID, chartID)}, 201, "")["id"].(string)
	hidden := f.developer.expect("POST", "/dashboards", map[string]any{"name": "未授权", "spec": dashboardSpec(chartID)}, 201, "")["id"].(string)
	f.share(t, board)
	count := func(query string, args ...any) int {
		t.Helper()
		var n int
		if err := f.admin.db.Pool.QueryRow(ctx, query, args...).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	expiry := func(view map[string]any) time.Time {
		t.Helper()
		at, err := time.Parse(time.RFC3339Nano, view["expiresAt"].(string))
		if err != nil {
			t.Fatal(err)
		}
		return at
	}
	share := func(state map[string]any, days int) map[string]any {
		t.Helper()
		return f.viewer.expect("POST", "/dashboards/"+board+"/views", map[string]any{"state": state, "validDays": days}, 201, "")
	}

	// A viewer shares what they chose, empty parts and the order of widgets aside.
	first := share(map[string]any{"filters": map[string]any{"g": []any{"华东"}}, "useChartFilters": []any{"wb", "wa"}, "links": map[string]any{}, "tabs": map[string]any{}, "page": ""}, 30)
	id := first["id"].(string)
	if days := time.Until(expiry(first)).Hours() / 24; days < 29.9 || days > 30.1 {
		t.Errorf("valid for %.2f days, want 30", days)
	}
	valid := func(view map[string]any) float64 { return time.Until(expiry(view)).Hours() / 24 }
	// Shared again the same way, they keep their link, which lasts from now.
	same := share(map[string]any{"useChartFilters": []any{"wa", "wb"}, "filters": map[string]any{"g": []any{"华东"}}}, 30)
	if same["id"] != id || expiry(same).Before(expiry(first)) {
		t.Errorf("the same conditions again: %v, first %v", same, first)
	}
	// For another length of time they get a link of their own, which lasts
	// as long as was asked: a day is a day, whatever was shared before.
	longer := share(map[string]any{"useChartFilters": []any{"wa", "wb"}, "filters": map[string]any{"g": []any{"华东"}}}, 90)
	if longer["id"] == id || valid(longer) < 89.9 || valid(longer) > 90.1 {
		t.Errorf("the same conditions for 90 days: %v, first %v", longer, first)
	}
	shorter := share(map[string]any{"filters": map[string]any{"g": []any{"华东"}}, "useChartFilters": []any{"wa", "wb"}}, 1)
	if shorter["id"] == id || shorter["id"] == longer["id"] || valid(shorter) < 0.9 || valid(shorter) > 1.1 {
		t.Errorf("the same conditions for a day: %v", shorter)
	}
	// Nor does that cut short the link already sent.
	if kept := f.viewer.expect("GET", "/dashboards/"+board+"/views/"+id, nil, 200, ""); !expiry(kept).Equal(expiry(same)) {
		t.Errorf("the first link now expires at %v, was %v", kept["expiresAt"], same["expiresAt"])
	}
	// The tab a tab container shows is carried too, and the page of a split dashboard.
	other := share(map[string]any{"filters": map[string]any{"g": []any{"华南"}}, "tabs": map[string]any{"wt": "wb"}, "page": "p2"}, 7)
	if other["id"] == id {
		t.Error("other conditions got the same link")
	}
	carried := f.viewer.expect("GET", "/dashboards/"+board+"/views/"+other["id"].(string), nil, 200, "")["state"].(map[string]any)
	if tabs, _ := json.Marshal(carried["tabs"]); string(tabs) != `{"wt":"wb"}` {
		t.Errorf("tabs: %s", tabs)
	}
	if carried["page"] != "p2" {
		t.Errorf("page: %v", carried["page"])
	}
	if n := count(`SELECT count(*) FROM dashboard_views WHERE dashboard_id = $1`, board); n != 4 {
		t.Errorf("%d rows, want 4", n)
	}

	got := f.viewer.expect("GET", "/dashboards/"+board+"/views/"+id, nil, 200, "")
	state, _ := json.Marshal(got["state"])
	if string(state) != `{"filters":{"g":["华东"]},"useChartFilters":["wa","wb"]}` {
		t.Errorf("state: %s", state)
	}
	if n := count(`SELECT count(*) FROM dashboard_views WHERE id = $1 AND last_opened_at IS NOT NULL`, id); n != 1 {
		t.Error("opening the link was not noted")
	}

	f.viewer.expect("POST", "/dashboards/"+board+"/views", map[string]any{"state": map[string]any{}, "validDays": 2}, 400, "invalid_valid_days")
	// The link grants nothing: a dashboard the viewer cannot open cannot be shared or read through it.
	f.viewer.expect("POST", "/dashboards/"+hidden+"/views", map[string]any{"state": map[string]any{}, "validDays": 1}, 404, "")
	f.viewer.expect("GET", "/dashboards/"+hidden+"/views/"+id, nil, 404, "")
	f.viewer.expect("GET", "/dashboards/"+board+"/views/dv_nope", nil, 404, "view_not_found")
	if n := count(`SELECT count(*) FROM audit_events WHERE action = 'dashboard.share' AND object_id = $1`, board); n != 5 {
		t.Errorf("%d share events, want 5", n)
	}

	// Expired conditions are not carried, and maintenance deletes them.
	if _, err := f.admin.db.Pool.Exec(ctx, `UPDATE dashboard_views SET expires_at = now() - interval '1 second' WHERE id = $1`, id); err != nil {
		t.Fatal(err)
	}
	f.viewer.expect("GET", "/dashboards/"+board+"/views/"+id, nil, 404, "view_not_found")
	orgID := ""
	if err := f.admin.db.Pool.QueryRow(ctx, `SELECT org_id FROM dashboards WHERE id = $1`, board).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	if pruned, err := store.PruneDashboardViews(ctx, f.admin.db.Pool, orgID); err != nil || pruned != 1 {
		t.Errorf("pruned %d, %v", pruned, err)
	}

	// Deleting the dashboard deletes what it was shared with.
	f.developer.expect("DELETE", "/dashboards/"+board, nil, 204, "")
	if n := count(`SELECT count(*) FROM dashboard_views WHERE dashboard_id = $1`, board); n != 0 {
		t.Errorf("%d rows left after deleting the dashboard", n)
	}
}
