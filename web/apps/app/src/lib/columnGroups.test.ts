import { groupsOf, layoutColumns } from '@supabi/charts'
import { describe, expect, it } from 'vitest'
import { fitsInGroup, groupPicked, pickHeader, pickedGroup, pickedPaths, renameGroup, ungroup } from './columnGroups'

const order = ['region', 'city', 'revenue', 'profit', 'orders']

describe('picking headers', () => {
  it('extends a pick with Shift only within the group it started in', () => {
    const first = pickHeader(undefined, [2], false)
    expect(pickedPaths(pickHeader(first, [4], true))).toEqual([[2], [3], [4]])
    // Backwards too.
    expect(pickedPaths(pickHeader(first, [0], true))).toEqual([[0], [1], [2]])
    // In another group, the pick starts again there.
    expect(pickedPaths(pickHeader(first, [1, 0], true))).toEqual([[1, 0]])
    expect(pickedPaths(pickHeader(first, [3], false))).toEqual([[3]])
  })
})

describe('grouping headers', () => {
  it('puts the picked items in a group, which can then be put in another, and takes groups away one at a time', () => {
    const amount = groupPicked(order, { parent: [], anchor: 2, to: 3 }, '金额')
    expect(amount.items).toEqual(['region', 'city', { label: '金额', columns: ['revenue', 'profit'] }, 'orders'])
    expect(amount.path).toEqual([2])
    const results = groupPicked(amount.items, { parent: [], anchor: 4, to: 2 }, '业绩')
    expect(groupsOf(results.items)).toEqual([{ label: '业绩', columns: [{ label: '金额', columns: ['revenue', 'profit'] }, 'orders'] }])
    // What a table draws from what was kept is what was grouped.
    expect(layoutColumns(groupsOf(results.items), order)).toEqual(results.items)
    expect(pickedGroup(results.items, { parent: [], anchor: 2, to: 2 })?.label).toBe('业绩')
    expect(pickedGroup(results.items, { parent: [], anchor: 1, to: 2 })).toBeUndefined()

    expect(ungroup(results.items, [2])).toEqual(amount.items)
    expect(renameGroup(results.items, [2, 0], ' 本期 ')).toEqual(['region', 'city', { label: '业绩', columns: [{ label: '本期', columns: ['revenue', 'profit'] }, 'orders'] }])
    expect(renameGroup(results.items, [2, 0], '  ')).toBe(results.items)
  })

  it('takes in a hidden column between the picked ones, since every column has a place', () => {
    // Shown: region, revenue; city hidden between them. A pick from region to revenue covers it.
    expect(groupPicked(order, { parent: [], anchor: 0, to: 2 }, '组').items[0]).toEqual({ label: '组', columns: ['region', 'city', 'revenue'] })
  })

  it('refuses a group that would nest more than three deep', () => {
    const items = [{ label: 'a', columns: [{ label: 'b', columns: ['region'] }, 'city'] }, 'revenue']
    expect(fitsInGroup(items, { parent: [], anchor: 0, to: 1 })).toBe(true)
    expect(fitsInGroup(items, { parent: [0], anchor: 0, to: 0 })).toBe(true)
    expect(fitsInGroup(items, { parent: [0, 0], anchor: 0, to: 0 })).toBe(true)
    const deep = groupPicked(items, { parent: [0, 0], anchor: 0, to: 0 }, 'c').items
    expect(fitsInGroup(deep, { parent: [], anchor: 0, to: 0 })).toBe(false)
    expect(fitsInGroup(deep, { parent: [0, 0, 0], anchor: 0, to: 0 })).toBe(false)
  })
})
