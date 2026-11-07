// Package app is the program: its command line, and the roles it runs.
package app

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"slices"
	"sync"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/supazd/supabi/internal/api"
	"github.com/supazd/supabi/internal/assistant"
	"github.com/supazd/supabi/internal/audit"
	"github.com/supazd/supabi/internal/blob"
	"github.com/supazd/supabi/internal/buildinfo"
	"github.com/supazd/supabi/internal/config"
	"github.com/supazd/supabi/internal/datasource"
	_ "github.com/supazd/supabi/internal/datasource/clickhouse" // registers the driver
	_ "github.com/supazd/supabi/internal/datasource/mysql"      // registers the driver
	_ "github.com/supazd/supabi/internal/datasource/postgres"   // registers the driver
	_ "github.com/supazd/supabi/internal/datasource/trino"      // registers the driver
	"github.com/supazd/supabi/internal/exports"
	"github.com/supazd/supabi/internal/llm"
	"github.com/supazd/supabi/internal/qcache"
	"github.com/supazd/supabi/internal/role"
	"github.com/supazd/supabi/internal/scheduler"
	"github.com/supazd/supabi/internal/secret"
	"github.com/supazd/supabi/internal/server"
	"github.com/supazd/supabi/internal/source"
	"github.com/supazd/supabi/internal/store"
	"github.com/supazd/supabi/internal/worker"
)

const usage = `Usage:
  supabi serve [flags]     run the server (see "supabi serve -h")
  supabi migrate [flags]   apply pending schema migrations and exit
  supabi clear-secrets [flags]
                           remove the stored passwords and API keys after the
                           secret-key was lost (see "supabi clear-secrets -h")
  supabi example-config    print a config file with every setting, for --config
  supabi generate-key      print a new value for secret-key
  supabi version           print version information
`

// Main runs the command line and returns the process exit code.
func Main(args []string) int {
	if len(args) == 0 {
		fmt.Fprint(os.Stderr, usage)
		return 2
	}
	switch args[0] {
	case "serve", "migrate", "clear-secrets":
		cfg, err := config.Load(args[0], args[1:])
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, "supabi:", err)
			return 2
		}
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		run := Run
		switch args[0] {
		case "migrate":
			run = Migrate
		case "clear-secrets":
			run = ClearSecrets
		}
		if err := run(ctx, cfg, os.Stderr); err != nil {
			fmt.Fprintln(os.Stderr, "supabi:", err)
			return 1
		}
		return 0
	case "example-config":
		fmt.Print(config.Example)
		return 0
	case "generate-key":
		fmt.Println(secret.GenerateKey())
		return 0
	case "version":
		fmt.Printf("supabi %s (%s)\n", buildinfo.Version, buildinfo.Commit)
		return 0
	case "-h", "--help", "help":
		fmt.Print(usage)
		return 0
	default:
		fmt.Fprintf(os.Stderr, "supabi: unknown command %q\n\n%s", args[0], usage)
		return 2
	}
}

type runner interface {
	Run(ctx context.Context) error
}

// Migrate brings the metadata database up to date and returns.
func Migrate(ctx context.Context, cfg config.Config, logOut io.Writer) error {
	logger := newLogger(cfg, logOut)
	logConfig(logger, cfg)
	pool, err := store.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	return migrate(ctx, pool, logger)
}

func migrate(ctx context.Context, pool *pgxpool.Pool, logger *slog.Logger) error {
	applied, err := store.Migrate(ctx, pool, store.CoreMigrations())
	if err != nil {
		return err
	}
	if err := store.Bootstrap(ctx, pool); err != nil {
		return err
	}
	logger.Info("database schema is up to date", "applied", applied)
	return nil
}

// ClearSecrets removes the stored secrets, for an installation that lost
// the key they were sealed with to start with a new one; without --yes it
// only says what it would remove. See .agents/design/configuration.md 11.
func ClearSecrets(ctx context.Context, cfg config.Config, out io.Writer) error {
	pool, err := store.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	if !cfg.Yes {
		n, err := store.CountSecrets(ctx, pool)
		if err != nil {
			return err
		}
		fmt.Fprintf(out, `This would remove the passwords of %d data sources and the API keys of %d AI
providers, for administrators to enter them again. Stop every instance
first: one still running seals new secrets with the old key.
Run again with --yes to remove them.
`, n.Datasources, n.AIProviders)
		return nil
	}
	n, err := store.ClearSecrets(ctx, pool)
	if err != nil {
		return err
	}
	fmt.Fprintf(out, `Removed the passwords of %d data sources and the API keys of %d AI providers.
Start with the new secret-key, then enter them again.
`, n.Datasources, n.AIProviders)
	return nil
}

// Run starts the configured roles and blocks until ctx is cancelled or one of
// them fails; in both cases the remaining roles are stopped before returning.
func Run(ctx context.Context, cfg config.Config, logOut io.Writer) error {
	logger := newLogger(cfg, logOut)
	logger.Info("starting supabi", "version", buildinfo.Version, "roles", cfg.Roles)
	logConfig(logger, cfg)

	pool, err := store.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	if cfg.AutoMigrate {
		if err := migrate(ctx, pool, logger); err != nil {
			return err
		}
	}

	if cfg.SecretKey == "" {
		return errors.New("secret-key is required: it encrypts stored database passwords. Create one with `supabi generate-key`, set it in the config file or as SUPABI_SECRET_KEY, and keep it safe; without it they cannot be read back")
	}
	secrets, err := secret.NewBox(cfg.SecretKey)
	if err != nil {
		return err
	}
	if err := store.CheckSecretKey(ctx, pool, secrets); err != nil {
		return err
	}
	conns := datasource.NewManager()
	defer conns.Close()
	// Only interactive API queries use the result cache; exports stream to disk.
	var cache *qcache.Cache
	if slices.Contains(cfg.Roles, role.API) {
		var closeCache func()
		if cache, closeCache, err = openQueryCache(ctx, cfg, logger); err != nil {
			return err
		}
		defer closeCache()
	}
	// Only the roles that write and serve export files need their store.
	var files blob.Store
	if slices.Contains(cfg.Roles, role.API) || slices.Contains(cfg.Roles, role.Worker) {
		if files, err = openExportFiles(ctx, cfg, logger); err != nil {
			return err
		}
	}
	exportService := &exports.Service{Pool: pool, Files: files, Sources: source.Connections{Pool: pool, Secrets: secrets, Conns: conns}}
	// Events go to the metadata database for the audit page, and to the log
	// for collectors to ship elsewhere.
	recorder := audit.Recorders{store.AuditEvents{Pool: pool}, audit.Log{Logger: logger}}
	apiServer := &api.Server{
		Exports: exportService,
		Pool:    pool, Secrets: secrets, Conns: conns, Logger: logger,
		Logins:    &store.LoginThrottle{Pool: pool, Max: 5, Window: 5 * time.Minute},
		Cache:     cache,
		Audit:     recorder,
		Assistant: &assistant.Service{Pool: pool, Secrets: secrets, LLM: &llm.Client{}, Logger: logger},
	}
	// Chart exports run charts as their owners would on a dashboard.
	exportService.Charts = apiServer

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	var (
		wg       sync.WaitGroup
		mu       sync.Mutex
		firstErr error
	)
	for _, r := range cfg.Roles {
		var run runner
		switch r {
		case role.API:
			run = server.New(cfg.HTTPAddr, cfg.ShutdownTimeout, cfg.HTTPMaxBodySize, apiServer.Register, pool.Ping, logger)
		case role.Worker:
			run = &worker.Worker{Pool: pool, Exports: exportService, Logger: logger, Concurrency: cfg.ExportWorkers, Audit: recorder}
		case role.Scheduler:
			run = &scheduler.Scheduler{Pool: pool, Logger: logger}
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := run.Run(ctx); err != nil {
				mu.Lock()
				if firstErr == nil {
					firstErr = fmt.Errorf("%s: %w", r, err)
				}
				mu.Unlock()
				cancel()
			}
		}()
	}
	wg.Wait()
	logger.Info("stopped")
	return firstErr
}

// openExportFiles sets up where export files are kept. An S3 bucket that
// cannot be reached stops the start: every export would fail.
func openExportFiles(ctx context.Context, cfg config.Config, logger *slog.Logger) (blob.Store, error) {
	if cfg.ExportStorage != "s3" {
		dir := filepath.Join(cfg.DataDir, "exports")
		logger.Info("export storage", "store", "local", "directory", dir)
		return blob.NewLocal(dir), nil
	}
	files, err := blob.OpenS3(ctx, blob.S3Config{
		Endpoint: cfg.S3Endpoint, Region: cfg.S3Region, Bucket: cfg.S3Bucket, Prefix: cfg.S3Prefix, PathStyle: cfg.S3PathStyle,
		AccessKeyID: cfg.S3AccessKeyID, SecretAccessKey: cfg.S3SecretAccessKey,
	}, "exports/")
	if err != nil {
		return nil, fmt.Errorf("export storage: %w", err)
	}
	logger.Info("export storage", "store", "s3", "endpoint", cfg.S3Endpoint, "bucket", cfg.S3Bucket, "prefix", cfg.S3Prefix)
	return files, nil
}

// openQueryCache sets up where query results are kept. Redis being down is
// reported but does not stop the process: queries then go to the data sources.
func openQueryCache(ctx context.Context, cfg config.Config, logger *slog.Logger) (*qcache.Cache, func(), error) {
	switch cfg.QueryCache {
	case "redis":
		store, err := qcache.NewRedis(cfg.RedisURL, cfg.RedisKeyPrefix)
		if err != nil {
			return nil, nil, fmt.Errorf("redis url: %w", err)
		}
		if err := store.Ping(ctx); err != nil {
			logger.Warn("redis does not answer; query results are not kept until it does", "error", err)
		}
		logger.Info("query cache", "store", "redis")
		return qcache.New(store, logger), func() { _ = store.Close() }, nil
	case "off":
		logger.Info("query cache", "store", "off")
		return qcache.New(nil, logger), func() {}, nil
	}
	logger.Info("query cache", "store", "memory", "size", cfg.QueryCacheSize)
	return qcache.New(qcache.NewMemory(cfg.QueryCacheSize), logger), func() {}, nil
}

// logConfig names the config file that was read, and each of its settings
// that the environment or a flag replaced, so that an edit of the file which
// seems to do nothing can be explained. Values are left out: some are secrets.
func logConfig(logger *slog.Logger, cfg config.Config) {
	if cfg.File == "" {
		return
	}
	logger.Info("read config file", "path", cfg.File)
	for _, o := range cfg.Overridden {
		logger.Info("config file setting overridden", "key", o.Key, "by", o.By)
	}
}

func newLogger(cfg config.Config, out io.Writer) *slog.Logger {
	opts := &slog.HandlerOptions{Level: cfg.LogLevel}
	if cfg.LogFormat == "json" {
		return slog.New(slog.NewJSONHandler(out, opts))
	}
	return slog.New(slog.NewTextHandler(out, opts))
}
