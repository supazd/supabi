package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/supazd/supabi/internal/audit"
	"github.com/supazd/supabi/internal/id"
)

// AuditEvents keeps audit events in the metadata database.
type AuditEvents struct {
	Pool *pgxpool.Pool
}

var _ audit.Recorder = AuditEvents{}

func (a AuditEvents) Record(ctx context.Context, e audit.Event) error {
	category, ok := audit.CategoryOf(e.Action)
	if !ok {
		return fmt.Errorf("unknown audit action %q", e.Action)
	}
	if e.At.IsZero() {
		e.At = time.Now()
	}
	detail := e.Detail
	if detail == nil {
		detail = map[string]any{}
	}
	raw, err := json.Marshal(detail)
	if err != nil {
		return err
	}
	_, err = a.Pool.Exec(ctx, `INSERT INTO audit_events(id,org_id,occurred_at,workspace_id,actor_id,actor_email,category,action,outcome,object_type,object_id,object_name,detail,client_ip,forwarded_for,user_agent)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
		id.New("aud"), e.OrgID, e.At, e.WorkspaceID, e.ActorID, e.ActorEmail, category, e.Action, e.Outcome,
		e.Object.Type, e.Object.ID, e.Object.Name, raw, clip(e.ClientIP, 100), clip(e.ForwardedFor, 500), clip(e.UserAgent, 500))
	return err
}

// clip keeps headers a client controls to a sane length, cut at a character.
func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// AuditRecord is a stored event, with the names its actor and workspace
// have now.
type AuditRecord struct {
	ID                             string
	At                             time.Time
	WorkspaceID, WorkspaceName     string
	ActorID, ActorEmail, ActorName string
	Category                       audit.Category
	Action                         string
	Outcome                        audit.Outcome
	Object                         audit.Object
	Detail                         json.RawMessage
	ClientIP, ForwardedFor         string
	UserAgent                      string
}

// AuditCursor is where the previous page ended.
type AuditCursor struct {
	At time.Time
	ID string
}

type AuditFilter struct {
	WorkspaceID, ActorID string
	Category             audit.Category
	Outcome              audit.Outcome
	// From is inclusive and To exclusive; nil leaves that side open.
	From, To *time.Time
	Before   *AuditCursor
}

// ListAuditEvents returns an org's events, newest first.
func ListAuditEvents(ctx context.Context, pool *pgxpool.Pool, orgID string, f AuditFilter, limit int) ([]AuditRecord, error) {
	var beforeAt *time.Time
	var beforeID string
	if f.Before != nil {
		beforeAt, beforeID = &f.Before.At, f.Before.ID
	}
	rows, err := pool.Query(ctx, `SELECT a.id,a.occurred_at,a.workspace_id,a.actor_id,a.actor_email,a.category,a.action,a.outcome,a.object_type,a.object_id,a.object_name,a.detail,a.client_ip,a.forwarded_for,a.user_agent,
 COALESCE(u.display_name,''),COALESCE(w.name,'')
 FROM audit_events a
 LEFT JOIN users u ON u.org_id=a.org_id AND u.id=a.actor_id
 LEFT JOIN workspaces w ON w.org_id=a.org_id AND w.id=a.workspace_id
 WHERE a.org_id=$1
 AND ($2='' OR a.workspace_id=$2) AND ($3='' OR a.actor_id=$3) AND ($4='' OR a.category=$4) AND ($5='' OR a.outcome=$5)
 AND ($6::timestamptz IS NULL OR a.occurred_at>=$6) AND ($7::timestamptz IS NULL OR a.occurred_at<$7)
 AND ($8::timestamptz IS NULL OR (a.occurred_at,a.id)<($8,$9))
 ORDER BY a.occurred_at DESC,a.id DESC LIMIT $10`,
		orgID, f.WorkspaceID, f.ActorID, string(f.Category), string(f.Outcome), f.From, f.To, beforeAt, beforeID, limit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (AuditRecord, error) {
		var r AuditRecord
		err := row.Scan(&r.ID, &r.At, &r.WorkspaceID, &r.ActorID, &r.ActorEmail, &r.Category, &r.Action, &r.Outcome, &r.Object.Type, &r.Object.ID, &r.Object.Name, &r.Detail,
			&r.ClientIP, &r.ForwardedFor, &r.UserAgent, &r.ActorName, &r.WorkspaceName)
		return r, err
	})
}

// ObjectName returns what an audited object is called now, or "" when it
// does not exist (any more) or has no name of its own.
func ObjectName(ctx context.Context, pool *pgxpool.Pool, s Scope, kind, objectID string) (string, error) {
	var row pgx.Row
	switch kind {
	case "datasource", "dataset", "chart", "dashboard", "folder", "export":
		row = pool.QueryRow(ctx, `SELECT name FROM `+kind+`s WHERE org_id=$1 AND workspace_id=$2 AND id=$3`, s.OrgID, s.WorkspaceID, objectID)
	case "user_attribute":
		row = pool.QueryRow(ctx, `SELECT name FROM user_attributes WHERE org_id=$1 AND workspace_id=$2 AND key=$3`, s.OrgID, s.WorkspaceID, objectID)
	case "user":
		row = pool.QueryRow(ctx, `SELECT email FROM users WHERE org_id=$1 AND id=$2`, s.OrgID, objectID)
	case "group":
		row = pool.QueryRow(ctx, `SELECT name FROM user_groups WHERE org_id=$1 AND id=$2`, s.OrgID, objectID)
	case "workspace":
		row = pool.QueryRow(ctx, `SELECT name FROM workspaces WHERE org_id=$1 AND id=$2`, s.OrgID, objectID)
	case "ai_provider":
		row = pool.QueryRow(ctx, `SELECT name FROM ai_providers WHERE org_id=$1 AND id=$2`, s.OrgID, objectID)
	case "ai_model":
		row = pool.QueryRow(ctx, `SELECT model FROM ai_models WHERE org_id=$1 AND id=$2`, s.OrgID, objectID)
	default:
		return "", nil
	}
	var name string
	err := row.Scan(&name)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return name, err
}

// auditPruneBatch bounds how many events one statement deletes, so pruning
// a long backlog does not hold locks for long.
const auditPruneBatch = 10_000

// PruneAuditEvents deletes an org's events from before the cutoff and
// returns how many it deleted.
func PruneAuditEvents(ctx context.Context, pool *pgxpool.Pool, orgID string, before time.Time) (int64, error) {
	var total int64
	for {
		tag, err := pool.Exec(ctx, `DELETE FROM audit_events WHERE org_id=$1 AND id IN (SELECT id FROM audit_events WHERE org_id=$1 AND occurred_at<$2 LIMIT $3)`, orgID, before, auditPruneBatch)
		if err != nil {
			return total, err
		}
		total += tag.RowsAffected()
		if tag.RowsAffected() < auditPruneBatch {
			return total, nil
		}
	}
}

// DeleteExpiredSessions removes an org's sessions that have ended, and
// returns how many it removed.
func DeleteExpiredSessions(ctx context.Context, pool *pgxpool.Pool, orgID string) (int64, error) {
	tag, err := pool.Exec(ctx, `DELETE FROM sessions WHERE org_id=$1 AND expires_at<now()`, orgID)
	return tag.RowsAffected(), err
}

// EnqueueMaintenance schedules one maintenance job per org and hour. Every
// scheduler instance may try; the deduplication key keeps one.
func EnqueueMaintenance(ctx context.Context, pool *pgxpool.Pool, now time.Time) error {
	_, err := pool.Exec(ctx, `INSERT INTO background_jobs(id,org_id,kind,dedupe_key) SELECT $1||'_'||o.id,o.id,'maintenance',$2 FROM orgs o ON CONFLICT(org_id,dedupe_key) DO NOTHING`, id.New("job"), "maintenance:"+now.UTC().Format("2006-01-02T15"))
	return err
}

// PruneMaintenanceJobs forgets maintenance jobs that ended a week ago; one
// is queued every hour.
func PruneMaintenanceJobs(ctx context.Context, pool *pgxpool.Pool, orgID string) error {
	_, err := pool.Exec(ctx, `DELETE FROM background_jobs WHERE org_id=$1 AND kind='maintenance' AND status IN ('succeeded','failed','cancelled') AND finished_at<now()-interval '7 days'`, orgID)
	return err
}
