package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// System settings are those an organization has one value of. They are kept
// here, not in each instance's startup configuration, so that every instance
// reads the same: .agents/design/configuration.md 10.

// SystemSettingValues are the system settings as an administrator set them,
// in the units the settings page shows. Nil follows the default, which a
// newer version may change.
type SystemSettingValues struct {
	ExportRetentionHours *int
	ExportTimeoutMinutes *int
	ExportMaxRows        *int64
	ExportMaxSizeMB      *int
	// AuditRetentionDays is 0 to keep audit events.
	AuditRetentionDays     *int
	QueryCacheTTLMinutes   *int
	QueryTimeoutSeconds    *int
	QueryDefaultRows       *int
	QueryMaxRows           *int
	SessionLifetimeHours   *int
	WorkspaceRetentionDays *int
	MCPEnabled             *bool
	// AssistantCompressPercent and AssistantMaxToolCalls bound the AI
	// assistant: .agents/design/configuration.md 10.9.
	AssistantCompressPercent *int
	// AssistantMaxToolCalls is 0 to set no limit.
	AssistantMaxToolCalls *int
	// NotificationRefreshSeconds is how often open pages read the bell and
	// the banner: .agents/design/configuration.md 10.10.
	NotificationRefreshSeconds *int
}

// SystemSettings are the system settings in force.
type SystemSettings struct {
	// ExportRetention is how long a finished export file can be downloaded.
	ExportRetention time.Duration
	// ExportTimeout is the longest one attempt at an export may run.
	ExportTimeout  time.Duration
	ExportMaxRows  int64
	ExportMaxBytes int64
	// AuditRetention is how long audit events, and the records of calls to
	// models, are kept; zero keeps them.
	AuditRetention time.Duration
	// QueryCacheTTL is how long query results are kept, unless a data
	// source says otherwise.
	QueryCacheTTL time.Duration
	// QueryTimeout is the longest a statement of a query, a preview or a look
	// at a data source may run.
	QueryTimeout time.Duration
	// QueryDefaultRows is how many rows a query that does not say returns,
	// and QueryMaxRows the most it returns whatever it says.
	QueryDefaultRows, QueryMaxRows int
	// SessionLifetime is how long a session lasts without activity.
	SessionLifetime time.Duration
	// WorkspaceRetention is how long a deleted workspace can be restored
	// before the hourly maintenance purges it.
	WorkspaceRetention time.Duration
	// MCPEnabled lets people connect MCP clients: .agents/design/ai-assistant.md 14.6.
	MCPEnabled bool
	// AssistantCompressPercent is the share of a model's usable context past
	// which the AI assistant summarizes the earlier part of a conversation
	// before answering, and an answer is given no more tools.
	AssistantCompressPercent int
	// AssistantMaxToolCalls is the most tools one answer may call; 0 sets
	// no limit.
	AssistantMaxToolCalls int
	// NotificationRefresh is how often an open page reads the bell's badge
	// and the banner.
	NotificationRefresh time.Duration
}

// DefaultSystemSettings are the settings no administrator has changed.
var DefaultSystemSettings = SystemSettings{
	ExportRetention:          24 * time.Hour,
	ExportTimeout:            15 * time.Minute,
	ExportMaxRows:            2_000_000,
	ExportMaxBytes:           512 << 20,
	AuditRetention:           180 * 24 * time.Hour,
	QueryCacheTTL:            10 * time.Minute,
	QueryTimeout:             60 * time.Second,
	QueryDefaultRows:         1000,
	QueryMaxRows:             10000,
	SessionLifetime:          7 * 24 * time.Hour,
	WorkspaceRetention:       30 * 24 * time.Hour,
	AssistantCompressPercent: 80,
	AssistantMaxToolCalls:    60,
	NotificationRefresh:      time.Minute,
}

// InForce fills in the defaults of the settings left unset.
func (v SystemSettingValues) InForce() SystemSettings {
	s := DefaultSystemSettings
	if v.ExportRetentionHours != nil {
		s.ExportRetention = time.Duration(*v.ExportRetentionHours) * time.Hour
	}
	if v.ExportTimeoutMinutes != nil {
		s.ExportTimeout = time.Duration(*v.ExportTimeoutMinutes) * time.Minute
	}
	if v.ExportMaxRows != nil {
		s.ExportMaxRows = *v.ExportMaxRows
	}
	if v.ExportMaxSizeMB != nil {
		s.ExportMaxBytes = int64(*v.ExportMaxSizeMB) << 20
	}
	if v.AuditRetentionDays != nil {
		s.AuditRetention = time.Duration(*v.AuditRetentionDays) * 24 * time.Hour
	}
	if v.QueryCacheTTLMinutes != nil {
		s.QueryCacheTTL = time.Duration(*v.QueryCacheTTLMinutes) * time.Minute
	}
	if v.QueryTimeoutSeconds != nil {
		s.QueryTimeout = time.Duration(*v.QueryTimeoutSeconds) * time.Second
	}
	if v.QueryDefaultRows != nil {
		s.QueryDefaultRows = *v.QueryDefaultRows
	}
	if v.QueryMaxRows != nil {
		s.QueryMaxRows = *v.QueryMaxRows
	}
	if v.SessionLifetimeHours != nil {
		s.SessionLifetime = time.Duration(*v.SessionLifetimeHours) * time.Hour
	}
	if v.WorkspaceRetentionDays != nil {
		s.WorkspaceRetention = time.Duration(*v.WorkspaceRetentionDays) * 24 * time.Hour
	}
	if v.MCPEnabled != nil {
		s.MCPEnabled = *v.MCPEnabled
	}
	if v.AssistantCompressPercent != nil {
		s.AssistantCompressPercent = *v.AssistantCompressPercent
	}
	if v.AssistantMaxToolCalls != nil {
		s.AssistantMaxToolCalls = *v.AssistantMaxToolCalls
	}
	if v.NotificationRefreshSeconds != nil {
		s.NotificationRefresh = time.Duration(*v.NotificationRefreshSeconds) * time.Second
	}
	return s
}

func GetSystemSettings(ctx context.Context, pool *pgxpool.Pool, orgID string) (SystemSettingValues, error) {
	var v SystemSettingValues
	err := pool.QueryRow(ctx, `SELECT export_retention_hours, export_timeout_minutes, export_max_rows, export_max_size_mb,
 audit_retention_days, query_cache_ttl_minutes, query_timeout_seconds, query_default_rows, query_max_rows,
 session_lifetime_hours, workspace_retention_days, mcp_enabled, assistant_compress_percent, assistant_max_tool_calls,
 notification_refresh_seconds
 FROM system_settings WHERE org_id = $1`, orgID).Scan(
		&v.ExportRetentionHours, &v.ExportTimeoutMinutes, &v.ExportMaxRows, &v.ExportMaxSizeMB, &v.AuditRetentionDays, &v.QueryCacheTTLMinutes,
		&v.QueryTimeoutSeconds, &v.QueryDefaultRows, &v.QueryMaxRows, &v.SessionLifetimeHours, &v.WorkspaceRetentionDays, &v.MCPEnabled,
		&v.AssistantCompressPercent, &v.AssistantMaxToolCalls, &v.NotificationRefreshSeconds)
	if errors.Is(err, pgx.ErrNoRows) {
		return SystemSettingValues{}, nil
	}
	return v, err
}

// SystemSettingsInForce reads the settings anew where they are used, so that
// a change applies at once on every instance.
func SystemSettingsInForce(ctx context.Context, pool *pgxpool.Pool, orgID string) (SystemSettings, error) {
	v, err := GetSystemSettings(ctx, pool, orgID)
	return v.InForce(), err
}

// SetSystemSettings replaces every setting; nil returns one to its default.
// Sessions idle for longer than the lifetime end with it: a security setting
// made shorter should not wait for them to run out the old one.
func SetSystemSettings(ctx context.Context, pool *pgxpool.Pool, s Scope, v SystemSettingValues) error {
	return translate(pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `INSERT INTO system_settings (org_id, export_retention_hours, export_timeout_minutes, export_max_rows,
 export_max_size_mb, audit_retention_days, query_cache_ttl_minutes, query_timeout_seconds, query_default_rows, query_max_rows,
 session_lifetime_hours, workspace_retention_days, mcp_enabled, assistant_compress_percent, assistant_max_tool_calls,
 notification_refresh_seconds, updated_by)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
 ON CONFLICT (org_id) DO UPDATE SET export_retention_hours = EXCLUDED.export_retention_hours,
 export_timeout_minutes = EXCLUDED.export_timeout_minutes, export_max_rows = EXCLUDED.export_max_rows,
 export_max_size_mb = EXCLUDED.export_max_size_mb, audit_retention_days = EXCLUDED.audit_retention_days,
 query_cache_ttl_minutes = EXCLUDED.query_cache_ttl_minutes, query_timeout_seconds = EXCLUDED.query_timeout_seconds,
 query_default_rows = EXCLUDED.query_default_rows, query_max_rows = EXCLUDED.query_max_rows,
 session_lifetime_hours = EXCLUDED.session_lifetime_hours, workspace_retention_days = EXCLUDED.workspace_retention_days,
 mcp_enabled = EXCLUDED.mcp_enabled, assistant_compress_percent = EXCLUDED.assistant_compress_percent,
 assistant_max_tool_calls = EXCLUDED.assistant_max_tool_calls, notification_refresh_seconds = EXCLUDED.notification_refresh_seconds,
 updated_by = EXCLUDED.updated_by, updated_at = now()`,
			s.OrgID, v.ExportRetentionHours, v.ExportTimeoutMinutes, v.ExportMaxRows, v.ExportMaxSizeMB, v.AuditRetentionDays, v.QueryCacheTTLMinutes,
			v.QueryTimeoutSeconds, v.QueryDefaultRows, v.QueryMaxRows, v.SessionLifetimeHours, v.WorkspaceRetentionDays, v.MCPEnabled,
			v.AssistantCompressPercent, v.AssistantMaxToolCalls, v.NotificationRefreshSeconds, s.actor()); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `UPDATE sessions SET expires_at = LEAST(expires_at, last_seen_at + make_interval(secs => $2)) WHERE org_id = $1`,
			s.OrgID, v.InForce().SessionLifetime.Seconds())
		return err
	}))
}
