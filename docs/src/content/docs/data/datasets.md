---
title: Datasets
description: Describe a query once, so that every chart reads the same fields.
---

A dataset is a SQL query with its fields described. Charts read datasets, not tables, so a name, a calculation or a permission set on the dataset applies to every chart on it.

New datasets are made from SQL: write a query in [Data exploration](/data/exploration/) and click **Create dataset**. Developers and Admins can create and change them. A saved dataset opens read-only; click **Edit** to change it.

## Fields

SupaBI reads the columns of the query and suggests a field for each one. Numbers become measures and the rest dimensions, except that a number named `id` or ending in `_id` is taken as a dimension.

| Kind | What it is | Example |
|---|---|---|
| **Dimension** | A value to group, filter and sort by | Region, order time |
| **Measure** | A number on each row, aggregated when put on a chart | Order amount |
| **Metric** | A number already aggregated in its own expression | Sales per buyer |

Click **Edit**, then open **Field details** to change each field:

- **Name** is the only name people see, and can change at any time. Charts keep working after a rename.
- **Description** explains the field. The AI assistant reads it too.
- **Make measure** and **Make dimension** switch a number between the two kinds. Text and dates can only be dimensions.
- **Hidden** takes a field out of the field list of charts. Charts that already use it keep working. This is not a permission; for that, use [data permissions](/admin/data-permissions/).
- **Duplicate** gives one column a second field, for example `User ID` as a dimension and a copy of it as a measure counted distinct.

## Calculated fields

**New calculated field** adds a field worked out by an expression instead of read from a column. Refer to other fields as `${name}`, and click **Try it** to see the result on the first rows:

```sql
CASE WHEN ${Order amount} >= 1000 THEN 'High' WHEN ${Order amount} >= 100 THEN 'Medium' ELSE 'Low' END
```

**New metric** adds a field that aggregates in its own expression. Use one for ratios, weighted averages and any number that has only one right way to be computed, so that every chart gets it the same way:

```sql
SUM(${Order amount}) / NULLIF(COUNT_DISTINCT(${User ID}), 0)
```

A chart uses a metric as it is and cannot aggregate it again. See [Expressions and functions](/data/expressions/) for what you can write.

## Display format

In **Field details**, a number or date field can carry a format, which decides how it is written in tables, axes, labels and tooltips. It changes how a value looks, not the value: filters, sorting and exports still use the raw value. A chart can [override it per column](/charts/editor/#display-format-and-style).

For numbers:

| Option | Meaning |
|---|---|
| **Style** | **None** shows the value as it is. **Number** applies the options below. **Percentage** shows a ratio as a percentage, so 0.2345 shows as 23.45% |
| **Decimal places** | A fixed number of places. **Automatic (up to 2)** drops trailing zeros |
| **Thousands separator** | The separator follows the interface language |
| **Unit** | Divides the value first: thousands, 万, millions, 亿 or billions. **Automatic** picks a unit for each value, 万 and 亿 in Chinese and K, M and B in English |
| **Prefix**, **Suffix** | Up to 16 characters each, such as ¥ or 元 |

With the unit 万, two decimal places, the prefix ¥ and the suffix 元, the value 1234567.891 shows as ¥123.46万元.

For dates:

| Option | Meaning |
|---|---|
| **Writing** | **Dashes** (2026-01-05), **Slashes** (2026/01/05) or **Chinese** (2026年1月5日) |
| **Time when not grouped** | How far an ungrouped timestamp is written: **To the second**, **To the minute** or **Date only** |
| **Grouped by week** | **First and last days**, **First day** or **Week number** |

## When the SQL or the tables change

To change the SQL, click **Show SQL** and then **Edit SQL in data exploration**. When the tables changed but the SQL did not, click **Sync fields**. Either way, SupaBI compares the fields with the columns the query returns now:

- A new column gets a new field.
- A field whose column is gone is marked **no longer exists**. **Point at another column** keeps its name and everything that refers to it, which is what you want when a column was renamed. Otherwise delete the field. A dataset with such a field cannot be saved.

When you save, SupaBI runs the query and the expressions once with no rows, to catch errors. If a change affects charts, for example a deleted field, it lists them and asks you to confirm. A field that a data permission rule refers to cannot be deleted.

## Revision history

Every save creates a revision. Under **Revision history** you can see each revision, compare any two, and **Restore as draft**. A restored definition takes effect only after you save it, which checks it like any other save and creates a new revision. Data permissions are kept apart and are not restored.

## Save conflicts

Datasets, charts and dashboards all check the version when saving. If someone else saved first, your save is rejected and your draft is kept. **Review changes** shows the **Original content**, **My draft** and the **Latest saved content** together:

- Changes that do not collide are merged for you.
- Where both sides changed the same thing differently, you choose. On a dataset, name, display format, description and hidden state are compared property by property. A change to a field's type, expression or column is handled as a whole field.

**Apply to draft** only updates your draft. Review it, and save again.

## What reads a dataset

**Used by** lists the charts and dashboards that read a dataset. **Data lineage** in the Workbench shows the whole picture as a map, from data sources and tables through datasets and charts to dashboards. Turn on **Only what nothing reads** to find what can be cleaned up.

Lineage finds tables by reading the names after `FROM` and `JOIN` in the SQL, so it knows which tables a dataset reads, not which columns.
