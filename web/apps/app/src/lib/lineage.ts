// What reads what in a workspace, as a graph that is cut down to what is
// asked for and laid out in columns. Nothing here draws anything.

export type LineageKind = 'datasource' | 'table' | 'dataset' | 'chart' | 'dashboard'

/** The kinds from what is read first to what is read last: the columns, left to right. */
export const lineageKinds: LineageKind[] = ['datasource', 'table', 'dataset', 'chart', 'dashboard']

export interface LineageNode {
  id: string
  kind: LineageKind
  name: string
  sourceType?: string
}

/** `to` reads `from`. */
export interface LineageEdge {
  from: string
  to: string
}

export interface LineageGraph {
  nodes: LineageNode[]
  edges: LineageEdge[]
}

type Links = Map<string, string[]>

function links(edges: LineageEdge[], towards: 'from' | 'to'): Links {
  const away = towards === 'to' ? 'from' : 'to'
  const out: Links = new Map()
  for (const edge of edges) out.set(edge[away], [...(out.get(edge[away]) ?? []), edge[towards]])
  return out
}

/** Everything reached from `start` by following `next`, `start` itself left out. */
function reach(start: string, next: Links): Set<string> {
  const seen = new Set<string>()
  const queue = [start]
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    for (const other of next.get(id) ?? []) {
      if (!seen.has(other)) {
        seen.add(other)
        queue.push(other)
      }
    }
  }
  return seen
}

/** What a resource reads, directly or through others, and what reads it. */
export function lineageOf(graph: LineageGraph, id: string): { upstream: Set<string>; downstream: Set<string> } {
  return { upstream: reach(id, links(graph.edges, 'from')), downstream: reach(id, links(graph.edges, 'to')) }
}

/**
 * The graph without the kinds left out. What read a resource that is gone is
 * tied to what that resource read, preserving dependencies across hidden columns.
 */
export function withoutKinds(graph: LineageGraph, hidden: ReadonlySet<LineageKind>): LineageGraph {
  if (hidden.size === 0) return graph
  const gone = new Set(graph.nodes.filter((node) => hidden.has(node.kind)).map((node) => node.id))
  const readers = links(graph.edges, 'to')
  const edges = new Map<string, LineageEdge>()
  for (const edge of graph.edges) {
    if (gone.has(edge.from)) continue
    // Past whatever is gone, to the first that stay.
    const ends: string[] = []
    const seen = new Set<string>()
    const queue = [edge.to]
    for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
      if (seen.has(id)) continue
      seen.add(id)
      if (gone.has(id)) queue.push(...(readers.get(id) ?? []))
      else ends.push(id)
    }
    for (const to of ends) edges.set(`${edge.from}>${to}`, { from: edge.from, to })
  }
  return { nodes: graph.nodes.filter((node) => !gone.has(node.id)), edges: [...edges.values()] }
}

/** The graph with only the resources kept, and what ties them to each other. */
export function only(graph: LineageGraph, kept: ReadonlySet<string>): LineageGraph {
  return { nodes: graph.nodes.filter((node) => kept.has(node.id)), edges: graph.edges.filter((edge) => kept.has(edge.from) && kept.has(edge.to)) }
}

/**
 * Resources nothing reads. A dashboard is what everything is for, so it is
 * never one of them.
 */
export function unread(graph: LineageGraph): Set<string> {
  const read = new Set(graph.edges.map((edge) => edge.from))
  return new Set(graph.nodes.filter((node) => node.kind !== 'dashboard' && !read.has(node.id)).map((node) => node.id))
}

/** The resources whose names hold the text, whatever the case. Those without a name to show match nothing. */
export function named(graph: LineageGraph, text: string): Set<string> {
  const wanted = text.trim().toLowerCase()
  return new Set(graph.nodes.filter((node) => node.name.toLowerCase().includes(wanted)).map((node) => node.id))
}

/** The resources with everything up and down from each of them. */
export function withLineage(graph: LineageGraph, ids: Iterable<string>): Set<string> {
  const up = links(graph.edges, 'from')
  const down = links(graph.edges, 'to')
  const out = new Set<string>()
  for (const id of ids) {
    out.add(id)
    for (const other of reach(id, up)) out.add(other)
    for (const other of reach(id, down)) out.add(other)
  }
  return out
}

/**
 * What folding puts away: a resource goes when everything it reads is folded
 * or has itself gone. One that is also read through something still open
 * stays. The count beside each folded resource is how much went under it.
 */
export function foldedAway(graph: LineageGraph, folded: ReadonlySet<string>): { hidden: Set<string>; counts: Map<string, number> } {
  const reads = links(graph.edges, 'from')
  const hidden = new Set<string>()
  // Columns in order: what a resource reads is settled before the resource is.
  const ordered = [...graph.nodes].sort((a, b) => lineageKinds.indexOf(a.kind) - lineageKinds.indexOf(b.kind))
  for (const node of ordered) {
    const sources = reads.get(node.id) ?? []
    if (sources.length > 0 && sources.every((source) => folded.has(source) || hidden.has(source))) hidden.add(node.id)
  }
  const down = links(graph.edges, 'to')
  const counts = new Map<string, number>()
  for (const id of folded) {
    if (hidden.has(id)) continue
    counts.set(id, [...reach(id, down)].filter((other) => hidden.has(other)).length)
  }
  return { hidden, counts }
}

export interface LineageColumn {
  kind: LineageKind
  nodes: LineageNode[]
}

/**
 * The resources in columns by kind, each column ordered so that the lines
 * between neighbours cross as little as a few passes can manage: a resource
 * is put at the middle of what it is tied to in the columns already placed.
 */
export function columnsOf(graph: LineageGraph): LineageColumn[] {
  const columns = lineageKinds
    .map((kind) => ({ kind, nodes: graph.nodes.filter((node) => node.kind === kind).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)) }))
    .filter((column) => column.nodes.length > 0)
  const reads = links(graph.edges, 'from')
  const readBy = links(graph.edges, 'to')
  // Where each resource is in its column, from 0 to 1, so that columns of different lengths compare.
  const place = new Map<string, number>()
  const settle = (column: LineageColumn) => column.nodes.forEach((node, index) => place.set(node.id, column.nodes.length === 1 ? 0.5 : index / (column.nodes.length - 1)))
  columns.forEach(settle)
  const sweep = (order: LineageColumn[], ties: Links) => {
    for (const column of order) {
      const middle = new Map(
        column.nodes.map((node) => {
          const others = (ties.get(node.id) ?? []).map((id) => place.get(id)).filter((at): at is number => at !== undefined)
          return [node.id, others.length > 0 ? others.reduce((sum, at) => sum + at, 0) / others.length : place.get(node.id)!]
        }),
      )
      // The sort is stable: resources tied to the same things keep their order by name.
      column.nodes.sort((a, b) => middle.get(a.id)! - middle.get(b.id)!)
      settle(column)
    }
  }
  for (let pass = 0; pass < 3; pass++) {
    sweep(columns.slice(1), reads)
    sweep(columns.slice(0, -1).reverse(), readBy)
  }
  return columns
}
