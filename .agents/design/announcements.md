# Announcements and notifications

Status: decided and implemented on 2026-11-09.

## 1. Why

Administrators have no way to tell people inside SupaBI that something affects them: a maintenance window, data that is late today, a metric whose definition changed, a new dashboard. They have to use a channel outside it. The only in-app messages are the results of exports ([Exports](exports.md) section 6), and email has a server but no feature that sends ([Email](email.md) section 10).

Announcements are written by administrators and shown to everyone they concern, as a banner while they are in effect and in a notification center (a bell in the top bar) afterwards, so a person who closed one can find it again.

## 2. Two kinds

| | Published in | By | Shown to |
|---|---|---|---|
| System announcement | System administration → Announcements | System administrators | Everyone signed in to the organization, including people in no workspace |
| Workspace announcement | Workspace settings → Announcements | Admins of the workspace | Everyone who can enter the workspace |

- A system administrator is an Admin in every workspace ([Access control and workspaces](access-control.md) 4.1), so they can publish workspace announcements too.
- "Can enter" is the same set as the workspace switcher: a direct member, a member through a group, or a system administrator. A person who loses access to a workspace no longer sees its announcements, and gets them back with access, read or unread as they were. The announcements of a deleted workspace are hidden from everyone and come back if it is restored.

## 3. An announcement

| Field | Rules |
|---|---|
| Title | Required, one line, at most 120 characters |
| Body | Optional, Markdown, at most 10,000 characters |
| Starts | Now by default, or a later date and time; it is not shown before then |
| Ends | Required: 1, 3, 7 or 30 days after the start (7 by default), or a date and time; must be after the start |

- **States**: Scheduled before the start, Active from the start until the end, Ended after it.
- **Times** are entered and shown in the browser's time zone. A system announcement belongs to no workspace, so it has no workspace time zone to follow, and a workspace announcement is read the same way.
- **The end is required** so that an announcement does not stay in the banner for good. A new announcement must end in the future. An edit keeps the end as it is unless it is changed, so the text of an ended announcement can still be corrected.
- **Markdown** is rendered by the rules of the AI assistant's answers ([AI assistant](ai-assistant.md) section 4): GitHub syntax, links open in a new tab, and HTML in the text is shown as text and never run. The body is not streamed, so this is a separate, static Markdown component in `packages/ui`.
- There are no levels or colors. Editing an announcement does not show it again to people who have read it; to tell everyone again, publish a new one.

## 4. Where people see them

### 4.1 Banner

- Under the top bar, on every page that has the top bar.
- It holds the Active announcements the person has not read: system ones first, then the current workspace's, the latest start first within each. Announcements of the person's other workspaces are not in the banner: the banner is for what concerns the work at hand, and the bell's badge says they are there.
- One line each: the title, "View", which opens the full text in a dialog, and "Got it", which marks it read and removes the line. The dialog has "Got it" too.
- At most three lines. When there are more, a line under them says "N more", and opens the bell.

### 4.2 Bell

- In the top bar, before Exports, for everyone signed in, with or without a current workspace.
- The badge is the number of unread Active announcements: system ones and those of every workspace the person can enter.
- It opens a panel under the bell, with "Mark all as read" in its header and three tabs: **All**, **System announcements** and **Workspace announcements**. A later kind of notification, such as alerts or subscriptions, adds a tab of its own when it is built; there are no empty tabs for kinds that do not exist. Exports stay in the export center.
- The list holds every announcement that has started, Ended ones included, until an administrator deletes it; Scheduled ones are not in it. The latest start comes first, 20 at a time, with "Load more".
- One line each: a dot when unread, the title, where it comes from ("System" or the workspace's name) and when it started. Clicking a line expands the body under it and marks it read. Reading a workspace's announcement does not switch to that workspace.

### 4.3 Read

- A person has one read state per announcement. "Got it" on the banner, expanding it in the bell and "Mark all as read" all set it.
- An announcement stops counting as unread when it ends: it leaves the banner, is no longer in the badge, and has no dot in the bell. Ended announcements are history, so a person who comes back after a month is not greeted by old ones.
- Editing keeps the read state. Deleting an announcement removes it, and everyone's read state of it, at once.

### 4.4 Refresh

- The page reads the badge and the banner when it loads (switching workspace reloads the page), when it becomes visible again, after the person publishes or changes an announcement, and every N seconds while it is visible. Polling pauses while the page is hidden.
- N is the system setting "Notification refresh interval", 60 seconds by default ([Startup configuration](configuration.md) 10.10). Each read returns the value in force, so open pages follow a change at their next read.
- The list in the bell is read when it opens.

## 5. Managing announcements

- **System administration → Announcements** (`/settings/system/announcements`), for system administrators: the system announcements.
- **Workspace settings → Announcements** (`/settings/workspace/announcements`), for Admins of the workspace: the current workspace's announcements. Developers do not see the page.
- The layout follows the settings pages ([Access control and workspaces](access-control.md) 2.2.1): "New announcement" in the page header, and a table with one row each: the title, the state, the period (start – end) and who published it, the latest start first, 20 to a page. "Edit" stays in the row; "End now" (for Active ones) and "Delete" are in the "⋯" menu.
- **Delete** asks first: it removes the announcement from everyone's notifications and cannot be undone. **End now** sets the end to the present moment, and needs no confirmation: the announcement stays in the bell and can be extended again by editing. A Scheduled announcement has not been shown, so it is edited or deleted instead; ending it would put an announcement nobody saw into everyone's history.
- **New** and **Edit** use one dialog: Title; Body, with **Write** and **Preview** tabs; Starts, **Now** or **Later** with a date and time; Ends, **1 day**, **3 days**, **7 days**, **30 days** or **Custom** with a date and time. Editing an announcement that has started shows its start as a date and time.
- After saving, the page re-reads the banner and the badge, so the publisher sees the result at once.

## 6. API

| Endpoint | Needs |
|---|---|
| `GET`, `POST /system/announcements`; `PUT`, `DELETE /system/announcements/{id}`; `POST /system/announcements/{id}/end` | A system administrator, with or without a current workspace |
| `GET`, `POST /workspace/announcements`; `PUT`, `DELETE /workspace/announcements/{id}`; `POST /workspace/announcements/{id}/end` | Admin of the current workspace |
| `GET /notifications/summary`: the unread count, the banner (at most three, and how many there are), the refresh interval | Signed in |
| `GET /notifications?category=&before=`: a page of the bell, each with its body, source and read state | Signed in |
| `POST /notifications/{id}/read`; `POST /notifications/read` marks all read | Signed in |

- The management lists return every announcement of their scope, Scheduled and Ended ones included.
- `end` uses the server's clock, not the browser's.
- The reading endpoints need no current workspace, like the export center ([Exports](exports.md) section 6); the banner leaves out workspace announcements when there is none. They are named for notifications, not announcements, so that later kinds join the same bell.

## 7. Storage

- `announcements`: `id`, `org_id`, `workspace_id` (empty for a system announcement), `title`, `body`, `starts_at`, `ends_at`, `created_by`, `created_at`, `updated_by`, `updated_at`. The end must be after the start.
- `announcement_reads`: `org_id`, `announcement_id`, `user_id`, `read_at`, one row per person and announcement, deleted with the announcement.
- Permanently deleting a workspace deletes its announcements and their read states ([Access control and workspaces](access-control.md) 2.3).

## 8. Audit

`announcement.create`, `announcement.update` (ending one early included) and `announcement.delete`, in the category "Content" ([Access control and workspaces](access-control.md) 7.1). The workspace is empty for a system announcement. The details are the submitted title, start and end, and the body. Reading and marking read are not recorded, like the other things a person does to their own view.

## 9. Not now

| Item | Why | When to reconsider |
|---|---|---|
| Sending announcements by email | It would be the first feature that sends email, which decides the queue, retries, the record of sent messages and each person's language ([Email](email.md) section 10) | When people miss announcements because they do not open SupaBI |
| Announcing to some groups or roles only | Workspaces already separate the audiences | When one workspace holds audiences that need different messages |
| System announcements on the sign-in page | It would make announcements readable without signing in | When maintenance needs announcing to people who cannot sign in |
| Who has read an announcement | Not asked for | When administrators need to know who has seen one |
| Levels and colors | Decided against for now | When ordinary announcements drown out urgent ones |
