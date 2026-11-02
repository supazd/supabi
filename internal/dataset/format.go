package dataset

import (
	"strings"
	"unicode/utf8"

	"github.com/supazd/supabi/internal/datasource"
)

// Format is how a number or a date is written for people to read. It changes
// nothing about what is queried. A number takes the number properties and a
// date the date properties, never both. See .agents/design/dataset.md §5.5.
type Format struct {
	// Style is "none", which shows the number as the query returned it and
	// says nothing else; "number", which is meant when it is left out; or
	// "percent", which shows a ratio as a percentage: 0.25 as 25%. A field
	// without a format is shown as with none; a chart says none to set aside
	// the dataset's format.
	Style string `json:"style,omitempty"`
	// Decimals is a fixed number of decimal places. Without it, up to two are
	// shown and trailing zeros are left out.
	Decimals *int `json:"decimals,omitempty"`
	// Grouping separates thousands. Without it, they are separated.
	Grouping *bool `json:"grouping,omitempty"`
	// Unit divides the number before it is shown: K, M, B, wan (万) or yi (亿),
	// or auto, which picks one for each value by the reader's language.
	Unit   string `json:"unit,omitempty"`
	Prefix string `json:"prefix,omitempty"`
	Suffix string `json:"suffix,omitempty"`

	// Date is how a date is written: "dash" (2026-01-05), which is meant when
	// it is left out; "slash" (2026/01/05); or "chinese" (2026年1月5日). How
	// much of it is written is the grain's to say.
	Date string `json:"date,omitempty"`
	// Time is how much of the time of day a timestamp not grouped by a grain
	// shows: "second", which is meant when it is left out; "minute"; or
	// "none", the date alone. A date has no time.
	Time string `json:"time,omitempty"`
	// Week is how a week is written: "range", its first and last days, which
	// is meant when it is left out; "start", its first day; or "number", the
	// week of the year, counted as the workspace says.
	Week string `json:"week,omitempty"`
}

const (
	maxFormatDecimals = 10
	maxAffixLength    = 16
)

var (
	formatUnits = map[string]bool{"auto": true, "K": true, "M": true, "B": true, "wan": true, "yi": true}
	dateStyles  = map[string]bool{"dash": true, "slash": true, "chinese": true}
	timeStyles  = map[string]bool{"second": true, "minute": true, "none": true}
	weekStyles  = map[string]bool{"range": true, "start": true, "number": true}
)

// Formattable reports whether values of the type can have a display format:
// numbers and dates.
func Formattable(t datasource.Type) bool { return t.Numeric() || t.Temporal() }

// Problem returns the property of the format that is not valid for a value of
// the type, or "" when all of them are. The type must be Formattable.
func (f *Format) Problem(t datasource.Type) string {
	if t.Temporal() {
		return f.dateProblem(t)
	}
	switch {
	case f.Date != "":
		return "date"
	case f.Time != "":
		return "time"
	case f.Week != "":
		return "week"
	}
	return f.numberProblem()
}

func (f *Format) numberProblem() string {
	if f.Style == "none" {
		// Nothing goes with none, so nothing is stored that is not shown.
		switch {
		case f.Decimals != nil:
			return "decimals"
		case f.Grouping != nil:
			return "grouping"
		case f.Unit != "":
			return "unit"
		case f.Prefix != "":
			return "prefix"
		case f.Suffix != "":
			return "suffix"
		}
		return ""
	}
	switch {
	case f.Style != "" && f.Style != "number" && f.Style != "percent":
		return "style"
	case f.Decimals != nil && (*f.Decimals < 0 || *f.Decimals > maxFormatDecimals):
		return "decimals"
	case f.Unit != "" && (!formatUnits[f.Unit] || f.Style == "percent"):
		return "unit"
	case !validAffix(f.Prefix):
		return "prefix"
	case !validAffix(f.Suffix):
		return "suffix"
	}
	return ""
}

// A date has no style: written as it came, the first day of a month says
// nothing of the month.
func (f *Format) dateProblem(t datasource.Type) string {
	switch {
	case f.Style != "":
		return "style"
	case f.Decimals != nil:
		return "decimals"
	case f.Grouping != nil:
		return "grouping"
	case f.Unit != "":
		return "unit"
	case f.Prefix != "":
		return "prefix"
	case f.Suffix != "":
		return "suffix"
	case f.Date != "" && !dateStyles[f.Date]:
		return "date"
	case f.Time != "" && (!timeStyles[f.Time] || t != datasource.Timestamp):
		return "time"
	case f.Week != "" && !weekStyles[f.Week]:
		return "week"
	}
	return ""
}

func validAffix(s string) bool {
	return utf8.RuneCountInString(s) <= maxAffixLength && !strings.ContainsAny(s, "\r\n")
}

// checkFormat checks the display format of a field, if it has one.
func checkFormat(f Field) error {
	if f.Format == nil {
		return nil
	}
	pairs := []string{"key", f.Key, "label", f.Label}
	if !Formattable(f.Type) {
		return Errorf("format_not_supported", pairs, "field %q is neither a number nor a date, so it has no display format", f.Label)
	}
	if property := f.Format.Problem(f.Type); property != "" {
		return Errorf("invalid_format", append(pairs, "property", property), "the display format of field %q has an invalid %s", f.Label, property)
	}
	return nil
}
