// Package query turns the query IR into SQL and runs it. The IR is the only
// way any entry point (editor, AI, embedding, API) asks for data, and this
// package is the only place that writes SQL. See .agents/design/query-ir.md.
package query

import (
	"bytes"
	"encoding/json"

	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/dialect"
)

// CurrentVersion is the IR version this build understands.
const CurrentVersion = 1

const (
	ModeAggregate = "aggregate"
	ModeDetail    = "detail"
)

// Query asks one question of one dataset. It never contains SQL: it can only
// name fields the dataset defines.
type Query struct {
	Version int    `json:"version"`
	Dataset string `json:"dataset"`
	Mode    string `json:"mode,omitempty"`

	Dimensions []Dimension `json:"dimensions,omitempty"`
	Measures   []Measure   `json:"measures,omitempty"`
	// FilterMeasures are aggregates available to HAVING without adding output columns.
	FilterMeasures []Measure `json:"filterMeasures,omitempty"`
	// Columns lists the fields to return in detail mode.
	Columns []DetailColumn `json:"columns,omitempty"`

	// Filter is a condition tree over fields. A time range is one of its
	// conditions: op "time", with a TimeRange as its value.
	Filter   *dataset.Filter `json:"filter,omitempty"`
	Having   *dataset.Filter `json:"having,omitempty"`
	Sort     []Sort          `json:"sort,omitempty"`
	Limit    *int            `json:"limit,omitempty"`
	Offset   int             `json:"offset,omitempty"`
	Timezone string          `json:"timezone,omitempty"`
	Params   map[string]any  `json:"params,omitempty"`
	// Totals asks for the measures again over coarser groups: each lists the
	// dimensions, by output name, it still groups by; an empty one is the
	// grand total. They are computed by the database, so a count of distinct
	// values or an average is right where adding up the rows would not be.
	Totals [][]string `json:"totals,omitempty"`
	// Candidates is a server-only projection used by filter option endpoints.
	// The original grouping and HAVING remain intact while enumerating rows
	// belonging to matching groups. It is never accepted in the public IR.
	// A future query cache must key on compiled SQL/args or include this plan;
	// JSON serialization alone intentionally omits it.
	Candidates *CandidateProjection `json:"-"`
}

type CandidateProjection struct {
	Field  string
	Search string
}

type Dimension struct {
	Field string        `json:"field"`
	Grain dialect.Grain `json:"grain,omitempty"`
	Alias string        `json:"alias,omitempty"`
	// Label is what the column is called for people, in place of the field's
	// own name. Alias names the column for the query; this is only shown.
	Label string `json:"label,omitempty"`
}

// Name is the dimension's output column: its alias, or else its field.
func (d Dimension) Name() string {
	if d.Alias != "" {
		return d.Alias
	}
	return d.Field
}

// DetailColumn is a field of a detail query. It is written as the field's key, or
// as an object when the column is given a label of its own.
type DetailColumn struct {
	Field string `json:"field"`
	Label string `json:"label,omitempty"`
}

func (c DetailColumn) MarshalJSON() ([]byte, error) {
	if c.Label == "" {
		return json.Marshal(c.Field)
	}
	type plain DetailColumn
	return json.Marshal(plain(c))
}

func (c *DetailColumn) UnmarshalJSON(data []byte) error {
	if len(data) > 0 && data[0] == '"' {
		*c = DetailColumn{}
		return json.Unmarshal(data, &c.Field)
	}
	type plain DetailColumn
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var out plain
	if err := decoder.Decode(&out); err != nil {
		return err
	}
	*c = DetailColumn(out)
	return nil
}

// Measure is a field and how it is aggregated. A dimension or a measure of
// the dataset needs an Agg; a metric aggregates in its own expression and
// takes none. See .agents/design/query-ir.md §3.5.
type Measure struct {
	Field string      `json:"field"`
	Agg   dataset.Agg `json:"agg,omitempty"`
	// Alias names the column in the query. The field's key when left out.
	Alias string `json:"alias,omitempty"`
	// Label is what the column is called for people, in place of the field's
	// own name and of any mention of how it was aggregated.
	Label string `json:"label,omitempty"`
	// BaseLabel names the aggregate before a derived calculation is applied.
	// Dynamic options carry their own aggregate name; unlike Label, this
	// retains the computation's naming metadata. Label takes precedence.
	BaseLabel string   `json:"baseLabel,omitempty"`
	Compute   *Compute `json:"compute,omitempty"`
}

// Name is what the measure's column is called in the query.
func (m Measure) Name() string {
	if m.Alias != "" {
		return m.Alias
	}
	return m.Field
}

// UnmarshalJSON turns away the form measures had before they were all
// written as a field and an aggregation, rather than reading it as a measure
// that names no field.
func (m *Measure) UnmarshalJSON(data []byte) error {
	type plain Measure
	var probe struct {
		Adhoc json.RawMessage `json:"adhoc"`
	}
	if err := json.Unmarshal(data, &probe); err == nil && probe.Adhoc != nil {
		return dataset.Errorf("invalid_measure", nil, "a measure is written as {field, agg}; adhoc is no longer accepted")
	}
	// Strict like the rest of a query read through decodeStrict: a misspelt
	// key is an error, not a measure quietly missing a part.
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	return decoder.Decode((*plain)(m))
}

// Compute derives a value from an aggregate. PercentOfTotal divides by the
// same aggregate over the filtered source, grouped only by Within.
// Cumulative runs along the dimension Along, starting over for each
// combination of the other dimensions.
type Compute struct {
	Type      string    `json:"type"`
	Within    []string  `json:"within,omitempty"`
	TimeField string    `json:"timeField,omitempty"`
	Offset    *Duration `json:"offset,omitempty"`
	Output    string    `json:"output,omitempty"`
	Along     string    `json:"along,omitempty"`
}

const PercentOfTotal = "percent_of_total"
const Compare = "compare"
const Cumulative = "cumulative"

// Comparison describes how a comparison column is named, apart from an explicit label.
type Comparison struct {
	Offset Duration `json:"offset"`
	Output string   `json:"output"`
}

// OpTime is the filter operator whose value is a TimeRange.
const OpTime = "time"

// TimeRange is the value of a "time" condition on a date or timestamp field.
// It is exactly one of: Last, Current, Start/End, Bounds, or Special.
type TimeRange struct {
	Last           *Duration     `json:"last,omitempty"`
	IncludeCurrent bool          `json:"includeCurrent,omitempty"`
	Current        dialect.Grain `json:"current,omitempty"`
	// Start is inclusive and End exclusive, as local time in the query zone.
	Start string `json:"start,omitempty"`
	End   string `json:"end,omitempty"`
	// Bounds permits independently fixed or relative endpoints. A missing
	// endpoint is unbounded; an empty Bounds has no time restriction.
	Bounds *TimeBounds `json:"bounds,omitempty"`
	// Special selects missing or present dates instead of an interval.
	// Its only values are is_null and not_null.
	Special string `json:"special,omitempty"`

	// The rest qualify the interval and are no interval of their own.

	// IncludeNull keeps rows without a date as well. It cannot go with Special.
	IncludeNull bool `json:"includeNull,omitempty"`
	// Grain is what the interval is made of: day, week or month. Its ends are
	// moved out to whole periods of it. Left out, they stay where they are.
	Grain dialect.Grain `json:"grain,omitempty"`
	// WeekStart is the ISO weekday weeks start on in this range, 1 Monday to
	// 7 Sunday. Left out, the workspace's first day of the week applies.
	WeekStart int `json:"weekStart,omitempty"`
}

// TimeBounds is a half-open interval [Start, End) in the query time zone.
type TimeBounds struct {
	Start *TimeBound `json:"start,omitempty"`
	End   *TimeBound `json:"end,omitempty"`
}

// TimeBound sets exactly one of Fixed or Relative. Relative.N is a signed
// offset from the start of the current period: 0 starts this period, -1 the
// previous period, and 1 the next. Endpoints never implicitly include a period;
// to include today, for example, use an end of {n:1, unit:"day"}.
type TimeBound struct {
	// Fixed is a local date/date-time, or an RFC3339 timestamp identifying an
	// absolute instant. Explicit offsets survive ambiguous DST wall times.
	Fixed    string    `json:"fixed,omitempty"`
	Relative *Duration `json:"relative,omitempty"`
}

type Duration struct {
	N    int           `json:"n"`
	Unit dialect.Grain `json:"unit"`
}

type Sort struct {
	// By is the alias of an output column.
	By   string `json:"by"`
	Desc bool   `json:"desc,omitempty"`
}
