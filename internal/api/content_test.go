package api

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

// contentFixture is an installation with a data source, a dataset, and one
// member for each role below admin.
type contentFixture struct {
	admin, viewer, developer *client
	datasetID                string
	shared                   int // dashboards share has made
}

const memberPassword = "member-password"

func newContentFixture(t *testing.T) *contentFixture {
	t.Helper()
	admin := newClient(t)
	for _, role := range []string{"viewer", "developer"} {
		admin.expect("POST", "/users", map[string]any{"email": role + "@example.com", "displayName": role, "password": memberPassword}, 201, "")
		admin.expect("POST", "/members", map[string]any{"userId": userID(t, admin, role+"@example.com"), "role": role}, 201, "")
	}
	sourceID := admin.expect("POST", "/datasources", admin.datasourceInput("db"), 201, "")["id"].(string)
	datasetID := admin.expect("POST", "/datasets", map[string]any{"name": "订单", "datasourceId": sourceID, "spec": admin.spec(nil)}, 201, "")["id"].(string)
	return &contentFixture{
		admin:     admin,
		viewer:    admin.signedIn("viewer@example.com", memberPassword),
		developer: admin.signedIn("developer@example.com", memberPassword),
		datasetID: datasetID,
	}
}

// share lets viewers see what the IDs name, as an admin would: a dashboard is
// granted to every member, and charts are put on a new dashboard that is.
func (f *contentFixture) share(t *testing.T, ids ...string) {
	t.Helper()
	var charts []string
	for _, id := range ids {
		if strings.HasPrefix(id, "db_") {
			f.admin.expect("PUT", "/dashboards/"+id+"/grants", map[string]any{"subjects": []any{map[string]any{"everyone": true}}}, 200, "")
		} else {
			charts = append(charts, id)
		}
	}
	if len(charts) > 0 {
		f.shared++
		board := f.developer.expect("POST", "/dashboards", map[string]any{"name": fmt.Sprintf("shared %d", f.shared), "spec": dashboardSpec(charts...)}, 201, "")
		f.share(t, board["id"].(string))
	}
}

// chart builds a chart input: revenue by month, drawn as viz.
func (f *contentFixture) chart(name, viz string) map[string]any {
	var spec map[string]any
	raw := `{"specVersion":1,"query":{"version":1,"dataset":"` + f.datasetID + `","dimensions":[{"field":"order_date","grain":"month","alias":"month"},{"field":"region"}],"measures":[{"field":"revenue","agg":"sum"}]},"viz":` + viz + `}`
	if err := json.Unmarshal([]byte(raw), &spec); err != nil {
		panic(err)
	}
	return map[string]any{"name": name, "description": "按月", "spec": spec}
}

func TestCharts(t *testing.T) {
	f := newContentFixture(t)
	const bar = `{"type":"bar","x":"month","y":["revenue"],"series":"region"}`

	f.developer.expect("POST", "/charts", f.chart(" ", bar), 400, "name_required")
	f.developer.expect("POST", "/charts", f.chart("c", `{"type":"bar","x":"nope","y":["revenue"]}`), 400, "viz_unknown_column")
	f.developer.expect("POST", "/charts", f.chart("c", `{"type":"bar","x":"month","y":["revenue"],"colour":"red"}`), 400, "invalid_spec")
	broken := f.chart("c", bar)
	broken["spec"].(map[string]any)["query"].(map[string]any)["measures"] = []any{map[string]any{"field": "nope"}}
	f.developer.expect("POST", "/charts", broken, 400, "unknown_field")
	elsewhere := f.chart("c", bar)
	elsewhere["spec"].(map[string]any)["query"].(map[string]any)["dataset"] = "ds_nope"
	f.developer.expect("POST", "/charts", elsewhere, 400, "unknown_dataset")

	created := f.developer.expect("POST", "/charts", f.chart("月度销售额", bar), 201, "")
	id := created["id"].(string)
	if created["vizType"] != "bar" || created["datasetId"] != f.datasetID || created["description"] != "按月" {
		t.Errorf("created = %v", created)
	}
	f.developer.expect("POST", "/charts", f.chart("月度销售额", bar), 409, "name_taken")

	updated := f.developer.editing("PUT", "/charts/"+id, f.chart("月度销售额", `{"type":"table"}`), 200, "")
	if updated["vizType"] != "table" {
		t.Errorf("updated = %v", updated)
	}
	f.developer.editing("PUT", "/charts/ch_nope", f.chart("x", bar), 404, "not_found")
	// Viewers list only the charts on dashboards granted to them.
	if _, list := f.viewer.do("GET", "/charts", nil); len(list.([]any)) != 0 {
		t.Errorf("charts a viewer lists before any is shared = %v", list)
	}
	board := f.developer.expect("POST", "/dashboards", map[string]any{"name": "board", "spec": dashboardSpec(id)}, 201, "")["id"].(string)
	f.share(t, board)
	_, list := f.viewer.do("GET", "/charts", nil)
	if items := list.([]any); len(items) != 1 || items[0].(map[string]any)["vizType"] != "table" || items[0].(map[string]any)["spec"] != nil {
		t.Errorf("list = %v", list)
	}
	f.developer.expect("DELETE", "/dashboards/"+board, nil, 204, "")

	// A dataset cannot be deleted from under a chart.
	f.admin.expect("DELETE", "/datasets/"+f.datasetID, nil, 409, "in_use")
	f.developer.expect("DELETE", "/charts/"+id, nil, 204, "")
	f.developer.expect("GET", "/charts/"+id, nil, 404, "not_found")
	f.admin.expect("DELETE", "/datasets/"+f.datasetID, nil, 204, "")
}

func TestViewersReachDataOnlyThroughCharts(t *testing.T) {
	f := newContentFixture(t)
	chart := f.chart("按月", `{"type":"line","x":"month","y":["revenue"]}`)
	chart["spec"].(map[string]any)["query"].(map[string]any)["dimensions"] = []any{map[string]any{"field": "order_date", "grain": "month", "alias": "month"}}
	chart["spec"].(map[string]any)["filters"] = []any{
		map[string]any{"id": "when", "field": "order_date", "op": "time", "label": "下单日期", "control": map[string]any{"type": "relative"}},
		map[string]any{"id": "east", "field": "region", "op": "in", "value": []any{"华东"}},
	}
	id := f.developer.expect("POST", "/charts", chart, 201, "")["id"].(string)

	rows := func(c *client, body any) string {
		t.Helper()
		result := c.expect("POST", "/charts/"+id+"/data", body, 200, "")
		encoded, _ := json.Marshal(result["rows"])
		return string(encoded)
	}
	f.viewer.expect("POST", "/charts/"+id+"/data", nil, 404, "not_found") // not shared with viewers yet
	f.share(t, id)
	// The viewer may not query the dataset, nor even see that it exists…
	f.viewer.expect("POST", "/query", `{"query":{"version":1,"dataset":"`+f.datasetID+`","measures":[{"field":"revenue","agg":"sum"}]}}`, 403, "forbidden")
	f.viewer.expect("GET", "/datasets/"+f.datasetID, nil, 403, "forbidden")
	// …but gets the data of a chart someone made for them.
	if got, want := rows(f.viewer, nil), `[["2026-01-01","100.50"],["2026-02-01","200.00"]]`; got != want {
		t.Errorf("chart data = %s, want %s", got, want)
	}
	// They may set the filters the chart offers them. The clock is pinned to 10 March 2026.
	if got, want := rows(f.viewer, map[string]any{"filters": map[string]any{"when": map[string]any{"last": map[string]any{"n": 1, "unit": "month"}}}}), `[["2026-02-01","200.00"]]`; got != want {
		t.Errorf("chart data for last month = %s, want %s", got, want)
	}
	if got := rows(f.viewer, map[string]any{"filters": map[string]any{"when": map[string]any{"current": "month"}}}); got != `[]` {
		t.Errorf("chart data for this month = %s, want []", got)
	}

	// The request cannot carry anything but values for those filters: not a
	// field, not a value for a condition the author fixed.
	f.viewer.expect("POST", "/charts/"+id+"/data", map[string]any{"filters": map[string]any{"when": map[string]any{"dimension": "order_date", "current": "year"}}}, 400, "invalid_time_range")
	f.viewer.expect("POST", "/charts/"+id+"/data", map[string]any{"filters": map[string]any{"when": map[string]any{"last": map[string]any{"n": -1, "unit": "day"}}}}, 400, "invalid_time_range")
	f.viewer.expect("POST", "/charts/"+id+"/data", map[string]any{"filters": map[string]any{"east": []any{"华南"}}}, 400, "filter_not_interactive")
	f.viewer.expect("POST", "/charts/"+id+"/data", map[string]any{"filters": map[string]any{"region": []any{"华南"}}}, 400, "filter_not_interactive")
	f.viewer.expect("POST", "/charts/ch_nope/data", nil, 404, "not_found")

	// Viewers look; they do not change.
	f.viewer.expect("POST", "/charts", chart, 403, "forbidden")
	f.viewer.editing("PUT", "/charts/"+id, chart, 403, "forbidden")
	f.viewer.expect("DELETE", "/charts/"+id, nil, 403, "forbidden")
	f.viewer.expect("POST", "/dashboards", map[string]any{"name": "x", "spec": map[string]any{}}, 403, "forbidden")
}

func dashboardSpec(chartIDs ...string) map[string]any {
	items := []any{}
	for i, id := range chartIDs {
		items = append(items, map[string]any{"id": "w" + string(rune('a'+i)), "type": "chart", "chartId": id, "x": (i % 2) * 6, "y": (i / 2) * 4, "w": 6, "h": 4})
	}
	return map[string]any{"specVersion": 1, "layout": map[string]any{"columns": 12, "items": items}}
}

func TestDashboards(t *testing.T) {
	f := newContentFixture(t)
	first := f.developer.expect("POST", "/charts", f.chart("甲", `{"type":"table"}`), 201, "")["id"].(string)
	second := f.developer.expect("POST", "/charts", f.chart("乙", `{"type":"pie","x":"region","y":["revenue"]}`), 201, "")["id"].(string)

	f.developer.expect("POST", "/dashboards", map[string]any{"name": " ", "spec": dashboardSpec(first)}, 400, "name_required")
	f.developer.expect("POST", "/dashboards", map[string]any{"name": "d", "spec": dashboardSpec("ch_nope")}, 400, "unknown_chart")
	f.developer.expect("POST", "/dashboards", map[string]any{"name": "d", "spec": map[string]any{"specVersion": 1, "layout": map[string]any{"columns": 12, "items": []any{}}, "theme": "dark"}}, 400, "invalid_spec")
	tooWide := dashboardSpec(first)
	tooWide["layout"].(map[string]any)["items"].([]any)[0].(map[string]any)["w"] = 13
	f.developer.expect("POST", "/dashboards", map[string]any{"name": "d", "spec": tooWide}, 400, "invalid_item_position")

	created := f.developer.expect("POST", "/dashboards", map[string]any{"name": "经营概览", "description": "每日", "spec": dashboardSpec(first, second)}, 201, "")
	id := created["id"].(string)
	// The charts come with the dashboard, so drawing it takes no further lookups.
	charts := created["charts"].([]any)
	if len(charts) != 2 || charts[0].(map[string]any)["spec"] == nil || created["description"] != "每日" {
		t.Errorf("created = %v", created)
	}
	f.developer.expect("POST", "/dashboards", map[string]any{"name": "经营概览", "spec": dashboardSpec()}, 409, "name_taken")

	f.viewer.expect("GET", "/dashboards/"+id, nil, 404, "not_found") // not shared with viewers yet
	f.share(t, id)
	fetched := f.viewer.expect("GET", "/dashboards/"+id, nil, 200, "")
	if len(fetched["charts"].([]any)) != 2 || fetched["spec"].(map[string]any)["layout"] == nil {
		t.Errorf("fetched = %v", fetched)
	}
	if _, list := f.viewer.do("GET", "/dashboards", nil); len(list.([]any)) != 1 {
		t.Errorf("list = %v", list)
	}

	// A chart cannot be deleted while a dashboard shows it; taking it off the dashboard frees it.
	f.developer.expect("DELETE", "/charts/"+second, nil, 409, "in_use")
	updated := f.developer.editing("PUT", "/dashboards/"+id, map[string]any{"name": "经营概览", "spec": dashboardSpec(first)}, 200, "")
	if len(updated["charts"].([]any)) != 1 {
		t.Errorf("updated = %v", updated)
	}
	f.developer.expect("DELETE", "/charts/"+second, nil, 204, "")
	f.developer.editing("PUT", "/dashboards/db_nope", map[string]any{"name": "x", "spec": dashboardSpec(first)}, 404, "not_found")

	// Deleting the dashboard frees its remaining chart.
	f.viewer.expect("DELETE", "/dashboards/"+id, nil, 403, "forbidden")
	f.developer.expect("DELETE", "/dashboards/"+id, nil, 204, "")
	f.developer.expect("GET", "/dashboards/"+id, nil, 404, "not_found")
	f.developer.expect("DELETE", "/charts/"+first, nil, 204, "")
}

// Titles and text sit on the grid with the charts, but query nothing and are
// neither filtered nor linked.
func TestDashboardTitleAndText(t *testing.T) {
	f := newContentFixture(t)
	input := f.chart("按地区", `{"type":"bar","x":"region","y":["revenue"]}`)
	input["spec"].(map[string]any)["query"].(map[string]any)["dimensions"] = []any{map[string]any{"field": "region"}}
	chart := f.developer.expect("POST", "/charts", input, 201, "")["id"].(string)
	spec := dashboardSpec(chart)
	items := spec["layout"].(map[string]any)["items"].([]any)
	items = append(items,
		map[string]any{"id": "wt", "type": "title", "x": 0, "y": 4, "w": 12, "h": 1, "useDashboardName": true},
		map[string]any{"id": "wx", "type": "text", "x": 6, "y": 0, "w": 6, "h": 4, "markdown": "**口径**：已支付订单"},
	)
	spec["layout"].(map[string]any)["items"] = items
	// With a filter, saving compiles every widget's query; there is none to compile for these.
	spec["filters"] = []any{map[string]any{"id": "g", "label": "地区", "op": "in", "control": map[string]any{"type": "select"}, "targets": []any{map[string]any{"item": "wa", "field": "region"}}}}
	saved := f.developer.expect("POST", "/dashboards", map[string]any{"name": "概览", "spec": spec}, 201, "")
	id := saved["id"].(string)
	if charts := saved["charts"].([]any); len(charts) != 1 {
		t.Errorf("charts = %v", charts)
	}
	stored := saved["spec"].(map[string]any)["layout"].(map[string]any)["items"].([]any)
	if title, text := stored[1].(map[string]any), stored[2].(map[string]any); title["useDashboardName"] != true || text["markdown"] != "**口径**：已支付订单" {
		t.Errorf("items = %v", stored)
	}
	f.share(t, id)
	f.viewer.expect("POST", "/dashboards/"+id+"/items/wa/data", map[string]any{}, 200, "")
	f.viewer.expect("POST", "/dashboards/"+id+"/items/wt/data", map[string]any{}, 404, "not_found")
	f.viewer.expect("POST", "/dashboards/"+id+"/items/wx/filters/g/options", map[string]any{}, 404, "not_found")
	// The chart is only in use where a chart widget shows it.
	f.developer.expect("DELETE", "/charts/"+chart, nil, 409, "in_use")

	onTitle := dashboardSpec(chart)
	onTitle["layout"].(map[string]any)["items"] = items
	onTitle["filters"] = []any{map[string]any{"id": "g", "label": "地区", "op": "in", "control": map[string]any{"type": "select"}, "targets": []any{map[string]any{"item": "wt", "field": "region"}}}}
	f.developer.expect("POST", "/dashboards", map[string]any{"name": "筛选标题", "spec": onTitle}, 400, "invalid_filter_target")
	toText := dashboardSpec(chart)
	toText["layout"].(map[string]any)["items"] = items
	toText["links"] = []any{linkSpec("l", "wa", "region", "wx", "region")}
	f.developer.expect("POST", "/dashboards", map[string]any{"name": "联动文本", "spec": toText}, 400, "invalid_link")
	mixed := dashboardSpec(chart)
	mixed["layout"].(map[string]any)["items"] = []any{map[string]any{"id": "wt", "type": "title", "chartId": chart, "x": 0, "y": 0, "w": 12, "h": 1}}
	f.developer.expect("POST", "/dashboards", map[string]any{"name": "混合", "spec": mixed}, 400, "invalid_item_fields")
	// A title's background and border are in its frame now, not its style.
	styled := dashboardSpec(chart)
	styled["layout"].(map[string]any)["items"] = []any{map[string]any{"id": "wt", "type": "title", "x": 0, "y": 0, "w": 12, "h": 1, "style": map[string]any{"background": "blue"}}}
	f.developer.expect("POST", "/dashboards", map[string]any{"name": "旧样式", "spec": styled}, 400, "invalid_spec")
}

// A chart widget can be laid out before its chart is chosen. Empty, it queries
// nothing, is neither filtered nor linked, and does not count as using a chart.
func TestDashboardEmptyChartWidget(t *testing.T) {
	f := newContentFixture(t)
	input := f.chart("按地区", `{"type":"bar","x":"region","y":["revenue"]}`)
	input["spec"].(map[string]any)["query"].(map[string]any)["dimensions"] = []any{map[string]any{"field": "region"}}
	chart := f.developer.expect("POST", "/charts", input, 201, "")["id"].(string)
	spec := dashboardSpec(chart)
	frame := map[string]any{"background": "#1f3a5f", "backgroundDark": "#0d1b2a", "border": false, "padding": "compact"}
	spec["layout"].(map[string]any)["items"] = append(spec["layout"].(map[string]any)["items"].([]any),
		map[string]any{"id": "we", "type": "chart", "x": 0, "y": 4, "w": 6, "h": 4, "title": "待定", "note": "下周补上", "frame": frame},
	)
	spec["frame"] = map[string]any{"border": false}
	spec["filters"] = []any{map[string]any{"id": "g", "label": "地区", "op": "in", "control": map[string]any{"type": "select"}, "targets": []any{map[string]any{"item": "wa", "field": "region"}}}}
	saved := f.developer.expect("POST", "/dashboards", map[string]any{"name": "排版", "spec": spec}, 201, "")
	id := saved["id"].(string)
	if charts := saved["charts"].([]any); len(charts) != 1 {
		t.Errorf("charts = %v", charts)
	}
	stored := saved["spec"].(map[string]any)
	if empty := stored["layout"].(map[string]any)["items"].([]any)[1].(map[string]any); !reflect.DeepEqual(empty["frame"], frame) || empty["note"] != "下周补上" || empty["chartId"] != nil {
		t.Errorf("empty widget = %v", empty)
	}
	if !reflect.DeepEqual(stored["frame"], map[string]any{"border": false}) {
		t.Errorf("frame = %v", stored["frame"])
	}
	f.share(t, id)
	f.viewer.expect("POST", "/dashboards/"+id+"/items/we/data", map[string]any{}, 404, "not_found")
	f.viewer.expect("POST", "/dashboards/"+id+"/items/we/filters/g/options", map[string]any{}, 404, "not_found")
	onEmpty := spec
	onEmpty["filters"] = []any{map[string]any{"id": "g", "label": "地区", "op": "in", "control": map[string]any{"type": "select"}, "targets": []any{map[string]any{"item": "we", "field": "region"}}}}
	f.developer.editing("PUT", "/dashboards/"+id, map[string]any{"name": "排版", "spec": onEmpty}, 400, "invalid_filter_target")
}

// A tab container's tabs are chart widgets of their own: their charts are the
// dashboard's, and each is filtered and queried by its id.
func TestDashboardTabs(t *testing.T) {
	f := newContentFixture(t)
	input := f.chart("按地区", `{"type":"bar","x":"region","y":["revenue"]}`)
	input["spec"].(map[string]any)["query"].(map[string]any)["dimensions"] = []any{map[string]any{"field": "region"}}
	first := f.developer.expect("POST", "/charts", input, 201, "")["id"].(string)
	second := f.developer.expect("POST", "/charts", f.chart("明细", `{"type":"table"}`), 201, "")["id"].(string)
	spec := map[string]any{"specVersion": 1, "layout": map[string]any{"columns": 12, "items": []any{
		map[string]any{"id": "wt", "type": "tabs", "x": 0, "y": 0, "w": 12, "h": 4, "frame": map[string]any{"border": false}, "defaultTab": "wb", "tabs": []any{
			map[string]any{"id": "wa", "chartId": first, "title": "地区", "note": "口径"},
			map[string]any{"id": "wb", "chartId": second},
			map[string]any{"id": "wc"},
		}},
	}}}
	spec["filters"] = []any{map[string]any{"id": "g", "label": "地区", "op": "in", "control": map[string]any{"type": "select"}, "targets": []any{map[string]any{"item": "wa", "field": "region"}}}}
	saved := f.developer.expect("POST", "/dashboards", map[string]any{"name": "分页", "spec": spec}, 201, "")
	id := saved["id"].(string)
	if charts := saved["charts"].([]any); len(charts) != 2 {
		t.Errorf("charts = %v", charts)
	}
	box := saved["spec"].(map[string]any)["layout"].(map[string]any)["items"].([]any)[0].(map[string]any)
	tabs := box["tabs"].([]any)
	if box["defaultTab"] != "wb" || len(tabs) != 3 || tabs[0].(map[string]any)["note"] != "口径" || tabs[2].(map[string]any)["chartId"] != nil {
		t.Errorf("tabs = %v", tabs)
	}
	f.share(t, id)
	data := f.viewer.expect("POST", "/dashboards/"+id+"/items/wa/data", map[string]any{"filters": map[string]any{"g": []any{"华东"}}}, 200, "")
	if rows := data["rows"].([]any); len(rows) != 1 {
		t.Errorf("rows of a filtered tab = %v", rows)
	}
	f.viewer.expect("POST", "/dashboards/"+id+"/items/wb/data", map[string]any{}, 200, "")
	// The global filter's options are drawn from the tab it targets.
	if options := f.viewer.expect("POST", "/dashboards/"+id+"/filters/g/options", map[string]any{}, 200, ""); len(options["values"].([]any)) != 2 {
		t.Errorf("options from a tab = %v", options)
	}
	// The container and an empty tab hold no chart.
	f.viewer.expect("POST", "/dashboards/"+id+"/items/wt/data", map[string]any{}, 404, "not_found")
	f.viewer.expect("POST", "/dashboards/"+id+"/items/wc/data", map[string]any{}, 404, "not_found")
	// A chart in a tab is in use.
	f.developer.expect("DELETE", "/charts/"+second, nil, 409, "in_use")
	one := map[string]any{"specVersion": 1, "layout": map[string]any{"columns": 12, "items": []any{
		map[string]any{"id": "wt", "type": "tabs", "x": 0, "y": 0, "w": 12, "h": 4, "tabs": []any{map[string]any{"id": "wa", "chartId": first}}},
	}}}
	f.developer.editing("PUT", "/dashboards/"+id, map[string]any{"name": "分页", "spec": one}, 400, "invalid_tabs")
}

func TestDashboardPages(t *testing.T) {
	f := newContentFixture(t)
	input := f.chart("按地区", `{"type":"bar","x":"region","y":["revenue"]}`)
	input["spec"].(map[string]any)["query"].(map[string]any)["dimensions"] = []any{map[string]any{"field": "region"}}
	first := f.developer.expect("POST", "/charts", input, 201, "")["id"].(string)
	second := f.developer.expect("POST", "/charts", f.chart("明细", `{"type":"table"}`), 201, "")["id"].(string)
	// Each page is a grid of its own, from the top; what is above the tabs names no page.
	spec := map[string]any{"specVersion": 1, "layout": map[string]any{"columns": 12,
		"pages": []any{map[string]any{"id": "p1", "name": "概览"}, map[string]any{"id": "p2", "name": "明细"}},
		"items": []any{
			map[string]any{"id": "wt", "type": "title", "x": 0, "y": 0, "w": 12, "h": 8, "useDashboardName": true},
			map[string]any{"id": "wa", "type": "chart", "chartId": first, "page": "p1", "x": 0, "y": 0, "w": 12, "h": 16},
			map[string]any{"id": "wb", "type": "chart", "chartId": second, "page": "p2", "x": 0, "y": 0, "w": 12, "h": 16},
		}}}
	spec["filters"] = []any{map[string]any{"id": "g", "label": "地区", "op": "in", "control": map[string]any{"type": "select"}, "targets": []any{map[string]any{"item": "wa", "field": "region"}, map[string]any{"item": "wb", "field": "region"}}}}
	saved := f.developer.expect("POST", "/dashboards", map[string]any{"name": "分页", "spec": spec}, 201, "")
	id := saved["id"].(string)
	layout := saved["spec"].(map[string]any)["layout"].(map[string]any)
	if pages := layout["pages"].([]any); len(pages) != 2 || pages[1].(map[string]any)["name"] != "明细" {
		t.Errorf("pages = %v", pages)
	}
	if items := layout["items"].([]any); items[0].(map[string]any)["page"] != nil || items[2].(map[string]any)["page"] != "p2" {
		t.Errorf("items = %v", items)
	}
	if charts := saved["charts"].([]any); len(charts) != 2 {
		t.Errorf("charts = %v", charts)
	}
	f.share(t, id)
	// A chart on another page is asked for as any other, and the filter reaches it there.
	data := f.viewer.expect("POST", "/dashboards/"+id+"/items/wb/data", map[string]any{"filters": map[string]any{"g": []any{"华东"}}}, 200, "")
	if rows := data["rows"].([]any); len(rows) == 0 {
		t.Errorf("rows on the second page = %v", rows)
	}
	f.developer.expect("DELETE", "/charts/"+second, nil, 409, "in_use")
	spec["layout"].(map[string]any)["items"].([]any)[2].(map[string]any)["page"] = "p3"
	f.developer.editing("PUT", "/dashboards/"+id, map[string]any{"name": "分页", "spec": spec}, 400, "invalid_item_page")
}

func TestDashboardFilters(t *testing.T) {
	f := newContentFixture(t)
	input := func(name, query, viz, filters string) map[string]any {
		var spec map[string]any
		raw := `{"specVersion":1,"query":` + strings.ReplaceAll(query, "$DS", f.datasetID) + `,"viz":` + viz + `,"filters":` + filters + `}`
		if err := json.Unmarshal([]byte(raw), &spec); err != nil {
			t.Fatal(err)
		}
		return map[string]any{"name": name, "spec": spec}
	}
	chart := func(name, query, viz, filters string) string {
		return f.developer.expect("POST", "/charts", input(name, query, viz, filters), 201, "")["id"].(string)
	}
	const (
		when   = `{"id":"when","field":"order_date","op":"time","label":"下单日期","control":{"type":"relative"},"exposed":true}`
		region = `{"id":"region","field":"region","op":"in","label":"地区","control":{"type":"select","multi":true},"exposed":true}`
		// The same field under another name, as a chart by someone else would have it.
		area = `{"id":"area","field":"region","op":"in","value":["华南"],"label":"区域","control":{"type":"search_select","multi":true},"exposed":true}`
		// Interactive, without the deprecated exposed flag.
		atLeast = `{"id":"amount","field":"amount","op":"between","label":"金额","control":{"type":"number_range"}}`
		// Fixed: the figure always means this year.
		thisYear = `{"id":"this_year","field":"order_date","op":"time","value":{"current":"year"}}`
	)
	const regionQuery, regionViz = `{"version":1,"dataset":"$DS","dimensions":[{"field":"region"}],"measures":[{"field":"revenue","agg":"sum"}]}`, `{"type":"bar","x":"region","y":["revenue"]}`
	byRegion := chart("按地区", regionQuery, regionViz, `[`+when+`,`+region+`,`+atLeast+`]`)
	byMonth := chart("按月", `{"version":1,"dataset":"$DS","dimensions":[{"field":"order_date","grain":"month","alias":"month"}],"measures":[{"field":"revenue","agg":"sum"}],"filter":{"op":"or","args":[{"field":"amount","op":"gt","value":150},{"field":"amount","op":"lt","value":0}]}}`,
		`{"type":"line","x":"month","y":["revenue"]}`, `[`+when+`,`+area+`]`)
	total := chart("全年累计", `{"version":1,"dataset":"$DS","measures":[{"field":"revenue","agg":"sum"}]}`, `{"type":"kpi","y":["revenue"]}`, `[`+thisYear+`,`+region+`]`)

	target := func(item, filter string) map[string]any { return map[string]any{"item": item, "filter": filter} }
	spec := dashboardSpec(byRegion, byMonth, total)
	spec["filters"] = []any{
		map[string]any{"id": "g_when", "label": "时间", "control": map[string]any{"type": "relative"}, "default": map[string]any{"last": map[string]any{"n": 1, "unit": "month"}},
			"targets": []any{target("wa", "when"), target("wb", "when")}},
		// One filter over what two charts call differently.
		map[string]any{"id": "g_region", "label": "地区", "control": map[string]any{"type": "select", "multi": true}, "default": []any{"华东"},
			"targets": []any{target("wa", "region"), target("wb", "area"), target("wc", "region")}},
	}

	// Legacy bindings are upgraded without requiring an exposed flag.
	bad := dashboardSpec(byRegion, total)
	global := func(control string, targets ...any) {
		bad["filters"] = []any{map[string]any{"id": "g", "label": "x", "control": map[string]any{"type": control}, "targets": targets}}
	}
	global("number_range", target("wa", "amount"))
	f.developer.expect("POST", "/dashboards", map[string]any{"name": "unexposed", "spec": bad}, 201, "")
	global("relative", target("wb", "this_year"))
	f.developer.expect("POST", "/dashboards", map[string]any{"name": "fixed", "spec": bad}, 201, "")
	global("select", target("wa", "nope"))
	f.developer.expect("POST", "/dashboards", map[string]any{"name": "d", "spec": bad}, 400, "invalid_filter_target")
	global("select", target("wz", "region"))
	f.developer.expect("POST", "/dashboards", map[string]any{"name": "d", "spec": bad}, 400, "invalid_filter_target")
	global("select", target("wa", "region"), target("wa", "when"))
	f.developer.expect("POST", "/dashboards", map[string]any{"name": "d", "spec": bad}, 400, "filter_targets_differ")
	global("relative", target("wa", "region"))
	f.developer.expect("POST", "/dashboards", map[string]any{"name": "d", "spec": bad}, 400, "invalid_filter_control")

	id := f.developer.expect("POST", "/dashboards", map[string]any{"name": "经营", "spec": spec}, 201, "")["id"].(string)
	// Fixture: (1) 01-10 100.50 华东, (2) 02-10 200.00 华东, (3) 02-20 300.25 华南. The clock is pinned to 10 March.
	f.share(t, id)
	data := func(c *client, item string, body any) string {
		t.Helper()
		result := c.expect("POST", "/dashboards/"+id+"/items/"+item+"/data", body, 200, "")
		encoded, _ := json.Marshal(result["rows"])
		return string(encoded)
	}
	check := func(name, got, want string) {
		t.Helper()
		if got != want {
			t.Errorf("%s: got %s, want %s", name, got, want)
		}
	}
	filters := func(pairs ...any) map[string]any {
		out := map[string]any{}
		for i := 0; i < len(pairs); i += 2 {
			out[pairs[i].(string)] = pairs[i+1]
		}
		return map[string]any{"filters": out}
	}
	allTime, everywhere := map[string]any{}, []any{}

	// With nothing sent: the global filters' defaults, February and 华东.
	check("defaults", data(f.viewer, "wa", nil), `[["华东","200.00"]]`)
	// An empty value lifts the filter.
	check("filter cleared", data(f.viewer, "wa", filters("g_region", everywhere)), `[["华东","200.00"],["华南","300.25"]]`)
	check("all time", data(f.viewer, "wa", filters("g_when", allTime, "g_region", everywhere)), `[["华东","300.50"],["华南","300.25"]]`)
	check("chosen values", data(f.viewer, "wa", filters("g_when", allTime, "g_region", []any{"华南", "华北"})), `[["华南","300.25"]]`)
	// The global value replaces the value of the chart's filter (华南), and is
	// ANDed with the query's own filter as a whole: the OR inside it gains nothing.
	check("replaces the chart's value", data(f.viewer, "wb", filters("g_when", allTime)), `[["2026-02-01","200.00"]]`)
	// Unselected charts keep their own time period.
	check("fixed range", data(f.viewer, "wc", filters("g_when", map[string]any{"current": "month"})), `[["300.50"]]`)
	check("fixed range, filter cleared", data(f.viewer, "wc", filters("g_region", everywhere)), `[["600.75"]]`)

	// A widget's own interactive filter, which no global filter took over, is the viewer's to set there.
	own := filters("g_when", allTime, "g_region", everywhere)
	own["chartFilters"] = map[string]any{"amount": []any{250, nil}}
	check("the widget's own filter", data(f.viewer, "wa", own), `[["华南","300.25"]]`)
	// Taken-over choices are retained by the browser but ignored until restored.
	own["chartFilters"] = map[string]any{"region": []any{"华南"}}
	check("taken over choice ignored", data(f.viewer, "wa", own), `[["华东","300.50"],["华南","300.25"]]`)
	own["useChartFilters"] = true
	check("chart choice restored", data(f.viewer, "wa", own), `[["华南","300.25"]]`)
	own["useChartFilters"] = false
	check("global restored", data(f.viewer, "wa", own), `[["华东","300.50"],["华南","300.25"]]`)
	own["chartFilters"] = map[string]any{"nope": []any{"华南"}}
	f.viewer.expect("POST", "/dashboards/"+id+"/items/wa/data", own, 400, "filter_not_interactive")
	own["chartFilters"] = map[string]any{"this_year": map[string]any{"current": "month"}}
	f.viewer.expect("POST", "/dashboards/"+id+"/items/wc/data", own, 400, "filter_not_interactive")

	// Values are only ever values.
	f.viewer.expect("POST", "/dashboards/"+id+"/items/wa/data", filters("g_region", []any{7}), 400, "invalid_filter_value")
	f.viewer.expect("POST", "/dashboards/"+id+"/items/wa/data", filters("g_when", map[string]any{"dimension": "order_date", "current": "year"}), 400, "invalid_time_range")
	check("hostile value", data(f.viewer, "wa", filters("g_region", []any{"x' OR '1'='1"})), `[]`)
	// A filter the dashboard does not define cannot name a field.
	f.viewer.expect("POST", "/dashboards/"+id+"/items/wa/data", filters("amount", []any{1}), 400, "unknown_filter")
	f.viewer.expect("POST", "/dashboards/"+id+"/items/nope/data", nil, 404, "not_found")
	f.viewer.expect("POST", "/dashboards/db_nope/items/wa/data", nil, 404, "not_found")

	values := func(path string) string {
		t.Helper()
		options := f.viewer.expect("GET", path, nil, 200, "")
		encoded, _ := json.Marshal(options["values"])
		if options["truncated"] != false {
			t.Errorf("%s: truncated = %v", path, options["truncated"])
		}
		return string(encoded)
	}
	check("options", values("/dashboards/"+id+"/filters/g_region/options"), `["华东","华南"]`)
	check("options searched", values("/dashboards/"+id+"/filters/g_region/options?search=%E5%8D%97"), `["华南"]`)
	check("a chart's options", values("/charts/"+byMonth+"/filters/area/options"), `["华东","华南"]`)
	f.viewer.expect("GET", "/dashboards/"+id+"/filters/nope/options", nil, 404, "not_found")
	f.viewer.expect("GET", "/charts/"+total+"/filters/nope/options", nil, 404, "not_found")
	// A fixed condition offers nothing to choose from.
	f.viewer.expect("GET", "/charts/"+total+"/filters/this_year/options", nil, 404, "not_found")

	// Global bindings survive local controls being removed, renamed or changed.
	f.developer.editing("PUT", "/charts/"+byRegion, input("按地区", regionQuery, regionViz, `[`+when+`,`+atLeast+`]`), 200, "")
	check("binding survives deleted control", data(f.viewer, "wa", nil), `[["华东","200.00"]]`)
	f.developer.editing("PUT", "/charts/"+byRegion, input("按地区", regionQuery, regionViz, `[`+when+`,`+strings.Replace(region, `,"exposed":true`, "", 1)+`]`), 200, "")
	f.developer.editing("PUT", "/charts/"+byRegion, input("按地区", regionQuery, regionViz, `[`+strings.Replace(when, `"id":"when"`, `"id":"region"`, 1)+`,`+when+`]`), 200, "")
	f.developer.editing("PUT", "/charts/"+byRegion, input("按地区", regionQuery, regionViz, `[`+when+`,`+region+`]`), 200, "")
}

func TestDashboardDirectFieldFilters(t *testing.T) {
	f := newContentFixture(t)
	first := f.chart("first", `{"type":"table"}`)
	first["spec"].(map[string]any)["filters"] = []any{
		map[string]any{"id": "amount", "field": "amount", "op": "lte", "value": 150, "label": "金额", "control": map[string]any{"type": "number"}},
		map[string]any{"id": "date", "field": "order_date", "op": "time", "value": map[string]any{"start": "2026-01-01", "end": "2026-02-01"}, "label": "日期", "control": map[string]any{"type": "date_range"}},
	}
	chartID := f.developer.expect("POST", "/charts", first, 201, "")["id"].(string)
	// Another dataset uses a different internal key for the same business field.
	ds := f.admin.expect("GET", "/datasets/"+f.datasetID, nil, 200, "")
	otherSpec := f.admin.spec(func(spec map[string]any) {
		for _, value := range spec["fields"].([]any) {
			field := value.(map[string]any)
			if field["key"] == "region" {
				field["key"] = "area"
			}
		}
	})
	otherDS := f.admin.expect("POST", "/datasets", map[string]any{"name": "second dataset", "datasourceId": ds["datasourceId"], "spec": otherSpec}, 201, "")["id"].(string)
	second := f.chart("second", `{"type":"table"}`)
	secondQuery := second["spec"].(map[string]any)["query"].(map[string]any)
	secondQuery["dataset"] = otherDS
	secondQuery["dimensions"] = []any{map[string]any{"field": "order_date", "grain": "month", "alias": "month"}, map[string]any{"field": "area"}}
	otherChart := f.developer.expect("POST", "/charts", second, 201, "")["id"].(string)
	spec := dashboardSpec(chartID, otherChart, chartID)
	target := func(item, field string) any { return map[string]any{"item": item, "field": field} }
	spec["filters"] = []any{
		map[string]any{"id": "amount", "label": "金额", "op": "gte", "control": map[string]any{"type": "number"}, "default": 200, "targets": []any{target("wa", "amount"), target("wb", "amount")}},
		map[string]any{"id": "date", "label": "日期", "op": "time", "control": map[string]any{"type": "date"}, "default": map[string]any{"start": "2026-02-20", "end": "2026-02-21"}, "targets": []any{target("wa", "order_date"), target("wb", "order_date")}},
		map[string]any{"id": "area", "label": "地区", "op": "in", "control": map[string]any{"type": "select", "multi": true}, "targets": []any{target("wa", "region"), target("wb", "area")}, "optionsFrom": "wb"},
	}
	id := f.developer.expect("POST", "/dashboards", map[string]any{"name": "direct", "spec": spec}, 201, "")["id"].(string)
	f.share(t, id)
	rows := func(item string, body any) string {
		t.Helper()
		result := f.viewer.expect("POST", "/dashboards/"+id+"/items/"+item+"/data", body, 200, "")
		b, _ := json.Marshal(result["rows"])
		return string(b)
	}
	for _, item := range []string{"wa", "wb"} {
		if got := rows(item, nil); got != `[["2026-02-01","华南","300.25"]]` {
			t.Errorf("%s: global condition did not replace local operation: %s", item, got)
		}
	}
	for _, item := range []string{"wa", "wc"} {
		if got := rows(item, map[string]any{"useChartFilters": true}); got != `[["2026-01-01","华东","100.50"]]` {
			t.Errorf("%s: chart conditions not restored: %s", item, got)
		}
	}
	if got := rows("wc", nil); got != `[["2026-01-01","华东","100.50"]]` {
		t.Errorf("unselected widget changed: %s", got)
	}
	if got := rows("wa", map[string]any{"filters": map[string]any{"amount": nil, "date": nil}}); got != `[["2026-01-01","华东","100.50"],["2026-02-01","华东","200.00"],["2026-02-01","华南","300.25"]]` {
		t.Errorf("empty globals should lift their local conditions too: %s", got)
	}
	options := f.viewer.expect("GET", "/dashboards/"+id+"/filters/area/options", nil, 200, "")
	if b, _ := json.Marshal(options["values"]); string(b) != `["华东","华南"]` {
		t.Errorf("mapped dataset options = %s", b)
	}
	// Invalid saved defaults fail immediately, rather than breaking viewers later.
	amount := spec["filters"].([]any)[0].(map[string]any)
	amount["default"] = "not a number"
	f.developer.editing("PUT", "/dashboards/"+id, map[string]any{"name": "direct", "spec": spec}, 400, "invalid_filter_value")
	amount["default"] = 200
	amount["targets"] = []any{target("wa", "missing")}
	f.developer.editing("PUT", "/dashboards/"+id, map[string]any{"name": "direct", "spec": spec}, 400, "unknown_field")
}

func TestDashboardAggregateFilters(t *testing.T) {
	f := newContentFixture(t)
	ds := f.admin.expect("GET", "/datasets/"+f.datasetID, nil, 200, "")
	dsSpec := f.admin.spec(func(spec map[string]any) {
		spec["fields"] = append(spec["fields"].([]any),
			map[string]any{"key": "total", "label": "总额", "expr": "SUM(${amount})", "type": "decimal", "role": "metric"},
			map[string]any{"key": "orders", "label": "订单数", "expr": "COUNT(${amount})", "type": "integer", "role": "metric"})
	})
	f.admin.editing("PUT", "/datasets/"+f.datasetID, map[string]any{"name": "订单", "datasourceId": ds["datasourceId"], "spec": dsSpec}, 200, "")
	chart := f.chart("aggregate", `{"type":"table"}`)
	q := chart["spec"].(map[string]any)["query"].(map[string]any)
	q["dimensions"] = []any{map[string]any{"field": "region"}}
	q["measures"] = []any{map[string]any{"field": "revenue", "agg": "sum", "alias": "sales"}, map[string]any{"alias": "count", "field": "amount", "agg": "count"}}
	chartID := f.developer.expect("POST", "/charts", chart, 201, "")["id"].(string)
	target := map[string]any{"item": "wa", "field": "total"}
	global := map[string]any{"id": "g", "label": "指标筛选", "op": "gte", "control": map[string]any{"type": "number"}, "default": 300.4, "targets": []any{target}}
	spec := dashboardSpec(chartID)
	spec["filters"] = []any{global}
	id := f.developer.expect("POST", "/dashboards", map[string]any{"name": "aggregates", "spec": spec}, 201, "")["id"].(string)
	f.share(t, id)
	check := func(want string) {
		t.Helper()
		result := f.viewer.expect("POST", "/dashboards/"+id+"/items/wa/data", nil, 200, "")
		got, _ := json.Marshal(result["rows"])
		if string(got) != want || len(result["columns"].([]any)) != 3 {
			t.Errorf("rows = %s, columns = %v; want %s with original 3 columns", got, result["columns"], want)
		}
	}
	check(`[["华东","300.50",2]]`)
	f.viewer.expect("GET", "/dashboards/"+id+"/filters/g/options", nil, 400, "invalid_filter_options")
	for _, candidate := range []struct {
		key, value string
		threshold  any
		want       string
	}{
		{"measure", "sales", 300.4, `[["华东","300.50",2]]`},
		{"measure", "count", 2, `[["华东","300.50",2]]`},
		{"field", "orders", 2, `[["华东","300.50",2]]`},
		// Dataset measures refer to row values; the chart's sales refers to SUM.
		{"field", "revenue", 300.4, `[]`},
	} {
		delete(target, "measure")
		delete(target, "field")
		target[candidate.key] = candidate.value
		global["default"] = candidate.threshold
		f.developer.editing("PUT", "/dashboards/"+id, map[string]any{"name": "aggregates", "spec": spec}, 200, "")
		check(candidate.want)
	}
	// A configured aggregate becomes an explicit field/aggregation binding,
	// which can remain as a HAVING-only measure after its output is removed.
	delete(target, "field")
	target["measure"] = "count"
	global["default"] = 2
	f.developer.editing("PUT", "/dashboards/"+id, map[string]any{"name": "aggregates", "spec": spec}, 200, "")
	q["measures"] = []any{map[string]any{"field": "revenue", "agg": "sum", "alias": "sales"}}
	f.developer.editing("PUT", "/charts/"+chartID, chart, 200, "")
	removed := f.viewer.expect("POST", "/dashboards/"+id+"/items/wa/data", nil, 200, "")
	if got := encoded(t, removed["rows"]); got != `[["华东","300.50"]]` || len(removed["columns"].([]any)) != 2 {
		t.Fatalf("retained HAVING-only aggregate: %s, columns=%v", got, removed["columns"])
	}
	// A displayed dataset metric canonicalizes to that metric's field. It
	// overrides the metric's local filter and survives removal from display.
	count := map[string]any{"field": "amount", "agg": "count", "alias": "count"}
	q["measures"] = []any{map[string]any{"field": "total", "alias": "metric_sales"}, count}
	chart["spec"].(map[string]any)["filters"] = []any{map[string]any{"id": "local_total", "field": "total", "op": "lte", "value": 300.3, "label": "本地总额", "control": map[string]any{"type": "number"}}}
	f.developer.editing("PUT", "/charts/"+chartID, chart, 200, "")
	target["measure"] = "metric_sales"
	global["default"] = 300.4
	updated := f.developer.editing("PUT", "/dashboards/"+id, map[string]any{"name": "aggregates", "spec": spec}, 200, "")
	storedTarget := updated["spec"].(map[string]any)["filters"].([]any)[0].(map[string]any)["targets"].([]any)[0].(map[string]any)
	if storedTarget["field"] != "total" || storedTarget["measure"] != nil {
		t.Fatalf("dataset metric alias not normalized: %v", storedTarget)
	}
	check(`[["华东","300.50",2]]`)
	restored := f.viewer.expect("POST", "/dashboards/"+id+"/items/wa/data", map[string]any{"useChartFilters": true}, 200, "")
	if b, _ := json.Marshal(restored["rows"]); string(b) != `[["华南","300.25",1]]` {
		t.Errorf("metric's local filter not restored: %s", b)
	}
	q["measures"] = []any{map[string]any{"field": "revenue", "agg": "sum", "alias": "sales"}, count}
	f.developer.editing("PUT", "/charts/"+chartID, chart, 200, "")
	check(`[["华东","300.50",2]]`)
}

func TestDashboardNonNumericAggregateFilters(t *testing.T) {
	f := newContentFixture(t)
	ds := f.admin.expect("GET", "/datasets/"+f.datasetID, nil, 200, "")
	dsSpec := f.admin.spec(func(spec map[string]any) {
		spec["fields"] = append(spec["fields"].([]any),
			map[string]any{"key": "last_order", "label": "最近下单", "expr": "MAX(${order_date})", "type": "date", "role": "metric"},
			map[string]any{"key": "last_region", "label": "最后地区", "expr": "MAX(${region})", "type": "string", "role": "metric"},
			map[string]any{"key": "all_large", "label": "均为大额", "expr": "BOOL_AND(${amount} > 150)", "type": "boolean", "role": "metric"})
	})
	f.admin.editing("PUT", "/datasets/"+f.datasetID, map[string]any{"name": "订单", "datasourceId": ds["datasourceId"], "spec": dsSpec}, 200, "")
	chart := f.chart("typed aggregates", `{"type":"table"}`)
	q := chart["spec"].(map[string]any)["query"].(map[string]any)
	q["dimensions"] = []any{map[string]any{"field": "region"}}
	q["measures"] = []any{map[string]any{"field": "revenue", "agg": "sum"}, map[string]any{"alias": "latest", "field": "order_date", "agg": "max"}}
	chartID := f.developer.expect("POST", "/charts", chart, 201, "")["id"].(string)
	for _, tt := range []struct {
		name, kind, key, op, control string
		value                        any
	}{
		{"dataset date", "field", "last_order", "time", "date", map[string]any{"start": "2026-02-20", "end": "2026-02-21"}},
		{"dataset text", "field", "last_region", "eq", "text", "华南"},
		{"dataset boolean", "field", "all_large", "in", "select", []any{true}},
		{"chart date", "measure", "latest", "time", "date_range", map[string]any{"start": "2026-02-20", "end": "2026-02-21"}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			spec := dashboardSpec(chartID)
			spec["filters"] = []any{map[string]any{"id": "g", "label": "聚合筛选", "op": tt.op, "control": map[string]any{"type": tt.control}, "default": tt.value, "targets": []any{map[string]any{"item": "wa", tt.kind: tt.key}}}}
			id := f.developer.expect("POST", "/dashboards", map[string]any{"name": tt.name, "spec": spec}, 201, "")["id"].(string)
			f.share(t, id)
			result := f.viewer.expect("POST", "/dashboards/"+id+"/items/wa/data", nil, 200, "")
			if rows, _ := json.Marshal(result["rows"]); string(rows) != `[["华南","300.25","2026-02-20"]]` || len(result["columns"].([]any)) != 3 {
				t.Errorf("non-numeric aggregate filter result = %s, columns = %v", rows, result["columns"])
			}
			if tt.key == "all_large" {
				options := f.viewer.expect("GET", "/dashboards/"+id+"/filters/g/options", nil, 200, "")
				if values, _ := json.Marshal(options["values"]); string(values) != `[false,true]` {
					t.Errorf("boolean options = %s", values)
				}
			}
		})
	}
}

func TestDashboardLegacyMultipleConditions(t *testing.T) {
	f := newContentFixture(t)
	chart := f.chart("legacy multiple", `{"type":"table"}`)
	chart["spec"].(map[string]any)["filters"] = []any{
		map[string]any{"id": "low", "field": "amount", "op": "gte", "value": 100},
		map[string]any{"id": "high", "field": "amount", "op": "lte", "value": 150},
		map[string]any{"id": "another", "field": "revenue", "op": "gte", "value": 1},
	}
	chartID := f.developer.expect("POST", "/charts", chart, 201, "")["id"].(string)
	spec := dashboardSpec(chartID)
	target := func(filter string) any { return map[string]any{"item": "wa", "filter": filter} }
	spec["filters"] = []any{
		map[string]any{"id": "g_low", "label": "下限", "control": map[string]any{"type": "number"}, "default": 100, "targets": []any{target("low")}},
		map[string]any{"id": "g_high", "label": "上限", "control": map[string]any{"type": "number"}, "default": 250, "targets": []any{target("high")}},
		map[string]any{"id": "g_pair", "label": "两个字段", "control": map[string]any{"type": "number"}, "default": 200, "targets": []any{target("low"), target("another")}},
	}
	created := f.developer.expect("POST", "/dashboards", map[string]any{"name": "multiple", "spec": spec}, 201, "")
	id := created["id"].(string)
	f.developer.editing("PUT", "/dashboards/"+id, map[string]any{"name": "multiple", "spec": created["spec"]}, 200, "")
	f.share(t, id)
	result := f.viewer.expect("POST", "/dashboards/"+id+"/items/wa/data", nil, 200, "")
	if rows, _ := json.Marshal(result["rows"]); string(rows) != `[["2026-02-01","华东","200.00"]]` {
		t.Errorf("multiple conditions did not all survive: %s", rows)
	}
	chart["spec"].(map[string]any)["filters"] = []any{}
	f.developer.editing("PUT", "/charts/"+chartID, chart, 200, "")
	result = f.viewer.expect("POST", "/dashboards/"+id+"/items/wa/data", nil, 200, "")
	if rows, _ := json.Marshal(result["rows"]); string(rows) != `[["2026-02-01","华东","200.00"]]` {
		t.Errorf("deleting local controls changed global conditions: %s", rows)
	}
}

// A binding that can no longer be resolved breaks only the widgets relying on
// it: the dashboard still opens to be repaired, and its charts can be edited.
func TestDashboardBrokenBinding(t *testing.T) {
	f := newContentFixture(t)
	chart := f.chart("bound", `{"type":"table"}`)
	chartID := f.developer.expect("POST", "/charts", chart, 201, "")["id"].(string)
	spec := dashboardSpec(chartID, chartID)
	spec["filters"] = []any{map[string]any{"id": "g", "label": "地区", "op": "in", "control": map[string]any{"type": "select"},
		"targets": []any{map[string]any{"item": "wa", "field": "region"}}}}
	id := f.developer.expect("POST", "/dashboards", map[string]any{"name": "broken", "spec": spec}, 201, "")["id"].(string)
	// As the migration leaves a binding whose chart filter was already gone.
	if _, err := f.admin.db.Pool.Exec(context.Background(), `UPDATE dashboards SET spec = jsonb_set(spec, '{filters,0,targets,0}', '{"item":"wa","filter":"removed"}') WHERE id = $1`, id); err != nil {
		t.Fatal(err)
	}
	f.share(t, id)
	f.viewer.expect("GET", "/dashboards/"+id, nil, 200, "")
	f.viewer.expect("POST", "/dashboards/"+id+"/items/wa/data", nil, 400, "invalid_filter_target")
	f.viewer.expect("POST", "/dashboards/"+id+"/items/wb/data", nil, 200, "")
	// The dashboard was broken before; changing its chart is not what broke it.
	chart["name"] = "renamed"
	f.developer.editing("PUT", "/charts/"+chartID, chart, 200, "")
}
