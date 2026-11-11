package query

import (
	"strings"
	"testing"

	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/datasource"
)

// A field written in the database's own SQL may have an OR at its top. It is
// compared and ANDed as one value: otherwise the OR would let rows past the
// row filter.
func TestNativeFieldIsOneOperand(t *testing.T) {
	spec := extensionDataset()
	spec.Fields = append(spec.Fields,
		dataset.Field{Key: "staff", Label: "Staff", Column: "is_staff", Type: datasource.Boolean, Role: dataset.Dimension},
		dataset.Field{Key: "admin", Label: "Admin", Column: "is_admin", Type: datasource.Boolean, Role: dataset.Dimension},
		dataset.Field{Key: "internal", Label: "Internal", Expr: "${staff} OR ${admin}", Type: datasource.Boolean, Role: dataset.Dimension},
	)
	opt := options()
	opt.RowFilter = &dataset.Filter{Field: "name", Op: "eq", Value: "East"}
	c, err := Compile(parse(t, `{"version":1,"dataset":"d","dimensions":[{"field":"name"}],"filter":{"field":"internal","op":"eq","value":false}}`), spec, opt)
	if err != nil {
		t.Fatal(err)
	}
	if want := `((t."is_staff") OR (t."is_admin")) = `; !strings.Contains(c.SQL, want) {
		t.Errorf("the field is not compared as one value:\n%s\nwant it to contain %s", c.SQL, want)
	}
}
