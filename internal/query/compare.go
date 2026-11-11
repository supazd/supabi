package query

import (
	"strconv"
	"strings"
	"time"

	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/dialect"
)

func (c *compiler) checkCompare(compute *Compute) error {
	if len(compute.Within) != 0 || compute.Along != "" || compute.Offset == nil || compute.Offset.N < 1 || compute.Offset.N > 1000 {
		return bad("invalid_compare", nil, "comparison needs an offset between 1 and 1000 and cannot use within or along")
	}
	switch compute.Offset.Unit {
	case dialect.Day, dialect.Week, dialect.Month, dialect.Quarter, dialect.Year:
	default:
		return bad("invalid_compare", nil, "comparison offset must use day, week, month, quarter or year")
	}
	if compute.Output != "value" && compute.Output != "delta" && compute.Output != "ratio" {
		return bad("invalid_compare", nil, "comparison output must be value, delta or ratio")
	}
	field, err := c.rowField(compute.TimeField)
	if err != nil {
		return err
	}
	if field.Type != datasource.Date && field.Type != datasource.Timestamp {
		return bad("compare_time_field", nil, "comparison needs a date or timestamp field")
	}
	for _, dim := range c.q.Dimensions {
		if dim.Field == compute.TimeField && !comparisonGrain(dim.Grain, compute.Offset.Unit, compute.Offset.N) {
			return bad("compare_grain", nil, "comparison offset must preserve the time dimension's grain")
		}
	}
	_, err = c.comparisonFilter(compute)
	return err
}

// A previous bucket must begin on the same kind of boundary. For example,
// a calendar year is not a whole number of weeks, so weekly year-on-year
// requires an explicit offset of 52 weeks rather than silently matching none.
func comparisonGrain(grain, unit dialect.Grain, n int) bool {
	switch grain {
	case "", dialect.Day, dialect.Hour, dialect.Minute:
		return true
	case dialect.Week:
		return unit == dialect.Week || unit == dialect.Day && n%7 == 0
	case dialect.Month:
		return unit == dialect.Month || unit == dialect.Quarter || unit == dialect.Year
	case dialect.Quarter:
		return unit == dialect.Quarter || unit == dialect.Year || unit == dialect.Month && n%3 == 0
	case dialect.Year:
		return unit == dialect.Year || unit == dialect.Quarter && n%4 == 0 || unit == dialect.Month && n%12 == 0
	}
	return false
}

// calendarShift preserves local wall time. AddDate alone normalizes March 31
// minus one month to March 3; SQL calendars instead clamp it to February 28.
func calendarShift(at time.Time, offset Duration) time.Time {
	if at.IsZero() {
		return at
	}
	n := -offset.N
	if offset.Unit == dialect.Day || offset.Unit == dialect.Week {
		if offset.Unit == dialect.Week {
			n *= 7
		}
		return at.AddDate(0, 0, n)
	}
	if offset.Unit == dialect.Quarter {
		n *= 3
	}
	if offset.Unit == dialect.Year {
		n *= 12
	}
	y, month, day := at.Date()
	first := time.Date(y, month+time.Month(n), 1, at.Hour(), at.Minute(), at.Second(), at.Nanosecond(), at.Location())
	last := time.Date(first.Year(), first.Month()+1, 0, 12, 0, 0, 0, at.Location()).Day()
	return time.Date(first.Year(), first.Month(), min(day, last), at.Hour(), at.Minute(), at.Second(), at.Nanosecond(), at.Location())
}

// shiftEnd shifts the end of a period, which the period does not include. An
// end at midnight follows the last day that is included: shifted itself, an
// end on the 31st would be clamped to the 30th of a shorter month and leave
// that 30th out, though the days compared with it are matched to it one by
// one. An end within a day is a moment, and is shifted as one.
func shiftEnd(end time.Time, offset Duration) time.Time {
	if end.IsZero() || end.Hour() != 0 || end.Minute() != 0 || end.Second() != 0 || end.Nanosecond() != 0 {
		return calendarShift(end, offset)
	}
	return calendarShift(end.AddDate(0, 0, -1), offset).AddDate(0, 0, 1)
}

// comparisonFilter shifts only the chosen time field in the user's filter.
// Access restrictions and source SQL/parameters are deliberately not shifted.
// A finite, conjunctive interval defines the current period even for scalar
// KPI queries and totals that have no time dimension left.
func (c *compiler) comparisonFilter(compute *Compute) (*dataset.Filter, error) {
	field, err := c.rowField(compute.TimeField)
	if err != nil {
		return nil, err
	}
	bounded := false
	var walk func(dataset.Filter, bool) (dataset.Filter, error)
	walk = func(f dataset.Filter, conjunctive bool) (dataset.Filter, error) {
		out := f
		if f.Logical() {
			out.Args = make([]dataset.Filter, len(f.Args))
			for i, arg := range f.Args {
				var err error
				out.Args[i], err = walk(arg, conjunctive && f.Op == "and")
				if err != nil {
					return out, err
				}
			}
			return out, nil
		}
		if f.Field != compute.TimeField {
			return out, nil
		}
		// A missing-date click intersects the finite current range to no rows.
		// Keep the same restriction on the previous period instead of treating
		// this additional guard as a replacement for the comparison interval.
		if conjunctive && f.Op == "is_null" {
			return out, nil
		}
		if !conjunctive || f.Op != OpTime {
			return out, bad("compare_time_range", nil, "comparison time field requires a time range joined with AND")
		}
		tr, err := DecodeTimeRange(f.Value)
		if err != nil {
			return out, err
		}
		if tr.Special != "" || tr.IncludeNull {
			return out, bad("compare_time_range", nil, "comparison time range cannot include missing dates")
		}
		start, end, err := c.resolveFieldTimeRange(tr, field.Type)
		if err != nil {
			return out, err
		}
		bounded = bounded || !start.IsZero() && !end.IsZero()
		start, end = calendarShift(start, *compute.Offset), shiftEnd(end, *compute.Offset)
		for _, at := range []time.Time{start, end} {
			if !at.IsZero() && (at.Year() < 1 || at.Year() > 9999) {
				return out, bad("invalid_compare", nil, "comparison period is outside the supported calendar")
			}
		}
		// Two moments within a day may clamp to the same one. That comparison
		// period is empty, represented as contradictory conditions, never
		// widened. Whole days cannot: see shiftEnd.
		if !start.IsZero() && !end.IsZero() && !start.Before(end) {
			out = dataset.Filter{Op: "and", Args: []dataset.Filter{
				{Field: f.Field, Op: "gte", Value: start.Format("2006-01-02T15:04:05.999999999")},
				{Field: f.Field, Op: "lt", Value: start.Format("2006-01-02T15:04:05.999999999")},
			}}
			field, _ := c.spec.FieldByKey(f.Field)
			if field.Type == datasource.Date {
				out.Args[0].Value, out.Args[1].Value = start.Format("2006-01-02"), start.Format("2006-01-02")
			}
			return out, nil
		}
		shifted := TimeRange{Bounds: &TimeBounds{}}
		if !start.IsZero() {
			shifted.Bounds.Start = &TimeBound{Fixed: start.Format("2006-01-02T15:04:05.999999999")}
		}
		if !end.IsZero() {
			shifted.Bounds.End = &TimeBound{Fixed: end.Format("2006-01-02T15:04:05.999999999")}
		}
		out.Value = shifted
		return out, nil
	}
	if c.q.Filter == nil {
		return nil, bad("compare_time_range", nil, "comparison needs a finite current time range")
	}
	out, err := walk(*c.q.Filter, true)
	if err != nil {
		return nil, err
	}
	if !bounded {
		return nil, bad("compare_time_range", nil, "comparison needs a finite current time range")
	}
	return &out, nil
}

func (c *compiler) comparisonJoin(compute *Compute, aggregate, from string, index int) (string, string, error) {
	filter, err := c.comparisonFilter(compute)
	if err != nil {
		return "", "", err
	}
	var selects, positions, on, where []string
	alias := "compare_" + strconv.Itoa(index)
	for i, dim := range c.q.Dimensions {
		_, value, err := c.dimensionValue(dim)
		if err != nil {
			return "", "", err
		}
		key := c.d.QuoteIdent("key_" + strconv.Itoa(i))
		selects = append(selects, value+" AS "+key)
		positions = append(positions, strconv.Itoa(i+1))
		current := "pct_rows." + c.d.QuoteIdent(dim.Name())
		if dim.Field == compute.TimeField {
			current = c.d.ShiftTime(current, compute.Offset.Unit, -compute.Offset.N)
		}
		on = append(on, c.d.NullSafeEqual(current, alias+"."+key))
	}
	selects = append(selects, aggregate+" AS "+c.d.QuoteIdent("value"), "COUNT(*) AS "+c.d.QuoteIdent("present"))
	if c.opt.RowFilter != nil {
		sql, err := c.filter(*c.opt.RowFilter, c.rowFilterOperand)
		if err != nil {
			return "", "", err
		}
		where = append(where, sql)
	}
	if filter != nil {
		sql, err := c.filter(*filter, c.fieldOperand)
		if err != nil {
			return "", "", err
		}
		where = append(where, sql)
	}
	previous := "SELECT " + strings.Join(selects, ", ") + "\nFROM " + from
	if len(where) > 0 {
		previous += "\nWHERE " + strings.Join(where, " AND ")
	}
	if len(positions) > 0 {
		previous += "\nGROUP BY " + strings.Join(positions, ", ")
	}
	if len(on) == 0 {
		on = []string{"1 = 1"}
	}
	join := "\nLEFT JOIN (\n" + previous + "\n) AS " + alias + " ON " + strings.Join(on, " AND ")
	// ClickHouse fills an unmatched outer join with defaults unless configured
	// otherwise. The row count distinguishes absent groups from actual zeroes.
	value := "CASE WHEN " + alias + "." + c.d.QuoteIdent("present") + " > 0 THEN " + alias + "." + c.d.QuoteIdent("value") + " ELSE NULL END"
	return join, value, nil
}
