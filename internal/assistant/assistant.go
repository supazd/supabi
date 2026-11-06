// Package assistant is the agent behind the AI assistant: it answers people
// in their conversations, looking things up with the tools it is given,
// keeps a conversation within what the model can read, names conversations,
// and records what each call to a model cost. See .agents/design/ai-assistant.md.
package assistant

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"slices"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/supazd/supabi/internal/llm"
	"github.com/supazd/supabi/internal/secret"
	"github.com/supazd/supabi/internal/store"
)

// How full the model's room may get before the earlier part of a
// conversation is summarized, and before an answer stops looking things up,
// and how many tools an answer may call, are system settings:
// .agents/design/configuration.md 10.9.
const (
	// partFill is how much of the summarizing model's room one part of what
	// it summarizes may take, a margin for the estimate of its length.
	partFill = 0.8
	// keepShare: the latest messages kept as they are take at most this
	// share of the room, the rest being summarized.
	keepShare = 4
	// Titles and summaries are short; reasoning models need room to think first.
	maxTitleTokens   = 1024
	maxSummaryTokens = 4096
	titleTimeout     = time.Minute
)

// ErrMessageTooLong means a message does not fit in what the model can read.
var ErrMessageTooLong = errors.New("the message is too long for the model")

// Service answers people. Its fields are required.
type Service struct {
	Pool    *pgxpool.Pool
	Secrets *secret.Box
	LLM     *llm.Client
	Logger  *slog.Logger
	// Now is replaceable so that tests can pin the date the model is told.
	Now func() time.Time
	// Heartbeat is how often an answer being written is touched; zero is
	// store.MessageHeartbeat. Tests shorten it.
	Heartbeat time.Duration
}

// Tool is something the model may call while it answers. The API layer
// provides the tools, each running as the person asking, with what they
// may see; see .agents/design/ai-assistant.md 12.6.
type Tool struct {
	Name        string
	Description string
	// Parameters is the JSON Schema of the arguments.
	Parameters json.RawMessage
	// Run does what the model asked, with the arguments as it wrote them.
	Run func(ctx context.Context, arguments string) ToolResult
}

// ToolResult is what a tool returned.
type ToolResult struct {
	// Content is what the model reads.
	Content string
	// Failed says that Content tells what went wrong, for the model to put
	// right or to tell the person.
	Failed bool
	// Subject is what the tool looked at, for people.
	Subject string
	// Source is where the figures in Content came from; nil when it has none.
	Source *store.AnswerSource
	// Cells are the values of a source that the model was given, which
	// its calculations may use.
	Cells []any
	// Calculation is what the calculator worked out.
	Calculation *store.Calculation
	// Table is the data of a source, which charts are drawn from.
	Table *Table
	// Chart is a chart drawn.
	Chart *store.AnswerChart
}

// Event types: what a turn reports while it runs.
const (
	EventStatus = "status"
	EventDelta  = "delta"
	EventTool   = "tool"
	EventDone   = "done"
	EventTitle  = "title"
)

// Statuses an answer goes through before its text arrives.
const (
	StatusThinking    = "thinking"
	StatusCompressing = "compressing"
)

// Event is something a turn reports while it runs.
type Event struct {
	Type   string
	Status string
	Text   string
	// Part is a tool being called: without what it returned when it starts,
	// with it when it is done.
	Part *store.MessagePart
	// Running says the tool of Part has not returned yet.
	Running bool
	Message *store.Message
	Title   string
}

// room is what a model can read in one call: its context, less what its answer may take.
func room(m store.AIModel) int64 {
	return int64(m.ContextTokens - m.MaxOutputTokens)
}

// CheckMessage refuses a message that could not be answered even alone.
func (s *Service) CheckMessage(chat store.AIModelCall, text string) error {
	if llm.EstimateTokens(systemPrompt(s.now(), "UTC", ""))+llm.EstimateTokens(text) > room(chat.AIModel) {
		return ErrMessageTooLong
	}
	return nil
}

// Answer writes an answer that StartTurn or StartRetry began, calling the
// tools given as the model asks, and keeps it however it ends: done,
// stopped when ctx ends, or failed. The first answer of a conversation then
// gives it a title.
func (s *Service) Answer(ctx context.Context, sc store.Scope, answer store.Message, tools []Tool, emit func(Event)) {
	// What was written is kept even after the person has gone.
	keep := context.WithoutCancel(ctx)
	sofar := &progress{}
	stop := s.touch(keep, answer, sofar)
	w := s.write(ctx, sc, answer, tools, sofar, emit)
	stop()
	parts := sofar.snapshot()
	final, err := store.FinishAnswer(keep, s.Pool, answer.ID, parts, w.status, w.code, w.contextTokens)
	if err != nil {
		s.Logger.ErrorContext(ctx, "assistant answer not kept", "message", answer.ID, "error", err)
		final = answer
		final.Parts, final.Status, final.Error = parts, w.status, w.code
	}
	emit(Event{Type: EventDone, Message: &final})
	if final.Status == store.MessageDone && answer.Seq == 2 {
		s.nameConversation(keep, sc, answer.ConversationID, emit)
	}
}

// written is how an answer ended.
type written struct {
	status        string
	code          string
	contextTokens *int
}

// progress is what has been written of an answer so far: its text, and the
// tools called between.
type progress struct {
	mu    sync.Mutex
	parts []store.MessagePart
}

// write adds text to the text being written, or after a tool as text anew.
func (p *progress) write(text string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if n := len(p.parts); n > 0 && p.parts[n-1].Type == store.PartText {
		p.parts[n-1].Text += text
		return
	}
	p.parts = append(p.parts, store.MessagePart{Type: store.PartText, Text: text})
}

func (p *progress) add(part store.MessagePart) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.parts = append(p.parts, part)
}

func (p *progress) snapshot() []store.MessagePart {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.parts)
}

// touch keeps what there is of an answer regularly, which shows that it is
// still being written, from the start to the end: summarizing the
// conversation first can take long too. The function returned stops it.
func (s *Service) touch(ctx context.Context, answer store.Message, sofar *progress) (stop func()) {
	every := s.Heartbeat
	if every <= 0 {
		every = store.MessageHeartbeat
	}
	done := make(chan struct{})
	var wg sync.WaitGroup
	wg.Go(func() {
		ticker := time.NewTicker(every)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				if err := store.TouchAnswer(ctx, s.Pool, answer.ID, sofar.snapshot()); err != nil {
					s.Logger.WarnContext(ctx, "assistant answer not touched", "message", answer.ID, "error", err)
				}
			}
		}
	})
	return func() {
		close(done)
		wg.Wait()
	}
}

// write has the model answer, as many times over as it calls tools: each
// time it does, the tools run and what they returned is given back to it.
func (s *Service) write(ctx context.Context, sc store.Scope, answer store.Message, tools []Tool, sofar *progress, emit func(Event)) written {
	fail := func(err error) written {
		if errors.Is(err, context.Canceled) {
			return written{status: store.MessageStopped}
		}
		code := "internal"
		if errors.Is(err, store.ErrAssistantNotConfigured) {
			code = "not_configured"
		} else {
			s.Logger.ErrorContext(ctx, "assistant answer failed", "message", answer.ID, "error", err)
		}
		return written{status: store.MessageFailed, code: code}
	}
	chat, err := store.ModelFor(ctx, s.Pool, sc.OrgID, store.PurposeChat)
	if err != nil {
		return fail(err)
	}
	conv, err := store.GetConversation(ctx, s.Pool, sc, answer.ConversationID)
	if err != nil {
		return fail(err)
	}
	history, err := store.ListMessages(ctx, s.Pool, sc, answer.ConversationID)
	if err != nil {
		return fail(err)
	}
	workspace, err := store.GetWorkspace(ctx, s.Pool, sc)
	if err != nil {
		return fail(err)
	}
	// Read once: an answer keeps to the settings it started with.
	settings, err := store.SystemSettingsInForce(ctx, s.Pool, sc.OrgID)
	if err != nil {
		return fail(err)
	}
	maxCalls := settings.AssistantMaxToolCalls
	system := systemPrompt(s.now(), workspace.Timezone, "")
	full := room(chat.AIModel) * int64(settings.AssistantCompressPercent) / 100

	compressed := false
	compress := func(refused bool) {
		compressed = true
		emit(Event{Type: EventStatus, Status: StatusCompressing})
		summarized, err := s.compress(ctx, sc, chat, conv, history, answer, refused)
		if err != nil {
			// The answer is tried all the same: it may still fit.
			if !errors.Is(err, context.Canceled) {
				s.Logger.WarnContext(ctx, "assistant conversation not summarized", "conversation", conv.ID, "error", err)
			}
			return
		}
		conv = summarized
	}
	if used(system, conv, history, answer) > full {
		compress(false)
	}

	// The calculator and charts are the assistant's own; the others look data up.
	byName := map[string]Tool{}
	offered := []llm.Tool{calculatorTool, chartTool}
	for _, t := range tools {
		byName[t.Name] = t
		offered = append(offered, llm.Tool{Name: t.Name, Description: t.Description, Parameters: t.Parameters})
	}
	var (
		// turn is what this answer has called and been given back so far.
		turn                   []llm.Message
		rounds, calls, sources int
		// known is what each source of this answer holds, for calculations.
		known = figures{}
		// tables are the data of the lookups of this answer, for charts.
		tables = map[int]*Table{}
		// filled is how much of the model's room the answer has taken.
		filled int64
	)
	for {
		if err := ctx.Err(); err != nil {
			return fail(err)
		}
		rounds++
		emit(Event{Type: EventStatus, Status: StatusThinking})
		req := llm.Request{
			Model:         chat.Model,
			MaxTokens:     chat.MaxOutputTokens,
			ThinkingLevel: chat.ThinkingLevel,
			Messages:      slices.Concat([]llm.Message{{Role: "system", Content: systemPrompt(s.now(), workspace.Timezone, conv.Summary)}}, readable(conv, history, answer), turn),
		}
		// Past the most calls, or with the room nearly full, the model
		// answers with what it has found. No most is no limit.
		if (maxCalls == 0 || calls < maxCalls) && filled <= full {
			req.Tools = offered
		}
		result, err := s.stream(ctx, sc, chat, req, answer, sofar, emit)
		// A provider that counts more tokens than estimated refuses the
		// call; summarizing harder, once, then makes room.
		if llm.KindOf(err) == llm.ContextTooLong && !compressed && len(turn) == 0 && result.Text == "" {
			compress(true)
			continue
		}
		w := written{status: store.MessageDone}
		if result.Usage != nil {
			w.contextTokens = new(int(result.Usage.Context()))
			filled = result.Usage.Context()
		} else {
			filled = estimate(req, result)
		}
		var failed *llm.Error
		switch {
		case err == nil:
		case errors.Is(err, context.Canceled):
			w.status = store.MessageStopped
		case errors.As(err, &failed):
			w.status, w.code = store.MessageFailed, string(failed.Kind)
			s.Logger.WarnContext(ctx, "assistant model call failed", "message", answer.ID, "model", chat.Model, "error", err)
		default:
			// Ours, not the provider's: an API key that cannot be opened, say.
			w.status, w.code = store.MessageFailed, "internal"
			s.Logger.ErrorContext(ctx, "assistant answer failed", "message", answer.ID, "error", err)
		}
		// A model that calls tools when given none is answering with what it has.
		if err != nil || len(result.ToolCalls) == 0 || len(req.Tools) == 0 {
			return w
		}

		turn = append(turn, llm.Message{Role: "assistant", Content: result.Text, ToolCalls: result.ToolCalls, Reasoning: result.Reasoning})
		for i, call := range result.ToolCalls {
			part := store.MessagePart{Type: store.PartTool, CallID: call.ID, Tool: call.Name, Arguments: call.Arguments, Round: rounds}
			if i == 0 {
				part.Reasoning = result.Reasoning
			}
			emit(Event{Type: EventTool, Part: &part, Running: true})
			var (
				out    ToolResult
				worked []*big.Rat
			)
			// One reply may call many tools at once: past the most, they are not run.
			switch {
			case maxCalls > 0 && calls >= maxCalls:
				out = ToolResult{Content: "Not run: this answer has called tools as often as it may. Answer with what you have found.", Failed: true}
			case call.Name == calculatorName:
				var result *big.Rat
				// The figure is kept as the model is shown it, which is what it copies.
				if out, result = calculate(call.Arguments, known); result != nil {
					worked = []*big.Rat{asShown(result)}
				}
				calls++
			case call.Name == chartName:
				out, worked = drawChart(call.Arguments, tables)
				calls++
			default:
				out = run(ctx, byName, call)
				calls++
			}
			// A call stopped on the way is not kept: what it returned is not known.
			if err := ctx.Err(); err != nil {
				return fail(err)
			}
			// Sources, calculations and charts that work figures out are
			// numbered together, as the answer cites them.
			if out.Source != nil || out.Calculation != nil || (out.Chart != nil && len(out.Chart.Calculations) > 0) {
				sources++
				switch {
				case out.Source != nil:
					out.Source.N, known[sources] = sources, cellsOf(out.Cells)
					if out.Table != nil {
						tables[sources] = out.Table
					}
				case out.Calculation != nil:
					out.Calculation.N, known[sources] = sources, worked
				default:
					out.Chart.N, known[sources] = sources, worked
				}
				out.Content = fmt.Sprintf("Source [%d]\n%s", sources, out.Content)
			}
			done := part
			done.Content, done.Failed, done.Subject, done.Source, done.Calculation, done.Chart = out.Content, out.Failed, out.Subject, out.Source, out.Calculation, out.Chart
			sofar.add(done)
			emit(Event{Type: EventTool, Part: &done})
			turn = append(turn, llm.Message{Role: "tool", ToolCallID: call.ID, Content: out.Content})
			filled += llm.EstimateTokens(out.Content)
		}
	}
}

// run calls the tool the model asked for.
func run(ctx context.Context, tools map[string]Tool, call llm.ToolCall) ToolResult {
	tool, ok := tools[call.Name]
	if !ok {
		return ToolResult{Content: fmt.Sprintf("There is no tool named %q.", call.Name), Failed: true}
	}
	return tool.Run(ctx, call.Arguments)
}

// estimate is how much of the model's room a call took, for a provider that
// did not say.
func estimate(req llm.Request, result llm.Result) int64 {
	var total int64
	for _, m := range req.Messages {
		total += llm.EstimateTokens(m.Content)
		for _, c := range m.ToolCalls {
			total += llm.EstimateTokens(c.Arguments)
		}
	}
	total += llm.EstimateTokens(result.Text)
	for _, c := range result.ToolCalls {
		total += llm.EstimateTokens(c.Arguments)
	}
	return total
}

// stream calls the chat model for an answer, passing its text on as it
// arrives and adding it to what has been written so far.
func (s *Service) stream(ctx context.Context, sc store.Scope, chat store.AIModelCall, req llm.Request, answer store.Message, sofar *progress, emit func(Event)) (llm.Result, error) {
	use := store.AIUsage{WorkspaceID: sc.WorkspaceID, UserID: sc.UserID, ConversationID: answer.ConversationID, MessageID: answer.ID, Purpose: store.PurposeChat}
	return s.call(ctx, sc.OrgID, chat, req, use, func(d llm.Delta) {
		if d.Thinking {
			return
		}
		sofar.write(d.Text)
		emit(Event{Type: EventDelta, Text: d.Text})
	})
}

// call calls a model and records what the call used, at the model's prices.
func (s *Service) call(ctx context.Context, orgID string, m store.AIModelCall, req llm.Request, use store.AIUsage, onDelta func(llm.Delta)) (llm.Result, error) {
	provider, err := s.provider(m)
	if err != nil {
		return llm.Result{}, err
	}
	started := time.Now()
	result, err := s.LLM.Stream(ctx, provider, req, onDelta)
	use.Model, use.Duration, use.Outcome = m, time.Since(started), store.UsageSuccess
	switch kind := llm.KindOf(err); {
	case err == nil:
	case kind == "":
		use.Outcome = store.UsageStopped
	default:
		use.Outcome = store.UsageFailure
	}
	switch {
	case result.Usage != nil:
		u := result.Usage
		use.InputTokens, use.CachedInputTokens, use.CacheWriteTokens, use.OutputTokens = u.Input, u.CachedInput, u.CacheWrite, u.Output
	case err == nil || result.Text != "":
		// The provider read the request and wrote something, but did not
		// say how much: stopped answers never come with usage.
		for _, m := range req.Messages {
			use.InputTokens += llm.EstimateTokens(m.Content)
		}
		use.OutputTokens, use.Estimated = llm.EstimateTokens(result.Text), true
	}
	// A call refused before anything was written is recorded at no cost.
	if recErr := store.RecordAIUsage(context.WithoutCancel(ctx), s.Pool, orgID, use); recErr != nil {
		s.Logger.ErrorContext(ctx, "assistant usage not recorded", "model", m.Model, "purpose", use.Purpose, "error", recErr)
	}
	return result, err
}

func (s *Service) provider(m store.AIModelCall) (llm.Provider, error) {
	p := llm.Provider{Protocol: m.Provider.Protocol, BaseURL: m.Provider.BaseURL}
	if m.Provider.APIKey != nil {
		key, err := s.Secrets.Open(m.Provider.APIKey)
		if err != nil {
			return p, fmt.Errorf("API key of provider %s: %w", m.Provider.Name, err)
		}
		p.APIKey = key
	}
	return p, nil
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// readable is what the model reads of a conversation for an answer: the
// messages since the summary, without failed answers and empty ones.
func readable(conv store.Conversation, history []store.Message, answer store.Message) []llm.Message {
	var out []llm.Message
	for _, m := range pending(conv, history, answer) {
		out = append(out, asRead(m)...)
	}
	return out
}

// asRead is a message as the model reads it again. An answer that called
// tools is what it wrote, the calls it made and what they returned, in the
// order they came. What it reasoned is not given back: providers want it
// only while the answer goes on.
func asRead(m store.Message) []llm.Message {
	if m.Role != "assistant" || !m.UsedTools() {
		return []llm.Message{{Role: m.Role, Content: m.Text()}}
	}
	var (
		out     []llm.Message
		text    string
		calls   []llm.ToolCall
		results []llm.Message
		round   int
	)
	called := func() {
		out = append(out, llm.Message{Role: "assistant", Content: text, ToolCalls: calls})
		out = append(out, results...)
		text, calls, results = "", nil, nil
	}
	for _, p := range m.Parts {
		switch p.Type {
		case store.PartText:
			if len(calls) > 0 {
				called()
			}
			text += p.Text
		case store.PartTool:
			if len(calls) > 0 && p.Round != round {
				called()
			}
			round = p.Round
			calls = append(calls, llm.ToolCall{ID: p.CallID, Name: p.Tool, Arguments: p.Arguments})
			results = append(results, llm.Message{Role: "tool", ToolCallID: p.CallID, Content: p.Content})
		}
	}
	if len(calls) > 0 {
		called()
	}
	if text != "" {
		out = append(out, llm.Message{Role: "assistant", Content: text})
	}
	return out
}

// pending is the messages before an answer that the summary does not cover
// and that have something in them.
func pending(conv store.Conversation, history []store.Message, answer store.Message) []store.Message {
	var out []store.Message
	for _, m := range history {
		if m.Seq <= conv.SummaryThrough || m.Seq >= answer.Seq || m.Status == store.MessageFailed || (m.Text() == "" && !m.UsedTools()) {
			continue
		}
		out = append(out, m)
	}
	return out
}

// tokensOf estimates how much of the model's room a message takes, with
// the tools it called and what they returned.
func tokensOf(m store.Message) int64 {
	var total int64
	for _, p := range m.Parts {
		total += llm.EstimateTokens(p.Text) + llm.EstimateTokens(p.Arguments) + llm.EstimateTokens(p.Content)
	}
	return total
}

// used is how much of the model's room the next call would take: what the
// provider reported for the latest answer, and an estimate of what came
// after it. Without a report, all of it is estimated.
func used(system string, conv store.Conversation, history []store.Message, answer store.Message) int64 {
	messages := pending(conv, history, answer)
	total := llm.EstimateTokens(system) + llm.EstimateTokens(conv.Summary)
	from := 0
	for i := len(messages) - 1; i >= 0; i-- {
		if m := messages[i]; m.Role == "assistant" && m.ContextTokens != nil {
			total, from = int64(*m.ContextTokens), i+1
			break
		}
	}
	for _, m := range messages[from:] {
		total += tokensOf(m)
	}
	return total
}
