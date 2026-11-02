package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/supazd/supabi/internal/id"
)

// ErrCycle means a folder was asked to move into itself or a folder inside it.
var ErrCycle = errors.New("a folder cannot be inside itself")

// The kinds of resource that are kept in folders. Each has its own tree.
const (
	KindDashboard = "dashboard"
	KindChart     = "chart"
	KindDataset   = "dataset"
)

// kindTables maps a kind to the table its resources are in.
var kindTables = map[string]string{KindDashboard: "dashboards", KindChart: "charts", KindDataset: "datasets"}

// FolderKind reports whether resources of the kind are kept in folders.
func FolderKind(kind string) bool {
	_, ok := kindTables[kind]
	return ok
}

type Folder struct {
	ID   string
	Kind string
	// ParentID is nil at the top of the tree.
	ParentID *string
	Name     string
}

const folderColumns = `id, kind, parent_id, name`

func scanFolder(row pgx.Row) (Folder, error) {
	var f Folder
	err := row.Scan(&f.ID, &f.Kind, &f.ParentID, &f.Name)
	return f, translate(err)
}

// ListFolders returns the folders of every kind that the member sees.
func ListFolders(ctx context.Context, pool *pgxpool.Pool, s Scope) ([]Folder, error) {
	rows, err := pool.Query(ctx, `SELECT `+folderColumns+` FROM folders WHERE org_id = $1 AND workspace_id = $2 ORDER BY name`,
		s.OrgID, s.WorkspaceID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (Folder, error) { return scanFolder(row) })
}

func GetFolder(ctx context.Context, pool *pgxpool.Pool, s Scope, folderID string) (Folder, error) {
	return scanFolder(pool.QueryRow(ctx, `SELECT `+folderColumns+` FROM folders WHERE org_id = $1 AND workspace_id = $2 AND id = $3`,
		s.OrgID, s.WorkspaceID, folderID))
}

// CreateFolder returns ErrNotFound when the parent is not a folder of the same kind in the same tree.
func CreateFolder(ctx context.Context, pool *pgxpool.Pool, s Scope, f Folder) (Folder, error) {
	if f.ParentID != nil {
		parent, err := GetFolder(ctx, pool, s, *f.ParentID)
		if err != nil {
			return f, err
		}
		if parent.Kind != f.Kind {
			return f, ErrNotFound
		}
	}
	return scanFolder(pool.QueryRow(ctx, `
		INSERT INTO folders (id, org_id, workspace_id, kind, parent_id, name, created_by)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING `+folderColumns,
		id.New("fld"), s.OrgID, s.WorkspaceID, f.Kind, f.ParentID, f.Name, s.actor()))
}

// UpdateFolder renames the folder and puts it under f.ParentID. It returns
// ErrCycle when that is the folder itself or one inside it, and ErrNotFound
// when it is not a folder of the same kind in the same tree.
func UpdateFolder(ctx context.Context, pool *pgxpool.Pool, s Scope, f Folder) (Folder, error) {
	var out Folder
	err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		current, err := scanFolder(tx.QueryRow(ctx, `SELECT `+folderColumns+` FROM folders WHERE org_id = $1 AND workspace_id = $2 AND id = $3 FOR UPDATE`,
			s.OrgID, s.WorkspaceID, f.ID))
		if err != nil {
			return err
		}
		if f.ParentID != nil {
			// Walk up from the new parent: meeting the folder on the way
			// means the parent is inside it.
			var kind *string
			var inside bool
			err := tx.QueryRow(ctx, `
				WITH RECURSIVE up AS (
					SELECT id, parent_id, kind FROM folders WHERE workspace_id = $1 AND id = $2
					UNION ALL
					SELECT f.id, f.parent_id, f.kind FROM folders f JOIN up ON f.workspace_id = $1 AND f.id = up.parent_id
				)
				SELECT (SELECT kind FROM folders WHERE workspace_id = $1 AND id = $2),
				       EXISTS (SELECT 1 FROM up WHERE id = $3)`,
				s.WorkspaceID, *f.ParentID, f.ID).Scan(&kind, &inside)
			if err != nil {
				return err
			}
			if kind == nil || *kind != current.Kind {
				return ErrNotFound
			}
			if inside {
				return ErrCycle
			}
		}
		out, err = scanFolder(tx.QueryRow(ctx, `
			UPDATE folders SET name = $4, parent_id = $5, updated_at = now()
			WHERE org_id = $1 AND workspace_id = $2 AND id = $3
			RETURNING `+folderColumns,
			s.OrgID, s.WorkspaceID, f.ID, f.Name, f.ParentID))
		return err
	})
	return out, translate(err)
}

// DeleteFolder returns ErrInUse while the folder holds anything.
func DeleteFolder(ctx context.Context, pool *pgxpool.Pool, s Scope, folderID string) error {
	tag, err := pool.Exec(ctx, `DELETE FROM folders WHERE org_id = $1 AND workspace_id = $2 AND id = $3`,
		s.OrgID, s.WorkspaceID, folderID)
	if err != nil {
		return translate(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// MoveToFolder puts a resource in a folder of its kind, or at the top of the
// tree when folderID is nil. It returns ErrNotFound when either is missing.
func MoveToFolder(ctx context.Context, pool *pgxpool.Pool, s Scope, kind, resourceID string, folderID *string) error {
	table, ok := kindTables[kind]
	if !ok {
		return ErrNotFound
	}
	args := []any{s.OrgID, s.WorkspaceID, resourceID, folderID, kind}
	// Moving is not an edit of the resource: updated_at stays as it is.
	tag, err := pool.Exec(ctx, `
		UPDATE `+table+` SET folder_id = $4
		WHERE org_id = $1 AND workspace_id = $2 AND id = $3
		  AND ($4::text IS NULL OR EXISTS (SELECT 1 FROM folders WHERE workspace_id = $2 AND id = $4 AND kind = $5))`,
		args...)
	if err != nil {
		return translate(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// Ref names a resource without the rest of it.
type Ref struct {
	ID   string
	Name string
}

// Usage is what would be affected by changing a resource.
type Usage struct {
	Datasets   []Ref
	Charts     []Ref
	Dashboards []Ref
}

func refs(ctx context.Context, pool *pgxpool.Pool, sql string, args ...any) ([]Ref, error) {
	rows, err := pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByPos[Ref])
}

// DatasourceUsage lists the datasets that read a data source.
func DatasourceUsage(ctx context.Context, pool *pgxpool.Pool, s Scope, datasourceID string) (Usage, error) {
	var u Usage
	var err error
	u.Datasets, err = refs(ctx, pool, `SELECT id, name FROM datasets WHERE org_id = $1 AND workspace_id = $2 AND datasource_id = $3 ORDER BY name`,
		s.OrgID, s.WorkspaceID, datasourceID)
	return u, err
}

// DatasetUsage lists the charts that read a dataset and the dashboards that show them.
func DatasetUsage(ctx context.Context, pool *pgxpool.Pool, s Scope, datasetID string) (Usage, error) {
	var u Usage
	var err error
	if u.Charts, err = refs(ctx, pool, `SELECT id, name FROM charts WHERE org_id = $1 AND workspace_id = $2 AND dataset_id = $3 ORDER BY name`,
		s.OrgID, s.WorkspaceID, datasetID); err != nil {
		return u, err
	}
	u.Dashboards, err = refs(ctx, pool, `
		SELECT DISTINCT d.id, d.name FROM dashboards d
		JOIN dashboard_charts dc ON dc.dashboard_id = d.id
		JOIN charts c ON c.id = dc.chart_id
		WHERE d.org_id = $1 AND d.workspace_id = $2 AND c.dataset_id = $3 ORDER BY d.name`,
		s.OrgID, s.WorkspaceID, datasetID)
	return u, err
}

// ChartUsage lists the dashboards that show a chart.
func ChartUsage(ctx context.Context, pool *pgxpool.Pool, s Scope, chartID string) (Usage, error) {
	var u Usage
	var err error
	u.Dashboards, err = refs(ctx, pool, `
		SELECT d.id, d.name FROM dashboards d
		JOIN dashboard_charts dc ON dc.dashboard_id = d.id
		WHERE d.org_id = $1 AND d.workspace_id = $2 AND dc.chart_id = $3 ORDER BY d.name`,
		s.OrgID, s.WorkspaceID, chartID)
	return u, err
}
