// What a viewer has chosen on a dashboard, as a share link carries it. See
// .agents/design/chart-dashboard.md 3.10.
import type { Cell } from '@supabi/charts'
import type { Chart, ParamControl, Schemas } from '../api/client'
import type { ChartSpec, Grain } from './builder'
import type { DynamicSelections } from './dynamics'
import type { ChartFilter, FilterControl, FilterOp, GlobalFilter } from './filters'
import { isParamFilter, type ParamFilter } from './paramFilters'
import { chartItems, isTabs, offeredTabs, shownTab, type BoardPage, type ChartHolder, type LayoutItem } from './layout'
import type { DashboardLink } from './links'
import { withStepTexts, type DrillPosition } from './drill'

export type ViewState = Schemas['DashboardViewState']

/** The choices a viewer makes on a widget. */
export interface WidgetChoices {
  useChartFilters: boolean
  chosen: Record<string, unknown>
  selections: DynamicSelections
  /** Where its chart is drilled down to. */
  drill?: DrillPosition
}

/** As much of a dashboard as its choices depend on. */
export interface ChoiceSpec {
  filters?: GlobalFilter[]
  links?: DashboardLink[]
  layout: { items: LayoutItem[]; pages?: BoardPage[] }
}

/** The viewer's choices on a dashboard. */
export interface Choices {
  values: Record<string, unknown>
  widgets: Record<string, WidgetChoices>
  links: Record<string, Cell>
  /** The tab chosen in each tab container, by its id. */
  tabs: Record<string, string>
  /** On a split dashboard, the page chosen. */
  page?: string
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

const chartOf = (item: ChartHolder, charts: Chart[]) => charts.find((chart) => chart.id === item.chartId)?.spec as unknown as ChartSpec | undefined
/** What the dataset says of the chart's parameter filters, as the server sends it with the chart. */
const paramsOf = (item: ChartHolder, charts: Chart[]) => charts.find((chart) => chart.id === item.chartId)?.params ?? {}

/** What a chart filter starts with: its own value, or for a parameter the default it follows. */
const startOf = (filter: ChartFilter | ParamFilter, params: Record<string, ParamControl>) => (isParamFilter(filter) ? params[filter.id]?.default : filter.value)

/** Whether a value can be given to a parameter as its control offers it: one or a list as it takes, from the dropdown when it has one. */
function fitsParam(filter: ParamFilter, info: ParamControl | undefined, value: unknown): boolean {
  if (!info) return false
  if (value === null) return !info.needsValue
  if (Array.isArray(value) !== Boolean(info.multi)) return false
  if (Array.isArray(value) && !value.length) return !info.needsValue
  if (filter.control?.type !== 'select') return true
  const offered = new Set((info.options ?? []).map((option) => JSON.stringify(option)))
  return (Array.isArray(value) ? value : [value]).every((item) => offered.has(JSON.stringify(item)))
}

/**
 * What a viewer has chosen that is not the dashboard's own: what a share link
 * carries. Empty when everything is as the dashboard shows it by default.
 */
export function chosenState(spec: ChoiceSpec, charts: Chart[], choices: Choices): ViewState {
  const state: ViewState = {}
  const filters = Object.fromEntries((spec.filters ?? []).filter((filter) => filter.id in choices.values && !same(choices.values[filter.id], filter.default)).map((filter) => [filter.id, choices.values[filter.id]]))
  if (Object.keys(filters).length) state.filters = filters
  const chartFilters: Record<string, Record<string, unknown>> = {}
  const selections: Record<string, Record<string, string>> = {}
  const drill: Record<string, Schemas['DrillState']> = {}
  const own: string[] = []
  for (const item of chartItems(spec.layout.items)) {
    const widget = choices.widgets[item.id]
    const chart = chartOf(item, charts)
    if (!widget || !chart) continue
    const params = paramsOf(item, charts)
    const changed = Object.fromEntries((chart.filters ?? []).filter((filter) => filter.control && filter.id in widget.chosen && !same(widget.chosen[filter.id], startOf(filter, params))).map((filter) => [filter.id, widget.chosen[filter.id]]))
    if (Object.keys(changed).length) chartFilters[item.id] = changed
    const picked = Object.fromEntries((chart.dynamics ?? []).filter((dynamic) => dynamic.id in widget.selections && widget.selections[dynamic.id] !== dynamic.options[0]?.id).map((dynamic) => [dynamic.id, widget.selections[dynamic.id]!]))
    if (Object.keys(picked).length) selections[item.id] = picked
    // A chart at its first level is as the dashboard shows it.
    if (chart.drill && widget.drill?.steps.length) drill[item.id] = { root: widget.drill.root, steps: widget.drill.steps.map((step) => ({ value: step.value, ...(step.text === undefined ? {} : { text: step.text }) })) }
    if (widget.useChartFilters) own.push(item.id)
  }
  if (Object.keys(chartFilters).length) state.chartFilters = chartFilters
  if (Object.keys(selections).length) state.selections = selections
  if (own.length) state.useChartFilters = own
  if (Object.keys(choices.links).length) state.links = choices.links
  if (Object.keys(drill).length) state.drill = drill
  // A tab container is carried only where it shows another tab than it opens on.
  const tabs = Object.fromEntries(spec.layout.items.filter(isTabs).flatMap((item) => {
    const shown = shownTab(item, offeredTabs(item), choices.tabs[item.id])
    return shown && shown.id !== shownTab(item, offeredTabs(item))?.id ? [[item.id, shown.id]] : []
  }))
  if (Object.keys(tabs).length) state.tabs = tabs
  // So is the page, where it is not the first.
  const pages = spec.layout.pages ?? []
  if (choices.page && pages.some((page) => page.id === choices.page) && choices.page !== pages[0]?.id) state.page = choices.page
  return state
}

/** Whether a value has the form a filter takes: a list for a list of values or a range, one value otherwise. */
function fits(op: FilterOp, control: FilterControl | undefined, value: unknown): boolean {
  if (value === null || op === 'time') return true
  if (['in', 'not_in', 'between', 'not_between'].includes(op) || control?.multi) return Array.isArray(value)
  return typeof value !== 'object'
}

/**
 * The shared choices the dashboard can still take, and whether any were left
 * out: the author may have removed or changed a filter, link or dynamic slot
 * since the link was shared, and the server refuses what it does not know.
 */
export function applicableState(state: ViewState, spec: ChoiceSpec, charts: Chart[]): { state: ViewState; dropped: boolean } {
  let dropped = false
  const keep = <T>(entries: [string, T][], ok: (entry: [string, T]) => boolean) => {
    const kept = entries.filter(ok)
    if (kept.length < entries.length) dropped = true
    return kept
  }
  // Only charts take choices.
  const items = new Map(chartItems(spec.layout.items).map((item) => [item.id, item]))
  const out: ViewState = {}
  const filters = keep(Object.entries(state.filters ?? {}), ([id, value]) => {
    const filter = spec.filters?.find((candidate) => candidate.id === id)
    return Boolean(filter) && fits(filter!.op, filter!.control, value)
  })
  if (filters.length) out.filters = Object.fromEntries(filters)
  const chartFilters = keep(Object.entries(state.chartFilters ?? {}), ([id]) => items.has(id)).flatMap(([id, values]) => {
    const chart = chartOf(items.get(id)!, charts)
    const params = paramsOf(items.get(id)!, charts)
    const kept = keep(Object.entries(values), ([filterId, value]) => {
      const filter = chart?.filters?.find((candidate) => candidate.id === filterId && candidate.control)
      if (!filter) return false
      return isParamFilter(filter) ? fitsParam(filter, params[filter.id], value) : fits(filter.op, filter.control, value)
    })
    return kept.length ? [[id, Object.fromEntries(kept)] as const] : []
  })
  if (chartFilters.length) out.chartFilters = Object.fromEntries(chartFilters)
  const selections = keep(Object.entries(state.selections ?? {}), ([id]) => items.has(id)).flatMap(([id, values]) => {
    const dynamics = chartOf(items.get(id)!, charts)?.dynamics ?? []
    const kept = keep(Object.entries(values), ([slot, option]) => {
      const dynamic = dynamics.find((candidate) => candidate.id === slot)
      return Boolean(dynamic) && (dynamic!.options.some((candidate) => candidate.id === option) || (option === '' && dynamic!.kind === 'dimension' && Boolean(dynamic!.allowEmpty)))
    })
    return kept.length ? [[id, Object.fromEntries(kept)] as const] : []
  })
  if (selections.length) out.selections = Object.fromEntries(selections)
  const own = (state.useChartFilters ?? []).filter((id) => items.has(id))
  if (own.length < (state.useChartFilters ?? []).length) dropped = true
  if (own.length) out.useChartFilters = own
  const links = keep(Object.entries(state.links ?? {}), ([id, value]) => Boolean(spec.links?.some((link) => link.id === id)) && (value === null || typeof value !== 'object'))
  if (links.length) out.links = Object.fromEntries(links) as Record<string, Cell>
  // A chart that no longer drills, or not that deep, opens at its first level. The values are not checked:
  // where a level reads another field now, the chart may show nothing, and the breadcrumb goes back.
  const drill = keep(Object.entries(state.drill ?? {}), ([id, position]) => {
    const levels = items.has(id) ? chartOf(items.get(id)!, charts)?.drill?.levels : undefined
    return Boolean(levels) && position.steps.length > 0 && position.steps.length <= levels!.length && position.steps.every((step) => step.value === null || typeof step.value !== 'object')
  })
  if (drill.length) out.drill = Object.fromEntries(drill)
  // A tab the container no longer has, or that no longer holds a chart, is not offered.
  const tabs = keep(Object.entries(state.tabs ?? {}), ([id, tab]) => spec.layout.items.some((item) => item.id === id && isTabs(item) && offeredTabs(item).some((entry) => entry.id === tab)))
  if (tabs.length) out.tabs = Object.fromEntries(tabs)
  if (state.page) {
    if (spec.layout.pages?.some((page) => page.id === state.page)) out.page = state.page
    else dropped = true
  }
  return { state: out, dropped }
}

/**
 * Shared choices as the dashboard keeps them while it is viewed. Values a
 * drill position brought without their texts are written as the charts write
 * them, which needs the dashboard and its charts.
 */
export function choicesOf(state: ViewState, spec?: ChoiceSpec, charts: Chart[] = []): Choices {
  const widgets: Record<string, WidgetChoices> = {}
  const widget = (id: string) => (widgets[id] ??= { useChartFilters: false, chosen: {}, selections: {} })
  for (const [id, values] of Object.entries(state.chartFilters ?? {})) widget(id).chosen = { ...values }
  for (const [id, values] of Object.entries(state.selections ?? {})) widget(id).selections = { ...values }
  for (const id of state.useChartFilters ?? []) widget(id).useChartFilters = true
  const items = spec ? chartItems(spec.layout.items) : []
  for (const [id, position] of Object.entries(state.drill ?? {})) {
    const restored = { root: position.root, steps: position.steps.map((step) => ({ value: step.value as Cell, ...(step.text === undefined ? {} : { text: step.text }) })) }
    const item = items.find((entry) => entry.id === id)
    const chart = item ? chartOf(item, charts) : undefined
    const first = (chart?.query.dimensions as { alias?: string; field?: string; grain?: Grain }[] | undefined)?.find((dimension) => (dimension.alias ?? dimension.field) === chart?.drill?.alias)
    widget(id).drill = chart?.drill ? withStepTexts(restored, chart.drill, first?.grain) : restored
  }
  return { values: { ...state.filters }, widgets, links: { ...(state.links as Record<string, Cell> | undefined) }, tabs: { ...state.tabs }, ...(state.page ? { page: state.page } : {}) }
}

/** Whether the state carries any choice at all. */
export const hasChoices = (state: ViewState) => Object.keys(state).length > 0
