---
title: Workspaces and members
description: Give people access to a workspace, and set how it counts dates.
---

A workspace holds data sources, datasets, charts and dashboards, kept apart from other workspaces. People enter a workspace with a role. See [Core concepts](/concepts/overview/#roles) for what each role can do.

## Give someone access

1. A system administrator creates the account under **System administration → User management** with **Add user**, and passes on the **Initial password** some other way. A new account belongs to no workspace.
2. A workspace Admin opens **Workspace settings → Members and access**, clicks **Add users**, chooses people and a role.
3. If they are a Viewer, [grant them dashboards](/dashboards/build/#save-and-grant-access).

Viewers see only **My dashboards** and **AI assistant** in the top bar. A Viewer without a granted dashboard sees none.

## Groups

Groups exist across the whole organization, and a system administrator maintains them under **System administration → Groups**. A group can hold different roles in different workspaces, and a change to its members affects every workspace that uses it.

To give a group access, open the **Authorised groups** tab of **Members and access** and click **Add groups**.

Someone with access from several places, directly and through groups, takes the highest role. The **Access source** column lists each of them. Removing direct access does not remove what comes from a group, and a disabled account cannot sign in at all.

## Workspace settings

**Workspace settings** in the top bar is visible to Developers and Admins. Admins can change everything, and Developers can only read **User attributes**.

Under **General**:

| Setting | Meaning |
|---|---|
| **Time zone** | Days and months are counted in this zone. It is UTC unless changed |
| **Weeks start on** | Monday or Sunday, used when grouping by week |
| **First week** | Which week is week 1 of a year: **Has January 1**, **Has at least 4 days in the year (ISO 8601)** or **First full week**. It only affects how weeks are written by number |

**User attributes** are used by data permission rules, see [Data permissions](/admin/data-permissions/#user-attributes).

**Announcements**, for Admins, publishes announcements to everyone who can enter the workspace. See [Announcements](/admin/announcements/).

## Switch workspace

If you belong to several workspaces, switch at the top left. Unsaved changes ask for confirmation first. The address of every page names its workspace (`/w/…`), and switching changes only the browser tab you switch in: other tabs stay in theirs, so two tabs can be in two workspaces. An address without a workspace, such as the site's root, opens in the workspace you last switched to. Query drafts in Data exploration and AI conversations are kept per workspace.

## Personal settings

**Personal settings** in the avatar menu shows your account and lets you **Change password**. There is no password recovery yet: a forgotten password can be reset only by a system administrator, with **Reset password**.

The language of the interface can be changed in the avatar menu, and the light or dark theme with the button beside it.
