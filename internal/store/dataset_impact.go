package store

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type datasetReader interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

// DatasetReaders returns definitions, not just resource-level lineage: a
// dashboard can bind a field its chart does not otherwise use.
func DatasetReaders(ctx context.Context, pool *pgxpool.Pool, s Scope, id string) ([]Chart, []Dashboard, error) {
	return datasetReaders(ctx, pool, s, id, false)
}

func datasetReaders(ctx context.Context, db datasetReader, s Scope, id string, lock bool) ([]Chart, []Dashboard, error) {
	suffix := ""
	if lock {
		// Also prevents a new dashboard reference from being inserted while
		// the change is checked and saved (its foreign key needs a key lock).
		suffix = " FOR UPDATE"
	}
	charts, err := collectCharts(db.Query(ctx, `SELECT `+chartColumns+` FROM charts
		WHERE org_id = $1 AND workspace_id = $2 AND dataset_id = $3 ORDER BY id`+suffix,
		s.OrgID, s.WorkspaceID, id))
	if err != nil {
		return nil, nil, err
	}
	rows, err := db.Query(ctx, `SELECT `+dashboardColumns+` FROM dashboards
		WHERE org_id = $1 AND workspace_id = $2 AND id IN (
			SELECT dc.dashboard_id FROM dashboard_charts dc JOIN charts c ON c.id = dc.chart_id
			WHERE c.org_id = $1 AND c.workspace_id = $2 AND c.dataset_id = $3
		) ORDER BY id`+suffix, s.OrgID, s.WorkspaceID, id)
	if err != nil {
		return nil, nil, err
	}
	dashboards, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Dashboard, error) { return scanDashboard(row) })
	return charts, dashboards, err
}
