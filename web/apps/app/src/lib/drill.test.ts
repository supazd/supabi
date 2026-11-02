import i18n from 'i18next'
import { describe, expect, it } from 'vitest'
import '../i18n'
import type { SpecField } from '../api/spec'
import { drillDown, drilledInto, drillPath, drillProblem, finerGrains, within } from './drill'

const fields: SpecField[] = [
  { key: 'created', label: '下单时间', column: 'created_at', type: 'timestamp', role: 'dimension' },
  { key: 'region', label: '大区', column: 'region', type: 'string', role: 'dimension' },
  { key: 'province', label: '省份', column: 'province', type: 'string', role: 'dimension' },
]

describe('drill levels', () => {
  it('nests periods the way the server does: a week holds days only', () => {
    expect(within('year', 'day')).toBe(true)
    expect(within('month', 'week')).toBe(false)
    expect(within('week', 'day')).toBe(true)
    expect(within('week', 'month')).toBe(false)
    expect(within('day', 'month')).toBe(false)
    expect(within(undefined, 'day')).toBe(false)
    expect(finerGrains('year')).toEqual(['quarter', 'month', 'day'])
    expect(finerGrains('week')).toEqual(['day'])
    expect(finerGrains(undefined)).toEqual([])
  })

  it('finds levels repeated, dates going coarser and fields that are no dimension', () => {
    const first = { field: 'region' }
    expect(drillProblem(first, [{ field: 'province' }, { field: 'created', grain: 'month' }, { field: 'created', grain: 'day' }], [], fields)).toBeUndefined()
    expect(drillProblem(first, [{ field: 'province' }], [{ field: 'province' }], fields)).toBe('repeated')
    expect(drillProblem(first, [{ field: 'created', grain: 'day' }, { field: 'created', grain: 'month' }], [], fields)).toBe('grain')
    expect(drillProblem(first, [{ field: 'created' }], [], fields)).toBe('unknownField')
    expect(drillProblem(first, [{ field: 'gone' }], [], fields)).toBe('unknownField')
  })
})

describe('where a chart is drilled down to', () => {
  const t = i18n.getFixedT('zh-CN')
  const drill = { alias: 'region', levels: [{ field: 'province', label: '省份' }, { field: 'created', grain: 'month' as const, label: '下单时间 · 月' }] }

  it('records each value clicked as the chart wrote it, under the name of the first level', () => {
    const column = { name: 'region', label: '大区', type: 'string' as const, role: 'dimension' as const }
    const east = drilledInto(undefined, '华东', column, t)
    expect(east).toEqual({ root: '大区', steps: [{ value: '华东', text: '华东' }] })
    const missing = drilledInto(east, null, { ...column, label: '省份' }, t)
    expect(missing).toEqual({ root: '大区', steps: [{ value: '华东', text: '华东' }, { value: null, text: '空值' }] })
    expect(drillPath(missing)).toEqual(['华东', null])
    expect(drillPath(undefined)).toEqual([])
  })

  it('offers the next level until the last', () => {
    expect(drillDown(drill, undefined, t)?.label).toBe('下钻到省份')
    expect(drillDown(drill, { root: '大区', steps: [{ value: '华东', text: '华东' }] }, t)?.label).toBe('下钻到下单时间 · 月')
    expect(drillDown(drill, { root: '大区', steps: [{ value: '华东', text: '华东' }, { value: '江苏', text: '江苏' }] }, t)).toBeUndefined()
    expect(drillDown(undefined, undefined, t)).toBeUndefined()
  })
})
