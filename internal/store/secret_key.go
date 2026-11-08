package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The secret key seals the passwords of data sources, the API keys of AI
// providers and the password of the email server. Every instance must hold
// the same one: .agents/design/configuration.md 11.

// ErrWrongSecretKey means the stored secrets were sealed with another key.
var ErrWrongSecretKey = errors.New("secret-key is not the key this database was set up with; start every instance with the same secret-key")

// Sealer seals and opens secrets with the key of an instance.
type Sealer interface {
	Seal(plaintext string) []byte
	Open(sealed []byte) (string, error)
}

const keyCheckText = "supabi secret-key check"

// CheckSecretKey is ErrWrongSecretKey unless key opens what the key the
// database was set up with sealed. A database without a check value gets one,
// once the key opens a secret already stored, if there is any.
func CheckSecretKey(ctx context.Context, pool *pgxpool.Pool, key Sealer) error {
	var sealed []byte
	err := pool.QueryRow(ctx, `SELECT sealed FROM secret_key_check`).Scan(&sealed)
	if errors.Is(err, pgx.ErrNoRows) {
		var stored []byte
		err = pool.QueryRow(ctx, `SELECT secret FROM datasources WHERE secret IS NOT NULL
 UNION ALL SELECT api_key FROM ai_providers WHERE api_key IS NOT NULL
 UNION ALL SELECT smtp_password FROM email_settings WHERE smtp_password IS NOT NULL LIMIT 1`).Scan(&stored)
		switch {
		case err == nil:
			if _, err := key.Open(stored); err != nil {
				return ErrWrongSecretKey
			}
		case !errors.Is(err, pgx.ErrNoRows):
			return err
		}
		// Of two instances starting at once, the first to write sets the check.
		if _, err := pool.Exec(ctx, `INSERT INTO secret_key_check (sealed) VALUES ($1) ON CONFLICT DO NOTHING`, key.Seal(keyCheckText)); err != nil {
			return err
		}
		err = pool.QueryRow(ctx, `SELECT sealed FROM secret_key_check`).Scan(&sealed)
	}
	if err != nil {
		return err
	}
	if text, err := key.Open(sealed); err != nil || text != keyCheckText {
		return ErrWrongSecretKey
	}
	return nil
}

// StoredSecrets counts the data sources with a password, the AI providers
// with an API key and the organizations whose email server has a password.
type StoredSecrets struct {
	Datasources, AIProviders, EmailServers int64
}

func CountSecrets(ctx context.Context, pool *pgxpool.Pool) (StoredSecrets, error) {
	var n StoredSecrets
	err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM datasources WHERE secret IS NOT NULL),
 (SELECT count(*) FROM ai_providers WHERE api_key IS NOT NULL),
 (SELECT count(*) FROM email_settings WHERE smtp_password IS NOT NULL)`).Scan(&n.Datasources, &n.AIProviders, &n.EmailServers)
	return n, err
}

// ClearSecrets removes every secret and the check of the key that sealed
// them, for an installation that lost its key to start with a new one. The
// data sources, providers and email settings stay, to be given their secrets
// again.
func ClearSecrets(ctx context.Context, pool *pgxpool.Pool) (StoredSecrets, error) {
	var n StoredSecrets
	err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		// A new version also drops connections opened with the old password.
		tag, err := tx.Exec(ctx, `UPDATE datasources SET secret = NULL, updated_at = now() WHERE secret IS NOT NULL`)
		if err != nil {
			return err
		}
		n.Datasources = tag.RowsAffected()
		if tag, err = tx.Exec(ctx, `UPDATE ai_providers SET api_key = NULL, updated_at = now() WHERE api_key IS NOT NULL`); err != nil {
			return err
		}
		n.AIProviders = tag.RowsAffected()
		if tag, err = tx.Exec(ctx, `UPDATE email_settings SET smtp_password = NULL, updated_at = now() WHERE smtp_password IS NOT NULL`); err != nil {
			return err
		}
		n.EmailServers = tag.RowsAffected()
		_, err = tx.Exec(ctx, `DELETE FROM secret_key_check`)
		return err
	})
	return n, err
}
