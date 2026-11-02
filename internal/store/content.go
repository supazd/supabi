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

var (
	ErrDatasetChanged   = errors.New("the dataset changed after validation")
	ErrChartChanged     = errors.New("a chart changed after validation")
	ErrRevisionConflict = errors.New("the resource has been edited since it was opened")
)

type Chart struct {
	ID          string
	Name        string
	Description string
	DatasetID   string
	Spec        json.RawMessage
	SpecVersion int
	Revision    int
	UpdatedAt   time.Time
	// FolderID is nil at the top of the tree. It is changed by MoveToFolder only.
	FolderID *string
	// DatasetRevision is the definition used to validate a write. It is not
	// stored on the chart; zero is for trusted callers that do not validate.
	DatasetRevision int `json:"-"`
}

const chartColumns = `id, name, description, dataset_id, spec, spec_version, revision, updated_at, folder_id`

func scanChart(row pgx.Row) (Chart, error) {
	var c Chart
	err := row.Scan(&c.ID, &c.Name, &c.Description, &c.DatasetID, &c.Spec, &c.SpecVersion, &c.Revision, &c.UpdatedAt, &c.FolderID)
	return c, translate(err)
}

func collectCharts(rows pgx.Rows, err error) ([]Chart, error) {
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (Chart, error) { return scanChart(row) })
}

func ListCharts(ctx context.Context, pool *pgxpool.Pool, s Scope) ([]Chart, error) {
	return collectCharts(pool.Query(ctx, `SELECT `+chartColumns+` FROM charts WHERE org_id = $1 AND workspace_id = $2 ORDER BY name`,
		s.OrgID, s.WorkspaceID))
}

// GetCharts returns the charts with the given IDs that exist in the workspace;
// IDs that match nothing are simply absent from the result.
func GetCharts(ctx context.Context, pool *pgxpool.Pool, s Scope, ids []string) ([]Chart, error) {
	return collectCharts(pool.Query(ctx, `SELECT `+chartColumns+` FROM charts WHERE org_id = $1 AND workspace_id = $2 AND id = ANY($3) ORDER BY name`,
		s.OrgID, s.WorkspaceID, ids))
}

func GetChart(ctx context.Context, pool *pgxpool.Pool, s Scope, chartID string) (Chart, error) {
	return scanChart(pool.QueryRow(ctx, `SELECT `+chartColumns+` FROM charts WHERE org_id = $1 AND workspace_id = $2 AND id = $3`,
		s.OrgID, s.WorkspaceID, chartID))
}

func CreateChart(ctx context.Context, pool *pgxpool.Pool, s Scope, c Chart) (Chart, error) {
	var out Chart
	err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		if err := lockDatasetRevisions(ctx, tx, s, map[string]int{c.DatasetID: c.DatasetRevision}); err != nil {
			return err
		}
		var err error
		out, err = scanChart(tx.QueryRow(ctx, `
			INSERT INTO charts (id, org_id, workspace_id, dataset_id, name, description, spec, spec_version, created_by, updated_by)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
			RETURNING `+chartColumns,
			id.New("ch"), s.OrgID, s.WorkspaceID, c.DatasetID, c.Name, c.Description, c.Spec, c.SpecVersion, s.actor()))
		if err != nil {
			return err
		}
		return insertChartRevision(ctx, tx, s, out.ID)
	})
	return out, translate(err)
}

func UpdateChart(ctx context.Context, pool *pgxpool.Pool, s Scope, c Chart) (Chart, error) {
	var out Chart
	err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		if err := lockDatasetRevisions(ctx, tx, s, map[string]int{c.DatasetID: c.DatasetRevision}); err != nil {
			return err
		}
		if err := lockContentRevision(ctx, tx, s, "charts", c.ID, c.Revision); err != nil {
			return err
		}
		var err error
		out, err = scanChart(tx.QueryRow(ctx, `
			UPDATE charts
			SET dataset_id = $4, name = $5, description = $6, spec = $7, spec_version = $8, updated_by = $9, updated_at = now(), revision = revision + 1
			WHERE org_id = $1 AND workspace_id = $2 AND id = $3
			RETURNING `+chartColumns,
			s.OrgID, s.WorkspaceID, c.ID, c.DatasetID, c.Name, c.Description, c.Spec, c.SpecVersion, s.actor()))
		if err != nil {
			return err
		}
		return insertChartRevision(ctx, tx, s, out.ID)
	})
	return out, translate(err)
}

// DeleteChart returns ErrInUse while a dashboard shows the chart.
func DeleteChart(ctx context.Context, pool *pgxpool.Pool, s Scope, chartID string) error {
	return deleteRow(ctx, pool, `DELETE FROM charts WHERE org_id = $1 AND workspace_id = $2 AND id = $3`, s, chartID)
}

func deleteRow(ctx context.Context, pool *pgxpool.Pool, sql string, s Scope, rowID string) error {
	tag, err := pool.Exec(ctx, sql, s.OrgID, s.WorkspaceID, rowID)
	if err != nil {
		return translate(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

type Dashboard struct {
	ID          string
	Name        string
	Description string
	Spec        json.RawMessage
	SpecVersion int
	Revision    int
	UpdatedAt   time.Time
	// FolderID is nil at the top of the tree. It is changed by MoveToFolder only.
	FolderID *string
	// These snapshots record the definitions used to validate a dashboard's
	// bindings. They are checked during save and are not persisted.
	ChartUpdatedAt   map[string]time.Time `json:"-"`
	DatasetRevisions map[string]int       `json:"-"`
}

const dashboardColumns = `id, name, description, spec, spec_version, revision, updated_at, folder_id`

func scanDashboard(row pgx.Row) (Dashboard, error) {
	var d Dashboard
	err := row.Scan(&d.ID, &d.Name, &d.Description, &d.Spec, &d.SpecVersion, &d.Revision, &d.UpdatedAt, &d.FolderID)
	return d, translate(err)
}

func ListDashboards(ctx context.Context, pool *pgxpool.Pool, s Scope) ([]Dashboard, error) {
	rows, err := pool.Query(ctx, `SELECT `+dashboardColumns+` FROM dashboards WHERE org_id = $1 AND workspace_id = $2 ORDER BY name`,
		s.OrgID, s.WorkspaceID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (Dashboard, error) { return scanDashboard(row) })
}

func GetDashboard(ctx context.Context, pool *pgxpool.Pool, s Scope, dashboardID string) (Dashboard, error) {
	return scanDashboard(pool.QueryRow(ctx, `SELECT `+dashboardColumns+` FROM dashboards WHERE org_id = $1 AND workspace_id = $2 AND id = $3`,
		s.OrgID, s.WorkspaceID, dashboardID))
}

// SaveDashboard creates the dashboard when d.ID is empty and updates it
// otherwise, and records which charts it shows. Every chart ID must exist in
// the workspace.
func SaveDashboard(ctx context.Context, pool *pgxpool.Pool, s Scope, d Dashboard, chartIDs []string) (Dashboard, error) {
	var out Dashboard
	err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		// Use the same dataset → chart → dashboard lock order as dataset
		// impact checks. Lock dependencies before writing the dashboard,
		// including before the FK checks that inserting its chart list needs.
		if err := lockDatasetRevisions(ctx, tx, s, d.DatasetRevisions); err != nil {
			return err
		}
		if err := lockChartVersions(ctx, tx, s, chartIDs, d.ChartUpdatedAt); err != nil {
			return err
		}
		var err error
		if d.ID == "" {
			out, err = scanDashboard(tx.QueryRow(ctx, `
				INSERT INTO dashboards (id, org_id, workspace_id, name, description, spec, spec_version, created_by, updated_by)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
				RETURNING `+dashboardColumns,
				id.New("db"), s.OrgID, s.WorkspaceID, d.Name, d.Description, d.Spec, d.SpecVersion, s.actor()))
		} else {
			if err := lockContentRevision(ctx, tx, s, "dashboards", d.ID, d.Revision); err != nil {
				return err
			}
			out, err = scanDashboard(tx.QueryRow(ctx, `
				UPDATE dashboards
				SET name = $4, description = $5, spec = $6, spec_version = $7, updated_by = $8, updated_at = now(), revision = revision + 1
				WHERE org_id = $1 AND workspace_id = $2 AND id = $3
				RETURNING `+dashboardColumns,
				s.OrgID, s.WorkspaceID, d.ID, d.Name, d.Description, d.Spec, d.SpecVersion, s.actor()))
		}
		if err != nil {
			return err
		}
		if err := insertDashboardRevision(ctx, tx, s, out.ID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM dashboard_charts WHERE dashboard_id = $1`, out.ID); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `
			INSERT INTO dashboard_charts (workspace_id, dashboard_id, chart_id)
			SELECT $1, $2, unnest($3::text[])`, s.WorkspaceID, out.ID, chartIDs)
		return err
	})
	return out, translate(err)
}

func DeleteDashboard(ctx context.Context, pool *pgxpool.Pool, s Scope, dashboardID string) error {
	return deleteRow(ctx, pool, `DELETE FROM dashboards WHERE org_id = $1 AND workspace_id = $2 AND id = $3`, s, dashboardID)
}

// The table is an internal constant. Take this lock after the resource's
// dependencies and hold it through the write, following dataset → chart → dashboard.
func lockContentRevision(ctx context.Context, tx pgx.Tx, s Scope, table, resourceID string, expected int) error {
	var revision int
	err := tx.QueryRow(ctx, `SELECT revision FROM `+table+` WHERE org_id = $1 AND workspace_id = $2 AND id = $3 FOR UPDATE`, s.OrgID, s.WorkspaceID, resourceID).Scan(&revision)
	if err != nil {
		return translate(err)
	}
	if revision != expected {
		return ErrRevisionConflict
	}
	return nil
}
