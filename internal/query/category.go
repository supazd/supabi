package query

import (
	"time"

	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/dialect"
)

// CategoryTimeRange maps a displayed wall-time bucket to a half-open interval.
// Calendar dates keep their dates; timestamps preserve instants across query zones.
func CategoryTimeRange(value string, grain dialect.Grain, sourceType, targetType datasource.Type, sourceZone, targetZone string, weekStart int) (TimeRange, error) {
	if sourceZone == "" {
		sourceZone = "UTC"
	}
	if targetZone == "" {
		targetZone = "UTC"
	}
	sourceLoc, err := time.LoadLocation(sourceZone)
	if err != nil || sourceZone == "Local" {
		return TimeRange{}, bad("invalid_timezone", nil, "invalid source timezone")
	}
	targetLoc, err := time.LoadLocation(targetZone)
	if err != nil || targetZone == "Local" {
		return TimeRange{}, bad("invalid_timezone", nil, "invalid target timezone")
	}
	// DATE buckets must not be normalized by DST (some zones skipped whole dates).
	if sourceType == datasource.Date {
		sourceLoc = time.UTC
	}
	at, err := parseLocalTime(value, sourceLoc)
	if err != nil {
		return TimeRange{}, err
	}
	if sourceType == datasource.Date && grain == "" {
		grain = dialect.Day
	}
	start, end := at, at.Add(time.Second)
	if grain != "" {
		if !validGrain(grain) {
			return TimeRange{}, bad("invalid_link_value", nil, "invalid date grain")
		}
		start = truncate(at, grain, weekStart)
		end = shift(start, grain, 1)
	}
	if end.Year() > 9999 {
		return TimeRange{}, bad("invalid_link_value", nil, "date bucket exceeds supported calendar")
	}
	layout := "2006-01-02T15:04:05.999999999"
	if sourceType == datasource.Timestamp && targetType == datasource.Timestamp {
		start, end = start.In(targetLoc), end.In(targetLoc)
		// Repeated wall times during DST rollback are distinct instants. Keep
		// their offsets when the range is handed to the target query.
		layout = time.RFC3339Nano
	}
	if targetType == datasource.Date {
		layout = "2006-01-02"
	}
	return TimeRange{Bounds: &TimeBounds{Start: &TimeBound{Fixed: start.Format(layout)}, End: &TimeBound{Fixed: end.Format(layout)}}}, nil
}
