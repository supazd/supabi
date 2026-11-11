package query

import (
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/dialect"
	"github.com/supazd/supabi/internal/expr"
)

// Options is the context a query is compiled in. None of it comes from the
// client: it is how the server applies workspace settings and access control.
type Options struct {
	Dialect dialect.Dialect
	// Now anchors relative time ranges.
	Now time.Time
	// Timezone is used when the query does not name one.
	Timezone  string
	WeekStart int
	// RowFilter restricts the rows the caller may see. It is ANDed into every
	// query and cannot be widened by the query itself.
	RowFilter *dataset.Filter
	// Hidden are the fields the caller may not see. A query that refers to
	// one anywhere fails; the row filter, which the server writes, may.
	Hidden       map[string]bool
	DefaultLimit int
	MaxLimit     int
	// SampleMissingParams fills parameters that have no value with a
	// placeholder of the right type. Only for checking that SQL is valid,
	// where the rows do not matter.
	SampleMissingParams bool
	// RawTimes leaves times as the database gives them, instead of writing
	// them in the query zone, which would make anything a time. Only for
	// checking what type a field really is.
	RawTimes bool
}

// OutputColumn describes one column of the result.
type OutputColumn struct {
	Name string
	// Type is the declared type; the database's actual type wins at run time.
	Type  datasource.Type
	Role  string // "dimension" or "measure"
	Label string
	// Format is how the column's numbers or dates are written. A count has
	// none: the count of an amount is not an amount.
	Format *dataset.Format
	// Grain is what a dimension's dates were truncated to, which says how much
	// of them to write: a month's first day stands for the month.
	Grain dialect.Grain
	// Agg is how a measure column was aggregated, by the dataset's default or
	// for this query alone. The label is the field's, so this is what tells the
	// column apart from the field aggregated another way. A metric has none,
	// and neither has a column the query gave a label of its own.
	Agg        dataset.Agg
	Compute    string
	Comparison *Comparison
}

// Compiled is a query ready to run.
type Compiled struct {
	SQL     string
	Args    []any
	Columns []OutputColumn
	// Limit is the number of rows to return. The SQL asks for one more so the
	// caller can tell whether the result was cut off.
	Limit int
}

const sourceAlias = "t"

type compiler struct {
	q    *Query
	spec *dataset.Spec
	opt  Options
	d    dialect.Dialect
	loc  *time.Location
	zone string
	args args

	// spans relates the source SQL as written to where source() put it.
	spans []span

	// failed is the first field that could not be written as SQL.
	failed error

	columns []OutputColumn
	// measureSQL maps selected and filter-only measure aliases to HAVING expressions.
	measureSQL   map[string]string
	measureTypes map[string]datasource.Type
	aliases      map[string]bool
}

func bad(code string, pairs []string, format string, a ...any) error {
	return dataset.Errorf(code, pairs, format, a...)
}

// Compile validates q against the dataset and produces SQL. The spec must
// already have passed Validate.
func Compile(q *Query, spec *dataset.Spec, opt Options) (*Compiled, error) {
	if q.Version != CurrentVersion {
		return nil, bad("unsupported_query_version", []string{"version", strconv.Itoa(q.Version)}, "query version %d is not supported", q.Version)
	}
	c := &compiler{q: q, spec: spec, opt: opt, d: opt.Dialect, measureSQL: map[string]string{}, measureTypes: map[string]datasource.Type{}, aliases: map[string]bool{}}

	if err := c.setTimezone(); err != nil {
		return nil, err
	}
	if err := q.checkTotals(); err != nil {
		return nil, err
	}

	from, err := c.source()
	if err != nil {
		return nil, err
	}

	// Computations put a statement around the one that groups the rows.
	compute := q.hasCompute()
	var selects []string
	groupBy := 0
	switch q.Mode {
	case "", ModeAggregate:
		if len(q.Columns) > 0 {
			return nil, bad("invalid_query", nil, "columns is only for detail mode")
		}
		if len(q.Dimensions)+len(q.Measures) == 0 {
			return nil, bad("empty_query", nil, "select at least one dimension or measure")
		}
		for _, dim := range q.Dimensions {
			sql, err := c.dimension(dim)
			if err != nil {
				return nil, err
			}
			selects = append(selects, sql)
		}
		groupBy = len(q.Dimensions)
		for _, m := range q.Measures {
			sql, err := c.measure(m, true)
			if err != nil {
				return nil, err
			}
			if !compute {
				// Nothing is put around this statement, so it gives the result.
				sql = c.shown(sql, c.measureTypes[m.Name()])
			}
			selects = append(selects, sql+" AS "+c.d.QuoteIdent(m.Name()))
		}
		for _, m := range q.FilterMeasures {
			sql, err := c.measure(m, false)
			if err != nil {
				return nil, err
			}
			if compute {
				selects = append(selects, sql+" AS "+c.d.QuoteIdent(m.Name()))
			}
		}
	case ModeDetail:
		if len(q.Dimensions)+len(q.Measures)+len(q.FilterMeasures) > 0 || q.Having != nil {
			return nil, bad("invalid_query", nil, "detail mode takes columns, not dimensions, measures or having")
		}
		if len(q.Columns) == 0 {
			return nil, bad("empty_query", nil, "select at least one column")
		}
		for _, column := range q.Columns {
			sql, err := c.dimension(Dimension{Field: column.Field, Label: column.Label})
			if err != nil {
				return nil, err
			}
			selects = append(selects, sql)
		}
	default:
		return nil, bad("invalid_query", nil, "unknown mode %q", q.Mode)
	}

	var where []string
	if opt.RowFilter != nil {
		sql, err := c.filter(*opt.RowFilter, c.rowFilterOperand)
		if err != nil {
			return nil, err
		}
		where = append(where, sql)
	}
	if q.Filter != nil {
		sql, err := c.filter(*q.Filter, c.fieldOperand)
		if err != nil {
			return nil, err
		}
		where = append(where, sql)
	}

	var sb strings.Builder
	sb.WriteString("SELECT ")
	sb.WriteString(strings.Join(selects, ", "))
	sb.WriteString("\nFROM ")
	sb.WriteString(from)
	if len(where) > 0 {
		sb.WriteString("\nWHERE ")
		sb.WriteString(strings.Join(where, " AND "))
	}
	if groupBy > 0 {
		positions := make([]string, groupBy)
		for i := range positions {
			positions[i] = strconv.Itoa(i + 1)
		}
		sb.WriteString("\nGROUP BY ")
		sb.WriteString(strings.Join(positions, ", "))
	}
	if compute {
		sql, err := c.computations(sb.String(), from, where)
		if err != nil {
			return nil, err
		}
		sb.Reset()
		sb.WriteString(sql)
	}
	if q.Having != nil {
		sql, err := c.filter(*q.Having, c.measureOperand)
		if err != nil {
			return nil, err
		}
		if compute {
			sb.WriteString("\nWHERE ")
		} else {
			sb.WriteString("\nHAVING ")
		}
		sb.WriteString(sql)
	}
	if q.Candidates != nil {
		return c.candidateValues(sb.String(), from, where)
	}

	order, err := c.orderBy(groupBy)
	if err != nil {
		return nil, err
	}
	if order != "" {
		sb.WriteString("\nORDER BY ")
		sb.WriteString(order)
	}

	limit, err := c.limit()
	if err != nil {
		return nil, err
	}
	if q.Offset < 0 {
		return nil, bad("invalid_query", nil, "offset cannot be negative")
	}
	sb.WriteString("\n" + c.d.Page(limit+1, q.Offset))

	if c.failed != nil {
		return nil, c.failed
	}
	sql, ordered := c.args.finalize(sb.String(), c.d)
	return &Compiled{SQL: sql, Args: ordered, Columns: c.columns, Limit: limit}, nil
}

// span is a piece of the source SQL that went into a statement unchanged.
// All three are counted in bytes.
type span struct {
	at     int // where it is in the statement
	source int // where it is in the source SQL
	length int
}

// SourceStatement is a statement built around a dataset's source SQL.
type SourceStatement struct {
	SQL   string
	Args  []any
	spans []span
}

// Locate takes a byte offset in the statement, such as where the database
// found an error, to the offset in the source SQL the author wrote. A place
// the author did not write, a parameter's value or what follows the SQL, is
// taken to the nearest place before it that they did. It reports false for a
// place ahead of the source SQL, and for a source that is a table.
func (s *SourceStatement) Locate(offset int) (int, bool) {
	for i := len(s.spans) - 1; i >= 0; i-- {
		if sp := s.spans[i]; sp.at <= offset {
			return sp.source + min(offset-sp.at, sp.length), true
		}
	}
	return 0, false
}

// SourceSQL returns a statement selecting everything from the dataset's
// source, for discovering or exporting its columns. Only the source and parameters of the
// spec are used, so it works before any field is defined.
func SourceSQL(spec *dataset.Spec, opt Options) (*SourceStatement, error) {
	c := &compiler{q: &Query{}, spec: spec, opt: opt, d: opt.Dialect}
	if err := c.setTimezone(); err != nil {
		return nil, err
	}
	from, err := c.source()
	if err != nil {
		return nil, err
	}
	const head = "SELECT * FROM "
	offsets := make([]int, len(c.spans))
	for i, sp := range c.spans {
		offsets[i] = len(head) + sp.at
	}
	sql, ordered, moved := c.args.finalizeAt(head+from, c.d, offsets)
	for i := range c.spans {
		c.spans[i].at = moved[i]
	}
	return &SourceStatement{SQL: sql, Args: ordered, spans: c.spans}, nil
}

func (c *compiler) setTimezone() error {
	c.zone = c.q.Timezone
	if c.zone == "" {
		c.zone = c.opt.Timezone
	}
	if c.zone == "" {
		c.zone = "UTC"
	}
	loc, err := time.LoadLocation(c.zone)
	// LoadLocation accepts "Local" and "", neither is a database time zone.
	if err != nil || c.zone == "Local" || strings.ContainsAny(c.zone, "'\\ ") {
		return bad("invalid_timezone", []string{"timezone", c.zone}, "unknown time zone %q", c.zone)
	}
	c.loc = loc
	return nil
}

func (c *compiler) limit() (int, error) {
	limit := c.opt.DefaultLimit
	if c.q.Limit != nil {
		if *c.q.Limit <= 0 {
			return 0, bad("invalid_query", nil, "limit must be positive")
		}
		limit = *c.q.Limit
	}
	return min(limit, c.opt.MaxLimit), nil
}

// ---- source ----

func (c *compiler) source() (string, error) {
	src := c.spec.Source
	if src.Type == "table" {
		name := c.d.QuoteIdent(src.Table)
		if src.Schema != "" {
			name = c.d.QuoteIdent(src.Schema) + "." + name
		}
		return name + " AS " + sourceAlias, nil
	}
	if strings.Contains(src.SQL, markerByte) {
		return "", bad("invalid_source", nil, "the source SQL contains a NUL character")
	}
	for name := range c.q.Params {
		if _, ok := c.spec.ParamByName(name); !ok {
			return "", bad("unknown_param", []string{"name", name}, "the dataset has no parameter %q", name)
		}
	}
	values := map[string][]any{}
	for _, p := range c.spec.Params {
		v, err := c.paramValue(p)
		if err != nil {
			return "", err
		}
		if v != nil {
			values[p.Name] = v
		}
	}

	written := strings.TrimRight(strings.TrimSpace(src.SQL), ";")
	tpl, err := dataset.ParseTemplate(written)
	if err != nil {
		return "", err
	}
	const open = "(\n"
	// What was trimmed from the front still counts in the author's positions.
	lead := strings.Index(src.SQL, written)
	c.spans = nil
	var sb strings.Builder
	missing := tpl.Render(
		func(name string) bool { return values[name] != nil },
		func(sql string, pos int) {
			c.spans = append(c.spans, span{at: len(open) + sb.Len(), source: lead + pos, length: len(sql)})
			sb.WriteString(sql)
		},
		func(name string) {
			p, _ := c.spec.ParamByName(name)
			if !p.Multi {
				sb.WriteString(c.bind(values[name][0], p.Type))
				return
			}
			markers := make([]string, len(values[name]))
			for i, v := range values[name] {
				markers[i] = c.bind(v, p.Type)
			}
			sb.WriteString("(" + strings.Join(markers, ", ") + ")")
		},
	)
	if missing != "" {
		return "", bad("missing_param", []string{"name", missing}, "parameter %q needs a value", missing)
	}
	return open + sb.String() + "\n) AS " + sourceAlias, nil
}

// paramValue returns the values to bind for a parameter, or nil when it has
// none. A parameter left out of the query takes its default; one given as
// null or as an empty list has no value, the way an empty filter restricts
// nothing, and the [[ ]] around it is dropped.
func (c *compiler) paramValue(p dataset.Param) ([]any, error) {
	raw, given := c.q.Params[p.Name]
	if !given {
		raw = p.Default
	}
	if raw == nil && c.opt.SampleMissingParams {
		raw = sampleValue(p.Type)
	}
	if raw == nil {
		if p.Required {
			return nil, bad("missing_param", []string{"name", p.Name}, "parameter %q needs a value", p.Name)
		}
		return nil, nil
	}
	items := []any{raw}
	if list, ok := raw.([]any); ok {
		if !p.Multi {
			return nil, bad("invalid_param_value", []string{"name", p.Name}, "parameter %q takes a single value", p.Name)
		}
		items = list
	}
	if len(items) == 0 {
		if p.Required {
			return nil, bad("missing_param", []string{"name", p.Name}, "parameter %q needs a value", p.Name)
		}
		return nil, nil
	}
	out := make([]any, len(items))
	for i, item := range items {
		if rel, ok := item.(map[string]any); ok {
			expr, _ := rel["relative"].(string)
			day, err := RelativeDay(expr, c.opt.Now.In(c.loc))
			if err != nil {
				if !given {
					return nil, bad("invalid_param_default", []string{"name", p.Name}, "parameter %q has an invalid relative default %q", p.Name, expr)
				}
				return nil, bad("invalid_param_value", []string{"name", p.Name}, "parameter %q has an invalid relative day %q", p.Name, expr)
			}
			item = day
		}
		v, err := c.literal(item, p.Type, false)
		if err != nil {
			return nil, bad("invalid_param_value", []string{"name", p.Name}, "parameter %q: %v", p.Name, err)
		}
		out[i] = v
	}
	return out, nil
}

// CheckParamValue reports whether v is one value of parameter p, as a chart
// may offer it: a literal of the parameter's type or, for a date parameter, a
// day relative to today such as {"relative": "today-1d"}.
func CheckParamValue(p dataset.Param, v any) error {
	if rel, ok := v.(map[string]any); ok {
		expr, _ := rel["relative"].(string)
		if p.Type != datasource.Date || len(rel) != 1 {
			return fmt.Errorf("only a date parameter takes a relative day")
		}
		_, err := RelativeDay(expr, time.Now())
		return err
	}
	_, err := (&compiler{loc: time.UTC}).literal(v, p.Type, false)
	return err
}

func sampleValue(t datasource.Type) any {
	switch t {
	case datasource.Integer, datasource.Decimal, datasource.Float:
		return float64(0)
	case datasource.Boolean:
		return false
	case datasource.Date:
		return "2000-01-01"
	case datasource.Timestamp:
		return "2000-01-01T00:00:00"
	}
	return ""
}

// RelativeDay is the day "today", "today-1d" or "today+7d" stands for at now,
// as a query takes it: now is in the query's time zone.
func RelativeDay(expr string, now time.Time) (string, error) {
	rest, ok := strings.CutPrefix(strings.ReplaceAll(expr, " ", ""), "today")
	if !ok {
		return "", fmt.Errorf("must start with today")
	}
	days := 0
	if rest != "" {
		n, err := strconv.Atoi(strings.TrimSuffix(rest, "d"))
		if err != nil || !strings.HasSuffix(rest, "d") || (rest[0] != '+' && rest[0] != '-') {
			return "", fmt.Errorf("expected a form like today-1d")
		}
		days = n
	}
	return now.AddDate(0, 0, days).Format("2006-01-02"), nil
}

// ---- select list ----

func (c *compiler) addColumn(col OutputColumn) error {
	if !dataset.ValidKey(col.Name) {
		return bad("invalid_alias", []string{"alias", col.Name}, "invalid alias %q", col.Name)
	}
	if c.aliases[col.Name] {
		return bad("duplicate_alias", []string{"alias", col.Name}, "output column %q appears twice; give one an alias", col.Name)
	}
	c.aliases[col.Name] = true
	c.columns = append(c.columns, col)
	return nil
}

// fieldSQL writes a field. A field the database cannot compute is remembered
// in c.failed, and stops the query from being compiled.
func (c *compiler) fieldSQL(key string) string {
	sql, err := c.spec.FieldSQL(key, dataset.Writer{
		Quote: func(name string) string { return sourceAlias + "." + c.d.QuoteIdent(name) },
		Env:   expr.Env{Dialect: c.d, Zone: c.zone, WeekStart: c.opt.WeekStart, Today: c.opt.Now.In(c.loc).Format(time.DateOnly)},
	})
	if err != nil && c.failed == nil {
		c.failed = err
	}
	return sql
}

// lookup returns a field of the dataset the caller may see.
func (c *compiler) lookup(key string) (dataset.Field, error) {
	field, ok := c.spec.FieldByKey(key)
	if !ok {
		return field, bad("unknown_field", []string{"key", key}, "the dataset has no field %q", key)
	}
	if c.opt.Hidden[key] {
		// Its label is not given: it is not the caller's to see.
		return field, bad("hidden_field", []string{"key", key}, "the field %q is not yours to see", key)
	}
	return field, nil
}

// rowField returns a field that has a value on every row, which is what
// grouping, filtering and aggregating need.
func (c *compiler) rowField(key string) (dataset.Field, error) {
	field, err := c.lookup(key)
	if err != nil {
		return field, err
	}
	return c.notMetric(field)
}

func (c *compiler) notMetric(field dataset.Field) (dataset.Field, error) {
	if field.Role == dataset.Metric {
		return field, bad("metric_field", []string{"key", field.Key, "label", field.Label}, "%q is a metric, so it can only be used as a measure of a query", field.Label)
	}
	return field, nil
}

func (c *compiler) dimension(dim Dimension) (string, error) {
	field, expr, err := c.dimensionValue(dim)
	if err != nil {
		return "", err
	}
	alias := dim.Alias
	if alias == "" {
		alias = field.Key
	}
	label, err := c.label(dim.Label, field.Label)
	if err != nil {
		return "", err
	}
	if err := c.addColumn(OutputColumn{Name: alias, Type: field.Type, Role: "dimension", Label: label, Format: field.Format, Grain: dim.Grain}); err != nil {
		return "", err
	}
	return expr + " AS " + c.d.QuoteIdent(alias), nil
}

// dimensionValue is shared by output grouping and candidate-group matching.
// Date grains and timestamp timezone conversion must be identical on both sides.
func (c *compiler) dimensionValue(dim Dimension) (dataset.Field, string, error) {
	field, err := c.rowField(dim.Field)
	if err != nil {
		return field, "", err
	}
	expr := c.fieldSQL(field.Key)
	switch field.Type {
	case datasource.Timestamp:
		if !c.opt.RawTimes {
			expr = c.d.LocalTime(expr, c.zone)
		}
		if dim.Grain != "" {
			if !validGrain(dim.Grain) {
				return field, "", bad("invalid_grain", []string{"grain", string(dim.Grain)}, "unknown grain %q", dim.Grain)
			}
			expr = c.d.TruncTime(expr, dim.Grain, c.opt.WeekStart)
		}
	case datasource.Date:
		if dim.Grain != "" {
			if !validGrain(dim.Grain) || dim.Grain == dialect.Hour || dim.Grain == dialect.Minute {
				return field, "", bad("invalid_grain", []string{"grain", string(dim.Grain), "key", field.Key}, "grain %q cannot be applied to date field %q", dim.Grain, field.Key)
			}
			expr = c.d.TruncDate(expr, dim.Grain, c.opt.WeekStart)
		}
	default:
		if dim.Grain != "" {
			return field, "", bad("grain_needs_time", []string{"key", field.Key}, "field %q is not a date or timestamp, so it cannot take a grain", field.Key)
		}
	}
	return field, expr, nil
}

// label returns the name a column is shown under: the one the query gives it,
// or else the field's own.
func (c *compiler) label(given, own string) (string, error) {
	if given == "" {
		return own, nil
	}
	if !dataset.ValidLabel(given) {
		return "", bad("invalid_column_label", []string{"label", given}, "%q cannot be the label of a column", given)
	}
	return given, nil
}

// measure adds a measure of the query and returns its aggregate as SQL. A time
// is still the moment: having and sorting compare that, and only the result
// writes it in the query zone (see shown).
func (c *compiler) measure(m Measure, visible bool) (string, error) {
	if err := c.checkCompute(m.Compute); err != nil {
		return "", err
	}
	if m.Field == "" {
		return "", bad("invalid_measure", nil, "a measure names a field")
	}
	field, err := c.lookup(m.Field)
	if err != nil {
		return "", err
	}
	pairs := []string{"key", field.Key, "label", field.Label}
	var expr string
	col := OutputColumn{Name: m.Name(), Label: field.Label, Format: field.Format}
	if field.Role == dataset.Metric {
		if m.Agg != "" {
			return "", bad("metric_agg", pairs, "%q is a metric, which aggregates by itself", field.Label)
		}
		expr, col.Type = c.fieldSQL(field.Key), field.Type
	} else {
		switch {
		case m.Agg == "":
			return "", bad("agg_required", pairs, "%q needs an aggregation to be a measure of a query", field.Label)
		case !m.Agg.Valid():
			return "", bad("invalid_agg", []string{"agg", string(m.Agg)}, "unknown aggregation %q", m.Agg)
		}
		if err := dataset.CheckAgg(m.Agg, field); err != nil {
			return "", err
		}
		expr = c.aggregate(m.Agg, c.fieldSQL(field.Key))
		col.Type, col.Agg = m.Agg.ResultType(field.Type), m.Agg
	}
	if col.Agg == dataset.Count || col.Agg == dataset.CountDistinct {
		col.Format = nil
	}
	if m.BaseLabel != "" {
		label, err := c.label(m.BaseLabel, col.Label)
		if err != nil {
			return "", err
		}
		col.Label, col.Agg = label, ""
	}
	if m.Label != "" {
		// A label that was given is the whole name: nothing is to be added to it.
		label, err := c.label(m.Label, col.Label)
		if err != nil {
			return "", err
		}
		col.Label, col.Agg = label, ""
	}
	if m.Compute != nil {
		if !col.Type.Numeric() {
			return "", bad("compute_needs_number", pairs, "derived calculation needs a numeric aggregate")
		}
		// Only these carry from one group's value to the next and still equal
		// the rows aggregated again. A metric's expression is not read, so
		// whether it adds up is not known.
		if m.Compute.Type == Cumulative && !slices.Contains([]dataset.Agg{dataset.Sum, dataset.Count, dataset.Min, dataset.Max}, m.Agg) {
			return "", bad("cumulative_agg", pairs, "%q cannot be accumulated: only sums, counts, minimums and maximums can", field.Label)
		}
		if m.Compute.Type == PercentOfTotal || m.Compute.Type == Compare && m.Compute.Output != "value" {
			col.Type = datasource.Float
		}
		if m.Compute.Type == PercentOfTotal || m.Compute.Output == "ratio" {
			col.Format = &dataset.Format{Style: "percent"}
		}
		if m.Label == "" {
			col.Compute = m.Compute.Type
			if m.Compute.Type == Compare {
				col.Comparison = &Comparison{Offset: *m.Compute.Offset, Output: m.Compute.Output}
			}
		}
	}
	col.Role = "measure"
	if visible {
		if err := c.addColumn(col); err != nil {
			return "", err
		}
	} else {
		if !dataset.ValidKey(col.Name) {
			return "", bad("invalid_alias", []string{"alias", col.Name}, "invalid alias %q", col.Name)
		}
		if c.aliases[col.Name] || c.measureSQL[col.Name] != "" {
			return "", bad("duplicate_alias", []string{"alias", col.Name}, "filter measure %q conflicts with another column or measure", col.Name)
		}
	}
	c.measureSQL[col.Name] = expr
	c.measureTypes[col.Name] = col.Type
	return expr, nil
}

// shown is a measure as the result gives it: a time is written in the query
// zone, as a dimension is. It is aggregated as instants first, which is also
// what having and sorting compare: wall-clock times repeat when the clocks go
// back, so the latest of them need not be the latest moment.
func (c *compiler) shown(sql string, t datasource.Type) string {
	if t == datasource.Timestamp && !c.opt.RawTimes {
		return c.d.LocalTime(sql, c.zone)
	}
	return sql
}

// aggregate is written as the database writes it: ClickHouse, for one, gives
// the least of no rows as a value unless asked otherwise.
func (c *compiler) aggregate(agg dataset.Agg, inner string) string {
	write, ok := c.d.Function(string(agg))
	if !ok {
		if c.failed == nil {
			c.failed = bad("function_unavailable", []string{"name", string(agg), "dialect", c.d.Name()}, "%s is not available on %s", agg, c.d.Name())
		}
		return "NULL"
	}
	return write([]dialect.Operand{{SQL: inner}})
}

// ---- filters ----

// operand resolves the left side of a comparison.
type operand func(name string) (sql string, t datasource.Type, err error)

func (c *compiler) fieldOperand(key string) (string, datasource.Type, error) {
	field, err := c.rowField(key)
	if err != nil {
		return "", "", err
	}
	return c.operandOf(field)
}

// rowFilterOperand is fieldOperand for the row filter, which may name fields
// the caller may not see: it is the server's, and shows no value.
func (c *compiler) rowFilterOperand(key string) (string, datasource.Type, error) {
	field, ok := c.spec.FieldByKey(key)
	if !ok {
		return "", "", bad("unknown_field", []string{"key", key}, "the dataset has no field %q", key)
	}
	if _, err := c.notMetric(field); err != nil {
		return "", "", err
	}
	return c.operandOf(field)
}

func (c *compiler) operandOf(field dataset.Field) (string, datasource.Type, error) {
	key := field.Key
	sql := c.fieldSQL(key)
	if field.Type == datasource.Timestamp {
		// Compared as instants, against times parsed in the query zone.
		sql = c.d.Instant(sql)
	}
	return sql, field.Type, nil
}

func (c *compiler) measureOperand(alias string) (string, datasource.Type, error) {
	sql, ok := c.measureSQL[alias]
	if !ok {
		return "", "", bad("unknown_output_measure", []string{"alias", alias}, "having refers to %q, which is not a measure of this query", alias)
	}
	t := c.measureTypes[alias]
	switch {
	case t == "" || t.Numeric():
		// Numeric aggregates have always been compared as decimals: a count
		// against 2.5, or against "10" sent as text, must keep compiling.
		t = datasource.Decimal
	case t == datasource.Timestamp:
		// Aggregate timestamps use the same instant semantics as row fields.
		sql = c.d.Instant(sql)
	case t == datasource.Boolean:
		// A boolean metric may itself be a comparison or a logical expression.
		// Keep it one operand before applying the viewer's IN/null condition.
		sql = "(" + sql + ")"
	}
	return sql, t, nil
}

var comparisons = map[string]string{"eq": "=", "ne": "<>", "gt": ">", "gte": ">=", "lt": "<", "lte": "<="}

func (c *compiler) filter(f dataset.Filter, resolve operand) (string, error) {
	// No row passes; data permissions use it for whoever may see none.
	if f.Op == "false" {
		return "1 = 0", nil
	}
	if f.Logical() {
		if f.Op == "not" {
			if len(f.Args) != 1 {
				return "", bad("invalid_filter", []string{"op", f.Op}, "not takes exactly one condition")
			}
			inner, err := c.filter(f.Args[0], resolve)
			if err != nil {
				return "", err
			}
			return "NOT (" + inner + ")", nil
		}
		if len(f.Args) == 0 {
			return "", bad("invalid_filter", []string{"op", f.Op}, "%s needs at least one condition", f.Op)
		}
		parts := make([]string, len(f.Args))
		for i, arg := range f.Args {
			inner, err := c.filter(arg, resolve)
			if err != nil {
				return "", err
			}
			parts[i] = inner
		}
		return "(" + strings.Join(parts, " "+strings.ToUpper(f.Op)+" ") + ")", nil
	}

	left, t, err := resolve(f.Field)
	if err != nil {
		return "", err
	}
	one := func(v any) (string, error) {
		lit, err := c.literal(v, t, true)
		if err != nil {
			return "", bad("invalid_filter_value", []string{"key", f.Field, "op", f.Op}, "filter on %q: %v", f.Field, err)
		}
		return c.bind(lit, t), nil
	}
	list := func() ([]string, error) {
		items, ok := f.Value.([]any)
		if !ok {
			return nil, bad("invalid_filter_value", []string{"key", f.Field, "op", f.Op}, "filter on %q: %s needs a list", f.Field, f.Op)
		}
		markers := make([]string, len(items))
		for i, item := range items {
			if markers[i], err = one(item); err != nil {
				return nil, err
			}
		}
		return markers, nil
	}

	switch f.Op {
	case "eq", "ne", "gt", "gte", "lt", "lte":
		marker, err := one(f.Value)
		if err != nil {
			return "", err
		}
		return left + " " + comparisons[f.Op] + " " + marker, nil
	case "in", "not_in":
		markers, err := list()
		if err != nil {
			return "", err
		}
		if len(markers) == 0 {
			// Nothing is in an empty list; everything is outside it.
			if f.Op == "in" {
				return "1 = 0", nil
			}
			return "1 = 1", nil
		}
		not := ""
		if f.Op == "not_in" {
			not = "NOT "
		}
		return left + " " + not + "IN (" + strings.Join(markers, ", ") + ")", nil
	case "between", "not_between":
		rangeValue, err := decodeFilterRange(f.Value)
		if err != nil {
			return "", bad("invalid_filter_value", []string{"key", f.Field, "op", f.Op}, "filter on %q: %v", f.Field, err)
		}
		lower, err := one(rangeValue.Min)
		if err != nil {
			return "", err
		}
		upper, err := one(rangeValue.Max)
		if err != nil {
			return "", err
		}
		includeMin := rangeValue.IncludeMin == nil || *rangeValue.IncludeMin
		includeMax := rangeValue.IncludeMax == nil || *rangeValue.IncludeMax
		if includeMin && includeMax {
			not := ""
			if f.Op == "not_between" {
				not = "NOT "
			}
			return left + " " + not + "BETWEEN " + lower + " AND " + upper, nil
		}
		lowerOp, upperOp := ">", "<"
		if includeMin {
			lowerOp = ">="
		}
		if includeMax {
			upperOp = "<="
		}
		condition := "(" + left + " " + lowerOp + " " + lower + " AND " + left + " " + upperOp + " " + upper + ")"
		if f.Op == "not_between" {
			condition = "NOT " + condition
		}
		return condition, nil
	case "contains", "not_contains", "starts_with", "ends_with", "like", "not_like":
		text, ok := f.Value.(string)
		if !ok || t != datasource.String {
			return "", bad("invalid_filter_value", []string{"key", f.Field, "op", f.Op}, "filter on %q: %s needs a text field and a text value", f.Field, f.Op)
		}
		kind := map[string]dialect.Pattern{"contains": dialect.Contains, "not_contains": dialect.Contains, "starts_with": dialect.StartsWith, "ends_with": dialect.EndsWith, "like": dialect.Wildcard, "not_like": dialect.Wildcard}[f.Op]
		// How text is matched differs between databases, so the dialect writes it.
		match := c.d.Match(left, kind, text, c.args.add)
		if f.Op == "not_contains" || f.Op == "not_like" {
			return "NOT (" + match + ")", nil
		}
		return match, nil
	case OpTime:
		return c.timeRange(f, left, t)
	case "is_null":
		return left + " IS NULL", nil
	case "not_null":
		return left + " IS NOT NULL", nil
	case "is_empty", "not_empty":
		if t != datasource.String {
			return "", bad("invalid_filter_value", []string{"key", f.Field, "op", f.Op}, "filter on %q: %s needs a text field", f.Field, f.Op)
		}
		comparison := "="
		if f.Op == "not_empty" {
			comparison = "<>"
		}
		return left + " " + comparison + " " + c.args.add(""), nil
	}
	return "", bad("invalid_filter", []string{"op", f.Op}, "unknown filter operator %q", f.Op)
}

// literal checks a JSON value against a logical type and converts it to what
// gets bound. Timestamps become instants when asInstant is set, and stay text
// otherwise (a dataset parameter is compared however the author's SQL says).
func (c *compiler) literal(v any, t datasource.Type, asInstant bool) (any, error) {
	switch t {
	case datasource.String:
		if s, ok := v.(string); ok {
			return s, nil
		}
	case datasource.Boolean:
		if b, ok := v.(bool); ok {
			return b, nil
		}
	case datasource.Integer:
		switch x := v.(type) {
		case float64:
			if x == math.Trunc(x) && math.Abs(x) < 1<<53 {
				return int64(x), nil
			}
		case string: // an integer too large for a JSON number, as results give it
			if n, err := strconv.ParseInt(x, 10, 64); err == nil {
				return n, nil
			}
		}
	case datasource.Decimal, datasource.Float:
		switch x := v.(type) {
		case float64:
			return x, nil
		case string: // lets a client send a decimal without losing digits
			if _, err := strconv.ParseFloat(x, 64); err == nil {
				return x, nil
			}
		}
	case datasource.Date:
		if s, ok := v.(string); ok {
			if _, err := time.Parse("2006-01-02", s); err == nil {
				return s, nil
			}
		}
	case datasource.Timestamp:
		if s, ok := v.(string); ok {
			parsed, err := parseLocalTime(s, c.loc)
			if err != nil {
				return nil, err
			}
			if asInstant {
				return parsed, nil
			}
			return parsed.Format("2006-01-02 15:04:05"), nil
		}
	}
	return nil, fmt.Errorf("%v is not a valid %s value", v, t)
}

// ---- time range ----

// resolveFieldTimeRange keeps DATE values in a DST-free calendar. Both the
// current and comparison periods must use the same calendar interpretation.
func (c *compiler) resolveFieldTimeRange(tr *TimeRange, t datasource.Type) (time.Time, time.Time, error) {
	now, location := c.opt.Now, c.loc
	if t == datasource.Date {
		// DATE values are calendar dates, not instants. Resolve in a DST-free
		// calendar while retaining the current wall date in the query zone;
		// some zones skip midnight (or even a whole day) during a transition.
		local := now.In(c.loc)
		now = time.Date(local.Year(), local.Month(), local.Day(), local.Hour(), local.Minute(), local.Second(), local.Nanosecond(), time.UTC)
		location = time.UTC
	}
	return resolveTimeRange(tr, now, location, c.opt.WeekStart)
}

// timeRange writes a "time" condition. left is the field as fieldOperand
// gives it: a timestamp is already an instant.
func (c *compiler) timeRange(f dataset.Filter, left string, t datasource.Type) (string, error) {
	if !t.Temporal() {
		return "", bad("time_field_required", []string{"key", f.Field}, "%q is not a date or timestamp, so it cannot take a time range", f.Field)
	}
	tr, err := DecodeTimeRange(f.Value)
	if err != nil {
		return "", err
	}
	start, end, err := c.resolveFieldTimeRange(tr, t)
	if err != nil {
		return "", err
	}
	if tr.Special == "is_null" {
		return left + " IS NULL", nil
	}
	if tr.Special == "not_null" {
		return left + " IS NOT NULL", nil
	}
	if t == datasource.Date && tr.Bounds != nil {
		// A calendar date has no time of day. Silently formatting a midday
		// bound as a date would change which rows fall inside the interval.
		for _, bound := range []*TimeBound{tr.Bounds.Start, tr.Bounds.End} {
			if bound != nil && bound.Relative != nil && (bound.Relative.Unit == dialect.Hour || bound.Relative.Unit == dialect.Minute) {
				return "", bad("invalid_time_range", nil, "relative bounds on a date field need a day or coarser unit")
			}
		}
		for _, bound := range []time.Time{start, end} {
			if !bound.IsZero() && (bound.Hour() != 0 || bound.Minute() != 0 || bound.Second() != 0 || bound.Nanosecond() != 0) {
				return "", bad("invalid_time_range", nil, "bounds on a date field must be local midnight")
			}
		}
	}
	bind := func(at time.Time) string { return c.bind(at.Format("2006-01-02"), datasource.Date) }
	if t == datasource.Timestamp {
		bind = func(at time.Time) string { return c.args.add(at) }
	}
	var parts []string
	if !start.IsZero() {
		parts = append(parts, left+" >= "+bind(start))
	}
	if !end.IsZero() {
		parts = append(parts, left+" < "+bind(end))
	}
	if len(parts) == 0 {
		return "1 = 1", nil
	}
	if tr.IncludeNull {
		return "((" + strings.Join(parts, " AND ") + ") OR " + left + " IS NULL)", nil
	}
	return "(" + strings.Join(parts, " AND ") + ")", nil
}

// ---- order ----

func (c *compiler) orderBy(dimensions int) (string, error) {
	var parts []string
	for _, s := range c.q.Sort {
		if !c.aliases[s.By] {
			return "", bad("unknown_sort_column", []string{"alias", s.By}, "cannot sort by %q: it is not an output column", s.By)
		}
		part := c.d.QuoteIdent(s.By)
		if c.measureTypes[s.By] == datasource.Timestamp {
			// The moments, not the times written, which repeat when the clocks go back.
			part = c.measureSQL[s.By]
		}
		if s.Desc {
			part += " DESC"
		}
		parts = append(parts, part)
	}
	if len(parts) == 0 {
		// A stable default: without it the same query could return rows in a
		// different order each time, and charts would flicker.
		for i := range dimensions {
			parts = append(parts, strconv.Itoa(i+1))
		}
	}
	return strings.Join(parts, ", "), nil
}
