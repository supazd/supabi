-- Announcements that administrators publish to the organization or to one
-- workspace, who has read them, and how often open pages look for them:
-- .agents/design/announcements.md, .agents/design/configuration.md 10.10.

CREATE TABLE announcements (
    id           text NOT NULL,
    org_id       text NOT NULL,
    workspace_id text,
    title        text NOT NULL,
    body         text DEFAULT '' NOT NULL,
    starts_at    timestamptz NOT NULL,
    ends_at      timestamptz NOT NULL,
    created_by   text,
    created_at   timestamptz DEFAULT now() NOT NULL,
    updated_by   text,
    updated_at   timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (id),
    UNIQUE (org_id, id),
    FOREIGN KEY (org_id) REFERENCES orgs (id),
    FOREIGN KEY (org_id, workspace_id) REFERENCES workspaces (org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, created_by) REFERENCES users (org_id, id),
    FOREIGN KEY (org_id, updated_by) REFERENCES users (org_id, id),
    CONSTRAINT announcements_title_check CHECK (char_length(title) BETWEEN 1 AND 120),
    CONSTRAINT announcements_body_check CHECK (char_length(body) <= 10000),
    CONSTRAINT announcements_period_check CHECK (ends_at > starts_at)
);

CREATE INDEX announcements_by_start ON announcements (org_id, starts_at DESC);

COMMENT ON TABLE announcements IS 'Announcements administrators publish: to everyone in the organization when workspace_id is NULL, otherwise to everyone who can enter that workspace. Shown in the banner while in effect and in the bell from their start until deleted.';
COMMENT ON COLUMN announcements.id IS 'Announcement id.';
COMMENT ON COLUMN announcements.org_id IS 'Organization the announcement belongs to.';
COMMENT ON COLUMN announcements.workspace_id IS 'Workspace whose members it is for; NULL for a system announcement, for the whole organization.';
COMMENT ON COLUMN announcements.title IS 'One-line title, shown in the banner and the bell.';
COMMENT ON COLUMN announcements.body IS 'Full text in Markdown; HTML in it is shown as text. Empty when the title says it all.';
COMMENT ON COLUMN announcements.starts_at IS 'When it is first shown; nobody but administrators sees it before.';
COMMENT ON COLUMN announcements.ends_at IS 'When it leaves the banner and stops counting as unread; it stays in the bell as history.';
COMMENT ON COLUMN announcements.created_by IS 'Administrator who published it.';
COMMENT ON COLUMN announcements.created_at IS 'When it was published.';
COMMENT ON COLUMN announcements.updated_by IS 'Administrator who last changed or ended it; NULL until then.';
COMMENT ON COLUMN announcements.updated_at IS 'When it was last changed or ended.';

CREATE TABLE announcement_reads (
    org_id          text NOT NULL,
    announcement_id text NOT NULL,
    user_id         text NOT NULL,
    read_at         timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (announcement_id, user_id),
    FOREIGN KEY (org_id, announcement_id) REFERENCES announcements (org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, user_id) REFERENCES users (org_id, id)
);

COMMENT ON TABLE announcement_reads IS 'Who has read which announcement: one row per person and announcement, kept when the announcement is edited and deleted with it.';
COMMENT ON COLUMN announcement_reads.org_id IS 'Organization the announcement and the person belong to.';
COMMENT ON COLUMN announcement_reads.announcement_id IS 'Announcement that was read.';
COMMENT ON COLUMN announcement_reads.user_id IS 'Person who read it.';
COMMENT ON COLUMN announcement_reads.read_at IS 'When they marked it read, from the banner or the bell.';

ALTER TABLE system_settings
    ADD COLUMN notification_refresh_seconds integer,
    ADD CONSTRAINT system_settings_notification_refresh_seconds_check CHECK (notification_refresh_seconds BETWEEN 10 AND 3600);

COMMENT ON COLUMN system_settings.notification_refresh_seconds IS 'How often, in seconds, an open page reads the bell''s badge and the banner; NULL follows the default.';
