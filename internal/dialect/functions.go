package dialect

import "strings"

// Operand is an argument of a function, already written as SQL.
type Operand struct {
	SQL string
	// Type is the logical type of the value, by the name the data source
	// layer gives it ("integer", "date", ...), or empty when it is not known.
	Type string
}

// FunctionWriter writes a call of a function with its arguments.
type FunctionWriter func(args []Operand) string

// Functions is how a database writes what the platform's expressions are made
// of. The names are not the ones people write: internal/expr breaks its
// functions down into these, so that a database only has to say how it does
// each small thing. See .agents/design/expressions.md.
type Functions interface {
	// Function returns the writer of a function, or false when the database
	// has no way to compute it.
	Function(name string) (FunctionWriter, bool)
}

func call(name string) FunctionWriter {
	return func(args []Operand) string {
		parts := make([]string, len(args))
		for i, arg := range args {
			parts[i] = arg.SQL
		}
		return name + "(" + strings.Join(parts, ", ") + ")"
	}
}

// pattern writes its arguments into a text where $1 is the first of them.
func pattern(text string) FunctionWriter {
	return func(args []Operand) string {
		pairs := make([]string, 0, 2*len(args))
		for i, arg := range args {
			pairs = append(pairs, "$"+string(rune('1'+i)), arg.SQL)
		}
		return strings.NewReplacer(pairs...).Replace(text)
	}
}

func numeric(t string) bool { return t == "integer" || t == "decimal" || t == "float" }

// truncating writes a conversion to a whole number that drops the fraction of
// a number rather than rounding it, and reads text as it is.
func truncating(truncate, as string) FunctionWriter {
	return func(args []Operand) string {
		if numeric(args[0].Type) {
			return "CAST(" + strings.Replace(truncate, "$1", args[0].SQL, 1) + " AS " + as + ")"
		}
		return "CAST(" + args[0].SQL + " AS " + as + ")"
	}
}

// standardFunctions is how most databases write them. The ones that go by
// MySQL's names are here too: StarRocks and Doris share them.
var standardFunctions = map[string]FunctionWriter{
	// Dividing by zero gives no value rather than an error.
	"/": pattern("($1 / NULLIF($2, 0))"),
	"%": pattern("($1 % NULLIF($2, 0))"),

	"sum":            call("SUM"),
	"avg":            call("AVG"),
	"min":            call("MIN"),
	"max":            call("MAX"),
	"count":          call("COUNT"),
	"count_all":      pattern("COUNT(*)"),
	"count_distinct": pattern("COUNT(DISTINCT $1)"),

	"coalesce": call("COALESCE"),
	"nullif":   call("NULLIF"),

	"abs":   call("ABS"),
	"round": call("ROUND"),
	"floor": call("FLOOR"),
	"ceil":  call("CEIL"),
	"power": call("POWER"),
	"sqrt":  call("SQRT"),

	"concat":      call("CONCAT"),
	"upper":       call("UPPER"),
	"lower":       call("LOWER"),
	"trim":        call("TRIM"),
	"length":      call("CHAR_LENGTH"),
	"substr":      call("SUBSTR"),
	"replace":     call("REPLACE"),
	"left":        call("LEFT"),
	"right":       call("RIGHT"),
	"contains":    pattern("(LOCATE($2, $1) > 0)"),
	"starts_with": pattern("(LEFT($1, CHAR_LENGTH($2)) = $2)"),
	"ends_with":   pattern("(RIGHT($1, CHAR_LENGTH($2)) = $2)"),

	"year":       call("YEAR"),
	"quarter":    call("QUARTER"),
	"month":      call("MONTH"),
	"day":        call("DAYOFMONTH"),
	"hour":       call("HOUR"),
	"minute":     call("MINUTE"),
	"isoweekday": pattern("(WEEKDAY($1) + 1)"),
	"to_date":    pattern("CAST($1 AS DATE)"),
	// The days from the first date to the second.
	"days_between": pattern("DATEDIFF($2, $1)"),
	"add_year":     pattern("DATE_ADD($1, INTERVAL $2 YEAR)"),
	"add_month":    pattern("DATE_ADD($1, INTERVAL $2 MONTH)"),
	"add_day":      pattern("DATE_ADD($1, INTERVAL $2 DAY)"),
	"add_hour":     pattern("DATE_ADD($1, INTERVAL $2 HOUR)"),
	"add_minute":   pattern("DATE_ADD($1, INTERVAL $2 MINUTE)"),

	"to_string":  pattern("CAST($1 AS CHAR)"),
	"to_integer": truncating("TRUNCATE($1, 0)", "SIGNED"),
	"to_decimal": pattern("CAST($1 AS DECIMAL(38, 10))"),
	"to_float":   pattern("CAST($1 AS DOUBLE)"),

	// Beyond the core: not every database has these, and those that do need
	// not agree to the last detail.
	"median":       nil,
	"regexp_match": pattern("REGEXP_LIKE($1, $2)"),
}

// over lays a database's own ways on the standard ones. A nil writer says the
// database has none.
func over(own map[string]FunctionWriter) map[string]FunctionWriter {
	all := make(map[string]FunctionWriter, len(standardFunctions))
	for name, write := range standardFunctions {
		all[name] = write
	}
	for name, write := range own {
		all[name] = write
	}
	return all
}

func lookup(functions map[string]FunctionWriter, name string) (FunctionWriter, bool) {
	write := functions[name]
	return write, write != nil
}

var mysqlFunctions = over(nil)

func (MySQL) Function(name string) (FunctionWriter, bool) { return lookup(mysqlFunctions, name) }

// extract reads a part of a date as a whole number.
func extract(part string) FunctionWriter {
	return pattern("CAST(EXTRACT(" + part + " FROM $1) AS integer)")
}

// adding moves a date or a time by a number of units. A date moved stays a date.
func adding(unit string) FunctionWriter {
	return func(args []Operand) string {
		moved := "(" + args[0].SQL + " + (" + args[1].SQL + ") * INTERVAL '1 " + unit + "')"
		if args[0].Type == "date" {
			return "CAST(" + moved + " AS date)"
		}
		return moved
	}
}

var postgresFunctions = over(map[string]FunctionWriter{
	// Two whole numbers divide into a whole number here, which is not what is
	// meant. Not only those typed integer: a sum of int is a bigint here, though
	// the platform counts it a decimal, so all but floats divide in numeric.
	"/": func(args []Operand) string {
		if args[0].Type != "float" && args[1].Type != "float" {
			return "(CAST(" + args[0].SQL + " AS numeric) / NULLIF(" + args[1].SQL + ", 0))"
		}
		return "(" + args[0].SQL + " / NULLIF(" + args[1].SQL + ", 0))"
	},
	// ROUND with digits is only there for numeric.
	"round": func(args []Operand) string {
		if args[0].Type == "float" {
			args = append([]Operand{{SQL: "CAST(" + args[0].SQL + " AS numeric)", Type: "decimal"}}, args[1:]...)
		}
		return call("ROUND")(args)
	},
	"concat": func(args []Operand) string {
		parts := make([]string, len(args))
		for i, arg := range args {
			parts[i] = arg.SQL
		}
		// The operator, unlike the function, gives no value when a part has none.
		return "(" + strings.Join(parts, " || ") + ")"
	},
	"length":      call("LENGTH"),
	"contains":    pattern("(STRPOS($1, $2) > 0)"),
	"starts_with": pattern("(LEFT($1, LENGTH($2)) = $2)"),
	"ends_with":   pattern("(RIGHT($1, LENGTH($2)) = $2)"),

	"year":         extract("YEAR"),
	"quarter":      extract("QUARTER"),
	"month":        extract("MONTH"),
	"day":          extract("DAY"),
	"hour":         extract("HOUR"),
	"minute":       extract("MINUTE"),
	"isoweekday":   extract("ISODOW"),
	"days_between": pattern("(CAST($2 AS date) - CAST($1 AS date))"),
	"add_year":     adding("year"),
	"add_month":    adding("month"),
	"add_day":      adding("day"),
	"add_hour":     adding("hour"),
	"add_minute":   adding("minute"),

	"to_string":  pattern("CAST($1 AS varchar)"),
	"to_integer": truncating("TRUNC($1)", "bigint"),
	"to_decimal": pattern("CAST($1 AS numeric(38, 10))"),
	"to_float":   pattern("CAST($1 AS double precision)"),

	"median":       pattern("PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY $1)"),
	"regexp_match": pattern("($1 ~ $2)"),
})

func (Postgres) Function(name string) (FunctionWriter, bool) { return lookup(postgresFunctions, name) }

var clickhouseFunctions = over(map[string]FunctionWriter{
	// A decimal divided keeps the digits of the dividend, and would lose the
	// rest of the quotient: it is given room for them first.
	"/": func(args []Operand) string {
		left := args[0].SQL
		if (args[0].Type == "decimal" || args[1].Type == "decimal") && args[0].Type != "float" && args[1].Type != "float" {
			left = "toDecimal128(" + left + ", 10)"
		}
		return "(" + left + " / NULLIF(" + args[1].SQL + ", 0))"
	},

	// The least or greatest of no rows is no value, as elsewhere, rather than
	// the type's default: a time of 0 is 1970, which a zone west of UTC would
	// move to before the start of the type and so round to 2106.
	"min": call("minOrNull"),
	"max": call("maxOrNull"),

	"trim":        call("trimBoth"),
	"length":      call("lengthUTF8"),
	"substr":      call("substringUTF8"),
	"replace":     call("replaceAll"),
	"left":        call("leftUTF8"),
	"right":       call("rightUTF8"),
	"contains":    pattern("(position($1, $2) > 0)"),
	"starts_with": call("startsWith"),
	"ends_with":   call("endsWith"),

	"year":         call("toYear"),
	"quarter":      call("toQuarter"),
	"month":        call("toMonth"),
	"day":          call("toDayOfMonth"),
	"hour":         call("toHour"),
	"minute":       call("toMinute"),
	"isoweekday":   call("toDayOfWeek"),
	"to_date":      call("toDate"),
	"days_between": pattern("dateDiff('day', $1, $2)"),
	"add_year":     call("addYears"),
	"add_month":    call("addMonths"),
	"add_day":      call("addDays"),
	"add_hour":     call("addHours"),
	"add_minute":   call("addMinutes"),

	"to_string":  call("toString"),
	"to_integer": call("toInt64"),
	"to_decimal": pattern("toDecimal128($1, 10)"),
	"to_float":   call("toFloat64"),

	"median":       pattern("quantileExactInclusive(0.5)(toFloat64($1))"),
	"regexp_match": call("match"),
})

func (ClickHouse) Function(name string) (FunctionWriter, bool) {
	return lookup(clickhouseFunctions, name)
}

var trinoFunctions = over(map[string]FunctionWriter{
	// Two whole numbers divide into a whole number here, and two decimals
	// into the larger of their scales, rounded: all but floats are given
	// room for the rest of the quotient first.
	"/": func(args []Operand) string {
		left := args[0].SQL
		if args[0].Type != "float" && args[1].Type != "float" {
			left = "CAST(" + left + " AS decimal(38, 10))"
		}
		return "(" + left + " / NULLIF(" + args[1].SQL + ", 0))"
	},

	"length": call("length"),
	// No LEFT or RIGHT here; a negative count is no characters, as elsewhere.
	"left":        pattern("substr($1, 1, greatest($2, 0))"),
	"right":       pattern("substr($1, greatest(length($1) - ($2) + 1, 1), greatest($2, 0))"),
	"contains":    pattern("(strpos($1, $2) > 0)"),
	"starts_with": call("starts_with"),
	"ends_with":   pattern("(substr($1, greatest(length($1) - length($2) + 1, 1)) = $2)"),

	"year":         call("year"),
	"quarter":      call("quarter"),
	"month":        call("month"),
	"day":          call("day"),
	"hour":         call("hour"),
	"minute":       call("minute"),
	"isoweekday":   call("day_of_week"),
	"days_between": pattern("date_diff('day', CAST($1 AS date), CAST($2 AS date))"),
	"add_year":     pattern("date_add('year', $2, $1)"),
	"add_month":    pattern("date_add('month', $2, $1)"),
	"add_day":      pattern("date_add('day', $2, $1)"),
	"add_hour":     pattern("date_add('hour', $2, $1)"),
	"add_minute":   pattern("date_add('minute', $2, $1)"),

	"to_string":  pattern("CAST($1 AS varchar)"),
	"to_integer": truncating("truncate($1)", "bigint"),
	"to_decimal": pattern("CAST($1 AS decimal(38, 10))"),
	"to_float":   pattern("CAST($1 AS double)"),

	// Only approx_percentile, which picks a value rather than interpolating.
	"median": nil,
})

func (Trino) Function(name string) (FunctionWriter, bool) { return lookup(trinoFunctions, name) }

// A date moved by DATE_ADD comes back as a time in StarRocks.
func addingDate(unit string) FunctionWriter {
	return func(args []Operand) string {
		moved := "DATE_ADD(" + args[0].SQL + ", INTERVAL " + args[1].SQL + " " + unit + ")"
		if args[0].Type == "date" {
			return "CAST(" + moved + " AS DATE)"
		}
		return moved
	}
}

var starrocksFunctions = over(map[string]FunctionWriter{
	"contains":    pattern("(LOCATE($2, $1) > 0)"),
	"starts_with": call("STARTS_WITH"),
	"ends_with":   call("ENDS_WITH"),
	// DAYOFWEEK counts from Sunday as 1.
	"isoweekday": pattern("(MOD(DAYOFWEEK($1) + 5, 7) + 1)"),
	"add_year":   addingDate("YEAR"),
	"add_month":  addingDate("MONTH"),
	"add_day":    addingDate("DAY"),
	"to_string":  pattern("CAST($1 AS VARCHAR)"),
	"to_integer": truncating("TRUNCATE($1, 0)", "BIGINT"),

	"median":       pattern("PERCENTILE_CONT($1, 0.5)"),
	"regexp_match": pattern("($1 REGEXP $2)"),
})

var dorisFunctions = func() map[string]FunctionWriter {
	all := make(map[string]FunctionWriter, len(starrocksFunctions))
	for name, write := range starrocksFunctions {
		all[name] = write
	}
	all["median"] = pattern("PERCENTILE($1, 0.5)")
	return all
}()

func (d StarRocks) Function(name string) (FunctionWriter, bool) {
	if d.Doris {
		return lookup(dorisFunctions, name)
	}
	return lookup(starrocksFunctions, name)
}
