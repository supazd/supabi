// Package testdb gives tests an isolated place in a real PostgreSQL.
package testdb

import (
	"context"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/supazd/supabi/internal/id"
)

// DB is a fresh schema that is dropped when the test ends.
type DB struct {
	// Pool is confined to the schema through its search_path.
	Pool   *pgxpool.Pool
	Schema string
	// Admin is not confined; use it with schema-qualified names.
	Admin *pgxpool.Pool
	URL   *url.URL
}

// New skips the test unless SUPABI_TEST_DATABASE_URL is set. Run tests with
// `make test`, which sets it.
func New(t *testing.T) *DB {
	t.Helper()
	raw := os.Getenv("SUPABI_TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("SUPABI_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := pgxpool.ParseConfig(raw)
	if err != nil {
		t.Fatal(err)
	}
	admin, err := pgxpool.NewWithConfig(ctx, cfg.Copy())
	if err != nil {
		t.Fatal(err)
	}
	schema := id.New("test")
	if _, err := admin.Exec(ctx, `CREATE SCHEMA `+schema); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		_, _ = admin.Exec(ctx, `DROP SCHEMA `+schema+` CASCADE`)
		admin.Close()
	})
	return &DB{Pool: pool, Schema: schema, Admin: admin, URL: u}
}

// Settings returns the connection settings of the test database in the form
// the postgres data source driver takes, and its password.
func (db *DB) Settings() (map[string]string, string) {
	password, _ := db.URL.User.Password()
	return map[string]string{
		"host":     db.URL.Hostname(),
		"port":     db.URL.Port(),
		"database": strings.TrimPrefix(db.URL.Path, "/"),
		"user":     db.URL.User.Username(),
		"sslmode":  "disable",
	}, password
}
