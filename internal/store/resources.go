package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/supazd/supabi/internal/id"
)

var (
	ErrNotFound = errors.New("not found")
	// ErrConflict means a unique name is already taken.
	ErrConflict = errors.New("already exists")
	// ErrInUse means other rows still refer to the one being deleted.
	ErrInUse = errors.New("still in use")
)

// Scope is the tenant and workspace a request acts in. Every query on a
// resource table filters by it.
type Scope struct {
	OrgID       string
	WorkspaceID string
	// UserID is who is acting; it is recorded as the creator or last editor.
	UserID string
}

// actor is the user to record, or NULL for changes made by the system itself.
func (s Scope) actor() *string {
	if s.UserID == "" {
		return nil
	}
	return &s.UserID
}

// DefaultWorkspaceID is the workspace created for a new installation.
const DefaultWorkspaceID = "ws_default"

func translate(err error) error {
	var pgErr *pgconn.PgError
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return ErrNotFound
	case errors.As(err, &pgErr) && pgErr.Code == "23505":
		return ErrConflict
	case errors.As(err, &pgErr) && pgErr.Code == "23503":
		return ErrInUse
	}
	return err
}

// ---- workspaces ----

type Workspace struct {
	ID        string
	Name      string
	Timezone  string
	WeekStart int
	// FirstWeekDays is how many days of a year's first week are in that year,
	// which numbers the weeks when they are written by number.
	FirstWeekDays int
	// DeletedAt is set once the workspace is deleted; it is purged when
	// SystemSettings.WorkspaceRetention has passed.
	DeletedAt *time.Time
}

func GetWorkspace(ctx context.Context, pool *pgxpool.Pool, s Scope) (Workspace, error) {
	w := Workspace{ID: s.WorkspaceID}
	err := pool.QueryRow(ctx, `SELECT name, timezone, week_start, first_week_days FROM workspaces WHERE org_id = $1 AND id = $2`,
		s.OrgID, s.WorkspaceID).Scan(&w.Name, &w.Timezone, &w.WeekStart, &w.FirstWeekDays)
	return w, translate(err)
}

// ---- data sources ----

type Datasource struct {
	ID           string
	Name         string
	Type         string
	Settings     map[string]string
	Secret       []byte // sealed password; nil when there is none
	DataTimezone string
	// CacheTTLSeconds is how long results are kept: nil follows the server
	// default, 0 keeps none.
	CacheTTLSeconds *int
	// MaxConcurrentQueries is nil for the default.
	MaxConcurrentQueries *int
	CreatedAt            time.Time
	UpdatedAt            time.Time
}

const datasourceColumns = `id, name, type, config, secret, data_timezone, cache_ttl_seconds, max_concurrent_queries, created_at, updated_at`

func scanDatasource(row pgx.Row) (Datasource, error) {
	var d Datasource
	err := row.Scan(&d.ID, &d.Name, &d.Type, &d.Settings, &d.Secret, &d.DataTimezone, &d.CacheTTLSeconds, &d.MaxConcurrentQueries, &d.CreatedAt, &d.UpdatedAt)
	return d, translate(err)
}

func ListDatasources(ctx context.Context, pool *pgxpool.Pool, s Scope) ([]Datasource, error) {
	rows, err := pool.Query(ctx, `SELECT `+datasourceColumns+` FROM datasources WHERE org_id = $1 AND workspace_id = $2 ORDER BY name`,
		s.OrgID, s.WorkspaceID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (Datasource, error) { return scanDatasource(row) })
}

func GetDatasource(ctx context.Context, pool *pgxpool.Pool, s Scope, datasourceID string) (Datasource, error) {
	return scanDatasource(pool.QueryRow(ctx,
		`SELECT `+datasourceColumns+` FROM datasources WHERE org_id = $1 AND workspace_id = $2 AND id = $3`,
		s.OrgID, s.WorkspaceID, datasourceID))
}

func CreateDatasource(ctx context.Context, pool *pgxpool.Pool, s Scope, d Datasource) (Datasource, error) {
	return scanDatasource(pool.QueryRow(ctx, `
		INSERT INTO datasources (id, org_id, workspace_id, name, type, config, secret, data_timezone, cache_ttl_seconds, max_concurrent_queries, created_by, updated_by)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
		RETURNING `+datasourceColumns,
		id.New("src"), s.OrgID, s.WorkspaceID, d.Name, d.Type, d.Settings, d.Secret, d.DataTimezone, d.CacheTTLSeconds, d.MaxConcurrentQueries, s.actor()))
}

// UpdateDatasource changes how a data source connects. Its type is not one of
// the things that change.
func UpdateDatasource(ctx context.Context, pool *pgxpool.Pool, s Scope, d Datasource) (Datasource, error) {
	return scanDatasource(pool.QueryRow(ctx, `
		UPDATE datasources
		SET name = $4, config = $5, secret = $6, data_timezone = $7, cache_ttl_seconds = $8, max_concurrent_queries = $9, updated_by = $10, updated_at = now()
		WHERE org_id = $1 AND workspace_id = $2 AND id = $3
		RETURNING `+datasourceColumns,
		s.OrgID, s.WorkspaceID, d.ID, d.Name, d.Settings, d.Secret, d.DataTimezone, d.CacheTTLSeconds, d.MaxConcurrentQueries, s.actor()))
}

func DeleteDatasource(ctx context.Context, pool *pgxpool.Pool, s Scope, datasourceID string) error {
	tag, err := pool.Exec(ctx, `DELETE FROM datasources WHERE org_id = $1 AND workspace_id = $2 AND id = $3`,
		s.OrgID, s.WorkspaceID, datasourceID)
	if err != nil {
		return translate(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ---- datasets ----

type Dataset struct {
	ID               string
	Name             string
	Description      string
	DatasourceID     string
	Spec             json.RawMessage
	SpecVersion      int
	Revision         int
	ValidationStatus string
	UpdatedAt        time.Time
	// FolderID is nil at the top of the tree. It is changed by MoveToFolder only.
	FolderID *string
}

const datasetColumns = `id, name, description, datasource_id, spec, spec_version, revision, validation_status, updated_at, folder_id`

func scanDataset(row pgx.Row) (Dataset, error) {
	var d Dataset
	err := row.Scan(&d.ID, &d.Name, &d.Description, &d.DatasourceID, &d.Spec, &d.SpecVersion, &d.Revision, &d.ValidationStatus, &d.UpdatedAt, &d.FolderID)
	return d, translate(err)
}

func ListDatasets(ctx context.Context, pool *pgxpool.Pool, s Scope) ([]Dataset, error) {
	rows, err := pool.Query(ctx, `SELECT `+datasetColumns+` FROM datasets WHERE org_id = $1 AND workspace_id = $2 ORDER BY name`,
		s.OrgID, s.WorkspaceID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (Dataset, error) { return scanDataset(row) })
}

func GetDataset(ctx context.Context, pool *pgxpool.Pool, s Scope, datasetID string) (Dataset, error) {
	return scanDataset(pool.QueryRow(ctx,
		`SELECT `+datasetColumns+` FROM datasets WHERE org_id = $1 AND workspace_id = $2 AND id = $3`,
		s.OrgID, s.WorkspaceID, datasetID))
}

// CreateDataset stores the dataset as revision 1.
func CreateDataset(ctx context.Context, pool *pgxpool.Pool, s Scope, d Dataset) (Dataset, error) {
	var out Dataset
	err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		var err error
		out, err = scanDataset(tx.QueryRow(ctx, `
			INSERT INTO datasets (id, org_id, workspace_id, datasource_id, name, description, spec, spec_version, validation_status, created_by, updated_by)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
			RETURNING `+datasetColumns,
			id.New("ds"), s.OrgID, s.WorkspaceID, d.DatasourceID, d.Name, d.Description, d.Spec, d.SpecVersion, d.ValidationStatus, s.actor()))
		if err != nil {
			return err
		}
		return insertRevision(ctx, tx, s, out)
	})
	return out, translate(err)
}

// UpdateDataset stores the dataset as its next revision. Earlier revisions are kept.
func UpdateDataset(ctx context.Context, pool *pgxpool.Pool, s Scope, d Dataset) (Dataset, error) {
	return UpdateDatasetChecked(ctx, pool, s, d, nil)
}

// UpdateDatasetChecked checks the current revision and its readers under the
// same locks as the write. User confirmation must describe what is saved.
func UpdateDatasetChecked(ctx context.Context, pool *pgxpool.Pool, s Scope, d Dataset, check func(Dataset, []Chart, []Dashboard) error) (Dataset, error) {
	var out Dataset
	err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		if check != nil {
			current, err := scanDataset(tx.QueryRow(ctx, `SELECT `+datasetColumns+` FROM datasets
				WHERE org_id = $1 AND workspace_id = $2 AND id = $3 FOR UPDATE`, s.OrgID, s.WorkspaceID, d.ID))
			if err != nil {
				return err
			}
			charts, dashboards, err := datasetReaders(ctx, tx, s, d.ID, true)
			if err != nil {
				return err
			}
			if err := check(current, charts, dashboards); err != nil {
				return err
			}
		}
		var err error
		out, err = scanDataset(tx.QueryRow(ctx, `
			UPDATE datasets
			SET datasource_id = $4, name = $5, description = $6, spec = $7, spec_version = $8,
			    validation_status = $9, revision = revision + 1, updated_at = now(), updated_by = $10
			WHERE org_id = $1 AND workspace_id = $2 AND id = $3
			RETURNING `+datasetColumns,
			s.OrgID, s.WorkspaceID, d.ID, d.DatasourceID, d.Name, d.Description, d.Spec, d.SpecVersion, d.ValidationStatus, s.actor()))
		if err != nil {
			return err
		}
		return insertRevision(ctx, tx, s, out)
	})
	return out, translate(err)
}

func insertRevision(ctx context.Context, tx pgx.Tx, s Scope, d Dataset) error {
	tag, err := tx.Exec(ctx, `
		INSERT INTO dataset_revisions (dataset_id, revision, org_id, spec, spec_version, created_by, name, description, datasource_id, datasource_name)
		SELECT $1, $2, $3, $4, $5, $6, $7, $8, id, name FROM datasources
		WHERE id = $9 AND org_id = $3 AND workspace_id = $10`,
		d.ID, d.Revision, s.OrgID, d.Spec, d.SpecVersion, s.actor(), d.Name, d.Description, d.DatasourceID, s.WorkspaceID)
	if err == nil && tag.RowsAffected() != 1 {
		return ErrNotFound
	}
	return err
}

func DeleteDataset(ctx context.Context, pool *pgxpool.Pool, s Scope, datasetID string) error {
	tag, err := pool.Exec(ctx, `DELETE FROM datasets WHERE org_id = $1 AND workspace_id = $2 AND id = $3`,
		s.OrgID, s.WorkspaceID, datasetID)
	if err != nil {
		return translate(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
