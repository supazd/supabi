package query

import (
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/supazd/supabi/internal/dialect"
)

func TestDateRangesKeepCalendarDatesAcrossMidnightTransitions(t *testing.T) {
	for _, tt := range []struct {
		name, zone, value string
		now               time.Time
		want              []any
	}{
		{"fixed midnight skipped", "America/Sao_Paulo", `{"bounds":{"start":{"fixed":"2018-11-04"},"end":{"fixed":"2018-11-05"}}}`, time.Time{}, []any{"2018-11-04", "2018-11-05"}},
		{"legacy midnight skipped", "America/Sao_Paulo", `{"start":"2018-11-04","end":"2018-11-05"}`, time.Time{}, []any{"2018-11-04", "2018-11-05"}},
		{"relative midnight skipped", "America/Sao_Paulo", `{"bounds":{"start":{"relative":{"n":0,"unit":"day"}},"end":{"relative":{"n":1,"unit":"day"}}}}`, time.Date(2018, 11, 4, 15, 0, 0, 0, time.UTC), []any{"2018-11-04", "2018-11-05"}},
		{"current calendar day", "America/Sao_Paulo", `{"current":"day"}`, time.Date(2018, 11, 4, 15, 0, 0, 0, time.UTC), []any{"2018-11-04", "2018-11-05"}},
		{"last includes current calendar day", "America/Sao_Paulo", `{"last":{"n":2,"unit":"day"},"includeCurrent":true}`, time.Date(2018, 11, 4, 15, 0, 0, 0, time.UTC), []any{"2018-11-03", "2018-11-05"}},
		{"current date uses query timezone", "America/Sao_Paulo", `{"current":"day"}`, time.Date(2018, 11, 4, 0, 30, 0, 0, time.UTC), []any{"2018-11-03", "2018-11-04"}},
		{"whole wall day skipped", "Pacific/Apia", `{"bounds":{"start":{"fixed":"2011-12-30"},"end":{"fixed":"2011-12-31"}}}`, time.Time{}, []any{"2011-12-30", "2011-12-31"}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			q := parse(t, `{"version":1,"dataset":"d","dimensions":[{"field":"day"}],"filter":{"field":"day","op":"time","value":`+tt.value+`}}`)
			opt := options()
			opt.Timezone, opt.Now = tt.zone, tt.now
			compiled, err := Compile(q, extensionDataset(), opt)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(compiled.Args, tt.want) {
				t.Fatalf("calendar dates changed: got %v want %v", compiled.Args, tt.want)
			}
		})
	}
}

func TestIndependentTimeBounds(t *testing.T) {
	loc, err := time.LoadLocation("America/Los_Angeles")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 3, 8, 12, 0, 0, 0, time.UTC)
	for _, tt := range []struct {
		name       string
		rangeValue TimeRange
		start, end string
	}{
		{
			name: "relative across spring DST transition",
			rangeValue: TimeRange{Bounds: &TimeBounds{
				Start: &TimeBound{Relative: &Duration{N: 0, Unit: dialect.Day}},
				End:   &TimeBound{Relative: &Duration{N: 1, Unit: dialect.Day}},
			}},
			start: "2026-03-08T00:00:00-08:00", end: "2026-03-09T00:00:00-07:00",
		},
		{
			name: "fixed start relative end",
			rangeValue: TimeRange{Bounds: &TimeBounds{
				Start: &TimeBound{Fixed: "2026-02-01"},
				End:   &TimeBound{Relative: &Duration{N: 0, Unit: dialect.Month}},
			}},
			start: "2026-02-01T00:00:00-08:00", end: "2026-03-01T00:00:00-08:00",
		},
		{
			name:       "unlimited start",
			rangeValue: TimeRange{Bounds: &TimeBounds{End: &TimeBound{Fixed: "2026-03-08T04:30:00"}}},
			end:        "2026-03-08T04:30:00-07:00",
		},
		{
			name:       "unlimited end",
			rangeValue: TimeRange{Bounds: &TimeBounds{Start: &TimeBound{Relative: &Duration{N: -1, Unit: dialect.Year}}}},
			start:      "2025-01-01T00:00:00-08:00",
		},
		{name: "unlimited", rangeValue: TimeRange{Bounds: &TimeBounds{}}},
		{
			name:       "legacy explicit range",
			rangeValue: TimeRange{Start: "2026-02-01", End: "2026-03-01"},
			start:      "2026-02-01T00:00:00-08:00", end: "2026-03-01T00:00:00-08:00",
		},
		{
			name:       "legacy last",
			rangeValue: TimeRange{Last: &Duration{N: 1, Unit: dialect.Day}},
			start:      "2026-03-07T00:00:00-08:00", end: "2026-03-08T00:00:00-08:00",
		},
		{
			name:       "legacy include current",
			rangeValue: TimeRange{Last: &Duration{N: 1, Unit: dialect.Day}, IncludeCurrent: true},
			start:      "2026-03-08T00:00:00-08:00", end: "2026-03-09T00:00:00-07:00",
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			start, end, err := resolveTimeRange(&tt.rangeValue, now, loc, dialect.Monday)
			if err != nil {
				t.Fatal(err)
			}
			format := func(value time.Time) string {
				if value.IsZero() {
					return ""
				}
				return value.Format(time.RFC3339)
			}
			if format(start) != tt.start || format(end) != tt.end {
				t.Fatalf("got [%s,%s), want [%s,%s)", format(start), format(end), tt.start, tt.end)
			}
		})
	}
}

func TestRelativeHourUsesLocalBoundary(t *testing.T) {
	loc, err := time.LoadLocation("Asia/Kathmandu")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 3, 10, 9, 17, 0, 0, time.UTC)
	start, end, err := resolveTimeRange(&TimeRange{Current: dialect.Hour}, now, loc, dialect.Monday)
	if err != nil {
		t.Fatal(err)
	}
	if start.Format(time.RFC3339) != "2026-03-10T15:00:00+05:45" || end.Sub(start) != time.Hour {
		t.Fatalf("hour was not anchored to local time: [%s,%s)", start, end)
	}
}

func TestIndependentTimeBoundsRejectMalformedOrReversedRanges(t *testing.T) {
	for _, value := range []string{
		`{"bounds":{"start":{}}}`,
		`{"bounds":{"end":{"fixed":"2026-01-01","relative":{"n":0,"unit":"day"}}}}`,
		`{"bounds":{"start":{"relative":{"n":1,"unit":"fortnight"}}}}`,
		`{"bounds":{"start":{"relative":{"n":1000001,"unit":"minute"}}}}`,
		`{"bounds":{"start":{"relative":{"n":10000,"unit":"year"}}}}`,
		`{"bounds":{"start":{"fixed":"2026-04-01"},"end":{"fixed":"2026-03-01"}}}`,
		`{"bounds":{"start":{"fixed":"2026-03-01"},"end":{"fixed":"2026-03-01"}}}`,
		`{"bounds":{},"current":"day"}`,
		`{"bounds":{},"start":"2026-01-01"}`,
		`{"bounds":{"start":{"relative":{"n":1,"unit":"day","extra":1}}}}`,
		`{"bounds":{"start":{"fixed":"2026-01-01T12:00:00"}}}`,
		`{"bounds":{"start":{"relative":{"n":0,"unit":"hour"}}}}`,
		`{"special":"is_empty"}`,
		`{"special":"is_null","current":"day"}`,
		`{"special":"not_null","last":{"n":1,"unit":"day"}}`,
		`{"special":"is_null","start":"2026-01-01"}`,
		`{"special":"not_null","end":"2026-01-01"}`,
		`{"special":"is_null","bounds":{}}`,
		`{"special":"not_null","includeCurrent":true}`,
		`{"special":"is_null","includeNull":true}`,
		`{"current":"day","grain":"quarter"}`,
		`{"current":"day","weekStart":8}`,
		`{"current":"day","weekStart":-1}`,
		`{"grain":"month","includeNull":true}`,
	} {
		q := parse(t, `{"version":1,"dataset":"d","dimensions":[{"field":"day"}],"filter":{"field":"day","op":"time","value":`+value+`}}`)
		if _, err := Compile(q, extensionDataset(), options()); errCode(err) != "invalid_time_range" {
			t.Errorf("%s: got %v, want invalid_time_range", value, err)
		}
	}
	if errCode(ValidateTimeRange(nil)) != "invalid_time_range" {
		t.Fatal("nil range should be rejected")
	}
}

func TestTimeSpecialValuesCompileNullPredicates(t *testing.T) {
	for _, field := range []string{"day", "created"} {
		for _, special := range []string{"is_null", "not_null"} {
			if err := ValidateTimeRange(&TimeRange{Special: special}); err != nil {
				t.Fatalf("%s: %v", special, err)
			}
			q := parse(t, `{"version":1,"dataset":"d","dimensions":[{"field":"`+field+`"}],"filter":{"field":"`+field+`","op":"time","value":{"special":"`+special+`"}}}`)
			got, err := Compile(q, extensionDataset(), options())
			if err != nil {
				t.Fatal(err)
			}
			predicate := " IS NULL"
			if special == "not_null" {
				predicate = " IS NOT NULL"
			}
			if !strings.Contains(got.SQL, predicate) || len(got.Args) != 0 {
				t.Fatalf("%s/%s: got %s / %#v", field, special, got.SQL, got.Args)
			}
		}
	}
	q := parse(t, `{"version":1,"dataset":"d","dimensions":[{"field":"name"}],"filter":{"field":"name","op":"time","value":{"special":"is_null"}}}`)
	if _, err := Compile(q, extensionDataset(), options()); errCode(err) != "time_field_required" {
		t.Fatalf("non-temporal field should still fail: %v", err)
	}
}

func TestTimeBoundsCompileHalfOpenOrUnrestricted(t *testing.T) {
	for _, field := range []string{"day", "created"} {
		q := parse(t, `{"version":1,"dataset":"d","dimensions":[{"field":"`+field+`"}],"filter":{"field":"`+field+`","op":"time","value":{"bounds":{"start":{"relative":{"n":-6,"unit":"day"}},"end":{"relative":{"n":1,"unit":"day"}}}}}}`)
		got, err := Compile(q, extensionDataset(), options())
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(got.SQL, " >= $1 AND ") || !strings.Contains(got.SQL, " < $2)") || len(got.Args) != 2 {
			t.Fatalf("not a half-open interval: %s / %#v", got.SQL, got.Args)
		}
		if field == "day" {
			if got.Args[0] != "2026-03-04" || got.Args[1] != "2026-03-11" {
				t.Fatalf("wrong local dates: %#v", got.Args)
			}
		} else {
			start, ok := got.Args[0].(time.Time)
			if !ok || start.Format(time.RFC3339) != "2026-03-04T00:00:00+08:00" {
				t.Fatalf("timestamp must be bound as zoned instant: %#v", got.Args)
			}
		}
	}
	q := parse(t, `{"version":1,"dataset":"d","dimensions":[{"field":"day"}],"filter":{"field":"day","op":"time","value":{"bounds":{}}}}`)
	got, err := Compile(q, extensionDataset(), options())
	if err != nil || !strings.Contains(got.SQL, "WHERE 1 = 1") || len(got.Args) != 0 {
		t.Fatalf("unrestricted range: %#v, %v", got, err)
	}
}

func TestResolveTimeRangeGivesLocalWallTimes(t *testing.T) {
	now := time.Date(2026, 10, 16, 1, 0, 0, 0, time.UTC) // 09:00 on Friday the 16th in Shanghai
	day := func(d int, m time.Month) string {
		return time.Date(2026, m, d, 0, 0, 0, 0, time.UTC).Format(time.DateOnly)
	}
	for _, tt := range []struct {
		name      string
		tr        TimeRange
		weekStart int
		from, to  string
	}{
		{"last 30 days with today", TimeRange{Last: &Duration{N: 30, Unit: dialect.Day}, IncludeCurrent: true}, dialect.Monday, day(17, 9), day(17, 10)},
		{"last month", TimeRange{Last: &Duration{N: 1, Unit: dialect.Month}}, dialect.Monday, day(1, 9), day(1, 10)},
		{"this week from Monday", TimeRange{Current: dialect.Week}, dialect.Monday, day(12, 10), day(19, 10)},
		{"this week from Sunday", TimeRange{Current: dialect.Week}, dialect.Sunday, day(11, 10), day(18, 10)},
	} {
		t.Run(tt.name, func(t *testing.T) {
			start, end, err := ResolveTimeRange(&tt.tr, now, "Asia/Shanghai", tt.weekStart)
			if err != nil {
				t.Fatal(err)
			}
			if got := [2]string{start.Format(time.DateOnly), end.Format(time.DateOnly)}; got != [2]string{tt.from, tt.to} {
				t.Fatalf("got %v want [%s %s]", got, tt.from, tt.to)
			}
		})
	}
	open := TimeRange{Bounds: &TimeBounds{Start: &TimeBound{Fixed: "2026-06-14"}}}
	if start, end, err := ResolveTimeRange(&open, now, "Asia/Shanghai", dialect.Monday); err != nil || start.Format(time.DateOnly) != "2026-06-14" || !end.IsZero() {
		t.Fatalf("an open end stays open: %v %v %v", start, end, err)
	}
	if _, _, err := ResolveTimeRange(&TimeRange{Current: dialect.Day}, now, "Mars/Olympus", dialect.Monday); err == nil || !strings.Contains(err.Error(), "time zone") {
		t.Fatalf("an unknown zone is refused: %v", err)
	}
}

func TestIncludeNullKeepsRowsWithoutADate(t *testing.T) {
	for _, field := range []string{"day", "created"} {
		q := parse(t, `{"version":1,"dataset":"d","dimensions":[{"field":"`+field+`"}],"filter":{"field":"`+field+`","op":"time","value":{"current":"month","includeNull":true}}}`)
		got, err := Compile(q, extensionDataset(), options())
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(got.SQL, " >= $1 AND ") || !strings.Contains(got.SQL, " < $2) OR ") || !strings.Contains(got.SQL, " IS NULL)") || len(got.Args) != 2 {
			t.Fatalf("%s: dates in the month or none: %s / %#v", field, got.SQL, got.Args)
		}
	}
	q := parse(t, `{"version":1,"dataset":"d","dimensions":[{"field":"day"}],"filter":{"field":"day","op":"time","value":{"bounds":{},"includeNull":true}}}`)
	got, err := Compile(q, extensionDataset(), options())
	if err != nil || !strings.Contains(got.SQL, "WHERE 1 = 1") || len(got.Args) != 0 {
		t.Fatalf("an unrestricted range keeps every row already: %#v, %v", got, err)
	}
}

func TestGrainAndWeekStartShapeTheInterval(t *testing.T) {
	now := time.Date(2026, 10, 16, 1, 0, 0, 0, time.UTC) // 09:00 on Friday the 16th in Shanghai
	for _, tt := range []struct {
		name     string
		tr       TimeRange
		from, to string
	}{
		{"fixed days become whole months", TimeRange{Start: "2026-01-15", End: "2026-03-10", Grain: dialect.Month}, "2026-01-01", "2026-04-01"},
		{"month ends already whole stay", TimeRange{Start: "2026-01-01", End: "2026-04-01", Grain: dialect.Month}, "2026-01-01", "2026-04-01"},
		{"fixed days become whole weeks", TimeRange{Start: "2026-10-07", End: "2026-10-15", Grain: dialect.Week}, "2026-10-05", "2026-10-19"},
		{"this week from Tuesday", TimeRange{Current: dialect.Week, WeekStart: 2}, "2026-10-13", "2026-10-20"},
		{"last two weeks from Saturday", TimeRange{Last: &Duration{N: 2, Unit: dialect.Week}, WeekStart: 6}, "2026-09-26", "2026-10-10"},
		{"days become weeks from Tuesday", TimeRange{Last: &Duration{N: 7, Unit: dialect.Day}, IncludeCurrent: true, Grain: dialect.Week, WeekStart: 2}, "2026-10-06", "2026-10-20"},
		{"an open end stays open", TimeRange{Bounds: &TimeBounds{Start: &TimeBound{Fixed: "2026-06-14"}}, Grain: dialect.Month}, "2026-06-01", ""},
	} {
		t.Run(tt.name, func(t *testing.T) {
			start, end, err := ResolveTimeRange(&tt.tr, now, "Asia/Shanghai", dialect.Monday)
			if err != nil {
				t.Fatal(err)
			}
			to := ""
			if !end.IsZero() {
				to = end.Format(time.DateOnly)
			}
			if got := [2]string{start.Format(time.DateOnly), to}; got != [2]string{tt.from, tt.to} {
				t.Fatalf("got %v want [%s %s]", got, tt.from, tt.to)
			}
		})
	}
	q := parse(t, `{"version":1,"dataset":"d","dimensions":[{"field":"day"}],"filter":{"field":"day","op":"time","value":{"start":"2026-02-10","end":"2026-02-12","grain":"month"}}}`)
	got, err := Compile(q, extensionDataset(), options())
	if err != nil || !reflect.DeepEqual(got.Args, []any{"2026-02-01", "2026-03-01"}) {
		t.Fatalf("a query keeps the whole month: %#v, %v", got, err)
	}
}
