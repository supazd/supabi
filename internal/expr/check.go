package expr

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/supazd/supabi/internal/datasource"
)

// FieldInfo is what an expression needs to know of a field it refers to.
type FieldInfo struct {
	Key  string
	Type datasource.Type
	// Metric fields aggregate by themselves.
	Metric bool
}

// Scope finds the field a reference names. Where expressions are stored the
// name is the field's key; where they are written it is the name people see.
type Scope func(name string) (FieldInfo, bool)

// Checked is an expression that is known to make sense.
type Checked struct {
	Root Node
	// Type is what it gives, or empty when that cannot be told: it then gives
	// whatever a piece of native SQL in it does.
	Type datasource.Type
	// Aggregate is set when it turns the rows of a group into one value.
	Aggregate bool
	// Native is set when a piece of native SQL is part of it.
	Native bool
	// Refs are the keys of the fields it refers to, each once.
	Refs []string
	// Functions are the functions it uses, each once.
	Functions []string

	types map[Node]datasource.Type
	keys  map[*Ref]string
	// dates are the texts that are read as dates.
	dates map[*Lit]bool
}

// How many rows a value is of: none, as a constant; one; or a group of them.
const (
	constant = iota
	perRow
	perGroup
)

type checker struct {
	scope Scope
	out   *Checked
	seen  map[string]bool
}

// Check reads an expression and works out what it gives. An expression that
// aggregates is for a metric; one that does not is for a field with a value
// on every row.
func Check(text string, scope Scope, metric bool) (*Checked, *Error) {
	root, err := Parse(text)
	if err != nil {
		return nil, err
	}
	c := &checker{scope: scope, seen: map[string]bool{}, out: &Checked{Root: root, types: map[Node]datasource.Type{}, keys: map[*Ref]string{}, dates: map[*Lit]bool{}}}
	t, level, err := c.node(root)
	if err != nil {
		return nil, err
	}
	c.out.Type, c.out.Aggregate = t, level == perGroup
	from, to := root.Span()
	switch {
	case metric && level != perGroup && !c.out.Native:
		return nil, errorAt(from, to, "expr_metric_needs_aggregate", nil, "a metric aggregates in its own expression, such as SUM(${amount}) / COUNT(${id})")
	case !metric && level == perGroup:
		return nil, errorAt(from, to, "expr_aggregate_in_row", nil, "this field has a value on every row, so its expression cannot aggregate; make it a metric to aggregate")
	}
	return c.out, nil
}

func isNumber(t datasource.Type) bool { return t.Numeric() }

// unify returns the type two values have in common. A value of unknown type goes with any.
func unify(a, b datasource.Type) (datasource.Type, bool) {
	switch {
	case a == "":
		return b, true
	case b == "" || a == b:
		return a, true
	case isNumber(a) && isNumber(b):
		if a == datasource.Float || b == datasource.Float {
			return datasource.Float, true
		}
		return datasource.Decimal, true
	}
	return "", false
}

var datePattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// asDate reads a text that is written as a date as one, where a date is what is wanted.
func (c *checker) asDate(n Node, t datasource.Type) datasource.Type {
	if lit, ok := n.(*Lit); ok && t == datasource.String && datePattern.MatchString(lit.Text) {
		c.out.dates[lit] = true
		c.out.types[n] = datasource.Date
		return datasource.Date
	}
	return t
}

// same checks that values can be compared or stand for one another, and returns their common type.
func (c *checker) same(nodes []Node, types []datasource.Type) (datasource.Type, *Error) {
	hasDate := false
	for _, t := range types {
		hasDate = hasDate || t == datasource.Date
	}
	common := datasource.Type("")
	for i, n := range nodes {
		t := types[i]
		if hasDate {
			t = c.asDate(n, t)
		}
		merged, ok := unify(common, t)
		if !ok {
			from, to := n.Span()
			return "", errorAt(from, to, "expr_type_mismatch", []string{"left", string(common), "right", string(t)}, "%s and %s do not go together", common, t)
		}
		common = merged
	}
	return common, nil
}

func mix(levels ...int) (int, bool) {
	level := constant
	for _, l := range levels {
		if l != constant && level != constant && l != level {
			return 0, false
		}
		level = max(level, l)
	}
	return level, true
}

func (c *checker) nodes(nodes []Node) ([]datasource.Type, int, *Error) {
	types := make([]datasource.Type, len(nodes))
	levels := make([]int, len(nodes))
	for i, n := range nodes {
		t, level, err := c.node(n)
		if err != nil {
			return nil, 0, err
		}
		types[i], levels[i] = t, level
	}
	level, ok := mix(levels...)
	if !ok {
		from, _ := nodes[0].Span()
		_, to := nodes[len(nodes)-1].Span()
		return nil, 0, errorAt(from, to, "expr_mixed_levels", nil, "a value of each row cannot be put together with an aggregate; aggregate it too")
	}
	return types, level, nil
}

func (c *checker) want(n Node, t datasource.Type, kinds ...datasource.Type) *Error {
	if t == "" {
		return nil
	}
	for _, kind := range kinds {
		if t == kind {
			return nil
		}
	}
	names := make([]string, len(kinds))
	for i, kind := range kinds {
		names[i] = string(kind)
	}
	from, to := n.Span()
	return errorAt(from, to, "expr_wrong_type", []string{"expected", strings.Join(names, ","), "actual", string(t)}, "this is %s, where %s is needed", t, strings.Join(names, " or "))
}

func (c *checker) node(n Node) (t datasource.Type, level int, err *Error) {
	defer func() {
		if err == nil {
			// A text read as a date has been noted as one already.
			if _, noted := c.out.types[n]; !noted {
				c.out.types[n] = t
			}
		}
	}()
	switch n := n.(type) {
	case *Lit:
		return n.Type, constant, nil

	case *Ref:
		field, ok := c.scope(n.Name)
		if !ok {
			return "", 0, errorAt(n.from, n.to, "expr_unknown_field", []string{"name", n.Name}, "there is no field %q", n.Name)
		}
		c.out.keys[n] = field.Key
		if !c.seen["$"+field.Key] {
			c.seen["$"+field.Key] = true
			c.out.Refs = append(c.out.Refs, field.Key)
		}
		if field.Metric {
			return field.Type, perGroup, nil
		}
		return field.Type, perRow, nil

	case *Unary:
		t, level, err := c.node(n.X)
		if err != nil {
			return "", 0, err
		}
		if n.Op == "not" {
			return datasource.Boolean, level, c.want(n.X, t, datasource.Boolean)
		}
		return t, level, c.want(n.X, t, datasource.Integer, datasource.Decimal, datasource.Float)

	case *Binary:
		sides := []Node{n.L, n.R}
		types, level, err := c.nodes(sides)
		if err != nil {
			return "", 0, err
		}
		switch n.Op {
		case "and", "or":
			for i, side := range sides {
				if err := c.want(side, types[i], datasource.Boolean); err != nil {
					return "", 0, err
				}
			}
			return datasource.Boolean, level, nil
		case "=", "<>", "<", "<=", ">", ">=":
			_, err := c.same(sides, types)
			return datasource.Boolean, level, err
		}
		for i, side := range sides {
			if err := c.want(side, types[i], datasource.Integer, datasource.Decimal, datasource.Float); err != nil {
				return "", 0, err
			}
		}
		common, _ := unify(types[0], types[1])
		switch {
		case n.Op == "%":
			for i, side := range sides {
				if err := c.want(side, types[i], datasource.Integer); err != nil {
					return "", 0, err
				}
			}
			return datasource.Integer, level, nil
		case n.Op == "/" && common != datasource.Float:
			// Dividing never drops the fraction, whatever is divided.
			return datasource.Decimal, level, nil
		}
		return common, level, nil

	case *Case:
		var all, conds, results []Node
		if n.Subject != nil {
			all, conds = append(all, n.Subject), append(conds, n.Subject)
		}
		for _, when := range n.Whens {
			all = append(all, when.Cond, when.Then)
			conds, results = append(conds, when.Cond), append(results, when.Then)
		}
		if n.Else != nil {
			all, results = append(all, n.Else), append(results, n.Else)
		}
		_, level, err := c.nodes(all)
		if err != nil {
			return "", 0, err
		}
		typesOf := func(nodes []Node) []datasource.Type {
			types := make([]datasource.Type, len(nodes))
			for i, node := range nodes {
				types[i] = c.out.types[node]
			}
			return types
		}
		if n.Subject != nil {
			if _, err := c.same(conds, typesOf(conds)); err != nil {
				return "", 0, err
			}
		} else {
			for _, cond := range conds {
				if err := c.want(cond, c.out.types[cond], datasource.Boolean); err != nil {
					return "", 0, err
				}
			}
		}
		t, err := c.same(results, typesOf(results))
		return t, level, err

	case *In:
		all := append([]Node{n.X}, n.List...)
		types, level, err := c.nodes(all)
		if err != nil {
			return "", 0, err
		}
		_, err = c.same(all, types)
		return datasource.Boolean, level, err

	case *Between:
		all := []Node{n.X, n.Low, n.High}
		types, level, err := c.nodes(all)
		if err != nil {
			return "", 0, err
		}
		_, err = c.same(all, types)
		return datasource.Boolean, level, err

	case *IsNull:
		_, level, err := c.node(n.X)
		return datasource.Boolean, level, err

	case *Call:
		return c.call(n)
	}
	panic("expr: unknown node")
}

func (c *checker) call(n *Call) (datasource.Type, int, *Error) {
	f, ok := byName[n.Name]
	if !ok {
		return "", 0, errorAt(n.name.from, n.name.to, "expr_unknown_function", []string{"name", n.Name}, "there is no function %s", n.Name)
	}
	if !c.seen[f.Name] {
		c.seen[f.Name] = true
		c.out.Functions = append(c.out.Functions, f.Name)
	}
	types, level, err := c.nodes(n.Args)
	if err != nil {
		return "", 0, err
	}
	if len(n.Args) == 0 {
		level = constant
	}
	if f.Aggregate {
		if level == perGroup {
			return "", 0, errorAt(n.from, n.to, "expr_nested_aggregate", []string{"name", f.Name}, "%s is given something that is aggregated already", f.Name)
		}
		level = perGroup
	}

	if f.check != nil {
		t, err := f.check(c, n, types)
		return t, level, err
	}
	least, most := len(f.params)-f.optional, len(f.params)
	if len(n.Args) < least || len(n.Args) > most && !f.variadic {
		return "", 0, c.arity(n, least, most, f.variadic)
	}
	for i, arg := range n.Args {
		p := f.params[min(i, len(f.params)-1)]
		if p.units != nil {
			if err := c.unit(arg, p.units); err != nil {
				return "", 0, err
			}
			continue
		}
		if p.kinds == nil {
			continue
		}
		wantsText := false
		for _, kind := range p.kinds {
			wantsText = wantsText || kind == datasource.String
		}
		if !wantsText {
			types[i] = c.asDate(arg, types[i])
		}
		if err := c.want(arg, types[i], p.kinds...); err != nil {
			return "", 0, err
		}
	}
	return f.result(types), level, nil
}

func (c *checker) arity(n *Call, least, most int, variadic bool) *Error {
	wanted := strconv.Itoa(least)
	switch {
	case variadic:
		wanted += "+"
	case most != least:
		wanted += "-" + strconv.Itoa(most)
	}
	return errorAt(n.from, n.to, "expr_arguments", []string{"name", n.Name, "expected", wanted, "actual", strconv.Itoa(len(n.Args))},
		"%s takes %s arguments, and is given %d", n.Name, wanted, len(n.Args))
}

// unit checks that an argument is one of the words a function knows, written as text.
func (c *checker) unit(n Node, units []string) *Error {
	if lit, ok := n.(*Lit); ok && lit.Type == datasource.String {
		for _, unit := range units {
			if strings.EqualFold(lit.Text, unit) {
				return nil
			}
		}
	}
	from, to := n.Span()
	quoted := make([]string, len(units))
	for i, unit := range units {
		quoted[i] = "'" + unit + "'"
	}
	return errorAt(from, to, "expr_unit", []string{"units", strings.Join(quoted, ", ")}, "one of %s is needed here", strings.Join(quoted, ", "))
}

func unitOf(n Node) string { return strings.ToLower(n.(*Lit).Text) }

func checkIf(c *checker, n *Call, types []datasource.Type) (datasource.Type, *Error) {
	if len(n.Args) != 3 {
		return "", c.arity(n, 3, 3, false)
	}
	if err := c.want(n.Args[0], types[0], datasource.Boolean); err != nil {
		return "", err
	}
	return c.same(n.Args[1:], types[1:])
}

func checkSame(c *checker, n *Call, types []datasource.Type) (datasource.Type, *Error) {
	if len(n.Args) < 2 || n.Name == "IFNULL" && len(n.Args) > 2 {
		return "", c.arity(n, 2, 2, n.Name != "IFNULL")
	}
	return c.same(n.Args, types)
}

func checkNullIf(c *checker, n *Call, types []datasource.Type) (datasource.Type, *Error) {
	if len(n.Args) != 2 {
		return "", c.arity(n, 2, 2, false)
	}
	if _, err := c.same(n.Args, types); err != nil {
		return "", err
	}
	return c.out.types[n.Args[0]], nil
}

// The digits of ROUND are written out: some databases take nothing else.
func checkRound(c *checker, n *Call, types []datasource.Type) (datasource.Type, *Error) {
	if len(n.Args) < 1 || len(n.Args) > 2 {
		return "", c.arity(n, 1, 2, false)
	}
	if err := c.want(n.Args[0], types[0], datasource.Integer, datasource.Decimal, datasource.Float); err != nil {
		return "", err
	}
	if len(n.Args) == 2 {
		if lit, ok := n.Args[1].(*Lit); !ok || lit.Type != datasource.Integer {
			from, to := n.Args[1].Span()
			return "", errorAt(from, to, "expr_literal_needed", []string{"name", n.Name}, "the number of digits is written out as a whole number")
		}
	}
	return types[0], nil
}

func checkDateAdd(c *checker, n *Call, types []datasource.Type) (datasource.Type, *Error) {
	if len(n.Args) != 3 {
		return "", c.arity(n, 3, 3, false)
	}
	types[0] = c.asDate(n.Args[0], types[0])
	if err := c.want(n.Args[0], types[0], datasource.Date, datasource.Timestamp); err != nil {
		return "", err
	}
	if err := c.want(n.Args[1], types[1], datasource.Integer); err != nil {
		return "", err
	}
	units := timeUnits
	if types[0] == datasource.Date {
		// A date moved by hours would no longer be a date.
		units = dateUnits
	}
	return types[0], c.unit(n.Args[2], units)
}

var nativeSlot = regexp.MustCompile(`\{(\d+)\}`)

// NATIVE('sql with {0} and {1}', a, b) is a piece of the database's own SQL,
// with the other arguments written where the numbers are.
func checkNative(c *checker, n *Call, _ []datasource.Type) (datasource.Type, *Error) {
	c.out.Native = true
	if len(n.Args) == 0 {
		return "", c.arity(n, 1, 1, true)
	}
	lit, ok := n.Args[0].(*Lit)
	if !ok || lit.Type != datasource.String || strings.TrimSpace(lit.Text) == "" {
		from, to := n.Args[0].Span()
		return "", errorAt(from, to, "expr_native_text", nil, "NATIVE takes the SQL as text, written out")
	}
	for _, slot := range nativeSlot.FindAllStringSubmatch(lit.Text, -1) {
		if at, _ := strconv.Atoi(slot[1]); at >= len(n.Args)-1 {
			return "", errorAt(lit.from, lit.to, "expr_native_slot", []string{"slot", slot[0]}, "%s has no argument to stand for", slot[0])
		}
	}
	return "", nil
}

// Refs lists the names an expression refers to, as they are written.
func Refs(root Node) []string {
	var names []string
	var walk func(Node)
	walk = func(n Node) {
		switch n := n.(type) {
		case *Ref:
			names = append(names, n.Name)
		case *Unary:
			walk(n.X)
		case *Binary:
			walk(n.L)
			walk(n.R)
		case *Call:
			for _, arg := range n.Args {
				walk(arg)
			}
		case *Case:
			if n.Subject != nil {
				walk(n.Subject)
			}
			for _, when := range n.Whens {
				walk(when.Cond)
				walk(when.Then)
			}
			if n.Else != nil {
				walk(n.Else)
			}
		case *In:
			walk(n.X)
			for _, item := range n.List {
				walk(item)
			}
		case *Between:
			walk(n.X)
			walk(n.Low)
			walk(n.High)
		case *IsNull:
			walk(n.X)
		}
	}
	walk(root)
	return names
}
