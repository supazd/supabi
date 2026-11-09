---
title: System administration
description: Accounts, groups, workspaces, email, announcements, the audit log and settings for the whole organization.
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

## Email

**Email** sets the SMTP server SupaBI sends email through, one for the whole organization. No feature sends email yet; set it up and send a test now, so it works when one does. Every instance reads the settings for each message, so a change applies at once.

| Setting | Meaning |
|---|---|
| **SMTP server** | A host name or IP address, such as `smtp.example.com`. Email is on once this and the **Sender address** are set; leave it empty to turn email off, and the other settings are kept |
| **Encryption** | **STARTTLS** (port 587) connects, then has the server encrypt, and is an error if it cannot. **SSL/TLS** (port 465) encrypts from the start. **No encryption** (port 25) is for a relay inside your network, and never signs in |
| **Port** | Empty takes the usual port of the encryption |
| **Username**, **Password** | Leave the username empty if the server takes mail without signing in. A saved password is never shown; leave the field empty to keep it, or tick **Remove the saved password** |
| **Sender address** | The address messages come from. The server may only accept addresses it is allowed to send as |
| **Sender name** | Shown with the sender address. Empty takes `SupaBI` |

The server's certificate is checked against the trust store of the machine SupaBI runs on. For a server whose certificate comes from an internal CA, add that CA to the trust store, for example with `SSL_CERT_FILE`.

**Send a test email** sends with the settings on the page, saved or not, to the address you enter, your own to start with. The email is in the language of the page. When the server refuses, the page says at which step, such as signing in or the recipient, with the server's own reply under it. The server accepting the email does not mean it reached the inbox: if it does not arrive, look in the spam folder, and check that the server may send as the sender address.

## Announcements

**Announcements** publishes system announcements, which everyone signed in sees. See [Announcements](/admin/announcements/).

## Audit log

The **Audit log** records who did what, when, and which data they read. Filter by time, workspace, actor, category and outcome, and open an event for its details. For a query, that includes the SQL and parameters of each statement.

| Category | What is recorded |
|---|---|
| **Sign-in** | Signing in and out, failed sign-ins with the reason, changing a password, allowing and revoking [MCP clients](/admin/mcp/) |
| **Accounts and groups** | Creating and changing accounts and groups |
| **Workspaces and members** | Workspace settings, deletions and membership |
| **Access and data permissions** | Dashboard grants, data permissions, user attributes |
| **Content** | Creating, changing and deleting data sources, datasets, charts, dashboards and folders, sharing with conditions, and publishing, changing and deleting announcements |
| **Queries** | Each fetch of data from a data source |
| **Exports** | Creating, finishing, cancelling and downloading |
| **AI models** | Changes to the AI configuration |
| **System** | Changes to the general and email settings, and test emails |

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
| **Sign-in** | **Session lifetime** | 168 hours | Signs out after this long without activity. An [MCP client](/admin/mcp/) unused for this long has to be allowed again |
| **Notifications** | **Refresh interval** | 60 seconds | From 10 to 3,600. How often every open page checks for new [announcements](/admin/announcements/): shorter reaches people sooner, and asks more of the server |
| **AI assistant** | **Compress context at** | 80% | A share of the model's context, from 50 to 95. Past it, the earlier part of a conversation is summarized before the next answer, and an answer stops looking things up |
| | **Most tool calls per answer** | 60 | Lookups, calculations and charts all count. `0` sets no limit. Each call sends the whole conversation to the model again, so more calls cost more |
| **MCP service** | **MCP clients** | Off | Lets people connect AI clients of their own; see [MCP](/admin/mcp/) |

Shortening a retention period asks for confirmation first, because what is past the new limit is deleted within the hour.

For settings that belong to each instance, see [Configuration](/deployment/configuration/).
