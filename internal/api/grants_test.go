package api

import "testing"

func TestDashboardGrants(t *testing.T) {
	f := newContentFixture(t)
	shown := f.developer.expect("POST", "/charts", f.chart("shown", `{"type":"table"}`), 201, "")["id"].(string)
	elsewhere := f.developer.expect("POST", "/charts", f.chart("elsewhere", `{"type":"table"}`), 201, "")["id"].(string)
	board := f.developer.expect("POST", "/dashboards", map[string]any{"name": "board", "spec": dashboardSpec(shown)}, 201, "")["id"].(string)
	other := f.developer.expect("POST", "/dashboards", map[string]any{"name": "other", "spec": dashboardSpec(elsewhere)}, 201, "")["id"].(string)
	grants := "/dashboards/" + board + "/grants"
	count := func(c *client, path string) int {
		t.Helper()
		_, list := c.do("GET", path, nil)
		return len(list.([]any))
	}
	sees := func(want bool) {
		t.Helper()
		status, code := 404, "not_found"
		if want {
			status, code = 200, ""
		}
		f.viewer.expect("GET", "/dashboards/"+board, nil, status, code)
		f.viewer.expect("POST", "/dashboards/"+board+"/items/wa/data", nil, status, code)
		f.viewer.expect("POST", "/charts/"+shown+"/data", nil, status, code)
	}

	// A new dashboard is seen by no viewer; developers see every dashboard.
	if count(f.viewer, "/dashboards") != 0 || count(f.viewer, "/charts") != 0 {
		t.Error("a viewer sees dashboards or charts nobody granted them")
	}
	sees(false)
	if count(f.developer, "/dashboards") != 2 {
		t.Error("a developer does not see every dashboard")
	}
	if got := f.developer.expect("GET", grants, nil, 200, "")["subjects"].([]any); len(got) != 0 {
		t.Errorf("grants of a new dashboard = %v", got)
	}

	// Developers and admins grant access to existing subjects; viewers cannot.
	viewerID := userID(t, f.admin, "viewer@example.com")
	f.viewer.expect("PUT", grants, map[string]any{"subjects": []any{map[string]any{"user": viewerID}}}, 403, "forbidden")
	f.viewer.expect("GET", grants, nil, 403, "forbidden")
	f.admin.expect("PUT", grants, map[string]any{"subjects": []any{map[string]any{}}}, 400, "invalid_subject")
	f.admin.expect("PUT", grants, map[string]any{"subjects": []any{map[string]any{"user": viewerID, "everyone": true}}}, 400, "invalid_subject")
	f.admin.expect("PUT", grants, map[string]any{"subjects": []any{map[string]any{"user": "user_nope"}}}, 400, "unknown_user")
	f.admin.expect("PUT", grants, map[string]any{"subjects": []any{map[string]any{"group": "grp_nope"}}}, 400, "unknown_group")
	f.admin.expect("PUT", "/dashboards/db_nope/grants", map[string]any{"subjects": []any{}}, 404, "not_found")

	// Granted to the viewer: they see the dashboard and its charts, and nothing else.
	f.developer.expect("PUT", grants, map[string]any{"subjects": []any{map[string]any{"user": viewerID}, map[string]any{"user": viewerID}}}, 200, "")
	if got := f.developer.expect("GET", grants, nil, 200, "")["subjects"].([]any); len(got) != 1 || got[0].(map[string]any)["user"] != viewerID {
		t.Errorf("grants = %v", got)
	}
	sees(true)
	if count(f.viewer, "/dashboards") != 1 || count(f.viewer, "/charts") != 1 {
		t.Error("a viewer sees more than the dashboard granted to them")
	}
	f.viewer.expect("GET", "/dashboards/"+other, nil, 404, "not_found")
	f.viewer.expect("POST", "/charts/"+elsewhere+"/data", nil, 404, "not_found")
	f.viewer.expect("GET", "/charts/"+elsewhere, nil, 404, "not_found")

	// Through a group; and the grant goes when the group does.
	group := f.admin.expect("POST", "/groups", map[string]any{"name": "销售", "userIds": []string{viewerID}}, 201, "")["id"].(string)
	f.developer.expect("PUT", grants, map[string]any{"subjects": []any{map[string]any{"group": group}}}, 200, "")
	sees(true)
	f.admin.expect("DELETE", "/groups/"+group, nil, 204, "")
	sees(false)

	// To every member.
	f.developer.expect("PUT", grants, map[string]any{"subjects": []any{map[string]any{"everyone": true}}}, 200, "")
	sees(true)
	f.developer.expect("PUT", grants, map[string]any{"subjects": []any{}}, 200, "")
	sees(false)

	// Deleting a dashboard takes its grants along.
	f.admin.expect("PUT", "/dashboards/"+other+"/grants", map[string]any{"subjects": []any{map[string]any{"everyone": true}}}, 200, "")
	f.developer.expect("DELETE", "/dashboards/"+other, nil, 204, "")
	if count(f.viewer, "/dashboards") != 0 {
		t.Error("a deleted dashboard is still listed")
	}
}
