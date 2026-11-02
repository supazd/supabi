package dialect

import (
	"strconv"
	"strings"
)

// MySQL is the MySQL dialect. Doris and StarRocks speak the same protocol and
// can build on it.
//
// MySQL has no type for an instant, so time is handled as wall-clock time in
// the data time zone throughout: data source connections set the session time
// zone to it, which makes TIMESTAMP columns read that way too, and bound time
// arguments are sent in it. Converting between named zones needs the server's
// time zone tables to be loaded; the driver checks that when connecting.
type MySQL struct {
	Like
	LimitOffset
	TextInContext
}

func (MySQL) Name() string { return "mysql" }

func (MySQL) NullSafeEqual(left, right string) string { return left + " <=> " + right }

func (MySQL) QuoteIdent(name string) string {
	return "`" + strings.ReplaceAll(name, "`", "``") + "`"
}

// Placeholder is positional: the number is not part of the marker, so
// arguments must be supplied in the order the markers appear.
func (MySQL) Placeholder(int) string { return "?" }

func (MySQL) Lexis() Lexis { return Lexis{BackslashEscapes: true, HashComments: true} }

// Instant is the expression itself: values are compared as wall-clock time
// in the data time zone on both sides.
func (MySQL) Instant(expr string) string { return expr }

func (MySQL) LocalTime(expr, zone string) string {
	return "CONVERT_TZ(" + expr + ", @@session.time_zone, '" + zone + "')"
}

func (MySQL) TruncTime(expr string, grain Grain, weekStart int) string {
	return truncMySQL(expr, grain, weekStart, "DATETIME")
}

func (MySQL) TruncDate(expr string, grain Grain, weekStart int) string {
	return truncMySQL(expr, grain, weekStart, "DATE")
}

// MySQL has no date_trunc; each grain is built from date arithmetic.
func truncMySQL(expr string, grain Grain, weekStart int, as string) string {
	x := "(" + expr + ")"
	var day string
	switch grain {
	case Year:
		day = "MAKEDATE(YEAR(" + x + "), 1)"
	case Quarter:
		day = "MAKEDATE(YEAR(" + x + "), 1) + INTERVAL (QUARTER(" + x + ") - 1) QUARTER"
	case Month:
		day = "DATE_SUB(DATE(" + x + "), INTERVAL (DAYOFMONTH(" + x + ") - 1) DAY)"
	case Week:
		// WEEKDAY counts from Monday as 0; DAYOFWEEK from Sunday as 1.
		back := "WEEKDAY(" + x + ")"
		if weekStart == Sunday {
			back = "(DAYOFWEEK(" + x + ") - 1)"
		}
		day = "DATE_SUB(DATE(" + x + "), INTERVAL " + back + " DAY)"
	case Hour:
		return "CAST(DATE_FORMAT(" + x + ", '%Y-%m-%d %H:00:00') AS " + as + ")"
	case Minute:
		return "CAST(DATE_FORMAT(" + x + ", '%Y-%m-%d %H:%i:00') AS " + as + ")"
	default:
		day = "DATE(" + x + ")"
	}
	return "CAST(" + day + " AS " + as + ")"
}

func (MySQL) ShiftTime(expr string, unit Grain, n int) string {
	return "DATE_ADD(" + expr + ", INTERVAL " + strconv.Itoa(n) + " " + strings.ToUpper(string(unit)) + ")"
}
