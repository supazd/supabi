// Package audit describes who did what to which object, and which data they
// read. Recorders keep the events: the metadata database for the audit page,
// and the application log for log collectors. See
// .agents/design/access-control.md §7.
package audit

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"
	"unicode/utf8"
)

// Category groups actions for filtering.
type Category string

const (
	Auth      Category = "auth"
	Account   Category = "account"
	Workspace Category = "workspace"
	Access    Category = "access"
	Content   Category = "content"
	Query     Category = "query"
	Export    Category = "export"
	AI        Category = "ai"
	System    Category = "system"
)

// Outcome is how an operation ended. Changes record only success and denial:
// a change that failed changed nothing.
type Outcome string

const (
	Success Outcome = "success"
	// Failure is recorded for sign-ins, queries, finished exports and test
	// emails only.
	Failure Outcome = "failure"
	// Denied is a refusal by a permission check.
	Denied Outcome = "denied"
)

// actions is every event there is, with its category. The web interface
// names each of them; keep its translations in step.
var actions = map[string]Category{
	"auth.setup":           Auth,
	"auth.login":           Auth,
	"auth.logout":          Auth,
	"auth.password_change": Auth,
	"mcp.authorize":        Auth,
	"mcp.revoke":           Auth,

	"user.create":  Account,
	"user.update":  Account,
	"group.create": Account,
	"group.update": Account,
	"group.delete": Account,

	"workspace.create":    Workspace,
	"workspace.update":    Workspace,
	"workspace.delete":    Workspace,
	"workspace.restore":   Workspace,
	"workspace.purge":     Workspace,
	"member.add":          Workspace,
	"member.update":       Workspace,
	"member.remove":       Workspace,
	"group_member.set":    Workspace,
	"group_member.remove": Workspace,

	"dashboard_grants.update": Access,
	"dataset_policy.update":   Access,
	"user_attribute.set":      Access,
	"user_attribute.delete":   Access,

	"datasource.create": Content,
	"datasource.update": Content,
	"datasource.delete": Content,
	"dataset.create":    Content,
	"dataset.update":    Content,
	"dataset.delete":    Content,
	"chart.create":      Content,
	"chart.update":      Content,
	"chart.delete":      Content,
	"dashboard.create":  Content,
	"dashboard.update":  Content,
	"dashboard.delete":  Content,
	"dashboard.share":   Content,
	"folder.create":     Content,
	"folder.update":     Content,
	"folder.delete":     Content,
	"resource.move":     Content,

	"query.run": Query,

	"export.create":   Export,
	"export.finish":   Export,
	"export.cancel":   Export,
	"export.download": Export,

	"ai_provider.create": AI,
	"ai_provider.update": AI,
	"ai_provider.delete": AI,
	"ai_model.create":    AI,
	"ai_model.update":    AI,
	"ai_model.delete":    AI,
	"ai_settings.update": AI,

	"system_settings.update": System,
	"email_settings.update":  System,
	"email.test":             System,
}

// CategoryOf returns the category of an action, and whether the action exists.
func CategoryOf(action string) (Category, bool) {
	c, ok := actions[action]
	return c, ok
}

// Event is one thing that happened.
type Event struct {
	OrgID string
	// WorkspaceID is empty for sign-in, account and group events.
	WorkspaceID string
	At          time.Time
	// ActorID is empty when a sign-in names no existing account; ActorEmail
	// is then the address typed.
	ActorID, ActorEmail string
	Action              string
	Outcome             Outcome
	Object              Object
	// Detail is marshalled to JSON. Nothing in it may hold a password.
	Detail map[string]any
	// ClientIP is the connection's address; ForwardedFor is the header as
	// sent, which a client can forge.
	ClientIP, ForwardedFor, UserAgent string
}

// Object is what an event acted on. Name is as it was at the time.
type Object struct {
	Type, ID, Name string
}

// Statement is one statement sent to a data source for a query event.
type Statement struct {
	// Kind is main, total or subtotal for a chart query, rows otherwise.
	Kind         string `json:"kind"`
	DatasetID    string `json:"datasetId,omitempty"`
	DatasourceID string `json:"datasourceId"`
	SQL          string `json:"sql"`
	SQLClipped   bool   `json:"sqlClipped,omitempty"`
	Args         []any  `json:"args"`
	// DurationMs is the database's time, also for a result from the cache.
	DurationMs int64  `json:"durationMs"`
	Rows       int    `json:"rows"`
	Truncated  bool   `json:"truncated,omitempty"`
	Cached     bool   `json:"cached,omitempty"`
	Error      string `json:"error,omitempty"`
}

// MaxSQL is how much of a statement's SQL is kept.
const MaxSQL = 64 << 10

// NewStatement keeps at most MaxSQL bytes of the SQL, cut at a character.
func NewStatement(kind, datasourceID, sql string, args []any) Statement {
	s := Statement{Kind: kind, DatasourceID: datasourceID, SQL: sql, Args: append([]any{}, args...)}
	if len(sql) > MaxSQL {
		cut := MaxSQL
		for cut > 0 && !utf8.RuneStart(sql[cut]) {
			cut--
		}
		s.SQL, s.SQLClipped = sql[:cut], true
	}
	return s
}

// Recorder keeps events.
type Recorder interface {
	Record(ctx context.Context, e Event) error
}

// Recorders records an event with each of them in turn, and reports the
// errors of those that failed.
type Recorders []Recorder

func (rs Recorders) Record(ctx context.Context, e Event) error {
	var errs []error
	for _, r := range rs {
		if err := r.Record(ctx, e); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// Log writes an event as one structured log line, for log collectors to
// ship elsewhere. The detail stays out: SQL, arguments and request content
// are kept in the metadata database only.
type Log struct {
	Logger *slog.Logger
}

func (l Log) Record(ctx context.Context, e Event) error {
	l.Logger.InfoContext(ctx, "audit", Attrs(e)...)
	return nil
}

// Attrs are the fields of an event that may go to a log.
func Attrs(e Event) []any {
	return []any{"action", e.Action, "outcome", e.Outcome, "org", e.OrgID, "workspace", e.WorkspaceID,
		"actor", e.ActorID, "email", e.ActorEmail, "objectType", e.Object.Type, "objectId", e.Object.ID, "ip", e.ClientIP}
}

// Body turns request content into a detail, with every value under a key
// that mentions a password replaced.
func Body(v any) (map[string]any, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("audit content is not an object: %w", err)
	}
	return redact(out).(map[string]any), nil
}

const redacted = "[redacted]"

func redact(v any) any {
	switch v := v.(type) {
	case map[string]any:
		for key, value := range v {
			if strings.Contains(strings.ToLower(key), "password") {
				v[key] = redacted
			} else {
				v[key] = redact(value)
			}
		}
	case []any:
		for i, value := range v {
			v[i] = redact(value)
		}
	}
	return v
}
