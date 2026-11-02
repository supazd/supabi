package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// RevisionSummary is one save of a dataset, chart or dashboard.
type RevisionSummary struct {
	Revision      int
	Name          string
	CreatedAt     time.Time
	CreatedBy     *string
	CreatedByName *string
}

type DatasetRevision struct {
	RevisionSummary
	Description    string
	DatasourceID   string
	DatasourceName string
	Spec           json.RawMessage
}

// History has the same workspace boundary as the live dataset. Actor names
// may change, but the saved definition and data source name never do.
const revisionFrom = ` FROM dataset_revisions r
	JOIN datasets d ON d.id = r.dataset_id AND d.org_id = r.org_id
	LEFT JOIN users u ON u.id = r.created_by AND u.org_id = r.org_id
	WHERE d.org_id = $1 AND d.workspace_id = $2 AND d.id = $3`

func ListDatasetRevisions(ctx context.Context, pool *pgxpool.Pool, s Scope, datasetID string, before, limit int) ([]RevisionSummary, error) {
	return listRevisions(ctx, pool, revisionFrom, s, datasetID, before, limit)
}

// listRevisions reads up to limit revisions older than before (all when it is
// zero), newest first. from names the revisions r and their authors u, and
// binds the organization, workspace and resource to $1, $2 and $3.
func listRevisions(ctx context.Context, pool *pgxpool.Pool, from string, s Scope, resourceID string, before, limit int) ([]RevisionSummary, error) {
	rows, err := pool.Query(ctx, `SELECT r.revision, r.name, r.created_at, r.created_by, u.display_name`+from+`
		AND ($4 = 0 OR r.revision < $4) ORDER BY r.revision DESC LIMIT $5`, s.OrgID, s.WorkspaceID, resourceID, before, limit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (RevisionSummary, error) {
		var r RevisionSummary
		err := row.Scan(&r.Revision, &r.Name, &r.CreatedAt, &r.CreatedBy, &r.CreatedByName)
		return r, err
	})
}

func GetDatasetRevision(ctx context.Context, pool *pgxpool.Pool, s Scope, datasetID string, revision int) (DatasetRevision, error) {
	var r DatasetRevision
	err := pool.QueryRow(ctx, `SELECT r.revision, r.name, r.created_at, r.created_by, u.display_name,
		r.description, r.datasource_id, r.datasource_name, r.spec`+revisionFrom+` AND r.revision = $4`,
		s.OrgID, s.WorkspaceID, datasetID, revision).Scan(&r.Revision, &r.Name, &r.CreatedAt, &r.CreatedBy, &r.CreatedByName,
		&r.Description, &r.DatasourceID, &r.DatasourceName, &r.Spec)
	return r, translate(err)
}

// DatasetRevisionWithField finds the most recent saved definition containing
// key. The dataset join keeps history confined to the caller's workspace;
// revisions themselves predate workspace_id. The full definition lets callers
// check visibility of calculated fields and their dependencies before naming one.
func DatasetRevisionWithField(ctx context.Context, pool *pgxpool.Pool, s Scope, datasetID, key string) (json.RawMessage, error) {
	var spec json.RawMessage
	err := pool.QueryRow(ctx, `
		SELECT r.spec FROM dataset_revisions r
		JOIN datasets d ON d.id = r.dataset_id AND d.org_id = r.org_id
		WHERE d.org_id = $1 AND d.workspace_id = $2 AND d.id = $3
		  AND r.spec->'fields' @> jsonb_build_array(jsonb_build_object('key', $4::text))
		ORDER BY r.revision DESC LIMIT 1`, s.OrgID, s.WorkspaceID, datasetID, key).Scan(&spec)
	return spec, translate(err)
}
