import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { linkColumns, pruneLinks, useDashboardLinks, type DashboardLink } from './links'
import type { ChartSpec } from './builder'
import type { LayoutItem } from './layout'

const links: DashboardLink[] = [{ id: 'region', label: 'Region', source: { item: 'a', column: 'region' }, targets: [{ item: 'b', field: 'area' }] }]
describe('dashboard links', () => {
  it('toggles null and empty categories and clears stale choices on context changes', () => {
    const { result, rerender } = renderHook(({ context }) => useDashboardLinks(links, () => context), { initialProps: { context: 'initial' } })
    act(() => result.current.select('a', 'region', null))
    expect(result.current.values).toEqual({ region: null })
    act(() => result.current.select('a', 'region', null))
    expect(result.current.values).toEqual({})
    act(() => result.current.select('a', 'region', ''))
    expect(result.current.values).toEqual({ region: '' })
    rerender({ context: 'changed filter' })
    expect(result.current.values).toEqual({})
  })
  it('keeps unrelated selections while invalidating downstream clicks, including cycles', () => {
    const graph: DashboardLink[] = [...links, { id: 'city', label: 'City', source: { item: 'b', column: 'city' }, targets: [{ item: 'c', field: 'city' }] }]
    const { result, rerender } = renderHook(({ source }) => useDashboardLinks(graph, (link) => link.id === 'region' ? source : 'steady'), { initialProps: { source: 'first' } })
    act(() => result.current.select('a', 'region', 'East'))
    act(() => result.current.select('b', 'city', 'Shanghai'))
    expect(result.current.values).toEqual({ region: 'East', city: 'Shanghai' })
    act(() => result.current.select('a', 'region', 'West'))
    expect(result.current.values).toEqual({ region: 'West' })
    act(() => result.current.select('b', 'city', 'Chengdu'))
    rerender({ source: 'changed source filter' })
    expect(result.current.values).toEqual({})
    graph.push({ id: 'cycle', label: 'Cycle', source: { item: 'c', column: 'city' }, targets: [{ item: 'a', field: 'region' }] })
    rerender({ source: 'changed source filter' })
    act(() => result.current.select('a', 'region', 'East'))
    expect(result.current.values).toEqual({ region: 'East' })
  })
  it('prunes mappings together with removed widgets', () => {
    expect(pruneLinks(links, [{ id: 'a' }] as LayoutItem[])).toEqual([])
    expect(pruneLinks(links, [{ id: 'b' }] as LayoutItem[])).toEqual([])
  })
  it('offers only displayed static categories, including detail table fields', () => {
    const spec = { query: { dimensions: [{ field: 'day', alias: 'month', grain: 'month' }, { field: 'region' }] }, viz: { type: 'bar', x: 'month' } } as unknown as ChartSpec
    expect(linkColumns(spec)).toEqual([{ column: 'month', field: 'day', grain: 'month' }])
    expect(linkColumns({ ...spec, dynamics: [{ alias: 'month' }] } as ChartSpec)).toEqual([])
    expect(linkColumns({ ...spec, viz: { type: 'line', x: 'month' } })).toEqual([])
    expect(linkColumns({ query: { mode: 'detail', columns: ['region', { field: 'day' }] }, viz: { type: 'table' } } as unknown as ChartSpec)).toEqual([{ column: 'region', field: 'region' }, { column: 'day', field: 'day' }])
  })
})
