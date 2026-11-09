# Access control and workspaces (draft v0)

Status: draft, to be discussed. This document decides the ownership and visibility fields of almost every table in the metadata database, which must be settled before the tables are created.

## 1. Questions to answer

1. Who (the subject)
2. Can act on what (the resource)
3. Can do what (the action)
4. Sees which data (rows and columns)

The first three are **resource permissions**. They decide whether someone can open or edit a dashboard or dataset. The fourth is **data permission**. It decides the range of data the queries return once the dashboard is open. The two are independent: two people who can see the same dashboard can see different data.

## 2. Hierarchy

```
Instance
 └─ Organization        Tenant boundary: users, groups and authentication config belong to one organization
     └─ Workspace       Resource boundary: data sources, datasets, charts and dashboards belong to one workspace
         ├─ Members     Users or groups, each with one role in this workspace
         ├─ User attributes   Data-permission attributes defined in this workspace, and their values for users and groups
         ├─ Data sources
         └─ Folders     Nestable; dashboards, charts and datasets each have their own folder tree
             ├─ Dashboards
             ├─ Charts
             └─ Datasets
```

- **Instance**: one deployment.
- **Organization**: a tenant. Accounts, groups and resources are fully isolated between organizations, and the same email address in two organizations is two accounts. v1 has only one automatically created default organization, and the UI has no "organization" concept. Multiple organizations (multi-tenancy) come later.
- **Workspace**: the isolation boundary for resources, corresponding to a team or a line of business. Resources cannot be referenced across workspaces.
- **Folder**: organizes dashboards, charts and datasets. Each of the three has its own tree, and a folder holds only one kind of resource. A folder is a node of permission inheritance (inheritance is not implemented yet, so for now folders are only for organizing). Data sources are not put in folders and belong directly to the workspace. Organizing folders requires the Developer role.

Every table carries `org_id`, resource tables also carry `workspace_id`, and every query filters by them. `org_id` is added now because adding an isolation field to every table afterward is very expensive.

### 2.1 Global administration and workspace settings

Global means the current organization. In v1's single-organization UI it appears as "System administration". Users and groups exist once, globally. Workspaces reference them and assign workspace roles. A workspace does not have groups of its own.

| Item | Belongs to | Maintained by |
|---|---|---|
| User accounts, account profiles, enabled or disabled status, passwords, system administrator status | Global | System administrators; users can change their own password in Personal settings |
| Groups and group members | Global | System administrators |
| The list of all workspaces; creating, deleting and restoring workspaces (2.3) | Global | System administrators |
| Workspace name, time zone, week start day, first week | Workspace | Workspace admins |
| Workspace access and roles of users and groups | Workspace | Workspace admins |
| Definition and assignment of custom user attributes | Workspace | Maintained by workspace admins, read-only for Developers |

- Creating an ordinary account does not add it to the current workspace and does not assign a workspace role. Add users or groups separately through "Members and access".
- A global group can have different roles in different workspaces. In a workspace, "Authorised groups" can only add an existing group, change that group's workspace role or remove its access. It cannot create a group or change group members.
- A change in the members of a global group affects every workspace that references it. The members page also lists the access obtained through direct grants, through groups and through system administrator status, and shows the source and the effective role. Removing a direct grant does not revoke access from other sources. A disabled account still cannot sign in or get access.
- Attributes are inputs to data-permission rules and do not grant access to a workspace or dashboard by themselves. Built-in account attributes are read-only. Custom attributes are defined and assigned independently in each workspace. Global custom attributes and overriding an attribute of the same name across levels are not provided for now.
- Workspace-level groups will be considered later, and only if workspace admins clearly need to assemble business teams themselves. For now neither nested groups nor two-level group inheritance is introduced.

### 2.2 Settings entry points

The three kinds of settings each have their own title, sidebar and routes. They are not mixed in one sidebar:

| Entry | Location | Pages and routes | Visible to |
|---|---|---|---|
| System administration | Avatar menu | `/settings/system/users` User management; `groups` Groups; `workspaces` All workspaces; `ai` AI models; `ai-usage` AI usage; `audit` Audit log; `general` General (export limits, audit retention, the default lifetime of the query cache and the MCP switch; see [Startup configuration](configuration.md) section 10) | System administrators; does not depend on the current workspace |
| Workspace settings | Top navigation bar (Developer and above) | `/settings/workspace/general` General; `members` Members and access; `attributes` User attributes | Workspace admins can manage everything; Developers can only view user attributes |
| Personal settings | Avatar menu | `/settings/personal/account` My account, Change password; `mcp` MCP, the clients the person has authorized ([AI assistant](ai-assistant.md) 14.5) | All signed-in users, including users who have not joined a workspace |

The navigation bar title of Workspace settings always shows "workspace name · Workspace settings". "Members and access" uses two tabs, "Users" and "Authorised groups". The workspace list in System administration offers "Manage", which opens the same set of settings for that workspace. To manage another workspace, the user first goes through the existing draft confirmation and session switch flow, then enters the General page of the target workspace.

The UI currently shows the organization admin as "System administrator", while internally the organization-level `isOrgAdmin` flag is still used. A system administrator can read the user directory and the group directory when no workspace is selected. The Developers and Admins of the current workspace can also read them, to choose whom to grant access to. Viewers cannot read the directories. Workspace attributes and settings always require a valid current workspace.

### 2.2.1 Layout and interaction of the settings pages

The three kinds of settings use the same set of pages. The look matches "My dashboards" and is the island-style look described in section 12 of the [Architecture overview](architecture.md):

- **Fills the window.** On the left is a fixed-width navigation bar, with the name of this kind of settings at the top. The content area on the right fills the remaining width and scrolls inside itself when the content is long. On a narrow screen the navigation bar moves above the content.
- **One page header per page.** The page name, a one-line description, and the primary button (Add user, New group and so on) on the right of the header. The page name appears only once. When a page has several parts (AI models has "What each model is for" and "Providers and models", My account has "Change password"), each part has a small heading and the parts are separated by dividers.
- **Tables stretch, forms do not.** A table widens with the content area. Narrow columns such as status, role and actions have fixed widths, and the remaining width goes to the name column. A form is at most 640px wide and left-aligned.
- **One row per record.** Name and email are in the same cell, with the email in small gray text. A disabled account is marked "Disabled" after the name, and a system administrator is marked "System administrator".
- **Create and edit use dialogs**, not forms expanded in the page.
- **Row actions go into a "⋯" menu.** The one most-used action of each row stays outside the menu, such as "Manage" for a workspace and "Test" for a model.
- **Dangerous actions are confirmed first.** Disabling an account, making someone a system administrator or removing that status, deleting a group, deleting, restoring or immediately deleting a workspace, removing the access of a user or group, deleting an attribute, deleting a model provider or model, and shortening the audit retention period all explain their consequences in a confirmation box first, and run only after one more click. Enabling an account and changing a role take effect directly.
- **Long lists are searchable.** User management and Members and access search by name or email, and paginate beyond 20 entries.
- **Save results use brief notices.** "Saved" and "Password changed" appear for a few seconds and then disappear. They do not stay on the page.

What is special about each page:

- **General**: a single column. Each item has its name on the left and its control on the right, with the description below the control. There are two groups, "Name" and "Dates and weeks" (time zone, week start day, first week). Saving is possible only when something has changed. With unsaved changes, leaving the page or switching workspace asks for confirmation first.
- **General** (System administration): the layout is the same as General in Workspace settings. There are three groups, "Exports", "Audit" and "Query cache". An empty input means use the default, and the placeholder text is the default. See [Startup configuration](configuration.md) 10.3.
- **Members and access**: the "Users" tab has three columns: user, role and source. The role is the effective role. The source column lists, in one line, the role given by each source, for example "Direct: Viewer · East China Sales: Developer". Changing or removing a direct grant is in the "⋯" menu, and someone who has access only through a group can also be given a direct grant from that menu. The description of the three roles is in the tooltip of the "Role" column header. "Add users" and "Add groups" are on the search box row of their own tabs. In the dialog you select several at once, then pick one role. On the "Authorised groups" tab the role is still changed directly in the row: a group has only one role in a workspace, so the effective role and the direct grant can never differ.
- **User attributes**: click the cell that holds an attribute value to edit the value for that one user or group. Adding an attribute is in the page header. Renaming and deleting are in the menu of that attribute's column header, and there is no longer an "Attribute management" dialog. The tooltip of the column header shows the attribute key. The page still lists all users and groups of the organization: the member list can be read only by workspace admins, while Developers can also see this page.

### 2.3 Deleting a workspace

Deletion has two steps: first mark the workspace as deleted, then delete it permanently when the retention period ends. The retention period defaults to 30 days, and a system administrator changes it under "System administration → General" ([Startup configuration](configuration.md) 10.7). During that time the workspace can be restored, or deleted immediately.

- **Only a system administrator can delete, restore and delete immediately.** As with creating a workspace, the entry is in the list under "System administration → Workspaces". Workspace admins cannot delete their own workspace.
- **Once deleted, the workspace is hidden from everyone**, including system administrators: it is not in the switch list and cannot be switched into. It remains only in the workspace list of System administration, which shows "Deleted" and the date of permanent deletion, and where the buttons change to "Restore" and "Delete now".
- **Sessions inside this workspace**: the session of the person who deletes it is moved to the first workspace they can enter (chosen the same way as at sign-in), and the page reloads in full, as when switching workspaces. The sessions of other people are not switched automatically. They end up with no current workspace instead: further requests from pages they already opened fail, with a message that the current workspace is no longer available and asking them to switch in the top bar. After a reload the page asks them to pick a workspace from the top bar, and asks them to contact an administrator only when they have no workspace at all. This way a form someone was halfway through filling in is never silently saved into another workspace. Exports queued or running in the workspace are canceled and are not resumed after a restore. A share link that points to this workspace shows a no-access message when opened.
- **The name stays taken**: until permanent deletion, no new workspace with the same name can be created, and no other workspace can be renamed to it. The message says to restore it or delete it now first. This way a restore never collides with a name.
- **Restore**: the workspace comes back as it was. Members, content and settings are all unchanged, and it appears again in the switch list of the people who may enter it.
- **Permanent deletion**: when the retention period ends, the hourly maintenance job performs it, so in practice it happens within an hour after the period ends. "Delete now" runs immediately and works only on a deleted workspace. After the retention period is shortened, workspaces already past the new limit are permanently deleted within an hour, and saving asks for confirmation first. It deletes the workspace and everything in it in one go: data sources (including saved passwords), datasets with their revisions and data permissions, charts, dashboards with their revisions, dashboard grants, share conditions, folders, members, user attributes, export records and export files. The export files are deleted from storage first. If that fails, the content in the database is not deleted this time and is left for the next maintenance run to retry. The content in the database is deleted in one transaction.
- **Kept**: accounts and groups belong to the organization and are not deleted. Audit events are kept and cleaned up by the retention period as usual. After permanent deletion, earlier events of this workspace show its ID in the Workspace column, and the deletion and permanent deletion events themselves record the workspace name.
- **The last workspace can also be deleted**, including the default workspace created at installation. It is created only on first startup, together with the default organization, so after permanent deletion it does not reappear on restart. A system administrator can enter System administration without being in any workspace, and then create a new one.
- On permanent deletion, the connection pools of this workspace's data sources on this instance are closed, the same as when deleting a data source.
- **Two-step confirmation**: all three actions work by clicking once, after which the button turns in place into confirm and cancel buttons, with the consequences written above them, the same as how deleting a data source works. Only one confirmation is expanded at a time in a row. A deleted workspace shows the date of permanent deletion below its name.
- In the implementation, a non-null `workspaces.deleted_at` means deleted. Sessions, switching and workspace selection at sign-in only consider workspaces that are not deleted. On deletion, the sessions are handled and the exports canceled in the same transaction. Permanent deletion deletes table by table following the foreign key dependencies, without relying on the cascade settings of foreign keys. A test lists all tables that carry `workspace_id` and checks that no row of the workspace is left after permanent deletion, so the test fails when a newly added table is missed.

## 3. Subjects

| Subject | Description |
|---|---|
| User | An organization-level account. Workspace-level **user attributes** can be configured for it (such as `regions=[East China, South China]`), which data permissions refer to; see 5.6 |
| Group | A set of global users, used for granting in bulk. Roles are granted and attribute values are configured per workspace. Members are maintained only in System administration, and may be synchronized from SSO later |
| Every member | All members of a workspace. It can be chosen when granting, so there is no need to add members one by one. It is not a real group, and it follows automatically when members change |
| Service account | A non-human identity for the data API and embedding. It holds a secret key, and likewise has a role and attributes |

In the embedding scenario, the host system uses the service account's secret key to issue a short-lived token, and the token carries the end user's attributes. At query time these attributes work exactly like ordinary user attributes.

## 4. Resource permissions

### 4.1 Roles

A member has one role in each workspace. There are only three roles, fixed, from low to high:

| Role | For | What it can do |
|---|---|---|
| Viewer | Business users | See the dashboards and charts in the workspace, use filters and chart links, and export the chart data that the author allows to be exported |
| Developer | Data analysts, engineers, report builders | Plus: manage data source connections, write SQL against data sources in Data exploration, create and change datasets, charts, dashboards and folders, configure the row and column permissions of datasets, and view lineage and reference relationships |
| Admin | Workspace owners | Plus: manage the roles of the members and groups of the workspace, and change workspace settings |

Rules:

- A higher role has all the abilities of the lower one. Each API registers only "which role is needed at least".
- A person can be a member directly, or through several groups, and takes the highest of those roles.
- A **system administrator** is the organization admin flag on an account: it manages global accounts, groups and workspaces, and is an Admin in every workspace of the organization.
- There are no custom roles and no permission points to tick. SQL export in Data exploration requires the Developer or Admin role. Chart data export on a dashboard does not depend on the role. It is decided by the chart's "Allow data exports" switch and the dashboard grants, and the switch applies to all roles; see [Exports](exports.md) section 2. An export job can be viewed, canceled and downloaded only by its initiator, from whichever workspace is current, as long as they can still enter the workspace it was made in; background execution and download check permissions again in that workspace ([Exports](exports.md) section 6). The AI assistant is available to all roles, and each person sees only their own conversations. The model it calls is configured by system administrators; see [AI assistant](ai-assistant.md) section 8. The MCP service needs only a Viewer in the workspace of each dashboard it reads; see [AI assistant](ai-assistant.md) section 14. Features that do not exist yet (subscriptions, embedding) are not given a placeholder in advance, and which role they belong to is decided when they are built.
- A Developer can write SQL directly against data sources, and can read all the data that the connection account of every data source in the workspace can see. Making someone a Developer means trusting them to see that data.

This converged on 2026-10-17 from "a set of permission points plus four built-in roles, with custom roles on top". The reasons: half of the permission points correspond to features that do not exist yet; and when roles can be configured freely, someone who holds "manage members" can give a role higher than their own to others, or to a group they belong to, and so escalate their privileges.

### 4.1.1 Self-service analysis for Viewers (planned)

Later, Viewers can ask the AI questions and have it generate personal dashboards. This does not change the three roles. It gives Viewers two more abilities:

- **Personal content**: charts and dashboards that belong only to the person. They can be told apart by `owner_id`, do not appear in shared dashboards and do not affect anyone else.
- **Self-service queries**: Viewers send queries against datasets. The precondition is that data permissions (section 5) are implemented and the dataset is set to allow self-service queries by Viewers. Queries always carry the row and column permissions.

Until then, Viewers can fetch data only through charts that others have saved; see 4.3. Dashboard data is fetched as the viewer, so when a personal dashboard is shared with others later, what they see is still only the data within their own data scope.

### 4.2 Dashboard grants

In the first version only dashboards are granted. The rules are:

- **Viewers see no dashboards by default.** A Developer or Admin grants a dashboard to users, groups or "Every member", and only those who are granted can see and open it in "My dashboards". A newly created dashboard is not visible either, and becomes visible to Viewers only after it is granted.
- **Developers and Admins see all dashboards.** They can edit all dashboards anyway.
- **A grant has only one level, "Can view".** Editing a dashboard is still decided by the role: both Developers and Admins can edit.
- **Charts are not granted separately.** Viewers reach charts only through granted dashboards. They can fetch only the data and filter candidates of the charts on those dashboards, and the chart list shows only the charts on those dashboards. Calling the API directly with a chart ID does not return the data of other charts.
- A person can see a dashboard if they are granted directly, or granted through any group they belong to, or if the dashboard is granted to every member.
- **Developers and Admins can both change dashboard grants**, in the dashboard's "Access" settings.

Later this extends to general resource grants:

- Grant access levels on folders, dashboards, datasets and data sources: can view; can edit (plus modify and delete); can manage (plus change the grants of that resource).
- **Folder inheritance**: a dashboard inherits the grants of its folder by default, and a subfolder inherits from its parent folder. Inheritance can be broken at any level to set grants separately.
- Final permission = the actions the role allows ∩ the level of the resource grant. For example, a Viewer cannot edit a dashboard even if they are granted "can edit" on it.

### 4.3 Permission relationship between dashboards and datasets

If a user can see a dashboard, can they also see the data of the dataset behind it?

The draft chooses: **yes**. Viewing a dashboard does not require a separate grant on the dataset. The reason is that business users should not need to understand the concept of a "dataset", or granting would become very tedious.

Accompanying constraints:

- Once dataset grants exist, a Developer must have "can view" on the dataset to **create** a chart from it. That is, the grant on a dataset controls "who can build charts with it".
- The queries behind a dashboard still enforce data permissions (rows and columns), so the range of data seen still differs from person to person.

### 4.4 Internal representation

After resource grants are implemented, the role decides which kinds of actions can be done, and the resource grant decides which resources they can be done on. The two are intersected.

## 5. Data permissions

Attached to datasets and injected uniformly in the query layer, taking effect on all entry points (dashboards, AI, embedding, data API, exports, subscription pushes).

- **Only Viewers are restricted.** Developers and Admins can write SQL directly against data sources, so restricting them on the dataset path does not protect the data.
- **Configured by Developers and Admins**, who manage named rules in the dataset's "Data permissions" tab, with search, filtering by type, edit, duplicate, delete and user simulation checks. The rule editor supports fixed values, dynamic user attributes and AND/OR combinations of several conditions. After editing, the list is saved as a whole. What people not covered by any rule see is set separately.
- The "Data permissions" tab offers rule editing and user preview to Developers and Admins. Viewers cannot access it.
- **Saved separately from the dataset definition**: changing permissions does not give the dataset a new version, and changing the dataset does not touch permissions. Each change records who made it and when.
- A rule can apply to users, groups or every member.

### 5.1 Row-level permissions

A row-level rule consists of "for whom" and "which rows they can see". The editor configures the row conditions directly. It supports "AND" and "OR" combinations of several conditions, as well as fixed values and dynamic user attributes, for example `region = East China` and `store in (A01, A02)`. Creating, editing and duplicating a rule all require a complete condition, and the "all visible" toggle is no longer provided.

The front end and the back end both require a complete condition. Saving and simulation checks reject missing or incomplete conditions. At query time, an invalid rule lets no rows through, and it does not override the restrictions of other rules. There is no row-level rule that lets everything through unconditionally.

```jsonc
{ "subjects": [{ "group": "grp_east" }], "rows": { "field": "region", "op": "eq", "value": "East China" } }
```

Which rows a person can see is decided in the following order:

1. **Covered by at least one rule** (directly, through any group they belong to, or because the rule applies to every member): they can see only the rows that these rules let through, and multiple rules take the **union**. For example, someone in both the East China group and the South China group sees East China plus South China.
2. **Covered by no rule**: decided by the dataset setting "Whoever no row rule covers":
   - **Sees all**: suits the case where most people see everything as usual and only a few groups are tightened. Give the East China group "East China", and the other groups are not affected.
   - **Sees nothing** (the default when a rule is first added on the page; existing configurations keep their choice): suits datasets where everyone should see only their own part (regions, stores, salaries). Someone who was left out of the configuration sees no rows, instead of seeing all of them.

Once covered, a person sees only the rows that the rules let through, and the restriction is not canceled by being in another group that has no rule. For example, Zhang San is in the East China group (sees only East China) and the Headquarters group (no rule), so they see only East China. When the Headquarters group needs an additional range, configure conditions by responsibility. If restrictions such as region and department must all hold at the same time, they must use an "AND" combination within a single rule.

In the implementation:

- The resolved result is one filter condition, compiled into a `WHERE` wrapped around the source SQL (the query compiler's `RowFilter`). It applies to every SQL statement of one data fetch: details and aggregates, totals and subtotals, the subqueries of period-over-period comparison and share, and filter candidate values. This injection point and its consistency test already exist.
- "Sees nothing" compiles to an always-false condition. The query runs as usual and the result is empty.
- **An invalid rule is treated as "sees nothing".** If a field referenced by a rule is deleted or its type changes, the people it matches see no rows, and the data permissions page marks the rule as invalid. When a dataset is saved, deleting a field that a rule references is blocked.

### 5.2 Column-level permissions

The scope of a column permission has two directions. The default is `columnMode: "visible"` (visible to the applicable members, invisible to others). After switching to `"hidden"`, it is invisible to the applicable members and visible to others. For compatibility with the original API, `visibleTo` in the rule still stores the applicable members:

```jsonc
{ "fields": ["cost", "gross_margin"], "visibleTo": [{ "group": "grp_finance" }] }
```

- A field without a column-level rule is visible to everyone, and so is a newly added field.
- Each rule yields a visibility result according to its scope. For multiple rules on the same field, the visible results are unioned, and then the dependencies of calculated fields are propagated. The invisible direction follows the same semantics; it is not deny-first.
- **Dependency propagation**: a calculated field that references an invisible field is invisible too. The dependencies come from the `${...}` references in expressions.
- For a field that cannot be seen: it does not appear in the dataset's field list, and a query that references it anywhere (display, grouping, filtering, sorting, dynamic candidates) is rejected.
- If a chart on a dashboard uses a field that the current user cannot see, that chart shows "No permission", and other charts are not affected.
- Row-level rules can reference restricted fields: the filtering happens on the server and does not hand the values of the field to someone who cannot see it.

The page is divided into two blocks, "Row and column permission scope" and "Row and column permission rules", and the field outline on the left is kept when switching the data permissions tab. If there are no row or column rules at all, it means "Not enabled": even if `unmatched: "none"` was saved, data is no longer filtered. It turns on after the first rule is added and saved, and turns off after all rules are deleted and saved. Before saving, a pending-enable or pending-disable state is shown.

### 5.3 Preview as someone

A Developer or Admin picks a user on the data permissions page and sees the rows and columns that this user can actually see on this dataset. It is used to check whether anything was left out of the configuration, especially for datasets set to "Sees all".

### 5.4 Cache

The key of the query result cache must include the effective row-level filter condition and the set of visible columns. Users with different data scopes cannot share the cache. Users with the same data scope can.

### 5.5 Data masking (later)

Replace a field's value with a partly masked form (such as showing only the last four digits of a phone number). Note this: if filtering and sorting still work on the original value, a filter such as "phone number contains 1381234" can be used to probe the true value again and again. So for a person who sees masked data, every use of this field (display, grouping, filtering, sorting, candidate values) must be replaced with the masked expression.

### 5.6 User attributes

The definition and assignment of custom attributes belong to the **workspace** and are maintained by workspace admins, and Developers have read-only access. The "Workspace settings → User attributes" page shows users and global groups separately, and provides attribute management and bulk assignment. A value set for a global group takes effect only in the current workspace, and does not change the group's global profile or its values in other workspaces.

- System attributes: `userId`, `email` and `displayName`, read from the account, read-only and cannot be redefined. It is recommended to identify an owner by the stable user ID or email, because names are not unique.
- Custom attributes: a stable key, a display name, and multi-value text assignments for users and groups. The key does not change after creation, and the display name can.
- When a user has an assignment of their own, it completely overrides the group assignments (including an explicit empty value). Otherwise the values of all the groups the user belongs to are merged and deduplicated. Removing the user's assignment restores inheritance.
- Text must match the dataset field exactly, with case and spaces kept. `*` is an ordinary character and does not mean permission to all rows.
- Attributes support the `in` condition on text fields. In the API it is expressed as `{ "field": "region", "op": "in", "value": { "userAttr": "regions" } }`, and can be combined with fixed values in an `and` / `or` condition tree.
- The server resolves it as the **actual viewer**, produces a parameterized ordinary filter condition, and passes it to the original query compiler. Dashboard data fetches, filter candidates and permission simulation share this path. After attributes or group members change, the change takes effect on the next query, with no need to sign in again.
- A missing attribute or an empty value makes the whole row rule that references it let no rows through (including nested AND/OR/NOT). It does not fall back to the "Sees all" of unmatched members. Other independent rules can still grant permission.
- After an attribute is deleted, the rules that reference it are marked invalid and stop letting rows through. The UI states the impact clearly at deletion. Saving a rule rejects unknown attributes or dynamic matching on a non-text field.
- Existing unnamed rules, fixed conditions and column rules stay compatible. The historical setting for what unmatched members see is not migrated automatically. A dataset with no policy is still open.

This refactoring took as reference the screenshots of the rule list, editor and user attribute table in Volcano Engine's [Data row and column permissions](https://docs.volcengine.com/docs/Datawindprivatization/Datarowandcolumnpermissions?lang=en) and [Configuration best practices](https://docs.volcengine.com/docs/Datawindprivatization/BestPracticesforRowandRowPermissionsConfiguration?lang=zh). It keeps this project's model of three fixed roles and the union semantics of allow rules. Attribute file import and SSO sync are not provided for now, and attributes can be updated in bulk through the attribute API.

### 5.7 System variables (later)

Using `{{user.email}}` in dataset SQL to join with a data warehouse permission mapping table, as well as attributes synchronized from SSO and attributes of embedding tokens, are not implemented yet.

## 6. Authentication

Authentication answers "who are you". It is decoupled from the authorization model above and plugs in through interfaces:

- Local accounts (user name and password)
- Single sign-on: OIDC, SAML, LDAP
- Service account secret keys, embedding tokens
- OAuth authorizations of MCP clients, with SupaBI as its own authorization server ([AI assistant](ai-assistant.md) 14.4)

The output of the authentication module is a unified identity: user ID, groups and user attributes. With SSO access, groups and attributes can be synchronized from the identity provider.

## 7. Audit

Audit answers "who did what to what, when, and which data they looked at". Events are written to the metadata database and queried in System administration. At the same time one application log line is written, for the log system to collect and ship out.

### 7.1 Events recorded

| Category | Events |
|---|---|
| Sign-in `auth` | Initializing the admin, signing in, signing out, changing one's own password. A failed sign-in is also recorded, with the reason: account does not exist, wrong password, account disabled, too many attempts. Authorizing an MCP client and revoking it ([AI assistant](ai-assistant.md) 14.8) |
| Accounts and groups `account` | Creating and changing accounts (disable, restore, make system administrator, admin resets password); creating, changing and deleting groups |
| Workspaces and members `workspace` | Creating a workspace, changing workspace settings, deleting, restoring, permanently deleting (automatic permanent deletion at expiry is also recorded, with no actor); adding a member, changing a role, removing a member; setting and removing the role of a group in a workspace |
| Access and data permissions `access` | Dashboard grants, dataset data permissions, setting and deleting user attributes |
| Content `content` | Creating, changing and deleting data sources, datasets, charts, dashboards and folders, and moving them into folders; sharing a dashboard with filter conditions (`dashboard.share`, the details being the shared conditions and their validity period) |
| Queries `query` | Each fetch of data from a data source; see 7.3 |
| Exports `export` | Create, finish, cancel, download, download refused. A download is the moment data leaves the system, and is recorded separately |
| System `system` | Changing the General settings of System administration (`system_settings.update`, the details being the values before and after the change); changing the email settings (`email_settings.update`) and sending a test email (`email.test`), see [Email](email.md) 7 |

Not recorded: read-only operations (lists, opening the editor, viewing configuration), requests that are not signed in, switching workspace, and database calls that return no data (`LIMIT 0` to get column info, `EXPLAIN`, testing a connection). Viewing the audit log itself is not recorded either.

The outcome of each event is success, failure or denied:

- A change records only success and denied. A change that fails validation or hits a save conflict has changed nothing. A denied change is recorded, because it shows that someone is trying an operation beyond their role.
- Sign-in records success and failure.
- A query records success, failure and denied: a failed query has also already sent its SQL to the database.
- An export finish records success or failure. An export canceled by the user is already recorded by the cancel event, and is no longer recorded as finished.
- A test email records success or failure: it sends a message out of the system.

### 7.2 Contents of an event

| Content | Description |
|---|---|
| Time, organization, workspace | Sign-in, account and group events do not belong to any workspace, so the workspace is empty. Creating a workspace is recorded under the new workspace |
| Actor | The user ID and the email at that time. On a failed sign-in there may be no user, only the email that was entered. An export finish is executed in the background, and the actor is the initiator |
| Event, category, outcome | The event name, such as `dataset.update`; the categories are in 7.1 |
| Object | Type, ID and the name at that time. On a rename, the details also record the former name; on deletion, the name before deletion is recorded |
| Details | Depends on the event; see below |
| Source | The connecting IP, the original text of the request header `X-Forwarded-For`, and the User-Agent |

- **No foreign keys**: after an account is disabled or a workspace or resource is deleted, the events remain, and the names rely on the snapshot taken at recording time.
- **`X-Forwarded-For` is not treated as a trusted IP**: the client can forge it, so it is stored as is and separately from the connecting IP. When deployed behind a reverse proxy, the connecting IP is the address of the proxy.
- **Details**: for accounts and groups, members, workspace settings, grants and data permissions, user attributes, folders and moves, the content of the submitted request is recorded, with any field whose name contains `password` replaced by `[redacted]`. The request content of a data source contains the connection password, and the definitions of datasets, charts and dashboards are large and each saved definition already exists in its own revision (for charts and dashboards see [Charts and dashboards](chart-dashboard.md) 4.1), so for these only the object is recorded, not the content.

### 7.3 Queries

- **One data fetch request records one event**, containing every statement it sent to the database: the main query, totals and subtotals. Each statement records the SQL, the bound parameters, the dataset, the data source, the duration, the row count, whether it was truncated, whether it hit the cache, and the error on failure. SQL longer than 64 KB is truncated and marked as such.
- **A cache hit is recorded too**: the data was still handed to this person. The duration is the duration of the original query in the database.
- **All data fetch entry points are covered**: chart and dashboard data fetches, filter candidates, dataset previews (including SQL run in Data exploration), the query API, the simulated preview of data permissions, and the MCP service. The object of the event is the resource the request targets: a chart, dashboard, dataset or data source.
- **The queries of an export** run in the background and are recorded on the export finish event, with no separate query event. The export create event records the full SQL, or the chart and the filter values. The finish event records the row count, the file size and the failure reason.

### 7.4 How it is recorded

- **Audit is an interface of the platform foundation** (`audit.Recorder`). Two implementations are enabled at the same time now: one writes to the `audit_events` table in the metadata database, and one writes a structured application log line (`msg=audit`). The application log has only the event, outcome, actor, workspace, object and source, with no details: the SQL, parameters and request content are only in the database. Shipping out currently relies on collecting the application log, and implementations that push to syslog or a webhook will be added later as needed.
- **API events are recorded uniformly after the request is handled.** Like the permission requirements table, there is an audit table that registers which event each API records and where the object comes from. A test fails when an API is not in the table, so a new API cannot be missed. Sign-in, initialization, and export creation and download need information from during handling (the failure reason, the export source), so the handler records them itself.
- **Query events are collected where the query layer executes statements**: it takes the statements at the same moment as the query diagnostics, cache hits included, so every entry point passes through it.
- **Denials are recorded at the permission check**, including blocking by role and denials returned by handlers.
- **A failure to write the audit does not undo the operation that already completed**: the error is written to the application log together with the whole event. Audit is not in the same transaction as the business change, because otherwise every storage function would have to accept an outside transaction. This will be changed when strong consistency is needed.

### 7.5 Query UI

- System administration gets a new "Audit log" page (`/settings/system/audit`), visible only to system administrators. Sign-in and account and group changes do not belong to any workspace, so they do not fit in Workspace settings.
- Filter by time range, workspace, actor, category and outcome. Sorted by time, newest first, and 50 are loaded each time.
- Expand an event to see its details. For a query event, the SQL and parameters are shown statement by statement.
- Later, Workspace settings can give workspace admins a view that shows only the events of their own workspace.

### 7.6 Retention and cleanup

- The default retention is 180 days. A system administrator changes it under "System administration → General", and `0` means keep forever. It is stored in the metadata database and all instances read the same value. Shortening it asks for confirmation first ([Startup configuration](configuration.md) section 10). The worker performs the cleanup. The usage records of the AI assistant use the same retention period; see [AI assistant](ai-assistant.md) 13.5.
- The scheduler delivers one maintenance job per organization every hour, deduplicated across instances, and the worker executes it: it deletes expired sessions, deletes audit events in batches by the retention period, deletes failed sign-in counts older than one day, deletes the records of maintenance jobs that ended more than seven days ago, and deletes expired OAuth requests and tokens and the MCP clients nobody authorized within 24 hours of registering ([AI assistant](ai-assistant.md) 14.9).
- Tables are indexed by organization and time. When the data volume gets large enough that deleting by row becomes slow, switch to monthly partitions and delete whole partitions.

## 8. Scope of capabilities

All capabilities are open source (Apache 2.0), with no editions. The table below is the planned full scope; see section 13 for the implementation progress.

| Capability | Scope |
|---|---|
| Organization | A single default organization at first; multiple organizations (multi-tenancy) later |
| Workspaces | Multiple |
| Roles | Three fixed roles: Viewer, Developer and Admin |
| Folders and resource grants | Dashboard grants first; later inheritance by folder, and grants on datasets and data sources |
| Groups | Maintained by hand, or synchronized from SSO |
| Authentication | Local accounts; OIDC, SAML, LDAP |
| Data permissions | Row-level and column-level permissions; dynamic user attributes; data masking later |
| Embedding | Public links, basic embedding, signed embedding with user attributes, white labeling |
| Audit | Application log; then storage in the database, a query UI and shipping out |

The **injection point of data permissions is in the query layer**: the "permission resolution" interface returns the row filter condition and the set of visible columns, and row-level policies, column-level policies and masking rules are all resolved in this one implementation. The compile flow has only one path.

## 9. Impact on the metadata database

- All tables: `org_id`.
- All resource tables: `workspace_id`, `created_by`, `created_at`, `updated_by`, `updated_at`.
- Dashboards, charts, datasets: `folder_id`. Folders: `kind` (which kind of resource it holds) and `parent_id`.
- Subjects: `user`, `user_group`, `user_group_member`, `service_account`. Workspace attributes are stored in `user_attributes` (definitions and assignments for users and groups); the JSONB attribute field originally reserved on accounts is still unused.
- Role: `workspace_member.role`, with the values `viewer`, `developer` and `admin`.
- Membership: `workspace_member` (subject, role).
- Dashboard grants: `dashboard_grants` (dashboard, subject). The subject is a user, a group or every member, exactly one of the three. When a dashboard, user or group is deleted, its grants are deleted with it. Later this extends to a general `resource_grant` (resource type, resource ID, subject, access level), where records on a folder take effect through inheritance.
- Data permissions: `dataset_policies`, one row per dataset, stored apart from the dataset definition: what people not covered see, row-level rules and column-level rules (each a JSON array, with the subjects in a rule written as `{user}`, `{group}` or `{everyone}`), and who changed it and when. A dataset without this row restricts no one. Rules are read and written as a whole, so they are stored as JSON. After a user or group is deleted, the rules that reference them no longer cover anyone.

## 10. Explicitly not doing in v1

| Item | Reason |
|---|---|
| Sharing resources across workspaces | It breaks the isolation boundary |
| Mixed deny-first rules (deny override) | Column permissions support a global visible/invisible direction, and the visible results of the rules are still unioned |
| Approval flow (requesting access to a dashboard) | A process feature, later |

## 11. Decided

1. **Organization layer**: add an "organization" above the workspace as the tenant boundary. All tables carry `org_id`, and v1 has only one default organization.
2. **A visible dashboard means visible data**: viewing a dashboard does not require a separate grant on the dataset, and the data scope is constrained by data permissions.
3. **All open source**: there are no open source and enterprise editions. Row and column permissions, masking, SSO and everything else are open source under Apache 2.0. The earlier split put row-level permissions in the open source edition and column-level permissions and data masking in the enterprise edition. It was dropped on 2026-10-17.
4. **Roles**: three fixed roles, Viewer, Developer and Admin. There are no custom roles; see 4.1.

## 12. Later decisions

1. **Accounts and groups belong to the organization. Memberships and custom user attributes belong to the workspace.** Accounts and groups are maintained by system administrators in one place, and creating an account and adding it to a workspace are two separate operations. Workspace admins can only pick the subjects to grant from existing accounts or global groups, and workspace groups are not provided.
2. **The management entry points are split into System administration, Workspace settings and Personal settings.** For the specific routes, visibility and the display of the sources of access, see 2.2.

## 13. Implementation status

| Capability | Status |
|---|---|
| Table structure for organizations, workspaces, users and member roles | Implemented |
| Local account sign-in, sessions, initializing the admin on first run | Implemented |
| Blocking APIs by role | Implemented; see the permission requirements table in `internal/api/session.go` |
| User management (create, disable, reset password, make system administrator) | Implemented, limited to system administrators; creating an account does not grant workspace access |
| Workspace member management (add, change role, remove access) | Implemented; shows the direct, group and system administrator sources of access |
| Global groups and their roles in workspaces | Implemented; workspace groups are not provided |
| Three kinds of settings entry points | Implemented; global, workspace and personal each have their own navigation |
| Multiple workspaces (create, settings, switch, delete) | Implemented; a deleted workspace can be restored within the retention period, see 2.3 |
| Dashboard grants | Implemented, see 4.2; inheritance by folder and grants on datasets and data sources are not implemented |
| Row-level and column-level permissions | Implemented, see section 5; dynamic user attributes are implemented; masking and system variables are not implemented |
| Audit | Implemented, see section 7: storage in the database, the query UI in System administration, the application log; the view for workspace admins and shipping out by push are not implemented |
| SSO | Not implemented |
| OAuth authorizations of MCP clients | Implemented, see [AI assistant](ai-assistant.md) section 14 |

Details settled during the implementation:

- **Sessions** are stored in the metadata database. The browser holds only a random token, and the database stores only the hash of the token. The cookie is `HttpOnly` and `SameSite=Lax`. A session expires after being inactive for longer than the sign-in session lifetime, which defaults to seven days and is changed under "System administration → General" ([Startup configuration](configuration.md) 10.7). Expired sessions are deleted by the hourly maintenance job; see 7.6.
- **Cross-site request protection**: besides `SameSite`, the server rejects write requests whose origin does not match its own.
- **Passwords** are hashed with Argon2id, with the parameters stored together with the hash, so they can be raised later without affecting existing passwords. Each hash or check takes 19 MiB of memory, so each process runs at most four at once, whatever they are for: signing in, setting up, changing or resetting a password, creating an account. The others wait their turn, and stop waiting when their client leaves. Unlimited, 64 checks at once took 1.2 GB, and anyone who can reach the sign-in page could start them. Four at once still check about 250 passwords a second, and the CPU limits how many can be checked anyway.
- **Failed sign-ins** return exactly the same result for "account does not exist" and "wrong password" and take a similar amount of time, so they cannot be used to probe whether an account exists. After five failures for the same email within five minutes, sign-in is not accepted again until those five minutes end. The failure count is stored in the metadata database, all instances share the same count, and time is taken from the database. The count is reset after a successful sign-in, and records from a day ago are deleted by the hourly maintenance job. Each attempt is counted before its password is checked, in one statement that refuses it once the window already holds five, and a successful one clears the count. Counted after the check, attempts made at the same time all passed the limit before any of them was counted: 40 at once were all checked. A refused attempt does not add to the count, so the window still ends five minutes after its first failure.
- **A role change takes effect immediately**, with no need for the person to sign in again. Disabling an account or resetting a password immediately ends all of that person's sessions.
- **An admin cannot change their own role, status or organization admin status**, and cannot remove themselves from a workspace, so that they cannot lock themselves out.
- **Migration**: when changing from permission-point roles to three roles, members holding "manage members" become Admins, those holding "edit datasets" become Developers, and the rest become Viewers. The migration can only make people lose abilities, never gain them, and whatever is needed is promoted again by an admin: the former "Editor" becomes a Viewer; a custom role with only "manage data sources" and without "edit datasets" loses data source management; a custom role with only "manage workspace settings" and without "manage members" loses workspace settings.
- **The thresholds of the three kinds of operations**: public (sign-in related); at least a certain role within the current workspace; requires the organization admin (changes the organization itself: accounts, groups, workspaces).
- **The role required by each API**: viewing charts and dashboards, fetching their data and filter candidates, sharing a dashboard and opening the shared conditions ([Charts and dashboards](chart-dashboard.md) 3.10), exporting the chart data on a dashboard that is allowed to be exported require a Viewer. Viewing, canceling and downloading one's own exports need only a signed-in user, with no current workspace: each export is checked in the workspace it was made in. Editing and draft preview of data sources, Data exploration, datasets, charts and dashboards, folders, and lineage and reference relationships require a Developer, and so do SQL export and its download. Members and workspace settings require an Admin. Viewers have no entry for querying datasets directly.
- **A new API must register its permission requirement**, or it is denied by default, and a test ensures that the permission table is consistent with the API definitions.
