package content

import (
	"bytes"
	"encoding/json"
	"maps"
	"strings"

	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/query"
)

// A parameter filter gives a dataset parameter its value, where other
// filters restrict a field. It has no condition: how the value is used is up
// to the dataset's SQL. Without a control it fixes the value; with one,
// viewers type it in or pick it from options the author lists. See
// .agents/design/chart-dashboard.md 2.11.

// ControlInput lets a viewer type a parameter's value. What they type into
// follows the parameter's type.
const ControlInput = "input"

// maxParamOptions is how many values a parameter's dropdown may offer, as
// many as a field filter lists.
const maxParamOptions = 500

// IsParam reports whether the filter gives a dataset parameter its value.
func (f ChartFilter) IsParam() bool { return f.Param != "" }

func (f *ChartFilter) UnmarshalJSON(data []byte) error {
	type plain ChartFilter
	var in struct {
		plain
		// Read as written, so that null can be told from left out.
		Value json.RawMessage `json:"value"`
	}
	// Strict like the rest of a spec read through decodeStrict.
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&in); err != nil {
		return err
	}
	*f = ChartFilter(in.plain)
	f.ValueSet = in.Value != nil
	if in.Value == nil {
		return nil
	}
	return json.Unmarshal(in.Value, &f.Value)
}

func (f ChartFilter) MarshalJSON() ([]byte, error) {
	type plain ChartFilter
	if !f.IsParam() || !f.ValueSet || f.Value != nil {
		return json.Marshal(plain(f))
	}
	// Written as null it gives the parameter no value; left out, the
	// parameter would keep the dataset's default.
	return json.Marshal(struct {
		plain
		Value any `json:"value"`
	}{plain: plain(f)})
}

// ownDefault is the value a parameter filter starts with, and whether it has
// one of its own rather than following the dataset's default.
func (f ChartFilter) ownDefault() (any, bool) {
	return f.Value, f.ValueSet || f.Value != nil
}

// paramDefault is the value a parameter filter starts with.
func (f ChartFilter) paramDefault(p dataset.Param) any {
	if value, own := f.ownDefault(); own {
		return value
	}
	return p.Default
}

// ParamControl is what showing a parameter filter takes from the dataset,
// worked out for viewers, who cannot read the dataset themselves.
type ParamControl struct {
	Type  datasource.Type `json:"type"`
	Multi bool            `json:"multi,omitempty"`
	// NeedsValue says the SQL cannot run without a value: the parameter is
	// required, or used outside [[ ]]. Its control cannot be cleared.
	NeedsValue bool `json:"needsValue,omitempty"`
	// Default is the value a viewer starts with.
	Default any `json:"default,omitempty"`
	// Options are what a dropdown offers.
	Options []any `json:"options,omitempty"`
}

// ParamControls describes the chart's parameter filters viewers set, by ID,
// from the dataset as it is now. A filter whose parameter the dataset no
// longer has is left out: the chart cannot run until it is mended.
func (s *ChartSpec) ParamControls(ds *dataset.Spec) map[string]ParamControl {
	var out map[string]ParamControl
	var needs map[string]bool
	for _, f := range s.Filters {
		p, ok := ds.ParamByName(f.Param)
		if !f.IsParam() || !f.Interactive() || !ok {
			continue
		}
		if out == nil {
			out, needs = map[string]ParamControl{}, ds.ParamsRequiringInput(false)
		}
		control := ParamControl{Type: p.Type, Multi: p.Multi, NeedsValue: needs[p.Name], Default: f.paramDefault(p)}
		if f.Control != nil && f.Control.Type == ControlSelect {
			control.Options = paramOptions(f, p)
		}
		out[f.ID] = control
	}
	return out
}

// paramOptions are what a parameter's dropdown offers: the author's options,
// after the values of the default they do not list. The default is always on
// offer, though it follows the dataset's, which may have changed since.
func paramOptions(f ChartFilter, p dataset.Param) []any {
	if p.Type == datasource.Boolean {
		return []any{true, false}
	}
	listed := map[string]bool{}
	for _, option := range f.Options {
		listed[valueKey(option)] = true
	}
	var out []any
	for _, value := range paramItems(f.paramDefault(p)) {
		if key := valueKey(value); !listed[key] {
			listed[key] = true
			out = append(out, value)
		}
	}
	return append(out, f.Options...)
}

// paramItems lists the values in a parameter's value: those of a list, or
// the value itself. Null gives none.
func paramItems(value any) []any {
	switch v := value.(type) {
	case nil:
		return nil
	case []any:
		return v
	}
	return []any{value}
}

// valueKey tells values apart as JSON does, whatever Go type they came in.
func valueKey(value any) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

// checkParamValue checks a value given to parameter p: one of its values, or
// a list of them for a parameter taking several. Null and an empty list give
// it none, which is for the SQL to accept or not.
func checkParamValue(p dataset.Param, value any) error {
	pairs := []string{"name", p.Name}
	_, isList := value.([]any)
	switch {
	case value == nil:
		return nil
	case isList && !p.Multi:
		return bad("invalid_param_value", pairs, "parameter %q takes a single value", p.Name)
	case !isList && p.Multi:
		return bad("invalid_param_value", pairs, "parameter %q takes a list of values", p.Name)
	}
	for _, item := range paramItems(value) {
		if err := query.CheckParamValue(p, item); err != nil {
			return bad("invalid_param_value", pairs, "parameter %q: %v", p.Name, err)
		}
	}
	return nil
}

// validateParamFilter checks a filter giving a dataset parameter its value.
// given collects the parameters given values so far; needs are those the
// dataset's SQL cannot do without (Spec.ParamsRequiringInput).
func (s *ChartSpec) validateParamFilter(f ChartFilter, ds *dataset.Spec, given, needs map[string]bool) error {
	pairs := []string{"id", f.ID}
	p, ok := ds.ParamByName(f.Param)
	if !ok {
		return bad("unknown_param", []string{"name", f.Param}, "the dataset has no parameter %q", f.Param)
	}
	_, fixed := s.Query.Params[f.Param]
	switch {
	case f.Field != "" || f.Op != "" || f.Aggregation != "" || len(f.DependsOn) > 0 || f.Exposed:
		return bad("invalid_filter", pairs, "filter %q gives parameter %q a value; it takes no field, condition or parent filters", f.ID, f.Param)
	case given[f.Param] || fixed:
		return bad("duplicate_param_filter", []string{"name", f.Param}, "parameter %q is given a value more than once", f.Param)
	}
	given[f.Param] = true
	value, own := f.ownDefault()
	if err := checkParamValue(p, value); err != nil {
		return err
	}
	if f.Control == nil {
		if len(f.Options) > 0 {
			return bad("invalid_param_options", pairs, "only a dropdown offers options")
		}
		if len(paramItems(value)) == 0 {
			return bad("filter_needs_value", pairs, "filter %q is fixed, so it needs a value", f.ID)
		}
		return nil
	}
	if strings.TrimSpace(f.Label) == "" {
		return bad("filter_needs_label", pairs, "filter %q has no label", f.ID)
	}
	switch kind := f.Control.Type; {
	case f.Control.Multi || kind != ControlInput && kind != ControlSelect || kind == ControlInput && p.Type == datasource.Boolean:
		// Whether a dropdown takes several values is the parameter's to say.
		return bad("invalid_filter_control", append(pairs, "control", kind, "type", string(p.Type)), "control %q cannot give a %s parameter its value", kind, p.Type)
	case kind == ControlInput && len(f.Options) > 0, p.Type == datasource.Boolean && len(f.Options) > 0:
		return bad("invalid_param_options", pairs, "filter %q offers no options of its own", f.ID)
	case len(f.Options) > maxParamOptions:
		return bad("invalid_param_options", append(pairs, "max", "500"), "a dropdown offers at most %d values", maxParamOptions)
	}
	listed := map[string]bool{}
	for _, option := range f.Options {
		if _, isList := option.([]any); isList || option == nil {
			return bad("invalid_param_options", pairs, "each option is a single value")
		}
		if err := checkParamValue(dataset.Param{Name: p.Name, Type: p.Type}, option); err != nil {
			return err
		}
		if key := valueKey(option); listed[key] {
			return bad("invalid_param_options", pairs, "option %s is listed twice", key)
		} else {
			listed[key] = true
		}
	}
	if own && f.Control.Type == ControlSelect && p.Type != datasource.Boolean {
		for _, item := range paramItems(value) {
			if !listed[valueKey(item)] {
				return bad("invalid_param_value", []string{"name", p.Name}, "the default %s is not among the options", valueKey(item))
			}
		}
	}
	if needs[p.Name] && len(paramItems(f.paramDefault(p))) == 0 {
		return bad("param_needs_default", append(pairs, "name", p.Name), "parameter %q cannot be left without a value, so filter %q needs a default", p.Name, f.ID)
	}
	return nil
}

// checkViewerParam checks the value a viewer chose for a parameter filter.
// Typed in, it is a value of the parameter's type, or the default as it
// stands; picked from a dropdown, one the dropdown offers.
func (f ChartFilter) checkViewerParam(value any, ds *dataset.Spec) error {
	p, ok := ds.ParamByName(f.Param)
	if !ok {
		return bad("unknown_param", []string{"name", f.Param}, "the dataset has no parameter %q", f.Param)
	}
	if err := checkParamValue(p, value); err != nil {
		return err
	}
	if valueKey(value) == valueKey(f.paramDefault(p)) {
		return nil
	}
	offered := map[string]bool{}
	for _, option := range paramOptions(f, p) {
		offered[valueKey(option)] = true
	}
	for _, item := range paramItems(value) {
		_, relative := item.(map[string]any)
		switch {
		case f.Control.Type == ControlInput && relative:
			return bad("invalid_param_value", []string{"name", p.Name}, "parameter %q is typed in, which gives no relative day", p.Name)
		case f.Control.Type == ControlSelect && !offered[valueKey(item)]:
			return bad("invalid_param_value", []string{"name", p.Name}, "%s is not among the options of parameter %q", valueKey(item), p.Name)
		}
	}
	return nil
}

// withParams gives the parameters of the chart's parameter filters their
// values: the viewer's, else the filter's own. A filter following the
// dataset's default leaves the parameter to it.
func (s *ChartSpec) withParams(q query.Query, values map[string]any) query.Query {
	copied := false
	for _, f := range s.Filters {
		if !f.IsParam() {
			continue
		}
		value, given := values[f.ID]
		if !given {
			if value, given = f.ownDefault(); !given {
				continue
			}
		}
		if !copied {
			q.Params, copied = maps.Clone(q.Params), true
			if q.Params == nil {
				q.Params = map[string]any{}
			}
		}
		q.Params[f.Param] = value
	}
	return q
}
