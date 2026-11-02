package content

import (
	"errors"
	"strconv"

	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/query"
)

// ResolvedFilterTarget describes the query operand behind a saved binding.
// Identity includes its row/aggregate semantics, independently of output aliases.
type ResolvedFilterTarget struct {
	Field     string
	Measure   query.Measure
	Type      datasource.Type
	Aggregate bool
	Identity  string
}

func targetKindCount(t FilterTarget) int {
	n := 0
	for _, value := range []string{t.Field, t.Measure, t.Filter} {
		if value != "" {
			n++
		}
	}
	return n
}

// ResolveFilterTarget accepts direct field bindings and legacy chart-filter references.
func ResolveFilterTarget(chart *ChartSpec, ds *dataset.Spec, target FilterTarget) (ResolvedFilterTarget, error) {
	var out ResolvedFilterTarget
	if targetKindCount(target) != 1 {
		return out, bad("invalid_filter_target", []string{"item", target.Item}, "a filter target must name exactly one field or measure")
	}
	if target.Aggregation != "" && target.Field == "" {
		return out, bad("invalid_filter_target", nil, "aggregation requires a dataset field")
	}
	if target.Filter != "" {
		legacy, ok := chart.FilterByID(target.Filter)
		if !ok || legacy.IsParam() {
			return out, bad("invalid_filter_target", []string{"filter", target.Filter}, "the chart has no field filter %q", target.Filter)
		}
		target.Field, target.Filter = legacy.Field, ""
	}
	if target.Field != "" {
		field, ok := ds.FieldByKey(target.Field)
		if !ok {
			return out, bad("unknown_field", []string{"key", target.Field, "dataset", chart.Query.Dataset}, "the dataset has no field %q", target.Field)
		}
		out.Field, out.Type = field.Key, field.Type
		out.Aggregate = field.Role == dataset.Metric
		out.Identity = "field:" + field.Key
		if out.Aggregate {
			out.Measure = query.Measure{Field: field.Key}
			out.Identity = "metric:" + field.Key
		}
		if target.Aggregation != "" {
			if field.Role == dataset.Metric || !target.Aggregation.Valid() {
				return out, bad("invalid_filter_target", []string{"key", field.Key}, "explicit filter aggregation requires a row-level field")
			}
			if err := dataset.CheckAgg(target.Aggregation, field); err != nil {
				return out, err
			}
			out.Aggregate, out.Type = true, target.Aggregation.ResultType(field.Type)
			out.Measure = query.Measure{Field: field.Key, Agg: target.Aggregation}
			out.Identity = "aggregate:" + string(target.Aggregation) + ":" + field.Key
		}
	} else {
		found := false
		for _, m := range chart.Query.Measures {
			if m.Name() != target.Measure {
				continue
			}
			found = true
			if m.Compute != nil || m.Field == "" {
				return out, bad("invalid_measure", []string{"alias", target.Measure}, "filter targets need a field and its aggregation")
			}
			out.Measure, out.Aggregate = m, true
			key := m.Field
			field, ok := ds.FieldByKey(key)
			if !ok {
				return out, bad("unknown_field", []string{"key", key, "dataset", chart.Query.Dataset}, "the dataset has no field %q", key)
			}
			out.Field = key
			switch {
			case field.Role == dataset.Metric:
				if m.Agg != "" {
					return out, bad("metric_agg", []string{"key", key, "label", field.Label}, "%q is a metric, which aggregates by itself", field.Label)
				}
				out.Type, out.Identity = field.Type, "metric:"+key
			case m.Agg == "":
				return out, bad("agg_required", []string{"key", key, "label", field.Label}, "%q needs an aggregation to be a measure of a query", field.Label)
			case !m.Agg.Valid():
				return out, bad("invalid_agg", []string{"agg", string(m.Agg)}, "unknown aggregation %q", m.Agg)
			default:
				if err := dataset.CheckAgg(m.Agg, field); err != nil {
					return out, err
				}
				out.Type = m.Agg.ResultType(field.Type)
				out.Identity = "aggregate:" + string(m.Agg) + ":" + key
			}
			break
		}
		if !found {
			return out, bad("unknown_output_measure", []string{"alias", target.Measure}, "the chart has no measure %q", target.Measure)
		}
	}
	if out.Aggregate && chart.Query.Mode == query.ModeDetail {
		return out, bad("invalid_filter_target", []string{"item", target.Item}, "detail charts cannot be filtered by aggregate results")
	}
	return out, nil
}

// NormalizeFilters upgrades old bindings without changing their defaults or
// chart filters, and canonicalizes dataset metrics referenced by output alias.
// It is best effort: a binding that cannot be resolved is left as it is, so a
// dashboard with one broken binding still opens and only the widgets relying on
// it fail. CheckFilters reports such bindings when the dashboard is saved.
func (s *DashboardSpec) NormalizeFilters(chart func(chartID string) (*ChartSpec, *dataset.Spec, bool)) {
	for i := range s.Filters {
		f := &s.Filters[i]
		for j := range f.Targets {
			t := &f.Targets[j]
			item, _ := s.ItemByID(t.Item)
			spec, ds, ok := chart(item.ChartID)
			if !ok || targetKindCount(*t) != 1 {
				continue
			}
			if t.Filter != "" {
				legacy, ok := spec.FilterByID(t.Filter)
				if !ok || legacy.IsParam() {
					continue
				}
				if f.Op == "" {
					f.Op = legacy.Op
				}
				// Previous bindings shared both value and operation; one that
				// differs stays a legacy binding for CheckFilters to reject.
				if f.Op != legacy.Op {
					continue
				}
				t.Field, t.Filter = legacy.Field, ""
			}
			if t.Measure != "" {
				if _, dynamic := spec.DynamicMeasure(t.Measure); dynamic {
					continue
				}
				resolved, err := ResolveFilterTarget(spec, ds, *t)
				if err != nil {
					continue
				}
				if field, _ := ds.FieldByKey(resolved.Field); field.Role == dataset.Metric {
					t.Field, t.Measure = field.Key, ""
				} else {
					t.Field, t.Measure, t.Aggregation = resolved.Field, "", resolved.Measure.Agg
				}
			}
		}
	}
}

// CheckFilters checks direct mappings and compatible condition types. It
// normalizes first, which costs nothing for a spec already normalized.
// Multiple global conditions on the same operand are combined with AND.
func (s *DashboardSpec) CheckFilters(chart func(chartID string) (*ChartSpec, *dataset.Spec, bool)) error {
	s.NormalizeFilters(chart)
	for _, f := range s.Filters {
		pairs := []string{"id", f.ID}
		var fieldType datasource.Type
		var aggregate bool
		for i, t := range f.Targets {
			item, _ := s.ItemByID(t.Item)
			spec, ds, ok := chart(item.ChartID)
			if !ok {
				return bad("invalid_filter_target", append(pairs, "item", t.Item), "widget %q shows no chart", t.Item)
			}
			target, err := ResolveFilterTarget(spec, ds, t)
			if err != nil {
				return withFilterID(err, f.ID)
			}
			if dynamic, ok := spec.DynamicMeasure(t.Measure); ok {
				for _, option := range dynamic.Options {
					resolved, err := spec.ResolveDynamics(map[string]string{dynamic.ID: option.ID})
					if err != nil {
						return withFilterID(err, f.ID)
					}
					alternative, err := ResolveFilterTarget(&resolved, ds, t)
					if err != nil {
						return withFilterID(err, f.ID)
					}
					if alternative.Type != target.Type || alternative.Aggregate != target.Aggregate || !f.Control.fits(f.Op, alternative.Type) {
						return bad("filter_targets_differ", []string{"id", f.ID}, "all dynamic alternatives must accept the global filter")
					}
				}
			}
			if t.Filter != "" {
				// Normalization upgrades every legacy binding that shares the filter's operation.
				return bad("filter_targets_differ", append(pairs, "item", t.Item), "legacy filter targets use different operations")
			}
			if i == 0 {
				fieldType, aggregate = target.Type, target.Aggregate
			} else {
				sameType := target.Type == fieldType || (target.Type.Temporal() && fieldType.Temporal())
				if !sameType || target.Aggregate != aggregate {
					return bad("filter_targets_differ", append(pairs, "item", t.Item), "filter %q combines incompatible field types or row and aggregate conditions", f.ID)
				}
			}
			if !f.Control.fits(f.Op, target.Type) || (target.Aggregate && !f.Control.aggregateFits(f.Op, target.Type)) {
				return bad("invalid_filter_control", append(pairs, "control", f.Control.Type, "op", f.Op, "type", string(target.Type)), "control %q cannot fill in a %q condition on this field", f.Control.Type, f.Op)
			}
		}
		if _, _, err := (ChartFilter{ID: f.ID, Op: f.Op, Control: &f.Control}).Condition(f.Default); err != nil {
			return err
		}
	}
	if err := s.CheckLinks(chart); err != nil {
		return err
	}
	return s.validateCascadeTargets(chart)
}

// withFilterID names the global filter a target error belongs to.
func withFilterID(err error, id string) error {
	var specErr *dataset.Error
	if errors.As(err, &specErr) && specErr.Params["id"] == "" {
		if specErr.Params == nil {
			specErr.Params = map[string]string{}
		}
		specErr.Params["id"] = id
	}
	return err
}

// conditions collects filter conditions for a query: row conditions go to its
// WHERE, aggregate ones to its HAVING through a filter measure.
type conditions struct {
	q          query.Query
	rows, aggs []dataset.Filter
}

// add applies f with value to target; an empty value restricts nothing.
func (c *conditions) add(f ChartFilter, target ResolvedFilterTarget, value any) error {
	condition, restricts, err := f.Condition(value)
	if err != nil || !restricts {
		return err
	}
	if target.Aggregate {
		condition.Field = filterMeasure(&c.q, target.Measure)
		c.aggs = append(c.aggs, condition)
	} else {
		c.rows = append(c.rows, condition)
	}
	return nil
}

func (c *conditions) query() query.Query {
	return andHaving(And(c.q, c.rows), c.aggs)
}

// filterMeasure reuses a selected measure when possible; otherwise it adds a
// collision-free HAVING-only measure without modifying the chart's output.
func filterMeasure(q *query.Query, m query.Measure) string {
	matches := func(candidate query.Measure) bool {
		return candidate.Field == m.Field && candidate.Agg == m.Agg && candidate.Compute == nil
	}
	for _, candidates := range [][]query.Measure{q.Measures, q.FilterMeasures} {
		for _, candidate := range candidates {
			if matches(candidate) {
				return candidate.Name()
			}
		}
	}
	used := map[string]bool{}
	for _, dim := range q.Dimensions {
		name := dim.Alias
		if name == "" {
			name = dim.Field
		}
		used[name] = true
	}
	for _, candidates := range [][]query.Measure{q.Measures, q.FilterMeasures} {
		for _, candidate := range candidates {
			used[candidate.Name()] = true
		}
	}
	for n := 1; ; n++ {
		alias := "filter_measure_" + strconv.Itoa(n)
		if used[alias] {
			continue
		}
		m.Alias, m.Label = alias, ""
		q.FilterMeasures = append(append([]query.Measure(nil), q.FilterMeasures...), m)
		return alias
	}
}

func andHaving(q query.Query, conditions []dataset.Filter) query.Query {
	if len(conditions) == 0 {
		return q
	}
	args := conditions
	if q.Having != nil {
		args = append([]dataset.Filter{*q.Having}, conditions...)
	}
	q.Having = &dataset.Filter{Op: "and", Args: args}
	return q
}
