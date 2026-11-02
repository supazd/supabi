---
title: Install SupaBI
description: Run SupaBI on your machine to try it, or as a service for your team.
---

There are no prebuilt packages yet, so SupaBI is built from source. To look around first, run it on your own machine with sample data. To use it with a team, run it as a service.

## Get the source

Both ways start from a copy of the repository:

```bash
git clone https://github.com/supazd/supabi.git
cd supabi
```

## Try it on your machine

You need [Docker](https://www.docker.com) and [mise](https://mise.jdx.dev), which installs the versions of Go, Node and pnpm that the project uses. From the root of the repository:

```bash
mise install
make dev-up
make dev-seed
make run
```

`make dev-up` starts the databases in Docker, `make dev-seed` loads about 20,000 sample orders, and `make run` builds SupaBI and starts it. These commands use a secret key that is public in the repository, so keep them to local trials.

Open <http://localhost:8080> and create the administrator account. Then [build your first dashboard](/getting-started/first-dashboard/).

## Run it as a service

SupaBI keeps its own data, such as accounts and dashboards, in PostgreSQL. Create an empty database for it before you start.

### Build

```bash
make build
```

This writes one static binary to `bin/supabi`, with the web interface inside it. To build for another platform, set `GOOS` and `GOARCH`.

### Configure

Create a config file and a secret key:

```bash
bin/supabi example-config > supabi.yaml
bin/supabi generate-key
chmod 600 supabi.yaml
```

Fill in the two required settings in `supabi.yaml`:

```yaml
database-url: postgres://supabi:PASSWORD@db.internal:5432/supabi
secret-key: THE_KEY_FROM_GENERATE_KEY
```

:::caution
`secret-key` encrypts the data source passwords and AI provider keys that SupaBI stores. Generate it once and keep it safe. If it is lost, those passwords and keys have to be entered again.
:::

Every other setting in the file is explained there and has a default. Each one can also be given as a flag or an environment variable: `http-addr` is `--http-addr` and `SUPABI_HTTP_ADDR`. A flag wins over the variable, and the variable over the file.

### Start

```bash
bin/supabi serve --config supabi.yaml
```

SupaBI applies its database migrations at startup and listens on `127.0.0.1:8080`. Open that address and create the administrator account.

### Serve other people

By default only the same machine can connect. To serve others, set `http-addr`, for example to `0.0.0.0:8080`, and put a reverse proxy that handles HTTPS in front, because SupaBI itself serves only HTTP.

A load balancer can use these two endpoints:

| Endpoint | Meaning |
|---|---|
| `GET /healthz` | The process is alive |
| `GET /readyz` | The service is ready; it returns 503 when the metadata database is unavailable |
