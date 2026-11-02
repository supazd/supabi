---
title: AI assistant
description: Ask questions of your dashboards, with a source for every number, and set up the models behind it.
---

The **AI assistant** in the top bar answers questions from the dashboards you can open. Every role can use it, and each person sees only their own conversations in the current workspace.

## Ask a question

Type a question and press Enter, or Shift+Enter for a new line. Answers appear word by word and can be stopped. Closing or leaving the page stops an answer.

The assistant works the way you would on a dashboard. It looks at which dashboards exist and which charts and filters are on them, then reads the data of charts under the conditions you asked for. It can switch dimensions and metrics, drill down and use chart links.

It reads only what you can see, under your own [data permissions](/admin/data-permissions/). It does not query datasets or write SQL.

## Sources

Every number in an answer comes from a tool result and is marked with its source, like **[1]**. Below the answer, **Sources** lists the dashboard, chart and conditions of each one, and **Open** opens the dashboard under those conditions.

A difference, share or growth rate that is not on a chart is worked out with a calculator, not in the model's head, and its expression and numbers are listed as a source too.

When a conversation grows close to the model's context length, the earlier part is summarized automatically. You still see all of it.

## Set up the models

Only a system administrator can do this, under **System administration → AI models**. A change takes effect at once, with no restart.

1. **Add provider**: enter a name, the **Protocol**, the **API address** and the **API key**. OpenAI-compatible APIs are supported for now, including DeepSeek, Tongyi Qianwen, Kimi and Zhipu, and models deployed with vLLM or Ollama. The key is stored encrypted.
2. **Add model** to the provider:

   | Field | Meaning |
   |---|---|
   | **Model ID** | The name passed to the API, such as `deepseek-chat` |
   | **Context length** | Tokens one call can read and write at most, such as 128K or 1M. It decides when a conversation is summarized |
   | **Max output** | Tokens one answer may have at most, such as 8K |
   | **Thinking level** | Optional, and sent as it is as `reasoning_effort`. Leave it empty if the provider does not take it |
   | **Currency** | The currency of the prices |
   | **Input**, **Cached input**, **Cache write**, **Output** | Prices per million tokens. Where a provider does not charge cache hits and writes apart, leave those empty |

3. **Test** makes one trial call and checks whether the model calls tools. A model that does not cannot look up data. The test is recorded as usage.
4. Under **What each model is for**, choose a model for **Chat**, which is required, and optionally for **Titles** and **Context compression**. Those two can use a cheaper model, and use the chat model when not set.

People cannot choose a model themselves. A model in use cannot be deleted; replace it first.

Behind a reverse proxy, see [how to let answers stream](/deployment/operations/#reverse-proxy).

## Usage and cost

**AI usage** in System administration shows the tokens of every model call and its cost at the price of the time, **By person**, **By model**, **By workspace**, **By purpose** or **By day**. Costs in different currencies are counted apart, never added together.

Administrators cannot see the content of conversations.
