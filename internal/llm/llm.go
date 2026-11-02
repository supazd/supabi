// Package llm calls language models, in the protocols their providers speak.
// It knows nothing of SupaBI: what to ask and what to keep is the caller's.
package llm

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"
	"unicode"
)

// Protocols a provider may speak.
const (
	// OpenAI is OpenAI-compatible chat completions, which most providers and
	// model servers offer: DeepSeek, Qwen, Kimi, GLM, vLLM, Ollama and others.
	OpenAI = "openai"
)

// Protocols lists every protocol there is.
var Protocols = []string{OpenAI}

// Provider is where a model runs and how to reach it.
type Provider struct {
	Protocol string
	BaseURL  string
	// APIKey is sent with each call; empty sends none.
	APIKey string
}

// Message is one message of what the model reads.
type Message struct {
	// Role is system, user, assistant, or tool for what a tool returned.
	Role    string
	Content string
	// ToolCalls are the tools an assistant message called.
	ToolCalls []ToolCall
	// ToolCallID is the call a tool message answers.
	ToolCallID string
	// Reasoning is what the model reasoned before calling tools, for the
	// providers that want it back while the same answer goes on.
	Reasoning string
}

// Tool is a function the model may call. Parameters is a JSON Schema.
type Tool struct {
	Name        string
	Description string
	Parameters  json.RawMessage
}

// ToolCall is a call the model made: a tool by name, and its arguments as
// the JSON text the model wrote, which may not even be JSON.
type ToolCall struct {
	ID        string
	Name      string
	Arguments string
}

// Request is one call to a model.
type Request struct {
	Model     string
	Messages  []Message
	MaxTokens int
	// Tools are what the model may call; none, and it only writes.
	Tools []Tool
	// ThinkingLevel says how hard the model thinks, in the provider's own
	// words, which differ; empty leaves it to the provider.
	ThinkingLevel string
}

// Usage is what a call was billed for, in tokens of four kinds that do not
// overlap: providers count them differently, and are converted to these.
type Usage struct {
	// Input is read without the provider's cache.
	Input       int64
	CachedInput int64
	CacheWrite  int64
	// Output includes reasoning.
	Output int64
}

// Context is how much of the model's context the call filled.
func (u Usage) Context() int64 { return u.Input + u.CachedInput + u.CacheWrite + u.Output }

// Result is what a call wrote. It holds what arrived even when the call
// failed part of the way.
type Result struct {
	Text string
	// ToolCalls are the tools the model called; the answer goes on once
	// their results are given back.
	ToolCalls []ToolCall
	// Reasoning is what the model reasoned, where the provider sends it apart.
	Reasoning string
	// Usage is nil when the provider did not report it.
	Usage *Usage
	// Truncated is set when the answer stopped at MaxTokens.
	Truncated bool
}

// Delta is a piece of an answer as it arrives.
type Delta struct {
	Text string
	// Thinking is set for a piece of the model's reasoning, which is not
	// part of the answer: it only shows that the model is working.
	Thinking bool
}

// ErrorKind is why a call failed, in terms a person can act on.
type ErrorKind string

const (
	Unauthorized   ErrorKind = "unauthorized"
	RateLimited    ErrorKind = "rate_limited"
	ContextTooLong ErrorKind = "context_too_long"
	Unreachable    ErrorKind = "unreachable"
	Timeout        ErrorKind = "timeout"
	// Rejected is any other error the provider answered with.
	Rejected ErrorKind = "provider_error"
)

// Error is a call that failed for a reason other than the caller stopping it.
type Error struct {
	Kind   ErrorKind
	Status int
	// Message is what the provider said. It can repeat parts of the request,
	// a part of the API key even, so it is for administrators and logs only.
	Message string
}

func (e *Error) Error() string {
	if e.Status != 0 {
		return fmt.Sprintf("%s (HTTP %d): %s", e.Kind, e.Status, e.Message)
	}
	return fmt.Sprintf("%s: %s", e.Kind, e.Message)
}

// KindOf is the kind of a failed call, or "" when the caller stopped it.
func KindOf(err error) ErrorKind {
	var e *Error
	if errors.As(err, &e) {
		return e.Kind
	}
	if errors.Is(err, context.Canceled) {
		return ""
	}
	return Unreachable
}

// Client calls models.
type Client struct {
	HTTP *http.Client
	// Idle is how long a call may go without hearing anything from the
	// provider before it is given up; reasoning counts as hearing.
	Idle time.Duration
}

// Stream calls a model and passes the answer on as it arrives. The context
// stops it; the error is then the context's.
func (c *Client) Stream(ctx context.Context, p Provider, req Request, onDelta func(Delta)) (Result, error) {
	switch p.Protocol {
	case OpenAI:
		return c.streamOpenAI(ctx, p, req, onDelta)
	}
	return Result{}, &Error{Kind: Rejected, Message: "unknown protocol " + p.Protocol}
}

// Call calls a model and returns its whole answer.
func (c *Client) Call(ctx context.Context, p Provider, req Request) (Result, error) {
	return c.Stream(ctx, p, req, func(Delta) {})
}

// EstimateTokens guesses how many tokens a text takes, for when a provider
// does not say. It errs high: a character of Chinese, Japanese or Korean is
// about a token, and other text about four characters to the token.
func EstimateTokens(text string) int64 {
	var wide, other int64
	for _, r := range text {
		if unicode.In(r, unicode.Han, unicode.Hiragana, unicode.Katakana, unicode.Hangul) {
			wide++
		} else {
			other++
		}
	}
	return wide + (other+2)/3
}
