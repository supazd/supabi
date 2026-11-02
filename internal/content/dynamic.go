package content

import (
	"slices"
	"strings"

	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/dialect"
	"github.com/supazd/supabi/internal/query"
)

// DynamicField offers author-defined alternatives for one stable output column.
// Viewers select option IDs; field names and aggregations remain author-owned.
type DynamicField struct {
	ID         string          `json:"id"`
	Kind       string          `json:"kind"`
	Label      string          `json:"label"`
	Alias      string          `json:"alias"`
	Options    []DynamicOption `json:"options"`
	AllowEmpty bool            `json:"allowEmpty,omitempty"`
}

type DynamicOption struct {
	ID    string        `json:"id"`
	Label string        `json:"label,omitempty"`
	Field string        `json:"field"`
	Agg   dataset.Agg   `json:"agg,omitempty"`
	Grain dialect.Grain `json:"grain,omitempty"`
}

func dimensionName(d query.Dimension) string {
	if d.Alias != "" {
		return d.Alias
	}
	return d.Field
}

func (s *ChartSpec) DynamicMeasure(alias string) (DynamicField, bool) {
	for _, dynamic := range s.Dynamics {
		if dynamic.Kind == "measure" && dynamic.Alias == alias {
			return dynamic, true
		}
	}
	return DynamicField{}, false
}

// ResolveDynamics does not mutate the saved spec. Defaults always use the first option.
func (s *ChartSpec) ResolveDynamics(selections map[string]string) (ChartSpec, error) {
	out := *s
	out.Query.Dimensions = slices.Clone(s.Query.Dimensions)
	out.Query.Measures = slices.Clone(s.Query.Measures)
	removedDimension := false
	for id := range selections {
		if !slices.ContainsFunc(s.Dynamics, func(d DynamicField) bool { return d.ID == id }) {
			return out, bad("unknown_dynamic", []string{"id", id}, "the chart has no dynamic field %q", id)
		}
	}
	for _, dynamic := range s.Dynamics {
		if len(dynamic.Options) == 0 {
			return out, bad("invalid_dynamic", []string{"id", dynamic.ID}, "a dynamic field needs options")
		}
		selected, chosen := selections[dynamic.ID]
		if !chosen {
			selected = dynamic.Options[0].ID
		}
		if selected == "" && dynamic.Kind == "dimension" && dynamic.AllowEmpty {
			removedDimension = true
			out.Query.Dimensions = slices.DeleteFunc(out.Query.Dimensions, func(d query.Dimension) bool { return dimensionName(d) == dynamic.Alias })
			continue
		}
		at := slices.IndexFunc(dynamic.Options, func(o DynamicOption) bool { return o.ID == selected })
		if at < 0 {
			return out, bad("invalid_dynamic_selection", []string{"id", dynamic.ID, "option", selected}, "the dynamic field %q has no option %q", dynamic.ID, selected)
		}
		option := dynamic.Options[at]
		found := false
		switch dynamic.Kind {
		case "dimension":
			for i, d := range out.Query.Dimensions {
				if dimensionName(d) == dynamic.Alias {
					out.Query.Dimensions[i] = query.Dimension{Field: option.Field, Alias: dynamic.Alias, Label: option.Label, Grain: option.Grain}
					found = true
				}
			}
		case "measure":
			for i, m := range out.Query.Measures {
				if m.Name() == dynamic.Alias {
					out.Query.Measures[i] = query.Measure{Field: option.Field, Agg: option.Agg, Alias: dynamic.Alias, Label: option.Label, Compute: m.Compute}
					if m.Compute != nil {
						out.Query.Measures[i].Label = ""
						out.Query.Measures[i].BaseLabel = option.Label
					}
					found = true
				}
			}
		}
		if !found {
			return out, bad("invalid_dynamic", []string{"id", dynamic.ID}, "dynamic field %q does not identify an output column", dynamic.ID)
		}
	}
	// Nor the totals: they group by what is left.
	if removedDimension {
		out.Query.PruneTotals()
		out.Query.PruneCompute()
	}
	// Removing a category must not leave the visualisation pointing at a missing column.
	has := func(alias string) bool {
		return slices.ContainsFunc(out.Query.Dimensions, func(d query.Dimension) bool { return dimensionName(d) == alias })
	}
	// A heatmap needs both of its dimensions; without one it is shown as a table.
	if removedDimension && s.Viz.Type == Heatmap && !(slices.ContainsFunc(s.Viz.Rows, has) && slices.ContainsFunc(s.Viz.Columns, has)) {
		out.Viz = Viz{Type: Table, Formats: s.Viz.Formats}
	}
	// A sankey diagram keeps the levels that are left; with fewer than two it is a table.
	if removedDimension && s.Viz.Type == Sankey {
		out.Viz.Levels = slices.DeleteFunc(slices.Clone(s.Viz.Levels), func(name string) bool { return !has(name) })
		if len(out.Viz.Levels) < 2 {
			out.Viz = Viz{Type: Table, Formats: s.Viz.Formats}
		}
	}
	// A pivot table keeps the dimensions that are left; without any it is a table.
	if removedDimension && s.Viz.Type == Pivot {
		out.Viz.Rows = slices.DeleteFunc(slices.Clone(s.Viz.Rows), func(name string) bool { return !has(name) })
		out.Viz.Columns = slices.DeleteFunc(slices.Clone(s.Viz.Columns), func(name string) bool { return !has(name) })
		if len(out.Viz.Rows)+len(out.Viz.Columns) == 0 {
			out.Viz = Viz{Type: Table, Formats: s.Viz.Formats}
		}
	}
	if removedDimension && out.Viz.Type != Table && s.Viz.X != "" {
		if len(out.Query.Dimensions) == 0 {
			out.Viz = Viz{Type: Table, Formats: s.Viz.Formats}
		} else {
			if !has(out.Viz.X) {
				out.Viz.X = dimensionName(out.Query.Dimensions[0])
			}
			if !has(out.Viz.Series) || out.Viz.Series == out.Viz.X {
				out.Viz.Series = ""
			}
		}
	}
	if removedDimension && len(s.Viz.HiddenColumns) > 0 {
		// Only removed dimensions lose their presentation setting; measures and
		// the remaining dimensions keep their stable output aliases.
		out.Viz.HiddenColumns = slices.DeleteFunc(slices.Clone(s.Viz.HiddenColumns), func(name string) bool {
			return slices.ContainsFunc(s.Query.Dimensions, func(d query.Dimension) bool { return dimensionName(d) == name }) && !has(name)
		})
	}
	return out, nil
}

func (s *ChartSpec) validateDynamics(ds *dataset.Spec, d dialect.Dialect) error {
	if len(s.Dynamics) == 0 {
		return nil
	}
	if s.Query.Mode == query.ModeDetail || len(s.Dynamics) > 16 {
		return bad("invalid_dynamic", nil, "dynamic fields require an aggregate chart and at most 16 slots")
	}
	seen, aliases := map[string]bool{}, map[string]bool{}
	for _, dynamic := range s.Dynamics {
		pairs := []string{"id", dynamic.ID}
		if !dataset.ValidKey(dynamic.ID) || seen[dynamic.ID] || !dataset.ValidKey(dynamic.Alias) || aliases[dynamic.Alias] || strings.TrimSpace(dynamic.Label) == "" || len(dynamic.Options) == 0 || len(dynamic.Options) > 64 {
			return bad("invalid_dynamic", pairs, "dynamic fields need unique IDs and aliases, a label and 1–64 options")
		}
		seen[dynamic.ID], aliases[dynamic.Alias] = true, true
		if dynamic.Kind != "dimension" && dynamic.Kind != "measure" || dynamic.AllowEmpty && dynamic.Kind != "dimension" {
			return bad("invalid_dynamic", pairs, "only dynamic dimensions may be empty")
		}
		opts := map[string]bool{}
		for _, option := range dynamic.Options {
			if !dataset.ValidKey(option.ID) || opts[option.ID] {
				return bad("invalid_dynamic", pairs, "dynamic option IDs must be unique")
			}
			opts[option.ID] = true
			field, exists := ds.FieldByKey(option.Field)
			if !exists {
				return bad("unknown_field", []string{"key", option.Field}, "the dynamic field names an unknown dataset field")
			}
			if dynamic.Kind == "dimension" && (field.Role != dataset.Dimension || option.Agg != "") || dynamic.Kind == "measure" && option.Grain != "" {
				return bad("invalid_dynamic", pairs, "dynamic alternatives must have the configured field role")
			}
			resolved, err := s.ResolveDynamics(map[string]string{dynamic.ID: option.ID})
			if err != nil {
				return err
			}
			if err := resolved.validateBase(ds, d); err != nil {
				return err
			}
		}
	}
	// All optional dimensions may be empty at the same time.
	empty := map[string]string{}
	for _, dynamic := range s.Dynamics {
		if dynamic.AllowEmpty {
			empty[dynamic.ID] = ""
		}
	}
	resolved, err := s.ResolveDynamics(empty)
	if err != nil {
		return err
	}
	return resolved.validateBase(ds, d)
}
