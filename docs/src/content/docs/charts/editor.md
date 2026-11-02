---
title: Chart editor
description: Put fields on a chart, filter it, calculate on it, and let viewers change it.
---

A chart reads one [dataset](/data/datasets/). Click **New chart** on a dataset, or go to **Workbench → Charts** and click **New chart**. Developers and Admins can create and change charts.

The fields of the dataset are on the left. **Chart type** and the style options are next to them. On the right are the bars you drop fields on, with the preview below. The panel at the bottom holds **Data**, **Query diagnostics**, **Show the chart definition**, **Used by** and **Revision history**.

## Put fields on the chart

Drag a field from the left onto a bar, or click it to add it at the end. Which bars appear depends on the [chart type](/charts/types/): most have **Dimensions** and **Metrics**, a detail table has **Columns**, and a pivot table has **Rows** and **Columns across**.

With **Run automatically** on, the preview updates after every change. Otherwise click **Run**.

Drag a field within its bar to reorder it, or use **Move earlier** and **Move later** in its menu. When a field has focus, Alt+← and Alt+→ do the same. The order is the order of the columns the query returns.

A date dimension is grouped by **Time grain**, the row below the bars: year, quarter, month, week or day.

Click a field for its menu:

| Option | Meaning |
|---|---|
| **Sum**, **Average**, **Minimum**, **Maximum**, **Count**, **Distinct count** | How a measure is aggregated. Text and dates have only the last four. Measures start as a sum, and a dimension dragged onto **Metrics** starts as a distinct count. A dataset [metric](/data/datasets/#calculated-fields) has no choice here |
| **Add an alias** | A name for this field on this chart only |
| **Ascending**, **Descending** | Sort by this column. With several sorted columns, the earlier ones take priority. With none, rows are sorted by the dimensions in turn |
| **Measure calculation** | See [below](#measure-calculation) |
| **Drill-down…** | See [below](#drill-down) |
| **Display format…** | See [below](#display-format-and-style) |

Under **General**, **Most rows shown** limits the rows the chart reads, 1,000 by default and at most 10,000 unless a system administrator [changes the limits](/admin/system/#general-settings). Sorting by a metric and limiting the rows makes a top 10.

## Filters

A filter limits the rows a chart reads. Drag a field onto **Filters** to open **Filter settings**. Nothing is filtered for you: a dataset has no default time field, so add the filters each chart needs. Several filters on a chart all have to hold.

- With **Show as chart filter** off, it is a fixed condition, and viewers neither see nor change it.
- With it on, it appears above the chart with a **Label** and a **Control**, and its value is the default. Trying a value in the editor preview does not change the default.

The conditions and controls depend on the field:

| Field | Conditions | Controls |
|---|---|---|
| Text, integer, Boolean | is any of, is none of | **Dropdown**, **Search and dropdown**, **Tiled choices** |
| Text | contains, starts with, matches pattern and others | **Search box** |
| Number | is between, is outside | **Number range** |
| Number | is, is greater than and others | **Number** |
| Date, timestamp | is within | **Single date**, **Calendar (from and to)**, **Date range** |

A date range can be **Relative dates** such as the last 30 days, **Fixed dates**, **Advanced** bounds where each end is fixed, relative or unbounded, or **Special values** such as **Null dates**.

In a pattern, `%` stands for any length of text and `_` for one character.

**Filter scope** matters for measures. **Detail rows** filters the rows before they are grouped. **Aggregate results** filters each group after it, for example regions with a total of at least 1,000, using the **Aggregation** you choose.

### Cascading filters

**Parent filters** makes one filter's options depend on another, so that choosing a province narrows the cities. Only filters that pick exact values can cascade.

## Measure calculation

**Measure calculation** in the menu of a numeric measure works something out from the aggregated values:

| Option | Meaning |
|---|---|
| **Original value** | No calculation |
| **Grand total** | The share of the total of all rows |
| **Within groups** | The share within groups; choose which dimensions group the denominator |
| **Period comparison** | Compares with an earlier period |
| **Running total** | Adds the values up along one dimension |

For **Period comparison**, choose the **Time field** and the **Current period**, then **Year over year** or **Previous period** with the number of periods and the **Time unit**. The **Calculation result** is the **Previous value**, the **Difference** or the **Growth rate**.

For **Running total**, choose the dimension in **Run along**. The total starts at the beginning of the filter range and does not include earlier data, and it starts over within each of the other dimensions. It works on sums, counts, minimums and maximums, not on averages, distinct counts or dataset metrics.

## Dynamic dimensions and metrics

A dynamic field lets viewers switch what a chart groups by or computes, without a chart for each. Use **Add dynamic dimension** or **Add dynamic metric** in the field list, give it a **Display name**, and add its **Candidate fields**. Viewers then get a control on the chart.

**Allow no dimension** lets viewers remove the grouping. A chart can have up to 16 dynamic fields, each with up to 64 candidates. Detail tables do not support them.

## Drill-down

Drill-down lets viewers click a value and go one level deeper along a path you set. **Drill-down…** in the menu of a dimension opens the levels: the first is the dimension itself, and **Add the next level** adds a field, and a grain for dates.

```text
Region → Province → City
Order time by year → by quarter → by month → by day
```

- It works on the category of bar, horizontal bar, line, area, combo and pie charts, and on any dimension of an aggregated table.
- A chart has one drill-down, with up to 8 levels counting the first.
- For a date, each level must fit inside the one before, so a week cannot follow a month.
- The levels are stored in the chart, not the dataset.

The dimension gets a **Drill** tag. You can click through it in the editor preview. See [how viewers use it](/dashboards/interaction/#drill-down).

## Display format and style

**Display format…** overrides the [format of the dataset](/data/datasets/#display-format) for this column on this chart. **Follow the dataset** sits beside the other styles and goes back to it.

The options on the left depend on the chart type:

| Group | Options |
|---|---|
| **Style** | For example **Stacked**, **Stack to 100%**, **Smooth lines**, **Show data points**, **Widest bar (pixels)** |
| **Legend and labels** | **Legend** position, **Show values on the chart** |
| **Colors** | A **Palette**, and the color of each metric. Colors come from 8 hues chosen to stay distinguishable |
| **Axes** | **Title**, **Minimum**, **Maximum**, **Hide grid lines**, **Hide labels**, **Label angle** |

With more than 8 series or slices, the first 7 are kept by size and the rest are merged into "Other".

## Query diagnostics

**Query diagnostics** shows the SQL and bound parameters of the query, its totals and subtotals, with the time, cache status and whether the result was cut off. It is for Developers and Admins, and is requested one query at a time.

## Save

**Save** is enabled once there is something to save. Every save adds an entry to **Revision history**, which lists the version, time and author. Charts cannot be compared or restored there, because what a chart draws also depends on its dataset. If someone else saved first, see [Save conflicts](/data/datasets/#save-conflicts).

**Allow data exports** under **General** lets anyone who can open a dashboard [export this chart's data](/dashboards/view-and-share/#export-chart-data). It is off by default, and when off nobody can export the chart from a dashboard.
