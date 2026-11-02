package content

import (
	"slices"
	"strings"

	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/dialect"
	"github.com/supazd/supabi/internal/query"
)

// Link maps one displayed category to row fields on other dashboard widgets.
// Clients submit values by link ID, never fields, operations or time grains.
type Link struct {
	ID      string         `json:"id"`
	Label   string         `json:"label"`
	Source  LinkSource     `json:"source"`
	Targets []FilterTarget `json:"targets"`
}
type LinkSource struct {
	Item   string `json:"item"`
	Column string `json:"column"`
}

func (s *DashboardSpec) validateLinks() error {
	seen := map[string]bool{}
	for _, l := range s.Links {
		if !dataset.ValidKey(l.ID) || seen[l.ID] || strings.TrimSpace(l.Label) == "" || !s.IsChart(l.Source.Item) || l.Source.Column == "" || len(l.Targets) == 0 {
			return bad("invalid_link", []string{"id", l.ID}, "a link needs a unique ID, label, source column and targets")
		}
		seen[l.ID] = true
		targets := map[string]bool{}
		for _, t := range l.Targets {
			key := t.Item
			if !s.IsChart(t.Item) || t.Item == l.Source.Item || t.Field == "" || t.Measure != "" || t.Aggregation != "" || t.Filter != "" || targets[key] {
				return bad("invalid_link", []string{"id", l.ID}, "a link must target one row field per other widget")
			}
			targets[key] = true
		}
	}
	return nil
}

func linkColumn(c *ChartSpec, ds *dataset.Spec, column string) (dataset.Field, dialect.Grain, error) {
	invalid := func() (dataset.Field, dialect.Grain, error) {
		return dataset.Field{}, "", bad("invalid_link_source", nil, "link source must be a static displayed category of a bar, pie or table")
	}
	if c.Viz.Type != "bar" && c.Viz.Type != "hbar" && c.Viz.Type != "pie" && c.Viz.Type != "table" {
		return invalid()
	}
	if c.Viz.Type != "table" && c.Viz.X != column {
		return invalid()
	}
	for _, d := range c.Dynamics {
		if d.Alias == column {
			return invalid()
		}
	}
	field, grain := "", dialect.Grain("")
	if c.Query.Mode == query.ModeDetail {
		for _, col := range c.Query.Columns {
			if col.Field == column {
				field = col.Field
			}
		}
	} else {
		for _, d := range c.Query.Dimensions {
			if d.Name() == column {
				field, grain = d.Field, d.Grain
			}
		}
	}
	f, ok := ds.FieldByKey(field)
	if !ok || f.Role == dataset.Metric {
		return invalid()
	}
	return f, grain, nil
}

func (s *DashboardSpec) CheckLinks(chart func(string) (*ChartSpec, *dataset.Spec, bool)) error {
	for _, l := range s.Links {
		source, _ := s.ItemByID(l.Source.Item)
		c, ds, ok := chart(source.ChartID)
		if !ok {
			return bad("invalid_link_source", []string{"id", l.ID}, "link source chart is unavailable")
		}
		f, grain, err := linkColumn(c, ds, l.Source.Column)
		if err != nil {
			return withFilterID(err, l.ID)
		}
		for _, t := range l.Targets {
			item, _ := s.ItemByID(t.Item)
			target, targetDS, ok := chart(item.ChartID)
			if !ok {
				return bad("invalid_link_target", []string{"id", l.ID}, "link target chart is unavailable")
			}
			resolved, err := ResolveFilterTarget(target, targetDS, t)
			if err != nil {
				return withFilterID(err, l.ID)
			}
			same := f.Type == resolved.Type || f.Type.Temporal() && resolved.Type.Temporal()
			if resolved.Aggregate || !same || resolved.Type == datasource.Date && f.Type == datasource.Timestamp && (grain == "" || grain == dialect.Hour || grain == dialect.Minute) {
				return bad("invalid_link_target", []string{"id", l.ID}, "link fields must have compatible row types and time precision")
			}
		}
	}
	return nil
}

// LinkItems adds sources required to interpret a target widget's clicks.
func (s *DashboardSpec) LinkItems(items ...string) []string {
	out := slices.Clone(items)
	for _, l := range s.Links {
		for _, t := range l.Targets {
			if slices.Contains(items, t.Item) {
				out = append(out, l.Source.Item)
				break
			}
		}
	}
	return out
}
func (s *DashboardSpec) ScopedLinks(items ...string) []Link {
	var out []Link
	for _, l := range s.Links {
		targets := slices.DeleteFunc(slices.Clone(l.Targets), func(t FilterTarget) bool { return !slices.Contains(items, t.Item) })
		if len(targets) > 0 {
			l.Targets = targets
			out = append(out, l)
		}
	}
	return out
}

// ApplyLinks only appends conditions, including when global takeover is disabled.
func (s *DashboardSpec) ApplyLinks(q query.Query, itemID string, values map[string]any, chart func(string) (*ChartSpec, *dataset.Spec, bool), zone string, weekStart int) (query.Query, error) {
	for id := range values {
		if !slices.ContainsFunc(s.Links, func(l Link) bool { return l.ID == id }) {
			return q, bad("unknown_link", []string{"id", id}, "unknown dashboard link")
		}
	}
	var conditions []dataset.Filter
	for _, l := range s.Links {
		value, active := values[l.ID]
		if !active {
			continue
		}
		if !slices.ContainsFunc(l.Targets, func(t FilterTarget) bool { return t.Item == itemID }) {
			continue
		}
		source, _ := s.ItemByID(l.Source.Item)
		c, ds, ok := chart(source.ChartID)
		if !ok {
			return q, bad("invalid_link_source", nil, "link source is unavailable")
		}
		field, grain, err := linkColumn(c, ds, l.Source.Column)
		if err != nil {
			return q, err
		}
		sourceZone := c.Query.Timezone
		if sourceZone == "" {
			sourceZone = zone
		}
		targetZone := q.Timezone
		if targetZone == "" {
			targetZone = zone
		}
		for _, target := range l.Targets {
			if target.Item != itemID {
				continue
			}
			targetItem, _ := s.ItemByID(itemID)
			var targetType datasource.Type
			if _, targetDS, ok := chart(targetItem.ChartID); ok {
				tf, _ := targetDS.FieldByKey(target.Field)
				targetType = tf.Type
			}
			f, err := categoryCondition(target.Field, targetType, field, grain, value, sourceZone, targetZone, weekStart,
				bad("invalid_link_value", nil, "a category must be a scalar, null, or text for a date"))
			if err != nil {
				return q, err
			}
			conditions = append(conditions, f)
		}
	}
	return And(q, conditions), nil
}

// categoryCondition keeps the rows of the target field that match a clicked
// category of the source field, grouped by grain: its value, IS NULL for null,
// and for a date the period it stands for, read in sourceZone and compared in
// targetZone. Clicks only name scalars; anything else is invalid.
func categoryCondition(target string, targetType datasource.Type, source dataset.Field, grain dialect.Grain, value any, sourceZone, targetZone string, weekStart int, invalid error) (dataset.Filter, error) {
	f := dataset.Filter{Field: target, Op: "eq", Value: value}
	switch {
	case value == nil:
		f.Op = "is_null"
	case source.Type.Temporal():
		text, ok := value.(string)
		if !ok {
			return f, invalid
		}
		tr, err := query.CategoryTimeRange(text, grain, source.Type, targetType, sourceZone, targetZone, weekStart)
		if err != nil {
			return f, err
		}
		f.Op, f.Value = query.OpTime, tr
	default:
		switch value.(type) {
		case string, float64, bool, int, int64:
		default:
			return f, invalid
		}
	}
	return f, nil
}
