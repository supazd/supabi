package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// EmailSettings are the SMTP server an organization sends email through,
// which a system administrator sets: .agents/design/email.md 3. Email is off
// while Host or FromAddress is empty.
type EmailSettings struct {
	Host string
	// Port is 0 to follow the encryption.
	Port int
	// Security is starttls, tls or none.
	Security string
	// Username is empty to use the server without signing in.
	Username string
	// Password is sealed with the secret key; nil when there is none.
	Password    []byte
	FromAddress string
	// FromName is empty to follow the default.
	FromName string
}

// DefaultEmailSecurity is the encryption of an organization that never saved
// its email settings.
const DefaultEmailSecurity = "starttls"

// GetEmailSettings reads the settings anew, so that a change applies at
// once on every instance. An organization without a row has email off.
func GetEmailSettings(ctx context.Context, pool *pgxpool.Pool, orgID string) (EmailSettings, error) {
	var v EmailSettings
	err := pool.QueryRow(ctx, `SELECT coalesce(smtp_host, ''), coalesce(smtp_port, 0), smtp_security, coalesce(smtp_username, ''),
 smtp_password, coalesce(from_address, ''), coalesce(from_name, '') FROM email_settings WHERE org_id = $1`, orgID).
		Scan(&v.Host, &v.Port, &v.Security, &v.Username, &v.Password, &v.FromAddress, &v.FromName)
	if errors.Is(err, pgx.ErrNoRows) {
		return EmailSettings{Security: DefaultEmailSecurity}, nil
	}
	return v, err
}

// SetEmailSettings replaces the settings. With keepPassword the stored
// password stays as it is, which the settings never carry back in the clear.
func SetEmailSettings(ctx context.Context, pool *pgxpool.Pool, s Scope, v EmailSettings, keepPassword bool) error {
	_, err := pool.Exec(ctx, `INSERT INTO email_settings (org_id, smtp_host, smtp_port, smtp_security, smtp_username, smtp_password,
 from_address, from_name, updated_by)
 VALUES ($1, NULLIF($2, ''), NULLIF($3::integer, 0), $4, NULLIF($5, ''), $6, NULLIF($7, ''), NULLIF($8, ''), $9)
 ON CONFLICT (org_id) DO UPDATE SET smtp_host = EXCLUDED.smtp_host, smtp_port = EXCLUDED.smtp_port,
 smtp_security = EXCLUDED.smtp_security, smtp_username = EXCLUDED.smtp_username,
 smtp_password = CASE WHEN $10::boolean THEN email_settings.smtp_password ELSE EXCLUDED.smtp_password END,
 from_address = EXCLUDED.from_address, from_name = EXCLUDED.from_name, updated_by = EXCLUDED.updated_by, updated_at = now()`,
		s.OrgID, v.Host, v.Port, v.Security, v.Username, v.Password, v.FromAddress, v.FromName, s.actor(), keepPassword)
	return translate(err)
}
