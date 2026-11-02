package assistant

import (
	"context"
	"errors"
	"strings"

	"github.com/supazd/supabi/internal/llm"
	"github.com/supazd/supabi/internal/store"
)

var errNothingToCompress = errors.New("nothing earlier than the latest messages to summarize")

// compress summarizes the earlier part of a conversation, so that the next
// answer fits: the latest messages stay as they are, within a share of the
// chat model's room, and always the one being answered; the rest joins the
// summary. The person still sees every message. After the provider refused
// the conversation as too long, only the message being answered is kept:
// the provider counts more than the estimate.
func (s *Service) compress(ctx context.Context, sc store.Scope, chat store.AIModelCall, conv store.Conversation, history []store.Message, answer store.Message, refused bool) (store.Conversation, error) {
	messages := pending(conv, history, answer)
	if len(messages) == 0 {
		return conv, errNothingToCompress
	}
	budget := room(chat.AIModel) / keepShare
	if refused {
		budget = 0
	}
	cut := len(messages) - 1
	kept := tokensOf(messages[cut])
	for cut > 0 {
		next := tokensOf(messages[cut-1])
		if kept+next > budget {
			break
		}
		cut--
		kept += next
	}
	// What is kept starts with a question, so that no answer is kept
	// without what it answered.
	for cut < len(messages)-1 && messages[cut].Role != "user" {
		cut++
	}
	older := messages[:cut]
	if len(older) == 0 {
		return conv, errNothingToCompress
	}

	model, err := store.ModelFor(ctx, s.Pool, sc.OrgID, store.PurposeCompression)
	if err != nil {
		return conv, err
	}
	summary := conv.Summary
	for _, part := range s.parts(model, summary, older) {
		if summary, err = s.summarize(ctx, sc, conv.ID, model, summary, part); err != nil {
			return conv, err
		}
	}
	through := older[len(older)-1].Seq
	if err := store.SetConversationSummary(context.WithoutCancel(ctx), s.Pool, conv.ID, summary, through); err != nil {
		return conv, err
	}
	conv.Summary, conv.SummaryThrough = summary, through
	return conv, nil
}

// parts splits the messages to summarize into runs that the summarizing
// model can read together with the summary so far, which grows as it goes.
// A message too long to fit is cut short.
func (s *Service) parts(model store.AIModelCall, summary string, messages []store.Message) [][]string {
	limit := int64(compressAt*float64(room(model.AIModel))) - llm.EstimateTokens(summaryPrompt) - llm.EstimateTokens(summary) - int64(min(model.MaxOutputTokens, maxSummaryTokens))
	limit = max(limit, 1000)
	var (
		out  [][]string
		part []string
		size int64
	)
	for _, m := range messages {
		line := transcriptLine(m)
		if n := llm.EstimateTokens(line); n > limit {
			line = string([]rune(line)[:limit]) + "…"
		}
		n := llm.EstimateTokens(line)
		if len(part) > 0 && size+n > limit {
			out, part, size = append(out, part), nil, 0
		}
		part, size = append(part, line), size+n
	}
	return append(out, part)
}

// transcriptLine is a message as the summarizing model reads it. Of the
// tools an answer called, only what they looked at is given: the figures
// they returned are not to be remembered, since they would be kept without
// their source.
func transcriptLine(m store.Message) string {
	if m.Role != "assistant" {
		return "User: " + m.Text()
	}
	var looked []string
	for _, p := range m.Parts {
		if p.Type == store.PartTool && p.Subject != "" && !p.Failed {
			looked = append(looked, p.Subject)
		}
	}
	if len(looked) == 0 {
		return "Assistant: " + m.Text()
	}
	return "Assistant (looked up: " + strings.Join(looked, "; ") + "): " + m.Text()
}

// summarize merges a part of the conversation into its summary.
func (s *Service) summarize(ctx context.Context, sc store.Scope, conversationID string, model store.AIModelCall, summary string, part []string) (string, error) {
	var in strings.Builder
	if summary != "" {
		in.WriteString("Earlier summary:\n" + summary + "\n\n")
	}
	in.WriteString("Conversation to add:\n" + strings.Join(part, "\n\n"))
	req := llm.Request{
		Model:     model.Model,
		MaxTokens: min(model.MaxOutputTokens, maxSummaryTokens),
		Messages:  []llm.Message{{Role: "system", Content: summaryPrompt}, {Role: "user", Content: in.String()}},
	}
	use := store.AIUsage{WorkspaceID: sc.WorkspaceID, UserID: sc.UserID, ConversationID: conversationID, Purpose: store.PurposeCompression}
	result, err := s.call(ctx, sc.OrgID, model, req, use, func(llm.Delta) {})
	if err != nil {
		return summary, err
	}
	text := strings.TrimSpace(withoutThinking(result.Text))
	if text == "" {
		return summary, errors.New("the summary came back empty")
	}
	return text, nil
}
