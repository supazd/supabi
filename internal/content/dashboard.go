package content

import (
	"math"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/query"
)

// GridColumns is the default width of the dashboard grid.
const GridColumns = 96

// Each former vertical row is split into eight fine grid units.
const maxItemHeight = 24 * 8

// DashboardSpec lays charts out on a grid and can filter them together.
type DashboardSpec struct {
	SpecVersion int    `json:"specVersion"`
	Layout      Layout `json:"layout"`
	// Filters are the global controls grouped in the query container.
	Filters []Filter `json:"filters,omitempty"`
	Links   []Link   `json:"links,omitempty"`
	// Missing in legacy dashboards, where filters were a strip above the charts.
	QueryContainer *QueryContainerLayout `json:"queryContainer,omitempty"`
	FilterStyle    *FilterStyle          `json:"filterStyle,omitempty"`
	// Empty preserves automatic triggering for existing dashboards.
	QueryMode string `json:"queryMode,omitempty"`
	// Frame is how chart and text widgets look unless they say otherwise.
	Frame *Frame `json:"frame,omitempty"`
	// Empty fits the query container height to its content.
	QueryHeightMode string `json:"queryHeightMode,omitempty"`
	// AutoRefresh is how often, in seconds, a viewed dashboard asks for its
	// data again; absent, it does not. One of AutoRefreshIntervals.
	AutoRefresh int `json:"autoRefresh,omitempty"`
}

// AutoRefreshIntervals are the intervals a dashboard may refresh at, in seconds.
var AutoRefreshIntervals = []int{60, 300, 900, 1800, 3600}

// QueryContainerLayout locates the single container of global controls on the chart grid.
type QueryContainerLayout struct {
	X     int    `json:"x"`
	Y     int    `json:"y"`
	W     int    `json:"w"`
	H     int    `json:"h"`
	Frame *Frame `json:"frame,omitempty"`
}

// Filter is a global control applied to explicitly mapped fields of selected charts.
// Its operation replaces the operation of any conflicting chart filter.
type Filter struct {
	ID      string         `json:"id"`
	Label   string         `json:"label"`
	Op      string         `json:"op"`
	Control Control        `json:"control"`
	Targets []FilterTarget `json:"targets"`
	// OptionsFrom names the widget supplying distinct values; empty uses the first target.
	OptionsFrom string   `json:"optionsFrom,omitempty"`
	Default     any      `json:"default,omitempty"`
	DependsOn   []string `json:"dependsOn,omitempty"`
}

// FilterTarget names a dataset field or a configured output measure on a chart.
// Filter is only read to upgrade bindings saved before direct field bindings.
type FilterTarget struct {
	Item        string      `json:"item"`
	Field       string      `json:"field,omitempty"`
	Measure     string      `json:"measure,omitempty"`
	Filter      string      `json:"filter,omitempty"`
	Aggregation dataset.Agg `json:"aggregation,omitempty"`
}

// OptionsTarget returns the target whose field supplies the filter's options.
func (f Filter) OptionsTarget() (FilterTarget, bool) {
	for _, t := range f.Targets {
		if f.OptionsFrom == "" || t.Item == f.OptionsFrom {
			return t, true
		}
	}
	return FilterTarget{}, false
}

// QueryForViewer applies saved dashboard bindings and validated viewer values.
// Chart filters retain their own values while taken over, and are restored when
// useChartFilters is true. Dataset row policies and the query's own conditions
// are never overridden.
func (s *DashboardSpec) QueryForViewer(item Item, chart *ChartSpec, ds *dataset.Spec, global, own map[string]any, useChartFilters bool) (query.Query, error) {
	for id := range global {
		if _, ok := s.FilterByID(id); !ok {
			return chart.Query, bad("unknown_filter", []string{"id", id}, "the dashboard has no filter %q", id)
		}
	}
	if err := chart.checkViewerValues(own, ds); err != nil {
		return chart.Query, err
	}
	if useChartFilters {
		return chart.Filtered(own, ds)
	}
	taken := map[string]bool{}
	c := conditions{q: chart.Query}
	for _, f := range s.Filters {
		for _, t := range f.Targets {
			if t.Item != item.ID {
				continue
			}
			if t.Filter != "" {
				// Normalization upgrades every legacy binding it can; what is left is broken.
				return chart.Query, bad("invalid_filter_target", []string{"id", f.ID, "item", t.Item, "filter", t.Filter}, "filter %q has a binding that can no longer be upgraded", f.ID)
			}
			target, err := ResolveFilterTarget(chart, ds, t)
			if err != nil {
				return chart.Query, withFilterID(err, f.ID)
			}
			taken[target.Identity] = true
			value := f.Default
			if chosen, ok := global[f.ID]; ok {
				value = chosen
			}
			if err := c.add(ChartFilter{ID: f.ID, Field: target.Field, Op: f.Op, Control: &f.Control}, target, value); err != nil {
				return chart.Query, err
			}
		}
	}
	for _, f := range chart.Filters {
		if f.IsParam() {
			continue
		}
		target, err := ResolveFilterTarget(chart, ds, FilterTarget{Field: f.Field, Aggregation: f.Aggregation})
		if err != nil {
			return chart.Query, err
		}
		if taken[target.Identity] {
			continue
		}
		value := f.Value
		if chosen, ok := own[f.ID]; ok {
			value = chosen
		}
		if err := c.add(f, target, value); err != nil {
			return chart.Query, err
		}
	}
	// Global filters bind fields only, so parameters keep the chart's values.
	return chart.withParams(c.query(), own), nil
}

// FilterByID returns the dashboard's filter with the given id.
func (s *DashboardSpec) FilterByID(id string) (Filter, bool) {
	for _, f := range s.Filters {
		if f.ID == id {
			return f, true
		}
	}
	return Filter{}, false
}

// OverriddenFilters uses resolved operands rather than display names, so a
// dynamic measure and an explicitly aggregated local condition agree exactly.
func (s *DashboardSpec) OverriddenFilters(item Item, chart *ChartSpec, ds *dataset.Spec) ([]string, error) {
	taken := map[string]bool{}
	for _, f := range s.Filters {
		for _, target := range f.Targets {
			if target.Item != item.ID {
				continue
			}
			resolved, err := ResolveFilterTarget(chart, ds, target)
			if err != nil {
				return nil, err
			}
			taken[resolved.Identity] = true
		}
	}
	out := []string{}
	for _, f := range chart.Filters {
		if f.IsParam() {
			continue
		}
		resolved, err := ResolveFilterTarget(chart, ds, FilterTarget{Field: f.Field, Aggregation: f.Aggregation})
		if err != nil {
			return nil, err
		}
		if taken[resolved.Identity] {
			out = append(out, f.ID)
		}
	}
	return out, nil
}

// ItemByID returns the dashboard's widget with the given id, which may be a
// tab of a tab container.
func (s *DashboardSpec) ItemByID(id string) (Item, bool) {
	for _, item := range s.Layout.Items {
		if item.ID == id {
			return item, true
		}
		for _, tab := range item.Tabs {
			if tab.ID == id {
				return tab.widget(), true
			}
		}
	}
	return Item{}, false
}

// Widgets lists the dashboard's widgets, each tab container followed by its
// tabs as the chart widgets they are.
func (s *DashboardSpec) Widgets() []Item {
	var widgets []Item
	for _, item := range s.Layout.Items {
		widgets = append(widgets, item)
		for _, tab := range item.Tabs {
			widgets = append(widgets, tab.widget())
		}
	}
	return widgets
}

type Layout struct {
	Columns int    `json:"columns"`
	Items   []Item `json:"items"`
	// Pages split the dashboard into tabs, in the order they are shown; the
	// first is shown when it is opened. Items name the page they are on, and
	// those that name none are above the tabs, on every page. Left out, the
	// dashboard is not split. See .agents/design/chart-dashboard.md 3.13.
	Pages []Page        `json:"pages,omitempty"`
	Grid  *GridSettings `json:"grid,omitempty"`
}

// Page is one of the tabs a dashboard is split into, with a grid of its own.
// Its id is unique among the widgets' and tabs'.
type Page struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// How many pages a split dashboard has. With one left it is not split.
const (
	minPages = 2
	maxPages = 20
)

// The longest a page's name may be, in characters.
const maxPageName = 50

// GridSettings is optional: old dashboards keep the original rendering defaults.
type GridSettings struct {
	RowHeight    float64 `json:"rowHeight"`
	ColumnGap    float64 `json:"columnGap"`
	RowGap       float64 `json:"rowGap"`
	ContainerGap int     `json:"containerGap"`
	AutoCompact  bool    `json:"autoCompact"`
}

// Item is one widget: a box on the grid, with what it holds. X and W are in
// columns; Y and H are in rows.
type Item struct {
	// ID is unique in the dashboard; filters and interactions will refer to it.
	ID   string `json:"id"`
	Type string `json:"type"`
	// ChartID is the chart a chart widget holds; without one it is an empty
	// box, laid out before its chart is chosen.
	ChartID string `json:"chartId,omitempty"`
	X       int    `json:"x"`
	Y       int    `json:"y"`
	W       int    `json:"w"`
	H       int    `json:"h"`
	// A title shows the dashboard's own name and description when
	// UseDashboardName is set, and its Title and Subtitle otherwise. On a
	// chart widget, Title is the name it goes by on this dashboard instead
	// of the chart's own.
	UseDashboardName bool   `json:"useDashboardName,omitempty"`
	Title            string `json:"title,omitempty"`
	Subtitle         string `json:"subtitle,omitempty"`
	// Style is how a title sits in its widget; only titles have one.
	Style *TitleStyle `json:"style,omitempty"`
	// Markdown is a text widget's content. Clients render it without its HTML.
	Markdown string `json:"markdown,omitempty"`
	// Note is a chart widget's remark, shown when its question mark is
	// pointed at; HideHeader leaves the chart's name off when it is viewed.
	Note       string `json:"note,omitempty"`
	HideHeader bool   `json:"hideHeader,omitempty"`
	Frame      *Frame `json:"frame,omitempty"`
	// Tabs are the charts a tab container switches between. DefaultTab is
	// the one shown when the dashboard is opened; left out, the first is.
	Tabs       []Tab  `json:"tabs,omitempty"`
	DefaultTab string `json:"defaultTab,omitempty"`
	// Page is the page of a split dashboard the widget is on. Left out, it is
	// above the tabs, on every page; on a dashboard not split it is left out.
	Page string `json:"page,omitempty"`
}

// Tab is one of the charts in a tab container: a chart widget with no place
// or frame of its own, which filters, links and data requests name by its id
// as they name any other.
type Tab struct {
	ID      string `json:"id"`
	ChartID string `json:"chartId,omitempty"`
	Title   string `json:"title,omitempty"`
	Note    string `json:"note,omitempty"`
}

// widget is the chart widget the tab is.
func (t Tab) widget() Item {
	return Item{ID: t.ID, Type: ItemChart, ChartID: t.ChartID, Title: t.Title, Note: t.Note}
}

// TitleStyle places a title and its subtitle in the widget. Whatever is left
// out is the default: left, in the middle.
type TitleStyle struct {
	Align         string `json:"align,omitempty"`
	VerticalAlign string `json:"verticalAlign,omitempty"`
}

func (s TitleStyle) valid() bool {
	return oneOf(s.Align, "left", "center", "right") && oneOf(s.VerticalAlign, "top", "middle", "bottom")
}

// oneOf reports whether v is left out or one of allowed.
func oneOf(v string, allowed ...string) bool { return v == "" || slices.Contains(allowed, v) }

// Frame is how a widget's box looks. Whatever is left out follows the
// dashboard's Frame on charts and text, and the widget type's own look
// otherwise; so Border is false, true or left out, and so is Transparency.
type Frame struct {
	// Background is "default", the theme's surface, which the board has
	// too, where the dashboard's frame would give another; "neutral", a
	// light grey, or one of the Hues, which each
	// scheme tints in its own step; or a colour of the author's own, as
	// #rrggbb, shown as it is. It is the light scheme's, and the dark one's
	// too unless BackgroundDark, of the same kinds, says otherwise.
	Background     string `json:"background,omitempty"`
	BackgroundDark string `json:"backgroundDark,omitempty"`
	// Transparency is how far the background lets through what is behind
	// it, in percent: 0 is opaque, 100 lets everything through. It is the
	// same in both schemes.
	Transparency *int   `json:"transparency,omitempty"`
	Border       *bool  `json:"border,omitempty"`
	Padding      string `json:"padding,omitempty"`
}

func (f *Frame) validate(pairs []string) error {
	if f == nil {
		return nil
	}
	background := func(v string) bool {
		return oneOf(v, append([]string{"default", "neutral"}, Hues...)...) || hexColor(v)
	}
	if !background(f.Background) || !background(f.BackgroundDark) || !oneOf(f.Padding, "compact", "normal", "comfortable") ||
		(f.Transparency != nil && (*f.Transparency < 0 || *f.Transparency > 100)) {
		return bad("invalid_item_frame", pairs, "a frame takes known backgrounds, a transparency from 0 to 100 and a known padding")
	}
	return nil
}

// hexColor reports whether s is a colour written as # and six hex digits.
func hexColor(s string) bool {
	if len(s) != 7 || s[0] != '#' {
		return false
	}
	_, err := strconv.ParseUint(s[1:], 16, 32)
	return err == nil
}

// The kinds of widget. Only charts query anything; titles and text are
// written by the author and never take part in filters or links. A tab
// container queries nothing itself: its tabs are charts.
const (
	ItemChart = "chart"
	ItemTitle = "title"
	ItemText  = "text"
	ItemTabs  = "tabs"
)

// How many tabs a tab container has. With one left it is a chart widget again.
const (
	minTabs = 2
	maxTabs = 20
)

// The longest a title widget's title and subtitle, a chart widget's name
// and note and a text widget's content may be, in characters.
const (
	maxItemTitle    = 200
	maxItemSubtitle = 500
	maxItemNote     = 500
	maxItemMarkdown = 20000
)

// validateKind checks that the item has the properties of its type and no
// others, so a widget cannot hide a chart behind a title or the like.
func (item Item) validateKind() error {
	pairs := []string{"id", item.ID, "type", item.Type}
	fields := func() error {
		return bad("invalid_item_fields", pairs, "item %q has properties a %s does not take", item.ID, item.Type)
	}
	tooLong := func(limit int) error {
		return bad("item_text_too_long", append(pairs, "limit", strconv.Itoa(limit)), "item %q is longer than %d characters", item.ID, limit)
	}
	if item.Type != ItemTabs && (item.Tabs != nil || item.DefaultTab != "") {
		return fields()
	}
	switch item.Type {
	case ItemChart:
		if item.UseDashboardName || item.Subtitle != "" || item.Style != nil || item.Markdown != "" {
			return fields()
		}
		if utf8.RuneCountInString(item.Title) > maxItemTitle {
			return tooLong(maxItemTitle)
		}
		if utf8.RuneCountInString(item.Note) > maxItemNote {
			return tooLong(maxItemNote)
		}
	case ItemTitle:
		if item.ChartID != "" || item.Markdown != "" || item.Note != "" || item.HideHeader || (item.UseDashboardName && (item.Title != "" || item.Subtitle != "")) {
			return fields()
		}
		if utf8.RuneCountInString(item.Title) > maxItemTitle {
			return tooLong(maxItemTitle)
		}
		if utf8.RuneCountInString(item.Subtitle) > maxItemSubtitle {
			return tooLong(maxItemSubtitle)
		}
		if item.Style != nil && !item.Style.valid() {
			return bad("invalid_item_style", pairs, "item %q has a style a title cannot take", item.ID)
		}
	case ItemText:
		if item.ChartID != "" || item.UseDashboardName || item.Title != "" || item.Subtitle != "" || item.Style != nil || item.Note != "" || item.HideHeader {
			return fields()
		}
		if utf8.RuneCountInString(item.Markdown) > maxItemMarkdown {
			return tooLong(maxItemMarkdown)
		}
	case ItemTabs:
		// What a chart widget says about its chart, each tab says about its own.
		if item.ChartID != "" || item.UseDashboardName || item.Title != "" || item.Subtitle != "" || item.Style != nil || item.Markdown != "" || item.Note != "" || item.HideHeader {
			return fields()
		}
		if len(item.Tabs) < minTabs || len(item.Tabs) > maxTabs {
			return bad("invalid_tabs", append(pairs, "min", strconv.Itoa(minTabs), "max", strconv.Itoa(maxTabs)), "item %q has %d tabs, not %d to %d", item.ID, len(item.Tabs), minTabs, maxTabs)
		}
		for _, tab := range item.Tabs {
			if err := tab.widget().validateKind(); err != nil {
				return err
			}
		}
		if item.DefaultTab != "" && !slices.ContainsFunc(item.Tabs, func(t Tab) bool { return t.ID == item.DefaultTab }) {
			return bad("invalid_default_tab", append(pairs, "tab", item.DefaultTab), "item %q shows %q first, which is not one of its tabs", item.ID, item.DefaultTab)
		}
	default:
		return bad("invalid_item_type", pairs, "unknown item type %q", item.Type)
	}
	return item.Frame.validate(pairs)
}

// HoldsChart reports whether the item is a chart widget with its chart chosen.
func (item Item) HoldsChart() bool { return item.Type == ItemChart && item.ChartID != "" }

// IsChart reports whether the dashboard has a chart widget with the given id
// and a chart in it. Only charts can be filtered or linked.
func (s *DashboardSpec) IsChart(id string) bool {
	item, ok := s.ItemByID(id)
	return ok && item.HoldsChart()
}

// Validate checks the structure. Whether the charts exist is for the caller,
// who knows the workspace.
func (s *DashboardSpec) Validate() error {
	if s.QueryHeightMode != "" && s.QueryHeightMode != "auto" && s.QueryHeightMode != "manual" {
		return bad("invalid_query_height_mode", nil, "query height mode must be auto or manual")
	}
	if s.QueryMode != "" && s.QueryMode != "auto" && s.QueryMode != "manual" {
		return bad("invalid_query_mode", nil, "query mode must be auto or manual")
	}
	if s.AutoRefresh != 0 && !slices.Contains(AutoRefreshIntervals, s.AutoRefresh) {
		return bad("invalid_auto_refresh", nil, "auto refresh must be 60, 300, 900, 1800 or 3600 seconds")
	}
	if err := s.FilterStyle.Validate(); err != nil {
		return err
	}
	if err := s.Frame.validate(nil); err != nil {
		return err
	}
	if s.QueryContainer != nil {
		if err := s.QueryContainer.Frame.validate(nil); err != nil {
			return err
		}
	}
	if s.SpecVersion != CurrentSpecVersion {
		return bad("unsupported_spec_version", nil, "dashboard spec version %d is not supported", s.SpecVersion)
	}
	if s.Layout.Grid == nil {
		if s.Layout.Columns != GridColumns && s.Layout.Columns != 12 {
			return bad("invalid_layout", nil, "the grid must have %d columns", GridColumns)
		}
	} else {
		g := s.Layout.Grid
		validPixel := func(value, min, max float64) bool {
			return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= min && value <= max && math.Mod(value*2, 1) == 0
		}
		if s.Layout.Columns < 12 || s.Layout.Columns > 192 || !validPixel(g.RowHeight, 4, 64) || !validPixel(g.ColumnGap, 0, 24) || !validPixel(g.RowGap, 0, 24) || g.ContainerGap < 0 || g.ContainerGap > 24 {
			return bad("invalid_layout", nil, "invalid grid settings")
		}
	}
	if box := s.QueryContainer; box != nil {
		if box.X < 0 || box.Y < 0 || box.W < 1 || box.H < 1 || box.H > maxItemHeight || box.X+box.W > s.Layout.Columns {
			return bad("invalid_layout", nil, "query container does not fit the dashboard grid")
		}
	}
	// Tabs are named as widgets are, so their ids are unique among them all.
	seen := map[string]bool{}
	identify := func(id string) error {
		pairs := []string{"id", id}
		switch {
		case !dataset.ValidKey(id):
			return bad("invalid_item_id", pairs, "invalid item id %q", id)
		case seen[id]:
			return bad("duplicate_item_id", pairs, "item id %q is used twice", id)
		}
		seen[id] = true
		return nil
	}
	if s.Layout.Pages != nil && (len(s.Layout.Pages) < minPages || len(s.Layout.Pages) > maxPages) {
		return bad("invalid_pages", []string{"min", strconv.Itoa(minPages), "max", strconv.Itoa(maxPages)}, "a dashboard is split into %d to %d pages, not %d", minPages, maxPages, len(s.Layout.Pages))
	}
	pages := map[string]bool{}
	for _, page := range s.Layout.Pages {
		pairs := []string{"id", page.ID}
		if err := identify(page.ID); err != nil {
			return err
		}
		if strings.TrimSpace(page.Name) == "" {
			return bad("invalid_page_name", pairs, "page %q has no name", page.ID)
		}
		if utf8.RuneCountInString(page.Name) > maxPageName {
			return bad("item_text_too_long", append(pairs, "limit", strconv.Itoa(maxPageName)), "page %q is longer than %d characters", page.ID, maxPageName)
		}
		pages[page.ID] = true
	}
	for _, item := range s.Layout.Items {
		pairs := []string{"id", item.ID}
		if err := identify(item.ID); err != nil {
			return err
		}
		if err := item.validateKind(); err != nil {
			return err
		}
		if item.Page != "" && !pages[item.Page] {
			return bad("invalid_item_page", append(pairs, "page", item.Page), "item %q is on page %q, which the dashboard does not have", item.ID, item.Page)
		}
		switch {
		case item.W < 1 || item.H < 1 || item.H > maxItemHeight || item.X < 0 || item.Y < 0 || item.X+item.W > s.Layout.Columns:
			return bad("invalid_item_position", pairs, "item %q does not fit the grid: x=%s y=%s w=%s h=%s",
				item.ID, strconv.Itoa(item.X), strconv.Itoa(item.Y), strconv.Itoa(item.W), strconv.Itoa(item.H))
		}
		for _, tab := range item.Tabs {
			if err := identify(tab.ID); err != nil {
				return err
			}
		}
	}
	filters := map[string]bool{}
	for _, f := range s.Filters {
		pairs := []string{"id", f.ID}
		switch {
		case !dataset.ValidKey(f.ID):
			return bad("invalid_filter_id", pairs, "invalid filter id %q", f.ID)
		case filters[f.ID]:
			return bad("duplicate_filter_id", pairs, "filter id %q is used twice", f.ID)
		case strings.TrimSpace(f.Label) == "":
			return bad("filter_needs_label", pairs, "filter %q has no label", f.ID)
		case len(f.Targets) == 0:
			return bad("filter_needs_target", pairs, "filter %q applies to no chart", f.ID)
		}
		for _, t := range f.Targets {
			if !s.IsChart(t.Item) || targetKindCount(t) != 1 {
				return bad("invalid_filter_target", append(pairs, "item", t.Item), "filter %q targets %q, which is not a widget of the dashboard", f.ID, t.Item)
			}
		}
		if _, ok := f.OptionsTarget(); !ok {
			return bad("invalid_filter_options", append(pairs, "item", f.OptionsFrom), "filter %q takes its options from %q, which it does not target", f.ID, f.OptionsFrom)
		}
		filters[f.ID] = true
	}
	if err := s.validateLinks(); err != nil {
		return err
	}
	return s.validateCascadeGraph()
}

// ChartIDs lists the charts the dashboard shows, without duplicates.
func (s *DashboardSpec) ChartIDs() []string {
	return s.chartIDs(func(Item) bool { return true })
}

// ChartIDsOf lists the charts the given widgets show.
func (s *DashboardSpec) ChartIDsOf(items ...string) []string {
	return s.chartIDs(func(item Item) bool { return slices.Contains(items, item.ID) })
}

func (s *DashboardSpec) chartIDs(keep func(Item) bool) []string {
	seen := map[string]bool{}
	var ids []string
	for _, item := range s.Widgets() {
		if keep(item) && item.HoldsChart() && !seen[item.ChartID] {
			seen[item.ChartID] = true
			ids = append(ids, item.ChartID)
		}
	}
	return ids
}

// ScopedFilters returns the global filters with only their bindings on the
// given widgets, dropping filters that bind none of them. It lets one widget
// be checked without loading every chart of the dashboard.
func (s *DashboardSpec) ScopedFilters(items ...string) []Filter {
	var scoped []Filter
	for _, f := range s.Filters {
		var targets []FilterTarget
		for _, t := range f.Targets {
			if slices.Contains(items, t.Item) {
				targets = append(targets, t)
			}
		}
		if len(targets) > 0 {
			f.Targets = targets
			if !slices.ContainsFunc(targets, func(t FilterTarget) bool { return t.Item == f.OptionsFrom }) {
				f.OptionsFrom = ""
			}
			scoped = append(scoped, f)
		}
	}
	return pruneDependencies(scoped)
}

// And returns q with further conditions added. They can only narrow what the
// query returns, never widen it.
func And(q query.Query, conditions []dataset.Filter) query.Query {
	if len(conditions) == 0 {
		return q
	}
	args := conditions
	if q.Filter != nil {
		args = append([]dataset.Filter{*q.Filter}, conditions...)
	}
	q.Filter = &dataset.Filter{Op: "and", Args: args}
	return q
}
