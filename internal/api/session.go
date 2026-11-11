package api

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/supazd/supabi/internal/api/gen"
	"github.com/supazd/supabi/internal/auth"
	"github.com/supazd/supabi/internal/authz"
	"github.com/supazd/supabi/internal/store"
)

const (
	sessionCookie = "supabi_session"
	// Activity is recorded at most this often, to keep reads from becoming writes.
	sessionTouchInterval = 5 * time.Minute
)

// caller is what the handlers know about the request's sender.
type caller struct {
	w         http.ResponseWriter
	r         *http.Request
	principal *store.Principal // nil when not signed in
	tokenHash []byte
	role      authz.Role // in the current workspace; empty outside one
}

type callerKey struct{}

func callerFrom(ctx context.Context) *caller {
	c, _ := ctx.Value(callerKey{}).(*caller)
	return c
}

// requirement is what an operation demands of its caller.
type requirement struct {
	// public operations work without a session.
	public bool
	// role is the least role the caller must hold in the current workspace.
	// Empty means any signed-in user.
	role authz.Role
	// workspace operations act on the caller's current workspace.
	workspace bool
	// orgAdmin operations change the org itself: its accounts, groups and
	// workspaces.
	orgAdmin bool
	// directory reads global users/groups: org administrators need no current
	// workspace; workspace developers may read it to choose access subjects.
	directory bool
}

func needs(role authz.Role) requirement {
	return requirement{role: role, workspace: true}
}

// requirements maps every operation to what it demands. An operation missing
// from this table is refused, so a new endpoint cannot be exposed by accident.
// The roles are described in .agents/design/access-control.md §4.1.
var requirements = map[string]requirement{
	"GetSession": {public: true},
	"Setup":      {public: true},
	"Login":      {public: true},
	"Logout":     {public: true},

	"GetVersion":      {},
	"ChangePassword":  {},
	"ListWorkspaces":  {},
	"SwitchWorkspace": {},

	// Anyone signed in answers an MCP client as themselves, and manages the
	// clients they allowed: .agents/design/ai-assistant.md 14.4, 14.5. Which
	// workspaces a client then reads is decided on each of its requests.
	"GetOAuthRequest":        {},
	"ApproveOAuthRequest":    {},
	"DenyOAuthRequest":       {},
	"ListMCPAuthorizations":  {},
	"RevokeMCPAuthorization": {},

	// Viewers reach data through charts: GetChartData runs only the chart's
	// own saved query, and the options and dashboard operations take values
	// from the caller and fields from what authors defined. None of them
	// lets a viewer query a dataset, and a viewer reaches only the dashboards
	// granted to them and the charts on those, which the handlers see to.
	"ListCharts":                       needs(authz.Viewer),
	"GetChart":                         needs(authz.Viewer),
	"GetChartData":                     needs(authz.Viewer),
	"GetChartFilterOptions":            needs(authz.Viewer),
	"QueryChartFilterOptions":          needs(authz.Viewer),
	"ListDashboards":                   needs(authz.Viewer),
	"GetDashboard":                     needs(authz.Viewer),
	"CreateDashboardView":              needs(authz.Viewer),
	"GetDashboardView":                 needs(authz.Viewer),
	"GetDashboardItemData":             needs(authz.Viewer),
	"GetDashboardFilterOptions":        needs(authz.Viewer),
	"QueryDashboardFilterOptions":      needs(authz.Viewer),
	"QueryDashboardChartFilterOptions": needs(authz.Viewer),
	// What a time range means now; it names no data, and viewers of a
	// chart change its dates too.
	"ResolveTimeRange": needs(authz.Viewer),
	// Folders of every kind are listed together; viewers get those of
	// dashboards and charts only, which the handler sees to.
	"ListFolders": needs(authz.Viewer),

	// Every member has their own exports: a chart's on a dashboard they
	// can open, when the chart allows it, and a developer's of SQL. Handlers
	// see to ownership, and a download is checked as its source would be.
	"CreateDashboardExport": needs(authz.Viewer),
	// The export center does not follow the current workspace: it holds the
	// caller's exports from every workspace they can enter, and the handlers
	// check each in its own. See .agents/design/exports.md 6.
	"ListExports":     {},
	"GetExport":       {},
	"CancelExport":    {},
	"DownloadExport":  {},
	"MarkExportsSeen": {},

	// Developers can read whatever the data sources' accounts can: they
	// write SQL against them.
	"CreateExport":         needs(authz.Developer),
	"ListDatasourceTypes":  needs(authz.Developer),
	"ListDatasources":      needs(authz.Developer),
	"GetDatasource":        needs(authz.Developer),
	"CreateDatasource":     needs(authz.Developer),
	"TestDatasource":       needs(authz.Developer),
	"UpdateDatasource":     needs(authz.Developer),
	"TestStoredDatasource": needs(authz.Developer),
	"DeleteDatasource":     needs(authz.Developer),
	"DescribeSource":       needs(authz.Developer),
	"ExplainSource":        needs(authz.Developer),
	"ListSourceTables":     needs(authz.Developer),
	"ListFunctions":        needs(authz.Developer),
	"CheckExpression":      needs(authz.Developer),

	"ListDatasets":         needs(authz.Developer),
	"GetDataset":           needs(authz.Developer),
	"ListDatasetRevisions": needs(authz.Developer),
	"GetDatasetRevision":   needs(authz.Developer),
	"CreateDataset":        needs(authz.Developer),
	"PreviewDataset":       needs(authz.Developer),
	"AnalyzeDatasetImpact": needs(authz.Developer),
	"UpdateDataset":        needs(authz.Developer),
	"DeleteDataset":        needs(authz.Developer),
	"RunQuery":             needs(authz.Developer),
	// Developers and admins configure the data permissions of datasets.
	"GetDatasetPolicy":     needs(authz.Developer),
	"SetDatasetPolicy":     needs(authz.Developer),
	"PreviewDatasetPolicy": needs(authz.Developer),

	"CreateChart":                        needs(authz.Developer),
	"UpdateChart":                        needs(authz.Developer),
	"DeleteChart":                        needs(authz.Developer),
	"ListChartRevisions":                 needs(authz.Developer),
	"PreviewChartData":                   needs(authz.Developer),
	"PreviewChartFilterOptions":          needs(authz.Developer),
	"CreateDashboard":                    needs(authz.Developer),
	"UpdateDashboard":                    needs(authz.Developer),
	"DeleteDashboard":                    needs(authz.Developer),
	"ListDashboardRevisions":             needs(authz.Developer),
	"PreviewDashboardItemData":           needs(authz.Developer),
	"PreviewDashboardFilterOptions":      needs(authz.Developer),
	"PreviewDashboardChartFilterOptions": needs(authz.Developer),

	"CreateFolder": needs(authz.Developer),
	"UpdateFolder": needs(authz.Developer),
	"DeleteFolder": needs(authz.Developer),
	"MoveResource": needs(authz.Developer),
	"GetUsage":     needs(authz.Developer),
	"GetLineage":   needs(authz.Developer),

	// Developers need the directory to choose subjects for dataset policies and dashboard grants.
	"ListUsers":           {directory: true},
	"ListGroups":          {directory: true},
	"ListUserAttributes":  needs(authz.Developer),
	"SetUserAttribute":    needs(authz.Admin),
	"DeleteUserAttribute": needs(authz.Admin),

	// Who is in the workspace, and in which role. Only an admin assigns
	// roles, and no role is above admin, so nobody can give more than they hold.
	"ListMembers":       needs(authz.Admin),
	"AddMember":         needs(authz.Admin),
	"UpdateMember":      needs(authz.Admin),
	"RemoveMember":      needs(authz.Admin),
	"ListGroupMembers":  needs(authz.Admin),
	"SetGroupMember":    needs(authz.Admin),
	"RemoveGroupMember": needs(authz.Admin),
	"UpdateWorkspace":   needs(authz.Admin),
	// Dashboard editors also decide who may view it.
	"GetDashboardGrants": needs(authz.Developer),
	"SetDashboardGrants": needs(authz.Developer),

	// What exists in the org.
	"CreateUser":      {orgAdmin: true},
	"UpdateUser":      {orgAdmin: true},
	"CreateGroup":     {orgAdmin: true},
	"UpdateGroup":     {orgAdmin: true},
	"DeleteGroup":     {orgAdmin: true},
	"CreateWorkspace": {orgAdmin: true},
	// Workspace admins cannot delete their own: .agents/design/access-control.md §2.3.
	"DeleteWorkspace":  {orgAdmin: true},
	"RestoreWorkspace": {orgAdmin: true},
	"PurgeWorkspace":   {orgAdmin: true},
	// Who did what, in every workspace and outside them.
	"ListAuditEvents": {orgAdmin: true},
	// The models the assistant calls, and what for: they cost money.
	"GetAIConfig":      {orgAdmin: true},
	"CreateAIProvider": {orgAdmin: true},
	"UpdateAIProvider": {orgAdmin: true},
	"DeleteAIProvider": {orgAdmin: true},
	"CreateAIModel":    {orgAdmin: true},
	"UpdateAIModel":    {orgAdmin: true},
	"DeleteAIModel":    {orgAdmin: true},
	"TestAIModel":      {orgAdmin: true},
	"SetAISettings":    {orgAdmin: true},
	// What the models cost, by person and by workspace across the org.
	"GetAIUsage": {orgAdmin: true},
	// What every instance keeps to: .agents/design/configuration.md 10.
	"GetSystemSettings": {orgAdmin: true},
	"SetSystemSettings": {orgAdmin: true},

	// Announcements: system ones are the organization's, a workspace's are
	// its admins'. See .agents/design/announcements.md 6.
	"ListSystemAnnouncements":     {orgAdmin: true},
	"CreateSystemAnnouncement":    {orgAdmin: true},
	"UpdateSystemAnnouncement":    {orgAdmin: true},
	"EndSystemAnnouncement":       {orgAdmin: true},
	"DeleteSystemAnnouncement":    {orgAdmin: true},
	"ListWorkspaceAnnouncements":  needs(authz.Admin),
	"CreateWorkspaceAnnouncement": needs(authz.Admin),
	"UpdateWorkspaceAnnouncement": needs(authz.Admin),
	"EndWorkspaceAnnouncement":    needs(authz.Admin),
	"DeleteWorkspaceAnnouncement": needs(authz.Admin),
	// Everyone's bell holds what they may see from every workspace they can
	// enter, like the export center, so it needs no current workspace.
	"GetNotificationSummary":   {},
	"ListNotifications":        {},
	"MarkNotificationRead":     {},
	"MarkAllNotificationsRead": {},
	// The server the organization sends email through, and its password.
	"GetEmailSettings":  {orgAdmin: true},
	"SetEmailSettings":  {orgAdmin: true},
	"TestEmailSettings": {orgAdmin: true},

	// Every member has the assistant, and their own conversations with it,
	// which the handlers see to. It reads no data yet.
	"GetAssistantStatus":       needs(authz.Viewer),
	"ListConversations":        needs(authz.Viewer),
	"CreateConversation":       needs(authz.Viewer),
	"RenameConversation":       needs(authz.Viewer),
	"DeleteConversation":       needs(authz.Viewer),
	"ListConversationMessages": needs(authz.Viewer),
	"SendAssistantMessage":     needs(authz.Viewer),
	"RetryAssistantMessage":    needs(authz.Viewer),
}

// authenticate runs before every operation: it identifies the caller and
// refuses the operation unless its requirement is met.
func (s *Server) authenticate(next gen.StrictHandlerFunc, operationID string) gen.StrictHandlerFunc {
	return func(ctx context.Context, w http.ResponseWriter, r *http.Request, request any) (any, error) {
		if !sameOrigin(r) {
			return nil, &apiError{status: http.StatusForbidden, code: "cross_origin", message: "requests from other sites are not accepted"}
		}
		c := &caller{w: w, r: r}
		if cookie, err := r.Cookie(sessionCookie); err == nil && cookie.Value != "" {
			hash := auth.HashSessionToken(cookie.Value)
			principal, err := store.GetPrincipal(ctx, s.Pool, hash)
			switch {
			case err == nil:
				if err := s.enterAddressed(ctx, &principal, r); err != nil {
					return nil, err
				}
				c.principal, c.tokenHash = &principal, hash
			case !errors.Is(err, store.ErrNotFound):
				return nil, err
			}
		}
		ctx = context.WithValue(ctx, callerKey{}, c)

		need, known := requirements[operationID]
		if !known {
			s.Logger.ErrorContext(ctx, "operation has no entry in the requirements table", "operation", operationID)
			return nil, &apiError{status: http.StatusForbidden, code: "forbidden", message: "not allowed"}
		}
		if need.public {
			return next(ctx, w, r, request)
		}
		if c.principal == nil {
			return nil, &apiError{status: http.StatusUnauthorized, code: "unauthenticated", message: "sign in first"}
		}
		if s.now().Sub(c.principal.LastSeenAt) > sessionTouchInterval {
			settings, err := store.SystemSettingsInForce(ctx, s.Pool, c.principal.OrgID)
			if err != nil {
				return nil, err
			}
			if err := store.TouchSession(ctx, s.Pool, c.tokenHash, settings.SessionLifetime); err != nil {
				return nil, err
			}
			setSessionCookie(w, r, cookieValue(r), settings.SessionLifetime)
		}
		if need.orgAdmin && !c.principal.IsOrgAdmin {
			return nil, s.refuse(ctx, operationID, c, request, &apiError{status: http.StatusForbidden, code: "forbidden", message: "only an organisation administrator can do this",
				params: map[string]string{"role": "org_admin"}})
		}
		if need.directory && !c.principal.IsOrgAdmin {
			need = needs(authz.Developer)
		}
		if need.workspace {
			if c.principal.WorkspaceID == "" {
				return nil, s.refuse(ctx, operationID, c, request, &apiError{status: http.StatusForbidden, code: "no_workspace", message: "the session has no current workspace: choose one, or ask to be added to one"})
			}
			role, err := store.WorkspaceRole(ctx, s.Pool, *c.principal)
			if err != nil {
				return nil, err
			}
			c.role = role
			if need.role != "" && !role.AtLeast(need.role) {
				return nil, s.refuse(ctx, operationID, c, request, &apiError{status: http.StatusForbidden, code: "forbidden", message: "your role does not allow this",
					params: map[string]string{"role": string(need.role)}})
			}
		}
		return next(ctx, w, r, request)
	}
}

// sameOrigin rejects state-changing requests that a page of another site made
// the browser send. Together with the SameSite cookie attribute this is the
// defence against cross-site request forgery.
func sameOrigin(r *http.Request) bool {
	if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
		return true
	}
	return fromThisSite(r)
}

// fromThisSite says whether a request comes from a page of this server, or
// from no page at all: requests without an Origin header (curl,
// server-to-server, MCP clients) are not browser-driven and pass.
func fromThisSite(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	return err == nil && strings.EqualFold(u.Host, r.Host)
}

func cookieValue(r *http.Request) string {
	if cookie, err := r.Cookie(sessionCookie); err == nil {
		return cookie.Value
	}
	return ""
}

// setSessionCookie sets the cookie, or clears it when lifetime is not positive.
func setSessionCookie(w http.ResponseWriter, r *http.Request, token string, lifetime time.Duration) {
	cookie := &http.Cookie{
		Name:     sessionCookie,
		Value:    token,
		Path:     "/",
		HttpOnly: true, // not readable by scripts
		SameSite: http.SameSiteLaxMode,
		// Behind a TLS-terminating proxy the request itself is plain HTTP.
		Secure: r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https"),
		MaxAge: int(lifetime.Seconds()),
	}
	if lifetime <= 0 {
		cookie.Value, cookie.MaxAge = "", -1
	}
	http.SetCookie(w, cookie)
}

// workspaceHeader names the workspace a request is for: the one in the
// address of the page that made it. See .agents/design/access-control.md §2.4.
const workspaceHeader = "X-SupaBI-Workspace"

// enterAddressed puts the principal in the workspace the request names, in
// place of the one its session last chose. One it cannot enter leaves it in
// none, so that nothing meant for one workspace is done in another.
func (s *Server) enterAddressed(ctx context.Context, p *store.Principal, r *http.Request) error {
	addressed := r.Header.Get(workspaceHeader)
	if addressed == "" || addressed == p.WorkspaceID {
		return nil
	}
	can, err := store.CanEnterWorkspace(ctx, s.Pool, p.OrgID, p.UserID, addressed)
	if err != nil {
		return err
	}
	p.WorkspaceID = ""
	if can {
		p.WorkspaceID = addressed
	}
	return nil
}

// scope returns the tenant and user of an authenticated request. WorkspaceID
// may be empty for global operations; workspace operations validate it first.
func (s *Server) scope(ctx context.Context) store.Scope {
	p := callerFrom(ctx).principal
	return store.Scope{OrgID: p.OrgID, WorkspaceID: p.WorkspaceID, UserID: p.UserID}
}
