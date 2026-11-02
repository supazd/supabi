package store

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/supazd/supabi/internal/authz"
)

// UserGroupIDs returns the groups a user is in.
func UserGroupIDs(ctx context.Context, pool *pgxpool.Pool, orgID, userID string) ([]string, error) {
	rows, err := pool.Query(ctx, `SELECT group_id FROM user_group_members WHERE org_id = $1 AND user_id = $2 ORDER BY group_id`, orgID, userID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

// ListDashboardGrants returns who the dashboard is granted to. It returns
// ErrNotFound when the workspace has no such dashboard.
func ListDashboardGrants(ctx context.Context, pool *pgxpool.Pool, s Scope, dashboardID string) ([]authz.Subject, error) {
	if _, err := GetDashboard(ctx, pool, s, dashboardID); err != nil {
		return nil, err
	}
	rows, err := pool.Query(ctx, `
		SELECT coalesce(user_id, ''), coalesce(group_id, ''), everyone FROM dashboard_grants
		WHERE org_id = $1 AND workspace_id = $2 AND dashboard_id = $3
		ORDER BY everyone DESC, group_id NULLS LAST, user_id`, s.OrgID, s.WorkspaceID, dashboardID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (authz.Subject, error) {
		var sub authz.Subject
		err := row.Scan(&sub.UserID, &sub.GroupID, &sub.Everyone)
		return sub, err
	})
}

// SetDashboardGrants replaces who the dashboard is granted to. It returns
// ErrNotFound when the workspace has no such dashboard. Users and groups must
// be of the scope's org; one of another org violates a foreign key.
func SetDashboardGrants(ctx context.Context, pool *pgxpool.Pool, s Scope, dashboardID string, subjects []authz.Subject) error {
	return translate(pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		// Lock the dashboard, even when it has no grants, so concurrent
		// replacements cannot merge their independently inserted subjects.
		var lockedID string
		if err := tx.QueryRow(ctx, `SELECT id FROM dashboards WHERE org_id = $1 AND workspace_id = $2 AND id = $3 FOR UPDATE`,
			s.OrgID, s.WorkspaceID, dashboardID).Scan(&lockedID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM dashboard_grants WHERE workspace_id = $1 AND dashboard_id = $2`, s.WorkspaceID, dashboardID); err != nil {
			return err
		}
		for _, sub := range subjects {
			if _, err := tx.Exec(ctx, `
				INSERT INTO dashboard_grants (org_id, workspace_id, dashboard_id, user_id, group_id, everyone)
				VALUES ($1, $2, $3, nullif($4, ''), nullif($5, ''), $6)
				ON CONFLICT DO NOTHING`,
				s.OrgID, s.WorkspaceID, dashboardID, sub.UserID, sub.GroupID, sub.Everyone); err != nil {
				return err
			}
		}
		return nil
	}))
}

// Visible is what a viewer may see of a workspace's content: the dashboards
// granted to them, and the charts those dashboards show.
type Visible struct {
	Dashboards map[string]bool
	Charts     map[string]bool
}

// VisibleContent returns the dashboards granted to the user, one of their
// groups or every member of the scope's workspace, and the charts on them.
func VisibleContent(ctx context.Context, pool *pgxpool.Pool, s Scope, userID string) (Visible, error) {
	out := Visible{Dashboards: map[string]bool{}, Charts: map[string]bool{}}
	rows, err := pool.Query(ctx, `
		WITH granted AS (
			SELECT DISTINCT g.dashboard_id FROM dashboard_grants g
			WHERE g.org_id = $1 AND g.workspace_id = $2 AND (g.everyone OR g.user_id = $3
				OR g.group_id IN (SELECT group_id FROM user_group_members WHERE user_id = $3)))
		SELECT granted.dashboard_id, coalesce(c.chart_id, '')
		FROM granted LEFT JOIN dashboard_charts c ON c.dashboard_id = granted.dashboard_id`,
		s.OrgID, s.WorkspaceID, userID)
	if err != nil {
		return out, err
	}
	var dashboardID, chartID string
	_, err = pgx.ForEachRow(rows, []any{&dashboardID, &chartID}, func() error {
		out.Dashboards[dashboardID] = true
		if chartID != "" {
			out.Charts[chartID] = true
		}
		return nil
	})
	return out, err
}
