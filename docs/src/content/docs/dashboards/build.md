---
title: Build a dashboard
description: Arrange charts, titles, text, tabs and pages on a dashboard.
---

A dashboard arranges charts on a page. Go to **Workbench → Dashboards** and click **New dashboard**. Developers and Admins can create and change dashboards.

A dashboard refers to saved charts and does not hold copies, so changing a chart changes it on every dashboard that uses it.

The top bar has the name, undo and redo, **Page settings**, **Preview** and **Save**. The toolbar on the left has **Charts**, **Title**, **Text**, **Pages**, **Filters** and **Chart links**. Filters and links have a page of their own: [Filters, links and drill-down](/dashboards/interaction/).

## Add charts

In the **Charts** panel, click **+** beside a chart, or drag it onto the canvas. Drag a widget by its title bar to move it, and drag its lower right corner to resize it. Click the pencil beside the name to rename the dashboard.

Clicking a widget selects it, and **…** at its top right holds its actions. Up to 100 steps can be undone with Ctrl/⌘+Z and redone with Ctrl/⌘+Shift+Z.

## Titles and text

A dashboard does not always show its name when viewed. **Title** adds one: by default it shows the name and description of the dashboard and follows when it is renamed, or you can write your own title and subtitle.

**Text** holds notes, definitions and conclusions in Markdown, with lists, tables and links. HTML in it is shown as text, links can only be http, https or mailto, and images are not shown.

Titles and text fetch no data and take no part in filters or chart links.

## Widget appearance

Every widget is a container. Under **Appearance** you can set:

- **Background**: light grey, one of the 8 colors of the palette, or a **Custom color**, with one each for the light and dark themes.
- **Transparency**, **Show border** and **Padding**.

A chart or text without its own setting follows **Default widget appearance** in **Page settings**. Titles can be aligned left, center or right, and top, middle or bottom.

A chart container can also have a **Display name** used only on this dashboard, a **Note** shown as a question mark in the title bar, and **Hide header** for viewing.

## Empty containers

**Empty chart container**, at the top of the chart library, lets you lay out the page first and add charts later. Drag a chart onto a container and it goes in; if the container already holds a chart, it replaces that chart once you confirm. **Take out chart** empties the container again.

## Tab containers

A tab container holds several charts in one spot, and viewers click a tab to switch. Click **Add tabs** in the **…** menu or the properties panel of a chart container. The chart becomes the first tab and keeps its filter mappings and chart links.

- Each tab has its own name and **Note**, and maps global filters, takes part in chart links and exports separately.
- In the tab list, the star sets which tab is **Shown first**. Drag the handle on the left, or use the arrow keys, to reorder.
- Dragging a chart from the library onto the tab strip adds a tab there.
- When viewing, only the current tab fetches data, and an empty tab is not shown.
- With one tab left, it becomes a plain chart container again.

## Pages

A dashboard can be split into several pages. **Pages** on the left splits it into two: titles, text and query containers above the charts move into a **Shared area** shown on every page, and the rest goes on the first page.

- Click **+** at the right of the tab strip to add a page, and the settings button to rename, reorder or delete pages.
- **Move to** in the **…** menu of a widget moves it to another page or to the shared area. You can also drag between the shared area and the current page.
- Global filters stay in one query container. Each page shows the filters linked to charts on it or in the shared area, and a value changed on one page applies on the others.
- When viewing, only pages that have been opened fetch data. The current page is in the address as `?page=`.
- With one page left, the dashboard is unpaged again.

## Page settings

**Page settings** holds:

- **Basic information**: the name and description.
- **Canvas layout**: **Grid columns**, **Cell height (px)**, the gaps between cells, and **Compact upward automatically**.
- **Timed refresh**: see [Timed refresh](/dashboards/view-and-share/#timed-refresh).
- **Default widget appearance**.

## Save and grant access

**Preview** shows the dashboard as viewers see it. **Save** saves it, and checks the version like any other [save](/data/datasets/#save-conflicts).

After the first save, **Access** appears. Viewers see only the dashboards granted to them, so a new dashboard is hidden from them until you choose the users, groups or **Every member** who can see it. Developers and Admins see every dashboard.

In the Workbench, dashboards, charts and datasets each have their own folders, made with **New folder** and filled with **Move to…**. Folders are only for organizing: they do not affect permissions, and a folder must be emptied before it can be deleted.
