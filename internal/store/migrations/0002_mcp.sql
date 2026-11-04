-- MCP clients, and the authorizations people give them through SupaBI as its
-- own OAuth authorization server: .agents/design/ai-assistant.md 14.

ALTER TABLE system_settings ADD COLUMN mcp_enabled boolean;

COMMENT ON COLUMN system_settings.mcp_enabled IS 'Whether people may connect MCP clients to read their dashboards; NULL follows the default, which is off.';

-- A client registers before anyone signs in, so it belongs to no organisation.
CREATE TABLE oauth_clients (
    id                         text NOT NULL,
    name                       text NOT NULL,
    redirect_uris              text[] NOT NULL,
    token_endpoint_auth_method text NOT NULL,
    secret_hash                bytea,
    created_at                 timestamptz DEFAULT now() NOT NULL,
    authorized_at              timestamptz,
    PRIMARY KEY (id),
    CONSTRAINT oauth_clients_token_endpoint_auth_method_check CHECK (token_endpoint_auth_method IN ('none', 'client_secret_basic', 'client_secret_post')),
    CONSTRAINT oauth_clients_secret_check CHECK ((token_endpoint_auth_method = 'none') = (secret_hash IS NULL))
);

CREATE INDEX oauth_clients_created_at_idx ON oauth_clients (created_at);

COMMENT ON TABLE oauth_clients IS 'MCP clients registered through dynamic client registration (RFC 7591). Registration is open, so one nobody authorizes within a day is deleted.';
COMMENT ON COLUMN oauth_clients.id IS 'Client ID handed to the client.';
COMMENT ON COLUMN oauth_clients.name IS 'Name the client gave itself, shown on the consent page. Nobody vouches for it.';
COMMENT ON COLUMN oauth_clients.redirect_uris IS 'Addresses an authorization may be sent back to: HTTPS, or HTTP on a loopback address.';
COMMENT ON COLUMN oauth_clients.token_endpoint_auth_method IS 'How the client proves itself at the token endpoint: none for a public client, or with its secret.';
COMMENT ON COLUMN oauth_clients.secret_hash IS 'SHA-256 of the client secret; NULL for a public client. The secret itself is not stored.';
COMMENT ON COLUMN oauth_clients.created_at IS 'When the client registered.';
COMMENT ON COLUMN oauth_clients.authorized_at IS 'When someone last allowed the client; NULL until someone does. A client nobody allowed within a day of registering is deleted.';

-- A request waits for consent before anyone is known to have signed in.
CREATE TABLE oauth_requests (
    id             text NOT NULL,
    client_id      text NOT NULL,
    redirect_uri   text NOT NULL,
    state          text,
    code_challenge text NOT NULL,
    resource       text NOT NULL,
    scope          text NOT NULL,
    expires_at     timestamptz NOT NULL,
    PRIMARY KEY (id),
    FOREIGN KEY (client_id) REFERENCES oauth_clients (id) ON DELETE CASCADE
);

CREATE INDEX oauth_requests_expires_at_idx ON oauth_requests (expires_at);
CREATE INDEX oauth_requests_client_id_idx ON oauth_requests (client_id);

COMMENT ON TABLE oauth_requests IS 'Authorization requests of MCP clients waiting for someone to allow or deny them on the consent page.';
COMMENT ON COLUMN oauth_requests.id IS 'Request ID, in the address of the consent page.';
COMMENT ON COLUMN oauth_requests.client_id IS 'Client asking.';
COMMENT ON COLUMN oauth_requests.redirect_uri IS 'Address the answer goes back to, one of the client''s.';
COMMENT ON COLUMN oauth_requests.state IS 'Value the client asked to have back with the answer; NULL when it gave none.';
COMMENT ON COLUMN oauth_requests.code_challenge IS 'PKCE challenge (S256) the code verifier must match.';
COMMENT ON COLUMN oauth_requests.resource IS 'MCP address the tokens are for.';
COMMENT ON COLUMN oauth_requests.scope IS 'Scopes asked for, separated by spaces.';
COMMENT ON COLUMN oauth_requests.expires_at IS 'When the request can no longer be answered.';

CREATE TABLE mcp_authorizations (
    id            text NOT NULL,
    org_id        text NOT NULL,
    user_id       text NOT NULL,
    client_id     text NOT NULL,
    scope         text NOT NULL,
    authorized_at timestamptz DEFAULT now() NOT NULL,
    last_used_at  timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (id),
    UNIQUE (org_id, id),
    UNIQUE (user_id, client_id),
    FOREIGN KEY (org_id, user_id) REFERENCES users (org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (client_id) REFERENCES oauth_clients (id) ON DELETE CASCADE
);

CREATE INDEX mcp_authorizations_client_id_idx ON mcp_authorizations (client_id);

COMMENT ON TABLE mcp_authorizations IS 'A person''s permission for an MCP client to read, as them, the dashboards they can open. It belongs to the person, not to a workspace.';
COMMENT ON COLUMN mcp_authorizations.id IS 'Authorization ID.';
COMMENT ON COLUMN mcp_authorizations.org_id IS 'Organisation of the person.';
COMMENT ON COLUMN mcp_authorizations.user_id IS 'Person who allowed the client.';
COMMENT ON COLUMN mcp_authorizations.client_id IS 'Client allowed.';
COMMENT ON COLUMN mcp_authorizations.scope IS 'Scopes granted, separated by spaces.';
COMMENT ON COLUMN mcp_authorizations.authorized_at IS 'When the person last allowed the client.';
COMMENT ON COLUMN mcp_authorizations.last_used_at IS 'When the client last used a token of this authorization, to within a few minutes.';

CREATE TABLE oauth_tokens (
    token_hash       bytea NOT NULL,
    kind             text NOT NULL,
    authorization_id text NOT NULL,
    resource         text NOT NULL,
    redirect_uri     text,
    code_challenge   text,
    expires_at       timestamptz,
    used_at          timestamptz,
    created_at       timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (token_hash),
    FOREIGN KEY (authorization_id) REFERENCES mcp_authorizations (id) ON DELETE CASCADE,
    CONSTRAINT oauth_tokens_kind_check CHECK (kind IN ('code', 'access', 'refresh')),
    CONSTRAINT oauth_tokens_expires_at_check CHECK ((kind = 'refresh') = (expires_at IS NULL)),
    CONSTRAINT oauth_tokens_code_check CHECK ((kind = 'code') = (redirect_uri IS NOT NULL AND code_challenge IS NOT NULL))
);

CREATE INDEX oauth_tokens_authorization_id_idx ON oauth_tokens (authorization_id);

COMMENT ON TABLE oauth_tokens IS 'Authorization codes, access tokens and refresh tokens of MCP authorizations. Only hashes are kept.';
COMMENT ON COLUMN oauth_tokens.token_hash IS 'SHA-256 of the code or token. The value itself is not stored, so this table cannot be used to act as anyone.';
COMMENT ON COLUMN oauth_tokens.kind IS 'code: exchanged once for tokens; access: sent with each MCP request; refresh: exchanged once for a new pair.';
COMMENT ON COLUMN oauth_tokens.authorization_id IS 'Authorization the code or token belongs to.';
COMMENT ON COLUMN oauth_tokens.resource IS 'MCP address the token is for; it is refused anywhere else.';
COMMENT ON COLUMN oauth_tokens.redirect_uri IS 'For a code, the address it was sent to, which the exchange must name again.';
COMMENT ON COLUMN oauth_tokens.code_challenge IS 'For a code, the PKCE challenge (S256) the exchange must answer.';
COMMENT ON COLUMN oauth_tokens.expires_at IS 'When a code or access token stops working. NULL for a refresh token, which lasts until it has gone unused for the session lifetime of the system settings.';
COMMENT ON COLUMN oauth_tokens.used_at IS 'When a code or refresh token was exchanged. One used again may have been stolen.';
COMMENT ON COLUMN oauth_tokens.created_at IS 'When the code or token was issued.';
