package store

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"regexp"
	"slices"
	"strconv"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var coreFS embed.FS

// Source is a named set of migration files. Each source is versioned
// independently; the program has one, the core schema.
type Source struct {
	Name string
	// FS holds files named NNNN_description.sql at its root.
	FS fs.FS
}

// CoreMigrations is the schema of the metadata database.
func CoreMigrations() Source {
	sub, err := fs.Sub(coreFS, "migrations")
	if err != nil {
		panic(err) // the directory is embedded at build time
	}
	return Source{Name: "core", FS: sub}
}

// Arbitrary constant identifying the migration lock in pg_advisory_lock.
const migrationLockKey = 7153_2046_8891

var migrationFile = regexp.MustCompile(`^(\d+)_(.+)\.sql$`)

type migration struct {
	version  int
	name     string
	sql      string
	checksum string
}

// Migrate applies pending migrations of each source in order and returns how
// many it applied. Migrations are forward-only. It is safe to call from many
// processes at once: an advisory lock makes them take turns.
func Migrate(ctx context.Context, pool *pgxpool.Pool, sources ...Source) (int, error) {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return 0, err
	}
	defer conn.Release()

	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock($1)`, int64(migrationLockKey)); err != nil {
		return 0, fmt.Errorf("acquire migration lock: %w", err)
	}
	defer func() {
		// Use a fresh context so the lock is released even when ctx was cancelled.
		_, _ = conn.Exec(context.WithoutCancel(ctx), `SELECT pg_advisory_unlock($1)`, int64(migrationLockKey))
	}()

	if _, err := conn.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			source     text NOT NULL,
			version    integer NOT NULL,
			name       text NOT NULL,
			checksum   text NOT NULL,
			applied_at timestamptz NOT NULL DEFAULT now(),
			PRIMARY KEY (source, version)
		)`); err != nil {
		return 0, fmt.Errorf("create schema_migrations: %w", err)
	}

	total := 0
	for _, src := range sources {
		n, err := migrateSource(ctx, conn.Conn(), src)
		total += n
		if err != nil {
			return total, fmt.Errorf("migrate %s: %w", src.Name, err)
		}
	}
	return total, nil
}

func migrateSource(ctx context.Context, conn *pgx.Conn, src Source) (int, error) {
	migrations, err := loadMigrations(src.FS)
	if err != nil {
		return 0, err
	}

	rows, err := conn.Query(ctx, `SELECT version, checksum FROM schema_migrations WHERE source = $1`, src.Name)
	if err != nil {
		return 0, err
	}
	applied := map[int]string{}
	var version int
	var checksum string
	if _, err := pgx.ForEachRow(rows, []any{&version, &checksum}, func() error {
		applied[version] = checksum
		return nil
	}); err != nil {
		return 0, err
	}

	known := map[int]migration{}
	maxApplied := 0
	for _, m := range migrations {
		known[m.version] = m
	}
	for v, sum := range applied {
		m, ok := known[v]
		if !ok {
			return 0, fmt.Errorf("database has version %d which this build does not know; it was migrated by a newer version", v)
		}
		if m.checksum != sum {
			return 0, fmt.Errorf("%04d_%s.sql was modified after it was applied; add a new migration instead", m.version, m.name)
		}
		maxApplied = max(maxApplied, v)
	}

	count := 0
	for _, m := range migrations {
		if _, done := applied[m.version]; done {
			continue
		}
		if m.version < maxApplied {
			return count, fmt.Errorf("%04d_%s.sql is older than applied version %d; migrations must be added in order", m.version, m.name, maxApplied)
		}
		if err := applyMigration(ctx, conn, src.Name, m); err != nil {
			return count, fmt.Errorf("%04d_%s.sql: %w", m.version, m.name, err)
		}
		count++
	}
	return count, nil
}

func applyMigration(ctx context.Context, conn *pgx.Conn, source string, m migration) (err error) {
	tx, err := conn.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			err = errors.Join(err, ignoreTxClosed(tx.Rollback(context.WithoutCancel(ctx))))
		}
	}()
	// No arguments, so pgx uses the simple protocol and the file may hold many statements.
	if _, err := tx.Exec(ctx, m.sql); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO schema_migrations (source, version, name, checksum) VALUES ($1, $2, $3, $4)`,
		source, m.version, m.name, m.checksum); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func ignoreTxClosed(err error) error {
	if errors.Is(err, pgx.ErrTxClosed) {
		return nil
	}
	return err
}

func loadMigrations(fsys fs.FS) ([]migration, error) {
	entries, err := fs.ReadDir(fsys, ".")
	if err != nil {
		return nil, err
	}
	var out []migration
	seen := map[int]string{}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		match := migrationFile.FindStringSubmatch(e.Name())
		if match == nil {
			return nil, fmt.Errorf("unexpected file %q: migrations must be named NNNN_description.sql", e.Name())
		}
		version, err := strconv.Atoi(match[1])
		if err != nil || version <= 0 {
			return nil, fmt.Errorf("invalid version in %q", e.Name())
		}
		if other, dup := seen[version]; dup {
			return nil, fmt.Errorf("%q and %q have the same version", other, e.Name())
		}
		seen[version] = e.Name()
		body, err := fs.ReadFile(fsys, e.Name())
		if err != nil {
			return nil, err
		}
		sum := sha256.Sum256(body)
		out = append(out, migration{version: version, name: match[2], sql: string(body), checksum: hex.EncodeToString(sum[:])})
	}
	slices.SortFunc(out, func(a, b migration) int { return a.version - b.version })
	return out, nil
}
