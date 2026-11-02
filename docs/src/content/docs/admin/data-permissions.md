---
title: Data permissions
description: Limit which rows and fields Viewers see, per person or group.
---

Data permissions limit what Viewers see on dashboards: which rows and which fields. They are set on a dataset, and apply wherever its data is read, including exports and the AI assistant.

They do not apply to Developers and Admins, who can write SQL against the data source anyway. To protect data from them, limit the account of the data source.

Open a dataset and go to the **Data permissions** tab. It is off until the first rule is saved.

## Add a rule

1. Click **Add row or column permission**.
2. Enter a **Rule name**, and choose the **Rule type** and the **Applicable members**: users, groups or **Every member**.
3. Set the content of the rule, and click **Finish editing**.
4. Click **Save** below the rule list. Rules take effect only then.

Rules are saved apart from the dataset, so changing them creates no dataset revision. Deleting the last rule and saving turns permissions off, and Viewers then see all rows and fields.

## Row permissions

A **Row permission** says which rows its members can see, with one or more conditions. Conditions combine with **Match all conditions (AND)** or **Match any condition (OR)**, and each value is a **Fixed value** or a **Dynamic value** from a [user attribute](#user-attributes).

Which rows someone sees is decided in this order:

1. **Covered by at least one rule**, directly, through a group or as every member: they see only the rows those rules let through. Several rules add up, so someone in both the East and South groups sees both.
2. **Covered by no rule**: decided by **Whoever no row rule covers**. Either they see all rows, for when only a few groups are limited, or they see none, for data where everyone should see only their part.

Being in another group with no rule does not lift a limit. Someone in the East group and the Headquarters group, which has no rule, still sees only East. Restrictions that must all hold, such as region and department, go in one rule with **AND**.

A rule whose field was deleted or changed type shows as invalid, and the people it covers see no rows. A field that a rule uses cannot be deleted from the dataset.

## Column permissions

A **Column permission** restricts its **Sensitive fields**. The scope is set once for the dataset, under **Row and column permission scope**:

- **Applicable members can see these columns; everyone else cannot**
- **Applicable members cannot see these columns; everyone else can**

Fields with no rule are visible to everyone, new fields included. A calculated field that refers to a restricted field is restricted too.

Someone who cannot see a field does not find it anywhere. A chart that uses it shows "This chart uses a field you may not see", and the other charts on the dashboard are not affected.

## User attributes

An attribute lets one rule give each person their own rows, instead of a rule per person. A rule such as `Region matches any regions` reads each viewer's `regions` values.

Set them up under **Workspace settings → User attributes**. Workspace Admins can change them, and Developers can read them.

1. Click **Add attribute** and enter a name and an **Attribute key**. The key cannot change later.
2. Click a cell to set the values for one user or group, one per line.

Rules can also use the built-in **User ID**, **Email** and **Name**.

- A user's own assignment replaces those of their groups, even if it is empty. Otherwise the values of all their groups are merged. **Remove explicit assignment** returns to the groups.
- Text must match the dataset exactly, including case and spaces. `*` is an ordinary character, not "everything".
- A missing or empty attribute lets no rows through that rule.
- Changes apply on the next query, with no need to sign in again.
- Attributes do not grant access to a workspace or dashboard by themselves.

## Check the result

**Preview as someone** picks a user and shows the rows and columns they can actually see on this dataset. Use it to check what a configuration leaves out, especially on a dataset where people not covered see all rows.
