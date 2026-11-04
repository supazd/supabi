---
title: MCP
description: Connect an AI client of your own, such as Claude or Cursor, to read the dashboards you can open, with a source for every number.
---

SupaBI has an MCP address. Connect an AI client of your own to it, such as Claude, ChatGPT, Claude Code or Cursor, and the client can read the dashboards you can open, as you. It uses the same four tools as the [AI assistant](/admin/ai-assistant/): list dashboards, describe one, look up the values of a filter, and read the data of a chart.

## Turn it on

MCP is off until a system administrator turns it on, under **System administration → General**, group **MCP service**: tick **Allow** for **MCP clients** and save.

It is off by default because the data goes to the model your client uses, which the administrator did not choose. The AI assistant, by contrast, uses only the models set up in [AI models](/admin/ai-assistant/#set-up-the-models). Turning it off stops every client at once. Their authorizations are kept and work again once it is turned back on.

## Connect a client

1. Open **Personal settings → MCP** from the account menu and copy the **MCP address**. It ends in `/mcp`, such as `https://bi.example.com/mcp`.
2. In your client, add a remote MCP server (Streamable HTTP) with that address. In Claude Code, for example:

   ```bash
   claude mcp add --transport http supabi https://bi.example.com/mcp
   ```

3. The client opens SupaBI in your browser. Sign in if asked, check the client's name and where the answer goes, and click **Allow**.

There is no token to copy: the client signs in with OAuth and renews its access by itself. A client that goes unused for the **Session lifetime** in General settings, 7 days by default, has to be allowed again.

The page shows who you are signed in as and where the answer goes. The client's name is chosen by whoever registered it, so allow it only if you started connecting it yourself just now.

## What a client can read

- One authorization covers every workspace you belong to. The client lists the dashboards of all of them, and reads each dashboard in its own workspace, with that workspace's time zone and your [data permissions](/admin/data-permissions/) there.
- It reads only what you can see in SupaBI, and changes nothing. It cannot query datasets or write SQL.
- A chart returns at most 200 rows, as for the AI assistant. The **Allow data exports** switch of a chart does not apply, because nothing is downloaded beyond what the chart shows.
- Each chart's data comes with its source: the dashboard, the chart, the conditions in effect, and a link that opens the dashboard under those conditions. The link keeps the conditions for 30 days. SupaBI asks the client to cite these sources, but cannot control how it writes its answers.

## Where a client connects from

Clients that run on your computer, such as Claude Code, Cursor and VS Code, connect from there. The connectors of Claude on the web and desktop, and ChatGPT, connect from their providers' cloud. A SupaBI reachable only inside a company network therefore works only with clients that run on your computer.

## Revoke a client

**Personal settings → MCP** lists the clients you allowed, with where each answers, when you allowed it and when it was last used. **Revoke** stops it at once.

When an administrator disables an account or resets its password, the person's clients are revoked too. Allowing and revoking a client are recorded in the [audit log](/admin/system/#audit-log) under **Sign-in**, and every fetch of data is recorded under **Queries**, noting that it came from MCP and which client.
