---
title: View and share
description: Read a dashboard, keep it up to date, share it, and export its data.
---

**My dashboards** in the top bar lists the dashboards you can see. Viewers see the ones granted to them, and Developers and Admins see all of them.

## The toolbar

| Item | What it does |
|---|---|
| **Timed refresh** | Fetches data again at an interval |
| **Refresh data** | Queries the database now |
| **Share** | Gives the link to the dashboard |
| **Full screen** | Covers the whole page. Escape exits |
| **Edit** | Opens the editor, for Developers and Admins |

The left of the toolbar shows the time of the data, taken from the oldest chart. When data is fetched again, the charts stay still and a progress bar appears at the top of the card. If a refresh fails, the previous chart is kept and a notice appears beside the title, which you can click to retry.

## Chart actions

**…** at the top right of a chart holds:

- Refresh the chart.
- **Enlarge chart**, which shows the chart larger.
- **View data**, which shows its current data as a table.
- **Export data**, when the chart allows it.

Enlarge and View data use the result already fetched and do not query again. Filters changed in the enlarged view stay in effect after it closes.

## On a phone

On a screen narrower than 760px, such as a phone held upright, the list and the dashboard take turns filling the screen:

- **My dashboards** shows the list. Tap a dashboard to open it.
- Above the dashboard are a back button and the dashboard's name. The back button, or the browser's back, returns to the list, and anything typed in the filter box is still there.
- The toolbar wraps onto two lines. **Full screen** gives the dashboard the whole screen.

On wider screens the list stays beside the dashboard.

A dashboard narrower than 640px shows its charts in one column, in reading order. A card in that column is at least as tall as the author made it, and grows to show all of its content: every figure of a KPI card, the whole of a text, and all of a chart's filters. Tables and pivot tables keep their height and scroll inside it. On wider screens the dashboard is laid out as the author arranged it.

## Timed refresh

The author sets an interval in **Page settings**: 1, 5, 15 or 30 minutes, or 1 hour. A viewer can change it temporarily on the toolbar.

While the page is in the foreground, it fetches data again at that interval. If someone else just fetched the same data within the interval, that result is used, so not everyone queries the database separately. **Refresh data** always queries the database.

## Share

**Share** gives the link to the dashboard. The link grants no access: someone who cannot see the dashboard gets a notice that says so. If the dashboard is in another workspace, the page offers to switch.

When the filters, chart links or dynamic selections differ from the defaults, you can tick **Include the current conditions**, and set **Conditions valid for**: 1, 7, 30 or 90 days, 30 by default. Each validity period has its own link, so a link copied earlier keeps the period it was copied with. **Conditions to include** can cover global filters, chart filters, chart links, dimensions and measures, drill-down, and the page and tabs shown.

The conditions are stored on the server, and the link carries only a short ID. After they expire, the link opens with the default conditions.

## Export chart data

When a chart has **Allow data exports** on, anyone who can open the dashboard can export its complete data under the current filters, from **Export data** in its **…** menu. This is the same for every role, and when it is off nobody can export the chart from a dashboard.

1. Choose the **File format** and **File name**, and click **Start export**.
2. Leave the page if you like. The job runs in the background.

The export runs against the saved dashboard, so in the editor, save first. It follows row and column permissions, and contains the rows of the query rather than what the chart draws:

- Values are raw, without display formats. XLSX keeps numbers and dates as such, so you can go on calculating in Excel.
- A pivot table exports flat rows, not a cross-tabulation. Totals and subtotals are not exported.
- Hidden columns are left out. "Most rows shown" still applies, so a top 10 exports 10 rows.

## Exports

**Exports** in the top bar lists your export jobs from every workspace you can enter, whichever one you are in, with a badge for new results. When you can enter more than one workspace, each job starts with the name of the workspace it was made in. There you can **Download** a finished file or **Cancel task** on a running one, without switching workspace.

Closing the page or signing out does not cancel a job. Every download checks your permissions in the workspace the export was made in, and is recorded in the audit log. The exports of a workspace you can no longer enter leave the list. By default a finished file is kept for 24 hours and job records for 30 days.
