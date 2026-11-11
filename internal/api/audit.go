package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"maps"
	"net"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"time"

	"github.com/supazd/supabi/internal/api/gen"
	"github.com/supazd/supabi/internal/audit"
	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/qcache"
	"github.com/supazd/supabi/internal/query"
	"github.com/supazd/supabi/internal/store"
)

// auditRule is what an operation records. See .agents/design/access-control.md §7.
type auditRule struct {
	// action is the event; empty records nothing.
	action string
	// object is the type of what the operation acts on, and from finds its ID.
	object string
	from   objectRef
	// body keeps the request content, passwords redacted, in the detail.
	body bool
	// handler records the event itself, with what only it knows. Refusals
	// by a permission check are still recorded for it.
	handler bool
}

// objectRef finds the ID of an operation's object. The response is nil
// until the operation has run.
type objectRef func(c *caller, response any) string

func pathParam(name string) objectRef {
	return func(c *caller, _ any) string { return c.r.PathValue(name) }
}

var byID = pathParam("id")

// created reads the ID that a created object came back with.
func created(field string) objectRef {
	return func(_ *caller, response any) string {
		v := reflect.ValueOf(response)
		if v.Kind() != reflect.Struct {
			return ""
		}
		if f := v.FieldByName(field); f.Kind() == reflect.String {
			return f.String()
		}
		return ""
	}
}

func self(c *caller, _ any) string             { return c.principal.UserID }
func currentWorkspace(c *caller, _ any) string { return c.principal.WorkspaceID }

const queryRun = "query.run"

func change(action, object string, from objectRef) auditRule {
	return auditRule{action: action, object: object, from: from}
}

// withBody is a change whose request content is kept.
func withBody(action, object string, from objectRef) auditRule {
	return auditRule{action: action, object: object, from: from, body: true}
}

func reads(object string, from objectRef) auditRule {
	return auditRule{action: queryRun, object: object, from: from}
}

// auditRules says what every operation records. Like the requirements
// table, it names every operation; a test keeps the two in step, so a new
// endpoint is not left out of the audit by accident.
var auditRules = map[string]auditRule{
	// Reading configuration records nothing.
	"GetSession": {}, "GetVersion": {}, "ListWorkspaces": {}, "SwitchWorkspace": {},
	"ListCharts": {}, "GetChart": {}, "ListChartRevisions": {}, "ListDashboards": {}, "GetDashboard": {}, "ListDashboardRevisions": {},
	"GetDashboardView": {}, "ResolveTimeRange": {}, "ListFolders": {},
	"ListExports": {}, "GetExport": {}, "MarkExportsSeen": {},
	"ListDatasourceTypes": {}, "ListDatasources": {}, "GetDatasource": {}, "ListSourceTables": {}, "ListFunctions": {},
	"ListDatasets": {}, "GetDataset": {}, "ListDatasetRevisions": {}, "GetDatasetRevision": {},
	"GetDatasetPolicy": {}, "GetUsage": {}, "GetLineage": {}, "ListUsers": {}, "ListGroups": {}, "ListUserAttributes": {},
	"ListMembers": {}, "ListGroupMembers": {}, "GetDashboardGrants": {}, "ListAuditEvents": {},
	// These reach a database without returning rows from it: columns of
	// LIMIT 0, a plan, a connection test, or checks before a save.
	"TestDatasource": {}, "TestStoredDatasource": {}, "DescribeSource": {}, "ExplainSource": {}, "CheckExpression": {}, "AnalyzeDatasetImpact": {},

	"Setup":          {action: "auth.setup", handler: true},
	"Login":          {action: "auth.login", handler: true},
	"Logout":         {action: "auth.logout"},
	"ChangePassword": change("auth.password_change", "user", self),
	// Allowing a client and revoking it name the client, which only the
	// handlers know. Reading a request or refusing it changes nothing.
	"GetOAuthRequest": {}, "DenyOAuthRequest": {}, "ListMCPAuthorizations": {},
	"ApproveOAuthRequest":    {action: "mcp.authorize", handler: true},
	"RevokeMCPAuthorization": {action: "mcp.revoke", handler: true},

	"CreateUser":       withBody("user.create", "user", created("Id")),
	"UpdateUser":       withBody("user.update", "user", byID),
	"CreateGroup":      withBody("group.create", "group", created("Id")),
	"UpdateGroup":      withBody("group.update", "group", byID),
	"DeleteGroup":      change("group.delete", "group", byID),
	"CreateWorkspace":  withBody("workspace.create", "workspace", created("Id")),
	"DeleteWorkspace":  change("workspace.delete", "workspace", byID),
	"RestoreWorkspace": change("workspace.restore", "workspace", byID),
	"PurgeWorkspace":   change("workspace.purge", "workspace", byID),

	"UpdateWorkspace":   withBody("workspace.update", "workspace", currentWorkspace),
	"AddMember":         withBody("member.add", "user", created("UserId")),
	"UpdateMember":      withBody("member.update", "user", pathParam("userId")),
	"RemoveMember":      change("member.remove", "user", pathParam("userId")),
	"SetGroupMember":    withBody("group_member.set", "group", pathParam("groupId")),
	"RemoveGroupMember": change("group_member.remove", "group", pathParam("groupId")),

	"SetDashboardGrants":  withBody("dashboard_grants.update", "dashboard", byID),
	"SetDatasetPolicy":    withBody("dataset_policy.update", "dataset", byID),
	"SetUserAttribute":    withBody("user_attribute.set", "user_attribute", pathParam("key")),
	"DeleteUserAttribute": change("user_attribute.delete", "user_attribute", pathParam("key")),

	"CreateDatasource": change("datasource.create", "datasource", created("Id")),
	"UpdateDatasource": change("datasource.update", "datasource", byID),
	"DeleteDatasource": change("datasource.delete", "datasource", byID),
	"CreateDataset":    change("dataset.create", "dataset", created("Id")),
	"UpdateDataset":    change("dataset.update", "dataset", byID),
	"DeleteDataset":    change("dataset.delete", "dataset", byID),
	"CreateChart":      change("chart.create", "chart", created("Id")),
	"UpdateChart":      change("chart.update", "chart", byID),
	"DeleteChart":      change("chart.delete", "chart", byID),
	"CreateDashboard":  change("dashboard.create", "dashboard", created("Id")),
	"UpdateDashboard":  change("dashboard.update", "dashboard", byID),
	"DeleteDashboard":  change("dashboard.delete", "dashboard", byID),
	// Who shared which conditions: the request is the conditions and their validity.
	"CreateDashboardView": withBody("dashboard.share", "dashboard", byID),
	"CreateFolder":        withBody("folder.create", "folder", created("Id")),
	"UpdateFolder":        withBody("folder.update", "folder", byID),
	"DeleteFolder":        change("folder.delete", "folder", byID),
	// The handler names the object, which the request body chooses.
	"MoveResource": {action: "resource.move", body: true},

	"GetChartData":                       reads("chart", byID),
	"GetChartFilterOptions":              reads("chart", byID),
	"QueryChartFilterOptions":            reads("chart", byID),
	"GetDashboardItemData":               reads("dashboard", byID),
	"GetDashboardFilterOptions":          reads("dashboard", byID),
	"QueryDashboardFilterOptions":        reads("dashboard", byID),
	"QueryDashboardChartFilterOptions":   reads("dashboard", byID),
	"PreviewChartData":                   reads("", nil),
	"PreviewChartFilterOptions":          reads("", nil),
	"PreviewDashboardItemData":           reads("", nil),
	"PreviewDashboardFilterOptions":      reads("", nil),
	"PreviewDashboardChartFilterOptions": reads("", nil),
	// The handlers name the dataset and data source, which the body chooses.
	"RunQuery":             reads("", nil),
	"PreviewDataset":       reads("", nil),
	"PreviewDatasetPolicy": reads("dataset", byID),

	// The models the assistant calls. A provider's request has its API
	// key, so it is not kept.
	"GetAIConfig": {}, "TestAIModel": {}, "GetAIUsage": {},
	"CreateAIProvider": change("ai_provider.create", "ai_provider", created("Id")),
	"UpdateAIProvider": change("ai_provider.update", "ai_provider", byID),
	"DeleteAIProvider": change("ai_provider.delete", "ai_provider", byID),
	"CreateAIModel":    withBody("ai_model.create", "ai_model", created("Id")),
	"UpdateAIModel":    withBody("ai_model.update", "ai_model", byID),
	"DeleteAIModel":    change("ai_model.delete", "ai_model", byID),
	"SetAISettings":    withBody("ai_settings.update", "", nil),

	"GetSystemSettings": {},
	"SetSystemSettings": {action: "system_settings.update", handler: true},

	// The workspace of an announcement's events is the current one, or none
	// for a system announcement. Reading one's notifications records nothing.
	"ListSystemAnnouncements": {}, "ListWorkspaceAnnouncements": {},
	"CreateSystemAnnouncement":    withBody("announcement.create", "announcement", created("Id")),
	"CreateWorkspaceAnnouncement": withBody("announcement.create", "announcement", created("Id")),
	"UpdateSystemAnnouncement":    withBody("announcement.update", "announcement", byID),
	"UpdateWorkspaceAnnouncement": withBody("announcement.update", "announcement", byID),
	"EndSystemAnnouncement":       change("announcement.update", "announcement", byID),
	"EndWorkspaceAnnouncement":    change("announcement.update", "announcement", byID),
	"DeleteSystemAnnouncement":    change("announcement.delete", "announcement", byID),
	"DeleteWorkspaceAnnouncement": change("announcement.delete", "announcement", byID),
	"GetNotificationSummary":      {}, "ListNotifications": {}, "MarkNotificationRead": {}, "MarkAllNotificationsRead": {},
	// The request has the email password; a test sends a message out.
	"GetEmailSettings":  {},
	"SetEmailSettings":  {action: "email_settings.update", handler: true},
	"TestEmailSettings": {action: "email.test", handler: true},
	// Conversations are not audited: see .agents/design/ai-assistant.md 8.
	"GetAssistantStatus": {}, "ListConversations": {}, "CreateConversation": {}, "RenameConversation": {}, "DeleteConversation": {},
	"ListConversationMessages": {}, "SendAssistantMessage": {}, "RetryAssistantMessage": {},

	"CreateExport":          {action: "export.create", handler: true},
	"CreateDashboardExport": {action: "export.create", handler: true},
	"DownloadExport":        {action: "export.download", object: "export", from: byID, handler: true},
	"CancelExport":          {action: "export.cancel", object: "export", from: byID, handler: true},
}

// trail collects what a request did, for its audit event.
type trail struct {
	mu         sync.Mutex
	object     *audit.Object
	statements []audit.Statement
	// recorded is set once the handler has recorded the event itself.
	recorded bool
}

type trailKey struct{}

func trailFrom(ctx context.Context) *trail {
	t, _ := ctx.Value(trailKey{}).(*trail)
	return t
}

// noteObject names the object of the request's event when the request
// body, rather than the path, chooses it.
func noteObject(ctx context.Context, kind, objectID string) {
	if t := trailFrom(ctx); t != nil {
		t.mu.Lock()
		t.object = &audit.Object{Type: kind, ID: objectID}
		t.mu.Unlock()
	}
}

// noteStatement adds a statement sent to a data source to the request's
// query event.
func noteStatement(ctx context.Context, st audit.Statement) {
	if t := trailFrom(ctx); t != nil {
		t.mu.Lock()
		t.statements = append(t.statements, st)
		t.mu.Unlock()
	}
}

// auditStatement describes a statement at the point its rows are accepted,
// as the diagnostics do.
func auditStatement(kind gen.QueryStatementKind, datasetID string, source store.Datasource, c *query.Compiled, result *query.Result, outcome qcache.Outcome, err error) audit.Statement {
	st := audit.NewStatement(string(kind), source.ID, c.SQL, c.Args)
	st.DatasetID = datasetID
	if err != nil {
		st.Error = statementError(err)
		return st
	}
	st.DurationMs, st.Rows, st.Truncated, st.Cached = result.Meta.DurationMs, len(result.Rows), result.Meta.Truncated, outcome.Hit
	return st
}

// statementError says why a statement failed: what the database said, or a
// code, never connection details.
func statementError(err error) string {
	var queryErr *datasource.QueryError
	switch {
	case errors.As(err, &queryErr):
		return queryErr.Message
	case errors.Is(err, datasource.ErrBusy):
		return "datasource_busy"
	case errors.Is(err, datasource.ErrQueueTimeout):
		return "queue_timeout"
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	case errors.Is(err, context.Canceled):
		return "canceled"
	}
	return "datasource_unreachable"
}

// recordAudit records what an admitted operation did, after it has run.
// Refusals before it runs are recorded by authenticate.
func (s *Server) recordAudit(next gen.StrictHandlerFunc, operationID string) gen.StrictHandlerFunc {
	rule := auditRules[operationID]
	if rule.action == "" {
		return next
	}
	return func(ctx context.Context, w http.ResponseWriter, r *http.Request, request any) (any, error) {
		c := callerFrom(ctx)
		if c == nil || c.principal == nil {
			// Signing in and setting up record themselves; signing out
			// without a session did nothing.
			return next(ctx, w, r, request)
		}
		t := &trail{}
		ctx = context.WithValue(ctx, trailKey{}, t)
		// What a deletion removes, or a rename replaces, is named as it was.
		var before string
		if rule.from != nil && changesName(rule.action) {
			before = s.objectName(ctx, audit.Object{Type: rule.object, ID: rule.from(c, nil)})
		}
		response, err := next(ctx, w, r, request)
		if !t.recorded {
			s.recordOperation(ctx, operationID, rule, t, request, response, err, before)
		}
		return response, err
	}
}

func changesName(action string) bool {
	return strings.HasSuffix(action, ".update") || removes(action)
}

func removes(action string) bool {
	return strings.HasSuffix(action, ".delete") || strings.HasSuffix(action, ".remove") || strings.HasSuffix(action, ".purge")
}

// refuse records the refusal of an audited operation by a permission check,
// and returns the refusal.
func (s *Server) refuse(ctx context.Context, operationID string, c *caller, request any, refusal *apiError) error {
	if rule := auditRules[operationID]; rule.action != "" && c.principal != nil {
		s.recordOperation(ctx, operationID, rule, &trail{}, request, nil, refusal, "")
	}
	return refusal
}

// recordOperation records an operation that has ended, if its rule and
// outcome call for it: changes when done or refused, queries when they
// reached a data source or were refused.
func (s *Server) recordOperation(ctx context.Context, operationID string, rule auditRule, t *trail, request, response any, err error, before string) {
	var outcome audit.Outcome
	switch {
	case refused(err):
		outcome = audit.Denied
	case rule.handler:
		return
	case rule.action == queryRun:
		if len(t.statements) == 0 {
			return
		}
		outcome = audit.Success
		if err != nil {
			outcome = audit.Failure
		}
	case err != nil:
		return
	default:
		outcome = audit.Success
	}
	c := callerFrom(ctx)
	e := s.event(ctx, rule.action, outcome)
	if requirements[operationID].workspace {
		e.WorkspaceID = c.principal.WorkspaceID
	}
	e.Object = audit.Object{Type: rule.object}
	if rule.from != nil {
		e.Object.ID = rule.from(c, response)
	}
	if t.object != nil {
		e.Object = *t.object
	}
	if e.Object.Type == "workspace" {
		e.WorkspaceID = e.Object.ID
	}
	e.Object.Name = before
	if !removes(rule.action) {
		if name := s.objectName(ctx, e.Object); name != "" {
			e.Object.Name = name
		}
	}

	detail := map[string]any{}
	if rule.body {
		if body := requestBody(request); body != nil {
			content, bodyErr := audit.Body(body)
			if bodyErr != nil {
				s.Logger.ErrorContext(ctx, "audit request content", "operation", operationID, "error", bodyErr)
			}
			detail["request"] = content
		}
	}
	if before != "" && e.Object.Name != before {
		detail["previousName"] = before
	}
	for _, name := range []string{"itemId", "filterId"} {
		if v := c.r.PathValue(name); v != "" {
			detail[name] = v
		}
	}
	if len(t.statements) > 0 {
		detail["statements"] = t.statements
	}
	var apiErr *apiError
	if errors.As(err, &apiErr) {
		detail["error"] = apiErr.code
		if role := apiErr.params["role"]; role != "" {
			detail["requiredRole"] = role
		}
	} else if err != nil {
		detail["error"] = errorCode(err)
	}
	e.Detail = detail
	s.record(ctx, e)
}

func refused(err error) bool {
	var apiErr *apiError
	return errors.As(err, &apiErr) && apiErr.status == http.StatusForbidden
}

// errorCode is the code an error is answered with, without logging it.
func errorCode(err error) string {
	var (
		specErr  *dataset.Error
		queryErr *datasource.QueryError
	)
	switch {
	case errors.As(err, &specErr):
		return specErr.Code
	case errors.As(err, &queryErr):
		return "database_error"
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	case errors.Is(err, context.Canceled):
		return "canceled"
	}
	return "error"
}

// requestBody is the decoded body of a strict request object, or nil.
func requestBody(request any) any {
	v := reflect.ValueOf(request)
	if v.Kind() != reflect.Struct {
		return nil
	}
	f := v.FieldByName("Body")
	if !f.IsValid() || f.Kind() != reflect.Pointer || f.IsNil() {
		return nil
	}
	return f.Interface()
}

// objectName is what an object is called now, or "" if that cannot be told.
// It is looked up even when the caller has gone, as the event is recorded.
func (s *Server) objectName(ctx context.Context, o audit.Object) string {
	if o.Type == "" || o.ID == "" {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	name, err := store.ObjectName(ctx, s.Pool, s.scope(ctx), o.Type, o.ID)
	if err != nil {
		s.Logger.WarnContext(ctx, "audit object name", "type", o.Type, "id", o.ID, "error", err)
	}
	return name
}

// event starts an event for what the caller did. The workspace is left for
// the caller to decide: not every event belongs to one.
func (s *Server) event(ctx context.Context, action string, outcome audit.Outcome) audit.Event {
	e := audit.Event{OrgID: signInOrg, At: time.Now(), Action: action, Outcome: outcome}
	c := callerFrom(ctx)
	if c == nil {
		return e
	}
	if p := c.principal; p != nil {
		e.OrgID, e.ActorID, e.ActorEmail = p.OrgID, p.UserID, p.Email
	}
	if c.r != nil {
		e.ClientIP = c.r.RemoteAddr
		if host, _, err := net.SplitHostPort(c.r.RemoteAddr); err == nil {
			e.ClientIP = host
		}
		e.ForwardedFor, e.UserAgent = c.r.Header.Get("X-Forwarded-For"), c.r.UserAgent()
	}
	return e
}

// record keeps an event. Failing to keep it does not undo what was done:
// the event goes to the log with the error instead.
func (s *Server) record(ctx context.Context, e audit.Event) {
	if t := trailFrom(ctx); t != nil {
		t.recorded = true
	}
	if s.Audit == nil {
		return
	}
	// Recorded even when the caller has gone, and not for longer than a moment.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if err := s.Audit.Record(ctx, e); err != nil {
		s.Logger.ErrorContext(ctx, "audit event not recorded", append(audit.Attrs(e), "error", err)...)
	}
}

// recordLogin records a sign-in, failed for the reason given unless it is
// empty. The account is the one signing in, whoever the browser was before.
// maxEmailLen is the longest address auth.NormalizeEmail accepts.
const maxEmailLen = 254

func (s *Server) recordLogin(ctx context.Context, u store.User, reason string) {
	e := s.event(ctx, "auth.login", audit.Success)
	// A sign-in that failed gives what was typed as the address, by someone
	// not signed in: kept to the length an address can have, so that neither
	// the audit log nor the server log can be filled through it.
	email := u.Email
	if len(email) > maxEmailLen {
		email = strings.ToValidUTF8(email[:maxEmailLen], "")
	}
	e.OrgID, e.ActorID, e.ActorEmail = signInOrg, u.ID, email
	if reason != "" {
		e.Outcome, e.Detail = audit.Failure, map[string]any{"reason": reason}
	}
	s.record(ctx, e)
}

// recordExport records what happened to an export, as its owner did it.
func (s *Server) recordExport(ctx context.Context, action string, outcome audit.Outcome, x store.Export, detail map[string]any) {
	e := s.event(ctx, action, outcome)
	e.WorkspaceID = x.WorkspaceID
	e.Object = audit.Object{Type: "export", ID: x.ID, Name: x.Name}
	e.Detail = map[string]any{"format": x.Format, "source": x.Source}
	maps.Copy(e.Detail, detail)
	s.record(ctx, e)
}

// auditPageSize is how many events a page holds.
const auditPageSize = 50

func (s *Server) ListAuditEvents(ctx context.Context, req gen.ListAuditEventsRequestObject) (gen.ListAuditEventsResponseObject, error) {
	p := req.Params
	f := store.AuditFilter{From: p.From, To: p.To}
	if p.WorkspaceId != nil {
		f.WorkspaceID = *p.WorkspaceId
	}
	if p.UserId != nil {
		f.ActorID = *p.UserId
	}
	if p.Category != nil {
		if !p.Category.Valid() {
			return nil, badRequest("invalid_request", "unknown category")
		}
		f.Category = audit.Category(*p.Category)
	}
	if p.Outcome != nil {
		if !p.Outcome.Valid() {
			return nil, badRequest("invalid_request", "unknown outcome")
		}
		f.Outcome = audit.Outcome(*p.Outcome)
	}
	if p.Cursor != nil {
		cursor, err := decodeAuditCursor(*p.Cursor)
		if err != nil {
			return nil, badRequest("invalid_cursor", "the cursor is not one this server returned")
		}
		f.Before = &cursor
	}
	records, err := store.ListAuditEvents(ctx, s.Pool, callerFrom(ctx).principal.OrgID, f, auditPageSize)
	if err != nil {
		return nil, err
	}
	out := gen.AuditEventPage{Items: make([]gen.AuditEvent, len(records))}
	for i, r := range records {
		if out.Items[i], err = auditEventResponse(r); err != nil {
			return nil, err
		}
	}
	if len(records) == auditPageSize {
		last := records[len(records)-1]
		out.NextCursor = new(encodeAuditCursor(store.AuditCursor{At: last.At, ID: last.ID}))
	}
	return gen.ListAuditEvents200JSONResponse(out), nil
}

func auditEventResponse(r store.AuditRecord) (gen.AuditEvent, error) {
	e := gen.AuditEvent{Id: r.ID, OccurredAt: r.At, Category: gen.AuditCategory(r.Category), Action: r.Action, Outcome: gen.AuditOutcome(r.Outcome),
		ClientIp: r.ClientIP, ForwardedFor: r.ForwardedFor, UserAgent: r.UserAgent}
	if err := json.Unmarshal(r.Detail, &e.Detail); err != nil {
		return e, err
	}
	e.Actor.Email = r.ActorEmail
	e.Actor.Id, e.Actor.DisplayName = optional(r.ActorID), optional(r.ActorName)
	if r.WorkspaceID != "" {
		e.Workspace = &struct {
			Id   string `json:"id"`
			Name string `json:"name"`
		}{Id: r.WorkspaceID, Name: r.WorkspaceName}
	}
	if r.Object.Type != "" || r.Object.ID != "" {
		e.Object = &struct {
			Id   string `json:"id"`
			Name string `json:"name"`
			Type string `json:"type"`
		}{Id: r.Object.ID, Name: r.Object.Name, Type: r.Object.Type}
	}
	return e, nil
}

// An audit cursor is where a page ended: the time and ID of its last event.
func encodeAuditCursor(c store.AuditCursor) string {
	return base64.RawURLEncoding.EncodeToString([]byte(c.At.UTC().Format(time.RFC3339Nano) + "|" + c.ID))
}

func decodeAuditCursor(s string) (store.AuditCursor, error) {
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return store.AuditCursor{}, err
	}
	at, eventID, ok := strings.Cut(string(raw), "|")
	if !ok || eventID == "" {
		return store.AuditCursor{}, errors.New("malformed cursor")
	}
	t, err := time.Parse(time.RFC3339Nano, at)
	return store.AuditCursor{At: t, ID: eventID}, err
}
