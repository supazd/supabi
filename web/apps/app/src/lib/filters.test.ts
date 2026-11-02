import { describe, expect, it } from 'vitest'
import type { SpecField } from '../api/spec'
import i18n from 'i18next'
import '../i18n'
import { alike, cascadeParents, filtersShownWith, describeTime, cascadeValues, cleanFilter, conditionOf, controlsFor, daysOf, descendants, editableFilter, filterFields, compatible, globalOps, takenByAll, filterProblem, fromDays, daysIn, isEmpty, newFilter, opsFor, pruneGlobal, reverseCascadeValues, timeModeOf, withFilters, withOp, type ChartFilter, type GlobalFilter } from './filters'

const fields: SpecField[] = [
  { key: 'created', label: '下单时间', column: 'created_at', type: 'timestamp', role: 'dimension' },
  { key: 'region', label: '地区', column: 'region', type: 'string', role: 'dimension' },
  { key: 'amount', label: '金额', column: 'amount', type: 'decimal', role: 'measure' },
  { key: 'arpu', label: '客单价', expr: 'SUM(amount) / COUNT(DISTINCT user_id)', type: 'decimal', role: 'metric' },
]
const field = (key: string) => fields.find((candidate) => candidate.key === key)!

describe('what a filter can be', () => {
  it('starts fixed, on the condition usual for the type', () => {
    const taken = new Set(['region'])
    expect(newFilter(field('region'), taken)).toEqual({ id: 'region_2', field: 'region', op: 'in' })
    expect(newFilter(field('created'), taken)).toEqual({ id: 'created', field: 'created', op: 'time' })
    expect(newFilter(field('amount'), taken)).toEqual({ id: 'amount', field: 'amount', op: 'between' })
  })

  it('offers each condition the controls that can fill it in', () => {
    expect(opsFor('boolean')).toEqual(['in', 'not_in', 'is_null', 'not_null'])
    expect(controlsFor('time')).toEqual(['relative', 'date'])
    expect(controlsFor('not_in')).toEqual(['select', 'search_select', 'tiles'])
    // Null conditions have no value to fill in.
    expect(controlsFor('is_null')).toEqual([])
  })

  it('keeps what still fits when the condition changes', () => {
    const select: ChartFilter = { id: 'f', field: 'region', op: 'in', value: ['华东'], label: '地区', control: { type: 'search_select', multi: true }, exposed: true }
    expect(withOp(select, 'contains')).toEqual({ ...select, op: 'contains', value: undefined, control: { type: 'text', multi: true } })
    expect(withOp(select, 'not_in')).toEqual({ ...select, op: 'not_in' })
    expect(withOp({ id: 'f', field: 'region', op: 'in', value: ['华东'] }, 'not_in')).toEqual({ id: 'f', field: 'region', op: 'not_in', value: ['华东'] })
    expect(withOp({ ...select, op: 'contains', value: '华', control: { type: 'text' } }, 'starts_with').value).toBe('华')
  })

  it('is editable when the editor could have written it', () => {
    expect(editableFilter({ id: 'f', field: 'region', op: 'in', value: ['a'] }, fields)).toBe(true)
    expect(editableFilter({ id: 'f', field: 'created', op: 'time', control: { type: 'date' }, label: 'x' }, fields)).toBe(true)
    // Saved before the date range panel took its place.
    expect(editableFilter({ id: 'f', field: 'created', op: 'time', control: { type: 'date_range' }, label: 'x' }, fields)).toBe(true)
    expect(editableFilter({ id: 'f', field: 'created', op: 'is_null' }, fields)).toBe(true)
    expect(editableFilter({ id: 'f', field: 'nope', op: 'in' }, fields)).toBe(false)
    expect(editableFilter({ id: 'f', field: 'arpu', op: 'between' }, fields)).toBe(true)
    expect(editableFilter({ id: 'f', field: 'arpu', op: 'is_null' }, fields)).toBe(true)
    expect(editableFilter({ id: 'f', field: 'arpu', op: 'not_null' }, fields)).toBe(true)
    expect(editableFilter({ id: 'f', field: 'region', op: 'between' }, fields)).toBe(false)
    expect(editableFilter({ id: 'f', field: 'region', op: 'in', control: { type: 'relative' } }, fields)).toBe(false)
    expect(editableFilter({ id: 'f', field: 'region', op: 'gt' as never, value: 'a' }, fields)).toBe(false)
  })
})

describe('values', () => {
  it('knows a value that restricts nothing', () => {
    expect(isEmpty('in', [])).toBe(true)
    expect(isEmpty('in', undefined)).toBe(true)
    expect(isEmpty('contains', '')).toBe(true)
    expect(isEmpty('between', [null, null])).toBe(true)
    expect(isEmpty('between', [0, null])).toBe(false)
    expect(isEmpty('time', {})).toBe(true)
    expect(isEmpty('time', { bounds: {} })).toBe(true)
    expect(isEmpty('time', { bounds: { start: { fixed: '2026-01-01' } } })).toBe(false)
    expect(isEmpty('time', { special: 'is_null' })).toBe(false)
    expect(isEmpty('time', { current: 'month' })).toBe(false)
    expect(isEmpty('is_null', undefined)).toBe(false)
  })

  it.each([
    ['between', { min: 0, includeMin: false }, 'gt', 0],
    ['between', { min: -5 }, 'gte', -5],
    ['between', { max: 10, includeMax: false }, 'lt', 10],
    ['between', { max: 10 }, 'lte', 10],
    ['not_between', { min: 0, includeMin: false }, 'lte', 0],
    ['not_between', { min: -5 }, 'lt', -5],
    ['not_between', { max: 10, includeMax: false }, 'gte', 10],
    ['not_between', { max: 10 }, 'gt', 10],
  ] as const)('converts %s with %j into its one-sided condition', (op, value, expectedOp, expectedValue) => {
    expect(conditionOf({ id: 'amount', field: 'amount', op, value })).toEqual({ field: 'amount', op: expectedOp, value: expectedValue })
  })

  it('preserves both interval boundaries and drops intervals with neither boundary', () => {
    for (const op of ['between', 'not_between'] as const) {
      const value = { min: -10, max: 20, includeMin: false, includeMax: true }
      expect(conditionOf({ id: 'f', field: 'amount', op, value })).toEqual({ field: 'amount', op, value })
      expect(conditionOf({ id: 'f', field: 'amount', op, value: { min: null, max: null, includeMin: false } })).toBeUndefined()
    }
  })

  it('retains the aggregation when switching to a condition without an interactive control', () => {
    const filter: ChartFilter = { id: 'f', field: 'amount', aggregation: 'avg', op: 'gte', value: 100, label: 'Average', control: { type: 'number' } }
    const next = withOp(filter, 'is_null', 'decimal')
    expect(next).toEqual({ id: 'f', field: 'amount', aggregation: 'avg', op: 'is_null', value: undefined })
    expect(withFilters({ version: 1 }, [next], fields)).toMatchObject({
      filterMeasures: [{ field: 'amount', agg: 'avg', alias: 'filter_f' }],
      having: { op: 'and', args: [{ field: 'filter_f', op: 'is_null' }] },
    })
  })

  it('turns filters into conditions the way the server does', () => {
    const filter = (patch: Partial<ChartFilter>): ChartFilter => ({ id: 'f', field: 'amount', op: 'between', ...patch })
    expect(conditionOf(filter({ value: [1, 5] }))).toEqual({ field: 'amount', op: 'between', value: [1, 5] })
    expect(conditionOf(filter({ value: [1, null] }))).toEqual({ field: 'amount', op: 'gte', value: 1 })
    expect(conditionOf(filter({ value: [null, 5] }))).toEqual({ field: 'amount', op: 'lte', value: 5 })
    expect(conditionOf(filter({ value: [null, null] }))).toBeUndefined()
    expect(conditionOf(filter({ op: 'not_null' }))).toEqual({ field: 'amount', op: 'not_null' })
    expect(conditionOf(filter({ value: [1, 5] }), [null, null])).toBeUndefined()
  })

  it('adds them to a query without letting its own filter swallow them', () => {
    const filters: ChartFilter[] = [
      { id: 'a', field: 'region', op: 'in', value: ['华东'] },
      { id: 'b', field: 'created', op: 'time', label: 'x', control: { type: 'relative' } },
    ]
    const own = { op: 'or', args: [] }
    expect(withFilters({ version: 1 }, [])).toEqual({ version: 1 })
    expect(withFilters({ version: 1 }, [filters[1]!])).toEqual({ version: 1 })
    expect(withFilters({ version: 1, filter: own }, filters)).toEqual({ version: 1, filter: { op: 'and', args: [own, { field: 'region', op: 'in', value: ['华东'] }] } })
  })

  it('stores nothing that says nothing', () => {
    expect(cleanFilter({ id: 'f', field: 'region', op: 'in', value: [], label: '地区', control: { type: 'select', multi: false }, exposed: false })).toEqual({ id: 'f', field: 'region', op: 'in', label: '地区', control: { type: 'select' } })
    expect(cleanFilter({ id: 'f', field: 'region', op: 'in', value: ['a'], label: 'gone', exposed: true })).toEqual({ id: 'f', field: 'region', op: 'in', value: ['a'] })
    expect(cleanFilter({ id: 'f', field: 'created', op: 'time', value: {}, label: 'x', control: { type: 'relative', multi: true }, exposed: true })).toEqual({ id: 'f', field: 'created', op: 'time', label: 'x', control: { type: 'relative' } })
    expect(cleanFilter({ id: 'f', field: 'region', op: 'is_null', value: ['a'] })).toEqual({ id: 'f', field: 'region', op: 'is_null' })
  })

  it('says what a filter still needs', () => {
    expect(filterProblem({ id: 'f', field: 'region', op: 'in' })).toBe('needsValue')
    expect(filterProblem({ id: 'f', field: 'region', op: 'is_null' })).toBeUndefined()
    expect(filterProblem({ id: 'f', field: 'region', op: 'in', control: { type: 'select' }, label: ' ' })).toBe('needsLabel')
    expect(filterProblem({ id: 'f', field: 'region', op: 'in', control: { type: 'select' }, label: '地区' })).toBeUndefined()
  })
})

describe('time values', () => {
  it('are shown by the name of a period when they have one', () => {
    expect(timeModeOf(undefined)).toBe('all')
    expect(timeModeOf({})).toBe('all')
    expect(timeModeOf({ includeCurrent: true, last: { unit: 'day', n: 7 } })).toBe('last7d')
    expect(timeModeOf({ last: { n: 1, unit: 'month' }, includeCurrent: false })).toBe('lastMonth')
    expect(timeModeOf({ current: 'quarter' })).toBe('thisQuarter')
    expect(timeModeOf({ last: { n: 3, unit: 'week' } })).toBe('lastN')
    expect(timeModeOf({ start: '2026-01-01' })).toBe('range')
  })

  it('end before their end, where a range of days includes its last day', () => {
    expect(fromDays('2026-02-01', '2026-02-28')).toEqual({ start: '2026-02-01', end: '2026-03-01' })
    expect(daysOf({ start: '2026-02-01', end: '2026-03-01' })).toEqual(['2026-02-01', '2026-02-28'])
    expect(fromDays('2026-12-31', '2026-12-31')).toEqual({ start: '2026-12-31', end: '2027-01-01' })
    expect(fromDays(undefined, '2026-02-28')).toEqual({ end: '2026-03-01' })
    expect(fromDays(undefined, undefined)).toEqual({})
    expect(daysOf({ start: '2026-02-01T00:00:00' })).toEqual(['2026-02-01', undefined])
  })
})

describe('global filters', () => {
  const charts = [
    { id: 'a', name: '甲', datasetId: 'orders', spec: { query: { measures: [{ field: 'amount', agg: 'sum' }, { field: 'arpu', alias: 'display_arpu' }, { field: 'amount', agg: 'avg', alias: 'mean_amount' }] } } },
    { id: 'b', name: '乙', datasetId: 'orders', spec: { query: { measures: [] } } },
    { id: 'c', name: '丙', datasetId: 'users', spec: { query: {} } },
    { id: 'd', name: '丁', datasetId: 'users', spec: { query: { mode: 'detail' } } },
  ]
  const items = [{ id: 'w1', chartId: 'a' }, { id: 'w2', chartId: 'b' }, { id: 'w3', chartId: 'c' }, { id: 'w4', chartId: 'd' }]
  const spec = { specVersion: 1, source: { type: 'table' }, fields }
  const offered = filterFields(items, charts, { orders: spec, users: spec })
  const entry = (item: string, field: string) => offered.find((candidate) => candidate.item === item && candidate.target.field === field)!

  it('offers dataset fields even when a chart has no local filters, and keeps row and aggregate measures distinct', () => {
    expect(offered.filter((candidate) => candidate.item === 'w1').map((candidate) => candidate.target)).toEqual([
      { item: 'w1', field: 'created' }, { item: 'w1', field: 'region' }, { item: 'w1', field: 'amount' }, { item: 'w1', field: 'arpu' },
      { item: 'w1', field: 'amount', aggregation: 'sum' }, { item: 'w1', field: 'amount', aggregation: 'avg' },
    ])
    expect(offered.filter((candidate) => candidate.item === 'w4').every((candidate) => !candidate.aggregate)).toBe(true)
  })

  it('keeps listing a measure bound by another aggregation than its sum, as older dashboards did', () => {
    const saved = [{ item: 'w2', field: 'amount', aggregation: 'max' as const }]
    const targets = filterFields(items, charts, { orders: spec, users: spec }, saved).filter((candidate) => candidate.item === 'w2' && candidate.target.aggregation).map((candidate) => candidate.target)
    expect(targets).toEqual([{ item: 'w2', field: 'amount', aggregation: 'sum' }, { item: 'w2', field: 'amount', aggregation: 'max' }])
    // It is offered only where it is bound.
    expect(offered.some((candidate) => candidate.target.aggregation === 'max')).toBe(false)
  })

  it('suggests the same field only within the same dataset while allowing multiple global conditions', () => {
    expect(alike(entry('w1', 'region'), offered)).toEqual([{ item: 'w1', field: 'region' }, { item: 'w2', field: 'region' }])
    const filters: GlobalFilter[] = [
      { id: 'g1', label: 'First', op: 'in', control: { type: 'select' }, targets: [{ item: 'w2', field: 'region' }] },
      { id: 'g2', label: 'Second', op: 'eq', control: { type: 'text' }, targets: [{ item: 'w2', field: 'region' }] },
    ]
    expect(takenByAll(filters, { item: 'w2', field: 'region' })).toEqual(filters)
    expect(alike(entry('w1', 'region'), offered)).toEqual([{ item: 'w1', field: 'region' }, { item: 'w2', field: 'region' }])
  })

  it('offers temporal, string and boolean aggregate results with suitable controls', () => {
    const metricFields: SpecField[] = [
      ...fields,
      { key: 'last_order', label: 'Last order', expr: 'MAX(created)', type: 'timestamp', role: 'metric' },
      { key: 'last_region', label: 'Last region', expr: 'MAX(region)', type: 'string', role: 'metric' },
      { key: 'any_order', label: 'Has orders', expr: 'COUNT(*) > 0', type: 'boolean', role: 'metric' },
    ]
    const available = filterFields([{ id: 'widget', chartId: 'chart' }], [{ id: 'chart', name: 'Chart', datasetId: 'orders', spec: { query: { measures: [
      { field: 'created', agg: 'max', alias: 'latest' }, { field: 'region', agg: 'min', alias: 'region_name' },
    ] } } }], { orders: { ...spec, fields: metricFields } })
    expect(available.find((candidate) => candidate.target.measure === 'latest')?.type).toBe('timestamp')
    expect(available.find((candidate) => candidate.target.measure === 'region_name')?.type).toBe('string')
    for (const [key, ops] of [['last_order', ['time']], ['last_region', ['eq', 'ne', 'contains', 'not_contains', 'starts_with', 'ends_with', 'like', 'not_like']], ['any_order', ['in', 'not_in']]] as const) {
      const candidate = available.find((entry) => entry.target.field === key)!
      expect(globalOps(candidate)).toEqual(ops)
      expect(newFilter(metricFields.find((field) => field.key === key)!, new Set()).op).toBe(ops[0])
    }
  })

  it('requires the same filtering stage and numeric type', () => {
    expect(compatible(entry('w1', 'amount'), entry('w1', 'arpu'))).toBe(false)
    expect(compatible(entry('w1', 'arpu'), { ...entry('w1', 'arpu'), type: 'integer' })).toBe(false)
    expect(globalOps({ ...entry('w1', 'arpu'), type: 'integer' })).toEqual(['between', 'not_between', 'eq', 'ne', 'gt', 'gte', 'lt', 'lte'])
  })

  it('removes only bindings to removed widgets and retains the rest, regardless of chart controls', () => {
    const filters: GlobalFilter[] = [
      { id: 'g1', label: '地区', op: 'in', control: { type: 'select' }, optionsFrom: 'w9', targets: [{ item: 'w1', field: 'region' }, { item: 'w9', field: 'region' }] },
      { id: 'g2', label: '没了', op: 'in', control: { type: 'select' }, targets: [{ item: 'w9', field: 'region' }] },
    ]
    expect(pruneGlobal(filters, items)).toEqual([{ id: 'g1', label: '地区', op: 'in', control: { type: 'select' }, targets: [{ item: 'w1', field: 'region' }] }])
  })

  it('puts dataset metrics in HAVING without adding visible output columns or replacing fixed query conditions', () => {
    const query = { version: 1, measures: [{ field: 'amount' }], having: { field: 'amount', op: 'gte', value: 1 } }
    const result = withFilters(query, [{ id: 'arpu', field: 'arpu', op: 'gte', value: 100 }, { id: 'amount', field: 'amount', op: 'lt', value: 30 }], fields)
    expect(result.measures).toEqual(query.measures)
    expect(result.filterMeasures).toEqual([{ field: 'arpu', alias: 'filter_arpu' }])
    expect(result.filter).toEqual({ op: 'and', args: [{ field: 'amount', op: 'lt', value: 30 }] })
    expect(result.having).toEqual({ op: 'and', args: [query.having, { field: 'filter_arpu', op: 'gte', value: 100 }] })
    expect(query).not.toHaveProperty('filterMeasures')
  })

  it('binds a dynamic measure to its alias instead of freezing the default candidate', () => {
    const available = filterFields([{ id: 'widget', chartId: 'dynamic_chart' }], [{ id: 'dynamic_chart', name: 'Dynamic chart', datasetId: 'orders', spec: {
      query: { measures: [{ field: 'amount', alias: 'selected_value' }] },
      dynamics: [{ id: 'metric', kind: 'measure', alias: 'selected_value', label: 'Selected metric', options: [{ id: 'total', field: 'amount', agg: 'sum' }, { id: 'average', field: 'amount', agg: 'avg' }] }],
    } }], { orders: spec })
    expect(available.find((candidate) => candidate.identity === 'dynamic:dynamic_chart:selected_value')).toMatchObject({
      target: { item: 'widget', measure: 'selected_value' }, label: 'Selected metric', type: 'decimal', aggregate: true, source: 'chart',
    })
    expect(available.filter((candidate) => candidate.target.field === 'amount' && candidate.target.aggregation === 'sum')).toHaveLength(1)
  })
})

describe('filter cascades', () => {
  const filters = [{ id: 'country' }, { id: 'province', dependsOn: ['country'] }, { id: 'city', dependsOn: ['province'] }, { id: 'district', dependsOn: ['city'] }, { id: 'store', dependsOn: ['province'] }, { id: 'unrelated' }]
  const values = { country: ['China'], province: ['Beijing'], city: ['Beijing'], district: ['Haidian'], store: ['Shop A'], unrelated: ['keep'] }

  it('clears all descendant defaults while keeping unrelated values and the input immutable', () => {
    expect(descendants(filters, 'country')).toEqual(['province', 'city', 'district', 'store'])
    expect(cascadeValues(filters, values, 'country', ['Japan'])).toEqual({ country: ['Japan'], province: null, city: null, district: null, store: null, unrelated: ['keep'] })
    expect(values.province).toEqual(['Beijing'])
  })

  it('reverse matches through all ancestors without old ancestors or sibling defaults constraining the result', () => {
    expect(cascadeParents(filters, 'city').map((filter) => filter.id)).toEqual(['province', 'country'])
    const changed = cascadeValues(filters, values, 'city', ['Tokyo'])
    expect(reverseCascadeValues(filters, changed, 'city')).toEqual({ country: null, province: null, city: ['Tokyo'], district: null, store: null, unrelated: ['keep'] })
    expect(values.country).toEqual(['China'])
  })
})

describe('open bounds and advanced time ranges', () => {
  it('keeps an open bound on an interactive range before viewers enter a value', () => {
    const range: ChartFilter = { id: 'n', field: 'amount', op: 'between', label: '金额', control: { type: 'number_range' }, value: { includeMin: false } }
    expect(cleanFilter(range).value).toEqual({ includeMin: false })
    // A closed, empty range says nothing and is not stored.
    expect(cleanFilter({ ...range, value: { includeMin: true } }).value).toBeUndefined()
    expect(conditionOf(range)).toBeUndefined()
  })

  it('names both ends of an advanced range, reading the end inclusively', async () => {
    await i18n.changeLanguage('en-US')
    const t = i18n.t.bind(i18n)
    expect(describeTime({ bounds: { start: { relative: { n: -6, unit: 'day' } }, end: { relative: { n: 1, unit: 'day' } } } }, t)).toBe('6 days ago ~ today')
    expect(describeTime({ bounds: { start: { fixed: '2026-01-01' }, end: { fixed: '2026-04-01' } } }, t)).toBe('2026-01-01 ~ 2026-03-31')
    expect(describeTime({ bounds: { start: { relative: { n: -1, unit: 'month' } }, end: { relative: { n: 0, unit: 'month' } } } }, t)).toBe('1 months ago')
    expect(describeTime({ bounds: { end: { relative: { n: 0, unit: 'year' } } } }, t)).toBe('… ~ 1 years ago')
    expect(describeTime({ bounds: {} }, t)).toBe('Any time')
  })
})

describe('how a range of dates is chosen', () => {
  const t = i18n.getFixedT('en-US')

  it('restricts nothing with no dates chosen, however they are to be chosen', () => {
    expect(isEmpty('time', { grain: 'month', includeNull: true })).toBe(true)
    expect(isEmpty('time', { bounds: {}, grain: 'week', weekStart: 2 })).toBe(true)
    expect(isEmpty('time', { current: 'month', grain: 'month' })).toBe(false)
    expect(conditionOf({ id: 'd', field: 'created', op: 'time', value: { grain: 'month' } })).toBeUndefined()
  })

  it('keeps how viewers choose dates before any are chosen', () => {
    const filter: ChartFilter = { id: 'd', field: 'created', op: 'time', value: { grain: 'week', weekStart: 2 }, label: 'Created', control: { type: 'relative' } }
    expect(cleanFilter(filter).value).toEqual({ grain: 'week', weekStart: 2 })
    expect(cleanFilter({ ...filter, control: undefined }).value).toBeUndefined()
  })

  it('says fixed months as months, and empty dates after the range', () => {
    expect(describeTime({ start: '2026-01-01', end: '2026-04-01', grain: 'month' }, t)).toBe('2026-01 ~ 2026-03')
    expect(describeTime({ start: '2026-05-01', end: '2026-06-01', grain: 'month' }, t)).toBe('2026-05')
    expect(describeTime({ current: 'month', includeNull: true }, t)).toBe('This month (with empty dates)')
    expect(describeTime({ last: { n: 3, unit: 'month' }, includeCurrent: true }, t)).toBe('Last 3 months')
  })

  it('moves days out to the whole months or weeks they fall in', () => {
    expect(daysIn('month', ['2026-01-15', '2026-02-10'], 1)).toEqual(['2026-01-01', '2026-02-28'])
    expect(daysIn('week', ['2026-10-14', '2026-10-16'], 1)).toEqual(['2026-10-12', '2026-10-18'])
    expect(daysIn('week', ['2026-10-14', '2026-10-16'], 2)).toEqual(['2026-10-13', '2026-10-19'])
    expect(daysIn('week', ['2026-10-18', undefined], 7)).toEqual(['2026-10-18', undefined])
    expect(daysIn('day', ['2026-10-14', '2026-10-16'], 1)).toEqual(['2026-10-14', '2026-10-16'])
  })
})

describe('filters shown with some charts', () => {
  it('shows those mapped to any of them, and the filters they depend on', () => {
    const filter = (id: string, items: string[], dependsOn?: string[]) => ({ id, targets: items.map((item) => ({ item })), ...(dependsOn ? { dependsOn } : {}) })
    const filters = [filter('region', ['a']), filter('city', ['b'], ['region']), filter('store', ['c'], ['city']), filter('date', ['a', 'c'])]
    expect(filtersShownWith(filters, new Set(['c'])).map((entry) => entry.id)).toEqual(['region', 'city', 'store', 'date'])
    expect(filtersShownWith(filters, new Set(['a'])).map((entry) => entry.id)).toEqual(['region', 'date'])
    expect(filtersShownWith(filters, new Set(['z']))).toEqual([])
  })
})
