package config

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/supazd/supabi/internal/role"
)

// clearEnv unsets the SUPABI_* variables of the shell running the tests: an
// empty variable counts as unset.
func clearEnv(t *testing.T) {
	for _, kv := range os.Environ() {
		if name, _, _ := strings.Cut(kv, "="); strings.HasPrefix(name, "SUPABI_") {
			t.Setenv(name, "")
		}
	}
}

func writeFile(t *testing.T, content string) string {
	path := filepath.Join(t.TempDir(), "supabi.yaml")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestConfigFile(t *testing.T) {
	clearEnv(t)
	file := writeFile(t, `
database-url: postgres://file/supabi
secret-key: file-key
roles: api, worker
http-addr: 0.0.0.0:9090
auto-migrate: false
export-workers: 3
query-cache-size: 1GB
redis-key-prefix: ""
s3-region:
log-level: debug
`)
	cfg, err := Load("serve", []string{"--config", file})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DatabaseURL != "postgres://file/supabi" || cfg.SecretKey != "file-key" || !slices.Equal(cfg.Roles, []role.Role{role.API, role.Worker}) ||
		cfg.HTTPAddr != "0.0.0.0:9090" || cfg.AutoMigrate || cfg.ExportWorkers != 3 || cfg.QueryCacheSize != 1<<30 ||
		cfg.RedisKeyPrefix != "" || cfg.S3Region != "us-east-1" || cfg.LogLevel != slog.LevelDebug || cfg.File != file || cfg.Overridden != nil {
		t.Errorf("from the file: %+v", cfg)
	}

	// A variable wins over the file, and a flag over both.
	t.Setenv("SUPABI_HTTP_ADDR", "127.0.0.1:7070")
	t.Setenv("SUPABI_LOG_LEVEL", "warn")
	t.Setenv("SUPABI_EXPORT_WORKERS", "4")
	cfg, err = Load("serve", []string{"--config", file, "--log-level=error", "--roles=scheduler"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.HTTPAddr != "127.0.0.1:7070" || cfg.LogLevel != slog.LevelError || !slices.Equal(cfg.Roles, []role.Role{role.Scheduler}) || cfg.ExportWorkers != 4 || cfg.DatabaseURL != "postgres://file/supabi" {
		t.Errorf("overridden: %+v", cfg)
	}
	want := []Override{{"roles", "--roles"}, {"http-addr", "SUPABI_HTTP_ADDR"}, {"export-workers", "SUPABI_EXPORT_WORKERS"}, {"log-level", "--log-level"}}
	if !slices.Equal(cfg.Overridden, want) {
		t.Errorf("overridden = %v, want %v", cfg.Overridden, want)
	}
}

func TestConfigFileFromEnvironment(t *testing.T) {
	clearEnv(t)
	t.Setenv("SUPABI_CONFIG", writeFile(t, "database-url: postgres://env-file/supabi\n"))
	if cfg, err := Load("migrate", nil); err != nil || cfg.DatabaseURL != "postgres://env-file/supabi" {
		t.Errorf("SUPABI_CONFIG: %+v, %v", cfg, err)
	}
	file := writeFile(t, "database-url: postgres://flag-file/supabi\n")
	if cfg, err := Load("migrate", []string{"--config=" + file}); err != nil || cfg.DatabaseURL != "postgres://flag-file/supabi" || cfg.File != file {
		t.Errorf("--config wins: %+v, %v", cfg, err)
	}
}

func TestConfigFileErrors(t *testing.T) {
	clearEnv(t)
	for content, want := range map[string]string{
		"database-url: postgres://x\nexprot-workers: 4\n": `:2: unknown setting "exprot-workers"`,
		"exprot-workers:\n":           `:1: unknown setting "exprot-workers"`,
		"config: other.yaml\n":        `:1: unknown setting "config"`,
		"roles: api\nroles: worker\n": ":2: roles is already set on line 1",
		"roles: [api, worker]\n":      ":1: roles takes a single value",
		"export-workers: two\n":       `:1: invalid value "two" for export-workers`,
		"auto-migrate: yes\n":         `:1: invalid value "yes" for auto-migrate`,
		"- database-url\n":            ":1: write each setting as a line of key: value",
		"database-url: [\n":           "yaml:",
	} {
		if _, err := Load("serve", []string{"--config", writeFile(t, content)}); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%q: %v, want %q", content, err, want)
		}
	}
	if _, err := Load("serve", []string{"--config", filepath.Join(t.TempDir(), "missing.yaml")}); err == nil || !strings.Contains(err.Error(), "no such file") {
		t.Errorf("missing file: %v", err)
	}

	t.Setenv("SUPABI_DATABASE_URL", "postgres://localhost/supabi")
	for _, content := range []string{"", "# only a comment\n"} {
		if cfg, err := Load("serve", []string{"--config", writeFile(t, content)}); err != nil || cfg.HTTPAddr != "127.0.0.1:8080" {
			t.Errorf("%q: %+v, %v", content, cfg, err)
		}
	}
}

func TestEnvironment(t *testing.T) {
	clearEnv(t)
	t.Setenv("SUPABI_DATABASE_URL", "postgres://localhost/supabi")
	for name, value := range map[string]string{"SUPABI_S3_PATH_STYLE": "maybe", "SUPABI_AUTO_MIGRATE": "flase", "SUPABI_EXPORT_WORKERS": "two"} {
		t.Run(name, func(t *testing.T) {
			t.Setenv(name, value)
			if _, err := Load("serve", nil); err == nil || !strings.Contains(err.Error(), fmt.Sprintf("invalid value %q for %s", value, name)) {
				t.Errorf("%v", err)
			}
		})
	}
	// An empty variable is unset, so the default applies.
	t.Setenv("SUPABI_REDIS_KEY_PREFIX", "")
	t.Setenv("SUPABI_EXPORT_WORKERS", "")
	t.Setenv("SUPABI_SECRET_KEY", "env-key")
	cfg, err := Load("serve", nil)
	if err != nil || cfg.RedisKeyPrefix != "supabi:" || cfg.ExportWorkers != 2 || cfg.SecretKey != "env-key" {
		t.Errorf("%+v, %v", cfg, err)
	}
}

// TestExample checks that the example config has every setting once, and
// that with its commented settings taken in it gives the defaults it states.
func TestExample(t *testing.T) {
	clearEnv(t)
	t.Setenv("SUPABI_DATABASE_URL", "postgres://localhost/supabi")
	keys := define("serve", &raw{}).keys()
	setting := regexp.MustCompile(`^(# )?([a-z0-9-]+):`)
	count := map[string]int{}
	var lines []string
	for _, line := range strings.Split(Example, "\n") {
		if m := setting.FindStringSubmatch(line); m != nil && slices.Contains(keys, m[2]) {
			count[m[2]]++
			line = strings.TrimPrefix(line, "# ")
		}
		lines = append(lines, line)
	}
	name := regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)
	for _, key := range keys {
		if !name.MatchString(key) {
			t.Errorf("%s: a setting is lowercase words joined by hyphens, for its variable to be %s", key, envName(key))
		}
		if count[key] != 1 {
			t.Errorf("%s is in the example %d times, want once", key, count[key])
		}
	}
	got, err := Load("serve", []string{"--config", writeFile(t, strings.Join(lines, "\n"))})
	if err != nil {
		t.Fatal(err)
	}
	want, err := Load("serve", nil)
	if err != nil {
		t.Fatal(err)
	}
	got.File = ""
	if !reflect.DeepEqual(got, want) {
		t.Errorf("the example's values are not the defaults:\n got %+v\nwant %+v", got, want)
	}
}

func TestQueryCacheSettings(t *testing.T) {
	clearEnv(t)
	t.Setenv("SUPABI_DATABASE_URL", "postgres://localhost/supabi")
	cfg, err := Load("serve", nil)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.QueryCache != "memory" || cfg.QueryCacheSize != 256<<20 || cfg.RedisKeyPrefix != "supabi:" {
		t.Errorf("defaults: %+v", cfg)
	}
	cfg, err = Load("serve", []string{"--query-cache=redis", "--redis-url=redis://localhost:6379/0", "--query-cache-size=1gb"})
	if err != nil || cfg.QueryCache != "redis" || cfg.QueryCacheSize != 1<<30 {
		t.Errorf("redis: %+v, %v", cfg, err)
	}
	for args, want := range map[string]string{
		"--query-cache=redis":     "needs a Redis",
		"--query-cache=disk":      "invalid query cache",
		"--query-cache-size=0":    "invalid query cache size",
		"--query-cache-size=lots": "invalid query cache size",
		"--query-cache-size=-5MB": "invalid query cache size",
	} {
		if _, err := Load("serve", strings.Fields(args)); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: %v, want %q", args, err, want)
		}
	}
}

func TestExportStorageSettings(t *testing.T) {
	clearEnv(t)
	t.Setenv("SUPABI_DATABASE_URL", "postgres://localhost/supabi")
	cfg, err := Load("serve", nil)
	if err != nil || cfg.ExportStorage != "local" || cfg.S3Region != "us-east-1" || cfg.S3PathStyle {
		t.Fatalf("defaults: %+v, %v", cfg, err)
	}
	t.Setenv("SUPABI_S3_ACCESS_KEY_ID", "key")
	t.Setenv("SUPABI_S3_SECRET_ACCESS_KEY", "secret")
	cfg, err = Load("serve", []string{"--export-storage=s3", "--s3-bucket=exports", "--s3-endpoint=http://127.0.0.1:19100", "--s3-path-style", "--s3-prefix=prod/"})
	if err != nil || cfg.S3Bucket != "exports" || !cfg.S3PathStyle || cfg.S3Prefix != "prod/" || cfg.S3AccessKeyID != "key" || cfg.S3SecretAccessKey != "secret" {
		t.Fatalf("s3: %+v, %v", cfg, err)
	}
	t.Setenv("SUPABI_S3_SECRET_ACCESS_KEY", "")
	for args, want := range map[string]string{
		"--export-storage=s3 --s3-bucket=exports": "set both",
		"--export-storage=s3":                     "needs a bucket",
		"--export-storage=disk":                   "invalid export storage",
	} {
		if _, err := Load("serve", strings.Fields(args)); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: %v, want %q", args, err, want)
		}
	}
}

// The settings now in the system settings stop the start wherever they are
// given, rather than seem to apply.
func TestMovedSettings(t *testing.T) {
	clearEnv(t)
	t.Setenv("SUPABI_DATABASE_URL", "postgres://localhost/supabi")
	for _, args := range [][]string{{"--export-max-rows=1000"}, {"-audit-retention", "0"}, {"--roles=api", "--query-cache-ttl", "1h"}} {
		if _, err := Load("serve", args); err == nil || !strings.Contains(err.Error(), "is now set in System administration > General") {
			t.Errorf("%v: %v", args, err)
		}
	}
	file := writeFile(t, "roles: api\nexport-timeout: 15m\n")
	if _, err := Load("serve", []string{"--config", file}); err == nil || !strings.Contains(err.Error(), ":2: export-timeout is now set in System administration > General") {
		t.Errorf("in the file: %v", err)
	}
	t.Setenv("SUPABI_EXPORT_RETENTION", "48h")
	if _, err := Load("serve", nil); err == nil || !strings.Contains(err.Error(), "SUPABI_EXPORT_RETENTION is now set in System administration > General") {
		t.Errorf("as a variable: %v", err)
	}
}

// --yes is a flag of clear-secrets only, and no setting.
func TestClearSecretsFlag(t *testing.T) {
	clearEnv(t)
	t.Setenv("SUPABI_DATABASE_URL", "postgres://localhost/supabi")
	if cfg, err := Load("clear-secrets", []string{"--yes"}); err != nil || !cfg.Yes {
		t.Errorf("clear-secrets --yes: %+v, %v", cfg, err)
	}
	if cfg, err := Load("clear-secrets", nil); err != nil || cfg.Yes {
		t.Errorf("clear-secrets: %+v, %v", cfg, err)
	}
	if _, err := Load("serve", []string{"--yes"}); err == nil {
		t.Error("serve took --yes")
	}
	if _, err := Load("clear-secrets", []string{"--config", writeFile(t, "yes: true\n")}); err == nil || !strings.Contains(err.Error(), `unknown setting "yes"`) {
		t.Errorf("yes in the file: %v", err)
	}
}
