-- The SMTP server an organization sends email through, set by system
-- administrators: .agents/design/email.md 3.

CREATE TABLE email_settings (
    org_id        text NOT NULL,
    smtp_host     text,
    smtp_port     integer,
    smtp_security text DEFAULT 'starttls' NOT NULL,
    smtp_username text,
    smtp_password bytea,
    from_address  text,
    from_name     text,
    updated_by    text,
    updated_at    timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (org_id),
    FOREIGN KEY (org_id) REFERENCES orgs (id),
    FOREIGN KEY (org_id, updated_by) REFERENCES users (org_id, id),
    CONSTRAINT email_settings_smtp_port_check CHECK (smtp_port BETWEEN 1 AND 65535),
    CONSTRAINT email_settings_smtp_security_check CHECK (smtp_security IN ('starttls', 'tls', 'none')),
    CONSTRAINT email_settings_smtp_password_check CHECK (smtp_password IS NULL OR smtp_username IS NOT NULL)
);

COMMENT ON TABLE email_settings IS 'The SMTP server each organization sends email through, one row per organization; email is off while it has no host or no sender address. Read anew for every message, so a change applies at once on every instance.';
COMMENT ON COLUMN email_settings.org_id IS 'Organization the settings belong to.';
COMMENT ON COLUMN email_settings.smtp_host IS 'Host name or IP address of the SMTP server; NULL turns email off.';
COMMENT ON COLUMN email_settings.smtp_port IS 'Port of the SMTP server; NULL follows the encryption: 587 for starttls, 465 for tls, 25 for none.';
COMMENT ON COLUMN email_settings.smtp_security IS 'starttls asks the server to encrypt after connecting and fails if it cannot; tls encrypts from the start; none sends in plain text, without signing in.';
COMMENT ON COLUMN email_settings.smtp_username IS 'Name to sign in to the server with; NULL does not sign in.';
COMMENT ON COLUMN email_settings.smtp_password IS 'Password to sign in with, sealed with the secret key; NULL when there is none.';
COMMENT ON COLUMN email_settings.from_address IS 'Address messages are sent from; required while a host is set.';
COMMENT ON COLUMN email_settings.from_name IS 'Name shown with the sender address; NULL follows the default, SupaBI.';
COMMENT ON COLUMN email_settings.updated_by IS 'User who last changed the settings.';
COMMENT ON COLUMN email_settings.updated_at IS 'When the settings were last changed.';
