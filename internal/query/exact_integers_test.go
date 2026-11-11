package query

import (
	"reflect"
	"testing"

	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/datasource"
)

func bigSpec() *dataset.Spec {
	spec := extensionDataset()
	spec.Fields = append(spec.Fields, dataset.Field{Key: "qty", Label: "Qty", Column: "qty", Type: datasource.Integer, Role: dataset.Dimension})
	return spec
}

// A browser rounds a whole number past 2^53 as it reads JSON, so those are
// given as text, and taken back as text in a filter.
func TestIntegersABrowserWouldRoundAreText(t *testing.T) {
	const id = int64(1745226349834567681)
	raw := &datasource.Result{
		Columns: []datasource.Column{{Name: "id", Type: datasource.Integer}, {Name: "n", Type: datasource.Integer}},
		Rows:    [][]any{{int64(7), int64(maxExactInteger)}, {id, int64(-maxExactInteger - 1)}, {nil, "x"}},
	}
	kept := [][]any{raw.Rows[0], raw.Rows[1], raw.Rows[2]}
	shaped := Shape(&Compiled{Columns: []OutputColumn{{Name: "id", Type: datasource.Integer}, {Name: "n", Type: datasource.Integer}}, Limit: 10}, raw)
	want := [][]any{{int64(7), int64(maxExactInteger)}, {"1745226349834567681", "-9007199254740992"}, {nil, "x"}}
	if !reflect.DeepEqual(shaped.Rows, want) {
		t.Errorf("got %v\nwant %v", shaped.Rows, want)
	}
	// What the database returned is shared with the cache and stays as it was.
	if raw.Rows[1][0] != id || &raw.Rows[1][0] != &kept[1][0] {
		t.Errorf("the kept result was changed: %v", raw.Rows)
	}
	// A row with nothing to change is not copied.
	if &shaped.Rows[0][0] != &kept[0][0] {
		t.Error("a row with no such integer was copied")
	}

	c, err := Compile(parse(t, `{"version":1,"dataset":"d","dimensions":[{"field":"name"}],"filter":{"field":"qty","op":"in","value":["1745226349834567681",3]}}`), bigSpec(), options())
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(c.Args, []any{id, int64(3)}) {
		t.Errorf("args = %#v", c.Args)
	}
	for _, bad := range []string{`"12.5"`, `"1e3"`, `"99999999999999999999"`, `""`} {
		if _, err := Compile(parse(t, `{"version":1,"dataset":"d","dimensions":[{"field":"name"}],"filter":{"field":"qty","op":"eq","value":`+bad+`}}`), bigSpec(), options()); err == nil {
			t.Errorf("%s was taken as an integer", bad)
		}
	}
}
