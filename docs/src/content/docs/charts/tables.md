---
title: Tables
description: Aggregated and detail tables, pivot tables, and what you can do with their columns.
---

The **Table** type has two modes, chosen below the chart types:

| Mode | Fields | Result |
|---|---|---|
| **Aggregated** | Dimensions and metrics | One row per group |
| **Detail** | **Columns** | The rows of the dataset as they are |

## Totals

**Show totals** under **Table style** adds a total row to an aggregated table. The database computes totals the way each metric aggregates, over all the data, whatever the row limit, so totals of averages and distinct counts are correct. A chart that filters on aggregated results shows no totals, because they would be ambiguous.

## Table style

| Option | Meaning |
|---|---|
| **Striped rows** | A background color on alternate rows |
| **Freeze the first column** | The first visible column stays put when scrolling sideways |
| **Merge equal values** | See below |
| **Pages** | See below |
| **Row height** | **Dense**, **Standard** or **Roomy** |

Drag the right edge of a header to set a column's width, and use **Back to automatic widths** to undo it.

The menu of a column also has **Align left**, **Center** and **Align right**.

## Hide a column

**Hide in table** in the menu of a column keeps it in the query and takes it off the table, for example a dimension needed for sorting. It still takes part in grouping, sorting and calculations, and the editor marks it **Hidden**. The same menu shows it again. At least one column must stay visible.

## Merge equal values

**Merge equal values** merges equal values next to each other in a dimension column into one cell.

- Rows are not reordered for merging, so sort by the columns to merge first.
- A column merges only within the merged cells to its left.
- Measures and total rows are not merged.

## Pages

**Pages** has three choices: **Show all**, **Pages** with **Rows a page** (20 by default), and **Automatic**, which fills the height of the card.

Paging turns through the rows already read, so **Most rows shown** is the most rows that can be paged and turning a page does not query the database. The total row is on every page, and the page returns to 1 when a filter changes.

## Group headers

Headers can be grouped, like merged cells above a header in a spreadsheet:

1. In the editor, click one header, hold Shift and click another.
2. Click **Group** above the table and enter a name.

Groups can hold groups, up to three levels. Double-click a group name to rename it, and **Ungroup** removes one level. Grouping changes only the headers: exports still have one row of column names.

## Conditional format

**Conditional format…** in the menu of a numeric column shades cells by value, to mark the numbers that need attention. Each rule has a **Condition**, a **Value**, a **Color** and an optional **Icon**.

- A column has 1 to 5 rules, read from the top, and the first that holds is used. So order them as "below 0.8", "below 1", "at least 1".
- Rules compare the raw value, not what is displayed. A ratio shown as 80% is 0.8.
- Icons help people who cannot tell red from green.
- Total rows are not shaded, and exports carry no colors.

## Pivot tables

A **Pivot table** has **Rows**, **Columns across** and **Metrics**. Equal values of an outer dimension are written once.

**Show totals** adds the total of each row and column. **Show subtotals** appears once totals are on and rows or columns have two or more dimensions. The database computes both, so they are correct for any aggregation.

Pivot tables do not page and do not merge, since their row dimensions already span.
