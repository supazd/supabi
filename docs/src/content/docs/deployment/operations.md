---
title: Operations
description: Run several instances, sit behind a proxy, upgrade, and recover a lost key.
---

## Roles

One SupaBI process can run three roles, all of them by default:

| Role | Does |
|---|---|
| `api` | Serves the web interface and the API |
| `worker` | Runs exports and cleanup jobs |
| `scheduler` | Dispatches the expired-file cleanup and the hourly maintenance job |

To split them, give instances `--roles` or `SUPABI_ROLES`:

```bash
bin/supabi serve --config supabi.yaml --roles api
bin/supabi serve --config supabi.yaml --roles worker,scheduler
```

A split deployment still needs a worker and a scheduler. The hourly maintenance job deletes expired sessions, audit events past their retention, stale failed-login counts and workspaces past theirs.

## Several instances

All instances must use the same:

- `secret-key`. This is checked at startup, and an instance with a different key refuses to start.
- Export storage: a shared `data-dir` on persistent storage, or `s3`. See [Export files](/deployment/exports-and-cache/#export-files).
- Query cache: `redis`, if the cache is to be shared. See [Query cache](/deployment/exports-and-cache/#query-cache).

[General settings](/admin/system/#general-settings) live in the metadata database, so every instance sees the same values.

## Reverse proxy

SupaBI serves only HTTP and listens on `127.0.0.1` by default. To serve others, set `http-addr` and put a reverse proxy that handles HTTPS in front.

- **HTTPS**: pass `X-Forwarded-Proto: https`. The session cookie gets the `Secure` flag only when HTTPS is detected.
- **Host**: pass the `Host` header as the browser sent it. SupaBI refuses changes whose origin is another host, and names the [MCP](/admin/mcp/) address and its sign-in endpoints after this host and scheme. If the proxy forwards only some paths, include `/mcp`, `/oauth/` and `/.well-known/` besides `/api/`.
- **Streaming**: AI answers are streamed. The proxy must not buffer them, or the text comes out all at the end. SupaBI sends `X-Accel-Buffering: no`, which nginx follows; other proxies need their own setting.
- **Timeouts**: if you raise the [query timeout](/admin/system/#general-settings), raise the proxy's timeout to match.
- **Request size**: SupaBI reads request bodies of up to [`http-max-body-size`](/deployment/configuration/#basics), 8 MB by default. Let the proxy accept as much. nginx's `client_max_body_size` is `1m` by default, and a larger request then gets nginx's error page instead of SupaBI's message.

## Health checks

| Endpoint | Meaning |
|---|---|
| `GET /healthz` | Liveness, with no dependency on other components |
| `GET /readyz` | Readiness. Returns 503 when the metadata database is unavailable |

## Upgrades

Migrations run automatically at startup. To run them apart, set `auto-migrate` to `false` and run this before starting the new version:

```bash
bin/supabi migrate --config supabi.yaml
```

Migrations go forward only.

## Backups

Back up the metadata database, and keep `secret-key` apart from it. A backup without the key cannot decrypt the stored passwords and API keys, and a backup with the key next to it gives both away.

## Logs

`log-level` and `log-format` control the application log, and `json` suits a log system. [Audit events](/admin/system/#audit-log) also appear there, as lines with `msg=audit`.

## Lost secret key

`secret-key` encrypts the stored data source passwords and API keys of AI providers. If it is lost they cannot be decrypted, and SupaBI refuses to start with a different key. To recover:

1. Stop all instances.
2. See what would be cleared:

   ```bash
   bin/supabi clear-secrets --config supabi.yaml
   ```

3. Clear it:

   ```bash
   bin/supabi clear-secrets --config supabi.yaml --yes
   ```

4. Start with a new `secret-key`, and enter the data source passwords and API keys again. The data sources and providers themselves are kept.
