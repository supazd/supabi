package store

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The kinds of resource that read one another.
const (
	LineageDatasource = "datasource"
	// LineageTable is a table of a data source. Tables are not kept here:
	// they are those the datasets are found to read.
	LineageTable     = "table"
	LineageDataset   = "dataset"
	LineageChart     = "chart"
	LineageDashboard = "dashboard"
)

// LineageNode is a resource, as much of it as says what it is.
type LineageNode struct {
	Kind string
	ID   string
	Name string
	// SourceType is the driver of a data source; empty for other kinds.
	SourceType string
}

// LineageEdge says that To reads From.
type LineageEdge struct {
	From string
	To   string
}

// LineageSource is how a dataset reads its data source: with SQL,
// or by naming a table.
type LineageSource struct {
	// ID is the dataset.
	ID             string
	DatasourceID   string
	DatasourceType string
	SQL            string
	// Schema and Table are set for a dataset made of a table, which has no SQL.
	Schema string
	Table  string
}

// Lineage is what reads what in a workspace.
type Lineage struct {
	Nodes []LineageNode
	Edges []LineageEdge
	// Sources says how each dataset that has a data source reads
	// it, for finding the tables in between.
	Sources []LineageSource
}

// GetLineage lists the resources of the workspace and their data dependencies.
func GetLineage(ctx context.Context, pool *pgxpool.Pool, s Scope) (Lineage, error) {
	var l Lineage
	rows, err := pool.Query(ctx, `
		SELECT 'datasource', id, name, type FROM datasources WHERE org_id = $1 AND workspace_id = $2
		UNION ALL
		SELECT 'dataset', id, name, '' FROM datasets WHERE org_id = $1 AND workspace_id = $2
		UNION ALL
		SELECT 'chart', id, name, '' FROM charts WHERE org_id = $1 AND workspace_id = $2
		UNION ALL
		SELECT 'dashboard', id, name, '' FROM dashboards WHERE org_id = $1 AND workspace_id = $2
		ORDER BY 1, 3, 2`,
		s.OrgID, s.WorkspaceID)
	if err != nil {
		return l, err
	}
	if l.Nodes, err = pgx.CollectRows(rows, pgx.RowToStructByPos[LineageNode]); err != nil {
		return l, err
	}
	rows, err = pool.Query(ctx, `
		SELECT datasource_id, id FROM datasets WHERE org_id = $1 AND workspace_id = $2
		UNION ALL
		SELECT dataset_id, id FROM charts WHERE org_id = $1 AND workspace_id = $2
		UNION ALL
		SELECT dc.chart_id, dc.dashboard_id FROM dashboard_charts dc
		JOIN dashboards b ON b.id = dc.dashboard_id
		WHERE b.org_id = $1 AND b.workspace_id = $2
		ORDER BY 1, 2`,
		s.OrgID, s.WorkspaceID)
	if err != nil {
		return l, err
	}
	if l.Edges, err = pgx.CollectRows(rows, pgx.RowToStructByPos[LineageEdge]); err != nil {
		return l, err
	}
	rows, err = pool.Query(ctx, `
		SELECT d.id, d.datasource_id, ds.type,
			COALESCE(d.spec->'source'->>'sql', ''), COALESCE(d.spec->'source'->>'schema', ''), COALESCE(d.spec->'source'->>'table', '')
		FROM datasets d JOIN datasources ds ON ds.id = d.datasource_id
		WHERE d.org_id = $1 AND d.workspace_id = $2
		ORDER BY 1`,
		s.OrgID, s.WorkspaceID)
	if err != nil {
		return l, err
	}
	l.Sources, err = pgx.CollectRows(rows, pgx.RowToStructByPos[LineageSource])
	return l, err
}
