---
title: Data sources
description: Connect the databases that SupaBI reads.
---

A data source is a connection to one database. It belongs to one workspace, and Developers and Admins manage it under **Workbench → Data sources**.

## Supported databases

| Kind | Database | Version |
|---|---|---|
| Transactional | PostgreSQL | |
| Transactional | MySQL | 8.0 or later |
| Analytical | ClickHouse | |
| Analytical | Apache Doris | |
| Analytical | StarRocks | |
| Analytical | Trino | 418 or later |

## Add a data source

1. Click **Add data source** and choose the database.
2. Fill in the form.
3. Click **Test connection**, and when it says **Connected**, click **Save**.

| Field | Applies to | Meaning |
|---|---|---|
| **Name** | All | The name people see in SupaBI |
| **Host**, **Port** | All | Where the database listens. Left empty, the port is the usual one for that database |
| **Database** | All but Trino | The database to connect to. Optional on ClickHouse |
| **Default catalog**, **Default schema** | Trino | Where unqualified table names are looked up |
| **User**, **Password** | All | The account SupaBI connects with. The password is stored encrypted and never shown again; when you edit the data source, leave it empty to keep it. After changing the host, the port, the user or the encryption setting, enter the password again: a saved password is only sent to the server it was saved for |
| **SSL mode** | PostgreSQL | `disable`, `prefer`, `require`, `verify-ca` or `verify-full` |
| **TLS** | MySQL, Doris, StarRocks | Whether the connection is encrypted |
| **Encrypted connection** | ClickHouse, Trino | Whether the connection is encrypted |
| **Data time zone** | All | The zone of timestamps that the database stores without one |
| **Result cache** | All | How long results are kept, see below |
| **Concurrent queries** | All | How many queries run at once, see below |

:::caution[Use a read-only account]
SupaBI runs only read statements, and asks for a read-only session on the databases that have one. StarRocks and Doris do not, so there the account is the only protection. On every database, a Developer can read whatever the account can read.
:::

## Query settings

**Result cache** decides how long the same query gets the earlier result without asking the database:

| Option | Meaning |
|---|---|
| **System default** | The default cache lifetime, set under [System administration](/admin/system/#general-settings). It is 10 minutes unless changed |
| **Do not cache** | Always ask the database. Use it for databases whose live data matters |
| **Custom** | Your own lifetime, from 1 to 1440 minutes |

**Concurrent queries** limits how many queries each instance runs on this data source at once, from 1 to 64, and the rest wait. It is 8 when left empty.

## The page of a data source

Once saved, the page shows whether the connection works, its settings, and:

- **Tables**: every table and column, with the comments stored in the database.
- **Used by**: the datasets that read it, and the charts and dashboards behind them. **See in the lineage map** opens the same answer as a [lineage map](/data/datasets/#what-reads-a-dataset).

**Query in data exploration** opens a query on this data source.

## Delete a data source

Resources that read a data source stop working once it is deleted, and the confirmation says how many there are.
