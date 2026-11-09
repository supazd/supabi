package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/supazd/supabi/internal/id"
)

// Announcements are published by administrators to the organization or to
// one workspace, and read by everyone they concern: .agents/design/announcements.md.

type Announcement struct {
	ID string
	// StartNow starts it when it is saved, by the database's clock, which
	// is what shows it; StartsAt is then ignored.
	StartNow bool
	// WorkspaceID is empty for a system announcement, for the whole
	// organization; WorkspaceName is that workspace's current name.
	WorkspaceID, WorkspaceName string
	Title, Body                string
	StartsAt, EndsAt           time.Time
	// CreatedByName is who published it, as they are named now.
	CreatedByName        string
	CreatedAt, UpdatedAt time.Time
	// Unread is for one reader: it is in effect and they have not read it.
	Unread bool
}

const announcementColumns = `a.id, COALESCE(a.workspace_id, ''), a.title, a.body, a.starts_at, a.ends_at, a.created_at, a.updated_at`

func scanAnnouncement(row pgx.Row, more ...any) (Announcement, error) {
	var a Announcement
	err := row.Scan(append([]any{&a.ID, &a.WorkspaceID, &a.Title, &a.Body, &a.StartsAt, &a.EndsAt, &a.CreatedAt, &a.UpdatedAt}, more...)...)
	return a, translate(err)
}

// ---- managing: one scope, a workspace or the organization ----

// inScope matches announcements a of the scope's workspace, or the system
// ones when it has none. $1 is the org and $2 the workspace.
const inScope = `a.org_id = $1 AND a.workspace_id IS NOT DISTINCT FROM NULLIF($2, '')`

// managed is an announcement as administrators see it, with who published it.
const managed = `SELECT ` + announcementColumns + `, COALESCE(NULLIF(pub.display_name, ''), pub.email, '')
 FROM announcements a LEFT JOIN users pub ON pub.org_id = a.org_id AND pub.id = a.created_by WHERE ` + inScope

func scanManaged(row pgx.Row) (Announcement, error) {
	var name string
	a, err := scanAnnouncement(row, &name)
	a.CreatedByName = name
	return a, err
}

// ListAnnouncements is every announcement of the scope, Scheduled and Ended
// ones included, the latest start first.
func ListAnnouncements(ctx context.Context, pool *pgxpool.Pool, s Scope) ([]Announcement, error) {
	rows, err := pool.Query(ctx, managed+` ORDER BY a.starts_at DESC, a.id DESC`, s.OrgID, s.WorkspaceID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (Announcement, error) { return scanManaged(row) })
}

// GetAnnouncement is one announcement of the scope.
func GetAnnouncement(ctx context.Context, pool *pgxpool.Pool, s Scope, announcementID string) (Announcement, error) {
	return scanManaged(pool.QueryRow(ctx, managed+` AND a.id = $3`, s.OrgID, s.WorkspaceID, announcementID))
}

// start is the start to save: now, or the one asked for.
func (a Announcement) start() *time.Time {
	if a.StartNow {
		return nil
	}
	return &a.StartsAt
}

// CreateAnnouncement publishes a in the scope.
func CreateAnnouncement(ctx context.Context, pool *pgxpool.Pool, s Scope, a Announcement) (Announcement, error) {
	a.ID = id.New("ann")
	_, err := pool.Exec(ctx, `INSERT INTO announcements (id, org_id, workspace_id, title, body, starts_at, ends_at, created_by)
 VALUES ($1, $2, NULLIF($3, ''), $4, $5, COALESCE($6, now()), $7, $8)`, a.ID, s.OrgID, s.WorkspaceID, a.Title, a.Body, a.start(), a.EndsAt, s.actor())
	if err != nil {
		return Announcement{}, translate(err)
	}
	return GetAnnouncement(ctx, pool, s, a.ID)
}

// UpdateAnnouncement replaces the text and the period. Who has read it stays
// as it was: an edit does not tell everyone again.
func UpdateAnnouncement(ctx context.Context, pool *pgxpool.Pool, s Scope, a Announcement) (Announcement, error) {
	tag, err := pool.Exec(ctx, `UPDATE announcements a SET title = $4, body = $5, starts_at = COALESCE($6, now()), ends_at = $7, updated_by = $8, updated_at = now()
 WHERE `+inScope+` AND a.id = $3`, s.OrgID, s.WorkspaceID, a.ID, a.Title, a.Body, a.start(), a.EndsAt, s.actor())
	if err != nil {
		return Announcement{}, translate(err)
	}
	if tag.RowsAffected() == 0 {
		return Announcement{}, ErrNotFound
	}
	return GetAnnouncement(ctx, pool, s, a.ID)
}

// EndAnnouncement ends an announcement in effect at once, by the database's
// clock. One that has not started, or has ended, is left as it is and gives
// ErrConflict.
func EndAnnouncement(ctx context.Context, pool *pgxpool.Pool, s Scope, announcementID string) (Announcement, error) {
	tag, err := pool.Exec(ctx, `UPDATE announcements a SET ends_at = now(), updated_by = $4, updated_at = now()
 WHERE `+inScope+` AND a.id = $3 AND a.starts_at < now() AND a.ends_at > now()`, s.OrgID, s.WorkspaceID, announcementID, s.actor())
	if err != nil {
		return Announcement{}, translate(err)
	}
	if tag.RowsAffected() == 0 {
		if _, err := GetAnnouncement(ctx, pool, s, announcementID); err != nil {
			return Announcement{}, err
		}
		return Announcement{}, ErrConflict
	}
	return GetAnnouncement(ctx, pool, s, announcementID)
}

// DeleteAnnouncement removes it from everyone's notifications, with who has
// read it.
func DeleteAnnouncement(ctx context.Context, pool *pgxpool.Pool, s Scope, announcementID string) error {
	return translate(pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `DELETE FROM announcement_reads r USING announcements a WHERE r.announcement_id = a.id AND `+inScope+` AND a.id = $3`,
			s.OrgID, s.WorkspaceID, announcementID); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `DELETE FROM announcements a WHERE `+inScope+` AND a.id = $3`, s.OrgID, s.WorkspaceID, announcementID)
		if err == nil && tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		return err
	}))
}

// ---- reading: what one person is shown ----

// shownTo are the announcements that have started and that the person $2 of
// the org $1 may see: the system ones, and those of the workspaces they can
// enter now, which the workspace switcher lists.
const shownTo = ` FROM announcements a
 JOIN users u ON u.org_id = a.org_id AND u.id = $2
 LEFT JOIN workspaces w ON w.org_id = a.org_id AND w.id = a.workspace_id
 WHERE a.org_id = $1 AND a.starts_at <= now()
 AND (a.workspace_id IS NULL OR (w.deleted_at IS NULL AND ` + workspaceAccess + `))`

// unread is an announcement in effect that the person $2 has not read. One
// that has ended is history and counts no longer.
const unread = `a.ends_at > now() AND NOT EXISTS (SELECT FROM announcement_reads r WHERE r.announcement_id = a.id AND r.user_id = $2)`

// ListShownAnnouncements is a page of the bell: started announcements the
// person may see, the latest start first. category is "system",
// "workspace" or empty for both; before continues a previous page.
func ListShownAnnouncements(ctx context.Context, pool *pgxpool.Pool, orgID, userID, category string, before *time.Time, limit int) ([]Announcement, error) {
	rows, err := pool.Query(ctx, `SELECT `+announcementColumns+`, COALESCE(w.name, ''), `+unread+shownTo+`
 AND ($3 = '' OR ($3 = 'system') = (a.workspace_id IS NULL))
 AND ($4::timestamptz IS NULL OR a.starts_at < $4)
 ORDER BY a.starts_at DESC, a.id DESC LIMIT $5`, orgID, userID, category, before, limit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (Announcement, error) {
		var name string
		var isUnread bool
		a, err := scanAnnouncement(row, &name, &isUnread)
		a.WorkspaceName, a.Unread = name, isUnread
		return a, err
	})
}

// NotificationSummary is what the top bar shows a person without opening
// the bell.
type NotificationSummary struct {
	// Unread counts the announcements in effect they have not read, in
	// every workspace they can enter.
	Unread int
	// Banner holds the first of those that are the organization's or the
	// current workspace's, system ones first; BannerTotal counts them all.
	Banner      []Announcement
	BannerTotal int
}

// SummarizeNotifications reads the badge and the banner of a person whose
// current workspace is workspaceID, which may be empty.
func SummarizeNotifications(ctx context.Context, pool *pgxpool.Pool, orgID, userID, workspaceID string, bannerLimit int) (NotificationSummary, error) {
	var out NotificationSummary
	err := pool.QueryRow(ctx, `SELECT count(*), count(*) FILTER (WHERE a.workspace_id IS NULL OR a.workspace_id = NULLIF($3, ''))`+shownTo+` AND `+unread,
		orgID, userID, workspaceID).Scan(&out.Unread, &out.BannerTotal)
	if err != nil {
		return out, err
	}
	rows, err := pool.Query(ctx, `SELECT `+announcementColumns+`, COALESCE(w.name, '')`+shownTo+` AND `+unread+`
 AND (a.workspace_id IS NULL OR a.workspace_id = NULLIF($3, ''))
 ORDER BY a.workspace_id IS NOT NULL, a.starts_at DESC, a.id DESC LIMIT $4`, orgID, userID, workspaceID, bannerLimit)
	if err != nil {
		return out, err
	}
	out.Banner, err = pgx.CollectRows(rows, func(row pgx.CollectableRow) (Announcement, error) {
		var name string
		a, err := scanAnnouncement(row, &name)
		a.WorkspaceName, a.Unread = name, true
		return a, err
	})
	return out, err
}

// ReadAnnouncement marks one announcement the person may see as read. One
// they may not see gives ErrNotFound.
func ReadAnnouncement(ctx context.Context, pool *pgxpool.Pool, orgID, userID, announcementID string) error {
	tag, err := pool.Exec(ctx, `INSERT INTO announcement_reads (org_id, announcement_id, user_id) SELECT a.org_id, a.id, $2`+shownTo+` AND a.id = $3
 ON CONFLICT DO NOTHING`, orgID, userID, announcementID)
	if err != nil {
		return translate(err)
	}
	if tag.RowsAffected() == 0 {
		var shown bool
		if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT`+shownTo+` AND a.id = $3)`, orgID, userID, announcementID).Scan(&shown); err != nil {
			return err
		}
		if !shown {
			return ErrNotFound
		}
	}
	return nil
}

// ReadAllAnnouncements marks every unread announcement the person may see as
// read. Ended ones count no longer, so they are left alone.
func ReadAllAnnouncements(ctx context.Context, pool *pgxpool.Pool, orgID, userID string) error {
	_, err := pool.Exec(ctx, `INSERT INTO announcement_reads (org_id, announcement_id, user_id) SELECT a.org_id, a.id, $2`+shownTo+` AND `+unread+`
 ON CONFLICT DO NOTHING`, orgID, userID)
	return translate(err)
}
