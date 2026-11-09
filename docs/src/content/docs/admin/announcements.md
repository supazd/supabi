---
title: Announcements
description: Tell everyone in the organization, or in a workspace, about maintenance, late data or a change, in a banner and in their notifications.
---

An announcement tells people about something that affects them, such as a maintenance window, data that is late today, or a metric whose definition changed. While it is in effect it shows as a banner under the top bar. Afterwards it stays in everyone's notifications, behind the bell in the top bar.

| | Where | Who publishes | Who sees it |
|---|---|---|---|
| System announcement | **System administration → Announcements** | System administrators | Everyone signed in, in every workspace, and those in none |
| Workspace announcement | **Workspace settings → Announcements** | Admins of the workspace | Everyone who can enter the workspace |

A system administrator is an Admin in every workspace, so they can publish workspace announcements too. Someone who leaves a workspace no longer sees its announcements.

## Publish one

1. Open **Announcements** and click **New announcement**.
2. Write the **Title**, one line of up to 120 characters.
3. Write the **Body** if the title is not enough. It takes Markdown: **bold**, lists, links and tables. **Preview** shows how it will look. HTML is shown as text.
4. Under **Starts**, keep **Now**, or choose **Later** with a date and time.
5. Under **Ends**, choose **1 day**, **3 days**, **7 days** or **30 days** after the start, or **Custom** with a date and time. Every announcement ends, so none stays in the banner for good.
6. Click **New announcement**.

Times are in your browser's time zone. People see the announcement within a minute; see [the refresh interval](/admin/system/#general-settings).

## What people see

- **The banner** shows the announcements in effect that a person has not read: the system's first, then those of the workspace they are in. **View** opens the full text, and **Got it** marks it read. It holds three at most, with a line under them that opens the rest.
- **Notifications**, the bell, holds every announcement that has started, ended ones included, from every workspace the person can enter. Its tabs are **All**, **System announcements** and **Workspace announcements**. Opening one marks it read, and **Mark all as read** marks them all. The number on the bell counts the unread ones in effect.

An announcement that has ended no longer counts as unread: it leaves the banner, and stays in the bell as history.

## Change, end or delete one

The list shows each announcement's status: **Scheduled** before its start, **Active** until its end, then **Ended**.

- **Edit** changes the text and the times. People who have read it are not told again; to tell everyone again, publish a new one. An ended announcement can still be corrected without changing its times.
- **End now**, in the **…** menu of an active announcement, ends it at once. It stays in the bell, and editing it can extend it again. A scheduled one is edited or deleted instead.
- **Delete** removes it from everyone's notifications, and cannot be undone.

Publishing, changing and deleting are recorded in the [audit log](/admin/system/#audit-log).
