package api

import (
	"context"
	"strconv"
	"time"

	"github.com/supazd/supabi/internal/api/gen"
	"github.com/supazd/supabi/internal/audit"
	"github.com/supazd/supabi/internal/store"
)

// The settings an organization has one value of, which system administrators
// set on the settings page: .agents/design/configuration.md 10.

func (s *Server) GetSystemSettings(ctx context.Context, _ gen.GetSystemSettingsRequestObject) (gen.GetSystemSettingsResponseObject, error) {
	v, err := store.GetSystemSettings(ctx, s.Pool, s.scope(ctx).OrgID)
	if err != nil {
		return nil, err
	}
	return gen.GetSystemSettings200JSONResponse(systemSettingsResponse(v)), nil
}

// SetSystemSettings records the settings before and after, which the
// request alone does not show.
func (s *Server) SetSystemSettings(ctx context.Context, req gen.SetSystemSettingsRequestObject) (gen.SetSystemSettingsResponseObject, error) {
	in := req.Body
	if in == nil {
		return nil, badRequest("invalid_request", "a request body is required")
	}
	v := store.SystemSettingValues{
		ExportRetentionHours: in.ExportRetentionHours, ExportTimeoutMinutes: in.ExportTimeoutMinutes, ExportMaxRows: in.ExportMaxRows,
		ExportMaxSizeMB: in.ExportMaxSizeMb, AuditRetentionDays: in.AuditRetentionDays, QueryCacheTTLMinutes: in.QueryCacheTtlMinutes,
		QueryTimeoutSeconds: in.QueryTimeoutSeconds, QueryDefaultRows: in.QueryDefaultRows, QueryMaxRows: in.QueryMaxRows,
		SessionLifetimeHours: in.SessionLifetimeHours, WorkspaceRetentionDays: in.WorkspaceRetentionDays, MCPEnabled: in.McpEnabled,
		AssistantCompressPercent: in.AssistantCompressPercent, AssistantMaxToolCalls: in.AssistantMaxToolCalls,
	}
	for _, r := range []struct {
		setting string
		value   *int64
		lo, hi  int64
	}{
		{"exportRetentionHours", widen(v.ExportRetentionHours), 1, 8760},
		{"exportTimeoutMinutes", widen(v.ExportTimeoutMinutes), 1, 1440},
		{"exportMaxRows", v.ExportMaxRows, 1, 100_000_000},
		{"exportMaxSizeMb", widen(v.ExportMaxSizeMB), 1, 1 << 20},
		{"auditRetentionDays", widen(v.AuditRetentionDays), 0, 36500},
		{"queryCacheTtlMinutes", widen(v.QueryCacheTTLMinutes), 1, 1440},
		{"queryTimeoutSeconds", widen(v.QueryTimeoutSeconds), 1, 3600},
		{"queryDefaultRows", widen(v.QueryDefaultRows), 1, 100_000},
		{"queryMaxRows", widen(v.QueryMaxRows), 1, 100_000},
		{"sessionLifetimeHours", widen(v.SessionLifetimeHours), 1, 8760},
		{"workspaceRetentionDays", widen(v.WorkspaceRetentionDays), 1, 3650},
		{"assistantCompressPercent", widen(v.AssistantCompressPercent), 50, 95},
		{"assistantMaxToolCalls", widen(v.AssistantMaxToolCalls), 0, 1000},
	} {
		if r.value != nil && (*r.value < r.lo || *r.value > r.hi) {
			lo, hi := strconv.FormatInt(r.lo, 10), strconv.FormatInt(r.hi, 10)
			return nil, &apiError{status: 400, code: "invalid_setting", message: r.setting + " must be between " + lo + " and " + hi,
				params: map[string]string{"setting": r.setting, "min": lo, "max": hi}}
		}
	}
	if inForce := v.InForce(); inForce.QueryDefaultRows > inForce.QueryMaxRows {
		return nil, badRequest("default_rows_above_max", "the default rows of a query cannot be more than the most it returns")
	}
	sc := s.scope(ctx)
	before, err := store.GetSystemSettings(ctx, s.Pool, sc.OrgID)
	if err != nil {
		return nil, err
	}
	if err := store.SetSystemSettings(ctx, s.Pool, sc, v); err != nil {
		return nil, err
	}
	e := s.event(ctx, "system_settings.update", audit.Success)
	e.Detail = map[string]any{"before": settingValues(before), "after": settingValues(v)}
	s.record(ctx, e)
	return gen.SetSystemSettings200JSONResponse(systemSettingsResponse(v)), nil
}

func widen(n *int) *int64 {
	if n == nil {
		return nil
	}
	wide := int64(*n)
	return &wide
}

// settingValues names every setting, with nil for one at its default.
func settingValues(v store.SystemSettingValues) map[string]any {
	value := func(n *int) any {
		if n == nil {
			return nil
		}
		return *n
	}
	var rows, mcp any
	if v.ExportMaxRows != nil {
		rows = *v.ExportMaxRows
	}
	if v.MCPEnabled != nil {
		mcp = *v.MCPEnabled
	}
	return map[string]any{
		"exportRetentionHours": value(v.ExportRetentionHours), "exportTimeoutMinutes": value(v.ExportTimeoutMinutes), "exportMaxRows": rows,
		"exportMaxSizeMb": value(v.ExportMaxSizeMB), "auditRetentionDays": value(v.AuditRetentionDays), "queryCacheTtlMinutes": value(v.QueryCacheTTLMinutes),
		"queryTimeoutSeconds": value(v.QueryTimeoutSeconds), "queryDefaultRows": value(v.QueryDefaultRows), "queryMaxRows": value(v.QueryMaxRows),
		"sessionLifetimeHours": value(v.SessionLifetimeHours), "workspaceRetentionDays": value(v.WorkspaceRetentionDays), "mcpEnabled": mcp,
		"assistantCompressPercent": value(v.AssistantCompressPercent), "assistantMaxToolCalls": value(v.AssistantMaxToolCalls),
	}
}

func systemSettingsResponse(v store.SystemSettingValues) gen.SystemSettings {
	d := store.DefaultSystemSettings
	return gen.SystemSettings{
		Values: gen.SystemSettingValues{
			ExportRetentionHours: v.ExportRetentionHours, ExportTimeoutMinutes: v.ExportTimeoutMinutes, ExportMaxRows: v.ExportMaxRows,
			ExportMaxSizeMb: v.ExportMaxSizeMB, AuditRetentionDays: v.AuditRetentionDays, QueryCacheTtlMinutes: v.QueryCacheTTLMinutes,
			QueryTimeoutSeconds: v.QueryTimeoutSeconds, QueryDefaultRows: v.QueryDefaultRows, QueryMaxRows: v.QueryMaxRows,
			SessionLifetimeHours: v.SessionLifetimeHours, WorkspaceRetentionDays: v.WorkspaceRetentionDays, McpEnabled: v.MCPEnabled,
			AssistantCompressPercent: v.AssistantCompressPercent, AssistantMaxToolCalls: v.AssistantMaxToolCalls,
		},
		Defaults: gen.SystemSettingDefaults{
			ExportRetentionHours: int(d.ExportRetention / time.Hour), ExportTimeoutMinutes: int(d.ExportTimeout / time.Minute), ExportMaxRows: d.ExportMaxRows,
			ExportMaxSizeMb: int(d.ExportMaxBytes >> 20), AuditRetentionDays: int(d.AuditRetention / (24 * time.Hour)), QueryCacheTtlMinutes: int(d.QueryCacheTTL / time.Minute),
			QueryTimeoutSeconds: int(d.QueryTimeout / time.Second), QueryDefaultRows: d.QueryDefaultRows, QueryMaxRows: d.QueryMaxRows,
			SessionLifetimeHours: int(d.SessionLifetime / time.Hour), WorkspaceRetentionDays: int(d.WorkspaceRetention / (24 * time.Hour)), McpEnabled: d.MCPEnabled,
			AssistantCompressPercent: d.AssistantCompressPercent, AssistantMaxToolCalls: d.AssistantMaxToolCalls,
		},
	}
}
