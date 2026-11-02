package policy

import (
	"encoding/json"
	"github.com/supazd/supabi/internal/authz"
	"github.com/supazd/supabi/internal/dataset"
	"reflect"
	"testing"
)

func TestDynamicRowFilters(t *testing.T) {
	dynamic := dataset.Filter{Field: "region", Op: "in", Value: map[string]any{"userAttr": "regions"}}
	fixed := dataset.Filter{Field: "owner", Op: "eq", Value: "shared"}
	id := authz.Identity{UserID: "u", Attributes: map[string][]string{"regions": {"East", "South"}}}
	p := Policy{Unmatched: All, Rows: []RowRule{{Subjects: []authz.Subject{{Everyone: true}}, Filter: &dynamic}}}
	before, _ := json.Marshal(p)
	got := p.RowFilter(id, func(dataset.Filter) bool { return true })
	if !reflect.DeepEqual(got.Value, []any{"East", "South"}) {
		t.Fatalf("resolved = %#v", got)
	}
	after, _ := json.Marshal(p)
	if string(before) != string(after) {
		t.Fatal("resolution mutated stored policy")
	}
	for _, attrs := range []map[string][]string{nil, {"regions": {}}, {"other": {"East"}}} {
		id.Attributes = attrs
		if got := p.RowFilter(id, func(dataset.Filter) bool { return true }); got.Op != "false" {
			t.Fatalf("missing attribute grants access: %#v", got)
		}
	}
	// Absence cannot become an unrestricted rule, even beneath NOT or OR.
	for _, op := range []string{"and", "or", "not"} {
		nested := dataset.Filter{Op: op, Args: []dataset.Filter{dynamic, fixed}}
		if _, ok := ResolveFilter(nested, nil); ok {
			t.Fatalf("%s accepted missing attribute", op)
		}
	}
	p.Rows = append(p.Rows, RowRule{Subjects: []authz.Subject{{Everyone: true}}, Filter: &fixed})
	if got := p.RowFilter(id, func(dataset.Filter) bool { return true }); got.Field != "owner" {
		t.Fatalf("independent grant lost: %#v", got)
	}
	id.Attributes = map[string][]string{"regions": {"*", "x' OR 1=1 --"}}
	resolved, ok := ResolveFilter(dynamic, id.Attributes)
	if !ok || !reflect.DeepEqual(resolved.Value, []any{"*", "x' OR 1=1 --"}) {
		t.Fatalf("values must stay literal: %#v", got)
	}
}

func TestDynamicFilterValidation(t *testing.T) {
	for _, op := range []string{"eq", "not_in", "contains", "not"} {
		f := dataset.Filter{Field: "region", Op: op, Value: map[string]any{"userAttr": "regions"}}
		if _, ok := CheckAttributes(f, func(string, string) bool { return true }); ok {
			t.Fatalf("accepted %s", op)
		}
	}
	f := dataset.Filter{Field: "region", Op: "in", Value: map[string]any{"userAttr": "regions"}}
	if _, ok := CheckAttributes(f, func(string, string) bool { return false }); ok {
		t.Fatal("unknown attribute accepted")
	}
}

func TestMalformedAttributeFailsClosed(t *testing.T) {
	for _, value := range []any{map[string]any{"userAttr": ""}, map[string]any{"userAttr": 42}, map[string]any{"userAttr": "regions", "extra": true}} {
		f := dataset.Filter{Field: "region", Op: "not_null", Value: value}
		if _, ok := CheckAttributes(f, func(string, string) bool { return true }); ok {
			t.Fatal("accepted malformed reference")
		}
		if _, ok := ResolveFilter(f, nil); ok {
			t.Fatal("resolved malformed reference")
		}
	}
}
