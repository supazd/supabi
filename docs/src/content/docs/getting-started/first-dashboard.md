---
title: Build your first dashboard
description: Connect a database, write a query, and turn it into a dataset, a chart and a dashboard.
---

Everything in SupaBI starts from a query. You connect a database, write SQL, save it as a dataset, and build charts and dashboards on the dataset.

This guide uses the sample data from [Try it on your machine](/getting-started/install/#try-it-on-your-machine). To use your own database, change the connection details and the SQL. You need the Developer or Admin role, and the administrator account has it.

## Add a data source

1. In the top bar, open **Workbench**, and choose **Data sources** on the left.
2. Click **Add data source** and choose **PostgreSQL**.
3. Fill in the form:

   | Field | Value |
   |---|---|
   | Name | `Sample` |
   | Host | `127.0.0.1` |
   | Port | `15432` |
   | Database | `supabi` |
   | User | `supabi_demo` |
   | Password | `demo` |
   | Data time zone | `Asia/Shanghai` |

4. Click **Test connection**. When it says **Connected**, click **Save**.

The page of the data source now lists its tables.

:::tip
For your own database, use a read-only account. **Data time zone** is the zone of timestamps that the database stores without one.
:::

## Write a query

1. In the top bar, open **Data exploration**. The tables of the data source are on the left.
2. Paste this SQL and click **Run**, or press Ctrl+Enter (⌘+Enter on a Mac):

   ```sql
   SELECT o.created_at, r.name AS region, p.category, o.channel, o.quantity, o.amount
   FROM demo.orders o
   JOIN demo.regions r ON r.id = o.region_id
   JOIN demo.products p ON p.id = o.product_id
   ```

The result appears below the editor. It shows the first 1,000 rows; a chart built on this query reads all of them.

## Create a dataset

1. Click **Create dataset** on the toolbar. The dataset opens in a new browser tab, so allow pop-ups if your browser asks.
2. Look at **Fields** on the left. SupaBI has already sorted the columns: `quantity` and `amount` are measures, which charts can add up, and the others are dimensions, which charts can group by.
3. Enter `Orders` as the name and click **Save**.

## Make a chart

1. Click **New chart** at the top right of the dataset.
2. Under **Chart type**, choose **Bar**.
3. Drag `region` onto **Dimensions** and `amount` onto **Metrics**. The chart appears straight away, with `amount` summed as `SUM(amount)`.
4. Enter `Sales by region` as the name and click **Save**.

## Make a dashboard

1. In **Workbench**, choose **Dashboards** on the left and click **New dashboard**.
2. In the **Charts** panel on the right, click **+** beside `Sales by region`.
3. Click the pencil beside the name, enter `Sales overview`, and press Enter.
4. Click **Save**.

The dashboard is now under **My dashboards** in the top bar.

## Share it

Viewers see only the dashboards granted to them, so a new dashboard is hidden from them until you grant it:

1. In the dashboard editor, click **Access**. It appears once the dashboard is saved.
2. Choose the users or groups who can see it, or **Every member**.

To send someone the dashboard, open it under **My dashboards**, click **Share** and copy the link. The link grants no access: only people who can open the dashboard can see it.

## Next

Read the [core concepts](/concepts/overview/) to see how workspaces, roles and data permissions fit around what you just built.
