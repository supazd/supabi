package assistant

import (
	"context"
	"regexp"
	"strings"

	"github.com/supazd/supabi/internal/llm"
	"github.com/supazd/supabi/internal/store"
)

// nameConversation asks the title model what a conversation is about, after
// its first answer. A conversation its owner has named keeps its name; a
// title that cannot be had leaves the start of the first question.
func (s *Service) nameConversation(ctx context.Context, sc store.Scope, conversationID string, emit func(Event)) {
	ctx, cancel := context.WithTimeout(ctx, titleTimeout)
	defer cancel()
	conv, err := store.GetConversation(ctx, s.Pool, sc, conversationID)
	if err != nil || conv.TitleByUser {
		return
	}
	history, err := store.ListMessages(ctx, s.Pool, sc, conversationID)
	if err != nil || len(history) < 2 {
		return
	}
	model, err := store.ModelFor(ctx, s.Pool, sc.OrgID, store.PurposeTitle)
	if err != nil {
		return
	}
	req := llm.Request{
		Model:     model.Model,
		MaxTokens: min(model.MaxOutputTokens, maxTitleTokens),
		Messages: []llm.Message{
			{Role: "system", Content: titlePrompt},
			{Role: "user", Content: "Question:\n" + clip(history[0].Text(), 2000) + "\n\nAnswer:\n" + clip(history[1].Text(), 2000)},
		},
	}
	use := store.AIUsage{WorkspaceID: sc.WorkspaceID, UserID: sc.UserID, ConversationID: conversationID, Purpose: store.PurposeTitle}
	result, err := s.call(ctx, sc.OrgID, model, req, use, func(llm.Delta) {})
	if err != nil {
		s.Logger.WarnContext(ctx, "assistant conversation not named", "conversation", conversationID, "error", err)
		return
	}
	title := cleanTitle(result.Text)
	if title == "" {
		return
	}
	if named, err := store.SetAutoTitle(ctx, s.Pool, conversationID, title); err != nil {
		s.Logger.WarnContext(ctx, "assistant conversation title not kept", "conversation", conversationID, "error", err)
	} else if named {
		emit(Event{Type: EventTitle, Title: title})
	}
}

var thinking = regexp.MustCompile(`(?s)<think>.*?(</think>|$)`)

// withoutThinking drops reasoning that a model server left in the answer.
func withoutThinking(text string) string {
	return thinking.ReplaceAllString(text, "")
}

// cleanTitle keeps the first line of what the model wrote, without the
// quotes and final punctuation models add however they are asked.
func cleanTitle(text string) string {
	var line string
	for l := range strings.SplitSeq(withoutThinking(text), "\n") {
		if l = strings.TrimSpace(l); l != "" {
			line = l
			break
		}
	}
	line = strings.TrimLeft(line, "# ")
	for {
		trimmed := strings.TrimRight(strings.Trim(line, " *\"'`“”‘’「」『』《》"), "。.!！?？；;：:，,")
		if trimmed == line {
			break
		}
		line = trimmed
	}
	return store.TitleFromText(line)
}

func clip(text string, most int) string {
	if r := []rune(text); len(r) > most {
		return string(r[:most]) + "…"
	}
	return text
}
