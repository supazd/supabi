import { describe, expect, it } from 'vitest'
import type { SpecField } from '../api/spec'
import { addMeasure, aggChoices, hasSubtotals, maxTotals, aggOptions, buildSpec, buildViz, chartDrillProblem, drillableColumns, fieldsUsed, needsVisibleColumn, pruneColumnGroups, pruneComputes, pruneDrill, pruneHiddenColumns, reaggregated, recomputed, restore, shapeProblem, sortedBy, styleFor, subtotalsFit, totalsOf, withoutStaleSort, withType, type BuilderState, type ChartSpec } from './builder'
import { cleanFilter, type ChartFilter } from './filters'
import type { ParamFilter } from './paramFilters'
import { dynamicOutputProblem, hasQueryOutput, prunedTotals, resolveDynamicSpec, type DynamicField } from './dynamics'

const fields: SpecField[] = [
  { key: 'created', label: '下单时间', column: 'created_at', type: 'timestamp', role: 'dimension' },
  { key: 'region', label: '地区', column: 'region', type: 'string', role: 'dimension' },
  { key: 'channel', label: '渠道', column: 'channel', type: 'string', role: 'dimension' },
  { key: 'revenue', label: '销售额', column: 'amount', type: 'decimal', role: 'measure' },
  { key: 'arpu', label: '客单价', expr: 'SUM(amount) / COUNT(DISTINCT user_id)', type: 'decimal', role: 'metric' },
]
const field = (key: string) => fields.find((candidate) => candidate.key === key)!
/** Measures as the builder adds them: a measure summed, a metric as it is. */
const m = (...keys: string[]) => keys.map((key) => (fields.find((candidate) => candidate.key === key)?.role === 'measure' ? { field: key, agg: 'sum' as const } : { field: key }))
const state = (patch: Partial<BuilderState>): BuilderState => ({ dimensions: [], measures: m('revenue'), columns: [], labels: {}, grain: 'month', filters: [], vizType: 'table', stacked: false, ...patch })

describe('dynamic fields', () => {
  const dimension: DynamicField = { id: 'group', alias: 'dynamic_group', kind: 'dimension', label: 'Group by', allowEmpty: true, options: [
    { id: 'month', field: 'created', grain: 'month' }, { id: 'day', field: 'created', grain: 'day' }, { id: 'region', field: 'region' },
  ] }
  const measure: DynamicField = { id: 'metric', alias: 'dynamic_metric', kind: 'measure', label: 'Metric', options: [
    { id: 'sum', field: 'revenue', agg: 'sum' }, { id: 'avg', field: 'revenue', agg: 'avg', label: 'Average sale' }, { id: 'arpu', field: 'arpu' },
  ] }
  const dynamicState = () => state({ dimensions: [dimension.alias], measures: [{ field: measure.alias }], dynamics: [dimension, measure], vizType: 'line' })

  it('persists default candidates with stable aliases and restores all options', () => {
    const original = dynamicState()
    const spec = buildSpec('ds', original, fields)
    expect(spec.query.dimensions).toEqual([{ alias: 'dynamic_group', field: 'created', grain: 'month' }])
    expect(spec.query.measures).toEqual([{ alias: 'dynamic_metric', field: 'revenue', agg: 'sum' }])
    expect(spec.viz).toEqual({ type: 'line', x: 'dynamic_group', y: ['dynamic_metric'] })
    expect(restore(JSON.parse(JSON.stringify(spec)) as ChartSpec, fields)).toEqual(original)
    expect(fieldsUsed(spec)).toEqual(new Set(['created', 'region', 'revenue', 'arpu']))
  })

  it('changes fields, date grain and aggregation without changing saved defaults', () => {
    const saved = buildSpec('ds', dynamicState(), fields)
    const changed = resolveDynamicSpec(saved, { group: 'day', metric: 'avg' })
    expect(changed.query.dimensions).toEqual([{ alias: 'dynamic_group', field: 'created', grain: 'day' }])
    expect(changed.query.measures).toEqual([{ field: 'revenue', agg: 'avg', alias: 'dynamic_metric', label: 'Average sale' }])
    expect(changed.viz).toEqual(saved.viz)
    expect(saved.query.measures).toEqual([{ alias: 'dynamic_metric', field: 'revenue', agg: 'sum' }])
    expect(resolveDynamicSpec(saved, { group: 'deleted', metric: '' }).query).toEqual(saved.query)
  })

  it('allows no dimension, falls back to a table, and can restore the original chart', () => {
    const saved = buildSpec('ds', dynamicState(), fields)
    const empty = resolveDynamicSpec(saved, { group: '' })
    expect(empty.query.dimensions).toEqual([])
    expect(empty.viz).toEqual({ type: 'table' })
    expect(resolveDynamicSpec(saved, { group: 'region' }).viz).toEqual(saved.viz)
  })

  it('retains a remaining dimension when the x dimension is removed', () => {
    const saved = buildSpec('ds', { ...dynamicState(), dimensions: [dimension.alias, 'channel'] }, fields)
    expect(resolveDynamicSpec(saved, { group: '' }).viz).toEqual({ type: 'line', x: 'channel', y: ['dynamic_metric'] })
  })

  it('checks all optional dimensions together and accepts a remaining metric or required dimension', () => {
    const other = { ...dimension, id: 'other', alias: 'other_group' }
    const optionalOnly = state({ dimensions: [dimension.alias, other.alias], measures: [], dynamics: [dimension, other] })
    const spec = buildSpec('ds', optionalOnly, fields)
    expect(dynamicOutputProblem(spec)).toBe('needsOutput')
    expect(hasQueryOutput(resolveDynamicSpec(spec, { group: '', other: '' }).query)).toBe(false)
    // A partially configured draft still retains its definitions and default outputs.
    expect(spec.query.dimensions).toHaveLength(2)
    expect(dynamicOutputProblem(buildSpec('ds', { ...optionalOnly, measures: m('revenue') }, fields))).toBeUndefined()
    expect(dynamicOutputProblem(buildSpec('ds', { ...optionalOnly, dimensions: [...optionalOnly.dimensions, 'region'] }, fields))).toBeUndefined()
    expect(dynamicOutputProblem(buildSpec('ds', { ...optionalOnly, dynamics: [dimension, { ...other, allowEmpty: false }] }, fields))).toBeUndefined()
  })

  it('resolves implicit field aliases the same way as the server without changing the saved spec', () => {
    const original: ChartSpec = { specVersion: 1, query: { version: 1, dataset: 'ds', dimensions: [{ field: 'created' }], measures: [{ field: 'revenue', agg: 'sum' }] },
      viz: { type: 'line', x: 'created', y: ['revenue'] }, dynamics: [{ ...dimension, alias: 'created' }, { ...measure, alias: 'revenue' }] }
    const copy = structuredClone(original)
    expect(resolveDynamicSpec(original, { group: 'region', metric: 'avg' })).toMatchObject({ query: {
      dimensions: [{ alias: 'created', field: 'region' }],
      measures: [{ field: 'revenue', agg: 'avg', alias: 'revenue', label: 'Average sale' }],
    } })
    expect(resolveDynamicSpec(original, { group: '' })).toMatchObject({ query: { dimensions: [] }, viz: { type: 'table' } })
    expect(original).toEqual(copy)
  })

  it('keeps distinct candidate grains separate from the static date grain', () => {
    const original = { ...dynamicState(), dimensions: ['created', dimension.alias], grain: 'week' as const }
    expect(restore(buildSpec('ds', original, fields), fields)).toEqual(original)
  })

  it('uses raw default fields when converting to detail and drops aggregate-only metrics', () => {
    const original = dynamicState()
    const detailed = withType(original, 'detail', fields)
    expect(detailed).toMatchObject({ columns: ['created', 'revenue'], dimensions: [], measures: [] })
    expect(detailed.dynamics).toBeUndefined()
    expect(buildSpec('ds', detailed, fields).dynamics).toBeUndefined()
    const metricOnly = { ...original, dynamics: [dimension, { ...measure, options: [{ id: 'arpu', field: 'arpu' }] }] }
    expect(withType(metricOnly, 'detail', fields).columns).toEqual(['created'])
  })

  it('refuses choices with invalid fields, conflicting aliases or unmatched slots', () => {
    const saved = buildSpec('ds', dynamicState(), fields)
    expect(restore({ ...saved, dynamics: [{ ...dimension, alias: 'region' }, measure] }, fields)).toBeUndefined()
    expect(restore({ ...saved, dynamics: [{ ...dimension, options: [{ id: 'bad', field: 'missing' }] }, measure] }, fields)).toBeUndefined()
    expect(restore({ ...saved, dynamics: [{ ...dimension, alias: 'unmatched' }, measure] }, fields)).toBeUndefined()
  })
})

describe('shapeProblem', () => {
  const problem = (vizType: BuilderState['vizType'], dimensions: string[], measures = m('revenue')) => shapeProblem({ vizType, dimensions, measures })?.problem

  it('says what bars, lines and areas lack or have too much of', () => {
    for (const type of ['bar', 'line', 'area'] as const) {
      expect(problem(type, ['region'])).toBeUndefined()
      expect(problem(type, ['region'], m('revenue', 'arpu'))).toBeUndefined()
      expect(problem(type, ['region', 'channel'])).toBeUndefined()
      expect(problem(type, [])).toBe('needsDimension')
      expect(problem(type, ['region'], [])).toBe('needsMetric')
      expect(problem(type, ['region', 'channel', 'created'])).toBe('tooManyDimensions')
      expect(problem(type, ['region', 'channel'], m('revenue', 'arpu'))).toBe('oneMetricWithTwoDimensions')
    }
  })

  it('says what a pie or a KPI lacks or has too much of', () => {
    expect(problem('pie', ['region'])).toBeUndefined()
    expect(problem('pie', [])).toBe('needsDimension')
    expect(problem('pie', ['region', 'channel'])).toBe('oneDimension')
    expect(problem('pie', ['region'], [])).toBe('needsMetric')
    expect(problem('pie', ['region'], m('revenue', 'arpu'))).toBe('oneMetric')
    expect(problem('kpi', [], m('revenue', 'arpu'))).toBeUndefined()
    expect(problem('kpi', ['region'])).toBe('noDimension')
    expect(problem('kpi', [], [])).toBe('needsMetric')
  })

  it('has nothing to say about a table, grouped or not', () => {
    expect(problem('table', ['region', 'channel', 'created'], m('revenue', 'arpu'))).toBeUndefined()
    expect(problem('table', [], [])).toBeUndefined()
    expect(problem('detail', [], [])).toBeUndefined()
  })

  it('names the shelf where it is put right', () => {
    expect(shapeProblem({ vizType: 'bar', dimensions: [], measures: m('revenue') })?.shelf).toBe('dimension')
    expect(shapeProblem({ vizType: 'bar', dimensions: ['region'], measures: [] })?.shelf).toBe('metric')
  })
})

describe('buildViz', () => {
  it('puts time on the axis and the other dimension into series', () => {
    expect(buildViz(state({ dimensions: ['region', 'created'], vizType: 'bar', stacked: true }), fields)).toEqual({ type: 'bar', x: 'created', y: ['revenue'], series: 'region', stacked: true })
    expect(buildViz(state({ dimensions: ['region', 'channel'], vizType: 'line', stacked: true }), fields)).toEqual({ type: 'line', x: 'region', y: ['revenue'], series: 'channel' })
  })

  it('falls back to a table when the chosen type no longer fits', () => {
    expect(buildViz(state({ dimensions: ['region', 'channel'], vizType: 'pie' }), fields)).toEqual({ type: 'table' })
    expect(buildViz(state({ vizType: 'kpi' }), fields)).toEqual({ type: 'kpi', y: ['revenue'] })
  })

  it('writes the formats of the columns the query returns, and no others', () => {
    const formats = { revenue: { unit: 'wan' as const }, revenue_avg: { decimals: 1 }, gone: { prefix: '¥' } }
    expect(buildViz(state({ vizType: 'kpi', measures: [{ field: 'revenue', agg: 'sum' }, { field: 'revenue', agg: 'avg', alias: 'revenue_avg' }], formats }), fields)).toEqual({
      type: 'kpi',
      y: ['revenue', 'revenue_avg'],
      formats: { revenue: { unit: 'wan' }, revenue_avg: { decimals: 1 } },
    })
    // A column the formats do not name has none.
    expect(buildViz(state({ vizType: 'kpi', measures: [{ field: 'revenue', agg: 'max', alias: 'revenue_max' }], formats }), fields)).toEqual({ type: 'kpi', y: ['revenue_max'] })
    expect(buildViz(state({ vizType: 'detail', measures: [], columns: ['revenue'], formats }), fields)).toEqual({ type: 'table', formats: { revenue: { unit: 'wan' } } })
  })
})

describe('table column visibility', () => {
  it('round-trips hidden detail columns without changing the query or sorting', () => {
    const original = state({ vizType: 'detail', dimensions: [], measures: [], columns: ['region', 'revenue'], sort: [{ by: 'revenue', desc: true }] })
    const hidden = { ...original, hiddenColumns: ['revenue'] }
    const spec = buildSpec('ds', hidden, fields)
    expect(spec.query).toEqual(buildSpec('ds', original, fields).query)
    expect(spec.viz).toEqual({ type: 'table', hiddenColumns: ['revenue'] })
    expect(restore(JSON.parse(JSON.stringify(spec)) as ChartSpec, fields)).toEqual(hidden)
    expect(needsVisibleColumn(hidden)).toBe(false)
    expect(needsVisibleColumn({ ...hidden, hiddenColumns: ['region', 'revenue'] })).toBe(true)
  })

  it('keeps hidden dimensions and aliased measures in grouping, calculations, totals and ordering', () => {
    const original = state({ dimensions: ['region', 'channel'], measures: [...m('revenue'), { field: 'revenue', agg: 'sum', alias: 'share', compute: { type: 'percent_of_total', within: ['region'] } }], totals: true, sort: [{ by: 'revenue', desc: true }], formats: { share: { decimals: 1 } } })
    const hidden = { ...original, hiddenColumns: ['region', 'revenue'] }
    const spec = buildSpec('ds', hidden, fields)
    expect(spec.query).toEqual(buildSpec('ds', original, fields).query)
    expect(restore(spec, fields)).toEqual(hidden)
    expect(spec.viz.hiddenColumns).toEqual(['region', 'revenue'])
    const line = withType({ ...hidden, dimensions: ['region'] }, 'line', fields)
    expect(buildSpec('ds', line, fields).viz.hiddenColumns).toBeUndefined()
    expect(buildSpec('ds', withType(line, 'table', fields), fields).viz.hiddenColumns).toEqual(['region', 'revenue'])
    expect(pruneHiddenColumns({ ...hidden, dimensions: ['channel'], measures: [] }).hiddenColumns).toBeUndefined()
  })

  it('keeps dynamic visibility across choices and prunes only cleared dimensions without mutating the saved spec', () => {
    const dynamic = { id: 'group', alias: 'dynamic_group', kind: 'dimension' as const, label: 'Group', allowEmpty: true, options: [{ id: 'region', field: 'region' }, { id: 'channel', field: 'channel' }] }
    const hidden = state({ dimensions: [dynamic.alias], dynamics: [dynamic], hiddenColumns: [dynamic.alias] })
    const spec = buildSpec('ds', hidden, fields)
    expect(resolveDynamicSpec(spec, { group: 'channel' }).viz.hiddenColumns).toEqual([dynamic.alias])
    expect(resolveDynamicSpec(spec, { group: '' }).viz.hiddenColumns).toBeUndefined()
    expect(spec.viz.hiddenColumns).toEqual([dynamic.alias])
    expect(needsVisibleColumn(hidden)).toBe(false)
    // Hiding the only mandatory output would leave an empty table when the optional dimension is cleared.
    expect(needsVisibleColumn({ ...hidden, hiddenColumns: ['revenue'] })).toBe(true)
  })
})

describe('the other kinds of chart', () => {
  const two = { field: 'revenue', agg: 'avg' as const, alias: 'revenue_avg' }
  it('say what they lack or have too much of', () => {
    expect(shapeProblem(state({ vizType: 'combo', dimensions: ['created'] }))).toEqual({ shelf: 'metric', problem: 'needsTwoMetrics' })
    expect(shapeProblem(state({ vizType: 'combo', dimensions: ['created', 'region'], measures: [...m('revenue'), two] }))).toEqual({ shelf: 'dimension', problem: 'oneDimension' })
    expect(shapeProblem(state({ vizType: 'scatter', dimensions: ['region'], measures: [...m('revenue', 'arpu'), two, { field: 'revenue', agg: 'max' }] }))).toEqual({ shelf: 'metric', problem: 'tooManyMetrics', max: 3 })
    expect(shapeProblem(state({ vizType: 'heatmap', dimensions: ['region'] }))).toEqual({ shelf: 'dimension', problem: 'needsTwoDimensions' })
    expect(shapeProblem(state({ vizType: 'gauge', measures: [...m('revenue', 'arpu'), two] }))).toEqual({ shelf: 'metric', problem: 'tooManyMetrics', max: 2 })
    expect(shapeProblem(state({ vizType: 'funnel', dimensions: ['region'], measures: m('revenue', 'arpu') }))).toEqual({ shelf: 'metric', problem: 'oneMetric' })
    expect(shapeProblem(state({ vizType: 'treemap', dimensions: ['region', 'channel'] }))).toBeUndefined()
  })

  it('put each column where the kind of chart draws it', () => {
    const measures = [...m('revenue'), two]
    expect(buildViz(state({ vizType: 'hbar', dimensions: ['region'] }), fields)).toEqual({ type: 'hbar', x: 'region', y: ['revenue'] })
    // A combo chart starts with its first measure as bars and the others as lines, on one axis.
    expect(buildViz(state({ vizType: 'combo', dimensions: ['created'], measures }), fields)).toEqual({ type: 'combo', x: 'created', y: ['revenue', 'revenue_avg'], lines: ['revenue_avg'] })
    expect(buildViz(state({ vizType: 'combo', dimensions: ['created'], measures, lines: [], rightAxis: ['revenue_avg', 'gone'] }), fields)).toEqual({ type: 'combo', x: 'created', y: ['revenue', 'revenue_avg'], rightAxis: ['revenue_avg'] })
    expect(buildViz(state({ vizType: 'scatter', dimensions: ['region', 'channel'], measures }), fields)).toEqual({ type: 'scatter', x: 'region', y: ['revenue', 'revenue_avg'], series: 'channel' })
    expect(buildViz(state({ vizType: 'treemap', dimensions: ['region', 'channel'] }), fields)).toEqual({ type: 'treemap', x: 'channel', y: ['revenue'], series: 'region' })
    // Time runs across a heatmap.
    expect(buildViz(state({ vizType: 'heatmap', dimensions: ['region', 'created'] }), fields)).toEqual({ type: 'heatmap', rows: ['region'], columns: ['created'], y: ['revenue'] })
    expect(buildViz(state({ vizType: 'gauge', measures }), fields)).toEqual({ type: 'gauge', y: ['revenue', 'revenue_avg'] })
  })
})

describe('style', () => {
  it('writes only what applies to what is drawn', () => {
    const style = { legend: 'bottom' as const, smooth: true, solid: true, percent: true, labels: 'percent' as const, colors: { revenue: 'red' as const, gone: 'blue' as const }, xAxis: { title: ' 月份 ', min: 3, rotate: 45 as const }, yAxis: { min: 0, rotate: 90 as const }, y2Axis: { title: 'x' } }
    expect(styleFor({ type: 'line', x: 'month', y: ['revenue'] }, style)).toEqual({ legend: 'bottom', smooth: true, colors: { revenue: 'red' }, xAxis: { title: '月份', rotate: 45 }, yAxis: { min: 0 } })
    // A horizontal bar's value axis runs across; a share only stacks to the whole when stacked.
    expect(styleFor({ type: 'hbar', x: 'region', y: ['revenue'], stacked: true }, style)).toEqual({ legend: 'bottom', percent: true, colors: { revenue: 'red' }, xAxis: { title: '月份', min: 3 }, yAxis: { rotate: 90 } })
    expect(styleFor({ type: 'pie', x: 'region', y: ['revenue'] }, style)).toEqual({ legend: 'bottom', solid: true, labels: 'percent' })
    // Series made from a column's values take the palette's order.
    expect(styleFor({ type: 'bar', x: 'month', y: ['revenue'], series: 'region' }, { colors: { revenue: 'red' } })).toBeUndefined()
    expect(styleFor({ type: 'kpi', y: ['revenue'] }, style)).toBeUndefined()
    expect(styleFor({ type: 'gauge', y: ['a', 'b'] }, { gauge: { min: 0, max: 10 } })).toEqual({ gauge: { min: 0 } })
  })

  it('is kept when the type changes, and round-trips', () => {
    const shaped = state({ vizType: 'line', dimensions: ['created'], style: { smooth: true, legend: 'none' } })
    const pie = withType(shaped, 'pie', fields)
    // A pie has a legend but no lines to smooth.
    expect(buildViz(pie, fields).style).toEqual({ legend: 'none' })
    const back = withType(pie, 'line', fields)
    expect(buildViz(back, fields).style).toEqual({ smooth: true, legend: 'none' })
    const spec = buildSpec('ds', back, fields)
    expect(restore(JSON.parse(JSON.stringify(spec)) as ChartSpec, fields)).toEqual(back)
    const combo = state({ vizType: 'combo', dimensions: ['created'], measures: [...m('revenue'), { field: 'revenue', agg: 'avg', alias: 'revenue_avg' }], rightAxis: ['revenue_avg'] })
    const restored = restore(JSON.parse(JSON.stringify(buildSpec('ds', combo, fields))) as ChartSpec, fields)!
    expect(buildSpec('ds', restored, fields)).toEqual(buildSpec('ds', combo, fields))
    // A style the builder would not write leaves the chart read-only.
    const odd = { ...spec, viz: { ...spec.viz, style: { solid: true } } }
    expect(restore(odd, fields)).toBeUndefined()
  })
})

describe('pivot tables and totals', () => {
  const pivot = (patch: Partial<BuilderState> = {}) => state({ vizType: 'pivot', dimensions: ['region', 'created', 'channel'], pivotColumns: ['created'], totals: true, ...patch })
  it('put the dimensions down the side or across the top, in the order they were added', () => {
    expect(buildViz(pivot(), fields)).toEqual({ type: 'pivot', rows: ['region', 'channel'], columns: ['created'], y: ['revenue'] })
    expect(shapeProblem(pivot({ dimensions: [] }))).toEqual({ shelf: 'dimension', problem: 'needsDimension' })
  })

  it('ask for the total of each row, each column and everything, and never the table itself', () => {
    expect(totalsOf(pivot())).toEqual([['region', 'channel'], ['created'], []])
    expect(totalsOf(pivot({ pivotColumns: [] }))).toEqual([[]])
    expect(totalsOf(pivot({ pivotColumns: ['region', 'created', 'channel'] }))).toEqual([[]])
    expect(totalsOf(state({ vizType: 'table', dimensions: ['region'], totals: true }))).toEqual([[]])
    // A detail table has nothing to total; a table without groups is a total already.
    expect(totalsOf(state({ vizType: 'detail', columns: ['region'], totals: true }))).toEqual([])
    expect(totalsOf(state({ vizType: 'table', totals: true }))).toEqual([])
    expect(buildSpec('ds', pivot(), fields).query.totals).toEqual([['region', 'channel'], ['created'], []])
  })

  it('round-trip, with the table style and the totals', () => {
    const original = pivot({ style: { striped: true, freeze: true, widths: { region: 120, gone: 80 }, columnAlign: { revenue: 'center' } } })
    const spec = buildSpec('ds', original, fields)
    expect(spec.viz.style).toEqual({ striped: true, freeze: true, widths: { region: 120 }, columnAlign: { revenue: 'center' } })
    const restored = restore(JSON.parse(JSON.stringify(spec)) as ChartSpec, fields)!
    expect(buildSpec('ds', restored, fields)).toEqual(spec)
    expect(restored.totals).toBe(true)
    expect(restored.subtotals).toBeUndefined()
  })

  it('write the rules of the columns there are, a pivot table’s only for its measures, and none on a chart', () => {
    const red = [{ op: 'lt' as const, value: 0.8, color: 'red' as const }]
    const highlights = { revenue: red, region: red, gone: red }
    expect(buildSpec('ds', state({ vizType: 'table', dimensions: ['region'], style: { highlights } }), fields).viz.style).toEqual({ highlights: { revenue: red, region: red } })
    expect(buildSpec('ds', pivot({ style: { highlights } }), fields).viz.style).toEqual({ highlights: { revenue: red } })
    expect(buildSpec('ds', state({ vizType: 'bar', dimensions: ['region'], style: { highlights } }), fields).viz.style).toBeUndefined()
    const original = pivot({ style: { highlights: { revenue: [...red, { op: 'gte', value: 1, color: 'green', icon: 'up' }] } } })
    const spec = buildSpec('ds', original, fields)
    expect(buildSpec('ds', restore(JSON.parse(JSON.stringify(spec)) as ChartSpec, fields)!, fields)).toEqual(spec)
  })

  it('merge equal values on a table, summary or detail, and not on a pivot table, which always does', () => {
    expect(buildSpec('ds', state({ vizType: 'table', dimensions: ['region'], style: { merge: true } }), fields).viz.style).toEqual({ merge: true })
    expect(buildSpec('ds', state({ vizType: 'detail', columns: ['region'], style: { merge: true } }), fields).viz.style).toEqual({ merge: true })
    expect(buildSpec('ds', pivot({ style: { merge: true } }), fields).viz.style).toBeUndefined()
  })

  it('write a table’s paging, with a page size only for pages of a size', () => {
    const table = (style: BuilderState['style']) => buildSpec('ds', state({ vizType: 'table', dimensions: ['region'], style }), fields).viz.style
    expect(table({ paging: 'pages', pageSize: 50 })).toEqual({ paging: 'pages', pageSize: 50 })
    expect(table({ paging: 'auto', pageSize: 50 })).toEqual({ paging: 'auto' })
    expect(table({ pageSize: 50 })).toBeUndefined()
    expect(buildSpec('ds', pivot({ style: { paging: 'auto' } }), fields).viz.style).toBeUndefined()
  })

  it('write a table’s column groups as its columns stand, and none on other types', () => {
    const grouped = state({ dimensions: ['region', 'channel'], columnGroups: [{ label: '维度', columns: ['region', 'channel'] }, { label: '业绩', columns: ['revenue'] }] })
    const spec = buildSpec('ds', grouped, fields)
    expect(spec.viz.columnGroups).toEqual(grouped.columnGroups)
    expect(buildSpec('ds', restore(JSON.parse(JSON.stringify(spec)) as ChartSpec, fields)!, fields)).toEqual(spec)
    expect(buildSpec('ds', { ...grouped, vizType: 'bar' }, fields).viz.columnGroups).toBeUndefined()
    // A column taken off leaves its group, and a group left with none goes; one put back comes outside every group.
    const without = pruneColumnGroups({ ...grouped, dimensions: ['region'] })
    expect(without.columnGroups).toEqual([{ label: '维度', columns: ['region'] }, { label: '业绩', columns: ['revenue'] }])
    expect(buildSpec('ds', { ...without, dimensions: ['region', 'channel'] }, fields).viz.columnGroups).toEqual(without.columnGroups)
    expect(pruneColumnGroups({ ...grouped, measures: [] }).columnGroups).toEqual([{ label: '维度', columns: ['region', 'channel'] }])
    expect(pruneColumnGroups(grouped)).toBe(grouped)
  })

  it('take a dimension added between a group’s columns into the innermost group around it', () => {
    const across = state({ dimensions: ['region'], columnGroups: [{ label: '全部', columns: ['region', 'revenue'] }] })
    expect(pruneColumnGroups({ ...across, dimensions: ['region', 'channel'] }).columnGroups).toEqual([{ label: '全部', columns: ['region', 'channel', 'revenue'] }])
  })

  it('ask, with subtotals, for each group of an outer dimension paired with every level across, after the totals', () => {
    expect(totalsOf(pivot({ subtotals: true }))).toEqual([['region', 'channel'], ['created'], [], ['region', 'created'], ['region']])
    // Across the top too: a subtotal row needs a value under each subtotal column.
    expect(totalsOf(pivot({ subtotals: true, pivotColumns: ['created', 'channel'] }))).toEqual([['region'], ['created', 'channel'], [], ['region', 'created'], ['created']])
    expect(totalsOf(pivot({ subtotals: true, pivotColumns: ['region', 'created', 'channel'] }))).toEqual([[], ['region', 'created'], ['region']])
    // Nothing to subtotal with one dimension a side, and nothing at all without totals.
    expect(totalsOf(pivot({ subtotals: true, dimensions: ['region', 'created'] }))).toEqual([['region'], ['created'], []])
    expect(totalsOf(pivot({ subtotals: true, totals: undefined }))).toEqual([])
    expect(hasSubtotals(pivot({ dimensions: ['region', 'created'] }))).toBe(false)
  })

  it('leave the subtotals out rather than ask for more totals than the server takes', () => {
    const wide = pivot({ subtotals: true, dimensions: ['a', 'b', 'c', 'd', 'x', 'y', 'z'], pivotColumns: ['x', 'y', 'z'] })
    expect(subtotalsFit(wide)).toBe(false)
    expect(totalsOf(wide)).toEqual([['a', 'b', 'c', 'd'], ['x', 'y', 'z'], []])
    const fits = { ...wide, dimensions: ['a', 'b', 'c', 'x', 'y', 'z'] }
    expect(subtotalsFit(fits)).toBe(true)
    expect(totalsOf(fits)).toHaveLength(15)
    expect(totalsOf(fits).length).toBeLessThanOrEqual(maxTotals)
  })

  it('round-trip with subtotals', () => {
    const spec = buildSpec('ds', pivot({ subtotals: true }), fields)
    const restored = restore(JSON.parse(JSON.stringify(spec)) as ChartSpec, fields)!
    expect(restored.subtotals).toBe(true)
    expect(buildSpec('ds', restored, fields)).toEqual(spec)
    // Totals the builder would not ask for are not the builder's.
    expect(restore({ ...spec, query: { ...spec.query, totals: [['region', 'channel'], ['created'], [], ['region']] } }, fields)).toBeUndefined()
  })
})

describe('sankey diagrams', () => {
  const sankey = (dimensions: string[]) => state({ vizType: 'sankey', dimensions })
  it('take the dimensions as levels and ask for the flow between each pair of neighbours', () => {
    expect(shapeProblem(sankey(['region']))).toEqual({ shelf: 'dimension', problem: 'needsTwoDimensions' })
    expect(shapeProblem(sankey(['region', 'channel', 'created', 'revenue', 'arpu']))).toEqual({ shelf: 'dimension', problem: 'tooManyDimensions', max: 4 })
    expect(buildViz(sankey(['channel', 'region']), fields)).toEqual({ type: 'sankey', levels: ['channel', 'region'], y: ['revenue'] })
    // Two levels are the query's own rows.
    expect(totalsOf(sankey(['channel', 'region']))).toEqual([])
    expect(totalsOf(sankey(['channel', 'region', 'created']))).toEqual([['channel', 'region'], ['region', 'created']])
  })

  it('round-trip, without turning on a table’s totals', () => {
    const original = sankey(['channel', 'region', 'created'])
    const spec = buildSpec('ds', { ...original, style: { nodeAlign: 'left', labels: 'value' } }, fields)
    const restored = restore(JSON.parse(JSON.stringify(spec)) as ChartSpec, fields)!
    expect(buildSpec('ds', restored, fields)).toEqual(spec)
    expect(restored.totals).toBeUndefined()
  })
})

describe('totals when a dynamic dimension is left empty', () => {
  it('no longer name it, as the server prunes them', () => {
    const slot: DynamicField = { id: 'group', alias: 'group', kind: 'dimension', label: 'Group', allowEmpty: true, options: [{ id: 'region', field: 'region' }] }
    const spec = buildSpec('ds', state({ vizType: 'sankey', dimensions: ['group', 'channel', 'created'], dynamics: [slot] }), fields)
    expect(spec.query.totals).toEqual([['group', 'channel'], ['channel', 'created']])
    const resolved = resolveDynamicSpec(spec, { group: '' })
    expect(resolved.viz).toMatchObject({ type: 'sankey', levels: ['channel', 'created'] })
    expect(resolved.query.totals).toEqual([['channel']])
    expect(prunedTotals([['a', 'b'], ['b'], [], ['b', 'c']], ['b', 'c'])).toEqual([['b'], []])
  })
})

describe('KPI comparisons', () => {
  const kpi = (compare: Record<string, string>, style = {}) => state({ vizType: 'kpi', measures: [...m('revenue', 'arpu')], compare, style })
  it('pair measures of the chart, never in a chain, and write how only when there is one', () => {
    expect(buildViz(kpi({ revenue: 'arpu' }, { compareAs: 'both', redUp: true, size: 'large' }), fields)).toEqual({ type: 'kpi', y: ['revenue', 'arpu'], compare: { revenue: 'arpu' }, style: { compareAs: 'both', redUp: true, size: 'large' } })
    expect(buildViz(kpi({ revenue: 'gone' }, { compareAs: 'diff' }), fields)).toEqual({ type: 'kpi', y: ['revenue', 'arpu'] })
    expect(buildViz(kpi({ revenue: 'arpu', arpu: 'revenue' }), fields).compare).toBeUndefined()
  })
})

describe('measures aggregated for one chart', () => {
  it('asks for them by field and aggregation, under the names they were given', () => {
    const measures = [{ field: 'revenue', agg: 'sum' as const }, { field: 'revenue', agg: 'avg' as const, alias: 'revenue_avg' }, { field: 'channel', agg: 'count_distinct' as const, alias: 'channel_count_distinct' }]
    const spec = buildSpec('ds_1', state({ dimensions: ['region'], vizType: 'bar', measures }), fields)
    expect(spec.query.measures).toEqual(measures)
    expect(spec.viz.y).toEqual(['revenue', 'revenue_avg', 'channel_count_distinct'])
  })

  it('names a new measure apart from the other columns, within the length a name may have', () => {
    expect(addMeasure([], field('revenue'), ['revenue'])).toEqual([{ field: 'revenue', agg: 'sum', alias: 'revenue_sum' }])
    const twice = addMeasure(addMeasure([], field('revenue')), field('revenue'), ['revenue_avg'])
    expect(twice.map((measure) => measure.alias ?? measure.field)).toEqual(['revenue', 'revenue_avg_2'])
    const long: SpecField = { key: 'x'.repeat(63), label: 'x', type: 'string', role: 'dimension' }
    expect(addMeasure([], long)).toEqual([{ field: long.key, agg: 'count_distinct', alias: `${'x'.repeat(45)}_count_distinct` }])
  })

  it('offers the aggregations of a field, starting with its own', () => {
    expect(aggChoices(field('revenue'))).toEqual(['sum', 'avg', 'min', 'max', 'count', 'count_distinct'])
    expect(aggChoices(field('region'))).toEqual(['count_distinct', 'count', 'min', 'max'])
    expect(aggChoices(field('arpu'))).toEqual([])
  })

  it('offers each aggregation the same field is not given elsewhere on the chart', () => {
    expect(aggOptions(m('revenue'), 0, field('revenue'))).toEqual(['sum', 'avg', 'min', 'max', 'count', 'count_distinct'])
    expect(aggOptions([{ field: 'revenue', agg: 'sum' }, { field: 'revenue', agg: 'avg' }], 1, field('revenue'))).toEqual(['avg', 'min', 'max', 'count', 'count_distinct'])
    expect(aggOptions([{ field: 'revenue', agg: 'sum' }, { field: 'revenue', agg: 'avg' }], 0, field('revenue'))).toEqual(['sum', 'min', 'max', 'count', 'count_distinct'])
    expect(aggOptions([{ field: 'region', agg: 'count' }], 0, field('region'))).toEqual(['count_distinct', 'count', 'min', 'max'])
  })

  it('adds a measure summed, a dimension counted, and a field again with the next aggregation not in use', () => {
    let measures = addMeasure([], field('revenue'))
    expect(measures).toEqual([{ field: 'revenue', agg: 'sum' }])
    measures = addMeasure(measures, field('revenue'))
    expect(measures).toEqual([{ field: 'revenue', agg: 'sum' }, { field: 'revenue', agg: 'avg', alias: 'revenue_avg' }])
    expect(addMeasure([], field('region'))).toEqual([{ field: 'region', agg: 'count_distinct', alias: 'region_count_distinct' }])
    expect(addMeasure(m('arpu'), field('arpu'))).toEqual(m('arpu'))
  })
})

describe('changing how a measure is aggregated', () => {
  it('keeps the name of its column and drops the format the chart gave it', () => {
    const before = state({ vizType: 'kpi', measures: [{ field: 'revenue', agg: 'sum' }, { field: 'revenue', agg: 'avg', alias: 'revenue_avg' }], formats: { revenue: { unit: 'wan' }, revenue_avg: { decimals: 1 } } })
    expect(reaggregated(before, 0, 'count')).toEqual({ measures: [{ field: 'revenue', agg: 'count' }, { field: 'revenue', agg: 'avg', alias: 'revenue_avg' }], formats: { revenue_avg: { decimals: 1 } } })
    expect(reaggregated({ ...before, formats: { revenue: { unit: 'wan' } } }, 0, 'max').formats).toBeUndefined()
    expect(buildViz({ ...before, ...reaggregated(before, 0, 'count') }, fields).y).toEqual(['revenue', 'revenue_avg'])
  })

  it('drops the rules of its conditional format, whose thresholds no longer fit, and keeps the others', () => {
    const red = [{ op: 'lt' as const, value: 100, color: 'red' as const }]
    const before = state({ measures: [{ field: 'revenue', agg: 'sum' }, { field: 'revenue', agg: 'avg', alias: 'revenue_avg' }], style: { striped: true, highlights: { revenue: red, revenue_avg: red } } })
    expect(reaggregated(before, 0, 'count').style).toEqual({ striped: true, highlights: { revenue_avg: red } })
    expect(reaggregated({ ...before, style: { highlights: { revenue: red } } }, 0, 'max').style).toEqual({ highlights: undefined })
    expect(recomputed(before, 1, { type: 'percent_of_total' }).style).toEqual({ striped: true, highlights: { revenue: red } })
    expect(recomputed(before, 1, undefined)).toBe(before)
  })
})

describe('detail tables', () => {
  it('ask for the rows as they are, and show them as a table', () => {
    expect(buildSpec('ds_1', state({ vizType: 'detail', measures: [], columns: ['region', 'revenue'] }), fields)).toEqual({
      specVersion: 1,
      query: { version: 1, dataset: 'ds_1', mode: 'detail', columns: ['region', 'revenue'] },
      viz: { type: 'table' },
    })
  })

  it('keep what was picked when going there and back, except metrics', () => {
    const chart = state({ dimensions: ['region'], vizType: 'bar', stacked: true, measures: [{ field: 'revenue', agg: 'avg' }, { field: 'revenue' }, { field: 'arpu' }] })
    const detail = withType(chart, 'detail', fields)
    expect(detail).toMatchObject({ vizType: 'detail', dimensions: [], measures: [], columns: ['region', 'revenue'], stacked: false })
    expect(withType(detail, 'bar', fields)).toMatchObject({ vizType: 'bar', dimensions: ['region'], measures: [{ field: 'revenue', agg: 'sum' }], columns: [] })
    // The type asked for is the type given, even when what carries over does not fit it yet.
    expect(withType(detail, 'kpi', fields).vizType).toBe('kpi')
    expect(withType(chart, 'line', fields)).toEqual({ ...chart, vizType: 'line' })
  })
})

describe('order and number of rows', () => {
  it('are asked for by output column, with the limit as it is set', () => {
    const chart = state({ dimensions: ['region'], vizType: 'bar', measures: [{ field: 'revenue', agg: 'sum' }, { field: 'revenue', agg: 'avg', alias: 'revenue_avg' }], sort: [{ by: 'revenue_avg', desc: true }, { by: 'region' }], limit: 10 })
    expect(buildSpec('ds_1', chart, fields).query).toMatchObject({ sort: [{ by: 'revenue_avg', desc: true }, { by: 'region' }], limit: 10 })
    expect(buildSpec('ds_1', state({ vizType: 'detail', measures: [], columns: ['region'], sort: [{ by: 'region' }], limit: 5 }), fields).query).toEqual({ version: 1, dataset: 'ds_1', mode: 'detail', columns: ['region'], sort: [{ by: 'region' }], limit: 5 })
    // Neither is written when not set: the chart is ordered by its dimensions, with the server's default number of rows.
    expect(buildSpec('ds_1', state({ dimensions: ['region'], vizType: 'bar' }), fields).query).not.toHaveProperty('sort')
    expect(buildSpec('ds_1', state({ dimensions: ['region'], vizType: 'bar' }), fields).query).not.toHaveProperty('limit')
  })

  it('keep the place of a key whose direction changes, and add a new key last', () => {
    let sort = sortedBy({}, 'revenue', 'desc')
    expect(sort.sort).toEqual([{ by: 'revenue', desc: true }])
    sort = sortedBy(sort, 'region', 'asc')
    sort = sortedBy(sort, 'revenue', 'asc')
    expect(sort.sort).toEqual([{ by: 'revenue' }, { by: 'region' }])
    sort = sortedBy(sort, 'revenue', undefined)
    expect(sort.sort).toEqual([{ by: 'region' }])
    expect(sortedBy(sort, 'region', undefined).sort).toBeUndefined()
  })

  it('drop a column the chart no longer returns', () => {
    const chart = state({ dimensions: ['region'], vizType: 'bar', sort: [{ by: 'region' }, { by: 'revenue', desc: true }] })
    expect(withoutStaleSort({ ...chart, dimensions: [] }).sort).toEqual([{ by: 'revenue', desc: true }])
    expect(withoutStaleSort({ ...chart, dimensions: [], measures: [] })).not.toHaveProperty('sort')
    // A detail table returns its fields as they are, so an order by a dimension carries over and one by a measure's column only where it is named after its field.
    const detail = withType({ ...chart, measures: [{ field: 'revenue', agg: 'avg', alias: 'revenue_avg' }], sort: [{ by: 'region' }, { by: 'revenue_avg' }] }, 'detail', fields)
    expect(detail.sort).toEqual([{ by: 'region' }])
  })
})

describe('names given on the chart', () => {
  it('go with the dimension, measure or column they are for', () => {
    const chart = buildSpec('ds_1', state({ dimensions: ['region'], vizType: 'bar', labels: { region: '大区' }, measures: [{ field: 'revenue', agg: 'sum', label: 'GMV' }, { field: 'revenue', agg: 'avg', alias: 'revenue_avg' }] }), fields)
    expect(chart.query.dimensions).toEqual([{ field: 'region', label: '大区' }])
    expect(chart.query.measures).toEqual([{ field: 'revenue', agg: 'sum', label: 'GMV' }, { field: 'revenue', agg: 'avg', alias: 'revenue_avg' }])
    const detail = buildSpec('ds_1', state({ vizType: 'detail', measures: [], columns: ['region', 'revenue'], labels: { revenue: '实付' } }), fields)
    expect(detail.query.columns).toEqual(['region', { field: 'revenue', label: '实付' }])
  })
})

describe('restore', () => {
  const when: ChartFilter = { id: 'when', field: 'created', op: 'time', value: { last: { n: 12, unit: 'month' }, includeCurrent: true }, label: '下单时间', control: { type: 'relative' }, exposed: true }

  it('round-trips what the builder writes, as the server would return it', () => {
    for (const original of [
      state({ dimensions: ['created'], vizType: 'line', filters: [when], grain: 'week' }),
      state({ dimensions: ['region', 'created'], vizType: 'area', stacked: true, filters: [when, { id: 'east', field: 'region', op: 'in', value: ['华东'] }] }),
      state({ vizType: 'kpi', measures: m('revenue', 'arpu') }),
      state({ dimensions: ['region'], vizType: 'pie' }),
      state({ vizType: 'kpi', filters: [{ id: 'this_year', field: 'created', op: 'time', value: { current: 'year' } }, { id: 'named', field: 'region', op: 'not_null' }] }),
      state({ dimensions: ['region'], vizType: 'bar', measures: [{ field: 'revenue', agg: 'sum' }, { field: 'revenue', agg: 'avg', alias: 'revenue_avg' }, { field: 'channel', agg: 'count_distinct', alias: 'channel_count_distinct' }] }),
      state({ vizType: 'detail', measures: [], columns: ['region', 'revenue'], filters: [{ id: 'region', field: 'region', op: 'in', label: '地区', control: { type: 'search_select', multi: true } }] }),
      state({ dimensions: ['region'], vizType: 'bar', labels: { region: '大区' }, measures: [{ field: 'revenue', agg: 'sum', label: 'GMV' }, { field: 'revenue', agg: 'avg', alias: 'revenue_avg', label: '客单' }] }),
      state({ vizType: 'detail', measures: [], columns: ['region', 'revenue'], labels: { revenue: '实付' } }),
      // A name an older chart gave its column is kept, so what refers to it still finds it.
      state({ vizType: 'kpi', measures: [{ field: 'revenue', agg: 'avg', alias: 'amount_sum' }] }),
      state({ dimensions: ['region'], vizType: 'bar', formats: { revenue: { decimals: 0, grouping: false, unit: 'wan', suffix: '万元' } } }),
      state({ dimensions: ['region'], vizType: 'bar', sort: [{ by: 'revenue', desc: true }, { by: 'region' }], limit: 10 }),
      state({ vizType: 'detail', measures: [], columns: ['region', 'revenue'], sort: [{ by: 'revenue' }], limit: 200 }),
    ]) {
      const spec = buildSpec('ds_1', original, fields)
      // The server drops false and empty values and may reorder keys.
      const fromServer = JSON.parse(JSON.stringify(spec)) as ChartSpec
      expect(restore(fromServer, fields)).toEqual({ ...original, filters: original.filters.map(cleanFilter) })
    }
  })

  it('keeps a measure the dataset broke since, so it can be taken off the chart', () => {
    const base = buildSpec('ds_1', state({ dimensions: ['region'], vizType: 'bar' }), fields)
    const gone = { ...base, query: { ...base.query, measures: [{ field: 'gone' }] }, viz: { ...base.viz, y: ['gone'] } }
    expect(restore(gone, fields)?.measures).toEqual([{ field: 'gone' }])
    const madeMetric = { ...base, query: { ...base.query, measures: [{ field: 'arpu', agg: 'sum' }] }, viz: { ...base.viz, y: ['arpu'] } }
    expect(restore(madeMetric, fields)?.measures).toEqual([{ field: 'arpu', agg: 'sum' }])
  })

  it('leaves a chart read-only when it formats a column it does not return', () => {
    const spec = buildSpec('ds_1', state({ vizType: 'kpi' }), fields)
    expect(restore({ ...spec, viz: { ...spec.viz, formats: { nope: { unit: 'K' } } } }, fields)).toBeUndefined()
  })

  it('keeps legacy exposed filters editable while dropping the obsolete flag', () => {
    const spec = buildSpec('ds_1', state({ dimensions: ['created'], vizType: 'line', filters: [when] }), fields)
    ;(spec.filters![0] as { exposed?: boolean }).exposed = true
    expect(restore(spec, fields)?.filters).toEqual([cleanFilter(when)])
  })

  it('stores filters without what says nothing', () => {
    const spec = buildSpec('ds_1', state({ vizType: 'kpi', filters: [{ id: 'f', field: 'region', op: 'in', value: [], label: '地区', control: { type: 'select', multi: false }, exposed: false }] }), fields)
    expect(spec.filters).toEqual([{ id: 'f', field: 'region', op: 'in', label: '地区', control: { type: 'select' } }])
    expect(buildSpec('ds_1', state({ vizType: 'kpi' }), fields).filters).toBeUndefined()
    // The query says what is asked; the filters are beside it.
    expect(spec.query.filter).toBeUndefined()
  })

  it('refuses specs that say more than the builder can', () => {
    const base = buildSpec('ds_1', state({ dimensions: ['region'], vizType: 'bar' }), fields)
    const withQuery = (patch: Record<string, unknown>): ChartSpec => ({ ...base, query: { ...base.query, ...patch } })
    expect(restore(withQuery({ filter: { field: 'region', op: 'eq', value: '华东' } }), fields)).toBeUndefined()
    // An order by a column the chart does not return, a limit that is no number of rows, rows skipped.
    expect(restore(withQuery({ sort: [{ by: 'channel' }] }), fields)).toBeUndefined()
    expect(restore(withQuery({ sort: [{ by: 'revenue', desc: 'yes' }] }), fields)).toBeUndefined()
    expect(restore(withQuery({ sort: { by: 'revenue' } }), fields)).toBeUndefined()
    expect(restore(withQuery({ limit: 0 }), fields)).toBeUndefined()
    expect(restore(withQuery({ limit: 2.5 }), fields)).toBeUndefined()
    expect(restore(withQuery({ limit: 10, offset: 10 }), fields)).toBeUndefined()
    expect(restore(withQuery({ dimensions: [{ field: 'region', alias: 'area' }] }), fields)).toBeUndefined()
    expect(restore(withQuery({ measures: [{ field: 'region', agg: 'count', alias: 'n' }] }), fields)).toBeUndefined()
    // A measure that does not say how it is aggregated.
    expect(restore(withQuery({ measures: [{ field: 'revenue' }] }), fields)).toBeUndefined()
    expect(restore({ ...withQuery({ measures: [{ field: 'revenue', agg: 'median', alias: 'revenue_median' }] }), viz: { ...base.viz, y: ['revenue_median'] } }, fields)).toBeUndefined()
    // A filter the editor could not have written: on a field that is gone, or a condition it does not offer.
    expect(restore({ ...base, filters: [{ id: 'f', field: 'nope', op: 'in', value: ['a'] }] }, fields)).toBeUndefined()
    expect(restore({ ...base, filters: [{ id: 'f', field: 'region', op: 'unknown' as never, value: 'a' }] }, fields)).toBeUndefined()
    expect(restore({ ...base, viz: { ...base.viz, x: 'revenue' } }, fields)).toBeUndefined()
  })
})

describe('fieldsUsed', () => {
  it('finds the fields a chart groups by, measures and filters on', () => {
    const spec = {
      specVersion: 1,
      query: { version: 1, dataset: 'ds', dimensions: [{ field: 'region', label: 'Area' }], measures: [{ field: 'revenue' }, { field: 'cost', agg: 'avg', alias: 'avg_cost' }] },
      viz: { type: 'bar', x: 'region', y: ['revenue', 'avg_cost'] },
      filters: [{ id: 'f', field: 'day', op: 'in', value: ['a'] }],
    }
    expect([...fieldsUsed(spec)].sort()).toEqual(['cost', 'day', 'region', 'revenue'])
  })

  it('finds the columns of a detail table, labelled or not', () => {
    const spec = { query: { version: 1, dataset: 'ds', mode: 'detail', columns: ['region', { field: 'day', label: 'Date' }] }, viz: { type: 'table' } }
    expect([...fieldsUsed(spec)].sort()).toEqual(['day', 'region'])
  })
})


describe('percent of total', () => {
  it('round trips grouped percentages and keeps unsupported definitions read-only', () => {
    const original = state({ dimensions: ['region', 'channel'], measures: [{ field: 'revenue', agg: 'sum', compute: { type: 'percent_of_total', within: ['region'] } }], totals: true })
    const saved = buildSpec('ds', original, fields)
    expect(restore(saved, fields)).toEqual(original)
    const withCompute = (compute: unknown) => ({ ...saved, query: { ...saved.query, measures: [{ field: 'revenue', agg: 'sum', compute }] } })
    for (const compute of [{ type: 'compare' }, { type: 'percent_of_total', within: ['missing'] }, { type: 'percent_of_total', within: ['region', 'region'] }, { type: 'percent_of_total', ignored: true }]) expect(restore(withCompute(compute), fields)).toBeUndefined()
  })
  it('allows a raw aggregate beside its share and resets stale currency formats', () => {
    const changed = recomputed(state({ formats: { revenue: { prefix: '$' } } }), 0, { type: 'percent_of_total' })
    expect(changed.formats).toBeUndefined()
    const formatted = { ...changed, formats: { revenue: { decimals: 3 } } }
    expect(recomputed(formatted, 0, { type: 'percent_of_total' })).toBe(formatted)
    const both = addMeasure(changed.measures, field('revenue'))
    expect(both).toEqual([{ field: 'revenue', agg: 'sum', compute: { type: 'percent_of_total' } }, { field: 'revenue', agg: 'sum', alias: 'revenue_sum' }])
    expect(aggOptions(both, 1, field('revenue'))).toContain('sum')
    const original = [{ field: 'revenue', agg: 'sum' as const, compute: { type: 'percent_of_total' as const, within: ['region', 'channel'] } }]
    expect(pruneComputes(original, ['region'])[0]!.compute).toEqual({ type: 'percent_of_total', within: ['region'] })
    expect(original[0]!.compute.within).toEqual(['region', 'channel'])
  })
  it('preserves computation across dynamic selection and prunes an omitted grouping', () => {
    const dynamics: DynamicField[] = [
      { id: 'group', alias: 'group', kind: 'dimension', label: 'Group', allowEmpty: true, options: [{ id: 'region', field: 'region' }] },
      { id: 'value', alias: 'value', kind: 'measure', label: 'Value', options: [{ id: 'sum', field: 'revenue', agg: 'sum' }, { id: 'avg', field: 'revenue', agg: 'avg' }] },
    ]
    const original = state({ dimensions: ['group'], measures: [{ field: 'value', compute: { type: 'percent_of_total', within: ['group'] } }], dynamics })
    const saved = buildSpec('ds', original, fields)
    expect(restore(saved, fields)).toEqual(original)
    expect(resolveDynamicSpec(saved, { group: '', value: 'avg' }).query.measures).toEqual([{ field: 'revenue', agg: 'avg', alias: 'value', compute: { type: 'percent_of_total', within: [] } }])
    expect((saved.query.measures as { compute: unknown }[])[0]!.compute).toEqual({ type: 'percent_of_total', within: ['group'] })
  })
})

describe('running totals', () => {
  it('round trips a running total and keeps one along nothing on the chart read-only', () => {
    const original = state({ dimensions: ['region', 'channel'], measures: [{ field: 'revenue', agg: 'sum', compute: { type: 'cumulative', along: 'channel' } }] })
    const saved = buildSpec('ds', original, fields)
    expect(saved.query.measures).toEqual([{ field: 'revenue', agg: 'sum', compute: { type: 'cumulative', along: 'channel' } }])
    expect(restore(saved, fields)).toEqual(original)
    const withCompute = (compute: unknown) => ({ ...saved, query: { ...saved.query, measures: [{ field: 'revenue', agg: 'sum', compute }] } })
    for (const compute of [{ type: 'cumulative' }, { type: 'cumulative', along: 'missing' }, { type: 'cumulative', along: 'region', within: ['region'] }]) expect(restore(withCompute(compute), fields)).toBeUndefined()
  })
  it('goes back to the original value without the dimension it runs along', () => {
    const original = [{ field: 'revenue', agg: 'sum' as const, compute: { type: 'cumulative' as const, along: 'channel' } }]
    expect(pruneComputes(original, ['region', 'channel'])[0]).toBe(original[0])
    expect(pruneComputes(original, ['region'])).toEqual([{ field: 'revenue', agg: 'sum' }])
    expect(original[0]!.compute).toEqual({ type: 'cumulative', along: 'channel' })
  })
  it('is the plain aggregate when a dynamic dimension it runs along is left empty', () => {
    const dynamics: DynamicField[] = [
      { id: 'group', alias: 'group', kind: 'dimension', label: 'Group', allowEmpty: true, options: [{ id: 'region', field: 'region' }] },
    ]
    const original = state({ dimensions: ['group'], measures: [{ field: 'revenue', agg: 'sum', compute: { type: 'cumulative', along: 'group' } }], dynamics })
    const saved = buildSpec('ds', original, fields)
    expect(restore(saved, fields)).toEqual(original)
    expect(resolveDynamicSpec(saved, { group: '' }).query.measures).toEqual([{ field: 'revenue', agg: 'sum' }])
    expect(resolveDynamicSpec(saved, {}).query.measures).toEqual([{ field: 'revenue', agg: 'sum', compute: { type: 'cumulative', along: 'group' } }])
  })
})

it('round-trips comparisons, retains them when dimensions change, and resets formats on output changes', () => {
  const compute = { type: 'compare' as const, timeField: 'created', offset: { n: 1, unit: 'year' as const }, output: 'ratio' as const }
  const original = state({ dimensions: ['created', 'region'], measures: [{ field: 'revenue', agg: 'sum', compute }], filters: [{ id: 'period', field: 'created', op: 'time', value: { current: 'month' } }] })
  const spec = buildSpec('ds', original, fields)
  const restored = restore(spec, fields)!
  expect(restored.measures[0]!.compute).toEqual(compute)
  expect(pruneComputes(restored.measures, [])[0]!.compute).toEqual(compute)
  const changed = recomputed({ ...restored, formats: { revenue: { style: 'percent' } } }, 0, { ...compute, output: 'value' })
  expect(changed.formats).toBeUndefined()
  expect(buildSpec('ds', { ...restored, ...changed }, fields).query.measures).toEqual([{ field: 'revenue', agg: 'sum', compute: { ...compute, output: 'value' } }])
})

it('keeps dynamic option names as aggregate names when applying and restoring comparisons', () => {
  const compute = { type: 'compare' as const, timeField: 'created', offset: { n: 1, unit: 'year' as const }, output: 'value' as const }
  const dynamics: DynamicField[] = [{ id: 'metric', alias: 'metric', label: 'Metric', kind: 'measure', options: [{ id: 'sum', field: 'revenue', agg: 'sum', label: 'SUM(Revenue)' }, { id: 'avg', field: 'revenue', agg: 'avg', label: 'Average sale' }] }]
  const original = state({ measures: [{ field: 'metric', compute }], dynamics, filters: [{ id: 'period', field: 'created', op: 'time', value: { current: 'month' } }] })
  const saved = buildSpec('ds', original, fields)
  expect(saved.query.measures).toEqual([{ field: 'revenue', alias: 'metric', agg: 'sum', baseLabel: 'SUM(Revenue)', compute }])
  expect(restore(saved, fields)).toEqual(original)
  expect(resolveDynamicSpec(saved, { metric: 'avg' }).query.measures).toEqual([{ field: 'revenue', alias: 'metric', agg: 'avg', baseLabel: 'Average sale', compute }])
  // Earlier saved charts used label for the automatically populated option
  // name. They stay editable and migrate on the next save.
  const legacy = structuredClone(saved)
  legacy.query.measures = [{ field: 'revenue', alias: 'metric', agg: 'sum', label: 'SUM(Revenue)', compute }]
  const restored = restore(legacy, fields)!
  expect(restored).toEqual(original)
  expect(buildSpec('ds', restored, fields)).toEqual(saved)
  expect(buildSpec('ds', { ...restored, ...recomputed(restored, 0, undefined) }, fields).query.measures).toEqual([{ field: 'revenue', alias: 'metric', agg: 'sum', label: 'SUM(Revenue)' }])
})

describe('drilling down', () => {
  const regions = { alias: 'region', levels: [{ field: 'channel', label: '渠道' }, { field: 'created', grain: 'month' as const, label: '下单时间 · 月' }] }
  const bars = () => state({ dimensions: ['region'], vizType: 'bar', drill: regions })

  it('writes the drill on the category axis and restores it', () => {
    const spec = buildSpec('ds', bars(), fields)
    expect(spec.drill).toEqual(regions)
    expect(restore(JSON.parse(JSON.stringify(spec)) as ChartSpec, fields)).toEqual(bars())
  })

  it('offers the category axis, the slices of a pie or any dimension of a grouped table, and no dynamic one', () => {
    expect(drillableColumns(state({ dimensions: ['created', 'region'], vizType: 'bar' }), fields)).toEqual(['created'])
    expect(drillableColumns(state({ dimensions: ['region'], vizType: 'pie' }), fields)).toEqual(['region'])
    expect(drillableColumns(state({ dimensions: ['region', 'channel'], vizType: 'table' }), fields)).toEqual(['region', 'channel'])
    for (const vizType of ['scatter', 'pivot', 'heatmap', 'detail'] as const) expect(drillableColumns(state({ dimensions: ['region', 'channel'], measures: m('revenue', 'arpu'), vizType }), fields)).toEqual([])
    const dynamic: DynamicField = { id: 'group', alias: 'dynamic_group', kind: 'dimension', label: 'Group', options: [{ id: 'region', field: 'region' }] }
    expect(drillableColumns(state({ dimensions: ['dynamic_group'], dynamics: [dynamic], vizType: 'bar' }), fields)).toEqual([])
  })

  it('keeps the drill while the chart cannot be drilled there, without writing it, and back again', () => {
    const scatter = withType(bars(), 'scatter', fields)
    expect(scatter.drill).toEqual(regions)
    expect(buildSpec('ds', scatter, fields).drill).toBeUndefined()
    expect(buildSpec('ds', withType(withType(bars(), 'detail', fields), 'bar', fields), fields).drill).toEqual(regions)
    // Become the series, the dimension is not drilled either.
    const split = state({ dimensions: ['region', 'created'], vizType: 'bar', drill: regions })
    expect(buildSpec('ds', split, fields).drill).toBeUndefined()
  })

  it('goes with its dimension, but not with a detail table', () => {
    expect(pruneDrill({ ...bars(), dimensions: [] }).drill).toBeUndefined()
    expect(pruneDrill({ ...bars(), dimensions: [], vizType: 'detail' }).drill).toEqual(regions)
  })

  it('says what is wrong with its levels, as the server does', () => {
    expect(chartDrillProblem(bars(), fields)).toBeUndefined()
    // A date goes finer only: by month, then not by year.
    const months = state({ dimensions: ['created'], vizType: 'line', drill: { alias: 'created', levels: [{ field: 'created', grain: 'day' }] } })
    expect(chartDrillProblem(months, fields)).toBeUndefined()
    expect(chartDrillProblem({ ...months, grain: 'day' }, fields)).toBe('repeated')
    expect(chartDrillProblem({ ...months, drill: { alias: 'created', levels: [{ field: 'created', grain: 'year' }] } }, fields)).toBe('grain')
    expect(chartDrillProblem({ ...months, grain: 'week', drill: { alias: 'created', levels: [{ field: 'created', grain: 'month' }] } }, fields)).toBe('grain')
    // Another dimension of the chart, or a field that is no dimension.
    const table = state({ dimensions: ['region', 'channel'], vizType: 'table', drill: { alias: 'region', levels: [{ field: 'channel' }] } })
    expect(chartDrillProblem(table, fields)).toBe('repeated')
    expect(chartDrillProblem({ ...table, drill: { alias: 'region', levels: [{ field: 'revenue' }] } }, fields)).toBe('unknownField')
    expect(chartDrillProblem({ ...table, drill: { alias: 'region', levels: [{ field: 'created', grain: 'month' }] }, hiddenColumns: ['region'] }, fields)).toBe('hidden')
    // A dynamic dimension is written as its first choice, which a level may not repeat either.
    const dynamic: DynamicField = { id: 'group', alias: 'dynamic_group', kind: 'dimension', label: 'Group', options: [{ id: 'channel', field: 'channel' }, { id: 'month', field: 'created', grain: 'month' }] }
    const split = state({ dimensions: ['region', 'dynamic_group'], dynamics: [dynamic], vizType: 'table', drill: { alias: 'region', levels: [{ field: 'created', grain: 'month' }] } })
    expect(chartDrillProblem(split, fields)).toBeUndefined()
    expect(chartDrillProblem({ ...split, drill: { alias: 'region', levels: [{ field: 'channel' }] } }, fields)).toBe('repeated')
  })

  it('leaves a drill it would not write as it is, shown and not edited', () => {
    const spec = buildSpec('ds', bars(), fields)
    expect(restore({ ...spec, drill: { ...regions, levels: [{ field: 'created' }] } }, fields)).toBeUndefined()
    expect(restore({ ...spec, drill: { ...regions, levels: [{ field: 'created', grain: 'hour' as never }] } }, fields)).toBeUndefined()
    expect(restore({ ...spec, drill: { ...regions, extra: true } as never }, fields)).toBeUndefined()
    expect(restore({ ...spec, drill: { ...regions, alias: 'channel' } }, fields)).toBeUndefined()
  })
})

describe('parameter filters', () => {
  const when: ChartFilter = { id: 'when', field: 'created', op: 'time', value: { last: { n: 12, unit: 'month' }, includeCurrent: true }, label: '下单时间', control: { type: 'relative' } }
  const day: ParamFilter = { id: 'p_day', param: 'day', label: '业务日期', control: { type: 'input' } }
  const fixed: ParamFilter = { id: 'p_top', param: 'top', value: 20 }

  it('are written before the field filters, and read back apart from them', () => {
    const spec = buildSpec('ds_1', state({ vizType: 'kpi', filters: [when], params: [day, fixed] }), fields)
    expect(spec.filters?.map((filter) => filter.id)).toEqual(['p_day', 'p_top', when.id])
    const restored = restore(spec, fields)
    expect(restored?.params).toEqual([day, fixed])
    expect(restored?.filters).toEqual([cleanFilter(when)])
  })

  it('keep a chart editable wherever the spec put them, and a value given as none', () => {
    const spec = buildSpec('ds_1', state({ vizType: 'kpi', filters: [when], params: [{ ...day, value: null }] }), fields)
    expect(restore({ ...spec, filters: [...spec.filters!].reverse() }, fields)?.params).toEqual([{ ...day, value: null }])
  })

  it('leave a chart read-only when their control is not one the editor offers', () => {
    const spec = buildSpec('ds_1', state({ vizType: 'kpi', params: [day] }), fields)
    expect(restore({ ...spec, filters: [{ ...day, control: { type: 'slider' } } as unknown as ParamFilter] }, fields)).toBeUndefined()
  })
})
