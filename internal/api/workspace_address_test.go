package api

import (
	"context"
	"testing"

	"github.com/supazd/supabi/internal/store"
)

// A page acts in the workspace of its address, whichever workspace another
// page of the same browser chose since. See .agents/design/access-control.md §2.4.
func TestRequestsActInTheWorkspaceOfTheirAddress(t *testing.T) {
	f := newContentFixture(t)
	admin := f.admin
	sales := admin.expect("POST", "/workspaces", map[string]any{"name": "销售"}, 201, "")["id"].(string)
	finance := admin.at(store.DefaultWorkspaceID)
	members := func(page *client) int {
		t.Helper()
		_, listed := page.do("GET", "/members", nil)
		return len(listed.([]any))
	}
	before := members(finance)

	// Another tab chooses the new workspace; the session goes there.
	admin.expect("POST", "/auth/workspace", map[string]any{"workspaceId": sales}, 200, "")
	if got := admin.expect("GET", "/auth/session", nil, 200, "")["workspace"].(map[string]any)["id"]; got != sales {
		t.Fatalf("a page without an address is in %v, want the workspace last chosen", got)
	}
	// The first tab is where its address says, and so is what it does.
	if got := finance.expect("GET", "/auth/session", nil, 200, "")["workspace"].(map[string]any)["id"]; got != store.DefaultWorkspaceID {
		t.Fatalf("the page is in %v, want the workspace of its address", got)
	}
	added := finance.expect("POST", "/users", map[string]any{"email": "new@example.com", "displayName": "New", "password": memberPassword}, 201, "")["id"].(string)
	finance.expect("POST", "/members", map[string]any{"userId": added, "role": "viewer"}, 201, "")
	if members(finance) != before+1 || members(admin.at(sales)) != 0 {
		t.Fatalf("the member went to the wrong workspace: %d here, %d there", members(finance), members(admin.at(sales)))
	}
	var recorded string
	if err := admin.db.Pool.QueryRow(context.Background(), `SELECT workspace_id FROM audit_events WHERE action = 'member.add' ORDER BY occurred_at DESC LIMIT 1`).Scan(&recorded); err != nil || recorded != store.DefaultWorkspaceID {
		t.Errorf("the audit trail puts it in %q (%v)", recorded, err)
	}
	// The role is the one held there: the viewer is nobody in the new workspace.
	if role := finance.expect("GET", "/auth/session", nil, 200, "")["role"]; role != "admin" {
		t.Errorf("role %v", role)
	}

	// A workspace the caller cannot enter is none, whether or not it exists.
	for _, id := range []string{sales, "ws_nowhere"} {
		page := f.viewer.at(id)
		if info := page.expect("GET", "/auth/session", nil, 200, ""); info["workspace"] != nil || info["authenticated"] != true {
			t.Errorf("%s: session %v", id, info)
		}
		page.expect("GET", "/dashboards", nil, 403, "no_workspace")
		page.expect("POST", "/dashboards/db_any/views", map[string]any{"state": map[string]any{}, "validDays": 1}, 403, "no_workspace")
	}
	// Once a member, the same address works, and the session stays where it was.
	admin.at(sales).expect("POST", "/members", map[string]any{"userId": userID(t, admin, "viewer@example.com"), "role": "viewer"}, 201, "")
	f.viewer.at(sales).expect("GET", "/dashboards", nil, 200, "")
	if got := f.viewer.expect("GET", "/auth/session", nil, 200, "")["workspace"].(map[string]any)["id"]; got != store.DefaultWorkspaceID {
		t.Errorf("entering by an address moved the session to %v", got)
	}

	// Signing in on a page keeps it in the workspace of its address.
	again := admin.anonymous().at(store.DefaultWorkspaceID)
	if got := again.expect("POST", "/auth/login", map[string]any{"email": "viewer@example.com", "password": memberPassword}, 200, "")["workspace"].(map[string]any)["id"]; got != store.DefaultWorkspaceID {
		t.Errorf("signed in to %v", got)
	}

	// A deleted workspace cannot be entered by its address either.
	admin.expect("DELETE", "/workspaces/"+sales, nil, 200, "")
	admin.at(sales).expect("GET", "/dashboards", nil, 403, "no_workspace")
}
