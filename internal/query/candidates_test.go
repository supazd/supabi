package query

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/dialect"
)

func TestCandidateProjectionPreservesGroupsAndParameterOrder(t *testing.T) {
	for _, d := range []dialect.Dialect{dialect.Postgres{}, dialect.MySQL{}, dialect.ClickHouse{}, dialect.StarRocks{}, dialect.StarRocks{Doris: true}, dialect.Trino{}} {
		t.Run(d.Name(), func(t *testing.T) {
			q := parse(t, `{"version":1,"dataset":"d","dimensions":[{"field":"day","grain":"month","alias":"name"}],"measures":[{"field":"amount","agg":"sum","alias":"total"}],"filter":{"field":"amount","op":"gte","value":1},"having":{"field":"total","op":"gt","value":10},"sort":[{"by":"total","desc":true}],"limit":2,"offset":99}`)
			q.Candidates = &CandidateProjection{Field: "name", Search: "a%"}
			opt := options()
			opt.Dialect = d
			opt.RowFilter = &dataset.Filter{Field: "name", Op: "ne", Value: "forbidden"}
			compiled, err := Compile(q, extensionDataset(), opt)
			if err != nil {
				t.Fatal(err)
			}
			wantArgs := []any{"forbidden", float64(1), float64(10), "forbidden", float64(1)}
			if d.Name() == "clickhouse" || d.Name() == "starrocks" || d.Name() == "doris" {
				wantArgs = append(wantArgs, "a%")
			} else {
				wantArgs = append(wantArgs, "%a!%%")
			}
			if !reflect.DeepEqual(compiled.Args, wantArgs) {
				t.Fatalf("arguments %v, want %v; SQL=%s", compiled.Args, wantArgs, compiled.SQL)
			}
			if strings.Count(compiled.SQL, "GROUP BY 1") != 2 || strings.Count(compiled.SQL, "HAVING") != 1 || strings.Count(compiled.SQL, "LIMIT") != 1 || !strings.HasSuffix(compiled.SQL, "ORDER BY 1\nLIMIT 3") || strings.Contains(compiled.SQL, "OFFSET") {
				t.Fatalf("grouping or pagination changed: %s", compiled.SQL)
			}
			left := d.TruncDate("t."+d.QuoteIdent("day"), dialect.Month, opt.WeekStart)
			if !strings.Contains(compiled.SQL, d.NullSafeEqual(left, "filter_groups."+d.QuoteIdent("name"))) {
				t.Fatalf("missing original grain / NULL-safe match: %s", compiled.SQL)
			}
			if len(compiled.Columns) != 1 || compiled.Columns[0].Name != "name" || compiled.Columns[0].Role != "dimension" {
				t.Fatalf("wrong candidate columns: %+v", compiled.Columns)
			}
			before := compiled.SQL
			q.Candidates = &CandidateProjection{Field: "day"}
			other, err := Compile(q, extensionDataset(), opt)
			if err != nil || before == other.SQL {
				t.Fatalf("different candidate fields must compile to different statements: %v", err)
			}
		})
	}
}

func TestCandidateProjectionWithoutDimensionsAndPublicIR(t *testing.T) {
	q := parse(t, `{"version":1,"dataset":"d","measures":[{"field":"amount","agg":"sum"}],"having":{"field":"amount","op":"gt","value":100}}`)
	q.Candidates = &CandidateProjection{Field: "name"}
	compiled, err := Compile(q, extensionDataset(), options())
	if err != nil || !strings.Contains(compiled.SQL, "CROSS JOIN") {
		t.Fatalf("scalar aggregate must gate every candidate: %+v %v", compiled, err)
	}
	raw, err := json.Marshal(q)
	if err != nil || strings.Contains(string(raw), "Candidates") || strings.Contains(string(raw), "candidates") {
		t.Fatalf("internal projection persisted: %s %v", raw, err)
	}
	decoder := json.NewDecoder(strings.NewReader(`{"version":1,"dataset":"d","candidates":{"Field":"name"}}`))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&Query{}); err == nil {
		t.Fatal("public callers may not supply the internal candidate plan")
	}
}
