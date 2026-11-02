package api

import (
	"context"
	"encoding/json"
	"testing"
)

func TestRowRules(t *testing.T) {
	f := newContentFixture(t)
	chart := f.chart("按地区", `{"type":"table"}`)
	chart["spec"].(map[string]any)["query"].(map[string]any)["dimensions"] = []any{map[string]any{"field": "region"}}
	chart["spec"].(map[string]any)["filters"] = []any{map[string]any{"id": "region", "field": "region", "op": "in", "label": "地区", "control": map[string]any{"type": "select", "multi": true}}}
	chartID := f.developer.expect("POST", "/charts", chart, 201, "")["id"].(string)
	board := f.developer.expect("POST", "/dashboards", map[string]any{"name": "销售", "spec": dashboardSpec(chartID)}, 201, "")["id"].(string)
	f.share(t, board)
	f.admin.expect("POST", "/users", map[string]any{"email": "wang@example.com", "displayName": "wang", "password": memberPassword}, 201, "")
	f.admin.expect("POST", "/members", map[string]any{"userId": userID(t, f.admin, "wang@example.com"), "role": "viewer"}, 201, "")
	wang := f.admin.signedIn("wang@example.com", memberPassword)
	viewerID := userID(t, f.admin, "viewer@example.com")
	east := f.admin.expect("POST", "/groups", map[string]any{"name": "华东组", "userIds": []string{viewerID}}, 201, "")["id"].(string)
	hq := f.admin.expect("POST", "/groups", map[string]any{"name": "总部", "userIds": []string{}}, 201, "")["id"].(string)
	policy := "/datasets/" + f.datasetID + "/policy"

	rows := func(c *client) string {
		t.Helper()
		result := c.expect("POST", "/dashboards/"+board+"/items/wa/data", nil, 200, "")
		got, _ := json.Marshal(result["rows"])
		return string(got)
	}
	options := func(c *client) string {
		t.Helper()
		result := c.expect("POST", "/charts/"+chartID+"/filters/region/options", map[string]any{}, 200, "")
		got, _ := json.Marshal(result["values"])
		return string(got)
	}
	const all, eastOnly, none = `[["华东","300.50"],["华南","300.25"]]`, `[["华东","300.50"]]`, `[]`
	check := func(name string, c *client, want string) {
		t.Helper()
		if got := rows(c); got != want {
			t.Errorf("%s: rows = %s, want %s", name, got, want)
		}
	}
	set := func(body map[string]any) {
		t.Helper()
		f.developer.expect("PUT", policy, body, 200, "")
	}
	eastRule := map[string]any{"subjects": []any{map[string]any{"group": east}}, "filter": map[string]any{"field": "region", "op": "eq", "value": "华东"}}

	// A dataset nobody restricted shows everyone everything.
	if got := f.developer.expect("GET", policy, nil, 200, ""); got["unmatched"] != "all" || len(got["rows"].([]any)) != 0 || got["updatedAt"] != nil {
		t.Errorf("policy of a new dataset = %v", got)
	}
	check("before any rule", f.viewer, all)

	// Developers can configure policies and load their subject directory; viewers cannot.
	f.viewer.expect("PUT", policy, map[string]any{"unmatched": "all", "rows": []any{}, "columns": []any{}}, 403, "forbidden")
	f.viewer.expect("GET", policy, nil, 403, "forbidden")
	for _, path := range []string{"/users", "/groups"} {
		if status, _ := f.developer.do("GET", path, nil); status != 200 {
			t.Errorf("developer directory %s: status = %d", path, status)
		}
		f.viewer.expect("GET", path, nil, 403, "forbidden")
	}
	f.developer.expect("POST", "/groups", map[string]any{"name": "not allowed", "userIds": []string{}}, 403, "forbidden")
	f.viewer.expect("PUT", "/dashboards/"+board+"/grants", map[string]any{"subjects": []any{map[string]any{"everyone": true}}}, 403, "forbidden")
	f.admin.expect("PUT", policy, map[string]any{"unmatched": "some", "rows": []any{}, "columns": []any{}}, 400, "")
	f.admin.expect("PUT", policy, map[string]any{"unmatched": "all", "rows": []any{map[string]any{"subjects": []any{}, "filter": eastRule["filter"]}}, "columns": []any{}}, 400, "rule_without_subjects")
	f.admin.expect("PUT", policy, map[string]any{"unmatched": "all", "rows": []any{map[string]any{"subjects": []any{map[string]any{"group": east}}, "filter": map[string]any{"field": "nope", "op": "eq", "value": "x"}}}, "columns": []any{}}, 400, "invalid_rule_filter")
	f.admin.expect("PUT", "/datasets/ds_nope/policy", map[string]any{"unmatched": "all", "rows": []any{}, "columns": []any{}}, 404, "not_found")

	// Narrowing one group leaves everyone else as they were.
	set(map[string]any{"unmatched": "all", "rows": []any{eastRule}, "columns": []any{}})
	check("covered by the east rule", f.viewer, eastOnly)
	check("covered by no rule", wang, all)
	check("developer", f.developer, all)
	if got := options(f.viewer); got != `["华东"]` {
		t.Errorf("filter options of a viewer limited to 华东 = %s", got)
	}
	if got := f.admin.expect("GET", policy, nil, 200, ""); got["updatedBy"] == nil || got["updatedAt"] == nil {
		t.Errorf("who changed the policy is not recorded: %v", got)
	}

	// Those no rule covers can be made to see nothing.
	set(map[string]any{"unmatched": "none", "rows": []any{eastRule}, "columns": []any{}})
	check("covered by no rule, unmatched none", wang, none)
	check("still covered by the east rule", f.viewer, eastOnly)

	// Neither group membership nor an incomplete rule can lift another rule.
	f.admin.expect("PUT", "/groups/"+hq, map[string]any{"name": "总部", "userIds": []string{viewerID}}, 200, "")
	check("in a group no rule names", f.viewer, eastOnly)
	for _, condition := range []any{
		nil,
		map[string]any{},
		map[string]any{"op": "and", "args": []any{}},
		map[string]any{"op": "or", "args": []any{eastRule["filter"], map[string]any{}}},
		map[string]any{"field": "region", "op": "in", "value": []any{}},
		map[string]any{"field": "region", "op": "not_in", "value": []any{}},
		map[string]any{"op": "not", "args": []any{map[string]any{"op": "false"}}},
	} {
		rule := map[string]any{"subjects": []any{map[string]any{"group": hq}}, "filter": condition}
		body := map[string]any{"unmatched": "none", "rows": []any{eastRule, rule}, "columns": []any{}}
		f.admin.expect("PUT", policy, body, 400, "")
		f.developer.expect("POST", policy+"/preview", map[string]any{"userId": viewerID, "policy": body}, 400, "")
		if condition == nil {
			delete(rule, "filter")
			f.admin.expect("PUT", policy, body, 400, "")
			f.developer.expect("POST", policy+"/preview", map[string]any{"userId": viewerID, "policy": body}, 400, "")
		}
	}
	check("rejected rules do not change saved access", f.viewer, eastOnly)

	// What someone sees can be looked at before it is saved.
	preview := f.developer.expect("POST", policy+"/preview", map[string]any{"userId": viewerID, "policy": map[string]any{"unmatched": "none", "rows": []any{eastRule}, "columns": []any{}}}, 200, "")
	if preview["restricted"] != true || len(preview["result"].(map[string]any)["rows"].([]any)) != 2 {
		t.Errorf("preview of the east rule = %v", preview)
	}
	preview = f.admin.expect("POST", policy+"/preview", map[string]any{"userId": userID(t, f.admin, "developer@example.com")}, 200, "")
	if preview["restricted"] != false || len(preview["result"].(map[string]any)["rows"].([]any)) != 3 {
		t.Errorf("preview of a developer = %v", preview)
	}
	f.viewer.expect("POST", policy+"/preview", map[string]any{"userId": viewerID}, 403, "forbidden")

	// A field a rule names cannot be deleted from the dataset.
	set(map[string]any{"unmatched": "all", "rows": []any{eastRule}, "columns": []any{}})
	_, original := f.admin.do("GET", "/datasets/"+f.datasetID, nil)
	spec := original.(map[string]any)["spec"].(map[string]any)
	var kept []any
	for _, field := range spec["fields"].([]any) {
		if field.(map[string]any)["key"] != "region" {
			kept = append(kept, field)
		}
	}
	spec["fields"] = kept
	f.developer.editing("PUT", "/datasets/"+f.datasetID, map[string]any{"name": "订单", "datasourceId": original.(map[string]any)["datasourceId"], "spec": spec}, 409, "field_in_policy")

	// A rule that no longer fits the dataset shows those it covers nothing.
	if _, err := f.admin.db.Pool.Exec(context.Background(), `UPDATE dataset_policies SET row_rules = jsonb_set(row_rules, '{0,filter,field}', '"gone"') WHERE dataset_id = $1`, f.datasetID); err != nil {
		t.Fatal(err)
	}
	check("covered by a broken rule", f.viewer, none)
	check("not covered by the broken rule", wang, all)
	if got := f.admin.expect("GET", policy, nil, 200, ""); len(got["invalidRows"].([]any)) != 1 {
		t.Errorf("invalid rows = %v", got["invalidRows"])
	}
	// Removing all rules disables the policy, even if unmatched was left at none.
	set(map[string]any{"unmatched": "none", "rows": []any{}, "columns": []any{}})
	check("all rules removed", f.viewer, all)
	preview = f.developer.expect("POST", policy+"/preview", map[string]any{"userId": viewerID}, 200, "")
	if len(preview["result"].(map[string]any)["rows"].([]any)) != 3 {
		t.Errorf("empty policy preview = %v", preview)
	}

}

func TestColumnRules(t *testing.T) {
	f := newContentFixture(t)
	byRegion := func(name string, measures []any) string {
		chart := f.chart(name, `{"type":"table"}`)
		q := chart["spec"].(map[string]any)["query"].(map[string]any)
		q["dimensions"], q["measures"] = []any{map[string]any{"field": "region"}}, measures
		return f.developer.expect("POST", "/charts", chart, 201, "")["id"].(string)
	}
	revenue := byRegion("销售额", []any{map[string]any{"field": "revenue", "agg": "sum"}})
	orders := byRegion("订单数", []any{map[string]any{"field": "region", "agg": "count", "alias": "orders"}})
	board := f.developer.expect("POST", "/dashboards", map[string]any{"name": "销售", "spec": dashboardSpec(revenue, orders)}, 201, "")["id"].(string)
	f.share(t, board)
	viewerID := userID(t, f.admin, "viewer@example.com")
	finance := f.admin.expect("POST", "/groups", map[string]any{"name": "财务", "userIds": []string{}}, 201, "")["id"].(string)
	policy := "/datasets/" + f.datasetID + "/policy"
	item := func(c *client, id string, status int, code string) string {
		t.Helper()
		result := c.expect("POST", "/dashboards/"+board+"/items/"+id+"/data", nil, status, code)
		got, _ := json.Marshal(result["rows"])
		return string(got)
	}
	hideMoney := map[string]any{"fields": []any{"amount", "revenue"}, "visibleTo": []any{map[string]any{"group": finance}}}

	f.admin.expect("PUT", policy, map[string]any{"unmatched": "all", "rows": []any{}, "columns": []any{map[string]any{"fields": []any{"nope"}, "visibleTo": []any{}}}}, 400, "unknown_field")
	f.admin.expect("PUT", policy, map[string]any{"unmatched": "all", "rows": []any{}, "columns": []any{map[string]any{"fields": []any{}, "visibleTo": []any{}}}}, 400, "rule_without_fields")
	f.developer.expect("PUT", policy, map[string]any{"unmatched": "all", "rows": []any{}, "columns": []any{hideMoney}}, 200, "")

	// A chart that uses a hidden field says so; the others on the board are unaffected.
	item(f.viewer, "wa", 400, "hidden_field")
	if got := item(f.viewer, "wb", 200, ""); got != `[["华东",2],["华南",1]]` {
		t.Errorf("a chart without hidden fields = %s", got)
	}
	f.viewer.expect("POST", "/charts/"+revenue+"/data", nil, 400, "hidden_field")
	if got := item(f.developer, "wa", 200, ""); got != `[["华东","300.50"],["华南","300.25"]]` {
		t.Errorf("a developer sees hidden fields: %s", got)
	}

	// Those it is visible to see it.
	f.admin.expect("PUT", "/groups/"+finance, map[string]any{"name": "财务", "userIds": []string{viewerID}}, 200, "")
	item(f.viewer, "wa", 200, "")
	f.admin.expect("PUT", "/groups/"+finance, map[string]any{"name": "财务", "userIds": []string{}}, 200, "")

	// A row rule may name a hidden field; it filters on the server and shows no value.
	f.admin.expect("PUT", policy, map[string]any{"unmatched": "all", "columns": []any{hideMoney}, "rows": []any{
		map[string]any{"subjects": []any{map[string]any{"user": viewerID}}, "filter": map[string]any{"field": "amount", "op": "gt", "value": 150}},
	}}, 200, "")
	if got := item(f.viewer, "wb", 200, ""); got != `[["华东",1],["华南",1]]` {
		t.Errorf("rows kept by a rule on a hidden field = %s", got)
	}

	// The preview names the hidden fields and leaves them out.
	preview := f.developer.expect("POST", policy+"/preview", map[string]any{"userId": viewerID}, 200, "")
	hidden, _ := json.Marshal(preview["hiddenFields"])
	columns := preview["result"].(map[string]any)["columns"].([]any)
	if string(hidden) != `["amount","revenue"]` || len(columns) != 2 || len(preview["result"].(map[string]any)["rows"].([]any)) != 2 {
		t.Errorf("preview = %v", preview)
	}

	// Reverse the column scope; persist it and enforce the same result in previews and charts.
	f.admin.expect("PUT", policy, map[string]any{"unmatched": "all", "columnMode": "invalid", "rows": []any{}, "columns": []any{hideMoney}}, 400, "")
	f.admin.expect("PUT", policy, map[string]any{"unmatched": "all", "columnMode": "hidden", "rows": []any{}, "columns": []any{hideMoney}}, 200, "")
	if got := f.admin.expect("GET", policy, nil, 200, ""); got["columnMode"] != "hidden" {
		t.Fatalf("column scope not persisted: %v", got)
	}
	item(f.viewer, "wa", 200, "")
	preview = f.developer.expect("POST", policy+"/preview", map[string]any{"userId": viewerID}, 200, "")
	if len(preview["hiddenFields"].([]any)) != 0 {
		t.Errorf("outside members should see columns: %v", preview)
	}
	f.admin.expect("PUT", "/groups/"+finance, map[string]any{"name": "财务", "userIds": []string{viewerID}}, 200, "")
	item(f.viewer, "wa", 400, "hidden_field")
	preview = f.developer.expect("POST", policy+"/preview", map[string]any{"userId": viewerID}, 200, "")
	if len(preview["hiddenFields"].([]any)) != 2 {
		t.Errorf("applicable members should not see columns: %v", preview)
	}
	// Clearing the final column rule also removes all restrictions.
	f.admin.expect("PUT", policy, map[string]any{"unmatched": "none", "columnMode": "hidden", "rows": []any{}, "columns": []any{}}, 200, "")
	if got := item(f.viewer, "wa", 200, ""); got != `[["华东","300.50"],["华南","300.25"]]` {
		t.Errorf("cleared policy: %s", got)
	}
}
