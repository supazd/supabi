---
title: Configuration
description: Every startup setting, and how settings reach SupaBI.
---

Startup configuration covers what belongs to each instance, and what SupaBI needs before it reaches its metadata database. Settings the whole organization shares, such as export limits and query timeouts, are not here: a system administrator changes them under [General settings](/admin/system/#general-settings).

## Ways to set a value

All settings can be written in one YAML file, given with `--config` or the environment variable `SUPABI_CONFIG`:

```bash
bin/supabi example-config > supabi.yaml   # every setting, with its explanation and default
bin/supabi serve --config supabi.yaml
```

Each one can also be a flag or an environment variable: `http-addr` is `--http-addr` and `SUPABI_HTTP_ADDR`. A flag wins over the variable, and the variable over the file. Settings of the file that were replaced are listed in the log at startup. Running with no file, only variables and flags, also works.

Relative paths are taken from the working directory. Prefer absolute paths.

If a setting that moved to System administration is still present, SupaBI refuses to start and says where it went.

## Settings

### Basics

| Setting | Default | Meaning |
|---|---|---|
| `database-url` | Required | The PostgreSQL metadata database |
| `secret-key` | Required | Encrypts stored passwords and API keys. Create it once with `supabi generate-key` |
| `roles` | All | The roles to run, of `api`, `worker` and `scheduler`, separated by commas |
| `http-addr` | `127.0.0.1:8080` | The listen address of the `api` role |
| `auto-migrate` | `true` | Applies pending migrations at startup. When off, run `supabi migrate` before starting a new version |
| `data-dir` | `data` | The data directory. Export files go here with `export-storage: local` |

### Logging

| Setting | Default | Meaning |
|---|---|---|
| `log-level` | `info` | `debug`, `info`, `warn` or `error` |
| `log-format` | `text` | `text` or `json` |

### Exports

| Setting | Default | Meaning |
|---|---|---|
| `export-storage` | `local` | `local` for the data directory, `s3` for object storage |
| `export-workers` | `2` | Background jobs each worker process runs at once, 1 to 32 |

The S3 settings are in [Exports and the query cache](/deployment/exports-and-cache/#export-files).

### Query cache

| Setting | Default | Meaning |
|---|---|---|
| `query-cache` | `memory` | `memory` for each instance alone, `redis` for sharing, or `off` |
| `query-cache-size` | `256MB` | The most memory the cache takes with `memory` |
| `redis-url` | | The Redis to use with `redis` |
| `redis-key-prefix` | `supabi:` | A prefix for every key written to Redis |

## Secrets

`secret-key`, `s3-access-key-id` and `s3-secret-access-key` have no flags, so they do not appear in the process list. `redis-url` can hold a password, so keep it out of flags too.

Once the config file holds secrets, make it readable only by the user SupaBI runs as:

```bash
chmod 600 supabi.yaml
```

To keep the file in version control or a configuration center, delete those lines and give them as environment variables instead.

## Commands

| Command | Meaning |
|---|---|
| `supabi serve` | Runs the server. See `supabi serve -h` for all flags |
| `supabi migrate` | Applies pending migrations and exits |
| `supabi clear-secrets` | Removes stored passwords and API keys after the secret key was lost, see [Operations](/deployment/operations/#lost-secret-key) |
| `supabi example-config` | Prints a config file with every setting |
| `supabi generate-key` | Prints a new value for `secret-key` |
| `supabi version` | Prints version information |
