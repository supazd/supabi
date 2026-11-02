package api

import (
	"encoding/json"
	"testing"

	"github.com/supazd/supabi/internal/authz"
	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/dialect"
	"github.com/supazd/supabi/internal/policy"
)

func TestDynamicPermissionsEndToEnd(t *testing.T) {
	f := newContentFixture(t)
	user := userID(t, f.admin, "viewer@example.com")
	group := f.admin.expect("POST", "/groups", map[string]any{"name": "East", "userIds": []string{user}}, 201, "")["id"].(string)
	path := "/user-attributes/regions"
	assignment := func(kind, id string, values []string) any {
		return map[string]any{"subject": map[string]any{kind: id}, "values": values}
	}
	set := func(assignments ...any) {
		f.admin.expect("PUT", path, map[string]any{"name": "Regions", "assignments": assignments}, 200, "")
	}
	f.viewer.expect("GET", "/user-attributes", nil, 403, "forbidden")
	f.developer.expect("PUT", path, map[string]any{"name": "Regions", "assignments": []any{}}, 403, "forbidden")
	f.admin.expect("PUT", "/user-attributes/email", map[string]any{"name": "Email", "assignments": []any{}}, 400, "invalid_attribute_key")
	f.admin.expect("PUT", path, map[string]any{"name": "Regions", "assignments": []any{assignment("user", "unknown", []string{"East"})}}, 400, "unknown_user")
	set(assignment("group", group, []string{"华东"}))
	rule := map[string]any{"name": "按负责大区", "subjects": []any{map[string]any{"everyone": true}}, "filter": map[string]any{"op": "in", "field": "region", "value": map[string]any{"userAttr": "regions"}}}
	policy := map[string]any{"unmatched": "all", "rows": []any{rule}, "columns": []any{}}
	policyPath := "/datasets/" + f.datasetID + "/policy"
	saved := f.developer.expect("PUT", policyPath, policy, 200, "")
	if saved["rows"].([]any)[0].(map[string]any)["name"] != "按负责大区" {
		t.Fatal("rule name not preserved")
	}
	chart := f.chart("Regional sales", `{"type":"table"}`)
	chart["spec"].(map[string]any)["query"].(map[string]any)["dimensions"] = []any{map[string]any{"field": "region"}}
	chart["spec"].(map[string]any)["filters"] = []any{map[string]any{"id": "region", "field": "region", "op": "in", "label": "Region", "control": map[string]any{"type": "select", "multi": true}}}
	chartID := f.developer.expect("POST", "/charts", chart, 201, "")["id"].(string)
	board := f.developer.expect("POST", "/dashboards", map[string]any{"name": "Sales", "spec": dashboardSpec(chartID)}, 201, "")["id"].(string)
	f.share(t, board)
	check := func(want string) {
		t.Helper()
		result := f.viewer.expect("POST", "/dashboards/"+board+"/items/wa/data", nil, 200, "")
		raw, _ := json.Marshal(result["rows"])
		if string(raw) != want {
			t.Fatalf("rows = %s, want %s", raw, want)
		}
	}
	check(`[["华东","300.50"]]`)
	options := f.viewer.expect("POST", "/charts/"+chartID+"/filters/region/options", map[string]any{}, 200, "")
	raw, _ := json.Marshal(options["values"])
	if string(raw) != `["华东"]` {
		t.Fatalf("candidate leak: %s", raw)
	}
	preview := f.developer.expect("POST", policyPath+"/preview", map[string]any{"userId": user}, 200, "")
	if len(preview["result"].(map[string]any)["rows"].([]any)) != 2 {
		t.Fatal("preview differs from live permissions")
	}
	set(assignment("group", group, []string{"华东"}), assignment("user", user, []string{"华南"}))
	check(`[["华南","300.25"]]`)
	set(assignment("group", group, []string{"华东"}), assignment("user", user, []string{}))
	check(`[]`)
	set(assignment("user", user, []string{"*"}))
	check(`[]`)
	// Workspace definitions and values never cross scope boundaries.
	other := f.admin.expect("POST", "/workspaces", map[string]any{"name": "Other"}, 201, "")["id"].(string)
	f.admin.expect("POST", "/auth/workspace", map[string]any{"workspaceId": other}, 200, "")
	_, listed := f.admin.do("GET", "/user-attributes", nil)
	if len(listed.([]any)) != 3 {
		t.Fatal("custom attributes crossed workspaces")
	}
	set(assignment("user", user, []string{"华南"}))
	check(`[]`)
	f.admin.expect("POST", "/auth/workspace", map[string]any{"workspaceId": "ws_default"}, 200, "")
	set(assignment("group", group, []string{"华东"}))
	check(`[["华东","300.50"]]`)
	f.admin.expect("PUT", "/groups/"+group, map[string]any{"name": "East", "userIds": []string{}}, 200, "")
	check(`[]`)

	f.admin.expect("DELETE", path, nil, 204, "")
	check(`[]`)
	f.developer.expect("PUT", policyPath, policy, 400, "unknown_attribute")
	invalid := f.developer.expect("GET", policyPath, nil, 200, "")
	if len(invalid["invalidRows"].([]any)) != 1 {
		t.Fatal("deleted attribute not marked invalid")
	}
	rule["filter"] = map[string]any{"op": "in", "field": "amount", "value": map[string]any{"userAttr": "email"}}
	f.developer.expect("PUT", policyPath, policy, 400, "invalid_rule_filter")
}

func TestDynamicRuleRejectsChangedFieldType(t *testing.T) {
	for _, typ := range []datasource.Type{datasource.String, datasource.Decimal, datasource.Date} {
		t.Run(string(typ), func(t *testing.T) {
			value := "1"
			if typ == datasource.Date {
				value = "2026-10-17"
			}
			spec := &dataset.Spec{SpecVersion: 1, Source: dataset.Source{Type: "table", Table: "orders"}, Fields: []dataset.Field{{Key: "code", Label: "Code", Column: "code", Type: typ, Role: dataset.Dimension}}}
			condition := dataset.Filter{Field: "code", Op: "in", Value: map[string]any{"userAttr": "codes"}}
			p := policy.Policy{Unmatched: policy.All, Rows: []policy.RowRule{{Subjects: []authz.Subject{{Everyone: true}}, Filter: &condition}}}
			fits := filterFits(spec, dialect.Postgres{})
			out, err := toPolicy(p, fits)
			if err != nil {
				t.Fatal(err)
			}
			got := p.RowFilter(authz.Identity{UserID: "u", Attributes: map[string][]string{"codes": {value}}}, fits)
			if typ == datasource.String {
				if len(*out.InvalidRows) != 0 || got == nil || got.Op != "in" {
					t.Fatalf("valid text rule: invalid=%v filter=%+v", *out.InvalidRows, got)
				}
			} else if len(*out.InvalidRows) != 1 || got == nil || got.Op != "false" {
				t.Fatalf("invalid dynamic rule must deny: invalid=%v filter=%+v", *out.InvalidRows, got)
			}
			// Invalid rules cannot widen or revoke an independent valid grant.
			fixed := dataset.Filter{Field: "code", Op: "eq", Value: value}
			p.Rows = append(p.Rows, policy.RowRule{Subjects: []authz.Subject{{Everyone: true}}, Filter: &fixed})
			if typ != datasource.String {
				got = p.RowFilter(authz.Identity{Attributes: map[string][]string{"codes": {value}}}, fits)
				if got == nil || got.Op != "eq" {
					t.Fatalf("independent grant lost: %+v", got)
				}
			}
		})
	}
}

func TestDeletingGroupCleansAttributeAssignmentsAcrossWorkspaces(t *testing.T) {
	f := newContentFixture(t)
	user := userID(t, f.admin, "viewer@example.com")
	group := f.admin.expect("POST", "/groups", map[string]any{"name": "Removed", "userIds": []string{user}}, 201, "")["id"].(string)
	kept := f.admin.expect("POST", "/groups", map[string]any{"name": "Kept", "userIds": []string{}}, 201, "")["id"].(string)
	other := f.admin.expect("POST", "/workspaces", map[string]any{"name": "Other"}, 201, "")["id"].(string)
	assignment := func(kind, id, value string) any {
		return map[string]any{"subject": map[string]any{kind: id}, "values": []string{value}}
	}
	expected := []any{assignment("user", user, "Direct"), assignment("group", kept, "Kept")}
	for _, workspace := range []string{"ws_default", other} {
		f.admin.expect("POST", "/auth/workspace", map[string]any{"workspaceId": workspace}, 200, "")
		f.admin.expect("PUT", "/user-attributes/regions", map[string]any{"name": "Regions", "assignments": []any{expected[0], assignment("group", group, "Removed"), expected[1]}}, 200, "")
		f.admin.expect("PUT", "/user-attributes/only_removed", map[string]any{"name": "Removed only", "assignments": []any{assignment("group", group, "Removed")}}, 200, "")
	}
	f.admin.expect("DELETE", "/groups/"+group, nil, 204, "")
	for _, workspace := range []string{"ws_default", other} {
		f.admin.expect("POST", "/auth/workspace", map[string]any{"workspaceId": workspace}, 200, "")
		_, listed := f.admin.do("GET", "/user-attributes", nil)
		for _, raw := range listed.([]any) {
			a := raw.(map[string]any)
			if a["key"] == "regions" {
				got, _ := json.Marshal(a["assignments"])
				want, _ := json.Marshal(expected)
				if string(got) != string(want) {
					t.Fatalf("remaining assignments = %s, want %s", got, want)
				}
				// The same payload used by the UI can be renamed and saved normally.
				f.admin.expect("PUT", "/user-attributes/regions", map[string]any{"name": "Renamed", "assignments": a["assignments"]}, 200, "")
			}
			if a["key"] == "only_removed" && len(a["assignments"].([]any)) != 0 {
				t.Fatalf("orphan retained: %v", a)
			}
		}
	}
}
