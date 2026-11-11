import { describe, expect, it } from 'vitest'
import { funnelOption, heatmapOption, sankeyOption, scatterOption, treemapOption } from './echartsAdapter'

// ECharts sets what a tooltip formatter returns as HTML, and the names in it come from the user's data.
const attack = '<img src=x onerror=alert(1)>'
const options = { scheme: 'light', texts: {}, formatValue: (value: number) => `${attack}${value}`, formatAxis: String } as unknown as Parameters<typeof funnelOption>[3]
const column = { name: attack, label: attack, type: 'decimal' } as never
const formatterOf = (option: unknown) => (option as { tooltip: { formatter: (p: unknown) => string } }).tooltip.formatter

describe('tooltips written here', () => {
  it('escape the names and values of the data', () => {
    const written = [
      formatterOf(funnelOption('f', [{ name: attack, value: 1, share: 1, raw: attack }], column, options))({ marker: '', name: attack, value: 1, dataIndex: 0 }),
      formatterOf(treemapOption('t', [{ name: attack, value: 1 }] as never, column, options))({ marker: '', name: attack, value: 1 }),
      formatterOf(scatterOption({ columns: { x: column, y: column, size: column }, series: [] } as never, options))({ marker: '', data: { name: attack, value: [1, 2, 3] } }),
      formatterOf(heatmapOption({ rows: [attack], columns: [attack], cells: [], column, min: 0, max: 1 } as never, options))({ value: [0, 0, 1] }),
      formatterOf(sankeyOption({ nodes: [{ id: 'a', name: attack, level: 0, value: 1 }], links: [], whole: 1, column } as never, options))({ dataType: 'node', data: { name: 'a', value: 1 } }),
      formatterOf(sankeyOption({ nodes: [{ id: 'a', name: attack, level: 0, value: 1 }], links: [], whole: 1, column } as never, options))({ dataType: 'edge', data: { source: 'a', target: 'a', value: 1 } }),
    ]
    for (const text of written) {
      expect(text).not.toContain('<img')
      expect(text).toContain('&lt;img')
    }
  })
})
