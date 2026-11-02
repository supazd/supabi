package dialect

import (
	"strconv"
	"strings"
)

// ClickHouse is the ClickHouse dialect.
//
// A DateTime in ClickHouse is an instant; a zone only decides how it is shown.
// Wall-clock time in a given zone is therefore computed, by shifting the
// instant by that zone's offset and labelling the result UTC. Everything that
// follows (truncation, formatting on the way out) then reads it as plain
// wall-clock time, the same as in the other dialects.
type ClickHouse struct {
	LimitOffset
	TextInContext
}

func (ClickHouse) Name() string { return "clickhouse" }

func (ClickHouse) NullSafeEqual(left, right string) string {
	return "isNotDistinctFrom(" + left + ", " + right + ")"
}

func (ClickHouse) QuoteIdent(name string) string {
	return "`" + strings.NewReplacer("\\", "\\\\", "`", "\\`").Replace(name) + "`"
}

func (ClickHouse) Placeholder(int) string { return "?" }

func (ClickHouse) Lexis() Lexis {
	return Lexis{BackslashEscapes: true, DollarQuotes: true, HashComments: true}
}

func (ClickHouse) Instant(expr string) string { return expr }

func (ClickHouse) LocalTime(expr, zone string) string {
	return "addSeconds(toDateTime(" + expr + ", 'UTC'), timezoneOffset(toTimeZone(" + expr + ", '" + zone + "')))"
}

func (ClickHouse) TruncTime(expr string, grain Grain, weekStart int) string {
	switch grain {
	case Day:
		return "toStartOfDay(" + expr + ")"
	case Hour:
		return "toStartOfHour(" + expr + ")"
	case Minute:
		return "toStartOfMinute(" + expr + ")"
	}
	// The coarser functions return a Date; make it a timestamp again.
	return "toDateTime(" + truncClickHouseDate(expr, grain, weekStart) + ", 'UTC')"
}

func (ClickHouse) TruncDate(expr string, grain Grain, weekStart int) string {
	return truncClickHouseDate("toDate("+expr+")", grain, weekStart)
}

func truncClickHouseDate(expr string, grain Grain, weekStart int) string {
	switch grain {
	case Year:
		return "toStartOfYear(" + expr + ")"
	case Quarter:
		return "toStartOfQuarter(" + expr + ")"
	case Month:
		return "toStartOfMonth(" + expr + ")"
	case Week:
		// Mode 1 starts weeks on Monday, mode 0 on Sunday.
		mode := "1"
		if weekStart == Sunday {
			mode = "0"
		}
		return "toStartOfWeek(" + expr + ", " + mode + ")"
	}
	return "toDate(" + expr + ")"
}

// Match uses functions that take the text as it is, so nothing needs escaping.
func (ClickHouse) Match(expr string, pattern Pattern, text string, bind func(any) string) string {
	switch pattern {
	case Wildcard:
		return expr + " LIKE " + bind(wildcardPattern(text, '\\'))
	case StartsWith:
		return "startsWith(" + expr + ", " + bind(text) + ")"
	case EndsWith:
		return "endsWith(" + expr + ", " + bind(text) + ")"
	}
	return "position(" + expr + ", " + bind(text) + ") > 0"
}

func (ClickHouse) ShiftTime(expr string, unit Grain, n int) string {
	function := map[Grain]string{Day: "addDays", Week: "addWeeks", Month: "addMonths", Quarter: "addQuarters", Year: "addYears"}[unit]
	return function + "(" + expr + ", " + strconv.Itoa(n) + ")"
}
