package content

import (
	"errors"
	"maps"
	"slices"

	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/dialect"
	"github.com/supazd/supabi/internal/query"
)

// Drill lets viewers step down a hierarchy the author lays out below one of
// the chart's dimensions: clicking a value shows the next level within it.
// Viewers submit the values clicked, never fields. See
// .agents/design/chart-dashboard.md §2.10.
type Drill struct {
	// Alias is the output name of the query dimension that is the first level.
	Alias  string       `json:"alias"`
	Levels []DrillLevel `json:"levels"`
}

// DrillLevel is a level below the first: a dataset dimension, at a grain for a date.
type DrillLevel struct {
	Field string        `json:"field"`
	Grain dialect.Grain `json:"grain,omitempty"`
	// Label names the column at this level; dashboard viewers cannot read the dataset.
	Label string `json:"label,omitempty"`
}

// maxDrillLevels is how many levels a drill has below the first.
const maxDrillLevels = 7

// drillTypes are the charts where a click picks a value of the drilled column.
var drillTypes = []string{Bar, HBar, Line, Area, Combo, Pie, Table}

// Drilled is the chart at the level path leads to, with the conditions that
// keep it within the values clicked on the way there, for the caller to
// append after every other condition. path holds one raw value for each level
// from the first, dates written as results write them. An empty path is the
// chart as saved.
func (s *ChartSpec) Drilled(path []any, ds *dataset.Spec, zone string, weekStart int) (ChartSpec, []dataset.Filter, error) {
	if len(path) == 0 {
		return *s, nil, nil
	}
	invalid := bad("invalid_drill", nil, "the chart cannot be drilled along that path")
	if s.Drill == nil || len(path) > len(s.Drill.Levels) {
		return *s, nil, invalid
	}
	if s.Query.Timezone != "" {
		zone = s.Query.Timezone
	}
	var conditions []dataset.Filter
	for i, value := range path {
		level, ok := s.drillLevel(i)
		if !ok {
			return *s, nil, invalid
		}
		field, ok := ds.FieldByKey(level.Field)
		if !ok {
			return *s, nil, bad("unknown_field", []string{"key", level.Field}, "the drill names an unknown dataset field")
		}
		condition, err := categoryCondition(level.Field, field.Type, field, level.Grain, value, zone, zone, weekStart, invalid)
		var e *dataset.Error
		if errors.As(err, &e) && (e.Code == "invalid_time_value" || e.Code == "invalid_link_value") {
			return *s, nil, invalid
		}
		if err != nil {
			return *s, nil, err
		}
		conditions = append(conditions, condition)
	}
	return s.atLevel(len(path), ds), conditions, nil
}

// drillLevel is level n of the drill as a dimension, the first being the
// query's own.
func (s *ChartSpec) drillLevel(n int) (query.Dimension, bool) {
	if n == 0 {
		at := slices.IndexFunc(s.Query.Dimensions, func(d query.Dimension) bool { return d.Name() == s.Drill.Alias })
		if at < 0 {
			return query.Dimension{}, false
		}
		return s.Query.Dimensions[at], true
	}
	level := s.Drill.Levels[n-1]
	return query.Dimension{Field: level.Field, Grain: level.Grain, Alias: s.Drill.Alias, Label: level.Label}, true
}

// atLevel groups the chart by level n of its drill in place of the first,
// under the same output name, so that everything naming the column still does.
func (s *ChartSpec) atLevel(n int, ds *dataset.Spec) ChartSpec {
	out := *s
	if n == 0 {
		return out
	}
	alias := s.Drill.Alias
	level, _ := s.drillLevel(n)
	out.Query.Dimensions = slices.Clone(s.Query.Dimensions)
	for i, d := range out.Query.Dimensions {
		if d.Name() == alias {
			out.Query.Dimensions[i] = level
		}
	}
	// The chart's own display and conditional formats for the column hold
	// only while the level is of a type they suit.
	field, _ := ds.FieldByKey(level.Field)
	if format, ok := s.Viz.Formats[alias]; ok && (!dataset.Formattable(field.Type) || format.Problem(field.Type) != "") {
		out.Viz.Formats = maps.Clone(s.Viz.Formats)
		delete(out.Viz.Formats, alias)
	}
	if style := s.Viz.Style; style != nil && style.Highlights[alias] != nil && !field.Type.Numeric() {
		kept := *style
		kept.Highlights = maps.Clone(style.Highlights)
		delete(kept.Highlights, alias)
		out.Viz.Style = &kept
	}
	return out
}

func (s *ChartSpec) validateDrill(ds *dataset.Spec, d dialect.Dialect) error {
	drill := s.Drill
	if drill == nil {
		return nil
	}
	invalid := func(format string, a ...any) error {
		return bad("invalid_drill", []string{"alias", drill.Alias}, format, a...)
	}
	if s.Query.Mode == query.ModeDetail || !slices.Contains(drillTypes, s.Viz.Type) {
		return invalid("only bar, line, area, combo and pie charts and aggregate tables can be drilled")
	}
	if len(drill.Levels) == 0 || len(drill.Levels) > maxDrillLevels {
		return invalid("a drill has 1 to %d levels below the first", maxDrillLevels)
	}
	// A dynamic dimension changes field itself; the next level would follow which choice?
	if slices.ContainsFunc(s.Dynamics, func(dynamic DynamicField) bool { return dynamic.Alias == drill.Alias }) {
		return invalid("a dynamic dimension cannot be drilled")
	}
	first, ok := s.drillLevel(0)
	if !ok {
		return invalid("%q is not a dimension of the query", drill.Alias)
	}
	if s.Viz.Type == Table && slices.Contains(s.Viz.HiddenColumns, drill.Alias) {
		return invalid("a hidden column cannot be clicked, so cannot be drilled")
	}
	if s.Viz.Type != Table && s.Viz.X != drill.Alias {
		return invalid("only the category axis can be drilled")
	}
	// Two levels alike, or a level that is another column, would show the same column twice.
	type grouping struct {
		field string
		grain dialect.Grain
	}
	seen := map[grouping]bool{}
	for _, dim := range s.Query.Dimensions {
		seen[grouping{dim.Field, dim.Grain}] = true
	}
	above := first
	for _, level := range drill.Levels {
		field, ok := ds.FieldByKey(level.Field)
		if !ok {
			return bad("unknown_field", []string{"key", level.Field}, "the drill names an unknown dataset field")
		}
		if field.Role != dataset.Dimension {
			return invalid("each level must be a dimension of the dataset")
		}
		if level.Grain != "" && !field.Type.Temporal() {
			return invalid("only a date has a grain")
		}
		if seen[grouping{level.Field, level.Grain}] {
			return invalid("levels must differ from each other and from the query's other dimensions")
		}
		seen[grouping{level.Field, level.Grain}] = true
		if level.Field == above.Field && !within(above.Grain, level.Grain) {
			return invalid("each period of a date's level must fall within one period of the level above")
		}
		above = query.Dimension{Field: level.Field, Grain: level.Grain}
	}
	// Every level is compiled, so that a chart does not fail only once clicked.
	resolved, err := s.ResolveDynamics(nil)
	if err != nil {
		return err
	}
	for n := range drill.Levels {
		at := resolved.atLevel(n+1, ds)
		if err := at.validateBase(ds, d); err != nil {
			return err
		}
	}
	return nil
}

// within says whether every period of the inner grain falls within one of
// the outer: a week runs across months and years, so it holds days, but no
// month holds it.
func within(outer, inner dialect.Grain) bool {
	if outer == dialect.Week {
		return slices.Contains([]dialect.Grain{dialect.Day, dialect.Hour, dialect.Minute}, inner)
	}
	nested := []dialect.Grain{dialect.Year, dialect.Quarter, dialect.Month, dialect.Day, dialect.Hour, dialect.Minute}
	i, j := slices.Index(nested, outer), slices.Index(nested, inner)
	return i >= 0 && j > i
}
