package api

import (
	"context"
	"testing"
)

func userID(t *testing.T, c *client, email string) string {
	t.Helper()
	var id string
	if err := c.db.Pool.QueryRow(context.Background(), `SELECT id FROM users WHERE email = $1`, email).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestUsersAndMembers(t *testing.T) {
	admin := newClient(t)
	const password = "member-password"
	input := func(email string) map[string]any {
		return map[string]any{"email": email, "displayName": "Bo", "password": password}
	}

	bad := input("bo@example.com")
	bad["password"] = "short"
	admin.expect("POST", "/users", bad, 400, "invalid_password")
	admin.expect("POST", "/users", input("not-an-email"), 400, "invalid_email")

	created := admin.expect("POST", "/users", input("Bo@Example.com"), 201, "")
	bo := created["id"].(string)
	if created["email"] != "bo@example.com" || created["status"] != "active" || created["isOrgAdmin"] != false || created["password"] != nil {
		t.Errorf("created = %v", created)
	}
	admin.expect("POST", "/users", input("bo@example.com"), 409, "email_taken")
	// Creating a global account does not grant access to the current workspace.
	if _, list := admin.do("GET", "/members", nil); len(list.([]any)) != 1 {
		t.Errorf("members = %v", list)
	}
	admin.expect("POST", "/members", map[string]any{"userId": bo, "role": "viewer"}, 201, "")
	// An account without workspace access can still sign in.
	loner := admin.expect("POST", "/users", map[string]any{"email": "cy@example.com", "displayName": "Cy", "password": password}, 201, "")["id"].(string)
	stranded := admin.signedIn("cy@example.com", password)
	if info := stranded.expect("GET", "/auth/session", nil, 200, ""); info["workspace"] != nil || len(info["workspaces"].([]any)) != 0 {
		t.Errorf("session of a user who belongs nowhere = %v", info)
	}
	stranded.expect("GET", "/charts", nil, 403, "no_workspace")
	admin.expect("POST", "/members", map[string]any{"userId": "user_nope", "role": "viewer"}, 400, "unknown_user")
	admin.expect("POST", "/members", map[string]any{"userId": loner, "role": "owner"}, 400, "unknown_role")
	admin.expect("POST", "/members", map[string]any{"userId": loner, "role": "viewer"}, 201, "")
	admin.expect("POST", "/members", map[string]any{"userId": loner, "role": "viewer"}, 409, "already_member")
	admin.expect("DELETE", "/members/"+loner, nil, 204, "")
	admin.expect("DELETE", "/members/"+loner, nil, 404, "not_found")

	session := admin.signedIn("bo@example.com", password)
	session.expect("GET", "/datasets", nil, 403, "forbidden")
	// A promotion takes effect on the member's next request, without signing in again.
	admin.expect("PATCH", "/members/"+bo, map[string]any{"role": "developer"}, 200, "")
	session.expect("GET", "/datasets", nil, 200, "")
	admin.expect("PATCH", "/members/"+bo, map[string]any{"role": "owner"}, 400, "unknown_role")
	admin.expect("PATCH", "/members/user_nope", map[string]any{"role": "viewer"}, 404, "not_found")

	// Members change their own password by proving they know the current one.
	session.expect("POST", "/auth/password", map[string]any{"currentPassword": "wrong-password", "newPassword": "a-new-password"}, 400, "wrong_password")
	session.expect("POST", "/auth/password", map[string]any{"currentPassword": password, "newPassword": "short"}, 400, "invalid_password")
	elsewhere := admin.signedIn("bo@example.com", password)
	session.expect("POST", "/auth/password", map[string]any{"currentPassword": password, "newPassword": "a-new-password"}, 204, "")
	session.expect("GET", "/datasets", nil, 200, "")                  // this browser stays signed in
	elsewhere.expect("GET", "/datasets", nil, 401, "unauthenticated") // the others do not
	admin.anonymous().expect("POST", "/auth/login", map[string]any{"email": "bo@example.com", "password": password}, 401, "invalid_credentials")

	// An administrator's reset ends every session of the user.
	admin.expect("PATCH", "/users/"+bo, map[string]any{"password": "short"}, 400, "invalid_password")
	admin.expect("PATCH", "/users/"+bo, map[string]any{"password": "reset-by-admin", "displayName": "Bo Li"}, 200, "")
	session.expect("GET", "/datasets", nil, 401, "unauthenticated")
	session = admin.signedIn("bo@example.com", "reset-by-admin")
	if info := session.expect("GET", "/auth/session", nil, 200, ""); info["user"].(map[string]any)["displayName"] != "Bo Li" {
		t.Errorf("display name not updated: %v", info["user"])
	}

	// Disabling locks the user out at once and keeps them out.
	if disabled := admin.expect("PATCH", "/users/"+bo, map[string]any{"status": "disabled"}, 200, ""); disabled["status"] != "disabled" {
		t.Errorf("after disabling: %v", disabled)
	}
	session.expect("GET", "/datasets", nil, 401, "unauthenticated")
	admin.anonymous().expect("POST", "/auth/login", map[string]any{"email": "bo@example.com", "password": "reset-by-admin"}, 401, "invalid_credentials")
	admin.expect("PATCH", "/users/"+bo, map[string]any{"status": "active"}, 200, "")
	session = admin.signedIn("bo@example.com", "reset-by-admin")
	admin.expect("PATCH", "/users/user_nope", map[string]any{"status": "disabled"}, 404, "not_found")

	// Administrators cannot lock themselves out…
	me := userID(t, admin, adminEmail)
	admin.expect("PATCH", "/members/"+me, map[string]any{"role": "viewer"}, 400, "cannot_change_self")
	admin.expect("DELETE", "/members/"+me, nil, 400, "cannot_change_self")
	admin.expect("PATCH", "/users/"+me, map[string]any{"status": "disabled"}, 400, "cannot_change_self")
	admin.expect("PATCH", "/users/"+me, map[string]any{"isOrgAdmin": false}, 400, "cannot_change_self")
	admin.expect("PATCH", "/users/"+me, map[string]any{"displayName": "Root"}, 200, "")

	// …and accounts belong to the org: a workspace admin who is not an org
	// administrator can arrange members but not create or change accounts.
	admin.expect("PATCH", "/members/"+bo, map[string]any{"role": "admin"}, 200, "")
	if failed := session.expect("POST", "/users", input("dee@example.com"), 403, "forbidden"); failed["params"].(map[string]any)["role"] != "org_admin" {
		t.Errorf("params = %v", failed["params"])
	}
	session.expect("PATCH", "/users/"+loner, map[string]any{"status": "disabled"}, 403, "forbidden")
	session.expect("POST", "/workspaces", map[string]any{"name": "x"}, 403, "forbidden")
	session.expect("POST", "/members", map[string]any{"userId": loner, "role": "viewer"}, 201, "")
	// Making someone an org administrator gives them everything, everywhere.
	admin.expect("PATCH", "/users/"+bo, map[string]any{"isOrgAdmin": true}, 200, "")
	session.expect("POST", "/users", input("dee@example.com"), 201, "")
}

func TestSystemDirectoryWithoutCurrentWorkspace(t *testing.T) {
	admin := newClient(t)
	// A system administrator can manage accounts and groups even when the
	// session has no selected workspace. Workspace settings still require one.
	if _, err := admin.db.Pool.Exec(context.Background(), `UPDATE sessions SET workspace_id = NULL`); err != nil {
		t.Fatal(err)
	}
	admin.expect("GET", "/users", nil, 200, "")
	admin.expect("GET", "/groups", nil, 200, "")
	admin.expect("GET", "/workspaces", nil, 200, "")
	admin.expect("GET", "/user-attributes", nil, 403, "no_workspace")
	admin.expect("PUT", "/workspace", map[string]any{"name": "Changed"}, 403, "no_workspace")
	created := admin.expect("POST", "/users", map[string]any{"email": "new@example.com", "displayName": "New", "password": "member-password"}, 201, "")
	admin.expect("POST", "/groups", map[string]any{"name": "Global team", "userIds": []string{created["id"].(string)}}, 201, "")
	member := admin.signedIn("new@example.com", "member-password")
	member.expect("GET", "/users", nil, 403, "no_workspace")
	member.expect("GET", "/groups", nil, 403, "no_workspace")
}

func TestGroupsAndWorkspaces(t *testing.T) {
	admin := newClient(t)
	const password = "member-password"
	uid := admin.expect("POST", "/users", map[string]any{"email": "gil@example.com", "displayName": "Gil", "password": password}, 201, "")["id"].(string)
	gil := admin.signedIn("gil@example.com", password)

	admin.expect("POST", "/groups", map[string]any{"name": " ", "userIds": []string{}}, 400, "name_required")
	admin.expect("POST", "/groups", map[string]any{"name": "g", "userIds": []string{"user_nope"}}, 400, "unknown_user")
	group := admin.expect("POST", "/groups", map[string]any{"name": "分析组", "userIds": []string{uid, uid}}, 201, "")
	gid := group["id"].(string)
	if len(group["userIds"].([]any)) != 1 {
		t.Errorf("group = %v", group)
	}
	admin.expect("POST", "/groups", map[string]any{"name": "分析组", "userIds": []string{}}, 409, "name_taken")

	// A workspace of its own, with its own time zone.
	admin.expect("POST", "/workspaces", map[string]any{"name": "x", "timezone": "Mars/Olympus"}, 400, "invalid_timezone")
	admin.expect("POST", "/workspaces", map[string]any{"name": "x", "weekStart": 3}, 400, "invalid_week_start")
	admin.expect("POST", "/workspaces", map[string]any{"name": "x", "firstWeekDays": 2}, 400, "invalid_first_week_days")
	second := admin.expect("POST", "/workspaces", map[string]any{"name": "华东区", "timezone": "Asia/Shanghai", "weekStart": 7, "firstWeekDays": 1}, 201, "")
	if second["firstWeekDays"] != float64(1) {
		t.Errorf("created workspace = %v", second)
	}
	admin.expect("POST", "/workspaces", map[string]any{"name": "华东区"}, 409, "name_taken")
	wid := second["id"].(string)

	// Gil cannot enter it, nor learn whether it exists.
	gil.expect("POST", "/auth/workspace", map[string]any{"workspaceId": wid}, 404, "not_found")
	gil.expect("POST", "/auth/workspace", map[string]any{"workspaceId": "ws_nope"}, 404, "not_found")

	// The administrator switches to it and gives Gil's group a role there.
	switched := admin.expect("POST", "/auth/workspace", map[string]any{"workspaceId": wid}, 200, "")
	if ws := switched["workspace"].(map[string]any); ws["id"] != wid || ws["timezone"] != "Asia/Shanghai" || ws["firstWeekDays"] != float64(1) || len(switched["workspaces"].([]any)) != 2 {
		t.Errorf("after switching: %v", switched)
	}
	admin.expect("PUT", "/group-members/grp_nope", map[string]any{"role": "viewer"}, 404, "not_found")
	admin.expect("PUT", "/group-members/"+gid, map[string]any{"role": "owner"}, 400, "unknown_role")
	admin.expect("PUT", "/group-members/"+gid, map[string]any{"role": "developer"}, 200, "")
	// Granting again replaces the group's role.
	granted := admin.expect("PUT", "/group-members/"+gid, map[string]any{"role": "viewer"}, 200, "")
	if granted["name"] != "分析组" || granted["role"] != "viewer" {
		t.Errorf("grant = %v", granted)
	}
	if _, list := admin.do("GET", "/group-members", nil); len(list.([]any)) != 1 {
		t.Errorf("group members = %v", list)
	}

	// Now Gil can enter, with the group's role. Resources stay in their workspace.
	sourceID := admin.expect("POST", "/datasources", admin.datasourceInput("db"), 201, "")["id"].(string)
	info := gil.expect("POST", "/auth/workspace", map[string]any{"workspaceId": wid}, 200, "")
	if info["role"] != "viewer" {
		t.Errorf("role through the group = %v", info["role"])
	}
	gil.expect("GET", "/charts", nil, 200, "")
	gil.expect("GET", "/datasources", nil, 403, "forbidden")
	admin.expect("POST", "/auth/workspace", map[string]any{"workspaceId": "ws_default"}, 200, "")
	if _, list := admin.do("GET", "/datasources", nil); len(list.([]any)) != 0 {
		t.Errorf("a data source of another workspace is visible: %v", list)
	}
	admin.expect("GET", "/datasources/"+sourceID, nil, 404, "not_found")
	admin.expect("POST", "/auth/workspace", map[string]any{"workspaceId": wid}, 200, "")

	// Workspace settings.
	gil.expect("PUT", "/workspace", map[string]any{"name": "x"}, 403, "forbidden")
	updated := admin.expect("PUT", "/workspace", map[string]any{"name": "华东大区", "timezone": "Asia/Tokyo", "weekStart": 1, "firstWeekDays": 7}, 200, "")
	if updated["name"] != "华东大区" || updated["timezone"] != "Asia/Tokyo" || updated["weekStart"] != float64(1) || updated["firstWeekDays"] != float64(7) {
		t.Errorf("updated = %v", updated)
	}
	admin.expect("PUT", "/workspace", map[string]any{"name": "Default"}, 409, "name_taken")

	// Taking the group's role away, or Gil out of the group, closes the door.
	admin.expect("PUT", "/groups/"+gid, map[string]any{"name": "分析组", "userIds": []string{}}, 200, "")
	gil.expect("GET", "/charts", nil, 403, "forbidden")
	admin.expect("PUT", "/groups/"+gid, map[string]any{"name": "分析组", "userIds": []string{uid}}, 200, "")
	gil.expect("GET", "/charts", nil, 200, "")
	admin.expect("DELETE", "/group-members/"+gid, nil, 204, "")
	admin.expect("DELETE", "/group-members/"+gid, nil, 404, "not_found")
	gil.expect("GET", "/charts", nil, 403, "forbidden")
	admin.expect("DELETE", "/groups/"+gid, nil, 204, "")
	admin.expect("DELETE", "/groups/"+gid, nil, 404, "not_found")
}
