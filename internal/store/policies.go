package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DatasetPolicy is the stored data permissions of a dataset. The rules are
// kept as JSON; the policy package reads them.
type DatasetPolicy struct {
	Unmatched   string
	ColumnMode  string
	RowRules    json.RawMessage
	ColumnRules json.RawMessage
	// UpdatedBy and UpdatedAt are empty for a dataset whose permissions were never set.
	UpdatedBy *string
	UpdatedAt *time.Time
}

// GetDatasetPolicy returns the data permissions of a dataset, or those of a
// dataset nobody restricted when none were set. It returns ErrNotFound when
// the workspace has no such dataset.
func GetDatasetPolicy(ctx context.Context, pool *pgxpool.Pool, s Scope, datasetID string) (DatasetPolicy, error) {
	p := DatasetPolicy{Unmatched: "all", ColumnMode: "visible", RowRules: json.RawMessage(`[]`), ColumnRules: json.RawMessage(`[]`)}
	err := pool.QueryRow(ctx, `
		SELECT p.unmatched, p.column_mode, p.row_rules, p.column_rules, p.updated_by, p.updated_at
		FROM dataset_policies p WHERE p.org_id = $1 AND p.workspace_id = $2 AND p.dataset_id = $3`,
		s.OrgID, s.WorkspaceID, datasetID).Scan(&p.Unmatched, &p.ColumnMode, &p.RowRules, &p.ColumnRules, &p.UpdatedBy, &p.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		_, err = GetDataset(ctx, pool, s, datasetID)
		return p, err
	}
	return p, translate(err)
}

// SetDatasetPolicy replaces the data permissions of a dataset. It returns
// ErrNotFound when the workspace has no such dataset.
func SetDatasetPolicy(ctx context.Context, pool *pgxpool.Pool, s Scope, datasetID string, p DatasetPolicy) error {
	if _, err := GetDataset(ctx, pool, s, datasetID); err != nil {
		return err
	}
	if p.ColumnMode == "" {
		p.ColumnMode = "visible"
	}
	_, err := pool.Exec(ctx, `
		INSERT INTO dataset_policies (org_id, workspace_id, dataset_id, unmatched, column_mode, row_rules, column_rules, updated_by)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (dataset_id) DO UPDATE SET unmatched = EXCLUDED.unmatched, column_mode = EXCLUDED.column_mode, row_rules = EXCLUDED.row_rules,
			column_rules = EXCLUDED.column_rules, updated_by = EXCLUDED.updated_by, updated_at = now()`,
		s.OrgID, s.WorkspaceID, datasetID, p.Unmatched, p.ColumnMode, p.RowRules, p.ColumnRules, s.actor())
	return translate(err)
}
