package content

import (
	"slices"

	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/query"
)

type cascadeNode struct {
	id      string
	parents []string
	exact   bool
}

func exactControl(op string, control *Control) bool {
	return op == "in" && control != nil && (control.Type == ControlSelect || control.Type == ControlSearchSelect || control.Type == ControlTiles)
}

func validateGraph(nodes []cascadeNode) error {
	byID := map[string]cascadeNode{}
	for _, node := range nodes {
		byID[node.id] = node
	}
	visited, active := map[string]bool{}, map[string]bool{}
	var walk func(string) error
	walk = func(id string) error {
		if active[id] {
			return bad("invalid_cascade", []string{"id", id}, "cascade dependencies must not contain cycles")
		}
		if visited[id] {
			return nil
		}
		active[id] = true
		node := byID[id]
		seen := map[string]bool{}
		for _, parent := range node.parents {
			other, exists := byID[parent]
			if !exists || seen[parent] || !node.exact || !other.exact {
				return bad("invalid_cascade", []string{"id", id}, "cascade dependencies must refer to distinct exact-match selection filters")
			}
			seen[parent] = true
			if err := walk(parent); err != nil {
				return err
			}
		}
		active[id], visited[id] = false, true
		return nil
	}
	for _, node := range nodes {
		if err := walk(node.id); err != nil {
			return err
		}
	}
	return nil
}

// dependencies returns ancestors, or all related controls for reverse matching.
// The requested control itself is always omitted to avoid self-restricting choices.
func dependencies(nodes []cascadeNode, id string, related bool) map[string]bool {
	out := map[string]bool{id: true}
	for changed := true; changed; {
		changed = false
		for _, node := range nodes {
			if out[node.id] {
				for _, parent := range node.parents {
					if !out[parent] {
						out[parent], changed = true, true
					}
				}
			} else if related && slices.ContainsFunc(node.parents, func(parent string) bool { return out[parent] }) {
				out[node.id], changed = true, true
			}
		}
	}
	delete(out, id)
	return out
}

func (s *ChartSpec) cascadeNodes() []cascadeNode {
	nodes := make([]cascadeNode, 0, len(s.Filters))
	for _, f := range s.Filters {
		nodes = append(nodes, cascadeNode{f.ID, f.DependsOn, exactControl(f.Op, f.Control) && f.Aggregation == ""})
	}
	return nodes
}

func (s *ChartSpec) validateCascade(ds *dataset.Spec) error {
	nodes := s.cascadeNodes()
	for i, f := range s.Filters {
		field, _ := ds.FieldByKey(f.Field)
		nodes[i].exact = nodes[i].exact && field.Role != dataset.Metric
	}
	return validateGraph(nodes)
}

func (s *DashboardSpec) cascadeNodes() []cascadeNode {
	nodes := make([]cascadeNode, 0, len(s.Filters))
	for _, f := range s.Filters {
		nodes = append(nodes, cascadeNode{f.ID, f.DependsOn, exactControl(f.Op, &f.Control)})
	}
	return nodes
}

func (s *DashboardSpec) validateCascadeGraph() error { return validateGraph(s.cascadeNodes()) }

func (s *ChartSpec) CascadeRelated(id string, related bool) map[string]bool {
	return dependencies(s.cascadeNodes(), id, related)
}
func (s *DashboardSpec) CascadeRelated(id string, related bool) map[string]bool {
	return dependencies(s.cascadeNodes(), id, related)
}

// OptionsQuery preserves immutable query conditions and fixed chart filters,
// while selections only narrow the author-defined cascade dependencies.
func (s *ChartSpec) OptionsQuery(id string, values map[string]any, ds *dataset.Spec, related bool) (query.Query, string, error) {
	f, exists := s.FilterByID(id)
	if !exists || !f.Interactive() {
		return query.Query{}, "", bad("filter_not_interactive", []string{"id", id}, "the chart has no selectable filter %q", id)
	}
	if f.IsParam() {
		return query.Query{}, "", bad("invalid_filter_options", []string{"id", id}, "a parameter's options are listed in the chart")
	}
	if err := s.checkViewerValues(values, ds); err != nil {
		return query.Query{}, "", err
	}
	target, err := ResolveFilterTarget(s, ds, FilterTarget{Field: f.Field, Aggregation: f.Aggregation})
	if err != nil {
		return query.Query{}, "", err
	}
	if target.Aggregate {
		return query.Query{}, "", bad("invalid_filter_options", []string{"id", id}, "aggregate filters do not enumerate source values")
	}
	keep := s.CascadeRelated(id, related)
	out := *s
	out.Filters = nil
	for _, candidate := range s.Filters {
		// Parameters shape the data the options come from, such as the day
		// of a snapshot, so they keep the values chosen.
		if candidate.ID != id && (!candidate.Interactive() || keep[candidate.ID] || candidate.IsParam()) {
			out.Filters = append(out.Filters, candidate)
		}
	}
	q, err := out.Filtered(values, ds)
	if err != nil {
		return query.Query{}, "", err
	}
	full, err := s.Filtered(values, ds)
	return OptionsProjection(q, f.Field, full), f.Field, err
}

// A result condition must be evaluated at the chart's original grouping,
// before the matching groups are projected to distinct candidate values.
func optionsProjection(base query.Query, field string) query.Query {
	out := base
	out.Sort, out.Offset, out.Limit, out.Totals = nil, 0, nil, nil
	if base.Having != nil {
		// Only aggregates referenced by HAVING are needed to select groups.
		// In particular, an unused comparison must not require a time filter
		// that the independent candidate query intentionally leaves out.
		used := filterFields(base.Having)
		out.Measures = slices.DeleteFunc(slices.Clone(base.Measures), func(m query.Measure) bool { return !used[m.Name()] })
		out.FilterMeasures = slices.DeleteFunc(slices.Clone(base.FilterMeasures), func(m query.Measure) bool { return !used[m.Name()] })
		// A draft may have result filters before any output is selected. Give
		// its scalar aggregate a temporary output without changing the grain.
		if len(out.Dimensions)+len(out.Measures) == 0 && len(out.FilterMeasures) > 0 {
			out.Measures = []query.Measure{out.FilterMeasures[0]}
			out.FilterMeasures = slices.Clone(out.FilterMeasures[1:])
		}
		out.Candidates = &query.CandidateProjection{Field: field}
		return out
	}
	out.Mode = query.ModeAggregate
	out.Dimensions = []query.Dimension{{Field: field}}
	out.Measures, out.FilterMeasures, out.Columns = nil, nil, nil
	return out
}

// OptionsProjection keeps the complete time conditions only when HAVING
// actually uses a comparison. Other interactive filters retain their normal
// independent/cascading candidate semantics.
func OptionsProjection(base query.Query, field string, full query.Query) query.Query {
	out := optionsProjection(base, field)
	needed := map[string]bool{}
	for _, measures := range [][]query.Measure{out.Measures, out.FilterMeasures} {
		for _, measure := range measures {
			if measure.Compute != nil && measure.Compute.Type == query.Compare {
				needed[measure.Compute.TimeField] = true
			}
		}
	}
	var conditions []dataset.Filter
	var walk func(*dataset.Filter)
	walk = func(f *dataset.Filter) {
		if f == nil {
			return
		}
		if f.Op == "and" {
			for i := range f.Args {
				walk(&f.Args[i])
			}
		} else if needed[f.Field] {
			conditions = append(conditions, *f)
		}
	}
	walk(full.Filter)
	return And(out, conditions)
}

func filterFields(filter *dataset.Filter) map[string]bool {
	fields := map[string]bool{}
	var walk func(*dataset.Filter)
	walk = func(f *dataset.Filter) {
		if f == nil {
			return
		}
		if f.Logical() {
			for i := range f.Args {
				walk(&f.Args[i])
			}
		} else {
			fields[f.Field] = true
		}
	}
	walk(filter)
	return fields
}

// Drop dependencies whose controls were removed along with their last widget.
func pruneDependencies(filters []Filter) []Filter {
	ids := map[string]bool{}
	for _, f := range filters {
		ids[f.ID] = true
	}
	for i := range filters {
		filters[i].DependsOn = slices.DeleteFunc(slices.Clone(filters[i].DependsOn), func(id string) bool { return !ids[id] })
	}
	return filters
}

func (s *DashboardSpec) validateCascadeTargets(chart func(string) (*ChartSpec, *dataset.Spec, bool)) error {
	if err := s.validateCascadeGraph(); err != nil {
		return err
	}
	for _, filter := range s.Filters {
		if len(s.CascadeRelated(filter.ID, true)) == 0 {
			continue
		}
		source, _ := filter.OptionsTarget()
		for id := range s.CascadeRelated(filter.ID, true) {
			parent, _ := s.FilterByID(id)
			if !slices.ContainsFunc(parent.Targets, func(t FilterTarget) bool { return t.Item == source.Item }) {
				return bad("invalid_cascade", []string{"id", filter.ID}, "cascade ancestors must map to the option source widget")
			}
		}
		for _, f := range s.Filters {
			if f.ID != filter.ID && !s.CascadeRelated(filter.ID, true)[f.ID] {
				continue
			}
			for _, target := range f.Targets {
				item, _ := s.ItemByID(target.Item)
				spec, ds, exists := chart(item.ChartID)
				if !exists {
					return bad("invalid_cascade", []string{"id", f.ID}, "cascade target chart is missing")
				}
				resolved, err := ResolveFilterTarget(spec, ds, target)
				if err != nil {
					return err
				}
				if resolved.Aggregate {
					return bad("invalid_cascade", []string{"id", f.ID}, "cascade filters require row-level fields")
				}
			}
		}
	}
	return nil
}
