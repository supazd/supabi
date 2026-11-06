package api

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/supazd/supabi/internal/store"
)

// System administrators set the settings every instance keeps to; a value
// out of range is refused, and the audit shows what changed.
func TestSystemSettings(t *testing.T) {
	admin := newClient(t)
	got := admin.expect("GET", "/system/settings", nil, 200, "")
	if values := got["values"].(map[string]any); len(values) != 0 {
		t.Errorf("values of a new installation = %v", values)
	}
	defaults := got["defaults"].(map[string]any)
	for setting, want := range map[string]float64{"exportRetentionHours": 24, "exportTimeoutMinutes": 15, "exportMaxRows": 2_000_000, "exportMaxSizeMb": 512, "auditRetentionDays": 180, "queryCacheTtlMinutes": 10,
		"queryTimeoutSeconds": 60, "queryDefaultRows": 1000, "queryMaxRows": 10000, "sessionLifetimeHours": 168, "workspaceRetentionDays": 30,
		"assistantCompressPercent": 80, "assistantMaxToolCalls": 60} {
		if defaults[setting] != want {
			t.Errorf("default %s = %v, want %v", setting, defaults[setting], want)
		}
	}

	for setting, value := range map[string]any{"exportRetentionHours": 0, "exportMaxRows": 100_000_001, "auditRetentionDays": -1, "queryCacheTtlMinutes": 1441,
		"queryTimeoutSeconds": 3601, "queryDefaultRows": 0, "queryMaxRows": 100_001, "sessionLifetimeHours": 0, "workspaceRetentionDays": 3651,
		"assistantCompressPercent": 49, "assistantMaxToolCalls": 1001} {
		admin.expect("PUT", "/system/settings", map[string]any{setting: value}, 400, "invalid_setting")
	}
	// Against each other as they apply: what is left empty is its default.
	admin.expect("PUT", "/system/settings", map[string]any{"queryDefaultRows": 20_000}, 400, "default_rows_above_max")
	admin.expect("PUT", "/system/settings", map[string]any{"queryMaxRows": 500}, 400, "default_rows_above_max")
	admin.expect("PUT", "/system/settings", map[string]any{"queryDefaultRows": 600, "queryMaxRows": 500}, 400, "default_rows_above_max")
	admin.expect("PUT", "/system/settings", map[string]any{"assistantCompressPercent": 96}, 400, "invalid_setting")
	admin.expect("PUT", "/system/settings", map[string]any{"assistantMaxToolCalls": -1}, 400, "invalid_setting")
	// 0 calls is no limit, not none.
	saved := admin.expect("PUT", "/system/settings", map[string]any{"exportMaxRows": 1000, "auditRetentionDays": 0, "assistantMaxToolCalls": 0}, 200, "")
	if values := saved["values"].(map[string]any); len(values) != 3 || values["exportMaxRows"] != float64(1000) || values["auditRetentionDays"] != float64(0) || values["assistantMaxToolCalls"] != float64(0) {
		t.Errorf("saved = %v", values)
	}
	if page := admin.expect("GET", "/exports", nil, 200, ""); page["maxRows"] != float64(1000) {
		t.Errorf("the export centre says at most %v rows", page["maxRows"])
	}
	// What is left out returns to its default.
	admin.expect("PUT", "/system/settings", map[string]any{"auditRetentionDays": 30}, 200, "")
	if values := admin.expect("GET", "/system/settings", nil, 200, "")["values"].(map[string]any); len(values) != 1 || values["auditRetentionDays"] != float64(30) {
		t.Errorf("after the second save = %v", values)
	}
	e := eventOf(t, auditEvents(t, admin, "?category=system"), "system_settings.update", nil)
	detail := e["detail"].(map[string]any)
	before, after := detail["before"].(map[string]any), detail["after"].(map[string]any)
	if before["exportMaxRows"] != float64(1000) || before["auditRetentionDays"] != float64(0) || before["assistantMaxToolCalls"] != float64(0) ||
		after["exportMaxRows"] != nil || after["auditRetentionDays"] != float64(30) || after["assistantMaxToolCalls"] != nil {
		t.Errorf("detail = %v", detail)
	}

	admin.expect("POST", "/users", map[string]any{"email": "bo@example.com", "displayName": "Bo", "password": "member-password"}, 201, "")
	bo := admin.signedIn("bo@example.com", "member-password")
	bo.expect("GET", "/system/settings", nil, 403, "")
	bo.expect("PUT", "/system/settings", map[string]any{"auditRetentionDays": 1}, 403, "")
}

// A query takes its rows from the settings as they are when it runs, and
// those who write queries are told what they are.
func TestQueryRowSettings(t *testing.T) {
	f := newContentFixture(t)
	rowsOf := func(limit any) (int, bool) {
		t.Helper()
		q := map[string]any{"version": 1, "dataset": f.datasetID, "dimensions": []any{map[string]any{"field": "order_date", "grain": "day", "alias": "day"}}, "measures": []any{map[string]any{"field": "revenue", "agg": "sum"}}, "params": map[string]any{"since": "2026-01-01"}}
		if limit != nil {
			q["limit"] = limit
		}
		got := f.developer.expect("POST", "/query", map[string]any{"query": q}, 200, "")
		return len(got["rows"].([]any)), got["meta"].(map[string]any)["truncated"].(bool)
	}
	told := func(wantDefault, wantMax float64) {
		t.Helper()
		rows := f.developer.expect("GET", "/auth/session", nil, 200, "")["queryRows"].(map[string]any)
		if rows["default"] != wantDefault || rows["max"] != wantMax {
			t.Errorf("the session says %v", rows)
		}
	}
	told(1000, 10000)
	if n, truncated := rowsOf(nil); n != 3 || truncated {
		t.Errorf("by default: %d rows, truncated %v", n, truncated)
	}
	f.admin.expect("PUT", "/system/settings", map[string]any{"queryDefaultRows": 1, "queryMaxRows": 2}, 200, "")
	told(1, 2)
	if n, truncated := rowsOf(nil); n != 1 || !truncated {
		t.Errorf("with a default of 1: %d rows, truncated %v", n, truncated)
	}
	// A saved limit above the most is held to it, and says so.
	if n, truncated := rowsOf(3); n != 2 || !truncated {
		t.Errorf("asking for more than the most: %d rows, truncated %v", n, truncated)
	}
	if _, signedOut := f.admin.anonymous().expect("GET", "/auth/session", nil, 200, "")["queryRows"]; signedOut {
		t.Error("told someone not signed in")
	}

	// Subtotals keep to the most, not the default: with groups left out they
	// would say nothing of what the rows add up to.
	q := map[string]any{"version": 1, "dataset": f.datasetID, "params": map[string]any{"since": "2026-01-01"}, "limit": 2, "totals": []any{[]any{"day"}},
		"dimensions": []any{map[string]any{"field": "order_date", "grain": "day", "alias": "day"}, map[string]any{"field": "region"}}, "measures": []any{map[string]any{"field": "revenue", "agg": "sum"}}}
	got := f.developer.expect("POST", "/query", map[string]any{"query": q}, 200, "")
	if rows := got["totals"].([]any)[0].(map[string]any)["rows"].([]any); len(rows) != 2 {
		t.Errorf("subtotals with a default of 1 and a most of 2: %v", rows)
	}
}

// A statement stops at the timeout as it is when it starts.
func TestQueryTimeoutSetting(t *testing.T) {
	f := newContentFixture(t)
	f.admin.expect("PUT", "/system/settings", map[string]any{"queryTimeoutSeconds": 1}, 200, "")
	slow := f.admin.spec(func(spec map[string]any) {
		spec["source"] = map[string]any{"type": "sql", "sql": fmt.Sprintf("SELECT o.*, pg_sleep(30)::text AS wait FROM %s.orders o WHERE order_date >= {{since}}", f.admin.db.Schema)}
	})
	id := f.admin.expect("POST", "/datasets", map[string]any{"name": "慢", "datasourceId": f.sourceID(t), "spec": slow}, 201, "")["id"]
	q := map[string]any{"version": 1, "dataset": id, "dimensions": []any{map[string]any{"field": "region"}}, "params": map[string]any{"since": "2026-01-01"}}
	started := time.Now()
	f.developer.expect("POST", "/query", map[string]any{"query": q}, 504, "timeout")
	if took := time.Since(started); took > 10*time.Second {
		t.Errorf("took %v, so the timeout did not apply", took)
	}
}

// A session lasts as long as the setting says, from the sign-in and from each
// time it is renewed; making that shorter ends those idle for longer.
func TestSessionLifetimeSetting(t *testing.T) {
	admin := newClient(t)
	ctx := context.Background()
	for _, email := range []string{"bo@example.com", "cy@example.com"} {
		admin.expect("POST", "/users", map[string]any{"email": email, "displayName": email, "password": "member-password"}, 201, "")
	}
	admin.expect("PUT", "/system/settings", map[string]any{"sessionLifetimeHours": 2}, 200, "")

	login, err := http.Post(admin.server.URL+"/api/v1/auth/login", "application/json", strings.NewReader(`{"email":"cy@example.com","password":"member-password"}`))
	if err != nil {
		t.Fatal(err)
	}
	login.Body.Close()
	if cookies := login.Cookies(); len(cookies) != 1 || cookies[0].MaxAge != 2*60*60 {
		t.Errorf("cookies = %v", cookies)
	}
	bo := admin.signedIn("bo@example.com", "member-password")
	left := func() time.Duration {
		t.Helper()
		var seconds float64
		if err := admin.db.Pool.QueryRow(ctx, `SELECT EXTRACT(EPOCH FROM s.expires_at - now()) FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = 'bo@example.com'`).Scan(&seconds); err != nil {
			t.Fatal(err)
		}
		return time.Duration(seconds) * time.Second
	}
	if got := left(); got <= time.Hour || got > 2*time.Hour {
		t.Errorf("the session has %v left", got)
	}

	// Renewed once it has been idle a while, by the setting as it is now. The
	// server's clock is pinned; the session was last seen well before it.
	admin.expect("PUT", "/system/settings", map[string]any{"sessionLifetimeHours": 5}, 200, "")
	if _, err := admin.db.Pool.Exec(ctx, `UPDATE sessions SET last_seen_at = '2026-01-01' WHERE user_id = (SELECT id FROM users WHERE email = 'bo@example.com')`); err != nil {
		t.Fatal(err)
	}
	bo.do("GET", "/datasets", nil)
	if got := left(); got <= 4*time.Hour || got > 5*time.Hour {
		t.Errorf("renewed for %v", got)
	}

	// Idle for three hours, which the new lifetime of two no longer allows;
	// the administrator, active just now, stays.
	if _, err := admin.db.Pool.Exec(ctx, `UPDATE sessions SET last_seen_at = now() - interval '3 hours' WHERE user_id = (SELECT id FROM users WHERE email = 'bo@example.com')`); err != nil {
		t.Fatal(err)
	}
	admin.expect("PUT", "/system/settings", map[string]any{"sessionLifetimeHours": 2}, 200, "")
	if status, _ := bo.do("GET", "/users", nil); status != http.StatusUnauthorized {
		t.Errorf("an idle session answers %d", status)
	}
	if status, _ := admin.do("GET", "/users", nil); status != http.StatusOK {
		t.Errorf("the administrator's session answers %d", status)
	}
}

// How long a deleted workspace stays follows the setting, for those deleted
// before it changed too.
func TestWorkspaceRetentionSetting(t *testing.T) {
	admin := newClient(t)
	id := admin.expect("POST", "/workspaces", map[string]any{"name": "销售部"}, 201, "")["id"].(string)
	purgeAt := func(listed []any) time.Time {
		t.Helper()
		for _, raw := range listed {
			if w := raw.(map[string]any); w["id"] == id {
				at, err := time.Parse(time.RFC3339Nano, w["purgeAt"].(string))
				if err != nil {
					t.Fatal(err)
				}
				return at
			}
		}
		t.Fatal("not listed")
		return time.Time{}
	}
	deleted := admin.expect("DELETE", "/workspaces/"+id, nil, 200, "")
	before := purgeAt([]any{deleted})
	admin.expect("PUT", "/system/settings", map[string]any{"workspaceRetentionDays": 7}, 200, "")
	_, list := admin.do("GET", "/workspaces", nil)
	if after := purgeAt(list.([]any)); before.Sub(after) != 23*24*time.Hour {
		t.Errorf("purged on %v rather than %v", after, before)
	}
	if got, err := store.SystemSettingsInForce(context.Background(), admin.db.Pool, store.DefaultOrgID); err != nil || got.WorkspaceRetention != 7*24*time.Hour {
		t.Errorf("in force: %v, %v", got.WorkspaceRetention, err)
	}
}
