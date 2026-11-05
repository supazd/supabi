package content

import (
	"maps"
	"slices"
	"strconv"
	"unicode/utf8"

	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/query"
)

// Viz says how to draw a result. It refers to the query's output columns by
// alias, so it depends only on the shape of the result.
type Viz struct {
	Type string `json:"type"`
	// HiddenColumns are table output columns kept in the query but not displayed.
	HiddenColumns []string `json:"hiddenColumns,omitempty"`
	// ColumnGroups put headers above a table's adjacent columns, nested at
	// most three deep. See .agents/design/chart-dashboard.md §2.7.
	ColumnGroups []ColumnGroup `json:"columnGroups,omitempty"`
	// X is the category column: what runs along the axis, names a slice or a
	// funnel stage, names a point of a scatter chart or a tile of a treemap.
	X string `json:"x,omitempty"`
	// Y lists the measure columns. Apart from a combo chart's right axis, they
	// share one value axis.
	Y []string `json:"y,omitempty"`
	// Series is a dimension column whose values become separate series, each
	// with its colour: the groups of a treemap and the colours of a scatter chart.
	Series string `json:"series,omitempty"`
	// Rows and Columns are the dimension columns down the side and across the
	// top of a heatmap or a pivot table.
	Rows    []string `json:"rows,omitempty"`
	Columns []string `json:"columns,omitempty"`
	// Levels are a sankey diagram's dimension columns, left to right; the
	// measure flows from each level's values to the next's.
	Levels []string `json:"levels,omitempty"`
	// Compare pairs a KPI tile's measure with the measure it is compared
	// against, which is then not a tile of its own.
	Compare map[string]string `json:"compare,omitempty"`
	// Lines lists the measures of a combo chart drawn as lines; the others are bars.
	Lines []string `json:"lines,omitempty"`
	// RightAxis lists the measures of a combo chart read against a second
	// value axis, on the right.
	RightAxis []string `json:"rightAxis,omitempty"`
	Stacked   bool     `json:"stacked,omitempty"`
	// Formats overrides, by output column, how the dataset says a column's
	// numbers or dates are written. Each replaces the field's format whole.
	Formats map[string]dataset.Format `json:"formats,omitempty"`
	// Style is how the chart looks. It never changes what is drawn.
	Style *Style `json:"style,omitempty"`
}

// Style is the look of a chart. Every setting is optional, and absent means
// the default; a setting that does not apply to the chart's type is refused
// rather than kept unused, so a spec says only what it does.
type Style struct {
	// Legend is where the legend is: top, bottom, left or right, or none.
	// Without it, a chart with more than one series has one at the top.
	Legend string `json:"legend,omitempty"`
	// Labels writes values on the marks: value, percent (of the whole, for
	// shares) or none. Without it, shares are labelled with their percentage
	// and nothing else is labelled.
	Labels string `json:"labels,omitempty"`
	// Palette is the order the series colours are given in: fresh or warm.
	// Without it, the default order.
	Palette string `json:"palette,omitempty"`
	// Colors gives a measure a colour of the palette by its hue, in place of
	// the next one in order.
	Colors map[string]string `json:"colors,omitempty"`
	// Smooth curves lines; Points marks every value on them.
	Smooth bool `json:"smooth,omitempty"`
	Points bool `json:"points,omitempty"`
	// Percent stacks each category to the whole, showing shares.
	Percent bool `json:"percent,omitempty"`
	// Solid draws a pie whole, without the hole in the middle.
	Solid bool `json:"solid,omitempty"`
	// BarWidth is the widest a bar is drawn, in pixels.
	BarWidth int `json:"barWidth,omitempty"`
	// The axes by where they are on screen: a bar chart's value axis is Y, a
	// horizontal bar chart's is X. Y2 is a combo chart's right axis.
	XAxis  *Axis `json:"xAxis,omitempty"`
	YAxis  *Axis `json:"yAxis,omitempty"`
	Y2Axis *Axis `json:"y2Axis,omitempty"`
	// Gauge is the scale of a gauge without a target measure.
	Gauge *Range `json:"gauge,omitempty"`
	// NodeAlign puts a sankey diagram's nodes that end early at the left or
	// the right. Without it, every path runs to the last level.
	NodeAlign string `json:"nodeAlign,omitempty"`

	// A table's rows alternate in shade; Density is compact or comfortable;
	// Freeze keeps the first column in view while the rest scroll across.
	Striped bool   `json:"striped,omitempty"`
	Density string `json:"density,omitempty"`
	Freeze  bool   `json:"freeze,omitempty"`
	// Merge writes a run of equal values in a table's dimension columns once,
	// within the runs of the dimension columns to its left. A pivot table
	// always does this for its row dimensions.
	Merge bool `json:"merge,omitempty"`
	// Paging shows a table's rows a page at a time: pages of PageSize rows
	// (20 without it), or auto, as many as fit. Without it, every row.
	Paging   string `json:"paging,omitempty"`
	PageSize int    `json:"pageSize,omitempty"`
	// Widths fixes columns' widths in pixels, by output column.
	Widths map[string]int `json:"widths,omitempty"`
	// ColumnAlign lines a column's cells up left, center or right, by output
	// column. Without it, numbers are on the right and the rest on the left.
	ColumnAlign map[string]string `json:"columnAlign,omitempty"`
	// Highlights shade a number's cell by the first of its column's rules the
	// value meets, by output column. See .agents/design/chart-dashboard.md §2.8.
	Highlights map[string][]Highlight `json:"highlights,omitempty"`

	// A KPI's tiles stand left or center, and are small or large.
	TextAlign string `json:"textAlign,omitempty"`
	Size      string `json:"size,omitempty"`
	// CompareAs writes a comparison as a percent change (the default), a
	// difference, or both. RedUp shows a rise in red, as markets in China do.
	CompareAs string `json:"compareAs,omitempty"`
	RedUp     bool   `json:"redUp,omitempty"`
}

// Axis is how one axis is drawn.
type Axis struct {
	Title string `json:"title,omitempty"`
	// Min and Max fix the ends of a value axis, which otherwise follow the data.
	Min *float64 `json:"min,omitempty"`
	Max *float64 `json:"max,omitempty"`
	// Rotate turns a category axis's labels by 45 or 90 degrees.
	Rotate int `json:"rotate,omitempty"`
	// HideGrid leaves out a value axis's grid lines.
	HideGrid bool `json:"hideGrid,omitempty"`
	// HideLabels leaves out the axis's labels.
	HideLabels bool `json:"hideLabels,omitempty"`
}

// Highlight is a rule of a column's conditional format: a value that compares
// with Value by Op, as a query's filters do, has its cell shaded in Color,
// with Icon before the number when there is one. Value is the number as the
// query returns it, not as it is written.
type Highlight struct {
	Op    string   `json:"op"`
	Value *float64 `json:"value"`
	Color string   `json:"color"`
	// Icon is up, down or dot.
	Icon string `json:"icon,omitempty"`
}

// Range is a scale from Min to Max.
type Range struct {
	Min *float64 `json:"min,omitempty"`
	Max *float64 `json:"max,omitempty"`
}

const (
	Bar     = "bar"
	HBar    = "hbar"
	Line    = "line"
	Area    = "area"
	Combo   = "combo"
	Scatter = "scatter"
	Pie     = "pie"
	Funnel  = "funnel"
	Treemap = "treemap"
	Heatmap = "heatmap"
	Gauge   = "gauge"
	KPI     = "kpi"
	Table   = "table"
	Pivot   = "pivot"
	Sankey  = "sankey"
)

// Sankey levels: at least two to flow between, and few enough to read.
const maxSankeyLevels = 4

// Hues are the colours of the palette, by name; each scheme has its own step of each.
var Hues = []string{"blue", "orange", "aqua", "yellow", "magenta", "green", "violet", "red"}

const maxAxisTitle = 50

// maxPageSize is the most rows a page of a table holds.
const maxPageSize = 1000

// maxHighlights is the most rules a column's conditional format has; more
// bands than this read better as a colour scale.
const maxHighlights = 5

// types is a set of chart types.
type types []string

func (t types) has(v string) bool { return slices.Contains(t, v) }

var (
	cartesian      = types{Bar, HBar, Line, Area, Combo}
	legendTypes    = types{Bar, HBar, Line, Area, Combo, Scatter, Pie, Funnel, Treemap}
	labelTypes     = types{Bar, HBar, Line, Area, Combo, Scatter, Pie, Funnel, Treemap, Heatmap, Sankey}
	shareTypes     = types{Pie, Funnel, Treemap, Sankey}
	paletteTypes   = types{Bar, HBar, Line, Area, Combo, Scatter, Pie, Treemap, Sankey}
	lineTypes      = types{Line, Area, Combo}
	barTypes       = types{Bar, HBar, Combo}
	stackableTypes = types{Bar, HBar, Area}
	tableTypes     = types{Table, Pivot}
)

const (
	minColumnWidth = 40
	maxColumnWidth = 800
)

// axisKinds says, for a chart type, what kind each axis is: "value",
// "category", or "" where there is no such axis.
func axisKinds(t string) (x, y, y2 string) {
	switch t {
	case Bar, Line, Area:
		return "category", "value", ""
	case Combo:
		return "category", "value", "value"
	case HBar:
		return "value", "category", ""
	case Scatter:
		return "value", "value", ""
	case Heatmap:
		return "category", "category", ""
	}
	return "", "", ""
}

// Check holds a viz over columns that come from elsewhere, such as a chart in
// an answer of the assistant, to the rules a saved chart's viz is held to.
func (v Viz) Check(columns []query.OutputColumn) error { return v.validate(columns) }

func (v Viz) validate(columns []query.OutputColumn) error {
	roles := map[string]string{}
	for _, c := range columns {
		roles[c.Name] = c.Role
	}
	if err := v.validateFormats(columns); err != nil {
		return err
	}
	column := func(name, role, property string) error {
		switch roles[name] {
		case role:
			return nil
		case "":
			return bad("viz_unknown_column", []string{"column", name, "property", property}, "%s refers to %q, which the query does not return", property, name)
		}
		return bad("viz_wrong_role", []string{"column", name, "property", property, "role", role}, "%s must be a %s, but %q is not", property, role, name)
	}
	// measures checks y holds between least and most measures; most 0 is no limit.
	measures := func(least, most int) error {
		if len(v.Y) == 0 {
			return bad("viz_needs_measure", []string{"type", v.Type}, "a %s chart needs at least one measure", v.Type)
		}
		if least == 1 && most == 1 && len(v.Y) != 1 {
			return bad("viz_needs_one_measure", []string{"type", v.Type}, "a %s chart shows exactly one measure", v.Type)
		}
		if most == 0 && len(v.Y) < least {
			return bad("viz_measure_min", []string{"type", v.Type, "min", strconv.Itoa(least)}, "a %s chart needs at least %d measures", v.Type, least)
		}
		if len(v.Y) < least || (most > 0 && len(v.Y) > most) {
			return bad("viz_measure_count", []string{"type", v.Type, "min", strconv.Itoa(least), "max", strconv.Itoa(most)}, "a %s chart takes from %d to %d measures", v.Type, least, most)
		}
		for i, name := range v.Y {
			if slices.Contains(v.Y[:i], name) {
				return bad("viz_duplicate_column", []string{"column", name}, "%q is listed twice", name)
			}
			if err := column(name, "measure", "y"); err != nil {
				return err
			}
		}
		return nil
	}
	category := func() error {
		if v.X == "" {
			return bad("viz_needs_x", []string{"type", v.Type}, "a %s chart needs a category column", v.Type)
		}
		return column(v.X, "dimension", "x")
	}
	series := func() error {
		if v.Series == "" {
			return nil
		}
		if err := column(v.Series, "dimension", "series"); err != nil {
			return err
		}
		if v.Series == v.X {
			return bad("viz_duplicate_column", []string{"column", v.X}, "the category and the series cannot be the same column")
		}
		return nil
	}
	forbid := func(set bool, property string) error {
		if set {
			return bad("viz_not_applicable", []string{"property", property, "type", v.Type}, "%s does not apply to a %s chart", property, v.Type)
		}
		return nil
	}
	// Each type checks its own columns; what only some types have is refused on the others.
	only := func(property string, set bool, applies ...string) error {
		return forbid(set && !slices.Contains(applies, v.Type), property)
	}
	if err := cmpFirst(
		only("hiddenColumns", len(v.HiddenColumns) > 0, Table),
		only("columnGroups", len(v.ColumnGroups) > 0, Table),
		only("rows", len(v.Rows) > 0, Heatmap, Pivot),
		only("columns", len(v.Columns) > 0, Heatmap, Pivot),
		only("compare", len(v.Compare) > 0, KPI),
		only("levels", len(v.Levels) > 0, Sankey),
		only("lines", len(v.Lines) > 0, Combo),
		only("rightAxis", len(v.RightAxis) > 0, Combo),
		only("stacked", v.Stacked, stackableTypes...),
	); err != nil {
		return err
	}

	var err error
	switch v.Type {
	case Bar, HBar, Line, Area:
		err = cmpFirst(category(), measures(1, 0), series())
		if err == nil && v.Series != "" && len(v.Y) != 1 {
			err = bad("viz_series_needs_one_measure", nil, "splitting into series works with exactly one measure")
		}
	case Combo:
		err = cmpFirst(category(), measures(2, 0), forbid(v.Series != "", "series"), v.subsetOfY("lines", v.Lines), v.subsetOfY("rightAxis", v.RightAxis))
	case Scatter:
		err = cmpFirst(category(), measures(2, 3), series())
	case Pie, Funnel:
		err = cmpFirst(category(), measures(1, 1), forbid(v.Series != "", "series"))
	case Treemap:
		err = cmpFirst(category(), measures(1, 1), series())
	case Heatmap:
		one := func(property string, names []string) error {
			if len(names) != 1 {
				return bad("viz_needs_one_dimension", []string{"type", v.Type, "property", property}, "a heatmap has exactly one dimension in %s", property)
			}
			return column(names[0], "dimension", property)
		}
		err = cmpFirst(forbid(v.X != "", "x"), forbid(v.Series != "", "series"), one("rows", v.Rows), one("columns", v.Columns), measures(1, 1))
		if err == nil && v.Rows[0] == v.Columns[0] {
			err = bad("viz_duplicate_column", []string{"column", v.Rows[0]}, "the rows and the columns cannot be the same column")
		}
	case Gauge:
		err = cmpFirst(forbid(v.X != "", "x"), forbid(v.Series != "", "series"), measures(1, 2))
	case KPI:
		err = cmpFirst(forbid(v.X != "", "x"), forbid(v.Series != "", "series"), measures(1, 0))
		if err == nil {
			err = v.validateCompare()
		}
	case Sankey:
		err = cmpFirst(forbid(v.X != "", "x"), forbid(v.Series != "", "series"), measures(1, 1))
		if err != nil {
			break
		}
		if len(v.Levels) < 2 || len(v.Levels) > maxSankeyLevels {
			return bad("viz_sankey_levels", []string{"min", "2", "max", strconv.Itoa(maxSankeyLevels)}, "a sankey diagram has from 2 to %d levels", maxSankeyLevels)
		}
		for i, name := range v.Levels {
			if slices.Contains(v.Levels[:i], name) {
				return bad("viz_duplicate_column", []string{"column", name}, "%q is listed twice", name)
			}
			if err := column(name, "dimension", "levels"); err != nil {
				return err
			}
		}
		// A dimension left out would split the flows into rows that do not say where they go.
		for _, c := range columns {
			if c.Role == "dimension" && !slices.Contains(v.Levels, c.Name) {
				return bad("viz_sankey_unplaced", []string{"column", c.Name}, "%q is not a level of the sankey diagram", c.Name)
			}
		}
	case Pivot:
		err = cmpFirst(forbid(v.X != "", "x"), forbid(v.Series != "", "series"), measures(1, 0))
		if err != nil {
			break
		}
		// Every dimension is down the side or across the top, once; one left out would repeat the rows.
		placed := append(slices.Clone(v.Rows), v.Columns...)
		for i, name := range placed {
			if slices.Contains(placed[:i], name) {
				return bad("viz_duplicate_column", []string{"column", name}, "%q is listed twice", name)
			}
			property := "rows"
			if i >= len(v.Rows) {
				property = "columns"
			}
			if err := column(name, "dimension", property); err != nil {
				return err
			}
		}
		for _, c := range columns {
			if c.Role == "dimension" && !slices.Contains(placed, c.Name) {
				return bad("viz_pivot_unplaced", []string{"column", c.Name}, "%q is neither a row nor a column of the pivot table", c.Name)
			}
		}
		if len(placed) == 0 {
			return bad("viz_pivot_unplaced", nil, "a pivot table needs a dimension in its rows or its columns")
		}
	case Table:
		err = cmpFirst(forbid(v.X != "", "x"), forbid(len(v.Y) > 0, "y"), forbid(v.Series != "", "series"))
		for i, name := range v.HiddenColumns {
			if slices.Contains(v.HiddenColumns[:i], name) {
				return bad("viz_duplicate_column", []string{"column", name}, "%q is listed twice", name)
			}
			if _, exists := roles[name]; !exists {
				return bad("viz_unknown_column", []string{"column", name, "property", "hiddenColumns"}, "hiddenColumns refers to %q, which the query does not return", name)
			}
		}
		if len(v.HiddenColumns) > 0 && len(v.HiddenColumns) == len(columns) {
			return bad("viz_needs_visible_column", nil, "a table must display at least one column")
		}
		if err := v.validateColumnGroups(columns); err != nil {
			return err
		}
	default:
		return bad("viz_unknown_type", []string{"type", v.Type}, "unknown chart type %q", v.Type)
	}
	if err != nil {
		return err
	}
	return cmpFirst(v.validateStyle(roles), v.validateHighlights(columns))
}

// validateCompare checks that each comparison is between two measures of the
// tiles, and that a measure compared against is not itself compared.
func (v Viz) validateCompare() error {
	for _, tile := range slices.Sorted(maps.Keys(v.Compare)) {
		reference := v.Compare[tile]
		for _, name := range []string{tile, reference} {
			if !slices.Contains(v.Y, name) {
				return bad("viz_unknown_column", []string{"column", name, "property", "compare"}, "compare refers to %q, which is not a measure of the chart", name)
			}
		}
		if tile == reference {
			return bad("viz_invalid_compare", []string{"column", tile}, "%q cannot be compared with itself", tile)
		}
		if _, compared := v.Compare[reference]; compared {
			return bad("viz_invalid_compare", []string{"column", reference}, "%q is compared against, so it is not a tile to compare", reference)
		}
	}
	return nil
}

// subsetOfY checks that a list names measures of y, each once.
func (v Viz) subsetOfY(property string, names []string) error {
	for i, name := range names {
		if !slices.Contains(v.Y, name) {
			return bad("viz_unknown_column", []string{"column", name, "property", property}, "%s refers to %q, which is not a measure of the chart", property, name)
		}
		if slices.Contains(names[:i], name) {
			return bad("viz_duplicate_column", []string{"column", name}, "%q is listed twice", name)
		}
	}
	return nil
}

func (v Viz) validateStyle(roles map[string]string) error {
	s := v.Style
	if s == nil {
		return nil
	}
	notApplicable := func(property string) error {
		return bad("viz_not_applicable", []string{"property", "style." + property, "type", v.Type}, "style.%s does not apply to a %s chart", property, v.Type)
	}
	invalid := func(property string) error {
		return bad("viz_invalid_style", []string{"property", "style." + property}, "style.%s has a value it cannot have", property)
	}
	check := func(property string, set bool, applies types, valid bool) error {
		if !set {
			return nil
		}
		if !applies.has(v.Type) {
			return notApplicable(property)
		}
		if !valid {
			return invalid(property)
		}
		return nil
	}
	in := func(value string, allowed ...string) bool { return slices.Contains(allowed, value) }

	if err := cmpFirst(
		check("legend", s.Legend != "", legendTypes, in(s.Legend, "top", "bottom", "left", "right", "none")),
		check("labels", s.Labels != "", labelTypes, in(s.Labels, "value", "none") || (s.Labels == "percent" && shareTypes.has(v.Type))),
		check("palette", s.Palette != "", paletteTypes, in(s.Palette, "fresh", "warm")),
		// A colour is given to a measure; series made from a column's values take the palette's order.
		check("colors", len(s.Colors) > 0, cartesian, v.Series == ""),
		check("smooth", s.Smooth, lineTypes, true),
		check("points", s.Points, lineTypes, true),
		check("percent", s.Percent, stackableTypes, v.Stacked),
		check("solid", s.Solid, types{Pie}, true),
		check("barWidth", s.BarWidth != 0, barTypes, s.BarWidth >= 4 && s.BarWidth <= 80),
		check("nodeAlign", s.NodeAlign != "", types{Sankey}, in(s.NodeAlign, "left", "right")),
		check("striped", s.Striped, tableTypes, true),
		check("density", s.Density != "", tableTypes, in(s.Density, "compact", "comfortable")),
		check("freeze", s.Freeze, tableTypes, true),
		check("merge", s.Merge, types{Table}, true),
		check("paging", s.Paging != "", types{Table}, in(s.Paging, "pages", "auto")),
		// A page size means something only for pages of a size.
		check("pageSize", s.PageSize != 0, types{Table}, s.Paging == "pages" && s.PageSize >= 1 && s.PageSize <= maxPageSize),
		check("widths", len(s.Widths) > 0, tableTypes, true),
		check("columnAlign", len(s.ColumnAlign) > 0, tableTypes, true),
		check("highlights", len(s.Highlights) > 0, tableTypes, true),
		check("textAlign", s.TextAlign != "", types{KPI}, in(s.TextAlign, "left", "center")),
		check("size", s.Size != "", types{KPI}, in(s.Size, "small", "large")),
		// How a comparison is written only means something where there is one.
		check("compareAs", s.CompareAs != "", types{KPI}, len(v.Compare) > 0 && in(s.CompareAs, "percent", "diff", "both")),
		check("redUp", s.RedUp, types{KPI}, len(v.Compare) > 0),
	); err != nil {
		return err
	}
	for _, name := range slices.Sorted(maps.Keys(s.Widths)) {
		if roles[name] == "" {
			return bad("viz_unknown_column", []string{"column", name, "property", "style.widths"}, "style.widths refers to %q, which the query does not return", name)
		}
		if w := s.Widths[name]; w < minColumnWidth || w > maxColumnWidth {
			return invalid("widths")
		}
	}
	for _, name := range slices.Sorted(maps.Keys(s.ColumnAlign)) {
		if roles[name] == "" {
			return bad("viz_unknown_column", []string{"column", name, "property", "style.columnAlign"}, "style.columnAlign refers to %q, which the query does not return", name)
		}
		if !in(s.ColumnAlign[name], "left", "center", "right") {
			return invalid("columnAlign")
		}
	}
	for _, name := range slices.Sorted(maps.Keys(s.Colors)) {
		if !slices.Contains(v.Y, name) {
			return bad("viz_unknown_column", []string{"column", name, "property", "style.colors"}, "style.colors refers to %q, which is not a measure of the chart", name)
		}
		if !slices.Contains(Hues, s.Colors[name]) {
			return invalid("colors")
		}
	}
	x, y, y2 := axisKinds(v.Type)
	for _, a := range []struct {
		property, kind string
		axis           *Axis
	}{{"xAxis", x, s.XAxis}, {"yAxis", y, s.YAxis}, {"y2Axis", y2, s.Y2Axis}} {
		if a.axis == nil {
			continue
		}
		if a.kind == "" {
			return notApplicable(a.property)
		}
		ax := a.axis
		value := a.kind == "value"
		switch {
		case utf8.RuneCountInString(ax.Title) > maxAxisTitle:
			return invalid(a.property + ".title")
		case !value && (ax.Min != nil || ax.Max != nil):
			return notApplicable(a.property + ".min")
		case ax.Min != nil && ax.Max != nil && *ax.Min >= *ax.Max:
			return invalid(a.property + ".max")
		case value && ax.Rotate != 0:
			return notApplicable(a.property + ".rotate")
		case !in(strconv.Itoa(ax.Rotate), "0", "45", "90"):
			return invalid(a.property + ".rotate")
		case !value && ax.HideGrid:
			return notApplicable(a.property + ".hideGrid")
		}
	}
	if g := s.Gauge; g != nil {
		switch {
		case v.Type != Gauge:
			return notApplicable("gauge")
		// With a target, the target is where the scale ends.
		case g.Max != nil && len(v.Y) > 1:
			return notApplicable("gauge.max")
		case g.Min != nil && g.Max != nil && *g.Min >= *g.Max:
			return invalid("gauge.max")
		}
	}
	return nil
}

// validateHighlights checks that each conditional format is on a number the
// query returns, a measure of a pivot table, with from one to maxHighlights
// valid rules. Whether the chart can have them at all is validateStyle's.
func (v Viz) validateHighlights(columns []query.OutputColumn) error {
	if v.Style == nil {
		return nil
	}
	invalid := bad("viz_invalid_style", []string{"property", "style.highlights"}, "style.highlights has a value it cannot have")
	for _, name := range slices.Sorted(maps.Keys(v.Style.Highlights)) {
		i := slices.IndexFunc(columns, func(c query.OutputColumn) bool { return c.Name == name })
		switch {
		case i < 0:
			return bad("viz_unknown_column", []string{"column", name, "property", "style.highlights"}, "style.highlights refers to %q, which the query does not return", name)
		case !columns[i].Type.Numeric():
			return bad("viz_highlight_not_supported", []string{"column", name}, "%q is not a number, so it has no conditional format", name)
		// A pivot table's dimensions are its headers, not its cells.
		case v.Type == Pivot && !slices.Contains(v.Y, name):
			return bad("viz_wrong_role", []string{"column", name, "property", "style.highlights", "role", "measure"}, "style.highlights must be on a measure, but %q is not", name)
		}
		rules := v.Style.Highlights[name]
		if len(rules) == 0 || len(rules) > maxHighlights {
			return invalid
		}
		for _, rule := range rules {
			if !slices.Contains([]string{"lt", "lte", "gt", "gte", "eq", "ne"}, rule.Op) || rule.Value == nil || !slices.Contains(Hues, rule.Color) || !slices.Contains([]string{"", "up", "down", "dot"}, rule.Icon) {
				return invalid
			}
		}
	}
	return nil
}

// validateFormats checks that each format is set on a number or a date the
// query returns, and is valid for it.
func (v Viz) validateFormats(columns []query.OutputColumn) error {
	for _, name := range slices.Sorted(maps.Keys(v.Formats)) {
		i := slices.IndexFunc(columns, func(c query.OutputColumn) bool { return c.Name == name })
		if i < 0 {
			return bad("viz_unknown_column", []string{"column", name, "property", "formats"}, "formats refers to %q, which the query does not return", name)
		}
		if !dataset.Formattable(columns[i].Type) {
			return bad("viz_format_not_supported", []string{"column", name}, "%q is neither a number nor a date, so it has no display format", name)
		}
		format := v.Formats[name]
		if property := format.Problem(columns[i].Type); property != "" {
			return bad("viz_invalid_format", []string{"column", name, "property", property}, "the display format of %q has an invalid %s", name, property)
		}
	}
	return nil
}

func cmpFirst(errs ...error) error {
	for _, err := range errs {
		if err != nil {
			return err
		}
	}
	return nil
}
