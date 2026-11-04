# SupaBI

An open-source BI system in early development, with no real users yet. The backend is Go (entry point `cmd/supabi`, code in `internal/`), the frontend is a pnpm workspace in `web/`, and metadata lives in PostgreSQL.

## Where the docs are

`.agents/` holds the project's design and decision records. They stay the reference across sessions and tools:

| Path | Contents |
|---|---|
| `.agents/design/architecture.md` | Architecture overview. Section 3 is the core constraints, section 11 the frontend constraints |
| `.agents/design/query-ir.md` | Query IR |
| `.agents/design/dataset.md` | Dataset model |
| `.agents/design/expressions.md` | Standard expressions |
| `.agents/design/chart-dashboard.md` | Chart and dashboard specs |
| `.agents/design/access-control.md` | Permissions, workspaces and audit |
| `.agents/design/exports.md` | Exports and background jobs |
| `.agents/design/configuration.md` | Startup configuration and system settings |
| `.agents/design/ai-assistant.md` | AI assistant |
| `.agents/design/docs-site.md` | Documentation site: how it is built and the rules its pages follow |
| `.agents/backlog.md` | What was deferred, why, and when to reconsider it |

`README.md` introduces the project and covers local development. `api/openapi.yaml` is the API definition. `docs/` is the user-facing documentation site, so design material does not go there. It is the only full description of features, so a change users can see updates the matching page there, in both languages, in the same commit.

- Every doc in `.agents/`, and `README.md`, has a Chinese version beside it, named `*.zh.md`. Read the English one and do not load both. When you change a doc, make the same change to its `.zh.md` in the same commit, and keep section numbers identical, because code comments cite them.
- `.agents/` is a hidden directory, which `rg` skips by default. To search the design docs, name the path and leave out the Chinese copies: `rg term .agents/ -g '!*.zh.md'`.

## Common commands

```bash
make dev-up         # start local Postgres, MySQL, ClickHouse, Redis and RustFS
make test           # everything: frontend type check, lint and unit tests, backend tests with databases and object storage
make generate       # regenerate the Go server code and TypeScript types from api/openapi.yaml
make build-go       # build the backend only, no Node needed
cd web && pnpm dev  # frontend dev server
make docs-dev       # documentation site, at http://localhost:4321
```

## How we work

1. Discuss the approach first and start once the user has decided. Write the agreed approach into `.agents/design/`, then write the code.
2. Do one thing per round. Do not move on to the next item unless the user says to do them together.
3. Decisions you made yourself during a discussion, which the user has not confirmed, go in a separate list in your summary for the user to confirm.
4. Read the relevant design docs before you start. If you really need to depart from a convention, say why first and let the user decide.
5. Report verification results when you finish. Try interface changes in a browser yourself before asking the user to try them, and do not hand the user something that looks usable before its interface exists.
6. Each piece of work goes on its own branch from the latest `main`, named after its type, for example `feat/chart-drill-down` or `fix/export-timeout`. Work in the current checkout unless the user asks for a worktree or the session already runs in one. Commit, push and open a pull request only when the user asks. The user reviews the pull request on GitHub and merges it; never merge it yourself or turn on auto-merge. After it merges, switch back to `main`, pull, and delete the local branch. If the user brings up something new while earlier work is unfinished, ask whether to open a pull request for the earlier work first, so that each pull request holds one thing.

`main` accepts changes only through pull requests, which are squash-merged: the pull request title becomes the commit title on `main`, and its description the commit body. The title follows the commit message rules below, and the description, in English, says what changed and how it was verified. CI (`.github/workflows/ci.yml`) runs `make test` and `make docs-build` on every pull request, and both must pass before it can merge.

Commit messages are in English, start with a type such as `feat:`, `fix:` or `docs:`, and say what the change does for the product, for example `feat: drill a chart down from a menu on the value clicked`. Code comments are in English. When a comment cites a design, name the file and section, for example `See .agents/design/query-ir.md §6.6.`.

## Hard rules

- **A migration file cannot change once written, not even a comment.** Startup checks a hash of the whole file (`internal/store/migrate.go`) and refuses to start if it differs, and a development database may already have run the file even if it is not committed. Add a new migration to change behavior. Run a migration from an unmerged branch only against a temporary database: a build without it refuses to start on a database that has run it, and if `main` takes its number first, the branch has to renumber it, which is safe only while no lasting database has run it. Every table and column needs a `COMMENT`, and a test fails if one is missing.
- **Do not trust a plain `go test ./...`.** Without `SUPABI_TEST_DATABASE_URL`, every test in store and api that needs a database is skipped and the output still says `ok`. Use `make test`, or set the variable (the value is in the `Makefile`), or run with `-v` and confirm nothing was skipped.
- **Change `api/openapi.yaml` first, then run `make generate`.** `internal/api/gen/api.gen.go` and `web/apps/app/src/api/schema.gen.ts` are generated, so do not edit them by hand.
- **Only the query layer generates and runs SQL.** This and the other core constraints are in section 3 of the architecture overview.
- **Lint enforces the frontend layers.** `apps/app` imports only from `packages/ui` and `packages/charts`, ECharts stays in `packages/charts`, and shadcn, Radix and other low-level libraries stay in `packages/ui`. A new interface library goes in the component package and on the `componentLibrary` list in `web/eslint.config.js`. Tailwind is used only inside the component package.
- **Interface text lives in the language packs in `web/apps/app/src/i18n/`**, never hard-coded in a component.

## Where a new setting goes

- **Startup configuration (YAML, environment variables):** values that belong to one machine or process (listen address, role, directories, logging, concurrency, memory limits), what is needed before connecting to the metadata database (`database-url`, `secret-key`), and connections to infrastructure such as S3 and Redis.
- **System administration (stored in the metadata database):** settings that should have one value across the organization and may change at run time. Each instance reads them from the database when it uses them, changes apply at once, and startup configuration keeps no override. Secrets are encrypted with `secret-key` before they are stored.
- Judge an infrastructure connection by who may share it in future, not by how it is used today, and do not propose moving it to system administration.
- Make a value a setting if an administrator might want to change it, without waiting for someone to ask. Hard-code only purely technical details.

See `.agents/design/configuration.md`.

## How to judge

- **Ask first whether a feature is needed.** When proposing a capability, start with why the existing mechanisms fall short, measure that if you can (`EXPLAIN`, real queries), and only then go into detail.
- **Keep the scope small.** Offer the smallest useful scope first and list extensions separately for the user to choose. If a capability would be broken by upstream changes, such as rolling back a resource that depends on upstream ones on its own, leave it out.
- **No temporary limits during development.** When a feature is built in steps, do not write role checks, switches or gradual rollouts for the intermediate states. Permissions that are part of the design are designed as usual.
- **Keep the interface compact.** Prefer one line per item in lists and panels, and make it fit in narrow property panels.

## Local environment

The user often runs the service on port 8080 against the development database `supabi`. To verify something, use another port and a temporary database. Do not touch that process, and do not create accounts or change data in the development database.
