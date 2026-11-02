package api

import (
	"slices"
	"testing"

	"github.com/supazd/supabi/internal/store"
)

func TestWithTables(t *testing.T) {
	l := store.Lineage{
		Nodes: []store.LineageNode{{Kind: store.LineageDatasource, ID: "pg"}, {Kind: store.LineageDatasource, ID: "ch"}},
		Edges: []store.LineageEdge{
			{From: "pg", To: "written"},
			{From: "pg", To: "picked"}, {From: "pg", To: "constant"}, {From: "ch", To: "counted"},
			{From: "written", To: "chart"},
		},
		Sources: []store.LineageSource{
			{ID: "written", DatasourceID: "pg", DatasourceType: "postgres", SQL: `SELECT * FROM shop.orders JOIN users ON true`},
			{ID: "picked", DatasourceID: "pg", DatasourceType: "postgres", Schema: "shop", Table: "orders"},
			{ID: "constant", DatasourceID: "pg", DatasourceType: "postgres", SQL: `SELECT 1`},
			// The same name in another data source is another table.
			{ID: "counted", DatasourceID: "ch", DatasourceType: "clickhouse", SQL: `SELECT * FROM targets JOIN users ON true`},
		},
	}
	got := withTables(l)

	var tables []string
	for _, n := range got.Nodes {
		if n.Kind == store.LineageTable {
			tables = append(tables, n.ID+"="+n.Name)
		}
	}
	wantTables := []string{"table:ch:targets=targets", "table:ch:users=users", "table:pg:shop.orders=shop.orders", "table:pg:users=users"}
	if !slices.Equal(tables, wantTables) {
		t.Errorf("tables = %q, want %q", tables, wantTables)
	}

	var edges []string
	for _, e := range got.Edges {
		edges = append(edges, e.From+">"+e.To)
	}
	slices.Sort(edges)
	wantEdges := []string{
		"ch>table:ch:targets", "ch>table:ch:users",
		"pg>constant",
		"pg>table:pg:shop.orders", "pg>table:pg:users",
		"table:ch:targets>counted", "table:ch:users>counted",
		"table:pg:shop.orders>picked", "table:pg:shop.orders>written", "table:pg:users>written",
		"written>chart",
	}
	if !slices.Equal(edges, wantEdges) {
		t.Errorf("edges = %q, want %q", edges, wantEdges)
	}

	// With no table found, nothing changes.
	bare := store.Lineage{Edges: []store.LineageEdge{{From: "pg", To: "constant"}}, Sources: []store.LineageSource{{ID: "constant", DatasourceID: "pg", DatasourceType: "postgres", SQL: `SELECT 1`}}}
	if got := withTables(bare); len(got.Nodes) != 0 || len(got.Edges) != 1 {
		t.Errorf("lineage without tables = %v", got)
	}
}
