package api

import (
	"cmp"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/supazd/supabi/internal/api/gen"
	"github.com/supazd/supabi/internal/audit"
	"github.com/supazd/supabi/internal/auth"
	"github.com/supazd/supabi/internal/store"
)

// SupaBI is its own OAuth authorization server for MCP clients, on the same
// origin as the MCP address: .agents/design/ai-assistant.md 14.4. The
// protocol endpoints here follow OAuth rather than the REST API; the consent
// page answers requests through the REST API, further down.

const (
	// mcpScope is the one scope, which covers the four tools.
	mcpScope = "dashboards:read"
	mcpPath  = "/mcp"

	oauthRequestLifetime = 10 * time.Minute
	oauthCodeLifetime    = time.Minute
	oauthAccessLifetime  = time.Hour
	// oauthRefreshGrace is how long a refresh token, once exchanged, is still
	// honoured, for requests made at once and retries after a lost answer.
	oauthRefreshGrace = 30 * time.Second

	maxRedirectURIs   = 10
	maxClientNameLen  = 200
	maxOAuthBodyBytes = 64 << 10
)

// registerOAuth mounts the protocol endpoints of OAuth and MCP.
func (s *Server) registerOAuth(mux *http.ServeMux) {
	mux.HandleFunc("GET /.well-known/oauth-protected-resource", s.resourceMetadata)
	mux.HandleFunc("GET /.well-known/oauth-protected-resource"+mcpPath, s.resourceMetadata)
	mux.HandleFunc("GET /.well-known/oauth-authorization-server", s.authorizationServerMetadata)
	mux.HandleFunc("POST /oauth/register", s.registerClient)
	mux.HandleFunc("GET /oauth/authorize", s.authorize)
	mux.HandleFunc("POST /oauth/token", s.issueTokens)
	mux.Handle(mcpPath, s.mcpHandler())
}

// origin is how the client reached this server, which names the MCP
// address and the authorization server. Like the session cookie, it takes
// HTTPS from the connection or from a proxy's X-Forwarded-Proto.
func origin(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}

// sameResource says whether two addresses name the same MCP server: the
// scheme and host compare without case, and a trailing slash is ignored.
func sameResource(a, b string) bool {
	ua, errA := url.Parse(a)
	ub, errB := url.Parse(b)
	return errA == nil && errB == nil && ua.Fragment == "" && ub.Fragment == "" && ua.RawQuery == ub.RawQuery &&
		strings.EqualFold(ua.Scheme, ub.Scheme) && strings.EqualFold(ua.Host, ub.Host) &&
		strings.TrimSuffix(ua.Path, "/") == strings.TrimSuffix(ub.Path, "/")
}

func (s *Server) mcpEnabled(ctx context.Context, orgID string) (bool, error) {
	settings, err := store.SystemSettingsInForce(ctx, s.Pool, orgID)
	return settings.MCPEnabled, err
}

// oauthError is an error of an OAuth endpoint, in the form OAuth gives it.
type oauthError struct {
	status      int
	code        string
	description string
}

func (e *oauthError) Error() string { return e.code + ": " + e.description }

var errMCPOff = &oauthError{http.StatusForbidden, "access_denied", "MCP is turned off by an administrator of SupaBI"}

func writeOAuthJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// writeOAuthError answers with err, or with a server error that the log
// keeps and the client is not told about.
func (s *Server) writeOAuthError(w http.ResponseWriter, r *http.Request, err error) {
	var e *oauthError
	if !errors.As(err, &e) {
		s.Logger.ErrorContext(r.Context(), "oauth endpoint failed", "path", r.URL.Path, "error", err)
		e = &oauthError{http.StatusInternalServerError, "server_error", "something went wrong"}
	}
	if e.status == http.StatusUnauthorized {
		w.Header().Set("WWW-Authenticate", `Basic realm="SupaBI"`)
	}
	writeOAuthJSON(w, e.status, map[string]string{"error": e.code, "error_description": e.description})
}

// ---- discovery ----

// resourceMetadata describes the MCP address as a protected resource (RFC 9728).
func (s *Server) resourceMetadata(w http.ResponseWriter, r *http.Request) {
	o := origin(r)
	// Public facts for discovery, which any page may read.
	w.Header().Set("Access-Control-Allow-Origin", "*")
	writeOAuthJSON(w, http.StatusOK, map[string]any{
		"resource":                 o + mcpPath,
		"authorization_servers":    []string{o},
		"scopes_supported":         []string{mcpScope},
		"bearer_methods_supported": []string{"header"},
		"resource_name":            "SupaBI",
	})
}

// authorizationServerMetadata describes the authorization server (RFC 8414).
func (s *Server) authorizationServerMetadata(w http.ResponseWriter, r *http.Request) {
	o := origin(r)
	w.Header().Set("Access-Control-Allow-Origin", "*")
	writeOAuthJSON(w, http.StatusOK, map[string]any{
		"issuer":                                o,
		"authorization_endpoint":                o + "/oauth/authorize",
		"token_endpoint":                        o + "/oauth/token",
		"registration_endpoint":                 o + "/oauth/register",
		"scopes_supported":                      []string{mcpScope},
		"response_types_supported":              []string{"code"},
		"grant_types_supported":                 []string{"authorization_code", "refresh_token"},
		"token_endpoint_auth_methods_supported": []string{"none", "client_secret_basic", "client_secret_post"},
		"code_challenge_methods_supported":      []string{"S256"},
		"authorization_response_iss_parameter_supported": true,
	})
}

// ---- registration ----

// loopback says whether a host names this very computer.
func loopback(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// redirectAllowed says whether an authorization may be sent to an address:
// HTTPS, or HTTP on a loopback address, with no fragment.
func redirectAllowed(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Fragment != "" || u.Host == "" || u.User != nil || len(raw) > 2000 {
		return false
	}
	return u.Scheme == "https" || (u.Scheme == "http" && loopback(u.Hostname()))
}

// redirectMatches says whether an address is one the client registered.
// For a loopback address the port is not compared: a program on the
// person's computer listens on whatever port is free (RFC 8252 7.3).
func redirectMatches(registered []string, given string) bool {
	if slices.Contains(registered, given) {
		return true
	}
	g, err := url.Parse(given)
	if err != nil || g.Scheme != "http" || !loopback(g.Hostname()) || g.Fragment != "" {
		return false
	}
	return slices.ContainsFunc(registered, func(raw string) bool {
		r, err := url.Parse(raw)
		return err == nil && r.Scheme == g.Scheme && strings.EqualFold(r.Hostname(), g.Hostname()) && r.Path == g.Path && r.RawQuery == g.RawQuery
	})
}

// registerClient is dynamic client registration (RFC 7591). Anyone may
// register; addresses that are neither HTTPS nor loopback are left out of
// the registration, which RFC 7591 allows, and only a registration left
// with none is refused. A client that does not say how it proves itself is
// registered as public: MCP clients run on people's computers and hold no
// secret, and one that ignored a secret it was given could never sign in.
func (s *Server) registerClient(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	if on, err := s.mcpEnabled(ctx, signInOrg); err != nil || !on {
		s.writeOAuthError(w, r, cmp.Or(err, error(errMCPOff)))
		return
	}
	var in struct {
		RedirectURIs  []string `json:"redirect_uris"`
		ClientName    string   `json:"client_name"`
		AuthMethod    string   `json:"token_endpoint_auth_method"`
		GrantTypes    []string `json:"grant_types"`
		ResponseTypes []string `json:"response_types"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxOAuthBodyBytes)).Decode(&in); err != nil {
		s.writeOAuthError(w, r, &oauthError{http.StatusBadRequest, "invalid_client_metadata", "the body must be a JSON object of client metadata"})
		return
	}
	var uris []string
	for _, uri := range in.RedirectURIs {
		if redirectAllowed(uri) && !slices.Contains(uris, uri) {
			uris = append(uris, uri)
		}
	}
	switch {
	case len(uris) == 0:
		s.writeOAuthError(w, r, &oauthError{http.StatusBadRequest, "invalid_redirect_uri", "a redirect address must be HTTPS, or HTTP on localhost, 127.0.0.1 or [::1]"})
		return
	case len(uris) > maxRedirectURIs:
		s.writeOAuthError(w, r, &oauthError{http.StatusBadRequest, "invalid_redirect_uri", "at most 10 redirect addresses"})
		return
	}
	method := cmp.Or(in.AuthMethod, "none")
	if !slices.Contains([]string{"none", "client_secret_basic", "client_secret_post"}, method) {
		s.writeOAuthError(w, r, &oauthError{http.StatusBadRequest, "invalid_client_metadata", "token_endpoint_auth_method must be none, client_secret_basic or client_secret_post"})
		return
	}
	for _, g := range in.GrantTypes {
		if g != "authorization_code" && g != "refresh_token" {
			s.writeOAuthError(w, r, &oauthError{http.StatusBadRequest, "invalid_client_metadata", "only the authorization_code and refresh_token grants are supported"})
			return
		}
	}
	for _, t := range in.ResponseTypes {
		if t != "code" {
			s.writeOAuthError(w, r, &oauthError{http.StatusBadRequest, "invalid_client_metadata", "only the code response type is supported"})
			return
		}
	}
	name := strings.TrimSpace(in.ClientName)
	if name == "" {
		u, _ := url.Parse(uris[0])
		name = u.Hostname()
	}
	if utf8.RuneCountInString(name) > maxClientNameLen {
		name = string([]rune(name)[:maxClientNameLen])
	}
	client := store.OAuthClient{Name: name, RedirectURIs: uris, AuthMethod: method}
	var secret string
	if method != "none" {
		secret, client.SecretHash = auth.NewSessionToken()
	}
	client, err := store.CreateOAuthClient(ctx, s.Pool, client)
	if err != nil {
		s.writeOAuthError(w, r, err)
		return
	}
	out := map[string]any{
		"client_id": client.ID, "client_id_issued_at": client.CreatedAt.Unix(), "client_name": client.Name,
		"redirect_uris": client.RedirectURIs, "token_endpoint_auth_method": method,
		"grant_types": []string{"authorization_code", "refresh_token"}, "response_types": []string{"code"}, "scope": mcpScope,
	}
	if secret != "" {
		out["client_secret"], out["client_secret_expires_at"] = secret, 0
	}
	writeOAuthJSON(w, http.StatusCreated, out)
}

// ---- authorization ----

// A PKCE challenge or verifier: base64url of a SHA-256 for the first, and
// 43 to 128 unreserved characters for the second (RFC 7636 4.1).
var (
	pkceChallenge = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	pkceVerifier  = regexp.MustCompile(`^[A-Za-z0-9._~-]{43,128}$`)
)

func pkceMatches(verifier, challenge string) bool {
	if !pkceVerifier.MatchString(verifier) {
		return false
	}
	sum := sha256.Sum256([]byte(verifier))
	return subtle.ConstantTimeCompare([]byte(base64.RawURLEncoding.EncodeToString(sum[:])), []byte(challenge)) == 1
}

// answerTo is where an answer to a client goes: its redirect address, with
// the answer, its state and who answered (RFC 9207) added to the query.
func answerTo(redirectURI, state, issuer string, answer url.Values) string {
	u, err := url.Parse(redirectURI)
	if err != nil {
		return redirectURI
	}
	q := u.Query()
	for key, values := range answer {
		q[key] = values
	}
	if state != "" {
		q.Set("state", state)
	}
	q.Set("iss", issuer)
	u.RawQuery = q.Encode()
	return u.String()
}

// authorize starts an authorization: it checks the request and sends the
// browser to the consent page in the app, which asks the person signed in.
// A request whose client or redirect address is wrong is not sent back to
// that address; the app says what went wrong instead.
func (s *Server) authorize(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	q := r.URL.Query()
	stop := func(code string) {
		http.Redirect(w, r, "/oauth/consent?error="+url.QueryEscape(code), http.StatusFound)
	}
	if on, err := s.mcpEnabled(ctx, signInOrg); err != nil {
		s.Logger.ErrorContext(ctx, "oauth authorize failed", "error", err)
		stop("server_error")
		return
	} else if !on {
		stop("mcp_disabled")
		return
	}
	client, err := store.GetOAuthClient(ctx, s.Pool, q.Get("client_id"))
	if err != nil {
		if !errors.Is(err, store.ErrNotFound) {
			s.Logger.ErrorContext(ctx, "oauth authorize failed", "error", err)
		}
		stop("invalid_client")
		return
	}
	redirect := q.Get("redirect_uri")
	if redirect == "" && len(client.RedirectURIs) == 1 {
		redirect = client.RedirectURIs[0]
	}
	if !redirectMatches(client.RedirectURIs, redirect) {
		stop("invalid_redirect_uri")
		return
	}
	state := q.Get("state")
	back := func(code, description string) {
		http.Redirect(w, r, answerTo(redirect, state, origin(r), url.Values{"error": {code}, "error_description": {description}}), http.StatusFound)
	}
	if q.Get("response_type") != "code" {
		back("unsupported_response_type", "only the code response type is supported")
		return
	}
	if q.Get("code_challenge_method") != "S256" || !pkceChallenge.MatchString(q.Get("code_challenge")) {
		back("invalid_request", "PKCE with the S256 method is required")
		return
	}
	resource := origin(r) + mcpPath
	if given := q.Get("resource"); given != "" && !sameResource(given, resource) {
		back("invalid_target", "the resource must be "+resource)
		return
	}
	// Scopes other than ours are left out: there is nothing else to grant.
	request, err := store.CreateOAuthRequest(ctx, s.Pool, store.OAuthRequest{
		ClientID: client.ID, RedirectURI: redirect, State: state, CodeChallenge: q.Get("code_challenge"), Resource: resource, Scope: mcpScope,
	}, oauthRequestLifetime)
	if err != nil {
		s.Logger.ErrorContext(ctx, "oauth authorize failed", "error", err)
		back("server_error", "the request could not be kept")
		return
	}
	http.Redirect(w, r, "/oauth/consent/"+url.PathEscape(request.ID), http.StatusFound)
}

// hostOf is the host an address names, for people to judge a client by.
func hostOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	return u.Hostname()
}

func (s *Server) GetOAuthRequest(ctx context.Context, req gen.GetOAuthRequestRequestObject) (gen.GetOAuthRequestResponseObject, error) {
	request, client, err := store.GetOAuthRequest(ctx, s.Pool, req.Id)
	if err != nil {
		return nil, err
	}
	on, err := s.mcpEnabled(ctx, s.scope(ctx).OrgID)
	if err != nil {
		return nil, err
	}
	return gen.GetOAuthRequest200JSONResponse{ClientName: client.Name, RedirectHost: hostOf(request.RedirectURI), Loopback: loopback(hostOf(request.RedirectURI)), McpEnabled: on}, nil
}

var errMCPDisabled = &apiError{status: http.StatusForbidden, code: "mcp_disabled", message: "MCP is turned off by an administrator"}

// ApproveOAuthRequest allows the client as the person signed in, and hands
// it a code by way of the browser.
func (s *Server) ApproveOAuthRequest(ctx context.Context, req gen.ApproveOAuthRequestRequestObject) (gen.ApproveOAuthRequestResponseObject, error) {
	c := callerFrom(ctx)
	if on, err := s.mcpEnabled(ctx, c.principal.OrgID); err != nil {
		return nil, err
	} else if !on {
		return nil, errMCPDisabled
	}
	code, hash := auth.NewSessionToken()
	request, a, err := store.ApproveOAuthRequest(ctx, s.Pool, req.Id, c.principal.OrgID, c.principal.UserID, hash, oauthCodeLifetime)
	if err != nil {
		return nil, err
	}
	s.recordMCPAuthorization(ctx, "mcp.authorize", a, request.RedirectURI, "")
	return gen.ApproveOAuthRequest200JSONResponse{RedirectTo: answerTo(request.RedirectURI, request.State, origin(c.r), url.Values{"code": {code}})}, nil
}

func (s *Server) DenyOAuthRequest(ctx context.Context, req gen.DenyOAuthRequestRequestObject) (gen.DenyOAuthRequestResponseObject, error) {
	request, err := store.DenyOAuthRequest(ctx, s.Pool, req.Id)
	if err != nil {
		return nil, err
	}
	answer := url.Values{"error": {"access_denied"}, "error_description": {"the person did not allow it"}}
	return gen.DenyOAuthRequest200JSONResponse{RedirectTo: answerTo(request.RedirectURI, request.State, origin(callerFrom(ctx).r), answer)}, nil
}

// recordMCPAuthorization records that a client was allowed or revoked. The
// person whose authorization it is goes in the detail when they are not the
// one acting, with why it was revoked.
func (s *Server) recordMCPAuthorization(ctx context.Context, action string, a store.MCPAuthorization, redirectURI, reason string) {
	e := s.event(ctx, action, audit.Success)
	e.OrgID = a.OrgID
	e.Object = audit.Object{Type: "mcp_client", ID: a.ClientID, Name: a.ClientName}
	hosts := redirectHosts(a.RedirectURIs)
	if redirectURI != "" {
		hosts = hostOf(redirectURI)
	}
	e.Detail = map[string]any{"redirectHost": hosts}
	if e.ActorID != a.UserID {
		e.Detail["userId"] = a.UserID
	}
	if reason != "" {
		e.Detail["reason"] = reason
	}
	s.record(ctx, e)
}

// redirectHosts are the hosts a client may be answered at, for people.
func redirectHosts(uris []string) string {
	var hosts []string
	for _, uri := range uris {
		if host := hostOf(uri); !slices.Contains(hosts, host) {
			hosts = append(hosts, host)
		}
	}
	return strings.Join(hosts, ", ")
}

// ---- tokens ----

// tokenClient is the client calling the token endpoint, which proves itself
// with its secret if it has one, by HTTP Basic or in the form (RFC 6749 2.3.1).
func (s *Server) tokenClient(r *http.Request) (store.OAuthClient, error) {
	id, secret, basic := r.BasicAuth()
	if basic {
		id, _ = url.QueryUnescape(id)
		secret, _ = url.QueryUnescape(secret)
	} else {
		id, secret = r.PostForm.Get("client_id"), r.PostForm.Get("client_secret")
	}
	invalid := &oauthError{http.StatusUnauthorized, "invalid_client", "unknown client, or wrong secret"}
	client, err := store.GetOAuthClient(r.Context(), s.Pool, id)
	if errors.Is(err, store.ErrNotFound) {
		return client, invalid
	} else if err != nil {
		return client, err
	}
	if client.SecretHash != nil && subtle.ConstantTimeCompare(auth.HashSessionToken(secret), client.SecretHash) != 1 {
		return client, invalid
	}
	return client, nil
}

// issueTokens exchanges a code, or a refresh token, for a new access token
// and refresh token.
func (s *Server) issueTokens(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	r.Body = http.MaxBytesReader(w, r.Body, maxOAuthBodyBytes)
	if err := r.ParseForm(); err != nil {
		s.writeOAuthError(w, r, &oauthError{http.StatusBadRequest, "invalid_request", "the body must be a form"})
		return
	}
	client, err := s.tokenClient(r)
	if err != nil {
		s.writeOAuthError(w, r, err)
		return
	}
	form := r.PostForm
	invalidGrant := &oauthError{http.StatusBadRequest, "invalid_grant", "the code or refresh token is invalid, expired or already used"}
	var (
		kind  string
		token string
	)
	switch form.Get("grant_type") {
	case "authorization_code":
		kind, token = store.TokenCode, form.Get("code")
	case "refresh_token":
		kind, token = store.TokenRefresh, form.Get("refresh_token")
	default:
		s.writeOAuthError(w, r, &oauthError{http.StatusBadRequest, "unsupported_grant_type", "only authorization_code and refresh_token are supported"})
		return
	}
	check := func(g store.OAuthGrant) error {
		if g.Authorization.ClientID != client.ID {
			return invalidGrant
		}
		if resource := form.Get("resource"); resource != "" && !sameResource(resource, g.Resource) {
			return &oauthError{http.StatusBadRequest, "invalid_target", "the tokens are for " + g.Resource}
		}
		settings, err := store.SystemSettingsInForce(ctx, s.Pool, g.Authorization.OrgID)
		if err != nil {
			return err
		}
		if !settings.MCPEnabled {
			return &oauthError{http.StatusBadRequest, "unauthorized_client", errMCPOff.description}
		}
		if kind == store.TokenCode {
			if given := form.Get("redirect_uri"); given != "" && given != g.RedirectURI {
				return invalidGrant
			}
			if !pkceMatches(form.Get("code_verifier"), g.CodeChallenge) {
				return &oauthError{http.StatusBadRequest, "invalid_grant", "the code verifier does not match"}
			}
		} else if g.Age >= settings.SessionLifetime {
			// It went unused for the session lifetime: .agents/design/ai-assistant.md 14.4.
			return invalidGrant
		}
		return nil
	}
	access, accessHash := auth.NewSessionToken()
	refresh, refreshHash := auth.NewSessionToken()
	g, err := store.ExchangeOAuthToken(ctx, s.Pool, kind, auth.HashSessionToken(token), oauthRefreshGrace, check,
		store.OAuthIssue{AccessHash: accessHash, RefreshHash: refreshHash, AccessLifetime: oauthAccessLifetime})
	switch {
	case errors.Is(err, store.ErrTokenReused):
		// Someone else may hold the code or token: nobody keeps the authorization.
		reason := "code_reused"
		if kind == store.TokenRefresh {
			reason = "refresh_token_reused"
		}
		s.recordMCPAuthorization(context.WithValue(ctx, callerKey{}, &caller{r: r}), "mcp.revoke", g.Authorization, "", reason)
		s.writeOAuthError(w, r, invalidGrant)
		return
	case errors.Is(err, store.ErrNotFound):
		s.writeOAuthError(w, r, invalidGrant)
		return
	case err != nil:
		s.writeOAuthError(w, r, err)
		return
	}
	writeOAuthJSON(w, http.StatusOK, map[string]any{
		"access_token": access, "token_type": "Bearer", "expires_in": int(oauthAccessLifetime / time.Second),
		"refresh_token": refresh, "scope": g.Authorization.Scope,
	})
}
