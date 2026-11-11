package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/supazd/supabi/internal/authz"
	"github.com/supazd/supabi/internal/id"
)

type User struct {
	ID           string
	OrgID        string
	Email        string
	DisplayName  string
	PasswordHash string // empty for accounts that cannot sign in with a password
	IsOrgAdmin   bool
	Status       string
}

const (
	UserActive   = "active"
	UserDisabled = "disabled"
)

// HasUsers reports whether the org has any account yet.
func HasUsers(ctx context.Context, pool *pgxpool.Pool, orgID string) (bool, error) {
	var exists bool
	err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT FROM users WHERE org_id = $1)`, orgID).Scan(&exists)
	return exists, err
}

// CreateFirstAdmin creates the first account of an org as its administrator
// and as an admin of the default workspace. It returns ErrConflict when the
// org already has an account, even if two requests race.
func CreateFirstAdmin(ctx context.Context, pool *pgxpool.Pool, orgID string, u User) (User, error) {
	u.ID, u.OrgID, u.IsOrgAdmin, u.Status = id.New("user"), orgID, true, UserActive
	err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		// Locking the org row makes concurrent setups take turns.
		if _, err := tx.Exec(ctx, `SELECT FROM orgs WHERE id = $1 FOR UPDATE`, orgID); err != nil {
			return err
		}
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT FROM users WHERE org_id = $1)`, orgID).Scan(&exists); err != nil {
			return err
		}
		if exists {
			return ErrConflict
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO users (id, org_id, email, display_name, password_hash, is_org_admin)
			VALUES ($1, $2, $3, $4, $5, true)`, u.ID, orgID, u.Email, u.DisplayName, u.PasswordHash); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO workspace_members (id, org_id, workspace_id, user_id, role)
			VALUES ($1, $2, $3, $4, 'admin')`,
			id.New("wm"), orgID, DefaultWorkspaceID, u.ID)
		return err
	})
	return u, translate(err)
}

func GetUserByEmail(ctx context.Context, pool *pgxpool.Pool, orgID, email string) (User, error) {
	u := User{OrgID: orgID}
	var hash *string
	err := pool.QueryRow(ctx, `
		SELECT id, email, display_name, password_hash, is_org_admin, status
		FROM users WHERE org_id = $1 AND lower(email) = lower($2)`, orgID, email).
		Scan(&u.ID, &u.Email, &u.DisplayName, &hash, &u.IsOrgAdmin, &u.Status)
	if hash != nil {
		u.PasswordHash = *hash
	}
	return u, translate(err)
}

func GetUserPasswordHash(ctx context.Context, pool *pgxpool.Pool, orgID, userID string) (string, error) {
	var hash *string
	err := pool.QueryRow(ctx, `SELECT password_hash FROM users WHERE org_id = $1 AND id = $2`, orgID, userID).Scan(&hash)
	if err != nil || hash == nil {
		return "", translate(err)
	}
	return *hash, nil
}

// SetPassword stores a new password hash and signs the user out everywhere
// except the session identified by keepTokenHash (nil: everywhere).
func SetPassword(ctx context.Context, pool *pgxpool.Pool, orgID, userID, passwordHash string, keepTokenHash []byte) error {
	return translate(pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE users SET password_hash = $3, updated_at = now() WHERE org_id = $1 AND id = $2`, orgID, userID, passwordHash)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		_, err = tx.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1 AND token_hash IS DISTINCT FROM $2`, userID, keepTokenHash)
		return err
	}))
}

// ---- sessions ----

// Principal is who a request acts as, and where.
type Principal struct {
	UserID      string
	OrgID       string
	WorkspaceID string // empty when the user belongs to no workspace
	Email       string
	DisplayName string
	IsOrgAdmin  bool
	ExpiresAt   time.Time
	LastSeenAt  time.Time
}

// CreateSession starts a session in the user's first workspace, and removes
// the user's expired sessions while it is there.
func CreateSession(ctx context.Context, pool *pgxpool.Pool, u User, tokenHash []byte, lifetime time.Duration) error {
	_, err := pool.Exec(ctx, `
		WITH expired AS (DELETE FROM sessions WHERE user_id = $2 AND expires_at < now())
		INSERT INTO sessions (token_hash, org_id, user_id, workspace_id, expires_at)
		VALUES ($3, $1, $2, (
			SELECT w.id FROM workspaces w
			WHERE w.org_id = $1 AND w.deleted_at IS NULL AND ($4 OR EXISTS (
				SELECT FROM workspace_members m
				LEFT JOIN user_group_members g ON g.group_id = m.group_id
				WHERE m.workspace_id = w.id AND (m.user_id = $2 OR g.user_id = $2)))
			ORDER BY w.created_at, w.id LIMIT 1
		), now() + make_interval(secs => $5))`,
		u.OrgID, u.ID, tokenHash, u.IsOrgAdmin, lifetime.Seconds())
	return err
}

// GetPrincipal resolves a session. It returns ErrNotFound when the session
// does not exist, has expired, or belongs to a disabled user. A deleted
// workspace is no workspace: deleting one moves its sessions away, and this
// covers a request that started before.
func GetPrincipal(ctx context.Context, pool *pgxpool.Pool, tokenHash []byte) (Principal, error) {
	var p Principal
	var workspace *string
	err := pool.QueryRow(ctx, `
		SELECT u.id, u.org_id, w.id, u.email, u.display_name, u.is_org_admin, s.expires_at, s.last_seen_at
		FROM sessions s JOIN users u ON u.id = s.user_id
		LEFT JOIN workspaces w ON w.org_id = s.org_id AND w.id = s.workspace_id AND w.deleted_at IS NULL
		WHERE s.token_hash = $1 AND s.expires_at > now() AND u.status = 'active'`, tokenHash).
		Scan(&p.UserID, &p.OrgID, &workspace, &p.Email, &p.DisplayName, &p.IsOrgAdmin, &p.ExpiresAt, &p.LastSeenAt)
	if workspace != nil {
		p.WorkspaceID = *workspace
	}
	return p, translate(err)
}

// TouchSession records activity and pushes the expiry out.
func TouchSession(ctx context.Context, pool *pgxpool.Pool, tokenHash []byte, lifetime time.Duration) error {
	_, err := pool.Exec(ctx, `UPDATE sessions SET last_seen_at = now(), expires_at = now() + make_interval(secs => $2) WHERE token_hash = $1`,
		tokenHash, lifetime.Seconds())
	return err
}

func DeleteSession(ctx context.Context, pool *pgxpool.Pool, tokenHash []byte) error {
	_, err := pool.Exec(ctx, `DELETE FROM sessions WHERE token_hash = $1`, tokenHash)
	return err
}

// WorkspaceRole returns the principal's role in its workspace: the highest of
// those it holds there, directly or through groups. An org administrator is
// an admin of every workspace of the org. It is empty outside a workspace,
// and for someone who holds no role in theirs.
func WorkspaceRole(ctx context.Context, pool *pgxpool.Pool, p Principal) (authz.Role, error) {
	if p.WorkspaceID == "" {
		return "", nil
	}
	if p.IsOrgAdmin {
		return authz.Admin, nil
	}
	rows, err := pool.Query(ctx, `
		SELECT m.role
		FROM workspace_members m
		LEFT JOIN user_group_members g ON g.group_id = m.group_id
		WHERE m.org_id = $1 AND m.workspace_id = $2 AND (m.user_id = $3 OR g.user_id = $3)`,
		p.OrgID, p.WorkspaceID, p.UserID)
	if err != nil {
		return "", err
	}
	roles, err := pgx.CollectRows(rows, pgx.RowTo[authz.Role])
	if err != nil {
		return "", err
	}
	return authz.Highest(roles), nil
}

// ---- members ----

// Member is a user who belongs to a workspace directly, with their role there.
type Member struct {
	UserID      string
	Email       string
	DisplayName string
	Status      string
	IsOrgAdmin  bool
	Role        authz.Role
}

const memberQuery = `
	SELECT u.id, u.email, u.display_name, u.status, u.is_org_admin, m.role
	FROM workspace_members m JOIN users u ON u.id = m.user_id
	WHERE m.org_id = $1 AND m.workspace_id = $2`

func scanMember(row pgx.Row) (Member, error) {
	var m Member
	err := row.Scan(&m.UserID, &m.Email, &m.DisplayName, &m.Status, &m.IsOrgAdmin, &m.Role)
	return m, translate(err)
}

func ListMembers(ctx context.Context, pool *pgxpool.Pool, s Scope) ([]Member, error) {
	rows, err := pool.Query(ctx, memberQuery+` ORDER BY lower(u.email)`, s.OrgID, s.WorkspaceID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (Member, error) { return scanMember(row) })
}

func GetMember(ctx context.Context, pool *pgxpool.Pool, s Scope, userID string) (Member, error) {
	return scanMember(pool.QueryRow(ctx, memberQuery+` AND u.id = $3`, s.OrgID, s.WorkspaceID, userID))
}

// AddMember adds an existing user of the org to the workspace. It returns
// ErrConflict when they already belong to it.
func AddMember(ctx context.Context, pool *pgxpool.Pool, s Scope, userID string, role authz.Role) (Member, error) {
	if _, err := pool.Exec(ctx, `
		INSERT INTO workspace_members (id, org_id, workspace_id, user_id, role)
		VALUES ($1, $2, $3, $4, $5)`, id.New("wm"), s.OrgID, s.WorkspaceID, userID, role); err != nil {
		return Member{}, translate(err)
	}
	return GetMember(ctx, pool, s, userID)
}

func SetMemberRole(ctx context.Context, pool *pgxpool.Pool, s Scope, userID string, role authz.Role) (Member, error) {
	tag, err := pool.Exec(ctx, `UPDATE workspace_members SET role = $4 WHERE org_id = $1 AND workspace_id = $2 AND user_id = $3`,
		s.OrgID, s.WorkspaceID, userID, role)
	if err != nil {
		return Member{}, translate(err)
	}
	if tag.RowsAffected() == 0 {
		return Member{}, ErrNotFound
	}
	return GetMember(ctx, pool, s, userID)
}

// RemoveMember takes a user out of the workspace. Their account remains.
func RemoveMember(ctx context.Context, pool *pgxpool.Pool, s Scope, userID string) error {
	return deleteRow(ctx, pool, `DELETE FROM workspace_members WHERE org_id = $1 AND workspace_id = $2 AND user_id = $3`, s, userID)
}

// ---- users ----

const userColumns = `id, org_id, email, display_name, coalesce(password_hash, ''), is_org_admin, status`

func scanUser(row pgx.Row) (User, error) {
	var u User
	err := row.Scan(&u.ID, &u.OrgID, &u.Email, &u.DisplayName, &u.PasswordHash, &u.IsOrgAdmin, &u.Status)
	return u, translate(err)
}

func ListUsers(ctx context.Context, pool *pgxpool.Pool, orgID string) ([]User, error) {
	rows, err := pool.Query(ctx, `SELECT `+userColumns+` FROM users WHERE org_id = $1 ORDER BY lower(email)`, orgID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (User, error) { return scanUser(row) })
}

func GetUser(ctx context.Context, pool *pgxpool.Pool, orgID, userID string) (User, error) {
	return scanUser(pool.QueryRow(ctx, `SELECT `+userColumns+` FROM users WHERE org_id = $1 AND id = $2`, orgID, userID))
}

// CreateUser creates a global account. Workspace access is assigned separately.
// An email already used in the org gives ErrConflict.
func CreateUser(ctx context.Context, pool *pgxpool.Pool, orgID string, u User) (User, error) {
	u.ID, u.OrgID, u.Status = id.New("user"), orgID, UserActive
	_, err := pool.Exec(ctx, `
		INSERT INTO users (id, org_id, email, display_name, password_hash, is_org_admin)
		VALUES ($1, $2, $3, $4, $5, $6)`, u.ID, orgID, u.Email, u.DisplayName, u.PasswordHash, u.IsOrgAdmin)
	return u, translate(err)
}

// UserChange holds the parts of a user to change; nil leaves a part alone.
type UserChange struct {
	DisplayName  *string
	Status       *string
	PasswordHash *string
	IsOrgAdmin   *bool
}

// UpdateUser applies a change. Disabling a user or resetting their password
// also ends their sessions, and revokes their MCP authorizations, which it
// returns.
func UpdateUser(ctx context.Context, pool *pgxpool.Pool, orgID, userID string, c UserChange) (User, []MCPAuthorization, error) {
	var (
		out     User
		revoked []MCPAuthorization
	)
	err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		var err error
		out, err = scanUser(tx.QueryRow(ctx, `
			UPDATE users SET
				display_name  = coalesce($3, display_name),
				status        = coalesce($4, status),
				password_hash = coalesce($5, password_hash),
				is_org_admin  = coalesce($6, is_org_admin),
				updated_at    = now()
			WHERE org_id = $1 AND id = $2
			RETURNING `+userColumns, orgID, userID, c.DisplayName, c.Status, c.PasswordHash, c.IsOrgAdmin))
		if err != nil {
			return err
		}
		if c.PasswordHash != nil || (c.Status != nil && *c.Status != UserActive) {
			if _, err = tx.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1`, userID); err != nil {
				return err
			}
			revoked, err = revokeAllMCPAuthorizations(ctx, tx, userID)
		}
		return err
	})
	return out, revoked, translate(err)
}

// ---- groups ----

type Group struct {
	ID      string
	Name    string
	UserIDs []string
}

func ListGroups(ctx context.Context, pool *pgxpool.Pool, orgID string) ([]Group, error) {
	rows, err := pool.Query(ctx, `
		SELECT g.id, g.name, coalesce(array_agg(m.user_id ORDER BY m.user_id) FILTER (WHERE m.user_id IS NOT NULL), '{}')
		FROM user_groups g LEFT JOIN user_group_members m ON m.group_id = g.id
		WHERE g.org_id = $1 GROUP BY g.id ORDER BY g.name`, orgID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (Group, error) {
		var g Group
		err := row.Scan(&g.ID, &g.Name, &g.UserIDs)
		return g, err
	})
}

// SaveGroup creates the group when g.ID is empty and updates it otherwise,
// replacing its members. A user of another org violates a foreign key and
// gives ErrInUse; callers check the users first.
func SaveGroup(ctx context.Context, pool *pgxpool.Pool, orgID string, g Group) (Group, error) {
	err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		if g.ID == "" {
			g.ID = id.New("grp")
			if _, err := tx.Exec(ctx, `INSERT INTO user_groups (id, org_id, name) VALUES ($1, $2, $3)`, g.ID, orgID, g.Name); err != nil {
				return err
			}
		} else {
			tag, err := tx.Exec(ctx, `UPDATE user_groups SET name = $3, updated_at = now() WHERE org_id = $1 AND id = $2`, orgID, g.ID, g.Name)
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 0 {
				return ErrNotFound
			}
		}
		if _, err := tx.Exec(ctx, `DELETE FROM user_group_members WHERE group_id = $1`, g.ID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `INSERT INTO user_group_members (org_id, group_id, user_id) SELECT $1, $2, unnest($3::text[])`, orgID, g.ID, g.UserIDs)
		return err
	})
	return g, translate(err)
}

func DeleteGroup(ctx context.Context, pool *pgxpool.Pool, orgID, groupID string) error {
	return translate(pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `DELETE FROM user_groups WHERE org_id = $1 AND id = $2`, orgID, groupID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		// Groups belong to the organisation, so remove their attribute values
		// in every workspace, while retaining all other assignments and order.
		_, err = tx.Exec(ctx, `UPDATE user_attributes SET assignments = (
			SELECT coalesce(jsonb_agg(item ORDER BY position), '[]'::jsonb)
			FROM jsonb_array_elements(assignments) WITH ORDINALITY AS a(item, position)
			WHERE item->'subject'->>'group' IS DISTINCT FROM $2
		), updated_at = now()
		WHERE org_id = $1 AND assignments @> jsonb_build_array(jsonb_build_object('subject', jsonb_build_object('group', $2::text)))`, orgID, groupID)
		return err
	}))
}

// GroupGrant is a group's role in a workspace.
type GroupGrant struct {
	GroupID string
	Name    string
	Role    authz.Role
}

func ListGroupGrants(ctx context.Context, pool *pgxpool.Pool, s Scope) ([]GroupGrant, error) {
	rows, err := pool.Query(ctx, `
		SELECT g.id, g.name, m.role FROM workspace_members m JOIN user_groups g ON g.id = m.group_id
		WHERE m.org_id = $1 AND m.workspace_id = $2 ORDER BY g.name`, s.OrgID, s.WorkspaceID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (GroupGrant, error) {
		var g GroupGrant
		err := row.Scan(&g.GroupID, &g.Name, &g.Role)
		return g, err
	})
}

// SetGroupRole gives a group a role in the workspace, replacing any it had.
func SetGroupRole(ctx context.Context, pool *pgxpool.Pool, s Scope, groupID string, role authz.Role) error {
	_, err := pool.Exec(ctx, `
		INSERT INTO workspace_members (id, org_id, workspace_id, group_id, role)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (workspace_id, group_id) DO UPDATE SET role = EXCLUDED.role`,
		id.New("wm"), s.OrgID, s.WorkspaceID, groupID, role)
	return translate(err)
}

func RemoveGroupGrant(ctx context.Context, pool *pgxpool.Pool, s Scope, groupID string) error {
	return deleteRow(ctx, pool, `DELETE FROM workspace_members WHERE org_id = $1 AND workspace_id = $2 AND group_id = $3`, s, groupID)
}

// ---- workspaces ----

const workspaceAccess = `(u.is_org_admin OR EXISTS (
	SELECT FROM workspace_members m LEFT JOIN user_group_members g ON g.group_id = m.group_id
	WHERE m.workspace_id = w.id AND (m.user_id = u.id OR g.user_id = u.id)))`

// ListWorkspaces returns the workspaces the user can enter: those they belong
// to, directly or through a group, or all of the org's for an administrator.
// withDeleted adds the deleted ones, which nobody can enter, for an
// administrator to restore or purge.
func ListWorkspaces(ctx context.Context, pool *pgxpool.Pool, orgID, userID string, withDeleted bool) ([]Workspace, error) {
	rows, err := pool.Query(ctx, `
		SELECT w.id, w.name, w.timezone, w.week_start, w.first_week_days, w.deleted_at
		FROM workspaces w JOIN users u ON u.org_id = w.org_id AND u.id = $2
		WHERE w.org_id = $1 AND `+workspaceAccess+` AND ($3 OR w.deleted_at IS NULL)
		ORDER BY w.created_at, w.id`, orgID, userID, withDeleted)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (Workspace, error) { return scanWorkspace(row) })
}

func CreateWorkspace(ctx context.Context, pool *pgxpool.Pool, s Scope, w Workspace) (Workspace, error) {
	w.ID = id.New("ws")
	_, err := pool.Exec(ctx, `INSERT INTO workspaces (id, org_id, name, timezone, week_start, first_week_days, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		w.ID, s.OrgID, w.Name, w.Timezone, w.WeekStart, w.FirstWeekDays, s.actor())
	return w, nameTaken(ctx, pool, s.OrgID, w.Name, translate(err))
}

func UpdateWorkspace(ctx context.Context, pool *pgxpool.Pool, s Scope, w Workspace) (Workspace, error) {
	tag, err := pool.Exec(ctx, `UPDATE workspaces SET name = $3, timezone = $4, week_start = $5, first_week_days = $6, updated_at = now() WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL`,
		s.OrgID, s.WorkspaceID, w.Name, w.Timezone, w.WeekStart, w.FirstWeekDays)
	if err != nil {
		return w, nameTaken(ctx, pool, s.OrgID, w.Name, translate(err))
	}
	if tag.RowsAffected() == 0 {
		return w, ErrNotFound
	}
	w.ID = s.WorkspaceID
	return w, nil
}

// CanEnterWorkspace says whether the user can enter the workspace: it is one
// of their org's, not deleted, and they are a member of it or an
// administrator of the org.
func CanEnterWorkspace(ctx context.Context, pool *pgxpool.Pool, orgID, userID, workspaceID string) (bool, error) {
	var can bool
	err := pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT FROM workspaces w JOIN users u ON u.org_id = w.org_id AND u.id = $2
			WHERE w.org_id = $1 AND w.id = $3 AND w.deleted_at IS NULL AND `+workspaceAccess+`)`,
		orgID, userID, workspaceID).Scan(&can)
	return can, err
}

// SwitchWorkspace moves a session to another workspace, if its user can enter
// it; otherwise it returns ErrNotFound, without saying whether the workspace exists.
func SwitchWorkspace(ctx context.Context, pool *pgxpool.Pool, tokenHash []byte, workspaceID string) error {
	tag, err := pool.Exec(ctx, `
		UPDATE sessions s SET workspace_id = w.id
		FROM workspaces w, users u
		WHERE s.token_hash = $1 AND u.id = s.user_id AND w.org_id = s.org_id AND w.id = $2 AND w.deleted_at IS NULL AND `+workspaceAccess,
		tokenHash, workspaceID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
