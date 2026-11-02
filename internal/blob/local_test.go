package blob

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSweepToleratesAConcurrentSweep(t *testing.T) {
	files := NewLocal(t.TempDir())
	old := time.Now().Add(-2 * time.Hour)
	write := func(key string, modified time.Time) string {
		t.Helper()
		path, err := files.path(key)
		if err != nil {
			t.Fatal(err)
		}
		if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(path, []byte("x"), 0600); err != nil {
			t.Fatal(err)
		}
		if err = os.Chtimes(path, modified, modified); err != nil {
			t.Fatal(err)
		}
		return path
	}
	// Orphans share a directory, so the walk lists them all before the other
	// sweep removes them.
	var orphans []string
	for _, name := range []string{"a.csv", "b.csv", "c.csv.part"} {
		orphans = append(orphans, write("org/ws/exp_1/run_1/"+name, old))
	}
	kept := []string{
		write("org/ws/exp_2/run_2/result.csv", old),        // kept
		write("org/ws/exp_3/run_3/result.csv.part", old),   // kept
		write("org/ws/exp_4/run_4/result.csv", time.Now()), // within the grace period
	}
	keep := func(key string) bool {
		return key == "org/ws/exp_2/run_2/result.csv" || filepath.Dir(key) == "org/ws/exp_3/run_3"
	}

	defer func(original func(string) error) { removeFile = original }(removeFile)
	var raced bool
	removeFile = func(path string) error {
		if !raced {
			raced = true
			for _, orphan := range orphans {
				_ = os.Remove(orphan)
			}
		}
		return os.Remove(path)
	}
	if err := files.Sweep(context.Background(), "org", time.Now().Add(-time.Hour), keep); err != nil {
		t.Fatalf("a file the other sweep removed failed this one: %v", err)
	}
	for _, path := range orphans {
		if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("orphan %s remains", path)
		}
	}
	for _, path := range kept {
		if _, err := os.Stat(path); err != nil {
			t.Errorf("%s was removed: %v", path, err)
		}
	}
}
