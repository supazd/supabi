package llm

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// sse answers a call with the given data lines, as a streaming provider does.
func sse(lines ...string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		for _, line := range lines {
			fmt.Fprintf(w, "%s\n\n", line)
			w.(http.Flusher).Flush()
		}
	}
}

func provider(t *testing.T, handler http.Handler) Provider {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return Provider{Protocol: OpenAI, BaseURL: server.URL + "/v1/", APIKey: "sk-test"}
}

func TestStreamOpenAI(t *testing.T) {
	var got struct {
		path, auth string
		body       map[string]any
	}
	p := provider(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got.path, got.auth = r.URL.Path, r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&got.body)
		sse(
			`: keep-alive`,
			`data: {"choices":[{"delta":{"role":"assistant","reasoning_content":"想一想"}}]}`,
			`data: {"choices":[{"delta":{"content":"你好"}}]}`,
			`data: {"choices":[{"delta":{"content":"，世界"},"finish_reason":"stop"}]}`,
			`data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":30,"prompt_tokens_details":{"cached_tokens":100}}}`,
			`data: [DONE]`,
		)(w, r)
	}))
	var deltas []Delta
	c := &Client{}
	res, err := c.Stream(context.Background(), p, Request{Model: "m1", MaxTokens: 512, Messages: []Message{{Role: "system", Content: "s"}, {Role: "user", Content: "hi"}}},
		func(d Delta) { deltas = append(deltas, d) })
	if err != nil {
		t.Fatal(err)
	}
	if got.path != "/v1/chat/completions" || got.auth != "Bearer sk-test" {
		t.Errorf("request to %q with %q", got.path, got.auth)
	}
	if got.body["model"] != "m1" || got.body["stream"] != true || got.body["max_tokens"] != float64(512) || len(got.body["messages"].([]any)) != 2 {
		t.Errorf("request body = %v", got.body)
	}
	if opts, _ := got.body["stream_options"].(map[string]any); opts["include_usage"] != true {
		t.Errorf("usage is not asked for: %v", got.body)
	}
	if res.Text != "你好，世界" || res.Truncated {
		t.Errorf("result = %+v", res)
	}
	if res.Usage == nil || *res.Usage != (Usage{Input: 20, CachedInput: 100, Output: 30}) {
		t.Errorf("usage = %+v", res.Usage)
	}
	want := []Delta{{Text: "想一想", Thinking: true}, {Text: "你好"}, {Text: "，世界"}}
	if fmt.Sprint(deltas) != fmt.Sprint(want) {
		t.Errorf("deltas = %v, want %v", deltas, want)
	}
}

// The level goes as it is, and without one nothing is said of it.
func TestThinkingLevel(t *testing.T) {
	var body map[string]any
	p := provider(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body = nil
		_ = json.NewDecoder(r.Body).Decode(&body)
		sse(`data: {"choices":[{"delta":{"content":"OK"}}]}`, `data: [DONE]`)(w, r)
	}))
	c := &Client{}
	for level, want := range map[string]any{"max": "max", "": nil} {
		if _, err := c.Stream(context.Background(), p, Request{Model: "m1", ThinkingLevel: level}, func(Delta) {}); err != nil {
			t.Fatal(err)
		}
		if got, sent := body["reasoning_effort"]; got != want || sent != (want != nil) {
			t.Errorf("level %q: sent %v", level, body)
		}
	}
}

func TestStreamOpenAIToolCalls(t *testing.T) {
	var body map[string]any
	p := provider(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		sse(
			`data: {"choices":[{"delta":{"reasoning_content":"先查"}}]}`,
			`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"list_dashboards","arguments":""}}]}}]}`,
			`data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_b","type":"function","function":{"name":"query_chart","arguments":"{\"dash"}}]}}]}`,
			`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}`,
			`data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"board\":\"d1\"}"}}]},"finish_reason":"tool_calls"}]}`,
			`data: [DONE]`,
		)(w, r)
	}))
	params := json.RawMessage(`{"type":"object","properties":{}}`)
	req := Request{Model: "m1", Tools: []Tool{{Name: "list_dashboards", Description: "lists", Parameters: params}}, Messages: []Message{
		{Role: "user", Content: "hi"},
		{Role: "assistant", ToolCalls: []ToolCall{{ID: "call_0", Name: "list_dashboards", Arguments: "{}"}}, Reasoning: "想"},
		{Role: "tool", ToolCallID: "call_0", Content: "[]"},
	}}
	res, err := (&Client{}).Stream(context.Background(), p, req, func(Delta) {})
	if err != nil {
		t.Fatal(err)
	}
	want := []ToolCall{{ID: "call_a", Name: "list_dashboards", Arguments: "{}"}, {ID: "call_b", Name: "query_chart", Arguments: `{"dashboard":"d1"}`}}
	if fmt.Sprint(res.ToolCalls) != fmt.Sprint(want) || res.Text != "" || res.Reasoning != "先查" {
		t.Errorf("result = %+v", res)
	}
	tools, _ := body["tools"].([]any)
	if len(tools) != 1 || tools[0].(map[string]any)["function"].(map[string]any)["name"] != "list_dashboards" {
		t.Errorf("tools sent = %v", body["tools"])
	}
	messages := body["messages"].([]any)
	called := messages[1].(map[string]any)
	answered := messages[2].(map[string]any)
	if called["reasoning_content"] != "想" || called["tool_calls"].([]any)[0].(map[string]any)["id"] != "call_0" || answered["tool_call_id"] != "call_0" || answered["role"] != "tool" {
		t.Errorf("messages sent = %v", messages)
	}
	if _, sent := messages[0].(map[string]any)["reasoning_content"]; sent {
		t.Error("reasoning is sent where there was none")
	}
	if content, sent := called["content"]; !sent || content != nil {
		t.Errorf("calls without text are sent with content %v", content)
	}
}

// A server that numbers every call 0 tells them apart by their IDs.
func TestToolCallsUnderOneIndex(t *testing.T) {
	zero := 0
	part := func(id, name, arguments string) openAIToolCallPart {
		p := openAIToolCallPart{Index: &zero, ID: id}
		p.Function.Name, p.Function.Arguments = name, arguments
		return p
	}
	var calls toolCalls
	for _, p := range []openAIToolCallPart{part("a", "list_dashboards", "{"), part("", "", "}"), part("b", "query_chart", `{"x":1}`), part("b", "", "")} {
		calls.add(p)
	}
	want := []ToolCall{{ID: "a", Name: "list_dashboards", Arguments: "{}"}, {ID: "b", Name: "query_chart", Arguments: `{"x":1}`}}
	if got := calls.done(); fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("calls = %+v, want %+v", got, want)
	}
}

func TestToolCallsWithoutIndex(t *testing.T) {
	part := func(id, name, arguments string) openAIToolCallPart {
		var p openAIToolCallPart
		p.ID, p.Function.Name, p.Function.Arguments = id, name, arguments
		return p
	}
	var calls toolCalls
	for _, p := range []openAIToolCallPart{part("x", "a", "{"), part("", "", "}"), part("y", "b", "{}")} {
		calls.add(p)
	}
	want := []ToolCall{{ID: "x", Name: "a", Arguments: "{}"}, {ID: "y", Name: "b", Arguments: "{}"}}
	if got := calls.done(); fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("calls = %+v, want %+v", got, want)
	}
}

func TestUsageOfEachProvider(t *testing.T) {
	cases := map[string]struct {
		raw  string
		want Usage
	}{
		"no cache":  {`{"prompt_tokens":50,"completion_tokens":5}`, Usage{Input: 50, Output: 5}},
		"openai":    {`{"prompt_tokens":50,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":40}}`, Usage{Input: 10, CachedInput: 40, Output: 5}},
		"deepseek":  {`{"prompt_tokens":50,"completion_tokens":5,"prompt_cache_hit_tokens":30,"prompt_cache_miss_tokens":20}`, Usage{Input: 20, CachedInput: 30, Output: 5}},
		"moonshot":  {`{"prompt_tokens":50,"completion_tokens":5,"cached_tokens":45}`, Usage{Input: 5, CachedInput: 45, Output: 5}},
		"no prompt": {`{"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":40}}`, Usage{CachedInput: 40, Output: 5}},
	}
	for name, tc := range cases {
		var u openAIUsage
		if err := json.Unmarshal([]byte(tc.raw), &u); err != nil {
			t.Fatal(err)
		}
		if got := u.usage(); got != tc.want {
			t.Errorf("%s: usage = %+v, want %+v", name, got, tc.want)
		}
	}
}

func TestStreamWithoutUsageOrKey(t *testing.T) {
	var auth string
	p := provider(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		sse(`data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"length"}]}`)(w, r)
	}))
	p.APIKey = ""
	res, err := (&Client{}).Call(context.Background(), p, Request{Model: "m"})
	if err != nil {
		t.Fatal(err)
	}
	if auth != "" || res.Text != "ok" || res.Usage != nil || !res.Truncated {
		t.Errorf("auth %q, result %+v", auth, res)
	}
}

func TestRejections(t *testing.T) {
	cases := []struct {
		status int
		body   string
		kind   ErrorKind
		says   string
	}{
		{401, `{"error":{"message":"Incorrect API key provided","type":"invalid_request_error","code":"invalid_api_key"}}`, Unauthorized, "invalid_api_key: Incorrect API key provided"},
		{429, `{"error":{"message":"Rate limit reached"}}`, RateLimited, "Rate limit reached"},
		{400, `{"error":{"message":"This model's maximum context length is 8192 tokens","code":"context_length_exceeded"}}`, ContextTooLong, "context_length_exceeded: This model's maximum context length is 8192 tokens"},
		{400, `{"object":"error","message":"This model's maximum context length is 4096 tokens. However, you requested 5000 tokens"}`, ContextTooLong, "This model's maximum context length is 4096 tokens. However, you requested 5000 tokens"},
		{404, `{"error":"model 'nope' not found"}`, Rejected, "model 'nope' not found"},
		{502, `bad gateway`, Rejected, "bad gateway"},
		{504, ``, Timeout, "504 Gateway Timeout"},
	}
	for _, tc := range cases {
		p := provider(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(tc.status)
			_, _ = w.Write([]byte(tc.body))
		}))
		_, err := (&Client{}).Call(context.Background(), p, Request{Model: "m"})
		var e *Error
		if !errors.As(err, &e) || e.Kind != tc.kind || e.Status != tc.status || e.Message != tc.says {
			t.Errorf("HTTP %d %s: error = %#v", tc.status, tc.body, err)
		}
	}
}

func TestErrorInTheStream(t *testing.T) {
	p := provider(t, sse(
		`data: {"choices":[{"delta":{"content":"部分"}}]}`,
		`data: {"error":{"message":"upstream overloaded"}}`,
	))
	res, err := (&Client{}).Call(context.Background(), p, Request{Model: "m"})
	if KindOf(err) != Rejected || res.Text != "部分" {
		t.Errorf("result %+v, error %v", res, err)
	}
}

func TestUnreachable(t *testing.T) {
	_, err := (&Client{}).Call(context.Background(), Provider{Protocol: OpenAI, BaseURL: "http://127.0.0.1:1"}, Request{Model: "m"})
	if KindOf(err) != Unreachable {
		t.Errorf("error = %v", err)
	}
}

// A provider that says nothing for too long is given up; one that keeps the
// connection alive with comments is not.
func TestIdle(t *testing.T) {
	silent := provider(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	c := &Client{Idle: 200 * time.Millisecond}
	res, err := c.Call(context.Background(), silent, Request{Model: "m"})
	if KindOf(err) != Timeout || res.Text != "a" {
		t.Errorf("result %+v, error %v", res, err)
	}

	alive := provider(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		for range 4 {
			fmt.Fprint(w, ": thinking\n\n")
			w.(http.Flusher).Flush()
			time.Sleep(100 * time.Millisecond)
		}
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"done\"}}]}\n\ndata: [DONE]\n\n")
	}))
	if res, err := c.Call(context.Background(), alive, Request{Model: "m"}); err != nil || res.Text != "done" {
		t.Errorf("result %+v, error %v", res, err)
	}
}

// Stopping a call is not an error of the provider's.
func TestStop(t *testing.T) {
	p := provider(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"半\"}}]}\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	ctx, cancel := context.WithCancel(context.Background())
	res, err := (&Client{}).Stream(ctx, p, Request{Model: "m"}, func(d Delta) {
		if d.Text == "半" {
			cancel()
		}
	})
	if !errors.Is(err, context.Canceled) || KindOf(err) != "" || res.Text != "半" {
		t.Errorf("result %+v, error %v", res, err)
	}
}

func TestEstimateTokens(t *testing.T) {
	if got := EstimateTokens("今天销售额多少"); got != 7 {
		t.Errorf("Chinese = %d", got)
	}
	if got := EstimateTokens(strings.Repeat("abc ", 30)); got != 40 {
		t.Errorf("English = %d", got)
	}
}

// A provider that ignored stream and answered in one piece is not taken for an empty answer.
func TestNotStreamed(t *testing.T) {
	p := provider(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"choices":[{"message":{"content":"整段回答"}}]}`)
	}))
	_, err := (&Client{}).Call(context.Background(), p, Request{Model: "m"})
	var e *Error
	if !errors.As(err, &e) || e.Kind != Rejected || !strings.Contains(e.Message, "not streamed") {
		t.Errorf("error = %v", err)
	}
}
