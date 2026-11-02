import { describe, expect, it } from 'vitest'
import { groupsOf, layoutColumns, toHeaderRows } from './columnGroups'
import type { ColumnGroup } from './spec'

const order = ['region', 'province', 'city', 'revenue', 'profit', 'orders', 'price']
const groups: ColumnGroup[] = [
  { label: '地区', columns: ['region', 'province', 'city'] },
  { label: '业绩', columns: [{ label: '金额', columns: ['revenue', 'profit'] }, 'orders'] },
]

describe('layoutColumns', () => {
  it('puts every column under the groups that hold it, in order', () => {
    const items = layoutColumns(groups, order)
    expect(items).toEqual([...groups, 'price'])
    expect(groupsOf(items)).toEqual(groups)
    expect(layoutColumns(undefined, order)).toEqual(order)
  })

  it('takes a column that comes between a group’s own into the innermost group around it', () => {
    // A dimension added to a summary table comes before the measures.
    expect(layoutColumns([{ label: '全部', columns: ['region', { label: '业绩', columns: ['revenue', 'orders'] }] }], ['region', 'channel', 'revenue', 'profit', 'orders'])).toEqual([
      { label: '全部', columns: ['region', 'channel', { label: '业绩', columns: ['revenue', 'profit', 'orders'] }] },
    ])
  })

  it('lets a column that is gone leave its group, and a group with none go', () => {
    expect(layoutColumns(groups, ['region', 'revenue', 'orders'])).toEqual([{ label: '地区', columns: ['region'] }, { label: '业绩', columns: [{ label: '金额', columns: ['revenue'] }, 'orders'] }])
    expect(layoutColumns(groups, ['region', 'orders'])).toEqual([{ label: '地区', columns: ['region'] }, { label: '业绩', columns: ['orders'] }])
  })

  it('drops a group that crosses one before it or nests too deep, keeping its columns', () => {
    expect(layoutColumns([{ label: 'a', columns: ['region', 'city'] }, { label: 'b', columns: ['province', 'revenue'] }], order)).toEqual([{ label: 'a', columns: ['region', 'province', 'city'] }, 'revenue', 'profit', 'orders', 'price'])
    const deep: ColumnGroup = { label: '1', columns: [{ label: '2', columns: [{ label: '3', columns: [{ label: '4', columns: ['region'] }] }] }] }
    expect(layoutColumns([deep], ['region'])).toEqual([{ label: '1', columns: [{ label: '2', columns: [{ label: '3', columns: ['region'] }] }] }])
  })
})

describe('toHeaderRows', () => {
  it('writes each group over its columns, and each column down to the last row', () => {
    const rows = toHeaderRows(layoutColumns(groups, order), () => true)
    expect(rows.map((row) => row.map((cell) => (cell.kind === 'group' ? `${cell.label}/${cell.colSpan}` : `${cell.name}^${cell.rowSpan}`)))).toEqual([
      ['地区/3', '业绩/3', 'price^3'],
      ['region^2', 'province^2', 'city^2', '金额/2', 'orders^2'],
      ['revenue^1', 'profit^1'],
    ])
    expect(rows[1]!.find((cell) => cell.kind === 'group')!.path).toEqual([1, 0])
    expect(rows[2]![1]!.path).toEqual([1, 0, 1])
  })

  it('counts only the columns shown, and leaves out a group with none of them', () => {
    const rows = toHeaderRows(layoutColumns(groups, order), (name) => !['revenue', 'profit', 'province'].includes(name))
    expect(rows.map((row) => row.map((cell) => (cell.kind === 'group' ? `${cell.label}/${cell.colSpan}` : `${cell.name}^${cell.rowSpan}`)))).toEqual([
      ['地区/2', '业绩/1', 'price^2'],
      ['region^1', 'city^1', 'orders^1'],
    ])
    expect(toHeaderRows(['region'], () => true)).toEqual([[{ kind: 'column', name: 'region', path: [0], level: 0, rowSpan: 1 }]])
  })
})
