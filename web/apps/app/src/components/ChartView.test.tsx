// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import '../i18n'
import { namedColumns } from './ChartView'
import type { QueryResult } from '../api/client'

describe('comparison column names', () => {
  it.each([
    ['value', 'Previous value'], ['delta', 'Difference'], ['ratio', 'Growth rate'],
  ] as const)('names a dynamic aggregate with its %s computation without repeating the aggregation', (output, label) => {
    const result: QueryResult = { columns: [{ name: 'metric', label: 'SUM(Amount)', type: 'float', role: 'measure', compute: 'compare', comparison: { offset: { n: 1, unit: 'year' }, output } }], rows: [], meta: { durationMs: 0, truncated: false, cached: false } }
    expect(namedColumns(result, 'en-US').columns[0]!.label).toBe(`SUM(Amount) (Year over year · ${label})`)
    expect(namedColumns(result, 'zh-CN').columns[0]!.label).toContain('同比')
    // A final custom label deliberately has no computation metadata.
    result.columns[0] = { name: 'metric', label: 'My custom result', type: 'float', role: 'measure' }
    expect(namedColumns(result, 'en-US').columns[0]!.label).toBe('My custom result')
  })
})

it('names a running total after the aggregate it runs', () => {
  const result: QueryResult = { columns: [{ name: 'amount', label: 'Amount', agg: 'sum', type: 'decimal', role: 'measure', compute: 'cumulative' }], rows: [], meta: { durationMs: 0, truncated: false, cached: false } }
  expect(namedColumns(result, 'en-US').columns[0]!.label).toBe('SUM(Amount) (running total)')
  expect(namedColumns(result, 'zh-CN').columns[0]!.label).toBe('SUM(Amount)（累计）')
})
