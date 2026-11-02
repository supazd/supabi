package store

import (
	"context"
	"maps"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"
)

// Lock in ID order so saving content that uses several datasets cannot invert
// the order another save takes. SHARE also blocks ordinary non-key updates,
// which change definitions without changing foreign-key columns.
func lockDatasetRevisions(ctx context.Context, tx pgx.Tx, s Scope, expected map[string]int) error {
	if len(expected) == 0 {
		return nil
	}
	rows, err := tx.Query(ctx, `SELECT id, revision FROM datasets
		WHERE org_id = $1 AND workspace_id = $2 AND id = ANY($3) ORDER BY id FOR SHARE`,
		s.OrgID, s.WorkspaceID, slices.Sorted(maps.Keys(expected)))
	if err != nil {
		return err
	}
	defer rows.Close()
	found := 0
	for rows.Next() {
		var id string
		var revision int
		if err := rows.Scan(&id, &revision); err != nil {
			return err
		}
		if expected[id] != 0 && expected[id] != revision {
			return ErrDatasetChanged
		}
		found++
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if found != len(expected) {
		return ErrNotFound
	}
	return nil
}

func lockChartVersions(ctx context.Context, tx pgx.Tx, s Scope, chartIDs []string, expected map[string]time.Time) error {
	ids := slices.Clone(chartIDs)
	slices.Sort(ids)
	ids = slices.Compact(ids)
	charts, err := collectCharts(tx.Query(ctx, `SELECT `+chartColumns+` FROM charts
		WHERE org_id = $1 AND workspace_id = $2 AND id = ANY($3) ORDER BY id FOR SHARE`,
		s.OrgID, s.WorkspaceID, ids))
	if err != nil {
		return err
	}
	if len(charts) != len(ids) {
		return ErrNotFound
	}
	for _, chart := range charts {
		if at, exists := expected[chart.ID]; exists && !at.Equal(chart.UpdatedAt) {
			return ErrChartChanged
		}
	}
	return nil
}
