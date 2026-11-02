package store

import (
	"context"
	"encoding/json"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/supazd/supabi/internal/authz"
	"slices"
)

type AttributeAssignment struct {
	Subject authz.Subject `json:"subject"`
	Values  []string      `json:"values"`
}

type UserAttribute struct {
	Key         string
	Name        string
	Assignments []AttributeAssignment
}

func ListUserAttributes(ctx context.Context, pool *pgxpool.Pool, s Scope) ([]UserAttribute, error) {
	rows, err := pool.Query(ctx, `SELECT key, name, assignments FROM user_attributes WHERE org_id=$1 AND workspace_id=$2 ORDER BY key`, s.OrgID, s.WorkspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []UserAttribute{}
	for rows.Next() {
		var a UserAttribute
		var raw []byte
		if err := rows.Scan(&a.Key, &a.Name, &raw); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(raw, &a.Assignments); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func SetUserAttribute(ctx context.Context, pool *pgxpool.Pool, s Scope, a UserAttribute) error {
	raw, err := json.Marshal(a.Assignments)
	if err != nil {
		return err
	}
	err = pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		// Hold referenced groups until the write commits. Otherwise a request
		// validated just before deletion could recreate an orphan assignment.
		groups := []string{}
		for _, assignment := range a.Assignments {
			if assignment.Subject.GroupID != "" {
				groups = append(groups, assignment.Subject.GroupID)
			}
		}
		slices.Sort(groups)
		groups = slices.Compact(groups)
		rows, err := tx.Query(ctx, `SELECT id FROM user_groups WHERE org_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR KEY SHARE`, s.OrgID, groups)
		if err != nil {
			return err
		}
		found, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return err
		}
		if len(found) != len(groups) {
			return ErrInUse
		}
		_, err = tx.Exec(ctx, `INSERT INTO user_attributes (org_id, workspace_id, key, name, assignments, updated_by)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (org_id,workspace_id,key)
        DO UPDATE SET name=EXCLUDED.name, assignments=EXCLUDED.assignments, updated_by=EXCLUDED.updated_by, updated_at=now()`, s.OrgID, s.WorkspaceID, a.Key, a.Name, raw, s.UserID)
		return err
	})
	return translate(err)
}

func DeleteUserAttribute(ctx context.Context, pool *pgxpool.Pool, s Scope, key string) error {
	tag, err := pool.Exec(ctx, `DELETE FROM user_attributes WHERE org_id=$1 AND workspace_id=$2 AND key=$3`, s.OrgID, s.WorkspaceID, key)
	if err != nil {
		return translate(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// A user's explicit assignment overrides inherited values, including an empty
// assignment. Otherwise memberships contribute a union, independent of order.
func AttributeValues(attrs []UserAttribute, id authz.Identity) map[string][]string {
	out := map[string][]string{}
	for _, a := range attrs {
		values := []string{}
		for _, assignment := range a.Assignments {
			if assignment.Subject.GroupID != "" && id.Covers(assignment.Subject) {
				values = append(values, assignment.Values...)
			}
		}
		for _, assignment := range a.Assignments {
			if assignment.Subject.UserID == id.UserID && id.UserID != "" {
				values = assignment.Values
				break
			}
		}
		values = slices.Clone(values)
		slices.Sort(values)
		out[a.Key] = slices.Compact(values)
	}
	return out
}
