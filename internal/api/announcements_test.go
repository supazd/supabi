package api

import (
	"context"
	"strings"
	"testing"
	"time"
)

// See .agents/design/announcements.md.

func notice(title string, ends time.Duration) map[string]any {
	return map[string]any{"title": title, "body": "**Markdown** body", "endsAt": time.Now().Add(ends)}
}

// bell is a page of the caller's bell, by id.
func bell(c *client, query string) map[string]map[string]any {
	c.t.Helper()
	items := c.expect("GET", "/notifications"+query, nil, 200, "")["items"].([]any)
	out := map[string]map[string]any{}
	for _, item := range items {
		n := item.(map[string]any)
		out[n["id"].(string)] = n
	}
	return out
}

func bannerTitles(summary map[string]any) []string {
	var titles []string
	for _, item := range summary["banner"].([]any) {
		titles = append(titles, item.(map[string]any)["title"].(string))
	}
	return titles
}

func TestAnnouncementsReachWhomTheyConcern(t *testing.T) {
	f := newContentFixture(t)
	admin := f.admin
	system := admin.expect("POST", "/system/announcements", notice("Maintenance on Saturday", 24*time.Hour), 201, "")["id"].(string)
	here := admin.expect("POST", "/workspace/announcements", notice("Sales data is late today", 24*time.Hour), 201, "")["id"].(string)

	// The developer is also a viewer of a second workspace, which has its own.
	other := admin.expect("POST", "/workspaces", map[string]any{"name": "Other", "timezone": "UTC", "weekStart": 1}, 201, "")["id"].(string)
	admin.expect("POST", "/auth/workspace", map[string]any{"workspaceId": other}, 200, "")
	admin.expect("POST", "/members", map[string]any{"userId": userID(t, admin, "developer@example.com"), "role": "viewer"}, 201, "")
	there := admin.expect("POST", "/workspace/announcements", notice("New dashboard in Other", 24*time.Hour), 201, "")["id"].(string)

	// The viewer belongs to the first workspace only.
	summary := f.viewer.expect("GET", "/notifications/summary", nil, 200, "")
	if summary["unread"] != float64(2) || summary["bannerTotal"] != float64(2) || summary["refreshSeconds"] != float64(60) ||
		strings.Join(bannerTitles(summary), "|") != "Maintenance on Saturday|Sales data is late today" {
		t.Fatalf("viewer's summary: %v", summary)
	}
	if list := bell(f.viewer, ""); len(list) != 2 || list[there] != nil || list[system]["category"] != "system" || list[here]["category"] != "workspace" {
		t.Fatalf("viewer's bell: %v", list)
	}
	if list := bell(f.viewer, "?category=system"); len(list) != 1 || list[system] == nil {
		t.Fatalf("system tab: %v", list)
	}
	f.viewer.expect("POST", "/notifications/"+there+"/read", nil, 404, "not_found")

	// The developer sees both workspaces' in the bell, and only the current
	// one's in the banner.
	summary = f.developer.expect("GET", "/notifications/summary", nil, 200, "")
	if summary["unread"] != float64(3) || summary["bannerTotal"] != float64(2) {
		t.Fatalf("developer's summary: %v", summary)
	}
	list := bell(f.developer, "?category=workspace")
	if len(list) != 2 || list[there]["workspaceName"] != "Other" || list[there]["unread"] != true {
		t.Fatalf("developer's workspace tab: %v", list)
	}
	f.developer.expect("POST", "/notifications/read", nil, 204, "")
	if summary := f.developer.expect("GET", "/notifications/summary", nil, 200, ""); summary["unread"] != float64(0) || len(summary["banner"].([]any)) != 0 {
		t.Fatalf("after marking all read: %v", summary)
	}
	if list := bell(f.developer, ""); len(list) != 3 || list[system]["unread"] != false {
		t.Fatalf("read announcements leave the bell: %v", list)
	}

	// Read once, an announcement stays read when it is edited.
	f.viewer.expect("POST", "/notifications/"+here+"/read", nil, 204, "")
	admin.expect("POST", "/auth/workspace", map[string]any{"workspaceId": "ws_default"}, 200, "")
	edited := admin.expect("PUT", "/workspace/announcements/"+here, notice("Sales data is late today, fixed by noon", 48*time.Hour), 200, "")
	if edited["title"] != "Sales data is late today, fixed by noon" || edited["createdBy"] != "Admin" {
		t.Fatalf("edited: %v", edited)
	}
	if list := bell(f.viewer, ""); list[here]["unread"] != false || list[here]["title"] != edited["title"] {
		t.Fatalf("edited announcement: %v", list[here])
	}
	if summary := f.viewer.expect("GET", "/notifications/summary", nil, 200, ""); summary["unread"] != float64(1) {
		t.Fatalf("viewer after reading one: %v", summary)
	}

	// Who may publish where.
	f.viewer.expect("GET", "/workspace/announcements", nil, 403, "forbidden")
	f.developer.expect("POST", "/workspace/announcements", notice("Not mine to say", time.Hour), 403, "forbidden")
	f.developer.expect("GET", "/system/announcements", nil, 403, "forbidden")
	// Another workspace's announcement is not this one's to change.
	admin.expect("PUT", "/workspace/announcements/"+there, notice("Moved", time.Hour), 404, "not_found")
	admin.expect("DELETE", "/workspace/announcements/"+system, nil, 404, "not_found")

	// Someone in no workspace still gets the system's.
	admin.expect("POST", "/users", map[string]any{"email": "nomad@example.com", "displayName": "Nomad", "password": memberPassword}, 201, "")
	nomad := admin.signedIn("nomad@example.com", memberPassword)
	if summary := nomad.expect("GET", "/notifications/summary", nil, 200, ""); summary["unread"] != float64(1) || strings.Join(bannerTitles(summary), "|") != "Maintenance on Saturday" {
		t.Fatalf("summary without a workspace: %v", summary)
	}

	// Deleted, it is gone from everyone's bell.
	admin.expect("DELETE", "/system/announcements/"+system, nil, 204, "")
	if list := bell(f.viewer, ""); list[system] != nil {
		t.Fatalf("deleted announcement still shown: %v", list)
	}

	// Published and changed in the right workspace, or in none.
	rows, err := admin.db.Pool.Query(context.Background(), `SELECT action, outcome, category, workspace_id, object_name FROM audit_events WHERE action LIKE 'announcement.%' ORDER BY occurred_at`)
	if err != nil {
		t.Fatal(err)
	}
	var events []string
	for rows.Next() {
		var action, outcome, category, workspace, name string
		if err := rows.Scan(&action, &outcome, &category, &workspace, &name); err != nil {
			t.Fatal(err)
		}
		events = append(events, strings.Join([]string{action, outcome, category, workspace, name}, " "))
	}
	want := []string{
		"announcement.create success content  Maintenance on Saturday",
		"announcement.create success content ws_default Sales data is late today",
		"announcement.create success content " + other + " New dashboard in Other",
		"announcement.update success content ws_default Sales data is late today, fixed by noon",
		// The developer tried to publish where they are not an admin.
		"announcement.create denied content ws_default ",
		"announcement.delete success content  Maintenance on Saturday",
	}
	if strings.Join(events, "\n") != strings.Join(want, "\n") {
		t.Fatalf("audit events:\n%s\nwant:\n%s", strings.Join(events, "\n"), strings.Join(want, "\n"))
	}
}

func TestAnnouncementPeriodsAndLimits(t *testing.T) {
	f := newContentFixture(t)
	admin := f.admin
	now := time.Now()
	for _, c := range []struct {
		body map[string]any
		code string
	}{
		{map[string]any{"title": " ", "endsAt": now.Add(time.Hour)}, "announcement_title"},
		{map[string]any{"title": "Two\nlines", "endsAt": now.Add(time.Hour)}, "announcement_title"},
		{map[string]any{"title": strings.Repeat("长", 121), "endsAt": now.Add(time.Hour)}, "announcement_title"},
		{map[string]any{"title": "Long", "body": strings.Repeat("x", 10001), "endsAt": now.Add(time.Hour)}, "announcement_body_too_long"},
		{map[string]any{"title": "Backwards", "startsAt": now.Add(2 * time.Hour), "endsAt": now.Add(time.Hour)}, "announcement_ends_before_start"},
		{map[string]any{"title": "Over", "endsAt": now.Add(-time.Minute)}, "announcement_end_past"},
		{map[string]any{"title": "Late", "startsAt": now.Add(-time.Hour), "endsAt": now.Add(time.Hour)}, "announcement_start_past"},
	} {
		admin.expect("POST", "/system/announcements", c.body, 400, c.code)
	}
	if n := admin.expect("POST", "/system/announcements", map[string]any{"title": strings.Repeat("长", 120), "endsAt": now.Add(time.Hour)}, 201, ""); n["body"] != "" {
		t.Fatalf("an announcement without a body: %v", n)
	}

	// A scheduled one is shown to nobody yet, and is not ended but edited.
	scheduled := admin.expect("POST", "/system/announcements", map[string]any{"title": "Upgrade next week", "startsAt": now.Add(time.Hour), "endsAt": now.Add(2 * time.Hour)}, 201, "")["id"].(string)
	if list := bell(f.viewer, ""); list[scheduled] != nil {
		t.Fatalf("scheduled announcement shown: %v", list[scheduled])
	}
	admin.expect("POST", "/system/announcements/"+scheduled+"/end", nil, 409, "announcement_not_in_effect")

	// Ended, an unread one is history: no longer unread, still in the bell.
	active := admin.expect("POST", "/system/announcements", notice("Today only", 24*time.Hour), 201, "")
	id := active["id"].(string)
	ended := admin.expect("POST", "/system/announcements/"+id+"/end", nil, 200, "")
	if endsAt, _ := time.Parse(time.RFC3339Nano, ended["endsAt"].(string)); endsAt.After(time.Now()) {
		t.Fatalf("ended in the future: %v", ended)
	}
	admin.expect("POST", "/system/announcements/"+id+"/end", nil, 409, "announcement_not_in_effect")
	if summary := f.viewer.expect("GET", "/notifications/summary", nil, 200, ""); summary["unread"] != float64(1) {
		t.Fatalf("an ended announcement still counts: %v", summary)
	}
	if list := bell(f.viewer, ""); list[id] == nil || list[id]["unread"] != false {
		t.Fatalf("ended announcement in the bell: %v", list[id])
	}
	// Its text can still be corrected with the period left as it was, but a
	// changed end must be in the future.
	fix := map[string]any{"title": "Today only, corrected", "startsAt": ended["startsAt"], "endsAt": ended["endsAt"]}
	admin.expect("PUT", "/system/announcements/"+id, fix, 200, "")
	fix["endsAt"] = time.Now().Add(-time.Second)
	admin.expect("PUT", "/system/announcements/"+id, fix, 400, "announcement_end_past")

	// The refresh interval is a system setting, returned with each summary.
	admin.expect("PUT", "/system/settings", map[string]any{"notificationRefreshSeconds": 5}, 400, "invalid_setting")
	admin.expect("PUT", "/system/settings", map[string]any{"notificationRefreshSeconds": 15}, 200, "")
	if summary := f.viewer.expect("GET", "/notifications/summary", nil, 200, ""); summary["refreshSeconds"] != float64(15) {
		t.Fatalf("refresh interval: %v", summary)
	}
	if list := admin.expect("GET", "/system/settings", nil, 200, ""); list["defaults"].(map[string]any)["notificationRefreshSeconds"] != float64(60) {
		t.Fatalf("default refresh interval: %v", list)
	}
}
