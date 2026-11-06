package assistant

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/supazd/supabi/internal/llm"
	"github.com/supazd/supabi/internal/secret"
	"github.com/supazd/supabi/internal/store"
	"github.com/supazd/supabi/internal/testdb"
)

// call is a request the fake provider received.
type call struct {
	Model     string `json:"model"`
	MaxTokens int    `json:"max_tokens"`
	Messages  []struct {
		Role       string `json:"role"`
		Content    string `json:"content"`
		ToolCalls  []any  `json:"tool_calls"`
		ToolCallID string `json:"tool_call_id"`
	} `json:"messages"`
	Tools []any `json:"tools"`
}

func (c call) system() string { return c.Messages[0].Content }

// fake is an OpenAI-compatible provider whose answers a test decides.
type fake struct {
	mu     sync.Mutex
	calls  []call
	answer func(c call, w http.ResponseWriter, r *http.Request)
}

func (f *fake) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var c call
	_ = json.NewDecoder(r.Body).Decode(&c)
	f.mu.Lock()
	f.calls = append(f.calls, c)
	answer := f.answer
	f.mu.Unlock()
	answer(c, w, r)
}

func (f *fake) callsTo(model string) []call {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []call
	for _, c := range f.calls {
		if c.Model == model {
			out = append(out, c)
		}
	}
	return out
}

// reply streams text in two pieces and reports usage when it is given.
func reply(w http.ResponseWriter, text string, usage string) {
	w.Header().Set("Content-Type", "text/event-stream")
	half := len([]rune(text)) / 2
	for _, piece := range []string{string([]rune(text)[:half]), string([]rune(text)[half:])} {
		chunk, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": piece}}}})
		fmt.Fprintf(w, "data: %s\n\n", chunk)
		w.(http.Flusher).Flush()
	}
	if usage != "" {
		fmt.Fprintf(w, "data: {\"choices\":[],\"usage\":%s}\n\n", usage)
	}
	fmt.Fprint(w, "data: [DONE]\n\n")
}

// callTools streams calls to tools, each a name and its arguments, the
// arguments in two pieces as providers send them.
func callTools(w http.ResponseWriter, calls ...[2]string) {
	w.Header().Set("Content-Type", "text/event-stream")
	for i, c := range calls {
		half := len(c[1]) / 2
		first, _ := json.Marshal(map[string]any{"index": i, "id": fmt.Sprintf("call_%d", i), "type": "function", "function": map[string]any{"name": c[0], "arguments": c[1][:half]}})
		rest, _ := json.Marshal(map[string]any{"index": i, "function": map[string]any{"arguments": c[1][half:]}})
		for _, part := range [][]byte{first, rest} {
			fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"tool_calls\":[%s]}}]}\n\n", part)
		}
	}
	fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n")
}

// testLog shows what the service logs with the test's output.
type testLog struct{ t *testing.T }

func (l testLog) Write(p []byte) (int, error) {
	l.t.Log(strings.TrimSpace(string(p)))
	return len(p), nil
}

type env struct {
	t *testing.T
	// onEvent sees the events of the turns asked.
	onEvent func(Event)
	ctx     context.Context
	svc     *Service
	pool    *testdb.DB
	scope   store.Scope
	fake    *fake
	chat    store.AIModel
	title   store.AIModel
	// tools are what the model may call.
	tools []Tool
}

// newEnv sets up an organization whose assistant answers with "chat-model",
// names conversations with "title-model" and summarizes with the chat model.
func newEnv(t *testing.T, contextTokens int) *env {
	t.Helper()
	db := testdb.New(t)
	ctx := context.Background()
	if _, err := store.Migrate(ctx, db.Pool, store.CoreMigrations()); err != nil {
		t.Fatal(err)
	}
	if err := store.Bootstrap(ctx, db.Pool); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO users (id, org_id, email, display_name) VALUES ('usr_a', $1, 'a@example.com', 'A')`, store.DefaultOrgID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `UPDATE workspaces SET timezone = 'Asia/Shanghai'`); err != nil {
		t.Fatal(err)
	}
	box, err := secret.NewBox(secret.GenerateKey())
	if err != nil {
		t.Fatal(err)
	}
	f := &fake{answer: func(c call, w http.ResponseWriter, _ *http.Request) { reply(w, "好的", "") }}
	server := httptest.NewServer(f)
	t.Cleanup(server.Close)

	e := &env{t: t, ctx: ctx, pool: db, fake: f,
		scope: store.Scope{OrgID: store.DefaultOrgID, WorkspaceID: store.DefaultWorkspaceID, UserID: "usr_a"},
		svc: &Service{Pool: db.Pool, Secrets: box, LLM: &llm.Client{Idle: 5 * time.Second}, Logger: slog.New(slog.NewTextHandler(testLog{t}, nil)),
			Now: func() time.Time { return time.Date(2026, 10, 22, 20, 0, 0, 0, time.UTC) }},
	}
	provider, err := store.CreateAIProvider(ctx, db.Pool, e.scope, store.AIProvider{Name: "Fake", Protocol: llm.OpenAI, BaseURL: server.URL + "/v1", APIKey: box.Seal("sk-test")})
	if err != nil {
		t.Fatal(err)
	}
	if e.chat, err = store.CreateAIModel(ctx, db.Pool, e.scope, store.AIModel{ProviderID: provider.ID, Model: "chat-model", ContextTokens: contextTokens, MaxOutputTokens: contextTokens / 8,
		Currency: "CNY", InputPrice: "2", CachedInputPrice: new("0.5"), OutputPrice: "8"}); err != nil {
		t.Fatal(err)
	}
	if e.title, err = store.CreateAIModel(ctx, db.Pool, e.scope, store.AIModel{ProviderID: provider.ID, Model: "title-model", ContextTokens: 8000, MaxOutputTokens: 2000,
		Currency: "USD", InputPrice: "0.1", OutputPrice: "0.4"}); err != nil {
		t.Fatal(err)
	}
	if err := store.SetAISettings(ctx, db.Pool, e.scope, store.AISettings{ChatModelID: e.chat.ID, TitleModelID: e.title.ID}); err != nil {
		t.Fatal(err)
	}
	return e
}

// ask sends a message in a conversation and has it answered.
func (e *env) ask(ctx context.Context, conversationID, text string) (store.Message, []Event) {
	e.t.Helper()
	_, answer, err := store.StartTurn(e.ctx, e.pool.Pool, e.scope, conversationID, text, "chat-model")
	if err != nil {
		e.t.Fatal(err)
	}
	var (
		mu     sync.Mutex
		events []Event
	)
	e.svc.Answer(ctx, e.scope, answer, e.tools, func(ev Event) {
		mu.Lock()
		events = append(events, ev)
		mu.Unlock()
		if e.onEvent != nil {
			e.onEvent(ev)
		}
	})
	for _, ev := range events {
		if ev.Type == EventDone {
			return *ev.Message, events
		}
	}
	e.t.Fatalf("no done event in %v", events)
	return store.Message{}, nil
}

func (e *env) conversation() store.Conversation {
	e.t.Helper()
	c, err := store.CreateConversation(e.ctx, e.pool.Pool, e.scope)
	if err != nil {
		e.t.Fatal(err)
	}
	return c
}

type usageRow struct {
	Purpose, Model, Outcome, Currency, Cost string
	Input, Cached, Output                   int64
	Estimated                               bool
}

func (e *env) usage() []usageRow {
	e.t.Helper()
	rows, err := e.pool.Pool.Query(e.ctx, `SELECT purpose, model, outcome, currency, cost::text, input_tokens, cached_input_tokens, output_tokens, estimated FROM ai_usage ORDER BY created_at, purpose`)
	if err != nil {
		e.t.Fatal(err)
	}
	defer rows.Close()
	var out []usageRow
	for rows.Next() {
		var u usageRow
		if err := rows.Scan(&u.Purpose, &u.Model, &u.Outcome, &u.Currency, &u.Cost, &u.Input, &u.Cached, &u.Output, &u.Estimated); err != nil {
			e.t.Fatal(err)
		}
		out = append(out, u)
	}
	return out
}

func TestAnswer(t *testing.T) {
	e := newEnv(t, 64000)
	e.fake.answer = func(c call, w http.ResponseWriter, _ *http.Request) {
		if c.Model == "title-model" {
			reply(w, "「销售概况」。", `{"prompt_tokens":40,"completion_tokens":6}`)
			return
		}
		reply(w, "你好，我暂时查不到数据。", `{"prompt_tokens":3000,"completion_tokens":500,"prompt_tokens_details":{"cached_tokens":2000}}`)
	}
	conv := e.conversation()
	answer, events := e.ask(e.ctx, conv.ID, "上个月销售额多少？\n按大区")

	if answer.Status != store.MessageDone || answer.Text() != "你好，我暂时查不到数据。" || answer.Model != "chat-model" || answer.ContextTokens == nil || *answer.ContextTokens != 3500 {
		t.Errorf("answer = %+v", answer)
	}
	var types, text []string
	for _, ev := range events {
		types = append(types, ev.Type+ev.Status)
		if ev.Type == EventDelta {
			text = append(text, ev.Text)
		}
	}
	if got := strings.Join(types, " "); got != "statusthinking delta delta done title" {
		t.Errorf("events = %s", got)
	}
	if strings.Join(text, "") != answer.Text() || events[len(events)-1].Title != "销售概况" {
		t.Errorf("deltas %q, events %+v", text, events)
	}

	chat := e.fake.callsTo("chat-model")
	if len(chat) != 1 || chat[0].MaxTokens != 8000 || len(chat[0].Messages) != 2 || chat[0].Messages[1].Content != "上个月销售额多少？\n按大区" {
		t.Fatalf("chat calls = %+v", chat)
	}
	if !strings.Contains(chat[0].system(), "Friday, 23 October 2026") || !strings.Contains(chat[0].system(), "Asia/Shanghai") {
		t.Errorf("system prompt does not date the conversation in the workspace's time zone:\n%s", chat[0].system())
	}
	if c, _ := store.GetConversation(e.ctx, e.pool.Pool, e.scope, conv.ID); c.Title != "销售概况" {
		t.Errorf("title = %q", c.Title)
	}

	// (3000-2000)×2 + 2000×0.5 + 500×8 per million; the title model's in its own currency.
	want := []usageRow{
		{Purpose: "chat", Model: "chat-model", Outcome: "success", Currency: "CNY", Cost: "0.007", Input: 1000, Cached: 2000, Output: 500},
		{Purpose: "title", Model: "title-model", Outcome: "success", Currency: "USD", Cost: "0.0000064", Input: 40, Output: 6},
	}
	got := e.usage()
	for i := range got {
		got[i].Cost = strings.TrimRight(strings.TrimRight(got[i].Cost, "0"), ".")
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("usage = %+v\nwant %+v", got, want)
	}

	// Later answers do not rename the conversation.
	e.ask(e.ctx, conv.ID, "那今年呢")
	if n := len(e.fake.callsTo("title-model")); n != 1 {
		t.Errorf("title model called %d times", n)
	}
}

// Stopping keeps what was written, and the call is recorded as estimated.
func TestStopAnswer(t *testing.T) {
	e := newEnv(t, 64000)
	ctx, cancel := context.WithCancel(e.ctx)
	e.fake.answer = func(c call, w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"写到一半\"}}]}\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}
	e.onEvent = func(ev Event) {
		if ev.Type == EventDelta {
			cancel()
		}
	}
	conv := e.conversation()
	answer, _ := e.ask(ctx, conv.ID, "讲个长故事")
	if answer.Status != store.MessageStopped || answer.Text() != "写到一半" {
		t.Errorf("answer = %+v", answer)
	}
	u := e.usage()
	if len(u) != 1 || u[0].Outcome != "stopped" || !u[0].Estimated || u[0].Output != 4 || u[0].Input == 0 {
		t.Errorf("usage = %+v", u)
	}
	// A stopped answer does not get the conversation named.
	if len(e.fake.callsTo("title-model")) != 0 {
		t.Error("title model called")
	}
}

func TestFailedAnswer(t *testing.T) {
	e := newEnv(t, 64000)
	e.fake.answer = func(c call, w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w, `{"error":{"message":"Incorrect API key provided: sk-te****"}}`)
	}
	conv := e.conversation()
	answer, _ := e.ask(e.ctx, conv.ID, "你好")
	if answer.Status != store.MessageFailed || answer.Error != "unauthorized" || answer.Text() != "" {
		t.Errorf("answer = %+v", answer)
	}
	if u := e.usage(); len(u) != 1 || u[0].Outcome != "failure" || u[0].Input != 0 || u[0].Estimated {
		t.Errorf("usage = %+v", u)
	}

	// Written again, it succeeds; only the last answer can be.
	e.fake.answer = func(c call, w http.ResponseWriter, _ *http.Request) { reply(w, "你好！", "") }
	again, err := store.StartRetry(e.ctx, e.pool.Pool, e.scope, answer.ID, "chat-model")
	if err != nil {
		t.Fatal(err)
	}
	e.svc.Answer(e.ctx, e.scope, again, nil, func(Event) {})
	messages, _ := store.ListMessages(e.ctx, e.pool.Pool, e.scope, conv.ID)
	if len(messages) != 2 || messages[1].Status != store.MessageDone || messages[1].Text() != "你好！" {
		t.Errorf("messages = %+v", messages)
	}
	if _, err := store.StartRetry(e.ctx, e.pool.Pool, e.scope, messages[1].ID, "chat-model"); err != store.ErrNotRetryable {
		t.Errorf("retrying a done answer: %v", err)
	}
}

// One answer at a time in a conversation; one whose writer died is taken
// for failed once it has gone untouched for a while.
func TestOneAnswerAtATime(t *testing.T) {
	e := newEnv(t, 64000)
	conv := e.conversation()
	_, first, err := store.StartTurn(e.ctx, e.pool.Pool, e.scope, conv.ID, "一", "chat-model")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.StartTurn(e.ctx, e.pool.Pool, e.scope, conv.ID, "二", "chat-model"); err != store.ErrAssistantBusy {
		t.Fatalf("second turn: %v", err)
	}
	if _, err := e.pool.Pool.Exec(e.ctx, `UPDATE ai_messages SET updated_at = now() - interval '2 minutes' WHERE id = $1`, first.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.StartTurn(e.ctx, e.pool.Pool, e.scope, conv.ID, "二", "chat-model"); err != nil {
		t.Fatalf("after the first writer died: %v", err)
	}
	messages, _ := store.ListMessages(e.ctx, e.pool.Pool, e.scope, conv.ID)
	if len(messages) != 4 || messages[1].Status != store.MessageFailed || messages[1].Error != "interrupted" {
		t.Errorf("messages = %+v", messages)
	}
	// Someone else's conversation is not there for them.
	other := e.scope
	other.UserID = "usr_b"
	if _, _, err := store.StartTurn(e.ctx, e.pool.Pool, other, conv.ID, "三", "chat-model"); err != store.ErrNotFound {
		t.Errorf("another person's turn: %v", err)
	}
}

// A conversation that outgrows the model's room is summarized: the model then
// reads the summary and the latest messages, and the person still sees all.
func TestCompress(t *testing.T) {
	e := newEnv(t, 8000) // room: 7000 tokens, summarized past 5600
	e.fake.answer = func(c call, w http.ResponseWriter, _ *http.Request) {
		var prompt int64
		for _, m := range c.Messages {
			prompt += llm.EstimateTokens(m.Content)
		}
		usage := fmt.Sprintf(`{"prompt_tokens":%d,"completion_tokens":2}`, prompt)
		if strings.Contains(c.system(), "keep the memory") {
			reply(w, "用户在问各大区的销售。", usage)
			return
		}
		reply(w, "好的。", usage)
	}
	conv := e.conversation()
	long := strings.Repeat("销", 1500)
	for i := range 3 {
		e.ask(e.ctx, conv.ID, fmt.Sprintf("第%d问%s", i+1, long))
	}
	if n := len(e.fake.callsTo("chat-model")); n != 3 {
		t.Fatalf("%d chat calls before the room ran out", n)
	}
	// After three questions of 1500 tokens, a fourth takes it past 5600.
	answer, events := e.ask(e.ctx, conv.ID, "第4问"+long)
	if answer.Status != store.MessageDone || events[0].Status != StatusCompressing {
		t.Fatalf("answer %+v, events %+v", answer, events)
	}
	var summarizing []call
	calls := e.fake.callsTo("chat-model")
	for _, c := range calls {
		if strings.Contains(c.system(), "keep the memory") {
			summarizing = append(summarizing, c)
		}
	}
	// The three earlier rounds, in parts that fit the summarizing model.
	if len(summarizing) != 2 || !strings.HasPrefix(summarizing[0].Messages[1].Content, "Conversation to add:\nUser: 第1问") ||
		!strings.HasPrefix(summarizing[1].Messages[1].Content, "Earlier summary:\n用户在问各大区的销售。") || !strings.Contains(summarizing[1].Messages[1].Content, "User: 第3问") {
		t.Errorf("summarizing calls = %d", len(summarizing))
	}
	last := calls[len(calls)-1]
	if !strings.Contains(last.system(), "用户在问各大区的销售。") {
		t.Errorf("the summary is not given to the model:\n%s", last.system())
	}
	// What is kept starts with a question, and ends with the one answered.
	if got := last.Messages[1:]; got[0].Role != "user" || !strings.HasPrefix(got[len(got)-1].Content, "第4问") || len(got) > 3 {
		t.Errorf("messages kept = %d, first %s", len(got), got[0].Role)
	}
	c, _ := store.GetConversation(e.ctx, e.pool.Pool, e.scope, conv.ID)
	if c.Summary != "用户在问各大区的销售。" || c.SummaryThrough != 6 {
		t.Errorf("conversation = %+v", c)
	}
	if messages, _ := store.ListMessages(e.ctx, e.pool.Pool, e.scope, conv.ID); len(messages) != 8 {
		t.Errorf("%d messages kept", len(messages))
	}
	purposes := map[string]int{}
	for _, u := range e.usage() {
		purposes[u.Purpose]++
	}
	if purposes["compression"] == 0 {
		t.Errorf("usage by purpose = %v", purposes)
	}
}

// A provider that counts more tokens than estimated says the request is too
// long; the conversation is then summarized and the call made again.
func TestCompressWhenTheProviderRefuses(t *testing.T) {
	e := newEnv(t, 64000)
	refused := false
	e.fake.answer = func(c call, w http.ResponseWriter, _ *http.Request) {
		switch {
		case strings.Contains(c.system(), "keep the memory"):
			reply(w, "摘要", "")
		case !refused && len(c.Messages) > 3:
			refused = true
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprint(w, `{"error":{"message":"This model's maximum context length is 64000 tokens","code":"context_length_exceeded"}}`)
		default:
			reply(w, "好的。", "")
		}
	}
	conv := e.conversation()
	e.ask(e.ctx, conv.ID, "一")
	answer, _ := e.ask(e.ctx, conv.ID, "二")
	if answer.Status != store.MessageDone || !refused {
		t.Fatalf("answer = %+v", answer)
	}
	if c, _ := store.GetConversation(e.ctx, e.pool.Pool, e.scope, conv.ID); c.Summary != "摘要" || c.SummaryThrough != 2 {
		t.Errorf("conversation = %+v", c)
	}
}

func TestCheckMessage(t *testing.T) {
	svc := &Service{}
	chat := store.AIModelCall{AIModel: store.AIModel{ContextTokens: 1000, MaxOutputTokens: 200}}
	if err := svc.CheckMessage(chat, "你好"); err != nil {
		t.Error(err)
	}
	if err := svc.CheckMessage(chat, strings.Repeat("长", 800)); err != ErrMessageTooLong {
		t.Errorf("long message: %v", err)
	}
}

func TestCleanTitle(t *testing.T) {
	cases := map[string]string{
		"「销售概况」。":                             "销售概况",
		"<think>想想</think>\n\n**Q3 Revenue**": "Q3 Revenue",
		"# 标题\n第二行":                           "标题",
		"":                                    "",
	}
	for in, want := range cases {
		if got := cleanTitle(in); got != want {
			t.Errorf("cleanTitle(%q) = %q, want %q", in, got, want)
		}
	}
}

// Summarizing a long conversation can take long; the answer is touched all
// the while, so that it is not taken for abandoned.
func TestTouchWhileSummarizing(t *testing.T) {
	e := newEnv(t, 8000)
	e.svc.Heartbeat = 50 * time.Millisecond
	var touched time.Duration
	e.fake.answer = func(c call, w http.ResponseWriter, _ *http.Request) {
		if strings.Contains(c.system(), "keep the memory") && touched == 0 {
			time.Sleep(400 * time.Millisecond)
			if err := e.pool.Pool.QueryRow(e.ctx, `SELECT updated_at - created_at FROM ai_messages WHERE status = 'generating'`).Scan(&touched); err != nil {
				t.Error(err)
			}
		}
		reply(w, "好的。", "")
	}
	conv := e.conversation()
	long := strings.Repeat("销", 2000)
	for i := range 3 {
		e.ask(e.ctx, conv.ID, fmt.Sprintf("第%d问%s", i+1, long))
	}
	if touched < 200*time.Millisecond {
		t.Errorf("touched %v after the answer began, while summarizing", touched)
	}
}

// What goes wrong on our side is not blamed on the provider.
func TestInternalFailure(t *testing.T) {
	e := newEnv(t, 64000)
	if _, err := e.pool.Pool.Exec(e.ctx, `UPDATE ai_providers SET api_key = '\x00'`); err != nil {
		t.Fatal(err)
	}
	answer, _ := e.ask(e.ctx, e.conversation().ID, "你好")
	if answer.Status != store.MessageFailed || answer.Error != "internal" {
		t.Errorf("answer = %+v", answer)
	}
}

// testTools look up dashboards and a chart, as the API layer's tools do,
// and note the arguments they were called with.
func testTools(called *[]string) []Tool {
	params := json.RawMessage(`{"type":"object","properties":{}}`)
	return []Tool{
		{Name: "list_dashboards", Description: "Lists dashboards.", Parameters: params, Run: func(_ context.Context, arguments string) ToolResult {
			*called = append(*called, "list_dashboards "+arguments)
			return ToolResult{Content: `[{"id":"d1","name":"销售看板"}]`, Subject: "仪表盘"}
		}},
		{Name: "query_chart", Description: "Reads a chart.", Parameters: params, Run: func(_ context.Context, arguments string) ToolResult {
			*called = append(*called, "query_chart "+arguments)
			if strings.Contains(arguments, "w9") {
				return ToolResult{Content: "unknown widget w9", Failed: true}
			}
			return ToolResult{Content: `{"rows":[["华东",100],["华南",80]]}`, Subject: "销售看板 › 营收", Source: &store.AnswerSource{DashboardID: "d1", ItemID: "w1"}, Cells: []any{"华东", 100, "华南", 80},
				Table: &Table{Columns: []Column{{Name: "region", Type: "string", Role: "dimension"}, {Name: "revenue", Type: "integer", Role: "measure"}}, Rows: [][]any{{"华东", 100}, {"华南", 80}}}}
		}},
	}
}

// The model calls tools, is given what they returned, and answers; the
// answer keeps the calls with what it wrote, and the next turn reads them.
func TestAnswerWithTools(t *testing.T) {
	e := newEnv(t, 64000)
	var called []string
	e.tools = testTools(&called)
	e.fake.answer = func(c call, w http.ResponseWriter, _ *http.Request) {
		if c.Model == "title-model" {
			reply(w, "华东营收", "")
			return
		}
		switch last := c.Messages[len(c.Messages)-1]; {
		case last.Role == "user" && strings.HasPrefix(last.Content, "华东"):
			callTools(w, [2]string{"list_dashboards", `{}`}, [2]string{"query_chart", `{"dashboard":"d1","widget":"w9"}`})
		case last.Role == "tool" && strings.Contains(last.Content, "w9"):
			callTools(w, [2]string{"query_chart", `{"dashboard":"d1","widget":"w1"}`})
		case last.Role == "tool":
			reply(w, "华东是 100 [1]。", `{"prompt_tokens":900,"completion_tokens":20}`)
		default:
			reply(w, "还是 100 [1]。", "")
		}
	}
	conv := e.conversation()
	answer, events := e.ask(e.ctx, conv.ID, "华东营收多少")

	if answer.Status != store.MessageDone || answer.Text() != "华东是 100 [1]。" || *answer.ContextTokens != 920 {
		t.Fatalf("answer = %+v", answer)
	}
	if want := []string{"list_dashboards {}", `query_chart {"dashboard":"d1","widget":"w9"}`, `query_chart {"dashboard":"d1","widget":"w1"}`}; fmt.Sprint(called) != fmt.Sprint(want) {
		t.Errorf("tools called: %q", called)
	}
	var kinds []string
	for _, p := range answer.Parts {
		kinds = append(kinds, p.Type+":"+p.Tool)
	}
	if got := strings.Join(kinds, " "); got != "tool:list_dashboards tool:query_chart tool:query_chart text:" {
		t.Fatalf("parts = %s", got)
	}
	failed, found := answer.Parts[1], answer.Parts[2]
	if !failed.Failed || failed.Source != nil || found.Source == nil || found.Source.N != 1 || !strings.HasPrefix(found.Content, "Source [1]\n") || found.Subject != "销售看板 › 营收" {
		t.Errorf("tool parts = %+v, %+v", failed, found)
	}
	var types []string
	for _, ev := range events {
		types = append(types, ev.Type+ev.Status)
	}
	if got := strings.Join(types, " "); got != "statusthinking tool tool tool tool statusthinking tool tool statusthinking delta delta done title" {
		t.Errorf("events = %s", got)
	}

	chat := e.fake.callsTo("chat-model")
	if len(chat) != 3 || len(chat[0].Tools) != 4 || len(chat[2].Tools) != 4 {
		t.Fatalf("chat calls = %d", len(chat))
	}
	// The model is given back what it called and what each call returned.
	got := chat[2].Messages[2:]
	if len(got) != 5 || len(got[0].ToolCalls) != 2 || got[1].ToolCallID != "call_0" || got[2].ToolCallID != "call_1" || len(got[3].ToolCalls) != 1 || !strings.HasPrefix(got[4].Content, "Source [1]") {
		t.Errorf("messages of the last call = %+v", got)
	}

	// The next turn reads the calls of the answer before, as they were made.
	e.ask(e.ctx, conv.ID, "确定吗")
	chat = e.fake.callsTo("chat-model")
	next := chat[len(chat)-1].Messages[1:]
	var roles []string
	for _, m := range next {
		roles = append(roles, m.Role)
	}
	if got := strings.Join(roles, " "); got != "user assistant tool tool assistant tool assistant user" || next[6].Content != "华东是 100 [1]。" {
		t.Errorf("history read = %s", got)
	}
}

// setSystem sets the system settings the next answers start with.
func (e *env) setSystem(v store.SystemSettingValues) {
	e.t.Helper()
	if err := store.SetSystemSettings(e.ctx, e.pool.Pool, e.scope, v); err != nil {
		e.t.Fatal(err)
	}
}

// toolResults counts what the model was given back in this answer and the ones before.
func (c call) toolResults() int {
	n := 0
	for _, m := range c.Messages {
		if m.Role == "tool" {
			n++
		}
	}
	return n
}

// Past the most calls an answer may make, as set, the model is given no
// tools and answers with what it has found.
func TestToolCallsEnd(t *testing.T) {
	e := newEnv(t, 64000)
	most := 3
	e.setSystem(store.SystemSettingValues{AssistantMaxToolCalls: &most})
	var called []string
	e.tools = testTools(&called)
	e.fake.answer = func(c call, w http.ResponseWriter, _ *http.Request) {
		if len(c.Tools) > 0 {
			callTools(w, [2]string{"list_dashboards", `{}`})
			return
		}
		reply(w, "查不完。", "")
	}
	answer, _ := e.ask(e.ctx, e.conversation().ID, "一直查")
	if answer.Status != store.MessageDone || answer.Text() != "查不完。" || len(called) != most {
		t.Errorf("answer %q after %d calls", answer.Text(), len(called))
	}

	// Calls past the most in one reply are not run either.
	called = nil
	e.fake.answer = func(c call, w http.ResponseWriter, _ *http.Request) {
		if len(c.Tools) == 0 {
			reply(w, "够了。", "")
			return
		}
		many := make([][2]string, most+5)
		for i := range many {
			many[i] = [2]string{"list_dashboards", `{}`}
		}
		callTools(w, many...)
	}
	answer, _ = e.ask(e.ctx, e.conversation().ID, "一次查很多")
	notRun := 0
	for _, p := range answer.Parts {
		if p.Failed && strings.HasPrefix(p.Content, "Not run") {
			notRun++
		}
	}
	if answer.Text() != "够了。" || len(called) != most || notRun != 5 {
		t.Errorf("answer %q after %d calls, %d not run", answer.Text(), len(called), notRun)
	}

	// One that calls tools even when given none is not run further.
	called = nil
	e.fake.answer = func(c call, w http.ResponseWriter, _ *http.Request) {
		if c.Model == "chat-model" {
			callTools(w, [2]string{"list_dashboards", `{}`})
		}
	}
	if answer, _ := e.ask(e.ctx, e.conversation().ID, "还查"); answer.Status != store.MessageDone || len(called) != most {
		t.Errorf("answer %+v after %d calls", answer, len(called))
	}

	// With no most, an answer calls tools for as long as the model asks,
	// past the default too.
	none, wanted := 0, store.DefaultSystemSettings.AssistantMaxToolCalls+5
	e.setSystem(store.SystemSettingValues{AssistantMaxToolCalls: &none})
	called = nil
	conv := e.conversation()
	e.fake.answer = func(c call, w http.ResponseWriter, _ *http.Request) {
		if len(c.Tools) > 0 && c.toolResults() < wanted {
			callTools(w, [2]string{"list_dashboards", `{}`})
			return
		}
		reply(w, "查完了。", "")
	}
	if answer, _ := e.ask(e.ctx, conv.ID, "查到底"); answer.Text() != "查完了。" || len(called) != wanted {
		t.Errorf("answer %q after %d calls, without a most", answer.Text(), len(called))
	}
}

// Past the share of the room set, an answer is given no more tools and
// answers with what it has found.
func TestToolsEndWhenTheRoomFills(t *testing.T) {
	e := newEnv(t, 64000) // room: 56000 tokens, half of it 28000
	half := 50
	e.setSystem(store.SystemSettingValues{AssistantCompressPercent: &half})
	calls := 0
	e.tools = []Tool{{Name: "big", Parameters: json.RawMessage(`{"type":"object"}`), Run: func(context.Context, string) ToolResult {
		calls++
		return ToolResult{Content: strings.Repeat("数", 10000)}
	}}}
	e.fake.answer = func(c call, w http.ResponseWriter, _ *http.Request) {
		if len(c.Tools) > 0 {
			callTools(w, [2]string{"big", `{}`})
			return
		}
		reply(w, "就这些。", "")
	}
	// Each result takes 10000: after the third, the next call would read
	// more than 28000.
	if answer, _ := e.ask(e.ctx, e.conversation().ID, "查很多"); answer.Text() != "就这些。" || calls != 3 {
		t.Errorf("answer %q after %d calls", answer.Text(), calls)
	}
}

// A conversation is summarized past the share of the room set.
func TestCompressAtTheSetShare(t *testing.T) {
	e := newEnv(t, 64000) // room: 56000 tokens, half of it 28000
	half := 50
	e.setSystem(store.SystemSettingValues{AssistantCompressPercent: &half})
	e.fake.answer = func(c call, w http.ResponseWriter, _ *http.Request) {
		if strings.Contains(c.system(), "keep the memory") {
			reply(w, "摘要", "")
			return
		}
		reply(w, "好的。", "")
	}
	conv := e.conversation()
	long := strings.Repeat("销", 10000)
	for i := range 2 {
		if _, events := e.ask(e.ctx, conv.ID, fmt.Sprintf("第%d问%s", i+1, long)); events[0].Status == StatusCompressing {
			t.Fatalf("summarized at question %d", i+1)
		}
	}
	// A third takes it past 28000, though not past the default of 44800.
	if _, events := e.ask(e.ctx, conv.ID, "第3问"+long); events[0].Status != StatusCompressing {
		t.Errorf("not summarized past half the room: %+v", events[0])
	}
}

// Stopped while a tool runs, the answer keeps the calls that were done.
func TestStopWhileToolRuns(t *testing.T) {
	e := newEnv(t, 64000)
	ctx, cancel := context.WithCancel(e.ctx)
	e.tools = []Tool{{Name: "slow", Parameters: json.RawMessage(`{"type":"object"}`), Run: func(ctx context.Context, _ string) ToolResult {
		cancel()
		<-ctx.Done()
		return ToolResult{Content: "too late", Failed: true}
	}}}
	e.fake.answer = func(c call, w http.ResponseWriter, _ *http.Request) { callTools(w, [2]string{"slow", `{}`}) }
	answer, _ := e.ask(ctx, e.conversation().ID, "查")
	if answer.Status != store.MessageStopped || len(answer.Parts) != 0 {
		t.Errorf("answer = %+v", answer)
	}
}

// The model works a figure out from those it looked up, citing them; the
// calculation is numbered among the sources, and its inputs are checked.
func TestAnswerWithCalculation(t *testing.T) {
	e := newEnv(t, 64000)
	var called []string
	e.tools = testTools(&called)
	e.fake.answer = func(c call, w http.ResponseWriter, _ *http.Request) {
		last := c.Messages[len(c.Messages)-1]
		switch {
		case c.Model == "title-model":
			reply(w, "差额", "")
		case last.Role == "user":
			callTools(w, [2]string{"query_chart", `{"dashboard":"d1","widget":"w1"}`})
		case strings.Contains(last.Content, "has no figure 70"):
			callTools(w, [2]string{"calculate", `{"expression":"a - b","inputs":{"a":{"label":"华东","value":100,"source":1},"b":{"label":"华南","value":80,"source":1}}}`})
		case strings.HasPrefix(last.Content, "Source [1]"):
			// A figure misread first, then put right.
			callTools(w, [2]string{"calculate", `{"expression":"a - b","inputs":{"a":{"label":"华东","value":100,"source":1},"b":{"label":"华南","value":70,"source":1}}}`})
		default:
			reply(w, "华东比华南多 20 [2]（100 [1] − 80 [1]）。", "")
		}
	}
	answer, _ := e.ask(e.ctx, e.conversation().ID, "华东比华南多多少")
	if answer.Status != store.MessageDone || len(answer.Parts) != 4 {
		t.Fatalf("answer = %+v", answer)
	}
	wrong, right := answer.Parts[1], answer.Parts[2]
	if !wrong.Failed || wrong.Calculation != nil {
		t.Errorf("a misread input is refused: %+v", wrong)
	}
	if right.Calculation == nil || right.Calculation.N != 2 || right.Calculation.Result != "20" || right.Subject != "华东 − 华南 = 20" || !strings.HasPrefix(right.Content, "Source [2]\n") {
		t.Errorf("calculation = %+v", right)
	}
	// The calculator and charts are offered with the tools that look data up.
	if chat := e.fake.callsTo("chat-model"); len(chat[0].Tools) != 4 {
		t.Errorf("%d tools offered", len(chat[0].Tools))
	}
}

// A chart is drawn from a lookup of the answer; one that works a series out
// is numbered among the sources, and its figures can be calculated with.
func TestAnswerWithChart(t *testing.T) {
	e := newEnv(t, 64000)
	var called []string
	e.tools = testTools(&called)
	e.fake.answer = func(c call, w http.ResponseWriter, _ *http.Request) {
		last := c.Messages[len(c.Messages)-1]
		switch {
		case c.Model == "title-model":
			reply(w, "各区域营收", "")
		case last.Role == "user":
			callTools(w, [2]string{"query_chart", `{"dashboard":"d1","widget":"w1"}`})
		case strings.HasPrefix(last.Content, "Source [1]"):
			callTools(w, [2]string{"draw_chart", `{"type":"bar","title":"各区域营收","x":"region","series":[{"id":"r","name":"营收","source":1,"column":"revenue"},{"id":"d","name":"三分之一","expression":"r / 3"}]}`})
		case strings.HasPrefix(last.Content, "Source [2]"):
			// Figures that do not end, as the model is shown them.
			callTools(w, [2]string{"calculate", `{"expression":"a / 7","inputs":{"a":{"label":"华东三分之一","value":"33.33333333","source":2}}}`})
		case strings.HasPrefix(last.Content, "Source [3]"):
			callTools(w, [2]string{"calculate", `{"expression":"a * 7","inputs":{"a":{"label":"上一步","value":"4.761904761","source":3}}}`})
		default:
			reply(w, "华东的三分之一是 33.33 [2]。", "")
		}
	}
	conv := e.conversation()
	answer, _ := e.ask(e.ctx, conv.ID, "画出各区域营收")
	if answer.Status != store.MessageDone || len(answer.Parts) != 5 {
		t.Fatalf("answer = %+v", answer)
	}
	chart := answer.Parts[1]
	if chart.Failed || chart.Chart == nil || chart.Chart.N != 2 || chart.Subject != "各区域营收" || !strings.HasPrefix(chart.Content, "Source [2]\nShown: 各区域营收.") {
		t.Fatalf("chart = %+v", chart)
	}
	if want := `[["华东",100,"33.33333333"],["华南",80,"26.66666667"]]`; compact(chart.Chart.Rows) != want {
		t.Errorf("rows = %s, want %s", chart.Chart.Rows, want)
	}
	if calc := answer.Parts[2]; calc.Failed || calc.Calculation == nil || calc.Calculation.N != 3 || calc.Calculation.Result != "4.761904761" {
		t.Errorf("calculation from the chart = %+v", calc)
	}
	if calc := answer.Parts[3]; calc.Failed || calc.Calculation == nil || calc.Calculation.N != 4 || calc.Calculation.Result != "33.333333327" {
		t.Errorf("calculation from a calculation = %+v", calc)
	}
	// The chart is kept with the answer.
	kept, err := store.ListMessages(e.ctx, e.pool.Pool, e.scope, conv.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got := kept[len(kept)-1].Parts[1].Chart; got == nil || got.N != 2 || compact(got.Rows) != compact(chart.Chart.Rows) || len(got.Calculations) != 1 {
		t.Errorf("kept = %+v", got)
	}
}

// compact is JSON as written without spaces, which the database adds.
func compact(raw []byte) string {
	var out bytes.Buffer
	if err := json.Compact(&out, raw); err != nil {
		return string(raw)
	}
	return out.String()
}
