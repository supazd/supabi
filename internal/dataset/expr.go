package dataset

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/supazd/supabi/internal/expr"
)

var (
	keyPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,62}$`)
	refPattern = regexp.MustCompile(`\$\{([^}]*)\}`)
)

// ValidKey reports whether s can be a field key or an alias.
func ValidKey(s string) bool { return keyPattern.MatchString(s) }

// refs returns the keys an expression refers to as ${key}.
func refs(expr string) []string {
	var keys []string
	for _, m := range refPattern.FindAllStringSubmatch(expr, -1) {
		keys = append(keys, strings.TrimSpace(m[1]))
	}
	return keys
}

// Refs returns the keys of the fields a calculated field refers to. A field
// read from a column refers to none.
func (f Field) Refs() []string { return refs(f.Expr) }

// Quoter quotes an identifier for the target database.
type Quoter func(name string) string

// Writer is what writing a field as SQL depends on.
type Writer struct {
	// Quote writes the name of a column of the source.
	Quote Quoter
	// Env is what an expression in the platform's language is written for.
	// Its Ref is not used: a reference is to a field of the dataset.
	Env expr.Env
}

// FieldSQL returns the SQL of a field, with references to other fields
// expanded. A reference stands for the other field's own expression: for a
// measure that is the row-level value, without its default aggregation. The
// dataset must be valid. It fails when the database has no way to compute a
// function the field, or one it refers to, is written with.
func (s *Spec) FieldSQL(key string, w Writer) (string, error) {
	f, _ := s.FieldByKey(key)
	if f.Column != "" {
		return w.Quote(f.Column), nil
	}
	var failed error
	ref := func(key string) string {
		sql, err := s.FieldSQL(key, w)
		if err != nil && failed == nil {
			failed = err
		}
		return sql
	}
	if f.Syntax != Standard {
		sql := refPattern.ReplaceAllStringFunc(f.Expr, func(written string) string {
			return "(" + ref(strings.TrimSpace(written[2:len(written)-1])) + ")"
		})
		// Written by hand, so its outermost operator is not known: without the
		// brackets an OR at the top would take in whatever the field is
		// compared with or ANDed to, a row filter included.
		return "(" + sql + ")", failed
	}
	checked, err := s.checkExpr(f)
	if err != nil {
		return "", err
	}
	env := w.Env
	env.Ref = ref
	sql, exprErr := checked.SQL(env)
	if exprErr != nil {
		return "", exprError(f, exprErr)
	}
	return sql, failed
}

// checkExpr reads the expression of a field written in the platform's language.
func (s *Spec) checkExpr(f Field) (*expr.Checked, error) {
	checked, err := expr.Check(f.Expr, func(key string) (expr.FieldInfo, bool) {
		target, ok := s.FieldByKey(key)
		return expr.FieldInfo{Key: target.Key, Type: target.Type, Metric: target.Role == Metric}, ok
	}, f.Role == Metric)
	if err != nil {
		return nil, exprError(f, err)
	}
	return checked, nil
}

// exprError says which field a mistake in an expression is in. Where it is in
// the expression goes along as from and to, in bytes.
func exprError(f Field, err *expr.Error) *Error {
	pairs := []string{"key", f.Key, "label", f.Label, "from", strconv.Itoa(err.From), "to", strconv.Itoa(err.To)}
	for name, value := range err.Params {
		pairs = append(pairs, name, value)
	}
	return Errorf(err.Code, pairs, "field %q: %s", f.Label, err.Message)
}
