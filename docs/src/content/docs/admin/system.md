---
title: System administration
description: Accounts, groups, workspaces, the audit log and settings for the whole organization.
---

**System administration** is in the avatar menu, for system administrators only. It does not depend on the current workspace.

## User management

**Add user** creates an account with an initial password. Creating an account does not add it to a workspace: [add it as a member](/admin/members/#give-someone-access) next.

The **…** menu of an account has:

- **Reset password**, the only way back from a forgotten password.
- **Disable**, which stops the account from signing in. Accounts can be disabled but not deleted.
- **Make system administrator** and **Remove system administrator**. A system administrator manages users, groups and every workspace, and is an Admin in each.

## Groups

**New group** creates a group and chooses its members. See [Groups](/admin/members/#groups).

## Workspaces

**Workspaces** lists every workspace. **New workspace** creates one, and **Manage** opens its settings.

Only a system administrator can delete a workspace, in two steps:

1. **Delete** hides the workspace from everyone, and it stays in this list with the date of its permanent deletion. Exports in progress are cancelled, and its share links show no access. **Restore** brings it back as it was during this time.
2. When the retention period ends, 30 days by default, the workspace and everything in it are deleted for good, within the hour. **Delete now** does this at once.

Accounts and groups belong to the organization and are not deleted. Audit events are kept. Until the permanent deletion, the name of a deleted workspace cannot be reused.

## Audit log

The **Audit log** records who did what, when, and which data they read. Filter by time, workspace, actor, category and outcome, and open an event for its details. For a query, that includes the SQL and parameters of each statement.

| Category | What is recorded |
|---|---|
| **Sign-in** | Signing in and out, failed sign-ins with the reason, changing a password |
| **Accounts and groups** | Creating and changing accounts and groups |
| **Workspaces and members** | Workspace settings, deletions and membership |
| **Access and data permissions** | Dashboard grants, data permissions, user attributes |
| **Content** | Creating, changing and deleting data sources, datasets, charts, dashboards and folders, and sharing with conditions |
| **Queries** | Each fetch of data from a data source |
| **Exports** | Creating, finishing, cancelling and downloading |
| **AI models** | Changes to the AI configuration |
| **System** | Changes to the general settings |

Read-only actions, such as opening a list or an editor, are not recorded. Each event also writes a line of application log with `msg=audit`, which a log system can collect. That line holds no SQL, parameters or request content.

## General settings

**General** holds the settings the whole organization has one of. Each instance reads them when it uses them, so a change applies at once, without a restart. An empty field uses the default.

| Group | Setting | Default | Meaning |
|---|---|---|---|
| **Exports** | **Most rows per export** | 2,000,000 | |
| | **Largest export file** | 512 MB | |
| | **Export timeout** | 15 minutes | |
| | **Export files kept for** | 24 hours | Job records are kept for 30 days |
| **Audit** | **Audit events kept for** | 180 days | `0` keeps them forever. AI usage records follow it |
| **Queries** | **Query timeout** | 60 seconds | Raising it may need a longer timeout on a reverse proxy too |
| | **Default rows** | 1,000 | The rows a chart reads when it sets no limit |
| | **Most rows per query** | 10,000 | Up to 100,000. Rows are held in memory, so raise it with care |
| | **Default cache lifetime** | 10 minutes | A data source can set its own |
| **Workspaces** | **Deleted workspaces kept for** | 30 days | |
| **Sign-in** | **Session lifetime** | 168 hours | Signs out after this long without activity |

Shortening a retention period asks for confirmation first, because what is past the new limit is deleted within the hour.

For settings that belong to each instance, see [Configuration](/deployment/configuration/).
