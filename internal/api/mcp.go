package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	mcpauth "github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/supazd/supabi/internal/api/gen"
	"github.com/supazd/supabi/internal/assistant"
	"github.com/supazd/supabi/internal/auth"
	"github.com/supazd/supabi/internal/authz"
	"github.com/supazd/supabi/internal/buildinfo"
	"github.com/supazd/supabi/internal/store"
)

// The MCP address: people's own MCP clients read, as them, the dashboards
// they can open, with the tools of the AI assistant. See
// .agents/design/ai-assistant.md 14.

// mcpInstructions are what a client is told when it connects, in place of
// the system prompt of the assistant: .agents/design/ai-assistant.md 14.7.
const mcpInstructions = `These tools read the dashboards of SupaBI, a business intelligence system, as the person who connected them: they see only what that person may open, in every workspace they belong to.
list_dashboards shows the dashboards and their charts; describe_dashboard shows the filters and charts of one, and the workspace's time zone and today's date there; filter_options gives the exact values a filter takes; query_chart reads a chart's data under the conditions you choose.
- Every figure you give must come from a result of query_chart. Cite it with the link of its source, and say which dashboard and chart it is from and under which conditions.
- When the figures the user asks for are on no chart, say so and point to the chart that comes closest. Do not estimate or make figures up.
- Write figures as the formats of their columns say: units, percentages, decimals.
- Use filter values exactly as filter_options gives them. For time, use a relative range when the user speaks of one, such as last month; it is resolved in the dashboard's workspace.`

// mcpDescriptions replace the assistant's descriptions of the tools that
// speak of workspaces: an MCP client reads across all of them.
var mcpDescriptions = map[string]string{
	"list_dashboards":    "Lists the dashboards the user can open, by workspace, in every workspace they belong to, with the charts on each, by widget id. Start here to find where what the user asks about may be.",
	"describe_dashboard": "Describes a dashboard: its workspace, with the time zone and today's date there; its filters; and for each chart its columns, with what the dataset says they mean, its own filters, the dimensions and measures a viewer can switch between, how it drills down, and the links that narrow it.",
}

type mcpClientKey struct{}

// mcpClientFrom says whether a tool runs for an MCP client, and which.
func mcpClientFrom(ctx context.Context) (string, bool) {
	name, ok := ctx.Value(mcpClientKey{}).(string)
	return name, ok
}

// mcpUser is who an MCP request acts for. It travels with the token's
// information, which the SDK hands to every tool call of the request.
type mcpUser struct {
	caller *caller
	client string
}

// mcpUserKey is where mcpUser is in the token's information.
const mcpUserKey = "supabi.user"

// mcpParallelWorkspaces is how many workspaces list_dashboards reads at once.
const mcpParallelWorkspaces = 4

// mcpHandler serves the MCP address. Every request carries an access token,
// and stands alone: there are no MCP sessions, so any instance answers.
func (s *Server) mcpHandler() http.Handler {
	server := s.mcpServer()
	protocol := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, &mcp.StreamableHTTPOptions{
		Stateless: true, JSONResponse: true, PropagateRequestCancellation: true,
		// Behind a reverse proxy on the same machine every request comes from
		// a loopback address under the public host name; fromThisSite below
		// is the protection against DNS rebinding instead.
		DisableLocalhostProtection: true,
	})
	// A valid token can still belong to an organisation that turned MCP off.
	enabled := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user := mcpauth.TokenInfoFromContext(r.Context()).Extra[mcpUserKey].(mcpUser)
		on, err := s.mcpEnabled(r.Context(), user.caller.principal.OrgID)
		if err != nil {
			s.Logger.ErrorContext(r.Context(), "mcp request failed", "error", err)
			http.Error(w, "something went wrong", http.StatusInternalServerError)
			return
		}
		if !on {
			http.Error(w, errMCPOff.description, http.StatusForbidden)
			return
		}
		protocol.ServeHTTP(w, r)
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !fromThisSite(r) {
			http.Error(w, "requests from other sites are not accepted", http.StatusForbidden)
			return
		}
		// The challenge names this server as the client reached it.
		mcpauth.RequireBearerToken(s.verifyMCPToken, &mcpauth.RequireBearerTokenOptions{
			ResourceMetadataURL: origin(r) + "/.well-known/oauth-protected-resource" + mcpPath,
			Scopes:              []string{mcpScope},
		})(enabled).ServeHTTP(w, r)
	})
}

// verifyMCPToken finds whom an access token acts for. A token is good only
// at the address it was issued for.
func (s *Server) verifyMCPToken(ctx context.Context, token string, r *http.Request) (*mcpauth.TokenInfo, error) {
	access, err := store.GetMCPAccess(ctx, s.Pool, auth.HashSessionToken(token))
	if errors.Is(err, store.ErrNotFound) || (err == nil && !sameResource(access.Resource, origin(r)+mcpPath)) {
		return nil, fmt.Errorf("%w: the access token is invalid or expired", mcpauth.ErrInvalidToken)
	}
	if err != nil {
		s.Logger.ErrorContext(ctx, "mcp token check failed", "error", err)
		return nil, errors.New("something went wrong")
	}
	user := mcpUser{caller: &caller{r: r, principal: &access.Principal}, client: access.Authorization.ClientName}
	return &mcpauth.TokenInfo{Scopes: strings.Fields(access.Authorization.Scope), Expiration: access.ExpiresAt, UserID: access.Principal.UserID,
		Extra: map[string]any{mcpUserKey: user}}, nil
}

// mcpServer is the MCP server of every request. Its tools run as the person
// the request's token acts for, outside any workspace until a dashboard
// decides one.
func (s *Server) mcpServer() *mcp.Server {
	server := mcp.NewServer(&mcp.Implementation{Name: "supabi", Title: "SupaBI", Version: buildinfo.Version}, &mcp.ServerOptions{Instructions: mcpInstructions})
	for _, t := range assistantTools {
		description := t.description
		if d, ok := mcpDescriptions[t.name]; ok {
			description = d
		}
		server.AddTool(&mcp.Tool{Name: t.name, Description: description, InputSchema: json.RawMessage(t.parameters), Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true}},
			func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
				var user mcpUser
				if req.Extra != nil && req.Extra.TokenInfo != nil {
					user, _ = req.Extra.TokenInfo.Extra[mcpUserKey].(mcpUser)
				}
				if user.caller == nil {
					return nil, errors.New("the request has no access token")
				}
				ctx = context.WithValue(context.WithValue(ctx, callerKey{}, user.caller), mcpClientKey{}, user.client)
				result := s.runMCPTool(ctx, t, req.Params.Arguments)
				return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: result.Content}}, IsError: result.Failed}, nil
			})
	}
	return server
}

// runMCPTool runs a tool in the workspace of the dashboard it is given,
// as the person would there; list_dashboards runs in every workspace.
func (s *Server) runMCPTool(ctx context.Context, t assistantTool, raw json.RawMessage) assistant.ToolResult {
	if strings.TrimSpace(string(raw)) == "" {
		raw = json.RawMessage("{}")
	}
	if t.name == "list_dashboards" {
		result, err := s.listAllDashboardsTool(ctx, raw)
		if err != nil {
			return s.toolFailure(ctx, err)
		}
		return result
	}
	var target struct {
		Dashboard string `json:"dashboard"`
	}
	// The tool reads its arguments strictly; this only finds the dashboard.
	_ = json.Unmarshal(raw, &target)
	workspaceID, err := store.DashboardWorkspace(ctx, s.Pool, callerFrom(ctx).principal.OrgID, target.Dashboard)
	if err != nil {
		return s.toolFailure(ctx, err)
	}
	in, err := s.callerIn(ctx, workspaceID)
	if err != nil {
		return s.toolFailure(ctx, err)
	}
	ctx = context.WithValue(ctx, callerKey{}, in)
	result, err := t.run(s, ctx, raw)
	if err != nil {
		return s.toolFailure(ctx, err)
	}
	if result.Source != nil {
		if result.Content, err = withSource(result.Content, s.mcpSource(in, result.Source)); err != nil {
			return s.toolFailure(ctx, err)
		}
	}
	return result
}

// callerIn is the caller as they are in a workspace, if they can access it.
// One they cannot is not found, so that they cannot learn it exists.
func (s *Server) callerIn(ctx context.Context, workspaceID string) (*caller, error) {
	c := callerFrom(ctx)
	p := *c.principal
	p.WorkspaceID = workspaceID
	role, err := store.WorkspaceRole(ctx, s.Pool, p)
	if err != nil {
		return nil, err
	}
	if !role.AtLeast(authz.Viewer) {
		return nil, store.ErrNotFound
	}
	return &caller{r: c.r, principal: &p, role: role}, nil
}

type toolWorkspaceDashboards struct {
	ID         string               `json:"id"`
	Name       string               `json:"name"`
	Dashboards []toolDashboardEntry `json:"dashboards"`
}

// listAllDashboardsTool lists the dashboards of every workspace the caller
// can access: .agents/design/ai-assistant.md 14.3.
func (s *Server) listAllDashboardsTool(ctx context.Context, raw json.RawMessage) (assistant.ToolResult, error) {
	if err := toolArguments(raw, &struct{}{}); err != nil {
		return assistant.ToolResult{}, err
	}
	p := callerFrom(ctx).principal
	workspaces, err := store.ListWorkspaces(ctx, s.Pool, p.OrgID, p.UserID, false)
	if err != nil {
		return assistant.ToolResult{}, err
	}
	// A few workspaces at a time: someone in many of them, as a system
	// administrator is in all, waits for the slowest few rather than for
	// each in turn, without taking every connection of the pool.
	found := make([]*toolWorkspaceDashboards, len(workspaces))
	errs := make([]error, len(workspaces))
	limit := make(chan struct{}, mcpParallelWorkspaces)
	var wg sync.WaitGroup
	for i, w := range workspaces {
		wg.Go(func() {
			limit <- struct{}{}
			defer func() { <-limit }()
			in, err := s.callerIn(ctx, w.ID)
			if err == nil {
				var dashboards []toolDashboardEntry
				if dashboards, err = s.dashboardEntries(context.WithValue(ctx, callerKey{}, in)); err == nil {
					found[i] = &toolWorkspaceDashboards{ID: w.ID, Name: w.Name, Dashboards: dashboards}
				}
			}
			if !errors.Is(err, store.ErrNotFound) {
				errs[i] = err
			}
		})
	}
	wg.Wait()
	if err := errors.Join(errs...); err != nil {
		return assistant.ToolResult{}, err
	}
	out := []toolWorkspaceDashboards{}
	for _, w := range found {
		if w != nil {
			out = append(out, *w)
		}
	}
	text, err := toolText(out)
	return assistant.ToolResult{Content: text}, err
}

// mcpSourceInfo is where a chart's data came from, as an MCP client reads
// it: it sees only tool results, so the link goes in the result.
type mcpSourceInfo struct {
	Dashboard string `json:"dashboard"`
	Chart     string `json:"chart"`
	// Link opens the dashboard with the chart as it was read.
	Link          string     `json:"link"`
	LinkExpiresAt *time.Time `json:"linkExpiresAt,omitempty"`
	Revisions     struct {
		Dashboard int `json:"dashboard"`
		Chart     int `json:"chart"`
		Dataset   int `json:"dataset"`
	} `json:"revisions"`
}

func (s *Server) mcpSource(c *caller, source *store.AnswerSource) mcpSourceInfo {
	// The address names the workspace: .agents/design/access-control.md §2.4.
	link := origin(c.r) + "/w/" + url.PathEscape(c.principal.WorkspaceID) + "/dashboards/" + url.PathEscape(source.DashboardID)
	if source.ViewID != "" {
		link += "?" + url.Values{"view": {source.ViewID}}.Encode()
	}
	out := mcpSourceInfo{Dashboard: source.DashboardName, Chart: source.ChartName, LinkExpiresAt: source.ExpiresAt, Link: link}
	out.Revisions.Dashboard, out.Revisions.Chart, out.Revisions.Dataset = source.DashboardRevision, source.ChartRevision, source.DatasetRevision
	return out
}

// withSource adds the source to a tool's result, a JSON object, whose
// figures are kept as they were written. The link is written as it is, not
// with & escaped, for a model to copy it whole.
func withSource(content string, source mcpSourceInfo) (string, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal([]byte(content), &raw); err != nil {
		return "", err
	}
	fields := map[string]any{"source": source}
	for key, value := range raw {
		fields[key] = value
	}
	var out strings.Builder
	enc := json.NewEncoder(&out)
	enc.SetEscapeHTML(false)
	err := enc.Encode(fields)
	return strings.TrimSuffix(out.String(), "\n"), err
}

// ---- authorizations ----

func (s *Server) ListMCPAuthorizations(ctx context.Context, _ gen.ListMCPAuthorizationsRequestObject) (gen.ListMCPAuthorizationsResponseObject, error) {
	c := callerFrom(ctx)
	list, err := store.ListMCPAuthorizations(ctx, s.Pool, c.principal.OrgID, c.principal.UserID)
	if err != nil {
		return nil, err
	}
	on, err := s.mcpEnabled(ctx, c.principal.OrgID)
	if err != nil {
		return nil, err
	}
	out := gen.MCPAuthorizations{Enabled: on, Address: origin(c.r) + mcpPath, Items: []gen.MCPAuthorization{}}
	for _, a := range list {
		out.Items = append(out.Items, gen.MCPAuthorization{Id: a.ID, ClientName: a.ClientName, RedirectHost: redirectHosts(a.RedirectURIs), AuthorizedAt: a.AuthorizedAt, LastUsedAt: a.LastUsedAt})
	}
	return gen.ListMCPAuthorizations200JSONResponse(out), nil
}

func (s *Server) RevokeMCPAuthorization(ctx context.Context, req gen.RevokeMCPAuthorizationRequestObject) (gen.RevokeMCPAuthorizationResponseObject, error) {
	p := callerFrom(ctx).principal
	a, err := store.RevokeMCPAuthorization(ctx, s.Pool, p.OrgID, p.UserID, req.Id)
	if err != nil {
		return nil, err
	}
	s.recordMCPAuthorization(ctx, "mcp.revoke", a, "", "")
	return gen.RevokeMCPAuthorization204Response{}, nil
}
