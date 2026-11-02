# Dataset model design (draft v0)

Status: draft, open for discussion. It goes with [Query IR](query-ir.md); the fields and parameters referenced in the IR are defined here.

## 1. Purpose

A dataset is a logical table with semantic annotations:

- It is created and maintained by data analysts or engineers.
- It belongs to exactly one data source. It stores no data; it is compiled and sent down at query time.
- Charts, dashboards, AI and the data API depend only on datasets and never touch physical tables directly.
- Row-level and column-level permissions and cache policy are attached to the dataset.

## 2. Structure overview

```jsonc
{
  "specVersion": 1,
  "id": "ds_8f3k2m",
  "name": "Order analysis",
  "description": "Paid orders, counted by order time. Refunded orders are not in this dataset.",
  "datasource": "src_prod_mysql",

  "source": {
    "type": "sql",                       // sql | table
    "sql": "SELECT o.id, o.created_at, o.amount, o.user_id, o.status, r.region_name\nFROM orders o JOIN regions r ON o.region_id = r.id\nWHERE o.dt >= {{start_date}}\n[[ AND r.region_name IN {{regions}} ]]"
  },

  "params": [
    { "name": "start_date", "type": "date", "label": "Start date",
      "default": { "relative": "today-90d" }, "required": true },
    { "name": "regions", "type": "string", "label": "Region", "multi": true }
  ],

  "fields": [
    // dimensions
    { "key": "order_id",   "label": "Order ID",     "column": "id",          "type": "string",    "role": "dimension", "hidden": true },
    { "key": "order_date", "label": "Order time",   "column": "created_at",  "type": "timestamp", "role": "dimension" },
    { "key": "region",     "label": "Region",       "column": "region_name", "type": "string",    "role": "dimension",
      "synonyms": ["Area", "Zone"] },
    { "key": "status",     "label": "Order status", "column": "status",      "type": "string",    "role": "dimension" },
    { "key": "user_id",    "label": "User ID",      "column": "user_id",     "type": "string",    "role": "dimension" },
    { "key": "amount_tier", "label": "Amount tier", "type": "string", "role": "dimension",
      "expr": "CASE WHEN ${amount} >= 1000 THEN 'High' WHEN ${amount} >= 100 THEN 'Medium' ELSE 'Low' END" },

    // measures
    { "key": "amount",      "label": "Order amount", "column": "amount",  "type": "decimal", "role": "measure",
      "format": { "decimals": 2, "prefix": "¥" } },
    { "key": "paid_amount", "label": "Paid amount", "type": "decimal", "role": "measure",
      "expr": "CASE WHEN ${status} = 'paid' THEN ${amount} END", "format": { "decimals": 2, "prefix": "¥" } },
    // metrics
    { "key": "order_count", "label": "Order count",   "type": "integer", "role": "metric", "expr": "COUNT(${order_id})" },
    { "key": "buyers",      "label": "Buyers",        "type": "integer", "role": "metric", "expr": "COUNT(DISTINCT ${user_id})" },
    { "key": "arpu",        "label": "Sales per buyer", "type": "decimal", "role": "metric",
      "expr": "SUM(${amount}) / NULLIF(COUNT(DISTINCT ${user_id}), 0)",
      "format": { "decimals": 2, "prefix": "¥" }, "description": "Sales divided by the number of buyers" }
  ],

  "cache": { "ttlSeconds": 300 }
}
```

This is the form used in storage and in the API. Its `key` is an internal ID that never appears in the UI: users see the name (`label`), and expressions are written with names as well, see sections 5.2 and 6.4.

## 3. Source `source`

| `type` | Content | Use |
|---|---|---|
| `table` | `schema` + `table` | Use a table or view directly, no SQL needed |
| `sql` | A `SELECT` statement, which may contain parameters | When you need joins, cleaning or pre-aggregation |

Constraints:

- It must be a single read-only query. Connecting to the data source with a read-only account is the first line of defense; the system itself only does basic checks (a single statement, starting with `SELECT` or `WITH`).
- The source SQL is written in the data source's own dialect. The system does not parse or translate it, and wraps it whole as a subquery at compile time.
- The only place that reads the source SQL is lineage: it finds the table names after `FROM` and `JOIN` and uses them to draw which tables the dataset reads on the lineage graph (`internal/sqlrefs`). This is not parsing. If a table cannot be read out, the graph just misses that table, and saving and querying are unaffected.
- Output column names must be unique.

## 4. Parameters `params`

| Property | Description |
|---|---|
| `name` | Referenced in SQL as `{{name}}` |
| `type` | `string` `integer` `decimal` `boolean` `date` `timestamp` |
| `label` | Display name |
| `multi` | When true, accepts an array, expanded to `(?, ?, ...)` |
| `default` | A fixed value, or a dynamic value of the form `{ "relative": "today-1d" }` |
| `required` | When true and there is no default value, the query must pass a value |

The rules are in section 3.10 of the Query IR document: parameters compile to bind parameters and can only replace values; `[[ ... ]]` is an optional fragment; `{{user.xxx}}` is a system variable.

Parameters have no list of allowed values. Which options appear in a dropdown is decided by each chart that uses the parameter (section 2.11 of [Charts and dashboards](chart-dashboard.md)).

**When to use a parameter.** Use one only when a filter cannot do the job. A condition that only narrows the range (`dt = {{biz_date}}` on a single table, a date range) needs no parameter: output that column and use a field filter in the chart. The filter condition is added outside the dataset SQL, and the database pushes it into the SQL. We checked this on 2026-10-22 with EXPLAIN on the development database: on PostgreSQL, a detail SQL with a join used the time index, and a SQL that aggregates by day filtered before aggregating; on ClickHouse, a SQL that aggregates first used the primary key range (not checked on Trino, StarRocks or Doris). Viewers can also use candidate values, date ranges, global filters, chart links and drill-down. The cases a filter cannot handle:

1. **The same value is used in several places in the SQL.** Two snapshot tables partitioned by `dt` are joined, and both sides need `dt = the same day`; an outer filter acts only on the one column in the output.
2. **Exactly one value is required.** Every `dt` of a full-snapshot partitioned table is a complete snapshot, so if no day or several days are selected, the numbers are counted repeatedly and added up. A parameter can be made required and single-valued on the dataset, and every chart that uses the dataset must obey it; a filter means "empty means no limit", and relies on each chart's author setting it up.
3. **The condition must take effect before aggregation, deduplication or a window function, and that column is not in the output.** "Each user's latest order as of a given day" written as an outer filter becomes "users whose latest order is before that day", which means something different, and the database will not push it in. "The number of users who placed at least 3 orders in the selected period", retention and repurchase are the same.
4. **The value takes part in a calculation rather than a filter.** Computing account age as of a cutoff date, or a target value or an exchange rate.

**Where parameters are declared.** Parameters follow the SQL, so they are declared in Data exploration: when the SQL contains `{{name}}`, a "Parameters" section appears on the right of the editor. It lists each parameter, and you can change the display name, type, whether it takes multiple values, whether it is required and the default value. When the SQL has no parameters, the section does not appear. Parameter declarations are kept in the browser along with the query draft. When a dataset is created, or the SQL is applied back to a dataset, they are carried over together with the SQL, and they are finally saved with the field configuration as part of one revision of the dataset.

- At the top of the "Parameters" section is a line of gray text: "Parameters are not needed just to narrow the data range: output the column and use a filter in the chart." Most people write parameters to fetch data by date; this line suggests using a filter instead. The cases that do need a parameter are described above.
- A parameter is a single value and takes no quotes: write `status = {{status}}`.
- Only the SQL itself is read for parameters. `{{...}}` and `[[ ]]` written inside strings, quoted identifiers and comments are plain text, matching how the database reads them: `'{{status}}'` is simply a string whose content is `{{status}}` (it may well be a value in the data), not a parameter, and the section on the right does not list it. A commented-out line no longer requires a parameter value. A mistake of this kind is also easy to spot: a placeholder inside quotes does not appear in the parameters section.
- A newly appearing parameter is of type text and has no default value.
- Default values are filled in according to the type. For dates you can enter relative values such as `today` or `today-1d`, which are saved as `{ "relative": ... }`. If what you enter is not a valid value of the type, a warning is shown and it is not taken as the default.
- When you delete a placeholder from the SQL, the parameter is no longer declared; if you write it back in the same edit, the display name, type, multiple-values setting, required setting and default value set earlier are still there.
- Placeholders with invalid names (uppercase letters, a leading digit and so on) are listed separately, with the rule explained.
- When a query is run, a dataset is generated or the SQL is applied back to a dataset, the parameters are carried along with the SQL; the dataset editor does not edit parameters.
- Type, whether the parameter takes multiple values, and the default value are edited here. The SQL cannot show whether a parameter takes multiple values, so tick "Multiple values" next to the parameter: a multi-value parameter is written `IN {{name}}` in the SQL, without parentheses, and is expanded to `(?, ?, ...)` when executed; fill in the default value separated by commas. Unticking it restores a single value.
- When the display name is left empty, the SQL parameter name is used; setting a display name does not change the placeholder in the SQL. The dataset side shows the display name, the SQL parameter name, the multiple-values and required marks, and the default value together.
- After you tick "Required", the default value is still used when no value is provided; when there is no default value, or an empty value is submitted explicitly (`null` for a single-value parameter, an empty list for a multi-value parameter), a value must be provided, even if the parameter is used only inside `[[ ]]`. Unticking Required does not change the SQL syntax: a parameter outside an optional fragment still needs a value or a default value.
- Changing only the display name or the required setting also counts as a change to the SQL draft: it enters the dataset draft only after it is applied back to the dataset, and a revision is generated on the formal save. Opening or refreshing an unmodified parameter configuration does not falsely report unsaved changes because of a different property order.

## 5. Fields `fields`

A dataset contains only one kind of thing: the field. Each field is one of three: dimension, measure or metric.

- **Dimensions** are used to group, filter and sort, for example region and order time.
- **Measures** are numeric values on each row, for example order amount. A measure is aggregated when it is put into a chart.
- **Metrics** are values already aggregated in the expression, for example sales per buyer. A metric is used as is when it is put into a chart.

A field's value is either taken directly from a column of the source SQL or computed by an expression; the latter is called a calculated field (section 5.3). A metric can only be a calculated field.

| Property | Required | Description |
|---|---|---|
| `key` | Yes | Internal ID, generated automatically at creation, cannot be changed afterwards, not shown in the UI. See section 5.2 |
| `label` | Yes | Name, the only name users see and write, can be changed at any time. See section 5.2 |
| `column` | One of the two | Column name in the source (called "Physical column" in the UI), saved exactly as the source gives it, without quotes |
| `expr` | One of the two | Expression of a calculated field, see section 5.3 |
| `type` | Yes | Logical type, see section 5.1 |
| `role` | Yes | `dimension`, `measure` or `metric`. A measure can only be a numeric field; numeric dimensions and measures can be converted into each other. See section 6 |
| `description` | No | Business meaning, also used as AI context |
| `synonyms` | No | Synonyms, to help AI and search match |
| `format` | No | Display format of numbers and dates, see section 5.5 |
| `hidden` | No | Not shown in the chart field picker, but can still be referenced by existing charts and by the expressions of other fields; does not change data permissions |
| `group` | No | Group name in the field list |

### 5.1 Logical types

`string` `integer` `decimal` `float` `boolean` `date` `timestamp`

The physical types of each database are mapped to these seven in the driver layer. Types that cannot be mapped (arrays, JSON, binary and so on) are treated as `string` in v1 or marked unsupported.

### 5.2 Name, internal ID and physical column

`column` and `expr` are two properties rather than one, and a field has exactly one of them. Earlier there was only `expr`, and whether it was a column name or an expression was guessed from "whether it looks like an identifier": Chinese column names and column names with spaces or symbols were all guessed wrong and spliced into the SQL as expressions, unchanged. Now we do not guess:

- `column` is always a name, not SQL. When the query is compiled, the data source's dialect adds the quotes (PostgreSQL uses double quotes, MySQL and ClickHouse use backticks, and the escaping rules differ as well), so any characters are allowed in a column name, and supporting a new database only requires stating in its dialect how to quote.
- `expr` is always SQL, used as is, even if it is just a name. When an expression needs a column, it references the field that reads that column (`${name}`) instead of writing the column name and quotes itself.
- Neither the UI nor the API adds quotes.

A field has three names, each with its own job:

| | Property | Example | In the UI | Can be changed | Role |
|---|---|---|---|---|---|
| Name | `label` | Order amount | Shown, editable | At any time | For people to read; expressions are written with it |
| Physical column | `column` | `amount` | Shown, read-only | Can be changed to point to another column (see section 5.4) | Which column of the source SQL the field's value is taken from |
| Internal ID | `key` | `amount` | Not shown | Cannot be changed | Charts, dashboards, the query IR and the expressions of other fields use it to reference this field |

Users only need to understand the first two. The internal ID exists so that the other two can both be changed: changing the name affects no reference, and when the source SQL renames a column, you just point the field to the new column and charts notice nothing.

**Name rules**

- Unique within a dataset, with dimensions and measures counted together, and compared ignoring case and leading and trailing whitespace. Expressions reference fields by name, so duplicate names are not allowed.
- 1 to 100 characters, and must not contain `{`, `}` or line breaks. Nothing else is restricted; Chinese characters and spaces are allowed.
- For a newly detected column, the name defaults to the column name.

**Internal ID rules**

- Format: starts with a lowercase letter, contains only lowercase letters, digits and underscores, at most 63 characters. It is also used as the column alias in generated SQL, so it takes a form that needs no escaping in any database.
- Unique within a dataset.
- Generated automatically at creation: converted to the format above from the column name (for a calculated field, from the name at creation time). When no meaningful result can be produced (for example when it is all Chinese characters), `f_` plus a random string is used. On a collision a numeric suffix is added.
- It is not guaranteed to be readable, and not guaranteed to match the name or the column name: it does not change when the name changes or when the field is pointed to another column. No logic may depend on its literal meaning.
- It does not appear in the UI. It is still used in the definitions of the API, the query IR, charts and dashboards (see section 3.11 of [Query IR](query-ir.md)); users who call the API directly find it in the dataset definition.

The same column can correspond to several fields ("Duplicate field"). They have the same physical column and different names and internal IDs. A common use is a column that serves as both a dimension and a measure: for example "User ID" is a dimension, and the duplicated "Buyers" is a measure aggregated as a distinct count.

### 5.3 Calculated fields

When a field does not read a column, write an expression in `expr`, like `amount_tier`, `paid_amount` and `arpu` in the example above. Calculated fields are likewise either dimensions or measures. To reference another field, write `${name}`:

```sql
CASE WHEN ${Order amount} >= 1000 THEN 'High' WHEN ${Order amount} >= 100 THEN 'Medium' ELSE 'Low' END
```

An expression can be written in two ways, told apart by the field's `syntax`:

- `"syntax": "standard"`: written with the platform's own functions, which mean the same on every database and are written out as that database's SQL only when the query is compiled. The system can read it, so it can point out errors before saving, and the type is inferred from it. New calculated fields use this form by default. See [Standard expressions](expressions.md).
- No `syntax`: written in the data source's dialect and spliced into the SQL as is. It must be rewritten when the data source changes.

When stored, names are replaced with internal IDs, as in `${amount}`; when edited, they are replaced back with the current names. So when a referenced field is renamed, the name shown in the expression follows, and no manual change is needed. The conversion rules are in section 6.4.

A calculated field has no physical column. In the UI that column shows "Calculated field", with an entry point for editing the expression.

### 5.4 Where fields come from

The system does not parse SQL. It gets column information by a trial execution:

```sql
SELECT * FROM ( <source SQL, parameters set to their defaults> ) t LIMIT 0
```

It takes the column names and types from the returned column metadata, and then:

- A newly appearing column: a field suggestion is generated automatically, and the analyst confirms or adjusts it. The name is the column name, the internal ID is generated as in section 5.2, and the type is the mapped result. A numeric column is classified as a measure, and the others as dimensions. A numeric column named `id` or ending in `_id` is mostly an identifier rather than a quantity, and is classified as a dimension.
- The column that a field's `column` points to no longer exists: the field is kept and marked invalid, and is not deleted automatically. The analyst can point it to another column (chosen from the detected columns) or delete it. While an invalid field exists, the dataset cannot be saved.
- A column type has changed: the user is asked to confirm.

When a column is renamed in the source SQL, it appears as "one field becomes invalid and a new column appears at the same time". Point the invalid field to the new column and discard the extra field suggestion, and the field's name, internal ID and all references stay unchanged. The system does not guess which column was renamed.

### 5.5 Display format `format`

A numeric or date field can carry a display format. It decides how its value is written in tables, pivot table headers, KPI cards, axes, legends, tooltips and data labels, and View data and the dataset preview use it as well. A format affects display only and takes no part in queries. A chart can override it per column, see section 2.6 of [Charts and dashboards](chart-dashboard.md).

Numbers and dates each have their own properties.

**Numbers**

```jsonc
"format": {
  "style": "number",   // none | number (when omitted) | percent
  "decimals": 2,       // 0–10; when omitted, at most 2 places, no trailing zeros
  "grouping": true,    // thousands separator, default true
  "unit": "wan",       // unit conversion; omitted means no conversion: auto | K | wan | M | yi | B
  "prefix": "¥",
  "suffix": "元"
}
```

| Property | Description |
|---|---|
| `style` | `none` (called "None" in the UI) has no style at all and shows the query result as is: no thousands separator, no unit conversion, no rounding of decimals, and it cannot carry other properties. `number` shows according to the properties below, and is what applies when `style` is omitted from the format. `percent` shows a ratio as a percentage, so 0.2345 shows as 23.45%; the value stored in the field must be a ratio, and a value already multiplied by 100 uses `number` with the suffix `%` |
| `decimals` | A fixed number of decimal places, padded with 0 when short. When omitted, at most 2 places are kept and trailing 0s are not written |
| `grouping` | Whether to add a thousands separator. The separator and the decimal point follow the UI language |
| `unit` | Converts first, then shows. In order of size they are `K`, `wan`, `M`, `yi`, `B`, that is thousand, ten thousand, million, hundred million and billion; wan and yi are written as "万" and "亿" and do not change with the UI language. `auto` chooses a unit for each value separately according to the UI language: Chinese uses 万 and 亿, English uses K, M and B. `percent` cannot carry a unit |
| `prefix` / `suffix` | Prefix and suffix, at most 16 characters each, no line breaks. The minus sign goes before the prefix: `-¥1,234` |

For example, 1234567.891 shows as `¥123.46万元` with the format above.

- Exact decimals reach the frontend as strings. Converting units and percentages moves the decimal point without going through floating-point numbers, so no precision is lost. Rounding is always half up.
- An axis uses only the style, unit, thousands separator, prefix and suffix from the format. The decimal places are decided by the ticks, at most 2.
- A format has no default: a field with no format is "None" and is shown as is, measures and dimensions alike. Choosing "None" on a dataset means no format is stored. When shown as is, an exact decimal keeps every digit the query returns; a floating-point number keeps only the significant digits it can represent (at most 15), so 0.1 + 0.2 shows as 0.3, not 0.30000000000000004.
- Ticks on an axis have to fit, so a "None" tick at one million or above is abbreviated according to the UI language, for example 2.5M.

**Dates and times**

Status: implemented.

```jsonc
"format": {
  "date": "slash",    // style: dash (when omitted) | slash | chinese
  "time": "minute",   // timestamp only: second (when omitted) | minute | none
  "week": "number"    // when grouped by week: range (when omitted) | start | number
}
```

| Property | Description |
|---|---|
| `date` | Style. `dash` uses hyphens; `slash` uses slashes; `chinese` writes "2026年1月5日". It does not change with the UI language, like "万" and "亿" |
| `time` | How far a timestamp with no grain is written. `second` goes to the second; `minute` to the minute; `none` writes only the date. `date` fields do not have this property |
| `week` | How a week is written when grouped by week. `range` writes the start and end dates; `start` writes only the first day; `number` writes the week number |

How far a value is written is decided by the query's grain: the dimension's `grain` (section 3.4 of [Query IR](query-ir.md)) is returned with the result column (section 4 of the Query IR):

| Grain | `dash` | `slash` | `chinese` |
|---|---|---|---|
| Year | 2026 | 2026 | 2026年 |
| Quarter | 2026 Q1 | 2026 Q1 | 2026年第1季度 |
| Month | 2026-01 | 2026/01 | 2026年1月 |
| Day, `date` with no grain | 2026-01-05 | 2026/01/05 | 2026年1月5日 |
| Hour | 2026-01-05 13:00 | 2026/01/05 13:00 | 2026年1月5日 13:00 |
| Minute | 2026-01-05 13:45 | 2026/01/05 13:45 | 2026年1月5日 13:45 |
| `timestamp` with no grain | 2026-01-05 13:45:12 | 2026/01/05 13:45:12 | 2026年1月5日 13:45:12 |

When grouped by week:

| `week` | `dash` | `slash` | `chinese` |
|---|---|---|---|
| `range` | 2026-01-05 ~ 01-11 | 2026/01/05 ~ 01/11 | 2026年1月5日 ~ 1月11日 |
| `start` | 2026-01-05 | 2026/01/05 | 2026年1月5日 |
| `number` | 2026-W02 | 2026/W02 | 2026年第2周 |

- `time` governs only ungrouped timestamps, such as the time in a detail table or a time aggregated as earliest or latest. When grouped by hour or minute, the value is written according to the grain and `time` is ignored.
- The end of a date range always writes the month and day, and also the year when it crosses a year: `2025-12-29 ~ 2026-01-04`.
- The week number is counted by the workspace's "Weeks start on" and "First week" settings (section 10.2 of [Architecture overview](architecture.md)). The year in front is the year the week belongs to, not necessarily the year of its first day: the week starting 2025-12-29 is 2026-W01 under "Has at least 4 days in the year". The week number is padded to two digits. The Q of a quarter and the W of a week do not change with the UI language.
- With no format, the defaults apply: hyphens, to the second, start and end dates, so a value grouped by month is no longer written as the first day of that month. Dates have no "None": `2026-01-01` written as is does not look like a month. Choosing the default for all three on a dataset means no format is stored.
- A value is already local time in the query time zone (section 10.2 of [Architecture overview](architecture.md)), so it is not converted again when shown.
- A date truncated by an expression (such as `DATE_TRUNC('month', ${Order date})`) carries no grain and is written as a day.
- Sorting, chart links and filters all use the original value. Two values that are written the same are still two categories, for example two times on the same day when only the date is written.

**Rules common to both**

- Only numeric (`integer`, `decimal`, `float`) and date (`date`, `timestamp`) fields can carry a format, and the properties must match the type: a numeric field can have only the numeric properties, a date field only the date properties, and a `date` field cannot have `time`. Fields of other types cannot carry a format. A mismatch is rejected on save.
- When a field's type is changed in the UI, the format that the new type cannot use is cleared with it: switching between numeric and date, or changing to another type, clears the whole format, and changing `timestamp` to `date` removes `time`.
- The format is returned with the result column of the query (see section 4 of [Query IR](query-ir.md)): dimensions, metrics, and measures aggregated by sum, average, minimum or maximum carry the field's format; count and distinct count do not, because the count of order amount is not an amount, and the count of order date is not a date either.
- Data exploration shows the raw result of the SQL, does not go through a dataset, and has no format. Exports write raw values, see section 2.3 of [Exports](exports.md).
- Conditional coloring and parentheses for negative numbers are not supported yet.

## 6. Dimensions and measures

`role` decides which side a field appears on by default and how it is used when put into a chart. It is only a property of the field, and numeric dimensions and measures can be converted into each other at any time; for a field that is referenced by the expressions of other fields or used by charts, the impact must be confirmed before the conversion (see section 8).

There are three kinds of numeric values, differing in who does the aggregation:

| | `role` | Example | Source | Aggregation | Additive |
|---|---|---|---|---|---|
| Column measure | `measure` | Order amount | Column name `amount` | The aggregation is chosen in the chart; it is sum when dragged in | Depends on the aggregation |
| Row-level calculated measure | `measure` | Paid amount | Row-level expression `CASE WHEN ... END` | Same as above | Same as above |
| Metric | `metric` | Sales per buyer | Expression with aggregate functions `SUM(...) / COUNT(DISTINCT ...)` | The expression does it itself; the system adds no aggregation | No |

Dimensions and measures are row-level: each row has one value. Metrics are not.

The place in the chart editor where numeric values go is also called "Measures": a metric is used as is; a measure or dimension dragged in comes with an aggregation and becomes this chart's own measure. The aggregation is written only in the chart, and the dataset does not prescribe it: a measure is summed when dragged in, a dimension is counted distinct, and it can be changed in the chart afterwards.

### 6.1 Aggregations

A measure can only be a numeric field, and a non-numeric field can only be a dimension. A measure means "a number on each row, to be aggregated when put into a chart", and summing text or dates is meaningless.

The aggregation values are `sum` `avg` `min` `max` `count` `count_distinct`, written in the query (see section 3.5 of [Query IR](query-ir.md)). All six can be used on numeric fields; other types can use only `count` `count_distinct` `min` `max`. A dimension can also be aggregated, for example a distinct count of "User ID", and nothing needs to be built in the dataset first.

When a number has only one correct way to be computed, such as order count, buyers, or the average of a unit price, write it as a metric (section 6.2) instead of counting on every chart to choose the right aggregation: a metric's aggregation is written in its own expression, so it is the same in any chart that uses it.

When a measure with a condition is needed, write it as a row-level calculated measure: "Paid amount" in the example above gives null for rows that do not meet the condition, and these are naturally ignored when summing.

`sum` and `count` are additive; `avg` and `count_distinct` are not. The system uses this to decide whether frontend totals, pre-aggregation and cache reuse are possible.

### 6.2 Metrics `metric`

Values such as ratios and weighted averages cannot be obtained by "computing each row first, then aggregating", so the expression must contain the aggregate functions itself:

```sql
SUM(${Order amount}) / NULLIF(COUNT(DISTINCT ${User ID}), 0)
```

The `role` of such a field is `metric`:

- A chart cannot specify an aggregation for it again.
- It can appear only in the measure position of a query and in `having`. It cannot be used to group or to filter detail rows, and does not appear in the columns of detail mode.
- It is always treated as non-additive.
- For a metric whose type is time, the system converts the result to local time in the query time zone (see section 10.2 of [Architecture overview](architecture.md)). Do not convert the time zone in the expression yourself, or it is converted twice.

The system does not parse expressions, so whether a field is a measure or a metric is declared by its creator. A wrong declaration is rejected by the database in the trial execution of the expression at save time (see section 8): an expression that contains an aggregate function but is declared a measure gets an aggregation error in a grouped query; an expression with no aggregation that is declared a metric gets an error such as "must appear in the GROUP BY clause".

### 6.3 How field references in expressions are expanded

- A reference to a row-level field (dimension or measure) expands to its row-level expression, **without aggregation**. So in a metric you write `SUM(${Order amount})`, not just `${Order amount}`.
- A reference to a metric expands to its expression, wrapped in parentheses. Only metrics can be referenced this way, for example `${Sales per buyer} * 100`.
- A row-level field cannot reference a metric.

### 6.4 `${...}` references

Expressions reference other fields uniformly with `${...}`. It has two forms with the same content; only what is written inside the braces differs:

| | Inside the braces | Example | Appears in |
|---|---|---|---|
| Written form | Name | `SUM(${Order amount}) / NULLIF(COUNT(DISTINCT ${User ID}), 0)` | The dataset editing UI |
| Stored form | Internal ID | `SUM(${amount}) / NULLIF(COUNT(DISTINCT ${user_id}), 0)` | Database, API |

The editing UI converts between the two; the API accepts and returns only the stored form:

- On open: replace each `${internal ID}` with the field's current name.
- On save: replace each `${name}` with the corresponding internal ID, matching with case and leading and trailing whitespace ignored. A name with no matching field is an error: it names which name in which expression, and nothing is saved.
- Names do not contain `{` or `}`, so the written form is unambiguous.

The `[name]` notation was not adopted: in ClickHouse and PostgreSQL, square brackets are the syntax of array literals and subscripts, and expressions can be written in the data source's dialect, so the two would conflict.

When a query is compiled, a native expression gets a text substitution on the stored form, and a standard expression is output from the syntax tree. What this reference scheme gives:

- **Decoupling**: when the source SQL renames a column, you only point the corresponding field to the new column, and the calculated fields that reference it need no change; when a field is renamed, the stored expressions do not change.
- **Known dependencies**: who depends on whom is known without parsing SQL, which is used for impact analysis and circular reference detection. A field referenced by other fields cannot be deleted; remove the references first.

Writing a raw column name directly in an expression can technically run, but the system cannot see such a dependency, so it is not recommended.

## 7. Other settings

| Property | Description |
|---|---|
| `cache.ttlSeconds` | Query result cache duration; defaults to the workspace settings; `0` means no caching |

Row-level and column-level permission policies are also attached to the dataset; their structure is defined separately in the Access control and workspaces document.

## 8. Validation on save

1. Structure validation: JSON Schema; format and uniqueness of internal IDs; format and uniqueness of names (section 5.2); display format values are valid, appear only on numeric and date fields, and the properties match the field type (section 5.5); the targets of `${...}` references exist; no circular references; measures are numeric fields (section 6.1); row-level fields do not reference metrics (section 6.3).
2. Parameter validation: every `{{name}}` in the SQL is declared; `[[ ]]` is paired correctly.
3. Source trial execution: `LIMIT 0` gets the column information, which is compared with the field mapping (see section 5.4).
4. Expression trial execution: the database checks the syntax and types of the expressions, in two `LIMIT 0` queries. One has no grouping and selects all row-level fields; the other computes all measures and metrics, with measures summed and metrics as the expression itself. Fields whose measure or metric declaration is wrong are rejected by the database here. The trial execution does not convert time to the query time zone, and the database reports the field's original type: a field declared as time that is actually a date or text is also rejected here.
5. Impact analysis: compared with the previous version, find the fields that were deleted or had their type or `role` changed, and the parameters that were deleted or changed, and list the charts that reference them. When charts are affected, confirmation is required before saving.

Impact analysis reads the current revision and the referencing definitions through `POST /datasets/{id}/impact` and runs no data query. Field references include chart queries, filters, the time fields of period-over-period comparison, all options of dynamic positions, each level of drill-down (section 2.10 of [Charts and dashboards](chart-dashboard.md)), and the indirect dependencies of calculated fields; dashboard global filters and chart links are checked separately, and cannot be judged from the chart's query fields alone. When a parameter is deleted or its type or multi-select setting changes, the charts that use the parameter are flagged: both a chart's parameter filter and `query.params` count (section 2.11 of [Charts and dashboards](chart-dashboard.md)); a parameter that used to run without a value and now must be passed one flags all charts of the dataset. Whether a parameter is required considers both `required` and its position in the SQL: adding a placeholder without a default value outside `[[ ]]`, moving a parameter without a default value out of an optional fragment, and clearing the default value of a required parameter all need confirmation; an empty default list of a multi-value parameter counts as no value. Adding a parameter with a valid default value, changing a valid default value, or clearing the default value of a parameter that is used only inside an optional fragment and has no `required` does not trigger confirmation.

Changing an existing parameter to `required`, or moving it out of an optional fragment, also needs confirmation: a viewer may clear the parameter control on a chart (a single value submits `null`, multiple values submit an empty array), and the parameter default value is then not used, so tightening the required constraint would make the original query fail.

The editor carries the `expectedRevision` from when it was opened, to avoid overwriting changes made in another tab or by someone else. The update and impact analysis APIs both require this field to be a positive integer, and return `revision_required` when it is omitted or invalid. When resources are affected, their names, the reason for the change and the dashboards they are on are shown, and links open in a new browser tab. After confirmation the save carries an `impactToken`; this token is bound to the definition to be saved, the original revision and the related resource definitions. The backend locks and re-analyzes inside the save transaction: a revision mismatch returns `resource_revision_conflict`, the same as for charts and dashboards, and an expired impact confirmation returns `dataset_impact_required`. A field referenced by a permission rule still cannot be deleted, and confirming the impact cannot bypass permission validation. Adding fields, and changing display names, formats or column mappings do not trigger confirmation.

After a version conflict, the draft is kept, and there is no automatic retry after a refresh. A unified diff window compares the editing baseline, the current draft and the freshly read latest content. Name and description are handled independently; the data source, SQL, parameters and the other dataset settings are still handled as one group. Fields are matched by their internal `key`, not by display name or array position:

- `label`, `description`, `format` and `hidden` of the same field are compared separately. Changes to different fields or different properties can be kept together; a change made by one side only and an identical change by both sides are merged automatically, and items are chosen one by one only when both sides change the same property differently. Clearing a property is also a change; `format` is chosen as a whole, and its inner settings are not spliced together.
- When the type, role, formula, expression language, source column or any other field definition changes, the field is compared as a whole. If only one side changed it, that can be kept; if the two sides differ, one side is chosen, to avoid splicing incompatible configurations such as a new type with an old format.
- New fields with different internal IDs can both be kept; a field added with the same ID but a different definition needs a choice. If one side deletes a field and the other leaves it unchanged, it is deleted; if one side deletes it and the other modifies it, an explicit choice is needed. When an ID is missing or duplicated, it falls back to choosing from the complete field list.
- Field order compares the original fields that both sides keep; adding or deleting does not by itself produce an order conflict. If only one side rearranges the order, that order is used; if both sides rearrange differently, a choice is needed. A field added by the other side or chosen to be kept is inserted before the next field that is still in the list, and appended when there is no following field.

The window shows only the changed items, and distinguishes automatic merges from conflicts awaiting a choice. The merge result still needs to be confirmed before it is applied. Closing the window changes neither the draft nor the baseline; after applying, the server's latest revision and content become the baseline, and the merged content becomes an unsaved draft that can be adjusted further. The next save still runs definition validation, impact analysis and confirmation, and a successful merge does not bypass checks on field references, parameters, data sources and so on; new changes made in the meantime still trigger a conflict. When reading the latest content fails or the resource has been deleted, the draft is kept, and the version check cannot be skipped.

If new draft changes arrive while the comparison window is open, such as an SQL write-back or a field detection result, the old merge plan stops being applied immediately. After "Compare again" is clicked, the server content is read again with the current draft and the old choices are cleared; it can be applied only after confirming again, so that an old snapshot does not overwrite later changes. If comparing again fails, the draft and the original editing baseline are still kept, and retry is supported.


When validation fails, messages to users always refer to fields by name and never show internal IDs.

Steps 3 and 4 need the data source to be reachable. When the data source is unreachable, saving as unvalidated is allowed, but the dataset cannot be referenced by new charts.

## 9. Changes and versions

- Every save creates an immutable revision snapshot, including the name, the description, the data source ID with its display name at the time, and the complete definition containing the SQL, parameters, fields and formats. The modification time and the modifier are recorded with the revision.
- The editor's "Revision history" lists the records in reverse chronological order with paging, shows the complete configuration of each version, and lets you pick any two versions to compare. The SQL is marked line by line for additions and deletions; fields are compared by internal ID and parameters by name for property changes, so a rename is not mistaken for a deletion followed by an addition.
- "Restore as draft" only replaces the current dataset editing content; if there are unsaved changes, it asks for confirmation first. The draft still takes the revision from when the editor was opened or last saved as its baseline, and saving still runs the normal validation, permission field checks, impact analysis and concurrent conflict checks; on success a new revision is created, and the old history is not rewritten. When the old data source has been deleted, the snapshot can still be viewed, and an available data source must be chosen again before saving.
- Data permissions and folder membership are maintained through separate APIs and are not part of the definition revision; restoring does not change them. The history API is open only to developers and admins of the current workspace.
- Non-destructive changes (changing the data-fetching logic, adding fields, renaming, changing column mappings) take effect directly.
- Destructive changes (deleting fields or parameters, changing types, changing `role`, changing an optional parameter to required) trigger impact analysis.
- When a field referenced by a chart no longer exists, the chart shows a clear error message naming the missing field, and other charts on the same dashboard are not affected. For a field that has been deleted, the name comes from the most recent revision of the dataset that still contains it; if it cannot be found, the internal ID is used. A viewer gets the name only when their current column permissions allow viewing that historical field and its dependencies.

## 10. Storage

- Table `dataset`: ID, workspace, data source, name, current revision number, complete definition (JSONB), validation status, creator and time.
- Table `dataset_revisions`: the complete definition of each revision, name, description, data source ID and display name, modifier and modification time.
- Reference index table: records which internal IDs of which dataset each chart references; it is maintained when a chart is saved and used by impact analysis queries.

## 11. Explicitly not in v1

| Item | Reason |
|---|---|
| Associations between datasets | An established trade-off of the lightweight semantic layer; joins are written in the source SQL |
| Building a dataset on another dataset | Adds compilation and permission complexity |
| Materialization (saving the result as a table) | A performance optimization that depends on the scheduler; to be done later |
| Dimension hierarchies (province → city → district) | Drill-down levels are configured in the chart (section 2.10 of [Charts and dashboards](chart-dashboard.md)), so a change to a dataset does not silently break the drill-down of downstream charts; when many charts repeatedly configure the same set of levels, define it in the dataset as a preset in the editor |
| Dimension grouping (merging values into a few tiers) | Can be written as a calculated field with `CASE WHEN`; a dedicated UI comes later |
| Translating native expressions and source SQL to another dialect | There is no SQL parser. Calculated fields written with [Standard expressions](expressions.md) need no translation |

## 12. Decisions made

1. **No draft/publish state in v1**: a save takes effect immediately, backed by impact analysis and revision rollback. The draft state is recorded in [Deferred items](../backlog.md).
2. **Read-only is guaranteed by the permissions of the data source account**; the system only does basic checks and does not introduce a SQL parser. The data source configuration UI must clearly tell users to use a read-only account.
3. **Internal IDs are not shown to users**. Users face only names and physical columns, and expressions are written by name, see sections 5.2 and 6.4. Two alternatives were considered:
   - Show the internal ID as an "Identifier" (the original approach): it is generated from the column name and cannot be changed, so to users it is just another way of writing the column name, one more concept to understand with no visible benefit.
   - Drop the internal ID and use the source SQL's column name directly as the field's identity: a calculated field has no column name, so it would still need a separate unchangeable name; one column could not correspond to several fields; a column rename could only be covered by writing an alias in the SQL, which a `table` source has no way to do.
4. **Only fields, split into dimensions and measures, with no separate metrics**. The `measures` list was removed, and fields gained `role` and `aggregated`. The three original kinds of metric became:
   - Structured metric (one aggregation on one field): a measure field; the aggregation was then written in `defaultAgg`, and later became decided by the chart, see item 6.
   - Structured metric with a filter condition: a row-level calculated measure, with the condition written into `CASE WHEN`.
   - Expression metric: an already-aggregated calculated measure. Previously, referencing a structured metric in an expression (`${revenue}`) brought the aggregation with it; now the reference is to a row-level field, and the aggregate function must be written out (`SUM(${Order amount})`).

   The reasons for doing it this way: one concept fewer, and a detected numeric column can be used directly without first creating a metric for it; additivity is still knowable, because apart from already-aggregated calculated measures, all aggregations are structured. The cost is that a measure with a condition goes from a dialect-independent structured filter to an expression written in the dialect; calculated fields were already written in the dialect, so this is no new restriction.

   The product has not been released, so this is an incompatible change: `specVersion` stays 1, no migration is provided, and the development environment is cleared with `make dev-reset` and rebuilt.

   Later, the "already-aggregated calculated measure" was changed from `role: "measure"` plus `aggregated: true` to a separate `role: "metric"`, called "Metric" in the UI. The reasons: what a field is gets stated in one place only, and there are no more combinations such as "a dimension marked as aggregated" that must be ruled out by validation; the UI, storage and users' wording agree; when AI generates or reads a dataset definition, a three-way enum is less error-prone than "an enum plus a boolean". This is still not the kind of "metric" removed above: it is a kind of field, not a separate list, and measures still work without first creating a metric. `specVersion` stays 1.
5. **The display format is a structured object, not a format string**. We considered an Excel-style format string (`#,##0.00`): it is familiar and compact, but we would have to implement a parser ourselves; writing "万" and "亿" is awkward (`0.0,,"万"`); and the UI would either make people hand-write format strings or convert back and forth between a form and a format string. Each property of the object maps directly to the browser's `Intl.NumberFormat`, backend validation only checks a few enums, the UI is just a set of form controls, and AI is less likely to get it wrong when generating it. `specVersion` stays 1. Dates do not use a `yyyy-MM-dd` style format string either: the same field must be written to different levels when grouped by month and by day, a format string can fix only one level, and when grouped by month `yyyy-MM-dd` would write the first day of the month. So the format only chooses the style, and how far it is written is decided by the grain.
6. **The dataset does not prescribe the aggregation**. Fields used to have `defaultAgg`: a measure was aggregated by it when put into a chart, and a chart could choose "Default" to follow it. It was later removed, and the aggregation is written only in the chart; a measure is summed when dragged into a chart. The reasons:
   - When a number has only one correct way to compute, that is the job of a metric, whose aggregation is written in its own expression; a default aggregation overlaps with the metric's responsibility.
   - A chart that follows the default would have its result silently changed when the dataset changes the default aggregation, without the chart's author knowing; with the aggregation written in the chart, the result is deterministic.
   - One concept fewer: the dataset has no "default aggregation" column, and the chart has no "Default" marker.

   At the same time, measures must be numeric fields: all that can be done on text and dates is counting and min/max, and they can simply be aggregated as dimensions. The cost is that for numbers that cannot be summed, such as average price and ratios, summing by default when dragged into a chart is wrong, so either change the aggregation in the chart or write a metric. `specVersion` stays 1.
