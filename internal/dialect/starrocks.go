package dialect

import (
	"strconv"
	"strings"
)

// StarRocks is the dialect of StarRocks and of Apache Doris, which share an
// ancestry and speak the MySQL protocol, but have their own functions.
//
// Like MySQL they have no type for an instant: time is wall-clock time in the
// data time zone, which the dialect needs to know to convert to another zone.
type StarRocks struct {
	LimitOffset
	TextInContext
	// Doris selects the Apache Doris variant where the two differ.
	Doris bool
	// DataTimezone is the zone of stored times; empty means UTC.
	DataTimezone string
}

func (StarRocks) NullSafeEqual(left, right string) string { return left + " <=> " + right }

func (d StarRocks) Name() string {
	if d.Doris {
		return "doris"
	}
	return "starrocks"
}

func (StarRocks) QuoteIdent(name string) string {
	return "`" + strings.ReplaceAll(name, "`", "``") + "`"
}

func (StarRocks) Placeholder(int) string { return "?" }

func (StarRocks) Lexis() Lexis { return Lexis{BackslashEscapes: true} }

func (StarRocks) Instant(expr string) string { return expr }

func (d StarRocks) LocalTime(expr, zone string) string {
	from := d.DataTimezone
	if from == "" {
		from = "UTC"
	}
	return "CONVERT_TZ(" + expr + ", '" + from + "', '" + zone + "')"
}

func (d StarRocks) TruncTime(expr string, grain Grain, weekStart int) string {
	return d.trunc(expr, grain, weekStart)
}

func (d StarRocks) TruncDate(expr string, grain Grain, weekStart int) string {
	return "CAST(" + d.trunc("CAST("+expr+" AS DATE)", grain, weekStart) + " AS DATE)"
}

func (d StarRocks) trunc(expr string, grain Grain, weekStart int) string {
	// The two engines take the arguments of date_trunc in opposite orders.
	truncate := func(x string) string {
		if d.Doris {
			return "date_trunc(" + x + ", '" + string(grain) + "')"
		}
		return "date_trunc('" + string(grain) + "', " + x + ")"
	}
	if grain == Week && weekStart == Sunday {
		// Weeks start on Monday here; shift a day forward and back.
		return "date_sub(" + truncate("date_add("+expr+", INTERVAL 1 DAY)") + ", INTERVAL 1 DAY)"
	}
	return truncate(expr)
}

// Match uses functions that take the text as it is, so nothing needs escaping.
func (StarRocks) Match(expr string, pattern Pattern, text string, bind func(any) string) string {
	switch pattern {
	case Wildcard:
		return expr + " LIKE " + bind(wildcardPattern(text, '\\'))
	case StartsWith:
		return "starts_with(" + expr + ", " + bind(text) + ")"
	case EndsWith:
		return "ends_with(" + expr + ", " + bind(text) + ")"
	}
	return "locate(" + bind(text) + ", " + expr + ") > 0"
}

func (StarRocks) ShiftTime(expr string, unit Grain, n int) string {
	return "DATE_ADD(" + expr + ", INTERVAL " + strconv.Itoa(n) + " " + strings.ToUpper(string(unit)) + ")"
}
