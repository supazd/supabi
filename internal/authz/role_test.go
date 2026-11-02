package authz

import "testing"

func TestAtLeast(t *testing.T) {
	cases := []struct {
		role, min Role
		want      bool
	}{
		{Viewer, Viewer, true},
		{Viewer, Developer, false},
		{Developer, Viewer, true},
		{Developer, Admin, false},
		{Admin, Developer, true},
		{"", Viewer, false},
		{"owner", Viewer, false},
	}
	for _, c := range cases {
		if got := c.role.AtLeast(c.min); got != c.want {
			t.Errorf("%q.AtLeast(%q) = %v, want %v", c.role, c.min, got, c.want)
		}
	}
}

func TestHighest(t *testing.T) {
	if got := Highest([]Role{Viewer, Admin, Developer}); got != Admin {
		t.Errorf("Highest = %q, want admin", got)
	}
	if got := Highest([]Role{"owner", Viewer}); got != Viewer {
		t.Errorf("an unknown role must be ignored, got %q", got)
	}
	if got := Highest(nil); got != "" {
		t.Errorf("Highest of nothing = %q", got)
	}
}
