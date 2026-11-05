package store

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/supazd/supabi/internal/id"
)

// The AI assistant: models set up by system administrators, conversations,
// and what calls to models cost. See .agents/design/ai-assistant.md.

var (
	// ErrAssistantNotConfigured means no model is set to answer people.
	ErrAssistantNotConfigured = errors.New("no model is set for the assistant")
	// ErrAssistantBusy means the conversation already has an answer being written.
	ErrAssistantBusy = errors.New("an answer is being written")
)

// ---- providers and models ----

// AIProvider is a service that runs models.
type AIProvider struct {
	ID       string
	Name     string
	Protocol string
	BaseURL  string
	// APIKey is sealed with the secret key; nil when the provider needs none.
	APIKey    []byte
	UpdatedAt time.Time
}

// AIModel is a model of a provider, with its limits and prices. Prices are
// decimal strings, per million tokens, so that they are never rounded on the way.
type AIModel struct {
	ID              string
	ProviderID      string
	Model           string
	ContextTokens   int
	MaxOutputTokens int
	Currency        string
	InputPrice      string
	// CachedInputPrice and CacheWritePrice are nil when the provider charges
	// those tokens as other input.
	CachedInputPrice *string
	CacheWritePrice  *string
	OutputPrice      string
	// ThinkingLevel is what is said of how hard the model thinks when it
	// answers; empty says nothing.
	ThinkingLevel string
	UpdatedAt     time.Time
}

func ListAIProviders(ctx context.Context, pool *pgxpool.Pool, orgID string) ([]AIProvider, error) {
	rows, err := pool.Query(ctx, `SELECT id, name, protocol, base_url, api_key, updated_at FROM ai_providers WHERE org_id = $1 ORDER BY name`, orgID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (AIProvider, error) {
		var p AIProvider
		err := row.Scan(&p.ID, &p.Name, &p.Protocol, &p.BaseURL, &p.APIKey, &p.UpdatedAt)
		return p, err
	})
}

func GetAIProvider(ctx context.Context, pool *pgxpool.Pool, orgID, providerID string) (AIProvider, error) {
	p := AIProvider{ID: providerID}
	err := pool.QueryRow(ctx, `SELECT name, protocol, base_url, api_key, updated_at FROM ai_providers WHERE org_id = $1 AND id = $2`, orgID, providerID).
		Scan(&p.Name, &p.Protocol, &p.BaseURL, &p.APIKey, &p.UpdatedAt)
	return p, translate(err)
}

func CreateAIProvider(ctx context.Context, pool *pgxpool.Pool, s Scope, p AIProvider) (AIProvider, error) {
	p.ID = id.New("aip")
	err := pool.QueryRow(ctx, `INSERT INTO ai_providers (id, org_id, name, protocol, base_url, api_key, created_by, updated_by)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING updated_at`,
		p.ID, s.OrgID, p.Name, p.Protocol, p.BaseURL, p.APIKey, s.actor()).Scan(&p.UpdatedAt)
	return p, translate(err)
}

// UpdateAIProvider changes a provider; its API key only when keepKey is false.
func UpdateAIProvider(ctx context.Context, pool *pgxpool.Pool, s Scope, p AIProvider, keepKey bool) error {
	tag, err := pool.Exec(ctx, `UPDATE ai_providers SET name = $3, protocol = $4, base_url = $5,
 api_key = CASE WHEN $6 THEN api_key ELSE $7 END, updated_by = $8, updated_at = now()
 WHERE org_id = $1 AND id = $2`,
		s.OrgID, p.ID, p.Name, p.Protocol, p.BaseURL, keepKey, p.APIKey, s.actor())
	if err != nil {
		return translate(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteAIProvider deletes a provider with its models. It is ErrInUse while
// one of them is set for something.
func DeleteAIProvider(ctx context.Context, pool *pgxpool.Pool, s Scope, providerID string) error {
	tag, err := pool.Exec(ctx, `DELETE FROM ai_providers WHERE org_id = $1 AND id = $2`, s.OrgID, providerID)
	if err != nil {
		return translate(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

const aiModelColumns = `id, provider_id, model, context_tokens, max_output_tokens, currency,
 input_price::text, cached_input_price::text, cache_write_price::text, output_price::text, COALESCE(thinking_level, ''), updated_at`

func scanAIModel(row pgx.Row) (AIModel, error) {
	var m AIModel
	err := row.Scan(&m.ID, &m.ProviderID, &m.Model, &m.ContextTokens, &m.MaxOutputTokens, &m.Currency,
		&m.InputPrice, &m.CachedInputPrice, &m.CacheWritePrice, &m.OutputPrice, &m.ThinkingLevel, &m.UpdatedAt)
	return m, err
}

func ListAIModels(ctx context.Context, pool *pgxpool.Pool, orgID string) ([]AIModel, error) {
	rows, err := pool.Query(ctx, `SELECT `+aiModelColumns+` FROM ai_models WHERE org_id = $1 ORDER BY model`, orgID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (AIModel, error) { return scanAIModel(row) })
}

func GetAIModel(ctx context.Context, pool *pgxpool.Pool, orgID, modelID string) (AIModel, error) {
	m, err := scanAIModel(pool.QueryRow(ctx, `SELECT `+aiModelColumns+` FROM ai_models WHERE org_id = $1 AND id = $2`, orgID, modelID))
	return m, translate(err)
}

// CreateAIModel adds a model to a provider; ErrNotFound when there is no such provider.
func CreateAIModel(ctx context.Context, pool *pgxpool.Pool, s Scope, m AIModel) (AIModel, error) {
	if _, err := GetAIProvider(ctx, pool, s.OrgID, m.ProviderID); err != nil {
		return AIModel{}, err
	}
	m.ID = id.New("aim")
	err := pool.QueryRow(ctx, `INSERT INTO ai_models (id, org_id, provider_id, model, context_tokens, max_output_tokens, currency,
 input_price, cached_input_price, cache_write_price, output_price, thinking_level, created_by, updated_by)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text::numeric, $9::text::numeric, $10::text::numeric, $11::text::numeric, NULLIF($12, ''), $13, $13) RETURNING updated_at`,
		m.ID, s.OrgID, m.ProviderID, m.Model, m.ContextTokens, m.MaxOutputTokens, m.Currency,
		m.InputPrice, m.CachedInputPrice, m.CacheWritePrice, m.OutputPrice, m.ThinkingLevel, s.actor()).Scan(&m.UpdatedAt)
	return m, translate(err)
}

// UpdateAIModel changes a model's name, limits, prices and thinking level;
// not its provider.
func UpdateAIModel(ctx context.Context, pool *pgxpool.Pool, s Scope, m AIModel) error {
	tag, err := pool.Exec(ctx, `UPDATE ai_models SET model = $3, context_tokens = $4, max_output_tokens = $5, currency = $6,
 input_price = $7::text::numeric, cached_input_price = $8::text::numeric, cache_write_price = $9::text::numeric, output_price = $10::text::numeric,
 thinking_level = NULLIF($11, ''), updated_by = $12, updated_at = now()
 WHERE org_id = $1 AND id = $2`,
		s.OrgID, m.ID, m.Model, m.ContextTokens, m.MaxOutputTokens, m.Currency,
		m.InputPrice, m.CachedInputPrice, m.CacheWritePrice, m.OutputPrice, m.ThinkingLevel, s.actor())
	if err != nil {
		return translate(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteAIModel is ErrInUse while the model is set for something.
func DeleteAIModel(ctx context.Context, pool *pgxpool.Pool, s Scope, modelID string) error {
	tag, err := pool.Exec(ctx, `DELETE FROM ai_models WHERE org_id = $1 AND id = $2`, s.OrgID, modelID)
	if err != nil {
		return translate(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ---- what each model is used for ----

// AIPurpose is what the assistant calls a model for.
type AIPurpose string

const (
	PurposeChat        AIPurpose = "chat"
	PurposeTitle       AIPurpose = "title"
	PurposeCompression AIPurpose = "compression"
	// PurposeTest is an administrator trying a model out; it is set for nothing.
	PurposeTest AIPurpose = "test"
)

// AISettings names the model set for each purpose; empty is unset.
type AISettings struct {
	ChatModelID        string
	TitleModelID       string
	CompressionModelID string
}

func GetAISettings(ctx context.Context, pool *pgxpool.Pool, orgID string) (AISettings, error) {
	var a AISettings
	err := pool.QueryRow(ctx, `SELECT COALESCE(chat_model_id, ''), COALESCE(title_model_id, ''), COALESCE(compression_model_id, '')
 FROM ai_settings WHERE org_id = $1`, orgID).Scan(&a.ChatModelID, &a.TitleModelID, &a.CompressionModelID)
	if errors.Is(err, pgx.ErrNoRows) {
		return AISettings{}, nil
	}
	return a, err
}

// SetAISettings is ErrInUse when a model named does not exist.
func SetAISettings(ctx context.Context, pool *pgxpool.Pool, s Scope, a AISettings) error {
	_, err := pool.Exec(ctx, `INSERT INTO ai_settings (org_id, chat_model_id, title_model_id, compression_model_id, updated_by)
 VALUES ($1, NULLIF($2, ''), NULLIF($3, ''), NULLIF($4, ''), $5)
 ON CONFLICT (org_id) DO UPDATE SET chat_model_id = EXCLUDED.chat_model_id, title_model_id = EXCLUDED.title_model_id,
 compression_model_id = EXCLUDED.compression_model_id, updated_by = EXCLUDED.updated_by, updated_at = now()`,
		s.OrgID, a.ChatModelID, a.TitleModelID, a.CompressionModelID, s.actor())
	return translate(err)
}

// AIModelCall is a model with the provider that runs it: what a call needs.
type AIModelCall struct {
	AIModel
	Provider AIProvider
}

// ModelFor returns the model set for a purpose, read anew on every call so
// that a change applies at once on every instance. Titles and summaries fall
// back to the chat model; ErrAssistantNotConfigured when there is none.
func ModelFor(ctx context.Context, pool *pgxpool.Pool, orgID string, purpose AIPurpose) (AIModelCall, error) {
	settings, err := GetAISettings(ctx, pool, orgID)
	if err != nil {
		return AIModelCall{}, err
	}
	modelID := settings.ChatModelID
	switch purpose {
	case PurposeTitle:
		modelID = cmp.Or(settings.TitleModelID, modelID)
	case PurposeCompression:
		modelID = cmp.Or(settings.CompressionModelID, modelID)
	}
	if modelID == "" {
		return AIModelCall{}, ErrAssistantNotConfigured
	}
	return ModelCall(ctx, pool, orgID, modelID)
}

// ModelCall returns a model with its provider.
func ModelCall(ctx context.Context, pool *pgxpool.Pool, orgID, modelID string) (AIModelCall, error) {
	m, err := GetAIModel(ctx, pool, orgID, modelID)
	if err != nil {
		return AIModelCall{}, err
	}
	p, err := GetAIProvider(ctx, pool, orgID, m.ProviderID)
	return AIModelCall{AIModel: m, Provider: p}, err
}

// ---- conversations ----

// Conversation is a person's conversation with the assistant in a workspace.
type Conversation struct {
	ID             string
	WorkspaceID    string
	UserID         string
	Title          string
	TitleByUser    bool
	Summary        string
	SummaryThrough int
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

// Message statuses.
const (
	MessageGenerating = "generating"
	MessageDone       = "done"
	MessageStopped    = "stopped"
	MessageFailed     = "failed"
)

// Message part types.
const (
	PartText = "text"
	// PartTool is a tool the assistant called, with what it returned.
	PartTool = "tool"
)

// MessagePart is a piece of a message's content: text, or a tool the
// assistant called while it answered, in the order they came.
type MessagePart struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`

	// CallID names the call to the model; Tool and Arguments are what it called.
	CallID    string `json:"callId,omitempty"`
	Tool      string `json:"tool,omitempty"`
	Arguments string `json:"arguments,omitempty"`
	// Round numbers the calls to the model within an answer, from 1: the
	// tools of one round were called at once, and are given back so.
	Round int `json:"round,omitempty"`
	// Reasoning is what the model reasoned before the calls it made at
	// once, kept on the first of them: some providers want it back while
	// the answer goes on.
	Reasoning string `json:"reasoning,omitempty"`
	// Content is what the tool returned for the model to read; Failed when
	// it says what went wrong.
	Content string `json:"content,omitempty"`
	Failed  bool   `json:"failed,omitempty"`
	// Subject is what the tool looked at, for people.
	Subject string `json:"subject,omitempty"`
	// Source is where the figures the tool returned came from.
	Source *AnswerSource `json:"source,omitempty"`
	// Calculation is what the calculator worked out, and from what.
	Calculation *Calculation `json:"calculation,omitempty"`
	// Chart is a chart the assistant drew, with what it drew.
	Chart *AnswerChart `json:"chart,omitempty"`
}

// AnswerChart is a chart the assistant drew from what its answer looked up,
// kept as it was drawn: the rows are never queried again. See
// .agents/design/ai-assistant.md 12.10.
type AnswerChart struct {
	// N numbers it among the sources of its answer when it worked series
	// out, which the answer cites; 0 when it did not.
	N     int    `json:"n,omitempty"`
	Title string `json:"title"`
	// Viz, Columns and Rows are what is drawn, as a chart's viz and a query
	// result's columns and rows have them.
	Viz     json.RawMessage `json:"viz"`
	Columns json.RawMessage `json:"columns"`
	Rows    json.RawMessage `json:"rows"`
	// Sources are the numbers of the lookups it drew from.
	Sources []int `json:"sources"`
	// Calculations are the series it worked out, and how.
	Calculations []ChartCalculation `json:"calculations,omitempty"`
}

// ChartCalculation is a series of a chart worked out row by row from series
// before it.
type ChartCalculation struct {
	// Series is the series' id, which names its column; Name is its name in the legend.
	Series string `json:"series"`
	Name   string `json:"name"`
	// Expression names its inputs by their ids.
	Expression string       `json:"expression"`
	Inputs     []ChartInput `json:"inputs"`
}

// ChartInput is a series a calculation used: by its id in the expression,
// its name, and the lookup it came from, 0 for one itself worked out.
type ChartInput struct {
	Name   string `json:"name"`
	Label  string `json:"label"`
	Source int    `json:"source,omitempty"`
}

// Calculation is a figure the assistant worked out from figures it looked
// up, which its answer cites as it cites a source. See
// .agents/design/ai-assistant.md 12.9.
type Calculation struct {
	// N numbers it among the sources of its answer.
	N          int                `json:"n"`
	Expression string             `json:"expression"`
	Inputs     []CalculationInput `json:"inputs"`
	Result     string             `json:"result"`
}

// CalculationInput is a figure a calculation used, by its name in the
// expression, as the source numbered Source has it.
type CalculationInput struct {
	Name   string `json:"name"`
	Label  string `json:"label"`
	Value  string `json:"value"`
	Source int    `json:"source"`
}

// AnswerSource is where figures in an answer came from: a chart on a dashboard, read under
// the conditions given. See .agents/design/ai-assistant.md 12.3.
type AnswerSource struct {
	// N numbers the source within its answer, which cites it as [N].
	N             int    `json:"n"`
	DashboardID   string `json:"dashboardId"`
	DashboardName string `json:"dashboardName"`
	ItemID        string `json:"itemId"`
	ChartID       string `json:"chartId"`
	// ChartName is the widget's title, or else the chart's name.
	ChartName         string `json:"chartName"`
	DatasetID         string `json:"datasetId"`
	DashboardRevision int    `json:"dashboardRevision"`
	ChartRevision     int    `json:"chartRevision"`
	DatasetRevision   int    `json:"datasetRevision"`
	// Conditions are those in effect, defaults included.
	Conditions []SourceCondition `json:"conditions"`
	// State is the conditions as a share link carries them, and ViewID the
	// link that keeps them.
	State     json.RawMessage `json:"state"`
	ViewID    string          `json:"viewId,omitempty"`
	ExpiresAt *time.Time      `json:"expiresAt,omitempty"`
	// DataAt is when the database returned the data.
	DataAt    *time.Time `json:"dataAt,omitempty"`
	Rows      int        `json:"rows"`
	Truncated bool       `json:"truncated"`
}

// SourceCondition is a condition a chart was read under.
type SourceCondition struct {
	// Kind is filter, chartFilter, selection, drill or link.
	Kind  string `json:"kind"`
	Label string `json:"label"`
	Value any    `json:"value"`
	// Text writes the value where it alone does not say enough: the dates
	// a time range stood for, or the option of a dynamic slot.
	Text string `json:"text,omitempty"`
	// Default says the value is the dashboard's own, not chosen.
	Default bool `json:"default,omitempty"`
}

// Message is a message of a conversation, the person's or the assistant's.
type Message struct {
	ID             string
	ConversationID string
	Seq            int
	Role           string
	Parts          []MessagePart
	Status         string
	Error          string
	Model          string
	// ContextTokens is what the model read and wrote for an answer, as the
	// provider reported it; nil when it did not.
	ContextTokens *int
	CreatedAt     time.Time
}

// Text is the message's text parts together.
func (m Message) Text() string {
	var text string
	for _, p := range m.Parts {
		if p.Type == PartText {
			text += p.Text
		}
	}
	return text
}

// UsedTools says whether the message has a tool in it.
func (m Message) UsedTools() bool {
	for _, p := range m.Parts {
		if p.Type == PartTool {
			return true
		}
	}
	return false
}

// TextParts is the content of a message that is only text.
func TextParts(text string) []MessagePart {
	if text == "" {
		return []MessagePart{}
	}
	return []MessagePart{{Type: PartText, Text: text}}
}

// staleAfter is how long an answer being written may go untouched before
// its writer is taken to have died. Writers touch it more often than this.
const staleAfter = time.Minute

// MessageHeartbeat is how often a writer touches the answer it is writing.
const MessageHeartbeat = 15 * time.Second

const conversationColumns = `id, workspace_id, user_id, title, title_by_user, summary, summary_through, created_at, updated_at`

func scanConversation(row pgx.Row) (Conversation, error) {
	var c Conversation
	err := row.Scan(&c.ID, &c.WorkspaceID, &c.UserID, &c.Title, &c.TitleByUser, &c.Summary, &c.SummaryThrough, &c.CreatedAt, &c.UpdatedAt)
	return c, err
}

// ListConversations returns the caller's conversations in the workspace,
// the latest first.
func ListConversations(ctx context.Context, pool *pgxpool.Pool, s Scope) ([]Conversation, error) {
	rows, err := pool.Query(ctx, `SELECT `+conversationColumns+` FROM ai_conversations
 WHERE org_id = $1 AND workspace_id = $2 AND user_id = $3 ORDER BY updated_at DESC, id`, s.OrgID, s.WorkspaceID, s.UserID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (Conversation, error) { return scanConversation(row) })
}

// GetConversation returns one of the caller's conversations in the
// workspace; anyone else's is ErrNotFound.
func GetConversation(ctx context.Context, pool *pgxpool.Pool, s Scope, conversationID string) (Conversation, error) {
	c, err := scanConversation(pool.QueryRow(ctx, `SELECT `+conversationColumns+` FROM ai_conversations
 WHERE org_id = $1 AND workspace_id = $2 AND user_id = $3 AND id = $4`, s.OrgID, s.WorkspaceID, s.UserID, conversationID))
	return c, translate(err)
}

func CreateConversation(ctx context.Context, pool *pgxpool.Pool, s Scope) (Conversation, error) {
	c, err := scanConversation(pool.QueryRow(ctx, `INSERT INTO ai_conversations (id, org_id, workspace_id, user_id)
 VALUES ($1, $2, $3, $4) RETURNING `+conversationColumns, id.New("conv"), s.OrgID, s.WorkspaceID, s.UserID))
	return c, translate(err)
}

// RenameConversation gives a conversation the caller's title, which is kept from then on.
func RenameConversation(ctx context.Context, pool *pgxpool.Pool, s Scope, conversationID, title string) (Conversation, error) {
	c, err := scanConversation(pool.QueryRow(ctx, `UPDATE ai_conversations SET title = $5, title_by_user = true
 WHERE org_id = $1 AND workspace_id = $2 AND user_id = $3 AND id = $4 RETURNING `+conversationColumns,
		s.OrgID, s.WorkspaceID, s.UserID, conversationID, title))
	return c, translate(err)
}

// DeleteConversation deletes a conversation with its messages. What its
// calls to models cost stays on record.
func DeleteConversation(ctx context.Context, pool *pgxpool.Pool, s Scope, conversationID string) error {
	tag, err := pool.Exec(ctx, `DELETE FROM ai_conversations WHERE org_id = $1 AND workspace_id = $2 AND user_id = $3 AND id = $4`,
		s.OrgID, s.WorkspaceID, s.UserID, conversationID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// SetAutoTitle names a conversation unless its owner has named it.
func SetAutoTitle(ctx context.Context, pool *pgxpool.Pool, conversationID, title string) (bool, error) {
	tag, err := pool.Exec(ctx, `UPDATE ai_conversations SET title = $2 WHERE id = $1 AND NOT title_by_user`, conversationID, title)
	return tag.RowsAffected() > 0, err
}

// SetConversationSummary keeps the summary of the messages up to and including through.
func SetConversationSummary(ctx context.Context, pool *pgxpool.Pool, conversationID, summary string, through int) error {
	_, err := pool.Exec(ctx, `UPDATE ai_conversations SET summary = $2, summary_through = $3 WHERE id = $1`, conversationID, summary, through)
	return err
}

const messageColumns = `id, conversation_id, seq, role, parts, status, error, model, context_tokens, created_at`

func scanMessage(row pgx.Row) (Message, error) {
	var (
		m     Message
		parts []byte
	)
	if err := row.Scan(&m.ID, &m.ConversationID, &m.Seq, &m.Role, &parts, &m.Status, &m.Error, &m.Model, &m.ContextTokens, &m.CreatedAt); err != nil {
		return m, err
	}
	return m, json.Unmarshal(parts, &m.Parts)
}

type execer interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// abandonStale fails the answers in a conversation whose writer has
// stopped touching them: the process writing them has died.
func abandonStale(ctx context.Context, db execer, conversationID string) error {
	_, err := db.Exec(ctx, `UPDATE ai_messages SET status = 'failed', error = 'interrupted'
 WHERE conversation_id = $1 AND status = 'generating' AND updated_at < now() - make_interval(secs => $2)`, conversationID, staleAfter.Seconds())
	return err
}

// ListMessages returns the messages of one of the caller's conversations, in order.
func ListMessages(ctx context.Context, pool *pgxpool.Pool, s Scope, conversationID string) ([]Message, error) {
	if _, err := GetConversation(ctx, pool, s, conversationID); err != nil {
		return nil, err
	}
	if err := abandonStale(ctx, pool, conversationID); err != nil {
		return nil, err
	}
	rows, err := pool.Query(ctx, `SELECT `+messageColumns+` FROM ai_messages WHERE conversation_id = $1 ORDER BY seq`, conversationID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (Message, error) { return scanMessage(row) })
}

// StartTurn adds the caller's message to a conversation, and an answer to
// it for the assistant to write with the model named. ErrAssistantBusy when
// another answer is being written there. A conversation without a title
// takes the start of its first message, until a better one is written.
func StartTurn(ctx context.Context, pool *pgxpool.Pool, s Scope, conversationID, text, model string) (question, answer Message, err error) {
	err = pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		var title string
		if err := tx.QueryRow(ctx, `SELECT title FROM ai_conversations WHERE org_id = $1 AND workspace_id = $2 AND user_id = $3 AND id = $4 FOR UPDATE`,
			s.OrgID, s.WorkspaceID, s.UserID, conversationID).Scan(&title); err != nil {
			return translate(err)
		}
		if err := abandonStale(ctx, tx, conversationID); err != nil {
			return err
		}
		var next int
		if err := tx.QueryRow(ctx, `SELECT COALESCE(max(seq), 0) + 1 FROM ai_messages WHERE conversation_id = $1`, conversationID).Scan(&next); err != nil {
			return err
		}
		if question, err = insertMessage(ctx, tx, conversationID, next, "user", TextParts(text), MessageDone, ""); err != nil {
			return err
		}
		if answer, err = insertMessage(ctx, tx, conversationID, next+1, "assistant", TextParts(""), MessageGenerating, model); err != nil {
			return err
		}
		if title == "" {
			title = TitleFromText(text)
		}
		_, err := tx.Exec(ctx, `UPDATE ai_conversations SET title = $2, updated_at = now() WHERE id = $1`, conversationID, title)
		return err
	})
	if errors.Is(err, ErrConflict) {
		err = ErrAssistantBusy
	}
	return question, answer, err
}

// StartRetry writes a failed answer again, with the model named. Only the
// last message of a conversation can be: later ones were written without it.
func StartRetry(ctx context.Context, pool *pgxpool.Pool, s Scope, messageID, model string) (Message, error) {
	var answer Message
	err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		var conversationID string
		err := tx.QueryRow(ctx, `SELECT c.id FROM ai_messages m JOIN ai_conversations c ON c.id = m.conversation_id
 WHERE c.org_id = $1 AND c.workspace_id = $2 AND c.user_id = $3 AND m.id = $4 FOR UPDATE OF c`,
			s.OrgID, s.WorkspaceID, s.UserID, messageID).Scan(&conversationID)
		if err != nil {
			return translate(err)
		}
		if err := abandonStale(ctx, tx, conversationID); err != nil {
			return err
		}
		answer, err = scanMessage(tx.QueryRow(ctx, `UPDATE ai_messages m SET status = 'generating', error = '', parts = '[]', model = $2, context_tokens = NULL, updated_at = now()
 WHERE m.id = $1 AND m.role = 'assistant' AND m.status = 'failed'
 AND m.seq = (SELECT max(seq) FROM ai_messages WHERE conversation_id = m.conversation_id)
 RETURNING `+messageColumns, messageID, model))
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotRetryable
		}
		if err != nil {
			return translate(err)
		}
		_, err = tx.Exec(ctx, `UPDATE ai_conversations SET updated_at = now() WHERE id = $1`, conversationID)
		return err
	})
	if errors.Is(err, ErrConflict) {
		err = ErrAssistantBusy
	}
	return answer, err
}

// ErrNotRetryable means the message is not a failed answer at the end of its conversation.
var ErrNotRetryable = errors.New("only the last answer can be written again, after it failed")

func insertMessage(ctx context.Context, tx pgx.Tx, conversationID string, seq int, role string, parts []MessagePart, status, model string) (Message, error) {
	raw, err := json.Marshal(parts)
	if err != nil {
		return Message{}, err
	}
	m, err := scanMessage(tx.QueryRow(ctx, `INSERT INTO ai_messages (id, conversation_id, seq, role, parts, status, model)
 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING `+messageColumns, id.New("msg"), conversationID, seq, role, raw, status, model))
	return m, translate(err)
}

// TouchAnswer keeps what has been written of an answer so far, and shows
// that its writer is alive.
func TouchAnswer(ctx context.Context, pool *pgxpool.Pool, messageID string, parts []MessagePart) error {
	raw, err := json.Marshal(nonNil(parts))
	if err != nil {
		return err
	}
	_, err = pool.Exec(ctx, `UPDATE ai_messages SET parts = $2, updated_at = now() WHERE id = $1 AND status = 'generating'`, messageID, raw)
	return err
}

func nonNil(parts []MessagePart) []MessagePart {
	if parts == nil {
		return []MessagePart{}
	}
	return parts
}

// FinishAnswer keeps an answer as it ended. One that was already taken for
// abandoned stays failed: its conversation may have moved on.
func FinishAnswer(ctx context.Context, pool *pgxpool.Pool, messageID string, parts []MessagePart, status, errCode string, contextTokens *int) (Message, error) {
	raw, err := json.Marshal(nonNil(parts))
	if err != nil {
		return Message{}, err
	}
	m, err := scanMessage(pool.QueryRow(ctx, `UPDATE ai_messages SET parts = $2, status = $3, error = $4, context_tokens = $5, updated_at = now()
 WHERE id = $1 AND status = 'generating' RETURNING `+messageColumns, messageID, raw, status, errCode, contextTokens))
	if errors.Is(err, pgx.ErrNoRows) {
		return scanMessage(pool.QueryRow(ctx, `SELECT `+messageColumns+` FROM ai_messages WHERE id = $1`, messageID))
	}
	return m, err
}

// TitleFromText is a title made of the start of a message: its first line, shortened.
func TitleFromText(text string) string {
	runes := []rune(text)
	for i, r := range runes {
		if r == '\n' {
			runes = runes[:i]
			break
		}
	}
	const most = 40
	if len(runes) > most {
		return string(runes[:most]) + "…"
	}
	return string(runes)
}

// ---- usage ----

// AIUsage is one call to a model, and what it used.
type AIUsage struct {
	WorkspaceID    string
	UserID         string
	ConversationID string
	MessageID      string
	Purpose        AIPurpose
	Model          AIModelCall
	// Tokens of four kinds that do not overlap.
	InputTokens       int64
	CachedInputTokens int64
	CacheWriteTokens  int64
	OutputTokens      int64
	Estimated         bool
	Duration          time.Duration
	Outcome           string
}

// Usage outcomes.
const (
	UsageSuccess = "success"
	UsageFailure = "failure"
	UsageStopped = "stopped"
)

// RecordAIUsage keeps a call, with its cost at the model's prices now. The
// cost is worked out by the database, in decimals.
func RecordAIUsage(ctx context.Context, pool *pgxpool.Pool, orgID string, u AIUsage) error {
	m := u.Model
	_, err := pool.Exec(ctx, `INSERT INTO ai_usage (id, org_id, workspace_id, user_id, conversation_id, message_id, purpose, provider, model_id, model,
 input_tokens, cached_input_tokens, cache_write_tokens, output_tokens, estimated, cost, currency, duration_ms, outcome)
 VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''), $7, $8, $9, $10, $11, $12, $13, $14, $15,
 ($11::bigint * $16::text::numeric + $12::bigint * COALESCE($17::text::numeric, $16::text::numeric)
  + $13::bigint * COALESCE($18::text::numeric, $16::text::numeric) + $14::bigint * $19::text::numeric) / 1000000,
 $20, $21, $22)`,
		id.New("aiu"), orgID, u.WorkspaceID, u.UserID, u.ConversationID, u.MessageID, string(u.Purpose), m.Provider.Name, m.ID, m.Model,
		u.InputTokens, u.CachedInputTokens, u.CacheWriteTokens, u.OutputTokens, u.Estimated,
		m.InputPrice, m.CachedInputPrice, m.CacheWritePrice, m.OutputPrice,
		m.Currency, u.Duration.Milliseconds(), u.Outcome)
	return err
}

// ---- usage, for system administrators ----

// AIUsageGroupBy is what calls are summed by.
type AIUsageGroupBy string

const (
	UsageByUser      AIUsageGroupBy = "user"
	UsageByModel     AIUsageGroupBy = "model"
	UsageByWorkspace AIUsageGroupBy = "workspace"
	UsageByPurpose   AIUsageGroupBy = "purpose"
	UsageByDay       AIUsageGroupBy = "day"
)

// usageKeys says what the calls of a group have in common. A day is counted
// in the zone given as $4.
var usageKeys = map[AIUsageGroupBy]string{
	UsageByUser:      `COALESCE(user_id, '')`,
	UsageByModel:     `json_build_array(provider, model)::text`,
	UsageByWorkspace: `COALESCE(workspace_id, '')`,
	UsageByPurpose:   `purpose`,
	UsageByDay:       `to_char(created_at AT TIME ZONE $4, 'YYYY-MM-DD')`,
}

// AIUsageFilter picks the calls to sum. From is inclusive and To
// exclusive; nil leaves that side open. Days are counted in TimeZone, an
// IANA name.
type AIUsageFilter struct {
	From, To *time.Time
	TimeZone string
}

// AIUsageSum is what some calls used. Costs are summed in each currency
// apart: there is no rate to turn one into another.
type AIUsageSum struct {
	Calls, Failed, Stopped, Estimated                              int64
	InputTokens, CachedInputTokens, CacheWriteTokens, OutputTokens int64
	// In the order of the currency codes.
	Costs []AICost
}

// AICost is an amount in a currency, as a decimal.
type AICost struct {
	Currency, Amount string
}

// AIUsageGroup sums the calls that share a key, with what the key names.
type AIUsageGroup struct {
	Key string
	// A user's name and email, and a workspace's name, now: a purged
	// workspace has none. A provider and a model as they were called.
	DisplayName, Email, WorkspaceName, Provider, Model string
	AIUsageSum
}

// AIUsageReport is what the calls in a time used, in all and by group.
type AIUsageReport struct {
	Total AIUsageSum
	// Answers that calls to chat wrote.
	Answers int64
	// Most calls first; days the latest first.
	Groups []AIUsageGroup
}

// SumAIUsage sums an org's calls to models, in all and grouped by.
func SumAIUsage(ctx context.Context, pool *pgxpool.Pool, orgID string, by AIUsageGroupBy, f AIUsageFilter) (AIUsageReport, error) {
	key, ok := usageKeys[by]
	if !ok {
		return AIUsageReport{}, errors.New("unknown grouping of usage: " + string(by))
	}
	args := []any{orgID, f.From, f.To}
	if by == UsageByDay {
		args = append(args, cmp.Or(f.TimeZone, "UTC"))
	}
	// One row per group and currency, and one per currency for the total.
	rows, err := pool.Query(ctx, `SELECT GROUPING(key) = 1, COALESCE(key, ''), currency, count(*), count(*) FILTER (WHERE outcome = 'failure'),
 count(*) FILTER (WHERE outcome = 'stopped'), count(*) FILTER (WHERE estimated), sum(input_tokens)::bigint, sum(cached_input_tokens)::bigint,
 sum(cache_write_tokens)::bigint, sum(output_tokens)::bigint, sum(cost)::text
 FROM (SELECT `+key+` AS key, * FROM ai_usage
  WHERE org_id = $1 AND ($2::timestamptz IS NULL OR created_at >= $2) AND ($3::timestamptz IS NULL OR created_at < $3)) calls
 GROUP BY GROUPING SETS ((key, currency), (currency))
 ORDER BY currency`, args...)
	if err != nil {
		return AIUsageReport{}, err
	}
	var report AIUsageReport
	at := map[string]int{} // where a key's group is in report.Groups
	var whole bool
	var groupKey string
	var sum AIUsageSum
	var cost AICost
	_, err = pgx.ForEachRow(rows, []any{&whole, &groupKey, &cost.Currency, &sum.Calls, &sum.Failed, &sum.Stopped, &sum.Estimated,
		&sum.InputTokens, &sum.CachedInputTokens, &sum.CacheWriteTokens, &sum.OutputTokens, &cost.Amount}, func() error {
		cost.Amount = trimDecimal(cost.Amount)
		if whole {
			report.Total.add(sum, cost)
			return nil
		}
		i, seen := at[groupKey]
		if !seen {
			i = len(report.Groups)
			at[groupKey] = i
			report.Groups = append(report.Groups, AIUsageGroup{Key: groupKey})
		}
		report.Groups[i].add(sum, cost)
		return nil
	})
	if err != nil {
		return AIUsageReport{}, err
	}
	if err := pool.QueryRow(ctx, `SELECT count(DISTINCT message_id) FROM ai_usage
 WHERE org_id = $1 AND purpose = 'chat' AND ($2::timestamptz IS NULL OR created_at >= $2) AND ($3::timestamptz IS NULL OR created_at < $3)`,
		orgID, f.From, f.To).Scan(&report.Answers); err != nil {
		return AIUsageReport{}, err
	}
	if err := nameUsageGroups(ctx, pool, orgID, by, report.Groups); err != nil {
		return AIUsageReport{}, err
	}
	slices.SortFunc(report.Groups, func(a, b AIUsageGroup) int {
		if by == UsageByDay {
			return strings.Compare(b.Key, a.Key)
		}
		return cmp.Or(cmp.Compare(b.Calls, a.Calls), strings.Compare(a.Key, b.Key))
	})
	return report, nil
}

// nameUsageGroups says what the keys of the groups name.
func nameUsageGroups(ctx context.Context, pool *pgxpool.Pool, orgID string, by AIUsageGroupBy, groups []AIUsageGroup) error {
	keys := make([]string, len(groups))
	for i, g := range groups {
		keys[i] = g.Key
	}
	var rows pgx.Rows
	var err error
	switch by {
	case UsageByModel:
		for i, g := range groups {
			var names [2]string
			if err := json.Unmarshal([]byte(g.Key), &names); err != nil {
				return err
			}
			groups[i].Provider, groups[i].Model = names[0], names[1]
		}
		return nil
	case UsageByUser:
		rows, err = pool.Query(ctx, `SELECT id, display_name, email FROM users WHERE org_id = $1 AND id = ANY($2)`, orgID, keys)
	case UsageByWorkspace:
		rows, err = pool.Query(ctx, `SELECT id, name, '' FROM workspaces WHERE org_id = $1 AND id = ANY($2)`, orgID, keys)
	default:
		return nil
	}
	if err != nil {
		return err
	}
	at := make(map[string]int, len(groups))
	for i, g := range groups {
		at[g.Key] = i
	}
	var key, name, email string
	_, err = pgx.ForEachRow(rows, []any{&key, &name, &email}, func() error {
		g := &groups[at[key]]
		if by == UsageByUser {
			g.DisplayName, g.Email = name, email
		} else {
			g.WorkspaceName = name
		}
		return nil
	})
	return err
}

func (s *AIUsageSum) add(o AIUsageSum, cost AICost) {
	s.Calls += o.Calls
	s.Failed += o.Failed
	s.Stopped += o.Stopped
	s.Estimated += o.Estimated
	s.InputTokens += o.InputTokens
	s.CachedInputTokens += o.CachedInputTokens
	s.CacheWriteTokens += o.CacheWriteTokens
	s.OutputTokens += o.OutputTokens
	s.Costs = append(s.Costs, cost)
}

// trimDecimal drops the zeros that a decimal ends in after its point.
func trimDecimal(s string) string {
	if !strings.Contains(s, ".") {
		return s
	}
	return strings.TrimSuffix(strings.TrimRight(s, "0"), ".")
}

// PruneAIUsage deletes an org's records of calls to models from before the
// cutoff, and returns how many it deleted. They are kept as long as audit
// events.
func PruneAIUsage(ctx context.Context, pool *pgxpool.Pool, orgID string, before time.Time) (int64, error) {
	var total int64
	for {
		tag, err := pool.Exec(ctx, `DELETE FROM ai_usage WHERE org_id=$1 AND id IN (SELECT id FROM ai_usage WHERE org_id=$1 AND created_at<$2 LIMIT $3)`, orgID, before, auditPruneBatch)
		if err != nil {
			return total, err
		}
		total += tag.RowsAffected()
		if tag.RowsAffected() < auditPruneBatch {
			return total, nil
		}
	}
}
