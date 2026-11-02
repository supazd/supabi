# AI assistant

Status: the first step (the most basic Agent), the second step (the usage page, section 13) and the third step (tools, section 12) are implemented. The fourth step only records a direction and will be designed when we get to it.

## 1. Positioning

- The AI assistant is an Agent, used first by viewers. The first problem it has to solve is getting people the data they want quickly.
- The data comes from the dashboards and charts the user has permission to see. Datasets are not queried directly; they are used to explain definitions (a field's display name, description and synonyms).
- Every number in an answer needs a source: which dashboard, which chart, which filter conditions, and which version of the chart and dataset. Otherwise the user gets a number that does not exist anywhere in the system, and data developers cannot check how it was computed or whether it matches the internal definitions. The generated SQL is not shown to viewers: with the versions and conditions the result can be reproduced, and the audit log records it too (12.3).
- Like the other entry points, the AI does not write SQL itself ([Architecture overview](architecture.md) section 3).

## 2. Steps

| Step | Content |
|---|---|
| 1. The most basic Agent | Models are configured in System administration; chat works; the context is compacted; usage and cost are recorded. Sections 3 to 10 of this document |
| 2. Usage page | A separate page in System administration. It shows usage and cost by person, model, workspace, purpose and day; it does not show conversation content. What data the AI read is already in the audit log. Section 13 |
| 3. Tools | Tools are assigned by role; four read-only tools look up charts on the dashboards the user can open, and answers carry their sources; a number that is not on any chart is worked out with the calculator, and the calculation is also a source. Section 12 |
| 4. Memory and past conversations | Remember the user's preferences and habits, and refer to earlier conversations |

Get the Agent itself working first, then add tools. During development we do not add restrictions just because "there are no tools yet".

## 3. Model configuration

### 3.1 Providers and models

System administration gets a new "AI models" page. Only system administrators can see and change it. It is shared by the whole organization and is not split by workspace. A change takes effect at once: the current configuration is read from the metadata database before each model call, so all instances agree and no restart is needed. An answer that is already being generated is finished with the model it started with.

**Provider**:

| Item | Description |
|---|---|
| Name | Chosen by the administrator, such as "DeepSeek" or "Internal vLLM" |
| Protocol | In the first step only "OpenAI-compatible" (the streaming interface of Chat Completions). DeepSeek, Qwen, Kimi and Zhipu, and models deployed with vLLM or Ollama, all offer this interface. "Anthropic" will be added later, since Claude uses its own protocol |
| API address | Such as `https://api.deepseek.com/v1` |
| API key | Encrypted with `secret-key` and stored in the database, like data source passwords. On read the plain text is not returned, only whether it is set; if left empty on edit, it stays unchanged |

A **model** belongs to one provider:

| Item | Description |
|---|---|
| Model ID | The name passed when calling the interface, such as `deepseek-chat` |
| Context length | In tokens. Context compaction decides by it (section 6). You can write it the provider's way, 128K or 1M; 1K counts as 1,000 |
| Max output | In tokens, sent with every call |
| Thinking level | Optional. If filled in, it is sent to the provider as is, as `reasoning_effort`; if empty, nothing is sent and the provider decides. See below |
| Prices | Per million tokens: input, cache-hit input, cache-write input, output. Some providers do not charge cache hits and cache writes separately; for those the prices can be left empty, and then the input price is used |
| Currency | The currency of this model's prices, stored as an ISO 4217 code, such as `CNY` or `USD`. It is chosen from a list that shows the code, symbol and name, and all three are searchable. Different providers can use different currencies |

Amounts use fixed-point decimals, not floating-point numbers. Prices and currency can both be changed, and a change only affects later usage records.

The thinking level is text, not a dropdown: the values differ by provider. DeepSeek and Kimi use low, high and max, and OpenAI also has none and xhigh, so any fixed list would miss some. A wrong value is rejected by the provider, and you see that when you click "Test" (3.3), so we only limit the length, to 32 characters at most.

- It is used only for answering questions and for testing. Title generation and context compaction do not send it: their token limits are small (1024 and 4096), and the model's thinking counts toward them, so at a high level the limit could be used up before any result is written.
- When a level is set, a test uses the model's max output, as answering does; otherwise thinking uses up the allowance and the test wrongly reports an empty reply or no tool call. When no level is set, the test's allowance is unchanged.
- Not every provider accepts it: Qwen uses `enable_thinking` and `thinking_budget`, so leave it empty for such models. We do not support these parameters, or switches such as `thinking.type`.

Deleting: a model that is in use for any purpose cannot be deleted; replace it first. Deleting a provider deletes its models too, and it likewise requires that none of those models is in use. Usage records store a snapshot of the names at the time, so deletion does not affect them.

### 3.2 Purposes

Different jobs use different models; choose one for each:

| Purpose | Description |
|---|---|
| Chat | Answers the user; must be set |
| Titles | Gives a conversation a title; when not set, the chat model is used |
| Context compression | Summarizes the earlier part of a conversation; when not set, the chat model is used |

Users can never choose a model themselves. Only administrators change it, in the back office, and users do not need to know about models. When no chat model is set, the AI assistant page says that an administrator has not set a model yet; the message shown to a system administrator has a link to set one up.

### 3.3 Test

Each model has a "Test" button. It sends a very short request and shows whether it succeeded and how long it took, and on failure the error the provider returned. A test also costs money, so it records one usage entry, with the purpose "Tests".

## 4. Conversations

### 4.1 Entry point and ownership

- The top bar gets a new "AI assistant" entry, available to every role. The conversation list is on the left of the page, and the current conversation is on the right.
- A conversation belongs to "the person + the workspace": after switching workspace, you see the conversations of that workspace. The tools of the third step read the dashboards of the current workspace, so conversations follow the workspace. When a workspace is permanently deleted, its conversations are deleted with it.
- Only the person who owns a conversation can see it. Calling the API with someone else's conversation ID gets "does not exist".

### 4.2 Conversation list and titles

- Create, rename and delete, sorted by most recent update. Deleting a conversation deletes its messages; the usage records are kept.
- After the first round of answering is complete, the title generation model writes a short title from the first question and the answer, and the list updates by itself once it is ready. Before that, or if generation fails, the title is the beginning of the first question. A conversation the user has renamed is no longer renamed automatically.

### 4.3 Sending, streaming and stopping

- The user sends a message. The server saves it first, then calls the chat model, pushes the incremental text to the browser over SSE (`text/event-stream`), and saves the complete answer when it is written.
- In the input box, Enter sends and Shift+Enter starts a new line; an Enter pressed while an input method is composing text does not send.
- Only one answer can be generated at a time in the same conversation; no further message can be sent while it is being generated.
- Before any text has been output, "Thinking…" is shown. Some models (such as DeepSeek's reasoning models) return the thinking process separately before the main text. In the first step we neither show nor save it, and only treat it as "still working".
- After "Stop", the server cancels the request to the model, saves the part that has already been generated, and marks it "Stopped".
- Generation follows the request and is not put into a background job. Closing, refreshing or leaving the AI assistant page is the same as stopping. This is the simplest way, and the cost is that refreshing the page interrupts the answer. Switching to another conversation inside the AI assistant does not stop it; the answer is finished in the background, and while it is being written no message can be sent in another conversation.
- An answer being written saves the part written so far every 15 seconds, which also shows that it is still being written. If the service exits abnormally, an answer that was not finished counts as interrupted after one minute without an update. When the conversation is opened again it is shown as failed (the reason is interruption) and can be retried.
- When deployed behind a reverse proxy, the proxy must not buffer the response of this endpoint, or the text piles up and comes out all at the end. The server sends `X-Accel-Buffering: no`; other proxies need separate configuration.

### 4.4 Errors

When the model cannot be reached, times out, the key is wrong, the request is rate limited, or the provider returns an error, the answer is marked failed and the reason is shown. The user can "Retry", which regenerates this one answer. If the provider sends nothing at all for a long time (5 minutes for now; the thinking process and the comment lines it sends to keep the connection alive both count), the call is interrupted and handled as a timeout.

When a single message is by itself longer than the usable context, it is not sent, and we say directly that this message is too long. Apart from that, a conversation, however long, should not fail because it exceeds the context; see section 6.

### 4.5 Display

- The user's messages are shown as plain text, keeping line breaks.
- Answers are shown as Markdown, using the AI assistant's own component and not reusing the code of the dashboard "Text" widget: the text widget will change later, and the AI side will also add features as needed, so the two evolve separately.
- The requirement for the first step is that rendering works while streaming: a code block, table or list that is half written does not break or flicker. Rendering uses react-markdown and remark-gfm (tables, strikethrough and other GitHub syntax). While an answer is being written, remend first closes the unfinished bold, code and links at the end, and then it is rendered. A single tilde is not treated as strikethrough, so "20~25%" is shown as written. Text is merged and refreshed every 50 milliseconds, so even when the model outputs very fast, the view is not redrawn every few characters.
- Headings, lists, tables, code blocks, links and images are supported; external images are shown as usual, and links open in a new tab. HTML in Markdown is shown as text and is not executed.
- When the message list is opened, it stays at the end. While an answer is being written, a reader who is at the end follows it down; a reader who has scrolled up stays where they are, and a "Back to latest" button appears. Sending a message goes back to the end. It uses use-stick-to-bottom.
- These interface components (message list, message, Markdown, input box) are in `Chat.tsx` of the component package `packages/ui`, and the AI assistant page imports only from the component package; see [Architecture overview](architecture.md) 11.2. We do not use AI Elements from the shadcn ecosystem; the reason and when to re-evaluate are in [Deferred items](../backlog.md).

## 5. What is sent to the model

- **System prompt**: it is the SupaBI AI assistant; answer in the user's language; the current date and the workspace time zone; use tools to look up data on the dashboards the user can open, and how to write numbers and how to cite sources is in 12.3 (in the first step it was "data cannot be looked up yet; say so honestly and do not make up numbers"). It is written in code and is not configurable.
- **Conversation**: system prompt + compaction summary (if any) + the messages after the summary. A stopped answer was seen by the user, so it is included as usual; a failed one is not.

## 6. Context compaction

However long a conversation gets, it must not fail because it exceeds the context. At a certain length, the earlier part is compacted into a summary.

- **Judging how much is used**: on every model call, the provider returns how many input and output tokens this call used, from which we know how long the context of this conversation already is. The server does not count tokens itself for each model; when the provider returns no usage, it estimates from the character count.
- **When to compact**: when the input plus output of the previous call, plus the new message being sent (estimated from the character count), exceeds 80% (provisional) of the usable context (context length minus max output), it compacts first and then sends. If the provider still reports that the context is too long, it compacts and retries once.
- **How to compact**: the context compaction model summarizes the old summary and the messages to be compacted into one new summary, keeping the user's goals, the conclusions reached so far, the open questions and the names mentioned. The most recent messages are kept as they are, up to a quarter (provisional) of the usable context, and at least the last round is kept. When the content to be compacted exceeds the compaction model's context, it is summarized in segments.
- **Only the latest summary is kept.** It is stored on the conversation, together with the message up to which it summarizes.
- **What the user sees does not change**: the interface still shows the complete conversation, and only what is sent to the model is different. During compaction it shows "The conversation is long; tidying it up…".
- The cost of compaction is recorded as usual, with the purpose "Context compression".

## 7. Usage and cost

Every model call records one entry; the page is in section 13:

| Content | Description |
|---|---|
| Time, organization, workspace, user | |
| Conversation, message | Empty for tests |
| Purpose | Chat, Titles, Context compression, Tests |
| Provider, model | A snapshot of the name and model ID |
| Tokens | Input that missed the cache, input that hit the cache, cache writes, output; the four do not overlap |
| Cost, currency | Computed from the model's price and currency at the time of the call and stored; changing the price or currency later does not affect existing records |
| Duration, result | Succeeded, Failed, Stopped |
| Estimated or not | When the provider returned no usage, it is estimated from the character count, and this is marked |

Providers report usage in different ways; it is all converted into the four categories above before it is recorded:

- The input reported by OpenAI-compatible interfaces (`prompt_tokens`) includes the cache-hit part (`prompt_tokens_details.cached_tokens`), which must be subtracted; some providers use their own fields, such as DeepSeek's `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens`.
- For streaming calls, usage has to be requested in the request (`stream_options.include_usage`), and the provider returns it in the last chunk. On stop or failure it may not be available, and then it is estimated from the character count.
- When the Anthropic protocol is added later, its `input_tokens` does not include cache reads and writes; cache hits and cache writes have two other fields.

When costs are totaled, they are split by currency: different currencies are neither added nor converted, because the system has no source of exchange rates.

Records have no foreign keys. They are kept as usual after a user, conversation or model is deleted, and also when a workspace is permanently deleted: like the audit log, they are the organization's records. The retention period is the same as the audit log's, see 13.5.

## 8. Permissions and audit

- AI assistant: at least a viewer, that is, all roles. This is the conclusion of "decide which role it belongs to when we get to it" in [Access control and workspaces](access-control.md) 4.1.
- Model configuration and purposes: system administrators.
- Creating, deleting and changing model configuration, and setting purposes, are recorded in the existing audit log, in a new category `ai`. The request content contains the API key, so, as with data sources, only the object is recorded, not the content.
- Conversation content does not go into the audit log, and administrators cannot see it either (13.2). What data the AI fetched is recorded in query events (12.6).

## 9. Metadata database and API

| Table | Content |
|---|---|
| `ai_providers` | Name, protocol, API address, encrypted API key |
| `ai_models` | The provider it belongs to, model ID, context length, max output, the four prices, currency |
| `ai_settings` | One row per organization: which model is used for chat, titles and context compression |
| `ai_conversations` | Organization, workspace, user, title, whether the owner has renamed it, the summary and the message it summarizes up to |
| `ai_messages` | The conversation it belongs to, sequence number, role (user, assistant), content, status (generating, complete, stopped, failed), error, the model used, the context token count reported by the provider |
| `ai_usage` | The content of section 7 |

Endpoints:

| Endpoint | Description |
|---|---|
| `GET /ai/config` | A system administrator reads all providers, models and purposes; for the API key it only says whether one exists and does not return the plain text |
| `/ai/providers`, `/ai/models`, `/ai/settings` | System administrators configure providers, models and purposes; `POST /ai/models/{id}/test` tests a model, and the error the provider returned is shown to the system administrator as is |
| `GET /assistant` | Whether a chat model is set; the page shows its notice based on this |
| `/assistant/conversations` | The owner's conversations in the current workspace: list, create, rename, delete, and read messages |
| `POST /assistant/conversations/{id}/messages` | Sends a message and returns SSE: start (the two saved messages), status (thinking, compacting the conversation), incremental text, done (the final answer, with the reason when it failed), title. If the conversation already has an answer being written, or no model is set, the request is rejected at once with an ordinary error |
| `POST /assistant/messages/{id}/retry` | Regenerates a failed answer, returned the same way |

## 10. Room left for the later steps

- **A message's content is stored as a series of "parts"**: the first step has only text. In the third step, tool calls and tool results (with sources) go into the same series, with no change to the table structure.
- **The Agent loop**: in the first step each answer calls the model once (`write` in `internal/assistant`). In the third step this becomes a loop of "call the model → if there are tool calls, run them → give the results back to the model" (12.4). The tool list is computed for the current user: each tool registers the lowest role it needs, and a tool that is not registered is not given, the same as for the API. If we later need finer control by person or group, it is extended in this one place.
- **Summary and sources**: when compacting, a number in an earlier answer loses its source once it goes into the summary. The third step decided that a summary only records what was looked up, not the values, and looks it up again when needed (12.4).
- **Conversations are stored on the server**, and the fourth step's reference to past conversations builds on this. Memory records only preferences and habits (which dashboard is viewed often, which metric "revenue" refers to), not the data itself: numbers are looked up again each time, since a remembered number goes stale and has no source.

## 11. Not in the first step

- Tools and sources (third step); the usage page (second step); memory and referring to past conversations (fourth step).
- Users choosing the model themselves: never.
- The Anthropic protocol: added as the next protocol.
- Safety limits on answer content (such as external images): considered later.
- Showing the thinking process, a configurable system prompt, uploading files and images, editing a sent message, regenerating a successful answer, sharing and exporting conversations.

## 12. Third step: tools

Status: implemented.

### 12.1 Scope

- Four read-only tools, all needing only the viewer role. Data is fetched only from dashboards the person can open, in the same way as operating on the dashboard: global filters, chart filters, dynamic dimensions and metrics, drill-down, chart links.
- Each tool corresponds to an existing viewer endpoint, calls the same functions, and runs as the current user. Dashboard authorization, row-level and column-level permissions, the query cache and audit work as before, and there is no separate set ([Architecture overview](architecture.md) sections 1 and 3). A viewer can only submit values, not queries ([Charts and dashboards](chart-dashboard.md) 3.5), and this holds for the AI too.
- Not doing: querying datasets directly and writing SQL (viewers have no such entry, see [Access control and workspaces](access-control.md) 4.1.1); lineage and references (only data developers can see them); export and generating personal dashboards (they are not read-only); an MCP service (only reserved, see 12.7).

### 12.2 The four tools

| Tool | Input | Returns | Corresponding endpoint |
|---|---|---|---|
| `list_dashboards` | None | The dashboards in the current workspace that the person can open: ID and name, and the ID and name of each chart widget on each dashboard | `GET /dashboards` |
| `describe_dashboard` | Dashboard ID | The filters, and how each chart can be queried, see below | `GET /dashboards/{id}` |
| `filter_options` | Dashboard ID and filter ID, plus the widget ID for a chart's own filter; optional search term and the values already selected in other filters | At most 500 candidate values and whether they were truncated, the same as the candidates in the UI; for cascading filters, narrowed by the values already selected | `POST /dashboards/{id}/filters/{filterId}/options`, `POST /dashboards/{id}/items/{itemId}/filters/{filterId}/options` |
| `query_chart` | Dashboard ID and widget ID; global filters, chart filters, dynamic selections, drill-down path, and the values of chart links | Data and sources, see 12.3 | `POST /dashboards/{id}/items/{itemId}/data` |

The list and the details are separate: with many dashboards, giving the fields of all the charts at once would fill the context. The model first picks a dashboard by name, then looks at its details.

`describe_dashboard` returns:

- **Global filters**: ID, name, field type, operator, single or multiple selection, default value, which charts it applies to, and the parent filter for a cascade. Parameter filters ([Charts and dashboards](chart-dashboard.md) 2.11) are listed the same way. A time filter says that relative time can be used (such as "last month"), which the server resolves in the workspace time zone.
- **Each chart**: widget ID, name, chart type; the display names of the dimensions and measures, and their descriptions and synonyms in the dataset, used to match the words the user says and the definitions; the chart's own filters, written like global filters, with a note of which ones are taken over by global filters; the dynamic positions and their candidates; and, when drill-down is possible, the drill-down dimensions and the names of the levels below.
- **Chart links** are written on the target chart: "can be narrowed by Region equal to a value, with the value taken from [column] of [source chart]", so the model does not need to understand source and target.
- Only chart widgets are listed; widgets such as title and text are not. Field descriptions are given according to column-level permissions, and fields that cannot be seen are not given ([Access control and workspaces](access-control.md) 5.2).

The values `query_chart` takes are the same as the dashboard data request ([Charts and dashboards](chart-dashboard.md) 3.5), except that "Refresh data" and "Use chart filters" are not offered: the AI fetches data under the cache rules, like a viewer; a chart filter taken over by a global filter is changed through the global filter.

### 12.3 Results and sources

- **Data handed to the model**: column names use display names, values use raw values, and each column carries its display format (percentage, decimal places, unit), so the model writes numbers in that format. At most 200 rows (provisional); extra rows are cut off and the model is told the total number of rows; totals are given as usual.
- **Sources**: one `query_chart` is one source, numbered [1], [2] within an answer. A source records:
  - the ID and name of the dashboard and chart widget, and the version numbers of the dashboard, chart and dataset;
  - the conditions actually in effect: global filters, chart filters, dynamic selections, drill-down path, chart links, including defaults used when nothing was passed; a relative time is written as the resolved start and end dates, and a date parameter's value relative to today (such as `today-1d`) is written as the actual day on which the data was fetched;
  - the time of the data (the cache time on a cache hit), and whether the model read only some of the rows. A chart that lists only its top rows does not count: the model reads every row it shows;
  - the link used to open it, see below.
- **No SQL for viewers**. The version numbers plus the conditions are enough to reproduce a result; every SQL statement is also recorded as usual in the audit log's query events ([Access control and workspaces](access-control.md) 7.3).
- **Links** borrow share links to store the conditions ([Charts and dashboards](chart-dashboard.md) 3.10): when data is fetched, the conditions of this call are stored as one share, with the page and tab the chart is on, and opening it shows the chart. It is valid for 30 days, and the link is put into the tool result. With no conditions at all, nothing is stored, and what opens is the dashboard itself. The drill-down position the server stores is only values, and when the link is opened it is written out at the granularity of each level. This is not someone sharing, so no `dashboard.share` event is recorded, while the data fetch itself records a query event as usual. Shared conditions must first be able to carry the drill-down position (3.10); otherwise a source obtained after a drill-down opens at the first level.
- **Expiry**: when "Open" on a source is clicked in the app, the stored conditions are saved again and then opened. The same conditions get the same ID and the expiry time is pushed back, so the sources of old conversations can be opened too. This time it goes through the share endpoint, and a `dashboard.share` event is recorded. A link that exists only in a tool result (the future MCP) stops working when it expires.
- If the dashboard or chart is later changed or deleted, the source still shows the name and version of that time. The link opens the current dashboard, and if it cannot be seen, it says that it does not exist or that there is no permission, the same as for the dashboard itself.

**How an answer uses sources**, written into the system prompt:

- A number in an answer can only come from tool results, and each number is followed by its source number, such as "East China revenue last month 1,234 万元[1]".
- A number that is not on any chart but can be computed from numbers that were looked up (a difference, a growth rate, a share) is worked out with `calculate`, not in the model's head, and the text says how it was computed (12.9). Comparing sizes and talking about rankings is fine. When the number the user wants can be neither found nor computed, say so honestly and point to the closest chart.
- When several charts could be the number the user wants, say which one was used and mention the others.

**Interface**: below the answer are the sources of that answer, folded by default into one line that gives the number of sources and the dashboards used, such as "5 sources · Sales dashboard, Inventory dashboard". Duplicate dashboards are removed, the rest are ordered by source number, and the list is cut short when it does not fit on one line. Click the line to expand it and click again to collapse it. When there are many sources, listing them one by one would be longer than the text itself and would steal the attention, so, like the data-fetching steps, they are folded. Once expanded, each source shows "Dashboard › Chart", a summary of the conditions (written the same way as in the share dialog), the time of the data and "Open". The numbers in the text can be clicked: if the sources are folded, they expand first, and then it jumps to the matching one. Each answer expands and collapses on its own and this is not remembered; when a conversation is opened again, they are all folded. While an answer is being written, the count grows as data is fetched. During generation, a tool call is shown as one status line, such as "Reading the data: Sales dashboard › Monthly revenue"; when the answer is written, these fold into "Looked things up 3 times", which can be expanded. The components go into `packages/ui`; per the convention in [Deferred items](../backlog.md), we first evaluate whether the tool and inline-citation components of AI Elements are suitable.

### 12.4 The Agent loop

`write` becomes a loop: the model is called with the tools; if the model wants to call tools, they are run in turn, the results are handed back, and the model is called again; when the model no longer calls tools, the text of that call is the answer.

- **Limit**: one answer calls tools at most 20 times (provisional). At the limit, the last call is not given tools, so the model answers from the results it already has. Several tools called in one model reply also count toward it; those over the limit are not run, and the model is told that the limit has been reached.
- **A tool error** (unknown filter or candidate, no permission, query failed) does not fail the answer: the error description is handed to the model as the tool result, and the model can change the call and try again, or tell the user honestly.
- **Stop**: a query being run is canceled too, and the text already written and the tool results are saved.
- **Context**: the tool calls and results of earlier rounds are sent to the model as usual, which is useful when the user follows up with "and South China?"; when they get too long, they are compacted as in section 6. When compacting, the summary only records what was looked up (dashboard, chart, conditions) and not the values; when a number is needed it is looked up again, so that numbers do not lose their sources. Tool results within one answer are not compacted; when this answer has used 80% of the usable context, no more tools are given, and the model answers from the results it already has.
- **SSE events** gain a "tool" event: when execution starts it carries the tool name, and when it ends it is sent again, with what was looked up (the names of the dashboard and chart) and the sources. When the written part is saved every 15 seconds, the tool calls and results are saved along with it. On stop, the call being run is not saved: what it returned is not known.
- **The model must support tool calls** (`tools` in the OpenAI-compatible interface, `tool_calls` in the streamed response). A model's "Test" sends one more request with tools, and when they are not supported it warns the administrator. Whether a reasoning model's thinking process must be sent back within the tool loop differs by provider; the implementation follows what is measured for each provider.

### 12.5 Storage

- An answer's "parts" (section 10) gain one more kind, "tool": one call and its result are in the same part (call ID, tool name, arguments, the content handed to the model, what was looked up, the sources), and sit together with the text parts in the order they happened, with no change to the table structure. A part records in which model call of this answer it was issued: tools issued by the same call are handed back to the model together. A reasoning model's thinking process is recorded on the first tool of each call, and is handed back only within this answer; later answers do not carry it.
- The API gives the UI only the tool name, what was looked up, whether it finished or failed, and the sources, and not the content handed to the model.
- "Retry" regenerates the whole answer, and the tool calls are made again.

### 12.6 Tool definitions and permissions

- Each tool is registered once: name, the description shown to the model, parameter format (JSON Schema), lowest role, and the function that runs it. The in-app Agent loop and the future MCP service (12.7) are two shells around the same set of tools.
- The tool implementations are in the API layer (`internal/api`) and call the same functions as the handlers of the corresponding endpoints. `internal/assistant` only knows the interface "tool": api imports assistant, and importing the other way would make a cycle.
- They run with the identity and workspace of this request, like the endpoints. The tool list is computed by role, and a tool that is not registered is not given (section 10); these four are all for viewers.
- Every data fetch (`query_chart`, `filter_options`) records a query event as usual, with the dashboard as the object and details noting that it came from the AI assistant.
- The tools themselves cost no model money; usage and cost are recorded on the model calls, as in section 7.
- `calculate` (12.9) is not registered here: it touches no data and involves no permissions, so the Agent loop provides it itself.

### 12.7 Reserved for the MCP service

Later we want an MCP service, so that viewers can fetch data with a local Agent. The plan is to add a remote MCP address to the same program; users enter the address in their local Agent and can use it, with no other program to install. This step is not done. It only guarantees two things, so that there is no rework later:

- The tools do not depend on the AI assistant (12.6); MCP exposes the same set of tools directly.
- Sources are in the tool result, with links (12.3): an MCP client sees only the tool results.

MCP does not offer `calculate` (12.9): a local Agent has its own ability to compute.

To decide when MCP is built: login methods other than the browser (personal token or OAuth), and which workspace a token belongs to; data leaves the system through the user's own model, which is in effect an export, so whether to restrict it by the chart's "Allow data exports" and whether administrators need a master switch. Model configuration, cost, compaction and conversations belong only to the in-app Agent, and MCP does not use them.

### 12.8 Order of implementation

The original plan had three steps; in practice they were implemented and tested together:

1. Share links carry the drill-down position ([Charts and dashboards](chart-dashboard.md) 3.10). It is itself an improvement to the viewing experience and can be tried on its own.
2. The model's tool calls, the Agent loop and message parts, plus `list_dashboards` and `describe_dashboard`: one can ask "which dashboards are there" and "what can I see in this dashboard".
3. `filter_options`, `query_chart`, sources and the UI: one can ask for numbers with sources.

### 12.9 Calculation

Status: implemented.

A number that is not on any chart but can be worked out simply from the numbers that were looked up (a difference, a growth rate, a share, the sum of several items) used to get no answer at all, which looked odd. Now the model works it out with the `calculate` tool and does not do the arithmetic in its head, and the expression is listed as a source.

At first the model was not allowed to calculate, because of three worries. Here is how much the calculator covers of each:

| Worry | What we do |
|---|---|
| Arithmetic mistakes (subtracting big numbers, division) | The program computes, in decimal fixed point, not floating point |
| The numbers used are misread, misremembered or made up | The server checks that every input really is in the source it names |
| Wrong definition: adding averages, ratios or distinct counts, or taking the sum of the top ten as the whole | The calculator cannot stop this. The expression is laid out so people can see it, and the tool description and the system prompt remind the model |

**The tool**: the input is the expression and the inputs it uses; each input gives a name, a value and a source number:

```jsonc
{
  "expression": "(a - b) / b",
  "inputs": {
    "a": { "label": "East China sales", "value": 4184761.25, "source": 1 },
    "b": { "label": "South China sales", "value": 3005120.40, "source": 1 }
  }
}
```

- The expression has only `+ - * /`, parentheses, input names and constants. Constants, such as ×100 to turn a value into a percentage or ÷12 for a monthly average, are written in the expression as they are and are shown in the source too.
- The calculation is decimal fixed point, and division keeps 10 significant digits (provisional). It returns the result and the source number of this calculation.
- **Input check**: each input's value must appear in the source it names: a cell in a row or in the total row of a data result, compared as numbers (`"100.50"` equals `100.5`); or it can be the result of an earlier calculation in this answer. A value that does not match, or a source that does not exist, is not accepted, and the reason is handed back to the model to fix.
- **Only sources in this answer**: numbers from earlier answers are looked up again when needed, consistent with 12.4 ("numbers are looked up again when needed"). The cost is one more lookup on a follow-up.
- Division by zero, a malformed expression, and the use of a name that was not given are all handed back to the model as errors.
- The calculator is given to the model together with the data tools. At the call limit, or when no tools are given anymore, a tool call that the model still sends is not run, and the text of that call is the answer.

**Source**: one calculation takes one source number, in the same sequence as the data sources. The source records the expression, the name, value and source number of each input, and the result. In the UI it is written as "③ Worked out: (East China sales [1] − South China sales [1]) ÷ South China sales [1] = 0.3925", with no "Open"; the [1] in it can be clicked and jumps to the matching data source.

**How an answer is written**, put into the system prompt and the tool description:

- A number that is not on any chart is worked out with `calculate`, and the text says how, such as "East China is 117.96 万 more than South China [3] (East China 418.48 万 [1] − South China 300.51 万 [1])".
- Do not add averages, ratios or distinct counts.
- When a total is needed, use the total row in the result; when the result is truncated, or the chart only lists the top N, do not add up the rows as if that were the whole.
- Do only the arithmetic the user asked for; no forecasting, no estimating.

**Where it lives**: `calculate` is in `internal/assistant` and is provided by the Agent loop itself; it can see the tool results the answer already has, which it uses to check the inputs. In storage it is, like the other tools, a "tool" part of the answer, and sources gain one more kind, "calculation". A calculation does not call the model, records no usage, does not touch data sources, and records no query event.

## 13. Second step: the usage page

Status: implemented.

### 13.1 Why do it

- The usage and cost of every model call are recorded (section 7), but they can only be seen by querying the database directly.
- "What data the AI looked at" needs no separate work: every data fetch is recorded in the audit log's query events, with details noting that it came from the AI assistant (12.6), together with the chart, conditions and SQL. The second step only adds usage and cost.
- Measured on the development database on 2026-10-25: 24 answers made 45 model calls, an average of 1.9 per answer and at most 6, because every round of the tool loop resends the whole context; 407,000 input tokens and 20,000 output tokens, with zero cache hits (Claude Haiku 5.5 on OpenRouter). Listing the four kinds of tokens by model is what lets an administrator see this.

### 13.2 Scope

- Under "AI models" in System administration, a new page "AI usage" (`/settings/system/ai-usage`) is added, visible only to system administrators. Models and cost belong to the whole organization; as with the audit log, workspace admins have no view limited to their own workspace.
- Only usage and cost are shown, not conversation content. A conversation can be seen only by its owner (4.1), and users ask their questions with that expectation. Conversation titles are generated from the first question, so they are not shown either.
- Viewing the usage page is not audited, the same as viewing the audit log.

### 13.3 The page

The only **filter** is the time range, which defaults to the last 30 days (including today). As in the audit log, days are divided by the time zone of the browser.

**Totals** are written at the top:

| Item | Description |
|---|---|
| Cost | Written separately by currency, such as "USD 0.05 · CNY 12.30", neither added nor converted (section 7) |
| Answers | How many answers the calls with the purpose Chat involve |
| Calls | Also shows how many of them failed or were stopped |
| Tokens | The four kinds separately: input that missed the cache, input that hit the cache, cache writes, output. When some calls were estimated from the character count, it says how many |

**Summary table**: choose one of by person, model, workspace, purpose and day; one row per group, showing the number of calls, the four kinds of tokens and the cost.

- When a group used two currencies, the cost cell lists both side by side and does not add them.
- Sorted by the number of calls, from most to least: different currencies cannot be sorted by cost. By day, sorted from most recent to oldest, and days without calls are not listed.

The names of the groups:

| Group | How it is written |
|---|---|
| Person | The current name and email. Accounts can only be disabled, not deleted, so they can always be found |
| Model | The provider and model name at the time of recording, such as "OpenRouter · anthropic/claude-haiku-5.5". A renamed model is split into two rows; a deleted model is still shown as usual |
| Workspace | The current name; after permanent deletion, "Deleted workspace". Model tests belong to no workspace and are written as "Tests of models" |
| Purpose | Chat, Titles, Context compression, Tests |
| Day | The date |

### 13.4 Endpoint

`GET /ai/usage`: the parameters are the start and end time, the grouping (`user`, `model`, `workspace`, `purpose`, `day`) and the browser's time zone (an IANA name, used when grouping by day). It returns the totals and the groups, with cost split by currency. Only system administrators can call it, and it is not audited.

### 13.5 Retention

- Usage records and audit events share one retention period, the "Audit events kept for" setting under "System administration → General" (default 180 days, `0` means keep forever, see [Access control and workspaces](access-control.md) 7.6). They are deleted in batches together by the hourly maintenance job, with no additional setting.
- To see cost over a longer time, lengthen the retention period or set it to `0`. A usage record is only two or three hundred bytes; with 1000 people each asking 20 times a day, and each answer calling the model twice, a year comes to about 15 million rows.

### 13.6 Not in this step

A per-call detail list, usage trend charts, exporting usage, filtering the audit log by "from the AI assistant", workspace admins seeing only their own workspace's usage, administrators viewing conversation content, and a separate retention period for usage. The reasons and when to re-evaluate are in [Deferred items](../backlog.md).
