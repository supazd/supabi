package conformance

import (
	"context"
	"testing"

	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/query"
)

func percentages(t *testing.T, tg Target) {
	spec, opt := tg.spec(), tg.options()
	spec.Fields = append(spec.Fields,
		dataset.Field{Key: "signed_qty", Label: "Signed", Expr: "${qty} - 2", Type: datasource.Integer, Role: dataset.MeasureRole},
		dataset.Field{Key: "mean_qty", Label: "Mean", Expr: "AVG(${qty})", Type: datasource.Decimal, Role: dataset.Metric},
		dataset.Field{Key: "zero", Label: "Zero", Expr: "${qty} - ${qty}", Type: datasource.Integer, Role: dataset.MeasureRole},
		dataset.Field{Key: "missing", Label: "Missing", Expr: "CASE WHEN ${qty} < 0 THEN ${qty} END", Type: datasource.Integer, Role: dataset.MeasureRole},
	)
	if err := spec.Validate(); err != nil {
		t.Fatal(err)
	}
	cases := []struct{ name, body, want string }{
		{"sum and raw side by side", `"dimensions":[{"field":"region"}],"measures":[{"field":"qty","agg":"sum"},{"field":"qty","agg":"sum","alias":"share","compute":{"type":"percent_of_total"}}]`, `[["华东",3,0.25],["华北",1,0.08333333],["华南",8,0.66666667]]`},
		{"distinct reaggregates", `"dimensions":[{"field":"region"}],"measures":[{"field":"buyers","agg":"count_distinct","compute":{"type":"percent_of_total"}}]`, `[["华东",0.66666667],["华北",0.33333333],["华南",0.66666667]]`},
		{"average reaggregates", `"dimensions":[{"field":"region"}],"measures":[{"field":"qty","agg":"avg","compute":{"type":"percent_of_total"}}]`, `[["华东",0.625],["华北",0.41666667],["华南",1.66666667]]`},
		{"metric reaggregates", `"dimensions":[{"field":"region"}],"measures":[{"field":"mean_qty","compute":{"type":"percent_of_total"}}]`, `[["华东",0.625],["华北",0.41666667],["华南",1.66666667]]`},
		{"within alias", `"dimensions":[{"field":"region","alias":"area"},{"field":"status"}],"measures":[{"field":"qty","agg":"sum","compute":{"type":"percent_of_total","within":["area"]}}]`, `[["华东","paid",1],["华北","paid",1],["华南","paid",0.625],["华南","refunded",0.375]]`},
		{"nullable group keys", `"dimensions":[{"field":"note","alias":"n"},{"field":"tier"}],"measures":[{"field":"qty","agg":"sum","compute":{"type":"percent_of_total","within":["n"]}}],"filter":{"field":"note","op":"is_null"}`, `[[null,"high",0.28571429],[null,"low",0.71428571]]`},
		{"date grain denominator", `"dimensions":[{"field":"created","grain":"month","alias":"month"},{"field":"region"}],"measures":[{"field":"qty","agg":"sum","compute":{"type":"percent_of_total","within":["month"]}}]`, `[["2026-01-01T00:00:00","华东",1],["2026-02-01T00:00:00","华东",0.4],["2026-02-01T00:00:00","华南",0.6],["2026-03-01T00:00:00","华北",0.16666667],["2026-03-01T00:00:00","华南",0.83333333]]`},
		{"top n keeps denominator", `"dimensions":[{"field":"region"}],"measures":[{"field":"qty","agg":"sum","compute":{"type":"percent_of_total"}}],"sort":[{"by":"qty","desc":true}],"limit":1`, `[["华南",0.66666667]]`},
		{"offset keeps denominator", `"dimensions":[{"field":"region"}],"measures":[{"field":"qty","agg":"sum","compute":{"type":"percent_of_total"}}],"sort":[{"by":"qty","desc":true}],"limit":1,"offset":1`, `[["华东",0.25]]`},
		{"having on share", `"dimensions":[{"field":"region"}],"measures":[{"field":"qty","agg":"sum","compute":{"type":"percent_of_total"}}],"having":{"field":"qty","op":"gt","value":0.5}`, `[["华南",0.66666667]]`},
		{"having on hidden raw aggregate", `"dimensions":[{"field":"region"}],"measures":[{"field":"qty","agg":"sum","compute":{"type":"percent_of_total"}}],"filterMeasures":[{"field":"qty","agg":"sum","alias":"raw"}],"having":{"field":"raw","op":"gt","value":4}`, `[["华南",0.66666667]]`},
		{"hidden computed aggregate", `"dimensions":[{"field":"region"}],"measures":[{"field":"qty","agg":"sum"}],"filterMeasures":[{"field":"qty","agg":"sum","alias":"share","compute":{"type":"percent_of_total"}}],"having":{"field":"share","op":"gt","value":0.5}`, `[["华南",8]]`},
		{"signed values are not clamped", `"dimensions":[{"field":"region"}],"measures":[{"field":"signed_qty","agg":"sum","compute":{"type":"percent_of_total"}}]`, `[["华东",-0.5],["华北",-0.5],["华南",2]]`},
		{"zero and null", `"dimensions":[{"field":"region"}],"measures":[{"field":"zero","agg":"sum","compute":{"type":"percent_of_total"}},{"field":"missing","agg":"sum","compute":{"type":"percent_of_total"}}]`, `[["华东",null,null],["华北",null,null],["华南",null,null]]`},
		{"empty scalar", `"measures":[{"field":"qty","agg":"count","compute":{"type":"percent_of_total"}}],"filter":{"field":"qty","op":"lt","value":0}`, `[[null]]`},
		{"grand total", `"measures":[{"field":"qty","agg":"sum","compute":{"type":"percent_of_total"}}]`, `[[1]]`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			result := tg.run(t, opt, spec, `{"version":1,"dataset":"d",`+tc.body+`}`)
			expect(t, tc.name, result, tc.want)
			for _, col := range result.Columns {
				if col.Compute != "" && (col.Format == nil || col.Format.Style != "percent") {
					t.Errorf("percentage format: %+v", col)
				}
			}
		})
	}
	t.Run("parameters and row access", func(t *testing.T) {
		copy := *spec
		copy.Source = dataset.Source{Type: "sql", SQL: "SELECT * FROM " + tg.QualifiedName + " WHERE qty >= {{minimum}}"}
		copy.Params = []dataset.Param{{Name: "minimum", Type: datasource.Integer}}
		opt.RowFilter = &dataset.Filter{Field: "status", Op: "eq", Value: "paid"}
		result := tg.run(t, opt, &copy, `{"version":1,"dataset":"d","params":{"minimum":1},"dimensions":[{"field":"region"}],"measures":[{"field":"qty","agg":"sum","compute":{"type":"percent_of_total"}}],"filter":{"field":"order_id","op":"lte","value":3}}`)
		expect(t, "restricted denominator", result, `[["华东",1]]`)
	})
	t.Run("totals and candidates", func(t *testing.T) {
		q := parse(t, `{"version":1,"dataset":"d","dimensions":[{"field":"region"},{"field":"status"}],"measures":[{"field":"qty","agg":"sum","compute":{"type":"percent_of_total","within":["region"]}}]}`)
		for _, keep := range [][]string{{"region"}, {}} {
			total := q.TotalQuery(keep)
			c, err := query.Compile(&total, spec, opt)
			if err != nil {
				t.Fatal(err)
			}
			result, err := query.Run(context.Background(), tg.Conn, c)
			if err != nil {
				t.Fatal(err)
			}
			want := `[[1]]`
			if len(keep) > 0 {
				want = `[["华东",1],["华北",1],["华南",1]]`
			}
			expect(t, "subtotal", result, want)
		}
		q.Having = &dataset.Filter{Field: "qty", Op: "gt", Value: 0.5}
		q.Candidates = &query.CandidateProjection{Field: "status"}
		c, err := query.Compile(q, spec, opt)
		if err != nil {
			t.Fatal(err)
		}
		result, err := query.Run(context.Background(), tg.Conn, c)
		if err != nil {
			t.Fatalf("%v\n%s", err, c.SQL)
		}
		expect(t, "candidate groups", result, `[["paid"]]`)
	})
}
