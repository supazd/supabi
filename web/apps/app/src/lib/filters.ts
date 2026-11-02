// Filters of charts and dashboards, as the interface edits them. The server
// owns the rules (.agents/design/chart-dashboard.md 2.3 and 3.2); what is here
// mirrors them so the interface offers only what will be accepted.
import type { TFunction } from 'i18next'
import type { LogicalType } from '../api/client'
import { aggResultType, aggsFor, isNumeric, isTemporal, makeKey, type Aggregation, type DatasetSpec, type SpecField } from '../api/spec'

export const controlTypes = ['select', 'search_select', 'tiles', 'text', 'number', 'number_range', 'date', 'date_range', 'relative'] as const
export type ControlType = (typeof controlTypes)[number]

export interface FilterControl {
  type: ControlType
  /** Lets a select take several values. */
  multi?: boolean
}

export const filterOps = ['in', 'not_in', 'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'not_contains', 'starts_with', 'ends_with', 'like', 'not_like', 'between', 'not_between', 'time', 'is_null', 'not_null', 'is_empty', 'not_empty'] as const
export type FilterOp = (typeof filterOps)[number]

/**
 * A condition on a chart. Without a control it is fixed: viewers neither see
 * nor change it. With one they choose the value.
 */
export interface ChartFilter {
  id: string
  field: string
  op: FilterOp
  value?: unknown
  label?: string
  control?: FilterControl
  /** Legacy property; global filters no longer require it. */
  exposed?: boolean
  aggregation?: Aggregation
  dependsOn?: string[]
}

/** A filter of a dashboard: one value for the chart filters it has taken over. */
export interface GlobalFilter {
  id: string
  label: string
  op: FilterOp
  control: FilterControl
  targets: FilterTarget[]
  optionsFrom?: string
  default?: unknown
  dependsOn?: string[]
}

export interface FilterTarget {
  /** The widget, not the chart: a chart can be on a dashboard twice. */
  item: string
  field?: string
  measure?: string
  aggregation?: Aggregation
}

/** The conditions a field of this type can be given, the usual one first. */
export function opsFor(type: LogicalType): FilterOp[] {
  if (isTemporal(type)) return ['time', 'is_null', 'not_null']
  if (type === 'string') return ['in', 'not_in', 'contains', 'not_contains', 'starts_with', 'ends_with', 'like', 'not_like', 'eq', 'ne', 'is_null', 'not_null', 'is_empty', 'not_empty']
  if (type === 'integer') return ['in', 'not_in', 'between', 'not_between', 'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'is_null', 'not_null']
  if (type === 'boolean') return ['in', 'not_in', 'is_null', 'not_null']
  return ['between', 'not_between', 'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'is_null', 'not_null']
}

/** The controls that can fill in a condition, the usual one first. Empty when viewers cannot be offered it. */
export function controlsFor(op: FilterOp, type?: LogicalType): ControlType[] {
  switch (op) {
    case 'in':
    case 'not_in':
      return ['select', 'search_select', 'tiles']
    case 'eq':
      return type && isNumeric(type) ? ['number'] : ['text']
    case 'ne':
      return type && isNumeric(type) ? ['number'] : ['text']
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return ['number']
    case 'contains':
    case 'not_contains':
    case 'starts_with':
    case 'ends_with':
    case 'like':
    case 'not_like':
      return ['text']
    case 'between':
    case 'not_between':
      return ['number_range']
    case 'time':
      return ['relative', 'date']
  }
  return []
}

/** Conditions that leave out what is chosen; a control alone would read as the opposite. */
export const negatedOps: ReadonlySet<FilterOp> = new Set(['not_in', 'ne', 'not_contains', 'not_like', 'not_between'])

/**
 * Conditions as a formula writes them, the same in every language, for where
 * there is little room. The rest (contains, matches a pattern, a time range)
 * have no symbol a reader would know, and keep their words.
 */
export const opSymbols: Partial<Record<FilterOp, string>> = { eq: '=', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤', in: 'IN', not_in: 'NOT IN', is_null: 'IS NULL', not_null: 'IS NOT NULL' }

/** A condition in few characters: its symbol, or its words when it has none. */
export const opText = (op: FilterOp, t: TFunction) => opSymbols[op] ?? t(`filter.ops.${op}`)

export const takesValue = (op: FilterOp) => !['is_null', 'not_null', 'is_empty', 'not_empty'].includes(op)
export const isSelect = (control: FilterControl | undefined) => control?.type === 'select' || control?.type === 'search_select' || control?.type === 'tiles'

/** The control a value is written with: the filter's own, or for a fixed condition the one that suits it. */
export function valueControl(filter: Pick<ChartFilter, 'op' | 'control'>, type?: LogicalType): FilterControl | undefined {
  if (filter.control) return filter.control
  if (filter.op === 'not_in') return { type: 'search_select', multi: true }
  const [first] = controlsFor(filter.op, type)
  return first ? { type: first, multi: true } : undefined
}

/** Whether a value restricts nothing. */
export function isEmpty(op: FilterOp, value: unknown): boolean {
  if (!takesValue(op)) return false
  if (value === undefined || value === null || value === '') return true
  if ((op === 'between' || op === 'not_between') && !Array.isArray(value)) { const range = value as NumberRange; return range.min == null && range.max == null }
  if (op === 'time' && typeof value === 'object') return !hasInterval(value as TimeValue)
  if (Array.isArray(value)) return op === 'between' || op === 'not_between' ? value.every((side) => side === null || side === undefined) : value.length === 0
  return typeof value === 'object' && Object.keys(value).length === 0
}

export interface Condition {
  field: string
  op: string
  value?: unknown
}

/** A filter as a condition of a query, or undefined when its value restricts nothing. */
export function conditionOf(filter: ChartFilter, value: unknown = filter.value): Condition | undefined {
  if (!takesValue(filter.op)) return { field: filter.field, op: filter.op }
  if (isEmpty(filter.op, value)) return undefined
  if (filter.op === 'between' || filter.op === 'not_between') {
    const range = rangeOf(value)
    const outside = filter.op === 'not_between'
    if (range.min == null) return { field: filter.field, op: outside ? range.includeMax === false ? 'gte' : 'gt' : range.includeMax === false ? 'lt' : 'lte', value: range.max }
    if (range.max == null) return { field: filter.field, op: outside ? range.includeMin === false ? 'lte' : 'lt' : range.includeMin === false ? 'gt' : 'gte', value: range.min }
  }
  return { field: filter.field, op: filter.op, value }
}

/** A query with a chart's filters applied, the way the server applies them. */
export function withFilters(query: Record<string, unknown>, filters: ChartFilter[], fields: SpecField[] = []): Record<string, unknown> {
  const rows: Condition[] = []
  const aggregates: Condition[] = []
  const filterMeasures = [...((query.filterMeasures as QueryMeasure[] | undefined) ?? [])]
  const taken = new Set([...((query.dimensions as QueryMeasure[] | undefined) ?? []), ...((query.measures as QueryMeasure[] | undefined) ?? []), ...filterMeasures].map((measure) => measure.alias ?? measure.field ?? ''))
  for (const filter of filters) {
    const condition = conditionOf(filter)
    if (!condition) continue
    if (filter.aggregation || fields.find((field) => field.key === filter.field)?.role === 'metric') {
      const alias = makeKey(`filter_${filter.id}`, taken)
      filterMeasures.push({ field: filter.field, ...(filter.aggregation ? { agg: filter.aggregation } : {}), alias })
      aggregates.push({ ...condition, field: alias })
    } else rows.push(condition)
  }
  return {
    ...query,
    ...(rows.length ? { filter: { op: 'and', args: query.filter ? [query.filter, ...rows] : rows } } : {}),
    ...(aggregates.length ? { filterMeasures, having: { op: 'and', args: query.having ? [query.having, ...aggregates] : aggregates } } : {}),
  }
}

/** A filter as it is stored: nothing that says nothing. */
export function cleanFilter(filter: ChartFilter): ChartFilter {
  const out: ChartFilter = { id: filter.id, field: filter.field, op: filter.op }
  if (takesValue(filter.op) && !isEmpty(filter.op, filter.value)) out.value = filter.value
  // How viewers are to choose dates is kept before any are chosen.
  else if (filter.control && filter.op === 'time' && filter.value && Object.keys(timeQualifiers(filter.value as TimeValue)).length) out.value = timeQualifiers(filter.value as TimeValue)
  // An open bound is part of the condition: it is kept even before viewers have entered a value.
  else if (filter.control && (filter.op === 'between' || filter.op === 'not_between')) {
    const { includeMin, includeMax } = rangeOf(filter.value)
    if (includeMin === false || includeMax === false) out.value = { ...(includeMin === false ? { includeMin } : {}), ...(includeMax === false ? { includeMax } : {}) }
  }
  if (filter.aggregation) out.aggregation = filter.aggregation
  if (filter.control && filter.dependsOn?.length) out.dependsOn = [...filter.dependsOn]
  if (filter.control) {
    out.label = filter.label ?? ''
    out.control = isSelect(filter.control) && filter.control.multi ? { type: filter.control.type, multi: true } : { type: filter.control.type }
  }
  return out
}

/** Why a filter cannot be saved as it is, if anything. */
export function filterProblem(filter: ChartFilter): 'needsValue' | 'needsLabel' | undefined {
  if (!filter.control) return isEmpty(filter.op, filter.value) ? 'needsValue' : undefined
  return filter.label?.trim() ? undefined : 'needsLabel'
}

/** The filter a field starts with: a fixed one, on the condition usual for its type. Letting viewers set it is asked for. */
export function newFilter(field: SpecField, taken: Set<string>): ChartFilter {
  return { id: makeKey(field.key, taken), field: field.key, op: (field.role === 'metric' ? aggregateOps(field.type) : opsFor(field.type))[0]! }
}

/** A filter given another condition, keeping of the rest what still fits. */
export function withOp(filter: ChartFilter, op: FilterOp, type?: LogicalType): ChartFilter {
  const controls = controlsFor(op, type)
  const sameKind = controlsFor(filter.op, type)[0] === controls[0]
  const next: ChartFilter = { ...filter, op, value: sameKind ? filter.value : undefined }
  if (!filter.control) return next
  // A condition viewers cannot be offered leaves the filter fixed.
  if (controls.length === 0) return { id: next.id, field: next.field, op, value: next.value, ...(next.aggregation ? { aggregation: next.aggregation } : {}) }
  return { ...next, control: controls.includes(filter.control.type) ? filter.control : { type: controls[0]!, multi: true } }
}

/** Whether the editor could have written this filter, and so can edit it without losing anything. */
export function editableFilter(filter: ChartFilter, fields: SpecField[]): boolean {
  const field = fields.find((candidate) => candidate.key === filter.field)
  if (!field || !(field.role === 'metric' || filter.aggregation ? aggregateOps(field.type) : opsFor(field.type)).includes(filter.op)) return false
  // A date filter saved before the date editor is read the way the editor reads it.
  const { op, control } = isTemporal(field.type) ? asTimeFilter(filter) : filter
  return !control || controlsFor(op, field.type).includes(control.type)
}

/** Dataset metrics can be filtered after aggregation, except in detail charts. */
export const filterable = (field: SpecField, detail = false) => !detail || field.role !== 'metric'

/** A measure of a query: a field and its aggregation; a metric has none. */
interface QueryMeasure {
  field?: string
  agg?: Aggregation
  alias?: string
  label?: string
}

/** One available field of a widget, with its row/aggregate meaning retained. */
export interface FilterField {
  item: string
  chartId: string
  chartName: string
  datasetId: string
  target: FilterTarget
  label: string
  type: LogicalType
  aggregate: boolean
  source: 'dataset' | 'chart'
  agg?: Aggregation
  identity: string
}

export const sameTarget = (a: FilterTarget, b: FilterTarget) => a.item === b.item && a.field === b.field && a.measure === b.measure && a.aggregation === b.aggregation
export const takenByAll = (filters: GlobalFilter[], target: FilterTarget) => filters.filter((filter) => filter.targets.some((other) => sameTarget(other, target)))
export const compatible = (a: FilterField, b: FilterField) => a.aggregate === b.aggregate && (a.type === b.type || (isTemporal(a.type) && isTemporal(b.type)))
/** Aggregate values do not have a row-level option list. Boolean has a fixed domain. */
export const aggregateOps = (type: LogicalType): FilterOp[] => {
  if (isNumeric(type)) return ['between', 'not_between', 'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'is_null', 'not_null']
  if (isTemporal(type)) return ['time', 'is_null', 'not_null']
  if (type === 'boolean') return ['in', 'not_in', 'is_null', 'not_null']
  return ['eq', 'ne', 'contains', 'not_contains', 'starts_with', 'ends_with', 'like', 'not_like', 'is_null', 'not_null', 'is_empty', 'not_empty']
}
export const globalOps = (field: FilterField) => (field.aggregate ? aggregateOps(field.type) : isNumeric(field.type) ? ['between', 'not_between', 'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in'] as FilterOp[] : opsFor(field.type)).filter((op) => controlsFor(op, field.type).length > 0)

/**
 * Dataset fields plus chart aggregations; a displayed dataset metric is listed
 * once. `saved` are the targets the dashboard already binds: a measure of the
 * dataset bound by another aggregation than its sum, as old bindings may be, is
 * listed too, so the binding stays as it is when its filter is edited.
 */
export function filterFields(items: { id: string; chartId: string; title?: string }[], charts: { id: string; name: string; datasetId: string; spec: unknown }[], datasets: Record<string, DatasetSpec>, saved: FilterTarget[] = []): FilterField[] {
  return items.flatMap((item) => {
    const chart = charts.find((candidate) => candidate.id === item.chartId)
    const ds = chart && datasets[chart.datasetId]
    if (!chart || !ds) return []
    const definition = chart.spec as { query?: { mode?: string; measures?: QueryMeasure[] }; dynamics?: { kind: string; alias: string; label: string; options: { field: string; agg?: Aggregation }[] }[] }
    const query = definition.query
    // A widget goes by the name it has on the board, if it has one.
    const common = { item: item.id, chartId: chart.id, chartName: item.title || chart.name, datasetId: chart.datasetId }
    const result: FilterField[] = ds.fields.filter((field) => query?.mode !== 'detail' || field.role !== 'metric').map((field) => ({
      ...common, target: { item: item.id, field: field.key }, label: field.label, type: field.type,
      aggregate: field.role === 'metric', source: 'dataset', identity: `field:${field.key}`,
    }))
    if (query?.mode === 'detail') return result
    for (const measure of query?.measures ?? []) {
      const dynamic = definition.dynamics?.find((slot) => slot.kind === 'measure' && slot.alias === measure.alias)
      if (dynamic) {
        const types = dynamic.options.map((option) => { const field = ds.fields.find((entry) => entry.key === option.field); return field ? aggResultType(option.agg, field.type) : undefined })
        if (types[0] && types.every((type) => type === types[0])) result.push({ ...common, target: { item: item.id, measure: dynamic.alias }, label: dynamic.label, type: types[0], aggregate: true, source: 'chart', identity: `dynamic:${chart.id}:${dynamic.alias}` })
        continue
      }
      const field = ds.fields.find((candidate) => candidate.key === measure.field)
      const agg = measure.agg
      if (!field || field.role === 'metric' || !agg) continue
      result.push({ ...common, target: agg && field.role === 'measure' && isNumeric(field.type) ? { item: item.id, field: field.key, aggregation: agg } : { item: item.id, measure: measure.alias ?? measure.field }, label: measure.label ?? field.label, type: aggResultType(agg, field.type),
        aggregate: true, source: 'chart', agg, identity: `aggregate:${field.key}:${agg}` })
    }
    // A measure of the dataset can be filtered by its sum; another aggregation is had by putting it on the chart.
    for (const field of ds.fields.filter((entry) => entry.role === 'measure' && isNumeric(entry.type))) {
      const aggs = new Set<Aggregation>(['sum'])
      for (const target of saved) if (target.item === item.id && target.field === field.key && target.aggregation && aggsFor(field.type).includes(target.aggregation)) aggs.add(target.aggregation)
      for (const agg of aggs) {
        const target = { item: item.id, field: field.key, aggregation: agg }
        if (!result.some((entry) => sameTarget(entry.target, target))) result.push({ ...common, target, label: field.label, type: aggResultType(agg, field.type), aggregate: true, source: 'dataset', agg, identity: `aggregate:${field.key}:${agg}` })
      }
    }
    return result
  })
}

/** Removing a widget removes only that widget's bindings, preserving the other mappings. */
export function pruneGlobal(filters: GlobalFilter[], items: { id: string }[]): GlobalFilter[] {
  return filters.map((filter) => {
    const targets = filter.targets.filter((target) => items.some((item) => item.id === target.item))
    const { optionsFrom, ...rest } = filter
    return { ...rest, targets, ...(optionsFrom && targets.some((target) => target.item === optionsFrom) ? { optionsFrom } : {}) }
  }).filter((filter) => filter.targets.length > 0).map((filter, _, kept) => ({ ...filter, ...(filter.dependsOn ? { dependsOn: filter.dependsOn.filter((id) => kept.some((entry) => entry.id === id)) } : {}) }))
}

/**
 * The global filters shown with some of the charts, as on a page of a split
 * dashboard: those mapped to any of them, and the filters these depend on,
 * whose values narrow their options. See .agents/design/chart-dashboard.md 3.13.
 */
export function filtersShownWith<T extends { id: string; targets: { item: string }[]; dependsOn?: string[] }>(filters: T[], holders: Set<string>): T[] {
  const shown = new Set(filters.filter((filter) => filter.targets.some((target) => holders.has(target.item))).map((filter) => filter.id))
  const visit = (id: string) => {
    for (const parent of filters.find((filter) => filter.id === id)?.dependsOn ?? []) {
      if (!shown.has(parent)) { shown.add(parent); visit(parent) }
    }
  }
  for (const id of [...shown]) visit(id)
  return filters.filter((filter) => shown.has(filter.id))
}

/** Suggest only the same semantic field in the same dataset; other datasets need explicit mapping. */
export function alike(first: FilterField, fields: FilterField[]): FilterTarget[] {
  const items = new Set<string>()
  return fields.filter((entry) => {
    if (entry.datasetId !== first.datasetId || entry.identity !== first.identity || items.has(entry.item)) return false
    items.add(entry.item)
    return true
  }).map((entry) => entry.target)
}

// ---- time ----

export const timeUnits = ['day', 'week', 'month', 'quarter', 'year'] as const
export type TimeUnit = (typeof timeUnits)[number]

/** What a range of dates is made of, as it is chosen: days, whole weeks or whole months. */
export const timeGrains = ['day', 'month', 'week'] as const
export type TimeGrain = (typeof timeGrains)[number]

export interface TimeValue {
  last?: { n: number; unit: TimeUnit }
  includeCurrent?: boolean
  current?: TimeUnit
  start?: string
  end?: string
  bounds?: { start?: TimeBound; end?: TimeBound }
  special?: 'is_null' | 'not_null'
  /** Rows without a date are kept too. */
  includeNull?: boolean
  /** Left out for days. The server moves the ends out to whole periods. */
  grain?: Exclude<TimeGrain, 'day'>
  /** The ISO weekday this range's weeks start on; left out, the workspace's. */
  weekStart?: number
}

/** Whether a time value names any dates; what only qualifies a range does not. */
export function hasInterval(time: TimeValue): boolean {
  return Boolean(time.last || time.current || time.start || time.end || time.special || time.bounds?.start || time.bounds?.end)
}

/** The parts of a time value that qualify its range and are none of their own. */
export function timeQualifiers(time: TimeValue): Pick<TimeValue, 'includeNull' | 'grain' | 'weekStart'> {
  return { ...(time.includeNull ? { includeNull: true } : {}), ...(time.grain ? { grain: time.grain } : {}), ...(time.weekStart ? { weekStart: time.weekStart } : {}) }
}

export interface TimeBound { fixed?: string; relative?: { n: number; unit: TimeUnit } }
export interface NumberRange { min?: number | null; max?: number | null; includeMin?: boolean; includeMax?: boolean }
export const rangeOf = (value: unknown): NumberRange => Array.isArray(value) ? { min: value[0], max: value[1] } : (value ?? {}) as NumberRange

/**
 * A date filter as the date editor writes it: the one condition `time`, whose
 * value says too whether dates are missing, and a control that is a date range
 * or a single date. Filters saved before keep working: a null condition becomes
 * its special value, and the calendar of a range opens as the full range panel.
 */
export function asTimeFilter<T extends Pick<ChartFilter, 'op' | 'value' | 'control'>>(filter: T): T {
  const special = filter.op === 'is_null' || filter.op === 'not_null' ? filter.op : undefined
  const control = filter.control?.type === 'date_range' ? { ...filter.control, type: 'relative' as const } : filter.control
  return { ...filter, op: 'time', ...(special ? { value: { special } } : {}), ...(control ? { control } : {}) }
}

/** The periods offered by name. Everything else is written as "the last N" or as a range of days. */
export const timePresets = {
  today: { current: 'day' },
  yesterday: { last: { n: 1, unit: 'day' } },
  last7d: { last: { n: 7, unit: 'day' }, includeCurrent: true },
  last30d: { last: { n: 30, unit: 'day' }, includeCurrent: true },
  last90d: { last: { n: 90, unit: 'day' }, includeCurrent: true },
  last12m: { last: { n: 12, unit: 'month' }, includeCurrent: true },
  last3m: { last: { n: 3, unit: 'month' }, includeCurrent: true },
  last6m: { last: { n: 6, unit: 'month' }, includeCurrent: true },
  last4w: { last: { n: 4, unit: 'week' }, includeCurrent: true },
  thisWeek: { current: 'week' },
  thisMonth: { current: 'month' },
  thisQuarter: { current: 'quarter' },
  thisYear: { current: 'year' },
  lastWeek: { last: { n: 1, unit: 'week' } },
  lastMonth: { last: { n: 1, unit: 'month' } },
  lastQuarter: { last: { n: 1, unit: 'quarter' } },
  lastYear: { last: { n: 1, unit: 'year' } },
} as const satisfies Record<string, TimeValue>

export type TimePreset = keyof typeof timePresets

/** The periods offered by name for each grain, nearest first, then by the period of the calendar they name. */
export const grainPresets: Record<TimeGrain, TimePreset[]> = {
  day: ['today', 'yesterday', 'last7d', 'last30d', 'last90d', 'last12m', 'thisWeek', 'lastWeek', 'thisMonth', 'lastMonth', 'thisQuarter', 'lastQuarter', 'thisYear', 'lastYear'],
  month: ['thisMonth', 'lastMonth', 'last3m', 'last6m', 'last12m', 'thisQuarter', 'lastQuarter', 'thisYear', 'lastYear'],
  week: ['thisWeek', 'lastWeek', 'last4w'],
}

/** The units "the last N" can count in for each grain. */
export const grainUnits: Record<TimeGrain, readonly TimeUnit[]> = { day: timeUnits, month: ['month', 'quarter', 'year'], week: ['week'] }

/** The first day of the month after a YYYY-MM month. */
export const monthAfter = (month: string) => { const [year, number] = month.split('-').map(Number) as [number, number]; return number === 12 ? `${year + 1}-01-01` : `${year}-${String(number + 1).padStart(2, '0')}-01` }

/** A day moved to the edge of its week: back to the first day, or on to the last. Weeks start on an ISO weekday. */
export function weekEdge(date: string, weekStart: number, edge: 'first' | 'last'): string {
  const weekday = new Date(`${date.slice(0, 10)}T00:00:00Z`).getUTCDay() || 7
  const back = (weekday - weekStart + 7) % 7
  return shiftDay(date, edge === 'first' ? -back : 6 - back)
}

/** A range of days, both included, moved out to whole periods of a grain. */
export function daysIn(grain: TimeGrain, [first, last]: [string | undefined, string | undefined], weekStart: number): [string | undefined, string | undefined] {
  if (grain === 'month') return [first && `${first.slice(0, 7)}-01`, last && shiftDay(monthAfter(last.slice(0, 7)), -1)]
  if (grain === 'week') return [first && weekEdge(first, weekStart, 'first'), last && weekEdge(last, weekStart, 'last')]
  return [first, last]
}
export const timePresetKeys = Object.keys(timePresets) as TimePreset[]
export type TimeMode = 'all' | TimePreset | 'lastN' | 'range' | 'advanced' | 'is_null' | 'not_null'

const sameTime = (a: TimeValue, b: TimeValue) =>
  a.current === b.current && a.last?.n === b.last?.n && a.last?.unit === b.last?.unit && Boolean(a.includeCurrent) === Boolean(b.includeCurrent) && !a.start && !a.end

/** How a time value is shown: by the name of a period when it has one. */
export function timeModeOf(value: unknown): TimeMode {
  const time = (value ?? {}) as TimeValue
  if (time.bounds) return 'advanced'
  if (time.special) return time.special
  if (time.start || time.end) return 'range'
  if (!time.last && !time.current) return 'all'
  return timePresetKeys.find((key) => sameTime(timePresets[key], time)) ?? (time.last ? 'lastN' : 'all')
}

const day = 86_400_000
/** A day as YYYY-MM-DD moved by a number of days. */
export const shiftDay = (date: string, days: number) => new Date(Date.parse(`${date.slice(0, 10)}T00:00:00Z`) + days * day).toISOString().slice(0, 10)

/** The first and the last day of a range, both included. A time value ends before its `end`. */
export function daysOf(value: unknown): [string | undefined, string | undefined] {
  const time = (value ?? {}) as TimeValue
  return [time.start?.slice(0, 10), time.end ? shiftDay(time.end, -1) : undefined]
}

/** A range of days, both included, as a time value. With neither it is empty. */
export function fromDays(first: string | undefined, last: string | undefined): TimeValue {
  return { ...(first ? { start: first } : {}), ...(last ? { end: shiftDay(last, 1) } : {}) }
}

/**
 * A time value in words. The end of a range is said inclusively, as people read
 * it: a bound at the start of next month reads as "this month".
 */
export function describeTime(value: unknown, t: TFunction): string {
  const time = (value ?? {}) as TimeValue
  const mode = timeModeOf(value)
  const said = describeInterval(time, mode, t)
  return time.includeNull && hasInterval(time) && !time.special ? t('filter.time.withNull', { range: said }) : said
}

function describeInterval(time: TimeValue, mode: TimeMode, t: TFunction): string {
  if (mode === 'lastN') return t('filter.time.lastNOf', { n: time.last!.n, unit: t(`filter.time.units.${time.last!.unit}`) })
  if (mode === 'range') {
    const days = daysOf(time)
    const said = time.grain === 'month' ? days.map((day) => day?.slice(0, 7)) : days
    return time.grain === 'month' && said[0] && said[0] === said[1] ? said[0] : said.map((day) => day ?? '…').join(' ~ ')
  }
  if (mode !== 'advanced') return t(`filter.time.${mode}`)
  const { start, end } = time.bounds ?? {}
  if (!start && !end) return t('filter.time.all')
  const period = (n: number, unit: TimeUnit) => n === 0
    ? t(`filter.time.currentPeriod.${unit}`)
    : t(n < 0 ? 'filter.time.periodsAgo' : 'filter.time.periodsLater', { count: Math.abs(n), unit: t(`filter.time.units.${unit}`) })
  const fixed = (at: string, last: boolean) => {
    const midnight = at.length === 10 || /T00:00(:00)?$/.test(at)
    return midnight ? (last ? shiftDay(at.slice(0, 10), -1) : at.slice(0, 10)) : at.replace('T', ' ')
  }
  const first = !start ? '…' : start.fixed ? fixed(start.fixed, false) : period(start.relative!.n, start.relative!.unit)
  const last = !end ? '…' : end.fixed ? fixed(end.fixed, true) : period(end.relative!.n - 1, end.relative!.unit)
  return first === last ? first : `${first} ~ ${last}`
}

/** Cascades use explicit filter IDs, never inferred field names. */
export function descendants(filters: { id: string; dependsOn?: string[] }[], id: string): string[] {
  const found = new Set<string>()
  const visit = (parent: string) => {
    for (const filter of filters) if (filter.id !== id && filter.dependsOn?.includes(parent) && !found.has(filter.id)) { found.add(filter.id); visit(filter.id) }
  }
  visit(id)
  return [...found]
}

/** Changing a parent clears its descendants, including saved defaults. */
export function cascadeValues(filters: { id: string; dependsOn?: string[] }[], values: Record<string, unknown>, id: string, value: unknown): Record<string, unknown> {
  return { ...values, ...Object.fromEntries(descendants(filters, id).map((child) => [child, null])), [id]: value ?? null }
}
export const canCascade = (filter: { op: FilterOp; control?: FilterControl; aggregation?: Aggregation }) => filter.op === 'in' && isSelect(filter.control) && !filter.aggregation
export function cascadeParents<T extends { id: string; dependsOn?: string[] }>(filters: T[], id: string): T[] {
  const found = new Set<string>()
  const visit = (child: string) => { for (const parent of filters.find((filter) => filter.id === child)?.dependsOn ?? []) if (!found.has(parent)) { found.add(parent); visit(parent) } }
  visit(id)
  return [...found].map((parent) => filters.find((filter) => filter.id === parent)).filter((filter): filter is T => Boolean(filter))
}

/** The entire connected group participates in reverse matching, including sibling branches. */
export function cascadeComponent<T extends { id: string; dependsOn?: string[] }>(filters: T[], id: string): T[] {
  const found = new Set([id])
  for (let changed = true; changed;) {
    changed = false
    for (const filter of filters) {
      if (!found.has(filter.id) && !filter.dependsOn?.some((parent) => found.has(parent))) continue
      for (const key of [filter.id, ...(filter.dependsOn ?? [])]) if (!found.has(key)) { found.add(key); changed = true }
    }
  }
  return filters.filter((filter) => found.has(filter.id))
}

/** Mirrors the server: every related filter must map to every option source in its group. */
export function validGlobalCascade(filters: GlobalFilter[], fields: FilterField[]): boolean {
  const checked = new Set<string>()
  for (const filter of filters) {
    if (checked.has(filter.id)) continue
    const group = cascadeComponent(filters, filter.id)
    group.forEach((member) => checked.add(member.id))
    if (!group.some((member) => member.dependsOn?.length)) continue
    const sources = group.map((member) => member.optionsFrom ?? member.targets[0]?.item)
    for (const member of group) {
      if (!canCascade(member) || cascadeParents(filters, member.id).some((parent) => parent.id === member.id)) return false
      if (member.dependsOn?.some((id) => !filters.some((parent) => parent.id === id))) return false
      if (sources.some((source) => !source || !member.targets.some((target) => target.item === source))) return false
      if (member.targets.some((target) => {
        const entry = fields.find((entry) => sameTarget(entry.target, target))
        return !entry || entry.aggregate
      })) return false
    }
  }
  return true
}

/** Reverse matching recomputes ancestors without unrelated sibling defaults. */
export function reverseCascadeValues(filters: { id: string; dependsOn?: string[] }[], values: Record<string, unknown>, id: string): Record<string, unknown> {
  const ancestors = cascadeParents(filters, id)
  const keep = new Set([id, ...ancestors.map((parent) => parent.id)])
  const cleared = ancestors.flatMap((parent) => descendants(filters, parent.id)).filter((child) => !keep.has(child))
  return { ...values, ...Object.fromEntries([...cleared, ...ancestors.map((parent) => parent.id)].map((child) => [child, null])) }
}

type Range = ReturnType<typeof rangeOf>
const unbounded = (bound: unknown) => bound === null || bound === undefined

// Leaving out what a single bound keeps keeps the rest: not ≤ 10 is > 10.
const opposite = { '<': '≥', '≤': '>', '>': '≤', '≥': '<' } as const

/** A range as intervals are written: [1, 10], (1, 10], or a single bound as ≥ 1. */
function describeRange({ min, max, includeMin, includeMax }: Range, excluded = false): string {
  const bound = (sign: keyof typeof opposite, value: unknown) => `${excluded ? opposite[sign] : sign} ${String(value)}`
  if (unbounded(min)) return bound(includeMax === false ? '<' : '≤', max)
  if (unbounded(max)) return bound(includeMin === false ? '>' : '≥', min)
  const range = `${includeMin === false ? '(' : '['}${String(min)}, ${String(max)}${includeMax === false ? ')' : ']'}`
  return excluded ? `NOT ${range}` : range
}

/** A value in words, for where there is no room for its control. */
export function describeValue(op: FilterOp, value: unknown, t: TFunction): string {
  if (!takesValue(op)) return ''
  if (isEmpty(op, value)) return t('filter.any')
  if (op === 'time') return describeTime(value, t)
  if (op === 'between' || op === 'not_between') return describeRange(rangeOf(value))
  if (Array.isArray(value)) {
    const listed = value.slice(0, 3).map(String).join(t('filter.separator'))
    return value.length > 3 ? t('filter.manyValues', { first: listed, count: value.length }) : listed
  }
  return String(value)
}

/** A condition and its value as a formula puts them, for a filter's chip: = app, IN (app, web), [1, 10], IS NULL. */
export function describeCondition(op: FilterOp, value: unknown, t: TFunction): string {
  if (!takesValue(op)) return opText(op, t)
  if (isEmpty(op, value)) return t('filter.any')
  if (op === 'time') return describeTime(value, t)
  if (op === 'between' || op === 'not_between') return describeRange(rangeOf(value), op === 'not_between')
  if (op === 'in' || op === 'not_in') {
    const values: unknown[] = Array.isArray(value) ? value : [value]
    if (values.length === 1) return `${opSymbols[op === 'in' ? 'eq' : 'ne']} ${String(values[0])}`
    const listed = values.slice(0, 3).map(String).join(', ')
    return `${opSymbols[op]} (${listed}${values.length > 3 ? `, +${values.length - 3}` : ''})`
  }
  return `${opText(op, t)} ${String(value)}`
}
