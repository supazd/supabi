# Chart and dashboard spec design (v1)

Status: implemented, still evolving. It goes with [Query IR](query-ir.md) and [Dataset model](dataset.md). Section 7 records the main design trade-offs.

Filters bind directly to dataset fields or chart measures, and the chart does not have to expose a filter. Dynamic dimensions/metrics and cascading candidates are supported. Old filter ID bindings are converted by a database migration, so no data needs to be rebuilt. The properties added in this round are all optional and `specVersion` stays 1; old charts with no dynamic fields or cascading keep their previous behavior.

The interaction follows DataWind's [dynamic dimensions/dynamic metrics](https://docs.volcengine.com/docs/Datawindprivatization/Dynamicdimensionsdynamicmetrics?lang=zh) and [global filters](https://docs.volcengine.com/docs/Datawindprivatization/Globalfilter?lang=zh). This project implements the main flows of filter configuration, dynamic switching, association takeover and cascading. The field identity, request protocol, back-fill and limits described below are SupaBI's own implementation rules; details that the reference docs do not state are not inferred to be DataWind's behavior.

## 1. Positioning

- **Chart**: one query plus one way of presenting it. It is reusable, saved on its own, and can be referenced by several dashboards.
- **Dashboard**: the layout of several charts, plus the filters that act on them.

Both are declarative JSON, carry a version number and are stored in the metadata database. The drag-and-drop editor, the AI and the API all produce and consume the same structure, and no rendering library appears in it.

Charts and dashboards also have a separate content `revision`, unrelated to the config format `specVersion`. The read and list endpoints return the content version. An update must send `expectedRevision`; if it is missing or invalid, the response is 400 `revision_required`. The save transaction locks the dependencies and the current resource in the order dataset, chart, dashboard, checks the current version, updates the content and increments the version. When saves of the same version run concurrently, only one succeeds. A stale save returns 409 `resource_revision_conflict` and changes neither the content nor the reference index. Charts and dashboards do not yet record a full revision history.

The editor and datasets use the same window for resolving differences. It compares the original content, the current draft and the latest content on the server. Name and description are chosen independently; a chart's query, visualization and filter settings form one group, and a dashboard's layout, widgets, filters and chart links form one group, so that settings that depend on each other are not pulled apart and spliced together. A side that has not changed automatically yields to the side that has; where the two sides changed differently, an explicit choice is required. Closing the window keeps the draft and the original version. Applying the result only updates the draft and the save baseline, and editing can continue. For a dashboard, applying also clears the undo/redo history, because the state before the merge is based on the old version, and undoing back and then saving with the new version number would overwrite other people's changes without a prompt. Saving again still performs the version check and the normal validation, and new changes made in the meantime prompt a conflict again. This conflict is handled separately from a dependency conflict caused by changes to the datasets or charts referenced during the save.

## 2. Chart spec

```jsonc
{
  "specVersion": 1,
  "query": { /* query IR, see query-ir.md */ },
  "viz": {
    "type": "bar",
    "x": "month",
    "y": ["revenue", "paid_revenue"],
    "series": "region",
    "stacked": true,
    "formats": { /* optional, see 2.6 */ }
  },
  "filters": [ /* see 2.3; for those targeting dataset parameters, see 2.11 */ ],
  "dynamics": [ /* optional, see 2.4 */ ],
  "allowExport": false, /* optional, see 2.9 */
  "drill": { /* optional, see 2.10 */ }
}
```

Everything `viz` references is an alias of a query output column, not an internal ID of a dataset field. This way a chart's presentation depends only on the shape of the query result.

### 2.1 Chart types

| `type` | Meaning | `x` | `y` | `series` | Other |
|---|---|---|---|---|---|
| `bar` | Bar chart | Required, one dimension column | Required, one or more measure columns | Optional, one dimension column | `stacked` |
| `hbar` | Horizontal bar chart | Same as above, laid out top to bottom along the vertical axis | Same | Same | `stacked` |
| `line` | Line chart | Same | Same | Same | |
| `area` | Area chart | Same | Same | Same | `stacked` |
| `combo` | Combo chart | Required, one dimension column | Required, at least two measure columns | Not supported | `lines`: the measures drawn as lines, the rest are drawn as bars; `rightAxis`: the measures read on the right value axis |
| `scatter` | Scatter chart | Required, one point per value | Required, two to three measure columns: horizontal axis, vertical axis, bubble size | Optional, points are colored by its values | |
| `pie` | Pie chart | Required, category column | Required, exactly one measure column | Not supported | |
| `funnel` | Funnel chart | Required, one tier per value | Required, exactly one measure column | Not supported | Sorted from largest to smallest, not merged into "Other" |
| `treemap` | Treemap | Required, one block per value | Required, exactly one measure column | Optional, used as the grouping, one color per group | |
| `heatmap` | Heatmap | Not supported | Required, exactly one measure column | Not supported | `rows` and `columns` each take exactly one dimension column, placed on the vertical and horizontal axes respectively |
| `gauge` | Gauge | Not supported | Required, one to two measure columns; the second is the target value | Not supported | Takes the first row of the result |
| `kpi` | KPI card | Not supported | Required, one or more measure columns | Not supported | Takes the first row of the result |
| `table` | Table | Not supported | Not supported | Not supported | Shown in the query's column order; `hiddenColumns` can hide the given output columns; `columnGroups` adds groups above the header for adjacent columns |
| `pivot` | Pivot table | Not supported | Required, one or more measure columns | Not supported | `rows`, `columns`: the dimension columns placed on the left and on top, each dimension in exactly one place, at least one |
| `sankey` | Sankey chart | Not supported | Required, exactly one measure column: the flow | Not supported | `levels`: the dimension columns of the levels from left to right, 2 to 4 of them, each dimension of the query in exactly one level |

A detail table is not another `type`: it is a `table` whose query is in detail mode (`mode: "detail"`, see [Query IR](query-ir.md) 3.3). `viz` depends only on the shape of the result, while the difference between a summary table and a detail table is what is being asked, so it is recorded in the query. The chart editor has only one "Table" type. Once it is selected, an "Aggregated / Detail" segmented control appears below the chart type. It is not in a collapsible group and is always visible, because it decides whether the canvas holds "Dimensions + Measures" or "Columns". When "Detail" is chosen, the dimension bar and the measure bar are replaced by a single "Columns" bar. Dimensions and measures can be put into it, but metrics cannot, because a metric has no value on a single row. When switching back and forth, the selected fields are kept as far as possible. A new chart defaults to "Table · Detail", and switching to Table from another chart type defaults to "Aggregated". When the chart has a condition that filters on aggregate results, "Detail" cannot be selected, and the reason is explained below the control.

The field menu of a numeric measure has "Measure calculation", which supports "Original value / Grand total / Within groups". For "Within groups", several of the current dimensions can be selected, and at least one must be chosen; the `%` button of a dynamic metric uses the same settings. The settings are saved in the query's `compute`, and the preview, the dashboard and reopening all use the same definition ([Query IR](query-ir.md) 3.5). When the calculation is changed, the chart format override of that column is cleared and a percentage is shown by default; merely opening and confirming the original settings does not change the format. The original measure and the share can both be put into the chart. Removing a dimension removes it from the share's grouping, and when all are removed it becomes "Grand total".

The same window supports "Period comparison": choose the time field, the current period, and year over year (previous 1 year) or period over period (an offset with a unit of day/week/month/quarter/year), and the output is the previous value, the difference or the growth rate. The current period is also written into the chart filter of that field; an existing filter keeps its ID and label; a single-date control is upgraded to a date range control so that the display matches the current period, and other controls are kept. If there is no filter yet, a fixed filter is added. The range must be bounded and must not include null dates. The calculation is kept when the chart is saved and reopened, when a dynamic metric is switched and when a dashboard runs; the original value, the share, year over year and period over period can coexist as measures with different aliases. The growth rate defaults to a percentage; the previous value and the difference keep the format of the original measure. The name of a dynamic option is used as the name before the calculation, and the result appends a year-over-year, period-over-period or share note; when an old chart is saved again, the corresponding name property is converted automatically.

The same window also has "Running total", whose definition is in [Query IR](query-ir.md) 3.5:

- Choose which dimension the total runs along. The candidates are the chart's current dimensions; the default is the first time dimension, or the first dimension if there is none. A chart with no dimensions does not have this option.
- Only measures aggregated by sum, count, minimum or maximum can have a running total. For average, distinct count and dataset metrics this option is unavailable, with the reason given: their running total cannot be derived from the values of the groups in turn. When a dynamic metric has a running total, all its candidates must use one of these four aggregations. This is checked on save, like the checks on other candidates, so that the default candidate does not work while a switch to another one fails.
- The window explains the definition: the total starts from the beginning separately within each of the other dimensions; it starts at the beginning of the filter range and does not include earlier data; result filters, sorting and the row limit do not change the running total.
- The name gets the suffix "(running total)", and the format follows the original measure's format. The original value and the running total can be put into the chart together.
- When the dimension it runs along is removed from the chart, or the aggregation is changed to one that cannot run a total, the calculation reverts to the original value. When the dimension it runs along is a dynamic dimension that may be left empty and the viewer chooses empty, the column is an ordinary aggregate, that is, the value accumulated to the end of the whole range.

The chart type is chosen by the author, and the editor does not change it for them. Adding or removing fields does not change the chart type. When the fields do not meet the requirements of the chosen type (for example a bar chart whose only dimension was deleted), the type stays as it is, the canvas shows what is missing or extra (for example "The bar chart still needs 1 dimension"), and the corresponding dimension bar or measure bar is marked. No query is sent then, and the previous result is not shown either, because it does not match the current fields and could be mistaken for the current chart; the chart also cannot be saved. Once the fields are complete, the query runs again at once, even if the query itself is the same as before (for example switching from a bar chart missing its dimension to a KPI card). Any chart type can be chosen first and the fields added afterward as prompted; hovering over the icon shows what fields this chart type needs, for example a pie chart needs "1 dimension and 1 metric". The editor's requirements for fields:

| Type | Dimensions | Measures | How the editor places them |
|---|---|---|---|
| Bar, horizontal bar, line and area charts | 1 or 2 | 1 or more; exactly 1 with 2 dimensions | With 2 dimensions, the time dimension goes on the category axis and the other is split into series |
| Combo chart | 1 | 2 or more | The first measure is drawn as bars and the rest as lines, all read on the left axis; in "Style" each can be changed to bars or a line and moved to the right axis |
| Scatter chart | 1 or 2 | 2 or 3 | Each value of the first dimension is a point, and the second dimension sets the color |
| Pie and funnel charts | 1 | 1 | |
| Treemap | 1 or 2 | 1 | With 2 dimensions the first is the grouping |
| Heatmap | 2 | 1 | The time dimension goes on the horizontal axis and the other on the vertical axis; if neither is a time dimension, the first is on the horizontal axis |
| Gauge | 0 | 1 or 2 | The second measure is the target value |
| KPI card | 0 | 1 or more | In "KPI style" one measure can be compared with another |
| Table | Any number | Any number | |
| Pivot table | 1 or more | 1 or more | The dimension bar is replaced by two bars, "Rows" and "Columns across"; the field menu can move a field between rows and columns |
| Sankey chart | 2 to 4 | 1 | The dimensions form the levels from left to right in the order they have in the bar |

**The order of fields in a bar** can be adjusted by dragging directly, and a new field can also be dragged to any position in the bar. Earlier, a new field could only be added to the end, and changing the order meant deleting it and adding it back.

- **Scope**: dimensions, measures, detail columns, the "Rows" and "Columns across" of a pivot table, and filters are each reordered by dragging within their own bar, and so are dynamic dimensions and dynamic metrics. A field cannot be dragged to another bar; the drop is not accepted (the cursor shows that dropping is not allowed). Within a pivot table, rows and columns still use "Move to columns / Move to rows" in the field menu. Dragging to another bar is in [Deferred items](../backlog.md).
- **Dragging**: hold and drag the whole field block, with no separate handle; a single click still opens its menu or filter settings. While dragging, a vertical line shows at the drop position: if the pointer is over the left half of a field block, the field goes before it, and over the right half, after it. When the fields in a bar wrap onto several lines, the line the pointer is on decides. Dropping on blank space in the bar puts the field last. Releasing outside the bar or pressing Escape leaves the order unchanged; dropping it back in place also changes nothing and does not run the query again.
- **A new field dragged in from the field list on the left** also lands where it is released, with the same line rules; adding it by clicking, or dragging it to blank space in the bar, still puts it last. Filters and dynamic fields must first be set up in a dialog; after confirming they are placed where the drag was released, and canceling adds nothing. A dimension or column that is already in the bar and is dragged in again stays as it is now, and its position does not change either.
- **Keyboard**: the field menu has "Move earlier" and "Move later", which are unavailable when the field is already first or last. Opening a filter's field block shows the filter settings and there is no menu, so when any field block has focus, Alt+← / Alt+→ moves it one position earlier or later.
- **What a changed order affects**: the order of dimensions, measures and columns is the order of the columns the query returns, so the query runs again. The column order of a table, sorting by the dimensions in turn when no sort is set (2.7), the left column constraining the right one when equal values are merged (2.8), the nesting of the rows and columns of a pivot table, the levels of a Sankey chart, the first measure drawn as bars in a combo chart when nothing is specified, and the second measure of a gauge being the target value all follow the order in the bar. The order of filters is the order of the controls on the canvas and the dashboard.
- **Not affected**: sorting, display format, hiding, column width and alignment all go by the alias of the output column and do not change with the order. For column groups, see 2.7. A read-only chart cannot be dragged.

Rules:

- **One value axis**. Several measures share the same axis; measures whose magnitudes differ widely should be split into two charts. The only exception is the combo chart: when the author explicitly puts a measure in `rightAxis`, it reads the second value axis on the right, its name in the legend is followed by "(right axis)", and the right axis draws no grid lines. There is no right axis by default, and when the right axis is checked the editor warns that two axes make it easy to compare heights that are not comparable.
- `series` splits the values of one dimension into several series. When a bar, horizontal bar, line or area chart uses `series`, `y` can have only one measure.
- **The colors of series and pie sectors are assigned in a fixed order and do not cycle**. When there are more than 8, the first 7 are kept by their total values and the rest are merged into "Other". A point in a scatter chart can sit next to any other point, and of the 8 colors only the first 3 can be told apart from each other in every pairing (including color vision deficiency simulation), so a scatter chart keeps the first 3 groups by number of points and merges the rest into "Other", in neutral gray. The tiers of a funnel chart have an order, so they are not merged, and the colors use one hue from dark to light (light to dark in dark mode); a heatmap likewise uses a single hue for magnitude and adds a color scale. In a treemap with no grouping all blocks have the same color and are told apart by the gaps between them.
- `stacked` only makes sense for quantities that can be added up, and whether they can is for the author to judge.
- In a **pivot table**, rows are arranged in the order the query returns them (possibly sorted by some measure), and columns in the natural order of their values. Consecutive identical values of an outer dimension are written once, spanning the rows or columns they contain. With no column dimension there is only one group of columns; with no row dimension there is only one row. With subtotals, the rows are gathered by the values of the outer dimension (the groups are ordered by when their first row appears, and the order within a group follows the query), each group is followed by its subtotal row ("East China subtotal"), and groups of the inner levels come first; columns likewise get a subtotal column after each group. Last come the total row and the total column.
- **Totals** (table and pivot table) are computed by the database and written in the query's `totals` ([Query IR](query-ir.md) 3.8.1). The frontend does not add up the rows, so totals of averages and distinct counts are correct too. The "Show totals" switch in the editor: an aggregated table wants a grand total; a pivot table wants the total of each row (one column on the right), the total of each column (one row at the bottom) and the grand total where they meet; a total that would group by all the dimensions (that is, the table itself) is not wanted.
- **Subtotals** are another switch of the pivot table, "Show subtotals", which appears when "Show totals" is on and the rows or columns have two or more dimensions. Subtotals are also computed by the database: the first i row dimensions and the first j column dimensions are combined pairwise, each combination being one `totals` item (for example, when the rows are region > city and the columns are month, `["region", "month"]` and `["region"]` are added), so that the subtotal rows have values under every column (including the subtotal columns and the total column). They are written after the three items written when there are no subtotals, so the `totals` of existing charts do not change. The count is (number of row dimensions+1)×(number of column dimensions+1)−1 items. When it exceeds the query's limit of 16 items (for example 4 row dimensions and 3 column dimensions), no subtotals are written, the switch is unavailable and the reason is explained. When a chart is opened, if `totals` is exactly the form with subtotals, the switch is restored to on. They are not merged into "Show totals", for two reasons: subtotals turn the query from at most 3 runs into at most 15, which costs noticeably when the data source is slow; and subtotal rows sit in the middle of the data, and often only the totals at the bottom and on the right are wanted. Totals cover all the data and are not affected by the row limit. When a table has retrieved only some of the groups ("Most rows shown" is set, or the default row limit truncated it), the total row reads "Total (all data)", so that it is not mistaken for the total of the rows shown; totaling only the displayed rows would require restricting the database to the retrieved groups, see [Deferred items](../backlog.md). When the chart has a condition that filters on results, totals are not shown, and the bottom of the table explains the reason. A detail table has no totals.
- In a **Sankey chart**, each link is the flow between a pair of values on two adjacent levels. With only two levels, each row of the query is one link; with three or more levels, the flow between two adjacent levels is taken from the query's `totals` (the editor writes one item for each pair of adjacent levels, for example `[["channel","status"],["status","region"]]`), computed by the database, so every link is correct for distinct counts and averages too; only when no totals are available (for example when there is a condition that filters on results) are the rows added up. The height of a node is the sum of the links on its larger side, inflow or outflow, so the flow is best additive (sum, count): with a distinct count every link is correct, but the node height is the links added together, which can be larger than the actual distinct count of that value. Values with the same name on different levels are different nodes. The first level keeps the first 7 values and merges the rest into "Other" (8 in all, the same as the palette), colored in the order the values appear; the later levels keep the first 11 and use a neutral color; a link takes the color of its starting point, semi-transparent. Links with zero or negative flow are not drawn.
- **Comparison on a KPI card**: `compare` pairs one measure with another, for example `{ "revenue": "target" }`. The measure compared against no longer gets a card of its own and cannot be compared with another measure. Below the card, the percentage change (relative to the absolute value of the compared-against value) or the difference is written, preceded by ▲ or ▼, so the direction is not conveyed by color alone.

### 2.2 Validation on save

1. `query` is compiled once against the dataset under the query IR rules, and any compile error rejects the save.
2. The columns `viz` references must be output columns of the query, with the correct role: `x` and `series` are dimensions, `y` is a measure.
3. The required and mutually exclusive items of each type match the table above. `lines` and `rightAxis` can list only measures in `y`, each once; each dimension column of a pivot table appears exactly once in `rows` or `columns`; each dimension column of a Sankey chart is exactly one level, and with more than two levels the query's `totals` must have every pair of adjacent levels; both sides of `compare` are measures in `y`, and a measure cannot be compared with itself, and comparisons cannot be chained.
4. Every entry of `formats` points to a numeric or date output column of the query, the format's properties match the column's type, and the format itself is valid, see 2.6.
5. Every entry of `style` applies to this kind of chart and has a valid value, see 2.8.
6. `hiddenColumns` applies only to tables, references aliases of query output columns, has no duplicates, and must leave at least one column shown; this condition must also hold when all dynamic dimensions that may be emptied are emptied.
7. `columnGroups` applies only to tables. Everything it references is an output column of the query, and each column appears at most once; each group has at least one item and a non-empty name of at most 50 characters, and groups nest at most three levels; the columns each group covers are adjacent among the query's output columns, hidden columns counted. See 2.7.

### 2.3 Filters

The time range and the other conditions on a chart are the same thing: a filter. A time range is just a filter on a date field and is no longer modeled separately.

```jsonc
"filters": [
  // Fixed condition: no control, so viewers can neither see nor change it
  { "id": "f_paid", "field": "status", "op": "in", "value": ["paid"] },

  // Shown as a chart filter: has a control
  { "id": "f_date", "field": "order_date", "op": "time",
    "value": { "last": { "n": 30, "unit": "day" }, "includeCurrent": true },
    "label": "Order date", "control": { "type": "relative" } },

  // Independent of whether a global filter is bound; control only decides whether a control is shown
  { "id": "f_uid", "field": "uid", "op": "in", "value": [],
    "label": "UID", "control": { "type": "search_select" } },

  // The same measure can filter detail rows, or explicitly name an aggregation and filter the result
  { "id": "f_total", "field": "amount", "aggregation": "sum", "op": "gte",
    "value": 1000, "label": "Amount total", "control": { "type": "number" } }
]
```

| Property | Meaning |
|---|---|
| `id` | Unique within the chart, used when submitting local chart filter values |
| `field` | A dimension, measure or metric field of the dataset; without `aggregation`, dimensions and measures filter detail rows and metrics filter aggregate results |
| `aggregation` | Optional, the aggregation for filtering on the result of a numeric measure: `sum`, `avg`, `min`, `max`, `count`, `count_distinct`, defaulting to sum in the editor; dataset metrics already define their aggregation and cannot be aggregated again |
| `op` | The condition, see the table below |
| `value` | The value. With a `control` it is the initial value, and empty means no restriction; a fixed condition needs a valid condition value, except for operators that take no value |
| `control` | The control viewers use to change the value. Omitting it makes the filter a fixed condition |
| `label` | The name shown on the control, required when there is a `control` |
| `dependsOn` | Optional, an array of parent filter IDs within the current chart; restricts the candidate options, see 2.5 |

A filter can also point to a dataset parameter, written with `param` instead of `field`; the rules differ, see 2.11.

`control` decides whether a filter is fixed or shown as a chart filter. The `exposed` field in old data is read for compatibility only and no longer controls whether a global filter is possible. A measure without `aggregation` filters the raw rows; once it is set, it filters the computed result of each group. This has nothing to do with whether the field has been put into the chart's measure bar. Result filtering is implemented through `filterMeasures`/`HAVING` and adds no display column; a detail table does not allow result filtering.

The chart editing page shows interactive filters above the preview chart. The controls match those on a dashboard, wrap automatically when there is not enough space and give up chart height. A trial selection affects only the preview; it does not change the default value or create an unsaved state, and the default value is still changed through the filter settings. The preview follows the "Run automatically" switch; when it is off, click "Run" to apply. Fixed conditions still take part in fetching data but show no control. Changing a filter definition or switching the dataset clears temporary values that are no longer valid.

The chart's save button is enabled only when the draft has changes and the settings are valid, and is disabled again after a successful save; changes that keep happening during a save still count as unsaved. While a query runs, the query button switches to a "Cancel" button of the same width, which cancels the request and keeps the last result; a new query, switching the dataset or leaving the editing page also cancels requests that are no longer needed, and a late response does not overwrite the current result. The right side of the query action bar shows the time taken (ms) and the row count of the result currently displayed.

**Conditions and controls are separate.** `op` decides what the condition means, `control.type` decides how viewers fill in the value, and which controls can be used depends on the field type and `op`:

| Field type | `op` | Available controls |
|---|---|---|
| Text, integer, boolean | `in`, `not_in` | `select` (drop-down), `search_select` (type to search on the server), `tiles` (tiled; shown as a drop-down when there are more than 30 values or the result is truncated); `multi` controls single or multiple selection |
| Text | `eq`, `ne`, `contains`, `not_contains`, `starts_with`, `ends_with`, `like`, `not_like` | `text` (type a condition; no options are queried) |
| Number | `between`, `not_between` | `number_range`, supporting open and closed intervals and a single bound |
| Number | `eq`, `ne`, `gt`, `gte`, `lt`, `lte` | `number` |
| Date, time | `time` | `date` (a single day), `date_range` (fixed range), `relative` (a compact entry; the panel lets you choose relative, fixed, advanced or special values) |

The structure of a `time` value is in [Query IR 3.6](query-ir.md#36-time-range): `last`, `current`, `start`/`end`, `bounds` and `special` are mutually exclusive. The start and end of an advanced range can each be fixed, relative or unbounded; the special values are all, null dates and non-null dates. Chart/global controls use `{}` for all, and `{ "bounds": {} }` also means an unbounded range; `{ "special": "is_null" }` and `{ "special": "not_null" }` filter for null and non-null values respectively. `includeNull`, `grain` and `weekStart` modify the interval (include null dates, edit by year-month-day/year-month/year-week, and this filter's week calculation logic); a value with only modifiers also means all, and the editor uses it to remember the granularity. Time zone, week start day and left-closed right-open intervals follow the query IR, and existing date controls and saved time values stay compatible.

Rules:

- Filters are combined with "AND".
- A chart can have several date filters, each acting on a different date field.
- **The system does not create filters for the author.** A dataset has no concept of a "default time field"; local chart filters are added by the author, and a global filter specifies the field of each chart independently.
- Filters are not written into `query`. When data is fetched, the server compiles them into conditions appended to the query, so `query` describes "what to ask" and `filters` describes "within what range to ask".
- A numeric range is compatible with `[min, max]`, and can also be written as `{ "min": 0, "max": 100, "includeMin": false, "includeMax": true }`; when the open/closed form is not specified, both ends are included. When one end is empty it becomes the corresponding one-sided comparison, and when both ends are empty it means no limit; `not_between` takes the outside of the interval, with the bounds inverted. The conversion of an open end happens at the chart condition layer; the range condition of the original query IR still needs both end values. Open or closed belongs to the condition itself: when it is shown as a control and the default value is empty, a value that holds only the open/closed form, such as `{ "includeMin": false }`, is still saved, and the bounds a viewer enters follow it.
- Fixed conditions can also use `is_null` and `not_null`, and text can use `is_empty` and `not_empty`. The latter two target the empty string and cannot replace a NULL check. A date's empty/non-empty switch can be exposed as a control through `time.special`.
- `contains`, prefix and suffix matching treat the value as a literal; in `like` and `not_like`, `%` stands for any length and `_` for a single character, and a backslash escapes the wildcards. All values are still executed through bound parameters.
- Drop-down options are obtained through "chart + filter", so viewers do not need dataset permissions; `search_select` hands the typed text to the server to look up by "contains", returning at most 500 at a time.
- Aggregate metrics use controls by result type: numeric comparison/range, date/relative time, text comparison, boolean single/multiple choice. Boolean candidates are fixed as true/false, and other aggregate results do not enumerate values. The condition goes into `HAVING`, and a metric that the chart has not selected adds no result column.

### 2.4 Dynamic dimensions and dynamic metrics

A dynamic field offers author-specified candidates at one fixed output position, and what a viewer selects is a candidate ID. It changes the grouping field or the metric being computed; it does not filter rows by a field value.

```jsonc
"dynamics": [
  {
    "id": "group", "kind": "dimension", "label": "Analysis dimension", "alias": "category",
    "allowEmpty": true,
    "options": [
      { "id": "region", "field": "region", "label": "Region" },
      { "id": "month", "field": "order_date", "grain": "month", "label": "Order month" }
    ]
  },
  {
    "id": "metric", "kind": "measure", "label": "Analysis metric", "alias": "value",
    "options": [
      { "id": "revenue", "field": "revenue" },
      { "id": "average", "field": "amount", "agg": "avg", "label": "Average amount" }
    ]
  }
]
```

- Each entry requires `id`, `kind` (`dimension` or `measure`), `label`, `alias` and `options`. `alias` corresponds to the stable output name in `query.dimensions` or `query.measures`; `viz` keeps referencing that alias. The editor keeps the first candidate in the base query.
- A candidate requires `id` and `field`, and may have `label`. When saving, the editor writes a name for every candidate (the field name when not customized, with the aggregation or granularity appended), because dashboard viewers cannot read the dataset to name candidates. A dimension candidate may only be a dataset dimension, and a date can be given a `grain`; a metric candidate references a metric, or references a row-level field and names the aggregation with `agg` (required for measures and dimensions; the editor defaults measures to sum). A metric candidate cannot set `grain`, and a dataset metric cannot be aggregated again.
- A chart has at most 16 dynamic positions, each with 1–64 candidates; position IDs, aliases and the candidate IDs within each position must be unique. All candidates are validated on save, so that the default does not work while a switch fails. Detail mode does not support dynamic fields.
- The data request uses `selections: { "group": "month", "metric": "average" }`; a position that is omitted uses its first candidate. Only a dimension with `allowEmpty: true` accepts an empty string, meaning no grouping by that dimension; a metric cannot be left empty. An unknown position, an unknown option or a disallowed empty value is an error right away.
- Dynamic selections are resolved first, and then the chart and global conditions are layered on. When all dimensions are empty, the visual falls back to a table; a heatmap missing its row or column dimension also falls back to a table, and so does a Sankey chart left with fewer than two levels. A removed dimension is also dropped from the query's `totals`, see [Query IR](query-ir.md) 3.8.1; when only the current horizontal axis is removed, the first remaining dimension is used, and a removed series, or a series that coincides with the horizontal axis, is cleaned up.
- Selections in the editing preview and in dashboards are temporary state and do not change the saved query or the default candidate. When a global filter is bound to a specific `field`, it always filters that field; when it is bound to the alias of a dynamic metric `measure`, it follows the aggregation semantics of the current candidate, and all candidates must be compatible with the global control and the target result type.

### 2.5 Cascading filters

Chart filters and global filters both express dependencies with `dependsOn: [parent filter ID]`; each forms its own graph, and a local chart ID cannot reference a global filter or the other way around. Only an exact `in` selection at the detail level can take part in cascading, and both parent and child must use `select`, `search_select` or `tiles`. `not_in`, fuzzy text matching, dates, aggregate results and fixed conditions cannot be cascade nodes. On save, a missing parent, a duplicate dependency, a self-reference and a cycle are rejected.

After a parent is selected in the forward direction, the temporary values of its descendants are cleared and the candidates are read again according to all ancestors; a value that is not provided uses the saved default, and an explicit empty value means the restriction is lifted. When reading the candidates of a control, its own value is excluded, so that after a selection the control does not show only the selected items. Chart candidates keep the query's own constraints and the fixed conditions, and are not narrowed by unrelated interactive filters.

In this project, reverse cascading first clears the old ancestor values and the related sibling branches, and then uses the newly selected child to query the matching ancestors, so that an old parent does not block switching to another branch. `related: true` on the candidate endpoint allows a reverse lookup using conditions within the same connected component; the frontend is responsible for explicitly submitting the values that need to be cleared. Automatic back-fill uses only complete candidates with `truncated: false`: a single-select parent is back-filled only on a unique match, and a multi-select parent can be back-filled with the complete matching set; when there is no match or the result is truncated, nothing is guessed. Reverse back-fill is SupaBI's interaction rule, not an assertion about details DataWind has not made public.

Global cascading further requires that the widget `optionsFrom` points to for each node has field mappings for the other nodes in the same connected component. Several charts and different datasets can be mapped explicitly, but one candidate request queries only the dataset of the selected source widget, with no cross-dataset joins or union of candidates. Global candidates keep the fixed conditions that have not been taken over and the ancestors' global values. A widget's own candidates keep the fixed local conditions and the local ancestors; in global mode they also apply all the global conditions currently acting on that widget, and after switching back to chart mode these global conditions are ignored.

### 2.6 Display formats

The display formats of numbers and dates come from the dataset field by default ([Dataset model](dataset.md) 5.5). A chart can override them per column:

```jsonc
"viz": {
  "type": "bar", "x": "month", "y": ["revenue", "orders"],
  "formats": {
    "revenue": { "unit": "wan", "decimals": 1, "suffix": "元" }
  }
}
```

- The key is the alias of a query output column and the value is a complete format, with the same structure as the `format` of a dataset field. A column without an override follows the dataset; when the dataset has no format either, a number is shown as is with "None", and a date is written in the default form.
- To not use the dataset's format on the chart and show the value as is, write `{ "style": "none" }`. In the UI, "Follow the dataset" sits alongside "None", "Number" and "Percentage" as options of the same choice.
- A date has no "None"; to not use the dataset's format on the chart and write the date in the default form, write `{}`. In the UI, "Follow the dataset" sits alongside "Dashes", "Slashes" and "Chinese"; after the writing style is chosen, you then choose where the time is written (only timestamps have this) and how it is written when by week.
- An override replaces the format as a whole and is not merged by property. With a property-by-property merge, "no thousands separator" and "follow the dataset" could not be told apart; the result of a whole replacement is clear at a glance. When the editor changes from "Follow the dataset" to "Number" or "Percentage", it starts from the dataset's format.
- It can only be set on number and date columns, and the properties must match the column's type. A dynamic position is overridden by the position's alias and the override applies the same way when switching to another candidate; it has no effect when switching to a candidate of a different type, and `time` has no effect when switching to a `date` candidate.
- The format does not enter the query, does not affect data fetching and does not appear in the query result; the frontend applies it on top of the result columns.

### 2.7 Sorting, row count and column display

Sorting and the row count are written directly in the `sort` and `limit` of `query` ([Query IR](query-ir.md) 3.8), and the chart spec has no separate fields for them:

```jsonc
"query": {
  "dimensions": [{ "field": "city" }],
  "measures": [{ "field": "revenue", "agg": "sum" }],
  "sort": [{ "by": "revenue", "desc": true }],
  "limit": 10
}
```

- `sort[].by` is the alias of an output column and, like `viz` and `formats`, does not reference dataset fields. There can be several keys, and earlier ones take priority. Without `sort`, rows are sorted ascending by the dimensions in turn, and a detail table is not sorted.
- In the field menus of dimensions, measures and detail columns, the editor sets ascending, descending or removes sorting. A newly sorted column goes after the existing keys; a column whose direction alone is changed keeps its previous rank. A sorted column shows its direction after the name, and with several keys it also shows its rank. Dynamic positions cannot yet have sorting set in the editor.
- When a column is removed from the chart, the sort on it is deleted too, and adding the column back does not restore the sort.
- `limit` is an integer from 1 up to the row limit of a response (default 10000, changed in "System administration → General", [Startup configuration](configuration.md) 10.7), set in the "General" group of the editor's settings panel. The settings panel is arranged in groups under "Chart type", each group can be collapsed, a group title is a title bar with a background color, and the collapse icon is on the right. Groups that belong only to some charts (such as stacking under "Style") come first, and a group with nothing to set is not shown at all; "General" exists for every chart and is changed rarely, so it comes last. The collapsed state is remembered per group in the browser and is not stored in the chart. When `limit` is not written, the default number of returned rows is used (default 1000, also changed in the General settings); the result is then truncated, and the editor says so. When `limit` is written, returning fewer rows than actually exist is the result the author wants, and there is no longer a prompt; only when `limit` is greater than the cap does the chart return up to the cap, the input box says it is out of range, and the truncation prompt is still shown as usual.
- Dashboards and the preview use the sorting and row count in `query` directly. The candidate endpoint drops them when fetching values, so candidates come from all rows and are not affected by Top N (see 3.6).
- The editor cannot set `offset`. A chart that contains `offset` is read-only in the editor.

The detail columns of a table and the dimensions and measures of an aggregated table can be set to "Hide in table" in the field menu and shown again through the same menu. A hidden field stays in the editor, marked "Hidden"; dynamic dimensions and metrics are supported too. The setting is written in `viz.hiddenColumns`, for example `{ "type": "table", "hiddenColumns": ["customer_id", "revenue"] }`.

- It controls only how the current chart is presented and does not change `query`; hidden columns still take part in the query, grouping, sorting, measure calculations and totals. Hiding a dimension does not re-aggregate, so several rows with the same displayed name may appear. The API result and the query result at the bottom of the editor still contain all columns; hiding is not a data permission.
- The preview and dashboards use the same display rules; the header, cells and totals of a hidden column are hidden together, and "Freeze the first column" freezes the first visible column instead.
- The setting follows the output column's stable alias, so it is not lost when the display name is renamed, the aggregation is changed or the dynamic candidate changes; when an output column is removed its hidden setting is cleared, and when it is added again it is shown by default. When a dynamic dimension is temporarily emptied, it is dropped from this presentation only and the saved default settings are not changed.
- At least one column must stay visible. A dynamic dimension that may be emptied cannot be the only visible column; if removing other columns makes this condition fail, the editor prompts to restore the display and blocks saving.
- It takes effect only for detail tables and aggregated tables. When switching to another type, `hiddenColumns` is not written; when switching back to a table in the same editing session, the output columns that still exist keep their previous settings.

**Column groups** (`viz.columnGroups`) are like adding a few rows above the header in Excel, merging several adjacent cells and writing a name in them. They work for both detail tables and aggregated tables; the column headers of a pivot table are generated from data, so it does not have this.

```jsonc
"viz": {
  "type": "table",
  "columnGroups": [
    { "label": "Region", "columns": ["region", "province", "city"] },
    { "label": "Performance", "columns": [{ "label": "Amount", "columns": ["revenue", "profit"] }, "orders"] }
  ]
}
```

- **Structure**: groups form a tree. Each item in `columns` is the alias of an output column or a smaller group, written in the order the columns have in the table. Groups can only nest and cannot cross: a group covers several adjacent columns, with at most three levels of nesting and at most four header rows. A group can cover just one column, which amounts to adding a title above that column alone. A column that is not in any group has its header stretched all the way to the top.
- **Drawing**: the number of header rows is the depth of the deepest group plus one. A group name has at most 50 characters, the same as axis titles and page names, is centered above the columns it covers, is shown on a single line, and its width equals the sum of the columns below. Column names are written in the bottom row; where there is no group above, the header extends upward, with the text at the bottom. When scrolling down, all the header rows stay at the top, the same as in a pivot table; for this the header row height is fixed and does not change with the page's row height. Column width can only be adjusted by dragging the column name in the bottom row.
- **Editing**: groups are edited only on the chart editor's canvas; in dashboards and the preview they can only be viewed.
  - Click a header to select it, and hold Shift and click another to select everything between the two. A range can be selected only within the same level and the same parent group; clicking elsewhere starts again from that item. Click blank space or press Escape to clear the selection; an Escape that closes a dialog or a menu does not count. When a column is hidden or shown, the selection is also cleared, so that a column that cannot be seen is never selected. Dragging the right edge of a header to resize the column does not select it.
  - There is a toolbar above the table; when nothing is selected it says how to select, so the table does not move when a selection is made or cleared. When columns or several items are selected, there is "Group": the new group is called "Group" and goes straight into editing the name. When one group is selected there are "Rename" and "Ungroup", and double-clicking the group name also renames it. If the name is cleared and confirmed, the original name is kept.
  - "Ungroup" dissolves only this level; the columns and smaller groups inside stay in place and move up to the parent level.
  - Hidden columns that sit between the selected columns are also put into the new group, so that they are still in the group when shown again.
  - When merging would produce more than three levels, "Group" is unavailable and the reason is explained.
- **When columns change**:
  - When a column is taken off the chart, it leaves its group; a group that becomes empty is removed.
  - A newly added column goes at the end and is in no group. In an aggregated table, a newly added dimension goes between the dimensions and the measures: if a group spans the dimensions and the measures there, the new dimension joins the innermost group spanning that point, which keeps the columns of every group adjacent. A new field dragged to a position in the middle of the bar (2.1) is handled the same way.
  - When the order of columns is adjusted by dragging (2.1), the dragged column first leaves its original group: if it lands between the columns of a group, it joins the innermost level of that group; if it lands outside a group or at the edge of one, it is in no group. Otherwise, dragging one column of a group far away would make the group cover all the columns in between.
  - A group covers only the columns that are shown; when all the columns under a group are hidden, the group is not shown either. A dynamic dimension that may be emptied is handled the same way when it is temporarily emptied, and editing groups at that moment does not remove it from its group.
  - Groups follow the alias of the output column, and renaming the display name, changing the aggregation or changing the dynamic candidate does not affect them.
  - When switching to another chart type, the groups stay in the draft but are not saved; when switching back to a table in the same editing session, the columns that are still there keep their previous groups.
- **With other settings**:
  - "Freeze the first column" still freezes only the first visible column. When the first column is in a group, the group's cell scrolls away horizontally with the table; freezing a whole group would need a "Freeze the first few columns" option, see deferred items.
  - "Merge equal values" (2.8), total rows and click-triggered chart links are not affected.
  - Export, "View data" (3.8) and the "Data" panel at the bottom still have only one row of column names, without groups.

**Paging** (`style.paging`, `style.pageSize`) is chosen in "Table style" and works for both aggregated tables and detail tables; a pivot table has groups and subtotals, and the rules for a group split across two pages would have to be set separately, so it does not have this.

- **Only the rows already retrieved are paged**: the query retrieves as many rows as "Most rows shown" says, as usual (default 1000, cap 10000, both changed in the General settings), and turning pages only changes which rows are shown and no longer queries the database. Turning pages is therefore fast, only one page is drawn at a time, and a table of several thousand rows does not lag. Browsing data beyond the cap requires paging in the database, see [Deferred items](../backlog.md).
- **Three modes**:
  - **Show all**: `paging` is not written, which is how it always was, and existing charts do not change.
  - **Pages** (`paging: "pages"`): the rows per page are written in `pageSize`, an integer from 1 to 1000, 20 when not written; the number of pages is the number of retrieved rows divided by it, rounded up.
  - **Automatic** (`paging: "auto"`): the rows per page are computed from the height the table can use: subtract the header, the total row and the pager, divide by the height of one row, with a minimum of 1 row. It is recomputed when the card is resized, enlarged or shown full screen. To make the computation accurate, the row height of the table body is fixed, like the header, and does not change with the page's row height.
  - `pageSize` can be written only when `paging` is `pages`; otherwise the server rejects the save. When the editor switches modes, it keeps the value in the draft, and it is still there when switched back.
- **The pager** is below the table, on the right: "Previous page", "3 / 12", "Next page", with "Rows 41–60 of 1000" beside it; when the result is truncated by the row limit, the total number of rows is not known, so it reads "Rows 41–60; more rows matched than the limit, only the first 1000 are shown" instead, the same as the truncation prompt in the editor, so that it is not mistaken for all the data. It is also shown when there is only one page, so the table's height does not jump when the pager appears or disappears. Viewers cannot change the rows per page. After turning a page the table scrolls back to the top.
- **When it returns to page 1**: when a filter, a chart link or a dynamic selection changes, or the query is changed in the editor, it returns to page 1. A timed refresh or a manual refresh of the same query stays on the current page; if the number of rows drops and the current page is beyond the total number of pages, it falls back to the last page. When the rows per page of automatic paging change (the card is resized or shown full screen), it shows the page that contains the rows being viewed, not the same page number.
- **The current page is not saved**, and a share link does not carry it either. The enlarged view (3.8) is a separate table that starts at page 1, and after it is closed the card is still on its original page.
- **With other settings**:
  - The total row is computed over all the data and is shown on every page.
  - "Merge equal values" (2.8) merges only within the current page; when a group is split across two pages, the value is written again at the start of the next page; striped rows also start over on each page.
  - With paging, "Most rows shown" is the most rows retrieved, and the editor explains this beside it.
  - Freezing the first column, column widths, column groups and click-triggered chart links work as usual; export and "View data" (3.8) still use all rows.

### 2.8 Style

A chart's appearance is written in `viz.style`. It only affects how the chart is drawn: it does not affect data retrieval or change what is drawn. All of it is optional, and without it the default style applies:

```jsonc
"viz": {
  "type": "bar", "x": "month", "y": ["revenue", "orders"], "stacked": true,
  "style": {
    "legend": "bottom",
    "labels": "value",
    "palette": "warm",
    "colors": { "orders": "aqua" },
    "percent": true,
    "barWidth": 40,
    "xAxis": { "title": "Month", "rotate": 45 },
    "yAxis": { "min": 0, "hideGrid": true }
  }
}
```

| Property | Values | Applies to | Default |
|---|---|---|---|
| `legend` | `top`, `bottom`, `left`, `right`, `none` | bar, horizontal bar, line, area, combo, scatter, pie, funnel, treemap | At the top when there is more than one series; a funnel chart writes its level names beside the funnel and has no legend by default |
| `labels` | `value`, `percent`, `none`; `percent` is only for pie, funnel, treemap and Sankey | The types above plus heatmap and Sankey | Pie and funnel charts show the share (for a funnel, the share of the first level); a Sankey chart writes only node names (the share is the share of the total flowing out of the first level); the rest show no labels; in a scatter chart, `value` writes the name beside the point |
| `palette` | `fresh`, `warm` | bar, horizontal bar, line, area, combo, scatter, pie, treemap, Sankey | Default order |
| `colors` | Measure column → hue name (`blue`, `orange`, `aqua`, `yellow`, `magenta`, `green`, `violet`, `red`) | bar, horizontal bar, line, area, combo; not available with `series` | In the color scheme's order |
| `smooth`, `points` | Boolean | line, area, combo | No |
| `percent` | Boolean, only when stacked | bar, horizontal bar, area | No |
| `solid` | Boolean | Pie | No (donut) |
| `barWidth` | Integer from 4 to 80, the widest a bar can be in pixels | bar, horizontal bar, combo | 28 |
| `xAxis`, `yAxis`, `y2Axis` | See below | Types with axes | |
| `gauge` | `{ "min", "max" }` | Gauge; `max` cannot be written when there is a target value | 0 to the value rounded up at its first digit (such as 6,868,017 → 7,000,000) |
| `nodeAlign` | `left`, `right`: paths that end before the last level stop on the left or the right | Sankey | Extend to the last level |
| `striped` | Boolean, background color on alternate rows | Table, pivot table | No |
| `density` | `compact`, `comfortable` | Table, pivot table | Standard row height |
| `freeze` | Boolean, the first column stays put during horizontal scrolling | Table, pivot table | No |
| `merge` | Boolean, consecutive equal values in a dimension column are merged into one cell | Table | No |
| `paging` | `pages`, `auto`, see 2.7 | Table | Show all |
| `pageSize` | Integer from 1 to 1000, only when `paging` is `pages` | Table | 20 |
| `widths` | Output column → integer pixels from 40 to 800 | Table, pivot table | By content |
| `columnAlign` | Output column → `left`, `center`, `right` | Table, pivot table | Numbers right, the rest left |
| `highlights` | Numeric column → 1 to 5 rules, see "Conditional format" below | Table, pivot table | No shading |
| `textAlign` | `left`, `center` | KPI card | Left |
| `size` | `small`, `large` | KPI card | Medium |
| `compareAs` | `percent`, `diff`, `both`; only with `compare` | KPI card | Percent |
| `redUp` | Boolean, rises in red and falls in green; only with `compare` | KPI card | Rises in green, falls in red |

- **The server checks where each property applies.** A property that does not apply to this kind of chart is rejected at save instead of being left unused: what the spec says is what takes effect. When the chart type is switched, the editor keeps the properties that do not apply in the draft, and they are still there when the type is switched back, but the saved spec contains only the properties that apply.
- **Axes are named by their position on the screen**, because the value axis of a horizontal bar chart is horizontal and its category axis is vertical, and naming them by role would force a conversion. A value axis can set `title`, `min`, `max` (`min` less than `max`), `hideGrid` and `hideLabels`; a category axis can set `title`, `rotate` (45 or 90) and `hideLabels`. Which axis is the value axis: the `yAxis` of bar, line, area and combo charts (a combo chart also has `y2Axis`, writable only with `rightAxis`), the `xAxis` of horizontal bar charts, and both axes of scatter charts; in a heatmap both are category axes. When a scatter chart's axis has no title, the measure's name is used as the title, otherwise it is hard to tell which axis is which measure.
- **Colors can only be chosen from the color palette.** The color schemes are different orders of the same 8 hues, and every order has been verified: adjacent colors can be told apart both under a simulated red-green color blindness and under normal vision, and the first 3 colors can be told apart pairwise. `colors` stores the hue name, not a color value, and light and dark modes each use their own shade. Once a measure is given a color, the other measures take the remaining colors in the color scheme's order, so none clashes with it. A series split by dimension values cannot be given a color individually: the values change, and a color should follow the entity, not the position.
- **Stack to 100%** draws every category as 100%, the value axis shows percentages, and the tooltip shows both the share and the original value.
- **Data labels** are written at the top of a bar or on a point of a line; when stacked, inside the bar. Labels do not avoid each other and overlap when there are many categories. This is a trade-off the author makes by turning them on.
- When a gauge has a second measure, it is the target value, the scale ends at it, and below the gauge is written "Target X · Y% reached"; without a target value, the measure name is written below.
- **Column width** is set in the editor by dragging the right edge of a header and is written to `widths`; "Table style" can restore automatic column widths. In a pivot table, the headers of the row dimensions and the measures can be dragged (with only one measure the measure has no header and cannot be dragged). They cannot be dragged on a dashboard or in the preview. After a column is taken off the chart, its width and alignment stay in the draft but are not written to the spec, and they are restored when the column is added back.
- **Alignment** is set in the field menu (dimensions, measures and detail columns in tables and pivot tables all have it). Choosing the current alignment again restores the default.
- **Merge equal values** (`merge`) is turned on in "Table style" and works for both aggregate tables and detail tables; the row dimensions of a pivot table already write consecutive equal values only once, so it has no such option.
  - Only dimension columns are merged. Measure columns are not: if two rows happen to have the same sales amount, they should not become one cell.
  - Only adjacent rows are merged, and rows are not reordered for merging, so the effect depends on sorting: when sorted by sales amount, the rows of one region are scattered and almost nothing can be merged. The text below the switch says this and suggests sorting by the column to merge first.
  - A column is merged only within the range where all the dimension columns to its left are the same, as with the row dimensions of a pivot table: when two adjacent rows have the same province but different regions, the province is not merged. The last dimension usually differs on every row, so it naturally does not merge. In a detail table, a measure column in between does not affect this range.
  - Only displayed columns count: hidden dimension columns (2.7) are not merged and do not limit the columns to their right.
  - Sameness is judged on the raw value, as in a pivot table: a null equals a null, and a null differs from an empty string.
  - The value is written at the top of the merged cell, as in a pivot table; when a cell is taller than the visible area of the table, scrolling down hides the value. With merging on, dimension columns do not get striped rows, otherwise one cell would span rows of different shades; measure columns still alternate row colors. Alignment, column widths and the frozen first column work as usual.
  - Total rows do not take part in merging. With chart links, clicking a merged cell selects that value.
  - Exports, "View data" (3.8) and the "Data" panel at the bottom are still row-by-row results, and every row has its value.
- **Conditional format** (`highlights`) gives a cell a background color based on its value, and can also put a small icon before the number, to mark the numbers that need attention, such as a completion rate below 80% in red and one reaching 100% in green.

  ```jsonc
  "style": {
    "highlights": {
      "completion": [
        { "op": "lt", "value": 0.8, "color": "red", "icon": "down" },
        { "op": "lt", "value": 1, "color": "yellow" },
        { "op": "gte", "value": 1, "color": "green", "icon": "up" }
      ]
    }
  }
  ```

  - **Which columns**: numeric columns. In a table these are the measures of an aggregate table and the numeric columns of a detail table; in a pivot table they are the measures. Dimension columns, text and dates do not have this option.
  - **Rules**: 1 to 5 per column, read from top to bottom; the first one that is met is used and the later ones are not read. That is why the three levels above are written as "below 0.8", "below 1" and "not below 1". A condition compares with a fixed number, and `op` is written as in the query's filters: `lt`, `lte`, `gt`, `gte`, `eq`, `ne`. For even more rules a color scale would fit better, see [Deferred items](../backlog.md).
  - **It compares the raw value**, not the displayed number: a ratio displayed as "80%" is written 0.8, and a number displayed as "120万" is written 1200000. Next to the input box the editor writes what the column's format shows the value as ("= 80%"), so that the unit is not written wrong. A null satisfies no rule and is not shaded.
  - **Color** is chosen from the 8 hues of the color palette and stored as a hue name, like `colors`. It is drawn as a light background: the hue is blended with the cell's original background, and the text stays the body text color, so text on a light color such as yellow is still legible; after blending, the contrast between text and background is at least 4.5:1. Light and dark modes each use their own shade, and when a custom background is set on a dashboard, the hue is blended with that background. The background is opaque, so it also covers the content scrolling past when the first column is frozen. Only the background is shaded and the text color is not changed, see the deferred items.
  - **Icon** is optional: `up` ▲, `down` ▼, `dot` ●, written before the number. People with red-green color blindness cannot tell a red background from a green one, so when red and green mark good and bad, an icon should be added; the editor says so below the rules.
  - **Cells that are not shaded**: the total row of a table and the subtotals and totals of a pivot table are not shaded. They differ in magnitude from ordinary cells, and a sales threshold set for cities means nothing for the subtotal of a region.
  - **With other settings**: shaded cells do not get striped rows; a value selected by a chart link is still bold; hidden columns are not displayed and their rules are kept; merging equal values only merges dimension columns and is unrelated to this.
  - **When columns change**: rules follow the output column's alias, like column widths and alignment: after a column is taken off the chart its rules stay in the draft but are not written to the spec, and they are restored when it is added back. Changing the aggregation or the "Measure calculation" (share, year over year and period over period, running total) clears this column's rules, with the same timing and reason as clearing format overrides: the old thresholds no longer match the new numbers. A dynamic position is set by its position alias and does not take effect when switched to a candidate that is not numeric; as with display format, the editor cannot yet set it for a dynamic position, only the API can.
  - **Editing**: the field menu of a numeric column in a table or pivot table has "Conditional format", above "Display format", which opens a dialog with one rule per row: condition, value, color, icon. Each row can be moved up or deleted, and "Add rule" is at the bottom, unavailable at 5 rules. A new rule takes, in the order red, yellow, green, blue, violet, the first color not yet used. A field block with rules carries a "Shaded" tag, beside the "Format" tag for a changed format.
  - **Server checks**: only for tables and pivot tables; a key must be a numeric column returned by the query, and for a pivot table also one of its measures; 1 to 5 rules per column; `op`, `color` and `icon` can only take the values above, and `value` must be a number.
  - Exports, "View data" (3.8) and the "Data" panel at the bottom carry no colors, and exports still write raw values.
- The editor's canvas and the dashboard draw tables with the same component, so the style is WYSIWYG; the "Data" panel at the bottom is still the paged raw result.

### 2.9 Data export

`allowExport` decides whether the data of this chart can be exported on a dashboard, and defaults to `false`. It is set with the "Allow data exports" switch in the "General" group of the settings panel and applies to every role: when it is off, developers and administrators also have no export entry on the dashboard, so the person building the dashboard sees what a viewer sees.

- When it is on, anyone who can open the dashboard can export the data from the chart's "…" action bar, with the full result under the current filters, dynamic selections, chart links and drill-down (2.10), and row-level and column-level permissions still in force. An export runs against the saved dashboard, so while there are unsaved changes in edit mode or the in-page preview the button is grayed out, and the data can be exported only after saving; the widget properties panel shows whether the chart allows export.
- An export keeps `query.limit`. When "Most rows shown" is set, the export also contains only those rows, and the editor says so next to the switch; when it is not set, the default display limit of 1000 rows does not apply.
- An export writes the rows of the query result as raw values, without applying `formats`; a table's `hiddenColumns` are not exported, a pivot table is exported as flat rows, and totals and subtotals are not exported in the first version.

For execution, file formats, permission rechecks and the export center, see section 2 of [Exports](exports.md).

### 2.10 Drill-down

Status: implemented.

Drill-down lets a viewer look further down along a hierarchy the author has set up: on a bar chart grouped by region, click "East China", choose "Drill down to Province", and the chart changes to the provinces of East China; click "Jiangsu" and it changes to the cities of Jiangsu. It replaces one grouping dimension of this chart and looks only at the value clicked; it does not filter other charts. To filter other charts, use chart links (3.4). It follows Quick BI's [drilling](https://help.aliyun.com/zh/quick-bi/user-guide/drilling-filter-interaction-and-hyperlink): the levels are configured on the chart's dimension, and when drill-down coexists with chart links, the viewer chooses.

```jsonc
"drill": {
  "alias": "region",          // output name of a dimension in the query; it is the first level
  "levels": [
    { "field": "province", "label": "Province" },
    { "field": "city", "label": "City" }
  ]
}
```

A date goes to finer grains along the same field:

```jsonc
"drill": {
  "alias": "order_date",      // order time grouped by year
  "levels": [
    { "field": "order_date", "grain": "quarter", "label": "Order time (quarter)" },
    { "field": "order_date", "grain": "month", "label": "Order time (month)" },
    { "field": "order_date", "grain": "day", "label": "Order time (day)" }
  ]
}
```

**The levels are recorded in the chart, not in the dataset.** The dataset has no levels, so a change to the dataset does not silently break the drill-down of downstream charts, and nothing new has to be added to the dataset first. When many charts repeatedly configure the same levels, defining them in the dataset can be considered, as a preset filled into the chart in the editor, see [Deferred items](../backlog.md).

**Spec**

- `alias` is required and is the output name of a dimension in `query.dimensions`; that dimension's field and grain are the first level. `levels` are the levels below it, 1 to 7 items in order, 8 levels at most counting the first. Each level requires `field` and optionally `grain`, which only date fields can set. On save, the editor writes a `label` for each level (the field name, with the grain appended for a date), because dashboard viewers cannot read the dataset, as with dynamic candidates (2.4).
- A chart has only one `drill`, that is, only one dimension can be drilled down.
- Applicable charts: bar, horizontal bar, line, area, combo and pie charts, where `alias` must be `x`, and a chart with `series` drills down the category axis only and the series stays the same; for an aggregate table it can be any dimension column, which must not be in `hiddenColumns`. Detail tables and other types cannot be drilled down.
- `alias` cannot be the alias of a dynamic position (2.4): a dynamic dimension itself switches fields, and when the two are stacked it is unclear which candidate the next level follows.
- Each level can only be a dimension of the dataset, not a measure or a metric. The fields and grains of the levels (the first included) must not repeat, and must not equal another dimension in the query, otherwise two identical columns appear after drilling down.
- For two consecutive levels of the same date field, every period of the next level must fall completely within one period of the previous level: grains go finer in the order year, quarter, month, day, hour, minute, and intermediate ones can be skipped; a week spans months and years, so a week can be followed only by day, hour or minute, and cannot follow year, quarter or month. There is no such restriction between different fields, and "Region → Category" is also fine: click East China and look at East China by category.
- On save, the query with each level substituted is compiled once per level, as with dynamic candidates, to avoid the first level being viewable but an error appearing only after clicking down.

**How an author configures it**

- A dimension that can be drilled down has "Drill-down" in its field menu: the category-axis dimension of a chart, the dimension of a pie chart, and each dimension column of an aggregate table. For a chart with a series, the series dimension does not have this item. When another dimension already has drill-down configured, this item is unavailable and says that a chart can drill down only one dimension.
- Clicking "Drill-down" opens a dialog with the same name. The first row is the dimension itself and cannot be changed; below it, each level has a row: choose a field, for a date also a grain, and each row can be moved up or deleted, with "Add the next level" at the bottom. The first time a date dimension is opened, the grains finer than it are filled in (for a year grouping: quarter, month, day), and they can be deleted. Deleting all lower levels and confirming means no more drill-down.
- As in the dimension bar, the date grains are year, quarter, month, week and day; when the same field follows the previous level, a grain that is coarser than the previous level or would span periods cannot be chosen, a newly added level defaults to the next finer grain, and another date field defaults to month. The server also accepts hour and minute, but the editor does not offer them. When the levels do not satisfy the rules, the dialog states the reason and "OK" is unavailable.
- A field block with drill-down configured carries a "Drill" tag, beside "Format" and "Shaded".
- When the dimension is removed from the chart, its drill-down settings are removed with it. When the chart type is changed to one that cannot be drilled down, or the dimension is no longer the category axis, the drill-down settings stay in the draft but are not written to the spec, and they are restored when the type is changed back, as with conditional format (2.8). When a change to the grain of the first level means the rule of going finer is no longer satisfied, the field block marks the problem and the chart cannot be saved.
- The dataset's impact analysis also counts the fields referenced by the drill-down levels ([Dataset model](dataset.md) 8).

**How a viewer uses it**

- Click a value in the drill-down column: a bar (in a chart with a series, one segment of it), a slice, or a cell of this column in an aggregate table; line, area and combo charts draw no data points by default, and a click anywhere in the plot area above a category counts as a click on that category. A click first opens a menu at the click position, and nothing runs until an item is chosen; pressing Escape or clicking elsewhere closes the menu and does nothing.
- Items in the menu:
  - "Drill down to Province", where Province is the name of the next level. There is no such item when already at the last level.
  - "Link charts", only when this column is a chart link source (3.4). When the value clicked is exactly the one already linked, this item is "Unlink charts".
  - When there is no item at all, no menu opens and the mouse pointer does not turn into a hand.
- After a drill-down, a line of breadcrumbs appears below the chart filters and above the chart: on the left a layer icon and "Drilled down:", followed by the name of the first level and then the values clicked in turn, such as "Drilled down: Region › East China › Jiangsu". Clicking one of them returns to that level; the last one is the value where you are now and cannot be clicked. Without chart filters, the breadcrumbs sit right under the title bar; a chart whose title bar is hidden (3.14) also shows them. The breadcrumbs take one line and the chart becomes correspondingly shorter; at the first level they are not shown and take no height.
- The value clicked becomes a condition by the rules of chart links (3.4): the raw value is taken, not the text after the display format; NULL becomes `IS NULL` and the breadcrumb writes "Missing", and an empty string is written "Empty text"; a date is turned into a half-open time interval by the grain of its level, using the time zone of the chart's query. Other values on the breadcrumbs are displayed as on the chart. The "Other" merged by a pie chart and the total row of a table cannot be clicked.
- When drilling down, the aliases of the output columns do not change; only the field, grain and column name change, so `viz`, sorting, the row limit, totals, `within` of a share, `along` of a running total, header groups and column widths all keep working by alias as usual. The column's display format takes the format of this level's field; a format override set on this column in the chart applies only when the types are the same.
- A drill-down condition limits the scope like other filters: with period-over-period comparison, the date condition is shifted together with it, as with chart links (3.4); a running total starts from the start of this scope.
- Column-level permissions are checked only for the levels this query uses, that is, the current level and the levels above it. When a click goes down to a field the viewer cannot see, the chart shows "No permission" ([Access control and workspaces](access-control.md) 5.2), the breadcrumbs stay, and the viewer can go back.

**With other interactions**

- Drill-down changes only this chart and does not filter other charts.
- Drill-down conditions are appended with "AND" after global filter takeover, local filters and chart links, keeping the query's own conditions, the dataset limits and row-level policies. When a global filter, chart filter, chart link or dynamic selection changes, the drill-down position is kept, an empty result is shown as empty, and the viewer returns from the breadcrumbs; timed refresh and "Refresh data" keep it too. The query container's "Reset filters" clears drill-down together, going back to the first level, as it clears chart link clicks.
- **With chart links**: chart links map the target by the field of the first level, so the drill-down column can link only at the first level; after drilling down to the next level the column has a different field, and only drill-down remains in the menu. Other columns in a table are unaffected as chart link sources and can still choose "Link charts" after drilling down.
- Both drilling down and going back clear the chart link clicks this chart sent, as when its dynamic selection changes (3.4): drill-down changes the conditions it receives and its grouping, so the value originally clicked may no longer be on the chart.
- The candidates of a chart's own filters and of global filters are not affected by drill-down.
- Enlarging (3.8) shares the drill-down position with the card: drilling down while enlarged leaves the card at the same level once closed. "View data" shows the result of the current level.
- Export (2.9) carries the current drill-down path, and exports the data of the level in front of you.
- A share link (3.10) carries the drill-down position: when it carries the current conditions, the charts stop at the level they were at when shared once the link is opened.
- The drill-down position is temporary state: it is not saved and does not enter the undo history; each chart widget, and each tab in a tab container, has its own.
- Drill-down can also be clicked through in the chart editor's preview, with the same rules as on a dashboard, and the menu contains only drill-down; after the chart configuration is changed, it goes back to the first level. Without drill-down, the preview still builds the query in the frontend and hands it to `/query`; after drill-down, the data comes from the draft data endpoint (see "What is submitted" below), and the server builds the query with the same code as the dashboard. This way the translation rules of drill-down exist in only one copy, on the server: `/query` accepts only a finished query, so using it would require writing another copy in the frontend, and two copies sooner or later disagree.

**What is submitted**

Data and export requests gain a `drill` item, the values clicked in turn from the first level, at most as many as the number of items in `levels`:

```jsonc
{ "drill": ["East China", "Jiangsu"] }   // see the cities of Jiangsu
```

Omitted or an empty list means the first level. The server generates the conditions and replaces the dimensions from the saved levels, and viewers can still submit only values (3.5). When the chart has no drill-down, the path is longer than the levels, a value is not a scalar or null, or a date is not text that can be read as a date, it returns 400 `invalid_drill`. The order of processing: first resolve the dynamic selections, then replace the dimensions by the drill-down, then add the chart filters, global filters, chart links and drill-down conditions.

For an unsaved chart in the chart editor, after drilling down the new draft data endpoint `POST /charts/preview/data` is used. The request is the same as the saved chart's `POST /charts/{id}/data` (`filters`, `selections`, `drill`, `diagnostics`, `refresh`), plus a required chart draft `spec`, as with the draft candidates endpoint (3.6). The server validates the draft, builds the query and runs it by the same rules as for a saved chart, and writes nothing to the database; like the other draft endpoints it requires the developer role (section 5). A chart that is saved and opened read-only in the editor still uses `POST /charts/{id}/data`.

**Implementation order**

The original plan was that each step could be tried on the page once done, and committed before the next one; in practice the three steps were implemented and tested together and committed together:

1. Drill-down settings: the spec's `drill` on the server, save validation and impact analysis; the "Drill-down" dialog in the chart editor's field menu and the "Drill" tag on the field block. They can be configured and saved, and are still there after reopening.
2. Drilling down in the chart editor's preview: chart data accepts `drill`, a new draft data endpoint, a menu on click, and breadcrumbs.
3. Dashboard: dashboard data, draft preview and export accept `drill`; a click opens a menu, and chart links also open the menu first (3.4); breadcrumbs; the drill-down position is shared with enlarging and cleared on reset; the sample content (`make dev-seed-content`) gets a few charts that can be drilled down.

**Not in the first version**, see [Deferred items](../backlog.md): defining levels in the dataset; continuing chart links on the next level after drilling down, or filtering other charts at the same time; drilling down to detail; drill-down of scatter, treemap, funnel, heatmap and Sankey charts, and expanding and collapsing of pivot tables; temporarily choosing a dimension to look further down after clicking a value.

### 2.11 Dataset parameters

Status: discussed, to be implemented.

The parameters in dataset SQL ([Dataset model](dataset.md) 4) used to take only the dataset's default values. A chart can put filters that target parameters in `filters`: the author sets a different value for the parameter in the chart, or lets the viewer change it.

Use a parameter only when a filter cannot do the job, see "When to use parameters" in [Dataset model](dataset.md) 4. For a condition that only narrows the range, it is enough to output that column and use a field filter: the condition is added outside the dataset SQL, the database pushes it down into the SQL, and the viewer also gets candidates, date ranges, global filters, chart links and drill-down.

```jsonc
"filters": [
  // Dropdown: the viewer picks from options the author wrote
  { "id": "p_region", "param": "regions", "label": "Region",
    "control": { "type": "select" },
    "options": ["East China", "South China", "North China"],
    "value": ["East China", "South China"] },           // when omitted, follows the dataset's default

  // Input: the viewer fills it in
  { "id": "p_dt", "param": "biz_date", "label": "Business date",
    "control": { "type": "input" } },      // the default follows the dataset, such as today-1d

  // Fixed: no control, so the viewer does not see it
  { "id": "p_top", "param": "top_n", "value": 20 }
]
```

**Spec**

- `param` is the name of a parameter declared by the dataset, and is an alternative to `field`. A parameter filter has no `op`, `aggregation` or `dependsOn`, and no other filter can `dependsOn` it: a parameter is just a value or a set of values, and `=` or `IN` is written in the SQL.
- `control.type` is `input` or `select`. Omitting `control` means a fixed value, which the viewer can neither see nor change, and then `value` must be written. With a `control`, `label` is required, and the editor fills in the parameter's display name by default.
- `input`: the control is decided by the parameter type. Text is an input box, integers and decimals are number boxes, a date picks a day, a timestamp picks a date and time; a multi-value parameter can take several values, one per line or separated by commas, as with "Manual input" of a field filter. A boolean parameter has no `input`.
- `select`: `options` are the options the author writes, shown in the order written, at most 500, with no duplicates; a multi-value parameter is a multi-select dropdown. The options of a boolean parameter are fixed as "Yes" and "No", and `options` is not written.
- `value` is the default. When omitted it follows the default of the dataset parameter, and if the dataset changes its default, the chart follows; it is written in only when the author changed it in the chart. The `value` of a `select` must be in `options`.
- The options a viewer sees are `options` plus the current default, so the default is always among the options. When the default is not in `options` it is placed first; this happens only when the chart follows the dataset and the dataset later changed its default.
- The options and default of a date parameter can be relative dates, written as the dataset's defaults are (`{ "relative": "today-1d" }`), and the control shows them as "Yesterday (10-21)": `today` is today, `today-1d` is yesterday, `today+1d` is tomorrow, and the others are written "3 days ago" and "In 3 days". They are computed in the query time zone ([Query IR](query-ir.md) 3.9).
- A chart has at most one parameter filter per parameter. A parameter already written in `query.params` cannot also have a parameter filter: `query.params` is a value that always holds, with the same standing as `query.filter`, and can be written only through the API, so viewers cannot change it.
- Options and defaults are validated by the parameter type: the `value` of a multi-value parameter is a list, and that of a single-value parameter is a single value.

**Empty values**

- Some parameters **cannot do without a value**: those checked as required in the dataset, and those whose placeholder in the SQL is written outside `[[ ]]`. The other parameters can go without a value, and then the whole `[[ ]]` segment they sit in is removed, that is, there is no restriction.
- As with field filters, empty means no restriction, not a return to the default: when a viewer clears the input box or deselects everything, the parameter is passed no value. In the query, a single-value parameter explicitly passed `null` and a multi-value parameter passed `[]` both mean this ([Query IR](query-ir.md) 3.10).
- A parameter that cannot do without a value has a control that cannot be cleared: an empty input box is not submitted and prompts that it must be filled in; a multi-select keeps at least one item. The default cannot be empty either: when it follows the dataset and the dataset has no default either, the author must write one in the chart, otherwise it cannot be saved.
- A parameter that can go without a value can also have an empty default: the author deselects every default choice, and the parameter means no restriction when opened. Then `value` is written as `null` or `[]`; only omitting `value` means following the dataset.

**How an author configures it**

- When the dataset has parameters, the field list on the left of the chart editor gets an extra "Parameters" group at the bottom, listing each parameter's display name and type. A parameter can only be dragged to the filter bar, or clicked and then the "Parameter settings" dialog opens; a parameter already on the filter bar is marked "On the filters" and cannot be added again.
- The "Parameter settings" dialog:
  - Display name.
  - "Show as chart filter": unchecked, it is a fixed value, and only one value is filled in (a set of values for a multi-value parameter); once checked, choose "Typed in" or "Dropdown".
  - Dropdown: a list of options, one item per line, which can be added, removed and moved up. The first time it is opened, the list holds the dataset's default (for a multi-value parameter, each item of the default). The radio button before each item (a checkbox for a multi-value parameter) marks the default.
  - Default: it starts with "Default follows the dataset: Yesterday (10-21)". Once the author changes the default, it no longer follows, and "Use the dataset's default" appears here.
  - Values are filled in by the parameter type, as with filling in a parameter's default in "Data exploration": a date can be written as a relative date such as `today` or `today-1d`, and next to the option it shows which day that is now, such as "Yesterday (10-21)"; the default and fixed values of a multi-value parameter are separated by commas.
- A parameter filter is ordered before field filters on the filter bar, and is also before them when written to the spec: parameters decide which data is read. The field block has a "Parameter" tag, which shows the current default. The controls above the preview can be tried like those of field filters, and do not change the default.
- When a parameter in the dataset is deleted, or its type or multi-value setting changes, this parameter filter is marked with a problem on the filter bar, and can be saved only after it is deleted or fixed.

**How a viewer uses it**

- The controls are on the same row as the field filters: the same in the chart editor's preview, a dashboard card and enlarging (3.8).
- The dropdown shows the option's value itself, with no separate display name, see [Deferred items](../backlog.md).

**What is submitted**

- Values are submitted by filter ID, as with field filters: chart data puts them in `filters`, and dashboard data puts them in `chartFilters` (3.5). For example `{ "p_region": ["East China"], "p_dt": "2026-10-20" }`. Omitted ones use the chart's default; `null` or `[]` means no value is passed.
- Server checks: the type of the value; every value of a `select` must be among the options the viewer sees; `input` accepts only concrete values, not relative dates, except a default passed back unchanged. A value that fails returns 400 `invalid_param_value`; an empty value submitted for a parameter that cannot do without a value returns 400 `missing_param`. A fixed parameter filter accepts no submission, as with fixed conditions.
- The server writes the values into the query's `params`, overriding the dataset's defaults.
- Viewers cannot read the dataset, so the chart read endpoint (`GET /charts/{id}`, and the `charts` returned by a dashboard) also carries `params`: by filter ID, for each displayed parameter filter, its type, whether it is multi-value, whether it can be cleared (`needsValue`), the current default and the dropdown options, computed from the dataset's current revision. The chart editor has the dataset and computes them itself by the same rules.

**With other features**

- For the candidates of field filters, and the candidates global filters take from this chart (3.2), dataset parameters all use this chart's current values: after switching to a snapshot of another day, the candidates change too.
- Period-over-period comparison shifts only the filter conditions on time fields, not parameters ([Query IR](query-ir.md) 3.5). When a parameter is a business date, the current period and the comparison period read the same day's data.
- A global filter cannot be associated with a parameter, see [Deferred items](../backlog.md). Takeover by a global filter and "Use chart filters" involve only field filters, and parameter filters always take effect. Chart links and drill-down do not change parameters.
- A share link (3.10) carries the parameter values, under the "chart filters" category. When the link is opened, a dropdown value that is no longer among the options is dropped with a notice, as with other conditions that no longer hold.
- Export (2.9) exports with the current parameter values. Query diagnostics and the audit log still record the bound parameter values.
- The dataset's impact analysis ([Dataset model](dataset.md) 8) lists the charts that use this parameter, counting both parameter filters and `query.params`.

**Implementation order**

The three steps are implemented, tested and committed together:

1. Server: the spec's parameter filters and save validation; chart and dashboard data, candidates, export and sharing run by the values of parameter filters; in the query engine, `null` for a single-value parameter now means no value is passed; impact analysis lists the charts that use parameters.
2. Chart editor: the "Parameters" group in the field list, the "Parameter settings" dialog, and the controls on the filter bar and the preview.
3. Controls on dashboard cards, and sharing; guidance in the parameter area of "Data exploration" ([Dataset model](dataset.md) 4); sample content (`make dev-seed-content`) gets a dataset with parameters and a few charts that use parameter filters.

**Not in the first version**, see [Deferred items](../backlog.md): associating global filters with parameters; display names for dropdown options.

## 3. Dashboard spec

```jsonc
{
  "specVersion": 1,
  "layout": {
    "columns": 96,
    "items": [
      { "id": "w1", "type": "chart", "chartId": "ch_3f8k…", "x": 0, "y": 0, "w": 8, "h": 4 },
      { "id": "w2", "type": "chart", "chartId": "ch_9c2m…", "x": 8, "y": 0, "w": 4, "h": 4 }
    ]
  },
  "filters": [ /* global filters, see 3.2 */ ],
  "queryContainer": { "x": 0, "y": 0, "w": 12, "h": 2 }
}
```

### 3.1 Layout

- The default is a fine grid of 96 columns. `x` and `w` are in columns, `y` and `h` are in rows. The optional `layout.grid` stores the cell height, the horizontal and vertical gaps between cells, the minimum vertical space between containers and automatic compaction. Details are below.
- `items[].id` is unique within the dashboard. It is how a global filter refers to a widget.
- `type` is `chart`, `title`, `text` or `tabs`. Title and text widgets are in 3.12; dashboard-level tabs are in 3.13; the appearance of a widget as a container and the empty chart container are in 3.14; the tab container (`tabs`), which holds several charts in one container and switches between them with tabs, is in 3.15.
- A widget references a chart by its ID and does not embed the chart definition.

The Workbench editor keeps the island with the dashboard directory tree on the far left. The editing area on the right is divided into a top action bar, a narrow toolbar, a central canvas and a collapsible properties panel on the right. The top bar shows the name with a rename icon, undo/redo, page settings, preview and save; the save status appears only at the bottom of the Workbench. The name is read-only by default: click the edit icon to type, press Enter or leave the field to commit, and press Escape to cancel. The toolbar offers the chart library, title, text, global filters and chart links. The chart library reuses the ResourceTree of the chart editor page. It supports expanding the directory levels, search, dragging onto the canvas and adding by click, and it offers no move or delete operation for source charts.

The canvas scrolls on its own. Clicking a chart only selects the widget and does not open the properties panel automatically. When the panel is already open and shows page settings or query container settings, clicking a widget switches to that widget's properties, and clicking the query container switches to the query container settings (when the panel shows page settings or widget properties). While the chart library is open, clicking a widget only selects it and does not switch, so that you can keep putting charts into the selected empty container. After opening the panel through the configure button in the chart actions, you can change the grid width and height, see the linked filters, go to the source chart or remove the widget. Clicking a blank area only deselects the widget; page settings are opened only by the button at the top. Page settings contain the name, the description and the canvas layout. The dashboard contents show how many charts, titles and texts there are, and the last item is the revision history (4.1). The layout is shown as a segmented control with only "Grid layout" for now, and the grid configuration is below it. The name, description and grid configuration are staged first. The full-width "Apply" button at the bottom of the panel is enabled only when there are unapplied changes. Clicking it updates the canvas in one step and enters the undo history, and only "Save" at the top right writes to the server; unapplied input is not saved. When a grid setting differs from its default, a per-item reset icon appears, and a reset must also be applied. On apply, an empty value reverts to the original value and an out-of-range value is clamped to the allowed range. Undo and redo are supported, switching panels keeps the pending input, and leaving the page warns about unapplied changes. Selecting a widget or switching panels does not write to the dashboard spec. Every entry point for removing a widget asks for a second confirmation and, once confirmed, also cleans up the linked filters. The source chart is not deleted, and undo restores the widget and its links together.

The chart actions are collapsed behind "…" at the top right of the chart. Clicking it expands the icon action bar to the left; click it again, click outside or press Escape to collapse it. In edit mode the bar contains refresh, widget configuration and remove, plus a filter source switch when global links exist. In view mode and the in-page preview it contains refresh and, when global links exist, the filter source switch. Icons come with tooltips, and the bar is not in the keyboard focus order while collapsed.

Chart filter controls wrap automatically according to the card width. The chart content is drawn in the height that actually remains after the title and the filter area, and it adjusts to the card size, the number of filter rows and panels opening and closing. When the card is too short, it scrolls vertically inside, keeping a minimum space for the chart so that the filters and the chart do not overlap.

The toolbar on the left opens a three-column dialog for global filters and collapses the properties panel on the right. The left column adds, selects, renames or deletes filters. In the middle column, the upper part selects the linked charts and the lower part selects the mapped field of each chart. The right column configures exact filtering, conditional filtering or manual input, the default value, the control style and the cascading relationship. Confirming submits the whole group of changes at once; canceling leaves the draft unchanged. All global controls go into the "Query container", which has no title bar. It is moved by dragging a blank area and resized in width from the right edge (with manual height, also from the bottom-right corner), and it shares the grid with charts. Its position and size are saved as the optional `queryContainer` and do not take part in chart data queries or field mapping. The "…" at the top right offers reset filters, settings and remove. "Settings" opens the query container settings panel on the right, which shows "Container settings", "Chart control style" and "Query settings" in order, configuring the container height, the control style and how queries are triggered. The style reuses the chart's horizontal/vertical and compact/normal/comfortable options, is saved in the dashboard's `filterStyle` and applies to the preview and view mode. Confirming removal clears all global filters and the container layout and style, and one undo restores them. When an old dashboard does not have this field, the container appears above the charts with 96 columns and 8 fine rows, and the actual position is saved after the first layout or a configuration change. The editing canvas and the in-page preview do not repeat the dashboard name and description, and do not show the top count bar or the bottom operation hint bar; the name stays in the top action bar. The canvas shows the global filter controls and the charts directly (including the charts' own filter controls), and applies unsaved filter configuration in real time through the draft read-only data and options endpoints. Chart filters taken over by a global condition are grayed out; you can switch back to the chart condition and restore the global condition. Switching between edit and preview keeps temporary values, the takeover state, the draft, the panels and the undo history, and creates or updates no dashboard. Trying a selection does not change the default and does not enter the edit history. Deleting or changing a filter definition clears the corresponding stale values, and changing a field mapping reloads the options.

The name, description, layout and global filters are recorded as one whole draft with up to 100 undo/redo steps. Consecutive text input is merged, and removing a widget together with cleaning up its filter links is one step. Ctrl/⌘+Z, Ctrl/⌘+Shift+Z and Ctrl+Y are supported; input fields and dialogs keep their own undo behavior. Automatic grid compaction adds no history. Save is available only when there are changes and the name is not empty. After a successful save, the current draft becomes the saved baseline without clearing the history. Editing is locked while saving, and a failed save keeps the changes.

### 3.2 Global filters

A global filter sets its field, operator, control and default value on its own, then explicitly links to several charts. The candidates are the union of all dimensions, measures (filtering on the sum), and metrics of the chart's dataset, and the measures already configured in the chart. The chart does not need to have a local filter configured first:

```jsonc
"filters": [
  {
    "id": "g_user",
    "label": "User ID",
    "op": "in",
    "control": { "type": "search_select" },
    "targets": [
      { "item": "w1", "field": "uid" },       // uid in chart A's dataset
      { "item": "w2", "field": "user_id" }    // user_id in chart B's dataset
    ],
    "optionsFrom": "w1",
    "default": []
  }
]
```

- `targets` binds, per dashboard widget, either `field` (a dataset field) or `measure` (the output name of a chart query measure), one of the two. `field` can carry `aggregation` to state the aggregation explicitly, for example `{ "item": "w1", "field": "amount", "aggregation": "sum" }`; `measure` and `aggregation` cannot both be given. A widget can be linked to several fields, and the mapped conditions are combined with "and".
- Dataset dimensions and measures without aggregation go into `WHERE`; dataset metrics, fields with `aggregation` and chart measures go into `HAVING`, grouped by each chart's own dimensions. Detail tables do not support aggregate targets.
- A dataset metric referenced by a chart is deduplicated against that dataset metric; a raw measure and its aggregated metric are different candidates. The field types and the detail/aggregate layers of all targets must be compatible: text and integers, or detail and aggregate, cannot be mixed in one filter.
- Several global filters can bind the same semantic field, and their conditions are combined with "and", for example when the lower and upper limits are set separately. Together these global conditions replace the local condition. Different datasets need explicit mapping; fields cannot be linked just because they have the same name.
- When taken over, the **complete global condition** replaces the local condition on the same field, including the operator and the value. The chart's local control keeps its original form and value, is grayed out and says that the current condition is overridden. An empty value means the restriction on that field is lifted, and the takeover remains.
- Local filters that do not conflict stay in effect; a fixed condition in `ChartSpec.filters` is also replaced when a binding on the same field applies. A query constraint that must always hold stays in `query.filter`/`query.having` or in the dataset definition.
- Each linked widget can switch to "Use chart filters": all global conditions that act on the widget are ignored, and the chart's own conditions and the user's own values come back. It can also "Restore global filters". This is a widget state while viewing and does not change the saved chart.
- The dropdown options come from the widget named by `optionsFrom`, which is the first target by default. They are not a union, because that would need one query per dataset.
- `dependsOn` references the ID of a global filter in the same dashboard and uses the cascade validation and candidate rules of 2.5.
- When a global filter is created, widgets with the same dataset and the same semantic field can be preselected, and the author can deselect them. This is only a prefill and has no effect until saved.
- On save, the bindings to static chart measures are normalized: a dataset metric becomes `field`, and an aggregated measure or dimension becomes `field + aggregation`; a dynamic metric keeps its `measure` alias. So removing the display column of a static measure does not affect filtering on its result; where needed, it becomes a measure that takes part only in `HAVING`. Deleting a dynamic position that is still bound, changing it to an incompatible candidate or switching to an incompatible dataset is rejected on save, and the dependent dashboard is named. Deleting a local chart filter control does not affect global bindings.

A global time is an ordinary global filter on a date field. It can use a single-date, date-range or relative-time control; the date fields of the linked charts can differ, and the forms of the local date controls can differ too.

### 3.3 How filter conditions combine

- Conflicts are judged by semantic identity: a raw field, a dataset metric and a specific aggregate of a field are each identified separately. `SUM(amount)` and `AVG(amount)` are different identities, and so is the raw `amount`. A global condition replaces a chart condition of the same identity; the remaining conditions are combined with "and".
- Detail conditions and aggregate conditions are merged separately. They are appended to the chart's own `query.filter` and `query.having` conditions, so an "or" in the query does not swallow the appended conditions.
- The dataset's own SQL, parameters and filter restrictions are always kept.

### 3.4 Chart links on click

The "Chart links" tool on the left of the dashboard editor configures explicit sources and targets. The definition is saved as the optional `links`, so old dashboards need no migration:

```jsonc
"links": [{
  "id": "region_link",
  "label": "Region link",
  "source": { "item": "w1", "column": "region" },
  "targets": [{ "item": "w2", "field": "area" }]
}]
```

- The source is a dashboard widget ID plus a query output column name (alias first); the target is another widget ID plus a dataset field key. Each link can be linked to several target widgets, but each target widget can map only one field. Mapping across datasets must be explicit; fields with the same name are not linked automatically, and the same chart in different widgets is configured separately.
- In the first version, sources support the categories of bar charts, horizontal bar charts and pie charts, plus the dimension columns of aggregate tables and the field columns of detail tables. A dynamic dimension, an aggregate metric, a pivot table, a total row and the "Other" slice merged in a pie chart cannot be a source.
- A target must be a type-compatible field on the detail layer; it cannot be an aggregate metric, a dynamic position or the source widget itself. A date and a timestamp can be linked, but hour, minute and ungrouped timestamps cannot be mapped to DATE, to avoid losing time precision.
- Clicking a value on the source first pops up a menu at the click, and the link takes effect only when "Link charts" is chosen. The menu is shared with drill-down (2.10); press Escape or click elsewhere to close the menu and do nothing. Earlier, a single click linked the charts. Once drill-down exists, the same click may be a drill-down or a link, so it now always pops up the menu first, even when linking is the only option. Table cells work the same way.
- A click takes the raw value, not the text after display formatting. Each link is single-select; when the clicked value is already linked, that menu item reads "Unlink charts". The top of the dashboard lists the current conditions, which can be canceled one by one; the values in the conditions are shown as they are written on the source chart, and so are the link conditions listed in the share dialog. NULL and the empty string are valid choices and are shown as "Missing" and "Empty text". Bars and slices highlight the selected category, and in a table the selected field value is bold.
- `links` in the request is a map from link ID to scalar value. An ID that is absent means no restriction, and an explicit `null` means `IS NULL`. The field, operator and granularity all come from the saved configuration; a viewer cannot submit an arbitrary filter condition.
- Links are appended with AND after the global takeover and the local filters have been resolved, keeping the query's own conditions, the dataset restrictions and the row-level policy. "Use chart filters" only leaves the global takeover and does not cancel links. Multiple links also intersect; when there is no result, an empty result is shown as normal and the conditions are not relaxed.
- A date category is converted to a half-open time interval `[start, end)`. Month, week and so on use the granularity of the source query and the workspace's week start day. DATE stays a calendar date and is not affected by daylight saving time. A timestamp is interpreted in the source query's time zone and then converted to the target query's time zone. An ungrouped DATE is matched by day, and an ungrouped timestamp is matched at the second precision shown in the current result.
- A period-over-period comparison query reuses the `time` condition and shifts both the date link and the original current-period range, while links on other fields stay unchanged. An empty date is intersected with the finite current-period range that the comparison needs; the result is empty and the comparison range is not widened.
- Editing, preview and viewing use the same data-fetching rules. Choosing "Link charts" in the menu takes effect immediately; even if the global query is set to manual, only the global conditions that have already been submitted are used. Switching between edit and preview keeps the clicked values; a click does not enter the undo history and is not saved as a default condition. When the effective values of the filters acting on the source, the dynamic selections, the drill-down position (2.10), the linked charts or the mapping change, the corresponding temporary clicks are cleared, and resetting the filters clears all clicks. When a source click changes or is canceled, the earlier clicks on the downstream charts are cleared, to avoid continuing to use an expired category; changing the local filters of an ordinary target chart does not cancel the source click. Moving or resizing a widget does not clear clicks.
- The candidate endpoints for chart-local and global filters accept the same click context, and restrict the candidates by the links that act on the corresponding source widget; a link does not generate new click events by itself.
- Creating or changing a link requires `dataset.use`. With only content-edit permission, existing links can be kept and the layout arranged, and removing a widget also cleans up the related mappings. Removing the widget and cleaning up the mappings is one undo step. When a chart used by a link is changed, the dependencies are validated, and a change that deletes the source column, switches to an unsupported chart type or breaks the field type compatibility is rejected.

### 3.5 What a viewer can submit

Chart data fetching `POST /charts/{id}/data` accepts `filters` (a map from local chart filter ID to value) and `selections` (a map from dynamic position ID to candidate ID). Dashboard data fetching `POST /dashboards/{id}/items/{itemId}/data` accepts the following request, where `selections` belongs to the current widget's chart:

```jsonc
{
  "filters": { "g_region": ["East China"] },
  "chartFilters": { "f_total": 1000 },
  "selections": { "metric": "average" },
  "useChartFilters": false,
  "links": { "region_link": "East China" },
  "drill": ["East China"]
}
```

`drill` is the values clicked in turn along the drill-down path (2.10); chart data fetching accepts it too. When a filter ID does not appear in the request, a chart uses its `value` and a global filter uses its `default`; an explicit `null`, an empty selection and the like mean no restriction, not a return to the default. When a dynamic position is omitted, the first item is used, and an empty string is valid only for a dimension that is allowed to be empty. `useChartFilters` defaults to false; local conflicting values submitted during a takeover are ignored and take effect only after switching back to chart mode. The fields, operators, link scope and dynamic candidates come from the saved configuration; a request with an unknown filter or option, or one that changes a fixed condition, is rejected, and a viewer cannot submit an arbitrary query. The values of parameter filters (2.11) are also placed in `filters` and `chartFilters` by filter ID, and the value of a dropdown can only be one of the options in the dropdown.

`meta.overriddenFilters` in a dashboard widget result returns the array of local chart filter IDs that are actually taken over, computed from the field/aggregate identity after the dynamic selections are resolved; with `useChartFilters: true` it returns an empty array. The client uses it to gray out the corresponding controls, which correctly handles the change of conflicts after a dynamic metric switches from SUM to AVG. This result property is an optional extension; the plain `/query` and the result of a single chart need not provide it, which keeps old consumers compatible.

A dashboard author submits the same values plus the required dashboard draft `spec` through `POST /dashboards/preview/items/{itemId}/data`. The widgets in the draft still reference only saved charts. When a chart author drills down in the editor, they submit the chart data values plus the required chart draft `spec` through `POST /charts/preview/data` (2.10). A draft preview needs the developer role, as saving does, and neither fetching data nor fetching candidates writes to the database.

### 3.6 Candidate endpoints and compatibility

Interactive candidates use POST to pass the current context, and do not write temporary values back to the spec:

| Case | Path | Request |
|---|---|---|
| Saved chart | `/charts/{id}/filters/{filterId}/options` | `ChartOptionsRequest`: `filters`, `selections`, `search`, `related` |
| Chart editor draft | `/charts/preview/filters/{filterId}/options` | The fields above plus the required chart `spec`; the filter may not be saved yet but must exist in the draft |
| Saved dashboard, global filter | `/dashboards/{id}/filters/{filterId}/options` | `DashboardFilterOptionsRequest`: `filters`, `chartFilters`, `selections`, `useChartFilters`, `search`, `related` |
| Saved dashboard, widget's own filter | `/dashboards/{id}/items/{itemId}/filters/{filterId}/options` | Same as above; `filterId` is the ID inside the widget's chart |
| Dashboard draft, global filter | `/dashboards/preview/filters/{filterId}/options` | The dashboard options request plus the required dashboard `spec` |
| Dashboard draft, widget's own filter | `/dashboards/preview/items/{itemId}/filters/{filterId}/options` | Same as above |

All paths in the table use POST. `related` defaults to false and applies only ancestors; true allows reverse matching within the connected component. `search` does a literal contains lookup on text fields. The `selections` of a global dashboard filter's candidates belong to the chart that `optionsFrom` points to, while those of a widget's candidates belong to the current widget. `useChartFilters` controls whether a widget's own candidates restore the local conditions; it does not lift the cascade constraints of the global candidate definition itself.

It returns `{ "values": [...], "truncated": false }` with at most 500 distinct non-NULL values. For an aggregated boolean result, `[false, true]` is provided directly; other aggregated results are not enumerated. Candidates keep the dataset source, the parameters, the original query constraints and the applicable fixed filters, and reading options never relaxes permissions. Even if only some of the cascade values constrain the candidates, the filter IDs provided in the request and whether they may be modified are checked.

When there are conditions on aggregated results, the qualifying groups are first selected by the original chart's dimensions and date granularity, and then the candidate values are taken from them; the aggregate is not recomputed by the candidate field instead. A NULL group key still matches correctly. Search only narrows the outer candidates, and the original chart's sort, row limit and offset do not truncate the source of the candidates.

The GET `/options?search=...` for existing charts and global filters is kept; it resolves the dynamic/cascade context from the saved defaults, and POST is used when the current trial selections need to be reflected. The new request fields, result metadata and optional spec properties do not change how the old endpoints are called, and the old `last`/`current`/`start`/`end` time values and array numeric ranges are still accepted.

### 3.7 Viewing experience (planned)

Status: discussed. Items 1 to 4, the first step of item 5 and item 6 are implemented; the second step of item 5 is deferred. The items below are implemented and accepted one at a time, in this order:

1. Enlarge and view data (3.8), implemented
2. Full screen and timed refresh (3.9), including the longest acceptable age of the query cache ([Query IR](query-ir.md) 6.6), implemented
3. Share link (3.10), implemented
4. Title and text widgets (3.12), implemented
5. On-demand fetching and render modes (3.11), in two steps: first on-demand fetching in interactive mode (implemented), then full rendering and printing (deferred, see 3.11)
6. Tabs (3.13), implemented

Title and text widgets come before on-demand fetching: viewers can see them, and they do not depend on on-demand fetching. Tabs do not fetch data as long as pages that are not open are not rendered, so they do not really depend on on-demand fetching either; they come last because their structure has to be discussed first.

When viewing and editing a dashboard, the title of the browser tab is "Dashboard name - SupaBI", which helps tell multiple tabs and bookmarks apart and does not depend on whether a title is shown on the page. A dashboard with pages also includes the name of the current page (3.13). Other pages are still "SupaBI". When item 1 was implemented it was written as "SupaBI - Dashboard name"; when the tabs were designed it was changed to put the name first: when a browser tab is too narrow, the end is what gets cut off, and every tab starts with the same "SupaBI - ", so the part that tells them apart would be cut off first. Most products also put the product name last.

### 3.8 Enlarge and view data

These two items are in the chart's "…" action bar. They are available in view mode and the in-page preview, not on the editing canvas.

- **Enlarge**: shows the chart in a near-full-screen dialog, with the chart's own filters and dynamic dimension controls. It shares the same filter, dynamic selection, chart link and "Use chart filters" state with the original card: a condition changed while enlarged stays in effect on the dashboard after closing, and clicking to link on the enlarged chart acts on the other charts in the same way. On opening it uses the result already fetched and does not fetch again. Escape or the close button exits.
- **View data**: shows the rows of the chart's current query result in a table, that is, the data the chart has already fetched, without sending a new query. The column names are the same as the chart's column headings, and values are shown in the field's display format. When the result is truncated by "Most rows shown" or by the default number of returned rows, a note appears above the table. Pivot tables, Sankey charts and the like show flat rows, with totals and subtotals not included; columns hidden by the table (`hiddenColumns`) are not shown. These points are the same as for export (2.9).
- View data is not limited by `allowExport`, because it shows data the chart already presents; it offers no download, and downloading still goes through export (2.9).
- Viewing the underlying detail is not offered. The detail is far larger than the data the chart shows, and authorization needs separate thought.

### 3.9 Full screen and timed refresh

- **Full screen**: "Full screen" in the view-mode toolbar makes the dashboard cover the whole page, hiding the top bar and the directory on the left, and also enters browser full screen where the browser allows it. Escape or "Exit full screen" exits, and "Edit" is not shown in full screen. What enters browser full screen is the whole document, not the dashboard element, because dropdown menus and dialogs are attached at the end of the document, and putting only the dashboard element in full screen would leave them outside; so filters, chart links, chart menus, enlarge and view data work as usual in full screen. When the browser does not allow full screen (for example when embedded in another page), the dashboard still covers the whole page.
- **Refresh interval**: the author sets the default interval in "Timed refresh" in the page settings, saved as the optional `autoRefresh` (in seconds). It can only be 60, 300, 900, 1800 or 3600; any other value is rejected on save with `invalid_auto_refresh`. When omitted, there is no timed refresh. A viewer can temporarily change it to another interval or turn it off in the toolbar; this applies only to the current page and is not saved.
- It takes effect only in view mode; the editing canvas and the in-page preview do not refresh on a timer. The timer pauses while the page is not visible (switched to another browser tab, window minimized); on returning to the page, if the interval has already passed, it refreshes once immediately. While on, the toolbar shows the current interval. Browsers also throttle timers in background tabs, so a background tab may refresh later than the interval, and it catches up when switched back to the foreground.
- Each refresh covers the charts that have already fetched data (3.11) and uses the conditions that have been applied: in manual query mode, input for which "Query" has not yet been clicked does not take part. Filter candidates are not refreshed with it.
- **Relation to the cache**: the timed refresh request carries `maxAge` and does not use `refresh`. A cached result is used directly if the time its statement started executing is less than `maxAge` ago; otherwise the database is queried and the result is written back to the cache ([Query IR](query-ir.md) 6.6). `maxAge` is slightly shorter than the interval: the interval minus one tenth of it, at most 30 seconds less, so 54 seconds for a 1-minute interval and 3570 seconds for 1 hour. This way the result this page fetched last time is always counted as expired at the next refresh, and it is not mistaken for a fresh result and skipped for one round because of network and timer error; a result fetched by someone else in between is used directly. So each chart queries the database about once per interval, and the data everyone sees is never older than one interval; with the Redis cache, the same holds across instances. Using `default` directly would read a cache kept for up to 10 minutes, which makes a per-minute refresh meaningless; using `refresh` every time would make everyone with the page open query once each, so 50 people with a dashboard of 20 charts open and refreshing every minute would cause 1000 queries per minute.
- The manual "Refresh data" and "Refresh chart" are unchanged: they still use `refresh` and always query the database.
- When the data source is set to "Do not cache", every timed refresh queries the database, and identical queries running at the same time are still merged ([Query IR](query-ir.md) 6.7).

Feedback during refresh. A timed refresh happens once a minute and a query often takes only tens of milliseconds, so without feedback you cannot tell whether it is working; conversely, making the chart flash or showing a notice on every refresh is too noisy on a big screen. So:

- **The toolbar shows the data time**: the left of the view-mode toolbar shows "Data as of 14:32:05", which is the time the oldest data among all charts was fetched from the database (the result's `cachedAt`, present both for results that queried the database and for cache hits), not "the time of the last refresh": when a result fetched by someone else 20 seconds ago was reused, what is shown is 20 seconds ago. Data that is not from today carries the date. While a chart is fetching, it changes to "Loading data…" with a spinning icon; when a chart has failed, "N charts failed to refresh" is added after it. When timed refresh is on, hovering shows the time of the next refresh. There is no second-by-second countdown, because numbers jumping on a big screen are distracting.
- **Keep the old chart when fetching again**: the first time a chart loads it shows "Loading…"; after that, any fetch (refresh, timed refresh, a changed condition) keeps the chart already drawn, a thin progress bar appears at the top of the card, and the new result replaces it directly when it arrives. The progress bar appears only after waiting more than 300 milliseconds, so a refresh that returns in tens of milliseconds does not flash. When a condition has changed, the old chart fades until the new result arrives, so it is not taken for the result of the new condition; a refresh with the same conditions does not fade.
- **A failed refresh does not clear the chart**: when fetching again with the same conditions fails, the last chart is kept and a warning icon appears next to the title. Hovering shows "Refresh failed; the data shown is from 14:31:05. Click to try again." together with the database's error, and clicking retries (the retry is still a refresh). When fetching fails after the conditions were changed, the error and a retry button are shown and the old chart is not kept: the old chart answers the earlier conditions.
- No notice is shown on every refresh; once a minute is too noisy.

### 3.10 Share link

The view-mode toolbar gains a "Share" button; the dialog it opens shows the dashboard's link and a copy button.

- When the current conditions differ from the defaults, the dialog has an extra checkbox, "Include the current conditions", unticked by default; when the conditions equal the defaults, it is not shown. Not including them by default has two reasons: a link with conditions has a validity period, after which the recipient sees the default conditions, whereas a link without conditions is just the dashboard's address and stays valid forever, and a link copied casually should not quietly stop working a month later; also, the recipient can see the filter values (see below).
- The current conditions include: the values of the global filters, the values of each chart's own filters, link clicks, the selections of dynamic dimensions and dynamic metrics, the "Use chart filters" switch of each chart, the drill-down position of each chart (2.10), the tab each tab container is currently on (3.15), and the page a dashboard with pages is currently on (3.13). In manual query mode, only the conditions that have been applied are included. The drill-down position is recorded per chart widget, and the charts in each tab of a tab container are recorded separately; what is recorded is the content of the breadcrumb: the name of the first level, and for each level the raw value clicked and how it is written on the chart. When there is only a value and no written form (the source links of the AI assistant are saved by the server, see [AI assistant](ai-assistant.md) 12.3), the form is written out at the granularity of that level when the link is opened.
- **Which conditions to include**: once ticked, the conditions that differ from the defaults are listed below by category, one line per category: global filters, chart filters (including the "Use chart filters" switch), chart links, dimensions and measures, drill-down, and pages and tabs; only the categories that changed are listed. A drill-down is written as "Chart name: East China › Jiangsu", with the values written as in the breadcrumb. Each line has a checkbox, all ticked by default, and a category can be unticked; the specific content is written after it, for example "Region: East China, South China; Amount ≥ 200", truncated when too long, with the full text shown on hover. When there are many values, the style of the filter controls is used, "East China, South China, North China and others, 5 in all". An unticked category is not included, and the recipient sees the defaults for that category. Unticking all of them is the same as not including any conditions, and the link goes back to the dashboard's address, which the dialog says.
  - Ticking is by category, not by individual filter: among cascading global filters, the value of a child filter depends on its parent filter, so unticking only the parent would carry a combination that does not match, which including or excluding a whole category does not. The interface also does not grow long because there are many conditions.
  - The conditions are saved again on every change of the ticks; the same conditions get the same link ID.
  - The reminder "Whoever opens the link sees these filter values" is shown only when global filters, chart filters, chart links or drill-down are ticked; dimensions and measures and the tab being shown are not values in the data.
- **The conditions are stored on the server, and the link carries only a short ID**, in the form `/dashboards/{id}?ws={workspaceId}&view={viewId}`. So the filter values (customer names, phone numbers and so on) do not enter the browser history, the access logs of proxies and gateways, or the link previews of chat apps; and the link does not grow too long when hundreds of values are selected.

```jsonc
// Request body of POST /dashboards/{id}/views; returns { "id": "dv_…", "expiresAt": "…" }
{
  "state": {
    "filters": { "g_region": ["East China"] },
    "chartFilters": { "w1": { "f_total": 1000 } },
    "selections": { "w2": { "metric": "average" } },
    "useChartFilters": ["w3"],
    "links": { "region_link": "East China" },
    "drill": { "w4": { "root": "Region", "steps": [{ "value": "East China", "text": "East China" }, { "value": "Jiangsu", "text": "Jiangsu" }] } },
    "tabs": { "w7": "w9" },
    "page": "w21"
  },
  "validDays": 30
}
```

- There is a new table `dashboard_views`: ID, owning dashboard, conditions, a digest of the conditions, creator, creation time, expiry time and last-opened time. The same conditions of the same dashboard reuse the same ID based on their normalized content, so sharing repeatedly creates no new records. The conditions are not modified after creation and are deleted together with the dashboard.
- **Validity period**: when conditions are included, the dialog lets you choose how long they stay valid, 1, 7, 30 or 90 days, 30 days by default, counted from the time of sharing; opening the link does not extend it. When the same conditions are shared again, the same ID is reused and the expiry time is the later of the two, so links already sent out do not expire earlier because of it. Expired conditions are deleted by an hourly maintenance job. A link without conditions is just the dashboard's address and has no validity period.
- When conditions that have expired or been deleted are opened, the dashboard is shown with its default conditions and a notice says "The shared conditions have expired; the dashboard shows its defaults".
- **Workspace**: a dashboard belongs to a workspace and the API looks it up in the workspace the session is currently in, so the link carries the workspace ID (`ws`). When the recipient is currently in another workspace but can enter the one the link points to, the page says which workspace the dashboard is in and offers a "Switch to" button, which switches and reopens the link on click. It does not switch automatically, because the workspace belongs to the server-side session: other tabs in the same browser would switch with it, and what is being edited there would be written to the other workspace, so a note under the button says so. When the recipient cannot enter it, it is the same as having no permission.
- **No permission**: the flow for requesting access has not been built, so the recipient sees a no-access notice. The server returns 404 for a dashboard that cannot be seen, without revealing whether it exists, so the notice reads "This dashboard does not exist, or you do not have access to it. Its author or an administrator can help", with no distinction between the two cases. The dialog also reminds the person sharing in one line: only people who can open this dashboard can see it.
- **Sharing does not change permissions.** The link grants no access: the recipient must be able to open the dashboard ([Access control and workspaces](access-control.md) 4.2), data is fetched under the recipient's own identity, and row-level and column-level permissions apply as usual. Anyone who can open a dashboard can create a share; reading the conditions of a share likewise requires being able to open the dashboard it belongs to.
- **The filter values themselves are visible to the recipient.** When the recipient has no row permission for a customer, the chart is empty, but the filter box still shows that customer's name. When conditions containing such values are ticked to be included, the dialog points this out; the dialog also writes out the specific values, so the person sharing can see what they are about to send out.
- **Conditions that no longer apply**: if the author later deletes or changes a filter, link or dynamic position, the server returns 400 for an unknown ID (`unknown_filter`, `unknown_link`). When a link is opened, the front end first discards the IDs that no longer exist on the dashboard, the candidates that no longer exist in a dynamic position, and the values whose form does not match (`in`, `not_in`, `between`, `not_between` and multi-select controls need a list, time filters are not checked, and the rest need a single value; links accept only a single value). The remaining conditions are applied as usual, and a notice says "Some of the shared conditions no longer apply". Drill-down positions are handled the same way: when the chart can no longer drill down, or the path is longer than the current levels, the drill-down position of that chart is discarded and it stays at the first level. The values in the path are not checked: if a level changed its field, no data may be found, and going back from the breadcrumb is enough, the same as when other conditions change after a drill-down (2.10).
- Relative dates stay relative: "Last 7 days" is computed from the date when the recipient opens the link. For a fixed range, choose specific dates before sharing.
- After opening, until the recipient changes a condition, the `view` parameter stays in the address, so refreshing the page still shows the conditions as shared; once a condition is changed, it is removed from the address. In manual query mode, the shared global filter conditions are directly treated as applied conditions.
- What is carried is only the part that differs from the dashboard's defaults: a filter whose value equals its default, a dynamic position with the first candidate selected, and a chart that stays at the first level are not carried; clearing a filter that has a default carries an explicit empty value. The server then drops the empty parts and sorts the widgets with "Use chart filters", so the same conditions get the same digest. The conditions are at most 64 KB.
- Endpoints: `POST /dashboards/{id}/views` saves the conditions and returns the ID and the expiry time; `GET /dashboards/{id}/views/{viewId}` reads the conditions and records the opening time, and returns 404 `view_not_found` when they have expired or do not exist. Both require being able to open the dashboard, and when the dashboard cannot be seen they return 404, as the dashboard itself does.
- Creating a share records the audit event `dashboard.share` (category `content`), with the conditions as the details. The recipient's data fetching records query events as usual.

### 3.11 On-demand fetching and render modes (planned)

Status: on-demand fetching in interactive mode is implemented; full rendering, the ready signal and printing are deferred (see [Deferred items](../backlog.md)). There is no "Print"; the browser's own print can only print the charts that have already fetched data, and a chart not scrolled to prints as "Loading…".

A dashboard has two render modes, by purpose. The mode is decided by what the page is for and is not a setting of the author or the viewer.

| Mode | Used for | Data fetching |
|---|---|---|
| Interactive | View mode, editing canvas, in-page preview | A chart starts fetching when it is within one screen of the visible area |
| Full rendering | Printing, PDF export, and later screenshots and subscription pushes | All charts fetch immediately, animation is off, and a ready signal is emitted when all are done |

- **Interactive mode**: a chart that has fetched data keeps its result after scrolling out of the visible area; it is not unmounted and does not fetch again. When filters, chart links or dynamic selections change and on "Refresh data", only the charts that have already fetched data fetch again immediately (except those in other tabs, see 3.13); a chart that has never entered the visible area fetches with the conditions of that moment when it does.
  - **"Within one screen" is measured against the page's scroll area**: in view mode it is the content area of the dashboard, in full screen it is the layer covering the page, and on the editing canvas and in the in-page preview it is the canvas's scroll area. The visible part is extended by the size of one visible area in each of the four directions, and a chart card starts fetching as soon as any part of it enters that range. After entering or leaving full screen, it is computed against the new scroll area. The scroll area is named by the page and is not inferred from styles: an element with only horizontal `overflow` set is also counted as vertically scrollable, so inference is easy to get wrong. When none is named, the browser window is used.
  - The candidate values of a chart's own filter controls (dropdown, tiled, search select) are queries too, and likewise wait until the chart enters the range; on "Refresh data", only the candidate values of charts that have entered the range are fetched again.
  - When a chart appears, it measures its own position once, and a chart already in range fetches directly; after that it relies on the browser to report positions while scrolling. For a dashboard opened in a background tab, the browser does not paint the page and so reports no positions, so the first screen fetches as usual without waiting to be brought to the foreground, and the rest are fetched after switching over and scrolling near them. The middle part skipped in one jump (for example dragging straight to the bottom) has never entered the range and still does not fetch.
  - Once a chart has started fetching, it no longer matters whether it is in range, and it fetches again with conditions and refreshes according to the rules above. The current tab of a tab container (3.15) likewise has to enter the range before it fetches; the other tabs still fetch only when first opened.
  - **A chart that has not fetched data** shows the same "Loading…" as the first load, and the card is marked busy (`aria-busy`). It is more than one screen away and normally not seen; when scrolling past quickly, what you see is it loading.
  - Ways of reaching content without scrolling cannot find the content of a chart that has not fetched data: the browser's find in page, and the browse mode of screen readers (which do not necessarily scroll the page when reading further down). When moving focus with the Tab key, the browser scrolls the card that has focus into view, so it fetches.
  - **The toolbar counts only charts that have fetched data**: "Data as of", "Loading data…" and "N charts failed to refresh" do not count charts that have not fetched data, the same as for tabs that cannot be seen (3.15). Otherwise the charts lower on the page have no result until scrolled to, and the toolbar would show "Loading data…" all the time.
  - If "Refresh data" was clicked before the chart entered the range, its first fetch also goes straight to the database; if a timed refresh happened before, the first fetch carries `maxAge` (3.9). This way its data is not older than that of charts that have already fetched data, and "Data as of" does not move earlier because of scrolling down.
- **Ready signal**: once all charts have a result (success, empty result or error) and have finished drawing, a status attribute on the dashboard's root element changes to ready. A screenshot program waits for this signal instead of waiting a fixed number of seconds.
- **Printing**: "Print" in view mode first switches to full rendering mode and calls the browser's print once ready. The browser's own print (Ctrl/⌘+P) cannot wait for queries and can only print charts that have already fetched data.
- Later, server-side screenshots will enter full rendering mode through a URL parameter, designed together with how the headless browser signs in.
- In interactive mode, tabs that are not open do not fetch data (3.13).

**Implementation order**

1. On-demand fetching in interactive mode: the items under "Interactive mode" above. Implemented.
2. Full rendering, the ready signal and printing. The print layout is decided before this step: the paper orientation, how the grid shrinks to the paper width, cards not being cut by page breaks, and charts being redrawn at their size on paper; which pages of a dashboard with pages (3.13) are printed is also decided then. A print style was tried on 2026-10-20, and pressing ⌘P in Chrome still cut off the right side of charts or left blank space, so it was reverted and this step is deferred.

### 3.12 Title and text widgets

The widget types gain `title` and `text`, laid out in the grid like charts:

```jsonc
// Three widgets in layout.items
{ "id": "w3", "type": "title", "x": 0, "y": 0, "w": 96, "h": 8, "useDashboardName": true },
{ "id": "w4", "type": "title", "x": 0, "y": 8, "w": 96, "h": 8, "title": "East China", "subtitle": "Counted by order date",
  "style": { "align": "center", "verticalAlign": "top" }, "frame": { "background": "blue", "border": true } },
{ "id": "w5", "type": "text", "x": 0, "y": 16, "w": 48, "h": 16, "markdown": "**Definition**: paid orders, excluding refunds." }
```

- The view page does not always show the dashboard's name and description; add a title widget when needed.
- **Title widget**: when "Use the dashboard's name and description" (`useDashboardName`) is ticked, the title is the dashboard's name and the subtitle is its description, and they follow when the dashboard is renamed; when the description is empty there is no subtitle. The editing canvas and the in-page preview show the name and description in the draft, and they change right away once applied in the page settings. When it is not ticked, you write your own title (`title`) and subtitle (`subtitle`), and both can be left empty. A newly added title widget is ticked by default; on unticking, the current name and description are filled in, which makes it easy to edit from there. `title` and `subtitle` are not saved while it is ticked.
- The title is one line and the subtitle at most two lines; when too long they are truncated with an ellipsis, and the full text is shown on hover. The defaults are left-aligned and vertically centered, with no border and the same background as the dashboard, so it looks like a heading on the page.
- **Title alignment** (`style`, optional): only the items that differ from the defaults are saved, and a title without `style` is the default left-aligned, vertically centered one. The title and the subtitle are aligned together and not set separately.

  | Property | Values | Default |
  |---|---|---|
  | `align` | `left`, `center`, `right`: horizontal alignment | `left` |
  | `verticalAlign` | `top`, `middle`, `bottom`: vertical position within the widget | `middle` |

- **The title's background and border** are in the container appearance `frame` (3.14), the same as for other widgets; the items below describe how it looks on a title.
  - `background`: `neutral` is a light gray background; a hue name from the palette (`blue`, `orange`, `aqua`, `yellow`, `magenta`, `green`, `violet`, `red`) is a light background in that hue; a six-digit hex color value (such as `#1f3a5f`) is a color the author defines. When omitted, the background is the default, the same as the dashboard, as for other widgets.
  - `border`: `true` is a 1-pixel border with the same rounded corners as chart cards. When omitted, there is no border.

  - **Built-in backgrounds change with light and dark mode**: light gray and the 8 hues are stored as names, not color values, the same as chart colors (2.8). Light and dark mode each use their own shade, mixed with the card background into a light tint, so no hard-to-read combination appears in dark mode. The text still uses the normal text color; there is no white text on a dark background, because white text on hues such as yellow and magenta has too little contrast.
  - **Custom colors are shown as they are**: a color the author picks is what-you-see-is-what-you-get and is not lightened. The text of the title and subtitle automatically uses a dark or a light color according to the brightness of the background, taking whichever has the higher contrast with it, so it is light text on a dark background. The dark theme can have its own background (3.14); when not set, both modes use the same color, so a light background chosen in light mode is a bright patch in dark mode, where the text is readable but conspicuous. For the same blue, the built-in one is a lightened tint and the custom one is the original color, so the two look different.
  - The background can have its transparency adjusted (3.14). The editor stores lowercase color values, and the server accepts either case.
  - There is no background "the same color as chart cards": the dashboard's background and the chart cards are the same color, so such a background would not be visible. To look like a chart card, just turn on the border.
  - The border is either on or off; its color follows the theme's border color, does not change with the background hue, and its thickness cannot be adjusted.
  - With a background or border, the text keeps the same padding from the edge as a text card; with neither, it stays flush with the edge, aligned with the left edge of chart cards.
  - On the editing canvas, a title with a border no longer shows the dashed frame that marks its extent; the space taken by the "…" at the top right is reserved symmetrically on both sides, so a centered title sits in the same place when editing and viewing.
  - Below "Content" in the properties panel is the "Alignment" group, where horizontal and vertical alignment use segmented controls; after it comes the "Appearance" group shared by all widgets: the background uses color swatches like those of the chart colors, the border is a checkbox and the padding is a segmented control. Changes enter the undo history.
  - Above the background is the "Light theme / Dark theme" switch (3.14), and the swatches below set the background for the selected theme. The swatches are, in order, default, light gray, the 8 hues and finally "Custom color" (eyedropper icon). Clicking "Custom color" opens a color picker that says which theme's color is being set, with a color area (react-colorful) and a color value input box, and changes show on the canvas immediately; once a custom color is chosen, this swatch shows that color and is selected. Dragging in the picker or typing a value is merged into one undo step until the picker is closed. The color value box accepts only `#RRGGBB`; an unfinished or wrong value is not applied and does not clear the color already chosen.
  - Font size, text color and decoration (such as a color bar on the left) are not provided and can be added separately when needed. The text widget is still a card and has none of these settings.
  - Background and border used to be written in `style` and have been moved to `frame` by a migration.
- **Text widget**: write notes, definitions and conclusions in Markdown (`markdown`); like a chart, it is shown in a card, and it scrolls inside the card when the content overflows. It is rendered with markdown-it and supports CommonMark plus tables and strikethrough; one line break in the text box is one line break; a URL written out automatically becomes a link.
- **Preventing script injection**: the content is written by the author and shown to all viewers, so only Markdown is rendered, and any HTML in it is shown as plain text; links allow only `http`, `https` and `mailto`, and other links (`javascript:`, `data:`, relative addresses and so on) do not become links and are shown as text; links open in a new tab and do not reveal the origin to the target page (`rel="noopener noreferrer"`). Images are not shown: an image would make every viewer's browser request an address the author chose, which could be used to record who looked at it and when; the image syntax is shown as ordinary text and a link.
- **The scope is decided by position**: a title placed above the tabs belongs to the whole dashboard, and one placed inside a tab belongs only to that tab (3.13). There is no separate "global title" setting.
- **Editor**: the toolbar gains "Title" and "Text"; clicking adds the widget to the canvas, selects it and lets you edit its content in the properties panel on the right. A title is added at the very top of the canvas with full width, and the other widgets move down; a text is added at the very bottom like a chart, at half the width. Changes in the properties panel enter the undo history like other edits, and continuous typing is merged into one step. A title or text on the canvas can be dragged by its whole body, "…" offers widget configuration and remove, and remove also asks for a second confirmation. A title or text without content shows a gray hint on the canvas and is blank when viewing.
- **Size**: a title is 8 cells high by default (about 75 pixels at the default row height, enough for a title and one line of subtitle), and a text is 16 cells high by default; the minimum height of both is 4 cells, while a chart's remains 16 cells.
- These two kinds of widget do not fetch data, cannot be linked charts of a global filter, and cannot be the source or target of a chart link; they do not enter `dashboard_charts`. The data time, "Refresh data" and timed refresh in the view-mode toolbar look only at charts, and a dashboard with only titles and texts does not show them.
- **Validation on save**: title and text widgets cannot have `chartId`; chart widgets cannot have `subtitle`, `markdown` or `useDashboardName` (`title` is their display name, see 3.14); a title widget cannot have `markdown`, and when `useDashboardName` is ticked it cannot have `title` or `subtitle` either; a text widget has only `markdown`; only a title widget can have `style`. A violation is reported as `invalid_item_fields`. A value in `style` that is not in the table above is reported as `invalid_item_style`; for the validation of `frame` see 3.14. Length limits are counted in characters: title 200, subtitle 500, Markdown 20000, and exceeding them is reported as `item_text_too_long`. A global filter linked to a title or text is reported as `invalid_filter_target`, and a chart link that uses them is reported as `invalid_link`. Requesting data, candidates or export for a title or text widget returns 404.

### 3.13 Tab pages

Status: implemented.

A dashboard can be split into several tab pages, called "pages" below, and each page has its own layout. This paginates the whole dashboard. It is not the same as the tab container in 3.15 (one widget that switches between several charts with tabs); both are built.

**Structure**

A paged dashboard consists, from top to bottom, of the shared area, the tab strip and the current page.

```jsonc
"layout": {
  "columns": 96,
  "pages": [
    { "id": "w20", "name": "Overview" },
    { "id": "w21", "name": "Channels" }
  ],
  "items": [
    { "id": "w3", "type": "title", "x": 0, "y": 0, "w": 96, "h": 8, "useDashboardName": true },  // shared area
    { "id": "w1", "type": "chart", "chartId": "ch_3f8k…", "page": "w20", "x": 0, "y": 0, "w": 48, "h": 32 },
    { "id": "w2", "type": "chart", "chartId": "ch_9c2m…", "page": "w21", "x": 0, "y": 0, "w": 48, "h": 32 }
  ]
}
```

- The order of the pages is the order of `layout.pages`, and the first page is shown when the dashboard opens. There is no default page setting: the first page of a dashboard is usually the overview. A tab container has a default tab (3.15) because an order such as "Day | Week | Month | Year" must not be shuffled just to set the default. Dashboard pages rarely have this problem, and we can add it later if needed.
- A widget says which page it is on with `page`; a widget without `page` is in the shared area. All widgets are still in `layout.items`, so global filters, chart links, data fetching, candidate values, exports and share links still find charts by widget ID, and the API does not change. The tabs of a tab container stay on the same page as the container.
- The shared area and each page are separate grids, each counting vertical positions from 0. The grid settings (`layout.grid`), such as the number of columns, the row height and the gaps, are shared by all grids.
- The shared area can hold any widget: title, text, chart, tab container. What is placed here is shown on every page, for example the dashboard title, a note on how figures are defined, or a few key figures that every page needs. The shared area can be empty, in which case the tab strip is at the very top. The query container is always in the shared area (see "Global filters" below).
- Grids do not nest: a page cannot be split further. A widget can be dragged between the shared area and the current page; to reach another page, use "Move to" (see "Editing" below).
- A dashboard has 2 to 20 pages. With only one page left it turns back into an unpaged dashboard. A dashboard without `pages` is the same as today and needs no migration.

**Tab strip**

- Each page shows its name. When the names do not fit, the strip scrolls horizontally, with the same rules as the tab strip of a tab container (3.15): no wrapping, the mouse wheel also scrolls, the side with hidden tabs fades out, and the current page is always within view. The tab strip is a tab list (`tablist`); the left and right arrow keys switch pages, and Home and End go to the first and last page.
- When scrolling down, the tab strip stops at the top of the scroll area once it gets there (sticky), so a long page can be switched without scrolling back; the shared area scrolls away. Full screen is the same. When focus moves with the Tab key, the card scrolls to just below the tab strip so that the strip does not cover it.
- The tab strip follows the interface theme and has no appearance settings.

**Title**

No new widget is needed. A title widget (3.12) in the shared area is the title of the whole dashboard and is shown on every page; in a page it belongs to that page only, for example a section heading. There is no title that "uses the page name", because the tab strip already shows it.

**Global filters**

Global filters are still all in one query container, and the query container is in the shared area. Each page shows only the filters that relate to it:

- A filter relates to a page if it is linked to a chart in this page or in the shared area (any tab of a tab container counts), or if it is the parent of such a filter in a cascade. The value of a parent limits the candidates of its child; without seeing the parent, one could not tell why the candidates are fewer. The other filters are hidden.
- The definition of a filter does not change. It still links to charts by widget ID, and one filter can link to charts on several pages. After a chart moves to another page, the filters linked to it are shown on that page with no configuration change.
- A filter has one value across all pages: choose East China on page 1 and it is still East China on page 2. A hidden filter keeps its value and takes effect as usual when its page is shown again.
- The "Query" button, reset, query mode and control style remain a single set. In manual query mode, "Query" applies the current input of all filters, including those not shown on this page.
- With automatic height, the query container grows or shrinks with the number of filters shown, and the widgets below it in the shared area move along. With manual height it stays the same: blank space when there are few filters, scrolling inside the container when there are many.
- When a page has no filter to show, the query container is not shown in view mode and in the in-page preview, and the height it took is collapsed. On the edit canvas the container is still shown, with the message "No filters are linked to the charts on this page.", so that configuration can go on.
- In the middle column of the global filter dialog, the linked charts are grouped by the shared area and by page.
- No extra query container is put in a page, that is, multiple query containers are not supported (see [Deferred items](../backlog.md)). Each container would then have its own "Query" button and reset, and we would have to decide which filters they act on, whether query mode and control style are per container or per dashboard, whether cascading can cross containers, and what happens to the filters linked to a chart in its old container when the chart changes page. Showing filters by page already lets a filter that belongs to one page appear only on that page.

**Chart links**

Chart links can cross pages: click a chart on page 1 and the target chart on page 2 is limited in the same way, and the next time page 2 is opened it fetches data with the new condition. The current link conditions are listed above the grid (3.4), visible on any page, and can be cancelled one by one.

**Fetching data**

- In interactive mode only the pages that have been opened fetch data, and within a page charts still wait until they are near the viewport (3.11). Switching away and back keeps the earlier results.
- When filters, links or dynamic selections change, and on "Refresh data" and timed refresh, the charts that have fetched data in the shared area and the current page fetch again immediately; the charts that have fetched data on other pages fetch again with the conditions of that moment the next time the page is opened, with the same rule as the hidden tabs of a tab container (3.15). If "Refresh data" was clicked before a page was first opened, the first fetch of that page also goes straight to the database; if there was a timed refresh, it carries `maxAge`.
- The toolbar's "Data as of", "Loading data…" and refresh failures count only the charts in the shared area and the current page.
- Full rendering and printing are deferred (3.11); which pages to print will be decided then.

**URL and sharing**

- The current page is written into the URL parameter `page`, whose value is the page ID, with no filter values; it is not written on the first page. Switching pages replaces the URL without adding browser history, so "Back" returns to the previous web page, not to the previous page of the dashboard. Reloading stays on this page; if the page in the URL no longer exists, the first page is shown.
- Entering edit mode from view mode carries the current page, so the editor opens on the same page.
- The share conditions (3.10) gain `page`, carried only when the current page is not the first. It falls under the "tabs shown" group, which is renamed "Pages and tabs shown", and its content is written "Page: Channels". When the link is opened, a page that no longer exists is dropped and, like other invalid conditions, a message says that some conditions no longer apply. After that, switching pages is like changing any other condition: the `view` parameter is removed from the URL.

**Browser tab title**

For a paged dashboard, the title of the browser tab includes the name of the current page: "Dashboard name - Page name - SupaBI". It changes when the page is switched, and the edit page is the same. The page name goes after the dashboard name because many dashboards call their first page "Overview", and with the page name first several browser tabs would all read "Overview - …". An unpaged dashboard is "Dashboard name - SupaBI" (3.7).

**Editing**

- **Splitting into pages**: the toolbar gains "Pages". On an unpaged dashboard, clicking it splits the dashboard into two pages: the titles and text whose lower edge is above the topmost chart container (including empty containers and tab containers), and the query container, go into the shared area, and everything else goes into the first page; an empty second page is added and shown. On an already paged dashboard, clicking it adds an empty page and shows it. Splitting is one undo step.
- The tab strip has a "+" on the right, which adds an empty page and shows it; next to "+" is the settings button, which opens the page settings in the properties panel. Neither scrolls with the tabs.
- A new page is named "Page N", where N is the smallest number not yet used.
- **Switching pages**: click a tab on the edit canvas. Which page is current is not part of the undo history and is not saved; if the current page no longer exists after an undo or redo, the first page is shown.
- **Page settings**: click the settings button of the tab strip ("Manage pages") or its empty space, and the properties panel on the right lists the pages, each row with a drag handle, a name and a delete button. Names are edited in the list; when focus enters a row, the canvas switches to that page. If a name is cleared, the page keeps its old name until a new one is entered. Drag the handle to reorder, with the insertion position shown while dragging; when the handle has focus, the up and down arrow keys move the page up or down one place. Changes take effect at once and go into the undo history, with continuous typing merged into one step.
- **Deleting a page**: asks for confirmation, says how many widgets on the page are removed with it, and also removes their filter mappings and chart links; the source charts are not deleted. With one page left, the dashboard turns back into an unpaged one: the widgets of the shared area go on top and the widgets of the remaining page follow below. Deleting and turning back into an unpaged dashboard are one undo step.
- **Where new widgets go**: a title is added at the top of the shared area, at full width, consistent with adding it at the top of the canvas on an unpaged dashboard; text, charts and empty containers are added at the bottom of the current page. When dragging from the chart library, dropping on the shared area puts the widget in the shared area and dropping on the current page puts it in the current page. When the shared area is empty, the edit canvas shows a dashed frame with the hint "Components here are shown on every page", and widgets can be dragged into it.
- **Moving**: the "…" menu of a widget has "Move to", which moves it to the shared area or another page, placing it at the bottom of that grid with the same width and height; the edit canvas stays on the current page. This is one undo step. Filter mappings and chart links go by widget ID, so changing the page does not affect them. The query container has no "Move to".
- **Dragging to the other area**: on the edit canvas, a widget can be dragged directly between the shared area and the current page and lands where it is released. While dragging into the other area, the drop position is shown there and the other widgets make room, the same as dragging within one area. The area it came from stays as it is: the widget's old place is left empty and the neighbors do not fill in, and after release the area settles by its own rules, with the widgets below moving up under automatic upward compaction and the gap left under free layout, the same as "Move to". The moved widget keeps its width and height and stays selected. This is one undo step, and filter mappings and chart links are not affected.
  - Which area the pointer is in is computed from the extents of the areas at the start of the drag. In a free layout, dragging down inside the shared area makes the shared area grow with the widget and pushes the tab strip and the current page down; if the live extents were used, the pointer could never get into the current page.
  - If the widget is released outside both areas, for example on the tab strip, it stays in its original area, at the position shown for it there.
  - After the current page has been scrolled, dragging a widget up to the top edge of the canvas scrolls the canvas up as usual, and the widget can be dropped once the shared area comes into view.
  - The query container cannot be dragged out of the shared area, and it has no "Move to".
  - To reach another page: drag the widget into the shared area first, switch pages, and drag it down, or use "Move to". Pages do not switch automatically when the pointer stays on a tab: the dragged widget belongs to the original grid, switching pages hides that grid, and the drag would be interrupted. Dragging onto the tab of another page to drop at the bottom of that page is not done either: the author considered same-screen dragging enough.
  - The drop position and the making of room for cross-area drags are computed in the dashboard's grid component, and the local patch of the drag library (see [Deferred items](../backlog.md)) does not change.
- The "Dashboard contents" in the page settings shows the number of pages.

**Validation on save**

- `layout.pages` must have 2 to 20 pages, otherwise `invalid_pages` is reported. Page IDs follow the same rules as widget IDs: an invalid one reports `invalid_item_id`, and one that duplicates a widget, a tab or another page reports `duplicate_item_id`. After leading and trailing whitespace is removed, a page name must not be empty, otherwise `invalid_page_name` is reported; the limit is 50 characters, and exceeding it reports `item_text_too_long`.
- The `page` of a widget must be the ID of a page; the widgets of an unpaged dashboard cannot have `page`, otherwise `invalid_item_page` is reported.

**Implementation order**

1. Change the title of the browser tab to name first, SupaBI last (3.7). It is unrelated to paging, so do it on its own first.
2. Types and validation. View: the shared area, the tab strip (including sticky), switching pages, the URL parameter, on-demand data fetching and the toolbar, the page name in the browser title. Edit: "Pages" and "+", switching pages, renaming, deleting a page and turning back into an unpaged dashboard, where new widgets go, "Move to".
3. Show global filters by page; group the global filter dialog by page.
4. Reordering pages; the share link and entering edit mode carry the current page.

The four steps were built at once, at the author's request. Dragging widgets between the shared area and the current page (see "Editing") was added afterwards.

### 3.14 Widget containers

Status: implemented.

Every widget in the layout is a container: position, size and appearance belong to the container, and the chart, title, text or query control placed in it is its content. A chart container only references a chart (`chartId`); the definition, colors, axes and so on of the chart are still set on the chart editing page. In this way, "how this chart is placed and decorated" on a dashboard is separate from "the chart itself", and the properties panel is grouped by these two layers instead of mixing them.

```jsonc
// a widget in layout.items
{ "id": "w1", "type": "chart", "chartId": "ch_9c2m…", "x": 0, "y": 8, "w": 48, "h": 32,
  "title": "East China sales", "note": "Definition: paid orders, excluding refunds.", "hideHeader": true,
  "frame": { "background": "#f4f8ff", "backgroundDark": "#16202e", "border": false, "padding": "compact" } },
{ "id": "w2", "type": "chart", "x": 48, "y": 8, "w": 48, "h": 32 },                  // an empty chart container
{ "id": "w3", "type": "title", "x": 0, "y": 0, "w": 96, "h": 8, "useDashboardName": true,
  "style": { "align": "center" }, "frame": { "background": "blue" } }
```

```jsonc
// Top level of the dashboard spec: the default appearance of chart and text containers
"frame": { "border": false, "padding": "compact" }
```

**Chart container**

- **Empty container**: at the top of the chart library is "Empty chart container"; click it to add it at the bottom of the canvas (half the width and 16 rows high, the same as adding a chart), or drag it to a chosen position, to lay out the page structure first and put charts in later. Clicking or dragging a chart from the chart library still creates, in one step, a container that holds that chart, so no empty container needs to be made first.
- An empty container is shown on the canvas as a dashed frame with the hint "Drag a chart here from the chart library" and a "Choose from the chart library" button, and the whole block can be dragged. When an empty container is selected, the top of the chart library shows the hint "Click a chart to put it in …", and clicking a chart in the library puts it in this container instead of adding another one. In view mode and the in-page preview an empty container is blank, like a text widget with no content.
- When a chart is dragged over a chart container, the container is highlighted and the canvas does not make room for it; releasing puts the chart into this container (if it is empty) or asks to replace (if it holds a chart). Dropping on blank space still adds a new container.
- **Replace**: drag a chart onto a container that already holds a chart, and after confirmation it is replaced. Position, size and appearance are kept; the filter mappings and chart links of the original chart are removed, and the display name and note are cleared too, because they described the original chart. The "…" menu also has "Take out chart", which turns the container back into an empty container and removes the mappings in the same way. Replacing and taking out are each one undo step, which restores the cleaned-up mappings as well.
- **Display name** (`title`): when empty, the name of the chart is shown; when filled in, it is used only in this dashboard and the source chart is not changed. The card header, the enlarge dialog, export file names, accessible names, and the widget names in the global filter and chart link dialogs all use it; the "Chart" group of the properties panel still shows the name of the source chart. Up to 200 characters.
- **Note** (`note`): when filled in, a question mark icon appears to the left of the "…" on the right of the header, and hovering or keyboard focus shows the full note. Plain text, line breaks kept, Markdown not rendered; up to 500 characters. It is for definitions, data sources and other explanations that need not always be visible.
- **Hide header** (`hideHeader`): in view mode and the in-page preview the header is not shown and the chart fills the container. The question mark, the refresh failure warning and "…" float at the top right: the warning is always shown, and the question mark and "…" appear when the pointer enters the container or it has keyboard focus; the data fetch time of a single chart is not shown, while the data time in the toolbar remains.
- On the edit canvas, a hidden header floats over the top of the chart, semi-transparent with a dashed lower edge, and takes no space, so the size and position of the chart are the same as in view mode and there is no need to switch to the preview to see the real result. It is still a drag handle; its name is greyed out, with "Hidden when viewed" right after the name. A floating header covers a strip at the top of the chart, including the chart's own filter controls; use the preview to operate them.
- An empty container can also have a display name, a note and an appearance, which take effect once a chart is put in.

**Container appearance** (`frame`, optional): shared by titles, text, chart containers and the query container (`queryContainer.frame`).

| Property | Values | Description |
|---|---|---|
| `background` | `default`, `neutral`, a palette hue name or `#rrggbb` | `default` is the default background, that is, the surface color of the interface; the dashboard itself has this color too, and it is the same for all widgets. It is also what applies when nothing is written; writing it out is for restoring it on its own when the page default has a background. Built-in backgrounds change with light and dark mode; `#rrggbb` is the color of a custom color in light mode |
| `transparency` | an integer from 0 to 100 | Transparency of the background, as a percentage: 0 is opaque, 100 is fully transparent, and whatever is behind shows through. The same in both themes. 0 when not written |
| `backgroundDark` | the same kinds as `background` | Background in the dark theme. When not written it follows `background`: light grey and hues change to the dark shade, and a custom color stays as it is |
| `border` | `true`, `false` | A 1 pixel border, whose color follows the theme |
| `padding` | `compact`, `normal`, `comfortable` | The distance between the content and the edge; the names are the same as the compact, normal and comfortable of the controls inside charts |

- **Backgrounds are set separately for the light and dark themes**: the first row under "Background" in the appearance is a "Light theme / Dark theme" switch, which defaults to the current interface theme, and the dot next to each item is the color selected for that theme, the same as the color the swatch shows. The swatches and the custom color below set the background of the selected theme, and the swatches are shown for the selected theme: in the dark theme, the default background, light grey and the hues are all the dark shade. In the dark theme any kind can be chosen: default, light grey, a hue or a custom color. When the dark theme has no setting of its own it follows the light theme; once it is set separately, "Same as light theme" appears, and clicking it restores following. The interface has no explanatory text; the dot tells whether it follows. A dark background that equals the light one does not save `backgroundDark`. The canvas shows only the background of the current interface theme; see the other one by the dot next to the switch, or switch the interface theme. This solves the problem in 3.12 that "a light background chosen in the light theme is a bright block in the dark theme"; if only the light background is set, the behavior is as before.
- The first entry point was in the color picker panel and could only set custom colors separately, which was hard to discover; it moved above the swatches, and every background can be set per theme.
- **Content on a custom color switches to a theme chosen by the lightness of the background**: when the background is light it uses the colors of the light theme, when dark those of the dark theme, taking whichever set gives the higher contrast between text and background, computed separately for each mode. This is done by writing that theme's color variables on the container, with the background color as the "surface color" of the container, so titles, text, in-chart controls and tables all follow without handling each one.
- **Charts on a custom background**: drawn with the light or dark set of colors by the same rule, with the background color as the surface color of the chart: the gaps between bars, table cells and the total row use it, and the table header is slightly darker on top of it. Series use the same hue at that theme's shade. A chart in the enlarge dialog is drawn on the dialog and uses the colors of the interface theme. Under built-in and default backgrounds it uses the colors of the interface theme.
- **Transparency**: below "Background" is a "Transparency" slider, 0% to 100% in steps of 5%, with the current percentage next to it; it acts on the selected background, the default background included, so a chart is an opaque card by default and dragging to 100% makes it fully transparent. Both themes use the same value, because it says "how much shows through from behind" and has nothing to do with color. Dragging the slider until release is one undo step. A title can be adjusted like any other widget; to let a title show the canvas through, raise its transparency.
  - Text and chart colors are chosen from the actual color of the background composited over the dashboard surface color: a dark custom color made very transparent is already light on a light surface, so dark text is used inside. This composited color is also the surface color of the chart. The base color of the dashboard is the surface color of the interface (in full screen too), so in view mode what you see is exactly this composited color; while editing, the canvas has a grid, and a semi-transparent card shows the grid through it.
  - When the background has a color in only one theme, the padding in both themes is still computed as "with a background", so text does not move when the theme is switched.
  - Dragging an empty container from the chart library over an existing chart container makes room as usual, and releasing adds a new empty container instead of putting it into that container.
  - "No background" was once made directly transparent, with the result that every card on the edit page showed the grid through, which looked uncomfortable; it is now opaque by default and transparency is adjusted when needed.
- **The background options are the same for all widgets**: the swatches and transparency are exactly the same for titles, charts, text and the query container, and all default to the opaque default background. Titles earlier defaulted to "no background" with the slider unavailable, which was inconsistent with charts; this was changed to be the same, and whether a widget is transparent is decided by transparency.
- **Default borders differ by type**: charts and text containers default to a card (with a border and normal padding), titles default to no border (3.12), and the query container has a border by default. The top-level `frame` of the dashboard is the default appearance of chart and text containers, edited under "Default widget appearance" in the page settings, and like the other page settings it takes effect only after "Apply"; items not written on a widget follow it and items that are written override it, so `border: true` on a widget differs from leaving it out. A widget saves only the items that differ from its own default appearance, and changing back stops saving them. Titles do not follow the page default, because a title should look like a title on the page, not like a card; the query container does not follow it either.
- The three padding steps have different actual distances for each kind of widget: charts, text and the query container use 8/10, 12/16 and 18/24 pixels (vertical/horizontal), titles with a background or border use 4/10, 8/16 and 14/24, and titles without use 0, 4/2 and 8/8. A query container with automatic height computes its height from the selected padding. Charts and text without a border are outlined with dashed lines on the edit canvas, the same as titles.
- The `style.background` and `style.border` that titles have now (3.12) move to `frame`, and `style` keeps only alignment. Title styles already saved in the development database are moved over by a migration; it is not released yet, so the old form is not kept.

**Properties panel**: when a chart container is selected it is divided into the groups "Container" and "Chart".

- "Container": display name, note, hide header; then "Appearance" (Background, Show border, Padding) and size.
- "Chart": which chart is placed (for an empty container, "Choose from the chart library"), edit source chart, take out chart; then the linked filters and the data export note.
- The properties panels of titles, text and the query container also gain "Appearance"; the old "Style" group of titles keeps only alignment and is renamed "Alignment".
- In the color picker panel, dragging and typing are one undo step until the panel closes; moving focus within the panel does not split it.

**Validation on save**: a chart container may have no `chartId` (an empty container); an empty container fetches no data, and data fetching, candidate values and export return 404 for it. It cannot be a linked chart of a global filter (`invalid_filter_target`) or the source or target of a chart link (`invalid_link`), and it does not enter `dashboard_charts`. `title`, `note` and `hideHeader` belong to chart containers only, and other types report `invalid_item_fields`; a display name over 200 characters or a note over 500 characters reports `item_text_too_long`. A value in `frame` that is not recognized reports `invalid_item_frame`.

The plan was originally five steps (`frame` and title migration, the appearance of each kind of container, display name and note, empty containers, the default appearance in the page settings), and all were built at once at the author's request.

### 3.15 Tab container

Status: implemented.

A chart container can have several tabs, each holding one chart, switched by clicking a tab, so that several related charts can be viewed in turn in the same place, for example sales, order count and average order value. It is not the same as the dashboard-level tab pages in 3.13: those split the whole dashboard into pages, each with its own layout, while here several charts sit in one widget and grids do not nest. Both are built.

```jsonc
// a tab container in layout.items
{ "id": "w7", "type": "tabs", "x": 0, "y": 40, "w": 48, "h": 32,
  "frame": { "border": true }, "defaultTab": "w9",
  "tabs": [
    { "id": "w1", "chartId": "ch_3f8k…", "title": "Sales", "note": "Definition: paid orders." },
    { "id": "w9", "chartId": "ch_9c2m…" },
    { "id": "w10" }                                  // empty tab
  ] }
```

**Structure**

- Each tab is a chart container with no position and no appearance: it has its own widget ID, can have a chart (`chartId`), a display name (`title`) and a note (`note`), and can also be empty. The ID of a tab is unique within the dashboard together with the widget IDs.
- Global filters, chart links, data fetching, candidate values, export and share links all find charts by widget ID, and a chart in a tab uses the ID of the tab, so these features work for it as they do for a chart in an ordinary chart container: it can have its own filter field mapping, be the source or target of a chart link, and export data. The API does not change.
- Position, size and appearance (3.14) belong to the container and are shared by all tabs. The appearance follows the default widget appearance of the page, the same as chart containers.
- A tab holds one chart, not a small layout of several widgets: that would be a grid nested in a grid, and dragging across grids is complicated (3.13). A tab also holds only charts, not titles or text.
- A container has 2 to 20 tabs. With one left it turns back into an ordinary chart container (see "Editing" below).
- The **default tab** (`defaultTab`) is the tab shown when the dashboard opens; it stores the ID of the tab, and when it is not written the first tab is the default, so nothing is written when the default is the first. Order and default are separate: the order of tabs often has a meaning, such as "Day | Week | Month | Year", and showing "Month" by default should not require shuffling the order. For dynamic dimensions "the first candidate is the default" (2.4); here it differs, because the order there is only the order in a dropdown list, while the tabs are laid out on the page.
- Reordering does not change the default tab; after the default tab is removed, the default returns to the first tab.

**Viewing**

- The header of the container is replaced by a tab strip, and each tab shows its name: the display name, or the name of the chart when there is none. When the tabs do not fit, the tab strip scrolls horizontally, without wrapping, and the mouse wheel also scrolls; the side that still has hidden tabs fades out; the current tab is always within view.
- On the right of the tab strip are the data time of the current tab, the refresh failure warning, the question mark of the note and "…", the same as the header of a chart container, and all of them act on the current tab. The data time shows only a clock icon, and hovering shows "Updated …" and the exact time: as text it would take room from the tabs, and in a narrow container not even the first tab would be fully shown. Enlarge, view data and export use the name of the current tab.
- There is no "Hide header": the tab strip is needed for switching.
- Empty tabs are not shown in view mode and the in-page preview, consistent with an empty container being blank; when all tabs are empty, the container is blank. When the default tab is empty, the first tab that has a chart is shown first.
- Keyboard: the tab strip is a tab list (`tablist`); the left and right arrow keys move between tabs and switch, and Home and End go to the first and last.

**Fetching data**

- Only the current tab fetches data. The other tabs fetch the first time they are opened; switching away and back keeps the earlier results and does not fetch again. If "Refresh data" was clicked before the first open, the first fetch goes straight to the database; if there was a timed refresh, it carries `maxAge`, the same as a chart before it enters the viewport range in 3.11, so its data is no older than that of a chart that has already fetched.
- When filters, links or dynamic selections change, and on "Refresh data" and timed refresh, only the current tab of each container fetches at once; the other tabs that have fetched data fetch again with the conditions of that time when next opened, and show the old chart faded until the data arrives (3.9).
- The data time and refresh failures in the toolbar count only the current tab of each container; charts that cannot be seen do not affect "Data as of".
- The current tab is not saved in the dashboard; the tab a viewer switches to applies only to the page currently open. Full rendering (3.11) renders only the current tab.

**Editing**

- The "…" menu and the properties panel of a chart container (an empty one included) have "Add tabs": the container becomes a tab container, the existing chart becomes the first tab and keeps its original widget ID, so its filter mappings and chart links remain; an empty tab is added and switched to. The display name and note go with the chart and become those of the first tab; position, size and appearance stay with the container; "Hide header" is dropped. The container gets a new ID.
- The tab strip has a "+" on the right, which adds an empty tab and switches to it. "+" does not scroll with the tabs, so it is always visible however many tabs there are.
- **Dragging a chart onto the tab strip**: drag a chart from the chart library onto the tab strip of a tab container (the row with the tabs and "+"), and releasing adds a new tab holding that chart, inserted where the pointer is, and switches to it. While dragging over, the tab strip is highlighted and a vertical line between the tabs marks the insertion position, and the card itself is not highlighted; dragging onto the chart below the tab strip still puts the chart in, or replaces, the chart of the current tab (3.14). When there are already 20 tabs, the tab strip says it is full and releasing adds nothing. Dragging an "Empty chart container" over it is not put into the tab strip and makes room as usual; use "+" to add an empty tab. The header of an ordinary chart container does not accept a dragged-in new tab; "Add tabs" comes first.
- Click a tab on the edit canvas to switch; the empty space of the tab strip is still the drag handle. An empty tab, like an empty container, shows a dashed frame, a hint and a "Choose from the chart library" button: with the container selected, clicking a chart in the chart library, or dragging a chart onto the container, puts it into the current tab; dragging onto a tab that has a chart replaces it after confirmation, by the same rules as 3.14.
- The settings and "Take out chart" in "…" act on the current tab. "Remove" becomes "Remove tab", with confirmation, and also removes the filter mappings and chart links of the tab; the source chart is not deleted. When only one tab is left, the container turns back into an ordinary chart container, whose widget ID is the ID of the remaining tab, and its mappings and chart links are kept. Removing a tab and turning back into an ordinary container are one undo step.
- Which tab is current on the edit canvas is not part of the undo history and is not saved. When the edit page opens it shows the default tab first, the same as viewing.
- Properties panel: with a tab container selected, the order is the "Container" group (the tab list and "Add tabs"), the "Current tab" group (the display name and note of the current tab), appearance, size, and the "Chart" group, which is the same as for a chart container and acts on the current tab. "Current tab" comes right after the tab list so that after switching tabs its name can be changed at once, without scrolling past appearance and size. "Remove component" at the bottom removes the whole container, together with the mappings and chart links of all tabs.
- **Tab list**: each row has, from left to right, a drag handle, the tab name, a star and a delete button. Click the name to switch to that tab. The star of the default tab is solid and always shown; the stars of the other tabs are hollow, and clicking one makes that tab the default.
- **Reordering**: drag the handle in the tab list of the properties panel, with the insertion position shown while dragging. When the handle has focus, the up and down arrow keys move the tab up or down one place. Each change is one undo step. Sorting by dragging on the tab strip of the canvas is not done: the header is the handle for dragging the whole container, the tab strip is narrow and scrolls when the tabs do not fit, and step 3 has charts dragged from the chart library onto the tab strip, so these kinds of dragging would easily be mixed up; it can be added later if needed.
- In "Dashboard contents" of the page settings, charts in tabs count toward the number of charts and empty tabs count toward the number of empty containers. In the global filter and chart link dialogs, charts in tabs are listed alongside the other charts, shown by name.

**Validation on save**

- A widget of type `tabs` must have 2 to 20 tabs, otherwise `invalid_tabs` is reported. `defaultTab` must be the ID of one of its tabs, otherwise `invalid_default_tab` is reported. Only this type may have `tabs` and `defaultTab`; it cannot itself have the chart container fields `chartId`, `title`, `note`, `hideHeader` and so on, otherwise `invalid_item_fields` is reported.
- Tab IDs follow the same rules as widget IDs: an invalid one reports `invalid_item_id`, and one that duplicates a widget or another tab reports `duplicate_item_id`. A tab has only four items, `id`, `chartId`, `title` and `note`, with the same length limits as a chart container (`item_text_too_long`).
- An empty tab is the same as an empty container: it fetches no data and cannot be a linked chart of a global filter or the source or target of a chart link. A chart in a tab enters `dashboard_charts`, and a referenced chart cannot be deleted.
- No migration is needed: a dashboard without tab containers is the same as today.

**Implementation order**

1. Types and validation; viewing, switching and on-demand data fetching; "Add tabs", "+", removing a tab and turning back into an ordinary container; the properties panel.
2. The default tab; reordering in the tab list of the properties panel.
3. Dragging a chart onto the tab strip, which adds a new tab holding that chart, inserted where the pointer is.
4. The conditions of the share link (3.10) gain `tabs`: container ID to current tab ID, carrying only the containers whose displayed tab is not the one shown on opening (when the default tab is empty, the one shown on opening is the first tab that has a chart). When the link is opened, containers that no longer exist, and tabs that are not in a container or no longer have a chart, are dropped and, like other invalid conditions, a message says that some conditions no longer apply; the rest apply as usual. After that, switching tabs is like changing any other condition: the `view` parameter is removed from the URL.

All four steps are implemented.

## 4. Storage

- The `charts` table: ID, workspace, name, description, owning dataset, spec, creator and last modifier. A dataset referenced by a chart cannot be deleted.
- The `dashboards` table: ID, workspace, name, description, spec, creator and last modifier.
- The `dashboard_charts` table: the relation between a dashboard and the charts it references, rebuilt when a dashboard is saved. A chart referenced by a dashboard cannot be deleted.
- The `dashboard_views` table: the conditions carried by a share link, see 3.10.
- The `chart_revisions` and `dashboard_revisions` tables: the revision of every save, see 4.1.

### 4.1 Revision history

Status: implemented.

Each time a chart or dashboard is saved, a revision is recorded: the version number, the save time, the modifier, and the saved definition. The editor lists only the version, time and modifier, which answers "who changed it, and when"; the content of an old version cannot be viewed, nor compared or restored. The definition is stored so that there is evidence if it needs to be traced later; this time no interface or API for viewing it is built, and the database is queried directly when needed.

Comparison and restore are not done because what a chart draws also depends on the dataset it reads, and a dashboard also depends on the charts it references. For example, the dataset changes its SQL and fields, and the chart moves from v3 to v4 with it; rolling the chart back to v3 then needs the dataset of that time, so restoring the chart alone does not give what it looked like then, and the result cannot be controlled. The same holds for dashboards. A dataset can be restored because it is the most upstream, and impact analysis guards its saves ([Dataset model](dataset.md) section 9).

**What counts as a revision**

- Creation is version 1, and each successful save after that adds one; it is the same number as the revision number (`revision`) used by the save conflict check.
- Name, description and definition are saved together, and a rename is also a revision. The definition of a chart includes which dataset it reads.
- Moving to a folder, dashboard access and share links are not saves and produce no revision, the same as for datasets.
- A failed save (validation failure, save conflict) produces no revision.

**What is stored**

- `chart_revisions`: chart, revision number, name, description, dataset and the dataset revision number used for validation at save time, spec and its format version, modifier, save time. With the dataset revision number, tracing can find which version of the dataset this version of the chart was set up with at that time, and the definitions on both sides are in their own revisions.
- `dashboard_revisions`: dashboard, revision number, name, description, spec and its format version, modifier, save time.
- Written in the same transaction as the save: a successful save always has a revision. Audit is not in the transaction of the save, and a failed write is missed ([Access control and workspaces](access-control.md) section 7), so we do not rely on audit.
- Never modified after writing. A later migration of the spec format changes only the charts and dashboards themselves and does not rewrite the old definitions in the revisions: they are only for tracing, the program never reads them back for use, and keeping them as they were saved is more trustworthy. Datasets differ: their revisions can be restored, so they are rewritten along with the migration.
- All are kept, with no upper limit, and they are not cleaned up with the audit retention period.
- When a chart or dashboard is deleted, its revisions are deleted with it; the deletion itself is recorded in audit.

**The list in the editor**

- The bottom panel of the chart editor gains "Revision history" after "Used by"; the dashboard editor adds a "Revision history" section at the end of the page settings.
- Newest first, one row each: version number, save time, modifier, with the newest marked "Current". The time uses the short format "10-20 10:27", the same as the revision history of datasets, and hovering shows the full time; the properties panel of a dashboard is narrow, so a modifier name that does not fit is truncated and hovering shows the full name. For a version whose name differs from the present one, the name of that time is shown in the row below.
- Paging is the same as in the revision history of datasets, and "Load older revisions" continues it. When the list reaches the earliest record and it is not version 1, the end says "Nothing is recorded before revision N".
- The modifier shows the present name, the same as for datasets; where there is no modifier, "System" is shown.
- A new chart or dashboard that has not been saved shows "Revisions are recorded once it is saved." The list refreshes after a successful save.
- The APIs are `GET /charts/{id}/revisions` and `GET /dashboards/{id}/revisions`, whose paging parameters and per-item fields are the same as those of the revision list of datasets. There is no API to read the definition of a version. They are open only to developers and admins of the current workspace; read-only, not recorded in audit.

## 5. Permissions

| Operation | Required role |
|---|---|
| View charts and dashboards, get chart data, the candidate APIs of saved charts and dashboards | Viewer, limited to authorized dashboards and the charts on them ([Access control and workspaces](access-control.md) 4.2); candidates can only access the filter targets configured by the author |
| Export the data of a chart on a dashboard (see 2.9) | Can open the dashboard, and the chart has `allowExport` set to `true`; no distinction by role |
| Create, modify and delete charts and dashboards; data fetching and candidates for chart and dashboard drafts | Developer |

For roles see [Access control and workspaces](access-control.md) 4.1.

**Viewers fetch data through charts, not by querying datasets directly.** The "Get chart data" API runs only the query that the chart itself has saved; the caller can only attach filter values and the dynamic candidate IDs the author allows, and cannot submit an arbitrary query. This is how "if a dashboard is visible, its data is visible" in [Access control and workspaces](access-control.md) is realized: viewers cannot query datasets directly.

## 6. Explicitly not in v1

| Item | Notes |
|---|---|
| Combined filters | There is no product configuration yet for arbitrary AND/OR combinations of several filters; the query IR itself supports logic trees |
| Subqueries or standalone cross-dataset enumeration sources | Candidates can only come from the chart itself or from a widget already linked to the global filter; no external dataset or subquery can be named separately, and no union or join of candidates from several sources is done |
| Latest partition with data, trading days, working days and custom week calendars | Dates are interpreted by natural time, the query time zone and the week start day of the workspace; the latest non-empty partition is not looked up and no business calendar is maintained |
| Multi-grain selection for date filters | There is no picker yet for enumerating several grains such as year, month and week; the dynamic dimension candidates can configure the query date `grain`, which switches the grouping grain of a chart and is different from picking for a date filter |
| Global filters that target dataset parameters | Parameter filters on a chart are in 2.11; for linking parameters to global filters see [Deferred items](../backlog.md) |
| Multi-select chart links, dynamic dimension sources and more source chart types | The first version is static category single select, see 3.4 |
| Resource-level access | Folders exist but are used only for organizing; access by folder or by single resource is not done |
| Viewing, comparing and restoring old versions of charts or dashboards | Only revisions and the definitions of that time are recorded, see 4.1; datasets can be viewed, compared and restored |
| More chart types (maps, etc.) | |
| Subscriptions, embedding | |
| Export in the chart editor, exporting totals and subtotals, exporting pivot tables as cross tabs, applying display formats on export | The first version of chart export only exports the rows of the query result on a dashboard, see 2.9 |

## 7. Design trade-offs

The following trade-offs match the current implementation:

1. **Charts are saved independently and dashboards reference them**, instead of embedding chart definitions in dashboards. The benefit is reuse and separate authorization; the cost is that changing a chart affects every dashboard that references it.
2. **Global filters bind directly to fields and chart measures**; the candidate range and the take-over and restore behavior were settled in discussion with the user.
3. **The system does not create chart filters automatically**, because a dataset has no default time field.
4. **Charts and dashboards record revisions only, and old versions cannot be viewed, compared or restored** (4.1). Their results also depend on the upstream datasets and charts, and rolling one back alone does not give what it looked like at that time.
5. **A pie chart or a set of series with more than 8 items is merged into "Other"**, instead of reporting an error or generating more colors.
6. **Dynamic fields are resolved in the chart layer, and cascading narrows the options in the candidate layer.** The query layer receives only the resolved ordinary IR; dynamic fields and cascading do not create a second query executor.
7. **Combo charts allow a right axis, but the author must specify it for each series one by one.** Two value axes are easy to misread, and charting guidelines usually advise against them; users explicitly need it, so it is provided, but it is off by default, noted in the legend, and flagged by the editor.

The canvas defaults to 96 columns horizontally, a row height of 8px vertically, a column gap and a row gap of 1.5px each, 0 rows of extra vertical space around containers, and automatic upward compaction turned on. Both directions snap to the grid. The fields and ranges of `layout.grid`:

| Field | Default | Allowed range |
|---|---|---|
| `layout.columns` | 96 | 12–192, integer |
| `grid.rowHeight` | 8 | 4–64px, step 0.5 |
| `grid.columnGap` | 1.5 | 0–24px, step 0.5 |
| `grid.rowGap` | 1.5 | 0–24px, step 0.5 |
| `grid.containerGap` | 0 | 0–24 empty rows, integer |
| `grid.autoCompact` | true | boolean |

`grid` is an optional object; when it is absent, the original rendering behavior is kept, including the effect that an old 12-column spec was rendered as 96 columns, and historical coordinates are not migrated automatically. An explicit setting allows 12–192 columns. When the number of columns changes, the horizontal bounds of charts and query containers are scaled in proportion and constrained to the canvas; vertical positions and row counts stay the same, and any collision resolution that is needed belongs to the same undo operation.

`containerGap` is the number of extra empty rows kept between containers whose horizontal ranges overlap. The actual vertical gap is `rowGap + containerGap × (rowHeight + rowGap)`, and the height of a widget itself does not include this space. With automatic compaction off, blank space is kept, widgets still snap to the grid and may not overlap, and on collision they give way downward. Dragging, resizing, external drag-in, growth from content and the single-column display on narrow screens all keep the configured minimum space.

The background keeps the pale rounded blocks, drawn with the same column widths, row heights and gaps, and generated only while editing. If the horizontal gap would squeeze out the column width, the gap narrows automatically to fit the current canvas width, and the saved value does not change. A new chart is by default about half the width and 32 rows high; the minimum width is one sixth of the total columns rounded up, the minimum height is 16 rows and the maximum height is 192 rows; the minimum height of the query container is 6 rows, and its lower limit is raised according to the actual content of the controls and the padding. Editing, preview and view mode use the same configuration. Layout parameters are not part of the data dependencies of a chart, and changing them does not fetch data again.

Performance review (2026-10-16, this machine with Node 24 and the embedded browser): `node dev/benchmark-grid.mjs` reproduces the layout computation benchmark. The median layout computation for 100 widgets with the default/custom layouts is about 0.50/0.53ms; for 500 widgets it is about 10.5/11.4ms, and with compaction off about 0.51ms. In the browser, with 20 and 100 real line charts (100 points each) and 45 whole-grid row height updates per scenario, the old component and the new component were compared: the median React synchronous update time under the default configuration is about 3.5/13.8ms, against about 3.9/13.8ms before the change; updates to the next frame are about 16.8/78.2ms, against about 18.1/77.8ms before. This stress scenario includes chart redraws but not network data fetching; 100 charts being resized continuously is still heavy, so the configuration applies in one update after clicking "Apply", which avoids a full redraw on every keystroke. This is a sample from this machine in development mode, not a frame rate guarantee across devices. After the change to a separate apply button the computation benchmark was run again: for 100 widgets default/custom about 0.48/0.51ms, for 500 widgets about 10.8/11.3ms; pending input does not change the grid parameters. The patch to the layout library also detects changes of a custom compactor, which fixes the problem that the layout was not redone when only the vertical space was changed, without needing to toggle automatic compaction or rebuild the charts.

The "… → Settings" right panel of the query container can choose automatic or manual trigger, saved as the dashboard's `queryMode: "auto" | "manual"`; the default is automatic, compatible with old dashboards. Manual mode distinguishes the current input from the applied conditions: continuous input, selection, and switching between edit and preview do not refresh charts, and only clicking "Query" applies all current conditions at once. The button is disabled when nothing has changed, the input is invalid, or the reverse inference for cascading has not finished; refreshing a single chart uses the applied conditions. Filter candidate values and cascading options are still requested on demand, to support choosing conditions. A mode change goes into undo/redo and is persisted, and temporary input is not written as the default value of a filter; switching back to automatic applies the currently valid conditions. Default conditions still fetch data normally on the first page load, and deleting a filter definition also cleans up its input and applied value.

The query settings also provide a container height mode `queryHeightMode: "auto" | "manual"`, with automatic as the default. Automatic mode computes the height from the actual height of the controls, the padding and the minimum of 6 rows, so the container can grow or shrink when the width changes, content wraps, or content is added or removed, and the charts after it are compacted by the grid; dragging the right edge adjusts only the width. Manual mode keeps the specified height and the resize handle at the bottom right, while the content height still serves as the lower limit. The mode is saved with the dashboard, supports undo/redo, and applies in preview and view mode alike.

The menu of the query container offers "Reset filters" in edit, preview and view modes. It restores the defaults of all global filters at once and clears those with no default; at the same time it cancels input that has not been submitted and cascading inference. In automatic query mode it applies at once, and in manual mode it waits for a click on "Query". Reset changes neither the saved defaults nor the filter conditions of the charts themselves, and does not enter the layout undo history.
