package store

import (
	"context"
	"errors"
	"testing"
)

// A purge that cannot remove the export files deletes nothing, for the next
// attempt to finish; nor does one asked to wait longer than it has been.
func TestPurgeWorkspaceWaitsForFilesAndRetention(t *testing.T) {
	pool := migrated(t)
	ctx := context.Background()
	w, err := CreateWorkspace(ctx, pool, Scope{OrgID: DefaultOrgID}, Workspace{Name: "临时", Timezone: "UTC", WeekStart: 1, FirstWeekDays: 4})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO datasources (id, org_id, workspace_id, name, type) VALUES ('src_tmp', $1, $2, 'db', 'postgres')`, DefaultOrgID, w.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := DeleteWorkspace(ctx, pool, DefaultOrgID, w.ID, nil); err != nil {
		t.Fatal(err)
	}
	untouched := func(context.Context) error {
		t.Error("files removed before the workspace was due")
		return nil
	}
	if _, err := PurgeWorkspace(ctx, pool, DefaultOrgID, w.ID, DefaultSystemSettings.WorkspaceRetention, untouched); !errors.Is(err, ErrWorkspaceNotDeleted) {
		t.Errorf("purged before its time: err = %v", err)
	}
	unavailable := errors.New("storage unavailable")
	if _, err := PurgeWorkspace(ctx, pool, DefaultOrgID, w.ID, 0, func(context.Context) error { return unavailable }); !errors.Is(err, unavailable) {
		t.Errorf("err = %v, want the storage's", err)
	}
	if expired, err := ExpiredWorkspaces(ctx, pool, DefaultOrgID, 0); err != nil || len(expired) != 1 {
		t.Fatalf("after the failed purge: %v, %v", expired, err)
	}
	// The caller is told the name, and which data sources' connections to close.
	purged, err := PurgeWorkspace(ctx, pool, DefaultOrgID, w.ID, 0, func(context.Context) error { return nil })
	if err != nil || purged.Name != "临时" || len(purged.Datasources) != 1 || purged.Datasources[0] != "src_tmp" {
		t.Fatalf("purge: %+v, %v", purged, err)
	}
	if expired, err := ExpiredWorkspaces(ctx, pool, DefaultOrgID, 0); err != nil || len(expired) != 0 {
		t.Errorf("after the purge: %v, %v", expired, err)
	}
}
