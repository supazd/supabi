package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/supazd/supabi/internal/authz"
	"github.com/supazd/supabi/internal/id"
)

var ErrExportLimit = errors.New("too many active exports")

const JobLease = 30 * time.Second

type Job struct {
	ID, OrgID, Kind, Status, LeaseToken, ErrorCode string
	CreatedAt                                      time.Time
	StartedAt, FinishedAt                          *time.Time
	Attempts                                       int
}

type Export struct {
	CancelRequested bool
	Job
	WorkspaceID, UserID, DatasourceID, Name, Format string
	// Source is "sql" or "chart". A chart export names the widget it came
	// from, and the names it had then, to show where the file came from.
	Source, DashboardID, ItemID, ChartID string
	DashboardName, ChartName             string
	SourceSpec                           json.RawMessage
	Rows, SizeBytes                      int64
	FileKey                              string
	ExpiresAt, CleanedAt                 *time.Time
	// Unseen is a finished result its owner has not looked at yet.
	Unseen bool
}

const exportColumns = `j.id,j.org_id,j.kind,j.status,COALESCE(j.lease_token,''),j.error_code,j.created_at,j.started_at,j.finished_at,j.attempts,j.cancel_requested,
 e.workspace_id,e.user_id,e.datasource_id,e.name,e.format,e.source,e.dashboard_id,e.item_id,e.chart_id,e.dashboard_name,e.chart_name,e.source_spec,e.row_count,e.size_bytes,e.file_key,e.expires_at,e.cleaned_at,e.unseen`
const exportFrom = ` FROM exports e JOIN background_jobs j ON j.id=e.id AND j.org_id=e.org_id`

func scanExport(row pgx.Row) (Export, error) {
	var e Export
	err := row.Scan(&e.ID, &e.OrgID, &e.Kind, &e.Status, &e.LeaseToken, &e.ErrorCode, &e.CreatedAt, &e.StartedAt, &e.FinishedAt, &e.Attempts, &e.CancelRequested,
		&e.WorkspaceID, &e.UserID, &e.DatasourceID, &e.Name, &e.Format, &e.Source, &e.DashboardID, &e.ItemID, &e.ChartID, &e.DashboardName, &e.ChartName, &e.SourceSpec, &e.Rows, &e.SizeBytes, &e.FileKey, &e.ExpiresAt, &e.CleanedAt, &e.Unseen)
	return e, translate(err)
}

func CreateExport(ctx context.Context, pool *pgxpool.Pool, s Scope, e Export) (Export, error) {
	e.ID = id.New("exp")
	if e.Source == "" {
		e.Source = "sql"
	}
	err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		// Serialize quota checks for this owner without locking unrelated users.
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, s.OrgID+":"+s.UserID+":exports"); err != nil {
			return err
		}
		var active int
		if err := tx.QueryRow(ctx, `SELECT count(*)`+exportFrom+` WHERE e.org_id=$1 AND e.user_id=$2 AND j.status IN ('queued','running')`, s.OrgID, s.UserID).Scan(&active); err != nil {
			return err
		}
		if active >= 5 {
			return ErrExportLimit
		}
		if _, err := tx.Exec(ctx, `INSERT INTO background_jobs(id,org_id,kind) VALUES($1,$2,'export')`, e.ID, s.OrgID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `INSERT INTO exports(id,org_id,workspace_id,user_id,datasource_id,name,format,source,dashboard_id,item_id,chart_id,dashboard_name,chart_name,source_spec)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, e.ID, s.OrgID, s.WorkspaceID, s.UserID, e.DatasourceID, e.Name, e.Format, e.Source, e.DashboardID, e.ItemID, e.ChartID, e.DashboardName, e.ChartName, e.SourceSpec)
		return err
	})
	if err != nil {
		return Export{}, err
	}
	return GetExport(ctx, pool, s, e.ID)
}

func GetExport(ctx context.Context, pool *pgxpool.Pool, s Scope, exportID string) (Export, error) {
	return scanExport(pool.QueryRow(ctx, `SELECT `+exportColumns+exportFrom+` WHERE e.org_id=$1 AND e.workspace_id=$2 AND e.user_id=$3 AND e.id=$4`, s.OrgID, s.WorkspaceID, s.UserID, exportID))
}

func ListExports(ctx context.Context, pool *pgxpool.Pool, s Scope, before *time.Time) ([]Export, error) {
	rows, err := pool.Query(ctx, `SELECT `+exportColumns+exportFrom+` WHERE e.org_id=$1 AND e.workspace_id=$2 AND e.user_id=$3 AND ($4::timestamptz IS NULL OR j.created_at<$4) ORDER BY j.created_at DESC LIMIT 50`, s.OrgID, s.WorkspaceID, s.UserID, before)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (Export, error) { return scanExport(row) })
}

// ExportOwner returns a durable job's owner as they are now, independently
// of their browser session: role changes and disabled accounts take effect
// before execution. The role is empty for a disabled account or one no longer
// in the workspace.
func ExportOwner(ctx context.Context, pool *pgxpool.Pool, s Scope) (Principal, authz.Role, error) {
	p := Principal{OrgID: s.OrgID, WorkspaceID: s.WorkspaceID, UserID: s.UserID}
	err := pool.QueryRow(ctx, `SELECT u.email,u.display_name,u.is_org_admin FROM users u JOIN workspaces w ON w.org_id=u.org_id AND w.id=$3 WHERE u.org_id=$1 AND u.id=$2 AND u.status='active'`, s.OrgID, s.UserID, s.WorkspaceID).Scan(&p.Email, &p.DisplayName, &p.IsOrgAdmin)
	if errors.Is(err, pgx.ErrNoRows) {
		return p, "", nil
	}
	if err != nil {
		return p, "", err
	}
	r, err := WorkspaceRole(ctx, pool, p)
	return p, r, err
}

// ExportAllowed is whether the owner of a SQL export may still run it.
func ExportAllowed(ctx context.Context, pool *pgxpool.Pool, s Scope) (bool, error) {
	_, r, err := ExportOwner(ctx, pool, s)
	return r.AtLeast(authz.Developer), err
}

func ClaimJob(ctx context.Context, pool *pgxpool.Pool) (Job, error) {
	// A crashed worker may have exhausted its attempts or been cancelled.
	// A failure is a new result for its owner in the same statement.
	_, err := pool.Exec(ctx, `WITH finished AS (
 UPDATE background_jobs SET status=CASE WHEN cancel_requested THEN 'cancelled' ELSE 'failed' END,
 error_code=CASE WHEN cancel_requested THEN '' ELSE 'export_interrupted' END,finished_at=now(),lease_until=NULL
 WHERE status='running' AND lease_until<now() AND (attempts>=3 OR cancel_requested)
 RETURNING id,status
 ) UPDATE exports e SET unseen=true FROM finished f WHERE e.id=f.id AND f.status='failed'`)
	if err != nil {
		return Job{}, err
	}
	var j Job
	err = pool.QueryRow(ctx, `WITH picked AS (
 SELECT id FROM background_jobs WHERE (status='queued' OR (status='running' AND lease_until<now())) AND NOT cancel_requested AND attempts<3 ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1
 ) UPDATE background_jobs j SET status='running',lease_token=$1,lease_until=now()+$2*interval '1 second',attempts=attempts+1,started_at=now()
 FROM picked WHERE j.id=picked.id RETURNING j.id,j.org_id,j.kind,j.status,j.lease_token,j.error_code,j.created_at,j.started_at,j.finished_at,j.attempts`, id.New("run"), int(JobLease.Seconds())).Scan(&j.ID, &j.OrgID, &j.Kind, &j.Status, &j.LeaseToken, &j.ErrorCode, &j.CreatedAt, &j.StartedAt, &j.FinishedAt, &j.Attempts)
	return j, translate(err)
}

// Heartbeat refuses to revive an expired or cancelled lease. A late worker
// cannot publish output after another attempt has taken ownership.
func HeartbeatJob(ctx context.Context, pool *pgxpool.Pool, j Job, rows int64) (bool, error) {
	tag, err := pool.Exec(ctx, `WITH live AS (
 UPDATE background_jobs SET lease_until=now()+$3*interval '1 second' WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>now() AND NOT cancel_requested RETURNING id
 ) UPDATE exports SET row_count=$4 WHERE id IN (SELECT id FROM live)`, j.ID, j.LeaseToken, int(JobLease.Seconds()), rows)
	if j.Kind == "export" {
		return tag.RowsAffected() > 0, err
	}
	// Cleanup jobs have no export row; the lease was renewed by the CTE.
	var active bool
	if err == nil {
		err = pool.QueryRow(ctx, `SELECT status='running' AND lease_token=$2 AND lease_until>now() AND NOT cancel_requested FROM background_jobs WHERE id=$1`, j.ID, j.LeaseToken).Scan(&active)
	}
	return active, err
}

// FinishedExport is an export after its job ended, with its owner's email,
// to record what became of it.
func FinishedExport(ctx context.Context, pool *pgxpool.Pool, j Job) (Export, string, error) {
	var email string
	e, err := scanExport(pool.QueryRow(ctx, `SELECT `+exportColumns+exportFrom+` WHERE j.org_id=$1 AND j.id=$2`, j.OrgID, j.ID))
	if err == nil {
		err = translate(pool.QueryRow(ctx, `SELECT email FROM users WHERE org_id=$1 AND id=$2`, e.OrgID, e.UserID).Scan(&email))
	}
	return e, email, err
}

func LoadJobExport(ctx context.Context, pool *pgxpool.Pool, j Job) (Export, error) {
	return scanExport(pool.QueryRow(ctx, `SELECT `+exportColumns+exportFrom+` WHERE j.org_id=$1 AND j.id=$2 AND j.lease_token=$3 AND j.status='running'`, j.OrgID, j.ID, j.LeaseToken))
}

type ExportFile struct {
	Key         string
	Rows, Bytes int64
	Retention   time.Duration
}

// FinishJob publishes a file and marks the result new for its owner in the
// same transaction; a cancelled job is not new, its owner cancelled it.
// Cancellation wins if it was requested before this update acquired the row.
func FinishJob(ctx context.Context, pool *pgxpool.Pool, j Job, file ExportFile, code string) (string, error) {
	var status string
	err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `UPDATE background_jobs SET status=CASE WHEN cancel_requested THEN 'cancelled' WHEN $3<>'' THEN 'failed' ELSE 'succeeded' END,error_code=CASE WHEN cancel_requested THEN '' ELSE $3 END,finished_at=now(),lease_until=NULL
 WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>now() RETURNING status`, j.ID, j.LeaseToken, code).Scan(&status)
		if err != nil {
			return translate(err)
		}
		if j.Kind != "export" {
			return nil
		}
		switch status {
		case "succeeded":
			_, err = tx.Exec(ctx, `UPDATE exports SET file_key=$2,row_count=$3,size_bytes=$4,expires_at=now()+$5*interval '1 second',unseen=true WHERE id=$1`, j.ID, file.Key, file.Rows, file.Bytes, file.Retention.Seconds())
		case "failed":
			_, err = tx.Exec(ctx, `UPDATE exports SET unseen=true WHERE id=$1`, j.ID)
		}
		return err
	})
	return status, err
}

func CancelExport(ctx context.Context, pool *pgxpool.Pool, s Scope, exportID string) error {
	tag, err := pool.Exec(ctx, `UPDATE background_jobs j SET cancel_requested=CASE WHEN j.status IN ('queued','running') THEN true ELSE j.cancel_requested END,
 status=CASE WHEN j.status='queued' THEN 'cancelled' ELSE j.status END,finished_at=CASE WHEN j.status='queued' THEN now() ELSE j.finished_at END
 FROM exports e WHERE j.id=e.id AND e.org_id=$1 AND e.workspace_id=$2 AND e.user_id=$3 AND e.id=$4`, s.OrgID, s.WorkspaceID, s.UserID, exportID)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return err
}

// EnqueueExportCleanup schedules at most one cleanup per hour for each org
// that has exports; files are kept for a day, so an hour late is harmless.
// Orphans exist only beside an export row, which outlives its file by weeks.
func EnqueueExportCleanup(ctx context.Context, pool *pgxpool.Pool, now time.Time) error {
	_, err := pool.Exec(ctx, `INSERT INTO background_jobs(id,org_id,kind,dedupe_key) SELECT $1||'_'||o.id,o.id,'export_cleanup',$2 FROM orgs o WHERE EXISTS(SELECT 1 FROM exports e WHERE e.org_id=o.id) ON CONFLICT(org_id,dedupe_key) DO NOTHING`, id.New("job"), "exports:"+now.UTC().Format("2006-01-02T15"))
	return err
}

// UnseenExports counts the owner's new results in the workspace.
func UnseenExports(ctx context.Context, pool *pgxpool.Pool, s Scope) (int, error) {
	var n int
	err := pool.QueryRow(ctx, `SELECT count(*) FROM exports WHERE org_id=$1 AND workspace_id=$2 AND user_id=$3 AND unseen`, s.OrgID, s.WorkspaceID, s.UserID).Scan(&n)
	return n, err
}

// SeeExports marks all of the owner's new results in the workspace as seen.
func SeeExports(ctx context.Context, pool *pgxpool.Pool, s Scope) error {
	_, err := pool.Exec(ctx, `UPDATE exports SET unseen=false WHERE org_id=$1 AND workspace_id=$2 AND user_id=$3 AND unseen`, s.OrgID, s.WorkspaceID, s.UserID)
	return err
}

func ExpiredExports(ctx context.Context, pool *pgxpool.Pool, orgID string) ([]Export, error) {
	rows, err := pool.Query(ctx, `SELECT `+exportColumns+exportFrom+` WHERE e.org_id=$1 AND e.file_key<>'' AND e.cleaned_at IS NULL AND e.expires_at<=now() LIMIT 200`, orgID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Export, error) { return scanExport(r) })
}

func MarkExportCleaned(ctx context.Context, pool *pgxpool.Pool, exportID, key string) error {
	_, err := pool.Exec(ctx, `UPDATE exports SET cleaned_at=now() WHERE id=$1 AND file_key=$2 AND expires_at<=now()`, exportID, key)
	return err
}

func PruneExportHistory(ctx context.Context, pool *pgxpool.Pool, orgID string) error {
	_, err := pool.Exec(ctx, `DELETE FROM background_jobs j WHERE org_id=$1 AND finished_at<now()-interval '30 days' AND status IN ('succeeded','failed','cancelled') AND NOT EXISTS(SELECT 1 FROM exports e WHERE e.id=j.id AND e.file_key<>'' AND e.cleaned_at IS NULL)`, orgID)
	return err
}

// ReferencedExportFiles protects completed artifacts and live attempts while
// an orphan sweep removes files left by crashes or failed database commits.
func ReferencedExportFiles(ctx context.Context, pool *pgxpool.Pool, orgID string) (map[string]bool, map[string]bool, error) {
	rows, err := pool.Query(ctx, `SELECT e.file_key,e.workspace_id,e.id,CASE WHEN j.status='running' AND j.lease_until>now() THEN j.lease_token END FROM exports e JOIN background_jobs j ON j.id=e.id WHERE e.org_id=$1`, orgID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	files, attempts := map[string]bool{}, map[string]bool{}
	for rows.Next() {
		var key, workspace, exportID string
		var token *string
		if err := rows.Scan(&key, &workspace, &exportID, &token); err != nil {
			return nil, nil, err
		}
		if key != "" {
			files[key] = true
		}
		if token != nil {
			attempts[orgID+"/"+workspace+"/"+exportID+"/"+*token] = true
		}
	}
	return files, attempts, rows.Err()
}
