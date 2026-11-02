-- The schema of the metadata database. The design behind it is in
-- .agents/design/access-control.md, .agents/design/dataset.md,
-- .agents/design/chart-dashboard.md, .agents/design/exports.md,
-- .agents/design/configuration.md and .agents/design/ai-assistant.md.
--
-- Parent tables carry org_id and expose UNIQUE (org_id, id) so that children
-- can use composite foreign keys: a row can then never reference a row of
-- another org, whatever the application code does.
--
-- Every table and column is described with COMMENT, so the schema can be read
-- from psql or any database tool without the source at hand. New tables and
-- columns get their COMMENT in the migration that adds them; a test fails when
-- one is missing.

COMMENT ON TABLE schema_migrations IS 'Migration files already applied to this database, one row per file.';
COMMENT ON COLUMN schema_migrations.source IS 'Set of migrations the file belongs to: core, or one added by the enterprise edition. Each set is versioned on its own.';
COMMENT ON COLUMN schema_migrations.version IS 'Number at the start of the file name.';
COMMENT ON COLUMN schema_migrations.name IS 'Rest of the file name, without the extension.';
COMMENT ON COLUMN schema_migrations.checksum IS 'SHA-256 of the file as applied, in hex. Startup fails if the file has changed since.';
COMMENT ON COLUMN schema_migrations.applied_at IS 'When the file was applied.';

CREATE TABLE orgs (
    id             text NOT NULL,
    name           text NOT NULL,
    default_locale text DEFAULT 'zh-CN' NOT NULL,
    created_at     timestamptz DEFAULT now() NOT NULL,
    updated_at     timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (id)
);

COMMENT ON TABLE orgs IS 'Organisations: the tenants. Every other row belongs to exactly one.';
COMMENT ON COLUMN orgs.id IS 'Organisation id.';
COMMENT ON COLUMN orgs.name IS 'Display name.';
COMMENT ON COLUMN orgs.default_locale IS 'Interface language for users who have not chosen one, e.g. zh-CN.';
COMMENT ON COLUMN orgs.created_at IS 'When the row was created.';
COMMENT ON COLUMN orgs.updated_at IS 'When the row was last changed.';

CREATE TABLE users (
    id            text NOT NULL,
    org_id        text NOT NULL,
    email         text NOT NULL,
    display_name  text NOT NULL,
    password_hash text,
    attributes    jsonb DEFAULT '{}'::jsonb NOT NULL,
    locale        text,
    timezone      text,
    is_org_admin  boolean DEFAULT false NOT NULL,
    status        text DEFAULT 'active' NOT NULL,
    created_at    timestamptz DEFAULT now() NOT NULL,
    updated_at    timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (id),
    UNIQUE (org_id, id),
    FOREIGN KEY (org_id) REFERENCES orgs (id),
    CONSTRAINT users_status_check CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text])))
);

CREATE UNIQUE INDEX users_org_id_email_key ON users (org_id, lower(email));

COMMENT ON TABLE users IS 'User accounts of an organisation.';
COMMENT ON COLUMN users.id IS 'User id.';
COMMENT ON COLUMN users.org_id IS 'Organisation the account belongs to.';
COMMENT ON COLUMN users.email IS 'Sign-in name. Unique within the organisation, ignoring case.';
COMMENT ON COLUMN users.display_name IS 'Name shown in the interface.';
COMMENT ON COLUMN users.password_hash IS 'Hash of the password. NULL for accounts that only sign in through SSO.';
COMMENT ON COLUMN users.attributes IS 'Free-form attributes of the user as a JSON object; row-level policies read them.';
COMMENT ON COLUMN users.locale IS 'Interface language. NULL: use the organisation default.';
COMMENT ON COLUMN users.timezone IS 'IANA time zone. NULL: use the browser''s.';
COMMENT ON COLUMN users.is_org_admin IS 'Organisation administrators manage accounts, roles, groups and workspaces.';
COMMENT ON COLUMN users.status IS 'active or disabled. A disabled account cannot sign in.';
COMMENT ON COLUMN users.created_at IS 'When the row was created.';
COMMENT ON COLUMN users.updated_at IS 'When the row was last changed.';

CREATE TABLE user_groups (
    id         text NOT NULL,
    org_id     text NOT NULL,
    name       text NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (id),
    UNIQUE (org_id, id),
    UNIQUE (org_id, name),
    FOREIGN KEY (org_id) REFERENCES orgs (id)
);

COMMENT ON TABLE user_groups IS 'Named groups of users. A group can be made a workspace member as a whole.';
COMMENT ON COLUMN user_groups.id IS 'Group id.';
COMMENT ON COLUMN user_groups.org_id IS 'Organisation the group belongs to.';
COMMENT ON COLUMN user_groups.name IS 'Display name. Unique within the organisation.';
COMMENT ON COLUMN user_groups.created_at IS 'When the row was created.';
COMMENT ON COLUMN user_groups.updated_at IS 'When the row was last changed.';

CREATE TABLE user_group_members (
    org_id     text NOT NULL,
    group_id   text NOT NULL,
    user_id    text NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (group_id, user_id),
    FOREIGN KEY (org_id, group_id) REFERENCES user_groups (org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, user_id) REFERENCES users (org_id, id) ON DELETE CASCADE
);

CREATE INDEX user_group_members_user_id_idx ON user_group_members (user_id);

COMMENT ON TABLE user_group_members IS 'Which users are in which groups.';
COMMENT ON COLUMN user_group_members.org_id IS 'Organisation of both the group and the user.';
COMMENT ON COLUMN user_group_members.group_id IS 'The group.';
COMMENT ON COLUMN user_group_members.user_id IS 'The user in it.';
COMMENT ON COLUMN user_group_members.created_at IS 'When the user was added to the group.';

CREATE TABLE workspaces (
    id              text NOT NULL,
    org_id          text NOT NULL,
    name            text NOT NULL,
    timezone        text DEFAULT 'UTC' NOT NULL,
    week_start      smallint DEFAULT 1 NOT NULL,
    created_by      text,
    created_at      timestamptz DEFAULT now() NOT NULL,
    updated_at      timestamptz DEFAULT now() NOT NULL,
    first_week_days smallint DEFAULT 4 NOT NULL,
    deleted_at      timestamptz,
    PRIMARY KEY (id),
    UNIQUE (org_id, id),
    UNIQUE (org_id, name),
    FOREIGN KEY (org_id, created_by) REFERENCES users (org_id, id),
    FOREIGN KEY (org_id) REFERENCES orgs (id),
    CONSTRAINT workspaces_first_week_days_check CHECK ((first_week_days = ANY (ARRAY[1, 4, 7]))),
    CONSTRAINT workspaces_week_start_check CHECK ((week_start = ANY (ARRAY[1, 7])))
);

COMMENT ON TABLE workspaces IS 'Workspaces of an organisation. Data sources, datasets, charts and dashboards each live in one.';
COMMENT ON COLUMN workspaces.id IS 'Workspace id.';
COMMENT ON COLUMN workspaces.org_id IS 'Organisation the workspace belongs to.';
COMMENT ON COLUMN workspaces.name IS 'Display name. Unique within the organisation.';
COMMENT ON COLUMN workspaces.timezone IS 'IANA time zone that queries group and filter dates in.';
COMMENT ON COLUMN workspaces.week_start IS 'First day of the week as an ISO day number: 1 Monday, 7 Sunday.';
COMMENT ON COLUMN workspaces.created_by IS 'User who created the workspace.';
COMMENT ON COLUMN workspaces.created_at IS 'When the row was created.';
COMMENT ON COLUMN workspaces.updated_at IS 'When the row was last changed.';
COMMENT ON COLUMN workspaces.first_week_days IS 'How many days of the first week of a year are in that year: 4 is ISO 8601 when weeks start on Monday, 1 the week of January 1, 7 the first whole week.';
COMMENT ON COLUMN workspaces.deleted_at IS 'When a system administrator deleted the workspace; NULL while it is in use. A deleted workspace is hidden from everyone, can be restored, and is purged with its contents 30 days after this.';

CREATE TABLE workspace_members (
    id           text NOT NULL,
    org_id       text NOT NULL,
    workspace_id text NOT NULL,
    user_id      text,
    group_id     text,
    created_at   timestamptz DEFAULT now() NOT NULL,
    role         text NOT NULL,
    PRIMARY KEY (id),
    UNIQUE (workspace_id, group_id),
    UNIQUE (workspace_id, user_id),
    FOREIGN KEY (org_id, group_id) REFERENCES user_groups (org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, user_id) REFERENCES users (org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, workspace_id) REFERENCES workspaces (org_id, id) ON DELETE CASCADE,
    CONSTRAINT workspace_members_check CHECK ((num_nonnulls(user_id, group_id) = 1)),
    CONSTRAINT workspace_members_role_check CHECK ((role = ANY (ARRAY['viewer'::text, 'developer'::text, 'admin'::text])))
);

CREATE INDEX workspace_members_group_id_idx ON workspace_members (group_id);
CREATE INDEX workspace_members_user_id_idx ON workspace_members (user_id);

COMMENT ON TABLE workspace_members IS 'Who may work in a workspace and with which role. A member is either a user or a group.';
COMMENT ON COLUMN workspace_members.id IS 'Membership id.';
COMMENT ON COLUMN workspace_members.org_id IS 'Organisation of the workspace.';
COMMENT ON COLUMN workspace_members.workspace_id IS 'The workspace.';
COMMENT ON COLUMN workspace_members.user_id IS 'The user, when the member is a user. Exactly one of user_id and group_id is set.';
COMMENT ON COLUMN workspace_members.group_id IS 'The group, when the member is a group. Exactly one of user_id and group_id is set.';
COMMENT ON COLUMN workspace_members.created_at IS 'When the member was added.';
COMMENT ON COLUMN workspace_members.role IS 'Role in the workspace, from least to most able: viewer, developer or admin.';

CREATE TABLE datasources (
    id                     text NOT NULL,
    org_id                 text NOT NULL,
    workspace_id           text NOT NULL,
    name                   text NOT NULL,
    type                   text NOT NULL,
    config                 jsonb DEFAULT '{}'::jsonb NOT NULL,
    secret                 bytea,
    data_timezone          text DEFAULT 'UTC' NOT NULL,
    created_by             text,
    updated_by             text,
    created_at             timestamptz DEFAULT now() NOT NULL,
    updated_at             timestamptz DEFAULT now() NOT NULL,
    cache_ttl_seconds      integer,
    max_concurrent_queries integer,
    PRIMARY KEY (id),
    UNIQUE (workspace_id, id),
    UNIQUE (workspace_id, name),
    FOREIGN KEY (org_id, created_by) REFERENCES users (org_id, id),
    FOREIGN KEY (org_id, updated_by) REFERENCES users (org_id, id),
    FOREIGN KEY (org_id, workspace_id) REFERENCES workspaces (org_id, id),
    CONSTRAINT datasources_cache_ttl_seconds_check CHECK (((cache_ttl_seconds = 0) OR ((cache_ttl_seconds >= 60) AND (cache_ttl_seconds <= 86400)))),
    CONSTRAINT datasources_max_concurrent_queries_check CHECK (((max_concurrent_queries >= 1) AND (max_concurrent_queries <= 64)))
);

COMMENT ON TABLE datasources IS 'Connections to the databases that queries run against.';
COMMENT ON COLUMN datasources.id IS 'Data source id.';
COMMENT ON COLUMN datasources.org_id IS 'Organisation of the workspace.';
COMMENT ON COLUMN datasources.workspace_id IS 'Workspace the data source belongs to.';
COMMENT ON COLUMN datasources.name IS 'Display name. Unique within the workspace.';
COMMENT ON COLUMN datasources.type IS 'Name of the driver, e.g. postgres, mysql, clickhouse.';
COMMENT ON COLUMN datasources.config IS 'Connection settings that are not secret (host, port, database and so on) as a JSON object. Its fields depend on the driver.';
COMMENT ON COLUMN datasources.secret IS 'Credentials, encrypted with the server''s secret key. NULL when the driver needs none.';
COMMENT ON COLUMN datasources.data_timezone IS 'IANA time zone of timestamps the database stores without one.';
COMMENT ON COLUMN datasources.created_by IS 'User who created the data source.';
COMMENT ON COLUMN datasources.updated_by IS 'User who last changed it.';
COMMENT ON COLUMN datasources.created_at IS 'When the row was created.';
COMMENT ON COLUMN datasources.updated_at IS 'When the row was last changed.';
COMMENT ON COLUMN datasources.cache_ttl_seconds IS 'How long query results from this data source are kept, in seconds; 0 keeps none, NULL follows the server default.';
COMMENT ON COLUMN datasources.max_concurrent_queries IS 'How many statements each instance runs on this data source at once; NULL uses the default.';

CREATE TABLE sessions (
    token_hash   bytea NOT NULL,
    org_id       text NOT NULL,
    user_id      text NOT NULL,
    workspace_id text,
    created_at   timestamptz DEFAULT now() NOT NULL,
    last_seen_at timestamptz DEFAULT now() NOT NULL,
    expires_at   timestamptz NOT NULL,
    PRIMARY KEY (token_hash),
    FOREIGN KEY (org_id, user_id) REFERENCES users (org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, workspace_id) REFERENCES workspaces (org_id, id) ON DELETE SET NULL (workspace_id)
);

CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);

COMMENT ON TABLE sessions IS 'Browser sessions of signed-in users.';
COMMENT ON COLUMN sessions.token_hash IS 'Hash of the token in the session cookie. The token itself is not stored, so this table cannot be used to impersonate anyone.';
COMMENT ON COLUMN sessions.org_id IS 'Organisation of the user.';
COMMENT ON COLUMN sessions.user_id IS 'The signed-in user.';
COMMENT ON COLUMN sessions.workspace_id IS 'Workspace the session is working in. NULL when none is chosen or it was deleted.';
COMMENT ON COLUMN sessions.created_at IS 'When the user signed in.';
COMMENT ON COLUMN sessions.last_seen_at IS 'When the session was last used.';
COMMENT ON COLUMN sessions.expires_at IS 'When the session stops being valid. Pushed back as the session is used.';

CREATE TABLE folders (
    id           text NOT NULL,
    org_id       text NOT NULL,
    workspace_id text NOT NULL,
    kind         text NOT NULL,
    parent_id    text,
    name         text NOT NULL,
    created_by   text,
    created_at   timestamptz DEFAULT now() NOT NULL,
    updated_at   timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (id),
    UNIQUE (workspace_id, id),
    FOREIGN KEY (org_id, created_by) REFERENCES users (org_id, id),
    FOREIGN KEY (org_id, workspace_id) REFERENCES workspaces (org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, parent_id) REFERENCES folders (workspace_id, id),
    CONSTRAINT folders_kind_check CHECK ((kind = ANY (ARRAY['dashboard'::text, 'chart'::text, 'dataset'::text])))
);

CREATE UNIQUE INDEX folders_name_key ON folders (workspace_id, kind, COALESCE(parent_id, ''::text), name);
CREATE INDEX folders_parent_id_idx ON folders (parent_id);

COMMENT ON TABLE folders IS 'Folders of the workbench. Each holds dashboards, charts or datasets, never a mix.';
COMMENT ON COLUMN folders.id IS 'Folder id.';
COMMENT ON COLUMN folders.org_id IS 'Organisation the folder belongs to.';
COMMENT ON COLUMN folders.workspace_id IS 'Workspace the folder belongs to.';
COMMENT ON COLUMN folders.kind IS 'What the folder holds: dashboard, chart or dataset.';
COMMENT ON COLUMN folders.parent_id IS 'Folder this one is inside. NULL at the top of the tree.';
COMMENT ON COLUMN folders.name IS 'Display name, unique among the folders next to it.';
COMMENT ON COLUMN folders.created_by IS 'User who created the folder. NULL when the system did.';
COMMENT ON COLUMN folders.created_at IS 'When the row was created.';
COMMENT ON COLUMN folders.updated_at IS 'When the row was last changed.';

CREATE TABLE datasets (
    id                text NOT NULL,
    org_id            text NOT NULL,
    workspace_id      text NOT NULL,
    datasource_id     text NOT NULL,
    name              text NOT NULL,
    description       text DEFAULT '' NOT NULL,
    spec              jsonb NOT NULL,
    spec_version      integer NOT NULL,
    revision          integer DEFAULT 1 NOT NULL,
    validation_status text DEFAULT 'unvalidated' NOT NULL,
    created_by        text,
    updated_by        text,
    created_at        timestamptz DEFAULT now() NOT NULL,
    updated_at        timestamptz DEFAULT now() NOT NULL,
    folder_id         text,
    PRIMARY KEY (id),
    UNIQUE (workspace_id, id),
    UNIQUE (workspace_id, name),
    FOREIGN KEY (org_id, created_by) REFERENCES users (org_id, id),
    FOREIGN KEY (org_id, updated_by) REFERENCES users (org_id, id),
    FOREIGN KEY (org_id, workspace_id) REFERENCES workspaces (org_id, id),
    FOREIGN KEY (workspace_id, datasource_id) REFERENCES datasources (workspace_id, id),
    FOREIGN KEY (workspace_id, folder_id) REFERENCES folders (workspace_id, id),
    CONSTRAINT datasets_validation_status_check CHECK ((validation_status = ANY (ARRAY['unvalidated'::text, 'valid'::text, 'invalid'::text])))
);

CREATE INDEX datasets_datasource_id_idx ON datasets (datasource_id);
CREATE INDEX datasets_folder_id_idx ON datasets (folder_id);

COMMENT ON TABLE datasets IS 'Datasets: a table or a join of tables in one data source, with the dimensions and measures charts can use.';
COMMENT ON COLUMN datasets.id IS 'Dataset id.';
COMMENT ON COLUMN datasets.org_id IS 'Organisation of the workspace.';
COMMENT ON COLUMN datasets.workspace_id IS 'Workspace the dataset belongs to.';
COMMENT ON COLUMN datasets.datasource_id IS 'Data source the dataset reads. Always in the same workspace.';
COMMENT ON COLUMN datasets.name IS 'Display name. Unique within the workspace.';
COMMENT ON COLUMN datasets.description IS 'What the dataset holds, shown next to its name.';
COMMENT ON COLUMN datasets.spec IS 'Current definition as JSON: tables, joins, dimensions, measures.';
COMMENT ON COLUMN datasets.spec_version IS 'Version of the format spec is written in.';
COMMENT ON COLUMN datasets.revision IS 'Number of the current definition. Starts at 1 and goes up by one on every save.';
COMMENT ON COLUMN datasets.validation_status IS 'Result of checking spec against the data source: unvalidated, valid or invalid.';
COMMENT ON COLUMN datasets.created_by IS 'User who created the dataset.';
COMMENT ON COLUMN datasets.updated_by IS 'User who last changed it.';
COMMENT ON COLUMN datasets.created_at IS 'When the row was created.';
COMMENT ON COLUMN datasets.updated_at IS 'When the row was last changed.';
COMMENT ON COLUMN datasets.folder_id IS 'Folder the dataset is in. NULL at the top of the tree.';

CREATE TABLE dataset_revisions (
    dataset_id      text NOT NULL,
    revision        integer NOT NULL,
    org_id          text NOT NULL,
    spec            jsonb NOT NULL,
    spec_version    integer NOT NULL,
    created_by      text,
    created_at      timestamptz DEFAULT now() NOT NULL,
    name            text NOT NULL,
    description     text NOT NULL,
    datasource_id   text NOT NULL,
    datasource_name text NOT NULL,
    PRIMARY KEY (dataset_id, revision),
    FOREIGN KEY (dataset_id) REFERENCES datasets (id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, created_by) REFERENCES users (org_id, id)
);

COMMENT ON TABLE dataset_revisions IS 'Every definition a dataset has been saved with, for history and rollback. Rows are never changed.';
COMMENT ON COLUMN dataset_revisions.dataset_id IS 'The dataset.';
COMMENT ON COLUMN dataset_revisions.revision IS 'Number of this definition, matching datasets.revision at the time it was saved.';
COMMENT ON COLUMN dataset_revisions.org_id IS 'Organisation of the dataset.';
COMMENT ON COLUMN dataset_revisions.spec IS 'The definition as saved.';
COMMENT ON COLUMN dataset_revisions.spec_version IS 'Version of the format spec is written in.';
COMMENT ON COLUMN dataset_revisions.created_by IS 'User who saved this definition.';
COMMENT ON COLUMN dataset_revisions.created_at IS 'When it was saved.';
COMMENT ON COLUMN dataset_revisions.name IS 'Dataset name when this revision was saved.';
COMMENT ON COLUMN dataset_revisions.description IS 'Dataset description when this revision was saved.';
COMMENT ON COLUMN dataset_revisions.datasource_id IS 'Data source used by this revision. Retained even if that source is later deleted.';
COMMENT ON COLUMN dataset_revisions.datasource_name IS 'Data source display name when this revision was saved.';

CREATE TABLE charts (
    id           text NOT NULL,
    org_id       text NOT NULL,
    workspace_id text NOT NULL,
    dataset_id   text NOT NULL,
    name         text NOT NULL,
    description  text DEFAULT '' NOT NULL,
    spec         jsonb NOT NULL,
    spec_version integer NOT NULL,
    created_by   text,
    updated_by   text,
    created_at   timestamptz DEFAULT now() NOT NULL,
    updated_at   timestamptz DEFAULT now() NOT NULL,
    folder_id    text,
    revision     integer DEFAULT 1 NOT NULL,
    PRIMARY KEY (id),
    UNIQUE (workspace_id, id),
    UNIQUE (workspace_id, name),
    FOREIGN KEY (org_id, created_by) REFERENCES users (org_id, id),
    FOREIGN KEY (org_id, updated_by) REFERENCES users (org_id, id),
    FOREIGN KEY (org_id, workspace_id) REFERENCES workspaces (org_id, id),
    FOREIGN KEY (workspace_id, dataset_id) REFERENCES datasets (workspace_id, id),
    FOREIGN KEY (workspace_id, folder_id) REFERENCES folders (workspace_id, id),
    CONSTRAINT charts_revision_check CHECK ((revision > 0))
);

CREATE INDEX charts_dataset_id_idx ON charts (dataset_id);
CREATE INDEX charts_folder_id_idx ON charts (folder_id);

COMMENT ON TABLE charts IS 'Saved charts: a query on one dataset and how to draw its result.';
COMMENT ON COLUMN charts.id IS 'Chart id.';
COMMENT ON COLUMN charts.org_id IS 'Organisation of the workspace.';
COMMENT ON COLUMN charts.workspace_id IS 'Workspace the chart belongs to.';
COMMENT ON COLUMN charts.dataset_id IS 'Dataset the chart''s query reads. It cannot be deleted while the chart exists.';
COMMENT ON COLUMN charts.name IS 'Display name. Unique within the workspace.';
COMMENT ON COLUMN charts.description IS 'What the chart shows, displayed next to its name.';
COMMENT ON COLUMN charts.spec IS 'Definition as JSON: the query and the visualisation settings.';
COMMENT ON COLUMN charts.spec_version IS 'Version of the format spec is written in.';
COMMENT ON COLUMN charts.created_by IS 'User who created the chart.';
COMMENT ON COLUMN charts.updated_by IS 'User who last changed it.';
COMMENT ON COLUMN charts.created_at IS 'When the row was created.';
COMMENT ON COLUMN charts.updated_at IS 'When the row was last changed.';
COMMENT ON COLUMN charts.folder_id IS 'Folder the chart is in. NULL at the top of the tree.';
COMMENT ON COLUMN charts.revision IS 'Content revision for optimistic save checks; incremented on every definition update, independent of the spec format version.';

CREATE TABLE dashboards (
    id           text NOT NULL,
    org_id       text NOT NULL,
    workspace_id text NOT NULL,
    name         text NOT NULL,
    description  text DEFAULT '' NOT NULL,
    spec         jsonb NOT NULL,
    spec_version integer NOT NULL,
    created_by   text,
    updated_by   text,
    created_at   timestamptz DEFAULT now() NOT NULL,
    updated_at   timestamptz DEFAULT now() NOT NULL,
    folder_id    text,
    revision     integer DEFAULT 1 NOT NULL,
    PRIMARY KEY (id),
    UNIQUE (workspace_id, id),
    UNIQUE (workspace_id, name),
    FOREIGN KEY (org_id, created_by) REFERENCES users (org_id, id),
    FOREIGN KEY (org_id, updated_by) REFERENCES users (org_id, id),
    FOREIGN KEY (org_id, workspace_id) REFERENCES workspaces (org_id, id),
    FOREIGN KEY (workspace_id, folder_id) REFERENCES folders (workspace_id, id),
    CONSTRAINT dashboards_revision_check CHECK ((revision > 0))
);

CREATE INDEX dashboards_folder_id_idx ON dashboards (folder_id);

COMMENT ON TABLE dashboards IS 'Dashboards: charts laid out on a grid, with shared filters.';
COMMENT ON COLUMN dashboards.id IS 'Dashboard id.';
COMMENT ON COLUMN dashboards.org_id IS 'Organisation of the workspace.';
COMMENT ON COLUMN dashboards.workspace_id IS 'Workspace the dashboard belongs to.';
COMMENT ON COLUMN dashboards.name IS 'Display name. Unique within the workspace.';
COMMENT ON COLUMN dashboards.description IS 'What the dashboard is for, shown next to its name.';
COMMENT ON COLUMN dashboards.spec IS 'Definition as JSON: which charts, where they sit, and the filters.';
COMMENT ON COLUMN dashboards.spec_version IS 'Version of the format spec is written in.';
COMMENT ON COLUMN dashboards.created_by IS 'User who created the dashboard.';
COMMENT ON COLUMN dashboards.updated_by IS 'User who last changed it.';
COMMENT ON COLUMN dashboards.created_at IS 'When the row was created.';
COMMENT ON COLUMN dashboards.updated_at IS 'When the row was last changed.';
COMMENT ON COLUMN dashboards.folder_id IS 'Folder the dashboard is in. NULL at the top of the tree.';
COMMENT ON COLUMN dashboards.revision IS 'Content revision for optimistic save checks; incremented on every definition update, independent of the spec format version.';

CREATE TABLE dashboard_charts (
    workspace_id text NOT NULL,
    dashboard_id text NOT NULL,
    chart_id     text NOT NULL,
    PRIMARY KEY (dashboard_id, chart_id),
    FOREIGN KEY (workspace_id, chart_id) REFERENCES charts (workspace_id, id),
    FOREIGN KEY (workspace_id, dashboard_id) REFERENCES dashboards (workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX dashboard_charts_chart_id_idx ON dashboard_charts (chart_id);

COMMENT ON TABLE dashboard_charts IS 'Which charts each dashboard shows. Rewritten from the dashboard''s spec on every save, so that a chart still in use cannot be deleted.';
COMMENT ON COLUMN dashboard_charts.workspace_id IS 'Workspace of both the dashboard and the chart.';
COMMENT ON COLUMN dashboard_charts.dashboard_id IS 'The dashboard.';
COMMENT ON COLUMN dashboard_charts.chart_id IS 'A chart it shows.';

CREATE TABLE dashboard_grants (
    org_id       text NOT NULL,
    workspace_id text NOT NULL,
    dashboard_id text NOT NULL,
    user_id      text,
    group_id     text,
    everyone     boolean DEFAULT false NOT NULL,
    created_at   timestamptz DEFAULT now() NOT NULL,
    FOREIGN KEY (org_id, group_id) REFERENCES user_groups (org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, user_id) REFERENCES users (org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, workspace_id) REFERENCES workspaces (org_id, id),
    FOREIGN KEY (workspace_id, dashboard_id) REFERENCES dashboards (workspace_id, id) ON DELETE CASCADE,
    CONSTRAINT dashboard_grants_check CHECK (((num_nonnulls(user_id, group_id) + (everyone)::integer) = 1))
);

CREATE INDEX dashboard_grants_group_id_idx ON dashboard_grants (group_id);
CREATE UNIQUE INDEX dashboard_grants_subject_idx ON dashboard_grants (dashboard_id, user_id, group_id, everyone) NULLS NOT DISTINCT;
CREATE INDEX dashboard_grants_user_id_idx ON dashboard_grants (user_id);

COMMENT ON TABLE dashboard_grants IS 'Who may see a dashboard. Viewers see only dashboards granted here; developers and admins see every dashboard.';
COMMENT ON COLUMN dashboard_grants.org_id IS 'Organisation of the dashboard and of the user or group.';
COMMENT ON COLUMN dashboard_grants.workspace_id IS 'Workspace of the dashboard.';
COMMENT ON COLUMN dashboard_grants.dashboard_id IS 'The dashboard.';
COMMENT ON COLUMN dashboard_grants.user_id IS 'The user it is granted to, or NULL.';
COMMENT ON COLUMN dashboard_grants.group_id IS 'The group it is granted to, or NULL.';
COMMENT ON COLUMN dashboard_grants.everyone IS 'True when it is granted to every member of the workspace.';
COMMENT ON COLUMN dashboard_grants.created_at IS 'When the grant was made.';

CREATE TABLE dataset_policies (
    org_id       text NOT NULL,
    workspace_id text NOT NULL,
    dataset_id   text NOT NULL,
    unmatched    text DEFAULT 'all' NOT NULL,
    row_rules    jsonb DEFAULT '[]'::jsonb NOT NULL,
    column_rules jsonb DEFAULT '[]'::jsonb NOT NULL,
    updated_by   text,
    updated_at   timestamptz DEFAULT now() NOT NULL,
    column_mode  text DEFAULT 'visible' NOT NULL,
    PRIMARY KEY (dataset_id),
    FOREIGN KEY (org_id, updated_by) REFERENCES users (org_id, id),
    FOREIGN KEY (org_id, workspace_id) REFERENCES workspaces (org_id, id),
    FOREIGN KEY (workspace_id, dataset_id) REFERENCES datasets (workspace_id, id) ON DELETE CASCADE,
    CONSTRAINT dataset_policies_column_mode_check CHECK ((column_mode = ANY (ARRAY['visible'::text, 'hidden'::text]))),
    CONSTRAINT dataset_policies_unmatched_check CHECK ((unmatched = ANY (ARRAY['all'::text, 'none'::text])))
);

COMMENT ON TABLE dataset_policies IS 'Data permissions of a dataset: the rows and fields viewers may see. A dataset without a row restricts nobody.';
COMMENT ON COLUMN dataset_policies.org_id IS 'Organisation of the dataset.';
COMMENT ON COLUMN dataset_policies.workspace_id IS 'Workspace of the dataset.';
COMMENT ON COLUMN dataset_policies.dataset_id IS 'The dataset.';
COMMENT ON COLUMN dataset_policies.unmatched IS 'What a viewer no row rule covers sees: all rows, or none.';
COMMENT ON COLUMN dataset_policies.row_rules IS 'Row rules as a JSON array of {subjects, filter}: the subjects see the rows that pass the filter, or all rows without one. A subject is {user}, {group} or {everyone}.';
COMMENT ON COLUMN dataset_policies.column_rules IS 'Column rules as a JSON array of {fields, visibleTo}: only the subjects in visibleTo see those fields.';
COMMENT ON COLUMN dataset_policies.updated_by IS 'Who last changed the permissions.';
COMMENT ON COLUMN dataset_policies.updated_at IS 'When the permissions were last changed.';
COMMENT ON COLUMN dataset_policies.column_mode IS 'Whether column rule subjects may see or may not see the governed fields; visible by default.';

CREATE TABLE user_attributes (
    org_id       text NOT NULL,
    workspace_id text NOT NULL,
    key          text NOT NULL,
    name         text NOT NULL,
    assignments  jsonb DEFAULT '[]'::jsonb NOT NULL,
    updated_by   text,
    updated_at   timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (org_id, workspace_id, key),
    FOREIGN KEY (org_id, updated_by) REFERENCES users (org_id, id),
    FOREIGN KEY (org_id, workspace_id) REFERENCES workspaces (org_id, id) ON DELETE CASCADE
);

COMMENT ON TABLE user_attributes IS 'Workspace-scoped user attributes supplying dynamic row permissions.';
COMMENT ON COLUMN user_attributes.org_id IS 'Organisation owning the workspace.';
COMMENT ON COLUMN user_attributes.workspace_id IS 'Workspace in which the attribute is defined and resolved.';
COMMENT ON COLUMN user_attributes.key IS 'Stable attribute key referenced by row rules.';
COMMENT ON COLUMN user_attributes.name IS 'Display name shown in attribute and rule editors.';
COMMENT ON COLUMN user_attributes.assignments IS 'User/group assignments with exact text values; individual assignments override the union inherited from groups.';
COMMENT ON COLUMN user_attributes.updated_by IS 'Administrator who last changed this attribute.';
COMMENT ON COLUMN user_attributes.updated_at IS 'When this attribute was last changed.';

CREATE TABLE background_jobs (
    id               text NOT NULL,
    org_id           text NOT NULL,
    kind             text NOT NULL,
    status           text DEFAULT 'queued' NOT NULL,
    dedupe_key       text,
    created_at       timestamptz DEFAULT now() NOT NULL,
    started_at       timestamptz,
    finished_at      timestamptz,
    lease_token      text,
    lease_until      timestamptz,
    attempts         integer DEFAULT 0 NOT NULL,
    cancel_requested boolean DEFAULT false NOT NULL,
    error_code       text DEFAULT '' NOT NULL,
    PRIMARY KEY (id),
    UNIQUE (org_id, dedupe_key),
    UNIQUE (org_id, id),
    FOREIGN KEY (org_id) REFERENCES orgs (id),
    CONSTRAINT background_jobs_kind_check CHECK ((kind = ANY (ARRAY['export'::text, 'export_cleanup'::text, 'maintenance'::text]))),
    CONSTRAINT background_jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text])))
);

CREATE INDEX background_jobs_ready ON background_jobs (created_at) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]));

COMMENT ON TABLE background_jobs IS 'Durable background work, claimed with a renewable and fenced execution lease.';
COMMENT ON COLUMN background_jobs.id IS 'Job identifier; exports use the same identifier.';
COMMENT ON COLUMN background_jobs.org_id IS 'Owning organization.';
COMMENT ON COLUMN background_jobs.kind IS 'Worker handler to execute: an export, export file cleanup, or hourly maintenance (expired sessions, old audit events).';
COMMENT ON COLUMN background_jobs.status IS 'Durable job lifecycle state.';
COMMENT ON COLUMN background_jobs.dedupe_key IS 'Optional unique scheduling key, shared by scheduler instances.';
COMMENT ON COLUMN background_jobs.created_at IS 'Time the job entered the queue.';
COMMENT ON COLUMN background_jobs.started_at IS 'Time the latest attempt started.';
COMMENT ON COLUMN background_jobs.finished_at IS 'Time the job reached a terminal state.';
COMMENT ON COLUMN background_jobs.lease_token IS 'Fencing token for the current worker attempt.';
COMMENT ON COLUMN background_jobs.lease_until IS 'Time after which an abandoned attempt can be reclaimed.';
COMMENT ON COLUMN background_jobs.attempts IS 'Number of claims; abandoned work is retried at most three times.';
COMMENT ON COLUMN background_jobs.cancel_requested IS 'Whether the requester has asked the running query to stop.';
COMMENT ON COLUMN background_jobs.error_code IS 'Safe localized failure code, without SQL or connection details.';

CREATE TABLE exports (
    id             text NOT NULL,
    org_id         text NOT NULL,
    workspace_id   text NOT NULL,
    user_id        text NOT NULL,
    datasource_id  text NOT NULL,
    name           text NOT NULL,
    format         text NOT NULL,
    source_spec    jsonb NOT NULL,
    row_count      bigint DEFAULT 0 NOT NULL,
    file_key       text DEFAULT '' NOT NULL,
    size_bytes     bigint DEFAULT 0 NOT NULL,
    expires_at     timestamptz,
    cleaned_at     timestamptz,
    source         text DEFAULT 'sql' NOT NULL,
    dashboard_id   text DEFAULT '' NOT NULL,
    item_id        text DEFAULT '' NOT NULL,
    chart_id       text DEFAULT '' NOT NULL,
    dashboard_name text DEFAULT '' NOT NULL,
    chart_name     text DEFAULT '' NOT NULL,
    unseen         boolean DEFAULT false NOT NULL,
    PRIMARY KEY (id),
    UNIQUE (org_id, id),
    FOREIGN KEY (org_id, id) REFERENCES background_jobs (org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, user_id) REFERENCES users (org_id, id),
    FOREIGN KEY (org_id, workspace_id) REFERENCES workspaces (org_id, id) ON DELETE CASCADE,
    CONSTRAINT exports_format_check CHECK ((format = ANY (ARRAY['csv'::text, 'xlsx'::text]))),
    CONSTRAINT exports_source_check CHECK ((source = ANY (ARRAY['sql'::text, 'chart'::text])))
);

CREATE INDEX exports_expiry ON exports (expires_at) WHERE ((file_key <> ''::text) AND (cleaned_at IS NULL));
CREATE INDEX exports_owner ON exports (org_id, workspace_id, user_id);
CREATE INDEX exports_unseen ON exports (org_id, workspace_id, user_id) WHERE unseen;

COMMENT ON TABLE exports IS 'Export snapshots and private file metadata, scoped to the requesting user and workspace.';
COMMENT ON COLUMN exports.id IS 'Export identifier, also its background job identifier.';
COMMENT ON COLUMN exports.org_id IS 'Owning organization.';
COMMENT ON COLUMN exports.workspace_id IS 'Workspace in which the request was made.';
COMMENT ON COLUMN exports.user_id IS 'Only this user may list, cancel, or download this export.';
COMMENT ON COLUMN exports.datasource_id IS 'Data source queried: the SQL export''s, or the chart dataset''s when the export was made; kept for history if the source is deleted.';
COMMENT ON COLUMN exports.name IS 'User-facing file name without an extension.';
COMMENT ON COLUMN exports.format IS 'Requested CSV or XLSX file format.';
COMMENT ON COLUMN exports.source_spec IS 'Immutable SQL and parameter snapshot, or resolved chart query and columns; never returned by list endpoints.';
COMMENT ON COLUMN exports.row_count IS 'Rows written; updated periodically while the query runs.';
COMMENT ON COLUMN exports.file_key IS 'Private path relative to the exports directory, including the winning attempt token.';
COMMENT ON COLUMN exports.size_bytes IS 'Size of the completed file.';
COMMENT ON COLUMN exports.expires_at IS 'Download deadline, set when the export succeeds.';
COMMENT ON COLUMN exports.cleaned_at IS 'Time the expired file was removed.';
COMMENT ON COLUMN exports.source IS 'sql for data exploration, chart for a widget on a dashboard.';
COMMENT ON COLUMN exports.dashboard_id IS 'For chart exports, the dashboard whose visibility the owner needs to run and download it.';
COMMENT ON COLUMN exports.item_id IS 'For chart exports, the dashboard widget that showed the chart.';
COMMENT ON COLUMN exports.chart_id IS 'For chart exports, the chart, which must still allow exports and still be on the widget.';
COMMENT ON COLUMN exports.dashboard_name IS 'For chart exports, the dashboard name at the time, shown as the export''s origin.';
COMMENT ON COLUMN exports.chart_name IS 'For chart exports, the chart name at the time, shown as the export''s origin.';
COMMENT ON COLUMN exports.unseen IS 'A succeeded or failed result the owner has not yet looked at; set atomically with completion.';

CREATE TABLE audit_events (
    id            text NOT NULL,
    org_id        text NOT NULL,
    occurred_at   timestamptz NOT NULL,
    workspace_id  text DEFAULT '' NOT NULL,
    actor_id      text DEFAULT '' NOT NULL,
    actor_email   text DEFAULT '' NOT NULL,
    category      text NOT NULL,
    action        text NOT NULL,
    outcome       text NOT NULL,
    object_type   text DEFAULT '' NOT NULL,
    object_id     text DEFAULT '' NOT NULL,
    object_name   text DEFAULT '' NOT NULL,
    detail        jsonb DEFAULT '{}'::jsonb NOT NULL,
    client_ip     text DEFAULT '' NOT NULL,
    forwarded_for text DEFAULT '' NOT NULL,
    user_agent    text DEFAULT '' NOT NULL,
    PRIMARY KEY (org_id, id),
    FOREIGN KEY (org_id) REFERENCES orgs (id),
    CONSTRAINT audit_events_category_check CHECK ((category = ANY (ARRAY['auth'::text, 'account'::text, 'workspace'::text, 'access'::text, 'content'::text, 'query'::text, 'export'::text, 'ai'::text, 'system'::text]))),
    CONSTRAINT audit_events_outcome_check CHECK ((outcome = ANY (ARRAY['success'::text, 'failure'::text, 'denied'::text])))
);

CREATE INDEX audit_events_actor ON audit_events (org_id, actor_id, occurred_at DESC, id DESC);
CREATE INDEX audit_events_time ON audit_events (org_id, occurred_at DESC, id DESC);
CREATE INDEX audit_events_workspace ON audit_events (org_id, workspace_id, occurred_at DESC, id DESC);

COMMENT ON TABLE audit_events IS 'Who did what to which object, and which data they read; see .agents/design/access-control.md section 7.';
COMMENT ON COLUMN audit_events.id IS 'Event identifier.';
COMMENT ON COLUMN audit_events.org_id IS 'Owning organization.';
COMMENT ON COLUMN audit_events.occurred_at IS 'Time the operation finished.';
COMMENT ON COLUMN audit_events.workspace_id IS 'Workspace acted in; empty for sign-in, account and group events.';
COMMENT ON COLUMN audit_events.actor_id IS 'User who acted; empty when a sign-in names no existing account.';
COMMENT ON COLUMN audit_events.actor_email IS 'Email of the actor at the time, or the one typed at a failed sign-in.';
COMMENT ON COLUMN audit_events.category IS 'Group of actions the event belongs to, for filtering.';
COMMENT ON COLUMN audit_events.action IS 'What happened, such as dataset.update or query.run.';
COMMENT ON COLUMN audit_events.outcome IS 'success, failure (sign-ins and queries), or denied by a permission check.';
COMMENT ON COLUMN audit_events.object_type IS 'Type of the object acted on, such as dataset or user.';
COMMENT ON COLUMN audit_events.object_id IS 'Identifier of the object acted on.';
COMMENT ON COLUMN audit_events.object_name IS 'Name of the object at the time; before deletion for a delete.';
COMMENT ON COLUMN audit_events.detail IS 'Action-specific facts: request content without passwords, query statements, export results.';
COMMENT ON COLUMN audit_events.client_ip IS 'Address of the connection; a reverse proxy''s when there is one.';
COMMENT ON COLUMN audit_events.forwarded_for IS 'X-Forwarded-For header as sent; clients can forge it.';
COMMENT ON COLUMN audit_events.user_agent IS 'User-Agent header as sent.';

CREATE TABLE login_throttle (
    org_id       text NOT NULL,
    email        text NOT NULL,
    failures     integer NOT NULL,
    window_start timestamptz NOT NULL,
    PRIMARY KEY (org_id, email),
    FOREIGN KEY (org_id) REFERENCES orgs (id),
    CONSTRAINT login_throttle_failures_check CHECK ((failures > 0))
);

CREATE INDEX login_throttle_window ON login_throttle (org_id, window_start);

COMMENT ON TABLE login_throttle IS 'Recent failed sign-ins per email address; deleted on success and by the hourly maintenance job once stale.';
COMMENT ON COLUMN login_throttle.org_id IS 'Organization signed in to.';
COMMENT ON COLUMN login_throttle.email IS 'Normalized email address typed, whether or not an account has it.';
COMMENT ON COLUMN login_throttle.failures IS 'Failures since window_start.';
COMMENT ON COLUMN login_throttle.window_start IS 'Time of the first failure of the current window; a later failure after the window starts a new one.';

CREATE TABLE dashboard_views (
    id             text NOT NULL,
    org_id         text NOT NULL,
    workspace_id   text NOT NULL,
    dashboard_id   text NOT NULL,
    state          jsonb NOT NULL,
    state_hash     text NOT NULL,
    created_by     text,
    created_at     timestamptz DEFAULT now() NOT NULL,
    expires_at     timestamptz NOT NULL,
    last_opened_at timestamptz,
    PRIMARY KEY (id),
    UNIQUE (dashboard_id, state_hash),
    FOREIGN KEY (org_id, created_by) REFERENCES users (org_id, id),
    FOREIGN KEY (workspace_id, dashboard_id) REFERENCES dashboards (workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX dashboard_views_expiry ON dashboard_views (org_id, expires_at);

COMMENT ON TABLE dashboard_views IS 'Conditions a dashboard is shared with; a share link names one by its id. Deleted with the dashboard, and by the hourly maintenance job once expired.';
COMMENT ON COLUMN dashboard_views.id IS 'Short id carried by the share link.';
COMMENT ON COLUMN dashboard_views.org_id IS 'Organization of the dashboard.';
COMMENT ON COLUMN dashboard_views.workspace_id IS 'Workspace of the dashboard.';
COMMENT ON COLUMN dashboard_views.dashboard_id IS 'Dashboard shared.';
COMMENT ON COLUMN dashboard_views.state IS 'Global and chart filter values, link clicks, dynamic choices and widgets using their own filters, as the viewer had them.';
COMMENT ON COLUMN dashboard_views.state_hash IS 'SHA-256 of the state as stored, so that sharing the same conditions again finds the same row.';
COMMENT ON COLUMN dashboard_views.created_by IS 'User who first shared these conditions.';
COMMENT ON COLUMN dashboard_views.created_at IS 'When these conditions were first shared.';
COMMENT ON COLUMN dashboard_views.expires_at IS 'When the link stops carrying the conditions: the latest of the expiries asked for by everyone who shared them.';
COMMENT ON COLUMN dashboard_views.last_opened_at IS 'When the link was last opened with the conditions applied; empty until then.';

CREATE TABLE chart_revisions (
    chart_id         text NOT NULL,
    revision         integer NOT NULL,
    org_id           text NOT NULL,
    workspace_id     text NOT NULL,
    name             text NOT NULL,
    description      text NOT NULL,
    dataset_id       text NOT NULL,
    dataset_revision integer,
    spec             jsonb NOT NULL,
    spec_version     integer NOT NULL,
    created_by       text,
    created_at       timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (chart_id, revision),
    FOREIGN KEY (org_id, created_by) REFERENCES users (org_id, id),
    FOREIGN KEY (workspace_id, chart_id) REFERENCES charts (workspace_id, id) ON DELETE CASCADE
);

COMMENT ON TABLE chart_revisions IS 'Every definition a chart has been saved with, for tracing changes; never restored or rewritten. Deleted with the chart.';
COMMENT ON COLUMN chart_revisions.chart_id IS 'The chart.';
COMMENT ON COLUMN chart_revisions.revision IS 'Number of this definition, matching charts.revision at the time it was saved.';
COMMENT ON COLUMN chart_revisions.org_id IS 'Organization of the chart.';
COMMENT ON COLUMN chart_revisions.workspace_id IS 'Workspace of the chart.';
COMMENT ON COLUMN chart_revisions.name IS 'Chart name when this revision was saved.';
COMMENT ON COLUMN chart_revisions.description IS 'Chart description when this revision was saved.';
COMMENT ON COLUMN chart_revisions.dataset_id IS 'Dataset the chart read. Not a foreign key: the chart may have moved to another dataset since, and this one been deleted.';
COMMENT ON COLUMN chart_revisions.dataset_revision IS 'Revision the dataset had when the chart was saved, which the chart was checked against; its definition is in dataset_revisions. Empty for the revisions recorded when this table was made, where it was not known.';
COMMENT ON COLUMN chart_revisions.spec IS 'The definition as saved, in the format of its time.';
COMMENT ON COLUMN chart_revisions.spec_version IS 'Version of the format spec is written in.';
COMMENT ON COLUMN chart_revisions.created_by IS 'User who saved this definition.';
COMMENT ON COLUMN chart_revisions.created_at IS 'When it was saved.';

CREATE TABLE dashboard_revisions (
    dashboard_id text NOT NULL,
    revision     integer NOT NULL,
    org_id       text NOT NULL,
    workspace_id text NOT NULL,
    name         text NOT NULL,
    description  text NOT NULL,
    spec         jsonb NOT NULL,
    spec_version integer NOT NULL,
    created_by   text,
    created_at   timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (dashboard_id, revision),
    FOREIGN KEY (org_id, created_by) REFERENCES users (org_id, id),
    FOREIGN KEY (workspace_id, dashboard_id) REFERENCES dashboards (workspace_id, id) ON DELETE CASCADE
);

COMMENT ON TABLE dashboard_revisions IS 'Every definition a dashboard has been saved with, for tracing changes; never restored or rewritten. Deleted with the dashboard.';
COMMENT ON COLUMN dashboard_revisions.dashboard_id IS 'The dashboard.';
COMMENT ON COLUMN dashboard_revisions.revision IS 'Number of this definition, matching dashboards.revision at the time it was saved.';
COMMENT ON COLUMN dashboard_revisions.org_id IS 'Organization of the dashboard.';
COMMENT ON COLUMN dashboard_revisions.workspace_id IS 'Workspace of the dashboard.';
COMMENT ON COLUMN dashboard_revisions.name IS 'Dashboard name when this revision was saved.';
COMMENT ON COLUMN dashboard_revisions.description IS 'Dashboard description when this revision was saved.';
COMMENT ON COLUMN dashboard_revisions.spec IS 'The definition as saved, in the format of its time.';
COMMENT ON COLUMN dashboard_revisions.spec_version IS 'Version of the format spec is written in.';
COMMENT ON COLUMN dashboard_revisions.created_by IS 'User who saved this definition.';
COMMENT ON COLUMN dashboard_revisions.created_at IS 'When it was saved.';

CREATE TABLE ai_providers (
    id         text NOT NULL,
    org_id     text NOT NULL,
    name       text NOT NULL,
    protocol   text NOT NULL,
    base_url   text NOT NULL,
    api_key    bytea,
    created_by text,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_by text,
    updated_at timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (id),
    UNIQUE (org_id, id),
    UNIQUE (org_id, name),
    FOREIGN KEY (org_id, created_by) REFERENCES users (org_id, id),
    FOREIGN KEY (org_id) REFERENCES orgs (id),
    FOREIGN KEY (org_id, updated_by) REFERENCES users (org_id, id)
);

COMMENT ON TABLE ai_providers IS 'Services that run language models for the AI assistant, shared by the whole organization.';
COMMENT ON COLUMN ai_providers.id IS 'Provider identifier.';
COMMENT ON COLUMN ai_providers.org_id IS 'Owning organization.';
COMMENT ON COLUMN ai_providers.name IS 'Name the administrator gave it, unique in the organization.';
COMMENT ON COLUMN ai_providers.protocol IS 'Protocol the provider speaks, such as openai for OpenAI-compatible chat completions. Checked by the application, so that adding one needs no migration.';
COMMENT ON COLUMN ai_providers.base_url IS 'Address of the API, to which the protocol''s paths are appended.';
COMMENT ON COLUMN ai_providers.api_key IS 'API key sealed with the secret key; NULL when the provider needs none.';
COMMENT ON COLUMN ai_providers.created_by IS 'User who added the provider.';
COMMENT ON COLUMN ai_providers.created_at IS 'When the provider was added.';
COMMENT ON COLUMN ai_providers.updated_by IS 'User who last changed the provider.';
COMMENT ON COLUMN ai_providers.updated_at IS 'When the provider was last changed.';

CREATE TABLE ai_models (
    id                 text NOT NULL,
    org_id             text NOT NULL,
    provider_id        text NOT NULL,
    model              text NOT NULL,
    context_tokens     integer NOT NULL,
    max_output_tokens  integer NOT NULL,
    currency           text NOT NULL,
    input_price        numeric NOT NULL,
    cached_input_price numeric,
    cache_write_price  numeric,
    output_price       numeric NOT NULL,
    created_by         text,
    created_at         timestamptz DEFAULT now() NOT NULL,
    updated_by         text,
    updated_at         timestamptz DEFAULT now() NOT NULL,
    thinking_level     text,
    PRIMARY KEY (id),
    UNIQUE (org_id, id),
    UNIQUE (provider_id, model),
    FOREIGN KEY (org_id, created_by) REFERENCES users (org_id, id),
    FOREIGN KEY (org_id, provider_id) REFERENCES ai_providers (org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, updated_by) REFERENCES users (org_id, id),
    CONSTRAINT ai_models_cache_write_price_check CHECK ((cache_write_price >= (0)::numeric)),
    CONSTRAINT ai_models_cached_input_price_check CHECK ((cached_input_price >= (0)::numeric)),
    CONSTRAINT ai_models_check CHECK (((max_output_tokens > 0) AND (max_output_tokens < context_tokens))),
    CONSTRAINT ai_models_context_tokens_check CHECK ((context_tokens > 0)),
    CONSTRAINT ai_models_currency_check CHECK ((currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT ai_models_input_price_check CHECK ((input_price >= (0)::numeric)),
    CONSTRAINT ai_models_output_price_check CHECK ((output_price >= (0)::numeric)),
    CONSTRAINT ai_models_thinking_level_check CHECK ((thinking_level <> ''::text))
);

COMMENT ON TABLE ai_models IS 'Models of a provider that the assistant may be set to use, with their limits and prices. Deleted with their provider.';
COMMENT ON COLUMN ai_models.id IS 'Model identifier.';
COMMENT ON COLUMN ai_models.org_id IS 'Owning organization.';
COMMENT ON COLUMN ai_models.provider_id IS 'Provider that runs the model.';
COMMENT ON COLUMN ai_models.model IS 'Name of the model in calls to the provider, such as deepseek-chat.';
COMMENT ON COLUMN ai_models.context_tokens IS 'Tokens the model reads and writes in one call at most; conversations are summarized before they outgrow it.';
COMMENT ON COLUMN ai_models.max_output_tokens IS 'Tokens one answer may have at most; sent with every call.';
COMMENT ON COLUMN ai_models.currency IS 'ISO 4217 code of the currency the prices are in. Costs in different currencies are never added together.';
COMMENT ON COLUMN ai_models.input_price IS 'Price of a million input tokens read without the provider''s cache.';
COMMENT ON COLUMN ai_models.cached_input_price IS 'Price of a million input tokens read from the provider''s cache; NULL charges them as other input.';
COMMENT ON COLUMN ai_models.cache_write_price IS 'Price of a million input tokens written to the provider''s cache; NULL charges them as other input.';
COMMENT ON COLUMN ai_models.output_price IS 'Price of a million output tokens.';
COMMENT ON COLUMN ai_models.created_by IS 'User who added the model.';
COMMENT ON COLUMN ai_models.created_at IS 'When the model was added.';
COMMENT ON COLUMN ai_models.updated_by IS 'User who last changed the model.';
COMMENT ON COLUMN ai_models.updated_at IS 'When the model was last changed. Changes apply to later calls only.';
COMMENT ON COLUMN ai_models.thinking_level IS 'Sent as it is as reasoning_effort when answering and when tried; NULL sends none, leaving it to the provider.';

CREATE TABLE ai_settings (
    org_id               text NOT NULL,
    chat_model_id        text,
    title_model_id       text,
    compression_model_id text,
    updated_by           text,
    updated_at           timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (org_id),
    FOREIGN KEY (org_id, chat_model_id) REFERENCES ai_models (org_id, id),
    FOREIGN KEY (org_id, compression_model_id) REFERENCES ai_models (org_id, id),
    FOREIGN KEY (org_id) REFERENCES orgs (id),
    FOREIGN KEY (org_id, title_model_id) REFERENCES ai_models (org_id, id),
    FOREIGN KEY (org_id, updated_by) REFERENCES users (org_id, id)
);

COMMENT ON TABLE ai_settings IS 'Which model the assistant uses for what, one row per organization. A model in use here cannot be deleted. People never choose a model themselves.';
COMMENT ON COLUMN ai_settings.org_id IS 'Organization the settings belong to.';
COMMENT ON COLUMN ai_settings.chat_model_id IS 'Model that answers people; the assistant is unavailable while it is NULL.';
COMMENT ON COLUMN ai_settings.title_model_id IS 'Model that names conversations; NULL uses the chat model.';
COMMENT ON COLUMN ai_settings.compression_model_id IS 'Model that summarizes the earlier part of long conversations; NULL uses the chat model.';
COMMENT ON COLUMN ai_settings.updated_by IS 'User who last changed the settings.';
COMMENT ON COLUMN ai_settings.updated_at IS 'When the settings were last changed.';

CREATE TABLE ai_conversations (
    id              text NOT NULL,
    org_id          text NOT NULL,
    workspace_id    text NOT NULL,
    user_id         text NOT NULL,
    title           text DEFAULT '' NOT NULL,
    title_by_user   boolean DEFAULT false NOT NULL,
    summary         text DEFAULT '' NOT NULL,
    summary_through integer DEFAULT 0 NOT NULL,
    created_at      timestamptz DEFAULT now() NOT NULL,
    updated_at      timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (id),
    FOREIGN KEY (org_id, user_id) REFERENCES users (org_id, id),
    FOREIGN KEY (org_id, workspace_id) REFERENCES workspaces (org_id, id) ON DELETE CASCADE
);

CREATE INDEX ai_conversations_owner ON ai_conversations (org_id, workspace_id, user_id, updated_at DESC);

COMMENT ON TABLE ai_conversations IS 'Conversations with the assistant. Each belongs to one person in one workspace, and only that person sees it.';
COMMENT ON COLUMN ai_conversations.id IS 'Conversation identifier.';
COMMENT ON COLUMN ai_conversations.org_id IS 'Owning organization.';
COMMENT ON COLUMN ai_conversations.workspace_id IS 'Workspace the conversation was held in; it is deleted with the workspace.';
COMMENT ON COLUMN ai_conversations.user_id IS 'Person the conversation belongs to.';
COMMENT ON COLUMN ai_conversations.title IS 'Title in the list: the start of the first question, then one the title model wrote, unless the person renamed it.';
COMMENT ON COLUMN ai_conversations.title_by_user IS 'Whether the person named the conversation; their title is never replaced.';
COMMENT ON COLUMN ai_conversations.summary IS 'Summary of the earlier messages, sent to the model in their place once the conversation grew too long. Empty until then.';
COMMENT ON COLUMN ai_conversations.summary_through IS 'Sequence number of the last message the summary covers; 0 without a summary.';
COMMENT ON COLUMN ai_conversations.created_at IS 'When the conversation was started.';
COMMENT ON COLUMN ai_conversations.updated_at IS 'When a message was last added; the list is in this order.';

CREATE TABLE ai_messages (
    id              text NOT NULL,
    conversation_id text NOT NULL,
    seq             integer NOT NULL,
    role            text NOT NULL,
    parts           jsonb DEFAULT '[]'::jsonb NOT NULL,
    status          text NOT NULL,
    error           text DEFAULT '' NOT NULL,
    model           text DEFAULT '' NOT NULL,
    context_tokens  integer,
    created_at      timestamptz DEFAULT now() NOT NULL,
    updated_at      timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (id),
    UNIQUE (conversation_id, seq),
    FOREIGN KEY (conversation_id) REFERENCES ai_conversations (id) ON DELETE CASCADE,
    CONSTRAINT ai_messages_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text]))),
    CONSTRAINT ai_messages_status_check CHECK ((status = ANY (ARRAY['generating'::text, 'done'::text, 'stopped'::text, 'failed'::text])))
);

CREATE UNIQUE INDEX ai_messages_generating ON ai_messages (conversation_id) WHERE (status = 'generating'::text);

COMMENT ON TABLE ai_messages IS 'Messages of a conversation, the person''s and the assistant''s, in order.';
COMMENT ON COLUMN ai_messages.id IS 'Message identifier.';
COMMENT ON COLUMN ai_messages.conversation_id IS 'Conversation the message is in.';
COMMENT ON COLUMN ai_messages.seq IS 'Position in the conversation, from 1.';
COMMENT ON COLUMN ai_messages.role IS 'Who wrote it: user or assistant.';
COMMENT ON COLUMN ai_messages.parts IS 'Content as a list of parts, each an object with a type; text parts carry the text. Later parts will record tools the assistant used, with where their data came from.';
COMMENT ON COLUMN ai_messages.status IS 'generating while the assistant writes it, then done, stopped by the person, or failed. A person''s message is done.';
COMMENT ON COLUMN ai_messages.error IS 'Code of why an answer failed, such as timeout or interrupted; empty otherwise. What the provider said is in the log only: it may repeat request details.';
COMMENT ON COLUMN ai_messages.model IS 'Name of the model that wrote an answer; empty for the person''s messages.';
COMMENT ON COLUMN ai_messages.context_tokens IS 'Tokens of everything the model read and wrote for this answer, as the provider reported them; NULL when it did not. Tells when to summarize.';
COMMENT ON COLUMN ai_messages.created_at IS 'When the message was added.';
COMMENT ON COLUMN ai_messages.updated_at IS 'When the message last changed. While an answer is generated it is touched regularly, so that one whose writer died can be told from one still being written.';

CREATE TABLE ai_usage (
    id                  text NOT NULL,
    org_id              text NOT NULL,
    workspace_id        text,
    user_id             text,
    conversation_id     text,
    message_id          text,
    purpose             text NOT NULL,
    provider            text NOT NULL,
    model_id            text,
    model               text NOT NULL,
    input_tokens        bigint DEFAULT 0 NOT NULL,
    cached_input_tokens bigint DEFAULT 0 NOT NULL,
    cache_write_tokens  bigint DEFAULT 0 NOT NULL,
    output_tokens       bigint DEFAULT 0 NOT NULL,
    estimated           boolean DEFAULT false NOT NULL,
    cost                numeric DEFAULT 0 NOT NULL,
    currency            text NOT NULL,
    duration_ms         integer DEFAULT 0 NOT NULL,
    outcome             text NOT NULL,
    created_at          timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (id),
    CONSTRAINT ai_usage_outcome_check CHECK ((outcome = ANY (ARRAY['success'::text, 'failure'::text, 'stopped'::text]))),
    CONSTRAINT ai_usage_purpose_check CHECK ((purpose = ANY (ARRAY['chat'::text, 'title'::text, 'compression'::text, 'test'::text])))
);

CREATE INDEX ai_usage_time ON ai_usage (org_id, created_at);

COMMENT ON TABLE ai_usage IS 'Every call to a model, with the tokens it used and what it cost. No foreign keys: the record outlives the people, conversations and models it names.';
COMMENT ON COLUMN ai_usage.id IS 'Record identifier.';
COMMENT ON COLUMN ai_usage.org_id IS 'Organization billed.';
COMMENT ON COLUMN ai_usage.workspace_id IS 'Workspace of the conversation; NULL for a test by an administrator.';
COMMENT ON COLUMN ai_usage.user_id IS 'Person the call was made for.';
COMMENT ON COLUMN ai_usage.conversation_id IS 'Conversation the call was made for; NULL for a test.';
COMMENT ON COLUMN ai_usage.message_id IS 'Answer the call wrote, for chat calls.';
COMMENT ON COLUMN ai_usage.purpose IS 'Why the model was called: chat, title, compression, or test from the model settings.';
COMMENT ON COLUMN ai_usage.provider IS 'Name of the provider at the time.';
COMMENT ON COLUMN ai_usage.model_id IS 'Identifier of the model setting used.';
COMMENT ON COLUMN ai_usage.model IS 'Name of the model at the time.';
COMMENT ON COLUMN ai_usage.input_tokens IS 'Input tokens read without the provider''s cache.';
COMMENT ON COLUMN ai_usage.cached_input_tokens IS 'Input tokens read from the provider''s cache.';
COMMENT ON COLUMN ai_usage.cache_write_tokens IS 'Input tokens written to the provider''s cache.';
COMMENT ON COLUMN ai_usage.output_tokens IS 'Output tokens, reasoning included.';
COMMENT ON COLUMN ai_usage.estimated IS 'Whether the provider did not report the tokens, so that they were estimated from the length of the text.';
COMMENT ON COLUMN ai_usage.cost IS 'Cost at the model''s prices when the call was made.';
COMMENT ON COLUMN ai_usage.currency IS 'ISO 4217 code of the cost''s currency, the model''s at the time.';
COMMENT ON COLUMN ai_usage.duration_ms IS 'How long the call took, in milliseconds.';
COMMENT ON COLUMN ai_usage.outcome IS 'success, failure, or stopped when the person stopped the answer or left.';
COMMENT ON COLUMN ai_usage.created_at IS 'When the call was made.';

CREATE TABLE system_settings (
    org_id                   text NOT NULL,
    export_retention_hours   integer,
    export_timeout_minutes   integer,
    export_max_rows          bigint,
    export_max_size_mb       integer,
    audit_retention_days     integer,
    query_cache_ttl_minutes  integer,
    updated_by               text,
    updated_at               timestamptz DEFAULT now() NOT NULL,
    query_timeout_seconds    integer,
    query_default_rows       integer,
    query_max_rows           integer,
    session_lifetime_hours   integer,
    workspace_retention_days integer,
    PRIMARY KEY (org_id),
    FOREIGN KEY (org_id) REFERENCES orgs (id),
    FOREIGN KEY (org_id, updated_by) REFERENCES users (org_id, id),
    CONSTRAINT system_settings_audit_retention_days_check CHECK ((audit_retention_days >= 0)),
    CONSTRAINT system_settings_export_max_rows_check CHECK ((export_max_rows > 0)),
    CONSTRAINT system_settings_export_max_size_mb_check CHECK ((export_max_size_mb > 0)),
    CONSTRAINT system_settings_export_retention_hours_check CHECK ((export_retention_hours > 0)),
    CONSTRAINT system_settings_export_timeout_minutes_check CHECK ((export_timeout_minutes > 0)),
    CONSTRAINT system_settings_query_cache_ttl_minutes_check CHECK ((query_cache_ttl_minutes > 0)),
    CONSTRAINT system_settings_query_default_rows_check CHECK ((query_default_rows > 0)),
    CONSTRAINT system_settings_query_max_rows_check CHECK ((query_max_rows > 0)),
    CONSTRAINT system_settings_query_timeout_seconds_check CHECK ((query_timeout_seconds > 0)),
    CONSTRAINT system_settings_session_lifetime_hours_check CHECK ((session_lifetime_hours > 0)),
    CONSTRAINT system_settings_workspace_retention_days_check CHECK ((workspace_retention_days > 0))
);

COMMENT ON TABLE system_settings IS 'Settings a system administrator sets for the whole organization, one row per organization; no row is every setting at its default. Each is read anew where it is used, so a change applies at once on every instance.';
COMMENT ON COLUMN system_settings.org_id IS 'Organization the settings belong to.';
COMMENT ON COLUMN system_settings.export_retention_hours IS 'How long a finished export file can be downloaded; NULL follows the default of the running version.';
COMMENT ON COLUMN system_settings.export_timeout_minutes IS 'The longest one attempt at an export may run; NULL follows the default.';
COMMENT ON COLUMN system_settings.export_max_rows IS 'The most rows an export may have; NULL follows the default.';
COMMENT ON COLUMN system_settings.export_max_size_mb IS 'The largest CSV or XLSX file an export may write, in MiB; NULL follows the default.';
COMMENT ON COLUMN system_settings.audit_retention_days IS 'How long audit events and records of calls to AI models are kept; 0 keeps them, NULL follows the default.';
COMMENT ON COLUMN system_settings.query_cache_ttl_minutes IS 'How long query results are kept unless a data source says otherwise; NULL follows the default.';
COMMENT ON COLUMN system_settings.updated_by IS 'User who last changed the settings.';
COMMENT ON COLUMN system_settings.updated_at IS 'When the settings were last changed.';
COMMENT ON COLUMN system_settings.query_timeout_seconds IS 'The longest a statement of a query, a preview or a look at a data source may run; NULL follows the default.';
COMMENT ON COLUMN system_settings.query_default_rows IS 'How many rows a query that does not say returns; NULL follows the default.';
COMMENT ON COLUMN system_settings.query_max_rows IS 'The most rows a query returns, whatever it says; NULL follows the default.';
COMMENT ON COLUMN system_settings.session_lifetime_hours IS 'How long a session lasts without activity; NULL follows the default.';
COMMENT ON COLUMN system_settings.workspace_retention_days IS 'How long a deleted workspace can be restored before it is purged; NULL follows the default.';

CREATE TABLE secret_key_check (
    only_row   boolean DEFAULT true NOT NULL,
    sealed     bytea NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (only_row),
    CONSTRAINT secret_key_check_only_row_check CHECK (only_row)
);

COMMENT ON TABLE secret_key_check IS 'A fixed text sealed with the secret key of the installation, at most one row. An instance that cannot open it holds another key and does not start. supabi clear-secrets removes it with the secrets.';
COMMENT ON COLUMN secret_key_check.only_row IS 'Always true: the installation has one key.';
COMMENT ON COLUMN secret_key_check.sealed IS 'The fixed text, sealed as stored secrets are.';
COMMENT ON COLUMN secret_key_check.created_at IS 'When the first instance to start with this key wrote it.';
