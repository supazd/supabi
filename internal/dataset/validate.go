package dataset

import (
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/expr"
)

var paramNamePattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,62}$`)

// Validate checks everything about a spec that can be checked without the
// database: structure, unique keys and names, roles, references and cycles. Whether the SQL
// itself is valid is established separately by running it with LIMIT 0.
func (s *Spec) Validate() error {
	if s.SpecVersion != CurrentSpecVersion {
		return Errorf("unsupported_spec_version", []string{"version", fmt.Sprint(s.SpecVersion)}, "spec version %d is not supported", s.SpecVersion)
	}
	if err := s.validateSource(); err != nil {
		return err
	}

	params := map[string]bool{}
	for _, p := range s.Params {
		switch {
		case !paramNamePattern.MatchString(p.Name):
			return Errorf("invalid_param_name", []string{"name", p.Name}, "invalid parameter name %q", p.Name)
		case params[p.Name]:
			return Errorf("duplicate_param", []string{"name", p.Name}, "parameter %q is declared twice", p.Name)
		case !p.Type.Valid():
			return Errorf("invalid_type", []string{"key", p.Name, "type", string(p.Type)}, "parameter %q has invalid type %q", p.Name, p.Type)
		}
		params[p.Name] = true
	}
	if s.Source.Type == "sql" {
		tpl, err := ParseTemplate(s.Source.SQL)
		if err != nil {
			return err
		}
		for _, name := range tpl.ParamNames() {
			if !params[name] {
				return Errorf("undeclared_param", []string{"name", name}, "the SQL uses parameter %q which is not declared", name)
			}
		}
	}

	if len(s.Fields) == 0 {
		return Errorf("no_fields", nil, "a dataset needs at least one field")
	}
	keys := map[string]bool{}
	labels := map[string]bool{}
	for _, f := range s.Fields {
		if !ValidKey(f.Key) {
			return Errorf("invalid_key", []string{"key", f.Key, "label", f.Label}, "invalid key %q: use lowercase letters, digits and underscores, starting with a letter", f.Key)
		}
		if keys[f.Key] {
			return Errorf("duplicate_key", []string{"key", f.Key, "label", f.Label}, "key %q is used more than once", f.Key)
		}
		keys[f.Key] = true

		if !ValidLabel(f.Label) {
			return Errorf("invalid_label", []string{"key", f.Key, "label", f.Label}, "invalid name %q: 1 to %d characters, without braces or line breaks", f.Label, maxLabelLength)
		}
		if folded := foldLabel(f.Label); labels[folded] {
			return Errorf("duplicate_label", []string{"key", f.Key, "label", f.Label}, "the name %q is used more than once", f.Label)
		} else {
			labels[folded] = true
		}

		switch {
		case f.Column == "" && strings.TrimSpace(f.Expr) == "":
			return Errorf("empty_expr", []string{"key", f.Key, "label", f.Label}, "field %q has neither a column nor an expression", f.Label)
		case f.Column != "" && f.Expr != "":
			return Errorf("column_and_expr", []string{"key", f.Key, "label", f.Label}, "field %q has both a column and an expression", f.Label)
		case strings.ContainsRune(f.Column, 0):
			return Errorf("invalid_column", []string{"key", f.Key, "label", f.Label}, "the column of field %q contains a NUL character", f.Label)
		case !f.Type.Valid():
			return Errorf("invalid_type", []string{"key", f.Key, "label", f.Label, "type", string(f.Type)}, "field %q has invalid type %q", f.Label, f.Type)
		case f.Syntax != "" && (f.Syntax != Standard || f.Column != ""):
			return Errorf("invalid_syntax", []string{"key", f.Key, "label", f.Label, "syntax", string(f.Syntax)}, "field %q has invalid syntax %q: only an expression has one, and it is standard or left out", f.Label, f.Syntax)
		}
		if err := checkRole(f); err != nil {
			return err
		}
		if err := checkFormat(f); err != nil {
			return err
		}
	}

	// References, now that every key is known.
	deps := map[string][]string{}
	for _, f := range s.Fields {
		names := refs(f.Expr)
		if f.Syntax == Standard {
			root, err := expr.Parse(f.Expr)
			if err != nil {
				return exprError(f, err)
			}
			names = expr.Refs(root)
		}
		for _, ref := range names {
			target, ok := s.FieldByKey(ref)
			if !ok {
				return Errorf("unknown_reference", []string{"key", f.Key, "label", f.Label, "ref", ref}, "field %q refers to %q, which is not a field", f.Label, ref)
			}
			if target.Role == Metric && f.Role != Metric {
				return Errorf("metric_reference", []string{"key", f.Key, "label", f.Label, "ref", target.Key, "refLabel", target.Label},
					"field %q is computed per row, so it cannot refer to the metric %q", f.Label, target.Label)
			}
			deps[f.Key] = append(deps[f.Key], ref)
		}
	}
	if cycle := findCycle(deps); cycle != "" {
		f, _ := s.FieldByKey(cycle)
		return Errorf("circular_reference", []string{"key", cycle, "label", f.Label}, "%q refers to itself through other fields", f.Label)
	}

	// What is written in the platform's language can be read here, without
	// asking the database: that it makes sense, and gives what the field says it holds.
	for _, f := range s.Fields {
		if f.Syntax != Standard {
			continue
		}
		checked, err := s.checkExpr(f)
		if err != nil {
			return err
		}
		if checked.Type != "" && checked.Type != f.Type && !(checked.Type.Numeric() && f.Type.Numeric()) {
			return Errorf("field_type_mismatch", []string{"key", f.Key, "label", f.Label, "declared", string(f.Type), "actual", string(checked.Type)},
				"field %q is declared as %s but its expression gives %s", f.Label, f.Type, checked.Type)
		}
	}

	return nil
}

var leadingKeyword = regexp.MustCompile(`(?i)^\s*(select|with)\b`)

func (s *Spec) validateSource() error {
	switch s.Source.Type {
	case "table":
		if s.Source.Table == "" {
			return Errorf("invalid_source", nil, "a table source needs a table name")
		}
	case "sql":
		// Deliberately shallow: the database account is what enforces read-only.
		// See .agents/design/dataset.md §3.
		sql := strings.TrimRight(strings.TrimSpace(s.Source.SQL), ";")
		if !leadingKeyword.MatchString(sql) {
			return Errorf("source_not_select", nil, "the source must be a single SELECT statement")
		}
		if strings.Contains(sql, ";") {
			return Errorf("source_multiple_statements", nil, "the source must be a single statement")
		}
	default:
		return Errorf("invalid_source", nil, "source type must be sql or table, got %q", s.Source.Type)
	}
	return nil
}

const maxLabelLength = 100

// ValidLabel reports whether s can be the name of a field. Braces are kept
// out because expressions refer to fields as ${name} where people write them.
func ValidLabel(s string) bool {
	n := utf8.RuneCountInString(s)
	return n >= 1 && n <= maxLabelLength && s == strings.TrimSpace(s) && !strings.ContainsAny(s, "{}\r\n")
}

// foldLabel is the form in which names are compared: two names that differ
// only in case are the same name.
func foldLabel(s string) string { return strings.ToLower(strings.TrimSpace(s)) }

// checkRole checks that a field can be what its role says.
func checkRole(f Field) error {
	pairs := []string{"key", f.Key, "label", f.Label}
	switch f.Role {
	case Dimension:
	case MeasureRole:
		if !f.Type.Numeric() {
			return Errorf("measure_not_numeric", append(pairs, "type", string(f.Type)), "field %q is %s, so it can only be a dimension", f.Label, f.Type)
		}
	case Metric:
		if f.Column != "" {
			return Errorf("metric_column", pairs, "field %q is a plain column, so it cannot be a metric", f.Label)
		}
	default:
		return Errorf("invalid_role", append(pairs, "role", string(f.Role)), "field %q has invalid role %q: use dimension, measure or metric", f.Label, f.Role)
	}
	return nil
}

// CheckAgg reports whether agg can be applied to field.
func CheckAgg(agg Agg, field Field) error {
	if (agg == Sum || agg == Avg) && !field.Type.Numeric() {
		return Errorf("agg_needs_number", []string{"agg", string(agg), "key", field.Key, "label", field.Label}, "%s needs a numeric field, but %q is %s", agg, field.Label, field.Type)
	}
	if (agg == Min || agg == Max) && field.Type == datasource.Boolean {
		return Errorf("agg_not_applicable", []string{"agg", string(agg), "key", field.Key, "label", field.Label}, "%s cannot be applied to boolean field %q", agg, field.Label)
	}
	return nil
}

// findCycle returns a key that is part of a reference cycle, or "".
func findCycle(deps map[string][]string) string {
	const visiting, done = 1, 2
	state := map[string]int{}
	var visit func(string) string
	visit = func(key string) string {
		switch state[key] {
		case visiting:
			return key
		case done:
			return ""
		}
		state[key] = visiting
		for _, dep := range deps[key] {
			if found := visit(dep); found != "" {
				return found
			}
		}
		state[key] = done
		return ""
	}
	for key := range deps {
		if found := visit(key); found != "" {
			return found
		}
	}
	return ""
}
