package dialect

import (
	"strconv"
	"strings"
)

// Trino is the Trino dialect.
//
// Time is handled as in PostgreSQL: data source connections set the session
// time zone to the data time zone, so that casting to a timestamp with a zone
// reads one stored without a zone in it, and gives the instant either way.
// Precision 6 keeps the microseconds that warehouses store, and short
// timestamps that Trino computes with quickly.
type Trino struct{ Like }

func (Trino) Name() string { return "trino" }

func (Trino) NullSafeEqual(left, right string) string {
	return left + " IS NOT DISTINCT FROM " + right
}

// QuoteIdent quotes a name. Trino compares names regardless of case even when
// they are quoted, and gives the columns of a result in lower case.
func (Trino) QuoteIdent(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}

func (Trino) Placeholder(int) string { return "?" }

// TextAs casts: Trino compares text only with text.
func (Trino) TextAs(marker, t string) string {
	switch t {
	case "date":
		return "CAST(" + marker + " AS date)"
	case "timestamp":
		return "CAST(" + marker + " AS timestamp(6))"
	case "decimal":
		return "CAST(" + marker + " AS decimal(38, 10))"
	case "float":
		return "CAST(" + marker + " AS double)"
	}
	return marker
}

// Page puts OFFSET first, where Trino requires it.
func (Trino) Page(limit, offset int) string {
	page := "LIMIT " + strconv.Itoa(limit)
	if offset > 0 {
		page = "OFFSET " + strconv.Itoa(offset) + " " + page
	}
	return page
}

func (Trino) Lexis() Lexis { return Lexis{} }

func (Trino) Instant(expr string) string {
	return "CAST(" + expr + " AS timestamp(6) with time zone)"
}

func (t Trino) LocalTime(expr, zone string) string {
	return "CAST(" + t.Instant(expr) + " AT TIME ZONE '" + zone + "' AS timestamp(6))"
}

func (Trino) TruncTime(expr string, grain Grain, weekStart int) string {
	return truncTrino(expr, grain, weekStart)
}

func (Trino) TruncDate(expr string, grain Grain, weekStart int) string {
	return truncTrino("CAST("+expr+" AS date)", grain, weekStart)
}

func truncTrino(expr string, grain Grain, weekStart int) string {
	if grain == Week && weekStart == Sunday {
		// date_trunc('week') starts on Monday; shift a day forward and back.
		return "date_add('day', -1, date_trunc('week', date_add('day', 1, " + expr + ")))"
	}
	return "date_trunc('" + string(grain) + "', " + expr + ")"
}

// ShiftTime relies on date_add keeping to the last day of a shorter month.
func (Trino) ShiftTime(expr string, unit Grain, n int) string {
	return "date_add('" + string(unit) + "', " + strconv.Itoa(n) + ", " + expr + ")"
}
