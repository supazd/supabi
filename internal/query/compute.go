package query

import (
	"slices"
	"strconv"
	"strings"

	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/dialect"
)

func (q *Query) hasCompute() bool {
	return slices.ContainsFunc(q.Measures, func(m Measure) bool { return m.Compute != nil }) ||
		slices.ContainsFunc(q.FilterMeasures, func(m Measure) bool { return m.Compute != nil })
}

func (c *compiler) checkCompute(compute *Compute) error {
	if compute == nil {
		return nil
	}
	if compute.Type == Compare {
		return c.checkCompare(compute)
	}
	if compute.Type == Cumulative {
		if len(compute.Within) != 0 || compute.TimeField != "" || compute.Offset != nil || compute.Output != "" {
			return bad("invalid_cumulative", nil, "a running total takes only the dimension it runs along")
		}
		if !slices.ContainsFunc(c.q.Dimensions, func(d Dimension) bool { return d.Name() == compute.Along }) {
			return bad("invalid_cumulative", []string{"column", compute.Along}, "along must name an output dimension; invalid dimension %q", compute.Along)
		}
		return nil
	}
	if compute.Type != PercentOfTotal {
		return bad("compute_not_supported", []string{"type", compute.Type}, "derived calculation %q is not supported yet", compute.Type)
	}
	if compute.TimeField != "" || compute.Offset != nil || compute.Output != "" || compute.Along != "" {
		return bad("invalid_compute", nil, "percent of total does not accept comparison or running total settings")
	}
	for i, name := range compute.Within {
		if !slices.ContainsFunc(c.q.Dimensions, func(d Dimension) bool { return d.Name() == name }) || slices.Contains(compute.Within[:i], name) {
			return bad("invalid_compute", []string{"column", name}, "within must name distinct output dimensions; invalid dimension %q", name)
		}
	}
	return nil
}

// computations joins independently aggregated baselines to the original
// groups. Summing the displayed values would be wrong for DISTINCT, averages
// and metrics. Both sides read the same source, bound parameters, row filters
// and access restrictions; HAVING and pagination apply only after division.
// Running totals are taken over the groups themselves, before HAVING too.
func (c *compiler) computations(groups, from string, where []string) (string, error) {
	float, ok := c.d.Function("to_float")
	divide, divides := c.d.Function("/")
	if !ok || !divides {
		return "", bad("compute_not_supported", nil, "database does not support numeric division")
	}
	joined := "\nFROM (\n" + groups + "\n) AS pct_rows"
	measures := append(slices.Clone(c.q.Measures), c.q.FilterMeasures...)
	running := false
	for i, m := range measures {
		base := c.measureSQL[m.Name()]
		value := "pct_rows." + c.d.QuoteIdent(m.Name())
		if m.Compute != nil && m.Compute.Type == Compare {
			join, previous, err := c.comparisonJoin(m.Compute, base, from, i)
			if err != nil {
				return "", err
			}
			joined += join
			if m.Compute.Output == "value" {
				value = previous
			} else {
				left := float([]dialect.Operand{{SQL: value}})
				right := float([]dialect.Operand{{SQL: previous}})
				value = "(" + left + " - " + right + ")"
				if m.Compute.Output == "ratio" {
					value = divide([]dialect.Operand{{SQL: value, Type: "float"}, {SQL: right, Type: "float"}})
				}
			}
		} else if m.Compute != nil && m.Compute.Type == Cumulative {
			value, running = c.running(m, value), true
		} else if m.Compute != nil {
			alias := "pct_total_" + strconv.Itoa(i)
			var selects, positions, on []string
			for j, name := range m.Compute.Within {
				dim := c.q.Dimensions[slices.IndexFunc(c.q.Dimensions, func(d Dimension) bool { return d.Name() == name })]
				_, sql, err := c.dimensionValue(dim)
				if err != nil {
					return "", err
				}
				key := c.d.QuoteIdent("key_" + strconv.Itoa(j))
				selects = append(selects, sql+" AS "+key)
				positions = append(positions, strconv.Itoa(j+1))
				on = append(on, c.d.NullSafeEqual("pct_rows."+c.d.QuoteIdent(name), alias+"."+key))
			}
			selects = append(selects, base+" AS "+c.d.QuoteIdent("value"))
			total := "SELECT " + strings.Join(selects, ", ") + "\nFROM " + from
			if len(where) > 0 {
				total += "\nWHERE " + strings.Join(where, " AND ")
			}
			if len(positions) > 0 {
				total += "\nGROUP BY " + strings.Join(positions, ", ")
			}
			if len(on) > 0 {
				joined += "\nINNER JOIN (\n" + total + "\n) AS " + alias + " ON " + strings.Join(on, " AND ")
			} else {
				joined += "\nCROSS JOIN (\n" + total + "\n) AS " + alias
			}
			// Floating division avoids integer truncation and database-specific
			// decimal scales. The dialect's division returns NULL on zero.
			left := float([]dialect.Operand{{SQL: value}})
			right := float([]dialect.Operand{{SQL: alias + "." + c.d.QuoteIdent("value")}})
			value = divide([]dialect.Operand{{SQL: left, Type: "float"}, {SQL: right, Type: "float"}})
		}
		c.measureSQL[m.Name()] = value
	}
	rows := "pct_rows."
	if running {
		// A window function cannot be filtered in the statement that computes
		// it, so HAVING goes on a statement around it.
		var inner []string
		for _, col := range c.columns {
			if col.Role == "dimension" {
				inner = append(inner, "pct_rows."+c.d.QuoteIdent(col.Name)+" AS "+c.d.QuoteIdent(col.Name))
			}
		}
		for _, m := range measures {
			inner = append(inner, c.measureSQL[m.Name()]+" AS "+c.d.QuoteIdent(m.Name()))
			c.measureSQL[m.Name()] = "cum_rows." + c.d.QuoteIdent(m.Name())
		}
		joined = "\nFROM (\nSELECT " + strings.Join(inner, ", ") + joined + "\n) AS cum_rows"
		rows = "cum_rows."
	}
	selects := make([]string, len(c.columns))
	for i, col := range c.columns {
		value := rows + c.d.QuoteIdent(col.Name)
		if col.Role == "measure" {
			value = c.shown(c.measureSQL[col.Name], col.Type)
		}
		selects[i] = value + " AS " + c.d.QuoteIdent(col.Name)
	}
	return "SELECT " + strings.Join(selects, ", ") + joined, nil
}

// running accumulates a group's value along one dimension, starting over for
// each combination of the others. Groups differ in some dimension, so each
// partition has one row for each value along it and the order has no ties.
// Sums and counts add up; the least and the greatest so far are the least and
// the greatest of the rows so far.
func (c *compiler) running(m Measure, value string) string {
	agg := m.Agg
	if agg == dataset.Count {
		agg = dataset.Sum
	}
	var partition []string
	for _, dim := range c.q.Dimensions {
		if dim.Name() != m.Compute.Along {
			partition = append(partition, "pct_rows."+c.d.QuoteIdent(dim.Name()))
		}
	}
	along := "pct_rows." + c.d.QuoteIdent(m.Compute.Along)
	// Groups without a value along come last, whichever way the database
	// would put them.
	window := "ORDER BY " + along + " IS NULL, " + along + " ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW"
	if len(partition) > 0 {
		window = "PARTITION BY " + strings.Join(partition, ", ") + " " + window
	}
	return c.aggregate(agg, value) + " OVER (" + window + ")"
}

// PruneCompute keeps group-relative percentages meaningful when dimensions
// are removed by a subtotal or an optional dynamic dimension. A running total
// whose dimension is gone is the plain aggregate: the value accumulated to
// the end. Copy rather than mutate the saved chart's measures or their
// compute definitions.
func (q *Query) PruneCompute() {
	has := func(name string) bool {
		return slices.ContainsFunc(q.Dimensions, func(d Dimension) bool { return d.Name() == name })
	}
	prune := func(measures []Measure) []Measure {
		out := slices.Clone(measures)
		for i, m := range out {
			if m.Compute == nil {
				continue
			}
			if m.Compute.Type == Cumulative {
				if !has(m.Compute.Along) {
					out[i].Compute = nil
				}
				continue
			}
			compute := *m.Compute
			compute.Within = slices.DeleteFunc(slices.Clone(compute.Within), func(name string) bool { return !has(name) })
			out[i].Compute = &compute
		}
		return out
	}
	q.Measures, q.FilterMeasures = prune(q.Measures), prune(q.FilterMeasures)
}
