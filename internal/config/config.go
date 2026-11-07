// Package config loads process configuration from a YAML file, the
// environment and flags.
package config

import (
	_ "embed"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"maps"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"

	"go.yaml.in/yaml/v3"

	"github.com/supazd/supabi/internal/role"
)

// Example is a config file with every setting, as `supabi example-config`
// prints it.
//
//go:embed example.yaml
var Example string

type Config struct {
	Roles    []role.Role
	HTTPAddr string
	// HTTPMaxBodySize is the largest request body the api role reads, in
	// bytes: .agents/design/configuration.md 12.
	HTTPMaxBodySize int64
	DatabaseURL     string
	AutoMigrate     bool
	SecretKey       string
	DataDir         string
	LogLevel        slog.Level
	LogFormat       string
	ShutdownTimeout time.Duration

	ExportWorkers int
	// ExportStorage is where export files are kept: local or s3.
	ExportStorage string

	// The S3 bucket for --export-storage=s3. The keys have no flag.
	S3Endpoint, S3Region, S3Bucket, S3Prefix string
	S3PathStyle                              bool
	S3AccessKeyID, S3SecretAccessKey         string

	// QueryCache is where query results are kept: memory, redis or off.
	QueryCache     string
	QueryCacheSize int64
	RedisURL       string
	RedisKeyPrefix string

	// Yes is --yes of clear-secrets, which without it only says what it
	// would clear.
	Yes bool

	// File is the config file the settings were read from; empty when none.
	File string
	// Overridden lists the settings of File that the environment or a flag
	// replaced, in the order of the file.
	Overridden []Override
}

// moved are the settings that left the startup configuration for the system
// settings, which every instance reads from the metadata database. Given
// anyway, they stop the start rather than seem to apply:
// .agents/design/configuration.md 10.5.
var moved = []string{"export-retention", "export-timeout", "export-max-rows", "export-max-size", "audit-retention", "query-cache-ttl"}

const movedTo = "is now set in System administration > General in the web interface, the same for every instance"

// movedFlag reports a moved setting among the flags of args.
func movedFlag(args []string) error {
	for _, arg := range args {
		if arg == "--" {
			break
		}
		name, _, _ := strings.Cut(strings.TrimLeft(arg, "-"), "=")
		if strings.HasPrefix(arg, "-") && slices.Contains(moved, name) {
			return fmt.Errorf("--%s %s; remove it from the command line", name, movedTo)
		}
	}
	return nil
}

// movedVariable reports a moved setting given as an environment variable.
func movedVariable() error {
	for _, key := range moved {
		if os.Getenv(envName(key)) != "" {
			return fmt.Errorf("%s %s; unset it", envName(key), movedTo)
		}
	}
	return nil
}

// Override is a setting of the config file that By, an environment variable
// or a flag, replaced.
type Override struct {
	Key, By string
}

// raw holds the settings as their flags parse them, before they are checked.
type raw struct {
	configFile                                                 string
	roles, httpAddr, databaseURL, dataDir, logLevel, logFormat string
	httpMaxBodySize                                            string
	queryCache, queryCacheSize, redisURL, redisKeyPrefix       string
	exportStorage, s3Endpoint, s3Region, s3Bucket, s3Prefix    string
	secretKey, s3AccessKeyID, s3SecretAccessKey                string
	autoMigrate, s3PathStyle, yes                              bool
	exportWorkers                                              int64
}

// Load parses the arguments of a command. Each setting comes from its flag,
// else from its SUPABI_* environment variable, else from the config file of
// --config or SUPABI_CONFIG, else from its default.
func Load(command string, args []string) (Config, error) {
	var r raw
	s := define(command, &r)
	if err := movedFlag(args); err != nil {
		return Config{}, err
	}
	if err := s.flags.Parse(args); err != nil {
		return Config{}, err
	}
	if s.flags.NArg() > 0 {
		return Config{}, fmt.Errorf("unexpected argument %q", s.flags.Arg(0))
	}
	file := r.configFile
	if file == "" {
		file = os.Getenv("SUPABI_CONFIG")
	}
	var entries []entry
	if file != "" {
		var err error
		if entries, err = readFile(file); err != nil {
			return Config{}, err
		}
	}
	if err := movedVariable(); err != nil {
		return Config{}, err
	}
	overridden, err := s.apply(file, entries)
	if err != nil {
		return Config{}, err
	}

	cfg := Config{
		ExportWorkers: int(r.exportWorkers),
		ExportStorage: r.exportStorage,
		S3Endpoint:    r.s3Endpoint, S3Region: r.s3Region, S3Bucket: r.s3Bucket, S3Prefix: r.s3Prefix, S3PathStyle: r.s3PathStyle,
		S3AccessKeyID: r.s3AccessKeyID, S3SecretAccessKey: r.s3SecretAccessKey,
		HTTPAddr:        r.httpAddr,
		DatabaseURL:     r.databaseURL,
		AutoMigrate:     r.autoMigrate,
		SecretKey:       r.secretKey,
		DataDir:         r.dataDir,
		LogFormat:       r.logFormat,
		ShutdownTimeout: 15 * time.Second,
		QueryCache:      r.queryCache,
		RedisURL:        r.redisURL,
		RedisKeyPrefix:  r.redisKeyPrefix,
		Yes:             r.yes,
		File:            file,
		Overridden:      overridden,
	}
	if cfg.DatabaseURL == "" {
		return Config{}, errors.New("database url is required: set " + sources("database-url"))
	}
	if cfg.ExportWorkers < 1 || cfg.ExportWorkers > 32 {
		return Config{}, errors.New("export workers must be between 1 and 32")
	}
	switch cfg.ExportStorage {
	case "local":
	case "s3":
		if cfg.S3Bucket == "" || cfg.S3Region == "" {
			return Config{}, errors.New("--export-storage=s3 needs a bucket and its region: set " + sources("s3-bucket"))
		}
		if (cfg.S3AccessKeyID == "") != (cfg.S3SecretAccessKey == "") {
			return Config{}, errors.New("set both s3-access-key-id and s3-secret-access-key, in the config file or as SUPABI_S3_ACCESS_KEY_ID and SUPABI_S3_SECRET_ACCESS_KEY, or neither to use the AWS SDK's default credentials")
		}
	default:
		return Config{}, fmt.Errorf("invalid export storage %q: use local or s3", cfg.ExportStorage)
	}
	if cfg.Roles, err = role.Parse(r.roles); err != nil {
		return Config{}, err
	}
	if err := cfg.LogLevel.UnmarshalText([]byte(r.logLevel)); err != nil {
		return Config{}, fmt.Errorf("invalid log level %q", r.logLevel)
	}
	if cfg.LogFormat != "text" && cfg.LogFormat != "json" {
		return Config{}, fmt.Errorf("invalid log format %q", cfg.LogFormat)
	}
	switch cfg.QueryCache {
	case "memory", "off":
	case "redis":
		if cfg.RedisURL == "" {
			return Config{}, errors.New("--query-cache=redis needs a Redis: set " + sources("redis-url"))
		}
	default:
		return Config{}, fmt.Errorf("invalid query cache %q: use memory, redis or off", cfg.QueryCache)
	}
	if cfg.QueryCacheSize, err = parseBytes(r.queryCacheSize); err != nil {
		return Config{}, fmt.Errorf("invalid query cache size %q: %w", r.queryCacheSize, err)
	}
	if cfg.HTTPMaxBodySize, err = parseBytes(r.httpMaxBodySize); err != nil {
		return Config{}, fmt.Errorf("invalid http max body size %q: %w", r.httpMaxBodySize, err)
	}
	return cfg, nil
}

// define registers the flags of a command, which parse into r.
func define(command string, r *raw) settings {
	fs := flag.NewFlagSet(command, flag.ContinueOnError)
	fs.StringVar(&r.configFile, "config", "", "YAML file with the settings below, also given by SUPABI_CONFIG; \"supabi example-config\" prints an example")
	fs.StringVar(&r.roles, "roles", "", "comma-separated roles to run: api, worker, scheduler (default all)")
	fs.StringVar(&r.httpAddr, "http-addr", "127.0.0.1:8080", "listen address of the api role")
	fs.StringVar(&r.httpMaxBodySize, "http-max-body-size", "8MB", "largest request body the api role reads, e.g. 8MB; a larger one is refused with 413")
	fs.StringVar(&r.databaseURL, "database-url", "", "metadata database, e.g. postgres://user:pass@host:5432/supabi; set it in the config file or SUPABI_DATABASE_URL so the password stays out of the process list")
	fs.BoolVar(&r.autoMigrate, "auto-migrate", true, "apply pending schema migrations on startup")
	fs.StringVar(&r.dataDir, "data-dir", "data", "directory for export files with --export-storage=local; API and worker instances must share it")
	fs.StringVar(&r.logLevel, "log-level", "info", "debug, info, warn or error")
	fs.StringVar(&r.logFormat, "log-format", "text", "text or json")
	fs.StringVar(&r.queryCache, "query-cache", "memory", "where query results are kept: memory (each instance its own), redis (shared by all instances) or off")
	fs.StringVar(&r.queryCacheSize, "query-cache-size", "256MB", "most memory the memory cache takes, e.g. 256MB or 1GB")
	fs.StringVar(&r.redisURL, "redis-url", "", "Redis for --query-cache=redis, e.g. rediss://:password@host:6379/0; set it in the config file or SUPABI_REDIS_URL so the password stays out of the process list")
	fs.StringVar(&r.redisKeyPrefix, "redis-key-prefix", "supabi:", "prefix of every key written to Redis")
	fs.StringVar(&r.exportStorage, "export-storage", "local", "where export files are kept: local (in the data directory) or s3 (in the bucket of --s3-bucket)")
	fs.StringVar(&r.s3Endpoint, "s3-endpoint", "", "address of an S3-compatible store, e.g. https://s3.example.com; empty for AWS S3")
	fs.StringVar(&r.s3Region, "s3-region", "us-east-1", "region of the bucket, which requests are also signed for")
	fs.StringVar(&r.s3Bucket, "s3-bucket", "", "existing bucket for --export-storage=s3; its keys are s3-access-key-id and s3-secret-access-key, or else the AWS SDK's default credentials such as an IAM role")
	fs.StringVar(&r.s3Prefix, "s3-prefix", "", "prefix of every object key, for installations sharing a bucket, e.g. prod/")
	fs.BoolVar(&r.s3PathStyle, "s3-path-style", false, "address the bucket as endpoint/bucket rather than bucket.endpoint, as self-hosted stores usually need")
	fs.Int64Var(&r.exportWorkers, "export-workers", 2, "concurrent background jobs in each worker process")
	if command == "clear-secrets" {
		fs.BoolVar(&r.yes, "yes", false, "clear them; without it, only say what would be cleared")
	}
	fs.Usage = func() {
		fmt.Fprintf(fs.Output(), `Usage: supabi %s [flags]

Each setting is a flag, an environment variable, or a line of the config file
of --config. In the file it is the flag's name without the dashes, such as
"http-addr: 0.0.0.0:8080"; as a variable it is SUPABI_ and the name in
capitals with underscores, such as SUPABI_HTTP_ADDR. A flag wins over the
variable, and the variable over the file.

The secrets secret-key, s3-access-key-id and s3-secret-access-key have no
flag, as the command line would show them in the process list.

`, fs.Name())
		fs.PrintDefaults()
	}
	return settings{flags: fs, secrets: map[string]*string{
		"secret-key":           &r.secretKey,
		"s3-access-key-id":     &r.s3AccessKeyID,
		"s3-secret-access-key": &r.s3SecretAccessKey,
	}}
}

// settings sets the values of a command's flags, and of the secrets, which
// have no flag: the command line would show them in the process list.
type settings struct {
	flags   *flag.FlagSet
	secrets map[string]*string
}

// commandFlags are flags of a command run, not settings: they have no
// variable and no line in the config file.
var commandFlags = []string{"config", "yes"}

// keys lists every setting: the flags but the command's own, then the
// secrets.
func (s settings) keys() []string {
	var keys []string
	s.flags.VisitAll(func(f *flag.Flag) {
		if !slices.Contains(commandFlags, f.Name) {
			keys = append(keys, f.Name)
		}
	})
	return append(keys, slices.Sorted(maps.Keys(s.secrets))...)
}

func (s settings) known(key string) bool {
	_, secret := s.secrets[key]
	return secret || !slices.Contains(commandFlags, key) && s.flags.Lookup(key) != nil
}

func (s settings) set(key, value string) error {
	if p, ok := s.secrets[key]; ok {
		*p = value
		return nil
	}
	return s.flags.Set(key, value)
}

// apply fills in each setting not given as a flag from its environment
// variable, else from the entries of the config file, and returns the
// entries that a flag or a variable replaced. An empty variable is unset.
func (s settings) apply(file string, entries []entry) ([]Override, error) {
	byFlag, byEnv := map[string]bool{}, map[string]bool{}
	s.flags.Visit(func(f *flag.Flag) { byFlag[f.Name] = true })
	for _, key := range s.keys() {
		name := envName(key)
		if v := os.Getenv(name); v != "" && !byFlag[key] {
			if err := s.set(key, v); err != nil {
				return nil, fmt.Errorf("invalid value %q for %s: %w", v, name, err)
			}
			byEnv[key] = true
		}
	}
	var overridden []Override
	for _, e := range entries {
		switch {
		case slices.Contains(moved, e.key):
			return nil, fmt.Errorf("%s:%d: %s %s; remove it from the config file", file, e.line, e.key, movedTo)
		case !s.known(e.key):
			return nil, fmt.Errorf("%s:%d: unknown setting %q", file, e.line, e.key)
		case e.unset:
		case byFlag[e.key]:
			overridden = append(overridden, Override{e.key, "--" + e.key})
		case byEnv[e.key]:
			overridden = append(overridden, Override{e.key, envName(e.key)})
		default:
			if err := s.set(e.key, e.value); err != nil {
				return nil, fmt.Errorf("%s:%d: invalid value %q for %s: %w", file, e.line, e.value, e.key, err)
			}
		}
	}
	return overridden, nil
}

// envName is the environment variable of a setting: SUPABI_HTTP_ADDR for
// http-addr.
func envName(key string) string {
	return "SUPABI_" + strings.ToUpper(strings.ReplaceAll(key, "-", "_"))
}

// sources says where a setting is given, for messages that ask for it.
func sources(key string) string {
	return fmt.Sprintf("%s in the config file, %s or --%s", key, envName(key), key)
}

// entry is a line of the config file.
type entry struct {
	key, value string
	line       int
	// unset is a key without a value, which is as if the line were not there.
	unset bool
}

// readFile reads the settings of a config file in the order they are
// written. Values are kept as text, for the flags to parse: YAML's own idea
// of their types plays no part.
func readFile(path string) ([]entry, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("config file: %w", err)
	}
	var doc yaml.Node
	if err := yaml.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if len(doc.Content) == 0 {
		return nil, nil // empty, or only comments
	}
	root := doc.Content[0]
	if root.Kind != yaml.MappingNode {
		return nil, fmt.Errorf("%s:%d: write each setting as a line of key: value", path, root.Line)
	}
	lines := map[string]int{}
	var entries []entry
	for i := 0; i+1 < len(root.Content); i += 2 {
		k, v := root.Content[i], root.Content[i+1]
		if first, ok := lines[k.Value]; ok {
			return nil, fmt.Errorf("%s:%d: %s is already set on line %d", path, k.Line, k.Value, first)
		}
		lines[k.Value] = k.Line
		if v.Kind != yaml.ScalarNode {
			return nil, fmt.Errorf("%s:%d: %s takes a single value", path, v.Line, k.Value)
		}
		entries = append(entries, entry{key: k.Value, value: v.Value, line: k.Line, unset: v.ShortTag() == "!!null"})
	}
	return entries, nil
}

// parseBytes reads a size such as 256MB, 1GB or a plain number of bytes.
func parseBytes(s string) (int64, error) {
	s = strings.ToUpper(strings.TrimSpace(s))
	factor := int64(1)
	for _, u := range byteUnits {
		if strings.HasSuffix(s, u.suffix) {
			s, factor = strings.TrimSpace(strings.TrimSuffix(s, u.suffix)), u.factor
			break
		}
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n <= 0 {
		return 0, errors.New("must be a positive size")
	}
	return n * factor, nil
}

// byteUnits are the units of a size, largest first; B, a suffix of the
// others, comes last.
var byteUnits = []struct {
	suffix string
	factor int64
}{{"GB", 1 << 30}, {"MB", 1 << 20}, {"KB", 1 << 10}, {"B", 1}}

// FormatBytes writes a size as the settings take it, in the largest unit it
// is a whole number of: 8MB, 1536KB.
func FormatBytes(n int64) string {
	for _, u := range byteUnits {
		if n != 0 && n%u.factor == 0 {
			return strconv.FormatInt(n/u.factor, 10) + u.suffix
		}
	}
	return strconv.FormatInt(n, 10) + "B"
}
