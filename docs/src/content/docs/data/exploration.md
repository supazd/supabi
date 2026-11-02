---
title: Data exploration
description: Write SQL against a data source, look at the results, and turn a query into a dataset.
---

**Data exploration** in the top bar is where you write SQL against a data source. Developers and Admins can use it.

## Run a query

Choose the data source at the top left. Its tables are listed below, and clicking a table name puts it into the SQL.

Write one `SELECT` statement in the data source's own syntax, and click **Run** or press Ctrl+Enter (⌘+Enter on a Mac). If part of the SQL is selected, only that part runs.

The panel below the editor has four tabs:

| Tab | Shows |
|---|---|
| **Result** | The rows. At most 1,000 are shown; use `WHERE` to narrow the result and see the others |
| **Columns** | The name and database type of each column |
| **Plan** | How the database would run the SQL. Click **Query plan** on the toolbar; nothing is run |
| **History** | The SQL you have run |

**Format** tidies the SQL, and **New query** opens another tab.

:::note
Query tabs, drafts and history stay in the current browser, separated by account and workspace. They do not follow you to another browser. To keep a query for good, save it as a dataset.
:::

## Create a dataset

Click **Create dataset** on the toolbar. The dataset opens in a new browser tab with the current SQL, so allow pop-ups if your browser asks. See [Datasets](/data/datasets/).

SQL and [parameters](/data/parameters/) belong to the dataset. To change them later, open the dataset and choose **Edit SQL in data exploration**. **Apply and return to dataset** updates the draft of the form you came from, and the change takes effect once you save the dataset.

## Export the results

**Export SQL results** writes the whole result to a CSV or XLSX file, without the 1,000-row limit.

1. Click **Export SQL results**. If part of the SQL is selected, only that part is exported.
2. Choose the **File format** and the **File name**, and click **Start export**.
3. Leave the page if you like. The job runs in the background, and the **Exports** button in the top bar shows a badge when the file is ready.

An export saves a snapshot of the SQL and its parameters, and runs it again in the background. By default one export is at most 2 million rows, 512 MB and 15 minutes, and the file is kept for 24 hours. A system administrator can change these under [General settings](/admin/system/#general-settings). XLSX splits a result that does not fit on one worksheet, and keeps long numbers and high-precision decimals as text.
