package store

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Charts and dashboards keep every saved definition, but only who saved one
// and when is read back: there is no restoring them (.agents/design/chart-dashboard.md 4.1).

func ListChartRevisions(ctx context.Context, pool *pgxpool.Pool, s Scope, chartID string, before, limit int) ([]RevisionSummary, error) {
	return listRevisions(ctx, pool, ` FROM chart_revisions r
		LEFT JOIN users u ON u.id = r.created_by AND u.org_id = r.org_id
		WHERE r.org_id = $1 AND r.workspace_id = $2 AND r.chart_id = $3`, s, chartID, before, limit)
}

func ListDashboardRevisions(ctx context.Context, pool *pgxpool.Pool, s Scope, dashboardID string, before, limit int) ([]RevisionSummary, error) {
	return listRevisions(ctx, pool, ` FROM dashboard_revisions r
		LEFT JOIN users u ON u.id = r.created_by AND u.org_id = r.org_id
		WHERE r.org_id = $1 AND r.workspace_id = $2 AND r.dashboard_id = $3`, s, dashboardID, before, limit)
}

// insertChartRevision records the chart as it has just been written, in the
// same transaction. The save holds its dataset locked, so the dataset's
// revision is the one the chart was checked against.
func insertChartRevision(ctx context.Context, tx pgx.Tx, s Scope, chartID string) error {
	return insertOne(ctx, tx, `
		INSERT INTO chart_revisions (chart_id, revision, org_id, workspace_id, name, description, dataset_id, dataset_revision, spec, spec_version, created_by, created_at)
		SELECT c.id, c.revision, c.org_id, c.workspace_id, c.name, c.description, c.dataset_id, d.revision, c.spec, c.spec_version, c.updated_by, c.updated_at
		FROM charts c JOIN datasets d ON d.id = c.dataset_id AND d.workspace_id = c.workspace_id
		WHERE c.org_id = $1 AND c.workspace_id = $2 AND c.id = $3`, s, chartID)
}

func insertDashboardRevision(ctx context.Context, tx pgx.Tx, s Scope, dashboardID string) error {
	return insertOne(ctx, tx, `
		INSERT INTO dashboard_revisions (dashboard_id, revision, org_id, workspace_id, name, description, spec, spec_version, created_by, created_at)
		SELECT id, revision, org_id, workspace_id, name, description, spec, spec_version, updated_by, updated_at
		FROM dashboards WHERE org_id = $1 AND workspace_id = $2 AND id = $3`, s, dashboardID)
}

func insertOne(ctx context.Context, tx pgx.Tx, sql string, s Scope, resourceID string) error {
	tag, err := tx.Exec(ctx, sql, s.OrgID, s.WorkspaceID, resourceID)
	if err == nil && tag.RowsAffected() != 1 {
		return ErrNotFound
	}
	return err
}
