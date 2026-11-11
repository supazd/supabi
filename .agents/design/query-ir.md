# Query IR design (draft v0)

Status: draft, open for discussion. It follows the `Query` structure in Rill's `runtime/metricsview/query.go`, with trade-offs made for SupaBI's positioning.

## 1. Positioning

The query IR is a structured description of "asking one question of a dataset". It is the only contract between the entry layers (drag and drop, AI, embedding, data API) and the query layer.

Three principles:

1. **There is no SQL in the IR**. It can only refer to fields already defined in the dataset by name, and every literal goes through parameter binding. This is the security boundary, and it is also what makes AI output verifiable.
2. **The IR is self-contained**. Dashboard-level filters and chart link conditions are merged into the IR before it reaches the query layer, so the query layer does not know that "dashboards" exist.
3. **The IR describes only what data is wanted**. It has no permissions (the server injects them by identity, and the client cannot specify them), no cache policy (that goes in the request envelope), and no visualization settings (those belong to the chart spec).

## 2. Structure overview

```jsonc
{
  "version": 1,
  "dataset": "ds_orders",              // dataset ID
  "mode": "aggregate",                 // aggregate | detail

  "dimensions": [
    { "field": "region" },
    { "field": "order_date", "grain": "month", "alias": "month" }
  ],

  "measures": [
    { "field": "revenue", "agg": "sum" },
    {
      "field": "revenue",
      "agg": "sum",
      "alias": "revenue_yoy",
      "compute": { "type": "compare", "timeField": "order_date", "offset": { "n": 1, "unit": "year" }, "output": "ratio" }
    }
  ],

  "filter": {
    "op": "and",
    "args": [
      { "field": "order_date", "op": "time", "value": { "last": { "n": 12, "unit": "month" } } },
      { "field": "channel", "op": "in", "value": ["app", "web"] },
      { "field": "region", "op": "ne", "value": "Test region" }
    ]
  },

  "having": { "field": "revenue", "op": "gt", "value": 10000 },

  "sort": [{ "by": "month" }, { "by": "revenue", "desc": true }],
  "limit": 1000,
  "offset": 0,
  "timezone": "Asia/Shanghai"
}
```

## 3. Field reference

### 3.1 `version`

The structure version of the IR. A chart spec persists the IR, and an old spec is migrated version by version when it is loaded.

### 3.2 `dataset`

The dataset ID. A query targets exactly one dataset. Queries across datasets are not supported.

### 3.3 `mode`

- `aggregate` (default): group by the dimensions and compute the measures.
- `detail`: return detail rows, used by the detail table and drill-down. In this mode `columns` replaces `dimensions`/`measures`, and `having`, `filterMeasures` and `compute` are not allowed. Each item of `columns` is the internal ID of a field. To give the column its own display name, write an object: `{ "field": "amount", "label": "Amount paid" }`.

### 3.4 `dimensions`

| Field | Required | Description |
|---|---|---|
| `field` | Yes | The internal ID (`key`) of a field in the dataset. It can be any unaggregated field, not only dimensions |
| `grain` | No | Time grain, available only for fields of type `date`/`timestamp`: `year` `quarter` `month` `week` `day` `hour` `minute` |
| `alias` | No | Output column name, equal to `field` by default. Required when the same dimension appears twice at different grains |
| `label` | No | The name of this column shown to people, which is the field's name by default. `alias` is the identifier the query uses internally to refer to this column, and `label` is used only for display |

### 3.5 `measures`

Each item is a field plus how to aggregate it:

```jsonc
{ "field": "amount", "agg": "sum" }                       // the column name defaults to the field's internal ID: amount
{ "field": "amount", "agg": "avg", "alias": "amount_avg" } // when the same field appears again, give it an alias
{ "field": "user_id", "agg": "count_distinct" }           // a dimension can be aggregated too
{ "field": "arpu" }                                       // metric: no agg
```

- When `field` is a measure or a dimension, `agg` is required, with the value `sum`, `avg`, `min`, `max`, `count` or `count_distinct`. `sum` and `avg` apply only to numeric fields, and `min` and `max` do not apply to boolean fields. A missing `agg` raises `agg_required`.
- When `field` is a metric, do not write `agg`: the aggregation of a metric is in its own expression. Writing it raises `metric_agg`.
- `alias` is the name of this column in the query, and defaults to the field's internal ID when omitted. Column names in one query cannot repeat, so when the same field appears twice, at least one of them needs an `alias`.
- Aggregation is structured. Expression strings are not accepted.

The dataset does not fix an aggregation ([Dataset model](dataset.md) section 6.1). The aggregation is written only here.

An item can carry `label` to give the column its own display name: `{ "field": "amount", "label": "GMV" }`. For a column with a `label`, the name is the label itself, and the result no longer carries `agg` (see section 4). The naming rules are the same as for dataset field names. Names in one query may repeat, and it is up to the author whether they do.

A measure can also use `baseLabel` to give the aggregate name before the computation. The result does not add the aggregate name a second time, but still carries `compute` / `comparison` so that the UI can add a note for share, year over year, period over period or running total. Dynamic options use this property. `label` still means the final name and takes higher priority.

**Derived computation `compute`** (it can be layered on either of the two above)

| `type` | Parameters | Meaning | Version |
|---|---|---|---|
| `compare` | `timeField`, `offset: {n, unit}`, `output: value \| delta \| ratio` | Uses the given time field and its row filter range, shifts it back by the offset, and compares with the comparison period | v1 |
| `percent_of_total` | `within: [dimension alias]` (optional) | Share. An empty `within` means share of the whole; otherwise the share is computed within groups of these dimensions | v1 |
| `cumulative` | `along: dimension output name` | Accumulates along this dimension in order; groups that are the same in the other dimensions each start from the beginning | v1 |
| `rank` | `partitionBy`, `desc` | Rank | Later |
| `moving` | `window`, `agg` | Moving average and so on | Later |

**Execution rules for year over year and period over period**

```json
{"field":"revenue","agg":"sum","alias":"growth","compute":{"type":"compare","timeField":"order_date","offset":{"n":1,"unit":"month"},"output":"ratio"}}
```

- `timeField` must be a date or time field of the dataset. The query must contain a finite `time` range on that field (both start and end present). The conditions may only be connected by AND. OR, NOT, empty dates and other operators are not allowed. `offset.n` is a positive integer from 1 to 1000, and the unit is day, week, month, quarter or year. Year over year shifts back 1 year, and month-over-month shifts back 1 month.
- The current period and the comparison period are aggregated again separately. Only the range of the selected time field in the user's filters is shifted. Other filters, the data source SQL, parameters and row-level permission filtering stay unchanged, so no data beyond the permissions is accessed.
- The comparison period is grouped by the same dimensions. The group key of the selected time field is shifted back and then matched, and the other dimensions use equality matching that includes nulls. Only groups that exist in the current period are returned. A KPI or total with no time dimension compares the whole range.
- `value` is the comparison-period value, `delta` is the current period minus the comparison period, and `ratio` is the difference divided by the comparison period. A missing comparison period returns empty. When the comparison period is zero, the growth rate is empty and the difference is still valid. A negative base is not made absolute. The comparison value and the difference keep the measure's format, and the growth rate defaults to a percentage.
- The time range is first resolved into a half-open interval by the query time zone, the current moment and the week start day, and then the two endpoints are shifted by calendar. Month ends and leap days are clamped to the last day of the target month. If the two endpoints are clamped to the same day, the comparison range is empty. Day and week offsets of timestamps keep the local wall-clock time, so across daylight saving time they are not fixed at 24 hours. DATE fields use calendar parsing and shifting without daylight saving time, and the current date is still taken in the query time zone, so that a midnight jump or a skipped day does not change the date value.
- The time grain must align with the offset: the week grain supports only whole weeks (multiples of 7 days), the month grain supports month, quarter and year offsets, the quarter grain supports whole quarters, and the year grain supports whole years. So year over year at the week grain needs 52 weeks to be chosen explicitly, and cannot use a calendar-year offset.
- Result filters, sorting and pagination run after the computation. Totals and subtotals are recomputed, and growth rates cannot be added up. A total with a result filter follows the existing omission rule. Dynamic metrics keep the computation settings.
- The result column returns `compute: "compare"` and `comparison: {offset, output}` so that the UI can build the name. With an explicit `label`, this naming metadata is omitted. Each comparison measure joins a separate comparison-period aggregate subquery, and scans are not shared yet.

**Execution rules for share**

```json
{"field":"buyers","agg":"count_distinct","alias":"buyer_share","compute":{"type":"percent_of_total","within":["region"]}}
```

The numerator is the aggregate value of the current group. The denominator is the same measure aggregated again over the data after the same data source, parameters, row filters and row-level permission filtering, keeping only the grouping dimensions in `within`. A dimension must use the output name of the query (the alias when there is an `alias`) and cannot repeat, and a time dimension keeps its original grain and time zone. An empty or omitted `within` means the grand total. When all dimensions are selected, the share of a nonzero group is 1.

- `having`, sorting, Top N (`limit`) and pagination run after the share is computed and do not shrink the denominator. When `having` refers to a share column, it compares the raw ratio from 0 to 1. When it refers to the original measure or to `filterMeasures`, it compares on that measure.
- The result rows are not added up to get the denominator: distinct counts, averages and dataset metrics are all aggregated again, so the shares of these may not sum to 100%. Negative numbers are not made absolute or truncated, so a ratio can be below 0 or above 1.
- Only numeric aggregate results are accepted. If the numerator or the denominator is NULL, or the denominator is 0, the result is NULL. Division is in floating point and returns the raw ratio (such as 0.25). The result column defaults to `format.style: "percent"` and does not inherit the amount unit, prefix or suffix.
- The result column carries `compute: "percent_of_total"` so that the UI can append "(% of total)" after the aggregate name. When `label` is set explicitly, `agg` and `compute` are omitted and that name is used in full. The percentage format is still kept.
- For totals, subtotals and when a nullable dynamic dimension is removed, `within` keeps only the dimensions that still take part in grouping, and the ratio is then recomputed. The grand total is 100% for a nonzero measure. The shares of the rows are not added up. A total with `having` keeps following the existing omission rule.
- Currently each share measure joins one separate aggregate subquery in the same SQL. Scans with the same denominator are not merged yet.

**Execution rules for running total**

```json
{"field":"revenue","agg":"sum","alias":"revenue_running","compute":{"type":"cumulative","along":"month"}}
```

Along the `along` dimension, from smallest to largest, the values of the groups are accumulated in order. Groups that have the same values in the other dimensions each start from the beginning. `along` must be an output dimension name of the query (the alias when there is an `alias`). A group is determined by all the dimensions, so among groups that are the same in the other dimensions, each value of `along` appears only once and there are no ties.

- Only `sum`, `count`, `min`, `max` and numeric results are accepted. Sum and count add the values of the groups together, and min and max take the smallest and largest value up to the current group. All of them give the same result as aggregating the detail rows "up to the current group" again. Average and distinct count cannot be derived from the values of the groups. The system does not parse the expressions of dataset metrics ([Dataset model](dataset.md) section 6.2), so it does not know whether they can be added. These three raise `cumulative_agg` instead of returning a wrong number. When `along` is not a dimension of the query, `invalid_cumulative` is raised.
- Accumulation starts from the first group the query reads, which is the start of the filter range. A running total over "last 30 days" starts from 0 at 30 days ago and does not include earlier data.
- Accumulation runs only across the groups the query returns, and groups with no data are not filled in. If a region has no orders in March, there is no row for it, and the April running total still includes January and February.
- A group where `along` is empty is placed last, and its running total includes all the groups that are the same in the other dimensions. When the value of a group is empty it is not counted, and the running total is the same as that of the previous group. When every value from the first group on is empty, the running total is empty.
- `having`, sorting, Top N (`limit`) and pagination run after accumulation and do not change the running total: page 2 continues the running total from page 1, and a group removed by `having` still counts toward the later running totals. When `having` refers to a running-total column, it compares the running total. The row order of the result is decided by `sort` and is independent of the direction of accumulation. When sorted by sales, the running total is not necessarily increasing.
- For totals, subtotals and when a nullable dynamic dimension is removed: if `along` is still there, the running total is recomputed over the remaining dimensions. If `along` has been removed, this column is an ordinary aggregate, equal to the final value of the running total over this range, so the grand total is the sum over the whole range. The running totals of the rows are not added up. A total with `having` keeps following the existing omission rule.
- The result column carries `compute: "cumulative"` so that the UI can append "(running total)" after the name. When `label` is set explicitly, `agg` and `compute` are omitted. The format is the same as without accumulation: sum, min and max carry the format of the field, count does not, and it is not changed to a percentage as share is.
- A measure has only one derived computation, so there is no running total of a year-over-year comparison, and no running share. `filterMeasures` can also carry a running total, with the same rules.

### 3.6 Time range

A time range is not an independent property of the query but a kind of condition in `filter`: the operator `time`, acting on a date or time field. `value` selects exactly one of the modes `last`, `current`, legacy `start/end`, `bounds` or `special`, and the modes cannot be mixed. `includeCurrent` only modifies `last` and cannot be used with `special`.

```jsonc
// relative time
{ "field": "order_date", "op": "time", "value": { "last": { "n": 30, "unit": "day" }, "includeCurrent": false } }
// current period
{ "field": "order_date", "op": "time", "value": { "current": "month" } }
// absolute time, closed on the left and open on the right
{ "field": "order_date", "op": "time", "value": { "start": "2026-01-01T00:00:00", "end": "2026-04-01T00:00:00" } }
// set the start and end points independently: from a fixed date to just before the start of the next month
{ "field": "order_date", "op": "time", "value": { "bounds": { "start": { "fixed": "2026-01-01" }, "end": { "relative": { "n": 1, "unit": "month" } } } } }
// special value, not a time interval
{ "field": "order_date", "op": "time", "value": { "special": "is_null" } }
```

- Relative time is resolved on the server by the query time zone and the workspace's week start day.
- `last.n` is a positive integer. Without the current period it takes the previous N complete periods, and with `includeCurrent: true` it includes the current complete period. `current` means the current complete period.
- A time interval is always closed on the left and open on the right, `[start, end)`. A fixed time is a local date/time in the query time zone, without a UTC offset. A timestamp is bound by the actual instant, and a date is bound by the calendar date. The legacy `start/end` can omit one end, but not both.
- When `bounds.start/end` is omitted, that side is unbounded, and `bounds: {}` means no limit at all. A non-empty endpoint must set exactly one of `fixed` or `relative`. `relative.n` is a signed number of periods moved from the **start of the current period**: `0` is the current start, `-1` is the start of the previous period, `1` is the start of the next period, the range is ±1,000,000, and the resulting year must be between 1 and 9999. The end endpoint does not automatically include that period. The last seven days including today use start `n: -6, unit: day` and end `n: 1, unit: day`.
- The new-style `bounds` accept, for a `date` field, only boundaries that are a date or whose time part is zero, and the relative unit can only be day or coarser. DATE takes the current calendar date in the query time zone first, then computes by calendar and binds the date string. It does not convert a date into a midnight instant, so a midnight daylight saving jump or a skipped whole day does not change the input date. `timestamp` is still resolved by the actual time zone, and can use hours, minutes and fixed boundaries with hours, minutes and seconds. Day, week, month and so on move by the local calendar, and across daylight saving time they are not converted at a fixed 24 hours.
- `special` supports only `is_null` and `not_null`, which generate `IS NULL` and `IS NOT NULL` respectively, and it applies to both dates and timestamps.
- Three modifiers do not form an interval on their own, and can be used with any of the interval modes above:
  - `includeNull: true` also keeps the rows whose date is empty, generating `((interval) OR field IS NULL)`. It cannot be used with `special`.
  - `grain` is `day`, `week` or `month`, and means the interval is made of whole days, weeks or months: the start is pulled back to the beginning of the period it falls in, and the end (exclusive) is advanced to the end of the period it falls in. When omitted, the endpoints stay as they are. `{ "start": "2026-01-15", "end": "2026-03-10", "grain": "month" }` is January to March 2026.
  - `weekStart` is an ISO weekday (1 Monday ... 7 Sunday). It decides only the week within this condition: the week unit of `current`/`last`/`bounds` and the alignment of `grain: week`. When omitted, the workspace's week start day is used. It does not affect dimensions grouped by week, which still use the workspace setting.
- A value with only modifiers and no interval (such as `{ "grain": "month" }`) is invalid in the query IR. Charts and dashboards treat it as "all" and produce no condition.
- The field must be stated: the dataset has no default time field.
- A query can have several time conditions, each acting on a different field.
- Early versions had a separate `timeRange` property, so that period-over-period comparison could find the main time range. It has been removed: charts and dashboards treat time as an ordinary filter (see [Charts and dashboards](chart-dashboard.md) section 2.3), and period-over-period comparison chooses the base time field and its ordinary time filter through `compute.timeField`.

### 3.7 `filter` and `having`

The same kind of expression tree. `filter` can only refer to unaggregated fields of the dataset and compiles to `WHERE`. `having` refers to the aliases of the `measures` or `filterMeasures` of this query and compiles to `HAVING`. When a time-typed measure is referenced, the filter value is resolved as local time in the query time zone and compared with the aggregate result by actual instant, regardless of the converted form shown in the result.

The elements of `filterMeasures` have the same structure as `measures`. They are used for measures that take part only in aggregate filtering and add no output column. For example, a chart that shows only region and sales can still filter regions by order count:

```jsonc
"filterMeasures": [{ "field": "order_id", "agg": "count", "alias": "filter_orders" }],
"having": { "field": "filter_orders", "op": "gte", "value": 10 }
```

These measures use the grouping dimensions of the chart itself. Their aliases must not repeat those of the output or of other filter measures, and sorting or visualization cannot refer to them as output columns.

There are two kinds of node:

```jsonc
// logical node
{ "op": "and" | "or" | "not", "args": [ ... ] }
// comparison node
{ "field": "channel", "op": "in", "value": ["app", "web"] }
```

Comparison operators:

| Category | Operators |
|---|---|
| Equality | `eq` `ne` `in` `not_in` |
| Ordering | `gt` `gte` `lt` `lte` `between` `not_between` |
| Text | `contains` `not_contains` `starts_with` `ends_with` `like` `not_like` |
| Null | `is_null` `not_null` |
| Empty string | `is_empty` `not_empty` |
| Time | `time` (see section 3.6) |

The type of `value` must match the field type, and this is checked in the validation stage.

`between/not_between` keeps the array format `[min, max]` with both ends included, and also accepts the object `{ "min": 10, "max": 100, "includeMin": false, "includeMax": true }`. When an inclusion flag is omitted, it defaults to `true`. The raw IR must provide two non-empty endpoints. The content layer of charts/dashboards allows one end to be empty, and converts the condition to `gt/gte/lt/lte` according to the inclusion flags and whether it is negated. If both ends are empty, the condition is removed. `not_between` negates the whole interval. All comparisons still follow the NULL semantics of SQL.

`is_empty/not_empty` apply only to strings, comparing `= ''` and `<> ''` respectively, and neither includes NULL. NULL uses the separate `is_null/not_null`.

`contains/not_contains/starts_with/ends_with` match literal text, including `%` and `_` in the input. `like/not_like` apply a pattern to the complete string: `%` matches text of any length, `_` matches a single character, and a backslash escapes the next character. For example, the JSON string `"50\\%"` matches the literal `50%`, and `"a\\\\b"` matches the literal `a\b`. After dialect escaping, the pattern is still a bound parameter, and user text is never concatenated into the SQL.

### 3.8 `sort` / `limit` / `offset`

- `sort[].by` refers to the alias of an output column (a dimension or measure). When sorting by a time-typed measure, it sorts by actual instant, not by the local time in the query time zone converted in the result.
- When `limit` is omitted, the server default is used. When it exceeds the server cap, it is truncated, and `truncated` is marked in the result.

### 3.8.1 `totals`

Computes the measures again at a coarser grouping. Each item lists the dimensions (output column names) it is still grouped by, and an empty array is the grand total.

```jsonc
"dimensions": [{ "field": "region" }, { "field": "order_date", "grain": "month", "alias": "month" }],
"measures": [{ "field": "revenue", "agg": "sum" }, { "field": "user_id", "agg": "count_distinct", "alias": "users" }],
"totals": [["region"], ["month"], []]
```

- Totals are computed by the database, not by adding up the rows. Each item compiles into a query with fewer grouping dimensions and the same conditions as the main query, so the totals of averages and distinct counts are also correct (with 1 person in one month and 2 people in the other, the total may be 2 people).
- Totals cover all the rows the query reads, and are not affected by `limit` or `offset`. Sorting keeps only the columns that are still returned.
- Only for aggregate queries that have measures. Each item can only refer to dimensions of the query, cannot repeat, and cannot keep all the dimensions (that would be the query itself). At most 16 items (a pivot table with subtotals needs one item for each pair of row and column levels, and that is 15 items with 3 row dimensions and 3 column dimensions).
- When the query has `having`, totals are not computed, and `meta.totalsOmitted` in the result is `true`. A condition that filters on results changes its meaning when moved to a coarser grouping, and filtering by the grouping of the main query would not be a "total" either.
- The candidate API drops `totals` when it fetches values.
- When a dynamic dimension is left empty, the query lacks that dimension. Each total drops it, and a total that becomes grouped by all the remaining dimensions (which is the query itself), or that duplicates another item, is no longer computed (done by the content layer when it resolves the dynamic selection, and the frontend preview uses the same rule).

### 3.9 `timezone`

An IANA time zone name. It affects time grain truncation, relative time resolution and how times are written in the result: columns of time type, including dimensions, detail columns, `min`/`max` of a time field and time-typed metrics, are all returned as local time in this time zone. When omitted, the workspace setting is used.

### 3.10 `params`

The source SQL of a dataset can declare parameters, so that analysts control the data retrieval logic. The IR passes the values through `params`:

```jsonc
"params": { "biz_date": "2026-10-08", "regions": ["East China", "South China"] }
```

The declaration on the dataset side:

```yaml
Source SQL: |
  SELECT * FROM orders
  WHERE dt = {{biz_date}}
  [[ AND region IN {{regions}} ]]
Parameters:
  - name: biz_date
    type: date
    default: { relative: "today-1d" }   # dynamic defaults are supported
    required: true
  - name: regions
    type: string
    multi: true                          # expands to IN (?, ?, ...)
```

Rules:

- `{{name}}` compiles to a bound parameter placeholder, **with no string concatenation**, so a parameter can only be a value, never a table name, column name or SQL fragment.
- `[[ ... ]]` is an optional fragment: when the parameter inside it has no value, the whole fragment is dropped.
- A parameter omitted from `params` uses the default of the dataset. Passing `null` explicitly (a single-value parameter) or `[]` (a multi-value parameter) means no value is passed, and does not fall back to the default. This is consistent with "empty means no limit" in filters: the whole `[[ ]]` fragment that contains the parameter is dropped. When the parameter cannot do without a value (it is required, or it has a placeholder outside `[[ ]]`), `missing_param` is raised.
- Sources of parameter values: fixed on the chart (`query.params`, or a parameter filter on the chart that has no control), chosen by the viewer through the parameter filter of the chart ([Charts and dashboards](chart-dashboard.md) section 2.11), or system variables (such as `{{user.dept}}`, taken from the attributes of the current user and not overridable by the client). Associating a dashboard global filter with a parameter is not implemented yet, and neither are system variables.
- A parameter that the dataset has not declared, or one of the wrong type, passed in the IR is rejected in the validation stage.
- Parameter values take part in the cache key.

### 3.11 Field references

Every `field` in the IR refers to the **internal ID** (`key`) of a dataset field, not to a column name in the source SQL and not to the name. How the three relate:

| | Example | Who can change it | What a change affects |
|---|---|---|---|
| SQL column name | `region_name` | Analysts, at any time | Only the field needs to point at the new column, and charts notice nothing |
| Internal ID | `region` | Cannot be changed after creation | Charts, the IR and AI all refer to it |
| Name | Region | Changed at any time | Affects only display and how expressions are written |

`dimensions[].field`, `measures[].field`, `filter` and `columns` in detail mode all refer to the internal ID of a field. Which fields can be used where:

| Position | Fields that can be used |
|---|---|
| `dimensions[].field`, `filter`, `columns` | Unaggregated fields, both dimensions and measures |
| `measures[].field` | Any field: dimensions and measures with `agg`, metrics without |

Internal IDs are generated automatically and are not shown in the UI, where users always pick fields by name. The IR is the format between the UI and the API, and is read and written by programs. A caller that writes an IR directly looks up the internal IDs in the dataset definition. For the full definition, see [Dataset model](dataset.md) section 5.2.

## 4. Request envelope and result

Execution options outside the IR go in the envelope, and do not enter the chart spec:

```jsonc
{
  "query": { /* IR */ },
  "options": {
    "cache": "default",      // default | refresh | bypass, see section 6.6
    "maxAge": 60,            // optional, in seconds, used only with default, see section 6.6
    "diagnostics": true,     // optional, returns the diagnostics of this query only to developers and admins
    "timeoutMs": 30000,
    "async": false           // when true, returns a job ID and a worker executes it
  }
}
```

Result:

```jsonc
{
  "columns": [
    { "name": "month",   "type": "timestamp", "role": "dimension", "label": "Order month", "grain": "month" },
    { "name": "revenue", "type": "decimal",   "role": "measure",   "label": "Sales", "format": { "decimals": 2, "prefix": "¥" } }
  ],
  "rows": [["2026-01-01T00:00:00", "128000.50"]],
  // present only when the query asked for totals, in the same order as totals; by is the dimensions this item keeps, and the columns are these dimensions plus all the measures
  "totals": [{ "by": [], "columns": [{ "name": "revenue", "type": "decimal", "role": "measure", "agg": "sum" }], "rows": [["128000.50"]] }],
  "meta": { "cached": true, "cachedAt": "2026-10-17T09:00:12+08:00", "truncated": false, "durationMs": 42 }
}
```

`meta.durationMs` includes the time of the totals queries.

A value in `rows` is `null`, a boolean, a number or text. A decimal is text, so that it keeps its digits. So is an integer beyond ±(2^53 − 1): a browser reading JSON would round it, and an identifier of nineteen digits would be shown with its last digits changed and match nothing when sent back. The column's `type` is still `integer`. A filter takes an integer value as a number or as such text, so a value picked from a result can be sent back as it came. This is done where a result is shaped (`query.Shape`); the cache and exports keep the integer.

`label` and `format` come from the dataset definition and can be used directly when the frontend renders. For the structure of `format`, see [Dataset model](dataset.md) section 5.5: dimension columns, metric columns and measure columns aggregated by `sum`, `avg`, `min` or `max` carry the format of the field. Columns aggregated by `count` or `count_distinct` do not, because a count has nothing to do with the unit of the original field. A column produced by aggregation also carries `agg` (such as `"agg": "avg"`). The column of a metric and a column given a `label` in the query do not. Its `label` is still the name of the field, and the frontend writes the aggregation into the name according to the UI language, for example "Average (Order amount)".

A dimension column grouped by a grain carries `grain`, and so does a dimension column in totals, and the frontend uses it to decide to which level a date is written ([Dataset model](dataset.md) section 5.5). A column without a grain does not carry it, including a date truncated by an expression.

The data API of a dashboard widget can additionally return `meta.overriddenFilters: string[]`, which lists the IDs of the chart filters taken over by global filters in this request, so that the UI can gray them out. The dashboard layer generates it from the resolved dynamic metrics and the actual bindings. It is not part of the query IR and does not change the general result of the query compiler.

### 4.1 Query diagnostics

`options.diagnostics: true` of `POST /query`, or `diagnostics: true` of `POST /charts/{id}/data`, makes a successful result include `diagnostics` in addition. Only developers and admins can request it, and a request from a viewer returns 403. Ordinary data retrieval does not return this field, and the diagnostics do not enter the shared cache and are not persisted.

- `requestId` uniquely identifies this request, and `requestedAt` records when the query was started. Even on a cache hit, a new request ID is generated.
- `statements` are ordered as the main query, then the requested totals/subtotals. The `kind` of each item is `main`, `total` or `subtotal`, and the `by` of a subtotal keeps the output dimension names. A total omitted because of `having` generates no statement entry, and keeps using the `meta.totalsOmitted` hint.
- `sql` and `args` are taken directly from the compiled object that produced this result, and are not compiled again. The SQL keeps the placeholders of the corresponding dialect, and the arguments are returned as a JSON array in placeholder order, including source SQL parameters, filter values and relative dates that have been resolved. What is shown here is the SQL passed to the driver. The parameter escaping and protocol conversion inside the driver are not expanded here.
- Each statement returns its own `durationMs`, `cached`, `shared`, `fetchedAt`, `rowCount` and `truncated`. The duration includes queueing at the data source. On a cache hit it is the duration of the original query, not the time to read the cache. `shared` means an identical query in progress was shared. `rowCount` is the number of rows returned, not counting the extra row used to decide truncation. The total duration is the sum of the statement durations, and with mixed hits each statement is still shown separately.
- The chart editor updates the diagnostics together with the result of the same response, and keeps a separate chart definition tab at the bottom. When the configuration changes without a rerun, they are marked stale. When rerunning or cancelling, they are still marked as the last successful result. When a new query fails, the old result and diagnostics are cleared. A cancelled response or a late one does not overwrite the current result.

## 5. Processing flow

```
IR
 → Structure validation      JSON Schema, version migration
 → Semantic validation       whether fields exist, whether types match, whether grain is used on a time dimension
 → Permission injection      column permissions: reject if a hidden field is referenced; row permissions: append filter conditions
 → Logical plan              expand compute (for example, compare expands into a main query + an offset query)
 → Dialect compilation       generate SQL + bound parameters
 → Cache / execution
 → Result shaping            type normalization, attach label and format
```

The compiled result of the basic form:

```sql
SELECT DATE_TRUNC('month', t.created_at) AS month,
       t.region_name                     AS region,
       SUM(t.amount)                     AS revenue
FROM ( /* dataset source SQL */ ) t
WHERE /* row permissions */ AND /* filter */
GROUP BY 1, 2
HAVING SUM(t.amount) > ?
ORDER BY month, revenue DESC
LIMIT 1000
```

How `compare` is compiled: the main time range and the offset time range each generate an aggregate subquery, joined on the non-time dimensions (and the shifted time dimension).

How `cumulative` is compiled: a window function outside the grouped query, partitioned by the remaining dimensions (no partition when there are none), ordered along `along` (nulls last, with the syntax given by the dialect), and the window runs from the first row of the partition to the current row. The running totals of sum and count both sum the values of the groups, and min and max use `MIN` and `MAX`. A window function cannot be written in `WHERE`, so when there is a running total, one more layer wraps the outside, and `having` is written in this layer:

```sql
SELECT month, region, revenue_running
FROM (
  SELECT g.month, g.region,
         SUM(g.revenue) OVER (PARTITION BY g.region ORDER BY g.month
                              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS revenue_running
  FROM ( /* the grouped query above, without HAVING */ ) g
) c
WHERE revenue_running > ?
ORDER BY month, region
LIMIT 1000
```

The `selections` of a dynamic dimension/metric, the dependencies of a cascading filter and the current selection are all resolved first in the content layer. A dynamic selection can only refer to candidate IDs saved by the author. After resolution, it replaces the dimension/metric definition and keeps the output alias. A cascading candidate query applies the configured ancestor conditions or reverse-matching conditions and is then compiled with the same IR. The query layer does not receive dynamic selectors or dashboard cascading configuration, and does not guess associations from fields with the same name across datasets.

When a candidate involves `HAVING` (including fixed or global result filters), the internal projection on the server first finds the qualifying groups by the original grouping of the chart, then joins the original rows with NULL-safe equality and takes distinct candidate values, keeping the original date grain and row filters. Candidate search applies only to the outer layer, so the original sorting/pagination of the chart does not limit the qualifying groups. The internal projection does not accept client JSON and is not written into the spec. The cache keys on the compiled SQL and arguments (see section 6.3), so it naturally distinguishes this projection, and does not key on the public IR JSON.

## 6. Caching and concurrency

Status: implemented. The code is in `internal/qcache` (caching and merging), `internal/datasource/limit.go` (concurrency limit) and `internal/api/cache.go` (wiring).

### 6.1 Goals and scope

- When one dashboard is opened by many people or refreshed repeatedly, identical queries are not pressed onto the data source again and again.
- A data source has a limit on the statements it runs at the same time. The ones beyond it queue, instead of all being pressed through together.
- Permission semantics do not change: the data seen on a cache hit is exactly the same as on a miss.

| | Cache | Concurrency limit |
|---|---|---|
| Chart and dashboard data retrieval (including totals), filter candidates, the query API, draft previews of charts, dashboards and datasets, permission preview | Yes | Yes |
| Data exploration, `LIMIT 0` trial runs, database and table structure, connection tests | No: what is wanted is the result of this moment, or it is not data retrieval itself | Yes |

In one sentence: statements that go through the query compiler use the cache, and all statements executed against a data source are subject to the concurrency limit.

### 6.2 Which layer the cache is in

What is cached is **the execution result of one compiled statement on the database**: after permission injection and dialect compilation, and before result shaping.

- The key comes from the compiled SQL and the bound parameters (section 6.3), not from the IR, the request body or the user.
- The value is the raw result returned by the database: the actual types of the columns and the rows. Column information such as `label`, `format`, `agg` and `compute` is attached again each time from the current dataset definition, so changing a field name or a display format does not need to invalidate the cache, and the old name is never read.
- Each item of the totals is a separate statement and is cached on its own (see section 3.8.1). Period-over-period comparison, share and running total are compiled into the same SQL and are cached with it.

### 6.3 Cache key

SHA-256 is taken over the following items after encoding them by type:

| Component | Purpose |
|---|---|
| Key format version | The whole cache is invalidated when the format of the cached content changes |
| Data source ID | The same SQL on different data sources is not the same data. A data source belongs to a workspace, so this also separates workspaces |
| Data source version (the modification time of the settings, the same one used to reopen the connection pool) | After the connection settings or the data time zone are changed, all the old results are invalidated |
| Compiled SQL | Already contains the source SQL of the dataset, filters, row-level permission conditions, time zone conversion and `LIMIT n+1` |
| Bound parameters, with types | Filter values, dataset parameters, values resolved from user attributes, and endpoints resolved from relative time. Types are included to tell `1` from `"1"` |

Not in the key: user, role, chart and dashboard. So people with the same data scope share the cache, and people with different row-level rules have different SQL or parameters and do not share it.

- **Relative time** is resolved into concrete endpoints at compile time, so "last 7 days" naturally gets a new key after midnight, and yesterday's range is never mistaken for today's.
- **Parts of the source SQL that are not deterministic** (`NOW()`, `CURRENT_DATE`, random numbers) cannot be seen in the key, so only the validity period covers for them.

### 6.4 Relation to data permissions

- **The cache comes after permission injection**, so any change to permissions (changing rules, changing user attributes, joining or leaving a group, changing a role) changes the SQL or parameters and takes effect on the next query immediately, with no need to clear the cache.
- Column-level permissions reject, at compile time, a query that references a hidden field, and a rejected query never reaches the cache.
- Adding another cache at the level of the IR, the request or the API response is not allowed: that would bypass the two points above. In the implementation the cache sits in exactly one place, between `query` and the data source.
- A hit only means "people with the same data scope asked the same question within the validity period". It does not bring out data that others can see but you cannot.

### 6.5 Validity period

- The default is set in "System administration → General", and is 10 minutes, with options from 1 minute to 24 hours. It is stored in the metadata database, every instance reads the same value, it is read on each query, and a change affects only the results written to the cache afterward ([Startup configuration](configuration.md) section 10). To turn off caching for the whole instance, use the startup configuration `--query-cache=off` (section 6.8).
- A data source can override it: "Result cache" offers "System default", "Do not cache" or a value between 1 minute and 24 hours. Pick "Do not cache" for a data source on a business database where live data matters. It is stored as a column of the data source, and changing it invalidates the existing cache of that data source, as changing any other setting does.
- The timer starts when the result is returned from the database, and the result expires when time is up. A hit does not extend the validity period.
- Validity periods at the dataset and chart level are not done for now (see [Deferred items](../backlog.md)).

### 6.6 Refresh

`options.cache` in the request envelope (section 4):

| Value | Read cache | Write cache | Merge identical queries (section 6.7) |
|---|---|---|---|
| `default` | Yes | Yes | Yes |
| `refresh` | No | Yes, replacing the old one | Yes |
| `bypass` | No | No | No |

- The data retrieval APIs for charts, dashboards and dataset previews do not expose the full envelope. Adding `refresh: true` to the request body corresponds to `refresh`. `bypass` is offered only on the query API, for troubleshooting.
- When the author clicks "Run" (chart editor) or "Refresh" (dataset preview) manually in an editor, it uses `refresh`. An automatic rerun after fields change uses `default`, since a changed definition naturally gives a different key.
- The "Refresh data" button in the dashboard view refreshes all charts. The existing "Refresh chart" in the chart menu refreshes only that one. Clicking "Query" in manual query mode uses `default`: it applies the conditions, and does not ask for the data to be fetched again.
- Anyone who can see this dashboard can refresh, including viewers, since otherwise they cannot get new data. The load caused by refreshing is held by merging and the concurrency limit.
- **Maximum acceptable age** (used for timed refresh of dashboards, see [Charts and dashboards](chart-dashboard.md) section 3.9): `default` can carry `maxAge` (seconds, 1–86400). A result in the cache is used only if the time its statement started executing (fetch time minus execution duration, including queueing) is less than `maxAge` ago. An older one is handled as `refresh`: it queries the database (still merging identical queries) and replaces the cache. The age counts from the start of execution, not from the return. For a statement that takes 10 seconds to run, when it is asked again one interval later, the age counted from the return time is still less than an interval, while counted from the start time it is exactly one interval, so the result is not mistaken for a new one. The query API takes it in `options.maxAge`, and it can only be used together with `cache: default` or with no `cache`. The widget data and filter candidate APIs of a dashboard (saved and draft) take `maxAge` in the request body, and it cannot come with `refresh: true`. Otherwise the API returns 400 `invalid_request`. A `maxAge` longer than the validity period (section 6.5) has no extra effect, because a result past its validity period is no longer in the cache. A statement with `maxAge` in the log records one more item, `maxAgeS`.
- The `meta` of the result gains two items: `cached` says whether it comes from the cache, and `cachedAt` is the time this result was returned from the database (ISO 8601, with a time zone offset). For a result with totals, it counts as `cached` only if all of it comes from the cache, and `cachedAt` is the earliest of them. On a hit, `durationMs` is the duration of the original execution. The chart shows "Updated N minutes ago", and hovering shows the exact time.

### 6.7 Merging identical queries

- Within one instance, when a query with the same key is already executing, a later request waits for its result and does not execute again. When dozens of people open the same dashboard at nine o'clock, each chart is queried only once.
- Merging happens only within an instance, with Redis too: merging across instances needs a distributed lock, and the instance waiting for the lock still has to poll for the result, so it is not done in the first version. So with N instances, the same query is executed at most N times at once, and afterward everyone reads from Redis.
- A merged request takes only one concurrency slot.
- The shared execution uses its own context: when one waiter leaves (closes the page), it does not cancel the execution. The statement is cancelled only when all the waiters have left, or on timeout.
- A page cancels the requests it no longer needs, and leaving then counts like closing the page. This applies to a dashboard chart's data whose conditions have changed, or that has been unmounted. It applies to a filter's options, when a newer search replaces them or the control goes away. It also applies to a data source's table list once another source is shown. Otherwise each change of the filters left the earlier queries running to the end, and they held slots and queue places that the queries still wanted then waited behind. The cost: going from A to B and back to A runs A again, if A was cancelled before its result could be kept.
- A request whose client has left is not an error. It is answered 499 `canceled`, which nobody reads, and logged only as the line every statement logs (below). An audited query that reached the data source is still recorded, as failed with `canceled`. The event, and the lookup of the name of what it was for, go ahead without the request, as any event's recording does ([Access control and workspaces](access-control.md) section 7.4).
- A failed result is not cached: the requests waiting at that time all receive the error, and the next request executes again.
- Merging still happens when a data source is set to "Do not cache" or with `--query-cache=off`: identical queries running at the same time have the same result anyway.

### 6.8 Storage

The cache storage is configurable with `--query-cache` (`SUPABI_QUERY_CACHE`):

| Value | Where it lives | Suitable for |
|---|---|---|
| `memory` (default) | An in-process LRU in each instance | Single-instance deployments; not wanting to maintain one more component |
| `redis` | External Redis, shared by all instances | Multi-instance deployments |
| `off` | No caching | Troubleshooting, or when all the data sources need live data |

The two storages have the same semantics: the same key, validity period, refresh and merging rules, and the upper layer depends on a single interface (read, write, with a validity period). All instances in one deployment should use the same storage. A two-level cache of local plus Redis is not built: after a refresh on one instance, the old local results on other instances would still be read, and the refresh would be unreliable.

A result whose estimated size exceeds 8 MB is not cached (there are at most 10000 rows by default, which can be large with many columns), and this is the same for both storages.

**`memory`**

- The total is limited by estimated bytes: `--query-cache-size`, 256 MB by default, and when it is exceeded the least recently used results are evicted.
- Each instance caches on its own: with multi-instance deployments the hit rate drops with the number of instances. A refresh on one instance replaces only the result on that instance, and the old results on other instances become invalid only when they expire. The cache is cleared on restart.

**`redis`**

- Connect with `--redis-url` (`SUPABI_REDIS_URL`), such as `rediss://:password@host:6379/0`. As with the metadata database, passing it through an environment variable is recommended, so that the password does not appear in the process list. `rediss://` (TLS) is supported.
- The key is `supabi:qc:` plus the digest from section 6.3. The prefix can be changed with `--redis-key-prefix`, which makes it easy to share one Redis with other applications. Each key carries its validity period with `SET ... PX`, and Redis deletes it on expiry.
- SupaBI does not control the total, and `--query-cache-size` has no effect on it: when deploying, set `maxmemory` on Redis, with the eviction policy `volatile-lru` or `allkeys-lru`. The deployment docs give the recommended configuration.
- Values use a typed binary encoding (it distinguishes integers from floats: JSON turns integers above 2^53 into floats), and larger results are compressed before being stored.
- **An unavailable Redis does not affect queries**: reads and writes of the cache have a short timeout (such as 200 milliseconds), a failure or timeout is treated as a miss, the data source is queried directly and a warning is logged, and the query does not fail. `/readyz` does not check Redis.
- What Redis stores is query results, which is business data, stored in plain text. Redis should be open only to SupaBI and protected with a password. Like the metadata database, it is a component that needs protection.
- A refresh replaces the shared copy, and all instances then read the new result.
- The `make dev-up` for local development brings up a Redis. The cache tests run the same set of cases against both storages.

### 6.9 Concurrency limit

- Each **data source, on each instance**, runs no more than N statements at the same time, 8 by default, and this can be changed to 1–64 in the data source settings. The default is smaller than the connection pool limit of the driver (10), so that queueing happens in our layer, where it can be timed and rejected, instead of silently waiting in the connection pool.
- The limit wraps around the data source connection, and all statements executed against this data source are limited (the table in section 6.1), that is `Query`, `Describe` and `Tables` of the connection. `Ping` for connection tests is not limited, since otherwise a test would give a false alarm when the data source is busy. Requests that hit the cache or wait on a merge do not take a slot. Changing the concurrency limit reopens the connection pool of this data source.
- First come, first served. Queueing time counts toward the query timeout (60 seconds by default, [Startup configuration](configuration.md) section 10.7).
- At most 100 statements queue per data source. Beyond that, `datasource_busy` (503) is returned immediately, and the UI says the data source is busy and to retry later. A timeout while queueing raises `queue_timeout` (504), and a timeout during execution raises `timeout` (504), which makes it easy to tell whether the data source is slow or the queue is long.
- The totals of a chart execute one item at a time and take only one slot at any moment (the same as now).
- With multiple instances, the actual concurrency limit of a data source is the number of instances × N, also when Redis is used for caching: the concurrency limit does not go through Redis, and a quota shared across instances is not built in the first version.
- Users are not distinguished: one person opening a dashboard with many charts can fill the queue. Fairness per user, and priority between scheduled jobs and interactive queries later, are not done for now.

### 6.10 Observability

- Each statement logs one line: data source, the first 12 characters of the key, whether it hit, whether it was merged, queueing time, execution time and row count. A failure to read or write Redis logs a warning, and the same kind of error is rate-limited, so that a Redis outage does not flood the log. Audit records the SQL, parameters, duration, row count and whether it hit the cache at the place where the statement is executed (at the same moment as the query diagnostics), and all the statements of one data retrieval request are combined into a single query event, see [Access control and workspaces](access-control.md) section 7.3.
- Exporting monitoring metrics and a cache management UI are not done in the first version.

## 7. Explicitly not done in v1

| Item | Reason | Alternative |
|---|---|---|
| Pivoting (columns to rows) | Databases differ greatly in support, and the interaction with `limit` is complex | The backend returns a long table, and the frontend pivots |
| Computing totals with `ROLLUP`/`GROUPING SETS` | Databases differ greatly in support | Each item of `totals` sends a separate query, see section 3.8.1 |
| Cross-dataset queries | Consistent with the decision for a lightweight semantic layer | Analysts join in the dataset SQL |
| Free-expression measures | Needs an expression parser and dialect translation | Define a calculated field in the dataset |
| Parameters replacing table names and column names | Cannot be done with bound parameters, and has an injection risk | Enum-type parameters with an allowlist can be considered later |

## 8. Decided

1. **The aggregation is written in the query**, limited to six basic aggregations, and expressions are not accepted. Earlier, a measure could omit the aggregation and be computed with the default aggregation of the dataset, and there was also an `adhoc` form that specified the aggregation for one query. Once datasets no longer had a default aggregation, the two forms were merged into `{ field, agg }`, and the old form is no longer accepted.
2. **Dataset SQL supports parameters**, see section 3.10.
3. **Field references use the internal ID (`key`)**, which cannot be changed after creation and is decoupled from the SQL column name and the name, see section 3.11.

## 9. Implementation status

The first version of the query kernel is in `internal/query`, `internal/dataset`, `internal/dialect` and `internal/datasource`.

| Capability | Status |
|---|---|
| Aggregate mode, detail mode | Implemented |
| Time grain of dimensions, including time zone conversion and the week start day | Implemented |
| Aggregation of measures and dimensions, metrics | Implemented |
| `filter`, `having`, `sort`, `limit`, `offset` | Implemented |
| Time condition `time` (relative, current period, absolute, independent fixed/relative/unbounded endpoints, NULL special values) | Implemented |
| Open and closed numeric intervals, `not_between`, empty strings and wildcard text matching | Implemented |
| Dynamic dimensions/metrics, cascading candidate context | Implemented in the content layer; the existing IR is reused after resolution |
| Dataset parameters, including optional fragments, multiple values and relative date defaults | Implemented |
| Injection of row-level and column-level permissions | Implemented; for the storage and resolution of the rules see [Access control and workspaces](access-control.md) section 5 |
| `compute.percent_of_total` (share) | Implemented, including share within groups, result filtering and totals |
| `compute.compare` (period-over-period comparison) | Implemented, including comparison values, differences, growth rates, time range settings and totals |
| `compute.cumulative` (running total) | Implemented, including partitioning by the remaining dimensions, result filtering, pagination and totals |
| System variables `{{user.xxx}}` | Not implemented |
| Caching, merging identical queries, concurrency limit | Implemented, see section 6 |
| Asynchronous execution | Not implemented |
| Dialects | PostgreSQL and MySQL are implemented, and pass the same set of consistency tests |

Details settled during implementation:

- **When no sorting is specified, rows are sorted ascending by dimension order**, which keeps the row order the same each time the same query returns.
- **Judging whether the result is truncated**: the SQL actually fetches one extra row, and if it is exceeded, the result is truncated and `truncated` is marked.
- **The type of a measure column is whatever the database actually returns**, and the type of a dimension column is whatever the dataset declares.
- **The type of a filter value is checked at compile time**, so an invalid value never reaches the database. The filter value of a timestamp is resolved as local time in the query time zone.
- **Text matching always uses bound parameters**. Literal matching and the `like/not_like` wildcard patterns have different semantics, and the dialect is responsible for converting escape characters, see section 3.7.
- **Data source connections are read-only by default** (a session-level read-only transaction), as a second line of defense besides a read-only account.

Known limitations:

- Date filters do not yet support the most recent date with data in a partition, trading days/working days, custom week calendars, or picking by several date grains in a filter control. The existing week start day setting still applies. The `grain` of query dimensions and the date grain switch of dynamic dimension candidates are supported, which differs from the filter control capabilities above.
- `[[` and `]]` in the source SQL are interpreted as optional fragments, which conflicts with PostgreSQL multidimensional array literals (such as `ARRAY[[1,2],[3,4]]`).
- `{{name}}` inside a string literal or a comment in the source SQL is also replaced as a parameter.
