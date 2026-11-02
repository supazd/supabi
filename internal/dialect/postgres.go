package dialect

import (
	"strconv"
	"strings"
)

// Postgres is the PostgreSQL dialect.
//
// Time handling relies on the session time zone of data source connections
// being the data time zone: casting to timestamptz then gives the right
// instant both for columns stored with a zone and for those stored without.
type Postgres struct {
	Like
	LimitOffset
	TextInContext
}

func (Postgres) Name() string { return "postgres" }

func (Postgres) NullSafeEqual(left, right string) string {
	return left + " IS NOT DISTINCT FROM " + right
}

func (Postgres) QuoteIdent(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}

func (Postgres) Placeholder(n int) string { return "$" + strconv.Itoa(n) }

func (Postgres) Lexis() Lexis { return Lexis{DollarQuotes: true} }

func (Postgres) Instant(expr string) string {
	return "(" + expr + ")::timestamptz"
}

func (p Postgres) LocalTime(expr, zone string) string {
	return "(" + p.Instant(expr) + " AT TIME ZONE '" + zone + "')"
}

func (Postgres) TruncTime(expr string, grain Grain, weekStart int) string {
	return truncPostgres(expr, grain, weekStart, "")
}

func (Postgres) TruncDate(expr string, grain Grain, weekStart int) string {
	return truncPostgres("("+expr+")::date", grain, weekStart, "::date")
}

func truncPostgres(expr string, grain Grain, weekStart int, cast string) string {
	if grain == Week && weekStart == Sunday {
		// date_trunc('week') starts on Monday; shift a day forward and back.
		return "(date_trunc('week', " + expr + " + interval '1 day') - interval '1 day')" + cast
	}
	return "date_trunc('" + string(grain) + "', " + expr + ")" + cast
}

func (Postgres) ShiftTime(expr string, unit Grain, n int) string {
	if unit == Quarter {
		unit = Month
		n *= 3
	}
	return "(" + expr + " + INTERVAL '" + strconv.Itoa(n) + " " + string(unit) + "')"
}
