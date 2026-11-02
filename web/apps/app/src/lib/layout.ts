// Dashboard layout helpers. Positions are in grid units and are what the
// dashboard spec stores; dragging and resizing are handled by the grid component.
import type { Frame, Padding } from './frame'

export const gridScale = 8
export const gridColumns = 12 * gridScale
export const defaultChartWidth = 6 * gridScale
export const defaultChartHeight = 4 * gridScale
export const maxItemHeight = 24 * gridScale

export interface GridSettings {
  columns: number
  rowHeight: number
  columnGap: number
  rowGap: number
  containerGap: number
  autoCompact: boolean
}

export const defaultGridSettings: GridSettings = { columns: gridColumns, rowHeight: 8, columnGap: 1.5, rowGap: 1.5, containerGap: 0, autoCompact: true }
export const gridSettingLimits = {
  columns: { min: 12, max: 192, step: 1 },
  rowHeight: { min: 4, max: 64, step: 0.5 },
  columnGap: { min: 0, max: 24, step: 0.5 },
  rowGap: { min: 0, max: 24, step: 0.5 },
  containerGap: { min: 0, max: 24, step: 1 },
} as const

export interface DashboardLayout {
  columns: number
  items: LayoutItem[]
  /** The pages the dashboard is split into, in the order they are shown; the first is shown when it is opened. Left out, it is not split. See .agents/design/chart-dashboard.md 3.13. */
  pages?: BoardPage[]
  grid?: Omit<GridSettings, 'columns'>
}

/** A page of a split dashboard: a grid of its own, under a tab of its name. Its id is unique among the widgets' and tabs'. */
export interface BoardPage { id: string; name: string }

export function readGridSettings(layout?: DashboardLayout): GridSettings {
  // Before grid settings existed the viewer always used 96 columns, including
  // legacy 12-column documents. Keep that appearance until explicitly changed.
  return { ...defaultGridSettings, ...layout?.grid, columns: layout?.grid ? layout.columns : gridColumns }
}

export function gridMinWidth(columns: number): number { return Math.ceil(columns / 6) }

/** Scale shared boundaries together to retain side-by-side alignment. */
export function changeGridColumns<T extends QueryContainerLayout>(items: T[], before: number, after: number): T[] {
  return items.map((item) => {
    const left = Math.round(item.x * after / before)
    const right = Math.round((item.x + item.w) * after / before)
    const w = Math.min(after, Math.max(gridMinWidth(after), right - left))
    return { ...item, x: Math.min(left, after - w), w }
  })
}

/** What a chart dragged towards a dashboard carries: its id. */
export const chartDragType = 'application/x-supabi-chart'
/** What an empty chart box dragged from the chart library carries instead of a chart's id. */
export const emptyChartDrop = 'empty'
/** Carried beside it, so that while it is dragged it is known to be one, and no chart widget takes it. */
export const emptyChartDragType = 'application/x-supabi-empty-chart'

interface ItemPlace {
  id: string
  x: number
  y: number
  w: number
  h: number
  /** How its box looks; see .agents/design/chart-dashboard.md 3.14. */
  frame?: Frame
  /** On a split dashboard, the page it is on. Left out, it is above the tabs, on every page. */
  page?: string
}

/**
 * What holds a chart: a chart widget, or a tab of a tab container. Filters,
 * links and data requests name it by its id. Without a chart it is empty,
 * laid out before its chart is chosen.
 */
export interface ChartHolder {
  id: string
  chartId?: string
  /** The name it goes by on this dashboard, instead of the chart's own. */
  title?: string
  /** A remark shown when its question mark is pointed at. */
  note?: string
}

/** A box for a chart. */
export interface ChartItem extends ItemPlace, ChartHolder {
  type: 'chart'
  /** Viewed, it shows no header with the chart's name. */
  hideHeader?: boolean
}

/** A tab of a tab container: a chart widget with no place or frame of its own. */
export type ChartTab = ChartHolder

/** A box that switches between charts, one in each tab; the first is shown first. See .agents/design/chart-dashboard.md 3.15. */
export interface TabsItem extends ItemPlace {
  type: 'tabs'
  tabs: ChartTab[]
  /** The tab shown when the dashboard is opened. Left out, the first is; so it is left out when it is the first. */
  defaultTab?: string
}

/** A chart widget or tab with its chart chosen: the only things that query anything. */
export type HeldChart = ChartHolder & { chartId: string }

/** Where a title and its subtitle sit in the widget. Each left out is the default: left, in the middle. */
export interface TitleStyle {
  align?: 'left' | 'center' | 'right'
  verticalAlign?: 'top' | 'middle' | 'bottom'
}

/** The dashboard's own name and description, or a title of its own. */
export interface TitleItem extends ItemPlace {
  type: 'title'
  useDashboardName?: boolean
  title?: string
  subtitle?: string
  style?: TitleStyle
}

/** Notes in Markdown, written by the author. */
export interface TextItem extends ItemPlace {
  type: 'text'
  markdown?: string
}

/** A widget. Only charts query anything; see .agents/design/chart-dashboard.md 3.12, 3.14 and 3.15. */
export type LayoutItem = ChartItem | TitleItem | TextItem | TabsItem

/** Whether the widget is a box for a chart, with or without one. */
export const isChart = (item: LayoutItem): item is ChartItem => item.type === 'chart'
export const holdsChart = (item: LayoutItem): item is ChartItem & HeldChart => item.type === 'chart' && Boolean(item.chartId)
export const isTabs = (item: LayoutItem): item is TabsItem => item.type === 'tabs'
/** What holds charts, held or not: the chart widgets, and the tabs of tab containers in their place. */
export const chartHolders = (items: LayoutItem[]): ChartHolder[] => items.flatMap((item) => item.type === 'chart' ? [item] : item.type === 'tabs' ? item.tabs : [])
/** The chart widgets and tabs with a chart in them, which are all that query, filter and link. */
export const chartItems = (items: LayoutItem[]): HeldChart[] => chartHolders(items).filter((holder): holder is HeldChart => Boolean(holder.chartId))

/** The tabs least and most a tab container has. With one left it is a chart widget again. */
export const tabLimits = { min: 2, max: 20 } as const

/** Changes one chart widget or tab, wherever it is. The change is given all of it, a chart widget's place too, and returns all of it. */
export function updateHolder(items: LayoutItem[], id: string, change: (holder: ChartHolder) => ChartHolder): LayoutItem[] {
  return items.map((item) => {
    if (item.type === 'chart') return item.id === id ? change(item) as ChartItem : item
    if (item.type === 'tabs' && item.tabs.some((tab) => tab.id === id)) return { ...item, tabs: item.tabs.map((tab) => tab.id === id ? change(tab) : tab) }
    return item
  })
}

/**
 * A chart widget made a tab container, with the given id: its chart goes in
 * the first tab, keeping the widget's id and with it the filters and links
 * mapped to it, its name and its note; then an empty tab. The box keeps its
 * place and frame. Its header is the tabs now, so it cannot be hidden.
 */
export function intoTabs(item: ChartItem, id: string, tabId: string): TabsItem {
  const { id: chartWidget, chartId, title, note, x, y, w, h, frame } = item
  const first: ChartTab = { id: chartWidget, ...(chartId ? { chartId } : {}), ...(title ? { title } : {}), ...(note ? { note } : {}) }
  return { id, type: 'tabs', x, y, w, h, ...(frame ? { frame } : {}), tabs: [first, { id: tabId }] }
}

/** The tabs a reader is offered: those with a chart. */
export const offeredTabs = (item: TabsItem): ChartTab[] => item.tabs.filter((tab) => tab.chartId)

/** The tab a tab container shows among those given: the one chosen, while it is among them; else its default, while that is; else the first. */
export function shownTab(item: TabsItem, tabs: ChartTab[], chosen?: string): ChartTab | undefined {
  return tabs.find((tab) => tab.id === chosen) ?? tabs.find((tab) => tab.id === item.defaultTab) ?? tabs[0]
}

/** The tab a tab container shows when the dashboard is opened. */
export const defaultTabOf = (item: TabsItem): ChartTab => item.tabs.find((tab) => tab.id === item.defaultTab) ?? item.tabs[0]!

/** A tab container with the given tabs, the given one of them shown first: written down only when it is not the first. */
function arranged(item: TabsItem, tabs: ChartTab[], shownFirst: string): TabsItem {
  const next: TabsItem = { ...item, tabs }
  delete next.defaultTab
  if (shownFirst !== tabs[0]?.id && tabs.some((tab) => tab.id === shownFirst)) next.defaultTab = shownFirst
  return next
}

/** A tab container that shows the given tab when the dashboard is opened. */
export const withDefaultTab = (item: TabsItem, tabId: string): TabsItem => arranged(item, item.tabs, tabId)

/** A tab container with another tab, at the given place among its tabs. The tab shown first stays the same. */
export function insertTab(item: TabsItem, tab: ChartTab, at: number): TabsItem {
  const tabs = [...item.tabs]
  tabs.splice(Math.max(0, Math.min(at, tabs.length)), 0, tab)
  return arranged(item, tabs, defaultTabOf(item).id)
}

/**
 * What a tab container's tabs are marked with while a chart is dragged over
 * them, for the grid to hand back when it is dropped there: the container
 * and the place among its tabs the chart goes in as a new tab. Ids are
 * letters, digits and underscores, so the colons part them.
 */
export const tabsDropTarget = (id: string, at: number) => `tabs:${id}:${at}`
export function readTabsDropTarget(target: string): { id: string; at: number } | undefined {
  const match = /^tabs:([^:]+):(\d+)$/.exec(target)
  return match ? { id: match[1]!, at: Number(match[2]) } : undefined
}

/** A tab container with one of its tabs moved to the given place among them. The tab shown first stays the same. */
export function moveTab(item: TabsItem, tabId: string, to: number): TabsItem {
  const tabs = item.tabs.filter((tab) => tab.id !== tabId)
  const moved = item.tabs.find((tab) => tab.id === tabId)
  if (!moved) return item
  tabs.splice(Math.max(0, Math.min(to, tabs.length)), 0, moved)
  return arranged(item, tabs, defaultTabOf(item).id)
}

/**
 * A tab container without one of its tabs. The tab shown first stays the
 * same, unless it is the one taken out: then the first is. With one left it
 * is a chart widget again, by that tab's id.
 */
export function withoutTab(item: TabsItem, tabId: string): TabsItem | ChartItem {
  const tabs = item.tabs.filter((tab) => tab.id !== tabId)
  if (tabs.length >= tabLimits.min) return arranged(item, tabs, defaultTabOf(item).id)
  const { x, y, w, h, frame } = item
  return { ...tabs[0]!, type: 'chart', x, y, w, h, ...(frame ? { frame } : {}) }
}

/** Default heights of titles and text, and the least either can be: a line of each. */
export const titleHeight = 8
export const textHeight = 16
export const noteMinHeight = 4
/** Titles and text, which may be shorter than charts. */
const isNote = (item: { type: LayoutItem['type'] }) => item.type === 'title' || item.type === 'text'
/** The least height an item can be given. */
export const minItemHeight = (item: { type: LayoutItem['type'] }) => isNote(item) ? noteMinHeight : 2 * gridScale
/** The longest titles, subtitles, text, and a chart widget's name and note may be, in characters, as the server checks. */
export const noteLimits = { title: 200, subtitle: 500, markdown: 20000, note: 500 } as const

/** An id not used by any item or tab, for a newly added widget or tab. */
export function newItemId(items: { id: string; tabs?: { id: string }[] }[]): string {
  const taken = new Set(items.flatMap((item) => [item.id, ...(item.tabs ?? []).map((tab) => tab.id)]))
  for (let n = items.length + 1; ; n++) {
    if (!taken.has(`w${n}`)) return `w${n}`
  }
}

/** Where a new widget goes: on a row of its own below everything else. Without a chart it is an empty box. */
export function place(items: { id: string; y: number; h: number }[], chartId: string | undefined, w = defaultChartWidth, h = defaultChartHeight, containerGap = 0): ChartItem {
  return { id: newItemId(items), type: 'chart', ...(chartId ? { chartId } : {}), x: 0, y: below(items, containerGap), w, h }
}

/** The first row below every item. */
export function below(items: { y: number; h: number }[], containerGap = 0): number {
  const bottom = items.reduce((max, item) => Math.max(max, item.y + item.h), 0)
  return bottom + (items.length ? containerGap : 0)
}

/** Puts an item on the top rows, moving everything else down to make room. */
export function insertAtTop<T extends { y: number }>(items: T[], item: T & { h: number }, containerGap = 0): T[] {
  const shift = item.h + (items.length ? containerGap : 0)
  return [{ ...item, y: 0 }, ...items.map((entry) => ({ ...entry, y: entry.y + shift }))]
}

/** Stored separately from chart items so data and field mappings remain chart-only. */
export interface QueryContainerLayout { x: number; y: number; w: number; h: number; frame?: Frame }

/** The room the query container's frame leaves around its controls, top and bottom with its edges, for its height to fit them. */
const queryPadding: Record<Padding, number> = { compact: 18, normal: 26, comfortable: 38 }
export type QueryHeightMode = 'auto' | 'manual'
export interface QueryContainerItem extends QueryContainerLayout { autoHeight: boolean; id: string; type: 'query'; /** It is always above the tabs of a split dashboard. */ keepInGrid: true; minH: number; maxH: number; minContentSelector: string; contentPadding: number }
/** A widget as the grid places it: titles and text may be shorter than charts. */
export type WidgetGridItem = LayoutItem & { minH?: number }
export type DashboardGridItem = WidgetGridItem | QueryContainerItem

export function dashboardGrid(items: LayoutItem[], hasFilters: boolean, container?: QueryContainerLayout, heightMode: QueryHeightMode = 'auto', columns = gridColumns, containerGap = 0): DashboardGridItem[] {
  const widgets: WidgetGridItem[] = items.map((item) => isNote(item) ? { ...item, minH: noteMinHeight } : item)
  if (!hasFilters) return widgets
  // Old dashboards had a strip above the canvas. Reserve its space without modifying saved charts.
  const layout = container ?? { x: 0, y: 0, w: columns, h: gridScale }
  let id = 'query-container'
  while (items.some((item) => item.id === id)) id += '-container'
  return [{ id, type: 'query', ...layout, autoHeight: heightMode === 'auto', keepInGrid: true, minH: 6, maxH: maxItemHeight, minContentSelector: '.dashboard-filters', contentPadding: queryPadding[layout.frame?.padding ?? 'normal'] }, ...widgets.map((item) => container ? item : { ...item, y: item.y + layout.h + containerGap })]
}

export function splitDashboardGrid(items: DashboardGridItem[]): { items: LayoutItem[]; queryContainer?: QueryContainerLayout } {
  const query = items.find((item) => item.type === 'query')
  // What only the grid needs is not part of the dashboard.
  const widgets = items.filter((item): item is WidgetGridItem => item.type !== 'query').map((item) => {
    const widget = { ...item }
    delete widget.minH
    return widget as LayoutItem
  })
  return { items: widgets, queryContainer: query ? { x: query.x, y: query.y, w: query.w, h: query.h, ...(query.frame ? { frame: query.frame } : {}) } : undefined }
}

/** The pages least and most a split dashboard has, and the longest a page's name may be. With one page left it is not split. */
export const pageLimits = { min: 2, max: 20, name: 50 } as const

/** The widgets on a page, in the order the dashboard keeps them; without a page, those above the tabs. */
export const onPage = <T extends { page?: string }>(items: T[], page: string | undefined): T[] => items.filter((item) => item.page === page)

/**
 * The widgets with those on a page, or above the tabs, given anew, in the
 * order given and where the first of them was among the others. What is
 * given is put on that page. Not split, it is the widgets given.
 */
export function replaceOnPage(items: LayoutItem[], page: string | undefined, next: LayoutItem[]): LayoutItem[] {
  const first = items.findIndex((item) => item.page === page)
  const others = items.filter((item) => item.page !== page)
  const at = first < 0 ? others.length : items.slice(0, first).filter((item) => item.page !== page).length
  return [...others.slice(0, at), ...next.map((item) => onto(item, page)), ...others.slice(at)]
}

/** The widget put on a page, or above the tabs. */
function onto<T extends LayoutItem>(item: T, page: string | undefined): T {
  const next = { ...item, ...(page ? { page } : {}) }
  if (!page) delete next.page
  return next
}

/** What holds charts, held or not: chart widgets and tab containers, by whose top what is above them all is told. */
const holdsCharts = (item: { type: string }) => item.type === 'chart' || item.type === 'tabs'

/**
 * A dashboard split into two pages. Titles and text above every chart and
 * tab container, and the query container, go above the tabs; the rest is
 * the first page, moved up to its top; the second page is empty. Given the
 * grid as the editor lays it out, with the query container in it.
 */
export function splitIntoPages(grid: DashboardGridItem[], pages: [BoardPage, BoardPage], containerGap = 0): DashboardGridItem[] {
  const top = Math.min(...grid.filter(holdsCharts).map((item) => item.y))
  const above = (item: DashboardGridItem) => item.type !== 'query' && !holdsCharts(item) && item.y + item.h <= top
  const query = grid.find((item) => item.type === 'query')
  const shared = grid.filter(above)
  const rest = grid.filter((item) => !above(item) && item.type !== 'query')
  const lift = rest.length ? Math.min(...rest.map((item) => item.y)) : 0
  // The query container keeps its place when it is above the charts too, and otherwise goes below the rest above them.
  const container = query && (query.y + query.h <= top ? query : { ...query, y: below(shared, containerGap) })
  return [...(container ? [container] : []), ...shared, ...rest.map((item) => ({ ...item, y: item.y - lift, page: pages[0].id }))]
}

/**
 * A split dashboard no longer split: what was above the tabs stays on top,
 * and the widgets of the one page left follow below them. What is on other
 * pages is taken out.
 */
export function joinPages(items: LayoutItem[], page: string, container?: QueryContainerLayout, containerGap = 0): LayoutItem[] {
  const shared = onPage(items, undefined)
  const room = below([...shared, ...(container ? [container] : [])], containerGap)
  return [...shared, ...onPage(items, page).map((item) => ({ ...onto(item, undefined), y: item.y + room }))]
}

/** A widget moved to another page, or above the tabs: below everything there, as wide and high as it was. */
export function moveToPage(items: LayoutItem[], id: string, page: string | undefined, containerGap = 0, container?: QueryContainerLayout): LayoutItem[] {
  const there = [...onPage(items, page), ...(page === undefined && container ? [container] : [])]
  return items.map((item) => item.id === id ? { ...onto(item, page), x: 0, y: below(there, containerGap) } : item)
}

/** The name a new page is given: the first "Page N" not yet taken, as nameOf says it. */
export function newPageName(pages: BoardPage[], nameOf: (n: number) => string): string {
  for (let n = 1; ; n++) {
    if (!pages.some((page) => page.name === nameOf(n))) return nameOf(n)
  }
}

/** The page shown: the one chosen, while the dashboard has it; otherwise the first. */
export const shownPage = (pages: BoardPage[] | undefined, chosen?: string): BoardPage | undefined => pages?.find((page) => page.id === chosen) ?? pages?.[0]

/**
 * The widgets with the room the query container takes given back, for when
 * it is not shown: those below it move up together, by its height and the
 * gap after it, but no higher than it was, unless something else is beside it.
 */
export function closeUp<T extends { y: number; h: number }>(items: T[], container: QueryContainerLayout | undefined, containerGap = 0): T[] {
  if (!container) return items
  const bottom = container.y + container.h
  if (items.some((item) => item.y < bottom && item.y + item.h > container.y)) return items
  const below = items.filter((item) => item.y >= bottom)
  if (!below.length) return items
  // All by the same rows, so that none comes to overlap another.
  const room = Math.min(container.h + containerGap, Math.min(...below.map((item) => item.y)) - container.y)
  return items.map((item) => item.y >= bottom ? { ...item, y: item.y - room } : item)
}
