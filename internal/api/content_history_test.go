package api

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
)

// Every save of a chart or dashboard is listed with who made it and when,
// renames included. The definitions are stored but not served.
func TestChartAndDashboardRevisions(t *testing.T) {
	f := newContentFixture(t)
	ctx := context.Background()
	chart := f.chart("甲", `{"type":"table"}`)
	chartID := f.developer.expect("POST", "/charts", chart, 201, "")["id"].(string)
	board := map[string]any{"name": "看板", "spec": dashboardSpec(chartID)}
	boardID := f.developer.expect("POST", "/dashboards", board, 201, "")["id"].(string)

	chart["name"], chart["expectedRevision"] = "甲（改名）", 1
	f.admin.expect("PUT", "/charts/"+chartID, chart, 200, "")
	chart["expectedRevision"] = 1
	f.developer.expect("PUT", "/charts/"+chartID, chart, 409, "resource_revision_conflict")
	chart["description"], chart["expectedRevision"] = "改了描述", 2
	f.developer.expect("PUT", "/charts/"+chartID, chart, 200, "")
	board["description"], board["expectedRevision"] = "改了描述", 1
	f.developer.expect("PUT", "/dashboards/"+boardID, board, 200, "")

	type entry struct {
		Revision      int
		Name          string
		CreatedByName string
		Spec          any
	}
	list := func(path string) ([]entry, any) {
		t.Helper()
		page := f.developer.expect("GET", path, nil, 200, "")
		raw, _ := json.Marshal(page["items"])
		var items []entry
		if err := json.Unmarshal(raw, &items); err != nil {
			t.Fatal(err)
		}
		return items, page["nextBefore"]
	}
	items, next := list("/charts/" + chartID + "/revisions")
	want := []entry{{3, "甲（改名）", "developer", nil}, {2, "甲（改名）", "Admin", nil}, {1, "甲", "developer", nil}}
	if !reflect.DeepEqual(items, want) || next != nil {
		t.Fatalf("chart revisions = %+v, next %v; want %+v", items, next, want)
	}
	items, next = list("/charts/" + chartID + "/revisions?limit=2")
	if len(items) != 2 || items[1].Revision != 2 || next != float64(2) {
		t.Fatalf("first page = %+v, next %v", items, next)
	}
	items, next = list("/charts/" + chartID + "/revisions?limit=2&before=2")
	if len(items) != 1 || items[0].Revision != 1 || next != nil {
		t.Fatalf("last page = %+v, next %v", items, next)
	}
	items, _ = list("/dashboards/" + boardID + "/revisions")
	if want := []entry{{2, "看板", "developer", nil}, {1, "看板", "developer", nil}}; !reflect.DeepEqual(items, want) {
		t.Fatalf("dashboard revisions = %+v, want %+v", items, want)
	}

	// What was saved is kept, with the dataset revision a chart was checked against.
	var description string
	var datasetRevision int
	if err := f.admin.api.Pool.QueryRow(ctx, `SELECT description, dataset_revision FROM chart_revisions WHERE chart_id = $1 AND revision = 3`, chartID).Scan(&description, &datasetRevision); err != nil {
		t.Fatal(err)
	}
	if description != "改了描述" || datasetRevision != 1 {
		t.Fatalf("stored chart revision: description %q, dataset revision %d", description, datasetRevision)
	}

	for _, path := range []string{"/charts/" + chartID + "/revisions", "/dashboards/" + boardID + "/revisions"} {
		f.viewer.expect("GET", path, nil, 403, "forbidden")
		f.admin.anonymous().expect("GET", path, nil, 401, "unauthenticated")
		for _, query := range []string{"?limit=0", "?limit=101", "?before=0"} {
			f.admin.expect("GET", path+query, nil, 400, "invalid_request")
		}
	}
	f.admin.expect("GET", "/charts/missing/revisions", nil, 404, "not_found")
	f.admin.expect("GET", "/dashboards/missing/revisions", nil, 404, "not_found")

	// Revisions go with what they record.
	f.developer.expect("DELETE", "/dashboards/"+boardID, nil, 204, "")
	f.developer.expect("DELETE", "/charts/"+chartID, nil, 204, "")
	var left int
	if err := f.admin.api.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM chart_revisions) + (SELECT count(*) FROM dashboard_revisions)`).Scan(&left); err != nil || left != 0 {
		t.Fatalf("revisions left after deleting: %d, %v", left, err)
	}
}

// Another workspace sees no history of a chart or dashboard it cannot see.
func TestContentRevisionsStayInTheirWorkspace(t *testing.T) {
	f := newContentFixture(t)
	chartID := f.admin.expect("POST", "/charts", f.chart("甲", `{"type":"table"}`), 201, "")["id"].(string)
	boardID := f.admin.expect("POST", "/dashboards", map[string]any{"name": "看板", "spec": dashboardSpec(chartID)}, 201, "")["id"].(string)
	workspace := f.admin.expect("POST", "/workspaces", map[string]any{"name": "Other"}, 201, "")
	f.admin.expect("POST", "/auth/workspace", map[string]any{"workspaceId": workspace["id"]}, 200, "")
	f.admin.expect("GET", "/charts/"+chartID+"/revisions", nil, 404, "not_found")
	f.admin.expect("GET", "/dashboards/"+boardID+"/revisions", nil, 404, "not_found")
}
