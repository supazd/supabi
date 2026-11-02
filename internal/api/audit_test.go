package api

import (
	"context"
	"fmt"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/supazd/supabi/internal/api/gen"
	"github.com/supazd/supabi/internal/audit"
	"github.com/supazd/supabi/internal/store"
)

// Every operation must say what it records, so that a new one is not left
// out of the audit, and every event it names must exist.
func TestEveryOperationHasAnAuditRule(t *testing.T) {
	iface := reflect.TypeOf((*gen.StrictServerInterface)(nil)).Elem()
	defined := map[string]bool{}
	for i := range iface.NumMethod() {
		name := iface.Method(i).Name
		defined[name] = true
		rule, ok := auditRules[name]
		if !ok {
			t.Errorf("operation %s has no entry in the audit table", name)
			continue
		}
		if rule.action == "" {
			continue
		}
		if _, known := audit.CategoryOf(rule.action); !known {
			t.Errorf("operation %s records %q, which is not an audit action", name, rule.action)
		}
		if rule.object != "" && rule.from == nil {
			t.Errorf("operation %s names an object type but not where to find its ID", name)
		}
	}
	for name := range auditRules {
		if !defined[name] {
			t.Errorf("the audit table names %s, which is not an operation", name)
		}
	}
}

// auditEvents lists the events a filter selects, newest first.
func auditEvents(t *testing.T, admin *client, query string) []map[string]any {
	t.Helper()
	page := admin.expect("GET", "/audit-events"+query, nil, 200, "")
	var out []map[string]any
	for _, item := range page["items"].([]any) {
		out = append(out, item.(map[string]any))
	}
	return out
}

// eventOf is the newest event of an action that matches, or fails the test.
func eventOf(t *testing.T, events []map[string]any, action string, match func(e map[string]any) bool) map[string]any {
	t.Helper()
	for _, e := range events {
		if e["action"] == action && (match == nil || match(e)) {
			return e
		}
	}
	t.Fatalf("no %s event among %d", action, len(events))
	return nil
}

func objectName(e map[string]any) any {
	object, _ := e["object"].(map[string]any)
	return object["name"]
}

func detailOf(e map[string]any) map[string]any {
	return e["detail"].(map[string]any)
}

func TestAuditRecordsSignInsChangesAndRefusals(t *testing.T) {
	f := newContentFixture(t)
	viewerID := userID(t, f.admin, "viewer@example.com")
	all := auditEvents(t, f.admin, "")

	setup := eventOf(t, all, "auth.setup", nil)
	if setup["actor"].(map[string]any)["email"] != adminEmail || setup["outcome"] != "success" || setup["workspace"] != nil || setup["category"] != "auth" {
		t.Errorf("setup = %v", setup)
	}
	// Account events belong to no workspace, and keep what was sent, but no password.
	created := eventOf(t, all, "user.create", func(e map[string]any) bool { return objectName(e) == "viewer@example.com" })
	request := detailOf(created)["request"].(map[string]any)
	if request["password"] != "[redacted]" || request["email"] != "viewer@example.com" || created["workspace"] != nil {
		t.Errorf("user.create = %v", created)
	}
	member := eventOf(t, all, "member.add", func(e map[string]any) bool { return objectName(e) == "viewer@example.com" })
	if member["workspace"].(map[string]any)["id"] != "ws_default" || detailOf(member)["request"].(map[string]any)["role"] != "viewer" {
		t.Errorf("member.add = %v", member)
	}
	login := eventOf(t, all, "auth.login", nil)
	if login["outcome"] != "success" || login["clientIp"] != "127.0.0.1" || login["userAgent"] == "" {
		t.Errorf("login = %v", login)
	}

	// Failed sign-ins say why, which their responses do not.
	stranger := f.admin.anonymous()
	stranger.expect("POST", "/auth/login", map[string]any{"email": "viewer@example.com", "password": "not-it"}, 401, "invalid_credentials")
	stranger.expect("POST", "/auth/login", map[string]any{"email": "nobody@example.com", "password": "not-it"}, 401, "invalid_credentials")
	failed := auditEvents(t, f.admin, "?category=auth&outcome=failure")
	if len(failed) != 2 {
		t.Fatalf("%d failed sign-ins", len(failed))
	}
	if actor := failed[0]["actor"].(map[string]any); actor["email"] != "nobody@example.com" || actor["id"] != nil || detailOf(failed[0])["reason"] != "unknown_account" {
		t.Errorf("unknown account = %v", failed[0])
	}
	if actor := failed[1]["actor"].(map[string]any); actor["id"] != viewerID || detailOf(failed[1])["reason"] != "wrong_password" {
		t.Errorf("wrong password = %v", failed[1])
	}

	// A refusal by role is recorded with the role it took.
	f.viewer.expect("POST", "/datasources", f.admin.datasourceInput("x"), 403, "forbidden")
	denied := auditEvents(t, f.admin, "?outcome=denied")
	if len(denied) != 1 || denied[0]["action"] != "datasource.create" || denied[0]["actor"].(map[string]any)["id"] != viewerID ||
		detailOf(denied[0])["requiredRole"] != "developer" || denied[0]["workspace"].(map[string]any)["id"] != "ws_default" {
		t.Fatalf("denied = %v", denied)
	}

	// A change keeps the name its object had; a failed change records nothing.
	bar := `{"type":"bar","x":"month","y":["revenue"]}`
	f.developer.expect("POST", "/charts", f.chart(" ", bar), 400, "name_required")
	chartID := f.developer.expect("POST", "/charts", f.chart("月度销售额", bar), 201, "")["id"].(string)
	f.developer.editing("PUT", "/charts/"+chartID, f.chart("月度营收", bar), 200, "")
	f.developer.expect("DELETE", "/charts/"+chartID, nil, 204, "")
	content := auditEvents(t, f.admin, "?category=content&userId="+userID(t, f.admin, "developer@example.com"))
	if len(content) != 3 {
		t.Fatalf("%d content events of the developer, want create, update and delete", len(content))
	}
	if e := content[2]; e["action"] != "chart.create" || objectName(e) != "月度销售额" {
		t.Errorf("create = %v", e)
	}
	if e := content[1]; e["action"] != "chart.update" || objectName(e) != "月度营收" || detailOf(e)["previousName"] != "月度销售额" {
		t.Errorf("rename = %v", e)
	}
	if e := content[0]; e["action"] != "chart.delete" || objectName(e) != "月度营收" || e["object"].(map[string]any)["id"] != chartID {
		t.Errorf("delete = %v", e)
	}

	// Filters combine; account events are in no workspace.
	if events := auditEvents(t, f.admin, "?workspaceId=ws_default&category=account"); len(events) != 0 {
		t.Errorf("account events in a workspace: %v", events)
	}
	for _, e := range auditEvents(t, f.admin, "?userId="+viewerID) {
		if e["actor"].(map[string]any)["id"] != viewerID {
			t.Errorf("another actor's event: %v", e)
		}
	}
	// Only system administrators read the audit, and reading it is not an event.
	f.developer.expect("GET", "/audit-events", nil, 403, "forbidden")
	f.admin.expect("GET", "/audit-events?category=nope", nil, 400, "")
	if events := auditEvents(t, f.admin, "?outcome=denied"); len(events) != 1 {
		t.Errorf("%d refusals after reading the audit", len(events))
	}
}

func TestAuditRecordsWhatQueriesRead(t *testing.T) {
	f := newContentFixture(t)
	q := `{"query":{"version":1,"dataset":"` + f.datasetID + `","dimensions":[{"field":"region"}],"measures":[{"field":"revenue","agg":"sum"}],"totals":[[]]}}`
	f.developer.expect("POST", "/query", q, 200, "")
	events := auditEvents(t, f.admin, "?category=query")
	if len(events) != 1 {
		t.Fatalf("%d query events", len(events))
	}
	e := events[0]
	if e["action"] != "query.run" || e["outcome"] != "success" || e["object"].(map[string]any)["id"] != f.datasetID || objectName(e) != "订单" {
		t.Errorf("query = %v", e)
	}
	statements := detailOf(e)["statements"].([]any)
	if len(statements) != 2 {
		t.Fatalf("statements = %v, want the main query and its total", statements)
	}
	main := statements[0].(map[string]any)
	if main["kind"] != "main" || main["datasetId"] != f.datasetID || main["rows"] != float64(2) || !strings.Contains(main["sql"].(string), "orders") || len(main["args"].([]any)) == 0 {
		t.Errorf("main statement = %v", main)
	}
	if total := statements[1].(map[string]any); total["kind"] != "total" || total["rows"] != float64(1) {
		t.Errorf("total = %v", total)
	}

	// Charts are what viewers read, named by the chart.
	chartID := f.developer.expect("POST", "/charts", f.chart("月度销售额", `{"type":"bar","x":"month","y":["revenue"]}`), 201, "")["id"].(string)
	f.share(t, chartID)
	f.viewer.expect("POST", "/charts/"+chartID+"/data", nil, 200, "")
	read := auditEvents(t, f.admin, "?category=query&userId="+userID(t, f.admin, "viewer@example.com"))
	if len(read) != 1 || objectName(read[0]) != "月度销售额" || read[0]["object"].(map[string]any)["type"] != "chart" {
		t.Errorf("chart data = %v", read)
	}

	// A query the database refuses is recorded with what it said; one that
	// never reached the database is not recorded.
	sourceID := f.developer.expect("POST", "/datasources", f.admin.datasourceInput("db2"), 201, "")["id"].(string)
	f.developer.expect("POST", "/datasets/preview", map[string]any{"datasourceId": sourceID, "spec": f.admin.spec(func(s map[string]any) {
		s["fields"].([]any)[1].(map[string]any)["column"] = "amuont"
	})}, 422, "database_error")
	f.developer.expect("POST", "/query", `{"query":{"version":1,"dataset":"","measures":[]}}`, 400, "")
	failed := auditEvents(t, f.admin, "?category=query&outcome=failure")
	if len(failed) != 1 || failed[0]["object"].(map[string]any)["id"] != sourceID {
		t.Fatalf("failed queries = %v", failed)
	}
	if st := detailOf(failed[0])["statements"].([]any)[0].(map[string]any); !strings.Contains(fmt.Sprint(st["error"]), "amuont") {
		t.Errorf("failed statement = %v", st)
	}
	// Viewers do not query datasets, and trying is recorded.
	f.viewer.expect("POST", "/query", q, 403, "forbidden")
	if denied := auditEvents(t, f.admin, "?category=query&outcome=denied"); len(denied) != 1 {
		t.Errorf("denied queries = %v", denied)
	}
}

func TestAuditRecordsExports(t *testing.T) {
	c := newClient(t)
	w := testExportWorker(c)
	sourceID := c.expect("POST", "/datasources", c.datasourceInput("db"), 201, "")["id"].(string)
	id := queueExport(c, sourceID, "csv", "SELECT 1 AS n")
	processExport(t, w)
	downloadCSV(t, c, id)
	events := auditEvents(t, c, "?category=export")
	if len(events) != 3 {
		t.Fatalf("%d export events, want create, finish and download", len(events))
	}
	if e := events[2]; e["action"] != "export.create" || detailOf(e)["sql"] != "SELECT 1 AS n" || detailOf(e)["datasourceId"] != sourceID || objectName(e) != "中文导出" {
		t.Errorf("create = %v", e)
	}
	// The worker records the finish as the owner's.
	if e := events[1]; e["action"] != "export.finish" || e["outcome"] != "success" || detailOf(e)["rows"] != float64(1) ||
		e["actor"].(map[string]any)["email"] != adminEmail || e["workspace"].(map[string]any)["id"] != "ws_default" || e["clientIp"] != "" {
		t.Errorf("finish = %v", e)
	}
	if e := events[0]; e["action"] != "export.download" || e["outcome"] != "success" || detailOf(e)["bytes"] == float64(0) {
		t.Errorf("download = %v", e)
	}
}

func TestAuditPages(t *testing.T) {
	c := newClient(t)
	ctx := context.Background()
	recorder := store.AuditEvents{Pool: c.db.Pool}
	// Events at the same moment are told apart by their IDs.
	at := time.Date(2026, 1, 1, 8, 0, 0, 0, time.UTC)
	for i := range 60 {
		e := audit.Event{OrgID: store.DefaultOrgID, At: at.Add(time.Duration(i/2) * time.Minute), Action: "folder.create", Outcome: audit.Success, Object: audit.Object{Type: "folder", ID: fmt.Sprint(i)}}
		if err := recorder.Record(ctx, e); err != nil {
			t.Fatal(err)
		}
	}
	seen := map[any]bool{}
	page := c.expect("GET", "/audit-events?category=content", nil, 200, "")
	for _, query := range []string{"", "next"} {
		if query == "next" {
			page = c.expect("GET", "/audit-events?category=content&cursor="+url.QueryEscape(page["nextCursor"].(string)), nil, 200, "")
		}
		for _, item := range page["items"].([]any) {
			id := item.(map[string]any)["object"].(map[string]any)["id"]
			if seen[id] {
				t.Fatalf("event %v on two pages", id)
			}
			seen[id] = true
		}
	}
	if len(seen) != 60 || page["nextCursor"] != nil {
		t.Fatalf("%d events over two pages; next %v", len(seen), page["nextCursor"])
	}
	// From is inclusive, to exclusive: ten minutes hold twenty events.
	window := "&from=" + url.QueryEscape(at.Add(10*time.Minute).Format(time.RFC3339)) + "&to=" + url.QueryEscape(at.Add(20*time.Minute).Format(time.RFC3339))
	if events := auditEvents(t, c, "?category=content"+window); len(events) != 20 {
		t.Errorf("%d events in ten minutes", len(events))
	}
	c.expect("GET", "/audit-events?cursor=nope", nil, 400, "invalid_cursor")
}

func TestMaintenanceRemovesWhatHasOutlivedItsUse(t *testing.T) {
	c := newClient(t)
	w := testExportWorker(c)
	ctx := context.Background()
	pool := c.db.Pool
	days := 30
	if err := store.SetSystemSettings(ctx, pool, store.Scope{OrgID: store.DefaultOrgID}, store.SystemSettingValues{AuditRetentionDays: &days}); err != nil {
		t.Fatal(err)
	}
	adminID := userID(t, c, adminEmail)
	if _, err := pool.Exec(ctx, `INSERT INTO sessions(token_hash,org_id,user_id,expires_at) VALUES('\x01',$1,$2,now()-interval '1 hour')`, store.DefaultOrgID, adminID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO background_jobs(id,org_id,kind,status,finished_at) VALUES('job_old',$1,'maintenance','succeeded',now()-interval '8 days')`, store.DefaultOrgID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO login_throttle VALUES($1,'stale@example.com',3,now()-interval '25 hours'),($1,'recent@example.com',3,now())`, store.DefaultOrgID); err != nil {
		t.Fatal(err)
	}
	recorder := store.AuditEvents{Pool: pool}
	for _, age := range []time.Duration{31 * 24 * time.Hour, 29 * 24 * time.Hour} {
		if err := recorder.Record(ctx, audit.Event{OrgID: store.DefaultOrgID, At: time.Now().Add(-age), Action: "folder.delete", Outcome: audit.Success}); err != nil {
			t.Fatal(err)
		}
	}
	// What calls to models cost is kept as long as audit events.
	usage := func(age time.Duration) {
		t.Helper()
		if _, err := pool.Exec(ctx, `INSERT INTO ai_usage (id, org_id, purpose, provider, model, currency, outcome, created_at) VALUES ($1, $2, 'chat', 'P', 'm', 'USD', 'success', $3)`,
			"aiu_"+age.String(), store.DefaultOrgID, time.Now().Add(-age)); err != nil {
			t.Fatal(err)
		}
	}
	usage(31 * 24 * time.Hour)
	usage(29 * 24 * time.Hour)
	// One job an hour, however many schedulers ask.
	hour := time.Now().Truncate(time.Hour)
	for _, at := range []time.Time{hour, hour.Add(time.Minute), hour.Add(59 * time.Minute)} {
		if err := store.EnqueueMaintenance(ctx, pool, at); err != nil {
			t.Fatal(err)
		}
	}
	job := processExport(t, w)
	if job.Kind != "maintenance" {
		t.Fatalf("claimed %s", job.Kind)
	}
	count := func(sql string, args ...any) (n int) {
		t.Helper()
		if err := pool.QueryRow(ctx, sql, args...).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	if n := count(`SELECT count(*) FROM background_jobs WHERE kind='maintenance' AND status='succeeded'`); n != 1 {
		t.Errorf("%d finished maintenance jobs, want this hour's alone", n)
	}
	if n := count(`SELECT count(*) FROM sessions WHERE expires_at<now()`); n != 0 {
		t.Errorf("%d expired sessions remain", n)
	}
	c.expect("GET", "/datasets", nil, 200, "") // the live session stays
	if n := count(`SELECT count(*) FROM login_throttle`); n != 1 {
		t.Errorf("%d counts of failed sign-ins remain of one stale and one recent", n)
	}
	if n := count(`SELECT count(*) FROM audit_events WHERE action='folder.delete'`); n != 1 {
		t.Errorf("%d events remain of one too old and one recent", n)
	}
	if n := count(`SELECT count(*) FROM ai_usage`); n != 1 {
		t.Errorf("%d records of calls to models remain of one too old and one recent", n)
	}
	// With no retention, events are kept.
	days = 0
	if err := store.SetSystemSettings(ctx, pool, store.Scope{OrgID: store.DefaultOrgID}, store.SystemSettingValues{AuditRetentionDays: &days}); err != nil {
		t.Fatal(err)
	}
	if err := recorder.Record(ctx, audit.Event{OrgID: store.DefaultOrgID, At: time.Now().AddDate(-3, 0, 0), Action: "folder.delete", Outcome: audit.Success}); err != nil {
		t.Fatal(err)
	}
	usage(3 * 365 * 24 * time.Hour)
	if err := store.EnqueueMaintenance(ctx, pool, hour.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	processExport(t, w)
	if n := count(`SELECT count(*) FROM audit_events WHERE action='folder.delete'`); n != 2 {
		t.Errorf("%d events kept without a retention", n)
	}
	if n := count(`SELECT count(*) FROM ai_usage`); n != 2 {
		t.Errorf("%d records of calls to models kept without a retention", n)
	}
}
