package authz

import "testing"

func TestCovers(t *testing.T) {
	id := Identity{UserID: "u1", GroupIDs: []string{"g1", "g2"}}
	cases := []struct {
		subject Subject
		want    bool
	}{
		{Subject{Everyone: true}, true},
		{Subject{UserID: "u1"}, true},
		{Subject{UserID: "u2"}, false},
		{Subject{GroupID: "g2"}, true},
		{Subject{GroupID: "g3"}, false},
		{Subject{}, false},
	}
	for _, c := range cases {
		if got := id.Covers(c.subject); got != c.want {
			t.Errorf("Covers(%+v) = %v, want %v", c.subject, got, c.want)
		}
	}
	if !(Subject{GroupID: "g"}).Valid() || (Subject{}).Valid() || (Subject{UserID: "u", Everyone: true}).Valid() {
		t.Error("a subject is valid when exactly one of its fields is set")
	}
}
