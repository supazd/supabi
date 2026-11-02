package query

import (
	"reflect"
	"testing"
)

func TestTotalQuery(t *testing.T) {
	limit := 10
	q := Query{
		Version:    1,
		Dataset:    "d",
		Dimensions: []Dimension{{Field: "created", Grain: "month", Alias: "month"}, {Field: "region"}},
		Measures:   []Measure{{Field: "revenue", Agg: "sum"}},
		Sort:       []Sort{{By: "region"}, {By: "month", Desc: true}, {By: "revenue", Desc: true}},
		Limit:      &limit,
		Offset:     5,
		Totals:     [][]string{{"region"}, {}},
	}
	total := q.TotalQuery([]string{"region"})
	if !reflect.DeepEqual(total.Dimensions, []Dimension{{Field: "region"}}) {
		t.Errorf("dimensions = %v", total.Dimensions)
	}
	// Ordered by what it still returns, over every row the query reads.
	if !reflect.DeepEqual(total.Sort, []Sort{{By: "region"}, {By: "revenue", Desc: true}}) || total.Limit != nil || total.Offset != 0 || total.Totals != nil {
		t.Errorf("total = %+v", total)
	}
	if len(q.Sort) != 3 || q.Limit == nil {
		t.Error("the query itself changed")
	}
	if grand := q.TotalQuery(nil); len(grand.Dimensions) != 0 {
		t.Errorf("grand total groups by %v", grand.Dimensions)
	}
}

func TestTotalsLimit(t *testing.T) {
	// A pivot table with three dimensions down the side and three across, with subtotals:
	// each row level paired with each column level, but for the table itself.
	q := Query{Version: 1, Dataset: "d", Measures: []Measure{{Field: "revenue", Agg: "sum"}}}
	rows, columns := []string{"a", "b", "c"}, []string{"x", "y", "z"}
	for _, name := range append(append([]string{}, rows...), columns...) {
		q.Dimensions = append(q.Dimensions, Dimension{Field: name})
	}
	for i := range len(rows) + 1 {
		for j := range len(columns) + 1 {
			if i < len(rows) || j < len(columns) {
				q.Totals = append(q.Totals, append(append([]string{}, rows[:i]...), columns[:j]...))
			}
		}
	}
	if err := q.checkTotals(); len(q.Totals) != 15 || err != nil {
		t.Errorf("%d totals: %v", len(q.Totals), err)
	}
	q.Totals = append(q.Totals, []string{}, []string{})
	if err := q.checkTotals(); err == nil {
		t.Errorf("%d totals were taken, more than %d", len(q.Totals), maxTotals)
	}
}

func TestPruneTotals(t *testing.T) {
	q := Query{
		Dimensions: []Dimension{{Field: "region"}, {Field: "channel"}},
		Totals:     [][]string{{"region", "month"}, {"month", "channel"}, {"month"}, {}, {"region", "channel"}},
	}
	q.PruneTotals()
	// month is gone: its totals keep what is left, and the grand total is asked for once.
	if !reflect.DeepEqual(q.Totals, [][]string{{"region"}, {"channel"}, {}}) {
		t.Errorf("totals = %v", q.Totals)
	}
	q.Dimensions = nil
	q.PruneTotals()
	if q.Totals != nil {
		t.Errorf("without dimensions, totals = %v", q.Totals)
	}
}
