package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/supazd/supabi/internal/id"
)

// DashboardView is the conditions a dashboard was shared with.
type DashboardView struct {
	ID          string
	DashboardID string
	State       json.RawMessage
	ExpiresAt   time.Time
}

// SaveDashboardView keeps the conditions a dashboard is shared with for
// validFor. The same conditions shared again keep their ID, and the later of
// the two expiries, so that a link already sent never expires sooner.
func SaveDashboardView(ctx context.Context, pool *pgxpool.Pool, s Scope, dashboardID string, state []byte, hash string, validFor time.Duration) (DashboardView, error) {
	v := DashboardView{DashboardID: dashboardID, State: state}
	err := pool.QueryRow(ctx, `INSERT INTO dashboard_views AS v (id, org_id, workspace_id, dashboard_id, state, state_hash, created_by, expires_at)
 VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8))
 ON CONFLICT (dashboard_id, state_hash) DO UPDATE SET expires_at = GREATEST(v.expires_at, EXCLUDED.expires_at)
 RETURNING id, expires_at`,
		id.New("dv"), s.OrgID, s.WorkspaceID, dashboardID, state, hash, s.actor(), validFor.Seconds()).Scan(&v.ID, &v.ExpiresAt)
	return v, err
}

// OpenDashboardView returns the conditions a link carries, and notes that it
// was opened. An expired or unknown one is ErrNotFound.
func OpenDashboardView(ctx context.Context, pool *pgxpool.Pool, s Scope, dashboardID, viewID string) (DashboardView, error) {
	v := DashboardView{ID: viewID, DashboardID: dashboardID}
	err := pool.QueryRow(ctx, `UPDATE dashboard_views SET last_opened_at = now()
 WHERE org_id = $1 AND workspace_id = $2 AND dashboard_id = $3 AND id = $4 AND expires_at > now()
 RETURNING state, expires_at`,
		s.OrgID, s.WorkspaceID, dashboardID, viewID).Scan(&v.State, &v.ExpiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return DashboardView{}, ErrNotFound
	}
	return v, err
}

// PruneDashboardViews deletes the shared conditions that have expired.
func PruneDashboardViews(ctx context.Context, pool *pgxpool.Pool, orgID string) (int64, error) {
	tag, err := pool.Exec(ctx, `DELETE FROM dashboard_views WHERE org_id = $1 AND expires_at <= now()`, orgID)
	return tag.RowsAffected(), err
}
