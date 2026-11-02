package conformance

import (
	"context"
	"testing"

	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/dialect"
	"github.com/supazd/supabi/internal/query"
)

func comparisons(t *testing.T, tg Target) {
	spec, opt := tg.spec(), tg.options()
	spec.Fields = append(spec.Fields,
		dataset.Field{Key: "zero", Label: "Zero", Expr: "${qty} - ${qty}", Type: datasource.Integer, Role: dataset.MeasureRole},
		dataset.Field{Key: "signed", Label: "Signed", Expr: "${qty} - 4", Type: datasource.Integer, Role: dataset.MeasureRole},
		dataset.Field{Key: "mean", Label: "Mean", Expr: "AVG(${qty})", Type: datasource.Float, Role: dataset.Metric},
		dataset.Field{Key: "annual", Label: "Annual", Expr: "CASE WHEN ${order_id} <= 2 THEN " + opt.Dialect.ShiftTime("${created}", dialect.Year, -1) + " ELSE ${created} END", Type: datasource.Timestamp, Role: dataset.Dimension},
	)
	if err := spec.Validate(); err != nil {
		t.Fatal(err)
	}
	comp := func(field, agg, alias, timeField, unit, output string) string {
		a := ""
		if agg != "" {
			a = `,"agg":"` + agg + `"`
		}
		return `{"field":"` + field + `"` + a + `,"alias":"` + alias + `","compute":{"type":"compare","timeField":"` + timeField + `","offset":{"n":1,"unit":"` + unit + `"},"output":"` + output + `"}}`
	}
	period := `"filter":{"field":"created","op":"time","value":{"start":"2026-02-01","end":"2026-04-01"}}`
	cases := []struct{ name, body, want string }{
		{"monthly raw value difference growth", `"dimensions":[{"field":"created","grain":"month","alias":"m"}],"measures":[{"field":"qty","agg":"sum"},` + comp("qty", "sum", "previous", "created", "month", "value") + `,` + comp("qty", "sum", "delta", "created", "month", "delta") + `,` + comp("qty", "sum", "ratio", "created", "month", "ratio") + `],` + period, `[["2026-02-01T00:00:00",5,1,4,4],["2026-03-01T00:00:00",6,5,1,0.2]]`},
		{"nullable key and missing group", `"dimensions":[{"field":"note"}],"measures":[` + comp("qty", "sum", "v", "created", "month", "value") + `],"filter":{"op":"and","args":[{"field":"created","op":"time","value":{"current":"month"}},{"field":"note","op":"is_null"}]}`, `[[null,2]]`},
		{"groups and missing previous", `"dimensions":[{"field":"region"}],"measures":[` + comp("qty", "sum", "v", "created", "month", "ratio") + `],"filter":{"field":"created","op":"time","value":{"current":"month"}}`, `[["华北",null],["华南",0.66666667]]`},
		{"scalar reaggregates average and distinct", `"measures":[` + comp("qty", "avg", "average", "created", "month", "ratio") + `,` + comp("buyers", "count_distinct", "distinct", "created", "month", "ratio") + `,` + comp("mean", "", "metric", "created", "month", "ratio") + `],"filter":{"field":"created","op":"time","value":{"current":"month"}}`, `[[0.2,-0.5,0.2]]`},
		{"zero baseline and negative baseline", `"measures":[` + comp("zero", "sum", "ratio", "created", "month", "ratio") + `,` + comp("zero", "sum", "delta", "created", "month", "delta") + `,` + comp("signed", "sum", "negative", "created", "month", "ratio") + `],"filter":{"field":"created","op":"time","value":{"current":"month"}}`, `[[null,0,-0.33333333]]`},
		{"missing scalar count is null", `"measures":[` + comp("qty", "count", "v", "created", "year", "value") + `],` + period, `[[null]]`},
		{"year over year", `"dimensions":[{"field":"annual","grain":"month"}],"measures":[` + comp("qty", "sum", "v", "annual", "year", "ratio") + `],"filter":{"field":"annual","op":"time","value":{"start":"2026-02-01","end":"2026-03-01"}}`, `[["2026-02-01T00:00:00",0.5]]`},
		{"date daily and DST", `"dimensions":[{"field":"order_date","grain":"day"}],"measures":[` + comp("qty", "sum", "v", "order_date", "day", "ratio") + `],"filter":{"field":"order_date","op":"time","value":{"start":"2026-03-09","end":"2026-03-10"}}`, `[["2026-03-09",4]]`},
		{"having sorting limit after comparison", `"dimensions":[{"field":"created","grain":"month"}],"measures":[` + comp("qty", "sum", "v", "created", "month", "ratio") + `],` + period + `,"having":{"field":"v","op":"lt","value":1},"sort":[{"by":"v","desc":true}],"limit":1`, `[["2026-03-01T00:00:00",0.2]]`},
		{"hidden comparison", `"dimensions":[{"field":"created","grain":"month"}],"measures":[{"field":"qty","agg":"sum"}],"filterMeasures":[` + comp("qty", "sum", "v", "created", "month", "ratio") + `],` + period + `,"having":{"field":"v","op":"lt","value":1}`, `[["2026-03-01T00:00:00",6]]`},
		{"comparison with percentage", `"measures":[` + comp("qty", "sum", "v", "created", "month", "ratio") + `,{"field":"qty","agg":"sum","compute":{"type":"percent_of_total"}}],"filter":{"field":"created","op":"time","value":{"current":"month"}}`, `[[0.2,1]]`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			expect(t, tc.name, tg.run(t, opt, spec, `{"version":1,"dataset":"d",`+tc.body+`}`), tc.want)
		})
	}
	t.Run("timezone and DST", func(t *testing.T) {
		for _, field := range []string{"created", "paid"} {
			body := `{"version":1,"dataset":"d","timezone":"America/Los_Angeles","dimensions":[{"field":"` + field + `","grain":"day"}],"measures":[` + comp("qty", "sum", "v", field, "day", "ratio") + `],"filter":{"field":"` + field + `","op":"time","value":{"start":"2026-03-08","end":"2026-03-09"}}}`
			expect(t, field, tg.run(t, opt, spec, body), `[["2026-03-08T00:00:00",4]]`)
		}
	})
	t.Run("source params access filters and totals", func(t *testing.T) {
		copy := *spec
		copy.Source = dataset.Source{Type: "sql", SQL: "SELECT * FROM " + tg.QualifiedName + " WHERE qty >= {{minimum}}"}
		copy.Params = []dataset.Param{{Name: "minimum", Type: datasource.Integer}}
		opt.RowFilter = &dataset.Filter{Field: "status", Op: "eq", Value: "paid"}
		body := `{"version":1,"dataset":"d","params":{"minimum":1},"dimensions":[{"field":"created","grain":"month"},{"field":"region"}],"measures":[` + comp("qty", "sum", "v", "created", "month", "ratio") + `],"filter":{"op":"and","args":[{"field":"created","op":"time","value":{"current":"month"}},{"field":"qty","op":"gte","value":1}]}}`
		q := parse(t, body)
		expect(t, "access", tg.run(t, opt, &copy, body), `[["2026-03-01T00:00:00","华北",null],["2026-03-01T00:00:00","华南",null]]`)
		total := q.TotalQuery(nil)
		c, err := query.Compile(&total, &copy, opt)
		if err != nil {
			t.Fatal(err)
		}
		result, err := query.Run(context.Background(), tg.Conn, c)
		if err != nil {
			t.Fatal(err)
		}
		expect(t, "total reaggregates paid", result, `[[2]]`)
		// Permissions on dates are not shifted to reveal an inaccessible baseline.
		opt.RowFilter = &dataset.Filter{Field: "created", Op: "time", Value: query.TimeRange{Start: "2026-03-01", End: "2026-04-01"}}
		c, err = query.Compile(&total, &copy, opt)
		if err != nil {
			t.Fatal(err)
		}
		result, err = query.Run(context.Background(), tg.Conn, c)
		if err != nil {
			t.Fatal(err)
		}
		expect(t, "restricted baseline", result, `[[null]]`)
	})
}
