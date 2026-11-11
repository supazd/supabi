package api

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/supazd/supabi/internal/store"
)

// noRedirects is a browser that stops at each redirect, to read where it goes.
var noRedirects = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

// oauthPost sends a form or JSON to an OAuth endpoint and decodes the answer.
func oauthPost(t *testing.T, endpoint string, body any) (int, map[string]any) {
	t.Helper()
	var req *http.Request
	if form, ok := body.(url.Values); ok {
		req, _ = http.NewRequest("POST", endpoint, strings.NewReader(form.Encode()))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	} else {
		raw, _ := json.Marshal(body)
		req, _ = http.NewRequest("POST", endpoint, strings.NewReader(string(raw)))
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

// pkce is a code verifier and its S256 challenge.
func pkce(seed string) (verifier, challenge string) {
	verifier = strings.Repeat(seed, 43/len(seed)+1)[:43]
	sum := sha256.Sum256([]byte(verifier))
	return verifier, base64.RawURLEncoding.EncodeToString(sum[:])
}

// mcpClient is an MCP client the way one registers and is allowed.
type mcpClient struct {
	id, redirect string
}

func registerMCPClient(t *testing.T, c *client, name string) mcpClient {
	t.Helper()
	status, out := oauthPost(t, c.server.URL+"/oauth/register", map[string]any{
		"client_name": name, "token_endpoint_auth_method": "none",
		// A custom scheme is left out, and the loopback address kept.
		"redirect_uris": []string{"cursor://anysphere.cursor-mcp/oauth/callback", "http://127.0.0.1:33418/callback"},
	})
	if status != 201 || out["client_name"] != name || len(out["redirect_uris"].([]any)) != 1 || out["client_secret"] != nil {
		t.Fatalf("register: %d %v", status, out)
	}
	return mcpClient{id: out["client_id"].(string), redirect: "http://127.0.0.1:33418/callback"}
}

// authorizeQuery is what a client sends the browser to /oauth/authorize with.
func authorizeQuery(m mcpClient, redirect, challenge string) url.Values {
	return url.Values{"response_type": {"code"}, "client_id": {m.id}, "redirect_uri": {redirect}, "state": {"st"},
		"code_challenge": {challenge}, "code_challenge_method": {"S256"}, "scope": {"dashboards:read openid"}}
}

// startAuthorization sends the browser to /oauth/authorize and returns where it is sent.
func startAuthorization(t *testing.T, c *client, q url.Values) *url.URL {
	t.Helper()
	resp, err := noRedirects.Get(c.server.URL + "/oauth/authorize?" + q.Encode())
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("authorize: status %d", resp.StatusCode)
	}
	location, _ := url.Parse(resp.Header.Get("Location"))
	return location
}

// allow takes a person through consent and the token exchange, and returns
// the tokens of their authorization.
func allow(t *testing.T, person *client, m mcpClient) (access, refresh string) {
	t.Helper()
	verifier, challenge := pkce("v")
	// The port of a loopback address is the client's to choose.
	location := startAuthorization(t, person, authorizeQuery(m, "http://127.0.0.1:50123/callback", challenge))
	request := strings.TrimPrefix(location.Path, "/oauth/consent/")
	answer, _ := url.Parse(person.expect("POST", "/oauth/requests/"+request+"/approve", nil, 200, "")["redirectTo"].(string))
	q := answer.Query()
	if answer.Host != "127.0.0.1:50123" || q.Get("state") != "st" || q.Get("iss") != person.server.URL || q.Get("code") == "" {
		t.Fatalf("approved: %s", answer)
	}
	status, tokens := oauthPost(t, person.server.URL+"/oauth/token", url.Values{"grant_type": {"authorization_code"}, "client_id": {m.id},
		"code": {q.Get("code")}, "redirect_uri": {"http://127.0.0.1:50123/callback"}, "code_verifier": {verifier}, "resource": {person.server.URL + "/mcp"}})
	if status != 200 || tokens["token_type"] != "Bearer" || tokens["scope"] != "dashboards:read" {
		t.Fatalf("token: %d %v", status, tokens)
	}
	return tokens["access_token"].(string), tokens["refresh_token"].(string)
}

type bearer string

func (b bearer) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+string(b))
	return http.DefaultTransport.RoundTrip(r)
}

// mcpStatus is how the MCP address answers a bare request with the token.
func mcpStatus(t *testing.T, endpoint, token string) (int, http.Header) {
	t.Helper()
	req, _ := http.NewRequest("POST", endpoint, strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	return resp.StatusCode, resp.Header
}

func connectMCP(t *testing.T, c *client, token string) *mcp.ClientSession {
	t.Helper()
	session, err := mcp.NewClient(&mcp.Implementation{Name: "test"}, nil).Connect(context.Background(),
		&mcp.StreamableClientTransport{Endpoint: c.server.URL + "/mcp", HTTPClient: &http.Client{Transport: bearer(token)}, MaxRetries: -1}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { session.Close() })
	return session
}

// call runs a tool and returns its text, and whether it failed.
func call(t *testing.T, session *mcp.ClientSession, tool string, arguments map[string]any) (string, bool) {
	t.Helper()
	result, err := session.CallTool(context.Background(), &mcp.CallToolParams{Name: tool, Arguments: arguments})
	if err != nil {
		t.Fatalf("%s: %v", tool, err)
	}
	return result.Content[0].(*mcp.TextContent).Text, result.IsError
}

func setMCP(t *testing.T, admin *client, on bool) {
	t.Helper()
	admin.expect("PUT", "/system/settings", map[string]any{"mcpEnabled": on}, 200, "")
}

// A person allows a client through OAuth, which then holds tokens only for
// this address, refreshes them, loses them when a refresh token is replayed,
// when the person revokes it, and when their account is disabled; and an
// administrator's switch turns it all off and on again.
func TestMCPAuthorization(t *testing.T) {
	f := newContentFixture(t)
	base := f.admin.server.URL

	// Discovery names this address, however it was reached.
	for _, path := range []string{"/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"} {
		resp, _ := http.Get(base + path)
		var meta map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&meta)
		resp.Body.Close()
		if meta["resource"] != base+"/mcp" || meta["authorization_servers"].([]any)[0] != base {
			t.Errorf("%s: %v", path, meta)
		}
	}
	resp, _ := http.Get(base + "/.well-known/oauth-authorization-server")
	var meta map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&meta)
	resp.Body.Close()
	if meta["issuer"] != base || meta["registration_endpoint"] != base+"/oauth/register" || meta["code_challenge_methods_supported"].([]any)[0] != "S256" {
		t.Errorf("authorization server: %v", meta)
	}
	if status, header := mcpStatus(t, base+"/mcp", ""); status != 401 || !strings.Contains(header.Get("WWW-Authenticate"), `resource_metadata="`+base+`/.well-known/oauth-protected-resource/mcp"`) {
		t.Errorf("without a token: %d %v", status, header)
	}

	// It is off until an administrator turns it on.
	if status, out := oauthPost(t, base+"/oauth/register", map[string]any{"redirect_uris": []string{"http://127.0.0.1/cb"}}); status != 403 || out["error"] != "access_denied" {
		t.Errorf("register while off: %d %v", status, out)
	}
	if location := startAuthorization(t, f.viewer, url.Values{}); location.String() != "/oauth/consent?error=mcp_disabled" {
		t.Errorf("authorize while off: %s", location)
	}
	setMCP(t, f.admin, true)
	if status, out := oauthPost(t, base+"/oauth/register", map[string]any{"redirect_uris": []string{"http://example.com/cb", "javascript:alert(1)"}}); status != 400 || out["error"] != "invalid_redirect_uri" {
		t.Errorf("register without an allowed address: %d %v", status, out)
	}
	m := registerMCPClient(t, f.viewer, "Test Agent")

	// A request the client cannot be answered at stays in the app; others go back to it.
	_, challenge := pkce("x")
	if location := startAuthorization(t, f.viewer, authorizeQuery(mcpClient{id: "oc_nope"}, m.redirect, challenge)); location.String() != "/oauth/consent?error=invalid_client" {
		t.Errorf("unknown client: %s", location)
	}
	if location := startAuthorization(t, f.viewer, authorizeQuery(m, "https://evil.example/callback", challenge)); location.String() != "/oauth/consent?error=invalid_redirect_uri" {
		t.Errorf("unregistered address: %s", location)
	}
	plain := authorizeQuery(m, m.redirect, challenge)
	plain.Set("code_challenge_method", "plain")
	if location := startAuthorization(t, f.viewer, plain); location.Host != "127.0.0.1:33418" || location.Query().Get("error") != "invalid_request" || location.Query().Get("state") != "st" || location.Query().Get("iss") != base {
		t.Errorf("without S256: %s", location)
	}
	elsewhere := authorizeQuery(m, m.redirect, challenge)
	elsewhere.Set("resource", "https://other.example/mcp")
	if location := startAuthorization(t, f.viewer, elsewhere); location.Query().Get("error") != "invalid_target" {
		t.Errorf("another resource: %s", location)
	}

	// The consent page names the client and where the answer goes.
	location := startAuthorization(t, f.viewer, authorizeQuery(m, m.redirect, challenge))
	request := strings.TrimPrefix(location.Path, "/oauth/consent/")
	info := f.viewer.expect("GET", "/oauth/requests/"+request, nil, 200, "")
	if info["clientName"] != "Test Agent" || info["redirectHost"] != "127.0.0.1" || info["loopback"] != true || info["mcpEnabled"] != true {
		t.Errorf("request: %v", info)
	}
	denied, _ := url.Parse(f.viewer.expect("POST", "/oauth/requests/"+request+"/deny", nil, 200, "")["redirectTo"].(string))
	if denied.Query().Get("error") != "access_denied" || denied.Query().Get("state") != "st" {
		t.Errorf("denied: %s", denied)
	}
	f.viewer.expect("POST", "/oauth/requests/"+request+"/approve", nil, 404, "not_found")

	// A code goes only to the client it was issued to, with its verifier, once.
	location = startAuthorization(t, f.viewer, authorizeQuery(m, m.redirect, challenge))
	answer, _ := url.Parse(f.viewer.expect("POST", "/oauth/requests/"+strings.TrimPrefix(location.Path, "/oauth/consent/")+"/approve", nil, 200, "")["redirectTo"].(string))
	code := answer.Query().Get("code")
	exchange := func(client, verifier string) (int, map[string]any) {
		return oauthPost(t, base+"/oauth/token", url.Values{"grant_type": {"authorization_code"}, "client_id": {client}, "code": {code}, "code_verifier": {verifier}})
	}
	other := registerMCPClient(t, f.viewer, "Other")
	if status, out := exchange(other.id, strings.Repeat("x", 43)); status != 400 || out["error"] != "invalid_grant" {
		t.Errorf("another client's code: %d %v", status, out)
	}
	if status, out := exchange(m.id, strings.Repeat("y", 43)); status != 400 || out["error"] != "invalid_grant" {
		t.Errorf("wrong verifier: %d %v", status, out)
	}
	status, first := exchange(m.id, strings.Repeat("x", 43))
	if status != 200 {
		t.Fatalf("exchange: %d", status)
	}
	if status, _ := mcpStatus(t, base+"/mcp", first["access_token"].(string)); status != 200 {
		t.Errorf("first token: %d", status)
	}
	// Used again, it may have been intercepted: what it gave stops working.
	if status, out := exchange(m.id, strings.Repeat("x", 43)); status != 400 || out["error"] != "invalid_grant" {
		t.Errorf("code used twice: %d %v", status, out)
	}
	if status, _ := mcpStatus(t, base+"/mcp", first["access_token"].(string)); status != 401 {
		t.Errorf("after the code was replayed: %d", status)
	}

	// A token works only at the address it was issued for.
	access, refresh := allow(t, f.viewer, m)
	if status, _ := mcpStatus(t, base+"/mcp", access); status != 200 {
		t.Errorf("with the token: %d", status)
	}
	otherHost := strings.Replace(base, "127.0.0.1", "localhost", 1)
	if status, header := mcpStatus(t, otherHost+"/mcp", access); status != 401 || !strings.Contains(header.Get("WWW-Authenticate"), `resource_metadata="`+otherHost+`/.well-known/oauth-protected-resource/mcp"`) {
		t.Errorf("at another address: %d %v", status, header)
	}
	if status, _ := mcpStatus(t, base+"/mcp", "nope"); status != 401 {
		t.Errorf("made-up token: %d", status)
	}
	req, _ := http.NewRequest("POST", base+"/mcp", strings.NewReader(`{}`))
	req.Header.Set("Authorization", "Bearer "+access)
	req.Header.Set("Origin", "https://evil.example")
	if resp, _ := http.DefaultClient.Do(req); resp.StatusCode != 403 {
		t.Errorf("from another site: %d", resp.StatusCode)
	}

	// A refresh token gives a new pair. Sent again at once, as from requests
	// made together or a retry, it gives another; replayed later, it ends the
	// authorization.
	refreshWith := func(token string) (int, map[string]any) {
		return oauthPost(t, base+"/oauth/token", url.Values{"grant_type": {"refresh_token"}, "client_id": {m.id}, "refresh_token": {token}})
	}
	status, renewed := refreshWith(refresh)
	if status != 200 || renewed["access_token"] == access {
		t.Fatalf("refresh: %d %v", status, renewed)
	}
	status, again := refreshWith(refresh)
	if status != 200 || again["access_token"] == renewed["access_token"] {
		t.Fatalf("refreshed again at once: %d %v", status, again)
	}
	for _, token := range []any{renewed["access_token"], again["access_token"]} {
		if status, _ := mcpStatus(t, base+"/mcp", token.(string)); status != 200 {
			t.Errorf("renewed token: %d", status)
		}
	}
	if _, err := f.admin.db.Pool.Exec(context.Background(), `UPDATE oauth_tokens SET used_at = used_at - interval '1 minute' WHERE used_at IS NOT NULL`); err != nil {
		t.Fatal(err)
	}
	if status, out := refreshWith(refresh); status != 400 || out["error"] != "invalid_grant" {
		t.Errorf("replayed refresh token: %d %v", status, out)
	}
	if status, _ := mcpStatus(t, base+"/mcp", renewed["access_token"].(string)); status != 401 {
		t.Errorf("after a replay: %d", status)
	}

	// The person sees their clients and revokes one.
	access, _ = allow(t, f.viewer, m)
	list := f.viewer.expect("GET", "/mcp/authorizations", nil, 200, "")
	items := list["items"].([]any)
	if list["enabled"] != true || list["address"] != base+"/mcp" || len(items) != 1 || items[0].(map[string]any)["clientName"] != "Test Agent" || items[0].(map[string]any)["redirectHost"] != "127.0.0.1" {
		t.Fatalf("authorizations: %v", list)
	}
	authorization := items[0].(map[string]any)["id"].(string)
	f.developer.expect("DELETE", "/mcp/authorizations/"+authorization, nil, 404, "not_found")
	f.viewer.expect("DELETE", "/mcp/authorizations/"+authorization, nil, 204, "")
	if status, _ := mcpStatus(t, base+"/mcp", access); status != 401 {
		t.Errorf("after revoking: %d", status)
	}

	// Turned off, nothing works; turned on again, the authorization does.
	access, _ = allow(t, f.viewer, m)
	setMCP(t, f.admin, false)
	if status, _ := mcpStatus(t, base+"/mcp", access); status != 403 {
		t.Errorf("while off: %d", status)
	}
	location = startAuthorization(t, f.viewer, url.Values{"client_id": {m.id}})
	if location.String() != "/oauth/consent?error=mcp_disabled" {
		t.Errorf("authorize while off: %s", location)
	}
	setMCP(t, f.admin, true)
	if status, _ := mcpStatus(t, base+"/mcp", access); status != 200 {
		t.Errorf("on again: %d", status)
	}

	// An administrator resetting the password revokes them, also when the
	// account is set active at the same time.
	viewerID := userID(t, f.admin, "viewer@example.com")
	f.admin.expect("PATCH", "/users/"+viewerID, map[string]any{"status": "active", "password": "another-password"}, 200, "")
	if status, _ := mcpStatus(t, base+"/mcp", access); status != 401 {
		t.Errorf("after resetting the password: %d", status)
	}

	// Disabling the account revokes its authorizations.
	access, _ = allow(t, f.admin.signedIn("viewer@example.com", "another-password"), m)
	f.admin.expect("PATCH", "/users/"+viewerID, map[string]any{"status": "disabled"}, 200, "")
	if status, _ := mcpStatus(t, base+"/mcp", access); status != 401 {
		t.Errorf("after disabling: %d", status)
	}
	if n, err := store.ListMCPAuthorizations(context.Background(), f.admin.api.Pool, store.DefaultOrgID, viewerID); err != nil || len(n) != 0 {
		t.Errorf("authorizations left: %v, %v", n, err)
	}

	// Each grant and revocation is in the audit log, with why it was revoked.
	var reasons []string
	for _, e := range auditEvents(t, f.admin, "?category=auth") {
		if e["action"] == "mcp.revoke" {
			reason, _ := e["detail"].(map[string]any)["reason"].(string)
			reasons = append(reasons, reason)
		}
	}
	if strings.Join(reasons, ",") != "user_disabled,password_reset,,refresh_token_reused,code_reused" {
		t.Errorf("revocations: %v", reasons)
	}
	// The change to the account that revoked them is there as well.
	updates := 0
	for _, e := range auditEvents(t, f.admin, "") {
		if object, _ := e["object"].(map[string]any); e["action"] == "user.update" && object["id"] == viewerID {
			updates++
		}
	}
	if updates != 2 {
		t.Errorf("user.update events for the account: %d, want 2", updates)
	}
}

// boardIn makes a dashboard in another workspace, as its administrator,
// granted to everyone there.
func boardIn(t *testing.T, f *contentFixture, workspace, board string, members ...string) (workspaceID, dashboardID string) {
	t.Helper()
	admin := f.admin.signedIn(adminEmail, adminPassword)
	workspaceID = admin.expect("POST", "/workspaces", map[string]any{"name": workspace, "timezone": "America/New_York"}, 201, "")["id"].(string)
	admin.expect("POST", "/auth/workspace", map[string]any{"workspaceId": workspaceID}, 200, "")
	for _, email := range members {
		admin.expect("POST", "/members", map[string]any{"userId": userID(t, admin, email), "role": "viewer"}, 201, "")
	}
	source := admin.expect("POST", "/datasources", admin.datasourceInput("db"), 201, "")["id"].(string)
	dataset := admin.expect("POST", "/datasets", map[string]any{"name": "订单", "datasourceId": source, "spec": admin.spec(nil)}, 201, "")["id"].(string)
	input := (&contentFixture{datasetID: dataset}).chart("月度", `{"type":"table"}`)
	chart := admin.expect("POST", "/charts", input, 201, "")["id"].(string)
	dashboardID = admin.expect("POST", "/dashboards", map[string]any{"name": board, "spec": dashboardSpec(chart)}, 201, "")["id"].(string)
	admin.expect("PUT", "/dashboards/"+dashboardID+"/grants", map[string]any{"subjects": []any{map[string]any{"everyone": true}}}, 200, "")
	return workspaceID, dashboardID
}

// An MCP client reads, as the person, the dashboards they can open in every
// workspace they belong to, each in its own workspace, and cites a link to
// what it read; dashboards elsewhere do not exist for it.
func TestMCPTools(t *testing.T) {
	f := newContentFixture(t)
	chart := f.developer.expect("POST", "/charts", f.drilledChart(), 201, "")["id"].(string)
	board := f.developer.expect("POST", "/dashboards", map[string]any{"name": "销售看板", "spec": dashboardSpec(chart)}, 201, "")["id"].(string)
	f.share(t, board)
	hidden := f.developer.expect("POST", "/dashboards", map[string]any{"name": "未授权", "spec": dashboardSpec(chart)}, 201, "")["id"].(string)
	finance, financeBoard := boardIn(t, f, "财务", "财务看板", "viewer@example.com")
	_, elsewhere := boardIn(t, f, "人事", "人事看板")

	setMCP(t, f.admin, true)
	access, _ := allow(t, f.viewer, registerMCPClient(t, f.viewer, "Test Agent"))
	session := connectMCP(t, f.viewer, access)
	if got := session.InitializeResult().Instructions; !strings.Contains(got, "link of its source") {
		t.Errorf("instructions: %s", got)
	}
	tools, err := session.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tool := range tools.Tools {
		names = append(names, tool.Name)
		if tool.Annotations == nil || !tool.Annotations.ReadOnlyHint {
			t.Errorf("%s is not marked read-only", tool.Name)
		}
	}
	if strings.Join(names, ",") != "describe_dashboard,filter_options,list_dashboards,query_chart" {
		t.Errorf("tools: %v", names)
	}

	listed, failed := call(t, session, "list_dashboards", map[string]any{})
	var workspaces []struct {
		ID, Name   string
		Dashboards []struct{ ID, Name string }
	}
	if err := json.Unmarshal([]byte(listed), &workspaces); err != nil || failed {
		t.Fatalf("list_dashboards: %s", listed)
	}
	var seen []string
	for _, w := range workspaces {
		for _, d := range w.Dashboards {
			seen = append(seen, w.Name+"/"+d.Name)
		}
	}
	if got := strings.Join(seen, ","); !strings.Contains(got, "/销售看板") || !strings.Contains(got, "财务/财务看板") || strings.Contains(got, "未授权") || strings.Contains(got, "人事") {
		t.Errorf("listed: %s", got)
	}

	// A dashboard of another workspace is read there, in its time zone.
	described, _ := call(t, session, "describe_dashboard", map[string]any{"dashboard": financeBoard})
	if !strings.Contains(described, `"workspace":{"id":"`+finance+`","name":"财务","timezone":"America/New_York","today":"2026-03-10"}`) {
		t.Errorf("describe_dashboard: %s", described)
	}
	text, failed := call(t, session, "query_chart", map[string]any{"dashboard": board, "widget": "wa", "drill": []any{"华东"}})
	var data struct {
		Rows   [][]any
		Source struct {
			Dashboard, Chart, Link string
			Revisions             struct{ Dashboard, Chart, Dataset int }
		}
	}
	if err := json.Unmarshal([]byte(text), &data); err != nil || failed {
		t.Fatalf("query_chart: %s", text)
	}
	link, _ := url.Parse(data.Source.Link)
	if data.Source.Dashboard != "销售看板" || len(data.Rows) != 2 || data.Source.Revisions.Dashboard != 1 ||
		link.Scheme+"://"+link.Host != f.viewer.server.URL || link.Path != "/dashboards/"+board || link.Query().Get("ws") != store.DefaultWorkspaceID || link.Query().Get("view") == "" {
		t.Errorf("query_chart: %s", text)
	}
	if !strings.Contains(text, "&ws="+store.DefaultWorkspaceID+`"`) {
		t.Errorf("the link is escaped: %s", text)
	}
	if text, failed := call(t, session, "query_chart", map[string]any{"dashboard": financeBoard, "widget": "wa"}); failed || !strings.Contains(text, "ws="+finance) {
		t.Errorf("another workspace: %s", text)
	}
	for _, id := range []string{hidden, elsewhere, "db_nope"} {
		if text, failed := call(t, session, "query_chart", map[string]any{"dashboard": id, "widget": "wa"}); !failed || !strings.HasPrefix(text, "not_found") {
			t.Errorf("%s: %v %s", id, failed, text)
		}
	}

	// What it read is a query event in the dashboard's workspace, from MCP.
	var events []string
	for _, e := range auditEvents(t, f.admin, "?category=query") {
		detail := e["detail"].(map[string]any)
		if detail["via"] == "mcp" {
			events = append(events, e["workspace"].(map[string]any)["name"].(string)+":"+detail["client"].(string))
		}
	}
	if strings.Join(events, ",") != "财务:Test Agent,Default:Test Agent" {
		t.Errorf("query events: %v", events)
	}
}

// A client that registered with a secret must prove itself with it, by HTTP
// Basic or in the form, to exchange its code.
func TestMCPConfidentialClient(t *testing.T) {
	f := newContentFixture(t)
	base := f.admin.server.URL
	setMCP(t, f.admin, true)
	// A client that does not say how it proves itself is taken as public.
	if status, public := oauthPost(t, base+"/oauth/register", map[string]any{"redirect_uris": []string{"http://localhost:8787/callback"}}); status != 201 ||
		public["token_endpoint_auth_method"] != "none" || public["client_secret"] != nil || public["client_name"] != "localhost" {
		t.Errorf("register without a method: %d %v", status, public)
	}
	status, registered := oauthPost(t, base+"/oauth/register", map[string]any{"client_name": "Claude", "token_endpoint_auth_method": "client_secret_basic",
		"redirect_uris": []string{"https://claude.ai/api/mcp/auth_callback"}})
	secret, _ := registered["client_secret"].(string)
	if status != 201 || registered["token_endpoint_auth_method"] != "client_secret_basic" || secret == "" {
		t.Fatalf("register: %d %v", status, registered)
	}
	m := mcpClient{id: registered["client_id"].(string), redirect: "https://claude.ai/api/mcp/auth_callback"}
	verifier, challenge := pkce("c")
	location := startAuthorization(t, f.viewer, authorizeQuery(m, m.redirect, challenge))
	answer, _ := url.Parse(f.viewer.expect("POST", "/oauth/requests/"+strings.TrimPrefix(location.Path, "/oauth/consent/")+"/approve", nil, 200, "")["redirectTo"].(string))
	if answer.Host != "claude.ai" || answer.Query().Get("code") == "" {
		t.Fatalf("approved: %s", answer)
	}
	form := url.Values{"grant_type": {"authorization_code"}, "code": {answer.Query().Get("code")}, "code_verifier": {verifier}, "redirect_uri": {m.redirect}}
	exchange := func(id, secret string, basic bool) (int, map[string]any) {
		body := url.Values{}
		for key, values := range form {
			body[key] = values
		}
		if !basic {
			body.Set("client_id", id)
			body.Set("client_secret", secret)
		}
		req, _ := http.NewRequest("POST", base+"/oauth/token", strings.NewReader(body.Encode()))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		if basic {
			req.SetBasicAuth(url.QueryEscape(id), url.QueryEscape(secret))
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}
	if status, out := exchange(m.id, "", false); status != 401 || out["error"] != "invalid_client" {
		t.Errorf("without the secret: %d %v", status, out)
	}
	if status, out := exchange(m.id, "wrong", true); status != 401 || out["error"] != "invalid_client" {
		t.Errorf("wrong secret: %d %v", status, out)
	}
	if status, out := exchange(m.id, secret, true); status != 200 || out["access_token"] == nil {
		t.Errorf("with the secret: %d %v", status, out)
	}
}
