package api

import (
	"context"
	"slices"
	"sort"

	"github.com/supazd/supabi/internal/api/gen"
	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/dialect"
	"github.com/supazd/supabi/internal/sqlrefs"
	"github.com/supazd/supabi/internal/store"
)

func (s *Server) GetLineage(ctx context.Context, _ gen.GetLineageRequestObject) (gen.GetLineageResponseObject, error) {
	scope := s.scope(ctx)
	lineage, err := store.GetLineage(ctx, s.Pool, scope)
	if err != nil {
		return nil, err
	}
	lineage = withTables(lineage)
	out := gen.GetLineage200JSONResponse{Nodes: make([]gen.LineageNode, len(lineage.Nodes)), Edges: make([]gen.LineageEdge, len(lineage.Edges))}
	for i, n := range lineage.Nodes {
		node := gen.LineageNode{Id: n.ID, Kind: gen.LineageNodeKind(n.Kind), Name: n.Name}
		if n.SourceType != "" {
			node.SourceType = &n.SourceType
		}
		out.Nodes[i] = node
	}
	for i, e := range lineage.Edges {
		out.Edges[i] = gen.LineageEdge{From: e.From, To: e.To}
	}
	return out, nil
}

// tablesOf lists the tables a dataset reads: the one a dataset is
// made of, or those its SQL names. The SQL is read each time rather than the
// tables kept, so that reading it better is all it takes to know better.
func tablesOf(src store.LineageSource) []sqlrefs.Table {
	if src.Table != "" {
		if src.Schema != "" {
			return []sqlrefs.Table{{Path: []string{src.Schema, src.Table}}}
		}
		return []sqlrefs.Table{{Path: []string{src.Table}}}
	}
	// A data source whose driver this build lacks has its SQL read as
	// standard SQL.
	var lexis dialect.Lexis
	if driver, ok := datasource.Lookup(src.DatasourceType); ok {
		lexis = driver.Dialect().Lexis()
	}
	return sqlrefs.Tables(src.SQL, lexis)
}

// withTables puts the tables between the data sources and what reads them.
//
// A table is whatever a dataset names, under the name it is given
// there: orders and public.orders are two tables, since telling that they are
// one would take asking the database.
//
// What reads a table is tied to the data source through it and no longer
// directly; what names no table that could be found stays tied directly. A
// dataset depends only on the tables named by its own saved SQL.
func withTables(l store.Lineage) store.Lineage {
	type table struct{ id, datasourceID, name string }
	tables := map[string]table{}
	reads := map[string][]string{}
	for _, src := range l.Sources {
		for _, t := range tablesOf(src) {
			name := t.String()
			id := "table:" + src.DatasourceID + ":" + name
			tables[id] = table{id: id, datasourceID: src.DatasourceID, name: name}
			if !slices.Contains(reads[src.ID], id) {
				reads[src.ID] = append(reads[src.ID], id)
			}
		}
	}
	if len(tables) == 0 {
		return l
	}

	through := map[store.LineageEdge]bool{}
	for _, src := range l.Sources {
		if len(reads[src.ID]) > 0 {
			through[store.LineageEdge{From: src.DatasourceID, To: src.ID}] = true
		}
	}
	l.Edges = slices.DeleteFunc(l.Edges, func(e store.LineageEdge) bool { return through[e] })

	ordered := make([]table, 0, len(tables))
	for _, t := range tables {
		ordered = append(ordered, t)
	}
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].id < ordered[j].id })
	for _, t := range ordered {
		l.Nodes = append(l.Nodes, store.LineageNode{Kind: store.LineageTable, ID: t.id, Name: t.name})
		l.Edges = append(l.Edges, store.LineageEdge{From: t.datasourceID, To: t.id})
	}
	for _, src := range l.Sources {
		for _, id := range reads[src.ID] {
			l.Edges = append(l.Edges, store.LineageEdge{From: id, To: src.ID})
		}
	}
	return l
}
