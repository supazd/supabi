package conformance

import (
	"context"
	"testing"

	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/query"
)

func runningTotals(t *testing.T, tg Target) {
	spec, opt := tg.spec(), tg.options()
	spec.Fields = append(spec.Fields,
		dataset.Field{Key: "refunded_qty", Label: "Refunded", Expr: "CASE WHEN ${status} = 'refunded' THEN ${qty} END", Type: datasource.Integer, Role: dataset.MeasureRole},
	)
	if err := spec.Validate(); err != nil {
		t.Fatal(err)
	}
	month := `{"field":"created","grain":"month","alias":"month"}`
	running := func(field, agg, alias, along string) string {
		return `{"field":"` + field + `","agg":"` + agg + `","alias":"` + alias + `","compute":{"type":"cumulative","along":"` + along + `"}}`
	}
	cases := []struct{ name, body, want string }{
		{"sum along months", `"dimensions":[` + month + `],"measures":[{"field":"qty","agg":"sum"},` + running("qty", "sum", "running", "month") + `]`,
			`[["2026-01-01T00:00:00",1,1],["2026-02-01T00:00:00",5,6],["2026-03-01T00:00:00",6,12]]`},
		{"starts over in each region", `"dimensions":[{"field":"region"},` + month + `],"measures":[` + running("qty", "sum", "running", "month") + `]`,
			`[["华东","2026-01-01T00:00:00",1],["华东","2026-02-01T00:00:00",3],["华北","2026-03-01T00:00:00",1],["华南","2026-02-01T00:00:00",3],["华南","2026-03-01T00:00:00",8]]`},
		{"along the first dimension", `"dimensions":[` + month + `,{"field":"region"}],"measures":[` + running("qty", "sum", "running", "month") + `]`,
			`[["2026-01-01T00:00:00","华东",1],["2026-02-01T00:00:00","华东",3],["2026-02-01T00:00:00","华南",3],["2026-03-01T00:00:00","华北",1],["2026-03-01T00:00:00","华南",8]]`},
		{"counts, least and greatest", `"dimensions":[` + month + `],"measures":[` + running("orders", "count", "n", "month") + `,` + running("amount", "min", "low", "month") + `,` + running("qty", "max", "high", "month") + `]`,
			`[["2026-01-01T00:00:00",1,100.5,1],["2026-02-01T00:00:00",3,100.5,3],["2026-03-01T00:00:00",5,50,5]]`},
		{"along dates", `"dimensions":[{"field":"order_date"}],"measures":[` + running("qty", "sum", "running", "order_date") + `]`,
			`[["2026-01-31",1],["2026-02-01",3],["2026-02-15",6],["2026-03-08",7],["2026-03-09",12]]`},
		{"no value along comes last", `"dimensions":[{"field":"note","alias":"n"}],"measures":[` + running("qty", "sum", "running", "n") + `],"sort":[{"by":"running"}]`,
			`[["50% off",1],["a_b",4],["axb",5],[null,12]]`},
		{"empty groups carry the value before", `"dimensions":[` + month + `],"measures":[` + running("refunded_qty", "sum", "running", "month") + `]`,
			`[["2026-01-01T00:00:00",null],["2026-02-01T00:00:00",3],["2026-03-01T00:00:00",3]]`},
		{"having leaves the running values", `"dimensions":[` + month + `],"measures":[` + running("qty", "sum", "running", "month") + `],"filterMeasures":[{"field":"qty","agg":"sum","alias":"raw"}],"having":{"field":"raw","op":"gt","value":1}`,
			`[["2026-02-01T00:00:00",6],["2026-03-01T00:00:00",12]]`},
		{"having on the running value", `"dimensions":[` + month + `],"measures":[` + running("qty", "sum", "running", "month") + `],"having":{"field":"running","op":"gt","value":6}`,
			`[["2026-03-01T00:00:00",12]]`},
		{"a hidden running value", `"dimensions":[` + month + `],"measures":[{"field":"qty","agg":"sum"}],"filterMeasures":[` + running("qty", "sum", "running", "month") + `],"having":{"field":"running","op":"lt","value":10}`,
			`[["2026-01-01T00:00:00",1],["2026-02-01T00:00:00",5]]`},
		{"pages carry on", `"dimensions":[` + month + `],"measures":[` + running("qty", "sum", "running", "month") + `],"sort":[{"by":"month","desc":true}],"limit":1,"offset":1`,
			`[["2026-02-01T00:00:00",6]]`},
		{"beside a percentage", `"dimensions":[` + month + `],"measures":[` + running("qty", "sum", "running", "month") + `,{"field":"qty","agg":"sum","alias":"share","compute":{"type":"percent_of_total"}}]`,
			`[["2026-01-01T00:00:00",1,0.08333333],["2026-02-01T00:00:00",6,0.41666667],["2026-03-01T00:00:00",12,0.5]]`},
		{"beside a comparison", `"dimensions":[` + month + `],"measures":[` + running("qty", "sum", "running", "month") + `,{"field":"qty","agg":"sum","alias":"before","compute":{"type":"compare","timeField":"created","offset":{"n":1,"unit":"month"},"output":"value"}}],"filter":{"field":"created","op":"time","value":{"start":"2026-02-01T00:00:00","end":"2026-04-01T00:00:00"}}`,
			`[["2026-02-01T00:00:00",5,1],["2026-03-01T00:00:00",11,5]]`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			expect(t, tc.name, tg.run(t, opt, spec, `{"version":1,"dataset":"d",`+tc.body+`}`), tc.want)
		})
	}
	t.Run("totals", func(t *testing.T) {
		q := parse(t, `{"version":1,"dataset":"d","dimensions":[{"field":"region"},`+month+`],"measures":[`+running("qty", "sum", "running", "month")+`]}`)
		for _, tc := range []struct {
			keep []string
			want string
		}{
			{[]string{"month"}, `[["2026-01-01T00:00:00",1],["2026-02-01T00:00:00",6],["2026-03-01T00:00:00",12]]`},
			{[]string{"region"}, `[["华东",3],["华北",1],["华南",8]]`},
			{[]string{}, `[[12]]`},
		} {
			total := q.TotalQuery(tc.keep)
			c, err := query.Compile(&total, spec, opt)
			if err != nil {
				t.Fatal(err)
			}
			result, err := query.Run(context.Background(), tg.Conn, c)
			if err != nil {
				t.Fatalf("%v\n%s", err, c.SQL)
			}
			expect(t, "total", result, tc.want)
		}
	})
}
