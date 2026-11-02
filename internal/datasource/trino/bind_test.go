package trino

import (
	"strings"
	"testing"
	"time"
)

func TestBind(t *testing.T) {
	query := "SELECT ? AS a, '?' AS b WHERE x = ? AND y = ?"
	at := time.Date(2026, 3, 8, 10, 0, 0, 0, time.FixedZone("", 8*3600))
	sent, written, err := bind(query, []any{"it's", int64(7), at})
	if err != nil {
		t.Fatal(err)
	}
	if want := "SELECT 'it''s' AS a, '?' AS b WHERE x = 7 AND y = TIMESTAMP '2026-03-08 10:00:00 +08:00'"; sent != want {
		t.Errorf("sent %s\nwant %s", sent, want)
	}
	// Positions in what was sent are found in what was given.
	for _, word := range []string{"SELECT", "AS a", "AS b", "x =", "AND y"} {
		if got, want := unbind(strings.Index(sent, word)+1, written), strings.Index(query, word)+1; got != want {
			t.Errorf("%q: position %d, want %d", word, got, want)
		}
	}
	// Inside a value is where its marker was.
	if got, want := unbind(strings.Index(sent, "2026")+1, written), strings.LastIndex(query, "?")+1; got != want {
		t.Errorf("inside a value: position %d, want %d", got, want)
	}

	if _, _, err := bind("SELECT ?", nil); err != nil {
		t.Errorf("without arguments the statement is sent as it is: %v", err)
	}
	if _, _, err := bind("SELECT '?'", []any{1}); err == nil {
		t.Error("an argument without a marker is an error")
	}
}

func TestPosition(t *testing.T) {
	sent := "SELECT '华东',\n  amount FORM t"
	if got, want := position(sent, 2, 10), strings.Index(sent, "FORM")+1; got != want {
		t.Errorf("position %d, want %d", got, want)
	}
	if got, want := position(sent, 1, 9), strings.Index(sent, "华")+1; got != want {
		t.Errorf("position %d, want %d", got, want)
	}
	// Just past the end, where something is missing.
	if got, want := position(sent, 2, 16), len(sent)+1; got != want {
		t.Errorf("position %d, want %d", got, want)
	}
	if got := position(sent, 3, 1); got != 0 {
		t.Errorf("a line that is not there: position %d", got)
	}
}

func TestMajorVersion(t *testing.T) {
	for version, want := range map[string]int{"483": 483, "413-e.12": 413, "476-SNAPSHOT": 476} {
		if got, ok := majorVersion(version); !ok || got != want {
			t.Errorf("%s: %d, %v; want %d", version, got, ok, want)
		}
	}
	if _, ok := majorVersion("unknown"); ok {
		t.Error("a version without a number was read")
	}
}
