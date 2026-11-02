package content

import (
	"strings"

	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/query"
)

// ChartFilter is a condition on a chart. Time ranges are filters like any
// other: a "time" condition on a date field.
//
// Without a control it is fixed: viewers neither see nor change it. With one,
// viewers choose the value. Dashboard bindings refer directly to dataset
// fields or chart measures, independently of these controls.
//
// A filter naming a Param instead of a Field gives a dataset parameter its
// value; see param.go.
type ChartFilter struct {
	// ID is unique in the chart and identifies viewer values.
	ID          string      `json:"id"`
	Field       string      `json:"field,omitempty"`
	Param       string      `json:"param,omitempty"`
	Op          string      `json:"op,omitempty"`
	Aggregation dataset.Agg `json:"aggregation,omitempty"`
	DependsOn   []string    `json:"dependsOn,omitempty"`
	// Value is the condition's value. With a control it is what a viewer
	// starts with, and empty means no restriction.
	Value any `json:"value,omitempty"`
	// ValueSet says a parameter filter's Value was written, even as null:
	// left out, the parameter keeps the dataset's default.
	ValueSet bool `json:"-"`
	// Options are what a parameter filter's dropdown offers.
	Options []any    `json:"options,omitempty"`
	Label   string   `json:"label,omitempty"`
	Control *Control `json:"control,omitempty"`
	// Exposed is accepted for compatibility with older saved charts.
	Exposed bool `json:"exposed,omitempty"`
}

// Control is how a viewer fills in a filter's value. Which ones fit depends
// on the condition and on the field's type.
type Control struct {
	Type string `json:"type"`
	// Multi lets a select take several values.
	Multi bool `json:"multi,omitempty"`
}

const (
	ControlSelect       = "select"
	ControlSearchSelect = "search_select"
	ControlTiles        = "tiles"
	ControlText         = "text"
	ControlNumberRange  = "number_range"
	ControlNumber       = "number"
	ControlDate         = "date"
	ControlDateRange    = "date_range"
	ControlRelative     = "relative"
)

// fits reports whether the control can fill in a condition of this kind on a
// field of this type.
func (c Control) fits(op string, t datasource.Type) bool {
	switch c.Type {
	case ControlSelect, ControlSearchSelect, ControlTiles:
		return (op == "in" || op == "not_in") && !t.Temporal()
	case ControlText:
		return (op == "eq" || op == "ne" || op == "contains" || op == "not_contains" || op == "starts_with" || op == "ends_with" || op == "like" || op == "not_like") && t == datasource.String
	case ControlNumber:
		return (op == "eq" || op == "ne" || op == "gt" || op == "gte" || op == "lt" || op == "lte") && t.Numeric()
	case ControlNumberRange:
		return (op == "between" || op == "not_between") && t.Numeric()
	case ControlDate, ControlDateRange, ControlRelative:
		return op == query.OpTime && t.Temporal()
	}
	return false
}

// aggregateFits allows controls whose values do not need row-level option
// enumeration. Boolean aggregates have a fixed, exhaustive true/false choice.
func (c Control) aggregateFits(op string, t datasource.Type) bool {
	if !c.fits(op, t) {
		return false
	}
	switch {
	case t.Numeric():
		return c.Type == ControlNumber || c.Type == ControlNumberRange
	case t.Temporal():
		return c.Type == ControlDate || c.Type == ControlDateRange || c.Type == ControlRelative
	case t == datasource.String:
		return c.Type == ControlText
	case t == datasource.Boolean:
		return c.Type == ControlSelect || c.Type == ControlSearchSelect || c.Type == ControlTiles
	}
	return false
}

// Interactive reports whether viewers can change the filter's value.
func (f ChartFilter) Interactive() bool { return f.Control != nil }

// Condition returns the filter as a condition of a query, given the value in
// force. It reports false when the value is empty, which restricts nothing.
func (f ChartFilter) Condition(value any) (dataset.Filter, bool, error) {
	out := dataset.Filter{Field: f.Field, Op: f.Op, Value: value}
	invalid := func(format string, a ...any) (dataset.Filter, bool, error) {
		return out, false, bad("invalid_filter_value", []string{"id", f.ID, "op", f.Op}, "filter %q: "+format, append([]any{f.ID}, a...)...)
	}
	switch f.Op {
	case "is_null", "not_null", "is_empty", "not_empty":
		out.Value = nil
		return out, true, nil
	case "in", "not_in":
		items, ok := value.([]any)
		if value != nil && !ok {
			return invalid("%s needs a list", f.Op)
		}
		if f.Control != nil && !f.Control.Multi && len(items) > 1 {
			return invalid("it takes a single value")
		}
		return out, len(items) > 0, nil
	case "between", "not_between":
		if value == nil {
			return out, false, nil
		}
		items, ok := value.([]any)
		includeLow, includeHigh := true, true
		if object, objectOK := value.(map[string]any); objectOK {
			for key := range object {
				if key != "min" && key != "max" && key != "includeMin" && key != "includeMax" {
					return invalid("unknown range property %q", key)
				}
			}
			if v, exists := object["includeMin"]; exists {
				var valid bool
				includeLow, valid = v.(bool)
				if !valid {
					return invalid("includeMin must be boolean")
				}
			}
			if v, exists := object["includeMax"]; exists {
				var valid bool
				includeHigh, valid = v.(bool)
				if !valid {
					return invalid("includeMax must be boolean")
				}
			}
			items, ok = []any{object["min"], object["max"]}, true
		}
		if !ok || len(items) != 2 {
			return invalid("a range needs two values")
		}
		// Either side may be left open.
		switch low, high := items[0], items[1]; {
		case low == nil && high == nil:
			return out, false, nil
		case low == nil:
			out.Op, out.Value = "lte", high
			if !includeHigh {
				out.Op = "lt"
			}
		case high == nil:
			out.Op, out.Value = "gte", low
			if !includeLow {
				out.Op = "gt"
			}
		}
		if f.Op == "not_between" && out.Op != "not_between" {
			out.Op = map[string]string{"lte": "gt", "lt": "gte", "gte": "lt", "gt": "lte"}[out.Op]
		}
		return out, true, nil
	case query.OpTime:
		if value == nil {
			return out, false, nil
		}
		if object, ok := value.(map[string]any); ok {
			// What qualifies an interval says nothing without one: a range
			// edited by month with no months chosen yet restricts nothing.
			for key, part := range object {
				if bounds, isBounds := part.(map[string]any); key == "bounds" && isBounds && len(bounds) == 0 {
					continue
				}
				if !timeQualifiers[key] {
					return out, true, nil
				}
			}
			return out, false, nil
		}
		return out, true, nil
	}
	if text, ok := value.(string); value == nil || (ok && text == "") {
		return out, false, nil
	}
	return out, true, nil
}

// timeQualifiers are the parts of a time range that qualify its interval and
// are none of their own.
var timeQualifiers = map[string]bool{"includeCurrent": true, "includeNull": true, "grain": true, "weekStart": true}

// FilterByID returns the chart's filter with the given id.
func (s *ChartSpec) FilterByID(id string) (ChartFilter, bool) {
	for _, f := range s.Filters {
		if f.ID == id {
			return f, true
		}
	}
	return ChartFilter{}, false
}

// checkViewerValues makes sure a viewer set only filters they are offered,
// and gave parameters values they may.
func (s *ChartSpec) checkViewerValues(values map[string]any, ds *dataset.Spec) error {
	for id, value := range values {
		f, ok := s.FilterByID(id)
		if !ok || !f.Interactive() {
			return bad("filter_not_interactive", []string{"id", id}, "the chart has no filter %q for viewers to set", id)
		}
		if f.IsParam() {
			if err := f.checkViewerParam(value, ds); err != nil {
				return err
			}
		}
	}
	return nil
}

// Filtered returns the chart's query with its filters applied. Values are
// taken as they are: whether a viewer may set them is for ForViewer.
func (s *ChartSpec) Filtered(values map[string]any, ds *dataset.Spec) (query.Query, error) {
	c := conditions{q: s.Query}
	for _, f := range s.Filters {
		if f.IsParam() {
			continue
		}
		value := f.Value
		if chosen, ok := values[f.ID]; ok {
			value = chosen
		}
		target, err := ResolveFilterTarget(s, ds, FilterTarget{Field: f.Field, Aggregation: f.Aggregation})
		if err != nil {
			return s.Query, err
		}
		if err := c.add(f, target, value); err != nil {
			return s.Query, err
		}
	}
	return s.withParams(c.query(), values), nil
}

// validateFilters checks the filters' structure against the dataset. That
// their values are of the right type is left to compiling the query.
func (s *ChartSpec) validateFilters(ds *dataset.Spec) error {
	seen := map[string]bool{}
	params := map[string]bool{}
	var needs map[string]bool
	for _, f := range s.Filters {
		pairs := []string{"id", f.ID}
		switch {
		case !dataset.ValidKey(f.ID):
			return bad("invalid_filter_id", pairs, "invalid filter id %q", f.ID)
		case seen[f.ID]:
			return bad("duplicate_filter_id", pairs, "filter id %q is used twice", f.ID)
		case f.Op == "and" || f.Op == "or" || f.Op == "not":
			return bad("invalid_filter", append(pairs, "op", f.Op), "filter %q must be a single condition", f.ID)
		}
		seen[f.ID] = true
		if f.IsParam() {
			if needs == nil {
				needs = ds.ParamsRequiringInput(false)
			}
			if err := s.validateParamFilter(f, ds, params, needs); err != nil {
				return err
			}
			continue
		}
		field, ok := ds.FieldByKey(f.Field)
		switch {
		case !ok:
			return bad("unknown_field", []string{"key", f.Field}, "the dataset has no field %q", f.Field)
		}
		if f.Aggregation != "" && (field.Role != dataset.MeasureRole || !field.Type.Numeric()) {
			return bad("invalid_filter_target", pairs, "chart filter aggregation requires a numeric measure")
		}
		_, restricts, err := f.Condition(f.Value)
		if err != nil {
			return err
		}
		target, err := ResolveFilterTarget(s, ds, FilterTarget{Field: f.Field, Aggregation: f.Aggregation})
		if err != nil {
			return err
		}
		if f.Control == nil {
			switch {
			case !restricts:
				return bad("filter_needs_value", pairs, "filter %q is fixed, so it needs a value", f.ID)
			}
			continue
		}
		if strings.TrimSpace(f.Label) == "" {
			return bad("filter_needs_label", pairs, "filter %q has no label", f.ID)
		}
		if !f.Control.fits(f.Op, target.Type) || (target.Aggregate && !f.Control.aggregateFits(f.Op, target.Type)) {
			return bad("invalid_filter_control", append(pairs, "control", f.Control.Type, "op", f.Op, "type", string(field.Type)),
				"control %q cannot fill in a %q condition on %s field %q", f.Control.Type, f.Op, field.Type, field.Label)
		}
	}
	return s.validateCascade(ds)
}

// ForViewer returns the chart's query as a viewer asks for it, with the
// values they chose for its interactive filters.
func (s *ChartSpec) ForViewer(values map[string]any, ds *dataset.Spec) (query.Query, error) {
	if err := s.checkViewerValues(values, ds); err != nil {
		return s.Query, err
	}
	return s.Filtered(values, ds)
}
