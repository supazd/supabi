package store

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/supazd/supabi/internal/authz"
)

func migrated(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool := newTestPool(t)
	ctx := context.Background()
	if _, err := Migrate(ctx, pool, CoreMigrations()); err != nil {
		t.Fatal(err)
	}
	if err := Bootstrap(ctx, pool); err != nil {
		t.Fatal(err)
	}
	return pool
}

func TestCreateFirstAdminHappensOnce(t *testing.T) {
	pool := migrated(t)
	ctx := context.Background()
	if has, err := HasUsers(ctx, pool, DefaultOrgID); err != nil || has {
		t.Fatalf("HasUsers = %v, %v before setup", has, err)
	}

	// Several browsers finishing the setup form at the same moment.
	const attempts = 8
	var wg sync.WaitGroup
	errs := make([]error, attempts)
	for i := range attempts {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, errs[i] = CreateFirstAdmin(ctx, pool, DefaultOrgID, User{Email: "a@example.com", DisplayName: "A", PasswordHash: "h"})
		}()
	}
	wg.Wait()
	succeeded := 0
	for _, err := range errs {
		switch {
		case err == nil:
			succeeded++
		case !errors.Is(err, ErrConflict):
			t.Errorf("unexpected error: %v", err)
		}
	}
	if succeeded != 1 {
		t.Fatalf("%d setups succeeded, want exactly 1", succeeded)
	}

	admin, err := GetUserByEmail(ctx, pool, DefaultOrgID, "A@Example.com")
	if err != nil || !admin.IsOrgAdmin || admin.PasswordHash != "h" {
		t.Fatalf("admin = %+v, %v", admin, err)
	}
	members, err := ListMembers(ctx, pool, Scope{OrgID: DefaultOrgID, WorkspaceID: DefaultWorkspaceID})
	if err != nil || len(members) != 1 || members[0].Role != authz.Admin {
		t.Fatalf("members = %+v, %v", members, err)
	}
}

func TestSessionsAndRoles(t *testing.T) {
	pool := migrated(t)
	ctx := context.Background()
	scope := Scope{OrgID: DefaultOrgID, WorkspaceID: DefaultWorkspaceID}
	if _, err := CreateFirstAdmin(ctx, pool, DefaultOrgID, User{Email: "admin@example.com", DisplayName: "Admin", PasswordHash: "h"}); err != nil {
		t.Fatal(err)
	}
	created, err := CreateUser(ctx, pool, scope.OrgID, User{Email: "v@example.com", DisplayName: "V", PasswordHash: "h"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := CreateUser(ctx, pool, scope.OrgID, User{Email: "V@example.com", DisplayName: "dup", PasswordHash: "h"}); !errors.Is(err, ErrConflict) {
		t.Errorf("duplicate email: err = %v, want ErrConflict", err)
	}
	if _, err := AddMember(ctx, pool, scope, created.ID, authz.Viewer); err != nil {
		t.Fatal(err)
	}
	viewer := Member{UserID: created.ID}
	user := User{ID: viewer.UserID, OrgID: DefaultOrgID}

	token := []byte("token-hash-1")
	if err := CreateSession(ctx, pool, user, token, time.Hour); err != nil {
		t.Fatal(err)
	}
	p, err := GetPrincipal(ctx, pool, token)
	if err != nil || p.UserID != viewer.UserID || p.WorkspaceID != DefaultWorkspaceID || p.Email != "v@example.com" {
		t.Fatalf("principal = %+v, %v", p, err)
	}
	if left := time.Until(p.ExpiresAt); left < 59*time.Minute || left > 61*time.Minute {
		t.Errorf("session expires in %v, want about an hour", left)
	}
	if _, err := GetPrincipal(ctx, pool, []byte("unknown")); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown token: err = %v", err)
	}

	if role, err := WorkspaceRole(ctx, pool, p); err != nil || role != authz.Viewer {
		t.Errorf("viewer role = %q, %v", role, err)
	}
	// A higher role held through a group wins over the one held directly.
	for _, stmt := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO user_groups (id, org_id, name) VALUES ('grp_1', $1, 'analysts')`, []any{DefaultOrgID}},
		{`INSERT INTO user_group_members (org_id, group_id, user_id) VALUES ($1, 'grp_1', $2)`, []any{DefaultOrgID, viewer.UserID}},
		{`INSERT INTO workspace_members (id, org_id, workspace_id, group_id, role) VALUES ('wm_g', $1, $2, 'grp_1', 'developer')`,
			[]any{DefaultOrgID, DefaultWorkspaceID}},
	} {
		if _, err := pool.Exec(ctx, stmt.sql, stmt.args...); err != nil {
			t.Fatal(err)
		}
	}
	if role, _ := WorkspaceRole(ctx, pool, p); role != authz.Developer {
		t.Errorf("role with a group role = %q", role)
	}
	if role, _ := WorkspaceRole(ctx, pool, Principal{IsOrgAdmin: true, WorkspaceID: DefaultWorkspaceID}); role != authz.Admin {
		t.Errorf("org admin role = %q", role)
	}
	if role, _ := WorkspaceRole(ctx, pool, Principal{IsOrgAdmin: true}); role != "" {
		t.Errorf("org admin role outside a workspace = %q", role)
	}
	if role, _ := WorkspaceRole(ctx, pool, Principal{OrgID: DefaultOrgID, UserID: viewer.UserID}); role != "" {
		t.Errorf("role without a workspace = %q", role)
	}

	// An expired session is as good as none, and is cleaned up at the next sign-in.
	if _, err := pool.Exec(ctx, `UPDATE sessions SET expires_at = now() - interval '1 second' WHERE token_hash = $1`, token); err != nil {
		t.Fatal(err)
	}
	if _, err := GetPrincipal(ctx, pool, token); !errors.Is(err, ErrNotFound) {
		t.Errorf("expired session: err = %v", err)
	}
	second := []byte("token-hash-2")
	if err := CreateSession(ctx, pool, user, second, time.Hour); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM sessions WHERE user_id = $1`, viewer.UserID).Scan(&count); err != nil || count != 1 {
		t.Errorf("sessions after signing in again = %d, %v; want 1", count, err)
	}

	// Changing the password keeps the session that did it and ends the others.
	third := []byte("token-hash-3")
	if err := CreateSession(ctx, pool, user, third, time.Hour); err != nil {
		t.Fatal(err)
	}
	if err := SetPassword(ctx, pool, DefaultOrgID, viewer.UserID, "new-hash", third); err != nil {
		t.Fatal(err)
	}
	if _, err := GetPrincipal(ctx, pool, second); !errors.Is(err, ErrNotFound) {
		t.Error("another session survived a password change")
	}
	if _, err := GetPrincipal(ctx, pool, third); err != nil {
		t.Errorf("the session that changed the password was ended: %v", err)
	}

	// Disabling a user ends their sessions and blocks new ones from resolving.
	disabled := UserDisabled
	if _, _, err := UpdateUser(ctx, pool, DefaultOrgID, viewer.UserID, UserChange{Status: &disabled}); err != nil {
		t.Fatal(err)
	}
	if _, err := GetPrincipal(ctx, pool, third); !errors.Is(err, ErrNotFound) {
		t.Error("a disabled user's session still resolves")
	}
	if err := CreateSession(ctx, pool, user, []byte("token-hash-4"), time.Hour); err != nil {
		t.Fatal(err)
	}
	if _, err := GetPrincipal(ctx, pool, []byte("token-hash-4")); !errors.Is(err, ErrNotFound) {
		t.Error("a disabled user can resolve a new session")
	}

	changed, err := SetMemberRole(ctx, pool, scope, viewer.UserID, authz.Admin)
	if err != nil || changed.Role != authz.Admin || changed.Status != UserDisabled {
		t.Errorf("after role change: %+v, %v", changed, err)
	}
	if _, err := SetMemberRole(ctx, pool, scope, viewer.UserID, "owner"); err == nil {
		t.Error("a role that does not exist was stored")
	}
	if _, err := SetMemberRole(ctx, pool, scope, "user_nope", authz.Admin); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown member: err = %v", err)
	}
}

func TestWorkspacesGroupsAndRoles(t *testing.T) {
	pool := migrated(t)
	ctx := context.Background()
	scope := Scope{OrgID: DefaultOrgID, WorkspaceID: DefaultWorkspaceID}
	admin, err := CreateFirstAdmin(ctx, pool, DefaultOrgID, User{Email: "admin@example.com", DisplayName: "Admin", PasswordHash: "h"})
	if err != nil {
		t.Fatal(err)
	}
	member, err := CreateUser(ctx, pool, scope.OrgID, User{Email: "m@example.com", DisplayName: "M", PasswordHash: "h"})
	if err != nil {
		t.Fatal(err)
	}
	names := func(userID string) string {
		list, err := ListWorkspaces(ctx, pool, DefaultOrgID, userID, false)
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, w := range list {
			out = append(out, w.Name)
		}
		return strings.Join(out, ",")
	}
	second, err := CreateWorkspace(ctx, pool, Scope{OrgID: DefaultOrgID, UserID: admin.ID}, Workspace{Name: "Second", Timezone: "UTC", WeekStart: 1, FirstWeekDays: 4})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := CreateWorkspace(ctx, pool, scope, Workspace{Name: "Second", Timezone: "UTC", WeekStart: 1, FirstWeekDays: 4}); !errors.Is(err, ErrConflict) {
		t.Errorf("duplicate workspace name: err = %v", err)
	}

	// An administrator sees every workspace; a user only those they belong to.
	if got := names(admin.ID); got != "Default,Second" {
		t.Errorf("admin workspaces = %s", got)
	}
	if got := names(member.ID); got != "" {
		t.Errorf("workspaces of a user who belongs nowhere = %s", got)
	}

	// Membership through a group counts, and so does switching by it.
	group, err := SaveGroup(ctx, pool, DefaultOrgID, Group{Name: "analysts", UserIDs: []string{member.ID}})
	if err != nil {
		t.Fatal(err)
	}
	secondScope := Scope{OrgID: DefaultOrgID, WorkspaceID: second.ID}
	if err := SetGroupRole(ctx, pool, secondScope, group.ID, authz.Viewer); err != nil {
		t.Fatal(err)
	}
	if err := SetGroupRole(ctx, pool, secondScope, group.ID, authz.Developer); err != nil {
		t.Fatal(err)
	}
	grants, err := ListGroupGrants(ctx, pool, secondScope)
	if err != nil || len(grants) != 1 || grants[0].Role != authz.Developer {
		t.Errorf("grants = %+v, %v", grants, err)
	}
	if got := names(member.ID); got != "Second" {
		t.Errorf("workspaces through a group = %s", got)
	}

	token := []byte("t1")
	if err := CreateSession(ctx, pool, member, token, time.Hour); err != nil {
		t.Fatal(err)
	}
	if p, _ := GetPrincipal(ctx, pool, token); p.WorkspaceID != second.ID {
		t.Errorf("a new session starts in %q, want the only workspace the user can enter", p.WorkspaceID)
	}
	if err := SwitchWorkspace(ctx, pool, token, DefaultWorkspaceID); !errors.Is(err, ErrNotFound) {
		t.Errorf("switching to a workspace the user cannot enter: err = %v", err)
	}
	if err := SwitchWorkspace(ctx, pool, token, "ws_nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("switching to a workspace that does not exist: err = %v", err)
	}
	if _, err := AddMember(ctx, pool, scope, member.ID, authz.Viewer); err != nil {
		t.Fatal(err)
	}
	if _, err := AddMember(ctx, pool, scope, member.ID, authz.Viewer); !errors.Is(err, ErrConflict) {
		t.Errorf("adding a member twice: err = %v", err)
	}
	if err := SwitchWorkspace(ctx, pool, token, DefaultWorkspaceID); err != nil {
		t.Fatal(err)
	}
	if p, _ := GetPrincipal(ctx, pool, token); p.WorkspaceID != DefaultWorkspaceID {
		t.Errorf("after switching the session is in %q", p.WorkspaceID)
	}

	// Emptying the group takes away what it granted.
	if _, err := SaveGroup(ctx, pool, DefaultOrgID, Group{ID: group.ID, Name: "analysts"}); err != nil {
		t.Fatal(err)
	}
	if got := names(member.ID); got != "Default" {
		t.Errorf("workspaces after leaving the group = %s", got)
	}
	if err := RemoveMember(ctx, pool, scope, member.ID); err != nil {
		t.Fatal(err)
	}
	if err := RemoveMember(ctx, pool, scope, member.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("removing a member twice: err = %v", err)
	}
	if _, err := GetUser(ctx, pool, DefaultOrgID, member.ID); err != nil {
		t.Errorf("removing a member must not delete the account: %v", err)
	}

}
