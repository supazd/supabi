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

describe('a treemap in groups', () => {
  const plain = { scheme: 'light', texts: {}, formatValue: String, formatAxis: String } as unknown as Parameters<typeof treemapOption>[3]
  const tiles = [{ name: 'Home', value: 3, children: [{ name: 'Fridge', value: 3 }] }, { name: 'Books', value: 1, children: [{ name: 'Novel', value: 1 }] }]
  type Drawn = { legend?: { data: string[] }; series: { type: string; radius?: number; data: { name: string; itemStyle: { color: string } }[] }[] }

  it('gives the legend each group in its colour, from a series that draws nothing', () => {
    const { legend, series } = treemapOption('t', tiles as never, undefined, plain) as unknown as Drawn
    expect(legend?.data).toEqual(['Home', 'Books'])
    const [tree, key] = series
    expect(series).toHaveLength(2)
    expect(key).toMatchObject({ type: 'pie', radius: 0 })
    expect(key!.data.map((item) => [item.name, item.itemStyle.color])).toEqual(tree!.data.map((tile) => [tile.name, tile.itemStyle.color]))
    expect(new Set(key!.data.map((item) => item.itemStyle.color)).size).toBe(2)
  })

  it('has no legend, and nothing standing for one, without groups or when the legend is turned off', () => {
    const flat = treemapOption('t', [{ name: 'Fridge', value: 3 }] as never, undefined, plain) as unknown as Drawn
    expect(flat.legend).toBeUndefined()
    expect(flat.series).toHaveLength(1)
    const off = treemapOption('t', tiles as never, undefined, { ...plain, style: { legend: 'none' } } as never) as unknown as Drawn
    expect(off.legend).toBeUndefined()
    expect(off.series).toHaveLength(1)
  })
})
