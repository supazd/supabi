package assistant

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/supazd/supabi/internal/llm"
	"github.com/supazd/supabi/internal/store"
)

// Trial is how a model answered a short call from an administrator.
type Trial struct {
	Reply    string
	Duration time.Duration
	// Err is what went wrong at the provider; nil when the model answered.
	Err *llm.Error
	// Tools is how it did when asked to call a tool, once it answered.
	Tools *ToolsTrial
}

// ToolsTrial is how a model did when asked to call a tool: the assistant
// looks data up through tools, which not every model or server offers.
type ToolsTrial struct {
	Called bool
	// Err is what the provider said when it refused the call.
	Err *llm.Error
}

// clockTool is the tool a model is asked to call when it is tried.
var clockTool = llm.Tool{Name: "get_time", Description: "Gives the current time.", Parameters: []byte(`{"type":"object","properties":{}}`)}

// TryModel makes a short call to a model, as an administrator checks it
// before setting it for anything. The call is recorded as any other.
func (s *Service) TryModel(ctx context.Context, sc store.Scope, modelID string) (Trial, error) {
	m, err := store.ModelCall(ctx, s.Pool, sc.OrgID, modelID)
	if err != nil {
		return Trial{}, err
	}
	// Thinking takes from the tokens of an answer: with a level set, the
	// model has what it has when it answers, or it may use them all up.
	room := func(tokens int) int {
		if m.ThinkingLevel != "" {
			return m.MaxOutputTokens
		}
		return min(m.MaxOutputTokens, tokens)
	}
	req := llm.Request{
		Model:         m.Model,
		MaxTokens:     room(256),
		ThinkingLevel: m.ThinkingLevel,
		Messages:      []llm.Message{{Role: "user", Content: "Reply with one word: OK"}},
	}
	started := time.Now()
	result, err := s.call(ctx, sc.OrgID, m, req, store.AIUsage{UserID: sc.UserID, Purpose: store.PurposeTest}, func(llm.Delta) {})
	t := Trial{Reply: strings.TrimSpace(withoutThinking(result.Text)), Duration: time.Since(started)}
	var failed *llm.Error
	if errors.As(err, &failed) {
		t.Err = failed
		return t, nil
	}
	if err != nil {
		return t, err
	}
	req = llm.Request{
		Model: m.Model,
		// A reasoning model thinks before it calls.
		MaxTokens:     room(maxSummaryTokens),
		ThinkingLevel: m.ThinkingLevel,
		Messages:      []llm.Message{{Role: "user", Content: "What time is it? Call the tool to find out."}},
		Tools:         []llm.Tool{clockTool},
	}
	result, err = s.call(ctx, sc.OrgID, m, req, store.AIUsage{UserID: sc.UserID, Purpose: store.PurposeTest}, func(llm.Delta) {})
	t.Tools = &ToolsTrial{Called: len(result.ToolCalls) > 0}
	if errors.As(err, &failed) {
		t.Tools.Err = failed
		return t, nil
	}
	return t, err
}
