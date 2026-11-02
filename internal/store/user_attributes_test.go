package store

import (
	"github.com/supazd/supabi/internal/authz"
	"reflect"
	"testing"
)

func TestAttributeValues(t *testing.T) {
	id := authz.Identity{UserID: "u", GroupIDs: []string{"g1", "g2"}}
	attrs := []UserAttribute{{Key: "region", Assignments: []AttributeAssignment{
		{Subject: authz.Subject{GroupID: "g1"}, Values: []string{"East"}},
		{Subject: authz.Subject{GroupID: "g2"}, Values: []string{"South"}},
		{Subject: authz.Subject{GroupID: "other"}, Values: []string{"Secret"}},
	}}}
	if got := AttributeValues(attrs, id)["region"]; !reflect.DeepEqual(got, []string{"East", "South"}) {
		t.Fatalf("inherited = %v", got)
	}
	attrs[0].Assignments = append(attrs[0].Assignments, AttributeAssignment{Subject: authz.Subject{UserID: "u"}, Values: []string{"West"}})
	if got := AttributeValues(attrs, id)["region"]; !reflect.DeepEqual(got, []string{"West"}) {
		t.Fatalf("override = %v", got)
	}
	attrs[0].Assignments[3].Values = []string{}
	if got := AttributeValues(attrs, id)["region"]; len(got) != 0 {
		t.Fatalf("empty override inherited %v", got)
	}
}
