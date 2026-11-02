VERSION ?= dev
COMMIT  := $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
LDFLAGS := -X github.com/supazd/supabi/internal/buildinfo.Version=$(VERSION) \
           -X github.com/supazd/supabi/internal/buildinfo.Commit=$(COMMIT)

# Matches compose.yaml. Override either variable to use another database.
DEV_DATABASE_URL  ?= postgres://supabi:supabi@127.0.0.1:15432/supabi
TEST_DATABASE_URL ?= $(DEV_DATABASE_URL)
TEST_MYSQL_DSN    ?= root:supabi@tcp(127.0.0.1:13306)/
TEST_CLICKHOUSE_URL ?= clickhouse://supabi:supabi@127.0.0.1:19000
TEST_TRINO_URL    ?= http://supabi@127.0.0.1:18080
TEST_REDIS_URL    ?= redis://127.0.0.1:16379/0
# The RustFS in compose.yaml, for `make run-s3`. Tests of S3 storage use the
# same bucket, each below a prefix of its own.
DEV_S3_ENDPOINT          ?= http://127.0.0.1:19100
DEV_S3_BUCKET            ?= supabi
DEV_S3_ACCESS_KEY_ID     ?= supabi
DEV_S3_SECRET_ACCESS_KEY ?= supabi-secret
TEST_S3_ENDPOINT          ?= $(DEV_S3_ENDPOINT)
TEST_S3_BUCKET            ?= $(DEV_S3_BUCKET)
TEST_S3_ACCESS_KEY_ID     ?= $(DEV_S3_ACCESS_KEY_ID)
TEST_S3_SECRET_ACCESS_KEY ?= $(DEV_S3_SECRET_ACCESS_KEY)
# For local development only: it is public. Production needs its own, from `supabi generate-key`.
DEV_SECRET_KEY    ?= c3VwYWJpLWRldi1vbmx5LW5vdC1mb3ItcHJvZC1rZXk=

.PHONY: build build-go generate web web-install web-check docs-install docs-dev docs-build test test-olap run run-s3 dev-up dev-up-olap dev-down dev-down-olap dev-reset dev-seed dev-seed-olap dev-seed-content

# Release-style binaries with the frontend embedded. Nothing needs cgo, so the
# binary is static and builds for another platform with GOOS and GOARCH.
build: web
	CGO_ENABLED=0 go build -tags embedweb -ldflags "$(LDFLAGS)" -o bin/supabi ./cmd/supabi

# Backend only, no Node toolchain needed. Pair it with `pnpm dev` in web/.
build-go:
	CGO_ENABLED=0 go build -ldflags "$(LDFLAGS)" -o bin/supabi ./cmd/supabi

# Regenerates code from api/openapi.yaml: Go server stubs and TypeScript types.
generate: web-install
	go generate ./...
	cd web && pnpm gen:api

web-install:
	cd web && pnpm install --frozen-lockfile

web: web-install
	cd web && pnpm build

web-check: web-install
	cd web && pnpm typecheck && pnpm lint && pnpm test

# The documentation site is a package of its own; see .agents/design/docs-site.md.
docs-install:
	cd docs && pnpm install --frozen-lockfile

docs-dev: docs-install
	cd docs && pnpm dev

docs-build: docs-install
	cd docs && pnpm build

# Database tests each run in their own throwaway schema or database. Without
# these variables they are skipped, so always go through this target.
test: dev-up web-check
	SUPABI_TEST_DATABASE_URL='$(TEST_DATABASE_URL)' SUPABI_TEST_MYSQL_DSN='$(TEST_MYSQL_DSN)' SUPABI_TEST_CLICKHOUSE_URL='$(TEST_CLICKHOUSE_URL)' SUPABI_TEST_REDIS_URL='$(TEST_REDIS_URL)' \
	SUPABI_TEST_S3_ENDPOINT='$(TEST_S3_ENDPOINT)' SUPABI_TEST_S3_BUCKET='$(TEST_S3_BUCKET)' SUPABI_TEST_S3_ACCESS_KEY_ID='$(TEST_S3_ACCESS_KEY_ID)' SUPABI_TEST_S3_SECRET_ACCESS_KEY='$(TEST_S3_SECRET_ACCESS_KEY)' \
	go test -race ./...

# StarRocks, Doris and Trino are too heavy to start for every test run. This
# starts them one at a time, runs the tests of their drivers, and stops them.
test-olap:
	docker compose --profile olap up -d starrocks
	./dev/wait-olap.sh starrocks
	SUPABI_TEST_STARROCKS_DSN='root@tcp(127.0.0.1:19030)/' go test -count=1 ./internal/datasource/mysql/
	docker compose --profile olap stop starrocks
	docker compose --profile olap up -d doris
	./dev/wait-olap.sh doris
	SUPABI_TEST_DORIS_DSN='root@tcp(127.0.0.1:19031)/' go test -count=1 ./internal/datasource/mysql/
	docker compose --profile olap stop doris
	docker compose --profile olap up -d --wait trino
	SUPABI_TEST_TRINO_URL='$(TEST_TRINO_URL)' go test -count=1 ./internal/datasource/trino/
	docker compose --profile olap stop trino

run: build dev-up
	SUPABI_DATABASE_URL=$(DEV_DATABASE_URL) SUPABI_SECRET_KEY=$(DEV_SECRET_KEY) SUPABI_DATA_DIR=data ./bin/supabi serve

# As run, with export files in the RustFS of compose.yaml rather than in data/.
run-s3: build dev-up
	SUPABI_DATABASE_URL=$(DEV_DATABASE_URL) SUPABI_SECRET_KEY=$(DEV_SECRET_KEY) SUPABI_DATA_DIR=data \
	SUPABI_EXPORT_STORAGE=s3 SUPABI_S3_ENDPOINT='$(DEV_S3_ENDPOINT)' SUPABI_S3_BUCKET='$(DEV_S3_BUCKET)' SUPABI_S3_PATH_STYLE=true \
	SUPABI_S3_ACCESS_KEY_ID='$(DEV_S3_ACCESS_KEY_ID)' SUPABI_S3_SECRET_ACCESS_KEY='$(DEV_S3_SECRET_ACCESS_KEY)' ./bin/supabi serve

dev-up:
	docker compose up -d --wait

dev-up-olap:
	docker compose --profile olap up -d

# Sample content over the PostgreSQL sample data: a data source, datasets,
# charts and dashboards, made as the first administrator in their first
# workspace, so set SupaBI up first. Running it again replaces what it made.
# DEV_SECRET_KEY must be the key the server runs with; see dev/seedcontent.
dev-seed-content: dev-up
	go run ./dev/seed -postgres '$(DEV_DATABASE_URL)' postgres
	go run ./dev/seedcontent -database-url '$(DEV_DATABASE_URL)' -secret-key '$(DEV_SECRET_KEY)'

# The same sample data for StarRocks and Doris, which it starts if needed.
# Their containers keep no data, so this has to be run again after each start.
dev-seed-olap: dev-up dev-up-olap
	./dev/wait-olap.sh starrocks
	./dev/wait-olap.sh doris
	go run ./dev/seed starrocks doris

# Stops everything dev-up and dev-up-olap started: naming the profile makes
# compose include its services, on top of the ones that belong to none.
dev-down:
	docker compose --profile olap down

# Stops only StarRocks, Doris and Trino, leaving the everyday databases running.
dev-down-olap:
	docker compose --profile olap rm --stop --force starrocks doris trino

# Back to a blank slate: deletes the development databases, the files in
# RustFS and the local export files.
# Stop the server first. Afterwards `make run` starts from the setup page.
dev-reset:
	docker compose --profile olap down --volumes
	rm -rf data

# Loads sample data to analyse into each of the everyday databases, the same
# rows into each; see dev/seed/main.go for how to connect to it.
dev-seed: dev-up
	go run ./dev/seed -postgres '$(DEV_DATABASE_URL)' postgres mysql clickhouse
