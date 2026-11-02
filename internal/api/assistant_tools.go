package api

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"
	"time"

	"github.com/supazd/supabi/internal/api/gen"
	"github.com/supazd/supabi/internal/assistant"
	"github.com/supazd/supabi/internal/audit"
	"github.com/supazd/supabi/internal/authz"
	"github.com/supazd/supabi/internal/content"
	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/query"
	"github.com/supazd/supabi/internal/store"
)

// The tools the AI assistant finds data with. Each does what an endpoint of
// a dashboard's viewer does, as the person asking, so that the assistant
// sees what they see on their dashboards and no more. See
// .agents/design/ai-assistant.md 12.

const (
	// toolRows is how many rows of a chart the model reads.
	toolRows = 200
	// sourceValidity is how long the link of a source keeps its conditions.
	sourceValidity = 30 * 24 * time.Hour
)

// assistantTool is a tool, with the least role that may call it.
type assistantTool struct {
	name        string
	description string
	parameters  string
	role        authz.Role
	run         func(s *Server, ctx context.Context, arguments json.RawMessage) (assistant.ToolResult, error)
}

const conditionsHelp = `A filter left out keeps its default; null or an empty list means no restriction. Values go by the filter's operator: in and not_in take a list of values, written exactly as filter_options gives them; between and not_between take [low, high]; eq, gt and the like take one value; contains and the like take text; time takes a range: {"last":{"n":1,"unit":"month"}} is the last whole month, and with "includeCurrent":true the current month too; {"current":"year"} is this year so far; {"start":"2026-01-01","end":"2026-04-01"} runs from one date up to another, not including it. Units are day, week, month, quarter and year.`

var assistantTools = []assistantTool{
	{name: "list_dashboards", role: authz.Viewer, run: (*Server).listDashboardsTool,
		description: "Lists the dashboards the user can open in this workspace, with the charts on each, by widget id. Start here to find where what the user asks about may be.",
		parameters:  `{"type":"object","properties":{}}`},
	{name: "describe_dashboard", role: authz.Viewer, run: (*Server).describeDashboardTool,
		description: "Describes a dashboard: its filters, and for each chart its columns, with what the dataset says they mean, its own filters, the dimensions and measures a viewer can switch between, how it drills down, and the links that narrow it.",
		parameters:  `{"type":"object","properties":{"dashboard":{"type":"string","description":"The dashboard's id."}},"required":["dashboard"]}`},
	{name: "filter_options", role: authz.Viewer, run: (*Server).filterOptionsTool,
		description: "Gives the values a filter can take, at most 500, so that a value is written exactly as the data has it. Values already chosen in other filters narrow the options of filters that depend on them.",
		parameters: `{"type":"object","properties":{` +
			`"dashboard":{"type":"string","description":"The dashboard's id."},` +
			`"filter":{"type":"string","description":"The filter's id."},` +
			`"widget":{"type":"string","description":"For a chart's own filter, the widget of the chart. Left out for a filter of the dashboard."},` +
			`"search":{"type":"string","description":"Text the values contain."},` +
			`"filters":{"type":"object","description":"Values chosen in the dashboard's filters, by filter id."},` +
			`"chartFilters":{"type":"object","description":"Values chosen in the chart's own filters, by filter id."}` +
			`},"required":["dashboard","filter"]}`},
	{name: "query_chart", role: authz.Viewer, run: (*Server).queryChartTool,
		description: "Reads the data of a chart on a dashboard, as the dashboard shows it under the conditions given, with the conditions in effect and the source to cite. At most " + fmt.Sprint(toolRows) + " rows are given. " + conditionsHelp,
		parameters: `{"type":"object","properties":{` +
			`"dashboard":{"type":"string","description":"The dashboard's id."},` +
			`"widget":{"type":"string","description":"The widget of the chart."},` +
			`"filters":{"type":"object","description":"Values of the dashboard's filters, by filter id."},` +
			`"chartFilters":{"type":"object","description":"Values of the chart's own filters, by filter id."},` +
			`"selections":{"type":"object","description":"The option chosen for each dynamic dimension or measure, by its id."},` +
			`"drill":{"type":"array","items":{},"description":"To see a level further down, the values clicked at each level from the first, as the chart's results write them."},` +
			`"links":{"type":"object","description":"By link id, a value of the link's source column, which narrows this chart."}` +
			`},"required":["dashboard","widget"]}`},
}

// assistantTools are the tools the caller may use, by their role. Each
// runs as the caller, in the workspace of the request.
func (s *Server) assistantToolsFor(ctx context.Context) []assistant.Tool {
	role := callerFrom(ctx).role
	var out []assistant.Tool
	for _, t := range assistantTools {
		if !role.AtLeast(t.role) {
			continue
		}
		out = append(out, assistant.Tool{Name: t.name, Description: t.description, Parameters: json.RawMessage(t.parameters),
			Run: func(ctx context.Context, arguments string) assistant.ToolResult {
				if strings.TrimSpace(arguments) == "" {
					arguments = "{}"
				}
				result, err := t.run(s, ctx, json.RawMessage(arguments))
				if err != nil {
					return s.toolFailure(ctx, err)
				}
				return result
			}})
	}
	return out
}

// toolFailure tells the model what went wrong, as an endpoint would tell
// its caller.
func (s *Server) toolFailure(ctx context.Context, err error) assistant.ToolResult {
	if errors.Is(err, context.Canceled) {
		return assistant.ToolResult{Content: "Stopped.", Failed: true}
	}
	e := s.toAPIError(ctx, err)
	message := e.code + ": " + e.message
	if e.code == "not_found" {
		message = "not_found: there is no such dashboard, widget or filter, or the user cannot open it"
	}
	if len(e.params) > 0 {
		params, _ := json.Marshal(e.params)
		message += " " + string(params)
	}
	return assistant.ToolResult{Content: message, Failed: true}
}

// toolArguments reads what the model wrote, refusing names it made up, so
// that it learns the right ones.
func toolArguments(raw json.RawMessage, into any) error {
	return decodeStrict(raw, into, "invalid_arguments")
}

// toolText is what the model reads of a tool's result.
func toolText(v any) (string, error) {
	raw, err := json.Marshal(v)
	return string(raw), err
}

// widgetName is what a chart's widget is called: its title, or its chart's name.
func widgetName(item content.Item, names map[string]string) string {
	if item.Title != "" {
		return item.Title
	}
	return names[item.ChartID]
}

// ---- list_dashboards ----

type toolDashboardEntry struct {
	ID          string           `json:"id"`
	Name        string           `json:"name"`
	Description string           `json:"description,omitempty"`
	Charts      []toolChartEntry `json:"charts"`
}

type toolChartEntry struct {
	Widget string `json:"widget"`
	Name   string `json:"name"`
}

func (s *Server) listDashboardsTool(ctx context.Context, raw json.RawMessage) (assistant.ToolResult, error) {
	if err := toolArguments(raw, &struct{}{}); err != nil {
		return assistant.ToolResult{}, err
	}
	list, err := store.ListDashboards(ctx, s.Pool, s.scope(ctx))
	if err != nil {
		return assistant.ToolResult{}, err
	}
	visible, err := s.visibleContent(ctx)
	if err != nil {
		return assistant.ToolResult{}, err
	}
	var (
		shown    []store.Dashboard
		widgets  [][]content.Item
		chartIDs []string
	)
	for _, d := range list {
		if visible != nil && !visible.Dashboards[d.ID] {
			continue
		}
		var spec content.DashboardSpec
		if err := json.Unmarshal(d.Spec, &spec); err != nil {
			return assistant.ToolResult{}, err
		}
		var items []content.Item
		for _, item := range spec.Widgets() {
			if item.HoldsChart() {
				items = append(items, item)
				chartIDs = append(chartIDs, item.ChartID)
			}
		}
		shown, widgets = append(shown, d), append(widgets, items)
	}
	charts, err := store.GetCharts(ctx, s.Pool, s.scope(ctx), slices.Compact(slices.Sorted(slices.Values(chartIDs))))
	if err != nil {
		return assistant.ToolResult{}, err
	}
	names := map[string]string{}
	for _, c := range charts {
		names[c.ID] = c.Name
	}
	out := []toolDashboardEntry{}
	for i, d := range shown {
		entry := toolDashboardEntry{ID: d.ID, Name: d.Name, Description: d.Description, Charts: []toolChartEntry{}}
		for _, item := range widgets[i] {
			entry.Charts = append(entry.Charts, toolChartEntry{Widget: item.ID, Name: widgetName(item, names)})
		}
		out = append(out, entry)
	}
	text, err := toolText(out)
	return assistant.ToolResult{Content: text}, err
}

// ---- describe_dashboard ----

type toolDashboard struct {
	ID          string       `json:"id"`
	Name        string       `json:"name"`
	Description string       `json:"description,omitempty"`
	Filters     []toolFilter `json:"filters,omitempty"`
	Charts      []toolChart  `json:"charts"`
}

type toolFilter struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	// Op is the condition's operator, or param for a dataset parameter.
	Op       string `json:"op"`
	Type     string `json:"type,omitempty"`
	Control  string `json:"control,omitempty"`
	Multiple bool   `json:"multiple,omitempty"`
	Default  any    `json:"default,omitempty"`
	// Options are what a parameter's dropdown offers.
	Options []any `json:"options,omitempty"`
	// AppliesTo are the widgets a dashboard's filter narrows.
	AppliesTo []string `json:"appliesTo,omitempty"`
	DependsOn []string `json:"dependsOn,omitempty"`
	// TakenOver says a dashboard's filter decides it, and its value is not used.
	TakenOver   bool     `json:"takenOverByDashboardFilter,omitempty"`
	Description string   `json:"description,omitempty"`
	Synonyms    []string `json:"synonyms,omitempty"`
}

type toolChart struct {
	Widget     string        `json:"widget"`
	Name       string        `json:"name"`
	Type       string        `json:"type"`
	Dimensions []toolField   `json:"dimensions,omitempty"`
	Measures   []toolField   `json:"measures,omitempty"`
	Columns    []toolField   `json:"columns,omitempty"`
	Filters    []toolFilter  `json:"filters,omitempty"`
	Dynamics   []toolDynamic `json:"dynamics,omitempty"`
	Drill      *toolDrill    `json:"drill,omitempty"`
	Links      []toolLink    `json:"links,omitempty"`
}

type toolField struct {
	// Column is the column's name in the chart's results.
	Column      string   `json:"column"`
	Label       string   `json:"label"`
	Agg         string   `json:"agg,omitempty"`
	Grain       string   `json:"grain,omitempty"`
	Description string   `json:"description,omitempty"`
	Synonyms    []string `json:"synonyms,omitempty"`
}

type toolDynamic struct {
	ID      string       `json:"id"`
	Label   string       `json:"label"`
	Kind    string       `json:"kind"`
	Column  string       `json:"column"`
	Options []toolOption `json:"options"`
}

type toolOption struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

type toolDrill struct {
	// Column is drilled down from; Levels are what it becomes, one by one.
	Column string   `json:"column"`
	Levels []string `json:"levels"`
}

type toolLink struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	// Narrows says which field of this chart a value narrows, and From
	// where such values come: a column of another chart.
	Narrows string `json:"narrows"`
	From    string `json:"from"`
}

// fieldOf describes a field of a chart's dataset, with what the dataset
// says it means unless the caller may not see the field.
func fieldOf(ds *dataset.Spec, hidden map[string]bool, key, label string) toolField {
	out := toolField{Label: label}
	f, ok := ds.FieldByKey(key)
	if !ok {
		if out.Label == "" {
			out.Label = key
		}
		return out
	}
	if out.Label == "" {
		out.Label = f.Label
	}
	if !hidden[key] {
		out.Description, out.Synonyms = f.Description, f.Synonyms
	}
	return out
}

func (s *Server) describeDashboardTool(ctx context.Context, raw json.RawMessage) (assistant.ToolResult, error) {
	var a struct {
		Dashboard string `json:"dashboard"`
	}
	if err := toolArguments(raw, &a); err != nil {
		return assistant.ToolResult{}, err
	}
	dc, err := s.loadDashboard(ctx, a.Dashboard, nil)
	if err != nil {
		return assistant.ToolResult{}, err
	}
	// What the caller may not see of each dataset.
	hidden := map[string]map[string]bool{}
	c := callerFrom(ctx)
	for _, loaded := range dc.datasets {
		if _, done := hidden[loaded.stored.ID]; done {
			continue
		}
		d, err := s.datasetDialect(ctx, loaded.stored)
		if err != nil {
			return assistant.ToolResult{}, err
		}
		scope, err := s.scopeFor(ctx, c.role, c.principal.UserID, loaded.stored.ID, loaded.spec, d)
		if err != nil {
			return assistant.ToolResult{}, err
		}
		hidden[loaded.stored.ID] = scope.hidden
	}
	out := toolDashboard{ID: a.Dashboard, Name: dc.name, Description: dc.description, Charts: []toolChart{}}
	for _, f := range dc.spec.Filters {
		tf := toolFilter{ID: f.ID, Label: f.Label, Op: f.Op, Control: f.Control.Type, Multiple: f.Control.Multi, Default: f.Default, DependsOn: f.DependsOn}
		for _, target := range f.Targets {
			tf.AppliesTo = append(tf.AppliesTo, target.Item)
			item, _ := dc.spec.ItemByID(target.Item)
			if loaded, ok := dc.datasets[item.ChartID]; ok && target.Field != "" && tf.Type == "" {
				if field, ok := loaded.spec.FieldByKey(target.Field); ok {
					tf.Type = string(field.Type)
					described := fieldOf(loaded.spec, hidden[loaded.stored.ID], target.Field, "")
					tf.Description, tf.Synonyms = described.Description, described.Synonyms
				}
			}
		}
		out.Filters = append(out.Filters, tf)
	}
	for _, item := range dc.spec.Widgets() {
		if !item.HoldsChart() {
			continue
		}
		chart, ok := dc.charts[item.ChartID]
		if !ok {
			continue
		}
		loaded := dc.datasets[item.ChartID]
		out.Charts = append(out.Charts, describeChart(dc, item, chart, loaded.spec, hidden[loaded.stored.ID]))
	}
	text, err := toolText(out)
	return assistant.ToolResult{Content: text, Subject: dc.name}, err
}

// describeChart says what a chart shows, as its dynamic choices first stand,
// and what can be changed about it.
func describeChart(dc *dashboardContext, item content.Item, chart content.ChartSpec, ds *dataset.Spec, hidden map[string]bool) toolChart {
	out := toolChart{Widget: item.ID, Name: widgetName(item, dc.names), Type: chart.Viz.Type}
	shown, err := chart.ResolveDynamics(nil)
	if err != nil {
		shown = chart
	}
	for _, d := range shown.Query.Dimensions {
		f := fieldOf(ds, hidden, d.Field, d.Label)
		f.Column, f.Grain = d.Name(), string(d.Grain)
		out.Dimensions = append(out.Dimensions, f)
	}
	for _, m := range shown.Query.Measures {
		f := fieldOf(ds, hidden, m.Field, m.Label)
		f.Column, f.Agg = m.Field, string(m.Agg)
		if m.Alias != "" {
			f.Column = m.Alias
		}
		out.Measures = append(out.Measures, f)
	}
	for _, col := range shown.Query.Columns {
		f := fieldOf(ds, hidden, col.Field, col.Label)
		f.Column = col.Field
		out.Columns = append(out.Columns, f)
	}
	overridden, _ := dc.spec.OverriddenFilters(item, &shown, ds)
	for _, f := range chart.Filters {
		if !f.Interactive() {
			continue
		}
		tf := toolFilter{ID: f.ID, Label: f.Label, Op: f.Op, Control: f.Control.Type, Multiple: f.Control.Multi, Default: f.Value, DependsOn: f.DependsOn, TakenOver: slices.Contains(overridden, f.ID)}
		if f.IsParam() {
			tf.Op, tf.Options = "param", f.Options
			if tf.Label == "" {
				tf.Label = f.Param
			}
		} else {
			described := fieldOf(ds, hidden, f.Field, f.Label)
			tf.Label, tf.Description, tf.Synonyms = described.Label, described.Description, described.Synonyms
			if field, ok := ds.FieldByKey(f.Field); ok {
				tf.Type = string(field.Type)
			}
		}
		out.Filters = append(out.Filters, tf)
	}
	for _, dyn := range chart.Dynamics {
		td := toolDynamic{ID: dyn.ID, Label: dyn.Label, Kind: dyn.Kind, Column: dyn.Alias}
		for _, option := range dyn.Options {
			td.Options = append(td.Options, toolOption{ID: option.ID, Label: fieldOf(ds, hidden, option.Field, option.Label).Label})
		}
		out.Dynamics = append(out.Dynamics, td)
	}
	if chart.Drill != nil {
		td := &toolDrill{Column: chart.Drill.Alias}
		for _, level := range chart.Drill.Levels {
			td.Levels = append(td.Levels, fieldOf(ds, hidden, level.Field, level.Label).Label)
		}
		out.Drill = td
	}
	for _, link := range dc.spec.Links {
		for _, target := range link.Targets {
			if target.Item != item.ID {
				continue
			}
			from := link.Source.Column
			if source, ok := dc.spec.ItemByID(link.Source.Item); ok {
				from = widgetName(source, dc.names) + " › " + link.Source.Column
			}
			out.Links = append(out.Links, toolLink{ID: link.ID, Label: link.Label, Narrows: fieldOf(ds, hidden, target.Field, "").Label, From: from})
		}
	}
	return out
}

// ---- filter_options ----

func (s *Server) filterOptionsTool(ctx context.Context, raw json.RawMessage) (assistant.ToolResult, error) {
	var a struct {
		Dashboard    string         `json:"dashboard"`
		Filter       string         `json:"filter"`
		Widget       string         `json:"widget"`
		Search       string         `json:"search"`
		Filters      map[string]any `json:"filters"`
		ChartFilters map[string]any `json:"chartFilters"`
	}
	if err := toolArguments(raw, &a); err != nil {
		return assistant.ToolResult{}, err
	}
	var (
		dc    *dashboardContext
		item  = a.Widget
		label string
		err   error
	)
	if a.Widget == "" {
		if dc, err = s.loadDashboard(ctx, a.Dashboard, func(spec *content.DashboardSpec) []string { return optionsItems(spec, a.Filter) }); err != nil {
			return assistant.ToolResult{}, err
		}
		f, ok := dc.spec.FilterByID(a.Filter)
		if !ok {
			return assistant.ToolResult{}, store.ErrNotFound
		}
		target, _ := f.OptionsTarget()
		item, label = target.Item, f.Label
	} else {
		if dc, err = s.loadDashboard(ctx, a.Dashboard, func(*content.DashboardSpec) []string { return []string{a.Widget} }); err != nil {
			return assistant.ToolResult{}, err
		}
		widget, _ := dc.spec.ItemByID(a.Widget)
		chart := dc.charts[widget.ChartID]
		if f, ok := chart.FilterByID(a.Filter); ok {
			label = cmp.Or(f.Label, f.Field, f.Param)
		}
	}
	in := gen.DashboardFilterOptionsRequest{}
	if len(a.Filters) > 0 {
		in.Filters = &a.Filters
	}
	if len(a.ChartFilters) > 0 {
		in.ChartFilters = &a.ChartFilters
	}
	if a.Search != "" {
		in.Search = &a.Search
	}
	var options gen.FilterOptions
	err = s.auditToolQuery(ctx, a.Dashboard, map[string]any{"itemId": item, "filterId": a.Filter}, func(ctx context.Context) error {
		var err error
		options, err = s.dashboardOptions(ctx, dc, item, a.Filter, a.Widget != "", in)
		return err
	})
	if err != nil {
		return assistant.ToolResult{}, err
	}
	text, err := toolText(options)
	return assistant.ToolResult{Content: text, Subject: dc.name + " › " + cmp.Or(label, a.Filter)}, err
}

// auditToolQuery records what a tool read from data sources as a query
// event of its own, as the endpoint it stands for would: the request that
// the assistant answers records nothing itself.
func (s *Server) auditToolQuery(ctx context.Context, dashboardID string, detail map[string]any, run func(ctx context.Context) error) error {
	t := &trail{}
	err := run(context.WithValue(ctx, trailKey{}, t))
	if len(t.statements) == 0 && !refused(err) {
		return err
	}
	outcome := audit.Success
	switch {
	case refused(err):
		outcome = audit.Denied
	case err != nil:
		outcome = audit.Failure
	}
	e := s.event(ctx, queryRun, outcome)
	e.WorkspaceID = callerFrom(ctx).principal.WorkspaceID
	e.Object = audit.Object{Type: "dashboard", ID: dashboardID}
	e.Object.Name = s.objectName(ctx, e.Object)
	detail["via"] = "assistant"
	if len(t.statements) > 0 {
		detail["statements"] = t.statements
	}
	if err != nil {
		var apiErr *apiError
		if errors.As(err, &apiErr) {
			detail["error"] = apiErr.code
		} else {
			detail["error"] = errorCode(err)
		}
	}
	e.Detail = detail
	s.record(ctx, e)
	return err
}

// ---- query_chart ----

type chartQuestion struct {
	Dashboard    string            `json:"dashboard"`
	Widget       string            `json:"widget"`
	Filters      map[string]any    `json:"filters"`
	ChartFilters map[string]any    `json:"chartFilters"`
	Selections   map[string]string `json:"selections"`
	Drill        []any             `json:"drill"`
	Links        map[string]any    `json:"links"`
}

// toolData is a chart's data as the model reads it.
type toolData struct {
	Conditions []store.SourceCondition `json:"conditions"`
	Columns    []gen.ResultColumn      `json:"columns"`
	Rows       [][]any                 `json:"rows"`
	// TotalRows is how many rows the chart has; past toolRows they are left out.
	TotalRows int              `json:"totalRows"`
	Truncated bool             `json:"truncated,omitempty"`
	Totals    []gen.QueryTotal `json:"totals,omitempty"`
	DataAt    *time.Time       `json:"dataAt,omitempty"`
}

func (s *Server) queryChartTool(ctx context.Context, raw json.RawMessage) (assistant.ToolResult, error) {
	var a chartQuestion
	if err := toolArguments(raw, &a); err != nil {
		return assistant.ToolResult{}, err
	}
	dc, err := s.loadDashboard(ctx, a.Dashboard, func(*content.DashboardSpec) []string { return []string{a.Widget} })
	if err != nil {
		return assistant.ToolResult{}, err
	}
	item, ok := dc.spec.ItemByID(a.Widget)
	if !ok || !item.HoldsChart() {
		return assistant.ToolResult{}, &apiError{status: 404, code: "not_found", message: fmt.Sprintf("the dashboard has no chart widget %q", a.Widget)}
	}
	body := gen.DashboardDataRequest{}
	if len(a.Filters) > 0 {
		body.Filters = &a.Filters
	}
	if len(a.ChartFilters) > 0 {
		body.ChartFilters = &a.ChartFilters
	}
	if len(a.Selections) > 0 {
		body.Selections = &a.Selections
	}
	if len(a.Links) > 0 {
		body.Links = &a.Links
	}
	if len(a.Drill) > 0 {
		path := gen.DrillPath(a.Drill)
		body.Drill = &path
	}
	var result gen.QueryResult
	err = s.auditToolQuery(ctx, a.Dashboard, map[string]any{"itemId": a.Widget}, func(ctx context.Context) error {
		var err error
		result, err = s.dashboardItemData(ctx, dc, a.Widget, body)
		return err
	})
	if err != nil {
		return assistant.ToolResult{}, err
	}
	source, err := s.answerSource(ctx, dc, item, a, result)
	if err != nil {
		return assistant.ToolResult{}, err
	}
	data := toolData{Conditions: source.Conditions, Columns: result.Columns, Rows: result.Rows, TotalRows: len(result.Rows), Truncated: result.Meta.Truncated, DataAt: result.Meta.CachedAt}
	if len(data.Rows) > toolRows {
		data.Rows, data.Truncated = data.Rows[:toolRows], true
	}
	if result.Totals != nil {
		data.Totals = *result.Totals
	}
	text, err := toolText(data)
	return assistant.ToolResult{Content: text, Subject: source.DashboardName + " › " + source.ChartName, Source: source, Cells: data.cells()}, err
}

// cells are the values the model was given, rows and totals, which its
// calculations may use.
func (d toolData) cells() []any {
	var out []any
	for _, row := range d.Rows {
		out = append(out, row...)
	}
	for _, total := range d.Totals {
		for _, row := range total.Rows {
			out = append(out, row...)
		}
	}
	return out
}

// answerSource is where a chart's data came from, with a link to open the
// dashboard as it was read: see .agents/design/ai-assistant.md 12.3.
func (s *Server) answerSource(ctx context.Context, dc *dashboardContext, item content.Item, a chartQuestion, result gen.QueryResult) (*store.AnswerSource, error) {
	loaded := dc.datasets[item.ChartID]
	source := &store.AnswerSource{
		DashboardID: a.Dashboard, DashboardName: dc.name, ItemID: item.ID, ChartID: item.ChartID, ChartName: widgetName(item, dc.names),
		DatasetID: loaded.stored.ID, DashboardRevision: dc.revision, ChartRevision: dc.revisions[item.ChartID], DatasetRevision: loaded.stored.Revision,
		DataAt: result.Meta.CachedAt, Rows: len(result.Rows), Truncated: len(result.Rows) > toolRows,
	}
	conditions, err := s.sourceConditions(ctx, dc, item, a)
	if err != nil {
		return nil, err
	}
	source.Conditions = conditions

	// The dashboard as it opens needs no link of its own.
	state := canonicalViewState(viewStateOf(dc, item, a))
	if source.State, err = json.Marshal(state); err != nil {
		return nil, err
	}
	if string(source.State) == "{}" {
		return source, nil
	}
	view, _, err := s.saveView(ctx, a.Dashboard, state, sourceValidity)
	if err != nil {
		// The figures stand without the link.
		s.Logger.WarnContext(ctx, "assistant source link not kept", "dashboard", a.Dashboard, "error", err)
		return source, nil
	}
	source.ViewID, source.ExpiresAt = view.ID, &view.ExpiresAt
	return source, nil
}

// viewStateOf is what a share link carries to open a dashboard with the
// chart as it was read, in view: on its page, in its tab.
func viewStateOf(dc *dashboardContext, item content.Item, a chartQuestion) gen.DashboardViewState {
	var state gen.DashboardViewState
	if len(a.Filters) > 0 {
		state.Filters = &a.Filters
	}
	if len(a.ChartFilters) > 0 {
		state.ChartFilters = &map[string]map[string]any{item.ID: a.ChartFilters}
	}
	if len(a.Selections) > 0 {
		state.Selections = &map[string]map[string]string{item.ID: a.Selections}
	}
	if len(a.Links) > 0 {
		state.Links = &a.Links
	}
	if len(a.Drill) > 0 {
		steps := make([]gen.DrillStep, len(a.Drill))
		for i, value := range a.Drill {
			steps[i] = gen.DrillStep{Value: value}
		}
		state.Drill = &map[string]gen.DrillState{item.ID: {Root: drillRoot(dc, item), Steps: steps}}
	}
	holder := item
	for _, container := range dc.spec.Layout.Items {
		if slices.ContainsFunc(container.Tabs, func(tab content.Tab) bool { return tab.ID == item.ID }) {
			state.Tabs = &map[string]string{container.ID: item.ID}
			holder = container
		}
	}
	if pages := dc.spec.Layout.Pages; len(pages) > 0 && holder.Page != "" && holder.Page != pages[0].ID {
		state.Page = &holder.Page
	}
	return state
}

// drillRoot is what the first level of a chart's drill is called.
func drillRoot(dc *dashboardContext, item content.Item) string {
	chart := dc.charts[item.ChartID]
	if chart.Drill == nil {
		return ""
	}
	for _, d := range chart.Query.Dimensions {
		if d.Name() == chart.Drill.Alias {
			return fieldOf(dc.datasets[item.ChartID].spec, nil, d.Field, d.Label).Label
		}
	}
	return chart.Drill.Alias
}

// sourceConditions are the conditions a chart was read under: those given,
// and the defaults of those left out. Conditions that restrict nothing are
// none; the time a range stood for is written out.
func (s *Server) sourceConditions(ctx context.Context, dc *dashboardContext, item content.Item, a chartQuestion) ([]store.SourceCondition, error) {
	workspace, err := store.GetWorkspace(ctx, s.Pool, s.scope(ctx))
	if err != nil {
		return nil, err
	}
	chart := dc.charts[item.ChartID]
	ds := dc.datasets[item.ChartID].spec
	out := []store.SourceCondition{}
	// A filter is a condition when the query makes one of its value: an
	// open range or an empty list is none.
	add := func(kind, label string, f content.ChartFilter, value any, given bool) {
		if _, restricts, err := f.Condition(value); err == nil && !restricts {
			return
		}
		c := store.SourceCondition{Kind: kind, Label: label, Value: value, Default: !given}
		if f.Op == query.OpTime {
			c.Text = s.rangeText(value, workspace)
		}
		out = append(out, c)
	}
	for _, f := range dc.spec.Filters {
		if !slices.ContainsFunc(f.Targets, func(t content.FilterTarget) bool { return t.Item == item.ID }) {
			continue
		}
		value, given := a.Filters[f.ID]
		if !given {
			value = f.Default
		}
		add("filter", f.Label, content.ChartFilter{ID: f.ID, Op: f.Op, Control: &f.Control}, value, given)
	}
	shown, err := chart.ResolveDynamics(a.Selections)
	if err != nil {
		shown = chart
	}
	overridden, _ := dc.spec.OverriddenFilters(item, &shown, ds)
	for _, f := range chart.Filters {
		if !f.Interactive() || slices.Contains(overridden, f.ID) {
			continue
		}
		value, given := a.ChartFilters[f.ID]
		if !given {
			value = f.Value
		}
		if !f.IsParam() {
			add("chartFilter", fieldOf(ds, nil, f.Field, f.Label).Label, f, value, given)
			continue
		}
		// A parameter left as the chart has it may follow the dataset's default.
		if !given && !f.ValueSet {
			if param, ok := ds.ParamByName(f.Param); ok {
				value = param.Default
			}
		}
		if !restrictsNothing(value) {
			out = append(out, store.SourceCondition{Kind: "chartFilter", Label: cmp.Or(f.Label, f.Param), Value: value, Text: s.relativeDaysText(value, workspace), Default: !given})
		}
	}
	for _, dyn := range chart.Dynamics {
		chosen, given := a.Selections[dyn.ID]
		if !given && len(dyn.Options) > 0 {
			chosen = dyn.Options[0].ID
		}
		c := store.SourceCondition{Kind: "selection", Label: dyn.Label, Value: chosen, Default: !given}
		for _, option := range dyn.Options {
			if option.ID == chosen {
				c.Text = fieldOf(ds, nil, option.Field, option.Label).Label
			}
		}
		out = append(out, c)
	}
	if len(a.Drill) > 0 {
		steps := make([]string, len(a.Drill))
		for i, value := range a.Drill {
			steps[i] = fmt.Sprint(value)
		}
		out = append(out, store.SourceCondition{Kind: "drill", Label: drillRoot(dc, item), Value: a.Drill, Text: strings.Join(steps, " › ")})
	}
	for _, id := range slices.Sorted(maps.Keys(a.Links)) {
		label := id
		for _, link := range dc.spec.Links {
			if link.ID == id {
				label = link.Label
			}
		}
		out = append(out, store.SourceCondition{Kind: "link", Label: label, Value: a.Links[id]})
	}
	return out, nil
}

// restrictsNothing says a parameter has no value: it is then left out.
func restrictsNothing(value any) bool {
	switch v := value.(type) {
	case nil:
		return true
	case string:
		return v == ""
	case []any:
		return len(v) == 0
	case map[string]any:
		return len(v) == 0
	}
	return false
}

// rangeText writes the dates a time range stands for today, the end as
// the last day in it.
func (s *Server) rangeText(value any, workspace store.Workspace) string {
	raw, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	var tr query.TimeRange
	if json.Unmarshal(raw, &tr) != nil {
		return ""
	}
	start, end, err := query.ResolveTimeRange(&tr, s.now(), workspace.Timezone, workspace.WeekStart)
	if err != nil {
		return ""
	}
	midnight := func(t time.Time) bool { return t.IsZero() || (t.Hour() == 0 && t.Minute() == 0 && t.Second() == 0) }
	write := func(t time.Time, last bool) string {
		switch {
		case t.IsZero():
			return ""
		case midnight(start) && midnight(end):
			if last {
				t = t.AddDate(0, 0, -1)
			}
			return t.Format("2006-01-02")
		}
		return t.Format("2006-01-02 15:04")
	}
	return strings.TrimSpace(write(start, false) + " – " + write(end, true))
}

// relativeDaysText writes the value of a date parameter with the days
// relative to today in it, such as {"relative": "today-1d"}, as the dates
// they stand for today; it is empty when the value has none.
func (s *Server) relativeDaysText(value any, workspace store.Workspace) string {
	items, ok := value.([]any)
	if !ok {
		items = []any{value}
	}
	loc, err := time.LoadLocation(workspace.Timezone)
	if err != nil {
		return ""
	}
	relative := false
	days := make([]string, len(items))
	for i, item := range items {
		days[i] = fmt.Sprint(item)
		if rel, ok := item.(map[string]any); ok {
			expr, _ := rel["relative"].(string)
			day, err := query.RelativeDay(expr, s.now().In(loc))
			if err != nil {
				return ""
			}
			days[i], relative = day, true
		}
	}
	if !relative {
		return ""
	}
	return strings.Join(days, ", ")
}
