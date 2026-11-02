package api

import (
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

// scriptedModels is an OpenAI-compatible provider that calls tools: for
// each round of an answer, the calls given, each a tool and its arguments,
// and then the text. It keeps what each call was given.
type scriptedModels struct {
	mu     sync.Mutex
	rounds [][][2]string
	text   string
	seen   [][]map[string]any
}

func (m *scriptedModels) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Messages []map[string]any `json:"messages"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	m.mu.Lock()
	m.seen = append(m.seen, body.Messages)
	// The calls already answered in this answer say which round it is.
	round := 0
	for i := len(body.Messages) - 1; i >= 0 && body.Messages[i]["role"] != "user"; i-- {
		if body.Messages[i]["role"] == "assistant" {
			round++
		}
	}
	m.mu.Unlock()
	w.Header().Set("Content-Type", "text/event-stream")
	if round < len(m.rounds) {
		for i, call := range m.rounds[round] {
			part, _ := json.Marshal(map[string]any{"index": i, "id": fmt.Sprintf("call_%d_%d", round, i), "type": "function", "function": map[string]any{"name": call[0], "arguments": call[1]}})
			fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"tool_calls\":[%s]}}]}\n\n", part)
		}
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n")
		return
	}
	chunk, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": m.text}}}})
	fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", chunk)
}

// toolResults are what the tools called returned, by call ID.
func (m *scriptedModels) toolResults() map[string]string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := map[string]string{}
	for _, messages := range m.seen {
		for _, msg := range messages {
			if msg["role"] == "tool" {
				out[msg["tool_call_id"].(string)] = msg["content"].(string)
			}
		}
	}
	return out
}

// A viewer asks; the assistant finds the dashboard they can open, reads how
// it is laid out, looks up a filter's values and reads a chart drilled down,
// as the dashboard would show it to them, and cites where the figures came from.
func TestAssistantTools(t *testing.T) {
	f := newContentFixture(t)
	input := f.drilledChart()
	// The dataset's parameter keeps its default, which the source lists.
	input["spec"].(map[string]any)["filters"] = []any{map[string]any{"id": "p_since", "param": "since", "label": "起始日", "control": map[string]any{"type": "input"}}}
	chart := f.developer.expect("POST", "/charts", input, 201, "")["id"].(string)
	spec := dashboardSpec(chart)
	spec["filters"] = []any{
		map[string]any{"id": "g_region", "label": "大区", "op": "in", "control": map[string]any{"type": "select", "multi": true},
			"targets": []any{map[string]any{"item": "wa", "field": "region"}}},
		map[string]any{"id": "g_amount", "label": "金额", "op": "between", "control": map[string]any{"type": "number_range"},
			"targets": []any{map[string]any{"item": "wa", "field": "amount"}}},
	}
	board := f.developer.expect("POST", "/dashboards", map[string]any{"name": "销售看板", "spec": spec}, 201, "")["id"].(string)
	f.share(t, board)
	hidden := f.developer.expect("POST", "/dashboards", map[string]any{"name": "未授权", "spec": dashboardSpec(chart)}, 201, "")["id"].(string)

	models := &scriptedModels{text: "华东 1 月是 100.50 [1]。", rounds: [][][2]string{
		{{"list_dashboards", `{}`}, {"describe_dashboard", `{"dashboard":"` + board + `"}`}},
		{{"filter_options", `{"dashboard":"` + board + `","filter":"g_region","search":"东"}`},
			{"query_chart", `{"dashboard":"` + board + `","widget":"wa","filters":{"g_region":["华东"],"g_amount":[null,null]},"drill":["华东"]}`},
			{"query_chart", `{"dashboard":"` + hidden + `","widget":"wa"}`}},
	}}
	server := httptest.NewServer(models)
	t.Cleanup(server.Close)
	providerID := f.admin.expect("POST", "/ai/providers", map[string]any{"name": "Fake", "protocol": "openai", "baseUrl": server.URL + "/v1"}, 201, "")["id"].(string)
	modelID := f.admin.expect("POST", "/ai/providers/"+providerID+"/models", map[string]any{"model": "fake-chat", "contextTokens": 64000, "maxOutputTokens": 8000,
		"currency": "CNY", "inputPrice": "2", "outputPrice": "8"}, 201, "")["id"].(string)
	f.admin.expect("PUT", "/ai/settings", map[string]any{"chatModelId": modelID}, 200, "")

	conv := f.viewer.expect("POST", "/assistant/conversations", nil, 201, "")["id"].(string)
	status, events := f.viewer.stream("POST", "/assistant/conversations/"+conv+"/messages", map[string]any{"text": "华东每月销售额"})
	if status != 200 {
		t.Fatalf("status %d: %v", status, events)
	}
	var tools []string
	for _, e := range events {
		if e["type"] == "tool" {
			part := e["part"].(map[string]any)
			tools = append(tools, fmt.Sprint(part["tool"], " ", part["done"]))
		}
	}
	if got := strings.Join(tools, ", "); got != "list_dashboards false, list_dashboards true, describe_dashboard false, describe_dashboard true, filter_options false, filter_options true, query_chart false, query_chart true, query_chart false, query_chart true" {
		t.Fatalf("tool events: %s", got)
	}

	results := models.toolResults()
	if listed := results["call_0_0"]; !strings.Contains(listed, `"name":"销售看板"`) || strings.Contains(listed, hidden) || !strings.Contains(listed, `"widget":"wa"`) {
		t.Errorf("list_dashboards: %s", listed)
	}
	described := results["call_0_1"]
	for _, want := range []string{`"id":"g_region"`, `"label":"大区"`, `"appliesTo":["wa"]`, `"levels":["月","日"]`, `"column":"region"`, `"label":"销售额"`} {
		if !strings.Contains(described, want) {
			t.Errorf("describe_dashboard lacks %s: %s", want, described)
		}
	}
	if options := results["call_1_0"]; options != `{"truncated":false,"values":["华东"]}` {
		t.Errorf("filter_options: %s", options)
	}
	read := results["call_1_1"]
	if !strings.HasPrefix(read, "Source [1]\n") || !strings.Contains(read, `"rows":[["2026-01-01","100.50"],["2026-02-01","200.00"]]`) || !strings.Contains(read, `"label":"大区","value":["华东"]`) {
		t.Errorf("query_chart: %s", read)
	}
	// A dashboard the viewer cannot open is not there for the assistant either.
	if refused := results["call_1_2"]; !strings.HasPrefix(refused, "not_found") {
		t.Errorf("a dashboard not shared: %s", refused)
	}

	// The answer keeps the calls with its text; the source of the figures
	// names the chart and the conditions it was read under.
	_, listed := f.viewer.do("GET", "/assistant/conversations/"+conv+"/messages", nil)
	raw, _ := json.Marshal(listed)
	var kept []struct {
		Parts []struct {
			Type, Tool, Subject, Text string
			Failed                    bool
			Source                    *struct {
				N                              int
				DashboardID, ChartName         string
				ChartRevision, DatasetRevision int
				Conditions                     []map[string]any
				State                          map[string]any
			}
		}
	}
	if err := json.Unmarshal(raw, &kept); err != nil || len(kept) != 2 {
		t.Fatalf("messages: %s", raw)
	}
	parts := kept[1].Parts
	if len(parts) != 6 || parts[5].Text != "华东 1 月是 100.50 [1]。" || !parts[4].Failed || parts[3].Subject != "销售看板 › 下钻" || parts[1].Subject != "销售看板" {
		t.Fatalf("parts: %s", raw)
	}
	source := parts[3].Source
	if source == nil || source.N != 1 || source.DashboardID != board || source.ChartRevision != 1 || source.DatasetRevision != 1 {
		t.Fatalf("source: %s", raw)
	}
	conditions, _ := json.Marshal(source.Conditions)
	// An open range restricts nothing, so it is no condition.
	if string(conditions) != `[{"kind":"filter","label":"大区","value":["华东"]},{"default":true,"kind":"chartFilter","label":"起始日","value":"2026-01-01"},{"kind":"drill","label":"地区","text":"华东","value":["华东"]}]` {
		t.Errorf("conditions: %s", conditions)
	}
	state, _ := json.Marshal(source.State)
	if string(state) != `{"drill":{"wa":{"root":"地区","steps":[{"value":"华东"}]}},"filters":{"g_amount":[null,null],"g_region":["华东"]}}` {
		t.Errorf("state: %s", state)
	}
	// Opening the source shares those conditions, as the viewer could.
	f.viewer.expect("POST", "/dashboards/"+board+"/views", map[string]any{"state": source.State, "validDays": 30}, 201, "")

	// What the tools read is audited as the dashboard's endpoints audit it.
	event := eventOf(t, auditEvents(t, f.admin, "?category=query"), "query.run", func(e map[string]any) bool {
		detail, _ := e["detail"].(map[string]any)
		return detail["via"] == "assistant" && detail["itemId"] == "wa" && detail["filterId"] == nil
	})
	if object := event["object"].(map[string]any); object["id"] != board || object["name"] != "销售看板" {
		t.Errorf("query event: %v", event)
	}
}

// A chart that lists only its top rows gives the model every row it shows:
// the model is told there are more, and the source does not say it read only some.
func TestSourceOfAChartWithALimit(t *testing.T) {
	f := newContentFixture(t)
	input := f.drilledChart()
	input["spec"].(map[string]any)["query"].(map[string]any)["limit"] = 1
	chart := f.developer.expect("POST", "/charts", input, 201, "")["id"].(string)
	board := f.developer.expect("POST", "/dashboards", map[string]any{"name": "销售看板", "spec": dashboardSpec(chart)}, 201, "")["id"].(string)
	f.share(t, board)

	models := &scriptedModels{text: "华东最高 [1]。", rounds: [][][2]string{
		{{"query_chart", `{"dashboard":"` + board + `","widget":"wa"}`}},
	}}
	server := httptest.NewServer(models)
	t.Cleanup(server.Close)
	providerID := f.admin.expect("POST", "/ai/providers", map[string]any{"name": "Fake", "protocol": "openai", "baseUrl": server.URL + "/v1"}, 201, "")["id"].(string)
	modelID := f.admin.expect("POST", "/ai/providers/"+providerID+"/models", map[string]any{"model": "fake-chat", "contextTokens": 64000, "maxOutputTokens": 8000,
		"currency": "CNY", "inputPrice": "2", "outputPrice": "8"}, 201, "")["id"].(string)
	f.admin.expect("PUT", "/ai/settings", map[string]any{"chatModelId": modelID}, 200, "")

	conv := f.viewer.expect("POST", "/assistant/conversations", nil, 201, "")["id"].(string)
	if status, events := f.viewer.stream("POST", "/assistant/conversations/"+conv+"/messages", map[string]any{"text": "哪个大区最高"}); status != 200 {
		t.Fatalf("status %d: %v", status, events)
	}
	if read := models.toolResults()["call_0_0"]; !strings.Contains(read, `"totalRows":1,"truncated":true`) {
		t.Errorf("the model is not told the chart has more rows: %s", read)
	}

	_, listed := f.viewer.do("GET", "/assistant/conversations/"+conv+"/messages", nil)
	raw, _ := json.Marshal(listed)
	var kept []struct {
		Parts []struct {
			Source *struct {
				Rows      int
				Truncated bool
			}
		}
	}
	if err := json.Unmarshal(raw, &kept); err != nil || len(kept) != 2 {
		t.Fatalf("messages: %s", raw)
	}
	for _, part := range kept[1].Parts {
		if part.Source != nil {
			if part.Source.Rows != 1 || part.Source.Truncated {
				t.Errorf("source = %+v, want the one row, all of it read", *part.Source)
			}
			return
		}
	}
	t.Fatalf("no source: %s", raw)
}

// A date parameter's days relative to today are written as the days they
// stand for in the workspace's time zone, where it may already be tomorrow.
func TestRelativeDaysText(t *testing.T) {
	s := &Server{Now: func() time.Time { return time.Date(2026, 3, 10, 20, 0, 0, 0, time.UTC) }}
	utc, shanghai := store.Workspace{Timezone: "UTC"}, store.Workspace{Timezone: "Asia/Shanghai"}
	for _, c := range []struct {
		value     any
		workspace store.Workspace
		want      string
	}{
		{map[string]any{"relative": "today-1d"}, utc, "2026-03-09"},
		{map[string]any{"relative": "today-1d"}, shanghai, "2026-03-10"},
		{[]any{"2026-01-01", map[string]any{"relative": "today"}}, shanghai, "2026-01-01, 2026-03-11"},
		{"2026-01-01", shanghai, ""},
		{map[string]any{"relative": "yesterday"}, shanghai, ""},
	} {
		if got := s.relativeDaysText(c.value, c.workspace); got != c.want {
			t.Errorf("%v in %s: %q, want %q", c.value, c.workspace.Timezone, got, c.want)
		}
	}
}
