import { describe, expect, it } from 'vitest'
import { buildSpec, pruneColumnGroups, type BuilderState } from './builder'
import type { SpecField } from '../api/spec'
import { dropIndex, moveOnShelf, moved, placedOnShelf, shelfKeys } from './shelves'

const fields: SpecField[] = [
  { key: 'region', label: '地区', column: 'region', type: 'string', role: 'dimension' },
  { key: 'channel', label: '渠道', column: 'channel', type: 'string', role: 'dimension' },
  { key: 'status', label: '状态', column: 'status', type: 'string', role: 'dimension' },
  { key: 'revenue', label: '销售额', column: 'amount', type: 'decimal', role: 'measure' },
]
const state = (patch: Partial<BuilderState>): BuilderState => ({ dimensions: [], measures: [], columns: [], labels: {}, grain: 'month', filters: [], vizType: 'table', stacked: false, ...patch })
// What select does after every change.
const apply = (from: BuilderState, patch: Partial<BuilderState> | undefined) => pruneColumnGroups({ ...from, ...patch })

describe('moving on a shelf', () => {
  it('puts an item at a place counted before it leaves, and does nothing where it would stay', () => {
    expect(moved(['a', 'b', 'c'], 0, 3)).toEqual(['b', 'c', 'a'])
    expect(moved(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
    const table = state({ dimensions: ['region', 'channel', 'status'] })
    expect(moveOnShelf(table, 'dimension', 'status', 0)).toEqual({ dimensions: ['status', 'region', 'channel'], columnGroups: undefined })
    expect(moveOnShelf(table, 'dimension', 'channel', 1)).toBeUndefined()
    expect(moveOnShelf(table, 'dimension', 'channel', 2)).toBeUndefined()
    expect(moveOnShelf(table, 'dimension', 'nope', 0)).toBeUndefined()
  })

  it('orders a pivot table’s rows and columns each among their own, keeping the other’s places', () => {
    const pivot = state({ vizType: 'pivot', dimensions: ['region', 'channel', 'status'], pivotColumns: ['channel'], measures: [{ field: 'revenue', agg: 'sum' }] })
    expect(shelfKeys(pivot, 'dimension')).toEqual(['region', 'status'])
    expect(shelfKeys(pivot, 'pivotColumn')).toEqual(['channel'])
    expect(moveOnShelf(pivot, 'dimension', 'status', 0)!.dimensions).toEqual(['status', 'channel', 'region'])
    expect(buildSpec('ds', apply(pivot, moveOnShelf(pivot, 'dimension', 'status', 0)), fields).viz).toMatchObject({ rows: ['status', 'region'], columns: ['channel'] })
  })

  it('orders metrics by their place, keeping each one’s aggregation and name', () => {
    const measures = [{ field: 'revenue', agg: 'sum' as const }, { field: 'revenue', agg: 'avg' as const, alias: 'avg_revenue' }]
    expect(moveOnShelf(state({ measures }), 'metric', 'avg_revenue', 0)!.measures).toEqual([measures[1], measures[0]])
  })

  it('orders filters, which have no columns and so no groups', () => {
    const filters = [{ id: 'a', field: 'region', op: 'in' as const, value: [] }, { id: 'b', field: 'status', op: 'in' as const, value: [] }]
    expect(moveOnShelf(state({ filters }), 'filter', 'a', 2)).toEqual({ filters: [filters[1], filters[0]] })
  })

  it('takes a moved column out of its group, and into the innermost one it lands inside', () => {
    const grouped = state({ vizType: 'detail', columns: ['region', 'channel', 'status', 'revenue'], columnGroups: [{ label: '地区', columns: ['region', 'channel'] }] })
    // Moved to the far end, it leaves the group, which does not stretch over the columns between.
    expect(apply(grouped, moveOnShelf(grouped, 'column', 'region', 4)).columnGroups).toEqual([{ label: '地区', columns: ['channel'] }])
    // At the edge of the group it stays out of it; between two of the group's own it joins.
    expect(apply(grouped, moveOnShelf(grouped, 'column', 'status', 0)).columnGroups).toEqual([{ label: '地区', columns: ['region', 'channel'] }])
    const wider = state({ ...grouped, columnGroups: [{ label: '地区', columns: ['region', 'channel', 'status'] }] })
    expect(apply(wider, moveOnShelf(wider, 'column', 'revenue', 1)).columnGroups).toEqual([{ label: '地区', columns: ['region', 'revenue', 'channel', 'status'] }])
    // The only column of a group taken out takes the group away.
    const alone = state({ ...grouped, columnGroups: [{ label: '状态', columns: ['status'] }] })
    expect(moveOnShelf(alone, 'column', 'status', 0)).toEqual({ columns: ['status', 'region', 'channel', 'revenue'], columnGroups: undefined })
  })

  it('puts what a change adds last at the place it was dropped', () => {
    const table = state({ dimensions: ['region', 'status'] })
    expect(placedOnShelf(table, { dimensions: ['region', 'status', 'channel'] }, 'dimension', 1)).toEqual({ dimensions: ['region', 'channel', 'status'], columnGroups: undefined })
    // Nothing added there, or no place: the change as it is.
    expect(placedOnShelf(table, { dimensions: ['region', 'status'] }, 'dimension', 0)).toEqual({ dimensions: ['region', 'status'] })
    expect(placedOnShelf(table, { dimensions: ['region', 'status', 'channel'] }, 'dimension', undefined)).toEqual({ dimensions: ['region', 'status', 'channel'] })
    // Dropped at the end, it is where it was added.
    expect(placedOnShelf(table, { dimensions: ['region', 'status', 'channel'] }, 'dimension', 2)).toEqual({ dimensions: ['region', 'status', 'channel'] })
    // A pivot table's row dimension dropped across the top keeps its place among all, but is put where it was dropped there.
    const pivot = state({ vizType: 'pivot', dimensions: ['region', 'channel', 'status'], pivotColumns: ['status'] })
    expect(shelfKeys({ ...pivot, ...placedOnShelf(pivot, { pivotColumns: ['status', 'region'] }, 'pivotColumn', 1) }, 'pivotColumn')).toEqual(['status', 'region'])
  })
})

describe('dropIndex', () => {
  // Two rows: a, b, c on the first, d on the second.
  const boxes = [
    { left: 0, right: 40, top: 0, bottom: 24 },
    { left: 48, right: 88, top: 0, bottom: 24 },
    { left: 96, right: 136, top: 0, bottom: 24 },
    { left: 0, right: 40, top: 30, bottom: 54 },
  ]

  it('puts something before the item whose left half the pointer is over, or after it on its right half', () => {
    expect(dropIndex(boxes, 10, 12)).toBe(0)
    expect(dropIndex(boxes, 30, 12)).toBe(1)
    expect(dropIndex(boxes, 44, 12)).toBe(1)
    expect(dropIndex(boxes, 120, 12)).toBe(3)
  })

  it('takes the row nearest the pointer, and after its last item past the end of it', () => {
    expect(dropIndex(boxes, 200, 12)).toBe(3)
    expect(dropIndex(boxes, 10, 42)).toBe(3)
    expect(dropIndex(boxes, 200, 42)).toBe(4)
    // Between the rows, nearer the second; below them all, the last row.
    expect(dropIndex(boxes, 30, 28)).toBe(4)
    expect(dropIndex(boxes, 10, 90)).toBe(3)
    expect(dropIndex([], 10, 10)).toBe(0)
  })
})
