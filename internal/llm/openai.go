package llm

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// errIdle stops a call that has heard nothing from its provider for too long.
var errIdle = errors.New("the provider sent nothing for too long")

const defaultIdle = 5 * time.Minute

// streamOpenAI calls the chat completions of an OpenAI-compatible API.
func (c *Client) streamOpenAI(ctx context.Context, p Provider, req Request, onDelta func(Delta)) (Result, error) {
	messages := make([]map[string]any, len(req.Messages))
	for i, m := range req.Messages {
		messages[i] = openAIMessage(m)
	}
	body := map[string]any{
		"model":    req.Model,
		"messages": messages,
		"stream":   true,
		// Without it, a streamed answer comes without usage.
		"stream_options": map[string]any{"include_usage": true},
	}
	if req.MaxTokens > 0 {
		body["max_tokens"] = req.MaxTokens
	}
	if req.ThinkingLevel != "" {
		body["reasoning_effort"] = req.ThinkingLevel
	}
	if len(req.Tools) > 0 {
		tools := make([]map[string]any, len(req.Tools))
		for i, t := range req.Tools {
			tools[i] = map[string]any{"type": "function", "function": map[string]any{"name": t.Name, "description": t.Description, "parameters": t.Parameters}}
		}
		body["tools"] = tools
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return Result{}, err
	}

	idle := c.Idle
	if idle <= 0 {
		idle = defaultIdle
	}
	ctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	timer := time.AfterFunc(idle, func() { cancel(errIdle) })
	defer timer.Stop()

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(p.BaseURL, "/")+"/chat/completions", bytes.NewReader(raw))
	if err != nil {
		return Result{}, &Error{Kind: Unreachable, Message: err.Error()}
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "text/event-stream")
	if p.APIKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+p.APIKey)
	}
	client := c.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(httpReq)
	if err != nil {
		return Result{}, failure(ctx, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return Result{}, openAIError(resp)
	}

	var (
		result    Result
		text      strings.Builder
		reasoning strings.Builder
		calls     toolCalls
		// streamed is set by the first event; a provider that answers
		// without streaming sends none.
		streamed bool
	)
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 64<<10), 8<<20)
	for scanner.Scan() {
		// Comments that keep the connection open count: the provider is there.
		timer.Reset(idle)
		data, ok := strings.CutPrefix(scanner.Text(), "data:")
		if !ok {
			continue
		}
		data = strings.TrimSpace(data)
		streamed = true
		if data == "[DONE]" {
			break
		}
		var chunk openAIChunk
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			result.Text = text.String()
			return result, &Error{Kind: Rejected, Message: "unreadable answer: " + shorten(data)}
		}
		if len(chunk.Error) > 0 && string(chunk.Error) != "null" {
			result.Text = text.String()
			message := errorMessage(chunk.Error)
			return result, &Error{Kind: kindOfRejection(0, message), Message: message}
		}
		if chunk.Usage != nil {
			u := chunk.Usage.usage()
			result.Usage = &u
		}
		for _, choice := range chunk.Choices {
			if thought := choice.Delta.ReasoningContent + choice.Delta.Reasoning; thought != "" {
				onDelta(Delta{Text: thought, Thinking: true})
			}
			reasoning.WriteString(choice.Delta.ReasoningContent)
			if choice.Delta.Content != "" {
				text.WriteString(choice.Delta.Content)
				onDelta(Delta{Text: choice.Delta.Content})
			}
			for _, call := range choice.Delta.ToolCalls {
				calls.add(call)
			}
			if choice.FinishReason == "length" {
				result.Truncated = true
			}
		}
	}
	result.Text = text.String()
	result.Reasoning = reasoning.String()
	result.ToolCalls = calls.done()
	if err := scanner.Err(); err != nil {
		return result, failure(ctx, err)
	}
	if context.Cause(ctx) != nil {
		return result, failure(ctx, context.Cause(ctx))
	}
	if !streamed {
		return result, &Error{Kind: Rejected, Status: resp.StatusCode, Message: "the answer was not streamed; the provider may not support streaming (" + resp.Header.Get("Content-Type") + ")"}
	}
	return result, nil
}

// failure says why a call ended early: the caller stopped it, it waited
// too long, or the provider could not be reached.
func failure(ctx context.Context, err error) error {
	cause := context.Cause(ctx)
	switch {
	case errors.Is(cause, errIdle):
		return &Error{Kind: Timeout, Message: errIdle.Error()}
	case errors.Is(cause, context.DeadlineExceeded):
		return &Error{Kind: Timeout, Message: "the call took too long"}
	case errors.Is(cause, context.Canceled):
		return context.Canceled
	}
	return &Error{Kind: Unreachable, Message: err.Error()}
}

// openAIMessage is a message as chat completions take it.
func openAIMessage(m Message) map[string]any {
	out := map[string]any{"role": m.Role, "content": m.Content}
	if m.ToolCallID != "" {
		out["tool_call_id"] = m.ToolCallID
	}
	if len(m.ToolCalls) > 0 {
		// Text is optional beside calls, and some servers refuse it empty.
		if m.Content == "" {
			out["content"] = nil
		}
		calls := make([]map[string]any, len(m.ToolCalls))
		for i, c := range m.ToolCalls {
			calls[i] = map[string]any{"id": c.ID, "type": "function", "function": map[string]any{"name": c.Name, "arguments": c.Arguments}}
		}
		out["tool_calls"] = calls
	}
	// Only providers that sent it there read it back: DeepSeek wants it
	// while an answer goes on through tools, others may refuse what they
	// do not know.
	if m.Reasoning != "" {
		out["reasoning_content"] = m.Reasoning
	}
	return out
}

type openAIChunk struct {
	Choices []struct {
		Delta struct {
			Content string `json:"content"`
			// DeepSeek, Qwen and vLLM send reasoning here; Ollama and
			// OpenRouter in reasoning.
			ReasoningContent string               `json:"reasoning_content"`
			Reasoning        string               `json:"reasoning"`
			ToolCalls        []openAIToolCallPart `json:"tool_calls"`
		} `json:"delta"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Usage *openAIUsage    `json:"usage"`
	Error json.RawMessage `json:"error"`
}

// openAIToolCallPart is a piece of a tool call as it streams: its index,
// then its ID and name once, and its arguments a piece at a time.
type openAIToolCallPart struct {
	Index    *int   `json:"index"`
	ID       string `json:"id"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

// toolCalls puts streamed pieces of tool calls together.
type toolCalls struct {
	calls []ToolCall
	index map[int]int
}

func (t *toolCalls) add(part openAIToolCallPart) {
	if t.index == nil {
		t.index = map[int]int{}
	}
	at, known := -1, false
	switch {
	case part.Index != nil:
		at, known = t.index[*part.Index]
		// A server that numbers every call 0 tells them apart by their IDs.
		if known && part.ID != "" && t.calls[at].ID != "" && part.ID != t.calls[at].ID {
			known = false
		}
	case part.ID == "" && len(t.calls) > 0:
		// A provider that numbers nothing goes on with the last call.
		at, known = len(t.calls)-1, true
	}
	if !known {
		t.calls = append(t.calls, ToolCall{})
		at = len(t.calls) - 1
		if part.Index != nil {
			t.index[*part.Index] = at
		}
	}
	c := &t.calls[at]
	if part.ID != "" {
		c.ID = part.ID
	}
	// The name comes whole, once; some providers repeat it.
	if c.Name == "" {
		c.Name = part.Function.Name
	}
	c.Arguments += part.Function.Arguments
}

// done is the calls made, each with an ID to answer it by.
func (t *toolCalls) done() []ToolCall {
	for i := range t.calls {
		if t.calls[i].ID == "" {
			t.calls[i].ID = fmt.Sprintf("call_%d", i)
		}
	}
	return t.calls
}

// openAIUsage is usage as OpenAI and the providers that follow it report it,
// each with its own way of counting the cache.
type openAIUsage struct {
	PromptTokens        int64 `json:"prompt_tokens"`
	CompletionTokens    int64 `json:"completion_tokens"`
	PromptTokensDetails *struct {
		CachedTokens int64 `json:"cached_tokens"`
	} `json:"prompt_tokens_details"`
	// DeepSeek.
	PromptCacheHitTokens  *int64 `json:"prompt_cache_hit_tokens"`
	PromptCacheMissTokens *int64 `json:"prompt_cache_miss_tokens"`
	// Moonshot (Kimi).
	CachedTokens *int64 `json:"cached_tokens"`
}

// usage converts to tokens that do not overlap: the prompt tokens include
// those read from the cache. No provider of this protocol reports writes to
// the cache apart from other input.
func (u openAIUsage) usage() Usage {
	var cached int64
	switch {
	case u.PromptCacheHitTokens != nil:
		cached = *u.PromptCacheHitTokens
	case u.PromptTokensDetails != nil:
		cached = u.PromptTokensDetails.CachedTokens
	case u.CachedTokens != nil:
		cached = *u.CachedTokens
	}
	input := max(u.PromptTokens-cached, 0)
	if u.PromptCacheMissTokens != nil {
		input = *u.PromptCacheMissTokens
	}
	return Usage{Input: input, CachedInput: cached, Output: u.CompletionTokens}
}

// openAIError reads the error a provider answered with.
func openAIError(resp *http.Response) error {
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	message := shorten(strings.TrimSpace(string(raw)))
	var body struct {
		Error   json.RawMessage `json:"error"`
		Message string          `json:"message"`
	}
	if json.Unmarshal(raw, &body) == nil {
		switch {
		case len(body.Error) > 0 && string(body.Error) != "null":
			message = errorMessage(body.Error)
		case body.Message != "":
			message = shorten(body.Message)
		}
	}
	if message == "" {
		message = resp.Status
	}
	return &Error{Kind: kindOfRejection(resp.StatusCode, message), Status: resp.StatusCode, Message: message}
}

// errorMessage reads an error object, or an error that is only a string.
func errorMessage(raw json.RawMessage) string {
	var e struct {
		Message string `json:"message"`
		Code    any    `json:"code"`
		Type    string `json:"type"`
	}
	if json.Unmarshal(raw, &e) == nil && e.Message != "" {
		if code := fmt.Sprint(e.Code); e.Code != nil && code != "" {
			return shorten(code + ": " + e.Message)
		}
		return shorten(e.Message)
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return shorten(s)
	}
	return shorten(string(raw))
}

func kindOfRejection(status int, message string) ErrorKind {
	switch status {
	case http.StatusUnauthorized, http.StatusForbidden:
		return Unauthorized
	case http.StatusTooManyRequests:
		return RateLimited
	case http.StatusRequestTimeout, http.StatusGatewayTimeout:
		return Timeout
	}
	if tooLong(message) {
		return ContextTooLong
	}
	return Rejected
}

// tooLong tells a request refused for its length by what the provider
// said: providers agree on no code for it.
func tooLong(message string) bool {
	m := strings.ToLower(message)
	for _, s := range []string{"context_length_exceeded", "context length", "context window", "maximum context", "prompt is too long", "input is too long", "too many tokens"} {
		if strings.Contains(m, s) {
			return true
		}
	}
	return false
}

// shorten keeps what a provider said to a length fit for a log line.
func shorten(s string) string {
	const most = 1000
	if r := []rune(s); len(r) > most {
		return string(r[:most]) + "…"
	}
	return s
}
