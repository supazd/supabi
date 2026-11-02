---
title: Chart types
description: The 15 chart types, what each one needs, and the options special to it.
---

Choose a type under **Chart type**. Each one needs certain fields, and the editor says what is missing.

| Type | Needs | Use it for |
|---|---|---|
| **Bar** | 1 dimension and 1 or more metrics, or 2 dimensions and 1 metric | Comparing categories |
| **Horizontal bar** | The same as bar | Long category names, rankings |
| **Line** | The same as bar | Change over time |
| **Area** | The same as bar | Change over time, with totals |
| **Combo** | 1 dimension and 2 or more metrics | Two measures with different scales |
| **Scatter** | 1 or 2 dimensions and 2 or 3 metrics (across, up, bubble size) | How two numbers relate |
| **Pie** | 1 dimension and 1 metric | Shares of a whole |
| **Funnel** | 1 dimension and 1 metric | Steps of a process |
| **Treemap** | 1 or 2 dimensions and 1 metric | Shares across many categories |
| **Heatmap** | 2 dimensions and 1 metric | A value across two dimensions |
| **Gauge** | 1 metric, and another as the target if wanted; no dimension | One value against a scale or target |
| **KPI** | 1 or more metrics and no dimension | Headline numbers |
| **Table** | Any fields | Exact values, see [Tables](/charts/tables/) |
| **Pivot table** | 1 or more dimensions, in rows or columns, and 1 or more metrics | Cross-tabulation, see [Tables](/charts/tables/#pivot-tables) |
| **Sankey** | 2 to 4 dimensions (the levels, left to right) and 1 metric | Flows between stages |

## Bar, line and area

With 2 dimensions, the second splits the values into series, one per value, and there can be only one metric. Bars and areas can be **Stacked**, and **Stack to 100%** shows each category as shares, with the original values in the tooltip. Stack only quantities that can be added up.

All metrics share one value axis, so metrics of very different size belong in separate charts or in a combo chart.

## Combo

Each metric is drawn as a bar or a line, chosen under **Draw as**. A metric set to **Right axis** reads the second axis on the right, and its name in the legend says so. This is the one chart with two value axes.

## Scatter

The first metric is the horizontal position, the second the vertical, and the third, if any, the bubble size. A second dimension colors the points. **Name each point** writes the name beside it.

## Pie, funnel and treemap

Pie charts are donuts unless **Solid (no hole in the middle)** is on. A funnel sorts from largest to smallest and merges nothing into "Other". A treemap with a second dimension groups its blocks and gives each group one color.

## Gauge

The gauge reads the first row of the result. With a second metric, that is the target: the scale ends at it, and the text below says how much of it is reached. Without one, set **Minimum** and **Maximum**, or the scale runs from 0 to the value rounded up.

## KPI

Each metric gets a card, from the first row of the result. Under **KPI style** you can set the **Alignment** and **Size**.

**Compare with** pairs one metric with another, for example revenue with its target. The metric compared against gets no card of its own, and the card shows the change below the number. **Show the comparison as** chooses **Percent change**, **Difference** or **Difference and percent**, and **Rises in red, falls in green** swaps the colors.

## Sankey

Each dimension is a level, in order from left to right, and the metric is the flow between neighbors. **Paths that end early** decides where a path stops if it does not reach the last level.
