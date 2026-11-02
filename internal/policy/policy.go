// Package policy holds the data permissions of a dataset: which rows and
// fields a viewer may see. See .agents/design/access-control.md §5.
package policy

import (
	"slices"

	"github.com/supazd/supabi/internal/authz"
	"github.com/supazd/supabi/internal/dataset"
)

// What whoever no row rule covers sees of a dataset.
const (
	All     = "all"
	None    = "none"
	Visible = "visible"
	Hidden  = "hidden"
)

// Policy is the data permissions of one dataset. The zero value, with
// Unmatched set to All, restricts nobody.
type Policy struct {
	// Unmatched is what whoever no row rule covers sees: All or None.
	Unmatched string `json:"unmatched"`
	// ColumnMode controls whether each rule grants or hides fields from its subjects.
	ColumnMode string       `json:"columnMode"`
	Rows       []RowRule    `json:"rows"`
	Columns    []ColumnRule `json:"columns"`
}

// RowRule lets its subjects see the rows that pass its required Filter.
type RowRule struct {
	Name     string          `json:"name,omitempty"`
	Subjects []authz.Subject `json:"subjects"`
	Filter   *dataset.Filter `json:"filter"`
}

// ColumnRule names fields and applicable subjects. ColumnMode determines their visibility.
type ColumnRule struct {
	Name      string          `json:"name,omitempty"`
	Fields    []string        `json:"fields"`
	VisibleTo []authz.Subject `json:"visibleTo"`
}

// Open is the policy of a dataset nobody has restricted.
func Open() Policy {
	return Policy{Unmatched: All, ColumnMode: Visible, Rows: []RowRule{}, Columns: []ColumnRule{}}
}

// Enabled is derived from rules; an empty policy imposes no restrictions.
func (p *Policy) Enabled() bool { return len(p.Rows)+len(p.Columns) > 0 }

// Nothing is a filter no row passes.
var Nothing = dataset.Filter{Op: "false"}

// HasCondition rejects missing conditions and incomplete branches before they
// can grant access. Dataset-specific operator and value validation follows.
func HasCondition(f *dataset.Filter) bool {
	if f == nil {
		return false
	}
	if f.Logical() {
		if len(f.Args) == 0 || (f.Op == "not" && len(f.Args) != 1) || f.Field != "" || f.Value != nil {
			return false
		}
		for _, arg := range f.Args {
			if !HasCondition(&arg) {
				return false
			}
		}
		return true
	}
	if f.Field == "" || f.Op == "" || f.Op == "false" || len(f.Args) > 0 {
		return false
	}
	if f.Op == "is_null" || f.Op == "not_null" {
		return true
	}
	if f.Op == "in" || f.Op == "not_in" {
		if _, ok := AttributeRef(f.Value); ok {
			return f.Op == "in"
		}
		values, ok := f.Value.([]any)
		return ok && len(values) > 0
	}
	return f.Value != nil && f.Value != ""
}

// RowFilter returns the filter on the rows id may see, or nil when they may
// see every row. Someone covered by rules sees what any of those rules lets
// through, whatever Unmatched says. valid tells whether a rule's filter still
// fits the dataset; one that does not lets its subjects see nothing, so a
// rule broken by a change to the dataset never shows more than it should.
func (p *Policy) RowFilter(id authz.Identity, valid func(dataset.Filter) bool) *dataset.Filter {
	if !p.Enabled() {
		return nil
	}
	var allowed []dataset.Filter
	covered := false
	for _, rule := range p.Rows {
		if !id.CoversAny(rule.Subjects) {
			continue
		}
		covered = true
		if !HasCondition(rule.Filter) || !valid(*rule.Filter) {
			continue
		}
		resolved, ok := ResolveFilter(*rule.Filter, id.Attributes)
		if ok && valid(resolved) {
			allowed = append(allowed, resolved)
		}
	}
	switch {
	case !covered && p.Unmatched == None:
		return &Nothing
	case !covered:
		return nil
	case len(allowed) == 0:
		return &Nothing
	case len(allowed) == 1:
		return &allowed[0]
	}
	return &dataset.Filter{Op: "or", Args: allowed}
}

// HiddenFields returns the keys of the fields id may not see: restricted
// fields no column rule grants them, and every calculated field that refers to one,
// however indirectly, since its values would give the hidden ones away.
func (p *Policy) HiddenFields(id authz.Identity, spec *dataset.Spec) map[string]bool {
	hidden := map[string]bool{}
	visible := map[string]bool{}
	for _, rule := range p.Columns {
		allowed := id.CoversAny(rule.VisibleTo)
		if p.ColumnMode == Hidden {
			allowed = !allowed
		}
		for _, key := range rule.Fields {
			hidden[key] = true
			visible[key] = visible[key] || allowed
		}
	}
	// Any rule may grant a field. Resolve this union before propagating
	// restrictions through expressions; an allowed expression still cannot
	// reveal a hidden dependency.
	for key, allowed := range visible {
		if allowed {
			delete(hidden, key)
		}
	}
	if len(hidden) == 0 {
		return nil
	}
	for changed := true; changed; {
		changed = false
		for _, f := range spec.Fields {
			if !hidden[f.Key] && slices.ContainsFunc(f.Refs(), func(key string) bool { return hidden[key] }) {
				hidden[f.Key] = true
				changed = true
			}
		}
	}
	return hidden
}

// Fields returns the keys of the fields the policy names, so they are not
// deleted from under it.
func (p *Policy) Fields() []string {
	var out []string
	add := func(key string) {
		if key != "" && !slices.Contains(out, key) {
			out = append(out, key)
		}
	}
	var walk func(f dataset.Filter)
	walk = func(f dataset.Filter) {
		add(f.Field)
		for _, arg := range f.Args {
			walk(arg)
		}
	}
	for _, rule := range p.Rows {
		if rule.Filter != nil {
			walk(*rule.Filter)
		}
	}
	for _, rule := range p.Columns {
		for _, key := range rule.Fields {
			add(key)
		}
	}
	return out
}
