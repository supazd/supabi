// What the Explore page lets a user choose, and how that becomes a chart spec.
// The page can only edit charts whose spec it could have produced itself;
// `restore` decides that, so a richer spec (made through the API, or later by
// AI) is never silently simplified by opening and saving it here.
import { axisKinds, groupsOf, layoutColumns, shareTypes, styleApplies, type Axis, type ColumnGroup, type DisplayFormat, type Style, type Viz, type VizType } from '@supabi/charts'
import { aggregations, aggsFor, isTemporal, type Aggregation, type SpecField } from '../api/spec'
import { cleanFilter, editableFilter, type ChartFilter } from './filters'
import { cleanParamFilter, isFieldFilter, isParamFilter, type ParamFilter } from './paramFilters'
import { dynamicColumn, validDynamics, type DynamicField } from './dynamics'
import { drillProblem, drillTypes, maxDrillLevels, type Drill, type DrillProblem, type Grouping } from './drill'
import type { FilterStyle } from './filterStyle'

export const grains = ['year', 'quarter', 'month', 'week', 'day'] as const
export type Grain = (typeof grains)[number]

export interface PercentCompute {
  type: 'percent_of_total'
  within?: string[]
}

export interface CompareCompute {
  type: 'compare'
  timeField: string
  offset: { n: number; unit: Grain }
  output: 'value' | 'delta' | 'ratio'
}

/** A running total along one dimension, starting over for each combination of the others. */
export interface CumulativeCompute {
  type: 'cumulative'
  along: string
}
export type MeasureCompute = PercentCompute | CompareCompute | CumulativeCompute

/**
 * A measure of a chart: a field of the dataset and how the chart aggregates
 * it. A measure or a dimension always has an `agg`; a metric of the dataset
 * aggregates by itself and has none, and so has a dynamic slot, whose `field`
 * is the slot's alias.
 */
export interface PickedMeasure {
  compute?: MeasureCompute
  field: string
  agg?: Aggregation
  /**
   * The name of its column, given when it is added and kept when its
   * aggregation changes, so what refers to the column still finds it. The
   * field's key when absent.
   */
  alias?: string
  /** What the chart calls it, in place of the name made from the field and the aggregation. */
  label?: string
}

/** An order of the rows: by an output column, ascending unless `desc`. */
export interface SortKey {
  by: string
  desc?: true
}

/** The name of a measure's column. */
export const measureName = (measure: PickedMeasure): string => measure.alias ?? measure.field

/**
 * What the builder offers to draw. A detail table is not a kind of drawing but
 * a kind of question: the rows as they are, neither grouped nor aggregated. It
 * is stored as a detail query shown as a table.
 */
export type BuilderType = VizType | 'detail'

export interface BuilderState {
  dimensions: string[]
  measures: PickedMeasure[]
  /** The fields of a detail table, in order. Empty for every other type. */
  columns: string[]
  /** What the chart calls its dimensions and columns, by field, where that is not the field's own name. */
  labels: Record<string, string>
  grain: Grain
  /** The conditions the chart runs under, time ranges among them. */
  filters: ChartFilter[]
  /** What the chart gives the dataset's parameters, written before the conditions: they decide what data there is. */
  params?: ParamFilter[]
  dynamics?: DynamicField[]
  filterStyle?: FilterStyle
  vizType: BuilderType
  stacked: boolean
  /**
   * The chart's look. Settings the chosen type does not have are kept, so
   * going to another type and back loses nothing, but are not written.
   */
  style?: Style
  /** A combo chart's measures drawn as lines, by column; all but the first when absent. */
  lines?: string[]
  /** A combo chart's measures read against the right axis, by column. */
  rightAxis?: string[]
  /** The dimensions a pivot table spreads across the top; the others run down the side. */
  pivotColumns?: string[]
  /** Whether a grouped table or a pivot table shows the database's totals. */
  totals?: boolean
  /** Whether a pivot table with totals also shows a subtotal for each group of an outer dimension. */
  subtotals?: boolean
  /** A KPI tile's measure, and the measure it is compared against, by column. */
  compare?: Record<string, string>
  /**
   * How the rows are ordered, by output column, the first key first. Without
   * it a chart is ordered by its dimensions and a detail table not at all.
   */
  sort?: SortKey[]
  /** The most rows the chart asks for; the server's default without it. */
  limit?: number
  /**
   * Display formats of the chart's own, by output column, in place of the
   * dataset's. One whose column is gone is kept but not written.
   */
  formats?: Record<string, DisplayFormat>
  /** Output columns hidden only when this chart is displayed as a table. */
  hiddenColumns?: string[]
  /** Headers over adjacent columns of a table, kept as the columns are when written. */
  columnGroups?: ColumnGroup[]
  /** Whether everyone who can open a dashboard showing the chart may export its data there. */
  allowExport?: boolean
  /**
   * The levels a viewer can drill down below one dimension. Kept while the
   * chart cannot be drilled there, so going to another type and back loses
   * nothing, but written only where it can (see drilled).
   */
  drill?: Drill
}

export interface ChartSpec {
  specVersion: 1
  query: Record<string, unknown>
  viz: Viz
  filters?: (ChartFilter | ParamFilter)[]
  dynamics?: DynamicField[]
  filterStyle?: FilterStyle
  allowExport?: boolean
  drill?: Drill
}

const temporal = (key: string, fields: SpecField[]) => fields.some((field) => field.key === key && isTemporal(field.type))

/** Why a chart cannot be drawn as the type chosen for it, and on which shelf that is put right. */
export interface ShapeProblem {
  shelf: 'dimension' | 'metric'
  problem: 'needsDimension' | 'needsTwoDimensions' | 'needsMetric' | 'needsTwoMetrics' | 'tooManyDimensions' | 'tooManyMetrics' | 'oneMetricWithTwoDimensions' | 'oneDimension' | 'oneMetric' | 'noDimension'
  /** The most there can be, for tooManyMetrics and tooManyDimensions. */
  max?: number
}

/** The most levels a sankey diagram has (internal/content/viz.go). */
export const maxSankeyLevels = 4

/**
 * What the fields picked lack, or have too many of, for the chosen type; the
 * first thing to put right when there are several. The type is the author's
 * choice and is never changed for them: a chart that does not fit it says
 * so until it does. A table, grouped or not, can show anything.
 */
export function shapeProblem(state: Pick<BuilderState, 'vizType' | 'dimensions' | 'measures'>): ShapeProblem | undefined {
  const d = state.dimensions.length
  const m = state.measures.length
  const problem = (shelf: ShapeProblem['shelf'], problem: ShapeProblem['problem'], max?: number): ShapeProblem => ({ shelf, problem, ...(max ? { max } : {}) })
  switch (state.vizType) {
    case 'bar':
    case 'hbar':
    case 'line':
    case 'area':
      // One dimension along the axis with any number of metrics, or a second dimension that splits a single metric into series.
      if (d === 0) return problem('dimension', 'needsDimension')
      if (d > 2) return problem('dimension', 'tooManyDimensions', 2)
      if (m === 0) return problem('metric', 'needsMetric')
      if (d === 2 && m > 1) return problem('metric', 'oneMetricWithTwoDimensions')
      return undefined
    case 'combo':
      if (d === 0) return problem('dimension', 'needsDimension')
      if (d > 1) return problem('dimension', 'oneDimension')
      if (m < 2) return problem('metric', 'needsTwoMetrics')
      return undefined
    case 'scatter':
      // A point for each value of the first dimension; a second one colours them. A third metric sizes them.
      if (d === 0) return problem('dimension', 'needsDimension')
      if (d > 2) return problem('dimension', 'tooManyDimensions', 2)
      if (m < 2) return problem('metric', 'needsTwoMetrics')
      if (m > 3) return problem('metric', 'tooManyMetrics', 3)
      return undefined
    case 'pie':
    case 'funnel':
      if (d === 0) return problem('dimension', 'needsDimension')
      if (d > 1) return problem('dimension', 'oneDimension')
      if (m === 0) return problem('metric', 'needsMetric')
      if (m > 1) return problem('metric', 'oneMetric')
      return undefined
    case 'treemap':
      if (d === 0) return problem('dimension', 'needsDimension')
      if (d > 2) return problem('dimension', 'tooManyDimensions', 2)
      if (m === 0) return problem('metric', 'needsMetric')
      if (m > 1) return problem('metric', 'oneMetric')
      return undefined
    case 'heatmap':
      if (d < 2) return problem('dimension', 'needsTwoDimensions')
      if (d > 2) return problem('dimension', 'tooManyDimensions', 2)
      if (m === 0) return problem('metric', 'needsMetric')
      if (m > 1) return problem('metric', 'oneMetric')
      return undefined
    case 'gauge':
      // The second metric, when there is one, is the target.
      if (d > 0) return problem('dimension', 'noDimension')
      if (m === 0) return problem('metric', 'needsMetric')
      if (m > 2) return problem('metric', 'tooManyMetrics', 2)
      return undefined
    case 'kpi':
      if (d > 0) return problem('dimension', 'noDimension')
      if (m === 0) return problem('metric', 'needsMetric')
      return undefined
    case 'sankey':
      // Each dimension is a level, left to right; the metric flows between them.
      if (d < 2) return problem('dimension', 'needsTwoDimensions')
      if (d > maxSankeyLevels) return problem('dimension', 'tooManyDimensions', maxSankeyLevels)
      if (m === 0) return problem('metric', 'needsMetric')
      if (m > 1) return problem('metric', 'oneMetric')
      return undefined
    case 'pivot':
      if (d === 0) return problem('dimension', 'needsDimension')
      if (m === 0) return problem('metric', 'needsMetric')
      return undefined
    default:
      return undefined
  }
}

/**
 * The aggregations a field can be given on a chart, the one it starts with
 * first: a sum for a measure, a count of distinct values for a dimension. A
 * metric has none.
 */
export function aggChoices(field: SpecField): Aggregation[] {
  if (field.role === 'metric') return []
  const first = field.role === 'measure' ? 'sum' : 'count_distinct'
  return [first, ...aggsFor(field.type).filter((agg) => agg !== first)]
}

const maxNameLength = 60

/**
 * Adds a field to the measures. A field may be there several times, each
 * aggregated differently, so adding it again takes the next aggregation not
 * in use; when there is none left, nothing changes. `taken` are the other
 * names of the query's columns, its dimensions.
 *
 * The first measure of a measure field is named after the field; any other,
 * and any aggregated dimension, which may be grouped by as well, after the
 * field and the aggregation.
 */
export function addMeasure(measures: PickedMeasure[], field: SpecField, taken: string[] = []): PickedMeasure[] {
  const used = measures.filter((measure) => measure.field === field.key && !measure.compute).map((measure) => measure.agg)
  if (field.role === 'metric') {
    if (used.length) return measures
    const names = new Set([...taken, ...measures.map(measureName)])
    let alias = field.key
    for (let n = 2; names.has(alias); n++) alias = `${field.key.slice(0, maxNameLength - String(n).length - 1)}_${n}`
    return [...measures, { field: field.key, ...(alias !== field.key ? { alias } : {}) }]
  }
  const agg = aggChoices(field).find((choice) => !used.includes(choice))
  if (!agg) return measures
  const names = new Set([...taken, ...measures.map(measureName)])
  if (field.role === 'measure' && !names.has(field.key)) return [...measures, { field: field.key, agg }]
  const base = `${field.key.slice(0, maxNameLength - agg.length - 1)}_${agg}`
  let alias = base
  for (let n = 2; names.has(alias); n++) alias = `${base}_${n}`
  return [...measures, { field: field.key, agg, alias }]
}

/**
 * What the measure at `index` can be changed to. The ways the same field is
 * already aggregated elsewhere on the chart are left out: twice the same
 * number is never meant.
 */
export function aggOptions(measures: PickedMeasure[], index: number, field: SpecField): Aggregation[] {
  const taken = measures.filter((other, at) => at !== index && other.field === field.key && same(other.compute, measures[index]?.compute)).map((other) => other.agg)
  return aggChoices(field).filter((agg) => !taken.includes(agg))
}

/**
 * The chart's own display format and conditional format for a column
 * dropped, for when its number comes to mean something else: neither the
 * units nor the thresholds fit it any more.
 */
function withoutNumberSettings(state: Pick<BuilderState, 'formats' | 'style'>, column: string): Pick<BuilderState, 'formats' | 'style'> {
  const formats = Object.fromEntries(Object.entries(state.formats ?? {}).filter(([name]) => name !== column))
  if (!state.style?.highlights?.[column]) return { formats: Object.keys(formats).length ? formats : undefined, style: state.style }
  const highlights = Object.fromEntries(Object.entries(state.style.highlights).filter(([name]) => name !== column))
  return { formats: Object.keys(formats).length ? formats : undefined, style: { ...state.style, highlights: Object.keys(highlights).length ? highlights : undefined } }
}

/**
 * Aggregates the measure at `index` another way. Its column keeps its name,
 * so what refers to it still finds it; the chart's own display format and
 * conditional format for it are dropped, since the number now means
 * something else.
 */
export function reaggregated(state: Pick<BuilderState, 'measures' | 'formats' | 'style'>, index: number, agg: Aggregation): Pick<BuilderState, 'measures' | 'formats' | 'style'> {
  const measure = state.measures[index]!
  return {
    measures: state.measures.map((other, at) => (at === index ? { ...measure, agg } : other)),
    ...withoutNumberSettings(state, measureName(measure)),
  }
}

/** The names of the measure columns, in order. */
export function measureNames(state: Pick<BuilderState, 'measures'>): string[] {
  return state.measures.map(measureName)
}

/**
 * Changes what is drawn. Going to a detail table and back keeps what was
 * picked as far as it carries over: dimensions and measures become columns,
 * and columns become dimensions and measures aggregated the dataset's way.
 * Metrics have no value on a row, so a detail table leaves them out.
 */
export function withType(state: BuilderState, type: BuilderType, fields: SpecField[]): BuilderState {
  return pruneHiddenColumns(withoutStaleSort(changedType(state, type, fields)))
}

function changedType(state: BuilderState, type: BuilderType, fields: SpecField[]): BuilderState {
  const field = (key: string) => fields.find((candidate) => candidate.key === key)
  if (type === 'detail') {
    if (state.vizType === 'detail') return state
    const source = (key: string) => state.dynamics?.find((dynamic) => dynamic.alias === key)?.options[0]?.field ?? key
    const rows = state.measures.map((measure) => source(measure.field)).filter((key) => field(key)?.role !== 'metric')
    const next = { ...state, vizType: type, stacked: false, dimensions: [], measures: [], columns: [...new Set([...state.dimensions.map(source), ...rows])] }
    delete next.dynamics
    return next
  }
  if (state.vizType !== 'detail') return { ...state, vizType: type }
  const picked = state.columns.map(field).filter((candidate): candidate is SpecField => Boolean(candidate))
  // The type asked for is the type given, whether or not the columns carried over fit it yet.
  return {
    ...state,
    vizType: type,
    columns: [],
    dimensions: picked.filter((candidate) => candidate.role === 'dimension').map((candidate) => candidate.key),
    measures: picked.filter((candidate) => candidate.role === 'measure').reduce<PickedMeasure[]>((measures, field) => addMeasure(measures, field), []),
  }
}

/** The names of the columns the chart's query returns. */
export const outputNames = (state: BuilderState): string[] => (state.vizType === 'detail' ? state.columns : [...state.dimensions, ...measureNames(state)])

/** A removed column should be visible if the author later adds it again. */
export function pruneHiddenColumns(state: BuilderState): BuilderState {
  if (!state.hiddenColumns) return state
  const names = new Set(outputNames(state))
  const hiddenColumns = state.hiddenColumns.filter((name) => names.has(name))
  if (hiddenColumns.length === state.hiddenColumns.length) return state
  const next: BuilderState = { ...state, hiddenColumns }
  if (!hiddenColumns.length) delete next.hiddenColumns
  return next
}

/**
 * Keeps the column groups to the chart's columns: a removed column leaves its
 * group, so it comes back outside every group, and a column added between a
 * group's own joins the innermost group around it.
 */
export function pruneColumnGroups(state: BuilderState): BuilderState {
  if (!state.columnGroups) return state
  const columnGroups = groupsOf(layoutColumns(state.columnGroups, outputNames(state)))
  if (JSON.stringify(columnGroups) === JSON.stringify(state.columnGroups)) return state
  const next: BuilderState = { ...state, columnGroups }
  if (!columnGroups.length) delete next.columnGroups
  return next
}

/** Optional dynamic dimensions may all be cleared; a table still needs a visible column then. */
export function needsVisibleColumn(state: BuilderState): boolean {
  if (!['table', 'detail'].includes(state.vizType) || !state.hiddenColumns?.length) return false
  const optional = new Set(state.dynamics?.filter((dynamic) => dynamic.kind === 'dimension' && dynamic.allowEmpty).map((dynamic) => dynamic.alias))
  return !outputNames(state).some((name) => !state.hiddenColumns!.includes(name) && !optional.has(name))
}

/**
 * Orders the rows by a column, or no longer by it without a direction. A
 * column already ordered by keeps its place among the keys, so changing its
 * direction does not change which key comes first; a new one comes last.
 */
export function sortedBy(state: Pick<BuilderState, 'sort'>, by: string, direction: 'asc' | 'desc' | undefined): Pick<BuilderState, 'sort'> {
  const key: SortKey = direction === 'desc' ? { by, desc: true } : { by }
  const current = state.sort ?? []
  const sort = !direction ? current.filter((other) => other.by !== by) : current.some((other) => other.by === by) ? current.map((other) => (other.by === by ? key : other)) : [...current, key]
  return { sort: sort.length ? sort : undefined }
}

/** Takes the order off columns the chart no longer returns, so one put back later is not ordered by surprise. */
export function withoutStaleSort(state: BuilderState): BuilderState {
  if (!state.sort) return state
  const names = new Set(outputNames(state))
  const sort = state.sort.filter((key) => names.has(key.by))
  if (sort.length === state.sort.length) return state
  const next: BuilderState = { ...state, sort }
  if (!sort.length) delete next.sort
  return next
}

export function buildViz(state: BuilderState, fields: SpecField[]): Viz {
  const drawn = drawing(state, fields)
  const style = styleFor(drawn, state.style, outputNames(state))
  const viz = style ? { ...drawn, style } : drawn
  const names = new Set(outputNames(state))
  const formats = Object.entries(state.formats ?? {}).filter(([name]) => names.has(name))
  return formats.length ? { ...viz, formats: Object.fromEntries(formats) } : viz
}

function drawing(state: BuilderState, fields: SpecField[]): Viz {
  // A chart that does not fit its type is never saved (the editor says what it lacks), but is still written as something that can be read.
  const type = state.vizType !== 'detail' && !shapeProblem(state) ? state.vizType : 'table'
  if (type === 'table') {
    const names = new Set(outputNames(state))
    const table = ['table', 'detail'].includes(state.vizType)
    const hiddenColumns = table ? state.hiddenColumns?.filter((name) => names.has(name)) : undefined
    const columnGroups = table ? groupsOf(layoutColumns(state.columnGroups, outputNames(state))) : []
    return { type, ...(hiddenColumns?.length ? { hiddenColumns } : {}), ...(columnGroups.length ? { columnGroups } : {}) }
  }
  const y = measureNames(state)
  if (type === 'gauge') return { type, y }
  if (type === 'kpi') {
    // A measure compared against is not compared in turn.
    const compare = Object.entries(state.compare ?? {}).filter(([tile, reference]) => tile !== reference && y.includes(tile) && y.includes(reference) && !state.compare?.[reference])
    return { type, y, ...(compare.length ? { compare: Object.fromEntries(compare) } : {}) }
  }
  if (type === 'pivot') return { type, ...pivotSides(state), y }
  if (type === 'sankey') return { type, levels: state.dimensions, y }
  const [first, second] = state.dimensions
  const stacked = state.stacked && (type === 'bar' || type === 'hbar' || type === 'area') ? { stacked: true } : {}
  if (type === 'combo') {
    const lines = (state.lines ?? y.slice(1)).filter((name) => y.includes(name))
    const rightAxis = (state.rightAxis ?? []).filter((name) => y.includes(name))
    return { type, x: first, y, ...(lines.length ? { lines } : {}), ...(rightAxis.length ? { rightAxis } : {}) }
  }
  if (type === 'pie' || type === 'funnel' || second === undefined) return { type, x: first, y, ...stacked }
  // A scatter chart's points are the first dimension's values, coloured by the second; a treemap groups by the first.
  if (type === 'scatter') return { type, x: first, y, series: second }
  if (type === 'treemap') return { type, x: second, y, series: first }
  // With two dimensions, time runs along the axis and the other one splits the series, or runs down the side of a heatmap.
  const source = (key: string) => state.dynamics?.find((dynamic) => dynamic.alias === key)?.options[0]?.field ?? key
  const x = temporal(source(second), fields) && !temporal(source(first!), fields) ? second : first
  const other = x === first ? second : first!
  if (type === 'heatmap') return { type, rows: [other], columns: [x!], y }
  return { type, x, y, series: other, ...stacked }
}

/**
 * The part of a style that applies to what is drawn: the server refuses the
 * rest, and a setting that does nothing is not written.
 */
export function styleFor(viz: Viz, style: Style | undefined, names: string[] = []): Style | undefined {
  if (!style) return undefined
  const out: Style = {}
  const applies = (key: keyof typeof styleApplies) => styleApplies[key].includes(viz.type)
  if (style.legend && applies('legend')) out.legend = style.legend
  if (style.labels && applies('labels') && (style.labels !== 'percent' || shareTypes.includes(viz.type))) out.labels = style.labels
  if (style.palette && applies('palette')) out.palette = style.palette
  if (style.colors && applies('colors') && !viz.series) {
    const colors = Object.entries(style.colors).filter(([name]) => viz.y?.includes(name))
    if (colors.length) out.colors = Object.fromEntries(colors)
  }
  if (style.smooth && applies('smooth')) out.smooth = true
  if (style.points && applies('points')) out.points = true
  if (style.percent && applies('percent') && viz.stacked) out.percent = true
  if (style.solid && applies('solid')) out.solid = true
  if (style.barWidth && applies('barWidth')) out.barWidth = style.barWidth
  const kinds = axisKinds(viz.type)
  for (const key of ['xAxis', 'yAxis', 'y2Axis'] as const) {
    const kind = key === 'y2Axis' && !viz.rightAxis?.length ? undefined : kinds[key]
    const axis = style[key] && kind ? axisFor(style[key], kind) : undefined
    if (axis) out[key] = axis
  }
  if (style.striped && applies('striped')) out.striped = true
  if (style.density && applies('density')) out.density = style.density
  if (style.freeze && applies('freeze')) out.freeze = true
  if (style.merge && applies('merge')) out.merge = true
  if (style.paging && applies('paging')) out.paging = style.paging
  // A page size is kept for when pages come back, but written only with them.
  if (style.pageSize && style.paging === 'pages' && applies('pageSize')) out.pageSize = style.pageSize
  // Widths and alignments of columns the table no longer has are kept for when they come back, but not written.
  for (const key of ['widths', 'columnAlign'] as const) {
    const entries = Object.entries(style[key] ?? {}).filter(([name]) => names.includes(name))
    if (entries.length && applies(key)) out[key] = Object.fromEntries(entries) as never
  }
  // So are a column's rules; a pivot table's are only for its measures, whose cells they shade.
  if (style.highlights && applies('highlights')) {
    const entries = Object.entries(style.highlights).filter(([name, rules]) => rules.length && names.includes(name) && (viz.type !== 'pivot' || viz.y?.includes(name)))
    if (entries.length) out.highlights = Object.fromEntries(entries)
  }
  if (style.textAlign && applies('textAlign')) out.textAlign = style.textAlign
  if (style.size && applies('size')) out.size = style.size
  // How a comparison is written only means something where there is one.
  if (viz.compare) {
    if (style.compareAs && applies('compareAs')) out.compareAs = style.compareAs
    if (style.redUp && applies('redUp')) out.redUp = true
  }
  if (style.gauge && applies('gauge')) {
    const gauge = { ...(style.gauge.min !== undefined ? { min: style.gauge.min } : {}), ...(style.gauge.max !== undefined && (viz.y?.length ?? 0) < 2 ? { max: style.gauge.max } : {}) }
    if (Object.keys(gauge).length) out.gauge = gauge
  }
  return Object.keys(out).length ? out : undefined
}

function axisFor(axis: Axis, kind: 'value' | 'category'): Axis | undefined {
  const out: Axis = {}
  if (axis.title?.trim()) out.title = axis.title.trim()
  if (kind === 'value') {
    if (axis.min !== undefined) out.min = axis.min
    if (axis.max !== undefined) out.max = axis.max
    if (axis.hideGrid) out.hideGrid = true
  } else if (axis.rotate) out.rotate = axis.rotate
  if (axis.hideLabels) out.hideLabels = true
  return Object.keys(out).length ? out : undefined
}

export function buildQuery(datasetId: string, state: BuilderState, fields: SpecField[]): Record<string, unknown> {
  return { ...questionOf(datasetId, state, fields), ...rowsOf(state) }
}

/** How many rows, in what order: only by columns the query returns, so one taken off is not asked for. */
function rowsOf(state: BuilderState): Record<string, unknown> {
  const names = new Set(outputNames(state))
  const sort = (state.sort ?? []).filter((key) => names.has(key.by))
  const totals = totalsOf(state)
  return { ...(sort.length ? { sort } : {}), ...(state.limit !== undefined ? { limit: state.limit } : {}), ...(totals.length ? { totals } : {}) }
}

/** The most totals a query may ask for; the server's limit (internal/query/totals.go). */
export const maxTotals = 16

/**
 * The totals a table asks the database for: a grouped table's grand total; a
 * pivot table's total of each row, of each column, and of everything. A
 * total that would group by every dimension is the table itself, and is not
 * asked for.
 *
 * With subtotals, a pivot table also asks for each group of an outer
 * dimension: every pairing of the first so many row dimensions with the
 * first so many column dimensions, so a subtotal row has a value under every
 * column, subtotal and total column included. They come after the totals
 * above, and are left out when there would be more than the server takes.
 */
export function totalsOf(state: BuilderState): string[][] {
  // A sankey diagram's flows between neighbouring levels are totals, asked for whenever there are more than two levels.
  if (state.vizType === 'sankey') return shapeProblem(state) || state.dimensions.length <= 2 ? [] : state.dimensions.slice(1).map((key, i) => [state.dimensions[i]!, key])
  if (!state.totals || shapeProblem(state) || state.measures.length === 0) return []
  if (state.vizType === 'table') return state.dimensions.length ? [[]] : []
  if (state.vizType !== 'pivot') return []
  const { rows, columns } = pivotSides(state)
  const out: string[][] = []
  if (columns.length) out.push(rows)
  if (rows.length) out.push(columns)
  if (rows.length && columns.length) out.push([])
  if (!state.subtotals || !subtotalsFit(state)) return out
  for (let i = rows.length; i >= 0; i--) {
    for (let j = columns.length; j >= 0; j--) {
      const keep = [...rows.slice(0, i), ...columns.slice(0, j)]
      // The table itself, or a total asked for already.
      if (keep.length === state.dimensions.length || out.some((other) => other.length === keep.length && other.every((name, at) => name === keep[at]))) continue
      out.push(keep)
    }
  }
  return out
}

/** A pivot table's dimensions down the side and across the top, each in the order they were added. */
function pivotSides(state: Pick<BuilderState, 'dimensions' | 'pivotColumns'>) {
  const across = new Set(state.pivotColumns ?? [])
  return { rows: state.dimensions.filter((key) => !across.has(key)), columns: state.dimensions.filter((key) => across.has(key)) }
}

/** Whether a pivot table has an outer dimension to subtotal, down the side or across the top. */
export function hasSubtotals(state: Pick<BuilderState, 'dimensions' | 'pivotColumns'>): boolean {
  const { rows, columns } = pivotSides(state)
  return rows.length > 1 || columns.length > 1
}

/** Whether the totals a pivot table with subtotals asks for stay within the server's limit. */
export function subtotalsFit(state: Pick<BuilderState, 'dimensions' | 'pivotColumns'>): boolean {
  const { rows, columns } = pivotSides(state)
  return hasSubtotals(state) && (rows.length + 1) * (columns.length + 1) - 1 <= maxTotals
}

function questionOf(datasetId: string, state: BuilderState, fields: SpecField[]): Record<string, unknown> {
  const label = (key: string) => (state.labels[key] ? { label: state.labels[key] } : {})
  const dynamic = (key: string, compute?: MeasureCompute) => {
    const slot = state.dynamics?.find((slot) => slot.alias === key)
    return slot?.options[0] ? dynamicColumn(slot, slot.options[0], compute) : undefined
  }
  // A column is written as its field alone unless it has a label, which is how the server writes it back.
  if (state.vizType === 'detail') return { version: 1, dataset: datasetId, mode: 'detail', columns: state.columns.map((key) => (state.labels[key] ? { field: key, ...label(key) } : key)) }
  return {
    version: 1,
    dataset: datasetId,
    dimensions: state.dimensions.map((key) => dynamic(key) ?? ({ field: key, ...(temporal(key, fields) ? { grain: state.grain } : {}), ...label(key) })),
    measures: state.measures.map((measure) => ({ ...(dynamic(measure.field, measure.compute) ?? {
      field: measure.field,
      ...(measure.agg ? { agg: measure.agg } : {}),
      ...(measure.alias ? { alias: measure.alias } : {}),
      ...(measure.label ? { label: measure.label } : {}),
    }), ...(measure.compute ? { compute: measure.compute } : {}) })),
  }
}

export function buildSpec(datasetId: string, state: BuilderState, fields: SpecField[]): ChartSpec {
  const drill = drilled(state, fields)
  const filters = [...(state.params ?? []).map(cleanParamFilter), ...state.filters.map(cleanFilter)]
  return { specVersion: 1, query: buildQuery(datasetId, state, fields), viz: buildViz(state, fields), ...(filters.length ? { filters } : {}), ...(state.dynamics?.length && state.vizType !== 'detail' ? { dynamics: state.dynamics } : {}), ...(state.filterStyle ? { filterStyle: state.filterStyle } : {}), ...(state.allowExport ? { allowExport: true } : {}), ...(drill ? { drill } : {}) }
}

/**
 * The dimensions a viewer could drill down as the chart is now: the category
 * axis of a bar, line, area or combo chart and the slices of a pie, or any
 * dimension of a grouped table. A dynamic dimension changes field itself, so
 * none of those.
 */
export function drillableColumns(state: BuilderState, fields: SpecField[]): string[] {
  if (!(drillTypes as readonly string[]).includes(state.vizType) || shapeProblem(state)) return []
  const fixed = state.dimensions.filter((key) => !state.dynamics?.some((dynamic) => dynamic.alias === key))
  if (state.vizType === 'table') return fixed
  const x = drawing(state, fields).x
  return x !== undefined && fixed.includes(x) ? [x] : []
}

/** The drill the chart is written with: its own, where the chart can be drilled there. */
export function drilled(state: BuilderState, fields: SpecField[]): Drill | undefined {
  return state.drill && state.drill.levels.length > 0 && drillableColumns(state, fields).includes(state.drill.alias) ? state.drill : undefined
}

/** The levels of a dimension of the chart as they group it: a date at the chart's grain. */
export const groupingOf = (state: Pick<BuilderState, 'grain'>, key: string, fields: SpecField[]) => ({ field: key, ...(temporal(key, fields) ? { grain: state.grain } : {}) })

/**
 * How the chart's dimensions but one group it, which no level of a drill
 * down that one may repeat: a dynamic dimension by its first choice, as the
 * query is written and the server checks it.
 */
export function otherGroupings(state: BuilderState, alias: string, fields: SpecField[]): Grouping[] {
  return state.dimensions.filter((key) => key !== alias).flatMap((key) => {
    const dynamic = state.dynamics?.find((slot) => slot.alias === key)
    if (!dynamic) return [groupingOf(state, key, fields)]
    const first = dynamic.options[0]
    return first ? [{ field: first.field, ...(first.grain ? { grain: first.grain } : {}) }] : []
  })
}

/**
 * What is wrong with the drill the chart is written with; a column drilled
 * down cannot be hidden either, since it is what is clicked.
 */
export function chartDrillProblem(state: BuilderState, fields: SpecField[]): DrillProblem | 'hidden' | undefined {
  const drill = drilled(state, fields)
  if (!drill) return undefined
  if (state.vizType === 'table' && state.hiddenColumns?.includes(drill.alias)) return 'hidden'
  return drillProblem(groupingOf(state, drill.alias, fields), drill.levels, otherGroupings(state, drill.alias, fields), fields)
}

/** A drill whose dimension is gone from the chart goes with it; one kept by a detail table is not gone. */
export function pruneDrill(state: BuilderState): BuilderState {
  if (!state.drill || state.vizType === 'detail' || state.dimensions.includes(state.drill.alias)) return state
  const next = { ...state }
  delete next.drill
  return next
}

/** Whether a stored drill is one the builder writes: a date down to a grain it offers, each level named or not. */
function editableDrill(drill: unknown, fields: SpecField[]): drill is Drill {
  if (!drill || typeof drill !== 'object' || Object.keys(drill).some((key) => key !== 'alias' && key !== 'levels')) return false
  const { alias, levels } = drill as { alias?: unknown; levels?: unknown }
  if (typeof alias !== 'string' || !Array.isArray(levels) || levels.length === 0 || levels.length > maxDrillLevels) return false
  return levels.every((level: unknown) => {
    if (!level || typeof level !== 'object' || Object.keys(level).some((key) => !['field', 'grain', 'label'].includes(key))) return false
    const { field, grain, label } = level as { field?: unknown; grain?: unknown; label?: unknown }
    const found = fields.find((candidate) => candidate.key === field)
    return typeof field === 'string' && (label === undefined || typeof label === 'string')
      && (grain === undefined ? !found || !isTemporal(found.type) : grains.includes(grain as Grain))
  })
}

/**
 * Recovers the builder state from a chart spec, or returns undefined when the
 * spec says something the builder cannot express.
 */
export function restore(spec: ChartSpec, fields: SpecField[]): BuilderState | undefined {
  const query = spec.query as {
    dataset?: unknown
    mode?: string
    columns?: (string | { field?: string; label?: string })[]
    dimensions?: { field?: string; alias?: string; grain?: string; label?: string }[]
    measures?: { field?: string; agg?: string; alias?: string; label?: string; baseLabel?: string; compute?: MeasureCompute }[]
    sort?: unknown
    limit?: unknown
    totals?: unknown
  }
  if (typeof query.dataset !== 'string') return undefined
  const sort = query.sort ?? []
  if (!Array.isArray(sort) || !sort.every(isSortKey)) return undefined
  if (query.limit !== undefined && !(Number.isInteger(query.limit) && (query.limit as number) > 0)) return undefined
  const params = (spec.filters ?? []).filter(isParamFilter)
  const filters = (spec.filters ?? []).filter(isFieldFilter).map((filter) => {
    const next = { ...filter }
    delete next.exposed
    return next
  })
  if (!filters.every((filter) => editableFilter(filter, fields))) return undefined
  // One whose parameter the dataset no longer has is kept, to be seen and taken off the chart.
  if (!params.every((filter) => !filter.control || ['input', 'select'].includes(filter.control.type))) return undefined
  const dynamics = spec.dynamics ?? []
  if (!validDynamics(dynamics, fields) || (query.mode === 'detail' && dynamics.length)) return undefined
  if (spec.drill !== undefined && !editableDrill(spec.drill, fields)) return undefined
  if (dynamics.some((slot) => (slot.kind === 'dimension' ? query.dimensions : query.measures)?.filter((column) => column.alias === slot.alias).length !== 1)) return undefined
  const dynamic = (alias: string | undefined, kind: DynamicField['kind']) => dynamics.find((slot) => slot.alias === alias && slot.kind === kind)
  const dimensions = (query.dimensions ?? []).map((dimension) => dynamic(dimension.alias, 'dimension')?.alias ?? dimension.field ?? '')
  const measures: PickedMeasure[] = (query.measures ?? []).map((measure) => ({ ...(dynamic(measure.alias, 'measure') ? { field: measure.alias! } : {
    field: measure.field ?? '',
    ...(measure.agg ? { agg: measure.agg as Aggregation } : {}),
    ...(measure.alias ? { alias: measure.alias } : {}),
    ...(measure.label ? { label: measure.label } : {}),
  }), ...(measure.compute ? { compute: measure.compute } : {}) }))
  if (measures.some((measure) => measure.compute && !editableCompute(measure.compute, dimensions))) return undefined
  if (measures.some((measure) => measure.agg !== undefined && !aggregations.includes(measure.agg))) return undefined
  // A field of the dataset that is not a metric is aggregated the way the chart says; one
  // that does not say cannot be shown. A measure the dataset broke since (its field gone,
  // or made a metric) is kept as it is, so it can be seen and taken off the chart.
  const slots = new Set(dynamics.map((slot) => slot.alias))
  if (measures.some((measure) => {
    const field = fields.find((candidate) => candidate.key === measure.field)
    return !slots.has(measure.field) && field !== undefined && field.role !== 'metric' && measure.agg === undefined
  })) return undefined
  const usedGrains = [...new Set((query.dimensions ?? []).filter((dimension) => !dynamic(dimension.alias, 'dimension')).map((dimension) => dimension.grain).filter(Boolean))]
  if (usedGrains.length > 1 || (usedGrains[0] && !grains.includes(usedGrains[0] as Grain))) return undefined

  const detail = query.mode === 'detail'
  const columns = (query.columns ?? []).map((column) => (typeof column === 'string' ? { field: column } : column))
  const labels: Record<string, string> = {}
  for (const item of detail ? columns : (query.dimensions ?? []).filter((dimension) => !dynamic(dimension.alias, 'dimension'))) if (item.field && item.label) labels[item.field] = item.label
  const state: BuilderState = {
    dimensions,
    measures,
    columns: detail ? columns.map((column) => column.field ?? '') : [],
    labels,
    grain: (usedGrains[0] as Grain | undefined) ?? 'month',
    filters,
    ...(params.length ? { params } : {}),
    ...(dynamics.length ? { dynamics } : {}),
    ...(spec.filterStyle ? { filterStyle: spec.filterStyle } : {}),
    ...(spec.allowExport ? { allowExport: true } : {}),
    ...(spec.drill ? { drill: spec.drill } : {}),
    vizType: detail ? 'detail' : spec.viz.type,
    stacked: Boolean(spec.viz.stacked),
    ...(spec.viz.style ? { style: spec.viz.style } : {}),
    // A combo chart without lines draws every measure as a bar, which is not what it starts as.
    ...(spec.viz.type === 'combo' ? { lines: spec.viz.lines ?? [], ...(spec.viz.rightAxis ? { rightAxis: spec.viz.rightAxis } : {}) } : {}),
    ...(spec.viz.type === 'pivot' && spec.viz.columns?.length ? { pivotColumns: spec.viz.columns } : {}),
    ...(spec.viz.compare ? { compare: spec.viz.compare } : {}),
    ...(query.totals !== undefined && spec.viz.type !== 'sankey' ? { totals: true } : {}),
    ...(sort.length ? { sort: sort.map((key): SortKey => (key.desc ? { by: key.by, desc: true } : { by: key.by })) } : {}),
    ...(query.limit !== undefined ? { limit: query.limit as number } : {}),
    ...(spec.viz.formats ? { formats: spec.viz.formats } : {}),
    ...(spec.viz.hiddenColumns?.length ? { hiddenColumns: spec.viz.hiddenColumns } : {}),
    ...(spec.viz.columnGroups?.length ? { columnGroups: spec.viz.columnGroups } : {}),
  }
  // The test: would the builder, given this state, write exactly this spec? A pivot table's totals may be with its subtotals.
  // Older dynamic computations stored their option name as a final label.
  // Normalize only that known form; arbitrary query labels remain untouched.
  // Parameters are written first, wherever the spec had them.
  const comparable = { ...spec, filters: [...params, ...filters], query: { ...spec.query, ...(query.measures ? { measures: query.measures.map((measure) => {
    const slot = dynamic(measure.alias, 'measure')
    if (!measure.compute || !slot || !measure.label || measure.baseLabel || measure.label !== slot.options[0]?.label) return measure
    const { label, ...rest } = measure
    return { ...rest, baseLabel: label }
  }) } : {}) } }
  const writes = (candidate: BuilderState) => same(buildSpec(query.dataset as string, candidate, fields), comparable)
  if (writes(state)) return state
  const subtotaled = { ...state, subtotals: true }
  return state.vizType === 'pivot' && state.totals && writes(subtotaled) ? subtotaled : undefined
}

const isSortKey = (key: unknown): key is { by: string; desc?: boolean } =>
  typeof key === 'object' && key !== null && typeof (key as { by?: unknown }).by === 'string' && [undefined, false, true].includes((key as { desc?: unknown }).desc as never)

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => same(item, b[i]))
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    return [...keys].every((key) => same(normal((a as Record<string, unknown>)[key]), normal((b as Record<string, unknown>)[key])))
  }
  return false
}

/** The server omits empty and false values; treat them as absent on both sides. */
function normal(value: unknown): unknown {
  if (value === false || value === '' || value === null) return undefined
  if (Array.isArray(value) && value.length === 0) return undefined
  return value
}

/**
 * The dataset fields a chart spec refers to, wherever it does: what it groups
 * by, measures, lists and filters on. Read without regard to the shape of the
 * spec, so that a spec the builder cannot express is still answered for.
 */
export function fieldsUsed(spec: unknown): Set<string> {
  const used = new Set<string>()
  const walk = (value: unknown, under?: string) => {
    if (Array.isArray(value)) {
      // The columns of a detail table are written as the field alone when they have no label.
      for (const item of value) {
        if (under === 'columns' && typeof item === 'string') used.add(item)
        else walk(item)
      }
    } else if (value && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        if (key === 'field' && typeof inner === 'string') used.add(inner)
        else walk(inner, key)
      }
    }
  }
  walk(spec)
  return used
}

/** Changing what a value means also resets its chart-specific number format and conditional format. */
export function recomputed(state: Pick<BuilderState, 'measures' | 'formats' | 'style'>, index: number, compute: MeasureCompute | undefined): Pick<BuilderState, 'measures' | 'formats' | 'style'> {
  const measure = state.measures[index]!
  if (same(measure.compute, compute)) return state
  return { measures: state.measures.map((other, at) => at === index ? { ...other, compute } : other), ...withoutNumberSettings(state, measureName(measure)) }
}

/**
 * Fits the computations to the dimensions left: a percentage is no longer
 * grouped by one taken off, and a running total along one goes back to the
 * original value.
 */
export function pruneComputes(measures: PickedMeasure[], dimensions: string[]): PickedMeasure[] {
  return measures.map((measure) => {
    if (measure.compute?.type === 'percent_of_total' && measure.compute.within) return { ...measure, compute: { ...measure.compute, within: measure.compute.within.filter((name) => dimensions.includes(name)) } }
    if (measure.compute?.type !== 'cumulative' || dimensions.includes(measure.compute.along)) return measure
    const next = { ...measure }
    delete next.compute
    return next
  })
}


function editableCompute(compute: MeasureCompute, dimensions: string[]): boolean {
  if (compute.type === 'cumulative') return Object.keys(compute).every((key) => key === 'type' || key === 'along') && dimensions.includes(compute.along)
  if (compute.type === 'compare') return Object.keys(compute).every((key) => ['type', 'timeField', 'offset', 'output'].includes(key)) && typeof compute.timeField === 'string' && Boolean(compute.timeField) && Boolean(compute.offset) && Object.keys(compute.offset).every((key) => key === 'n' || key === 'unit') && Number.isInteger(compute.offset.n) && compute.offset.n >= 1 && compute.offset.n <= 1000 && grains.includes(compute.offset.unit) && ['value', 'delta', 'ratio'].includes(compute.output)
  if (compute.type !== 'percent_of_total' || Object.keys(compute).some((key) => key !== 'type' && key !== 'within')) return false
  return compute.within === undefined || (Array.isArray(compute.within) && compute.within.every((name, i, names) => dimensions.includes(name) && names.indexOf(name) === i))
}
