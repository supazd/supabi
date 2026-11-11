# Architecture overview

Status: the parts that have been discussed and confirmed. For details see [Query IR](query-ir.md), [Dataset model](dataset.md), [Charts and dashboards spec](chart-dashboard.md), [Access control and workspaces](access-control.md) and [Startup configuration](configuration.md); for deferred items see [Deferred items](../backlog.md).

## 1. Product positioning

- An open-source product. All features are open source under the Apache 2.0 license, with no split between an open-source edition and an enterprise edition; private deployment is supported.
- It serves two kinds of people: data developers (analysts, engineers and report authors, who build datasets in SQL and make charts and dashboards by drag and drop) and business users (who view dashboards and, later, ask the AI questions). For the matching roles see [Access control and workspaces](access-control.md) 4.1.
- AI, drag and drop, embedding and the data API are different entry points on top of the same core. They do not each implement their own query logic.

## 2. Logical layers

```
Entry layer           Drag-and-drop editor │ AI assistant │ Embed SDK │ Data API
                               └─────────────────────┬─────────────────────┘
Spec layer            Dashboard spec │ Chart spec │ Filters and links        Declarative JSON, stored in the metadata database
                                                     │
Query layer           Query IR → permission injection → dialect compilation → execution and cache   System core
                                                     │
Dataset layer         Source (SQL or table pick) │ Parameters │ Fields (dimensions, measures)   Maintained by analysts
                                                     │
Data source layer     Connection management │ Drivers and dialects

Platform foundation   Authentication │ Resource permissions │ Workspaces │ Audit          Cross-cutting, plugged in through interfaces
```

Dependencies point only from top to bottom.

## 3. Core constraints

1. **All entry points produce the same kind of declarative description**. Drag and drop, AI and the API all generate a spec and a query IR, and never write SQL directly. What AI generates is a spec, so it can be validated, edited further in the editor, and is bound by permissions automatically.
2. **Only the query layer can generate and execute SQL**. Permissions, caching and audit are implemented in this one place.
3. **Generate SQL, never parse it**. The source SQL a user writes is wrapped whole as a subquery; column information and expression validation rely on a trial run with `LIMIT 0`.
4. **The spec is the single source of truth**. It carries a version number and is migrated version by version on load.
5. **Services are stateless**. All state lives in Postgres, Redis and object storage.
6. **Platform foundations plug in through interfaces**. Authentication, permissions and audit each have an interface; adding an implementation (such as OIDC sign-in or column-level permissions) does not change the code above them.

## 4. The path of one query

```
The frontend generates the chart spec (including the query IR)
 → structural validation and semantic validation (do the fields exist in the dataset)
 → inject row and column permissions for the current user
 → expand derived calculations (period-over-period comparison and so on)
 → compile to SQL in the dialect of the target database
 → look up the cache, execute on a miss
 → shape the result and return it; the frontend renders it according to the spec
```

## 5. Runtime

```
Browser (React)        Host system (embedded / API)
      └──────────┬──────────┘
        supabi single binary; role set by startup flags
        ┌────────┼────────┐
       api     worker   scheduler
        └────────┼────────┘
  Postgres     Redis     Object storage     User data sources
```

| Role | Responsibility |
|---|---|
| `api` | HTTP API, query compilation, synchronous queries |
| `worker` | Actual execution of asynchronous queries, exports and subscription pushes |
| `scheduler` | Time-triggered jobs: subscription pushes, data alerts, cache warm-up, metadata sync, cleanup and materialization refresh. It only dispatches jobs and does not run them |

Currently the worker implements background CSV/XLSX export of data exploration SQL and dashboard chart data, plus file cleanup. For each organization that has export records, the scheduler dispatches one expired-export cleanup job per hour. The queue uses Postgres leases and atomic claiming, and the "new result" flag of a finished result is written to Postgres in the same transaction as the completed status. Export files are stored in the data directory or in S3-compatible object storage. For the specific rules see [Exports](exports.md). Other job types are not implemented yet.

- A small deployment runs all roles in one process; at larger scale each role scales independently.
- With multiple scheduler instances, the Postgres job queue ensures that each job fires only once.
- The frontend build output is embedded in the Go binary, delivered as a single file.

| Dependency | Purpose | Required |
|---|---|---|
| Postgres | Metadata, job queue | Required |
| Redis | Query result cache | Optional; a minimal deployment can turn it off |
| Data directory | Default location for export files | Not needed when exports go to object storage; with local storage and multiple instances, a shared volume must be mounted |
| Object storage | Export files (`--export-storage=s3`), S3 or a compatible implementation | Optional |

## 6. Technology choices

| Item | Choice | Reason |
|---|---|---|
| Backend | Go, modular monolith | Single binary, low memory use, compiled, suited to private deployment; internal boundaries are drawn by module, so it can be split into services later |
| Frontend | React, TypeScript, Vite, pnpm workspace; React Router for routing, i18next for multiple languages | See section 11 |
| API | REST + OpenAPI | Frontend types are generated from the API definition; a simple toolchain that is easy to debug and easy for embedding parties to integrate with |
| Metadata database | Postgres, with the pgx driver | |
| Database migration | A lightweight in-house migrator | Migration files are embedded in the binary, forward only; it checks that applied files have not been changed, and uses a database lock so that only one pod runs them when several start at the same time |
| Resource ID | Type prefix plus a random string, such as `ds_3f8k2m9q0x7c1b5n4d6h` | Carries type information in logs, URLs and specs |

Go's two weak spots and how we deal with them:

- **Long-tail data source drivers**: data sources are built as an interface, so a JDBC bridge process can be attached later.
- **Multi-dialect SQL parsing**: see core constraint 3; the design avoids it.

## 7. Open-source license

- The license is Apache 2.0; see `LICENSE` in the repository root. All features are open source and there are no closed-source enterprise features: SSO, column-level permissions and masking, audit, multi-tenancy and embedding are all in the same codebase, and are implemented step by step within the scope of section 8 of [Access control and workspaces](access-control.md).
- The earlier plan was AGPL 3.0 plus a closed-source enterprise edition (open core). On 2026-10-17 it changed to the current plan: corporate legal departments generally accept Apache 2.0, embedding in other products meets no obstacle, and there is no boundary between an open-source edition and an enterprise edition to maintain. The cost is that the license does not stop others from hosting it and selling it.
- There is only one Go module and one entry point, `cmd/supabi`. The startup logic is in `internal/app`; all code is under `internal/`, and no Go packages are exposed.
- Whether external contributions use a DCO (commits carry `Signed-off-by`) or a CLA is decided before the first external contribution is accepted.
- Do not copy code from copyleft projects such as AGPL and GPL; they are incompatible with Apache 2.0. Before adding a dependency, confirm that its license allows distribution under Apache 2.0.

## 8. Reference projects

| Project | License | What we borrow |
|---|---|---|
| Rill | Apache 2.0 | Query IR structure, dialect interface, permission injection, unified query entry point |
| Grafana | AGPL 3.0 | Spec version migration, permission model of actions plus scopes, plugin processes |
| dac | AGPL 3.0 | The validation loop after AI generates a spec |

AGPL projects are studied for design ideas only; no code is copied.

## 9. Extensibility of data sources

The first batch of supported databases is MySQL, PostgreSQL, ClickHouse and Doris/StarRocks. Presto/Trino come after the first version. All of them are now implemented: PostgreSQL, MySQL, ClickHouse, StarRocks, Doris, and Trino (see 9.3), and all pass the same conformance tests. No analytics engine is built in; see 9.2.

MySQL requires version 8.0 or newer: the generated SQL uses window functions (running total), `CAST(… AS DOUBLE)` (share, the difference and growth rate of period-over-period comparison, `TO_FLOAT`) and `REGEXP_LIKE`, and the connection also has to set the session variable `transaction_read_only`. When a connection is tested, the server version is read, and a version below 8.0 is judged a failure with the reason explained. When the version cannot be read, common old servers are recognized by the way they fail: the encrypted connection handshake fails (a 5.7 compiled with an old OpenSSL accepts only RSA key exchange, which Go no longer offers by default), or the server does not recognize `transaction_read_only` (before 5.7.20). These failures carry an error code, and the UI explains them in the user's language. The check happens only when a connection is tested; existing data sources are saved and queried as usual. MariaDB version numbers differ from MySQL's, so it is not judged by version. Whether 5.7 is supported: see [Deferred items](../backlog.md).

The goal is that adding a database only requires implementing the interface and passing the tests, without changing the query compiler or the frontend. To get there:

1. **Keep the driver interface small**: connecting and health checks, query execution with cancellation, metadata listing (databases, tables, columns), mapping physical types to logical types, and returning the dialect.
2. **Split the dialect into several small interfaces by capability** (identifier escaping, time functions, type conversion, paging, placeholder style and so on), provide an ANSI default implementation, and let each database override only the parts that differ.
3. **Capability declaration**: a dialect declares whether it supports window functions, CTEs and so on. The compiler uses this to choose a form or to raise a clear error, instead of generating SQL that will fail.
4. **Conformance test suite**: the same set of query IR cases is run against every driver and the results are compared. A new database counts as integrated once it passes this suite.
5. **Connection settings are declared by the driver**: the driver supplies a structural description of its settings, and the frontend renders the connection form from it automatically.
6. **Table identity has three parts from the start** (catalog, schema, table), which leaves room for multi-catalog engines such as Trino. When a driver lists tables, it reports the level each table sits at: PostgreSQL has two levels, database and schema; Trino has two levels, catalog and schema; MySQL, StarRocks, Doris and ClickHouse have one level, the database.
7. **Databases with compatible protocols share a driver and each implement their own dialect**: Doris and StarRocks reuse the MySQL protocol driver. The two share one dialect and differ only in the argument order of `date_trunc`.

The test suite from item 4 is in `internal/conformance`. The steps to integrate a new database: implement the dialect in `internal/dialect`; implement the driver in `internal/datasource/<name>` and call `conformance.Run` in its tests; import the driver package in `internal/app`; and add a test database service in `compose.yaml`.

### 9.1 Differences between databases that remain

The suite guarantees that the same query gets the same values on every database, but the following differences come from the databases themselves and have not been smoothed over so far:

| Difference | Description |
|---|---|
| How numbers are represented | Summing an integer column returns an integer in PostgreSQL and a decimal in MySQL; the values are the same, but the type the API returns differs |
| Whether text comparison is case-sensitive | Depends on the database and the column collation. MySQL is case-insensitive by default and PostgreSQL is case-sensitive, which affects equality filters, `contains` and grouping |
| Order of text sorting | Depends on the collation, Chinese in particular |
| Boolean type | MySQL's boolean is `TINYINT(1)` and is recognized as an integer |
| Moment of the daylight saving time switch | MySQL compares in local time in the data time zone, so the hour that repeats when daylight saving time ends cannot be put in order; PostgreSQL compares by absolute instant and has no such problem |
| Precision of decimal division | ClickHouse decimal division keeps the decimal places of the dividend, so `350.25 / 2` gives `175.12`; Trino takes the larger number of decimal places of the two operands and rounds, giving `175.13`. A ratio measure written in native SQL in a dataset must be cast to floating point before dividing; the `/` of standard expressions already does this |
| How text matching is written | ClickHouse uses `position`, `startsWith` and `endsWith`; the others use `LIKE`. There is no difference for the user |
| All ClickHouse times are instants | `DateTime` stores an instant, and the time zone affects display only. The role of the data time zone here is that time text without a time zone in dataset SQL is parsed in it |
| ClickHouse has no boolean type for comparison results | A comparison expression returns the integer 0 or 1 |
| ClickHouse returns the default value of the type for the min or max of no rows | Not NULL; for times it is the year 1970. The field's `min`/`max` and the `MIN`/`MAX` in standard expressions have been rewritten as `minOrNull`/`maxOrNull`; a metric written in native SQL must be written this way by its author |
| StarRocks, Doris and Trino have no read-only session | Read-only cannot be enforced on the connection and relies only on the permissions of the database account. Their parameters are escaped by the client and spliced into the statement, rather than bound on the server |
| Trino names are case-insensitive | Even when quoted, and the column names in results are all lowercase. Two dataset column names that differ only in case will conflict |
| Trino does not treat text as a date or number | Parameters bound by the platform are already converted by type; values written by hand in dataset SQL must be written as `DATE '2026-01-01'` or `CAST(… AS date)` |
| StarRocks and Doris have only time types without a time zone | Same as MySQL's `DATETIME`; they are handled as local time in the data time zone |
| MySQL needs the time zone tables | When the server has not loaded them, the connection is refused with a hint, instead of returning wrong results |

A dataset's source SQL is written in the dialect of the data source itself and is inherently not portable. A calculated field written with [Standard expressions](expressions.md) is portable; written in native SQL it is not.

### 9.2 No built-in analytics engine, no file upload

On 2026-10-19, data upload and the built-in DuckDB engine were removed. Before that, CSV, Excel or Parquet files could be uploaded; each file was converted to Parquet and became a table, which was queried by a DuckDB embedded in every instance and locked so that it could neither reach the network nor load extensions. The reasons for removal:

- An uploaded table existed only in SupaBI's own engine and could not be joined with data already in the user's database, so it was of limited use.
- To keep dataset SQL from reading files of other workspaces and files on the server, the engine had to be locked down; a multi-instance deployment then needed either a shared volume or a separate cache sync, a cost out of proportion to the value.
- DuckDB needs CGO: the binary was about 84 MB, and cross-compiling needs a C toolchain for each target platform. After the removal the binary does not depend on CGO.

If files or data from other systems need to be brought in later, it will be done as data integration: write the data into the OLAP database the user already uses (such as ClickHouse, StarRocks, Doris), then analyze it through datasets like any other table, so that it can be used together with the existing data. This is not designed yet; see [Deferred items](../backlog.md).

### 9.3 Trino

Implemented 2026-10-21.

**Scope**

- Trino and distributions based on it (such as Starburst) are supported. PrestoDB is not supported: since the two split, the protocol headers differ, and Trino's Go driver cannot connect to it; see [Deferred items](../backlog.md).
- Trino 418 or newer is required: the conformance tests pass on both 418 and 483, and earlier versions have not been tested. When a connection is tested, the server version is read, and a version below 418 is judged a failure with the reason explained, done the same way as for MySQL; existing data sources are queried as usual.
- The driver is the official `trino-go-client`. It is a pure Go implementation, so the binary still does not depend on CGO. When a query is canceled, the driver tells Trino to end it, which meets what `Conn` requires of cancellation.
- Only login with a username and password is supported. The driver sends the password only over HTTPS; if a password is filled in but HTTPS is not selected, the connection fails at once with the reason explained. For Kerberos, JWT and OAuth2 see [Deferred items](../backlog.md).
- Every query carries the source `supabi`, so Trino administrators can recognize it in the query list, which serves the same purpose as PostgreSQL's `application_name`.
- The category is OLAP.

**Connection settings**

| Setting | Description |
|---|---|
| `host` | Required |
| `port` | Default 8080 |
| `user` | Required. Without a password, Trino treats it only as an identity and does not verify it |
| Password | Optional; if filled in, HTTPS must be used |
| `secure` | Whether to use HTTPS, default no |
| `catalog` | Optional; used when a statement does not name a catalog |
| `schema` | Optional; used when a statement does not name a schema; `catalog` must be filled in first |

**Database and table structure: listing all catalogs**

- A table sits at two levels, catalog and schema, and the first level of the tree is the catalog.
- For each catalog, `system.jdbc.columns` is read (it carries column comments), and table comments are read separately from `system.metadata.table_comments`. The default catalog is read first and the others in name order; `system` is not listed. Reading stops once `MaxCatalogColumns` (5000 columns) is reached, and the result is marked as truncated, as with other databases.
- When reading a catalog fails (for example the database behind it cannot be reached, or the account lacks permission), that catalog is skipped and the others are listed as usual. Otherwise one broken catalog would make the whole tree impossible to open.
- Table names are given as they must be written in a statement: a table in the default catalog and default schema is just the table name; a table in another schema of the default catalog is `schema.table`; a table in another catalog is the full name `catalog.schema.table`. For this, `datasource.Table` and `SourceTable` in the API gain an optional `catalog`, with the same meaning as `schema`: it is empty when the table can be found without writing it. Clicking a table name in data exploration inserts this name.
- With catalogs such as Hive that have many tables, one read can be slow and is bounded by the query timeout.

A dataset's table source (`type: table`) has only `schema` and `table`; `catalog` was not added this time. Datasets in the UI are all generated from SQL in data exploration, and the table source exists only in the API. So on Trino a table source can only point to a table in the default catalog; a table in another catalog must be written as a SQL source; see [Deferred items](../backlog.md).

**Dialect and driver**

| Aspect | Situation in Trino | What we do |
|---|---|---|
| Time | The session time zone can be set | Set the session time zone to the data time zone, the same idea as PostgreSQL: converting a value to `timestamp(6) with time zone` gives an instant; a column without a time zone is interpreted in the data time zone, and a column with a time zone is already an instant. Precision 6 keeps the microseconds that warehouses often store, and it is also a short timestamp type, which Trino computes quickly |
| Truncation and shifting | In `date_trunc` a week starts on Monday; when `date_add` adds months, a day that does not exist in that month is clamped to the end of the month | For weeks that start on Sunday, follow PostgreSQL: shift one day later first, truncate, then shift back |
| Paging | `OFFSET` must be written before `LIMIT` | The dialect gains `Page`, and the compiler writes `LIMIT` and `OFFSET` through it |
| Parameters bound as text | The compiler binds dates, times read as local time, and decimals that must keep all their digits as text. Other databases read the text as a date or number according to how it is used; Trino does not, and `date >= varchar` fails outright | The dialect gains `TextAs`; Trino adds a `CAST` to these parameters and other databases are unchanged. `{{parameter}}` in dataset SQL is likewise converted according to the type of the parameter |
| How parameters are sent to Trino | The driver by default writes parameters as literals, placed after `EXECUTE … USING`. But sent this way, Trino reports error positions wrongly (both 418 and 483 add the column offset of the first line to every line), and a statement with parameters cannot be run with `EXPLAIN` | The driver itself writes the parameters into the statement before sending it. The literal form uses `Serial` from the official driver, exactly the same as what it writes after `USING`; which `?` in a statement are parameters is found lexically by `sqlrefs.Placeholders`, and a `?` in a string, a quoted name or a comment does not count. Error positions reported by the server are then converted back to the original statement |
| Division | Integer division gives an integer; for decimal division, the number of decimal places of the result is the larger of the two operands, and the result is rounded | The platform's `/` first casts a dividend that is not floating point to `decimal(38, 10)` |
| Read-only | There is no read-only session. A read-only transaction can be used, but every query costs two extra round trips, and closing a result early makes the transaction abort | No transaction is opened. SQL is always wrapped as a subquery, so a write cannot fit in; in the end we rely on the permissions of the Trino account, the same as for StarRocks and Doris |
| Name case | Names are case-insensitive even when quoted, and the column names in results are all lowercase | The compiler reads results by position and is not affected |
| String functions | There are no `LEFT`, `RIGHT` or `CHAR_LENGTH`, and no `ends_with` | Written with `substr` and `length` |
| Median | Only the approximate `approx_percentile`, and it does not interpolate | Not provided, the same as MySQL |
| Statement text | Strings have no backslash escapes, there are no `$`-quoted strings, and `#` does not start a comment | All three items of `Lexis` are false |

The differences that remain are listed in the table in section 9.1.

**Local environment and tests**

- The Trino service in `compose.yaml` is in the `olap` profile and is not started normally (the JVM takes 1 to 2 GB of memory); `make test-olap` tests it as well.
- The configuration of the two catalogs is in `dev/trino/catalog`: `memory` lets the conformance tests create and drop tables; `postgres` uses the postgresql connector and, with a read-only account, reads the sample data in the local development Postgres, so nothing needs to be loaded separately, and the data is still there after the container restarts.
- The conformance tests normally run against Trino 483. 418 was run by hand once on 2026-10-21, and everything passed.

**Frontend**

The page logic is unchanged; only these things were added: the type name and logo; the names of the two settings `catalog` and `schema`; table names on the data exploration and data source pages carry the catalog; SQL formatting uses the Trino dialect that `sql-formatter` ships with. The editor's syntax highlighting uses standard SQL, and autocomplete does not recognize catalogs yet; see [Deferred items](../backlog.md).

## 10. Multiple languages and time zones

Both are cross-cutting requirements that are very costly to retrofit, and both are followed from the first line of code.

### 10.1 Multiple languages

| Scope | Approach |
|---|---|
| UI text | The whole frontend goes through language packs, with no hard-coded strings. Simplified Chinese and English first |
| Backend errors | The API returns an error code plus parameters, which the frontend translates; the backend returns no hard-coded natural-language text |
| Server-generated content | Subscription emails, push messages and the headers of export files are rendered on the server, so the backend also needs language packs and generates the content in the language of the recipient |
| Display of numbers, dates and currency | Dataset fields and charts store a structured number format ([Dataset model](dataset.md) 5.5), and the frontend renders it according to the locale of the user (thousands separator, decimal point, month names and so on) |
| AI assistant | Answers in the language of the user; the `label`, `description` and `synonyms` of dataset fields are what it relies on to understand questions in several languages |
| Language setting | A user-level preference; it falls back to the organization default, then to the browser language |

Translation into several languages of content that users create themselves (dashboard titles, field display names and so on) is not in v1; see [Deferred items](../backlog.md).

### 10.2 Multiple time zones

Four different time zones are involved, and they must be kept apart:

| Time zone | Meaning | Where it is set |
|---|---|---|
| Storage time zone | Timestamps in the metadata database | Always UTC |
| Data time zone | Which time zone the time columns without a time zone in the user's database actually represent | Set on the data source, and can be overridden on a dataset field |
| Query time zone | The time zone that bounds grouping by day and by month; the time zone that "Today" and "Last 7 days" refer to | Workspace default, can be overridden by a dashboard; that is, the `timezone` of the query IR |
| User time zone | How system times such as "Created at" and "Last refreshed" are shown in the UI | User preference, falls back to the browser time zone |

Rules:

1. **The query time zone follows the workspace by default, not the viewer**. Otherwise "Yesterday's sales" on the same dashboard would differ from person to person. A dashboard can separately choose "Use the viewer's time zone".
2. **Time zone conversion happens inside the database**: before time is truncated by granularity, the data time zone is converted to the query time zone. The dialect interface must implement this capability.
3. The `date` type is not converted between time zones.
4. Relative times and the default values of dynamic parameters (such as `today-1d`) are all parsed in the query time zone.
5. The planned time of scheduled jobs (subscriptions, alerts) carries a time zone, and daylight saving time is handled correctly.
6. Times in query results are returned as local time in the query time zone, without an offset, and the frontend does no further conversion. This holds for dimensions, detail columns, the `min`/`max` of time fields, and metrics of a time type. Aggregation and sorting by a time measure both use the actual instant, and the result is converted to local time only at the end: when daylight saving time ends, wall-clock times repeat, and taking the maximum by local time may pick the earlier instant. MySQL, StarRocks and Doris have no instant type, and aggregate and sort by local time in the data time zone; see the daylight saving time row in 9.1.
7. The query time zone is part of the query IR, so it takes part in the cache key automatically.

A locale setting close to the time zone is the **week start day** (Monday or Sunday). It is workspace-level, affects grouping by week, and is likewise handled by the dialect interface.

The **first week** is also a workspace-level setting: which week counts as week 1 of a year. It is used only to write week-grouped values as "Week number" ([Dataset model](dataset.md) 5.5). It does not enter the query and does not take part in the cache key: grouping by week uses only the week start day, and the week number is counted by the frontend from the first day of that week. It is saved as `firstWeekDays`, that is, how many days of week 1 must fall in the year at least:

| `firstWeekDays` | Rule | Week 1 of 2026 (week starts on Monday) | Week 1 of 2027 (week starts on Monday) |
|---|---|---|---|
| 4 (default) | At least 4 days in the year. With Monday as the start this is ISO 8601 | 2025-12-29 ~ 2026-01-04 | 2027-01-04 ~ 01-10 |
| 1 | The week that has January 1 | 2025-12-29 ~ 2026-01-04 | 2026-12-28 ~ 2027-01-03 |
| 7 | The first full week | 2026-01-05 ~ 01-11 | 2027-01-04 ~ 01-10 |

The days before week 1 belong to the last week of the previous year. In the workspace settings, "First week" comes after "Weeks start on"; the workspace admin changes it, and existing workspaces take the default.

## 11. Frontend constraints

Tech stack: Vite, React, TypeScript. The base component library is shadcn/ui (built on Radix primitives and Tailwind CSS) and the base chart library is ECharts, but business code may not use either of them directly.

### 11.1 Charts: must be fully encapsulated

The chart spec is a declarative structure we define ourselves; it is persisted, generated by AI and migrated across versions. An ECharts configuration object must not appear in the spec, the API or business code.

```
Chart spec + query result  →  adapter  →  ECharts config  →  render
```

- The adapter is the only place that knows ECharts. Replacing or adding a rendering engine only requires a new adapter.
- Effects the spec cannot express are handled by extending the spec. We provide no "write the ECharts config directly" backdoor, or the spec would no longer be portable or validatable.
- Tables, pivot tables and KPI cards do not depend on ECharts; they are implemented by our own components and are likewise driven by the spec.

### 11.2 Components: one export point, layered encapsulation

Hard rule: business code may import components only from our own component package, and must not import Radix, the code generated by shadcn, or any other underlying library the component package uses. This is enforced with lint rules.

Inside the component package there are three layers:

| Layer | Scope | Property definition |
|---|---|---|
| Base components | Buttons, inputs, selectors, dialogs, tabs, tooltips, dropdown menus, icons and other high-frequency components | Fully custom; exposes only the properties we need and does not inherit types from the underlying library |
| BI domain components | Field selectors, filter condition editors, result tables, dashboard grids and so on | Fully custom, composed from base components |
| Complex components | Forms, tables for admin lists, date pickers, trees and so on | Thin wrappers at first: the properties are a narrowed subset of the underlying library's properties, and are tightened into custom ones as usage grows |

- Design tokens (color, spacing, radius, font size) are defined by us and then mapped to shadcn's CSS variables (`styles.css`). Dark mode and white-labeling both depend on this layer.
- Code editors (source SQL, calculated field expressions) are likewise imported only from the component package. They use CodeMirror underneath, whose colors come from the design tokens; it is large, so it is loaded only when first displayed.
- Using thin wrappers for complex components is a deliberate trade-off: the interface surface of forms and tables is very large, and redefining all of it at the start would badly slow progress and would easily produce empty shells that lack features or just pass everything through unchanged.
- shadcn components are generated by its CLI into `packages/ui/src/shadcn/` and kept as close to upstream as possible, treated as an underlying library inside the repository: components from the shadcn ecosystem (such as AI Elements) refer to each other by path, and upstream fixes can be absorbed by regenerating with the CLI. Our wrappers sit outside it, and the properties exposed to the outside are defined by the wrappers.
- Tailwind is used only inside the component package, its class names carry the `tw:` prefix, and its global reset (preflight) is not enabled. Business styles remain plain CSS, and the prefix guarantees that business class names never collide with Tailwind's utility classes. To adjust the look of a component, business CSS may only use the `lb-*` class names on the root element of the wrapper, and must not depend on the internal structure of the underlying library.
- To test popups such as opened dropdowns and menus, use `@supabi/ui/testing`, which does not rely on the specific events the underlying library uses to trigger a popup.

### 11.3 Package structure

| Package | Contents | Depends on |
|---|---|---|
| `ui` | Components and design tokens | Underlying component library |
| `charts` | Chart spec types, adapter, rendering components | Underlying chart library |
| `app` | Admin console and editors | `ui`, `charts` |
| Embed SDK (later) | Dashboard rendering only | `charts` and the parts of `ui` needed for rendering |

The embed SDK has to run inside the host page and is sensitive to size and style isolation. This is why `charts` is a separate package, and why the rendering path depends on the underlying component library as little as possible.

### 11.4 Lazy loading

- The sign-in page and the top bar load on first paint; My dashboards, Workbench, Data exploration, and the system and workspace settings are each downloaded only when first opened. A viewer looking at dashboards downloads only the dashboard and chart code, not the editors; ECharts is downloaded only when a chart is opened. The code editor was already loaded only when first displayed.
- The `ui` package declares that only CSS has side effects (`sideEffects` in `package.json`), so components that are not used stay out of the first paint. As a result, the styles of a component load with the chunk it lives in and may come after `app.css`: rules that override underlying library styles are written in the component's own CSS, after the underlying library styles, and not in `app.css`.
- After a new version is deployed, the chunks of the old version no longer exist, and an already open page that switches to an area not yet loaded cannot fetch the file. The page then refreshes itself once to get the new version; an error is shown only if it still fails after the refresh.
- The build of 2026-10-19: the first-paint JavaScript dropped from 2,262 KB (gzip 708 KB) to about 849 KB (gzip about 276 KB).

## 12. Workbench

The top bar offers, in order, "My dashboards", "Workbench", "Data exploration" and "Workspace settings". My dashboards is the read-only entry for readers: dashboards are listed by folder on the left (empty folders are not shown), and the selected dashboard is shown on the right. On a narrow screen the list and the dashboard become two screens ([Charts and dashboards spec design](chart-dashboard.md) 3.16). Data exploration handles writing SQL and trial runs; Workbench manages datasets, charts, dashboards and data sources. Data exploration and Workbench are open only to data developers and administrators, and both use the data sources and permissions of the current workspace.

Settings are split into three entries by management scope. "System administration" in the avatar menu maintains global users, global groups and all workspaces in one place; "Personal settings" manages one's own account and password. "Workspace settings" in the top bar navigation contains General, Members and access, and User attributes, and its title shows the name of the current workspace. A data developer who enters workspace settings sees only the read-only User attributes; system administration is limited to system administrators and does not depend on the current workspace. From the workspace list in system administration one can enter the same set of settings for a given workspace, which is no longer mixed into one page with the configuration of the current workspace.

Users and groups belong to the organization as a whole; a workspace stores the grants to them and its own custom user attributes, and there are no workspace groups or global custom attributes. For the routes and permission boundaries of the three kinds of settings, see [Access control and workspaces](access-control.md) 2.1–2.2.

The Workbench layout follows a code editor, and its look is the "island" style: the side panel, the editor and the bottom panel are each a rounded surface floating on the same base color, with gaps between them, and the gaps are the handles for dragging to resize; the top bar, the icon strip and the status bar belong to the base color itself. My dashboards and the three kinds of settings pages use the same look; for the settings pages see [Access control and workspaces](access-control.md) 2.2.1.

```
┌ Top bar ───────────────────────────────────────────────────────────┐
├──┬────────────────────┬────────────────────────────────────────────┤
│Ic│ Side panel         │ Editor                                     │
│on│ What can be opened │                                            │
│s │ in this section    ├────────────────────────────────────────────┤
│  │                    │ Bottom panel: results, preview, references │
├──┴────────────────────┴────────────────────────────────────────────┤
│ Status bar: path · rows and time · Unsaved                         │
└────────────────────────────────────────────────────────────────────┘
```

| Section | Side panel | Editor |
|---|---|---|
| Dashboards, charts, datasets | Folder tree; can create, rename, move and delete, and supports drag and drop | Each has its own editor |
| Data sources | Name list | Details or create form |

- **Data exploration has no script resource.** The route is `/explore`; a separate panel on the left holds the data source selector and the database and table structure, the right side holds the query tabs and the SQL editor, and below are the results, the query plan and the run history. There are no personal/workspace script categories, no folders and no save button. Tabs, SQL drafts and run history are stored in the current browser by account and workspace, and closing a query on purpose asks for confirmation before the draft is discarded. Windows of the same browser share the list of queries and each shows its own one of them: a window follows what another opens or closes (the `storage` event), and works out every change of its own from the list as stored, not from what it last knew. A dataset's SQL window keeps a list of its own. Two windows editing the same query are not reconciled: its draft is whichever wrote last.
- **SQL, data source and parameters belong to the dataset.** The exploration page can create a dataset draft directly; when SQL editing is opened from a dataset, it brings in the current draft of the original form and shows the name of the dataset being edited. "Apply and return to dataset" only updates the SQL, data source and parameters of the original form, and the dataset then validates everything together and saves a revision. There is no separate SQL resource or revision history.
- **Lineage depends on the dataset's own SQL.** The layers are data source → table → dataset → chart → dashboard; SQL in which no table name can be found is linked directly to the data source.
- **SQL is written only in data exploration.** The dataset editor only does configuration: the name and type of fields, dimension or measure, calculated fields, and preview. A new dataset is generated from SQL in data exploration; changing the SQL of an existing dataset also goes back to data exploration, and the result is applied back to the dataset afterward. Data exploration executes SQL the same way a dataset does (wrapped as a subquery, read-only, row-limited); there is no other execution path.
- **Workbench opens only one resource at a time**, with no multiple tabs. Switching back and forth uses the search panel (Ctrl+K / ⌘K): with no input it lists recently opened resources. Leaving an editor with unsaved changes asks first. Data exploration is a standalone page that keeps its query tabs, SQL drafts and results while the app is open, so they are still there when you switch to another top bar entry and come back; after a refresh the tabs and drafts are restored, and the results must be run again.
- **The side panel, the panel beside the editor, the bottom panel and the status bar belong to the shell**; the current page fills in their content, so the position and behavior of the result area are the same in every editor. Panels can be collapsed and dragged to resize, and their state is saved in the browser.
- **References** are in the bottom panel: which datasets use a data source, which charts and dashboards use a dataset, and which dashboards use a chart.

## 13. Not yet decided

| Item | Decide before |
|---|---|
| Trade-offs in the charts and dashboards spec that have not been discussed | The first version has been implemented according to [Charts and dashboards spec design](chart-dashboard.md); its section 7 lists the points to be confirmed |
| Which pages to render when a paginated dashboard is printed | When printing is redone; see [Charts and dashboards spec design](chart-dashboard.md) 3.11, 3.13 |

### Browser tabs for related resources

Related jumps in the editors (references, lineage, source dataset, source chart, source SQL, and creating a chart or dataset from an existing resource) open in a new browser tab, which keeps the current editing session. Main navigation such as the sidebar, lists and search still switches within the current tab. Links use real links with `target="_blank"`, and keep the browser's right-click, copy-link and shortcut behavior. The new tab is in the same workspace as the one it was opened from, because the address names the workspace ([Access control and workspaces](access-control.md) 2.4).

The "Edit SQL in data exploration" of a dataset also opens in a new tab. The SQL editing page sends the result back to the original dataset form, replacing only the SQL, data source and parameters and keeping the unsaved changes to the name and fields; only after the original form confirms receipt is the SQL editing window closed and control returned to the original form. If the original form has been closed, the page says clearly that the result cannot be sent back, and must not claim that applying succeeded. The SQL is not put in the URL. Each return window keeps its own set of SQL tabs; after switching queries or other pages and then refreshing, the tabs and drafts of that window are still restored.
