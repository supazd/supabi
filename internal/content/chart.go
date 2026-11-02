// Package content defines charts and dashboards: the declarative specs that
// are stored, versioned and generated. See .agents/design/chart-dashboard.md.
package content

import (
	"slices"
	"time"

	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/dialect"
	"github.com/supazd/supabi/internal/query"
)

// CurrentSpecVersion is the version of chart and dashboard specs this build writes.
const CurrentSpecVersion = 1

// ChartSpec is a query, the filters it runs under and a way to present its result.
type ChartSpec struct {
	SpecVersion int         `json:"specVersion"`
	Query       query.Query `json:"query"`
	Viz         Viz         `json:"viz"`
	// Filters restrict what the query sees. They are kept beside the query,
	// which says what is asked; these say within what.
	Filters     []ChartFilter  `json:"filters,omitempty"`
	Dynamics    []DynamicField `json:"dynamics,omitempty"`
	FilterStyle *FilterStyle   `json:"filterStyle,omitempty"`
	// AllowExport lets everyone who can open a dashboard showing the chart
	// export its complete data there, whatever their role.
	AllowExport bool   `json:"allowExport,omitempty"`
	Drill       *Drill `json:"drill,omitempty"`
}

// FilterStyle applies to the chart's filters and dynamic selectors in every view.
type FilterStyle struct {
	Layout  string `json:"layout"`
	Density string `json:"density"`
}

// Validate checks the presentation shared by charts and dashboard query containers.
func (s *FilterStyle) Validate() error {
	if s != nil && (!slices.Contains([]string{"horizontal", "vertical"}, s.Layout) || !slices.Contains([]string{"comfortable", "normal", "compact"}, s.Density)) {
		return bad("invalid_filter_style", nil, "unsupported filter layout or density")
	}
	return nil
}

func bad(code string, pairs []string, format string, a ...any) error {
	return dataset.Errorf(code, pairs, format, a...)
}

// Validate checks the chart against its dataset: the query must compile, and
// the visualisation must refer to columns the query produces, in the right role.
func (s *ChartSpec) Validate(ds *dataset.Spec, d dialect.Dialect) error {
	if err := s.FilterStyle.Validate(); err != nil {
		return err
	}
	if err := s.validateDynamics(ds, d); err != nil {
		return err
	}
	if err := s.validateDrill(ds, d); err != nil {
		return err
	}
	resolved, err := s.ResolveDynamics(nil)
	if err != nil {
		return err
	}
	return resolved.validateBase(ds, d)
}

func (s *ChartSpec) validateBase(ds *dataset.Spec, d dialect.Dialect) error {
	if s.SpecVersion != CurrentSpecVersion {
		return bad("unsupported_spec_version", nil, "chart spec version %d is not supported", s.SpecVersion)
	}
	if err := s.validateFilters(ds); err != nil {
		return err
	}
	q, err := s.Filtered(nil, ds)
	if err != nil {
		return err
	}
	// Compiling is the validation; the SQL itself is discarded.
	compiled, err := query.Compile(&q, ds, query.Options{
		Dialect: d, Now: time.Now(), DefaultLimit: 1, MaxLimit: 1, SampleMissingParams: true,
	})
	if err != nil {
		return err
	}
	if err := s.Viz.validate(compiled.Columns); err != nil {
		return err
	}
	return s.validateFlows()
}

// validateFlows checks that a sankey diagram of more than two levels asks for
// the total of each pair of neighbouring levels. Those are its flows: adding
// up the rows instead would count a distinct value or an average wrongly.
func (s *ChartSpec) validateFlows() error {
	if s.Viz.Type != Sankey || len(s.Viz.Levels) <= 2 {
		return nil
	}
	for i := range len(s.Viz.Levels) - 1 {
		pair := s.Viz.Levels[i : i+2]
		if !slices.ContainsFunc(s.Query.Totals, func(keep []string) bool {
			return len(keep) == 2 && slices.Contains(keep, pair[0]) && slices.Contains(keep, pair[1])
		}) {
			return bad("viz_sankey_needs_totals", []string{"from", pair[0], "to", pair[1]}, "the query does not ask for the total of %q and %q, which is the flow between them", pair[0], pair[1])
		}
	}
	return nil
}
