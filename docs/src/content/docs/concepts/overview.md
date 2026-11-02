---
title: Core concepts
description: How data sources, datasets, charts, dashboards, workspaces and roles fit together.
---

Each thing in SupaBI is built on the one before it:

```text
Data source → Dataset → Chart → Dashboard
```

## Data source

A connection to a database. SupaBI connects to PostgreSQL, MySQL, ClickHouse, Apache Doris, StarRocks and Trino. Passwords are stored encrypted and are never shown again.

## Dataset

A SQL query with its fields described, so that a chart can use them by name. Each field is one of three kinds:

| Kind | What it is | Example |
|---|---|---|
| Dimension | A value to group or filter by | `region`, `created_at` |
| Measure | A number on each row, which a chart aggregates | `amount`, with `SUM` |
| Metric | A value that is already aggregated in its own expression | Sales per buyer |

A dataset is also where data permissions live: under **Data permissions** you limit which rows and fields Viewers see on dashboards.

## Chart

One way of looking at a dataset: a chart type with the fields it shows and its filters.

## Dashboard

A page of charts. It can also hold titles, text, tabs and several pages, with filters that apply across charts and chart links that let a click on one chart filter the others.

## Workspace

Data sources, datasets, charts and dashboards each belong to one workspace, usually one for a team or a line of business. Nothing can be referenced across workspaces. The first workspace is created for you and is named `Default`.

## Roles

A member has one role in each workspace, and a higher role can do everything a lower one can:

| Role | For | Can |
|---|---|---|
| Viewer | Business users | See the dashboards granted to them, use their filters and chart links, and export chart data where the author allows it |
| Developer | Analysts and report builders | Also connect data sources, write SQL, and make datasets, charts and dashboards |
| Admin | Workspace owners | Also manage members and workspace settings |

Add members under **Workspace settings → Members and access**.

:::caution
A Developer can write SQL against every data source in the workspace, so they can read whatever the connection account of a data source can read.
:::

A **system administrator** manages accounts, groups and workspaces under **System administration**, and is an Admin in every workspace. The account you create at the first start is one.
