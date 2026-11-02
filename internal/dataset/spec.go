// Package dataset defines the dataset model: a logical table with typed
// fields, each a dimension or a measure, and parameters. See
// .agents/design/dataset.md.
package dataset

import "github.com/supazd/supabi/internal/datasource"

// CurrentSpecVersion is the version written by this build.
const CurrentSpecVersion = 1

// Spec is the stored definition of a dataset.
type Spec struct {
	SpecVersion int     `json:"specVersion"`
	Source      Source  `json:"source"`
	Params      []Param `json:"params,omitempty"`
	Fields      []Field `json:"fields"`
	Cache       *Cache  `json:"cache,omitempty"`
}

type Source struct {
	// Type is "sql" or "table".
	Type   string `json:"type"`
	SQL    string `json:"sql,omitempty"`
	Schema string `json:"schema,omitempty"`
	Table  string `json:"table,omitempty"`
}

type Param struct {
	Name     string          `json:"name"`
	Type     datasource.Type `json:"type"`
	Label    string          `json:"label,omitempty"`
	Multi    bool            `json:"multi,omitempty"`
	Required bool            `json:"required,omitempty"`
	// Default is a literal, or {"relative": "today-1d"} for a date computed at query time.
	Default any `json:"default,omitempty"`
}

// Role says how a field is meant to be used.
type Role string

const (
	// Dimension fields group, filter and sort.
	Dimension Role = "dimension"
	// MeasureRole fields are numbers on each row, aggregated when they are
	// used. Only a numeric field can be one.
	MeasureRole Role = "measure"
	// Metric fields aggregate inside their own expression, such as a ratio of
	// two sums. They are used as they are and cannot be grouped or filtered by.
	Metric Role = "metric"
)

// Field is everything a dataset offers: a column of the source or a
// calculation over other fields, used as a dimension, a measure or a metric.
//
// A field is row-level, with one value per row, unless it is a metric.
type Field struct {
	// Key is the internal ID that charts, queries and other fields' expressions
	// refer to. It never changes once created, and people are not shown it.
	Key string `json:"key"`
	// Label is the name people see and write in expressions. It is unique
	// within the dataset and can be changed at any time.
	Label string `json:"label"`
	// Column is the column of the source the field reads, by the name the
	// source gives it. It is never SQL: each database quotes it its own way
	// when a query is written, so any name a column can have will do.
	Column string `json:"column,omitempty"`
	// Expr is what a calculated field computes, which may refer to other
	// fields as ${key}. A field has a column or an expression, never both.
	Expr string `json:"expr,omitempty"`
	// Syntax is the language Expr is written in: the platform's own
	// (Standard), which means the same on every database, or when empty the
	// SQL of the data source, which only that kind of database reads.
	Syntax Syntax          `json:"syntax,omitempty"`
	Type   datasource.Type `json:"type"`
	// Role says what the field is. How a measure is aggregated is not the
	// dataset's to say: each query says it. See .agents/design/dataset.md §6.1.
	Role        Role     `json:"role"`
	Description string   `json:"description,omitempty"`
	Synonyms    []string `json:"synonyms,omitempty"`
	Format      *Format  `json:"format,omitempty"`
	Hidden      bool     `json:"hidden,omitempty"`
	Group       string   `json:"group,omitempty"`
}

// Syntax is a language expressions are written in.
type Syntax string

// Standard is the platform's own language. See internal/expr.
const Standard Syntax = "standard"

// Agg is an aggregation function.
type Agg string

const (
	Sum           Agg = "sum"
	Avg           Agg = "avg"
	Min           Agg = "min"
	Max           Agg = "max"
	Count         Agg = "count"
	CountDistinct Agg = "count_distinct"
)

func (a Agg) Valid() bool {
	switch a {
	case Sum, Avg, Min, Max, Count, CountDistinct:
		return true
	}
	return false
}

// ResultType is the type an aggregation over a field of type in produces.
func (a Agg) ResultType(in datasource.Type) datasource.Type {
	switch a {
	case Count, CountDistinct:
		return datasource.Integer
	case Avg:
		if in == datasource.Float {
			return datasource.Float
		}
		return datasource.Decimal
	case Sum:
		if in == datasource.Integer {
			return datasource.Decimal // sums of integers can outgrow int64
		}
	}
	return in
}

type Cache struct {
	TTLSeconds int `json:"ttlSeconds"`
}

// Filter is a condition tree. A node is either logical (Op is and/or/not, with
// Args) or a comparison (Field, Op and usually Value). Queries use the same
// structure for their filters.
type Filter struct {
	Op    string   `json:"op"`
	Args  []Filter `json:"args,omitempty"`
	Field string   `json:"field,omitempty"`
	Value any      `json:"value,omitempty"`
}

// FilterRange is the object form of a between/not_between filter value. Both
// endpoints are required. Omitted inclusion flags default to true, matching
// the legacy two-element array form.
type FilterRange struct {
	Min        any   `json:"min"`
	Max        any   `json:"max"`
	IncludeMin *bool `json:"includeMin,omitempty"`
	IncludeMax *bool `json:"includeMax,omitempty"`
}

// Logical reports whether the node combines other nodes.
func (f Filter) Logical() bool { return f.Op == "and" || f.Op == "or" || f.Op == "not" }

// FieldByKey returns the field with the given key.
func (s *Spec) FieldByKey(key string) (Field, bool) {
	for _, f := range s.Fields {
		if f.Key == key {
			return f, true
		}
	}
	return Field{}, false
}

// ParamByName returns the parameter with the given name.
func (s *Spec) ParamByName(name string) (Param, bool) {
	for _, p := range s.Params {
		if p.Name == name {
			return p, true
		}
	}
	return Param{}, false
}

// ParamsRequiringInput returns the parameters a query must give a value:
// those whose value cannot satisfy a Required flag or a placeholder outside
// [[ ]]. With withDefaults, a parameter's default counts as its value;
// without, none has one, as when a query gives each null or an empty list,
// and the result is every parameter the SQL cannot do without. It renders
// the SQL as the compiler does, so quoted and commented placeholders and
// optional blocks agree.
func (s *Spec) ParamsRequiringInput(withDefaults bool) map[string]bool {
	required := map[string]bool{}
	if s.Source.Type != "sql" {
		return required
	}
	provided := map[string]bool{}
	for _, p := range s.Params {
		list, isList := p.Default.([]any)
		provided[p.Name] = withDefaults && p.Default != nil && (!isList || len(list) > 0)
		if p.Required && !provided[p.Name] {
			required[p.Name] = true
		}
	}
	tpl, err := ParseTemplate(s.Source.SQL)
	if err != nil {
		// Saved and proposed definitions have already passed Validate.
		return required
	}
	for {
		missing := tpl.Render(func(name string) bool { return provided[name] || required[name] }, func(string, int) {}, func(string) {})
		if missing == "" {
			return required
		}
		// Supplying the missing parameter lets the renderer find the next one.
		required[missing] = true
	}
}
