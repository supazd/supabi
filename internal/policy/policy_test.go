package policy

import (
	"encoding/json"
	"maps"
	"slices"
	"testing"

	"github.com/supazd/supabi/internal/authz"
	"github.com/supazd/supabi/internal/dataset"
)

func TestRowFilter(t *testing.T) {
	east := dataset.Filter{Field: "region", Op: "eq", Value: "华东"}
	south := dataset.Filter{Field: "region", Op: "eq", Value: "华南"}
	broken := dataset.Filter{Field: "gone", Op: "eq", Value: "x"}
	p := Policy{Unmatched: All, Rows: []RowRule{
		{Subjects: []authz.Subject{{GroupID: "east"}}, Filter: &east},
		{Subjects: []authz.Subject{{GroupID: "south"}, {UserID: "zhao"}}, Filter: &south},
		{Subjects: []authz.Subject{{GroupID: "hq"}}},
		{Subjects: []authz.Subject{{GroupID: "stale"}}, Filter: &broken},
	}}
	valid := func(f dataset.Filter) bool { return f.Field != "gone" }
	show := func(f *dataset.Filter) string {
		if f == nil {
			return "all"
		}
		b, _ := json.Marshal(f)
		return string(b)
	}
	cases := []struct {
		name      string
		id        authz.Identity
		unmatched string
		want      string
	}{
		{"covered by one rule", authz.Identity{UserID: "li", GroupIDs: []string{"east"}}, All, `{"op":"eq","field":"region","value":"华东"}`},
		{"covered by two rules sees either", authz.Identity{UserID: "zhao", GroupIDs: []string{"east"}}, All, `{"op":"or","args":[{"op":"eq","field":"region","value":"华东"},{"op":"eq","field":"region","value":"华南"}]}`},
		{"a group with no rule does not lift a rule", authz.Identity{UserID: "li", GroupIDs: []string{"east", "sales"}}, All, `{"op":"eq","field":"region","value":"华东"}`},
		{"a missing condition cannot lift another rule", authz.Identity{UserID: "li", GroupIDs: []string{"east", "hq"}}, All, `{"op":"eq","field":"region","value":"华东"}`},
		{"a missing condition grants nothing", authz.Identity{GroupIDs: []string{"hq"}}, All, `{"op":"false"}`},
		{"uncovered sees all", authz.Identity{UserID: "wang", GroupIDs: []string{"sales"}}, All, "all"},
		{"uncovered sees none", authz.Identity{UserID: "wang"}, None, `{"op":"false"}`},
		{"a broken rule shows nothing", authz.Identity{UserID: "qian", GroupIDs: []string{"stale"}}, All, `{"op":"false"}`},
		{"a broken rule beside a good one", authz.Identity{UserID: "qian", GroupIDs: []string{"stale", "east"}}, All, `{"op":"eq","field":"region","value":"华东"}`},
	}
	for _, c := range cases {
		p.Unmatched = c.unmatched
		if got := show(p.RowFilter(c.id, valid)); got != c.want {
			t.Errorf("%s: got %s, want %s", c.name, got, c.want)
		}
	}
	nested := dataset.Filter{Op: "and", Args: []dataset.Filter{east, {Field: "store", Op: "in", Value: []any{"A01"}}}}
	p.Rows = append(p.Rows, RowRule{Filter: &nested})
	p.Columns = []ColumnRule{{Fields: []string{"cost", "region"}}}
	if got, _ := json.Marshal(p.Fields()); string(got) != `["region","gone","store","cost"]` {
		t.Errorf("Fields = %s", got)
	}
}

func TestHiddenFields(t *testing.T) {
	spec := &dataset.Spec{Fields: []dataset.Field{
		{Key: "cost", Column: "cost"},
		{Key: "price", Column: "price"},
		{Key: "margin", Expr: "${price} - ${cost}"},
		{Key: "margin_rate", Expr: "${margin} / ${price}"},
		{Key: "region", Column: "region"},
	}}
	p := Policy{Unmatched: All, Columns: []ColumnRule{{Fields: []string{"cost"}, VisibleTo: []authz.Subject{{GroupID: "finance"}}}}}
	hidden := p.HiddenFields(authz.Identity{UserID: "li", GroupIDs: []string{"sales"}}, spec)
	if len(hidden) != 3 || !hidden["cost"] || !hidden["margin"] || !hidden["margin_rate"] {
		t.Errorf("hidden from sales = %v", hidden)
	}
	if hidden := p.HiddenFields(authz.Identity{UserID: "zhou", GroupIDs: []string{"finance"}}, spec); len(hidden) != 0 {
		t.Errorf("hidden from finance = %v", hidden)
	}
}

func TestColumnRulesUnion(t *testing.T) {
	spec := &dataset.Spec{Fields: []dataset.Field{
		{Key: "cost", Column: "cost"},
		{Key: "price", Column: "price"},
		{Key: "margin", Expr: "${price} - ${cost}"},
		{Key: "margin_rate", Expr: "${margin} / ${price}"},
		{Key: "secret", Column: "secret"},
	}}
	rules := []ColumnRule{
		{Fields: []string{"cost"}, VisibleTo: []authz.Subject{{GroupID: "finance"}}},
		{Fields: []string{"cost"}, VisibleTo: []authz.Subject{{GroupID: "management"}, {UserID: "li"}}},
		{Fields: []string{"cost"}}, // An empty grant cannot revoke another rule's grant.
		{Fields: []string{"margin"}, VisibleTo: []authz.Subject{{Everyone: true}}},
		{Fields: []string{"secret"}},
	}
	for _, reversed := range []bool{false, true} {
		columns := slices.Clone(rules)
		if reversed {
			slices.Reverse(columns)
		}
		p := Policy{Columns: columns}
		for _, id := range []authz.Identity{
			{GroupIDs: []string{"finance"}},
			{GroupIDs: []string{"management"}},
			{GroupIDs: []string{"finance", "management"}},
			{UserID: "li"},
		} {
			if got, want := p.HiddenFields(id, spec), map[string]bool{"secret": true}; !maps.Equal(got, want) {
				t.Errorf("identity %+v, reversed %v: hidden = %v, want %v", id, reversed, got, want)
			}
		}
		// A direct grant on margin must not expose its hidden dependency, even
		// after combining column grants. Ungoverned price remains visible.
		if got, want := p.HiddenFields(authz.Identity{GroupIDs: []string{"sales"}}, spec), map[string]bool{
			"cost": true, "margin": true, "margin_rate": true, "secret": true,
		}; !maps.Equal(got, want) {
			t.Errorf("unmatched identity, reversed %v: hidden = %v, want %v", reversed, got, want)
		}
		p.Columns = append(p.Columns, ColumnRule{Fields: []string{"cost"}, VisibleTo: []authz.Subject{{Everyone: true}}})
		if got, want := p.HiddenFields(authz.Identity{}, spec), map[string]bool{"secret": true}; !maps.Equal(got, want) {
			t.Errorf("everyone grant: hidden = %v, want %v", got, want)
		}
	}
}

func TestEmptyPolicyIsDisabled(t *testing.T) {
	p := Policy{Unmatched: None, ColumnMode: Hidden}
	if p.Enabled() || p.RowFilter(authz.Identity{}, func(dataset.Filter) bool { return true }) != nil || len(p.HiddenFields(authz.Identity{}, &dataset.Spec{})) != 0 {
		t.Fatal("an empty policy must not restrict data, even with a retained restrictive scope")
	}
}

func TestHiddenColumnScope(t *testing.T) {
	spec := &dataset.Spec{Fields: []dataset.Field{{Key: "cost", Column: "cost"}, {Key: "margin", Expr: "${cost} * 2"}}}
	p := Policy{ColumnMode: Hidden, Columns: []ColumnRule{{Fields: []string{"cost"}, VisibleTo: []authz.Subject{{GroupID: "sales"}}}}}
	if got := p.HiddenFields(authz.Identity{GroupIDs: []string{"sales"}}, spec); !maps.Equal(got, map[string]bool{"cost": true, "margin": true}) {
		t.Fatalf("applicable member: %v", got)
	}
	if got := p.HiddenFields(authz.Identity{GroupIDs: []string{"finance"}}, spec); len(got) != 0 {
		t.Fatalf("outside member: %v", got)
	}
	// As in visible mode, combine each rule's visible results before propagating dependencies.
	p.Columns = append(p.Columns, ColumnRule{Fields: []string{"cost"}, VisibleTo: []authz.Subject{{GroupID: "finance"}}})
	if got := p.HiddenFields(authz.Identity{GroupIDs: []string{"sales"}}, spec); len(got) != 0 {
		t.Fatalf("union: %v", got)
	}
	if got := p.HiddenFields(authz.Identity{GroupIDs: []string{"sales", "finance"}}, spec); len(got) != 2 {
		t.Fatalf("hidden by all rules: %v", got)
	}
}

func TestIncompleteConditionsNeverGrantRows(t *testing.T) {
	east := dataset.Filter{Field: "region", Op: "eq", Value: "华东"}
	for _, condition := range []*dataset.Filter{
		nil, {},
		{Op: "and"},
		{Op: "or", Args: []dataset.Filter{east, {}}},
		{Field: "region", Op: "in", Value: []any{}},
		{Field: "region", Op: "not_in", Value: []any{}},
		{Op: "not", Args: []dataset.Filter{{Op: "false"}}},
		{Field: "region", Op: "eq"},
	} {
		p := Policy{Unmatched: All, Rows: []RowRule{{Subjects: []authz.Subject{{Everyone: true}}, Filter: condition}}}
		valid := func(dataset.Filter) bool { return true }
		if got := p.RowFilter(authz.Identity{}, valid); got == nil || got.Op != "false" {
			t.Errorf("incomplete condition %+v granted rows: %+v", condition, got)
		}
		p.Rows = append(p.Rows, RowRule{Subjects: []authz.Subject{{Everyone: true}}, Filter: &east})
		if got := p.RowFilter(authz.Identity{}, valid); got == nil || got.Field != "region" || got.Value != "华东" {
			t.Errorf("incomplete condition %+v lifted the other rule: %+v", condition, got)
		}
	}
}
