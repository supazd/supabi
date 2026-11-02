---
title: Filters, links and drill-down
description: Let viewers narrow a dashboard, click from chart to chart, and look further down.
---

Charts can have [their own filters](/charts/editor/#filters). On a dashboard there are three more ways to change what is shown, and viewers can use them all.

## Global filters

A global filter applies to several charts at once. It lives in the query container at the top of the dashboard.

1. Click **Filters** on the left of the editor, then **Add global filter**.
2. Under **Charts and fields**, tick the charts it applies to and choose the field in each. The same field of the same dataset is suggested for you. Different datasets are mapped by hand.
3. Choose the condition, the control and the **Default value**. A global filter on a date field is the time range of the dashboard, and its charts may use different date fields.
4. **Options from** chooses which chart's field supplies the dropdown.

**A global condition replaces a chart filter on the same field**, both its condition and its value. The chart's own control stays but is greyed out. An empty global value means no restriction. Chart filters on other fields stay in effect.

To opt out while viewing, a chart has **Use chart filters**, which ignores global filters and brings its own back. **Restore global filters** undoes that. This is not saved.

Under the settings of the query container, **Trigger mode** is **Automatic**, where each change queries at once, or **Manual**, where viewers press **Query**. **Reset filters** returns everything to the defaults.

**Parent filters** makes global filters [cascade](/charts/editor/#cascading-filters), and global filters cannot be linked to [parameters](/data/parameters/) yet.

## Chart links

A chart link lets a click on one chart filter others.

1. Click **Chart links** on the left of the editor, then **Add link**.
2. Under **Link source**, choose the **Source chart** and the **Clicked field**.
3. Under **Link targets**, add charts and choose the **Target field** in each. Each target chart maps one field, and fields of different datasets are mapped by hand.

A source can be the category of a bar, horizontal bar or pie chart, a dimension of an aggregated table, or a column of a detail table. Pivot tables, total rows and the "Other" slice cannot be sources.

To use a link, click a value and choose **Link charts** from the menu. Clicking the same value offers **Unlink charts**. The top of the dashboard lists the **Active links**, which can be cancelled one by one. A link uses the raw value, not the displayed text, and several links all have to hold.

## Drill-down

If a chart has [drill-down](/charts/editor/#drill-down), click a value and choose **Drill down to** the next level. A line above the chart then shows where you are, such as **Drilled down:** Region › East China › Jiangsu. Click a part of it to go back.

- Drill-down changes only this chart, and does not filter others.
- The position is kept when a filter, chart link or dynamic selection changes, and through a refresh, so a level with no data shows as empty. **Reset filters** returns to the first level.
- A chart that is both a drill-down and a link source can link only at the first level.
- The enlarged view shares the drill-down position, and exports contain the level you are looking at. A share link can carry it.
- On a line, area or combo chart, a click anywhere above a category counts.

## How conditions combine

All of these narrow the data together, with "and":

1. The dataset's SQL and its [row permissions](/admin/data-permissions/), which always hold.
2. The chart's filters, except those replaced by a global filter.
3. Global filters.
4. Chart links.
5. Drill-down.

Viewers can only pass values to filters, links and dynamic fields the author set up. They cannot write their own conditions.
