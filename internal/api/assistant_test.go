package api

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/supazd/supabi/internal/store"
)

// fakeModels is an OpenAI-compatible provider that answers every call with
// the same text, and refuses calls with the wrong key.
func fakeModels(t *testing.T, text string) string {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer sk-right" {
			w.WriteHeader(http.StatusUnauthorized)
			fmt.Fprint(w, `{"error":{"message":"Incorrect API key provided"}}`)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		for _, piece := range strings.SplitAfter(text, "，") {
			chunk, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": piece}}}})
			fmt.Fprintf(w, "data: %s\n\n", chunk)
		}
		fmt.Fprint(w, "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":10}}\n\ndata: [DONE]\n\n")
	}))
	t.Cleanup(server.Close)
	return server.URL + "/v1"
}

// setUpModel adds a provider at the address and a model of it, and sets
// the model for chatting; it returns the model's ID.
func setUpModel(t *testing.T, admin *client, baseURL string) string {
	t.Helper()
	providerID := admin.expect("POST", "/ai/providers", map[string]any{"name": "Fake", "protocol": "openai", "baseUrl": baseURL, "apiKey": "sk-right"}, 201, "")["id"].(string)
	modelID := admin.expect("POST", "/ai/providers/"+providerID+"/models", map[string]any{"model": "fake-chat", "contextTokens": 64000, "maxOutputTokens": 8000,
		"currency": "cny", "inputPrice": "2", "cachedInputPrice": "0.5", "outputPrice": "8"}, 201, "")["id"].(string)
	admin.expect("PUT", "/ai/settings", map[string]any{"chatModelId": modelID}, 200, "")
	return modelID
}

// stream sends a message and reads the answer's events.
func (c *client) stream(method, path string, body any) (int, []map[string]any) {
	c.t.Helper()
	raw, _ := json.Marshal(body)
	req, err := http.NewRequest(method, c.server.URL+"/api/v1"+path, bytes.NewReader(raw))
	if err != nil {
		c.t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		var e map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&e)
		return resp.StatusCode, []map[string]any{e}
	}
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" || resp.Header.Get("X-Accel-Buffering") != "no" {
		c.t.Fatalf("content type %q, headers %v", ct, resp.Header)
	}
	var events []map[string]any
	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		if data, ok := strings.CutPrefix(scanner.Text(), "data: "); ok {
			var e map[string]any
			if err := json.Unmarshal([]byte(data), &e); err != nil {
				c.t.Fatalf("event %s: %v", data, err)
			}
			events = append(events, e)
		}
	}
	return resp.StatusCode, events
}

func TestAIModelSettings(t *testing.T) {
	admin := newClient(t)
	admin.expect("POST", "/users", map[string]any{"email": "dev@example.com", "displayName": "Dev", "password": "member-password"}, 201, "")
	admin.expect("POST", "/members", map[string]any{"userId": userID(t, admin, "dev@example.com"), "role": "admin"}, 201, "")
	workspaceAdmin := admin.signedIn("dev@example.com", "member-password")
	// What the assistant calls costs the organization: only its administrators set it.
	workspaceAdmin.expect("GET", "/ai/config", nil, 403, "forbidden")
	workspaceAdmin.expect("POST", "/ai/providers", map[string]any{"name": "x", "protocol": "openai", "baseUrl": "https://x"}, 403, "forbidden")

	admin.expect("POST", "/ai/providers", map[string]any{"name": "x", "protocol": "anthropic", "baseUrl": "https://x"}, 400, "invalid_protocol")
	admin.expect("POST", "/ai/providers", map[string]any{"name": "x", "protocol": "openai", "baseUrl": "api.deepseek.com"}, 400, "invalid_base_url")
	admin.expect("POST", "/ai/providers", map[string]any{"name": " ", "protocol": "openai", "baseUrl": "https://x"}, 400, "invalid_name")

	// The key is never given back; it changes only when sent.
	p := admin.expect("POST", "/ai/providers", map[string]any{"name": "DeepSeek", "protocol": "openai", "baseUrl": "https://api.deepseek.com/v1", "apiKey": "sk-secret"}, 201, "")
	if p["hasApiKey"] != true || p["apiKey"] != nil {
		t.Errorf("provider = %v", p)
	}
	providerID := p["id"].(string)
	admin.expect("POST", "/ai/providers", map[string]any{"name": "DeepSeek", "protocol": "openai", "baseUrl": "https://x"}, 409, "name_taken")
	if p := admin.expect("PATCH", "/ai/providers/"+providerID, map[string]any{"name": "深度求索", "protocol": "openai", "baseUrl": "https://api.deepseek.com/v1"}, 200, ""); p["hasApiKey"] != true || p["name"] != "深度求索" {
		t.Errorf("after a change without a key: %v", p)
	}
	if p := admin.expect("PATCH", "/ai/providers/"+providerID, map[string]any{"name": "深度求索", "protocol": "openai", "baseUrl": "https://api.deepseek.com/v1", "apiKey": ""}, 200, ""); p["hasApiKey"] != false {
		t.Errorf("after the key was removed: %v", p)
	}
	// A key of only spaces is none.
	if p := admin.expect("POST", "/ai/providers", map[string]any{"name": "Blank", "protocol": "openai", "baseUrl": "https://x", "apiKey": "  "}, 201, ""); p["hasApiKey"] != false {
		t.Errorf("a blank key: %v", p)
	}

	model := func(change map[string]any) map[string]any {
		in := map[string]any{"model": "deepseek-chat", "contextTokens": 64000, "maxOutputTokens": 8000, "currency": "CNY", "inputPrice": "2", "outputPrice": "8"}
		for k, v := range change {
			in[k] = v
		}
		return in
	}
	path := "/ai/providers/" + providerID + "/models"
	admin.expect("POST", path, model(map[string]any{"maxOutputTokens": 64000}), 400, "invalid_max_output_tokens")
	admin.expect("POST", path, model(map[string]any{"currency": "RMB元"}), 400, "invalid_currency")
	admin.expect("POST", path, model(map[string]any{"inputPrice": "2.1234567"}), 400, "invalid_price")
	admin.expect("POST", path, model(map[string]any{"cachedInputPrice": "-1"}), 400, "invalid_price")
	admin.expect("POST", "/ai/providers/aip_nope/models", model(nil), 404, "not_found")
	admin.expect("POST", path, model(map[string]any{"thinkingLevel": strings.Repeat("x", 33)}), 400, "invalid_thinking_level")
	admin.expect("POST", path, model(map[string]any{"thinkingLevel": strings.Repeat("思", 33)}), 400, "invalid_thinking_level")
	m := admin.expect("POST", path, model(map[string]any{"currency": "usd", "cachedInputPrice": "0.5"}), 201, "")
	if m["currency"] != "USD" || m["inputPrice"] != "2" || m["cachedInputPrice"] != "0.5" || m["cacheWritePrice"] != nil {
		t.Errorf("model = %v", m)
	}
	modelID := m["id"].(string)
	admin.expect("POST", path, model(nil), 409, "name_taken")
	if m := admin.expect("PATCH", "/ai/models/"+modelID, model(map[string]any{"inputPrice": "1.5"}), 200, ""); m["inputPrice"] != "1.5" || m["cachedInputPrice"] != nil {
		t.Errorf("changed model = %v", m)
	}

	admin.expect("PUT", "/ai/settings", map[string]any{"chatModelId": "aim_nope"}, 400, "unknown_model")
	admin.expect("PUT", "/ai/settings", map[string]any{"chatModelId": modelID, "titleModelId": modelID}, 200, "")
	config := admin.expect("GET", "/ai/config", nil, 200, "")
	if settings := config["settings"].(map[string]any); settings["chatModelId"] != modelID || settings["compressionModelId"] != nil ||
		len(config["providers"].([]any)) != 2 || len(config["models"].([]any)) != 1 {
		t.Errorf("config = %v", config)
	}
	// A model in use stays, and so does its provider.
	admin.expect("DELETE", "/ai/models/"+modelID, nil, 409, "ai_model_in_use")
	admin.expect("DELETE", "/ai/providers/"+providerID, nil, 409, "ai_model_in_use")
	admin.expect("PUT", "/ai/settings", map[string]any{}, 200, "")
	admin.expect("DELETE", "/ai/providers/"+providerID, nil, 204, "")
	if config := admin.expect("GET", "/ai/config", nil, 200, ""); len(config["models"].([]any)) != 0 {
		t.Errorf("the provider's models were left: %v", config)
	}

	events := auditEvents(t, admin, "?category=ai")
	created := eventOf(t, events, "ai_provider.create", func(e map[string]any) bool { return objectName(e) == "DeepSeek" })
	if objectName(created) != "DeepSeek" || created["detail"].(map[string]any)["request"] != nil {
		t.Errorf("a provider's request, with its key, is not kept: %v", created)
	}
	if e := eventOf(t, events, "ai_model.create", nil); objectName(e) != "deepseek-chat" || detailOf(e)["request"].(map[string]any)["inputPrice"] != "2" {
		t.Errorf("model created = %v", e)
	}
	eventOf(t, events, "ai_settings.update", nil)
	eventOf(t, events, "ai_provider.delete", func(e map[string]any) bool { return objectName(e) == "深度求索" })
}

// A thinking level goes with what the model answers and with its test, not
// with titles, whose few tokens thinking could use up. Left out, none goes.
func TestThinkingLevel(t *testing.T) {
	admin := newClient(t)
	var mu sync.Mutex
	var sent []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		sent = append(sent, body)
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"OK\"}}]}\n\ndata: [DONE]\n\n")
	}))
	t.Cleanup(server.Close)
	modelID := setUpModel(t, admin, server.URL+"/v1")
	levels := func() (withTools, without []any) {
		t.Helper()
		mu.Lock()
		defer mu.Unlock()
		for _, body := range sent {
			if _, tools := body["tools"]; tools {
				withTools = append(withTools, body["reasoning_effort"])
			} else {
				without = append(without, body["reasoning_effort"])
			}
		}
		sent = nil
		return withTools, without
	}
	input := map[string]any{"model": "fake-chat", "contextTokens": 64000, "maxOutputTokens": 8000, "currency": "CNY", "inputPrice": "2", "outputPrice": "8"}

	admin.expect("POST", "/ai/models/"+modelID+"/test", nil, 200, "")
	mu.Lock()
	if len(sent) != 2 || sent[0]["max_tokens"] != float64(256) || sent[1]["max_tokens"] != float64(4096) {
		t.Errorf("test without a level = %v", sent)
	}
	mu.Unlock()
	if withTools, without := levels(); fmt.Sprint(withTools, without) != "[<nil>] [<nil>]" {
		t.Errorf("test without a level sent %v, %v", withTools, without)
	}
	input["thinkingLevel"] = "  high "
	if saved := admin.expect("PATCH", "/ai/models/"+modelID, input, 200, ""); saved["thinkingLevel"] != "high" {
		t.Errorf("saved = %v", saved)
	}
	mu.Lock()
	sent = nil
	mu.Unlock()
	admin.expect("POST", "/ai/models/"+modelID+"/test", nil, 200, "")
	mu.Lock()
	for _, body := range sent {
		// Thinking counts against the tokens, so it has what an answer has.
		if body["max_tokens"] != float64(8000) {
			t.Errorf("test with a level had %v tokens", body["max_tokens"])
		}
	}
	mu.Unlock()
	if withTools, without := levels(); fmt.Sprint(withTools, without) != "[high] [high]" {
		t.Errorf("test with a level sent %v, %v", withTools, without)
	}
	id := admin.expect("POST", "/assistant/conversations", map[string]any{}, 201, "")["id"].(string)
	admin.stream("POST", "/assistant/conversations/"+id+"/messages", map[string]any{"text": "你好"})
	var answers, titles []any
	for deadline := time.Now().Add(5 * time.Second); len(titles) == 0 && time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		withTools, without := levels()
		answers, titles = append(answers, withTools...), append(titles, without...)
	}
	if fmt.Sprint(answers) != "[high]" || fmt.Sprint(titles) != "[<nil>]" {
		t.Errorf("answer sent %v, title sent %v", answers, titles)
	}
	delete(input, "thinkingLevel")
	if saved := admin.expect("PATCH", "/ai/models/"+modelID, input, 200, ""); saved["thinkingLevel"] != nil {
		t.Errorf("after leaving it out = %v", saved)
	}
}

func TestTestAIModel(t *testing.T) {
	admin := newClient(t)
	modelID := setUpModel(t, admin, fakeModels(t, "OK"))
	// The fake answers with text even when asked to call a tool.
	if trial := admin.expect("POST", "/ai/models/"+modelID+"/test", nil, 200, ""); trial["ok"] != true || trial["reply"] != "OK" || fmt.Sprint(trial["tools"]) != "map[called:false]" {
		t.Errorf("trial = %v", trial)
	}
	config := admin.expect("GET", "/ai/config", nil, 200, "")
	providerID := config["providers"].([]any)[0].(map[string]any)["id"].(string)
	admin.expect("PATCH", "/ai/providers/"+providerID, map[string]any{"name": "Fake", "protocol": "openai", "baseUrl": fakeModels(t, "OK"), "apiKey": "sk-wrong"}, 200, "")
	trial := admin.expect("POST", "/ai/models/"+modelID+"/test", nil, 200, "")
	failure, _ := trial["error"].(map[string]any)
	if trial["ok"] != false || failure["code"] != "unauthorized" || failure["status"] != float64(401) || failure["message"] != "Incorrect API key provided" {
		t.Errorf("trial with the wrong key = %v", trial)
	}
	var purposes []string
	rows, _ := admin.db.Pool.Query(t.Context(), `SELECT purpose || ':' || outcome FROM ai_usage ORDER BY created_at`)
	for rows.Next() {
		var p string
		_ = rows.Scan(&p)
		purposes = append(purposes, p)
	}
	// A model that did not answer is not asked to call a tool.
	if strings.Join(purposes, " ") != "test:success test:success test:failure" {
		t.Errorf("usage = %v", purposes)
	}
}

func TestAIUsage(t *testing.T) {
	admin := newClient(t)
	admin.expect("POST", "/users", map[string]any{"email": "dev@example.com", "displayName": "Dev", "password": "member-password"}, 201, "")
	devID := userID(t, admin, "dev@example.com")
	admin.expect("POST", "/members", map[string]any{"userId": devID, "role": "admin"}, 201, "")
	// What people spend on models is for the organization's administrators alone.
	admin.signedIn("dev@example.com", "member-password").expect("GET", "/ai/usage?groupBy=user", nil, 403, "forbidden")
	admin.expect("GET", "/ai/usage?groupBy=conversation", nil, 400, "invalid_request")
	admin.expect("GET", "/ai/usage?groupBy=day&timeZone=Mars/Olympus", nil, 400, "invalid_timezone")

	adminID := userID(t, admin, adminEmail)
	type call struct {
		user, workspace, message, purpose, provider, model, currency, cost, outcome, at string
		estimated                                                                       bool
	}
	for i, c := range []call{
		{adminID, store.DefaultWorkspaceID, "m1", "chat", "OpenRouter", "claude-haiku", "USD", "0.01", "success", "2026-10-24T23:30:00Z", false},
		{adminID, store.DefaultWorkspaceID, "m1", "chat", "OpenRouter", "claude-haiku", "USD", "0.020000", "success", "2026-10-24T23:40:00Z", false},
		{devID, store.DefaultWorkspaceID, "m2", "chat", "DeepSeek", "deepseek-chat", "CNY", "0.5", "failure", "2026-10-24T10:00:00Z", false},
		// In a workspace purged since.
		{devID, "ws_gone", "", "title", "DeepSeek", "deepseek-chat", "CNY", "0.25", "stopped", "2026-10-23T10:00:00Z", true},
		// A test of a model belongs to no workspace.
		{adminID, "", "", "test", "OpenRouter", "claude-haiku", "USD", "0.000001", "success", "2026-10-24T12:00:00Z", false},
		{adminID, store.DefaultWorkspaceID, "m0", "chat", "OpenRouter", "claude-haiku", "USD", "1", "success", "2026-09-01T00:00:00Z", false},
	} {
		if _, err := admin.db.Pool.Exec(t.Context(), `INSERT INTO ai_usage (id, org_id, workspace_id, user_id, message_id, purpose, provider, model,
 input_tokens, cached_input_tokens, output_tokens, estimated, cost, currency, outcome, created_at)
 VALUES ($1, $2, NULLIF($3, ''), $4, NULLIF($5, ''), $6, $7, $8, 1000, 200, 100, $9, $10::numeric, $11, $12, $13)`,
			fmt.Sprintf("aiu_%d", i), store.DefaultOrgID, c.workspace, c.user, c.message, c.purpose, c.provider, c.model, c.estimated, c.cost, c.currency, c.outcome, c.at); err != nil {
			t.Fatal(err)
		}
	}
	// Another organization's calls are its own.
	if _, err := admin.db.Pool.Exec(t.Context(), `INSERT INTO ai_usage (id, org_id, purpose, provider, model, cost, currency, outcome, created_at)
 VALUES ('aiu_other', 'org_other', 'chat', 'OpenRouter', 'claude-haiku', 5, 'USD', 'success', '2026-10-24T12:00:00Z')`); err != nil {
		t.Fatal(err)
	}

	week := "&from=2026-10-19T00:00:00Z&to=2026-10-26T00:00:00Z"
	report := func(query string) (map[string]any, []map[string]any) {
		t.Helper()
		r := admin.expect("GET", "/ai/usage?"+query, nil, 200, "")
		var groups []map[string]any
		for _, g := range r["groups"].([]any) {
			groups = append(groups, g.(map[string]any))
		}
		return r, groups
	}
	summary := func(g map[string]any) string {
		u := g["usage"].(map[string]any)
		var costs []string
		for _, c := range u["costs"].([]any) {
			c := c.(map[string]any)
			costs = append(costs, fmt.Sprint(c["currency"], " ", c["amount"]))
		}
		return fmt.Sprintf("%v %v calls %s", g["key"], u["calls"], strings.Join(costs, ", "))
	}

	// Costs are summed in each currency apart, never together.
	r, groups := report("groupBy=user" + week)
	total := r["total"].(map[string]any)
	if r["answers"] != float64(2) || fmt.Sprint(total["calls"], total["failed"], total["stopped"], total["estimated"]) != "5 1 1 1" ||
		total["inputTokens"] != float64(5000) || total["cachedInputTokens"] != float64(1000) || total["cacheWriteTokens"] != float64(0) || total["outputTokens"] != float64(500) ||
		fmt.Sprint(total["costs"]) != "[map[amount:0.75 currency:CNY] map[amount:0.030001 currency:USD]]" {
		t.Errorf("total = %v, answers %v", total, r["answers"])
	}
	if len(groups) != 2 || summary(groups[0]) != adminID+" 3 calls USD 0.030001" || groups[0]["displayName"] != "Admin" || groups[0]["email"] != adminEmail ||
		summary(groups[1]) != devID+" 2 calls CNY 0.75" || groups[1]["displayName"] != "Dev" {
		t.Errorf("by user = %v", groups)
	}

	_, groups = report("groupBy=workspace" + week)
	if len(groups) != 3 || summary(groups[0]) != "ws_default 3 calls CNY 0.5, USD 0.03" || groups[0]["workspaceName"] != "Default" ||
		summary(groups[1]) != " 1 calls USD 0.000001" || groups[1]["workspaceName"] != nil ||
		summary(groups[2]) != "ws_gone 1 calls CNY 0.25" || groups[2]["workspaceName"] != nil {
		t.Errorf("by workspace = %v", groups)
	}

	_, groups = report("groupBy=model" + week)
	if len(groups) != 2 || groups[0]["provider"] != "OpenRouter" || groups[0]["model"] != "claude-haiku" || groups[0]["usage"].(map[string]any)["calls"] != float64(3) ||
		groups[1]["provider"] != "DeepSeek" || groups[1]["model"] != "deepseek-chat" {
		t.Errorf("by model = %v", groups)
	}

	_, groups = report("groupBy=purpose" + week)
	if len(groups) != 3 || summary(groups[0]) != "chat 3 calls CNY 0.5, USD 0.03" || summary(groups[1]) != "test 1 calls USD 0.000001" || summary(groups[2]) != "title 1 calls CNY 0.25" {
		t.Errorf("by purpose = %v", groups)
	}

	// Days are counted where the reader is, the latest first.
	days := func(query string) string {
		t.Helper()
		_, groups := report(query)
		var out []string
		for _, g := range groups {
			out = append(out, fmt.Sprint(g["key"], ":", g["usage"].(map[string]any)["calls"]))
		}
		return strings.Join(out, " ")
	}
	if got := days("groupBy=day&timeZone=Asia/Shanghai" + week); got != "2026-10-25:2 2026-10-24:2 2026-10-23:1" {
		t.Errorf("days in Shanghai = %s", got)
	}
	if got := days("groupBy=day" + week); got != "2026-10-24:4 2026-10-23:1" {
		t.Errorf("days in UTC = %s", got)
	}
	// Without a time, all of it.
	if r, _ := report("groupBy=day"); r["total"].(map[string]any)["calls"] != float64(6) || r["answers"] != float64(3) {
		t.Errorf("all the time = %v", r)
	}
	// Nothing to sum is nothing, in no currency.
	if r, groups := report("groupBy=user&from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z"); len(groups) != 0 || r["answers"] != float64(0) ||
		fmt.Sprint(r["total"].(map[string]any)["costs"]) != "[]" {
		t.Errorf("an empty time = %v", r)
	}
	if events := auditEvents(t, admin, "?category=ai"); len(events) != 0 {
		t.Errorf("reading usage was recorded: %v", events)
	}
}

func TestConversations(t *testing.T) {
	admin := newClient(t)
	const password = "member-password"
	for _, email := range []string{"viewer@example.com", "other@example.com"} {
		admin.expect("POST", "/users", map[string]any{"email": email, "displayName": "V", "password": password}, 201, "")
		admin.expect("POST", "/members", map[string]any{"userId": userID(t, admin, email), "role": "viewer"}, 201, "")
	}
	viewer := admin.signedIn("viewer@example.com", password)
	other := admin.signedIn("other@example.com", password)

	if status := viewer.expect("GET", "/assistant", nil, 200, ""); status["configured"] != false {
		t.Errorf("status = %v", status)
	}
	conv := viewer.expect("POST", "/assistant/conversations", nil, 201, "")
	id := conv["id"].(string)
	if conv["title"] != "" {
		t.Errorf("new conversation = %v", conv)
	}
	if got, events := viewer.stream("POST", "/assistant/conversations/"+id+"/messages", map[string]any{"text": "你好"}); got != 409 || events[0]["code"] != "assistant_not_configured" {
		t.Fatalf("without a model: %d %v", got, events)
	}

	setUpModel(t, admin, fakeModels(t, "你好，我是 SupaBI 的助手。"))
	if status := viewer.expect("GET", "/assistant", nil, 200, ""); status["configured"] != true {
		t.Errorf("status = %v", status)
	}
	if got, events := viewer.stream("POST", "/assistant/conversations/"+id+"/messages", map[string]any{"text": "  "}); got != 400 || events[0]["code"] != "empty_message" {
		t.Errorf("an empty message: %d %v", got, events)
	}
	if got, events := viewer.stream("POST", "/assistant/conversations/"+id+"/messages", map[string]any{"text": strings.Repeat("长", 60000)}); got != 400 || events[0]["code"] != "message_too_long" {
		t.Errorf("a message too long: %d %v", got, events)
	}

	got, events := viewer.stream("POST", "/assistant/conversations/"+id+"/messages", map[string]any{"text": "你好\n你是谁"})
	var types, text []string
	for _, e := range events {
		types = append(types, e["type"].(string))
		if e["type"] == "delta" {
			text = append(text, e["text"].(string))
		}
	}
	// The title comes from the chat model too: no title model is set.
	if got != 200 || strings.Join(types, " ") != "start status delta delta done title" || strings.Join(text, "") != "你好，我是 SupaBI 的助手。" {
		t.Fatalf("events: %d %v", got, events)
	}
	start := events[0]
	if q := start["question"].(map[string]any); q["role"] != "user" || q["status"] != "done" || q["parts"].([]any)[0].(map[string]any)["text"] != "你好\n你是谁" {
		t.Errorf("start = %v", start)
	}
	done := events[4]["answer"].(map[string]any)
	if done["status"] != "done" || done["id"] != start["answer"].(map[string]any)["id"] || done["error"] != nil {
		t.Errorf("done = %v", done)
	}

	_, messages := viewer.do("GET", "/assistant/conversations/"+id+"/messages", nil)
	if items := messages.([]any); len(items) != 2 || items[1].(map[string]any)["status"] != "done" {
		t.Errorf("messages = %v", messages)
	}
	_, convs := viewer.do("GET", "/assistant/conversations", nil)
	if items := convs.([]any); len(items) != 1 || items[0].(map[string]any)["title"] != "你好，我是 SupaBI 的助手" {
		t.Errorf("conversations = %v", convs)
	}

	// Only the owner sees a conversation.
	other.expect("GET", "/assistant/conversations/"+id+"/messages", nil, 404, "not_found")
	other.expect("DELETE", "/assistant/conversations/"+id, nil, 404, "not_found")
	if got, _ := other.stream("POST", "/assistant/conversations/"+id+"/messages", map[string]any{"text": "看看"}); got != 404 {
		t.Errorf("another person's conversation: %d", got)
	}
	if _, convs := other.do("GET", "/assistant/conversations", nil); len(convs.([]any)) != 0 {
		t.Errorf("another person's list = %v", convs)
	}

	if c := viewer.expect("PATCH", "/assistant/conversations/"+id, map[string]any{"title": " 自我介绍 "}, 200, ""); c["title"] != "自我介绍" {
		t.Errorf("renamed = %v", c)
	}
	viewer.expect("PATCH", "/assistant/conversations/"+id, map[string]any{"title": ""}, 400, "invalid_title")
	// Only a failed last answer can be written again.
	viewer.expect("POST", "/assistant/messages/"+done["id"].(string)+"/retry", nil, 409, "not_retryable")

	// Conversations are not in the audit log.
	for _, e := range auditEvents(t, admin, "") {
		if strings.Contains(fmt.Sprint(e), "你是谁") {
			t.Errorf("audited: %v", e)
		}
	}
	viewer.expect("DELETE", "/assistant/conversations/"+id, nil, 204, "")
	viewer.expect("GET", "/assistant/conversations/"+id+"/messages", nil, 404, "not_found")
}
