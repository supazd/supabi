# Startup configuration

The startup configuration used to be set only by command-line flags or `SUPABI_*` environment variables, and the three secrets only by environment variables. This design adds a YAML config file as the main way to configure a deployment. Environment variables and command-line flags stay, and override individual settings.

Status: implemented. Section 10 moves the six settings that should have only one value for the whole organization into System administration, section 11 checks the secret key at startup, and section 12 limits what one request can cost.

## 1. Goals

- Services on servers usually use config files: Spark's `spark-defaults.conf`, Hadoop's `*-site.xml`, Trino's `etc/config.properties`. One file holds all the configuration of one environment. It is easy to read and review, can be kept under version control, and moves between machines and environments.
- Configuration centers (Nacos, Apollo, Consul) and Kubernetes ConfigMaps can both write configuration out as files, so a file is the most common form for connecting to them.
- Several instances share one file, so settings that need a consistent deployment environment (`data-dir`, S3, Redis) are naturally consistent. Settings that should have only one value for the whole organization are not in the startup configuration. They are stored in the metadata database, see section 10.
- The existing way of deploying with environment variables and flags keeps working.

## 2. Specifying the config file

```bash
supabi serve --config /etc/supabi/supabi.yaml
```

- Specify it with `--config` or the environment variable `SUPABI_CONFIG`. When both are present, `--config` wins. A container image can preset `SUPABI_CONFIG`. Both `serve` and `migrate` support it.
- **No automatic lookup of a default location**. If no file is specified, no file is read, and all configuration comes from environment variables, flags and defaults. Automatic lookup leaves you unsure which file was read, and in a container it might pick up a file that ended up in the image by accident. The startup log states the path of the file it read.
- If the specified file does not exist or cannot be read, startup is refused. The file may be empty.
- Relative paths are resolved against the process's working directory, and so are relative paths inside the file (such as `data-dir`). This is the same as for flags and environment variables: the same value does not mean different things depending on where it is written. In production, use absolute paths.

When deploying with systemd:

```ini
[Service]
User=supabi
ExecStart=/usr/local/bin/supabi serve --config /etc/supabi/supabi.yaml
```

## 3. File format

```yaml
http-addr: 0.0.0.0:8080
database-url: postgres://supabi:PASSWORD@db.internal:5432/supabi
secret-key: KEY_FROM_SUPABI_GENERATE_KEY
data-dir: /var/lib/supabi

export-storage: s3
s3-endpoint: https://s3.example.com
s3-bucket: supabi-exports
s3-path-style: true
s3-access-key-id: ACCESS_KEY
s3-secret-access-key: SECRET_KEY

query-cache: redis
redis-url: redis://:PASSWORD@redis.internal:6379/0
```

- **Flat, no hierarchy**. A key name is the flag name without `--`, and the environment variable name is `SUPABI_` plus the key name in upper case with hyphens replaced by underscores. There is one spelling rule for a setting in all three places, so the descriptions in `supabi serve -h` apply to the file directly.

  | Key in the file | Command-line flag | Environment variable |
  |---|---|---|
  | `http-addr` | `--http-addr` | `SUPABI_HTTP_ADDR` |
  | `export-workers` | `--export-workers` | `SUPABI_EXPORT_WORKERS` |
  | `secret-key` | none | `SUPABI_SECRET_KEY` |

- The settings you can write are all 19 flags, plus the three secrets `secret-key`, `s3-access-key-id` and `s3-secret-access-key`. Flags added later can be written in the file automatically, and their names follow the same rule.
- **Values are always read as text**, then passed to the same parsing and validation as command-line flags, so YAML's own type inference has no effect: `auto-migrate: false`, `export-workers: 4` and `query-cache-size: 256MB` are all understood by the flag's rules. Quotes are optional.
- Only "key: single value" is accepted. A list or a nested value is an error; `roles` is written as `api,worker`, the same as the flag.
- A `key:` with no value after it is the same as not having the line, that is, the setting is unset. To set an empty string, write `""`.
- Startup is refused in the following cases, and the error carries the file path and line number:
  - An unknown key, so that a misspelled setting is not silently ignored: `supabi: /etc/supabi/supabi.yaml:7: unknown setting "exprot-workers"`
  - The same key appears twice
  - A value in the wrong format: `supabi: /etc/supabi/supabi.yaml:12: invalid value "two" for export-workers: parse error`
  - A key that has moved into the system settings, see section 10.5
  - The top level is not a "key: value" mapping

## 4. Secrets

- The three secrets, and `database-url` and `redis-url` when they carry a password, can all be written in the file. They used to be allowed only as environment variables because command-line flags show up in the process list; writing them in a file has no such problem.
- Secrets still have no command-line flag.
- When the file contains secrets, set its permissions to `600`, owned by the user that runs the service. The program does not check file permissions: Kubernetes Secrets and ConfigMaps that are mounted are `0644` by default, and a check would raise false alarms in a common way of deploying.
- When the config file goes into a repository or a configuration center but the secrets should not go with it, leave these settings out of the file and supply them as environment variables instead (for example, Kubernetes injecting a Secret as environment variables). Environment variables take priority over the file, so the file needs no placeholders.

## 5. Priority

**Command-line flag > environment variable > config file > program default**

- The file is the baseline configuration of one environment; a container platform overrides individual settings with environment variables; for temporary troubleshooting, override with flags. This is the same idea as Spark overriding `spark-defaults.conf` with `--conf`.
- In a split deployment, all instances share one file, and each instance uses only `--roles` or `SUPABI_ROLES` to say which roles it runs.
- An environment variable with an empty value (`SUPABI_X=`) counts as unset, consistent with a `key:` with no value in the file.
- For each setting that is set in the file but overridden by an environment variable or a flag, startup writes one log line with only the key name and the source, not the value. Without it, there is nothing to trace when "I changed the file but it has no effect":

  ```
  level=INFO msg="config file setting overridden" key=roles by=--roles
  level=INFO msg="config file setting overridden" key=database-url by=SUPABI_DATABASE_URL
  ```

## 6. Environment variables are validated strictly

At present, when a duration, boolean or integer environment variable has the wrong format, the program silently uses the default. For example, `SUPABI_EXPORT_TIMEOUT=15` with the unit left out becomes 15 minutes, and `SUPABI_AUTO_MIGRATE=flase` is treated as `true`. This changes to the same validation as flags and the file: a wrong format refuses startup and names the variable: `supabi: invalid value "15" for SUPABI_EXPORT_TIMEOUT: parse error`.

This design changes behavior in only two places that are incompatible with today:

- A deployment that starts with a malformed environment variable fails to start after the upgrade, and the value must be corrected.
- A string-type environment variable with an empty value used to mean the empty string and now means unset. Only one spelling changes its result, `SUPABI_REDIS_KEY_PREFIX=`: it used to mean no prefix, and now means the default `supabi:`.

## 7. Example config

- The example config is embedded in the program and printed with `supabi example-config`:

  ```bash
  supabi example-config > /etc/supabi/supabi.yaml
  ```

  You get the example even with only the binary or a container image, with no dependence on the directory layout of a release package.
- Every setting has an English comment stating its purpose and default, grouped as basic, logging, export, S3 and query cache.
- The required `database-url` and `secret-key` stay uncommented with no value, so that starting without filling them in gives a clear error. The other settings are commented out with their defaults written out: a setting you do not change follows the defaults of newer versions, rather than being fixed at the version you copied the example from.
- A test guarantees that the example contains every setting and that the defaults in the comments match the program.
- The "Run" section of the README is changed to put the config file first. Environment variables and flags are introduced as ways to override.

## 8. Implementation notes

- Parse with `go.yaml.in/yaml/v3` into a node tree, keeping line numbers for error reports. This library already appears as an indirect dependency in `go.mod`.
- Values from the file and from environment variables are both written through `flag.FlagSet.Set`, sharing the same parsing and validation as command-line flags. The three secrets are not registered as command-line flags and are handled separately.
- All setting names come from one list, from which the file keys and environment variable names are derived, and tests check the matching rules.

## 9. Not doing

| Item | Reason |
|---|---|
| Automatic lookup of a config file in a default location | See section 2 |
| Reloading configuration at runtime | The listen address, metadata database, storage and roles cannot be switched at runtime. If only some were reloaded, each setting would need a rule on whether it takes effect immediately, which is easy to misunderstand. Restart the process after changing the config: Kubernetes uses a rolling restart, and with a configuration center, its client or the deployment tool restarts the process after a push |
| Direct integration with a configuration center (built-in Nacos, Apollo and Consul clients) | All of them can write configuration out as files. A built-in client needs code for each vendor, and would make startup depend on whether the configuration center is available |
| Multiple config files, include, per-environment profiles | One file per environment. Keeping secrets apart from the other configuration is done with environment variables, see section 4 |
| Referencing environment variables in the file (`${VAR}`) | Environment variables already override the file, so just leave the setting out of the file |
| Checking config file permissions | See section 4 |
| Hierarchical keys (`max-rows:` under `export:`) | Flat keys let one setting follow the same spelling rule in the file, flags and environment variables; grouping is expressed by the comments in the example |
| A separate validation command (check the configuration without starting) | Startup already validates fully. Add it later if checking the configuration before pushing it becomes necessary |

## 10. System settings

### 10.1 Where each setting lives

- **Startup configuration** holds only two kinds of settings: those that belong to each machine or process (listen address, roles, directories, logging, export concurrency, the memory limit of the cache, whether to migrate automatically), and those needed before the metadata database is connected (`database-url`, `secret-key`). The first kind differs between instances, and that is correct.
- **Settings that should have only one value for the whole organization** are stored in the metadata database, and a system administrator changes them in "System administration → General".

These settings used to be in the startup configuration too. Each instance read its own, the values could differ, and the result depended on which instance happened to run: the hourly maintenance job runs on only one instance, so how long the audit log is kept depends on whose turn it is that hour; the maximum number of rows in an export depends on which worker picks the job up. Sharing one config file is only a convention and cannot stop an instance from changing a value with an environment variable or a flag. Stored in the database, there is only one copy.

The six settings that move into the system settings:

| Setting | Former startup configuration | Default | Unit and range in the UI |
|---|---|---|---|
| Export files kept for | `export-retention` | 24 hours | hours, 1 to 8760 (one year) |
| Export timeout (per attempt) | `export-timeout` | 15 minutes | minutes, 1 to 1440 (one day) |
| Most rows per export | `export-max-rows` | 2,000,000 | rows, 1 to 100,000,000 |
| Largest export file | `export-max-size` | 512 MB | MB, 1 to 1,048,576 (1 TB) |
| Audit events kept for | `audit-retention` | 180 days | days, 0 to 36500, `0` means kept forever; AI usage records use it too ([AI assistant](ai-assistant.md) 13.5) |
| Default cache lifetime | `query-cache-ttl` | 10 minutes | minutes, 1 to 1440 |

The lower limits are the same as those of the old startup flags, only rounded to the units used in the UI. There was no upper limit before. The upper limits now only stop wrongly written values (such as a few extra zeros), and also keep durations within what the program can represent. The query cache lifetime now has the same range as the data source's "Result cache" option ([Query IR](query-ir.md) 6.5).

### 10.2 Storage and when changes take effect

- The metadata database has a `system_settings` table with one row per organization, the same as `ai_settings`. Each setting is one column, and a null value means use the program's default: a setting that was never changed follows the default of the new version, for the same reason as the commented-out settings in the example config (section 7). With no row, everything uses the defaults.
- Each setting is read from the database every time it is used. A change takes effect at once without a restart, and every instance reads the same value, the same as the AI model configuration ([AI assistant](ai-assistant.md) 3.1):

  | Setting | When it is read | Effect on what already exists |
  |---|---|---|
  | Export timeout, Most rows per export, Largest export file, Export files kept for | At the start of each attempt; when a file is finished, its expiry time is computed from the retention read then | An attempt in progress finishes with the values read when it started; a retry reads them again. Finished files keep their original expiry time |
  | Audit events kept for | At the start of each maintenance job | After it is shortened, the next maintenance run (within an hour) deletes the audit events and AI usage records beyond it |
  | Default cache lifetime | On each query (when the data source has no setting of its own) | Results already cached expire by the lifetime in effect when they were written |

- The limits shown in the export center ([Exports](exports.md) 4.3) are also read from here.
- When exports are stored on S3, the part size used to be computed from the file size limit at startup. It is now computed on each attempt from the limit read then.

### 10.3 Page

- A last item "General" (`/settings/system/general`) is added to the navigation bar of "System administration". Only a system administrator can see and change it.
- The layout is the same as the workspace's "General" ([Access control and workspaces](access-control.md) 2.2.1): a single column, each setting with its name on the left, the input and unit on the right, and the description below. It is divided into seven groups, "Exports", "Audit", "Queries", "Workspaces", "Sign-in", "AI assistant" and "MCP service" (the "Workspaces" and "Sign-in" groups, and the timeout and row settings in "Queries", are in section 10.7; "MCP service" is in section 10.8; "AI assistant" is in section 10.9). An empty input means use the default, and the placeholder text is the default. Saving is possible only when something has changed; with unsaved changes, leaving the page asks for confirmation first.
- A value out of range cannot be saved, and the reason is written under the input.
- When the audit retention is shortened, confirm before saving: "Within an hour of saving, audit events and AI usage records older than N days will be deleted, and they cannot be restored after deletion." Changing from kept forever to a limited period also counts as shortening. The other settings are saved directly.

### 10.4 API and audit

- `GET /system/settings` returns the value of each setting (empty when not set) and its default; `PUT /system/settings` saves everything as a whole, and an empty value means use the default. Only a system administrator can call them.
- Saving records one `system_settings.update` event, with the values before and after in the details. Audit gets a new category "System" (`system`) ([Access control and workspaces](access-control.md) 7.1).

### 10.5 Removed from the startup configuration

- The flags, environment variables and config file keys of the six settings are all removed, with no override kept: if an override stayed, instances could differ again.
- If any of these settings is still given, startup is refused and the error says where it moved to, so that nobody thinks it is still in effect:

  ```
  supabi: /etc/supabi/supabi.yaml:9: export-max-rows is now set in System administration > General in the web interface, the same for every instance; remove it from the config file
  supabi: SUPABI_AUDIT_RETENTION is now set in System administration > General in the web interface, the same for every instance; unset it
  ```

  Command-line flags are handled the same way. Only the environment variables of these six are checked; other unrecognized `SUPABI_*` environment variables are still not checked, as before.
- At the development stage there are no deployments to migrate, and the values that were in the startup configuration are not written into the database automatically.
- The example config drops these six. The "audit" group has only `audit-retention`, so the whole group is removed. `export-workers` stays in the "export" group, and `query-cache-size` stays in the "query cache" group.

### 10.6 Staying in the startup configuration, but must be the same across instances

The export storage and the S3 settings, the query cache mode and the Redis settings, and the `data-dir` shared for local storage must also be the same across instances, but they stay in the startup configuration:

- Like `database-url`, they describe the deployment environment, and S3 credentials may come from an IAM role on the machine ([Exports](exports.md) 4.2).
- The client is built at startup, and whether the storage is reachable is checked at startup; if they were in the database, the client would have to be replaceable at runtime.
- If the storage is switched midway, old files stay in the old place (same section as above).
- They are infrastructure connections and do not belong to one feature: Redis currently holds only the query cache, but API and other data may use it later; the S3 parameters are likewise general (same section as above). After distributed locks or shared counters are in use, instances would switch addresses at different moments, some connected to the old one and some to the new, and the state would get mixed up. `export-storage` and `query-cache` depend on these connections and stay with them; otherwise `redis` could be chosen on the page while the instance has no `redis-url`, which is one more way to go wrong.

The consequences of inconsistency are lighter than for the six settings above: with different export storage, downloads fail; with different query cache modes, the cache just cannot be shared, and the results are not wrong. Consistency still relies on sharing one config file. Listing the running instances in System administration and warning when they are inconsistent: see [Deferred items](../backlog.md).

### 10.7 Values that were hard-coded

The values below were hard-coded in the code and were in neither the startup configuration nor the system settings: a query over 60 seconds could only be fixed by changing the code, and a company requirement to sign out after 8 hours of inactivity could not be met either. They too have one value for the whole organization, so they move into the system settings, with storage, API and audit the same as in sections 10.2 and 10.4. A new migration adds columns to `system_settings`, and a null value means use the default.

| Setting | Column | Default | Unit and range in the UI |
|---|---|---|---|
| Query timeout | `query_timeout_seconds` | 60 seconds | seconds, 1 to 3600 |
| Default rows | `query_default_rows` | 1,000 | rows, 1 to 100,000, no more than the limit |
| Most rows per query | `query_max_rows` | 10,000 | rows, 1 to 100,000 |
| Session lifetime | `session_lifetime_hours` | 168 hours (7 days) | hours, 1 to 8760 (one year) |
| Deleted workspaces kept for | `workspace_retention_days` | 30 days | days, 1 to 3650 (ten years) |

The connection timeout (10 seconds) stays hard-coded: it is used only for "Test connection", and if a connection cannot be made in that long, the address or the network is almost certainly at fault. The wait when a process stops (15 seconds) does not move either: it belongs to each process, and if it needs to change it goes into the startup configuration.

| Setting | When it is read | Effect on what already exists |
|---|---|---|
| Query timeout | At the start of each statement. Queries, validation when a dataset is saved, explaining statements, and reading fields and tables all use it | A statement in progress uses the value read when it started. Exports use their own timeout |
| Default rows, Most rows per query | When each query is compiled | The row count is written into the SQL, and the SQL is part of the cache key, so after a change, results cached with the old row count are never read |
| Session lifetime | At sign-in, and at each renewal (at most once every five minutes for the same session) | See below |
| Deleted workspaces kept for | At the start of each maintenance job, and when the workspace list in System administration computes the permanent deletion date | The date is computed from `deleted_at` and not stored separately, so workspaces that are already deleted also follow the new value |

**Query timeout**: SupaBI's HTTP server has no write timeout, so raising the value does not get the connection cut by the server itself. When a reverse proxy sits in front, the proxy's timeout has to be raised too (nginx's `proxy_read_timeout` defaults to 60 seconds), and this is stated under the input.

**Rows**:

- All rows are fetched into instance memory and then sent to the browser, and paging only pages through the fetched rows ([Charts and dashboards](chart-dashboard.md) 2.7), so the limit stops at 100,000. A single result over 8 MB is not cached ([Query IR](query-ir.md) 6), so after the limit is raised, such results query the database every time. This is stated under the input; to get more rows, use an export.
- When saving, the default rows cannot be more than the limit. They are compared by the values in effect, and a side left empty uses its default.
- The limit governs every fetch that goes through a query. Those that fix their own row counts, such as filter options (500), dataset preview and the SQL workbench (1000), also return at most the limit after it is lowered, and show the usual notice that the result is incomplete.
- Subtotals and totals do not use the default rows but the limit directly: they carry no row count of their own, and if they were cut off by the default rows, groups would be missing with no notice.
- Chart authors also need to know these two values: the editor's input must check the range, and its placeholder shows the default, and these are now hard-coded in the frontend. `GET /system/settings` can be called only by a system administrator, so the values go into `GET /auth/session`, which is available once someone is signed in. After the page is opened the values may go stale, which affects only the hints; the server still runs with the latest values. After an administrator saves the system settings, the page reads them again, so that administrator sees the new values at once.
- When a saved chart's `limit` is greater than the new limit, the chart opens as usual and returns at most the limit (compilation already takes the smaller of the two). The editor's input warns that the value is out of range. The notice that the result was truncated is now shown only when no `limit` is written; it changes to also show when a `limit` is written but exceeds the limit, otherwise authors would think they got all the rows.

**Session lifetime**:

- The meaning is unchanged: sign out after this long without activity, and renew when there is activity.
- After it is raised, the new value applies from the next renewal.
- When it is shortened, in the same transaction as the save, each session's `expires_at` is changed to `LEAST(expires_at, last_seen_at + new lifetime)`: this is a security setting, and an idle session must not keep its old expiry time. The person saving has just been active and is not signed out. The worst outcome is signing in again, with no confirmation dialog.

**Deleted workspaces kept for**:

- When it is shortened, confirm before saving, the same as audit retention (section 10.3): "Within an hour of saving, workspaces that have been deleted for more than N days will be permanently deleted along with everything in them, and this cannot be restored." When audit retention is shortened at the same time, the confirmation dialog states both.
- The "after 30 days" hard-coded in the confirmation dialog for deleting a workspace changes to the current value: only a system administrator can reach this list page, so it reads `GET /system/settings` directly.

**Page**: the "Query cache" group is renamed "Queries" and holds Query timeout, Default rows, Most rows per query and Default cache lifetime (the label changes from "Default lifetime" to "Default cache lifetime"); two new groups, "Workspaces" and "Sign-in", are added.

### 10.8 MCP service

Whether people may connect MCP clients ([AI assistant](ai-assistant.md) section 14) has one value for the whole organization and may change at run time, so it is a system setting, with storage, API and audit as in sections 10.2 and 10.4. A new migration adds the column to `system_settings`, and a null value means use the default.

| Setting | Column | Default | In the UI |
|---|---|---|---|
| Allow MCP clients | `mcp_enabled` | Off | A switch, in a new group "MCP service" |

- It is read on every request to the MCP and OAuth endpoints. Turning it off refuses the next request at once; authorizations are kept and work again once it is turned back on ([AI assistant](ai-assistant.md) 14.6).
- It is off by default: the data goes to the model the person's client uses, which the administrator did not choose. The description under the switch says so.
- Both directions are saved directly, with no confirmation dialog: nothing is deleted either way.

### 10.9 AI assistant

Two values of the AI assistant were hard-coded: the share of the model's context at which a conversation is compacted ([AI assistant](ai-assistant.md) section 6), and the most tool calls one answer may make (12.4). An administrator may want to lower them to spend less, or raise them for questions that take many lookups, and the whole organization has one value of each, so they are system settings, with storage, API and audit as in sections 10.2 and 10.4. A new migration adds the columns to `system_settings`, and a null value means use the default. Decided on 2026-11-05.

| Setting | Column | Default | Unit and range in the UI |
|---|---|---|---|
| Compress context at | `assistant_compress_percent` | 80% | percent of the usable context, 50 to 95 |
| Most tool calls per answer | `assistant_max_tool_calls` | 60 | calls, 0 to 1000, `0` means no limit |

- Both are read once, at the start of each answer. An answer in progress keeps to the values read then; the next answer uses the new ones.
- **Compress context at** decides two things, as the hard-coded 80% did: when the earlier part of a conversation is compacted before an answer (section 6), and when an answer is no longer given tools (12.4).
  - Below 50%, what compaction keeps as it is (up to a quarter of the usable context) plus the summary comes close to the threshold: nearly every answer would compact first, and an answer would lose its tools after its first lookups.
  - Above 95%, the estimate from the character count leaves too little margin, and providers start refusing calls as too long.
  - How much the compaction model reads in one segment stays at 80% of its own usable context. That is a margin for the estimate, not a choice of when to compact.
- **Most tool calls per answer**: lookups, calculations and charts all count, as before. With `0`, an answer stops calling tools when the model stops, when the context reaches the share above, or when the person stops it. Every round resends the whole context, so the description under the input says that more calls cost more. The upper limit only stops wrongly written values.
- They govern the AI assistant only. An MCP client runs its own loop ([AI assistant](ai-assistant.md) section 14), and SupaBI does not count its calls.
- Both are saved directly, with no confirmation dialog: nothing is deleted.
- **Page**: a new group "AI assistant", just before "MCP service".

## 11. Secret key check

`secret-key` encrypts the data source passwords, the AI provider API keys and the password of the email server ([Email](email.md) 9) in the database, and it can only live in the startup configuration: if it were kept with the database, anyone who got one database backup could decrypt all the passwords.

Different secret keys across instances have the heaviest consequences: B cannot decrypt the passwords A stored, and queries fail; A cannot decrypt the passwords B newly stored either, so each side holds half, and it is hard to sort out afterwards. Today this is found only when a password is used. It changes to being found at startup:

- The metadata database stores a check value, a fixed piece of text encrypted with the secret key, in the `secret_key_check` table. There is only one for the whole installation: the secret key belongs to the whole installation and is not split by organization.
- `serve` checks after the migration and before starting the roles, and every role checks, because every role requires `secret-key`. If the current key can decrypt it, startup continues; if not, startup is refused:

  ```
  supabi: secret-key is not the key this database was set up with; start every instance with the same secret-key
  ```

  `migrate` does not use the secret key and does not check.
- **When there is no check value yet** (a new database, or one created before this version): if the database already holds encrypted values, first decrypt one of them with the current key, and if it cannot be decrypted startup is refused in the same way; if it can be decrypted, or the database has no encrypted values yet, the check value is written. When two instances start for the first time at the same time, only the one that writes first takes effect, and the one that writes later reads the existing check value and checks against it.

**A lost secret key**: before, a lost key still let the service start, and filling in the passwords again was enough; with the check, it cannot start. For this a command is added:

```bash
supabi clear-secrets --config /etc/supabi/supabi.yaml --yes
```

- It clears all the encrypted values in the database (data source passwords, AI provider API keys, the email server password) and the check value. The data sources, providers and email settings themselves are kept, and an administrator fills in the passwords and API keys again. After that, start with the new secret key, and a new check value is written.
- Without `--yes`, it only lists how many data source passwords, provider API keys and email server passwords would be cleared, and does not run.
- Stop all instances before running it: an instance that is still running holds the old key and keeps storing passwords with it.
- It uses only `database-url` and does not need `secret-key`.

Changing the secret key (decrypting all the values with the old key and encrypting them again with the new one) is not done, see [Deferred items](../backlog.md).

## 12. Request limits

The API reads a request's JSON body before it checks who sent it: the generated server decodes the body first, and only then runs the middleware that authenticates. With no limit on the body, anyone who can reach the server can make it allocate several times what they send, signed in or not. A 64 MiB body sent with no session got 401, after the server had allocated about 320 MiB reading it. The limits below bound what one request can cost. How many connections one client may open is for the reverse proxy.

**Body size**: the startup setting `http-max-body-size`, `8MB` by default, written like `query-cache-size`. It bounds the memory of one process, so it is in the startup configuration. Instances behind one load balancer should share it, or the same save could succeed on one and fail on another.

- It applies in front of the route table, to every path the api role serves. Some endpoints keep smaller limits of their own: OAuth's 64 KiB, and the MCP SDK's 4 MiB. The setting is a ceiling over them.
- A request whose `Content-Length` is over the limit is refused before any of it is read. One with no length, or a wrong one, is cut off where it passes the limit (`http.MaxBytesReader`).
- Either way the answer is 413 with the code `request_too_large` and the limit, in the spelling of the setting, as the parameter `limit`. When the cut-off happens inside the generated decoder, the API's handler of request errors recognises it, which would otherwise report it as `invalid_request`.
- The default: the largest request the interface sends is an export's SQL, up to 1,000,000 bytes (`internal/api/exports.go`), under 2 MB as JSON. Dataset and dashboard definitions are tens to hundreds of KB.
- Any positive size is accepted, with no lower bound: a limit too small to save a chart shows at once.

**Reading time**: 60 seconds to read the whole request, headers and body (`ReadTimeout`), hard-coded like the 10 seconds for the headers alone. Otherwise a client could send a body a byte at a time and hold the connection for as long as it likes.

- It does not cut long requests. The deadline applies only while the request is read: the handler may run on past it, as a query may for up to 3600 seconds (section 10.7), and a client that leaves later still cancels the query.
- nginx by default reads the whole body before it passes the request on (`proxy_request_buffering`), so behind it the 60 seconds are for nginx's read, not the browser's upload.

**Idle connections**: no limit, as before. `IdleTimeout` is set to a negative value to say so, because when it is zero Go uses `ReadTimeout` for it instead. Keep-alive connections would then close after 60 seconds, which is the default idle time of AWS load balancers, while Google Cloud's keep them about 10 minutes and ask backends to keep them longer. A backend that closes a connection the balancer is about to reuse causes sporadic 502s.

There is still no write timeout, see section 10.7.

Not doing:

| Item | Reason |
|---|---|
| Authenticating before the body is read | The generated server decodes first. Changing that means authenticating in a middleware outside the generated chain as well as inside it. With the limit, what an anonymous request can cost is bounded |
| A setting for the idle timeout | Kept without a limit, as before. Add it when a deployment behind a load balancer needs it |
| Limiting connections per client | The reverse proxy's job |
