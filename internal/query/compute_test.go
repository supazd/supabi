package query

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/datasource"
)

func TestPercentComputeValidationAndMetadata(t *testing.T) {
	spec := &dataset.Spec{SpecVersion: 1, Source: dataset.Source{Type: "table", Table: "orders"}, Fields: []dataset.Field{
		{Key: "region", Label: "Region", Column: "region", Type: datasource.String, Role: dataset.Dimension},
		{Key: "qty", Label: "Quantity", Column: "qty", Type: datasource.Integer, Role: dataset.MeasureRole, Format: &dataset.Format{Prefix: "$"}},
	}}
	for _, tc := range []struct{ body, code string }{
		{`"field":"qty","agg":"sum","compute":{"type":"percent_of_total","within":["region"]}`, "invalid_compute"},
		{`"field":"qty","agg":"sum","compute":{"type":"percent_of_total","within":["area","area"]}`, "invalid_compute"},
		{`"field":"qty","agg":"sum","compute":{"type":"percent_of_total","within":["area\"; DROP TABLE orders"]}`, "invalid_compute"},
		{`"field":"region","agg":"min","compute":{"type":"percent_of_total"}`, "compute_needs_number"},
		{`"field":"qty","agg":"sum","compute":{"type":"rank"}`, "compute_not_supported"},
		{`"field":"qty","agg":"sum","compute":{"type":"percent_of_total","within":["area"]}`, ""},
	} {
		q := parse(t, `{"version":1,"dataset":"d","dimensions":[{"field":"region","alias":"area"}],"measures":[{`+tc.body+`}]}`)
		c, err := Compile(q, spec, options())
		if errCode(err) != tc.code {
			t.Errorf("%s: %v", tc.body, err)
		}
		if err == nil {
			col := c.Columns[1]
			if col.Compute != PercentOfTotal || col.Format.Style != "percent" || col.Format.Prefix != "" || col.Type != datasource.Float {
				t.Errorf("column: %+v", col)
			}
		}
	}
	q := parse(t, `{"version":1,"dataset":"d","measures":[{"field":"qty","agg":"sum","label":"Share","compute":{"type":"percent_of_total"}}]}`)
	c, err := Compile(q, spec, options())
	if err != nil {
		t.Fatal(err)
	}
	if col := c.Columns[0]; col.Label != "Share" || col.Compute != "" || col.Agg != "" || col.Format.Style != "percent" {
		t.Errorf("custom label: %+v", col)
	}
	// The strict decoder must reject unsupported compute settings instead of dropping them.
	q = &Query{}
	if err := json.Unmarshal([]byte(`{"version":1,"measures":[{"field":"qty","agg":"sum","compute":{"type":"percent_of_total","withn":["area"]}}]}`), q); err == nil {
		t.Fatal("misspelt setting accepted")
	}
}

func TestPercentTotalDoesNotMutateOriginal(t *testing.T) {
	q := parse(t, `{"version":1,"dataset":"d","dimensions":[{"field":"region"},{"field":"status"}],"measures":[{"field":"qty","agg":"sum","compute":{"type":"percent_of_total","within":["region","status"]}}]}`)
	total := q.TotalQuery([]string{"region"})
	if !reflect.DeepEqual(total.Measures[0].Compute.Within, []string{"region"}) || !reflect.DeepEqual(q.Measures[0].Compute.Within, []string{"region", "status"}) {
		t.Fatalf("total %v, source %v", total.Measures, q.Measures)
	}
}

func TestCumulativeValidationAndMetadata(t *testing.T) {
	spec := &dataset.Spec{SpecVersion: 1, Source: dataset.Source{Type: "table", Table: "orders"}, Fields: []dataset.Field{
		{Key: "region", Label: "Region", Column: "region", Type: datasource.String, Role: dataset.Dimension},
		{Key: "created", Label: "Created", Column: "created_at", Type: datasource.Timestamp, Role: dataset.Dimension},
		{Key: "qty", Label: "Quantity", Column: "qty", Type: datasource.Integer, Role: dataset.MeasureRole, Format: &dataset.Format{Prefix: "$"}},
		{Key: "mean", Label: "Mean", Expr: "AVG(${qty})", Type: datasource.Decimal, Role: dataset.Metric},
	}}
	for _, tc := range []struct{ body, code string }{
		{`"field":"qty","agg":"sum","compute":{"type":"cumulative","along":"month"}`, ""},
		{`"field":"qty","agg":"min","compute":{"type":"cumulative","along":"area"}`, ""},
		{`"field":"qty","agg":"avg","compute":{"type":"cumulative","along":"month"}`, "cumulative_agg"},
		{`"field":"region","agg":"count_distinct","compute":{"type":"cumulative","along":"month"}`, "cumulative_agg"},
		{`"field":"mean","compute":{"type":"cumulative","along":"month"}`, "cumulative_agg"},
		{`"field":"region","agg":"max","compute":{"type":"cumulative","along":"month"}`, "compute_needs_number"},
		{`"field":"qty","agg":"sum","compute":{"type":"cumulative"}`, "invalid_cumulative"},
		{`"field":"qty","agg":"sum","compute":{"type":"cumulative","along":"region"}`, "invalid_cumulative"},
		{`"field":"qty","agg":"sum","compute":{"type":"cumulative","along":"month","within":["area"]}`, "invalid_cumulative"},
		{`"field":"qty","agg":"sum","compute":{"type":"percent_of_total","along":"month"}`, "invalid_compute"},
		{`"field":"qty","agg":"sum","compute":{"type":"compare","timeField":"created","offset":{"n":1,"unit":"year"},"output":"value","along":"month"}`, "invalid_compare"},
	} {
		q := parse(t, `{"version":1,"dataset":"d","dimensions":[{"field":"region","alias":"area"},{"field":"created","grain":"month","alias":"month"}],"measures":[{`+tc.body+`}]}`)
		c, err := Compile(q, spec, options())
		if errCode(err) != tc.code {
			t.Errorf("%s: %v", tc.body, err)
		}
		if err == nil {
			// The number keeps its type and its format: a running sum of an amount is an amount.
			if col := c.Columns[2]; col.Compute != Cumulative || col.Type == datasource.Float || col.Format == nil || col.Format.Prefix != "$" {
				t.Errorf("column: %+v", col)
			}
		}
	}
	q := parse(t, `{"version":1,"dataset":"d","dimensions":[{"field":"region"}],"measures":[{"field":"qty","agg":"count","compute":{"type":"cumulative","along":"region"}}]}`)
	c, err := Compile(q, spec, options())
	if err != nil {
		t.Fatal(err)
	}
	if col := c.Columns[1]; col.Compute != Cumulative || col.Format != nil {
		t.Errorf("count: %+v", col)
	}
}

func TestCumulativeStatement(t *testing.T) {
	spec := &dataset.Spec{SpecVersion: 1, Source: dataset.Source{Type: "table", Table: "orders"}, Fields: []dataset.Field{
		{Key: "region", Label: "Region", Column: "region", Type: datasource.String, Role: dataset.Dimension},
		{Key: "status", Label: "Status", Column: "status", Type: datasource.String, Role: dataset.Dimension},
		{Key: "qty", Label: "Quantity", Column: "qty", Type: datasource.Integer, Role: dataset.MeasureRole},
	}}
	q := parse(t, `{"version":1,"dataset":"d","dimensions":[{"field":"region"},{"field":"status"}],"measures":[{"field":"qty","agg":"count","alias":"n","compute":{"type":"cumulative","along":"status"}}],"having":{"field":"n","op":"gt","value":1}}`)
	c, err := Compile(q, spec, options())
	if err != nil {
		t.Fatal(err)
	}
	// A count runs as the sum of the counts, within each region, and HAVING
	// filters the running values from around the statement that has them.
	for _, want := range []string{
		`SUM(pct_rows."n") OVER (PARTITION BY pct_rows."region" ORDER BY pct_rows."status" IS NULL, pct_rows."status" ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS "n"`,
		`) AS cum_rows`,
		`WHERE cum_rows."n" >`,
	} {
		if !strings.Contains(c.SQL, want) {
			t.Errorf("missing %s in\n%s", want, c.SQL)
		}
	}
	q = parse(t, `{"version":1,"dataset":"d","dimensions":[{"field":"region"}],"measures":[{"field":"qty","agg":"max","compute":{"type":"cumulative","along":"region"}}]}`)
	if c, err = Compile(q, spec, options()); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(c.SQL, `MAX(pct_rows."qty") OVER (ORDER BY pct_rows."region" IS NULL`) {
		t.Errorf("one dimension has no partition:\n%s", c.SQL)
	}
}

func TestCumulativeTotalsAndPruning(t *testing.T) {
	q := parse(t, `{"version":1,"dataset":"d","dimensions":[{"field":"region"},{"field":"status"}],"measures":[{"field":"qty","agg":"sum","compute":{"type":"cumulative","along":"status"}}]}`)
	// Keeping the dimension it runs along, it runs again over what is left.
	if total := q.TotalQuery([]string{"status"}); total.Measures[0].Compute == nil || total.Measures[0].Compute.Along != "status" {
		t.Errorf("kept: %+v", total.Measures[0])
	}
	// Without it, the total is the plain aggregate, the value at the end.
	for _, keep := range [][]string{{"region"}, {}} {
		if total := q.TotalQuery(keep); total.Measures[0].Compute != nil {
			t.Errorf("%v: %+v", keep, total.Measures[0])
		}
	}
	if q.Measures[0].Compute == nil {
		t.Fatal("the original lost its running total")
	}
}
