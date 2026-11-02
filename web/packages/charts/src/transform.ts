// Turns a query result into the series a chart draws. No rendering library is
// involved here, which keeps the rules (pivoting, folding into "other")
// testable and shared by every renderer.
import { formatCategory } from './format'
import type { Cell, QueryResult, ResultColumn } from './result'
import { ChartSpecError, type Highlight, type Viz } from './spec'

/** The palette has this many colours, and colours are never reused for another series. */
export const maxSeries = 8

export interface Series {
  name: string
  data: (number | null)[]
  /** The measure the values are of, which says how to write them. */
  column?: ResultColumn
}

export interface CartesianData {
  categories: string[]
  /** The category values as the query returned them, for selecting one. */
  raw: Cell[]
  series: Series[]
}

export interface Slice {
  name: string
  value: number
  /** The category value as the query returned it; absent for the slice that gathers the rest. */
  raw?: Cell
}

const numericTypes = new Set<ResultColumn['type']>(['integer', 'decimal', 'float'])

export function toNumber(cell: Cell | undefined): number | null {
  if (cell === null || cell === undefined || typeof cell === 'boolean') return null
  const n = typeof cell === 'number' ? cell : Number(cell)
  return Number.isFinite(n) ? n : null
}

const compare = { lt: (a: number, b: number) => a < b, lte: (a: number, b: number) => a <= b, gt: (a: number, b: number) => a > b, gte: (a: number, b: number) => a >= b, eq: (a: number, b: number) => a === b, ne: (a: number, b: number) => a !== b }

/** The rule of a conditional format a value meets: the first that does. An empty value meets none, nor does empty text, which is not 0. */
export function highlightOf(rules: Highlight[] | undefined, cell: Cell | undefined): Highlight | undefined {
  const value = rules?.length && cell !== '' ? toNumber(cell) : null
  return value === null ? undefined : rules!.find((rule) => compare[rule.op](value, rule.value))
}

/**
 * Names a category by its value and the column it is in. Values written alike
 * stay apart: categories and series are told apart by the value, not its name.
 */
export type Labeler = (cell: Cell | undefined, column: ResultColumn) => string

const plainLabel: Labeler = (cell, column) => formatCategory(cell, column)

const keyOf = (cells: Cell[]) => JSON.stringify(cells)

/** A value as a key: text as it is, anything else marked so it is not taken for text. */
const valueKey = (cell: Cell | undefined) => (typeof cell === 'string' ? cell : `\u0002${JSON.stringify(cell ?? null)}`)

function columnIndex(result: QueryResult, name: string): number {
  const index = result.columns.findIndex((column) => column.name === name)
  if (index < 0) throw new ChartSpecError('unknown_column', name)
  return index
}

function measureIndex(result: QueryResult, name: string): number {
  const index = columnIndex(result, name)
  if (!numericTypes.has(result.columns[index]!.type)) throw new ChartSpecError('non_numeric_series', name)
  return index
}

const total = (values: (number | null)[]) => values.reduce<number>((sum, value) => sum + Math.abs(value ?? 0), 0)

/** Keeps the largest series and adds the rest up into one, so there are at most maxSeries. */
function foldSeries(series: Series[], otherLabel: string): Series[] {
  if (series.length <= maxSeries) return series
  const ranked = [...series].sort((a, b) => total(b.data) - total(a.data))
  const kept = new Set(ranked.slice(0, maxSeries - 1))
  const rest = series.filter((item) => !kept.has(item))
  const other: Series = {
    name: otherLabel,
    data: rest[0]!.data.map((_, i) => {
      const values = rest.map((item) => item.data[i] ?? null).filter((value): value is number => value !== null)
      return values.length ? values.reduce((sum, value) => sum + value, 0) : null
    }),
  }
  // Original order is kept so a series does not jump around when the data changes slightly.
  return [...series.filter((item) => kept.has(item)), other]
}

/** Data for bar, line and area charts. */
export function toCartesian(viz: Viz, result: QueryResult, otherLabel: string, label: Labeler = plainLabel): CartesianData {
  if (!viz.x) throw new ChartSpecError('unknown_column', '')
  if (!viz.y?.length) throw new ChartSpecError('no_series')
  const x = columnIndex(result, viz.x)
  const xColumn = result.columns[x]!

  if (!viz.series) {
    return {
      categories: result.rows.map((row) => label(row[x], xColumn)),
      raw: result.rows.map((row) => row[x] ?? null),
      series: viz.y.map((name) => {
        const index = measureIndex(result, name)
        const column = result.columns[index]!
        return { name: column.label ?? column.name, data: result.rows.map((row) => toNumber(row[index])), column }
      }),
    }
  }

  // One row per (category, series value): pivot the series values into columns.
  const split = columnIndex(result, viz.series)
  const splitColumn = result.columns[split]!
  const measure = measureIndex(result, viz.y[0]!)
  const categories: string[] = []
  const raw: Cell[] = []
  const position = new Map<string, number>()
  const bySeries = new Map<string, { name: string; values: Map<number, number | null> }>()
  for (const row of result.rows) {
    const category = keyOf([row[x] ?? null])
    if (!position.has(category)) {
      position.set(category, categories.length)
      categories.push(label(row[x], xColumn))
      raw.push(row[x] ?? null)
    }
    const key = keyOf([row[split] ?? null])
    if (!bySeries.has(key)) bySeries.set(key, { name: label(row[split], splitColumn), values: new Map() })
    bySeries.get(key)!.values.set(position.get(category)!, toNumber(row[measure]))
  }
  const series = [...bySeries.values()].map(({ name, values }) => ({ name, data: categories.map((_, i) => values.get(i) ?? null) }))
  const column = result.columns[measure]
  return { categories, raw, series: foldSeries(series, otherLabel).map((item) => ({ ...item, column })) }
}

/** Data for a pie chart: positive values only, largest first, folded into at most maxSeries slices. */
export function toSlices(viz: Viz, result: QueryResult, otherLabel: string, label: Labeler = plainLabel): Slice[] {
  if (!viz.x) throw new ChartSpecError('unknown_column', '')
  if (!viz.y?.length) throw new ChartSpecError('no_series')
  const x = columnIndex(result, viz.x)
  const measure = measureIndex(result, viz.y[0]!)
  const slices = result.rows
    .map((row): Slice => ({ name: label(row[x], result.columns[x]!), value: toNumber(row[measure]) ?? 0, raw: row[x] ?? null }))
    .filter((slice) => slice.value > 0)
    .sort((a, b) => b.value - a.value)
  if (slices.length <= maxSeries) return slices
  const rest = slices.slice(maxSeries - 1)
  return [...slices.slice(0, maxSeries - 1), { name: otherLabel, value: rest.reduce((sum, slice) => sum + slice.value, 0) }]
}

export interface Tile {
  label: string
  /** Kept as received so a decimal keeps every digit. */
  value: Cell
  column: ResultColumn
}

/** Data for KPI tiles: the first row of each measure. */
export function toTiles(viz: Viz, result: QueryResult): Tile[] {
  if (!viz.y?.length) throw new ChartSpecError('no_series')
  return viz.y.map((name) => {
    const index = columnIndex(result, name)
    const column = result.columns[index]!
    return { label: column.label ?? column.name, value: result.rows[0]?.[index] ?? null, column }
  })
}

/**
 * A scatter chart's points can sit next to any other, so only the first three
 * colours stay apart for every pair; series past them are gathered into one,
 * drawn in a neutral colour.
 */
export const maxScatterSeries = 3

export interface Point {
  /** The category value naming the point. */
  name: string
  /** Horizontal, vertical and, for a bubble, size. */
  value: [number, number] | [number, number, number]
}

export interface ScatterSeries {
  name: string
  points: Point[]
  /** The series gathering what does not fit the palette. */
  other?: true
}

export interface ScatterData {
  series: ScatterSeries[]
  /** The measures along each axis, and the one sizing the bubbles. */
  columns: { x: ResultColumn; y: ResultColumn; size?: ResultColumn }
}

/** Data for a scatter chart: a point per row, with no value for either axis left out. */
export function toScatter(viz: Viz, result: QueryResult, otherLabel: string, label: Labeler = plainLabel): ScatterData {
  if (!viz.x) throw new ChartSpecError('unknown_column', '')
  if (!viz.y || viz.y.length < 2) throw new ChartSpecError('no_series')
  const name = columnIndex(result, viz.x)
  const [h, v, s] = viz.y.map((column) => measureIndex(result, column))
  const split = viz.series ? columnIndex(result, viz.series) : undefined
  const groups = new Map<string, ScatterSeries>()
  for (const row of result.rows) {
    const x = toNumber(row[h!])
    const y = toNumber(row[v!])
    if (x === null || y === null) continue
    const value: Point['value'] = s === undefined ? [x, y] : [x, y, Math.max(0, toNumber(row[s]) ?? 0)]
    const group = split === undefined ? '' : keyOf([row[split] ?? null])
    if (!groups.has(group)) groups.set(group, { name: split === undefined ? '' : label(row[split], result.columns[split]!), points: [] })
    groups.get(group)!.points.push({ name: label(row[name], result.columns[name]!), value })
  }
  let series: ScatterSeries[] = [...groups.values()]
  if (series.length > maxScatterSeries) {
    const kept = new Set([...series].sort((a, b) => b.points.length - a.points.length).slice(0, maxScatterSeries))
    series = [...series.filter((item) => kept.has(item)), { name: otherLabel, points: series.filter((item) => !kept.has(item)).flatMap((item) => item.points), other: true }]
  }
  return { series, columns: { x: result.columns[h!]!, y: result.columns[v!]!, ...(s === undefined ? {} : { size: result.columns[s] }) } }
}

export interface Stage {
  name: string
  value: number
  /** Of the first stage, which is the largest. */
  share: number
  raw: Cell
}

/** Data for a funnel: every stage, largest first. A stage is never folded away. */
export function toStages(viz: Viz, result: QueryResult, label: Labeler = plainLabel): Stage[] {
  if (!viz.x) throw new ChartSpecError('unknown_column', '')
  if (!viz.y?.length) throw new ChartSpecError('no_series')
  const x = columnIndex(result, viz.x)
  const measure = measureIndex(result, viz.y[0]!)
  const stages = result.rows
    .map((row) => ({ name: label(row[x], result.columns[x]!), value: Math.max(0, toNumber(row[measure]) ?? 0), raw: row[x] ?? null }))
    .sort((a, b) => b.value - a.value)
  const first = stages[0]?.value ?? 0
  return stages.map((stage) => ({ ...stage, share: first > 0 ? stage.value / first : 0 }))
}

export interface TreemapNode {
  name: string
  value: number
  children?: TreemapNode[]
}

/**
 * Data for a treemap: tiles by the category, grouped by the series when there
 * is one. Groups past the palette are gathered into one, as series are.
 */
export function toTreemap(viz: Viz, result: QueryResult, otherLabel: string, label: Labeler = plainLabel): TreemapNode[] {
  if (!viz.x) throw new ChartSpecError('unknown_column', '')
  if (!viz.y?.length) throw new ChartSpecError('no_series')
  const x = columnIndex(result, viz.x)
  const measure = measureIndex(result, viz.y[0]!)
  const leaf = (row: Cell[]): TreemapNode => ({ name: label(row[x], result.columns[x]!), value: Math.max(0, toNumber(row[measure]) ?? 0) })
  if (!viz.series) return result.rows.map(leaf).filter((tile) => tile.value > 0)
  const split = columnIndex(result, viz.series)
  const groups = new Map<string, { name: string; children: TreemapNode[] }>()
  for (const row of result.rows) {
    const tile = leaf(row)
    if (tile.value <= 0) continue
    const group = keyOf([row[split] ?? null])
    if (!groups.has(group)) groups.set(group, { name: label(row[split], result.columns[split]!), children: [] })
    groups.get(group)!.children.push(tile)
  }
  const sum = (tiles: TreemapNode[]) => tiles.reduce((total, tile) => total + tile.value, 0)
  const tiles = [...groups.values()].map(({ name, children }) => ({ name, value: sum(children), children })).sort((a, b) => b.value - a.value)
  if (tiles.length <= maxSeries) return tiles
  const rest = tiles.slice(maxSeries - 1)
  const children = rest.flatMap((group) => group.children.map((child) => ({ ...child, name: `${group.name} · ${child.name}` })))
  return [...tiles.slice(0, maxSeries - 1), { name: otherLabel, value: sum(children), children }]
}

export interface HeatmapData {
  columns: string[]
  rows: string[]
  /** Column index, row index and value of each cell that has one. */
  cells: [number, number, number][]
  min: number
  max: number
  column: ResultColumn
}

/** Data for a heatmap: a cell for each pair of row and column values. */
export function toHeatmap(viz: Viz, result: QueryResult, label: Labeler = plainLabel): HeatmapData {
  const [rowName] = viz.rows ?? []
  const [columnName] = viz.columns ?? []
  if (!rowName || !columnName) throw new ChartSpecError('unknown_column', '')
  if (!viz.y?.length) throw new ChartSpecError('no_series')
  const r = columnIndex(result, rowName)
  const c = columnIndex(result, columnName)
  const measure = measureIndex(result, viz.y[0]!)
  const rows: string[] = []
  const columns: string[] = []
  const positions = { rows: new Map<string, number>(), columns: new Map<string, number>() }
  const at = (side: 'rows' | 'columns', cell: Cell | undefined, column: ResultColumn) => {
    const key = keyOf([cell ?? null])
    const list = side === 'rows' ? rows : columns
    if (!positions[side].has(key)) positions[side].set(key, list.push(label(cell, column)) - 1)
    return positions[side].get(key)!
  }
  const cells: [number, number, number][] = []
  for (const row of result.rows) {
    const ci = at('columns', row[c], result.columns[c]!)
    const ri = at('rows', row[r], result.columns[r]!)
    const value = toNumber(row[measure])
    if (value !== null) cells.push([ci, ri, value])
  }
  const values = cells.map((cell) => cell[2])
  return { columns, rows, cells, min: values.length ? Math.min(...values) : 0, max: values.length ? Math.max(...values) : 0, column: result.columns[measure]! }
}

export interface GaugeData {
  value: number | null
  /** The second measure, where the scale ends. */
  target?: number | null
  column: ResultColumn
  label: string
}

/** Data for a gauge: the first row of its measure and of its target. */
export function toGauge(viz: Viz, result: QueryResult): GaugeData {
  if (!viz.y?.length) throw new ChartSpecError('no_series')
  const index = measureIndex(result, viz.y[0]!)
  const column = result.columns[index]!
  const target = viz.y[1] === undefined ? undefined : toNumber(result.rows[0]?.[measureIndex(result, viz.y[1])])
  return { value: toNumber(result.rows[0]?.[index]), ...(viz.y[1] === undefined ? {} : { target }), column, label: column.label ?? column.name }
}

/**
 * A row or a column of a pivot table: the values of the first `depth` of its
 * dimensions. One with a value of each is the data; one with fewer is the
 * subtotal of a group of the outer ones, and one with none the total.
 */
export interface PivotLine {
  key: Cell[]
  depth: number
}

export interface PivotData {
  /** The dimensions down the side and across the top, and the measures in each cell. */
  rows: ResultColumn[]
  columns: ResultColumn[]
  measures: ResultColumn[]
  /**
   * The rows in the order the query gave them, kept together by the values
   * of the outer dimensions when there are subtotals, each group followed
   * by its subtotal and the whole by the total (the bottom row).
   */
  rowLines: PivotLine[]
  /** The columns in order of their values, each group followed by its subtotal and the whole by the total (the right-hand column). */
  columnLines: PivotLine[]
  /** By row line, column line and measure; undefined where the database has no such value. */
  cells: (Cell | undefined)[][][]
}

/** Orders values the way people read them: numbers by size, text alphabetically, nothing last. */
function compareCells(a: Cell, b: Cell): number {
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1
  const x = toNumber(a)
  const y = toNumber(b)
  if (x !== null && y !== null && typeof a !== 'string' && typeof b !== 'string') return x - y
  return String(a).localeCompare(String(b))
}

/**
 * Data for a pivot table: the rows by their row values, spread across by the
 * column values. Totals and subtotals are the database's (see QueryTotal),
 * never added up here, so an average or a count of distinct values is right;
 * there is a line for each the query asked for. A total is found by the
 * dimensions it is grouped by, in whatever order it lists them.
 */
export function toPivot(viz: Viz, result: QueryResult): PivotData {
  const rowNames = viz.rows ?? []
  const columnNames = viz.columns ?? []
  if (!viz.y?.length) throw new ChartSpecError('no_series')
  const r = rowNames.map((name) => columnIndex(result, name))
  const c = columnNames.map((name) => columnIndex(result, name))
  const m = viz.y.map((name) => columnIndex(result, name))
  const rowKeys: Cell[][] = []
  const columnKeys: Cell[][] = []
  const seen = new Set<string>()
  const add = (keys: Cell[][], key: Cell[], side: string) => {
    if (seen.has(side + keyOf(key))) return
    seen.add(side + keyOf(key))
    keys.push(key)
  }
  const values = new Map<string, Cell[]>()
  for (const row of result.rows) {
    const rowKey = r.map((i) => row[i] ?? null)
    const columnKey = c.map((i) => row[i] ?? null)
    add(rowKeys, rowKey, 'row')
    add(columnKeys, columnKey, 'column')
    values.set(keyOf([...rowKey, ...columnKey]), m.map((i) => row[i] ?? null))
  }

  // A total by the first so many row and column dimensions, looked up by their values in that order.
  const totals = new Map<string, Map<string, (Cell | undefined)[]> | undefined>()
  const total = (rowDepth: number, columnDepth: number) => {
    if (rowDepth === rowNames.length && columnDepth === columnNames.length) return values
    const id = `${rowDepth}:${columnDepth}`
    if (!totals.has(id)) {
      const names = [...rowNames.slice(0, rowDepth), ...columnNames.slice(0, columnDepth)]
      const found = result.totals?.find((item) => item.by.length === names.length && names.every((name) => item.by.includes(name)))
      const at = names.map((name) => found?.columns.findIndex((column) => column.name === name) ?? -1)
      const measures = viz.y!.map((name) => found?.columns.findIndex((column) => column.name === name) ?? -1)
      totals.set(id, found && new Map(found.rows.map((row) => [keyOf(at.map((i) => row[i] ?? null)), measures.map((i) => (i < 0 ? undefined : (row[i] ?? null)))])))
    }
    return totals.get(id)
  }
  // A line of totals across is there when the database gave the totals under the data columns; one down, beside the data rows.
  const rowDepths = range(rowNames.length).filter((depth) => total(depth, columnNames.length))
  const columnDepths = range(columnNames.length).filter((depth) => total(rowNames.length, depth))

  // The rows keep the order the query gave them, which may be by a measure, but with subtotals a group is kept together, in the order its first row came.
  if (rowDepths.some((depth) => depth > 0)) {
    const order = new Map<string, number>()
    for (const [i, key] of rowKeys.entries()) for (let depth = 1; depth < key.length; depth++) if (!order.has(keyOf(key.slice(0, depth)))) order.set(keyOf(key.slice(0, depth)), i)
    const rank = (key: Cell[]) => range(key.length).slice(1).map((depth) => order.get(keyOf(key.slice(0, depth)))!)
    const at = new Map(rowKeys.map((key, i) => [key, i]))
    rowKeys.sort((a, b) => rank(a).reduce<number>((first, n, i) => first || n - rank(b)[i]!, 0) || at.get(a)! - at.get(b)!)
  }
  // The columns read in order of their values.
  columnKeys.sort((a, b) => a.reduce<number>((order, cell, i) => order || compareCells(cell, b[i]!), 0))

  const rowLines = withSubtotals(rowKeys, rowNames.length, rowDepths)
  const columnLines = withSubtotals(columnKeys, columnNames.length, columnDepths)
  return {
    rows: r.map((i) => result.columns[i]!),
    columns: c.map((i) => result.columns[i]!),
    measures: m.map((i) => result.columns[i]!),
    rowLines,
    columnLines,
    cells: rowLines.map((row) => columnLines.map((column) => total(row.depth, column.depth)?.get(keyOf([...row.key, ...column.key])) ?? m.map(() => undefined))),
  }
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i)

/**
 * How many rows each cell of a table spans when equal values are merged, by
 * column shown: a run of equal values in a dimension column is one cell,
 * within the runs of the dimension columns before it, and a cell covered by
 * the one above spans none. Measures are not merged and do not end a run, so
 * they have no spans. Each column comes with where its values are in a row.
 */
export function toMergedSpans(columns: { column: ResultColumn; index: number }[], rows: Cell[][]): (number[] | undefined)[] {
  const dimensions = columns.flatMap(({ column, index }, at) => (column.role === 'dimension' ? [{ at, index }] : []))
  // The first dimension a row differs in from the row above: a new cell starts there and in every dimension after it.
  const breaks = rows.map((row, r) => {
    if (r === 0) return 0
    const at = dimensions.findIndex(({ index }) => row[index] !== rows[r - 1]![index])
    return at < 0 ? dimensions.length : at
  })
  const spans: (number[] | undefined)[] = columns.map(() => undefined)
  dimensions.forEach(({ at }, d) => {
    const counts = rows.map(() => 0)
    let start = 0
    breaks.forEach((first, r) => {
      if (first <= d) start = r
      counts[start]!++
    })
    spans[at] = counts
  })
  return spans
}

/**
 * The keys, which have `full` values each: each run sharing its first `depth`
 * values is followed by its subtotal, for each of the depths given above
 * zero, deepest first, and all of them by the total when zero is given.
 */
function withSubtotals(keys: Cell[][], full: number, depths: number[]): PivotLine[] {
  const lines: PivotLine[] = []
  const inner = depths.filter((depth) => depth > 0).sort((a, b) => b - a)
  keys.forEach((key, i) => {
    lines.push({ key, depth: full })
    const next = keys[i + 1]
    for (const depth of inner) {
      if (next === undefined || keyOf(next.slice(0, depth)) !== keyOf(key.slice(0, depth))) lines.push({ key: key.slice(0, depth), depth })
    }
  })
  if (depths.includes(0)) lines.push({ key: [], depth: 0 })
  return lines
}

/** A KPI tile and what it is compared against. */
export interface ComparedTile extends Tile {
  reference?: { label: string; value: Cell; column: ResultColumn }
}

/** KPI tiles with their comparisons. A measure compared against is not a tile of its own. */
export function toComparedTiles(viz: Viz, result: QueryResult): ComparedTile[] {
  const references = new Set(Object.values(viz.compare ?? {}))
  const tiles = toTiles(viz, result)
  return tiles
    .filter((tile) => !references.has(tile.column.name))
    .map((tile) => {
      const name = viz.compare?.[tile.column.name]
      const reference = name === undefined ? undefined : tiles.find((other) => other.column.name === name)
      return reference ? { ...tile, reference: { label: reference.label, value: reference.value, column: reference.column } } : tile
    })
}

/** The most nodes of a sankey diagram's later levels; the first, which is coloured, holds no more than the palette. */
export const maxSankeyNodes = 12

export interface SankeyNode {
  /** The level and the value, as one value can be at two levels. */
  id: string
  name: string
  level: number
  value: number
  /** The node that gathers what does not fit. */
  other?: true
}

export interface SankeyLink {
  source: string
  target: string
  value: number
}

export interface SankeyData {
  nodes: SankeyNode[]
  links: SankeyLink[]
  /** The flow out of the first level, which shares are of. */
  whole: number
  column: ResultColumn
}

/**
 * Data for a sankey diagram: a flow from each value of a level to each value
 * of the next. With more than two levels, the flows between two neighbouring
 * levels are the database's totals of that pair (QueryTotal), so they are
 * right whatever the measure; only where the totals are missing are the rows
 * added up. A flow must be positive to be drawn. Each level keeps its largest
 * values and gathers the rest into one node.
 */
export function toSankey(viz: Viz, result: QueryResult, otherLabel: string, label: Labeler = plainLabel): SankeyData {
  const levels = viz.levels ?? []
  if (levels.length < 2) throw new ChartSpecError('unknown_column', levels[0] ?? '')
  if (!viz.y?.length) throw new ChartSpecError('no_series')
  const measure = measureIndex(result, viz.y[0]!)
  levels.forEach((name) => columnIndex(result, name))

  // The flows between levels i and i + 1, by their values, and what each value of a level is called.
  const names = levels.map(() => new Map<string, string>())
  const flows = levels.slice(1).map((_, i) => {
    const pair = [levels[i]!, levels[i + 1]!]
    const total = levels.length > 2 ? result.totals?.find((item) => item.by.length === 2 && pair.every((name) => item.by.includes(name))) : undefined
    const source = total ?? result
    const [from, to] = pair.map((name) => source.columns.findIndex((column) => column.name === name))
    const value = total ? total.columns.findIndex((column) => column.name === viz.y![0]) : measure
    const out = new Map<string, Map<string, number>>()
    for (const row of source.rows) {
      const amount = toNumber(row[value]) ?? 0
      const a = valueKey(row[from!])
      const b = valueKey(row[to!])
      if (!names[i]!.has(a)) names[i]!.set(a, label(row[from!], source.columns[from!]!))
      if (!names[i + 1]!.has(b)) names[i + 1]!.set(b, label(row[to!], source.columns[to!]!))
      if (!out.has(a)) out.set(a, new Map())
      out.get(a)!.set(b, (out.get(a)!.get(b) ?? 0) + amount)
    }
    return out
  })

  // How much passes through each value of each level: what goes out of it, or comes in at the last.
  const through = levels.map(() => new Map<string, number>())
  flows.forEach((flow, i) => {
    for (const [a, targets] of flow) {
      for (const [b, amount] of targets) {
        if (amount <= 0) continue
        through[i]!.set(a, (through[i]!.get(a) ?? 0) + amount)
        if (i === flows.length - 1) through[i + 1]!.set(b, (through[i + 1]!.get(b) ?? 0) + amount)
      }
    }
  })
  const kept = through.map((values, level) => {
    const most = level === 0 ? maxSeries : maxSankeyNodes
    const ranked = [...values].sort((a, b) => b[1] - a[1]).map(([name]) => name)
    return new Set(ranked.length <= most ? ranked : ranked.slice(0, most - 1))
  })
  const idOf = (level: number, name: string) => `${level}:${kept[level]!.has(name) ? name : '\u0000other'}`

  const links = new Map<string, SankeyLink>()
  flows.forEach((flow, i) => {
    for (const [a, targets] of flow) {
      for (const [b, amount] of targets) {
        if (amount <= 0) continue
        const source = idOf(i, a)
        const target = idOf(i + 1, b)
        const key = `${source}\u0001${target}`
        const link = links.get(key) ?? { source, target, value: 0 }
        link.value += amount
        links.set(key, link)
      }
    }
  })
  // A node is as large as what passes through it: the larger of what comes in and what goes out.
  const sums = new Map<string, { in: number; out: number }>()
  for (const link of links.values()) {
    const s = sums.get(link.source) ?? { in: 0, out: 0 }
    const t = sums.get(link.target) ?? { in: 0, out: 0 }
    s.out += link.value
    t.in += link.value
    sums.set(link.source, s)
    sums.set(link.target, t)
  }
  const keyIn = (id: string) => id.slice(id.indexOf(':') + 1)
  const nodes = [...sums].map(([id, sum]): SankeyNode => {
    const level = Number(id.slice(0, id.indexOf(':')))
    const other = keyIn(id) === '\u0000other'
    return { id, name: other ? otherLabel : names[level]!.get(keyIn(id))!, level, value: Math.max(sum.in, sum.out), ...(other ? { other: true as const } : {}) }
  })
  const whole = [...links.values()].filter((link) => link.source.startsWith('0:')).reduce((total, link) => total + link.value, 0)
  // The first level stays in the order its values came, so each keeps its colour when the numbers change; later ones are largest first.
  const order = [...through[0]!.keys()]
  const rank = (node: SankeyNode) => (node.level === 0 ? order.indexOf(keyIn(node.id)) : -node.value)
  return { nodes: nodes.sort((a, b) => a.level - b.level || (a.other ? 1 : 0) - (b.other ? 1 : 0) || rank(a) - rank(b)), links: [...links.values()], whole, column: result.columns[measure]! }
}
