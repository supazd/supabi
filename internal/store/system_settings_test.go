package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/supazd/supabi/internal/secret"
)

// Settings left unset follow the defaults; saving nil returns one to them.
func TestSystemSettings(t *testing.T) {
	pool := migrated(t)
	ctx := context.Background()
	if got, err := SystemSettingsInForce(ctx, pool, DefaultOrgID); err != nil || got != DefaultSystemSettings {
		t.Fatalf("without a row: %+v, %v", got, err)
	}
	hours, days, rows, seconds, kept, on := 48, 0, int64(1000), 90, 7, true
	if err := SetSystemSettings(ctx, pool, Scope{OrgID: DefaultOrgID}, SystemSettingValues{ExportRetentionHours: &hours, AuditRetentionDays: &days, ExportMaxRows: &rows,
		QueryTimeoutSeconds: &seconds, QueryDefaultRows: &kept, QueryMaxRows: &seconds, SessionLifetimeHours: &hours, WorkspaceRetentionDays: &kept, MCPEnabled: &on}); err != nil {
		t.Fatal(err)
	}
	got, err := SystemSettingsInForce(ctx, pool, DefaultOrgID)
	want := DefaultSystemSettings
	want.ExportRetention, want.AuditRetention, want.ExportMaxRows = 48*time.Hour, 0, 1000
	want.QueryTimeout, want.QueryDefaultRows, want.QueryMaxRows = 90*time.Second, 7, 90
	want.SessionLifetime, want.WorkspaceRetention, want.MCPEnabled = 48*time.Hour, 7*24*time.Hour, true
	if err != nil || got != want {
		t.Errorf("set: %+v, %v; want %+v", got, err, want)
	}
	if err := SetSystemSettings(ctx, pool, Scope{OrgID: DefaultOrgID}, SystemSettingValues{ExportRetentionHours: &hours}); err != nil {
		t.Fatal(err)
	}
	if v, err := GetSystemSettings(ctx, pool, DefaultOrgID); err != nil || v.AuditRetentionDays != nil || v.ExportMaxRows != nil || v.MCPEnabled != nil || *v.ExportRetentionHours != 48 {
		t.Errorf("after resetting two: %+v, %v", v, err)
	}
	zero := 0
	if err := SetSystemSettings(ctx, pool, Scope{OrgID: DefaultOrgID}, SystemSettingValues{ExportTimeoutMinutes: &zero}); err == nil {
		t.Error("a timeout of 0 was stored")
	}
}

// A lifetime made shorter ends the sessions idle for longer at once; one made
// longer gives none more time until it is renewed.
func TestSessionLifetimeShortened(t *testing.T) {
	pool := migrated(t)
	ctx := context.Background()
	u, err := CreateFirstAdmin(ctx, pool, DefaultOrgID, User{Email: "a@example.com", DisplayName: "A", PasswordHash: "x"})
	if err != nil {
		t.Fatal(err)
	}
	session := func(token string, idle time.Duration) []byte {
		t.Helper()
		hash := []byte(token)
		if err := CreateSession(ctx, pool, u, hash, DefaultSystemSettings.SessionLifetime); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE sessions SET last_seen_at = now() - make_interval(secs => $2), expires_at = expires_at - make_interval(secs => $2) WHERE token_hash = $1`, hash, idle.Seconds()); err != nil {
			t.Fatal(err)
		}
		return hash
	}
	active, idle := session("active", time.Minute), session("idle", 5*time.Hour)
	hours := 4
	if err := SetSystemSettings(ctx, pool, Scope{OrgID: DefaultOrgID}, SystemSettingValues{SessionLifetimeHours: &hours}); err != nil {
		t.Fatal(err)
	}
	if _, err := GetPrincipal(ctx, pool, active); err != nil {
		t.Errorf("the active session: %v", err)
	}
	if _, err := GetPrincipal(ctx, pool, idle); !errors.Is(err, ErrNotFound) {
		t.Errorf("the idle session: %v", err)
	}
	var before, after time.Time
	expiry := `SELECT expires_at FROM sessions WHERE token_hash = $1`
	if err := pool.QueryRow(ctx, expiry, active).Scan(&before); err != nil {
		t.Fatal(err)
	}
	hours = 48
	if err := SetSystemSettings(ctx, pool, Scope{OrgID: DefaultOrgID}, SystemSettingValues{SessionLifetimeHours: &hours}); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, expiry, active).Scan(&after); err != nil || !after.Equal(before) {
		t.Errorf("a longer lifetime moved the expiry from %v to %v, %v", before, after, err)
	}
}

func box(t *testing.T) *secret.Box {
	b, err := secret.NewBox(secret.GenerateKey())
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// The first instance to start writes the check; one with another key then
// does not start, until the secrets are cleared.
func TestCheckSecretKey(t *testing.T) {
	pool := migrated(t)
	ctx := context.Background()
	first, other := box(t), box(t)
	if err := CheckSecretKey(ctx, pool, first); err != nil {
		t.Fatalf("a new database: %v", err)
	}
	if err := CheckSecretKey(ctx, pool, first); err != nil {
		t.Errorf("the same key again: %v", err)
	}
	if err := CheckSecretKey(ctx, pool, other); !errors.Is(err, ErrWrongSecretKey) {
		t.Errorf("another key: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO datasources (id, org_id, workspace_id, name, type, secret) VALUES ('src_pw', $1, $2, 'db', 'postgres', $3)`,
		DefaultOrgID, DefaultWorkspaceID, first.Seal("password")); err != nil {
		t.Fatal(err)
	}
	if n, err := ClearSecrets(ctx, pool); err != nil || n != (StoredSecrets{Datasources: 1}) {
		t.Fatalf("clear: %+v, %v", n, err)
	}
	if n, err := CountSecrets(ctx, pool); err != nil || n != (StoredSecrets{}) {
		t.Errorf("after clearing: %+v, %v", n, err)
	}
	if err := CheckSecretKey(ctx, pool, other); err != nil {
		t.Errorf("a new key after clearing: %v", err)
	}
}

// A database set up before the check is judged by a secret it stores.
func TestCheckSecretKeyOfOlderDatabase(t *testing.T) {
	pool := migrated(t)
	ctx := context.Background()
	first, other := box(t), box(t)
	if _, err := pool.Exec(ctx, `INSERT INTO ai_providers (id, org_id, name, protocol, base_url, api_key) VALUES ('aip_1', $1, 'p', 'openai', 'http://x', $2)`,
		DefaultOrgID, first.Seal("sk-test")); err != nil {
		t.Fatal(err)
	}
	if err := CheckSecretKey(ctx, pool, other); !errors.Is(err, ErrWrongSecretKey) {
		t.Errorf("another key than the stored secret's: %v", err)
	}
	if err := CheckSecretKey(ctx, pool, first); err != nil {
		t.Errorf("the stored secret's key: %v", err)
	}
	if err := CheckSecretKey(ctx, pool, other); !errors.Is(err, ErrWrongSecretKey) {
		t.Errorf("another key once checked: %v", err)
	}
}
