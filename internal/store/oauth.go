package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/supazd/supabi/internal/id"
)

// MCP clients and the authorizations people give them, with SupaBI as its
// own OAuth authorization server: .agents/design/ai-assistant.md 14.4.

// ErrTokenReused is a code or refresh token presented after it was already
// exchanged: it may have been stolen.
var ErrTokenReused = errors.New("token already used")

// Kinds of oauth_tokens.
const (
	TokenCode    = "code"
	TokenAccess  = "access"
	TokenRefresh = "refresh"
)

// OAuthClient is a client registered by dynamic client registration.
type OAuthClient struct {
	ID           string
	Name         string
	RedirectURIs []string
	// AuthMethod is none, client_secret_basic or client_secret_post.
	AuthMethod string
	// SecretHash is nil for a public client.
	SecretHash []byte
	CreatedAt  time.Time
}

func CreateOAuthClient(ctx context.Context, pool *pgxpool.Pool, c OAuthClient) (OAuthClient, error) {
	c.ID = id.New("oc")
	err := pool.QueryRow(ctx, `INSERT INTO oauth_clients (id, name, redirect_uris, token_endpoint_auth_method, secret_hash) VALUES ($1, $2, $3, $4, $5) RETURNING created_at`,
		c.ID, c.Name, c.RedirectURIs, c.AuthMethod, c.SecretHash).Scan(&c.CreatedAt)
	return c, translate(err)
}

func GetOAuthClient(ctx context.Context, pool *pgxpool.Pool, clientID string) (OAuthClient, error) {
	c := OAuthClient{ID: clientID}
	err := pool.QueryRow(ctx, `SELECT name, redirect_uris, token_endpoint_auth_method, secret_hash, created_at FROM oauth_clients WHERE id = $1`, clientID).
		Scan(&c.Name, &c.RedirectURIs, &c.AuthMethod, &c.SecretHash, &c.CreatedAt)
	return c, translate(err)
}

// OAuthRequest is an authorization request waiting for consent.
type OAuthRequest struct {
	ID          string
	ClientID    string
	RedirectURI string
	// State is empty when the client gave none.
	State         string
	CodeChallenge string
	Resource      string
	Scope         string
	ExpiresAt     time.Time
}

// CreateOAuthRequest keeps a request for lifetime, by the database's clock.
func CreateOAuthRequest(ctx context.Context, pool *pgxpool.Pool, r OAuthRequest, lifetime time.Duration) (OAuthRequest, error) {
	r.ID = id.New("oar")
	err := pool.QueryRow(ctx, `INSERT INTO oauth_requests (id, client_id, redirect_uri, state, code_challenge, resource, scope, expires_at)
		VALUES ($1, $2, $3, NULLIF($4, ''), $5, $6, $7, now() + make_interval(secs => $8)) RETURNING expires_at`,
		r.ID, r.ClientID, r.RedirectURI, r.State, r.CodeChallenge, r.Resource, r.Scope, lifetime.Seconds()).Scan(&r.ExpiresAt)
	return r, translate(err)
}

const oauthRequestColumns = `r.id, r.client_id, r.redirect_uri, coalesce(r.state, ''), r.code_challenge, r.resource, r.scope, r.expires_at`

func scanOAuthRequest(row pgx.Row, extra ...any) (OAuthRequest, error) {
	var r OAuthRequest
	err := row.Scan(append([]any{&r.ID, &r.ClientID, &r.RedirectURI, &r.State, &r.CodeChallenge, &r.Resource, &r.Scope, &r.ExpiresAt}, extra...)...)
	return r, translate(err)
}

// GetOAuthRequest returns a request that can still be answered, with its client.
func GetOAuthRequest(ctx context.Context, pool *pgxpool.Pool, requestID string) (OAuthRequest, OAuthClient, error) {
	var c OAuthClient
	r, err := scanOAuthRequest(pool.QueryRow(ctx, `SELECT `+oauthRequestColumns+`, c.id, c.name, c.redirect_uris
		FROM oauth_requests r JOIN oauth_clients c ON c.id = r.client_id WHERE r.id = $1 AND r.expires_at > now()`, requestID),
		&c.ID, &c.Name, &c.RedirectURIs)
	return r, c, err
}

// DenyOAuthRequest removes a request that can still be answered, and returns it.
func DenyOAuthRequest(ctx context.Context, pool *pgxpool.Pool, requestID string) (OAuthRequest, error) {
	return scanOAuthRequest(pool.QueryRow(ctx, `DELETE FROM oauth_requests r WHERE r.id = $1 AND r.expires_at > now() RETURNING `+oauthRequestColumns, requestID))
}

// MCPAuthorization is a person's permission for a client to read as them.
type MCPAuthorization struct {
	ID       string
	OrgID    string
	UserID   string
	ClientID string
	// ClientName and RedirectURIs are the client's, for people to recognize it.
	ClientName   string
	RedirectURIs []string
	Scope        string
	AuthorizedAt time.Time
	LastUsedAt   time.Time
}

const mcpAuthorizationColumns = `a.id, a.org_id, a.user_id, a.client_id, c.name, c.redirect_uris, a.scope, a.authorized_at, a.last_used_at`

func scanMCPAuthorization(row pgx.CollectableRow) (MCPAuthorization, error) {
	var a MCPAuthorization
	err := row.Scan(&a.ID, &a.OrgID, &a.UserID, &a.ClientID, &a.ClientName, &a.RedirectURIs, &a.Scope, &a.AuthorizedAt, &a.LastUsedAt)
	return a, err
}

// ApproveOAuthRequest answers a request as the person allowing it: it
// creates their authorization of the client, or renews it, and issues a
// code for it that lasts codeLifetime. The request is used up.
func ApproveOAuthRequest(ctx context.Context, pool *pgxpool.Pool, requestID, orgID, userID string, codeHash []byte, codeLifetime time.Duration) (OAuthRequest, MCPAuthorization, error) {
	var (
		r OAuthRequest
		a MCPAuthorization
	)
	err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		var err error
		if r, err = scanOAuthRequest(tx.QueryRow(ctx, `DELETE FROM oauth_requests r WHERE r.id = $1 AND r.expires_at > now() RETURNING `+oauthRequestColumns, requestID)); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `
			WITH a AS (
				INSERT INTO mcp_authorizations (id, org_id, user_id, client_id, scope) VALUES ($1, $2, $3, $4, $5)
				ON CONFLICT (user_id, client_id) DO UPDATE SET scope = EXCLUDED.scope, authorized_at = now(), last_used_at = now()
				RETURNING *
			), c AS (
				UPDATE oauth_clients SET authorized_at = now() WHERE id = $4 RETURNING *
			)
			SELECT `+mcpAuthorizationColumns+` FROM a, c`, id.New("oa"), orgID, userID, r.ClientID, r.Scope)
		if err != nil {
			return err
		}
		if a, err = pgx.CollectExactlyOneRow(rows, scanMCPAuthorization); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `INSERT INTO oauth_tokens (token_hash, kind, authorization_id, resource, redirect_uri, code_challenge, expires_at) VALUES ($1, 'code', $2, $3, $4, $5, now() + make_interval(secs => $6))`,
			codeHash, a.ID, r.Resource, r.RedirectURI, r.CodeChallenge, codeLifetime.Seconds())
		return err
	})
	return r, a, translate(err)
}

// OAuthGrant is what a code or refresh token was issued for.
type OAuthGrant struct {
	Authorization MCPAuthorization
	Resource      string
	// RedirectURI and CodeChallenge are a code's, which its exchange must match.
	RedirectURI   string
	CodeChallenge string
	// Age is how long ago the code or token was issued.
	Age time.Duration
}

// OAuthIssue is the pair of tokens an exchange issues, by their hashes.
type OAuthIssue struct {
	AccessHash, RefreshHash []byte
	AccessLifetime          time.Duration
}

// ExchangeOAuthToken uses up a code or a refresh token (kind) and issues a
// new pair of tokens in its place. check sees the grant first and refuses
// the exchange by returning an error, which leaves everything as it was; it
// decides, too, whether a refresh token has gone unused for too long.
//
// A refresh token presented again within grace of its exchange gets another
// pair: clients refresh from requests made at once, and retry when an answer
// is lost. Presented later, or a code presented again at all, it may have
// been stolen: the whole authorization is revoked, and ErrTokenReused comes
// back with the grant so that the revocation can be recorded.
func ExchangeOAuthToken(ctx context.Context, pool *pgxpool.Pool, kind string, hash []byte, grace time.Duration, check func(OAuthGrant) error, issue OAuthIssue) (OAuthGrant, error) {
	var (
		g      OAuthGrant
		reused bool
	)
	err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		var (
			expired       bool
			usedAgo       *float64
			ageSeconds    float64
			redirectURI   *string
			codeChallenge *string
			a             = &g.Authorization
		)
		err := tx.QueryRow(ctx, `
			SELECT t.resource, t.redirect_uri, t.code_challenge, coalesce(t.expires_at <= now(), false),
				extract(epoch FROM now() - t.used_at)::float8, extract(epoch FROM now() - t.created_at)::float8, `+mcpAuthorizationColumns+`
			FROM oauth_tokens t
			JOIN mcp_authorizations a ON a.id = t.authorization_id
			JOIN oauth_clients c ON c.id = a.client_id
			JOIN users u ON u.org_id = a.org_id AND u.id = a.user_id AND u.status = 'active'
			WHERE t.token_hash = $1 AND t.kind = $2
			FOR UPDATE OF t`, hash, kind).
			Scan(&g.Resource, &redirectURI, &codeChallenge, &expired, &usedAgo, &ageSeconds,
				&a.ID, &a.OrgID, &a.UserID, &a.ClientID, &a.ClientName, &a.RedirectURIs, &a.Scope, &a.AuthorizedAt, &a.LastUsedAt)
		if err != nil {
			return err
		}
		if redirectURI != nil {
			g.RedirectURI = *redirectURI
		}
		if codeChallenge != nil {
			g.CodeChallenge = *codeChallenge
		}
		g.Age = time.Duration(ageSeconds * float64(time.Second))
		if expired {
			return ErrNotFound
		}
		again := usedAgo != nil
		if again && (kind != TokenRefresh || *usedAgo >= grace.Seconds()) {
			reused = true
			_, err := tx.Exec(ctx, `DELETE FROM mcp_authorizations WHERE id = $1`, a.ID)
			return err
		}
		if err := check(g); err != nil {
			return err
		}
		if !again {
			if _, err := tx.Exec(ctx, `UPDATE oauth_tokens SET used_at = now() WHERE token_hash = $1`, hash); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, `INSERT INTO oauth_tokens (token_hash, kind, authorization_id, resource, expires_at) VALUES
			($1, 'access', $3, $4, now() + make_interval(secs => $5)), ($2, 'refresh', $3, $4, NULL)`,
			issue.AccessHash, issue.RefreshHash, a.ID, g.Resource, issue.AccessLifetime.Seconds()); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE mcp_authorizations SET last_used_at = now() WHERE id = $1`, a.ID)
		return err
	})
	if err == nil && reused {
		err = ErrTokenReused
	}
	return g, translate(err)
}

// MCPAccess is who an access token acts for, the address it is for, and
// when it expires.
type MCPAccess struct {
	Authorization MCPAuthorization
	Resource      string
	ExpiresAt     time.Time
	Principal     Principal
}

// GetMCPAccess finds the authorization of an access token that is still
// valid, of a person whose account is active. Its use is recorded, at most
// once every few minutes.
func GetMCPAccess(ctx context.Context, pool *pgxpool.Pool, hash []byte) (MCPAccess, error) {
	var (
		m MCPAccess
		a = &m.Authorization
		p = &m.Principal
	)
	err := pool.QueryRow(ctx, `
		SELECT t.resource, t.expires_at, `+mcpAuthorizationColumns+`, u.email, u.display_name, u.is_org_admin
		FROM oauth_tokens t
		JOIN mcp_authorizations a ON a.id = t.authorization_id
		JOIN oauth_clients c ON c.id = a.client_id
		JOIN users u ON u.org_id = a.org_id AND u.id = a.user_id
		WHERE t.token_hash = $1 AND t.kind = 'access' AND t.expires_at > now() AND u.status = 'active'`, hash).
		Scan(&m.Resource, &m.ExpiresAt, &a.ID, &a.OrgID, &a.UserID, &a.ClientID, &a.ClientName, &a.RedirectURIs, &a.Scope, &a.AuthorizedAt, &a.LastUsedAt,
			&p.Email, &p.DisplayName, &p.IsOrgAdmin)
	if err != nil {
		return m, translate(err)
	}
	p.UserID, p.OrgID = a.UserID, a.OrgID
	if time.Since(a.LastUsedAt) > 5*time.Minute {
		_, err = pool.Exec(ctx, `UPDATE mcp_authorizations SET last_used_at = now() WHERE id = $1`, a.ID)
	}
	return m, err
}

// ListMCPAuthorizations returns a person's authorizations, the latest first.
func ListMCPAuthorizations(ctx context.Context, pool *pgxpool.Pool, orgID, userID string) ([]MCPAuthorization, error) {
	rows, err := pool.Query(ctx, `SELECT `+mcpAuthorizationColumns+` FROM mcp_authorizations a JOIN oauth_clients c ON c.id = a.client_id
		WHERE a.org_id = $1 AND a.user_id = $2 ORDER BY a.authorized_at DESC, a.id`, orgID, userID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, scanMCPAuthorization)
}

// RevokeMCPAuthorization removes one of a person's authorizations, and its
// tokens with it.
func RevokeMCPAuthorization(ctx context.Context, pool *pgxpool.Pool, orgID, userID, authorizationID string) (MCPAuthorization, error) {
	rows, err := pool.Query(ctx, `
		WITH a AS (DELETE FROM mcp_authorizations WHERE org_id = $1 AND user_id = $2 AND id = $3 RETURNING *)
		SELECT `+mcpAuthorizationColumns+` FROM a JOIN oauth_clients c ON c.id = a.client_id`, orgID, userID, authorizationID)
	if err != nil {
		return MCPAuthorization{}, err
	}
	a, err := pgx.CollectExactlyOneRow(rows, scanMCPAuthorization)
	return a, translate(err)
}

// revokeAllMCPAuthorizations removes all of a person's authorizations, as
// when their sessions all end.
func revokeAllMCPAuthorizations(ctx context.Context, tx pgx.Tx, userID string) ([]MCPAuthorization, error) {
	rows, err := tx.Query(ctx, `
		WITH a AS (DELETE FROM mcp_authorizations WHERE user_id = $1 RETURNING *)
		SELECT `+mcpAuthorizationColumns+` FROM a JOIN oauth_clients c ON c.id = a.client_id`, userID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, scanMCPAuthorization)
}

// PruneOAuth deletes what can no longer be used: requests and codes and
// tokens past their time, refresh tokens of an org unused for idle, and
// clients nobody allowed within a day of registering. It returns how many
// tokens it deleted.
func PruneOAuth(ctx context.Context, pool *pgxpool.Pool, orgID string, idle time.Duration) (int64, error) {
	if _, err := pool.Exec(ctx, `DELETE FROM oauth_requests WHERE expires_at < now()`); err != nil {
		return 0, err
	}
	tag, err := pool.Exec(ctx, `
		DELETE FROM oauth_tokens t USING mcp_authorizations a
		WHERE t.authorization_id = a.id AND a.org_id = $1
		AND (t.expires_at < now() OR (t.kind = 'refresh' AND t.created_at < now() - make_interval(secs => $2)))`, orgID, idle.Seconds())
	if err != nil {
		return 0, err
	}
	_, err = pool.Exec(ctx, `DELETE FROM oauth_clients WHERE authorized_at IS NULL AND created_at < now() - interval '1 day'`)
	return tag.RowsAffected(), err
}

// DashboardWorkspace returns the workspace a dashboard is in, unless the
// workspace is deleted.
func DashboardWorkspace(ctx context.Context, pool *pgxpool.Pool, orgID, dashboardID string) (string, error) {
	var workspaceID string
	err := pool.QueryRow(ctx, `SELECT d.workspace_id FROM dashboards d JOIN workspaces w ON w.org_id = d.org_id AND w.id = d.workspace_id AND w.deleted_at IS NULL
		WHERE d.org_id = $1 AND d.id = $2`, orgID, dashboardID).Scan(&workspaceID)
	return workspaceID, translate(err)
}
