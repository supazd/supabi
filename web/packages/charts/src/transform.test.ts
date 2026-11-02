import { describe, expect, it } from 'vitest'
import type { Cell, QueryResult } from './result'
import { ChartSpecError } from './spec'
import { highlightOf, maxScatterSeries, toCartesian, toComparedTiles, toGauge, toHeatmap, toMergedSpans, toPivot, toSankey, toScatter, toSlices, toStages, toTiles, toTreemap } from './transform'

const byMonth: QueryResult = {
  columns: [
    { name: 'month', type: 'timestamp', role: 'dimension', grain: 'month' },
    { name: 'revenue', type: 'decimal', role: 'measure', label: '销售额' },
    { name: 'orders', type: 'integer', role: 'measure' },
  ],
  rows: [
    ['2026-01-01T00:00:00', '128000.50', 310],
    ['2026-02-01T00:00:00', null, 280],
  ],
}

const byMonthAndRegion: QueryResult = {
  columns: [
    { name: 'month', type: 'string', role: 'dimension' },
    { name: 'region', type: 'string', role: 'dimension' },
    { name: 'revenue', type: 'decimal', role: 'measure' },
  ],
  rows: [
    ['01', '华东', '10'],
    ['01', '华南', '20'],
    ['02', '华南', '5'],
    ['02', null, '1'],
  ],
}

function errorCode(fn: () => unknown) {
  try {
    fn()
  } catch (e) {
    if (e instanceof ChartSpecError) return e.code
    throw e
  }
  return undefined
}

describe('toCartesian', () => {
  it('uses labels, parses decimals and writes dates to their grain', () => {
    const data = toCartesian({ type: 'bar', x: 'month', y: ['revenue', 'orders'] }, byMonth, 'Other')
    expect(data.categories).toEqual(['2026-01', '2026-02'])
    // The raw values are what a click selects: unformatted, so they can be sent back as a filter.
    expect(data.raw).toEqual(['2026-01-01T00:00:00', '2026-02-01T00:00:00'])
    expect(data.series).toEqual([
      { name: '销售额', data: [128000.5, null], column: byMonth.columns[1] },
      { name: 'orders', data: [310, 280], column: byMonth.columns[2] },
    ])
  })

  it('keeps apart series whose values are written alike', () => {
    const result: QueryResult = {
      columns: [
        { name: 'region', type: 'string', role: 'dimension' },
        { name: 'at', type: 'timestamp', role: 'dimension', format: { time: 'none' } },
        { name: 'n', type: 'integer', role: 'measure' },
      ],
      rows: [['east', '2026-01-05T09:00:00', 1], ['east', '2026-01-05T17:00:00', 2]],
    }
    const data = toCartesian({ type: 'bar', x: 'region', y: ['n'], series: 'at' }, result, 'Other')
    expect(data.series.map((series) => [series.name, series.data])).toEqual([['2026-01-05', [1]], ['2026-01-05', [2]]])
  })

  it('pivots a series column, leaving gaps where a combination is missing', () => {
    const data = toCartesian({ type: 'bar', x: 'month', y: ['revenue'], series: 'region' }, byMonthAndRegion, 'Other')
    expect(data.categories).toEqual(['01', '02'])
    expect(data.raw).toEqual(['01', '02'])
    // Every series is of the one measure, and written the way it is.
    const column = byMonthAndRegion.columns[2]
    expect(data.series).toEqual([
      { name: '华东', data: [10, null], column },
      { name: '华南', data: [20, 5], column },
      { name: '—', data: [null, 1], column },
    ])
  })

  it('folds the smallest series into one once there are more than eight', () => {
    const result: QueryResult = {
      columns: byMonthAndRegion.columns,
      rows: Array.from({ length: 10 }, (_, i) => ['01', `r${i}`, String(i + 1)]),
    }
    const { series } = toCartesian({ type: 'bar', x: 'month', y: ['revenue'], series: 'region' }, result, '其他')
    expect(series.map((item) => item.name)).toEqual(['r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', '其他'])
    expect(series.at(-1)!.data).toEqual([1 + 2 + 3])
  })

  it('reports problems as error codes', () => {
    expect(errorCode(() => toCartesian({ type: 'bar', x: 'nope', y: ['orders'] }, byMonth, ''))).toBe('unknown_column')
    expect(errorCode(() => toCartesian({ type: 'bar', x: 'month', y: [] }, byMonth, ''))).toBe('no_series')
    expect(errorCode(() => toCartesian({ type: 'bar', x: 'orders', y: ['month'] }, byMonth, ''))).toBe('non_numeric_series')
  })
})

describe('toSlices', () => {
  it('orders slices by size, drops what cannot be a share, and folds the tail', () => {
    const result: QueryResult = {
      columns: [
        { name: 'region', type: 'string', role: 'dimension' },
        { name: 'revenue', type: 'decimal', role: 'measure' },
      ],
      rows: [['a', '5'], ['b', '0'], ['c', '-3'], ['d', null], ...Array.from({ length: 9 }, (_, i): [string, string] => [`r${i}`, String(10 + i)])],
    }
    const slices = toSlices({ type: 'pie', x: 'region', y: ['revenue'] }, result, 'Other')
    expect(slices).toHaveLength(8)
    expect(slices[0]).toEqual({ name: 'r8', value: 18, raw: 'r8' })
    // The gathered slice stands for many values, so it has none to select.
    expect(slices.at(-1)).toEqual({ name: 'Other', value: 11 + 10 + 5 })
  })
})

describe('toTiles', () => {
  it('takes the first row and keeps the value as received', () => {
    const tiles = toTiles({ type: 'kpi', y: ['revenue', 'orders'] }, byMonth)
    expect(tiles.map((tile) => [tile.label, tile.value])).toEqual([
      ['销售额', '128000.50'],
      ['orders', 310],
    ])
    expect(toTiles({ type: 'kpi', y: ['orders'] }, { ...byMonth, rows: [] })[0]!.value).toBeNull()
  })
})

const byCity: QueryResult = {
  columns: [
    { name: 'city', type: 'string', role: 'dimension' },
    { name: 'region', type: 'string', role: 'dimension' },
    { name: 'revenue', type: 'decimal', role: 'measure' },
    { name: 'orders', type: 'integer', role: 'measure' },
  ],
  rows: [
    ['上海', '华东', '100', 10],
    ['杭州', '华东', '60', 8],
    ['广州', '华南', '80', null],
    ['成都', '西南', '20', 2],
    ['西安', '西北', '10', 1],
    ['沈阳', '东北', '0', 1],
  ],
}

describe('toScatter', () => {
  it('makes a point of each row with both values, and gathers series past three', () => {
    const data = toScatter({ type: 'scatter', x: 'city', y: ['revenue', 'orders'], series: 'region' }, byCity, '其他')
    expect(data.series.length).toBe(maxScatterSeries + 1)
    // 华东 has the most points; the rest are kept in their order until the palette runs out.
    expect(data.series.map((item) => item.name)).toEqual(['华东', '西南', '西北', '其他'])
    expect(data.series[3]).toMatchObject({ other: true, points: [{ name: '沈阳', value: [0, 1] }] })
    expect(data.series.flatMap((item) => item.points).some((point) => point.name === '广州')).toBe(false)
  })

  it('sizes bubbles by a third measure', () => {
    const data = toScatter({ type: 'scatter', x: 'city', y: ['orders', 'orders', 'revenue'] }, byCity, '其他')
    expect(data.series[0]!.points[0]).toEqual({ name: '上海', value: [10, 10, 100] })
    expect(data.columns.size?.name).toBe('revenue')
  })
})

describe('toStages', () => {
  it('keeps every stage, largest first, with its share of the first', () => {
    const stages = toStages({ type: 'funnel', x: 'city', y: ['revenue'] }, byCity)
    expect(stages.map((stage) => stage.name)).toEqual(['上海', '广州', '杭州', '成都', '西安', '沈阳'])
    expect(stages[1]!.share).toBeCloseTo(0.8)
    expect(stages[5]!.share).toBe(0)
  })
})

describe('toTreemap', () => {
  it('lists tiles with a value, grouped by the series when there is one', () => {
    expect(toTreemap({ type: 'treemap', x: 'city', y: ['revenue'] }, byCity, '其他').map((tile) => tile.name)).toEqual(['上海', '杭州', '广州', '成都', '西安'])
    const groups = toTreemap({ type: 'treemap', x: 'city', y: ['revenue'], series: 'region' }, byCity, '其他')
    expect(groups[0]).toEqual({ name: '华东', value: 160, children: [{ name: '上海', value: 100 }, { name: '杭州', value: 60 }] })
    expect(groups.map((group) => group.name)).toEqual(['华东', '华南', '西南', '西北'])
  })
})

describe('toHeatmap', () => {
  it('places each value at its row and column', () => {
    const data = toHeatmap({ type: 'heatmap', rows: ['region'], columns: ['month'], y: ['revenue'] }, byMonthAndRegion)
    expect(data.columns).toEqual(['01', '02'])
    expect(data.rows).toEqual(['华东', '华南', '—'])
    expect(data.cells).toEqual([[0, 0, 10], [0, 1, 20], [1, 1, 5], [1, 2, 1]])
    expect([data.min, data.max]).toEqual([1, 20])
  })
})

describe('toGauge', () => {
  it('reads the first row, with the target when there is one', () => {
    expect(toGauge({ type: 'gauge', y: ['revenue', 'orders'] }, byCity)).toMatchObject({ value: 100, target: 10, label: 'revenue' })
    expect(toGauge({ type: 'gauge', y: ['revenue'] }, byCity)).not.toHaveProperty('target')
  })
})

describe('toPivot', () => {
  const withTotals: QueryResult = {
    ...byMonthAndRegion,
    totals: [
      { by: ['region'], columns: [byMonthAndRegion.columns[1]!, byMonthAndRegion.columns[2]!], rows: [['华东', '10'], ['华南', '25'], [null, '1']] },
      { by: ['month'], columns: [byMonthAndRegion.columns[0]!, byMonthAndRegion.columns[2]!], rows: [['02', '6'], ['01', '30']] },
      // Not 36: the database's total is whatever the measure's aggregation makes it.
      { by: [], columns: [byMonthAndRegion.columns[2]!], rows: [['35']] },
    ],
  }
  it('spreads the column values across, in order, and leaves a missing cell empty', () => {
    const data = toPivot({ type: 'pivot', rows: ['region'], columns: ['month'], y: ['revenue'] }, withTotals)
    expect(data.rowLines).toEqual([{ key: ['华东'], depth: 1 }, { key: ['华南'], depth: 1 }, { key: [null], depth: 1 }, { key: [], depth: 0 }])
    expect(data.columnLines).toEqual([{ key: ['01'], depth: 1 }, { key: ['02'], depth: 1 }, { key: [], depth: 0 }])
    expect(data.cells).toEqual([
      [['10'], [undefined], ['10']],
      [['20'], ['5'], ['25']],
      [[undefined], ['1'], ['1']],
      [['30'], ['6'], ['35']],
    ])
  })

  it('has no totals the query did not ask for, and one column with no column dimension', () => {
    const data = toPivot({ type: 'pivot', rows: ['region', 'month'], y: ['revenue'] }, { ...withTotals, totals: [withTotals.totals![2]!] })
    expect(data.columnLines).toEqual([{ key: [], depth: 0 }])
    expect(data.rowLines.map((line) => line.depth)).toEqual([2, 2, 2, 2, 0])
    expect(data.cells.at(-1)).toEqual([['35']])
  })

  const cities: QueryResult = {
    columns: [
      { name: 'region', type: 'string', role: 'dimension' },
      { name: 'city', type: 'string', role: 'dimension' },
      { name: 'year', type: 'string', role: 'dimension' },
      { name: 'buyers', type: 'integer', role: 'measure' },
    ],
    // Ordered by the measure, so a region's cities do not come together.
    rows: [
      ['华东', '上海', '2025', 5],
      ['华南', '广州', '2025', 4],
      ['华东', '杭州', '2025', 3],
      ['华东', '上海', '2026', 2],
    ],
  }
  const column = (name: string) => cities.columns.find((item) => item.name === name)!
  const by = (names: string[], rows: Cell[][]) => ({ by: names, columns: [...names.map(column), column('buyers')], rows })
  const withSubtotals: QueryResult = {
    ...cities,
    totals: [
      by(['region', 'city'], [['华东', '上海', 6], ['华南', '广州', 4], ['华东', '杭州', 3]]),
      by(['year'], [['2025', 10], ['2026', 2]]),
      by([], [[11]]),
      // Not 8 and 9: a buyer of both cities is counted once. Found by the dimensions, in whatever order.
      by(['year', 'region'], [['2025', '华东', 7], ['2025', '华南', 4], ['2026', '华东', 2]]),
      by(['region'], [['华东', 8], ['华南', 4]]),
    ],
  }

  it('follows each group of an outer row dimension with its subtotal, keeping the group together', () => {
    const data = toPivot({ type: 'pivot', rows: ['region', 'city'], columns: ['year'], y: ['buyers'] }, withSubtotals)
    expect(data.rowLines).toEqual([
      { key: ['华东', '上海'], depth: 2 },
      { key: ['华东', '杭州'], depth: 2 },
      { key: ['华东'], depth: 1 },
      { key: ['华南', '广州'], depth: 2 },
      { key: ['华南'], depth: 1 },
      { key: [], depth: 0 },
    ])
    expect(data.columnLines.map((line) => line.key)).toEqual([['2025'], ['2026'], []])
    expect(data.cells).toEqual([
      [[5], [2], [6]],
      [[3], [undefined], [3]],
      [[7], [2], [8]],
      [[4], [undefined], [4]],
      [[4], [undefined], [4]],
      [[10], [2], [11]],
    ])
  })

  it('keeps the rows in the order they came when there are no subtotals', () => {
    const data = toPivot({ type: 'pivot', rows: ['region', 'city'], columns: ['year'], y: ['buyers'] }, { ...withSubtotals, totals: withSubtotals.totals!.slice(0, 3) })
    expect(data.rowLines.map((line) => line.key)).toEqual([['华东', '上海'], ['华南', '广州'], ['华东', '杭州'], []])
  })

  it('follows each group of an outer column dimension with its subtotal', () => {
    const months: QueryResult = {
      columns: [column('region'), column('year'), { name: 'month', type: 'string', role: 'dimension' }, column('buyers')],
      rows: [
        ['华东', '2025', '01', 1],
        ['华东', '2025', '02', 2],
        ['华东', '2026', '01', 3],
        ['华南', '2025', '01', 4],
      ],
    }
    const cols = (names: string[], rows: Cell[][]) => ({ by: names, columns: [...names.map((name) => months.columns.find((item) => item.name === name)!), column('buyers')], rows })
    const data = toPivot({ type: 'pivot', rows: ['region'], columns: ['year', 'month'], y: ['buyers'] }, {
      ...months,
      totals: [
        cols(['region'], [['华东', 5], ['华南', 4]]),
        cols(['year', 'month'], [['2025', '01', 5], ['2025', '02', 2], ['2026', '01', 3]]),
        cols([], [[9]]),
        cols(['region', 'year'], [['华东', '2025', 3], ['华东', '2026', 3], ['华南', '2025', 4]]),
        cols(['year'], [['2025', 7], ['2026', 3]]),
      ],
    })
    expect(data.columnLines).toEqual([
      { key: ['2025', '01'], depth: 2 },
      { key: ['2025', '02'], depth: 2 },
      { key: ['2025'], depth: 1 },
      { key: ['2026', '01'], depth: 2 },
      { key: ['2026'], depth: 1 },
      { key: [], depth: 0 },
    ])
    expect(data.cells).toEqual([
      [[1], [2], [3], [3], [3], [5]],
      [[4], [undefined], [4], [undefined], [undefined], [4]],
      [[5], [2], [7], [3], [3], [9]],
    ])
  })
})

describe('toMergedSpans', () => {
  const shown = (columns: [string, 'dimension' | 'measure', number][]) => columns.map(([name, role, index]) => ({ column: { name, type: 'string' as const, role }, index }))

  it('merges a run of equal values only within the runs of the dimensions before it', () => {
    const rows: Cell[][] = [
      ['华东', '浙江', '杭州', 1],
      ['华东', '浙江', '宁波', 1],
      ['华东', '江苏', '南京', 2],
      // The same province and city as above, in another region.
      ['华南', '江苏', '南京', 2],
      ['华南', '广东', '广州', 3],
    ]
    const columns = shown([['region', 'dimension', 0], ['province', 'dimension', 1], ['city', 'dimension', 2], ['amount', 'measure', 3]])
    expect(toMergedSpans(columns, rows)).toEqual([[3, 0, 0, 2, 0], [2, 0, 1, 1, 1], [1, 1, 1, 1, 1], undefined])
    expect(toMergedSpans(columns, [])).toEqual([[], [], [], undefined])
  })

  it('takes nulls as equal and empty text as another value, and is bounded only by the dimensions shown', () => {
    // A hidden id differs on every row, and a measure between the dimensions differs too.
    const rows: Cell[][] = [
      [1, null, 5, 'a'],
      [2, null, 6, 'a'],
      [3, '', 6, 'a'],
    ]
    expect(toMergedSpans(shown([['region', 'dimension', 1], ['amount', 'measure', 2], ['city', 'dimension', 3]]), rows)).toEqual([[2, 0, 1], undefined, [2, 0, 1]])
  })
})

describe('toComparedTiles', () => {
  it('pairs a tile with what it is compared against, which is no tile of its own', () => {
    const tiles = toComparedTiles({ type: 'kpi', y: ['revenue', 'orders'], compare: { orders: 'revenue' } }, byMonth)
    expect(tiles).toHaveLength(1)
    expect(tiles[0]).toMatchObject({ label: 'orders', value: 310, reference: { label: '销售额', value: '128000.50' } })
  })
})

describe('toSankey', () => {
  const flows: QueryResult = {
    columns: [
      { name: 'channel', type: 'string', role: 'dimension' },
      { name: 'status', type: 'string', role: 'dimension' },
      { name: 'region', type: 'string', role: 'dimension' },
      { name: 'users', type: 'integer', role: 'measure' },
    ],
    rows: [
      ['app', 'paid', '华东', 5],
      ['app', 'paid', '华南', 4],
      ['web', 'paid', '华东', 3],
      ['web', 'refund', 'web', 2],
      ['app', 'refund', '华东', 0],
    ],
  }

  it('makes a flow of each row between two levels, keeping a value at two levels apart', () => {
    const data = toSankey({ type: 'sankey', levels: ['channel', 'region'], y: ['users'] }, { ...flows, columns: [flows.columns[0]!, flows.columns[2]!, flows.columns[3]!], rows: flows.rows.map((row) => [row[0]!, row[2]!, row[3]!]) }, '其他')
    expect(data.nodes.map((node) => node.id)).toEqual(['0:app', '0:web', '1:华东', '1:华南', '1:web'])
    // A flow of nothing is not drawn.
    expect(data.links).toContainEqual({ source: '0:app', target: '1:华东', value: 5 })
    expect(data.links).toHaveLength(4)
    expect(data.whole).toBe(14)
  })

  it('takes the flows between neighbouring levels from the database’s totals', () => {
    // Distinct users: 7 paid through app, though the rows add up to 9.
    const totals = [
      { by: ['channel', 'status'], columns: [flows.columns[0]!, flows.columns[1]!, flows.columns[3]!], rows: [['app', 'paid', 7], ['web', 'paid', 3], ['web', 'refund', 2]] },
      { by: ['status', 'region'], columns: [flows.columns[1]!, flows.columns[2]!, flows.columns[3]!], rows: [['paid', '华东', 6], ['paid', '华南', 4], ['refund', 'web', 2]] },
    ]
    const data = toSankey({ type: 'sankey', levels: ['channel', 'status', 'region'], y: ['users'] }, { ...flows, totals }, '其他')
    expect(data.links).toContainEqual({ source: '0:app', target: '1:paid', value: 7 })
    expect(data.links).toContainEqual({ source: '1:paid', target: '2:华东', value: 6 })
    expect(data.nodes.find((node) => node.id === '1:paid')?.value).toBe(10)
  })

  it('gathers the values past what a level holds into one node', () => {
    const many: QueryResult = { columns: [flows.columns[0]!, flows.columns[1]!, flows.columns[3]!], rows: Array.from({ length: 10 }, (_, i) => [`c${i}`, 'paid', 10 - i]) }
    const data = toSankey({ type: 'sankey', levels: ['channel', 'status'], y: ['users'] }, many, '其他')
    const first = data.nodes.filter((node) => node.level === 0)
    expect(first).toHaveLength(8)
    expect(first[7]).toMatchObject({ name: '其他', other: true, value: 3 + 2 + 1 })
    // The first level keeps the order its values came in.
    expect(first.slice(0, 3).map((node) => node.name)).toEqual(['c0', 'c1', 'c2'])
  })
})

describe('highlightOf', () => {
  const rules = [
    { op: 'lt', value: 0.8, color: 'red', icon: 'down' },
    { op: 'lt', value: 1, color: 'yellow' },
    { op: 'gte', value: 1, color: 'green', icon: 'up' },
  ] as const
  it('takes the first rule the value meets, from numbers as the query returns them', () => {
    expect(highlightOf([...rules], 0.5)?.color).toBe('red')
    expect(highlightOf([...rules], '0.8')?.color).toBe('yellow')
    expect(highlightOf([...rules], 1)?.color).toBe('green')
    expect(highlightOf([{ op: 'gt', value: 5, color: 'blue' }], 5)).toBeUndefined()
  })

  it('compares with every operator', () => {
    const meets = (op: 'lt' | 'lte' | 'gt' | 'gte' | 'eq' | 'ne') => [1, 2, 3].filter((value) => highlightOf([{ op, value: 2, color: 'blue' }], value))
    expect([meets('lt'), meets('lte'), meets('gt'), meets('gte'), meets('eq'), meets('ne')]).toEqual([[1], [1, 2], [3], [2, 3], [2], [1, 3]])
  })

  it('leaves empty and non-numeric values, and a column without rules, unshaded', () => {
    for (const cell of [null, undefined, '', 'n/a', true] as (Cell | undefined)[]) expect(highlightOf([{ op: 'ne', value: 1, color: 'red' }], cell)).toBeUndefined()
    expect(highlightOf(undefined, 1)).toBeUndefined()
    expect(highlightOf([], 1)).toBeUndefined()
  })
})
