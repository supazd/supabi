package dialect

import "testing"

func TestWildcardPatternsAreBoundWithConsistentEscaping(t *testing.T) {
	tests := []struct {
		input, bang, slash string
	}{
		{`item_%`, `item_%`, `item_%`},
		{`50\%`, `50!%`, `50\%`},
		{`one\_two`, `one!_two`, `one\_two`},
		{`a\\b`, `a\b`, `a\\b`},
		{`a\`, `a\`, `a\\`},
		{`a!b`, `a!!b`, `a!b`},
		{`\雪`, `雪`, `雪`},
		{`%' OR 1=1 --`, `%' OR 1=1 --`, `%' OR 1=1 --`},
	}
	for _, d := range []Dialect{Postgres{}, MySQL{}, ClickHouse{}, StarRocks{}, StarRocks{Doris: true}} {
		for _, tt := range tests {
			t.Run(d.Name()+"/"+tt.input, func(t *testing.T) {
				var bound []any
				sql := d.Match("field", Wildcard, tt.input, func(value any) string {
					bound = append(bound, value)
					return "?"
				})
				want, wantSQL := tt.bang, "field LIKE ? ESCAPE '!'"
				if d.Name() == "clickhouse" || d.Name() == "starrocks" || d.Name() == "doris" {
					want, wantSQL = tt.slash, "field LIKE ?"
				}
				if sql != wantSQL || len(bound) != 1 || bound[0] != want {
					t.Fatalf("got %q / %#v; want %q / %q", sql, bound, wantSQL, want)
				}
			})
		}
	}
}
