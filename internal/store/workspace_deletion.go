package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// A workspace is deleted in two steps: marked deleted, then purged with
// everything in it. See .agents/design/access-control.md 2.3.

var (
	// ErrWorkspaceDeleted means the workspace is already deleted.
	ErrWorkspaceDeleted = errors.New("the workspace is deleted")
	// ErrWorkspaceNotDeleted means only a deleted workspace can be restored
	// or purged, and this one is in use.
	ErrWorkspaceNotDeleted = errors.New("the workspace is not deleted")
	// ErrDeletedWorkspaceName means a deleted workspace still holds the
	// name, until it is restored or purged.
	ErrDeletedWorkspaceName = errors.New("a deleted workspace has the name")
)

const workspaceColumns = `id, name, timezone, week_start, first_week_days, deleted_at`

func scanWorkspace(row pgx.Row) (Workspace, error) {
	var w Workspace
	err := row.Scan(&w.ID, &w.Name, &w.Timezone, &w.WeekStart, &w.FirstWeekDays, &w.DeletedAt)
	return w, err
}

type rowQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

// workspaceState explains why a workspace was not in the state an operation
// needed: it does not exist, or wrong is why.
func workspaceState(ctx context.Context, db rowQuerier, orgID, workspaceID string, wrong error) error {
	var exists bool
	if err := db.QueryRow(ctx, `SELECT EXISTS (SELECT FROM workspaces WHERE org_id = $1 AND id = $2)`, orgID, workspaceID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return ErrNotFound
	}
	return wrong
}

// nameTaken tells a name held by a deleted workspace from one in use.
func nameTaken(ctx context.Context, pool *pgxpool.Pool, orgID, name string, err error) error {
	if !errors.Is(err, ErrConflict) {
		return err
	}
	var deleted bool
	if lookErr := pool.QueryRow(ctx, `SELECT EXISTS (SELECT FROM workspaces WHERE org_id = $1 AND name = $2 AND deleted_at IS NOT NULL)`, orgID, name).Scan(&deleted); lookErr != nil {
		return lookErr
	}
	if deleted {
		return ErrDeletedWorkspaceName
	}
	return err
}

// DeleteWorkspace marks a workspace deleted. In the same transaction its
// queued and running exports are cancelled, and the sessions in it leave it.
// The caller's, named by its token hash, moves to the first workspace its
// user can still enter, as on signing in, and its page starts afresh. The
// others are left without a current workspace: pages open in them would
// otherwise go on saving into a workspace their users did not choose.
func DeleteWorkspace(ctx context.Context, pool *pgxpool.Pool, orgID, workspaceID string, caller []byte) (Workspace, error) {
	var w Workspace
	err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		var err error
		w, err = scanWorkspace(tx.QueryRow(ctx, `UPDATE workspaces SET deleted_at = now(), updated_at = now()
			WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL RETURNING `+workspaceColumns, orgID, workspaceID))
		if errors.Is(err, pgx.ErrNoRows) {
			return workspaceState(ctx, tx, orgID, workspaceID, ErrWorkspaceDeleted)
		}
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE sessions s SET workspace_id = CASE WHEN s.token_hash = $3 THEN (
				SELECT w.id FROM workspaces w JOIN users u ON u.org_id = w.org_id AND u.id = s.user_id
				WHERE w.org_id = s.org_id AND w.deleted_at IS NULL AND `+workspaceAccess+`
				ORDER BY w.created_at, w.id LIMIT 1) END
			WHERE s.org_id = $1 AND s.workspace_id = $2`, orgID, workspaceID, caller); err != nil {
			return err
		}
		// As CancelExport does for one: a running job stops at its next heartbeat.
		_, err = tx.Exec(ctx, `UPDATE background_jobs j SET cancel_requested = true,
			status = CASE WHEN j.status = 'queued' THEN 'cancelled' ELSE j.status END,
			finished_at = CASE WHEN j.status = 'queued' THEN now() ELSE j.finished_at END
			FROM exports e WHERE j.id = e.id AND e.org_id = $1 AND e.workspace_id = $2 AND j.status IN ('queued', 'running')`, orgID, workspaceID)
		return err
	})
	return w, err
}

// RestoreWorkspace puts a deleted workspace back in use, as it was.
func RestoreWorkspace(ctx context.Context, pool *pgxpool.Pool, orgID, workspaceID string) (Workspace, error) {
	w, err := scanWorkspace(pool.QueryRow(ctx, `UPDATE workspaces SET deleted_at = NULL, updated_at = now()
		WHERE org_id = $1 AND id = $2 AND deleted_at IS NOT NULL RETURNING `+workspaceColumns, orgID, workspaceID))
	if errors.Is(err, pgx.ErrNoRows) {
		return w, workspaceState(ctx, pool, orgID, workspaceID, ErrWorkspaceNotDeleted)
	}
	return w, err
}

// ExpiredWorkspaces lists the org's workspaces deleted at least retention ago.
func ExpiredWorkspaces(ctx context.Context, pool *pgxpool.Pool, orgID string, retention time.Duration) ([]string, error) {
	rows, err := pool.Query(ctx, `SELECT id FROM workspaces WHERE org_id = $1 AND deleted_at <= now() - $2 * interval '1 second' ORDER BY deleted_at, id`,
		orgID, retention.Seconds())
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

// purgeStatements delete a workspace's contents, each after what refers to
// it; the rest of its rows go with the workspace itself. Rows that refer to
// these cascade with them: revisions, dashboard charts, grants and share
// conditions, dataset policies. A test checks that no table with a
// workspace_id keeps a row of a purged workspace.
var purgeStatements = []string{
	// An export's job owns it: deleting the job deletes the export.
	`DELETE FROM background_jobs j USING exports e WHERE e.id = j.id AND e.org_id = $1 AND e.workspace_id = $2`,
	`DELETE FROM dashboards WHERE org_id = $1 AND workspace_id = $2`,
	`DELETE FROM charts WHERE org_id = $1 AND workspace_id = $2`,
	`DELETE FROM datasets WHERE org_id = $1 AND workspace_id = $2`,
	`DELETE FROM datasources WHERE org_id = $1 AND workspace_id = $2`,
	// Folders, members and user attributes cascade.
	`DELETE FROM workspaces WHERE org_id = $1 AND id = $2`,
}

// Purged is what a purge removed that its caller has more to do about.
type Purged struct {
	// Name is the workspace's, for the record.
	Name string
	// Datasources are the IDs of its data sources, whose pooled
	// connections are to be closed, as on deleting one.
	Datasources []string
}

// PurgeWorkspace deletes a workspace deleted at least olderThan ago, and
// everything in it. removeFiles first deletes its export files from where
// they are stored; when that fails nothing else is deleted, for a later
// attempt to finish.
//
// Restoring the workspace while its files are being removed keeps the
// workspace but not those files, which only live a day anyway.
func PurgeWorkspace(ctx context.Context, pool *pgxpool.Pool, orgID, workspaceID string, olderThan time.Duration, removeFiles func(context.Context) error) (Purged, error) {
	const deleted = `SELECT name FROM workspaces WHERE org_id = $1 AND id = $2 AND deleted_at <= now() - $3 * interval '1 second'`
	check := func(db rowQuerier, query string) (string, error) {
		var name string
		err := db.QueryRow(ctx, query, orgID, workspaceID, olderThan.Seconds()).Scan(&name)
		if errors.Is(err, pgx.ErrNoRows) {
			return "", workspaceState(ctx, db, orgID, workspaceID, ErrWorkspaceNotDeleted)
		}
		return name, err
	}
	if _, err := check(pool, deleted); err != nil {
		return Purged{}, err
	}
	if err := removeFiles(ctx); err != nil {
		return Purged{}, fmt.Errorf("remove export files: %w", err)
	}
	var purged Purged
	err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		var err error
		// The lock keeps the workspace from being restored meanwhile.
		if purged.Name, err = check(tx, deleted+` FOR UPDATE`); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `SELECT id FROM datasources WHERE org_id = $1 AND workspace_id = $2`, orgID, workspaceID)
		if err != nil {
			return err
		}
		if purged.Datasources, err = pgx.CollectRows(rows, pgx.RowTo[string]); err != nil {
			return err
		}
		for _, statement := range purgeStatements {
			if _, err := tx.Exec(ctx, statement, orgID, workspaceID); err != nil {
				return err
			}
		}
		return nil
	})
	return purged, err
}
