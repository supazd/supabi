package query

import (
	"bytes"
	"encoding/json"
	"time"

	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/dialect"
)

// truncate returns the start of the period containing t, in t's location.
func truncate(t time.Time, unit dialect.Grain, weekStart int) time.Time {
	y, m, d := t.Date()
	loc := t.Location()
	switch unit {
	case dialect.Year:
		return time.Date(y, 1, 1, 0, 0, 0, 0, loc)
	case dialect.Quarter:
		return time.Date(y, m-(m-1)%3, 1, 0, 0, 0, 0, loc)
	case dialect.Month:
		return time.Date(y, m, 1, 0, 0, 0, 0, loc)
	case dialect.Week:
		// weekStart is an ISO weekday, 1 Monday to 7 Sunday; Go counts from Sunday as 0.
		first := time.Monday
		if weekStart >= 1 && weekStart <= 7 {
			first = time.Weekday(weekStart % 7)
		}
		back := (int(t.Weekday()) - int(first) + 7) % 7
		return time.Date(y, m, d-back, 0, 0, 0, 0, loc)
	case dialect.Day:
		return time.Date(y, m, d, 0, 0, 0, 0, loc)
	case dialect.Hour:
		// Truncate uses UTC, which is not an hour boundary in zones with a
		// fractional-hour offset. Subtraction also preserves which occurrence
		// of an ambiguous hour this instant belongs to during a DST rollback.
		return t.Add(-time.Duration(t.Minute())*time.Minute - time.Duration(t.Second())*time.Second - time.Duration(t.Nanosecond()))
	default:
		return t.Add(-time.Duration(t.Second())*time.Second - time.Duration(t.Nanosecond()))
	}
}

// shift moves the start of a period by n periods.
func shift(t time.Time, unit dialect.Grain, n int) time.Time {
	switch unit {
	case dialect.Year:
		return t.AddDate(n, 0, 0)
	case dialect.Quarter:
		return t.AddDate(0, 3*n, 0)
	case dialect.Month:
		return t.AddDate(0, n, 0)
	case dialect.Week:
		return t.AddDate(0, 0, 7*n)
	case dialect.Day:
		return t.AddDate(0, 0, n)
	case dialect.Hour:
		return t.Add(time.Duration(n) * time.Hour)
	default:
		return t.Add(time.Duration(n) * time.Minute)
	}
}

func validGrain(g dialect.Grain) bool {
	for _, known := range dialect.Grains {
		if g == known {
			return true
		}
	}
	return false
}

// ResolveTimeRange is the interval a time range stands for at now in the
// named zone, as wall times there: [start, end), a zero time an open side.
// The app shows a filter's dates with it, so that they are the dates a query
// keeps.
func ResolveTimeRange(tr *TimeRange, now time.Time, zone string, weekStart int) (start, end time.Time, err error) {
	if zone == "" {
		zone = "UTC"
	}
	loc, err := time.LoadLocation(zone)
	if err != nil || zone == "Local" {
		return start, end, bad("invalid_timezone", []string{"timezone", zone}, "unknown time zone %q", zone)
	}
	return resolveTimeRange(tr, now, loc, weekStart)
}

// resolveTimeRange turns a TimeRange into [start, end). A zero time means the
// side is open.
func resolveTimeRange(tr *TimeRange, now time.Time, loc *time.Location, weekStart int) (start, end time.Time, err error) {
	if tr == nil {
		return start, end, dataset.Errorf("invalid_time_range", nil, "a time condition needs a time range")
	}
	if tr.WeekStart != 0 {
		if tr.WeekStart < 1 || tr.WeekStart > 7 {
			return start, end, dataset.Errorf("invalid_time_range", nil, "weekStart must be an ISO weekday from 1 (Monday) to 7 (Sunday)")
		}
		weekStart = tr.WeekStart
	}
	switch tr.Grain {
	case "", dialect.Day, dialect.Week, dialect.Month:
	default:
		return start, end, dataset.Errorf("invalid_time_range", nil, "grain must be day, week or month")
	}
	if start, end, err = resolveInterval(tr, now, loc, weekStart); err != nil || tr.Grain == "" {
		return start, end, err
	}
	// Whole periods: the start goes back to where its period begins, and the
	// end, which is not kept, on to where its period ends.
	if !start.IsZero() {
		start = truncate(start, tr.Grain, weekStart)
	}
	if !end.IsZero() {
		if begins := truncate(end, tr.Grain, weekStart); !begins.Equal(end) {
			end = shift(begins, tr.Grain, 1)
		}
	}
	return start, end, nil
}

// resolveInterval is the interval a range names, before it is made of whole periods.
func resolveInterval(tr *TimeRange, now time.Time, loc *time.Location, weekStart int) (start, end time.Time, err error) {
	now = now.In(loc)
	set := 0
	if tr.Last != nil {
		set++
	}
	if tr.Current != "" {
		set++
	}
	if tr.Start != "" || tr.End != "" {
		set++
	}
	if tr.Bounds != nil {
		set++
	}
	if tr.Special != "" {
		set++
	}
	if set != 1 {
		return start, end, dataset.Errorf("invalid_time_range", nil, "a time range must set exactly one of last, current, start/end, bounds, or special")
	}

	switch {
	case tr.Special != "":
		if (tr.Special != "is_null" && tr.Special != "not_null") || tr.IncludeCurrent || tr.IncludeNull {
			return start, end, dataset.Errorf("invalid_time_range", nil, "special must be is_null or not_null without includeCurrent or includeNull")
		}
		return start, end, nil
	case tr.Last != nil:
		if tr.Last.N <= 0 || !validGrain(tr.Last.Unit) {
			return start, end, dataset.Errorf("invalid_time_range", nil, "last needs a positive n and a valid unit")
		}
		current := truncate(now, tr.Last.Unit, weekStart)
		if tr.IncludeCurrent {
			return shift(current, tr.Last.Unit, -(tr.Last.N - 1)), shift(current, tr.Last.Unit, 1), nil
		}
		return shift(current, tr.Last.Unit, -tr.Last.N), current, nil
	case tr.Current != "":
		if !validGrain(tr.Current) {
			return start, end, dataset.Errorf("invalid_time_range", nil, "invalid unit %q", tr.Current)
		}
		current := truncate(now, tr.Current, weekStart)
		return current, shift(current, tr.Current, 1), nil
	}
	if tr.Bounds != nil {
		if start, err = resolveTimeBound(tr.Bounds.Start, now, loc, weekStart); err != nil {
			return start, end, err
		}
		if end, err = resolveTimeBound(tr.Bounds.End, now, loc, weekStart); err != nil {
			return start, end, err
		}
	}
	if tr.Start != "" {
		if start, err = parseLocalTime(tr.Start, loc); err != nil {
			return start, end, err
		}
	}
	if tr.End != "" {
		if end, err = parseLocalTime(tr.End, loc); err != nil {
			return start, end, err
		}
	}
	if !start.IsZero() && !end.IsZero() && !start.Before(end) {
		return start, end, dataset.Errorf("invalid_time_range", nil, "start must be before end")
	}
	return start, end, nil
}

func resolveTimeBound(bound *TimeBound, now time.Time, loc *time.Location, weekStart int) (time.Time, error) {
	if bound == nil {
		return time.Time{}, nil
	}
	if (bound.Fixed == "") == (bound.Relative == nil) {
		return time.Time{}, dataset.Errorf("invalid_time_range", nil, "a time bound must set exactly one of fixed or relative")
	}
	if bound.Fixed != "" {
		// An explicit offset identifies an instant, including either occurrence
		// of a repeated DST hour. Restore the query location for later calendar
		// operations (whole periods and comparisons), not just its UTC offset.
		if at, err := time.Parse(time.RFC3339Nano, bound.Fixed); err == nil {
			return at.In(loc), nil
		}
		return parseLocalTime(bound.Fixed, loc)
	}
	relative := bound.Relative
	if !validGrain(relative.Unit) || relative.N < -1000000 || relative.N > 1000000 {
		return time.Time{}, dataset.Errorf("invalid_time_range", nil, "relative needs a valid unit and an offset between -1000000 and 1000000")
	}
	resolved := shift(truncate(now, relative.Unit, weekStart), relative.Unit, relative.N)
	if resolved.Year() < 1 || resolved.Year() > 9999 {
		return time.Time{}, dataset.Errorf("invalid_time_range", nil, "relative time bound is outside the supported calendar range")
	}
	return resolved, nil
}

// DecodeTimeRange reads the value of a "time" condition: a TimeRange, or the
// JSON object it is written as.
func DecodeTimeRange(v any) (*TimeRange, error) {
	switch tr := v.(type) {
	case TimeRange:
		return &tr, nil
	case *TimeRange:
		if tr != nil {
			return tr, nil
		}
	case map[string]any:
		raw, err := json.Marshal(tr)
		if err != nil {
			return nil, err
		}
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		var out TimeRange
		if err := decoder.Decode(&out); err != nil {
			return nil, dataset.Errorf("invalid_time_range", nil, "invalid time range: %v", err)
		}
		return &out, nil
	}
	return nil, dataset.Errorf("invalid_time_range", nil, "a time condition needs a time range as its value")
}

// ValidateTimeRange checks a time range without reference to a dataset.
func ValidateTimeRange(tr *TimeRange) error {
	_, _, err := resolveTimeRange(tr, time.Now(), time.UTC, dialect.Monday)
	return err
}

var localTimeLayouts = []string{"2006-01-02T15:04:05", "2006-01-02 15:04:05", "2006-01-02T15:04", "2006-01-02"}

// parseLocalTime reads a date or date-time as wall-clock time in loc.
func parseLocalTime(s string, loc *time.Location) (time.Time, error) {
	for _, layout := range localTimeLayouts {
		if t, err := time.ParseInLocation(layout, s, loc); err == nil {
			return t, nil
		}
	}
	return time.Time{}, dataset.Errorf("invalid_time_value", []string{"value", s}, "%q is not a date or date-time", s)
}
