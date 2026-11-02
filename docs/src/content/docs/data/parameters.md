---
title: Parameters
description: Pass values into the SQL of a dataset, for the cases a filter cannot handle.
---

A parameter is a value written into the SQL of a dataset. Most of the time you do not need one.

## Filter or parameter

To narrow the range, return the column and use a [filter in the chart](/charts/editor/#filters). The condition is added outside the dataset SQL, and the database pushes it into the query. Use a parameter only when a filter cannot do the job:

| Case | Example |
|---|---|
| The same value is used in several places in the SQL | Two snapshot tables joined, each needing `dt` to be the same day |
| Exactly one value is required | A table where every `dt` is a full snapshot, so several days would count everything twice |
| The condition must apply before aggregation, and the column is not returned | Each user's latest order as of a given day |
| The value takes part in a calculation | Account age as of a cut-off date, or an exchange rate |

## Write a parameter

Parameters are written in [Data exploration](/data/exploration/):

```sql
SELECT id, amount
FROM demo.orders
WHERE status = {{status}}
  [[AND channel = {{channel}}]]
```

- `{{name}}` is a parameter. It stands for a value by itself and takes no quotes. The name uses lowercase letters, digits and underscores, and cannot start with a digit.
- `[[ ... ]]` is an optional part: when its parameter has no value, the whole part is removed.
- A parameter that takes several values is written `IN {{name}}`, with no parentheses.
- Inside a string or a comment, `{{name}}` is plain text, not a parameter.

The parameter is passed to the database as a bound value, so it can replace a value but not a table or column name.

## Set it up

When the SQL has parameters, **Parameters** appears on the right of the editor, with one entry for each:

| Setting | Meaning |
|---|---|
| Display name | What people see. It defaults to the parameter name |
| Type | Text, Integer, Decimal, Boolean, Date or Timestamp |
| **several** | The parameter takes several values |
| **Required** | It must have a value |
| Default | Used when no value is given. A date can be relative, such as `today` or `today-1d` |

A parameter needs a value if it is **Required** or written outside `[[ ]]`. If it has no default in that case, every query has to pass one.

These settings are saved with the dataset. **Create dataset** and **Apply and return to dataset** carry them along with the SQL.

## Use it in a chart

The parameters of a dataset are at the bottom of the field list in the chart editor. Drag one to **Filters**, or click it, to open **Parameter settings**:

- With **Show as chart filter** off, it is a fixed value, and viewers neither see nor change it.
- With it on, choose **Typed in** for a box viewers fill in, or **Dropdown** for options you list. The options are written by hand, at most 500.

The default follows the dataset until you change it in the chart. **Use the dataset’s default** goes back.

Viewers see the controls on the chart in the editor preview, on dashboards and in the enlarged view. When a parameter is written inside `[[ ]]`, clearing the control means no limit. When the SQL cannot do without it, the control cannot be cleared.

## Limits

- [Global filters](/dashboards/interaction/#global-filters) cannot be linked to parameters yet.
- A share link carries the values of parameters, like other chart filters.
- Period comparison shifts time filters but not parameters, so if a parameter is a business date, both periods read that same day.
