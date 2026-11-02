package query

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/dialect"
)

func TestCategoryCalendarBounds(t *testing.T) {
	for _, tt := range []struct {
		name, value      string
		grain            dialect.Grain
		source, target   datasource.Type
		zone, targetZone string
		week             int
		start, end       string
	}{
		{"leap month", "2024-02-01", dialect.Month, datasource.Date, datasource.Date, "UTC", "UTC", 1, "2024-02-01", "2024-03-01"},
		{"sunday week across year", "2026-01-01", dialect.Week, datasource.Date, datasource.Date, "UTC", "UTC", 7, "2025-12-28", "2026-01-04"},
		{"DST day", "2026-03-08T00:00:00", dialect.Day, datasource.Timestamp, datasource.Timestamp, "America/Los_Angeles", "UTC", 1, "2026-03-08T08:00:00Z", "2026-03-09T07:00:00Z"},
		{"DST week", "2026-03-08T00:00:00", dialect.Week, datasource.Timestamp, datasource.Timestamp, "America/Los_Angeles", "UTC", 7, "2026-03-08T08:00:00Z", "2026-03-15T07:00:00Z"},
		{"calendar skipped day", "2011-12-30", "", datasource.Date, datasource.Date, "Pacific/Apia", "UTC", 1, "2011-12-30", "2011-12-31"},
		{"date to timestamp", "2026-02-01", dialect.Month, datasource.Date, datasource.Timestamp, "Asia/Shanghai", "America/Los_Angeles", 1, "2026-02-01T00:00:00", "2026-03-01T00:00:00"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			got, err := CategoryTimeRange(tt.value, tt.grain, tt.source, tt.target, tt.zone, tt.targetZone, tt.week)
			if err != nil {
				t.Fatal(err)
			}
			if got.Bounds.Start.Fixed != tt.start || got.Bounds.End.Fixed != tt.end {
				t.Fatalf("%+v, %+v", got.Bounds.Start, got.Bounds.End)
			}
		})
	}
	for _, value := range []string{"bad", "2026-02-30", "9999-12-01"} {
		if _, err := CategoryTimeRange(value, dialect.Month, datasource.Date, datasource.Date, "UTC", "UTC", 1); err == nil {
			t.Fatalf("accepted %s", value)
		}
	}
}

// Local wall-clock strings cannot distinguish the two occurrences of 01:00
// during rollback. Check actual instants through serialization and SQL binding.
func TestCategoryTimestampBoundsPreserveInstants(t *testing.T) {
	for _, tt := range []struct {
		name, value string
		grain       dialect.Grain
		start, end  string
	}{
		{"first repeated hour", "2026-11-01T08:00:00", dialect.Hour, "2026-11-01T08:00:00Z", "2026-11-01T09:00:00Z"},
		{"second repeated hour", "2026-11-01T09:00:00", dialect.Hour, "2026-11-01T09:00:00Z", "2026-11-01T10:00:00Z"},
		{"minute across rollback", "2026-11-01T08:59:00", dialect.Minute, "2026-11-01T08:59:00Z", "2026-11-01T09:00:00Z"},
		{"fractional second across rollback", "2026-11-01T08:59:59.123456789", "", "2026-11-01T08:59:59.123456789Z", "2026-11-01T09:00:00.123456789Z"},
		{"spring forward", "2026-03-08T09:00:00", dialect.Hour, "2026-03-08T09:00:00Z", "2026-03-08T10:00:00Z"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			const targetZone = "America/Los_Angeles"
			tr, err := CategoryTimeRange(tt.value, tt.grain, datasource.Timestamp, datasource.Timestamp, "UTC", targetZone, 1)
			if err != nil {
				t.Fatal(err)
			}
			raw, err := json.Marshal(tr)
			if err != nil {
				t.Fatal(err)
			}
			var restored TimeRange
			if err := json.Unmarshal(raw, &restored); err != nil {
				t.Fatal(err)
			}
			if err := ValidateTimeRange(&restored); err != nil {
				t.Fatalf("validate %s: %v", raw, err)
			}
			start, end, err := ResolveTimeRange(&restored, time.Time{}, targetZone, 1)
			if err != nil {
				t.Fatalf("resolve %s: %v", raw, err)
			}
			for i, at := range []time.Time{start, end} {
				want := []string{tt.start, tt.end}[i]
				if got := at.UTC().Format(time.RFC3339Nano); got != want {
					t.Fatalf("bound %d: got %s, want %s", i, got, want)
				}
				if at.Location().String() != targetZone {
					t.Fatalf("bound must retain query calendar location: %v", at)
				}
			}
			q := parse(t, `{"version":1,"dataset":"d","timezone":"America/Los_Angeles","dimensions":[{"field":"created"}],"filter":{"field":"created","op":"time","value":`+string(raw)+`}}`)
			compiled, err := Compile(q, extensionDataset(), options())
			if err != nil {
				t.Fatal(err)
			}
			if len(compiled.Args) != 2 {
				t.Fatalf("unexpected bounds: %#v", compiled.Args)
			}
			for i, arg := range compiled.Args {
				at, ok := arg.(time.Time)
				if !ok || at.UTC().Format(time.RFC3339Nano) != []string{tt.start, tt.end}[i] {
					t.Fatalf("SQL bound %d: %#v", i, arg)
				}
			}
		})
	}
}
