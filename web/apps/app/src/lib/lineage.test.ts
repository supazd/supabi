import { describe, expect, it } from 'vitest'
import { columnsOf, foldedAway, lineageOf, named, only, unread, withLineage, withoutKinds, type LineageGraph, type LineageKind } from './lineage'

const node = (id: string, kind: LineageKind, name = id) => ({ id, kind, name })
const edge = (from: string, to: string) => ({ from, to })

// Two sources. The orders table feeds a dataset drawn twice; users have no readers.
const graph: LineageGraph = {
  nodes: [node('pg', 'datasource'), node('ck', 'datasource'), node('q', 'table'), node('orders', 'dataset'), node('users', 'dataset'), node('bar', 'chart'), node('pie', 'chart'), node('board', 'dashboard')],
  edges: [edge('pg', 'q'), edge('q', 'orders'), edge('ck', 'users'), edge('orders', 'bar'), edge('orders', 'pie'), edge('bar', 'board')],
}
const ids = (set: Iterable<string>) => [...set].sort()

describe('lineage', () => {
  it('finds what a resource reads and what reads it', () => {
    const { upstream, downstream } = lineageOf(graph, 'orders')
    expect(ids(upstream)).toEqual(['pg', 'q'])
    expect(ids(downstream)).toEqual(['bar', 'board', 'pie'])
  })

  it('ties readers to what a kind left out was reading', () => {
    const cut = withoutKinds(graph, new Set<LineageKind>(['table', 'chart']))
    expect(cut.nodes.map((n) => n.id)).not.toContain('q')
    expect(cut.edges).toContainEqual(edge('pg', 'orders'))
    expect(cut.edges).toContainEqual(edge('orders', 'board'))
    expect(cut.edges).toHaveLength(3)
  })

  it('has tables between a source and what reads them, and does without them', () => {
    const withTables: LineageGraph = {
      nodes: [node('pg', 'datasource'), node('t', 'table'), node('orders', 'dataset'), node('users', 'dataset')],
      edges: [edge('pg', 't'), edge('t', 'orders'), edge('t', 'users')],
    }
    expect(columnsOf(withTables).map((column) => column.kind)).toEqual(['datasource', 'table', 'dataset'])
    const cut = withoutKinds(withTables, new Set<LineageKind>(['table']))
    expect(cut.edges.map((e) => `${e.from}>${e.to}`).sort()).toEqual(['pg>orders', 'pg>users'])
  })

  it('knows what nothing reads, dashboards aside', () => {
    expect(ids(unread(graph))).toEqual(['pie', 'users'])
  })

  it('keeps what matches a name with all that leads to and from it', () => {
    expect(ids(named(graph, 'PIE'))).toEqual(['pie'])
    const kept = withLineage(graph, named(graph, 'pie'))
    expect(ids(kept)).toEqual(['orders', 'pg', 'pie', 'q'])
    expect(only(graph, kept).edges).toHaveLength(3)
  })

  it('puts away what is read only through what is folded', () => {
    const { hidden, counts } = foldedAway(graph, new Set(['orders']))
    expect(ids(hidden)).toEqual(['bar', 'board', 'pie'])
    expect(counts.get('orders')).toBe(3)
  })

  it('keeps what is also read through something open', () => {
    const both = { nodes: [...graph.nodes, node('line', 'chart')], edges: [...graph.edges, edge('users', 'line'), edge('line', 'board')] }
    expect(ids(foldedAway(both, new Set(['orders'])).hidden)).toEqual(['bar', 'pie'])
  })

  it('lays the kinds out in columns, in reading order', () => {
    const columns = columnsOf(graph)
    expect(columns.map((column) => column.kind)).toEqual(['datasource', 'table', 'dataset', 'chart', 'dashboard'])
    // ck comes first by name, and so does what reads it.
    expect(columns[0]!.nodes.map((n) => n.id)).toEqual(['ck', 'pg'])
    expect(columns[2]!.nodes.map((n) => n.id)).toEqual(['users', 'orders'])
  })
})
