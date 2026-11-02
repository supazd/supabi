package policy

import "github.com/supazd/supabi/internal/dataset"

// AttributeRef distinguishes dynamic values from literal filter values.
func AttributeRef(value any) (string, bool) {
	obj, ok := value.(map[string]any)
	if !ok {
		return "", false
	}
	key, ok := obj["userAttr"].(string)
	return key, ok && key != "" && len(obj) == 1
}

// ResolveFilter copies a filter before substituting values. Missing attributes
// invalidate the whole rule, including beneath NOT/OR, so absence cannot grant
// access. Attributes only support positive membership tests on text fields.
func ResolveFilter(f dataset.Filter, attrs map[string][]string) (dataset.Filter, bool) {
	if malformedAttribute(f.Value) {
		return Nothing, false
	}
	if key, ok := AttributeRef(f.Value); ok {
		values := attrs[key]
		if f.Op != "in" || len(values) == 0 || len(f.Args) > 0 {
			return Nothing, false
		}
		literals := make([]any, len(values))
		for i, value := range values {
			literals[i] = value
		}
		f.Value = literals
	}
	args := make([]dataset.Filter, len(f.Args))
	for i, arg := range f.Args {
		resolved, ok := ResolveFilter(arg, attrs)
		if !ok {
			return Nothing, false
		}
		args[i] = resolved
	}
	f.Args = args
	return f, true
}

// CheckAttributes validates references and builds a representative literal
// filter for the query compiler without depending on any user's assignment.
func CheckAttributes(f dataset.Filter, allowed func(field, key string) bool) (dataset.Filter, bool) {
	if malformedAttribute(f.Value) {
		return Nothing, false
	}
	if key, ok := AttributeRef(f.Value); ok {
		if f.Op != "in" || len(f.Args) > 0 || !allowed(f.Field, key) {
			return Nothing, false
		}
		f.Value = []any{"attribute-value"}
	}
	args := make([]dataset.Filter, len(f.Args))
	for i, arg := range f.Args {
		checked, ok := CheckAttributes(arg, allowed)
		if !ok {
			return Nothing, false
		}
		args[i] = checked
	}
	f.Args = args
	return f, true
}

// Never let an operator that ignores its value swallow a broken reference.
func malformedAttribute(value any) bool {
	obj, ok := value.(map[string]any)
	if !ok {
		return false
	}
	if _, present := obj["userAttr"]; !present {
		return false
	}
	_, valid := AttributeRef(value)
	return !valid
}
