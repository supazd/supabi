package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/supazd/supabi/internal/api/gen"
	"github.com/supazd/supabi/internal/assistant"
	"github.com/supazd/supabi/internal/llm"
	"github.com/supazd/supabi/internal/store"
)

// The AI assistant: the models system administrators set up, and each
// person's conversations. See .agents/design/ai-assistant.md.

// ---- models, for system administrators ----

func (s *Server) GetAIConfig(ctx context.Context, _ gen.GetAIConfigRequestObject) (gen.GetAIConfigResponseObject, error) {
	orgID := s.scope(ctx).OrgID
	providers, err := store.ListAIProviders(ctx, s.Pool, orgID)
	if err != nil {
		return nil, err
	}
	models, err := store.ListAIModels(ctx, s.Pool, orgID)
	if err != nil {
		return nil, err
	}
	settings, err := store.GetAISettings(ctx, s.Pool, orgID)
	if err != nil {
		return nil, err
	}
	out := gen.AIConfig{Providers: make([]gen.AIProvider, len(providers)), Models: make([]gen.AIModel, len(models)), Settings: settingsResponse(settings)}
	for i, p := range providers {
		out.Providers[i] = providerResponse(p)
	}
	for i, m := range models {
		out.Models[i] = modelResponse(m)
	}
	return gen.GetAIConfig200JSONResponse(out), nil
}

func (s *Server) CreateAIProvider(ctx context.Context, req gen.CreateAIProviderRequestObject) (gen.CreateAIProviderResponseObject, error) {
	p, err := s.providerInput(req.Body)
	if err != nil {
		return nil, err
	}
	created, err := store.CreateAIProvider(ctx, s.Pool, s.scope(ctx), p)
	if errors.Is(err, store.ErrConflict) {
		return nil, &apiError{status: http.StatusConflict, code: "name_taken", message: "a provider has the name already"}
	}
	if err != nil {
		return nil, err
	}
	return gen.CreateAIProvider201JSONResponse(providerResponse(created)), nil
}

func (s *Server) UpdateAIProvider(ctx context.Context, req gen.UpdateAIProviderRequestObject) (gen.UpdateAIProviderResponseObject, error) {
	p, err := s.providerInput(req.Body)
	if err != nil {
		return nil, err
	}
	p.ID = req.Id
	sc := s.scope(ctx)
	err = store.UpdateAIProvider(ctx, s.Pool, sc, p, req.Body.ApiKey == nil)
	if errors.Is(err, store.ErrConflict) {
		return nil, &apiError{status: http.StatusConflict, code: "name_taken", message: "a provider has the name already"}
	}
	if err != nil {
		return nil, err
	}
	updated, err := store.GetAIProvider(ctx, s.Pool, sc.OrgID, req.Id)
	if err != nil {
		return nil, err
	}
	return gen.UpdateAIProvider200JSONResponse(providerResponse(updated)), nil
}

func (s *Server) DeleteAIProvider(ctx context.Context, req gen.DeleteAIProviderRequestObject) (gen.DeleteAIProviderResponseObject, error) {
	if err := store.DeleteAIProvider(ctx, s.Pool, s.scope(ctx), req.Id); err != nil {
		return nil, modelInUse(err)
	}
	return gen.DeleteAIProvider204Response{}, nil
}

func (s *Server) CreateAIModel(ctx context.Context, req gen.CreateAIModelRequestObject) (gen.CreateAIModelResponseObject, error) {
	m, err := modelInput(req.Body)
	if err != nil {
		return nil, err
	}
	m.ProviderID = req.Id
	created, err := store.CreateAIModel(ctx, s.Pool, s.scope(ctx), m)
	if errors.Is(err, store.ErrConflict) {
		return nil, &apiError{status: http.StatusConflict, code: "name_taken", message: "the provider has the model already"}
	}
	if err != nil {
		return nil, err
	}
	return gen.CreateAIModel201JSONResponse(modelResponse(created)), nil
}

func (s *Server) UpdateAIModel(ctx context.Context, req gen.UpdateAIModelRequestObject) (gen.UpdateAIModelResponseObject, error) {
	m, err := modelInput(req.Body)
	if err != nil {
		return nil, err
	}
	m.ID = req.Id
	sc := s.scope(ctx)
	err = store.UpdateAIModel(ctx, s.Pool, sc, m)
	if errors.Is(err, store.ErrConflict) {
		return nil, &apiError{status: http.StatusConflict, code: "name_taken", message: "the provider has the model already"}
	}
	if err != nil {
		return nil, err
	}
	updated, err := store.GetAIModel(ctx, s.Pool, sc.OrgID, req.Id)
	if err != nil {
		return nil, err
	}
	return gen.UpdateAIModel200JSONResponse(modelResponse(updated)), nil
}

func (s *Server) DeleteAIModel(ctx context.Context, req gen.DeleteAIModelRequestObject) (gen.DeleteAIModelResponseObject, error) {
	if err := store.DeleteAIModel(ctx, s.Pool, s.scope(ctx), req.Id); err != nil {
		return nil, modelInUse(err)
	}
	return gen.DeleteAIModel204Response{}, nil
}

// modelInUse names the reason a model or provider cannot be deleted.
func modelInUse(err error) error {
	if errors.Is(err, store.ErrInUse) {
		return &apiError{status: http.StatusConflict, code: "ai_model_in_use", message: "the model is set for the assistant; set another first"}
	}
	return err
}

func (s *Server) TestAIModel(ctx context.Context, req gen.TestAIModelRequestObject) (gen.TestAIModelResponseObject, error) {
	trial, err := s.Assistant.TryModel(ctx, s.scope(ctx), req.Id)
	if err != nil {
		return nil, err
	}
	out := gen.AIModelTrial{Ok: trial.Err == nil, DurationMs: int(trial.Duration.Milliseconds()), Reply: optional(trial.Reply), Error: trialError(trial.Err)}
	if tools := trial.Tools; tools != nil {
		out.Tools = &struct {
			Called bool                   `json:"called"`
			Error  *gen.AIModelTrialError `json:"error,omitempty"`
		}{Called: tools.Called, Error: trialError(tools.Err)}
	}
	return gen.TestAIModel200JSONResponse(out), nil
}

func trialError(e *llm.Error) *gen.AIModelTrialError {
	if e == nil {
		return nil
	}
	out := &gen.AIModelTrialError{Code: string(e.Kind), Message: e.Message}
	if e.Status != 0 {
		out.Status = &e.Status
	}
	return out
}

func (s *Server) SetAISettings(ctx context.Context, req gen.SetAISettingsRequestObject) (gen.SetAISettingsResponseObject, error) {
	sc := s.scope(ctx)
	settings := store.AISettings{ChatModelID: deref(req.Body.ChatModelId), TitleModelID: deref(req.Body.TitleModelId), CompressionModelID: deref(req.Body.CompressionModelId)}
	for _, modelID := range []string{settings.ChatModelID, settings.TitleModelID, settings.CompressionModelID} {
		if modelID == "" {
			continue
		}
		if _, err := store.GetAIModel(ctx, s.Pool, sc.OrgID, modelID); errors.Is(err, store.ErrNotFound) {
			return nil, &apiError{status: http.StatusBadRequest, code: "unknown_model", message: "no such model", params: map[string]string{"id": modelID}}
		} else if err != nil {
			return nil, err
		}
	}
	if err := store.SetAISettings(ctx, s.Pool, sc, settings); err != nil {
		return nil, err
	}
	return gen.SetAISettings200JSONResponse(settingsResponse(settings)), nil
}

// GetAIUsage sums what the calls to models used and cost. It shows nothing
// of the conversations: .agents/design/ai-assistant.md 13.2.
func (s *Server) GetAIUsage(ctx context.Context, req gen.GetAIUsageRequestObject) (gen.GetAIUsageResponseObject, error) {
	p := req.Params
	if !p.GroupBy.Valid() {
		return nil, badRequest("invalid_request", "unknown grouping")
	}
	f := store.AIUsageFilter{From: p.From, To: p.To}
	if p.TimeZone != nil {
		f.TimeZone = *p.TimeZone
		if _, err := time.LoadLocation(f.TimeZone); err != nil || f.TimeZone == "" || f.TimeZone == "Local" {
			return nil, &apiError{status: http.StatusBadRequest, code: "invalid_timezone", message: "unknown time zone " + f.TimeZone, params: map[string]string{"timezone": f.TimeZone}}
		}
	}
	report, err := store.SumAIUsage(ctx, s.Pool, s.scope(ctx).OrgID, store.AIUsageGroupBy(p.GroupBy), f)
	if err != nil {
		return nil, err
	}
	out := gen.AIUsageReport{Total: usageResponse(report.Total), Answers: report.Answers, Groups: make([]gen.AIUsageGroup, len(report.Groups))}
	for i, g := range report.Groups {
		out.Groups[i] = gen.AIUsageGroup{Key: g.Key, DisplayName: optional(g.DisplayName), Email: optional(g.Email), WorkspaceName: optional(g.WorkspaceName),
			Provider: optional(g.Provider), Model: optional(g.Model), Usage: usageResponse(g.AIUsageSum)}
	}
	return gen.GetAIUsage200JSONResponse(out), nil
}

func usageResponse(u store.AIUsageSum) gen.AIUsage {
	out := gen.AIUsage{Calls: u.Calls, Failed: u.Failed, Stopped: u.Stopped, Estimated: u.Estimated, InputTokens: u.InputTokens,
		CachedInputTokens: u.CachedInputTokens, CacheWriteTokens: u.CacheWriteTokens, OutputTokens: u.OutputTokens, Costs: make([]gen.AICost, len(u.Costs))}
	for i, c := range u.Costs {
		out.Costs[i] = gen.AICost{Currency: c.Currency, Amount: c.Amount}
	}
	return out
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func (s *Server) providerInput(in *gen.AIProviderInput) (store.AIProvider, error) {
	if in == nil {
		return store.AIProvider{}, badRequest("invalid_request", "a body is required")
	}
	p := store.AIProvider{Name: strings.TrimSpace(in.Name), Protocol: string(in.Protocol), BaseURL: strings.TrimSpace(in.BaseUrl)}
	if p.Name == "" || utf8.RuneCountInString(p.Name) > 100 {
		return p, badRequest("invalid_name", "a name of at most 100 characters is required")
	}
	if !slices.Contains(llm.Protocols, p.Protocol) {
		return p, badRequest("invalid_protocol", "unknown protocol")
	}
	if u, err := url.Parse(p.BaseURL); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return p, badRequest("invalid_base_url", "the address must be an http or https URL")
	}
	// A key of only spaces is none.
	if in.ApiKey != nil {
		if key := strings.TrimSpace(*in.ApiKey); key != "" {
			p.APIKey = s.Secrets.Seal(key)
		}
	}
	return p, nil
}

var (
	pricePattern    = regexp.MustCompile(`^\d{1,9}(\.\d{1,6})?$`)
	currencyPattern = regexp.MustCompile(`^[A-Z]{3}$`)
)

// maxThinkingLevel is more than any provider's word for a level.
const maxThinkingLevel = 32

func modelInput(in *gen.AIModelInput) (store.AIModel, error) {
	if in == nil {
		return store.AIModel{}, badRequest("invalid_request", "a body is required")
	}
	m := store.AIModel{Model: strings.TrimSpace(in.Model), ContextTokens: in.ContextTokens, MaxOutputTokens: in.MaxOutputTokens,
		Currency: strings.ToUpper(strings.TrimSpace(in.Currency)), InputPrice: in.InputPrice, OutputPrice: in.OutputPrice,
		CachedInputPrice: in.CachedInputPrice, CacheWritePrice: in.CacheWritePrice}
	if in.ThinkingLevel != nil {
		m.ThinkingLevel = strings.TrimSpace(*in.ThinkingLevel)
	}
	switch {
	case m.Model == "":
		return m, badRequest("invalid_model", "the model's name is required")
	case m.ContextTokens <= 0:
		return m, badRequest("invalid_context_tokens", "the context must be a positive number of tokens")
	case m.MaxOutputTokens <= 0 || m.MaxOutputTokens >= m.ContextTokens:
		return m, badRequest("invalid_max_output_tokens", "the output limit must be positive and less than the context")
	case !currencyPattern.MatchString(m.Currency):
		return m, badRequest("invalid_currency", "the currency must be a three-letter ISO 4217 code")
	case utf8.RuneCountInString(m.ThinkingLevel) > maxThinkingLevel:
		return m, badRequest("invalid_thinking_level", "the thinking level is too long")
	}
	for _, price := range []*string{&m.InputPrice, m.CachedInputPrice, m.CacheWritePrice, &m.OutputPrice} {
		if price != nil && !pricePattern.MatchString(*price) {
			return m, badRequest("invalid_price", "a price must be a decimal number with at most six places")
		}
	}
	return m, nil
}

func providerResponse(p store.AIProvider) gen.AIProvider {
	return gen.AIProvider{Id: p.ID, Name: p.Name, Protocol: gen.AIProtocol(p.Protocol), BaseUrl: p.BaseURL, HasApiKey: len(p.APIKey) > 0}
}

func modelResponse(m store.AIModel) gen.AIModel {
	out := gen.AIModel{Id: m.ID, ProviderId: m.ProviderID, Model: m.Model, ContextTokens: m.ContextTokens, MaxOutputTokens: m.MaxOutputTokens,
		Currency: m.Currency, InputPrice: m.InputPrice, CachedInputPrice: m.CachedInputPrice, CacheWritePrice: m.CacheWritePrice, OutputPrice: m.OutputPrice}
	if m.ThinkingLevel != "" {
		out.ThinkingLevel = &m.ThinkingLevel
	}
	return out
}

func settingsResponse(a store.AISettings) gen.AISettings {
	return gen.AISettings{ChatModelId: optional(a.ChatModelID), TitleModelId: optional(a.TitleModelID), CompressionModelId: optional(a.CompressionModelID)}
}

// ---- conversations ----

func (s *Server) GetAssistantStatus(ctx context.Context, _ gen.GetAssistantStatusRequestObject) (gen.GetAssistantStatusResponseObject, error) {
	_, err := store.ModelFor(ctx, s.Pool, s.scope(ctx).OrgID, store.PurposeChat)
	if err != nil && !errors.Is(err, store.ErrAssistantNotConfigured) {
		return nil, err
	}
	return gen.GetAssistantStatus200JSONResponse{Configured: err == nil}, nil
}

func (s *Server) ListConversations(ctx context.Context, _ gen.ListConversationsRequestObject) (gen.ListConversationsResponseObject, error) {
	conversations, err := store.ListConversations(ctx, s.Pool, s.scope(ctx))
	if err != nil {
		return nil, err
	}
	out := make(gen.ListConversations200JSONResponse, len(conversations))
	for i, c := range conversations {
		out[i] = conversationResponse(c)
	}
	return out, nil
}

func (s *Server) CreateConversation(ctx context.Context, _ gen.CreateConversationRequestObject) (gen.CreateConversationResponseObject, error) {
	c, err := store.CreateConversation(ctx, s.Pool, s.scope(ctx))
	if err != nil {
		return nil, err
	}
	return gen.CreateConversation201JSONResponse(conversationResponse(c)), nil
}

func (s *Server) RenameConversation(ctx context.Context, req gen.RenameConversationRequestObject) (gen.RenameConversationResponseObject, error) {
	title := strings.TrimSpace(req.Body.Title)
	if title == "" || utf8.RuneCountInString(title) > 100 {
		return nil, badRequest("invalid_title", "a title of at most 100 characters is required")
	}
	c, err := store.RenameConversation(ctx, s.Pool, s.scope(ctx), req.Id, title)
	if err != nil {
		return nil, err
	}
	return gen.RenameConversation200JSONResponse(conversationResponse(c)), nil
}

func (s *Server) DeleteConversation(ctx context.Context, req gen.DeleteConversationRequestObject) (gen.DeleteConversationResponseObject, error) {
	if err := store.DeleteConversation(ctx, s.Pool, s.scope(ctx), req.Id); err != nil {
		return nil, err
	}
	return gen.DeleteConversation204Response{}, nil
}

func (s *Server) ListConversationMessages(ctx context.Context, req gen.ListConversationMessagesRequestObject) (gen.ListConversationMessagesResponseObject, error) {
	messages, err := store.ListMessages(ctx, s.Pool, s.scope(ctx), req.Id)
	if err != nil {
		return nil, err
	}
	out := make(gen.ListConversationMessages200JSONResponse, len(messages))
	for i, m := range messages {
		out[i] = messageResponse(m)
	}
	return out, nil
}

func (s *Server) SendAssistantMessage(ctx context.Context, req gen.SendAssistantMessageRequestObject) (gen.SendAssistantMessageResponseObject, error) {
	if req.Body == nil || strings.TrimSpace(req.Body.Text) == "" {
		return nil, badRequest("empty_message", "the message is empty")
	}
	sc := s.scope(ctx)
	if _, err := store.GetConversation(ctx, s.Pool, sc, req.Id); err != nil {
		return nil, err
	}
	chat, err := store.ModelFor(ctx, s.Pool, sc.OrgID, store.PurposeChat)
	if err != nil {
		return nil, err
	}
	if err := s.Assistant.CheckMessage(chat, req.Body.Text); err != nil {
		return nil, err
	}
	question, answer, err := store.StartTurn(ctx, s.Pool, sc, req.Id, req.Body.Text, chat.Model)
	if err != nil {
		return nil, err
	}
	return answerStream{ctx: ctx, s: s, scope: sc, answer: answer,
		start: gen.AssistantEvent{Type: gen.AssistantEventTypeStart, Question: new(messageResponse(question)), Answer: new(messageResponse(answer))}}, nil
}

func (s *Server) RetryAssistantMessage(ctx context.Context, req gen.RetryAssistantMessageRequestObject) (gen.RetryAssistantMessageResponseObject, error) {
	sc := s.scope(ctx)
	chat, err := store.ModelFor(ctx, s.Pool, sc.OrgID, store.PurposeChat)
	if err != nil {
		return nil, err
	}
	answer, err := store.StartRetry(ctx, s.Pool, sc, req.Id, chat.Model)
	if err != nil {
		return nil, err
	}
	return answerStream{ctx: ctx, s: s, scope: sc, answer: answer,
		start: gen.AssistantEvent{Type: gen.AssistantEventTypeStart, Answer: new(messageResponse(answer))}}, nil
}

// answerPing is how often a connection waiting for an answer is shown to be
// alive, so that proxies do not close it while the model thinks.
const answerPing = 15 * time.Second

// answerStream writes an answer as server-sent events while the assistant
// writes it. It runs once the response is being written; ctx is the
// request's, which ends when the person stops the answer or leaves.
type answerStream struct {
	ctx    context.Context
	s      *Server
	scope  store.Scope
	start  gen.AssistantEvent
	answer store.Message
}

func (a answerStream) VisitSendAssistantMessageResponse(w http.ResponseWriter) error {
	return a.visit(w)
}

func (a answerStream) VisitRetryAssistantMessageResponse(w http.ResponseWriter) error {
	return a.visit(w)
}

func (a answerStream) visit(w http.ResponseWriter) error {
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	// nginx would otherwise hold the answer back until it is complete.
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	var mu sync.Mutex
	write := func(chunk string) {
		mu.Lock()
		defer mu.Unlock()
		// A person who left is noticed through ctx, not here.
		_, _ = io.WriteString(w, chunk)
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
	}
	send := func(e gen.AssistantEvent) {
		raw, err := json.Marshal(e)
		if err != nil {
			a.s.Logger.ErrorContext(a.ctx, "assistant event", "error", err)
			return
		}
		write("data: " + string(raw) + "\n\n")
	}
	send(a.start)

	var wg sync.WaitGroup
	stop := make(chan struct{})
	wg.Go(func() {
		ticker := time.NewTicker(answerPing)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				write(": ping\n\n")
			}
		}
	})
	a.s.Assistant.Answer(a.ctx, a.scope, a.answer, a.s.assistantToolsFor(a.ctx), func(ev assistant.Event) { send(eventResponse(ev)) })
	close(stop)
	wg.Wait()
	return nil
}

func eventResponse(ev assistant.Event) gen.AssistantEvent {
	out := gen.AssistantEvent{Type: gen.AssistantEventType(ev.Type)}
	switch ev.Type {
	case assistant.EventStatus:
		out.Status = new(gen.AssistantEventStatus(ev.Status))
	case assistant.EventDelta:
		out.Text = new(ev.Text)
	case assistant.EventTool:
		out.Part = new(partResponse(*ev.Part, !ev.Running))
	case assistant.EventDone:
		out.Answer = new(messageResponse(*ev.Message))
	case assistant.EventTitle:
		out.Title = new(ev.Title)
	}
	return out
}

func conversationResponse(c store.Conversation) gen.Conversation {
	return gen.Conversation{Id: c.ID, Title: c.Title, CreatedAt: c.CreatedAt, UpdatedAt: c.UpdatedAt}
}

func messageResponse(m store.Message) gen.AssistantMessage {
	out := gen.AssistantMessage{Id: m.ID, Seq: m.Seq, Role: gen.AssistantMessageRole(m.Role), Status: gen.AssistantMessageStatus(m.Status),
		Error: optional(m.Error), CreatedAt: m.CreatedAt, Parts: make([]gen.AssistantMessagePart, len(m.Parts))}
	// What is kept of a tool is what it returned.
	for i, p := range m.Parts {
		out.Parts[i] = partResponse(p, true)
	}
	return out
}

// partResponse is a part of a message as people see it: of a tool, what it
// looked at and where its figures came from, not what the model read.
func partResponse(p store.MessagePart, done bool) gen.AssistantMessagePart {
	out := gen.AssistantMessagePart{Type: gen.AssistantMessagePartType(p.Type), Text: optional(p.Text)}
	if p.Type != store.PartTool {
		return out
	}
	out.CallId, out.Tool, out.Subject = optional(p.CallID), optional(p.Tool), optional(p.Subject)
	out.Done = new(done)
	if p.Failed {
		out.Failed = new(true)
	}
	if src := p.Source; src != nil {
		source := gen.AnswerSource{N: src.N, DashboardId: src.DashboardID, DashboardName: src.DashboardName, ItemId: src.ItemID, ChartName: src.ChartName,
			DashboardRevision: src.DashboardRevision, ChartRevision: src.ChartRevision, DatasetRevision: src.DatasetRevision,
			Rows: src.Rows, Truncated: src.Truncated, DataAt: src.DataAt, Conditions: make([]gen.SourceCondition, len(src.Conditions))}
		for i, c := range src.Conditions {
			source.Conditions[i] = gen.SourceCondition{Kind: gen.SourceConditionKind(c.Kind), Label: c.Label, Value: c.Value, Text: optional(c.Text), Default: optionalTrue(c.Default)}
		}
		if len(src.State) > 0 {
			var state gen.DashboardViewState
			if json.Unmarshal(src.State, &state) == nil {
				source.State = state
			}
		}
		out.Source = &source
	}
	if calc := p.Calculation; calc != nil {
		out.Calculation = &gen.Calculation{N: calc.N, Expression: calc.Expression, Result: calc.Result, Inputs: make([]gen.CalculationInput, len(calc.Inputs))}
		for i, in := range calc.Inputs {
			out.Calculation.Inputs[i] = gen.CalculationInput{Name: in.Name, Label: in.Label, Value: in.Value, Source: in.Source}
		}
	}
	if c := p.Chart; c != nil {
		out.Chart = chartResponse(c)
	}
	return out
}

// chartResponse is a chart an answer drew. What it drew was written by the
// assistant as the API writes it, so it is read back the same way.
func chartResponse(c *store.AnswerChart) *gen.AnswerChart {
	out := &gen.AnswerChart{Title: c.Title, Sources: c.Sources, Calculations: make([]gen.ChartCalculation, len(c.Calculations))}
	if c.N > 0 {
		out.N = &c.N
	}
	if out.Sources == nil {
		out.Sources = []int{}
	}
	_ = json.Unmarshal(c.Viz, &out.Viz)
	_ = json.Unmarshal(c.Columns, &out.Columns)
	dec := json.NewDecoder(bytes.NewReader(c.Rows))
	// Figures stay as they were written: a large integer is not rounded.
	dec.UseNumber()
	_ = dec.Decode(&out.Rows)
	if out.Columns == nil {
		out.Columns = []gen.ResultColumn{}
	}
	if out.Rows == nil {
		out.Rows = [][]any{}
	}
	for i, calc := range c.Calculations {
		inputs := make([]gen.ChartCalculationInput, len(calc.Inputs))
		for j, in := range calc.Inputs {
			inputs[j] = gen.ChartCalculationInput{Name: in.Name, Label: in.Label}
			if in.Source > 0 {
				inputs[j].Source = &in.Source
			}
		}
		out.Calculations[i] = gen.ChartCalculation{Series: calc.Series, Name: calc.Name, Expression: calc.Expression, Inputs: inputs}
	}
	return out
}

func optionalTrue(b bool) *bool {
	if !b {
		return nil
	}
	return &b
}
