package id

import (
	"regexp"
	"testing"
)

func TestNew(t *testing.T) {
	re := regexp.MustCompile(`^ds_[0-9a-hjkmnp-tv-z]{20}$`)
	seen := map[string]bool{}
	for range 1000 {
		got := New("ds")
		if !re.MatchString(got) {
			t.Fatalf("New() = %q, want match %s", got, re)
		}
		if seen[got] {
			t.Fatalf("duplicate ID %q", got)
		}
		seen[got] = true
	}
}
