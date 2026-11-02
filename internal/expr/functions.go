package expr

import (
	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/dialect"
)

// Categories of functions, in the order they are offered.
const (
	Aggregate = "aggregate"
	Logic     = "logic"
	Math      = "math"
	Text      = "text"
	Date      = "date"
	Convert   = "convert"
	Escape    = "native"
)

// Func is a function of the language.
type Func struct {
	Name     string
	Category string
	// Aggregate functions turn the rows of a group into one value. They are
	// what a metric is made of, and have no place in a field computed per row.
	Aggregate bool
	// Extended functions are beyond the core: a database may not have them,
	// and those that do need not agree to the last detail. An expression
	// that uses one is not promised to move to another database.
	Extended bool

	params []param
	// optional is how many of the last parameters may be left out.
	optional int
	// variadic lets the last parameter be given any number of times.
	variadic bool
	result   func(args []datasource.Type) datasource.Type
	// check replaces the checking of arguments against params.
	check func(c *checker, call *Call, args []datasource.Type) (datasource.Type, *Error)
	// needs are the functions of a dialect it is written with.
	needs []string
}

type param struct {
	// kinds are the types the argument may have; nil for any.
	kinds []datasource.Type
	// units, when set, are the words the argument must be one of, written as text.
	units []string
}

var (
	anything = param{}
	number   = param{kinds: []datasource.Type{datasource.Integer, datasource.Decimal, datasource.Float}}
	whole    = param{kinds: []datasource.Type{datasource.Integer}}
	text     = param{kinds: []datasource.Type{datasource.String}}
	moment   = param{kinds: []datasource.Type{datasource.Date, datasource.Timestamp}}
	instant  = param{kinds: []datasource.Type{datasource.Timestamp}}

	dateUnits = []string{"year", "quarter", "month", "week", "day"}
	timeUnits = []string{"year", "quarter", "month", "week", "day", "hour", "minute"}
)

func always(t datasource.Type) func([]datasource.Type) datasource.Type {
	return func([]datasource.Type) datasource.Type { return t }
}

func first(args []datasource.Type) datasource.Type { return args[0] }

// sumType and avgType follow dataset.Agg.ResultType: a sum of whole numbers
// can outgrow them, and an average is seldom whole.
func sumType(args []datasource.Type) datasource.Type {
	if args[0] == datasource.Integer {
		return datasource.Decimal
	}
	return args[0]
}

func avgType(args []datasource.Type) datasource.Type {
	if args[0] == datasource.Float {
		return datasource.Float
	}
	return datasource.Decimal
}

var catalogue = []Func{
	{Name: "SUM", Category: Aggregate, Aggregate: true, params: []param{number}, result: sumType, needs: []string{"sum"}},
	{Name: "AVG", Category: Aggregate, Aggregate: true, params: []param{number}, result: avgType, needs: []string{"avg"}},
	{Name: "MIN", Category: Aggregate, Aggregate: true, params: []param{anything}, result: first, needs: []string{"min"}},
	{Name: "MAX", Category: Aggregate, Aggregate: true, params: []param{anything}, result: first, needs: []string{"max"}},
	{Name: "COUNT", Category: Aggregate, Aggregate: true, params: []param{anything}, optional: 1, result: always(datasource.Integer), needs: []string{"count", "count_all"}},
	{Name: "COUNT_DISTINCT", Category: Aggregate, Aggregate: true, params: []param{anything}, result: always(datasource.Integer), needs: []string{"count_distinct"}},
	{Name: "MEDIAN", Category: Aggregate, Aggregate: true, Extended: true, params: []param{number}, result: always(datasource.Float), needs: []string{"median"}},

	{Name: "IF", Category: Logic, check: checkIf},
	{Name: "COALESCE", Category: Logic, check: checkSame, needs: []string{"coalesce"}},
	{Name: "IFNULL", Category: Logic, check: checkSame, needs: []string{"coalesce"}},
	{Name: "NULLIF", Category: Logic, check: checkNullIf, needs: []string{"nullif"}},

	{Name: "ABS", Category: Math, params: []param{number}, result: first, needs: []string{"abs"}},
	{Name: "ROUND", Category: Math, check: checkRound, needs: []string{"round"}},
	{Name: "FLOOR", Category: Math, params: []param{number}, result: always(datasource.Integer), needs: []string{"floor"}},
	{Name: "CEIL", Category: Math, params: []param{number}, result: always(datasource.Integer), needs: []string{"ceil"}},
	{Name: "MOD", Category: Math, params: []param{whole, whole}, result: always(datasource.Integer), needs: []string{"%"}},
	{Name: "POWER", Category: Math, params: []param{number, number}, result: always(datasource.Float), needs: []string{"power"}},
	{Name: "SQRT", Category: Math, params: []param{number}, result: always(datasource.Float), needs: []string{"sqrt"}},

	{Name: "CONCAT", Category: Text, params: []param{text, text}, variadic: true, result: always(datasource.String), needs: []string{"concat"}},
	{Name: "UPPER", Category: Text, params: []param{text}, result: always(datasource.String), needs: []string{"upper"}},
	{Name: "LOWER", Category: Text, params: []param{text}, result: always(datasource.String), needs: []string{"lower"}},
	{Name: "TRIM", Category: Text, params: []param{text}, result: always(datasource.String), needs: []string{"trim"}},
	{Name: "LENGTH", Category: Text, params: []param{text}, result: always(datasource.Integer), needs: []string{"length"}},
	{Name: "SUBSTR", Category: Text, params: []param{text, whole, whole}, optional: 1, result: always(datasource.String), needs: []string{"substr"}},
	{Name: "LEFT", Category: Text, params: []param{text, whole}, result: always(datasource.String), needs: []string{"left"}},
	{Name: "RIGHT", Category: Text, params: []param{text, whole}, result: always(datasource.String), needs: []string{"right"}},
	{Name: "REPLACE", Category: Text, params: []param{text, text, text}, result: always(datasource.String), needs: []string{"replace"}},
	{Name: "CONTAINS", Category: Text, params: []param{text, text}, result: always(datasource.Boolean), needs: []string{"contains"}},
	{Name: "STARTS_WITH", Category: Text, params: []param{text, text}, result: always(datasource.Boolean), needs: []string{"starts_with"}},
	{Name: "ENDS_WITH", Category: Text, params: []param{text, text}, result: always(datasource.Boolean), needs: []string{"ends_with"}},
	{Name: "REGEXP_MATCH", Category: Text, Extended: true, params: []param{text, text}, result: always(datasource.Boolean), needs: []string{"regexp_match"}},

	{Name: "TODAY", Category: Date, result: always(datasource.Date), needs: []string{"to_date"}},
	{Name: "DATE", Category: Date, params: []param{{kinds: []datasource.Type{datasource.Date, datasource.Timestamp, datasource.String}}}, result: always(datasource.Date), needs: []string{"to_date"}},
	{Name: "YEAR", Category: Date, params: []param{moment}, result: always(datasource.Integer), needs: []string{"year"}},
	{Name: "QUARTER", Category: Date, params: []param{moment}, result: always(datasource.Integer), needs: []string{"quarter"}},
	{Name: "MONTH", Category: Date, params: []param{moment}, result: always(datasource.Integer), needs: []string{"month"}},
	{Name: "DAY", Category: Date, params: []param{moment}, result: always(datasource.Integer), needs: []string{"day"}},
	{Name: "HOUR", Category: Date, params: []param{instant}, result: always(datasource.Integer), needs: []string{"hour"}},
	{Name: "MINUTE", Category: Date, params: []param{instant}, result: always(datasource.Integer), needs: []string{"minute"}},
	{Name: "WEEKDAY", Category: Date, params: []param{moment}, result: always(datasource.Integer), needs: []string{"isoweekday"}},
	{Name: "DATE_TRUNC", Category: Date, params: []param{{units: dateUnits}, moment}, result: always(datasource.Date), needs: []string{"to_date"}},
	{Name: "DATE_ADD", Category: Date, check: checkDateAdd, needs: []string{"add_year", "add_month", "add_day", "add_hour", "add_minute"}},
	{Name: "DATE_DIFF", Category: Date, params: []param{{units: dateUnits}, moment, moment}, result: always(datasource.Integer), needs: []string{"days_between", "year", "quarter", "month", "to_integer"}},

	{Name: "TO_STRING", Category: Convert, params: []param{{kinds: []datasource.Type{datasource.String, datasource.Integer, datasource.Decimal, datasource.Float, datasource.Date}}}, result: always(datasource.String), needs: []string{"to_string"}},
	{Name: "TO_INTEGER", Category: Convert, params: []param{{kinds: []datasource.Type{datasource.String, datasource.Integer, datasource.Decimal, datasource.Float}}}, result: always(datasource.Integer), needs: []string{"to_integer"}},
	{Name: "TO_DECIMAL", Category: Convert, params: []param{{kinds: []datasource.Type{datasource.String, datasource.Integer, datasource.Decimal, datasource.Float}}}, result: always(datasource.Decimal), needs: []string{"to_decimal"}},
	{Name: "TO_FLOAT", Category: Convert, params: []param{{kinds: []datasource.Type{datasource.String, datasource.Integer, datasource.Decimal, datasource.Float}}}, result: always(datasource.Float), needs: []string{"to_float"}},

	{Name: "NATIVE", Category: Escape, check: checkNative},
}

var byName = func() map[string]*Func {
	all := map[string]*Func{}
	for i := range catalogue {
		all[catalogue[i].Name] = &catalogue[i]
	}
	return all
}()

// Lookup returns the function of a name, written in upper case.
func Lookup(name string) (Func, bool) {
	f, ok := byName[name]
	if !ok {
		return Func{}, false
	}
	return *f, true
}

// Available reports whether a database can compute the function.
func (f Func) Available(d dialect.Functions) bool {
	for _, need := range f.needs {
		if _, ok := d.Function(need); !ok {
			return false
		}
	}
	return true
}

// Functions lists the functions a database can compute, in the order they are offered.
func Functions(d dialect.Functions) []Func {
	var out []Func
	for _, f := range catalogue {
		if f.Available(d) {
			out = append(out, f)
		}
	}
	return out
}
