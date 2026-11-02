// Package dialect describes how one SQL database differs from another. The
// query compiler writes SQL only through these interfaces, so supporting a new
// database means implementing them, not changing the compiler.
//
// The interface is split by capability on purpose: each group stays small, and
// a database that is wire-compatible with another can reuse most of it.
package dialect

import (
	"strconv"
	"strings"
)

// Dialect is everything the compiler needs to know about a database.
type Dialect interface {
	Name() string
	Identifiers
	Placeholders
	Arguments
	Paging
	TimeFunctions
	Patterns
	Functions
	Reading
	Joining
}

type Paging interface {
	// Page limits a statement to limit rows, after skipping as many as offset,
	// which is 0 when none are skipped.
	Page(limit, offset int) string
}

// LimitOffset implements Paging as most databases write it.
type LimitOffset struct{}

func (LimitOffset) Page(limit, offset int) string {
	page := "LIMIT " + strconv.Itoa(limit)
	if offset > 0 {
		page += " OFFSET " + strconv.Itoa(offset)
	}
	return page
}

type Arguments interface {
	// TextAs writes the marker of a bound argument whose value is text
	// standing for a value of logical type t ("date", "timestamp", or a
	// "decimal" or "float" sent as text to keep its digits).
	TextAs(marker, t string) string
}

// TextInContext implements Arguments for databases that read such text as
// whatever type it is compared with or used as.
type TextInContext struct{}

func (TextInContext) TextAs(marker, _ string) string { return marker }

type Joining interface {
	// NullSafeEqual matches grouping keys, including two NULL values.
	NullSafeEqual(left, right string) string
}

type Reading interface {
	// Lexis is how the database tells the parts of a statement apart.
	Lexis() Lexis
}

// Lexis is where databases differ in reading the text of a statement: what
// ends a string and what is a comment. It is for finding one's way in SQL
// someone wrote, which the compiler never needs for the SQL it writes.
type Lexis struct {
	// BackslashEscapes is set when a backslash inside a string or a quoted
	// name takes the next character with it, so that \' does not end a string.
	BackslashEscapes bool
	// DollarQuotes is set when $tag$ ... $tag$ is a string.
	DollarQuotes bool
	// HashComments is set when # starts a comment that runs to the end of the line.
	HashComments bool
}

type Identifiers interface {
	// QuoteIdent quotes a column or alias so that case and special characters survive.
	QuoteIdent(name string) string
}

type Placeholders interface {
	// Placeholder returns the marker for the n-th bound argument, counting from 1.
	Placeholder(n int) string
}

// Grain is the unit a time value is truncated to.
type Grain string

const (
	Year    Grain = "year"
	Quarter Grain = "quarter"
	Month   Grain = "month"
	Week    Grain = "week"
	Day     Grain = "day"
	Hour    Grain = "hour"
	Minute  Grain = "minute"
)

// Grains lists every grain, coarsest first.
var Grains = []Grain{Year, Quarter, Month, Week, Day, Hour, Minute}

// Week start days, as ISO weekday numbers.
const (
	Monday = 1
	Sunday = 7
)

type TimeFunctions interface {
	// ShiftTime moves a local calendar value, clamping an invalid day to the
	// last day of the target month. Unit and n are validated by the caller.
	ShiftTime(expr string, unit Grain, n int) string

	// Instant turns a timestamp expression into a point in time that can be
	// compared with a bound time argument. A timestamp stored without a zone
	// is read in the data source's data time zone.
	Instant(expr string) string

	// LocalTime turns a timestamp expression into wall-clock time in zone,
	// an IANA name that the caller has already validated.
	LocalTime(expr, zone string) string

	// TruncTime truncates a wall-clock timestamp, as produced by LocalTime.
	TruncTime(expr string, grain Grain, weekStart int) string

	// TruncDate truncates a calendar date. Hour and Minute are not valid here.
	TruncDate(expr string, grain Grain, weekStart int) string
}

// Pattern is a way of matching text against a literal or wildcard pattern.
type Pattern int

const (
	Contains Pattern = iota
	StartsWith
	EndsWith
	// Wildcard matches the whole value: % matches any string, _ one character,
	// and a backslash quotes the following character.
	Wildcard
)

type Patterns interface {
	// Match returns a condition that is true when expr matches text in the
	// given way. Except for Wildcard, wildcard characters match themselves.
	// bind turns a value into the marker of a bound argument.
	Match(expr string, pattern Pattern, text string, bind func(value any) string) string
}

// Like implements Patterns with the standard LIKE operator. It is embedded by
// dialects whose LIKE accepts an ESCAPE clause.
type Like struct{}

// The escape character is "!" rather than the customary backslash because a
// backslash inside a string literal means different things to different databases.
func (Like) Match(expr string, pattern Pattern, text string, bind func(any) string) string {
	if pattern == Wildcard {
		return expr + " LIKE " + bind(wildcardPattern(text, '!')) + " ESCAPE '!'"
	}
	escaped := strings.NewReplacer("!", "!!", "%", "!%", "_", "!_").Replace(text)
	switch pattern {
	case StartsWith:
		escaped += "%"
	case EndsWith:
		escaped = "%" + escaped
	default:
		escaped = "%" + escaped + "%"
	}
	return expr + " LIKE " + bind(escaped) + " ESCAPE '!'"
}

// wildcardPattern converts the public backslash-escaped syntax to a database's
// LIKE escape character. Keeping this in bound values prevents SQL injection
// and avoids differences in how SQL string literals interpret backslashes.
func wildcardPattern(text string, escape rune) string {
	var out strings.Builder
	quoted := false
	for _, ch := range text {
		if !quoted && ch == '\\' {
			quoted = true
			continue
		}
		if ch == escape || (quoted && (ch == '%' || ch == '_')) {
			out.WriteRune(escape)
		}
		out.WriteRune(ch)
		quoted = false
	}
	if quoted {
		if escape == '\\' {
			out.WriteRune(escape)
		}
		out.WriteRune('\\')
	}
	return out.String()
}
