# Exports, background jobs and the export center

Exports have two sources: SQL export from Data exploration, and chart data export on a dashboard. Both produce CSV or XLSX and share the same background jobs, file storage, limits and the "Exports" entry in the top bar.

## 1. SQL export

In Data exploration, the user submits the current SQL (only the selected text if any is selected) together with a snapshot of the parameter settings. The job reruns it in the background, keeps the SQL's own `LIMIT` and does not carry over the preview's 1000-row cap. The column names and order the query returns become the file header directly, and an empty result still produces a file with a header. It requires the developer or admin role in the current workspace.

## 2. Chart data export

### 2.1 The switch

The chart spec gets an optional property `allowExport`, which defaults to `false`:

```jsonc
{ "specVersion": 1, "query": { /* … */ }, "viz": { /* … */ }, "allowExport": true }
```

- It is set in the "General" group of the chart editor's settings panel. The switch is named "Allow data exports" and is off by default. The help text says: once it is on, anyone who can see the chart can export its complete data from the dashboard, and row-level and column-level permissions still apply.
- **The switch applies to every role**, including developers and admins. When it is off, nobody has an export entry on the dashboard. This way, whoever builds a dashboard sees what a viewer sees, and nobody has to guess by role.
- The switch belongs to the chart, so when several dashboards reference a chart it is the same on each of them. Changing the switch is changing the chart, which requires the developer role, like any other chart edit.
- The switch is not a security boundary against developers: they can still write SQL against the data source in Data exploration and export it. It limits whether dashboard consumers can take the data away as a whole. On a dashboard, a viewer sees only the rows the chart displays (at most 1000 rows by default), but an export gets the full result, which is exactly why the author must turn it on explicitly.

### 2.2 Who can export and where

- Anyone who can open the dashboard (an authorized viewer; developers and admins see all dashboards, [Access control and workspaces](access-control.md) section 4.2), where the chart's `allowExport` is `true`, can export that chart's data from that dashboard.
- The entry is "Export data" in the "…" action bar at the top right of the chart. It appears only when `allowExport` is `true`, and is the same in view mode, edit mode and the in-page preview. Once opened, it works as in Data exploration: choose the format, change the file name (default "Dashboard name - Chart name"), and see the row limit, the retention time, and a note that the export is the full result under the current filters.
- An export runs against the **saved** dashboard: the definitions of filters, chart links, widgets and charts come from the saved version, while the filter values the viewer has currently selected, the dynamic choices and the click chart links are submitted with the request. So in edit mode and the in-page preview, an export is possible only when the draft matches the saved dashboard. With unsaved changes (including a new dashboard that has never been saved), the button is disabled with the hint "Save the dashboard to export", so the exported data never differs from the draft in front of the user. The widget properties panel of the dashboard editor also shows the chart as "Data exports allowed" or "Data exports not allowed", and provides an entry to open the source chart and change it.
- The chart editor does not offer export in the first version; developers can export in Data exploration.

### 2.3 What is exported

An export takes the same data as the chart the viewer is looking at on the dashboard right now, only without truncating to the displayed row count.

- **Filters and context**: the request body is the same as for a dashboard widget's data fetch, including global filters, chart filters, dynamic choices, `useChartFilters`, click chart links and the drill-down path ([Charts and dashboards](chart-dashboard.md) sections 3.5 and 2.10), plus the format and the file name. The server composes the query by the same rules as a data fetch, and rejects unknown filters, unknown candidates and requests that change fixed conditions. A viewer still cannot submit an arbitrary query.
- **Rows**: the query's own `sort`, `limit` and `offset` are kept. The "Most rows shown" setting the author makes under "General" is stored in `query.limit` and is part of the question the chart asks (for example Top 10), so the export likewise contains only those rows. When no `limit` is set, the default returned row count of a data fetch is not used and the full result is exported, subject to the export row limit. The editor points this out when `allowExport` is on and a row count is set.
- **Columns and header**: the column order matches the query output. Columns hidden in a table (`viz.hiddenColumns`) are not exported, matching what the dashboard shows; for other chart types, all output columns of the query are exported. When the chart uses a field the requester cannot see, the dashboard shows "No permission" for this chart, and the export is rejected the same way (`hidden_field`). The header uses the column names shown on the dashboard, including dataset display names, renames in the chart, and the descriptions of year over year, period over period, share and running total. The frontend generates these descriptions in the interface language, so the page that starts the export submits the header text with the request; the server accepts only headers for query output columns, limits their length, and uses the dataset display name for any column that is missing. The header affects only the requester's own file and has no bearing on permissions.
- **Values**: raw values are written, without display formats (units, thousands separators, decimal places, prefixes and suffixes, percentages). XLSX keeps number, date and boolean types, so calculations can continue in Excel. Share and growth rate are written as decimals, for example `0.25`; a running total is written as the accumulated value. The other rules are the same as the file format of SQL export, see section 4.
- **By chart type**: always the rows of the query result, never the chart's presentation structure. A pivot table exports flat rows: each row has one column each for the row dimensions, the column dimensions and the measures, and is not expanded into a crosstab. Totals, subtotals and the Sankey chart's totals between layers are extra queries and are not exported in the first version. The "Other" that merges series and slices is only a drawing rule, and the export keeps the original rows.
- **Time**: time ranges are resolved at the job's creation time, and timestamps are written in the workspace time zone, matching the dashboard display.

### 2.4 Snapshot and permission recheck

- When the API creates a job, it checks that the dashboard is visible, the widget exists and the chart the widget references has `allowExport` set to `true`. It composes the query from the current definition and the requester's data permissions, compiles it once, and rejects the request at once on any error. The export snapshot stores the dataset ID, the composed query IR (which already contains the values from the request), the columns and header to write, the workspace time zone and the week start day. The job record separately stores the dashboard ID, widget ID and chart ID, and the dashboard name and chart name at creation time, for rechecking permissions and for showing the source in the export center.
- When the worker runs, it queries as the requester: it rereads the dataset definition and compiles with the requester's current row-level and column-level permissions (developers and admins are not subject to data permissions, the same as dashboard data fetches), and it does not use the query cache. It checks again before execution and before committing completion: the account is valid, the requester is still a workspace member, still sees the dashboard, the widget still references the same chart, and the chart still has `allowExport`. If any item fails, the job fails and no file is published.
- The snapshot fixes the question the author defined at job creation: later changes to the chart do not affect jobs already submitted. Row-level and column-level permissions are always computed at execution time, so a tightening of permissions takes effect at once in jobs that have not finished.
- If the requester loses column-level permission on a field only after the job was created, the query is rejected at execution and the job fails with `export_forbidden`.

## 3. Execution and recovery

- The API validates the format, name and source, writes the job and the export snapshot to Postgres in one transaction, and returns the job ID at once. SQL export also validates the SQL parameters and which data source it belongs to. Each user can have at most 5 queued or running exports, across workspaces and sources.
- The worker claims jobs atomically with `FOR UPDATE SKIP LOCKED`. Each claim produces a new execution token with a 30-second lease, renewed every 2 seconds while recording the number of rows written. After a lease expires the job can be claimed again, at most 3 times; an old token cannot commit a result.
- The worker rechecks the account status and the permission the source requires (SQL export requires the developer role; for chart export see section 2.4). It uses the same connection management, read-only database connections and data source concurrency limits as the API, and exports use at most half of a data source's query slots. The database driver reads row by row, and CSV and XLSX are written row by row, so the whole result is never held in memory or in the query cache. Concurrency limits in different processes are still counted separately.
- Permissions are checked again once the file is complete. The completion status, the file metadata and the "new result" mark are committed in one transaction; a cancel request and the completion commit are serialized on the job row. If the cancel is accepted first, the file is not published even if it has already been generated.
- Closing the page or signing out does not cancel a job. The user can cancel a job in the export center; a queued job is cancelled at once, and a running job interrupts its query at the next heartbeat. If the process exits, another worker recovers the job after the lease expires.
- A retry queries the data source again, so the data may differ from the first attempt or from an earlier preview; an export is not a historical snapshot of the database. The source snapshot, the workspace time zone and the export format stay as they were at creation. Relative dates are computed from the job creation time, and timestamps are written in the workspace time zone at the time of submission, consistent with the exploration preview and the dashboard; date fields get no time zone shift.
- A failed job keeps only a reason code, in its record and in the audit entry, for the person who asked for the export. The error itself goes to the application log, for whoever runs the service: at error level for a fault of the service or its storage (`export_failed`), and at warning level for the rest (the query failed, a limit or the time allowed was exceeded, a permission was lost). A cancelled job writes none.

## 4. Files and limits

### 4.1 File storage

Export files are kept in the export storage. There are two implementations of the storage, chosen by `--export-storage`:

| Implementation | File location | Use for |
|---|---|---|
| `local` (default) | `SUPABI_DATA_DIR/exports/<key>` | A single instance, or multiple instances mounting the same shared volume |
| `s3` | `<prefix>exports/<key>` in the bucket | Multi-instance deployments that do not want a shared volume; AWS S3 or compatible object storage, such as RustFS, Ceph RGW or a cloud vendor's object storage |

The key is `<org>/<workspace>/<export>/<attempt>/result.csv` or `result.xlsx`, the same for both implementations, and is recorded in the job record. `<attempt>` is the lease token of this execution; each execution writes to a different key, so an old worker cannot overwrite a new worker's output. The key must be a relative path: it cannot contain `..` or a backslash, and cannot start with `/`.

The two implementations provide the same set of operations. Export, download and cleanup call only this set and do not distinguish the implementation:

| Operation | Local directory | S3 |
|---|---|---|
| Write | A `.part` file created with mode `0600` | Upload each part as soon as it fills in memory (multipart upload); if the whole file is smaller than one part, write it with a single `PutObject` at commit |
| Commit | Sync to disk, then rename atomically | Upload the last part and call `CompleteMultipartUpload`; the object appears only now |
| Abandon | Delete the `.part` file | `AbortMultipartUpload`; the parts already uploaded are deleted with it |
| Read | Open the file | `GetObject` with the requested range (Range) |
| Delete | Delete the file | `DeleteObject` |
| Sweep | Walk the org directory and delete empty execution directories | List the objects and unfinished multipart uploads under `<prefix>exports/<org>/` page by page |

Deleting a file that does not exist is not an error, the same for both implementations.

Export files are not published as a static directory and can be obtained only through the download endpoint.

**Writing and publishing**. The worker writes while it queries, rechecks permissions after writing (sections 2.4 and 3), commits the file once they pass, and then commits the completion status in Postgres by lease token (section 3). The file can be downloaded only once the database commit succeeds; until then, a committed file is just an object in the storage that no record points to. The handling that follows:

- Failure, cancellation, timeout or loss of the lease happens before the file is committed: the write is abandoned, the local `.part` is deleted and the S3 multipart upload is aborted. The abandon runs in a new context with a short timeout, because the job's own context has often been cancelled by then.
- Committing the file itself fails: delete the key on a best-effort basis. An S3 `CompleteMultipartUpload` that times out may already have succeeded, and the delete covers that case.
- The file is committed, but the database finds the job cancelled or the lease lost: delete the file.
- The outcome of the database commit is unclear (for example a timeout): keep the file and let the orphan sweep decide from the database records (section 5).

`.part` files and unfinished multipart uploads left behind by a process crash are also handled by the orphan sweep.

**Parts**. Each part is 8 MB by default; when the file size limit exceeds 80 GB, the part size is one ten-thousandth of the limit, because S3 allows at most 10,000 parts and every part except the last must be at least 5 MB. An export holds at most one part of buffer in memory, so a worker process holds `--export-workers` parts in total. Parts are uploaded one after another, and reading from the database continues only after a part has finished uploading.

**Checksums and encryption**. A checksum is added only when an S3 operation explicitly requires it (the SDK's `RequestChecksumCalculation` is set to `WhenRequired`); the AWS SDK's new default additional checksums are not enabled, because some compatible storage does not support them. Requests are still signed with SigV4, and production should use an HTTPS endpoint. Encryption at rest is left to the bucket's default encryption setting (SSE-S3 or SSE-KMS), and SupaBI does not configure it separately.

### 4.2 S3 settings

| Startup flag / environment variable | Description |
|---|---|
| `--export-storage` / `SUPABI_EXPORT_STORAGE` | `local` (default) or `s3` |
| `--s3-endpoint` / `SUPABI_S3_ENDPOINT` | The address of compatible storage, such as `https://s3.example.com`; when empty, AWS S3 is used and the address is determined by the region |
| `--s3-region` / `SUPABI_S3_REGION` | Default `us-east-1`. Most compatible storage does not distinguish regions, but this value is used in the signature |
| `--s3-bucket` / `SUPABI_S3_BUCKET` | Required when the storage is `s3`; the bucket must be created beforehand |
| `--s3-prefix` / `SUPABI_S3_PREFIX` | The prefix of object keys, empty by default. Used when several SupaBI deployments share one bucket, such as `prod/` |
| `--s3-path-style` / `SUPABI_S3_PATH_STYLE` | Whether to use path-style addresses (`endpoint/bucket/key`) instead of virtual-hosted style (`bucket.endpoint/key`). Default `false`; self-hosted RustFS and Ceph usually need `true` |
| `SUPABI_S3_ACCESS_KEY_ID`, `SUPABI_S3_SECRET_ACCESS_KEY` | The access key. Read only from environment variables; there is no matching startup flag, so it does not appear in the process list. When neither is set, the AWS SDK's default credential chain is used: environment variables such as `AWS_ACCESS_KEY_ID`, the configuration under `~/.aws`, and IAM roles on EKS, ECS and EC2 |

The S3 parameters are general connection settings, and their names do not contain `export`: other features that need to store files can later share the same bucket, each with its own prefix.

The permissions SupaBI uses: `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` and `s3:AbortMultipartUpload` on `<prefix>exports/*`, and `s3:ListBucket` and `s3:ListBucketMultipartUploads` on the bucket.

The configuration is checked at startup: if `s3` is chosen but the bucket is missing, startup is refused; then `HeadBucket` confirms the bucket is reachable, and a failure (wrong address, secret key or bucket name, or the storage is not ready) also refuses startup, with the reason stated in the error. Unlike Redis, when the storage is unavailable every export fails, and running with a wrong configuration would only delay finding the problem.

**Switching storage**. Existing files are not migrated. After a switch, files in the old storage that have not expired still show as ready to download in the export center, a download returns 410 `export_file_missing`, and after they expire they show as expired as usual; expiry cleanup deleting a key that does not exist on the new storage is not an error. Files left in the old storage must be deleted by hand.

### 4.3 Limits

Both sources use the same set of limits. The system administrator sets them under "System administration → General". They are stored in the metadata database, every instance reads the same values, and a change takes effect at once ([Startup configuration](configuration.md) section 10):

| Setting | Default |
|---|---|
| Export files kept for | 24 hours after completion |
| Export timeout | 15 minutes per attempt |
| Most rows per export | 2,000,000 rows |
| Largest export file | 512 MB |

How many jobs run at the same time depends on the machine and remains startup configuration: `--export-workers` / `SUPABI_EXPORT_WORKERS`, which defaults to 2 jobs at a time per worker process.

These limits protect the disk, memory and execution time of the supabi server. The load on data sources is already bounded by the data source concurrency slots. If a workspace later needs stricter limits, we will add a setting in "Workspace settings" that can only be lowered and never exceeds the system value.

A job fails when it exceeds the row limit, the file size limit, or the XLSX cell or column count limit, and no partial result is published. The file size limit counts the bytes of the final file; for XLSX that is the compressed size.

### 4.4 File formats

CSV uses a UTF-8 BOM and quotes commas, quotes and line breaks by the CSV rules. Text that a spreadsheet might read as a formula gets a leading single quote, while ordinary negative numbers keep their numeric content. CSV carries no field types; when long identifiers or exact decimals need to be opened directly in Excel, prefer XLSX.

XLSX uses streaming OOXML and does not build a shared string pool for the whole table. The first row is bold and frozen; dates, times and booleans use the matching cell types, and original strings stay text. Numbers beyond what Excel can hold in 15 significant digits, or outside its representable range, are saved as text. Each worksheet has at most 1,048,576 rows (including the header); further data goes into the next sheet automatically with the header repeated; there are at most 16,384 columns, and a cell holds at most 32,767 UTF-16 code units. Based on [Microsoft's Excel specifications and limits](https://support.microsoft.com/en-us/excel/excel-specifications-and-limits).

### 4.5 Download

On every request the download endpoint checks the current signed-in identity, the job's owner, the validity period, that the data source still exists, and the permission the source requires in the workspace the export was made in (section 6): SQL export requires the developer role; chart export requires that the requester can still see the dashboard, the widget still references the same chart and the chart still has `allowExport` on. After the author turns the switch off or revokes dashboard access, files already generated can no longer be downloaded, effective immediately. The response is an attachment with caching disabled. A file cannot be downloaded the moment it expires, whether or not the cleanup job has run. The content of a historical file does not update when the data source changes.

With both storage implementations the API reads the file and streams it to the browser, and never reads the whole file into memory. Presigned URLs are not used on S3 either: anyone who gets a presigned URL can download within its validity period, which bypasses the permission recheck and the download audit on every download described above, and also requires the browser to reach the storage directly. Forwarding supports resumable downloads: on S3 the object is read by the range the browser requests, and one download usually sends a single `GetObject`. When the file cannot be found in the storage, 410 `export_file_missing` is returned.

## 5. Scheduling and cleanup

An export the user starts is queued directly by the API. Every minute the scheduler tries to enqueue a cleanup job for each organization that has export records, deduplicated by the hour, so each organization is cleaned once an hour and a missed run is made up promptly after a process restart; the cleanup itself is run by a worker.

One cleanup does three things:

1. **Expired files**: for each record in the database that has expired and is not yet cleaned, delete the file (on S3, `DeleteObject`) and mark it cleaned once the delete succeeds. The key is stored in the record, so this step does not need to list the files in the storage. If a delete fails, the record is kept and the next cleanup tries again.
2. **Job records**: remove jobs in a terminal state that are more than 30 days old and whose files are already cleaned.
3. **Orphan sweep**: list all files under the organization (locally by walking `exports/<org>/`; on S3 by listing objects and unfinished multipart uploads under `<prefix>exports/<org>/` page by page), compare them with the database, and delete files that are older than one hour and are neither referenced by a completed record nor belong to an execution with a valid lease; on S3 such multipart uploads are aborted at the same time, and locally empty execution directories are deleted. The one-hour grace period protects files whose writing began after the cleanup read the database; a valid lease protects jobs that run for arbitrarily long.

Two cleanups of the same organization may run at the same time; a file the other has already deleted or an upload it has already aborted is not an error. On S3 a lifecycle rule can also be set on the bucket as a safety net, for example aborting unfinished multipart uploads after 7 days, but SupaBI does not depend on it.

The API, worker and scheduler can run in the same process or separately; when only the API is started, jobs queue and wait for a worker.

## 6. Export center

The top bar has a single "Exports" entry (a download icon), for everyone signed in, and its icon and meaning do not change with the role. Exports are not in the notification center (the bell, [Announcements](announcements.md) 4.2): the export list already contains the status of every job, and listing them there too would only repeat it.

The export center does not follow the current workspace. It holds the user's exports from every workspace they can enter, so a file started in one workspace can still be downloaded after switching to another, and a result that finishes in another workspace is not missed. Until 2026-11-09 it showed only the current workspace: a file started just before switching could be found only by switching back.

- **List**: all exports the user started in the workspaces they can enter, newest first, with SQL exports and chart exports mixed. Each item shows the file name, format, source ("Data exploration" or "Dashboard name / Chart name", using the names at creation time), status, row count, size and expiry time; a failure shows its reason. When the user can enter more than one workspace, the source starts with the workspace the export was made in, for example "Sales · Data exploration", using the workspace's current name. The list returns only metadata, not the SQL or filter values.
- **Which workspaces**: those the user can enter now (directly, through a group, or as a system administrator), the same as the workspace switcher. The exports of a workspace the user can no longer enter, or of a deleted one, are not listed and cannot be cancelled or downloaded. They come back when access is given again or the workspace is restored, as long as their records are kept.
- **Actions**: queued and running jobs can be cancelled. A successful job shows "Download" while the user still has download permission; when the permission is no longer met (for example a SQL export after the role drops to viewer, a chart that has turned export off, or revoked dashboard access), it shows "Cannot download" with the reason and offers no download. Both are checked in the workspace the export was made in, with the user's role there, whatever the current workspace.
- **New results**: when a job succeeds or fails it is marked as a new result the user has not seen; a job the user cancelled is not marked. The badge on the top bar shows the number of new results in all those workspaces; when a job is queued or running and there is no new result, a small dot is shown. Opening the export center marks all current new results as seen, and those items stay highlighted while it remains open, so there is no need to mark them read one by one.
- **Notice**: when a new result appears, a short notice is shown, for example "Sales detail.xlsx is ready to download" or "Sales detail.xlsx failed to export", with a "View" button that opens the export center.
- **Refresh**: a visible page queries every 3 seconds while a job is running and checks every 15 seconds when none is; polling pauses while the page is hidden and refreshes at once when it becomes visible again. After an export is started, the export center opens and refreshes immediately.
- **Permissions**: viewing one's own export list and cancelling one's own jobs requires only that the user can still enter the workspace the export was made in, whatever the role there and whichever workspace is current. Creating an export still happens in the current workspace: a SQL export requires the developer role, a chart export is covered in section 2.2, and download in section 4.
- Records are kept after signing out and can be viewed the next time the user signs in. There is no email or off-site push.

The bell holds announcements, and later the other messages unrelated to downloads, such as alerts and subscriptions, each kind under a tab of its own ([Announcements](announcements.md) 4.2); the export entry continues to handle only export jobs.

Endpoints: `GET /exports` returns the user's exports, the number of new results (`unseen`) and the limits; each item carries the workspace it was made in (`workspaceId`, `workspaceName`), its source (`source`, `dashboardName`, `chartName`), whether it is a new result (`unseen`), and, when the job succeeded and has not expired but cannot be downloaded now, the reason (`denied`). `POST /exports/seen` marks all of the user's new results as seen. These two, `GET /exports/{id}`, `POST /exports/{id}/cancel` and `GET /exports/{id}/file` need a signed-in user but no current workspace: each export is checked in its own workspace, and the cancel and download events are recorded in that workspace (section 7). The earlier notification table and the `/notifications` endpoint have been removed, and the unread success and failure notifications were converted into new results during the migration.

## 7. Export audit

The key actions of an export are written to the audit log (see [Access control and workspaces](access-control.md) section 7) as a record of where exported data goes, and can be queried in the "Audit log" of System administration by the "Exports" category:

| Event | Recorded |
|---|---|
| Create `export.create` | Export ID, name, format and source. A SQL export records the data source ID, the full SQL text and the parameter values; a chart export records the dashboard, widget, chart and dataset IDs and the filter values in the request |
| Finish `export.finish` | Terminal state (succeeded, failed, cancelled), row count, file size and failure reason code. Recorded by the worker; the actor is the requester |
| Cancel `export.cancel` | Export ID |
| Download `export.download` | The downloading user, row count and file size. A download is the moment data leaves the system, so it is recorded on its own; a refused download is recorded with the outcome "Denied", with the reason stated (expired, permission, source deleted) |

The audit details exist only in the metadata database; the audit lines in the application log do not contain the SQL; file content is not recorded. The full SQL snapshot is kept separately in the job record for 30 days.
