package api

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/supazd/supabi/internal/blob"
	"github.com/supazd/supabi/internal/blob/blobtest"
	"github.com/supazd/supabi/internal/store"
	"github.com/supazd/supabi/internal/worker"
)

// workspaceRows counts, for every table with a workspace_id, the rows of the
// workspace. Audit events are left out: they outlive the workspace.
func workspaceRows(t *testing.T, c *client, workspaceID string) map[string]int {
	t.Helper()
	ctx := context.Background()
	// The audit log and what the assistant's calls cost are the organization's
	// record: they outlive the workspace.
	rows, err := c.db.Pool.Query(ctx, `SELECT table_name FROM information_schema.columns
		WHERE table_schema = current_schema() AND column_name = 'workspace_id' AND table_name NOT IN ('audit_events', 'ai_usage')`)
	if err != nil {
		t.Fatal(err)
	}
	tables, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		t.Fatal(err)
	}
	counts := map[string]int{}
	for _, table := range tables {
		var n int
		if err := c.db.Pool.QueryRow(ctx, `SELECT count(*) FROM `+pgx.Identifier{table}.Sanitize()+` WHERE workspace_id = $1`, workspaceID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		counts[table] = n
	}
	return counts
}

// workspaceFixture is a workspace with one of everything a workspace holds,
// and a viewer who belongs to no other.
type workspaceFixture struct {
	admin, viewer     *client
	worker            *worker.Worker
	files             blob.Store
	id                string
	datasetID, queued string
	exportIDs         []string
}

// newWorkspaceFixture keeps export files in files, or in the data directory without.
func newWorkspaceFixture(t *testing.T, files blob.Store) *workspaceFixture {
	t.Helper()
	admin := newClient(t)
	if files == nil {
		files = blob.NewLocal(filepath.Join(admin.dataDir, "exports"))
	}
	w := testExportWorkerWith(admin, files)
	// Something in the default workspace, which deleting another must leave alone.
	admin.expect("POST", "/datasources", admin.datasourceInput("db"), 201, "")
	id := admin.expect("POST", "/workspaces", map[string]any{"name": "销售部"}, 201, "")["id"].(string)
	admin.expect("POST", "/auth/workspace", map[string]any{"workspaceId": id}, 200, "")

	admin.expect("POST", "/users", map[string]any{"email": "mia@example.com", "displayName": "Mia", "password": memberPassword}, 201, "")
	admin.expect("POST", "/members", map[string]any{"userId": userID(t, admin, "mia@example.com"), "role": "viewer"}, 201, "")
	viewer := admin.signedIn("mia@example.com", memberPassword)

	sourceID := admin.expect("POST", "/datasources", admin.datasourceInput("db"), 201, "")["id"].(string)
	datasetID := admin.expect("POST", "/datasets", map[string]any{"name": "订单", "datasourceId": sourceID, "spec": admin.spec(nil)}, 201, "")["id"].(string)
	admin.expect("PUT", "/datasets/"+datasetID+"/policy", map[string]any{"unmatched": "all", "rows": []any{}, "columns": []any{map[string]any{"fields": []string{"amount"}, "visibleTo": []any{}}}}, 200, "")
	admin.expect("PUT", "/user-attributes/regions", map[string]any{"name": "大区", "assignments": []any{}}, 200, "")
	f := &contentFixture{admin: admin, developer: admin, datasetID: datasetID}
	chartID := admin.expect("POST", "/charts", f.chart("按月", `{"type":"table"}`), 201, "")["id"].(string)
	folderID := admin.expect("POST", "/folders", map[string]any{"kind": "chart", "name": "销售"}, 201, "")["id"].(string)
	admin.expect("POST", "/folders", map[string]any{"kind": "chart", "name": "华东", "parentId": folderID}, 201, "")
	admin.expect("POST", "/folders/move", map[string]any{"kind": "chart", "id": chartID, "folderId": folderID}, 204, "")
	board := admin.expect("POST", "/dashboards", map[string]any{"name": "经营", "spec": dashboardSpec(chartID)}, 201, "")["id"].(string)
	admin.expect("PUT", "/dashboards/"+board+"/grants", map[string]any{"subjects": []any{map[string]any{"everyone": true}}}, 200, "")
	viewer.expect("POST", "/dashboards/"+board+"/views", map[string]any{"state": map[string]any{"filters": map[string]any{"g": []any{"华东"}}}, "validDays": 7}, 201, "")
	viewer.expect("POST", "/assistant/conversations", nil, 201, "")

	finished := queueExport(admin, sourceID, "csv", "SELECT 1 AS n")
	processExport(t, w)
	queued := queueExport(admin, sourceID, "csv", "SELECT 2 AS n")

	// Every table that holds a workspace's rows holds some of this one's, so
	// the purge below is tried on all of them.
	for table, n := range workspaceRows(t, admin, id) {
		if n == 0 {
			t.Errorf("the fixture has no rows in %s", table)
		}
	}
	return &workspaceFixture{admin: admin, viewer: viewer, worker: w, files: files, id: id, datasetID: datasetID, queued: queued, exportIDs: []string{finished, queued}}
}

func (f *workspaceFixture) count(t *testing.T, query string, args ...any) int {
	t.Helper()
	var n int
	if err := f.admin.db.Pool.QueryRow(context.Background(), query, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// exportFiles lists the files kept for the workspace's exports.
func (f *workspaceFixture) exportFiles(t *testing.T) []string {
	t.Helper()
	return blobtest.Keys(t, f.files, store.DefaultOrgID+"/"+f.id+"/")
}

func (f *workspaceFixture) workspace(t *testing.T) map[string]any {
	t.Helper()
	_, list := f.admin.do("GET", "/workspaces", nil)
	for _, item := range list.([]any) {
		if w := item.(map[string]any); w["id"] == f.id {
			return w
		}
	}
	return nil
}

func sessionWorkspace(c *client) any {
	return c.expect("GET", "/auth/session", nil, 200, "")["workspace"]
}

func TestDeletingAndRestoringAWorkspace(t *testing.T) {
	f := newWorkspaceFixture(t, nil)
	admin, viewer := f.admin, f.viewer

	// The admin also has the workspace open in another browser.
	elsewhere := admin.signedIn(adminEmail, adminPassword)
	elsewhere.expect("POST", "/auth/workspace", map[string]any{"workspaceId": f.id}, 200, "")

	viewer.expect("DELETE", "/workspaces/"+f.id, nil, 403, "forbidden")
	admin.expect("DELETE", "/workspaces/ws_nope", nil, 404, "not_found")
	deleted := admin.expect("DELETE", "/workspaces/"+f.id, nil, 200, "")
	deletedAt, _ := time.Parse(time.RFC3339Nano, deleted["deletedAt"].(string))
	purgeAt, _ := time.Parse(time.RFC3339Nano, deleted["purgeAt"].(string))
	if purgeAt.Sub(deletedAt) != 30*24*time.Hour {
		t.Errorf("deleted = %v", deleted)
	}
	admin.expect("DELETE", "/workspaces/"+f.id, nil, 409, "workspace_deleted")

	// Nobody is in it any more. The session that deleted it moves to the
	// workspace left, as a switch would. The others are left in none, even
	// where their user has another workspace: a page still open in them
	// must fail rather than save into a workspace nobody chose.
	if ws := sessionWorkspace(admin).(map[string]any); ws["id"] != store.DefaultWorkspaceID {
		t.Errorf("the deleting session is in %v", ws)
	}
	if ws := sessionWorkspace(viewer); ws != nil {
		t.Errorf("the viewer's session is in %v", ws)
	}
	viewer.expect("GET", "/dashboards", nil, 403, "no_workspace")
	session := elsewhere.expect("GET", "/auth/session", nil, 200, "")
	if offered := session["workspaces"].([]any); session["workspace"] != nil || len(offered) != 1 || offered[0].(map[string]any)["id"] != store.DefaultWorkspaceID {
		t.Errorf("the admin's other session: %v", session)
	}
	elsewhere.expect("POST", "/datasources", admin.datasourceInput("db2"), 403, "no_workspace")
	elsewhere.expect("POST", "/auth/workspace", map[string]any{"workspaceId": store.DefaultWorkspaceID}, 200, "")
	viewer.expect("POST", "/auth/workspace", map[string]any{"workspaceId": f.id}, 404, "not_found")
	admin.expect("POST", "/auth/workspace", map[string]any{"workspaceId": f.id}, 404, "not_found")
	if _, list := viewer.do("GET", "/workspaces", nil); len(list.([]any)) != 0 {
		t.Errorf("the viewer is offered %v", list)
	}
	// Only the system admin's list shows it, to restore or purge.
	if w := f.workspace(t); w == nil || w["deletedAt"] == nil {
		t.Errorf("the admin's list shows %v", w)
	}
	// A request that read the session before the deletion finds no workspace either.
	if _, err := admin.db.Pool.Exec(context.Background(), `UPDATE sessions SET workspace_id = $1 WHERE user_id = $2`, f.id, userID(t, admin, "mia@example.com")); err != nil {
		t.Fatal(err)
	}
	viewer.expect("GET", "/dashboards", nil, 403, "no_workspace")
	if _, err := admin.db.Pool.Exec(context.Background(), `UPDATE sessions SET workspace_id = NULL WHERE user_id = $1`, userID(t, admin, "mia@example.com")); err != nil {
		t.Fatal(err)
	}

	// Its exports stop; the finished one stays until the purge.
	if n := f.count(t, `SELECT count(*) FROM background_jobs WHERE id = $1 AND status = 'cancelled'`, f.queued); n != 1 {
		t.Error("the queued export was not cancelled")
	}
	// Its name stays taken until then.
	admin.expect("POST", "/workspaces", map[string]any{"name": "销售部"}, 409, "workspace_name_deleted")
	admin.expect("PUT", "/workspace", map[string]any{"name": "销售部"}, 409, "workspace_name_deleted")

	// Restoring puts it back as it was.
	if restored := admin.expect("POST", "/workspaces/"+f.id+"/restore", nil, 200, ""); restored["deletedAt"] != nil || restored["purgeAt"] != nil {
		t.Errorf("restored = %v", restored)
	}
	admin.expect("POST", "/workspaces/"+f.id+"/restore", nil, 409, "workspace_not_deleted")
	// Only a deleted workspace is purged.
	admin.expect("POST", "/workspaces/"+f.id+"/purge", nil, 409, "workspace_not_deleted")
	// The viewer, moved to no workspace, is offered it again and enters it.
	session = viewer.expect("GET", "/auth/session", nil, 200, "")
	if offered := session["workspaces"].([]any); session["workspace"] != nil || len(offered) != 1 || offered[0].(map[string]any)["id"] != f.id {
		t.Errorf("after restoring, the viewer's session: %v", session)
	}
	viewer.expect("POST", "/auth/workspace", map[string]any{"workspaceId": f.id}, 200, "")
	if _, list := viewer.do("GET", "/dashboards", nil); len(list.([]any)) != 1 {
		t.Errorf("after restoring, the viewer sees %v", list)
	}
	if got := workspaceRows(t, admin, f.id); got["charts"] != 1 || got["datasets"] != 1 || got["user_attributes"] != 1 {
		t.Errorf("after restoring: %v", got)
	}

	events := f.count(t, `SELECT count(*) FROM audit_events WHERE object_type = 'workspace' AND object_id = $1 AND object_name = '销售部'
		AND action IN ('workspace.delete', 'workspace.restore') AND actor_id = $2 AND workspace_id = $1`, f.id, userID(t, admin, adminEmail))
	if events != 2 {
		t.Errorf("%d delete and restore events, want 2", events)
	}
}

func TestPurgingAWorkspace(t *testing.T) {
	blobtest.Each(t, testPurgingAWorkspace)
}

func testPurgingAWorkspace(t *testing.T, files blob.Store) {
	f := newWorkspaceFixture(t, files)
	admin := f.admin
	if len(f.exportFiles(t)) == 0 {
		t.Fatal("the fixture's export left no file")
	}
	admin.expect("DELETE", "/workspaces/"+f.id, nil, 200, "")
	f.viewer.expect("POST", "/workspaces/"+f.id+"/purge", nil, 403, "forbidden")
	admin.expect("POST", "/workspaces/"+f.id+"/purge", nil, 204, "")
	admin.expect("POST", "/workspaces/"+f.id+"/purge", nil, 404, "not_found")
	admin.expect("POST", "/workspaces/"+f.id+"/restore", nil, 404, "not_found")

	for table, n := range workspaceRows(t, admin, f.id) {
		if n != 0 {
			t.Errorf("%d rows left in %s", n, table)
		}
	}
	if n := f.count(t, `SELECT count(*) FROM workspaces WHERE id = $1`, f.id); n != 0 {
		t.Error("the workspace is still there")
	}
	if n := f.count(t, `SELECT count(*) FROM dataset_revisions WHERE dataset_id = $1`, f.datasetID); n != 0 {
		t.Errorf("%d dataset revisions left", n)
	}
	if n := f.count(t, `SELECT count(*) FROM background_jobs WHERE id = ANY($1)`, f.exportIDs); n != 0 {
		t.Errorf("%d export jobs left", n)
	}
	if files := f.exportFiles(t); len(files) != 0 {
		t.Errorf("export files left: %v", files)
	}
	// Accounts belong to the org, and other workspaces keep what they hold.
	if n := f.count(t, `SELECT count(*) FROM users WHERE email = 'mia@example.com'`); n != 1 {
		t.Error("the viewer's account went with the workspace")
	}
	if _, list := admin.do("GET", "/datasources", nil); len(list.([]any)) != 1 {
		t.Errorf("the default workspace's data sources: %v", list)
	}
	// Its name is free again.
	admin.expect("POST", "/workspaces", map[string]any{"name": "销售部"}, 201, "")

	if n := f.count(t, `SELECT count(*) FROM audit_events WHERE action = 'workspace.purge' AND object_id = $1 AND object_name = '销售部' AND actor_id = $2`,
		f.id, userID(t, admin, adminEmail)); n != 1 {
		t.Errorf("%d purge events, want 1", n)
	}
}

func TestMaintenancePurgesWorkspacesDeletedThirtyDaysAgo(t *testing.T) {
	f := newWorkspaceFixture(t, nil)
	admin := f.admin
	recent := admin.expect("POST", "/workspaces", map[string]any{"name": "近期"}, 201, "")["id"].(string)
	admin.expect("DELETE", "/workspaces/"+f.id, nil, 200, "")
	admin.expect("DELETE", "/workspaces/"+recent, nil, 200, "")
	ctx := context.Background()
	backdate := func(id string, ago time.Duration) {
		t.Helper()
		if _, err := admin.db.Pool.Exec(ctx, `UPDATE workspaces SET deleted_at = now() - $2 * interval '1 second' WHERE id = $1`, id, ago.Seconds()); err != nil {
			t.Fatal(err)
		}
	}
	backdate(f.id, store.DefaultSystemSettings.WorkspaceRetention+time.Minute)
	backdate(recent, store.DefaultSystemSettings.WorkspaceRetention-time.Hour)

	if err := store.EnqueueMaintenance(ctx, admin.db.Pool, time.Now()); err != nil {
		t.Fatal(err)
	}
	if j := processExport(t, f.worker); j.Kind != "maintenance" {
		t.Fatalf("processed a %s job", j.Kind)
	}
	if n := f.count(t, `SELECT count(*) FROM workspaces WHERE id = $1`, f.id); n != 0 {
		t.Error("the workspace deleted 30 days ago was not purged")
	}
	if files := f.exportFiles(t); len(files) != 0 {
		t.Errorf("export files left: %v", files)
	}
	if w := f.workspace(t); w != nil {
		t.Errorf("still listed: %v", w)
	}
	if n := f.count(t, `SELECT count(*) FROM workspaces WHERE id = $1 AND deleted_at IS NOT NULL`, recent); n != 1 {
		t.Error("a workspace deleted less than 30 days ago was purged")
	}

	// Fewer days to keep them applies to the next maintenance.
	admin.expect("PUT", "/system/settings", map[string]any{"workspaceRetentionDays": 7}, 200, "")
	backdate(recent, 8*24*time.Hour)
	if err := store.EnqueueMaintenance(ctx, admin.db.Pool, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if j := processExport(t, f.worker); j.Kind != "maintenance" {
		t.Fatalf("processed a %s job", j.Kind)
	}
	if n := f.count(t, `SELECT count(*) FROM workspaces WHERE id = $1`, recent); n != 0 {
		t.Error("a workspace deleted more than the 7 days now kept was not purged")
	}
	// Nobody purged it at the time: the event has no actor.
	if n := f.count(t, `SELECT count(*) FROM audit_events WHERE action = 'workspace.purge' AND object_id = $1 AND object_name = '销售部' AND actor_id = ''`, f.id); n != 1 {
		t.Errorf("%d purge events without an actor, want 1", n)
	}
}
