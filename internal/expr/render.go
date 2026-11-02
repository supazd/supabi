package expr

import (
	"strconv"
	"strings"

	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/dialect"
)

// Env is what writing an expression as SQL depends on.
type Env struct {
	Dialect dialect.Dialect
	// Zone is the time zone a time is read in when a date or a part of one is taken from it.
	Zone      string
	WeekStart int
	// Today is the date in Zone, as 2006-01-02.
	Today string
	// Ref returns the SQL of the field with a key.
	Ref func(key string) string
}

// SQL writes the expression in a database's SQL. It fails when the database
// has no way to compute one of its functions.
func (c *Checked) SQL(env Env) (string, *Error) {
	r := &renderer{c: c, env: env}
	sql := r.node(c.Root).SQL
	return sql, r.err
}

type renderer struct {
	c   *Checked
	env Env
	err *Error
	// at is the function being written, for saying which one a database lacks.
	at *Call
}

func (r *renderer) operands(nodes []Node) []dialect.Operand {
	out := make([]dialect.Operand, len(nodes))
	for i, n := range nodes {
		out[i] = r.node(n)
	}
	return out
}

func typed(sql string, t datasource.Type) dialect.Operand {
	return dialect.Operand{SQL: sql, Type: string(t)}
}

// write calls a function of the dialect.
func (r *renderer) write(name string, t datasource.Type, args ...dialect.Operand) dialect.Operand {
	write, ok := r.env.Dialect.Function(name)
	if !ok {
		if r.err == nil {
			from, to, called := 0, 0, name
			if r.at != nil {
				from, to, called = r.at.from, r.at.to, r.at.Name
			}
			r.err = errorAt(from, to, "function_unavailable", []string{"name", called, "dialect", r.env.Dialect.Name()}, "%s is not available on %s", called, r.env.Dialect.Name())
		}
		return typed("NULL", t)
	}
	return typed(write(args), t)
}

func (r *renderer) text(value string) string {
	value = strings.ReplaceAll(value, "'", "''")
	if r.env.Dialect.Lexis().BackslashEscapes {
		value = strings.ReplaceAll(value, `\`, `\\`)
	}
	return "'" + value + "'"
}

func (r *renderer) date(value string) dialect.Operand {
	return r.write("to_date", datasource.Date, typed(r.text(value), datasource.String))
}

// day is the calendar date of a date or a time. A time is read in the zone of the query.
func (r *renderer) day(x dialect.Operand) dialect.Operand {
	switch datasource.Type(x.Type) {
	case datasource.Timestamp:
		return r.write("to_date", datasource.Date, typed(r.env.Dialect.LocalTime(x.SQL, r.env.Zone), datasource.Timestamp))
	case datasource.String:
		return r.write("to_date", datasource.Date, x)
	}
	return x
}

// local is a date as it is, or a time as the clock shows it in the zone of the query.
func (r *renderer) local(x dialect.Operand) dialect.Operand {
	if datasource.Type(x.Type) == datasource.Timestamp {
		return typed(r.env.Dialect.LocalTime(x.SQL, r.env.Zone), datasource.Timestamp)
	}
	return x
}

func (r *renderer) node(n Node) dialect.Operand {
	t := r.c.types[n]
	switch n := n.(type) {
	case *Lit:
		switch {
		case n.Type == "":
			return typed("NULL", t)
		case r.c.dates[n]:
			return r.date(n.Text)
		case n.Type == datasource.String:
			return typed(r.text(n.Text), t)
		case n.Type == datasource.Boolean:
			return typed(strings.ToUpper(n.Text), t)
		}
		return typed(n.Text, t)

	case *Ref:
		return typed("("+r.env.Ref(r.c.keys[n])+")", t)

	case *Unary:
		x := r.node(n.X)
		if n.Op == "not" {
			return typed("(NOT "+x.SQL+")", t)
		}
		return typed("(-"+x.SQL+")", t)

	case *Binary:
		l, right := r.node(n.L), r.node(n.R)
		switch n.Op {
		case "/", "%":
			return r.write(n.Op, t, l, right)
		case "and", "or":
			return typed("("+l.SQL+" "+strings.ToUpper(n.Op)+" "+right.SQL+")", t)
		case "=", "<>", "<", "<=", ">", ">=":
			return typed("("+r.compared(l).SQL+" "+n.Op+" "+r.compared(right).SQL+")", t)
		}
		return typed("("+l.SQL+" "+n.Op+" "+right.SQL+")", t)

	case *Case:
		var b strings.Builder
		b.WriteString("CASE")
		if n.Subject != nil {
			b.WriteString(" " + r.compared(r.node(n.Subject)).SQL)
		}
		for _, when := range n.Whens {
			cond := r.node(when.Cond)
			if n.Subject != nil {
				cond = r.compared(cond)
			}
			b.WriteString(" WHEN " + cond.SQL + " THEN " + r.node(when.Then).SQL)
		}
		if n.Else != nil {
			b.WriteString(" ELSE " + r.node(n.Else).SQL)
		}
		b.WriteString(" END")
		return typed(b.String(), t)

	case *In:
		items := make([]string, len(n.List))
		for i, item := range n.List {
			items[i] = r.compared(r.node(item)).SQL
		}
		not := ""
		if n.Not {
			not = "NOT "
		}
		return typed("("+r.compared(r.node(n.X)).SQL+" "+not+"IN ("+strings.Join(items, ", ")+"))", t)

	case *Between:
		not := ""
		if n.Not {
			not = "NOT "
		}
		return typed("("+r.compared(r.node(n.X)).SQL+" "+not+"BETWEEN "+r.compared(r.node(n.Low)).SQL+" AND "+r.compared(r.node(n.High)).SQL+")", t)

	case *IsNull:
		if n.Not {
			return typed("("+r.node(n.X).SQL+" IS NOT NULL)", t)
		}
		return typed("("+r.node(n.X).SQL+" IS NULL)", t)

	case *Call:
		outer := r.at
		r.at = n
		defer func() { r.at = outer }()
		return r.call(n, t)
	}
	panic("expr: unknown node")
}

// compared is a value as it is compared with another: two times are compared
// as moments, however each is stored.
func (r *renderer) compared(x dialect.Operand) dialect.Operand {
	if datasource.Type(x.Type) == datasource.Timestamp {
		return typed(r.env.Dialect.Instant(x.SQL), datasource.Timestamp)
	}
	return x
}

// Names of the dialect's functions that are written with the arguments as they are.
var direct = map[string]string{
	"SUM": "sum", "AVG": "avg", "MIN": "min", "MAX": "max", "COUNT_DISTINCT": "count_distinct", "MEDIAN": "median",
	"COALESCE": "coalesce", "IFNULL": "coalesce", "NULLIF": "nullif",
	"ABS": "abs", "ROUND": "round", "FLOOR": "floor", "CEIL": "ceil", "MOD": "%", "POWER": "power", "SQRT": "sqrt",
	"CONCAT": "concat", "UPPER": "upper", "LOWER": "lower", "TRIM": "trim", "LENGTH": "length", "SUBSTR": "substr",
	"LEFT": "left", "RIGHT": "right", "REPLACE": "replace", "CONTAINS": "contains", "STARTS_WITH": "starts_with",
	"ENDS_WITH": "ends_with", "REGEXP_MATCH": "regexp_match",
	"TO_INTEGER": "to_integer", "TO_DECIMAL": "to_decimal", "TO_FLOAT": "to_float",
}

// Parts of a date, by the function that reads them.
var parts = map[string]string{"YEAR": "year", "QUARTER": "quarter", "MONTH": "month", "DAY": "day", "HOUR": "hour", "MINUTE": "minute", "WEEKDAY": "isoweekday"}

func (r *renderer) call(n *Call, t datasource.Type) dialect.Operand {
	args := r.operands(n.Args)
	if name, ok := direct[n.Name]; ok {
		return r.write(name, t, args...)
	}
	if name, ok := parts[n.Name]; ok {
		return r.write(name, t, r.local(args[0]))
	}
	integer := func(sql string) dialect.Operand { return typed(sql, datasource.Integer) }

	switch n.Name {
	case "COUNT":
		if len(args) == 0 {
			return r.write("count_all", t)
		}
		return r.write("count", t, args...)

	case "IF":
		return typed("CASE WHEN "+args[0].SQL+" THEN "+args[1].SQL+" ELSE "+args[2].SQL+" END", t)

	case "TODAY":
		return r.date(r.env.Today)

	case "DATE":
		return r.day(args[0])

	case "TO_STRING":
		if datasource.Type(args[0].Type) == datasource.String {
			return args[0]
		}
		return r.write("to_string", t, args[0])

	case "DATE_TRUNC":
		return r.truncated(unitOf(n.Args[0]), args[1])

	case "DATE_ADD":
		unit, count := unitOf(n.Args[2]), args[1]
		// A quarter is three months and a week seven days, to every database.
		switch unit {
		case "quarter":
			unit, count = "month", integer("("+count.SQL+" * 3)")
		case "week":
			unit, count = "day", integer("("+count.SQL+" * 7)")
		}
		return r.write("add_"+unit, t, args[0], count)

	case "DATE_DIFF":
		// How many times the unit begins anew between the two: from the last
		// day of a month to the first of the next is one month.
		unit, from, to := unitOf(n.Args[0]), args[1], args[2]
		part := func(name string, x dialect.Operand) string { return r.write(name, datasource.Integer, r.local(x)).SQL }
		years := "(" + part("year", to) + " - " + part("year", from) + ")"
		switch unit {
		case "year":
			return integer(years)
		case "quarter":
			return integer("(" + years + " * 4 + " + part("quarter", to) + " - " + part("quarter", from) + ")")
		case "month":
			return integer("(" + years + " * 12 + " + part("month", to) + " - " + part("month", from) + ")")
		case "week":
			days := r.write("days_between", datasource.Integer, r.truncated("week", from), r.truncated("week", to))
			return r.write("to_integer", t, typed("("+days.SQL+" / 7)", datasource.Decimal))
		}
		return r.write("days_between", t, r.day(from), r.day(to))

	case "NATIVE":
		sql := nativeSlot.ReplaceAllStringFunc(n.Args[0].(*Lit).Text, func(slot string) string {
			at, _ := strconv.Atoi(slot[1 : len(slot)-1])
			return args[at+1].SQL
		})
		return typed("("+sql+")", t)
	}
	panic("expr: no way to write " + n.Name)
}

// truncated is the first day of the year, quarter, month or week a date or a time is in.
func (r *renderer) truncated(unit string, x dialect.Operand) dialect.Operand {
	day := r.day(x)
	if unit == "day" {
		return day
	}
	return typed(r.env.Dialect.TruncDate(day.SQL, dialect.Grain(unit), r.env.WeekStart), datasource.Date)
}
