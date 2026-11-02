package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// DefaultOrgID is the single org of an installation without multi-tenancy.
const DefaultOrgID = "org_default"

// Bootstrap creates the rows every installation needs: the default org with a
// default workspace. It is idempotent. The workspace is only made with the
// org, in the same statement: after that it is the administrators' to delete
// like any other (.agents/design/access-control.md 2.3), and a restart must not
// bring it back, nor fail on a new workspace that took its name.
func Bootstrap(ctx context.Context, pool *pgxpool.Pool) error {
	if _, err := pool.Exec(ctx, `
		WITH org AS (INSERT INTO orgs (id, name) VALUES ($1, 'Default') ON CONFLICT (id) DO NOTHING RETURNING id)
		INSERT INTO workspaces (id, org_id, name) SELECT $2, id, 'Default' FROM org`,
		DefaultOrgID, DefaultWorkspaceID); err != nil {
		return fmt.Errorf("create default org and workspace: %w", err)
	}
	return nil
}
