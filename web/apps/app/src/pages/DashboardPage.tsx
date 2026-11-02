import { applyFormats, type Cell, type QueryResult as ChartResult, type Viz } from '@supabi/charts'
import { Alert, Button, Checkbox, Dialog, Field, GridGroup, GridLayout, Input, Menu, Segmented, Select, TextArea, Tooltip, type ColorScheme, type GridMove, type MenuItem } from '@supabi/ui'
import { Fragment, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode, type SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { ApiError, api, unwrap, type Chart, type ChartSummary, type Dashboard } from '../api/client'
import type { DatasetSpec } from '../api/spec'
import { toApiError, useAsync, type AsyncState } from '../api/useAsync'
import { useFirstWeekDays, useSession } from '../auth/session'
import { useSessionActions } from '../auth/useSessionActions'
import { Async } from '../components/Async'
import { ChartView, namedColumns } from '../components/ChartView'
import { ChartExportDialog } from '../components/Exports'
import { ResultRows } from '../components/ResultRows'
import { RevisionList } from '../components/RevisionList'
import { DynamicControls } from '../components/DynamicControls'
import { ChartFilterBar, FilterStyleSettings } from '../components/ChartFilterBar'
import { resolveDynamicSpec } from '../lib/dynamics'
import { drillDown, drilledInto, drillPath } from '../lib/drill'
import { DrillCrumbs } from '../components/DrillCrumbs'
import type { ClickActions } from '../components/ChartView'
import { ErrorAlert, useErrorText } from '../components/ErrorAlert'
import { FilterControl, FilterLabel, filterCaption } from '../components/FilterControl'
import { ParamFilterControl } from '../components/ParamFilterControl'
import { GridSettingsFields, gridSettingsInput, parseGridSettings, type GridSettingsInput } from '../components/GridSettingsFields'
import { DashboardGrantsDialog } from '../components/DashboardGrantsDialog'
import { DashboardLinksDialog, DashboardLinkChips, useLinkValueText } from '../components/DashboardLinksDialog'
import { pruneLinks, useDashboardLinks, type DashboardLink, type DashboardLinksState } from '../lib/links'
import { GlobalFiltersDialog } from '../components/GlobalFiltersDialog'
import { Icon, type IconName } from '../components/Icon'
import type { ChartSpec } from '../lib/builder'
import { ancestorsKey, useCascadeChange } from '../lib/cascade'
import type { FilterStyle } from '../lib/filterStyle'
import { filterFields, filtersShownWith, pruneGlobal, takenByAll, type ChartFilter, type GlobalFilter } from '../lib/filters'
import { isFieldFilter, isParamFilter } from '../lib/paramFilters'
import { clockTime, fetchedAgo, freshLoads, freshLoadsBy } from '../lib/freshness'
import { chartDragType, emptyChartDragType, emptyChartDrop, gridScale, defaultChartHeight, defaultGridSettings, readGridSettings, changeGridColumns, gridMinWidth, type GridSettings, type DashboardLayout, maxItemHeight, newItemId, place, dashboardGrid, splitDashboardGrid, type QueryContainerLayout, type QueryHeightMode, type LayoutItem, type ChartItem, type ChartHolder, type ChartTab, type TabsItem, type TitleItem, type TitleStyle, type TextItem, chartItems, chartHolders, holdsChart, isChart, isTabs, updateHolder, intoTabs, withoutTab, offeredTabs, shownTab, defaultTabOf, withDefaultTab, moveTab, insertTab, tabsDropTarget, readTabsDropTarget, tabLimits, below, insertAtTop, titleHeight, textHeight, minItemHeight, noteLimits, onPage, replaceOnPage, splitIntoPages, joinPages, moveToPage, newPageName, shownPage, closeUp, pageLimits, type BoardPage, type DashboardGridItem } from '../lib/layout'
import { frameLook, frameOf, keptFrame, type Frame } from '../lib/frame'
import { FrameSettings } from '../components/FrameSettings'
import { renderMarkdown } from '../lib/markdown'
import { useHistory } from '../lib/useHistory'
import { usePageTitle } from '../lib/documentTitle'
import { useFullscreen } from '../lib/fullscreen'
import { ScrollArea, useArea, useNearby } from '../lib/nearby'
import { applicableState, choicesOf, chosenState, type Choices, type ViewState, type WidgetChoices } from '../lib/dashboardView'
import { ShareDashboardDialog } from '../components/ShareDashboardDialog'
import { autoRefreshIntervals, autoRefreshLabel, refreshMaxAge, useAutoRefresh } from '../lib/autoRefresh'
import { ChartPalette } from '../workbench/ChartPalette'
import { useWorkbench } from '../workbench/context'
import { UnsavedGuard, afterSave } from '../workbench/slots'
import { SaveConflict, useSaveConflict } from '../components/SaveConflict'
import type { SaveContent } from '../lib/saveConflict'

type QueryMode = 'auto' | 'manual'

interface DashboardSpec {
  links?: DashboardLink[]
  specVersion: 1
  layout: DashboardLayout
  filters?: GlobalFilter[]
  filterStyle?: FilterStyle
  queryMode?: QueryMode
  queryHeightMode?: QueryHeightMode
  queryContainer?: QueryContainerLayout
  /** Seconds between timed refreshes of the viewed dashboard; absent, it is not refreshed on a timer. */
  autoRefresh?: number
  /** How chart and text widgets look unless they say otherwise. */
  frame?: Frame
}

interface DashboardDraft {
  links: DashboardLink[]
  grid: GridSettings
  name: string
  description: string
  items: LayoutItem[]
  /** The pages the dashboard is split into; left out, it is not. */
  pages?: BoardPage[]
  filters: GlobalFilter[]
  filterStyle?: FilterStyle
  queryMode?: QueryMode
  queryHeightMode?: QueryHeightMode
  queryContainer?: QueryContainerLayout
  autoRefresh?: number
  frame?: Frame
}

interface DashboardPreview {
  spec: DashboardSpec
}

function dashboardDraft(value?: Pick<Dashboard, 'name' | 'description' | 'spec'>): DashboardDraft {
  const spec = value?.spec as DashboardSpec | undefined
  return { links: spec?.links ?? [], grid: readGridSettings(spec?.layout), name: value?.name ?? '', description: value?.description ?? '', items: spec?.layout.items ?? [], ...(spec?.layout.pages ? { pages: spec.layout.pages } : {}), filters: spec?.filters ?? [], queryContainer: spec?.queryContainer, filterStyle: spec?.filterStyle, queryMode: spec?.queryMode, queryHeightMode: spec?.queryHeightMode, autoRefresh: spec?.autoRefresh, frame: spec?.frame }
}

function dashboardDefinition(draft: DashboardDraft, keepGrid: boolean): DashboardSpec {
  const { links, items, pages, filters, queryMode, queryHeightMode, filterStyle, queryContainer, grid, autoRefresh, frame } = draft
  const { columns, ...gridOptions } = grid
  // Filters and links go by chart widgets and tabs, wherever these are.
  const holders = chartHolders(items)
  const kept = pruneGlobal(filters, holders)
  return { specVersion: 1, ...(autoRefresh ? { autoRefresh } : {}), ...(frame ? { frame } : {}), ...(links.length ? { links: pruneLinks(links, holders) } : {}), layout: { columns, items, ...(pages ? { pages } : {}), ...(keepGrid || JSON.stringify(grid) !== JSON.stringify(defaultGridSettings) ? { grid: gridOptions } : {}) }, ...(kept.length ? { filters: kept, ...(queryMode ? { queryMode } : {}), ...(queryHeightMode ? { queryHeightMode } : {}), ...(filterStyle ? { filterStyle } : {}), ...(queryContainer ? { queryContainer } : {}) } : {}) }
}

function comparableDashboard(board: Dashboard): Dashboard {
  return { ...board, spec: dashboardDefinition(dashboardDraft(board), Boolean((board.spec as unknown as DashboardSpec).layout.grid)) as unknown as Record<string, unknown> }
}

/** Renaming is one edit, committed on Enter or blur, and cancelled on Escape. */
function DashboardName({ value, disabled, onChange }: { value: string; disabled: boolean; onChange: (name: string) => void }) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const commit = () => { if (draft.trim()) onChange(draft.trim()); setEditing(false) }
  return <div className="dashboard-editor-title">
    {editing ? <input autoFocus aria-label={t('dashboard.dashboardName')} value={draft} disabled={disabled} onChange={(event) => setDraft(event.target.value)} onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); if (!event.nativeEvent.isComposing) commit() }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setEditing(false) }
      }} /> : <strong title={value || t('dashboard.new')}>{value || t('dashboard.new')}</strong>}
    <Tooltip title={t('dashboard.rename')}><Button size="sm" variant="ghost" disabled={disabled} icon={<Icon name="edit" size={14} />} aria-label={t('dashboard.rename')} onClick={() => { setDraft(value); setEditing(true) }} /></Tooltip>
  </div>
}

/** What a widget's data depends on besides its own chart. */
interface Conditions {
  /** The dashboard's global filters, and what the viewer chose in each. */
  filters: GlobalFilter[]
  values: Record<string, unknown>
}

type WidgetFilters = WidgetChoices
const emptyWidgetFilters: WidgetFilters = { useChartFilters: false, chosen: {}, selections: {} }

/** Temporary choices survive switching modes, but never become saved defaults. */
function useDashboardFilters(filters: GlobalFilter[], items: ChartHolder[], charts: Chart[], mode: QueryMode = 'auto', initial?: Pick<Choices, 'values' | 'widgets'>) {
  const globalKeys = Object.fromEntries(filters.map((filter) => [filter.id, JSON.stringify({ ...filter, label: undefined,
    charts: filter.targets.map((target) => items.find((item) => item.id === target.item)?.chartId),
  })]))
  const widgetKeys = Object.fromEntries(items.map((item) => [item.id, JSON.stringify({ chart: item.chartId,
    filters: (charts.find((chart) => chart.id === item.chartId)?.spec as unknown as ChartSpec | undefined)?.filters,
    dynamics: (charts.find((chart) => chart.id === item.chartId)?.spec as unknown as ChartSpec | undefined)?.dynamics,
    drill: (charts.find((chart) => chart.id === item.chartId)?.spec as unknown as ChartSpec | undefined)?.drill,
    globals: filters.filter((filter) => filter.targets.some((target) => target.item === item.id)).map((filter) => globalKeys[filter.id]),
  })]))
  const [resetKey, setResetKey] = useState(0)
  const key = JSON.stringify([globalKeys, widgetKeys, mode])
  // Choices a share link carries are where the viewer starts; they are applied, even in manual mode.
  const [stored, setStored] = useState({ key, globalKeys, widgetKeys, values: initial?.values ?? {}, draftValues: initial?.values ?? {}, widgets: initial?.widgets ?? ({} as Record<string, WidgetFilters>) })
  let current = stored
  if (stored.key !== key) {
    // Reconcile before children query: deleted IDs and values for an old field must not reach the API.
    current = { key, globalKeys, widgetKeys,
      draftValues: Object.fromEntries(Object.entries(stored.draftValues).filter(([id]) => globalKeys[id] !== undefined && globalKeys[id] === stored.globalKeys[id])),
      values: Object.fromEntries(Object.entries(mode === 'auto' ? stored.draftValues : stored.values).filter(([id]) => globalKeys[id] !== undefined && globalKeys[id] === stored.globalKeys[id])),
      widgets: Object.fromEntries(Object.entries(stored.widgets).filter(([id]) => widgetKeys[id] !== undefined && widgetKeys[id] === stored.widgetKeys[id])),
    }
    setStored(current)
  }
  return {
    // Remount controls to discard invalid text, debounced edits and pending cascade lookups.
    resetKey,
    reset: () => {
      setResetKey((key) => key + 1)
      // Every chart goes back to its first level, as every link is let go.
      const undrilled = (widgets: Record<string, WidgetFilters>) => Object.fromEntries(Object.entries(widgets).map(([id, widget]) => {
        const rest = { ...widget }
        delete rest.drill
        return [id, rest]
      }))
      setStored((current) => ({ ...current, draftValues: {}, widgets: undrilled(current.widgets), ...(mode === 'auto' ? { values: {} } : {}) }))
    },
    values: current.values,
    draftValues: current.draftValues,
    mode,
    hasPending: filters.some((filter) => JSON.stringify(filter.id in current.draftValues ? current.draftValues[filter.id] : filter.default) !== JSON.stringify(filter.id in current.values ? current.values[filter.id] : filter.default)),
    apply: () => setStored((current) => current.key !== key ? current : { ...current, values: current.draftValues }),
    widgets: current.widgets,
    globalKeys,
    widgetKeys,
    setValues: (values: Record<string, unknown>) => setStored((current) => current.key !== key ? current : { ...current, draftValues: values, ...(mode === 'auto' ? { values } : {}) }),
    setWidget: (id: string, patch: Partial<WidgetFilters> | ((current: WidgetFilters) => Partial<WidgetFilters>)) => setStored((current) => {
      if (current.widgetKeys[id] !== widgetKeys[id]) return current
      const widget = current.widgets[id] ?? emptyWidgetFilters
      return { ...current, widgets: { ...current.widgets, [id]: { ...widget, ...(typeof patch === 'function' ? patch(widget) : patch) } } }
    }),
  }
}
type DashboardFiltersState = ReturnType<typeof useDashboardFilters>

function linkContext(link: DashboardLink, interaction: DashboardFiltersState, filters: GlobalFilter[], items: ChartHolder[], charts: Chart[]) {
  const source = items.find((item) => item.id === link.source.item)
  return [interaction.resetKey, interaction.widgets[link.source.item],
    charts.find((chart) => chart.id === source?.chartId),
    link.targets.map((target) => charts.find((chart) => chart.id === items.find((item) => item.id === target.item)?.chartId)),
    filters.filter((filter) => filter.targets.some((target) => target.item === link.source.item)).map((filter) => [filter, filter.id in interaction.values ? interaction.values[filter.id] : filter.default]),
  ]
}

/**
 * The global filters' controls. All of them take part in cascades and
 * queries; shown says which have a control here, as on a page of a split
 * dashboard, where the others keep their values out of sight.
 */
/** The IDs of the parameter filters of the chart a widget shows, whose values shape the lists drawn from it. */
const paramFiltersOf = (widgets: ChartHolder[], charts: Chart[]) => (itemId: string) => {
  const chart = charts.find((candidate) => candidate.id === widgets.find((widget) => widget.id === itemId)?.chartId)
  return ((chart?.spec as unknown as ChartSpec | undefined)?.filters ?? []).filter(isParamFilter).map((filter) => filter.id)
}

function DashboardFilters({ filters, shown = filters, interaction, dashboardId, preview, style, linking, refreshToken = 0, paramsOf }: { linking: DashboardLinksState; style?: FilterStyle; filters: GlobalFilter[]; shown?: GlobalFilter[]; interaction: DashboardFiltersState; dashboardId?: string; preview?: DashboardPreview; refreshToken?: number; paramsOf: (itemId: string) => string[] }) {
  const { t } = useTranslation()
  // After the board is refreshed, each list is asked for afresh once.
  const refreshKey = String(refreshToken)
  const [freshOptions] = useState(() => freshLoadsBy(refreshKey))
  const sourceOf = (filter: GlobalFilter) => filter.optionsFrom ?? filter.targets[0]?.item
  // A list is drawn from its source chart as the viewer has set its dynamic choices and parameters there.
  const selectionContext = filters.map((filter) => {
    const source = sourceOf(filter)
    const widget = source ? interaction.widgets[source] : undefined
    return [source, widget?.selections ?? {}, source ? paramsOf(source).map((id) => widget?.chosen[id]) : []]
  })
  const definitionsKey = JSON.stringify([interaction.globalKeys, selectionContext, interaction.mode, linking.values])
  const options = (filterId: string, values: Record<string, unknown>, search = '', related = false) => {
    const filter = filters.find((entry) => entry.id === filterId)!
    const source = sourceOf(filter)
    const widget = source ? interaction.widgets[source] : undefined
    const asked = { links: linking.values, filters: values, selections: widget?.selections ?? {}, chartFilters: widget?.chosen ?? {}, search, related }
    const body = { ...asked, ...(freshOptions(filterId, refreshKey, JSON.stringify(asked)) ? { refresh: true } : {}) }
    return preview
      ? unwrap(api.POST('/dashboards/preview/filters/{filterId}/options', { params: { path: { filterId } }, body: { ...preview, spec: preview.spec as unknown as Record<string, unknown>, ...body } }))
      : unwrap(api.POST('/dashboards/{id}/filters/{filterId}/options', { params: { path: { id: dashboardId!, filterId } }, body }))
  }
  const valueOf = (filter: GlobalFilter) => filter.id in interaction.draftValues ? interaction.draftValues[filter.id] : filter.default
  const cascade = useCascadeChange({
    filters,
    values: interaction.draftValues,
    commit: interaction.setValues,
    load: (parent, values) => options(parent.id, values, '', true),
    context: definitionsKey,
  })
  // A global list is drawn from its source chart, narrowed only by its ancestors.
  const optionsKeyOf = (filter: GlobalFilter) => {
    const source = sourceOf(filter)
    return JSON.stringify([interaction.globalKeys[filter.id], linking.values, refreshKey, source ? interaction.widgets[source]?.selections : undefined, ancestorsKey(filters, filter.id, valueOf)])
  }
  const [invalid, setInvalid] = useState<Record<string, string>>({})
  // A control out of sight holds no text being typed: what it had entered is its value.
  const hasInvalid = shown.some((filter) => invalid[filter.id] === interaction.globalKeys[filter.id])
  if (!shown.length) return null
  return <ChartFilterBar className="dashboard-filters" style={style}>
    {shown.map((filter) => <div key={filter.id} className={`widget-filter global-filter${filter.control.type === 'tiles' ? ' tiled' : ''}`}>
      <span className="note small"><FilterLabel label={filter.label} op={filter.op} /></span>
      <FilterControl key={interaction.globalKeys[filter.id]} optionsKey={optionsKeyOf(filter)} id={`filter-${filter.id}`} control={filter.control} label={filterCaption(filter.label, filter.op, t)}
        debounce={interaction.mode !== 'manual'}
        onValidityChange={(valid) => setInvalid((previous) => {
          const next = valid ? undefined : interaction.globalKeys[filter.id]
          if (previous[filter.id] === next) return previous
          const result = { ...previous }
          if (next) result[filter.id] = next
          else delete result[filter.id]
          return result
        })}
        value={cascade.shown(filter.id, valueOf(filter))}
        onChange={(value) => { void cascade.change(filter, value) }} loadOptions={(search) => options(filter.id, interaction.draftValues, search)} />
    </div>)}
    {interaction.mode === 'manual' && <div className="query-submit">
      {interaction.hasPending && <span className="note small" role="status">{t('dashboard.queryPending')}</span>}
      <Button variant="primary" disabled={!interaction.hasPending || hasInvalid || cascade.isPending} onClick={interaction.apply}>{t('dashboard.runQuery')}</Button>
    </div>}
  </ChartFilterBar>
}

function QueryContainer({ children, frame, colorScheme, onSelect, onConfigure, onReset, onRemove }: { children: React.ReactNode; frame?: Frame; colorScheme: ColorScheme; onSelect?: () => void; onConfigure?: () => void; onReset?: () => void; onRemove?: () => void }) {
  const { t } = useTranslation()
  const look = frameLook(frameOf('query', frame), colorScheme)
  return <section className={`query-container ${look.className}${onConfigure ? ' editing' : ''}${onConfigure || onReset ? ' with-actions' : ''}`} style={look.style} aria-label={t('dashboard.queryContainer')}
    onClick={(event) => { if (!(event.target as HTMLElement).closest('button, a, input, .global-filter, .query-container-actions')) onSelect?.() }}>
    {(onConfigure || onReset) && <div className="query-container-actions">
      <WidgetActions name={t('dashboard.queryContainer')} actions={[
        ...(onReset ? [{ id: 'reset', label: t('dashboard.resetFilters'), icon: 'refresh' as const, onClick: onReset }] : []),
        ...(onConfigure ? [{ id: 'settings', label: t('dashboard.containerSettings'), icon: 'settings' as const, onClick: onConfigure }] : []),
        ...(onRemove ? [{ id: 'remove', label: t('dashboard.removeQueryContainer'), icon: 'trash' as const, onClick: onRemove, danger: true }] : []),
      ]} />
    </div>}
    <div className="query-container-body">{children}</div>
  </section>
}

/** One of a widget's actions: a click, or a menu of choices that opens from it. */
interface WidgetAction { id: string; label: string; icon: IconName; onClick?: () => void; menu?: MenuItem[]; danger?: boolean; disabled?: boolean }

/** A compact strip that reveals this mode's chart actions to the left. */
function WidgetActions({ name, actions }: { name: string; actions: WidgetAction[] }) {
  const { t } = useTranslation()
  const id = useId()
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    // A menu opened from the strip is drawn elsewhere; choosing in it is not a click outside.
    const outside = (event: PointerEvent) => { if (event.target instanceof Element && !root.current?.contains(event.target) && !event.target.closest('.lb-menu')) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  return <div ref={root} className={`widget-actions${open ? ' open' : ''}`}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget) && !(event.relatedTarget instanceof Element && event.relatedTarget.closest('.lb-menu'))) setOpen(false) }}
    onKeyDown={(event) => { if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus() } }}>
    <Tooltip title={t(open ? 'dashboard.collapseActions' : 'dashboard.moreActions')}><button ref={trigger} type="button" className="wb-icon-button widget-actions-toggle" aria-label={t('dashboard.chartActions', { name })} aria-expanded={open} aria-controls={id} onClick={() => setOpen((current) => !current)}><Icon name="more" /></button></Tooltip>
    <div id={id} className="widget-action-items" role="group" aria-label={t('dashboard.chartActions', { name })} aria-hidden={!open} inert={!open}>
      {actions.map((action) => action.menu ? (
        // The strip stays open while the menu is, and closes with the choice made in it.
        <Tooltip key={action.id} title={action.label}>
          <span className="widget-action-menu">
            <Menu placement="bottomRight" items={action.menu.map((item) => ({ ...item, onSelect: () => { setOpen(false); item.onSelect?.() } }))} disabled={action.disabled}>
              <button type="button" className="wb-icon-button" aria-label={action.label} disabled={action.disabled}><Icon name={action.icon} size={15} /></button>
            </Menu>
          </span>
        </Tooltip>
      ) : <Tooltip key={action.id} title={action.label}>
        <button type="button" className={`wb-icon-button${action.danger ? ' danger' : ''}`} aria-label={action.label} disabled={action.disabled} onClick={() => { setOpen(false); trigger.current?.focus(); action.onClick?.() }}><Icon name={action.icon} size={15} /></button>
      </Tooltip>)}
    </div>
  </div>
}

/**
 * How long ago a kept result was fetched. It ticks, so a board left open does
 * not keep saying "just now". Compact, among a tab container's tabs, it is a
 * clock that says so when pointed at, leaving the tabs the room.
 */
function Freshness({ at, compact }: { at: Date; compact?: boolean }) {
  const { t, i18n } = useTranslation()
  const [, tick] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    const timer = setInterval(tick, 30_000)
    return () => clearInterval(timer)
  }, [])
  const ago = t('dashboard.cachedAgo', { ago: fetchedAgo(at, new Date(), i18n.language, t('dashboard.justNow')) })
  const time = t('dashboard.cachedTitle', { time: at.toLocaleString(i18n.language) })
  if (compact) return (
    <Tooltip title={<div className="tooltip-lines"><div>{ago}</div><div>{time}</div></div>}>
      <span className="widget-freshness small" role="img" aria-label={ago}><Icon name="clock" size={12} /></span>
    </Tooltip>
  )
  return (
    <Tooltip title={time}>
      <span className="widget-freshness small">
        <Icon name="clock" size={12} />
        {ago}
      </span>
    </Tooltip>
  )
}

/** Where a widget's data stands, for the board to sum up. */
interface WidgetStatus {
  /** When the data shown was fetched from the database. */
  at?: string
  pending: boolean
  failed: boolean
}

/** Marks a chart whose refresh failed: what it shows is from before, and asking again is a click away. */
function RefreshFailure({ error, at, onRetry }: { error: ApiError; at?: string; onRetry: () => void }) {
  const { t, i18n } = useTranslation()
  const errorText = useErrorText()
  const label = at ? t('dashboard.refreshFailedAt', { time: clockTime(new Date(at), new Date(), i18n.language) }) : t('dashboard.refreshFailed')
  return (
    <Tooltip title={<div className="tooltip-lines"><div>{label}</div><div>{errorText(error)}</div></div>}>
      <button type="button" className="wb-icon-button widget-warning" aria-label={label} onClick={onRetry}><Icon name="warning" size={14} /></button>
    </Tooltip>
  )
}

/** When the data on the board is from, and whether any of it is being asked for or failed. */
function BoardFreshness({ statuses, next }: { statuses: WidgetStatus[]; next?: number }) {
  const { t, i18n } = useTranslation()
  const now = new Date()
  const loading = statuses.some((status) => status.pending)
  const failures = statuses.filter((status) => status.failed).length
  // The oldest data on the board is how old the board is.
  const times = statuses.flatMap((status) => (status.at ? [new Date(status.at).getTime()] : []))
  const oldest = times.length ? new Date(Math.min(...times)) : undefined
  if (!loading && !oldest && !failures) return null
  const summary = (
    <span className="board-freshness small">
      {loading
        ? <span className="board-freshness-item"><span className="spin"><Icon name="refresh" size={12} /></span>{t('dashboard.loadingData')}</span>
        : oldest && <span className="board-freshness-item"><Icon name="clock" size={12} />{t('dashboard.dataAsOf', { time: clockTime(oldest, now, i18n.language) })}</span>}
      {failures > 0 && <span className="board-freshness-item failed"><Icon name="warning" size={12} />{t('dashboard.refreshFailures', { count: failures })}</span>}
    </span>
  )
  return next ? <Tooltip title={t('dashboard.nextRefresh', { time: clockTime(new Date(next), now, i18n.language) })}>{summary}</Tooltip> : summary
}

/** Whether a drag carries a chart, and not an empty box, which makes room for itself instead. */
const carriesChart = (event: React.DragEvent) => event.dataTransfer.types.includes(chartDragType) && !event.dataTransfer.types.includes(emptyChartDragType)

/** Whether a chart is being dragged over a widget that would take it, and the handlers that tell. */
function useDropOver(enabled: boolean) {
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  useEffect(() => {
    if (!over) return
    // However the drag ends, nothing is over the widget any more.
    const done = () => { depth.current = 0; setOver(false) }
    window.addEventListener('dragend', done)
    window.addEventListener('drop', done)
    return () => { window.removeEventListener('dragend', done); window.removeEventListener('drop', done) }
  }, [over])
  if (!enabled) return [false, {}] as const
  return [over, {
    onDragEnter: (event: React.DragEvent) => { if (carriesChart(event)) { depth.current++; setOver(true) } },
    onDragLeave: (event: React.DragEvent) => { if (carriesChart(event) && --depth.current <= 0) { depth.current = 0; setOver(false) } },
    // The grid stops the drop from going further, so it is seen here, on the way.
    onDrop: () => { depth.current = 0; setOver(false) },
  }] as const
}

/** A remark on a chart, shown when its question mark is pointed at or focused. */
function WidgetNote({ name, note }: { name: string; note: string }) {
  const { t } = useTranslation()
  return (
    <Tooltip title={<span className="widget-note-text">{note}</span>}>
      <button type="button" className="wb-icon-button widget-note" aria-label={t('dashboard.container.noteOf', { name })}><Icon name="help" size={14} /></button>
    </Tooltip>
  )
}

/**
 * A box laid out for a chart not yet chosen. Being arranged, it says how to
 * fill it and takes a chart dropped onto it; on the board it is left blank.
 */
function ChartSlot({ item, frame, tabs, board, colorScheme, selected, onSelect, onConfigure, onChoose, onAddTab, moveTo, onRemove }: {
  item: ChartHolder
  /** How its box looks: the widget's own frame, or its tab container's. */
  frame?: Frame
  /** In a tab container: the tabs, which head it in place of its name. */
  tabs?: ReactNode
  board?: Frame
  colorScheme: ColorScheme
  selected?: boolean
  onSelect?: () => void
  onConfigure?: () => void
  onChoose?: () => void
  /** Makes the widget a tab container. */
  onAddTab?: () => void
  /** On a split dashboard, where the widget can be moved to. */
  moveTo?: MenuItem[]
  /** Removes the widget, or in a tab container the tab. */
  onRemove?: () => void
}) {
  const { t } = useTranslation()
  const editing = Boolean(onRemove)
  const [dropOver, dropHandlers] = useDropOver(editing)
  if (!editing) return <div className="chart-slot-blank" aria-hidden />
  const name = item.title || t(tabs ? 'dashboard.tabs.empty' : 'dashboard.container.empty')
  const look = frameLook(frameOf('chart', frame, board), colorScheme)
  return (
    <article className={`card widget chart-slot editing ${look.className}${selected ? ' selected' : ''}${dropOver ? ' drop-over' : ''}`} style={look.style} aria-label={name} data-drop-into={item.id} {...dropHandlers}
      onClick={(event) => { if (!(event.target as HTMLElement).closest('button, a, .widget-actions')) onSelect?.() }}>
      <header className="widget-handle">
        <span className="widget-grip"><Icon name="grip" size={14} /></span>
        {tabs ?? <h3>{name}</h3>}
        {item.note && <WidgetNote name={name} note={item.note} />}
        <WidgetActions name={name} actions={[
          ...(onConfigure ? [{ id: 'configure', label: t('dashboard.selectChart', { name }), icon: 'settings' as const, onClick: onConfigure }] : []),
          ...(onAddTab ? [{ id: 'tabs', label: t('dashboard.tabs.addTabs', { name }), icon: 'tabs' as const, onClick: onAddTab }] : []),
          ...(moveTo ? [{ id: 'move', label: t('dashboard.pages.moveTo'), icon: 'move' as const, menu: moveTo }] : []),
          { id: 'remove', label: t(tabs ? 'dashboard.tabs.removeTab' : 'dashboard.removeChart', { name }), icon: 'trash' as const, onClick: onRemove!, danger: true },
        ]} />
      </header>
      <div className="chart-slot-body">
        <Icon name="frame" size={22} />
        <p className="note small">{t('dashboard.container.dropHint')}</p>
        {onChoose && <Button size="sm" onClick={onChoose}>{t('dashboard.container.choose')}</Button>}
      </div>
    </article>
  )
}

/** One chart on the board. */
function Widget({
  dashboardId,
  exportFrom,
  chart,
  item,
  frame,
  hideHeader,
  tabs,
  visible = true,
  conditions,
  colorScheme,
  board,
  onRemove,
  onDetach,
  onAddTab,
  moveTo,
  onSelect,
  onConfigure,
  selected,
  preview,
  interaction,
  linking,
  refreshToken,
  autoRefresh,
  onStatus,
}: {
  dashboardId: string | undefined
  /**
   * The saved dashboard the widget's data is exported from. An export runs
   * what is saved, so it waits while the draft shown differs from that.
   */
  exportFrom?: { dashboardId?: string; dashboardName: string; unsaved?: boolean }
  chart: Chart | undefined
  item: ChartHolder
  /** How its box looks: the widget's own frame, or its tab container's. */
  frame?: Frame
  /** Viewed, it shows no header with the chart's name. */
  hideHeader?: boolean
  /** In a tab container: the tabs, which head it in place of its name. */
  tabs?: ReactNode
  /** In a tab container, whether its tab is the one shown. Hidden, it asks for nothing. */
  visible?: boolean
  conditions: Conditions
  colorScheme: ColorScheme
  /** How the dashboard frames widgets unless they say otherwise. */
  board?: Frame
  /** Removes the widget, or in a tab container the tab. */
  onRemove?: () => void
  /** Takes the chart out, leaving the box empty. */
  onDetach?: () => void
  /** Makes the widget a tab container. */
  onAddTab?: () => void
  /** On a split dashboard, where the widget can be moved to. */
  moveTo?: MenuItem[]
  onSelect?: () => void
  onConfigure?: () => void
  selected?: boolean
  preview?: DashboardPreview
  interaction: DashboardFiltersState
  linking: DashboardLinksState
  /** Changes when the whole board is refreshed. */
  refreshToken?: number
  /** A timed refresh: tick changes each time, and asks for results no older than maxAge seconds. */
  autoRefresh?: { tick: number; maxAge: number }
  /** Told when the widget's data is from, and whether it is loading or failed, for the board to sum up. */
  onStatus?: (itemId: string, status: WidgetStatus) => void
}) {
  const { t } = useTranslation()
  const firstWeekDays = useFirstWeekDays()
  const spec = chart?.spec as unknown as ChartSpec | undefined
  const own = (spec?.filters ?? []).filter((filter) => filter.control)
  // Its parameter filters set what data there is; only its field filters take part in cascades and global filters.
  const ownFields = own.filter(isFieldFilter)
  const { useChartFilters, chosen, selections, drill: position } = interaction.widgets[item.id] ?? emptyWidgetFilters
  const effectiveSpec = spec && resolveDynamicSpec(spec, selections)
  // Drilling changes only this chart's data, not what its lists of filter values are drawn from.
  const path = drillPath(position)
  const drilling = path.length ? { drill: path } : {}
  const associated = conditions.filters.some((filter) => filter.targets.some((target) => target.item === item.id))
  const outgoing = linking.links.filter((link) => link.source.item === item.id)
  const activeLink = outgoing.find((link) => link.id in linking.values)
  const body = {
    links: Object.fromEntries(linking.links.filter((link) => link.targets.some((target) => target.item === item.id) && link.id in linking.values).map((link) => [link.id, linking.values[link.id]])),
    selections,
    filters: conditions.values,
    useChartFilters,
    chartFilters: Object.fromEntries(own.filter((filter) => filter.id in chosen).map((filter) => [filter.id, chosen[filter.id] ?? null])),
  }
  // Moving or resizing the draft changes its layout, but not the data being queried.
  const queryPreview = preview && { links: preview.spec.links, filters: preview.spec.filters, charts: chartItems(preview.spec.layout.items).map(({ id, chartId }) => ({ id, chartId })) }
  // Refreshing the board or this chart asks the database again; other loads may use results kept from before.
  const [ownRefreshes, setOwnRefreshes] = useState(0)
  const refreshKey = `${refreshToken ?? 0}:${ownRefreshes}`
  // Counted from when the board opened: a chart first shown after it was refreshed, under a tab or
  // on a page opened since, asks as those refreshed did, and shows nothing older than they do.
  const [freshData] = useState(() => freshLoads('0:0'))
  const [freshOptions] = useState(() => freshLoadsBy('0:0'))
  // A timed refresh may use what someone else fetched since; refreshing by hand asks the database.
  const tickKey = String(autoRefresh?.tick ?? 0)
  const [timedData] = useState(() => freshLoads('0'))
  const loadKey = JSON.stringify([dashboardId, chart?.id, item.id, body, queryPreview, path])
  // Until it comes within a screen of being seen it asks for nothing; from then on it keeps up wherever it is scrolled to.
  const box = useRef<HTMLElement>(null)
  const near = useNearby(box)
  // Under another tab it asks for nothing, and keeps what it has; shown again, it asks as the board then is.
  const asked = [loadKey, refreshKey, tickKey]
  const [heldAsk, holdAsk] = useState(asked)
  if (visible && heldAsk.some((key, index) => key !== asked[index])) holdAsk(asked)
  const data = useAsync(async () => {
    if (!chart) return undefined
    const refreshing = freshData(refreshKey, loadKey)
    const timed = timedData(tickKey, loadKey) && Boolean(autoRefresh?.maxAge)
    const fresh = refreshing ? { refresh: true } : timed ? { maxAge: autoRefresh!.maxAge } : {}
    const result = await (preview
      ? unwrap(api.POST('/dashboards/preview/items/{itemId}/data', { params: { path: { itemId: item.id } }, body: { ...preview, spec: preview.spec as unknown as Record<string, unknown>, ...body, ...drilling, ...fresh } }))
      : dashboardId
        ? unwrap(api.POST('/dashboards/{id}/items/{itemId}/data', { params: { path: { id: dashboardId, itemId: item.id } }, body: { ...body, ...drilling, ...fresh } }))
        : unwrap(api.POST('/charts/{id}/data', { params: { path: { id: chart.id } }, body: { filters: body.chartFilters, selections, ...drilling, ...(refreshing ? { refresh: true } : {}) } })))
    // The conditions the result answers, to tell it from a result for conditions since changed.
    return { key: loadKey, result }
  // Nor does it ask before it is first shown, however near it is.
  }, visible ? asked : heldAsk, { keepData: true, wait: !near || !visible })
  const refresh = () => setOwnRefreshes((n) => n + 1)
  // A chart once drawn stays while it is asked for again, and when that fails.
  const loaded = data.status === 'ok' ? data.data : undefined
  const result = loaded?.result
  const outdated = loaded !== undefined && loaded.key !== loadKey
  // A value clicked here is written in the board's list of links as this chart writes it.
  const { describe } = linking
  const formats = effectiveSpec?.viz.formats
  const linked = outgoing.length > 0
  useEffect(() => {
    if (result && linked) describe(item.id, applyFormats(result as ChartResult, formats).columns)
  }, [describe, item.id, result, formats, linked])
  // Not yet asked, it is neither loading nor failed for the board to say so; the card itself is still marked busy.
  const pending = near && (data.status === 'loading' || (data.status === 'ok' && Boolean(data.pending)))
  // A refresh that failed leaves the chart as it was; failing to answer changed conditions shows why instead.
  const refreshFailed = data.status === 'ok' && !outdated ? data.failed : undefined
  const shown: AsyncState<typeof loaded> = data.status === 'ok' && data.failed && outdated ? { status: 'error', error: data.failed } : data
  const meta = result?.meta
  const failed = data.status === 'error' || (data.status === 'ok' && Boolean(data.failed))
  useEffect(() => {
    onStatus?.(item.id, { at: meta?.cachedAt, pending, failed })
  }, [onStatus, item.id, meta?.cachedAt, pending, failed])
  const cachedAt = meta?.cached && meta.cachedAt ? new Date(meta.cachedAt) : undefined
  const loadOptions = (filterId: string, values: Record<string, unknown>, search = '', related = false) => {
    const asked = { ...body, chartFilters: values, search, related }
    const context = { ...asked, ...(freshOptions(filterId, refreshKey, JSON.stringify(asked)) ? { refresh: true } : {}) }
    if (preview) return unwrap(api.POST('/dashboards/preview/items/{itemId}/filters/{filterId}/options', { params: { path: { itemId: item.id, filterId } }, body: { ...preview, spec: preview.spec as unknown as Record<string, unknown>, ...context } }))
    if (dashboardId) return unwrap(api.POST('/dashboards/{id}/items/{itemId}/filters/{filterId}/options', { params: { path: { id: dashboardId, itemId: item.id, filterId } }, body: context }))
    return unwrap(api.POST('/charts/{id}/filters/{filterId}/options', { params: { path: { id: chart!.id, filterId } }, body: { filters: values, selections, search, related, ...(context.refresh ? { refresh: true } : {}) } }))
  }
  const cascadeContext = JSON.stringify([body.links, useChartFilters, conditions.values, selections, interaction.widgetKeys[item.id], own.filter(isParamFilter).map((filter) => chosen[filter.id])])
  const takenOver = (filter: ChartFilter) => !useChartFilters && takenByAll(conditions.filters, { item: item.id, field: filter.field, aggregation: filter.aggregation }).length > 0
  const cascade = useCascadeChange({
    filters: ownFields,
    values: chosen,
    commit: (next) => interaction.setWidget(item.id, { chosen: next }),
    load: (parent, values) => loadOptions(parent.id, values, '', true),
    context: cascadeContext,
    skip: takenOver,
  })
  // Global values and dynamic choices narrow a chart's own lists; other own choices do not, except its ancestors.
  const optionsKeyOf = (filter: ChartFilter) => JSON.stringify([cascadeContext, queryPreview, refreshKey, ancestorsKey(ownFields, filter.id, (parent) => parent.id in chosen ? chosen[parent.id] : parent.value)])
  const controls = own
  // The name the widget goes by on this dashboard, or the chart's own.
  const chartName = item.title || (chart?.name ?? t('dashboard.missingChart'))
  const editing = Boolean(onRemove)
  const look = frameLook(frameOf('chart', frame, board), colorScheme)
  const [dropOver, dropHandlers] = useDropOver(editing)
  const exportable = Boolean(exportFrom && spec?.allowExport)
  const exportWaits = !exportFrom?.dashboardId || Boolean(exportFrom.unsaved)
  const [exporting, setExporting] = useState(false)
  // Enlarging a chart and reading its rows are for looking at the board, not for arranging it.
  const [inspecting, setInspecting] = useState<'enlarge' | 'rows'>()
  const inspectable = !onRemove
  const actions = [
    { id: 'refresh', label: t('dashboard.refreshChart', { name: chartName }), icon: 'refresh' as const, onClick: refresh, disabled: !chart || pending },
    ...(inspectable ? [
      { id: 'enlarge', label: t('dashboard.enlargeChart', { name: chartName }), icon: 'expand' as const, onClick: () => setInspecting('enlarge'), disabled: !chart },
      { id: 'rows', label: t('dashboard.viewChartData', { name: chartName }), icon: 'table' as const, onClick: () => setInspecting('rows'), disabled: !chart || !result },
    ] : []),
    ...(exportable ? [{ id: 'export', label: t(exportWaits ? 'dashboard.exportAfterSave' : 'dashboard.exportChart', { name: chartName }), icon: 'download' as const, onClick: () => setExporting(true), disabled: exportWaits || !chart }] : []),
    ...((dashboardId || preview) && associated ? [{ id: 'filters', label: t(useChartFilters ? 'dashboard.restoreGlobalFilters' : 'dashboard.useChartFilters'), icon: (useChartFilters ? 'filter' : 'unlock') as IconName, onClick: () => interaction.setWidget(item.id, { useChartFilters: !useChartFilters }) }] : []),
    ...(onConfigure ? [{ id: 'configure', label: t('dashboard.selectChart', { name: chartName }), icon: 'settings' as const, onClick: onConfigure }] : []),
    ...(onAddTab ? [{ id: 'tabs', label: t('dashboard.tabs.addTabs', { name: chartName }), icon: 'tabs' as const, onClick: onAddTab }] : []),
    ...(onDetach ? [{ id: 'detach', label: t('dashboard.container.detach', { name: chartName }), icon: 'detach' as const, onClick: onDetach }] : []),
    ...(moveTo ? [{ id: 'move', label: t('dashboard.pages.moveTo'), icon: 'move' as const, menu: moveTo }] : []),
    ...(onRemove ? [{ id: 'remove', label: t(tabs ? 'dashboard.tabs.removeTab' : 'dashboard.removeChart', { name: chartName }), icon: 'trash' as const, onClick: onRemove, danger: true }] : []),
  ]

  // The card and its enlarged view show the same controls and the same result: changing either changes both.
  const filterBar = (controls.length > 0 || Boolean(spec?.dynamics?.length)) && (
    <ChartFilterBar style={spec?.filterStyle}>
      <DynamicControls dynamics={spec?.dynamics ?? []} values={selections} onChange={(id, value) => interaction.setWidget(item.id, { selections: { ...selections, [id]: value } })} />
      {controls.map((filter) => {
        if (isParamFilter(filter)) {
          // What the dataset says of the parameter comes with the chart: viewers cannot read the dataset.
          const info = chart?.params?.[filter.id]
          if (!info) return null
          return (
            <span key={filter.id} className="widget-filter">
              <span className="note small">{filter.label ?? ''}</span>
              <ParamFilterControl
                key={`${interaction.widgetKeys[item.id]}:${filter.id}`}
                size="sm"
                kind={filter.control!.type}
                info={info}
                label={filter.label ?? ''}
                value={filter.id in chosen ? chosen[filter.id] : info.default}
                onChange={(value) => interaction.setWidget(item.id, { chosen: { ...chosen, [filter.id]: value } })}
              />
            </span>
          )
        }
        const owners = useChartFilters ? [] : takenByAll(conditions.filters, { item: item.id, field: filter.field, aggregation: filter.aggregation })
        const confirmed = meta?.overriddenFilters
        const dynamicOwners = useChartFilters ? [] : conditions.filters.filter((global) => global.targets.some((target) => {
          if (target.item !== item.id || !target.measure) return false
          const measure = (effectiveSpec?.query.measures as { alias?: string; field?: string; agg?: string }[] | undefined)?.find((entry) => entry.alias === target.measure)
          // The same field aggregated the same way; a metric is aggregated by neither.
          return measure !== undefined && measure.field === filter.field && measure.agg === filter.aggregation
        }))
        const overridden = confirmed ? confirmed.includes(filter.id) : owners.length > 0 || dynamicOwners.length > 0
        const ownerNames = [...new Set([...owners, ...dynamicOwners].map((owner) => owner.label))]
        return (
          <Tooltip key={filter.id} title={overridden ? t('dashboard.filterOverridden', { name: (ownerNames.length ? ownerNames : conditions.filters.filter((global) => global.targets.some((target) => target.item === item.id)).map((global) => global.label)).join(t('filter.separator')) }) : undefined}>
            <span className={`widget-filter${overridden ? ' overridden' : ''}`}>
              <span className="note small"><FilterLabel label={filter.label ?? ''} op={filter.op} /></span>
              <FilterControl
                key={`${interaction.widgetKeys[item.id]}:${filter.id}`}
                optionsKey={optionsKeyOf(filter)}
                size="sm"
                disabled={overridden}
                control={filter.control!}
                label={filterCaption(filter.label ?? '', filter.op, t)}
                value={cascade.shown(filter.id, filter.id in chosen ? chosen[filter.id] : filter.value)}
                onChange={(value) => { void cascade.change(filter, value) }}
                // Its lists are asked for too: not before the chart is near.
                loadOptions={near ? (search) => loadOptions(filter.id, body.chartFilters, search) : undefined}
              />
            </span>
          </Tooltip>
        )
      })}
    </ChartFilterBar>
  )
  // A value clicked offers what can be done with it: going one level down where the chart is drilled, and
  // linking other charts where it is a link's source. The column drilled down links only at its first level,
  // since the links map that level's field; drilling, or going back, lets go of the links clicked here.
  const drillSpec = spec?.drill
  const down = drillDown(drillSpec, position, t)
  const linkable = (column: string) => outgoing.some((link) => link.source.column === column) && (column !== drillSpec?.alias || !position)
  const linkedTo = (column: string, value: Cell) => outgoing.filter((link) => link.source.column === column).every((link) => link.id in linking.values && JSON.stringify(linking.values[link.id]) === JSON.stringify(value))
  const clickColumns = [...new Set([...(down && drillSpec ? [drillSpec.alias] : []), ...outgoing.map((link) => link.source.column).filter(linkable)])]
  const columnOf = (column: string) => result && applyFormats(namedColumns(result) as ChartResult, formats).columns.find((other) => other.name === column)
  const clickActions: ClickActions | undefined = clickColumns.length ? {
    columns: clickColumns,
    items: (column, value) => [
      ...(down && column === drillSpec?.alias ? [{ key: 'drill', label: down.label, onSelect: () => interaction.setWidget(item.id, { drill: drilledInto(position, value, columnOf(column), t, firstWeekDays) }) }] : []),
      ...(linkable(column) ? [{ key: 'link', label: t(linkedTo(column, value) ? 'drill.unlink' : 'drill.link'), onSelect: () => linking.select(item.id, column, value) }] : []),
    ],
  } : undefined
  const crumbs = <DrillCrumbs position={position} onBack={(depth) => interaction.setWidget(item.id, { drill: depth ? { ...position!, steps: position!.steps.slice(0, depth) } : undefined })} />
  // On the board a chart is drawn on its box's colour; enlarged, on the dialog's.
  const drawChart = (height: number, onBox = true) => chart && spec && (
    <Async state={shown} reload={data.reload}>
      {(loaded) =>
        loaded ? (
          <ChartView
            viz={effectiveSpec!.viz as Viz}
            result={loaded.result}
            pageKey={loaded.key}
            colorScheme={onBox ? look.scheme ?? colorScheme : colorScheme}
            surface={onBox ? look.surface : undefined}
            height={height}
            label={chartName}
            clickActions={clickActions}
            selection={activeLink ? { value: linking.values[activeLink.id] ?? null } : undefined}
            cellSelections={Object.fromEntries(outgoing.filter((link) => link.id in linking.values).map((link) => [link.source.column, linking.values[link.id] ?? null]))}
          />
        ) : null
      }
    </Async>
  )

  return (
    <article ref={box} className={`card widget ${look.className}${hideHeader ? editing ? ' header-faded' : ' header-hidden' : ''}${editing ? ' editing' : ''}${selected ? ' selected' : ''}${dropOver ? ' drop-over' : ''}${pending && outdated ? ' outdated' : ''}`} style={look.style} aria-label={chartName} aria-busy={pending || !near}
      data-drop-into={editing ? item.id : undefined} {...dropHandlers}
      onClick={(event) => { if (!(event.target as HTMLElement).closest('button, a, input, .widget-filters, .widget-actions')) onSelect?.() }}>
      {pending && result && <div className="widget-progress" role="progressbar" aria-label={t('dashboard.loadingChart', { name: chartName })} />}
      <header className="widget-handle">
        {onSelect && <span className="widget-grip"><Icon name="grip" size={14} /></span>}
        {tabs ?? <h3>{chartName}</h3>}
        {/* Hidden when viewed, the header still floats over the chart while arranging, to move it by. */}
        {editing && hideHeader && <span className="widget-header-hint small">{t('dashboard.container.hiddenWhenViewed')}</span>}
        {refreshFailed && <RefreshFailure error={refreshFailed} at={meta?.cachedAt} onRetry={data.reload} />}
        {cachedAt && !hideHeader && <Freshness at={cachedAt} compact={Boolean(tabs)} />}
        {item.note && <WidgetNote name={chartName} note={item.note} />}
        <WidgetActions key={onConfigure ? 'edit' : 'view'} name={chartName} actions={actions} />
      </header>
      {filterBar}
      {crumbs}
      <FitHeight className="widget-body">{(height) => drawChart(height)}</FitHeight>
      {exporting && exportFrom?.dashboardId && !exportFrom.unsaved && <ChartExportDialog dashboardId={exportFrom.dashboardId} itemId={item.id} name={`${exportFrom.dashboardName} - ${chartName}`} onClose={() => setExporting(false)}
        // The file is headed as the chart's columns are, in the viewer's language.
        request={{ ...body, ...drilling, ...(result ? { headers: Object.fromEntries(namedColumns(result).columns.map((column) => [column.name, column.label ?? column.name])) } : {}) }} />}
      {inspecting === 'enlarge' && (
        <Dialog open title={chartName} width={1280} onClose={() => setInspecting(undefined)}>
          <div className="widget-enlarged">
            {filterBar}
            {crumbs}
            <FitHeight className="widget-body">{(height) => drawChart(height, false)}</FitHeight>
          </div>
        </Dialog>
      )}
      {inspecting === 'rows' && (
        <Dialog open title={t('dashboard.chartData', { name: chartName })} width={960} onClose={() => setInspecting(undefined)}>
          {/* The rows the chart was drawn from, not asked for again. */}
          <Async state={shown} reload={data.reload}>
            {(loaded) => loaded ? (
              <div className="widget-rows">
                {loaded.result.meta.truncated && <p className="note small">{t('dashboard.rowsTruncated', { count: loaded.result.rows.length })}</p>}
                <ResultRows result={loaded.result} formats={effectiveSpec?.viz.formats} hidden={effectiveSpec?.viz.hiddenColumns} label={t('dashboard.chartData', { name: chartName })} />
              </div>
            ) : null}
          </Async>
        </Dialog>
      )}
    </article>
  )
}

/**
 * A tab container: one box, with a chart in each tab and the tabs for its
 * header. A tab's chart is drawn once its tab is opened, and kept, stacked
 * under the one shown, so that going back to it shows it as it was; only the
 * one shown asks for data. See .agents/design/chart-dashboard.md 3.15.
 */
function TabsBox({ item, tabs, active, nameOf, onActivate, onAdd, children }: {
  item: TabsItem
  /** The tabs offered: viewed, the empty ones are left out. */
  tabs: ChartTab[]
  /** The tab shown, one of tabs. */
  active: string
  nameOf: (tab: ChartTab) => string
  onActivate: (tabId: string) => void
  /** Being arranged, adds an empty tab. The tabs then also take a chart dragged onto them, as a new tab where it is let go. */
  onAdd?: () => void
  /** What a tab shows, headed by the tabs; shown says whether it is on top. */
  children: (tab: ChartTab, strip: ReactNode, shown: boolean) => ReactNode
}) {
  const { t } = useTranslation()
  const root = useRef<HTMLDivElement>(null)
  const [opened, setOpened] = useState([active])
  if (!opened.includes(active)) setOpened([...opened, active])
  // Each tab's box has the tabs on top; switching from them goes on from the tab chosen, on the box now shown.
  const refocus = useRef(false)
  // Each box has a strip of its own: the one now shown starts where the last was scrolled to.
  const scrolled = useRef(0)
  useLayoutEffect(() => {
    const strip = root.current?.querySelector<HTMLElement>('.widget-tab-panel.shown .widget-tab-strip')
    const chosen = strip?.querySelector<HTMLElement>('.widget-tab[aria-selected="true"]')
    if (!strip || !chosen) return
    // Only the strip scrolls to the chosen tab; scrolling it into view would move the page too.
    strip.scrollLeft = Math.min(Math.max(scrolled.current, chosen.offsetLeft + chosen.offsetWidth - strip.clientWidth), chosen.offsetLeft)
    if (refocus.current) chosen.focus({ preventScroll: true })
    refocus.current = false
  }, [active])
  const choose = (id: string) => {
    if (id === active) return
    refocus.current = true
    scrolled.current = root.current?.querySelector<HTMLElement>('.widget-tab-panel.shown .widget-tab-strip')?.scrollLeft ?? 0
    onActivate(id)
  }
  // While a chart from the library is dragged over the tabs, the place among them it would go in at.
  const [dropAt, setDropAt] = useState<number>()
  const depth = useRef(0)
  const receiving = dropAt !== undefined
  useEffect(() => {
    if (!receiving) return
    // However the drag ends, nothing is over the tabs any more.
    const done = () => { depth.current = 0; setDropAt(undefined) }
    window.addEventListener('dragend', done)
    window.addEventListener('drop', done)
    return () => { window.removeEventListener('dragend', done); window.removeEventListener('drop', done) }
  }, [receiving])
  const full = item.tabs.length >= tabLimits.max
  // Before the first tab whose middle is right of the pointer, or after them all.
  const placeOf = (event: React.DragEvent<HTMLElement>) => {
    const buttons = [...event.currentTarget.querySelectorAll<HTMLElement>('.widget-tab')]
    const at = buttons.findIndex((button) => { const box = button.getBoundingClientRect(); return event.clientX < box.left + box.width / 2 })
    return at < 0 ? buttons.length : at
  }
  const dropHandlers = onAdd ? {
    onDragEnter: (event: React.DragEvent<HTMLElement>) => { if (carriesChart(event)) { depth.current++; setDropAt(placeOf(event)) } },
    onDragOver: (event: React.DragEvent<HTMLElement>) => { if (carriesChart(event)) setDropAt(placeOf(event)) },
    onDragLeave: (event: React.DragEvent<HTMLElement>) => { if (carriesChart(event) && --depth.current <= 0) { depth.current = 0; setDropAt(undefined) } },
  } : {}
  const marker = !full && <span key="drop-marker" className="widget-tab-insert" aria-hidden />
  const strip = (
    <TabStrip label={t('dashboard.tabs.list')} onKeyDown={(event) => {
      const at = tabs.findIndex((tab) => tab.id === active)
      const to = { ArrowRight: (at + 1) % tabs.length, ArrowLeft: (at - 1 + tabs.length) % tabs.length, Home: 0, End: tabs.length - 1 }[event.key]
      if (to === undefined || !(event.target as HTMLElement).matches('[role="tab"]')) return
      event.preventDefault()
      choose(tabs[to]!.id)
    }}>
      {tabs.map((tab, index) => {
        const name = nameOf(tab)
        return <Fragment key={tab.id}>
          {dropAt === index && marker}
          <button type="button" role="tab" className="widget-tab" aria-selected={tab.id === active} tabIndex={tab.id === active ? 0 : -1} title={name} onClick={() => choose(tab.id)}>{name}</button>
        </Fragment>
      })}
      {dropAt === tabs.length && marker}
    </TabStrip>
  )
  // The tabs and what adds to them, which a chart dragged from the library goes in among. Adding a tab stays at hand however far the tabs are scrolled.
  const header = (
    <div className={`widget-tab-bar${receiving ? ' drop-over' : ''}`} data-drop-into={onAdd ? tabsDropTarget(item.id, dropAt ?? tabs.length) : undefined} {...dropHandlers}>
      {strip}
      {receiving && full && <span className="widget-tab-full small">{t('dashboard.tabs.fullShort', { count: tabLimits.max })}</span>}
      {onAdd && <Tooltip title={t('dashboard.tabs.add')}><button type="button" className="wb-icon-button widget-tab-add" aria-label={t('dashboard.tabs.add')} disabled={full} onClick={onAdd}><Icon name="plus" size={14} /></button></Tooltip>}
    </div>
  )
  return (
    <div ref={root} className="widget-tabs">
      {tabs.filter((tab) => opened.includes(tab.id)).map((tab) => {
        const shown = tab.id === active
        return <div key={tab.id} className={`widget-tab-panel${shown ? ' shown' : ''}`} role="tabpanel" aria-label={nameOf(tab)} aria-hidden={!shown} inert={!shown}>{children(tab, header, shown)}</div>
      })}
    </div>
  )
}

/**
 * A row of tabs. Too many for its width, it scrolls, by the wheel too, and
 * fades at an edge beyond which more are hidden.
 */
function TabStrip({ label, onKeyDown, children }: { label: string; onKeyDown: (event: React.KeyboardEvent) => void; children: ReactNode }) {
  const strip = useRef<HTMLDivElement>(null)
  const [more, setMore] = useState({ before: false, after: false })
  const measure = useCallback(() => {
    const element = strip.current
    if (!element) return
    const before = element.scrollLeft > 1
    const after = element.scrollLeft + element.clientWidth < element.scrollWidth - 1
    setMore((current) => current.before === before && current.after === after ? current : { before, after })
  }, [])
  // Names change without the strip changing size.
  useLayoutEffect(measure)
  useEffect(() => {
    const element = strip.current
    if (!element) return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    // A wheel turned over tabs that do not fit moves along them rather than the page.
    // At either end the wheel goes on scrolling the page.
    const wheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
      const room = event.deltaY > 0 ? element.scrollWidth - element.clientWidth - element.scrollLeft : element.scrollLeft
      if (room < 1) return
      event.preventDefault()
      element.scrollLeft += event.deltaY
    }
    element.addEventListener('scroll', measure, { passive: true })
    element.addEventListener('wheel', wheel, { passive: false })
    return () => { observer.disconnect(); element.removeEventListener('scroll', measure); element.removeEventListener('wheel', wheel) }
  }, [measure])
  return <div ref={strip} className={`widget-tab-strip${more.before ? ' more-before' : ''}${more.after ? ' more-after' : ''}`} role="tablist" aria-label={label} onKeyDown={onKeyDown}>{children}</div>
}

/**
 * The tabs of a split dashboard, between what is above them and the page
 * shown. Scrolled past, they stay at the top of what the board scrolls in.
 * See .agents/design/chart-dashboard.md 3.13.
 */
function PageTabs({ pages, active, onActivate, onAdd, onSettings }: {
  pages: BoardPage[]
  /** The page shown, one of pages. */
  active: string
  onActivate: (id: string) => void
  /** Being arranged: adds an empty page. */
  onAdd?: () => void
  /** Being arranged: shows the pages' settings, as a click between the tabs does. */
  onSettings?: () => void
}) {
  const { t } = useTranslation()
  const bar = useRef<HTMLDivElement>(null)
  // Chosen from the keyboard, the focus goes with the page chosen.
  const refocus = useRef(false)
  useLayoutEffect(() => {
    const strip = bar.current?.querySelector<HTMLElement>('.widget-tab-strip')
    const chosen = strip?.querySelector<HTMLElement>('.board-page-tab[aria-selected="true"]')
    if (!strip || !chosen) return
    // Only the strip scrolls to the chosen tab; scrolling it into view would move the board too.
    strip.scrollLeft = Math.min(Math.max(strip.scrollLeft, chosen.offsetLeft + chosen.offsetWidth - strip.clientWidth), chosen.offsetLeft)
    if (refocus.current) chosen.focus({ preventScroll: true })
    refocus.current = false
  }, [active])
  const full = pages.length >= pageLimits.max
  return (
    <div ref={bar} className={`board-page-tabs${onSettings ? ' editing' : ''}`} onClick={(event) => { if (onSettings && !(event.target as HTMLElement).closest('button')) onSettings() }}>
      <TabStrip label={t('dashboard.pages.list')} onKeyDown={(event) => {
        const at = pages.findIndex((page) => page.id === active)
        const to = { ArrowRight: (at + 1) % pages.length, ArrowLeft: (at - 1 + pages.length) % pages.length, Home: 0, End: pages.length - 1 }[event.key]
        if (to === undefined || !(event.target as HTMLElement).matches('[role="tab"]')) return
        event.preventDefault()
        refocus.current = true
        onActivate(pages[to]!.id)
      }}>
        {pages.map((page) => <button key={page.id} type="button" role="tab" className="widget-tab board-page-tab" aria-selected={page.id === active} tabIndex={page.id === active ? 0 : -1} title={page.name} onClick={() => onActivate(page.id)}>{page.name}</button>)}
      </TabStrip>
      {onAdd && <Tooltip title={t(full ? 'dashboard.pages.full' : 'dashboard.pages.add', { count: pageLimits.max })}><button type="button" className="wb-icon-button" aria-label={t('dashboard.pages.add')} disabled={full} onClick={onAdd}><Icon name="plus" size={14} /></button></Tooltip>}
      {onSettings && <Tooltip title={t('dashboard.pages.settings')}><button type="button" className="wb-icon-button" aria-label={t('dashboard.pages.settings')} onClick={onSettings}><Icon name="settings" size={14} /></button></Tooltip>}
    </div>
  )
}

/** What a row dragged in the inspector's list of tabs or pages carries: its id. */
const rowDragType = 'application/x-supabi-tab'

/**
 * Moving the rows of a list in the inspector by their handles: dragged, with
 * the place it would go marked, or a place up or down with the arrow keys,
 * which keep the focus on the handle moved.
 */
function useRowMoves(ids: string[], onMove: (id: string, to: number) => void) {
  const list = useRef<HTMLUListElement>(null)
  // The row being dragged, and the row it would go before or after.
  const [dragging, setDragging] = useState<{ id: string; over?: { id: string; after: boolean } }>()
  const refocus = useRef<string>(undefined)
  useLayoutEffect(() => {
    if (!refocus.current) return
    ;[...list.current?.querySelectorAll<HTMLElement>('.dashboard-tab-grip') ?? []].find((grip) => grip.dataset.row === refocus.current)?.focus()
    refocus.current = undefined
  })
  const drop = () => {
    const over = dragging?.over
    if (!dragging || !over) return
    const from = ids.indexOf(dragging.id)
    const at = ids.indexOf(over.id) + (over.after ? 1 : 0)
    // Where it goes among the others, once it is out of its own place.
    const to = at > from ? at - 1 : at
    if (to !== from) onMove(dragging.id, to)
  }
  return {
    list,
    /** How a row is marked while one is dragged. */
    marks: (id: string) => [dragging?.id === id && 'dragging', dragging?.over?.id === id && (dragging.over.after ? 'drop-after' : 'drop-before')],
    row: (id: string) => ({
      onDragOver: (event: React.DragEvent<HTMLLIElement>) => {
        if (!dragging) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        const box = event.currentTarget.getBoundingClientRect()
        const after = event.clientY > box.top + box.height / 2
        if (dragging.over?.id !== id || dragging.over.after !== after) setDragging({ ...dragging, over: { id, after } })
      },
      onDrop: (event: React.DragEvent<HTMLLIElement>) => { if (!dragging) return; event.preventDefault(); drop(); setDragging(undefined) },
    }),
    grip: (id: string, index: number) => ({
      'data-row': id,
      draggable: true,
      onDragStart: (event: React.DragEvent<HTMLButtonElement>) => {
        event.dataTransfer.effectAllowed = 'move'
        // A type of its own, so that a text field it is let go over does not take its name.
        event.dataTransfer.setData(rowDragType, id)
        // The whole row goes with the pointer, not the handle alone.
        const row = event.currentTarget.closest('li')
        if (row) event.dataTransfer.setDragImage?.(row, 12, row.offsetHeight / 2)
        setDragging({ id })
      },
      onDragEnd: () => setDragging(undefined),
      onKeyDown: (event: React.KeyboardEvent) => {
        const to = event.key === 'ArrowUp' ? index - 1 : event.key === 'ArrowDown' ? index + 1 : -1
        if (to < 0 || to >= ids.length) return
        event.preventDefault()
        refocus.current = id
        onMove(id, to)
      },
    }),
  }
}

/**
 * The tabs of a selected tab container, in the inspector: each shown by a
 * click on its name, made the one shown first by its star, moved by its
 * handle, dragged or with the arrow keys, and removed.
 */
function TabList({ item, shown, nameOf, onShow, onDefault, onMove, onRemove }: {
  item: TabsItem
  /** The tab the canvas shows. */
  shown: string | undefined
  nameOf: (tab: ChartTab) => string
  onShow: (tabId: string) => void
  onDefault: (tabId: string) => void
  /** Puts a tab at the given place among the tabs. */
  onMove: (tabId: string, to: number) => void
  onRemove: (tabId: string) => void
}) {
  const { t } = useTranslation()
  const moves = useRowMoves(item.tabs.map((tab) => tab.id), onMove)
  const shownFirst = defaultTabOf(item).id
  return (
    <ul ref={moves.list} className="dashboard-tab-list" aria-label={t('dashboard.tabs.list')}>
      {item.tabs.map((tab, index) => {
        const name = nameOf(tab)
        const isDefault = tab.id === shownFirst
        const marks = [tab.id === shown && 'active', ...moves.marks(tab.id)].filter(Boolean).join(' ')
        return (
          <li key={tab.id} className={marks || undefined} {...moves.row(tab.id)}>
            <Tooltip title={t('dashboard.tabs.moveHint')}>
              <button type="button" className="wb-icon-button dashboard-tab-grip" aria-label={t('dashboard.tabs.move', { name, position: index + 1, count: item.tabs.length })} {...moves.grip(tab.id, index)}><Icon name="grip" size={14} /></button>
            </Tooltip>
            <button type="button" className="dashboard-tab-list-name" aria-current={tab.id === shown} onClick={() => onShow(tab.id)}><Icon name={tab.chartId ? 'chart' : 'frame'} size={14} /><span>{name}</span></button>
            <Tooltip title={t(isDefault ? 'dashboard.tabs.isDefaultHint' : 'dashboard.tabs.makeDefaultHint')}>
              <button type="button" className={`wb-icon-button dashboard-tab-default${isDefault ? ' on' : ''}`} aria-label={t('dashboard.tabs.defaultOf', { name })} aria-pressed={isDefault} onClick={() => { if (!isDefault) onDefault(tab.id) }}><Icon name="star" size={14} /></button>
            </Tooltip>
            <Tooltip title={t('dashboard.tabs.removeTab', { name })}><button type="button" className="wb-icon-button danger" aria-label={t('dashboard.tabs.removeTab', { name })} onClick={() => onRemove(tab.id)}><Icon name="trash" size={14} /></button></Tooltip>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * A page's name in the inspector, changed as it is typed. Left blank, the
 * page keeps the name it had until another is typed.
 */
function PageNameInput({ page, label, onRename }: { page: BoardPage; label: string; onRename: (name: string) => void }) {
  const [text, setText] = useState(page.name)
  // Undone or redone, the name shown is the page's again.
  if (text.trim() && text !== page.name) setText(page.name)
  return <Input aria-label={label} value={text} maxLength={pageLimits.name} placeholder={page.name} onChange={(name) => { setText(name); if (name.trim()) onRename(name) }} />
}

/**
 * The pages of a split dashboard, in the inspector: each named in place,
 * moved by its handle, dragged or with the arrow keys, and removed. The
 * handle's row shows the page on the canvas when it is clicked.
 */
function PageList({ pages, shown, onShow, onRename, onMove, onRemove }: {
  pages: BoardPage[]
  /** The page the canvas shows. */
  shown: string | undefined
  onShow: (id: string) => void
  onRename: (id: string, name: string) => void
  onMove: (id: string, to: number) => void
  onRemove: (id: string) => void
}) {
  const { t } = useTranslation()
  const moves = useRowMoves(pages.map((page) => page.id), onMove)
  return (
    <ul ref={moves.list} className="dashboard-tab-list dashboard-page-list" aria-label={t('dashboard.pages.list')}>
      {pages.map((page, index) => {
        const marks = [page.id === shown && 'active', ...moves.marks(page.id)].filter(Boolean).join(' ')
        return (
          <li key={page.id} className={marks || undefined} {...moves.row(page.id)} onFocus={() => onShow(page.id)}>
            <Tooltip title={t('dashboard.pages.moveHint')}>
              <button type="button" className="wb-icon-button dashboard-tab-grip" aria-label={t('dashboard.pages.move', { name: page.name, position: index + 1, count: pages.length })} {...moves.grip(page.id, index)}><Icon name="grip" size={14} /></button>
            </Tooltip>
            <PageNameInput page={page} label={t('dashboard.pages.nameOf', { position: index + 1 })} onRename={(name) => onRename(page.id, name)} />
            <Tooltip title={t('dashboard.pages.remove', { name: page.name })}><button type="button" className="wb-icon-button danger" aria-label={t('dashboard.pages.remove', { name: page.name })} onClick={() => onRemove(page.id)}><Icon name="trash" size={14} /></button></Tooltip>
          </li>
        )
      })}
    </ul>
  )
}

/** A box that hands what it draws its own height, which follows the box's size. */
function FitHeight({ className, children }: { className: string; children: (height: number) => ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(1)
  useLayoutEffect(() => {
    const element = box.current
    if (!element) return
    // Flex layout reserves the actual space taken by the title and wrapped controls.
    const resize = () => setHeight(Math.max(1, element.clientHeight))
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return <div className={className} ref={box}>{children(height)}</div>
}

/** What a title shows: the dashboard's own name and description, or its own. */
function titleOf(item: TitleItem, dashboard: { name: string; description: string }) {
  return item.useDashboardName ? { title: dashboard.name, subtitle: dashboard.description } : { title: item.title ?? '', subtitle: item.subtitle ?? '' }
}

/** A title or text on the board. The author wrote it; it asks for no data. */
function NoteWidget({ item, dashboard, board, colorScheme, selected, onSelect, onConfigure, moveTo, onRemove }: {
  item: TitleItem | TextItem
  /** The dashboard's name and description, which a title may show. */
  dashboard: { name: string; description: string }
  /** How the dashboard frames widgets unless they say otherwise. */
  board?: Frame
  colorScheme: ColorScheme
  selected?: boolean
  onSelect?: () => void
  onConfigure?: () => void
  /** On a split dashboard, where it can be moved to. */
  moveTo?: MenuItem[]
  onRemove?: () => void
}) {
  const { t } = useTranslation()
  // Being arranged, an empty note says what it is for; on the board it is left blank.
  const editing = Boolean(onRemove)
  const markdown = item.type === 'text' ? item.markdown ?? '' : ''
  const html = useMemo(() => markdown.trim() ? renderMarkdown(markdown) : '', [markdown])
  const { title, subtitle } = item.type === 'title' ? titleOf(item, dashboard) : { title: '', subtitle: '' }
  const empty = item.type === 'title' ? !title && !subtitle : !html
  const name = item.type === 'title' ? title || t('dashboard.note.title') : t('dashboard.note.text')
  const style = item.type === 'title' ? item.style ?? {} : {}
  const placed = item.type === 'title' ? ` h-${style.align ?? 'left'} v-${style.verticalAlign ?? 'middle'}` : ''
  // Text left empty is not even a card on the board; a title keeps its frame, which may be a band of colour.
  const framed = item.type === 'title' || editing || !empty
  const look = framed ? frameLook(frameOf(item.type, item.frame, board), colorScheme) : undefined
  return (
    <article className={`board-note ${item.type}${placed}${look ? ` ${look.className}` : ''}${item.type === 'text' && framed ? ' card' : ''}${editing ? ' editing' : ''}${selected ? ' selected' : ''}`} aria-label={name}
      style={look?.style}
      onClick={(event) => { if (!(event.target as HTMLElement).closest('button, a, .widget-actions')) onSelect?.() }}>
      {item.type === 'title' ? (
        <div className="board-title">
          {title ? <h2 title={title}>{title}</h2> : editing && <h2 className="board-note-placeholder">{t('dashboard.note.emptyTitle')}</h2>}
          {subtitle && <p title={subtitle}>{subtitle}</p>}
        </div>
      ) : html ? (
        // Rendered without the author's HTML, and with links to the web and to mail only.
        <div className="board-text" dangerouslySetInnerHTML={{ __html: html }} />
      ) : editing && <p className="board-note-placeholder">{t('dashboard.note.emptyText')}</p>}
      {editing && <WidgetActions name={name} actions={[
        ...(onConfigure ? [{ id: 'configure', label: t('dashboard.note.configure', { name }), icon: 'settings' as const, onClick: onConfigure }] : []),
        ...(moveTo ? [{ id: 'move', label: t('dashboard.pages.moveTo'), icon: 'move' as const, menu: moveTo }] : []),
        { id: 'remove', label: t('dashboard.note.remove', { name }), icon: 'trash' as const, onClick: onRemove!, danger: true },
      ]} />}
    </article>
  )
}

function View({ dashboard, colorScheme, shared, notice }: {
  dashboard: Pick<Dashboard, 'id' | 'name' | 'description' | 'spec' | 'charts'>
  colorScheme: ColorScheme
  /** The conditions a share link carries, as far as the dashboard can still take them. */
  shared?: ViewState
  /** Said above the board, about how the share link was opened. */
  notice?: string
}) {
  const { t } = useTranslation()
  const session = useSession()
  const canEdit = session.atLeast('developer')
  const workspaceId = session.state.status === 'ok' ? session.state.data.workspace?.id : undefined
  const spec = dashboard.spec as unknown as DashboardSpec
  const grid = readGridSettings(spec.layout)
  const filters = spec.filters ?? []
  // Titles and text ask for no data: what the toolbar says about data is about the charts.
  const chartWidgets = chartItems(spec.layout.items)
  const [initial] = useState(() => shared && choicesOf(shared, spec, dashboard.charts))
  // The tab each tab container shows, for this page only, or as a share link carries it. Empty tabs are not offered to readers.
  const [activeTabs, setActiveTabs] = useState<Record<string, string>>(() => initial?.tabs ?? {})
  // On a split dashboard, the page shown: as a share link or the address says, or the first.
  const pages = spec.layout.pages
  const [search, setSearch] = useSearchParams()
  const [chosenPage, setChosenPage] = useState(() => initial?.page ?? search.get('page') ?? undefined)
  const page = shownPage(pages, chosenPage)
  const firstPage = pages?.[0]?.id
  // A page once opened stays drawn, out of sight, so that going back to it shows it as it was.
  const [opened, setOpened] = useState(() => page ? [page.id] : [])
  if (page && !opened.includes(page.id)) setOpened([...opened, page.id])
  const showPage = (id: string) => {
    setChosenPage(id)
    // Going to another page leaves no step in the browser's history to go back through.
    setSearch((current) => {
      const next = new URLSearchParams(current)
      if (id === firstPage) next.delete('page')
      else next.set('page', id)
      return next
    }, { replace: true })
  }
  // What is in view: what is above the tabs, and the page shown. Not split, it is everything.
  const sharedItems = onPage(spec.layout.items, undefined)
  const inView = page ? [...sharedItems, ...onPage(spec.layout.items, page.id)] : spec.layout.items
  // A page shows the global filters of the charts in view.
  const shownFilters = pages ? filtersShownWith(filters, new Set(chartItems(inView).map((item) => item.id))) : filters
  const interaction = useDashboardFilters(filters, chartWidgets, dashboard.charts, spec.queryMode, initial)
  const linking = useDashboardLinks(spec.links ?? [], (link) => linkContext(link, interaction, filters, chartWidgets, dashboard.charts), initial?.links)
  const linkText = useLinkValueText(linking)
  // What the viewer has chosen, which a share link may carry.
  const chosen = chosenState(spec, dashboard.charts, { values: interaction.values, widgets: interaction.widgets, links: linking.values, tabs: activeTabs, page: page?.id })
  const chosenKey = JSON.stringify(chosen)
  const [sharedKey] = useState(() => JSON.stringify(initial ? chosenState(spec, dashboard.charts, initial) : {}))
  const [sharing, setSharing] = useState<ViewState>()
  // The address names the shared conditions until the viewer changes them; reloading after that starts from the dashboard's own,
  // on the page then shown.
  const shownPageId = page?.id
  useEffect(() => {
    if (!search.has('view') || chosenKey === sharedKey) return
    setSearch((current) => {
      const next = new URLSearchParams(current)
      next.delete('view')
      if (shownPageId && shownPageId !== firstPage) next.set('page', shownPageId)
      return next
    }, { replace: true })
  }, [search, setSearch, chosenKey, sharedKey, shownPageId, firstPage])
  const conditions: Conditions = { filters, values: interaction.values }
  const [refreshToken, setRefreshToken] = useState(0)
  usePageTitle(page ? `${dashboard.name} - ${page.name}` : dashboard.name)
  const [fullscreen, setFullscreen] = useFullscreen()
  // Full screen, the board scrolls by itself; otherwise where the page it is on says, or in the window.
  const view = useRef<HTMLDivElement>(null)
  const around = useContext(ScrollArea)
  const own = useArea(useCallback(() => fullscreen ? view.current : null, [fullscreen]))
  const scrollArea = fullscreen || !around ? own : around
  // The author's interval, unless the reader picks another for this page.
  const [chosenInterval, chooseInterval] = useState<number>()
  const interval = chartWidgets.length ? chosenInterval ?? spec.autoRefresh ?? 0 : 0
  const [tick, setTick] = useState(0)
  const next = useAutoRefresh(interval, () => setTick((n) => n + 1))
  const autoRefresh = { tick, maxAge: interval ? refreshMaxAge(interval) : 0 }
  const [statuses, setStatuses] = useState<Record<string, WidgetStatus>>({})
  const report = useCallback((id: string, status: WidgetStatus) => setStatuses((current) => {
    const was = current[id]
    return was && was.at === status.at && was.pending === status.pending && was.failed === status.failed ? current : { ...current, [id]: status }
  }), [])
  // What the toolbar says about the data is about the charts that are shown, not those under other tabs or on other pages.
  const shownCharts = inView.flatMap((item) => {
    const tab = isTabs(item) ? shownTab(item, offeredTabs(item), activeTabs[item.id]) : undefined
    return holdsChart(item) ? [item.id] : tab ? [tab.id] : []
  })
  const chartOf = (holder: ChartHolder) => dashboard.charts.find((chart) => chart.id === holder.chartId)
  const chartWidget = (holder: ChartHolder, box: { frame?: Frame; hideHeader?: boolean; tabs?: ReactNode; visible?: boolean }) => (
    <Widget
      dashboardId={dashboard.id}
      exportFrom={{ dashboardId: dashboard.id, dashboardName: dashboard.name }}
      item={holder}
      {...box}
      chart={chartOf(holder)}
      conditions={conditions}
      colorScheme={colorScheme}
      board={spec.frame}
      interaction={interaction} linking={linking}
      refreshToken={refreshToken}
      autoRefresh={autoRefresh}
      onStatus={report}
    />
  )

  const gridProps = { columns: grid.columns, minWidth: gridMinWidth(grid.columns), rowHeight: grid.rowHeight, unitScale: gridScale, gap: grid.rowGap, columnGap: grid.columnGap, containerGap: grid.containerGap, autoCompact: grid.autoCompact }
  // On a page with none of its filters, the query container is not shown, and gives back its room.
  const sharedGrid = dashboardGrid(pages && filters.length && !shownFilters.length ? closeUp(sharedItems, spec.queryContainer, grid.containerGap) : sharedItems, shownFilters.length > 0, spec.queryContainer, spec.queryHeightMode, grid.columns, grid.containerGap)
  /** A widget on the board; on a page out of sight, its charts ask for nothing. */
  const boardItem = (item: DashboardGridItem, shown: boolean) => {
    if (item.type === 'query') return <QueryContainer frame={item.frame} colorScheme={colorScheme} onReset={interaction.reset}><DashboardFilters linking={linking} key={interaction.resetKey} style={spec.filterStyle} filters={filters} shown={shownFilters} interaction={interaction} dashboardId={dashboard.id} refreshToken={refreshToken} paramsOf={paramFiltersOf(chartWidgets, dashboard.charts)} /></QueryContainer>
    if (isTabs(item)) {
      const tab = shownTab(item, offeredTabs(item), activeTabs[item.id])
      return tab
        ? <TabsBox item={item} tabs={offeredTabs(item)} active={tab.id} nameOf={(tab) => tab.title || (chartOf(tab)?.name ?? t('dashboard.missingChart'))} onActivate={(id) => setActiveTabs((current) => ({ ...current, [item.id]: id }))}>
          {(tab, strip, tabShown) => chartWidget(tab, { frame: item.frame, tabs: strip, visible: tabShown && shown })}
        </TabsBox>
        : <div className="chart-slot-blank" aria-hidden />
    }
    if (!isChart(item)) return <NoteWidget item={item} dashboard={dashboard} board={spec.frame} colorScheme={colorScheme} />
    return holdsChart(item) ? chartWidget(item, { frame: item.frame, hideHeader: item.hideHeader, visible: shown }) : <ChartSlot item={item} board={spec.frame} colorScheme={colorScheme} />
  }

  return (
    <div ref={view} className={`board-view${fullscreen ? ' fullscreen' : ''}`}>
      <div className="row board-toolbar">
        {chartWidgets.length > 0 && (
          <>
            <BoardFreshness statuses={shownCharts.flatMap((id) => statuses[id] ?? [])} next={next} />
            <Select<number> aria-label={t('dashboard.autoRefresh')} value={interval} options={[0, ...autoRefreshIntervals].map((value) => ({ value, label: autoRefreshLabel(value, t) }))} onChange={chooseInterval} />
            <Tooltip title={t('dashboard.refreshAllHint')}>
              <Button icon={<Icon name="refresh" size={14} />} onClick={() => setRefreshToken((n) => n + 1)}>
                {t('dashboard.refreshAll')}
              </Button>
            </Tooltip>
          </>
        )}
        <Button icon={<Icon name="share" size={14} />} onClick={() => setSharing(chosen)}>{t('dashboard.share.open')}</Button>
        <Button icon={<Icon name={fullscreen ? 'collapse' : 'expand'} size={14} />} onClick={() => setFullscreen(!fullscreen)}>
          {t(fullscreen ? 'dashboard.exitFullscreen' : 'dashboard.fullscreen')}
        </Button>
        {canEdit && !fullscreen && (
          <Link target="_blank" rel="noopener noreferrer" to={`/workbench/dashboards/${dashboard.id}${page && page.id !== firstPage ? `?page=${page.id}` : ''}`}>
            <Button>{t('dashboard.edit')}</Button>
          </Link>
        )}
      </div>
      {notice && <Alert tone="info" title={notice} />}
      <DashboardLinkChips state={linking} />
      {sharing && <ShareDashboardDialog dashboardId={dashboard.id} workspaceId={workspaceId} state={sharing} spec={spec} charts={dashboard.charts} linkText={linkText} onClose={() => setSharing(undefined)} />}
      {spec.layout.items.length === 0 && !pages ? (
        <p className="note">{t('dashboard.emptyBoard')}</p>
      ) : (
        <ScrollArea value={scrollArea}>
          {sharedGrid.length > 0 && <GridLayout items={sharedGrid} {...gridProps} renderItem={(item) => boardItem(item, true)} />}
          {pages && page && <>
            <PageTabs pages={pages} active={page.id} onActivate={showPage} />
            <div className="board-pages">
              {pages.filter((entry) => opened.includes(entry.id)).map((entry) => {
                const shown = entry.id === page.id
                const items = onPage(spec.layout.items, entry.id)
                return <div key={entry.id} className={`board-page${shown ? ' shown' : ''}`} role="tabpanel" aria-label={entry.name} aria-hidden={!shown} inert={!shown}>
                  {items.length
                    ? <GridLayout items={dashboardGrid(items, false, undefined, 'auto', grid.columns, grid.containerGap)} {...gridProps} renderItem={(item) => boardItem(item, shown)} />
                    : <p className="note board-page-empty">{t('dashboard.pages.emptyPage')}</p>}
                </div>
              })}
            </div>
          </>}
        </ScrollArea>
      )}
    </div>
  )
}

function Editor({ dashboard, available, colorScheme, onCreated }: { dashboard?: Dashboard; available: ChartSummary[]; colorScheme: ColorScheme; onCreated: (dashboard: Dashboard) => void }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [search] = useSearchParams()
  const { reload } = useWorkbench()
  const conflict = useSaveConflict('dashboard', () => dashboard && comparableDashboard(dashboard))
  const savedBoard = conflict.base ?? dashboard
  const spec = savedBoard?.spec as DashboardSpec | undefined
  const { value: draft, update, undo, redo, endGroup, reset, canUndo, canRedo } = useHistory<DashboardDraft>(dashboardDraft(dashboard))
  const { links, name, description, items, pages, filters, queryContainer, filterStyle, queryMode, queryHeightMode, grid, frame: board } = draft
  // On a split dashboard, the page the canvas shows: at first the one it was opened on, as the address says. It is neither saved nor undone.
  const [chosenPage, setChosenPage] = useState(() => search.get('page') ?? undefined)
  const current = shownPage(pages, chosenPage)
  // A page once shown stays drawn, out of sight, so that going back to it shows it as it was.
  const [openedPages, setOpenedPages] = useState<string[]>(() => current ? [current.id] : [])
  if (current && !openedPages.includes(current.id)) setOpenedPages([...openedPages, current.id])
  usePageTitle(`${name.trim() || t('dashboard.new')}${current ? ` - ${current.name}` : ''}`)
  // A default frame staged as null clears it.
  const [pageEdits, setPageEdits] = useState<{ name?: string; description?: string; grid?: GridSettingsInput; autoRefresh?: number; frame?: Frame | null }>({})
  const pageName = pageEdits.name ?? name
  const pageDescription = pageEdits.description ?? description
  const pageGrid = pageEdits.grid ?? gridSettingsInput(grid)
  const pageAutoRefresh = pageEdits.autoRefresh ?? draft.autoRefresh ?? 0
  const pageFrame = pageEdits.frame === undefined ? board : pageEdits.frame ?? undefined
  const pageDirty = pageName !== name || pageDescription !== description || pageAutoRefresh !== (draft.autoRefresh ?? 0) || JSON.stringify(pageGrid) !== JSON.stringify(gridSettingsInput(grid)) || JSON.stringify(pageFrame) !== JSON.stringify(board)
  const setItems = (next: SetStateAction<LayoutItem[]>) => update((current) => ({ ...current, items: typeof next === 'function' ? next(current.items) : next }))
  type Panel = 'page' | 'charts' | 'widget' | 'query' | 'pages'
  const [linksOpen, setLinksOpen] = useState(false)
  const [grantsOpen, setGrantsOpen] = useState(false)
  const canManageGrants = useSession().atLeast('developer')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const openFilters = () => { endGroup(); setPanel(null); setFiltersOpen(true) }
  const [panel, setPanel] = useState<Panel | null>(spec?.layout.items.length ? null : 'charts')
  const [selectedId, setSelectedId] = useState<string>()
  const [removingQuery, setRemovingQuery] = useState(false)
  const [removingId, setRemovingId] = useState<string>()
  // A tab waiting for the author to say it goes, with what it holds.
  const [removingTab, setRemovingTab] = useState<{ item: string; tab: string }>()
  // A page waiting for the author to say it goes, with what is on it.
  const [removingPage, setRemovingPage] = useState<string>()
  // A chart dropped onto a widget or tab that holds another, waiting for the author to say it replaces it.
  const [replacing, setReplacing] = useState<{ itemId: string; chartId: string }>()
  // The tab each tab container shows on the canvas. It is neither saved nor undone.
  const [activeTabs, setActiveTabs] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  // Arranged or previewed, the board scrolls in the canvas.
  const canvas = useRef<HTMLDivElement>(null)
  const scrollArea = useArea(useCallback(() => canvas.current, []))
  const [error, setError] = useState<ApiError | null>(null)
  // What is stored, to tell whether there is anything to save.
  const state = JSON.stringify(draft)
  const [stored, setStored] = useState(state)
  const dirty = state !== stored

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (saving || previewing || removingId || removingTab || removingPage || replacing || event.defaultPrevented || event.isComposing || event.altKey || !(event.metaKey || event.ctrlKey)) return
      // Text fields and dialogs keep their own undo behavior.
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return
      const key = event.key.toLowerCase()
      if (key !== 'z' && key !== 'y') return
      event.preventDefault()
      if (key === 'y' || event.shiftKey) redo()
      else undo()
    }
    document.addEventListener('keydown', keydown)
    return () => document.removeEventListener('keydown', keydown)
  }, [saving, previewing, removingId, removingTab, removingPage, replacing, undo, redo])

  // Charts already on the board came with it; ones added now are fetched to preview them.
  const chartWidgets = chartItems(items)
  const ids = [...new Set(chartWidgets.map((item) => item.chartId))].sort()
  const charts = useAsync(() => Promise.all(ids.map((id) => savedBoard?.charts.find((chart) => chart.id === id) ?? unwrap(api.GET('/charts/{id}', { params: { path: { id } } })))), [ids.join(','), savedBoard])
  // Adding another chart must not temporarily erase the filters of charts already loaded.
  const [loadedCharts, setLoadedCharts] = useState(dashboard?.charts ?? [])
  if (charts.status === 'ok' && charts.data !== loadedCharts) setLoadedCharts(charts.data)
  const known = charts.status === 'ok' ? charts.data : loadedCharts
  const datasetIds = [...new Set(known.map((chart) => chart.datasetId))].sort()
  // A newer dashboard can use new fields from the same datasets. Refresh
  // their definitions whenever the saved baseline is accepted, too.
  const datasets = useAsync(async () => Object.fromEntries(await Promise.all(datasetIds.map(async (id) => {
    const dataset = await unwrap(api.GET('/datasets/{id}', { params: { path: { id } } }))
    return [id, dataset.spec as unknown as DatasetSpec]
  }))), [datasetIds.join(','), savedBoard])
  const fields = filterFields(chartWidgets, known, datasets.status === 'ok' ? datasets.data : {}, filters.flatMap((filter) => filter.targets))
  const kept = pruneGlobal(filters, chartWidgets)
  // On a split dashboard the query container shows the filters of the charts in view: above the tabs, and on the page shown.
  const inView = current ? [...onPage(items, undefined), ...onPage(items, current.id)] : items
  const shownFilters = pages ? filtersShownWith(kept, new Set(chartItems(inView).map((item) => item.id))) : kept
  const selected = items.find((item) => item.id === selectedId)
  const activeTab = (item: TabsItem) => shownTab(item, item.tabs, activeTabs[item.id])!
  const showTab = (itemId: string, tabId: string) => setActiveTabs((current) => ({ ...current, [itemId]: tabId }))
  /** What the inspector and the chart library are about: the selected chart widget, or the tab a selected tab container shows. */
  const holder = selected && (isChart(selected) ? selected : isTabs(selected) ? activeTab(selected) : undefined)
  const selectedChart = holder?.chartId ? known.find((chart) => chart.id === holder.chartId) : undefined
  /** What a chart widget or tab is called in the editor: by its name on the board, its chart's, or as empty. */
  const holderName = (holder: ChartHolder, inTabs = false) => holder.title || (holder.chartId ? known.find((chart) => chart.id === holder.chartId)?.name ?? t('dashboard.missingChart') : t(inTabs ? 'dashboard.tabs.empty' : 'dashboard.container.empty'))
  /** What a widget is called in the editor. */
  const nameOf = (item: LayoutItem) => isChart(item) ? holderName(item) : isTabs(item) ? t('dashboard.tabs.container')
    : item.type === 'title' ? titleOf(item, draft).title || t('dashboard.note.title') : t('dashboard.note.text')
  /** The widget on the grid a chart widget or tab is in. */
  const boxOf = (id: string) => items.find((item) => item.id === id || (isTabs(item) && item.tabs.some((tab) => tab.id === id)))
  const removing = items.find((item) => item.id === removingId)
  const removingName = removing ? nameOf(removing) : ''
  const removingFrom = removingTab && items.find((item): item is TabsItem => item.id === removingTab.item && isTabs(item))
  const tabRemoved = removingFrom?.tabs.find((tab) => tab.id === removingTab?.tab)
  const replacingItem = replacing && chartHolders(items).find((holder) => holder.id === replacing.itemId)
  const pageRemoved = removingPage ? pages?.find((page) => page.id === removingPage) : undefined
  const replacingWith = replacing && (known.find((chart) => chart.id === replacing.chartId) ?? available.find((chart) => chart.id === replacing.chartId))
  const select = (item: LayoutItem) => { setSelectedId(item.id); setPanel('widget') }
  // Ids are unique among widgets, tabs and pages alike.
  const taken = [...items, ...(pages ?? [])]
  /** The grid new widgets go on: the page shown, or the whole dashboard when it is not split. */
  const target = current?.id
  /** The grid of a page, or of what is above the tabs, with the query container; not split, that is the whole dashboard. */
  const gridOf = (from: DashboardDraft, page: string | undefined): DashboardGridItem[] => page === undefined
    ? dashboardGrid(onPage(from.items, undefined), pruneGlobal(from.filters, chartItems(from.items)).length > 0, from.queryContainer, from.queryHeightMode, from.grid.columns, from.grid.containerGap)
    : dashboardGrid(onPage(from.items, page), false, undefined, 'auto', from.grid.columns, from.grid.containerGap)
  /** The draft with one of its grids laid out anew. */
  const withGrid = (from: DashboardDraft, page: string | undefined, next: DashboardGridItem[]): DashboardDraft => {
    const split = splitDashboardGrid(next)
    return { ...from, items: replaceOnPage(from.items, page, split.items), ...(page === undefined ? { queryContainer: split.queryContainer } : {}) }
  }
  const setGrid = (page: string | undefined, next: DashboardGridItem[]) => update((current) => withGrid(current, page, next))
  const defaultPageName = (n: number) => t('dashboard.pages.defaultName', { n })
  /** Splits the dashboard into two pages, or gives it another. Either way the new page is empty, and shown. */
  const addPage = () => {
    if (pages && pages.length >= pageLimits.max) return
    endGroup()
    const id = newItemId(taken)
    if (pages) {
      const added = { id, name: newPageName(pages, defaultPageName) }
      update((current) => ({ ...current, pages: [...(current.pages ?? []), added] }))
    } else {
      const first = { id, name: defaultPageName(1) }
      const second = { id: newItemId([...taken, first]), name: defaultPageName(2) }
      update((current) => {
        const split = splitDashboardGrid(splitIntoPages(gridOf(current, undefined), [first, second], current.grid.containerGap))
        return { ...current, items: split.items, queryContainer: split.queryContainer, pages: [first, second] }
      })
      setChosenPage(second.id)
      return
    }
    setChosenPage(id)
  }
  /** Names a page. Typing its name is one step to undo. */
  const renamePage = (id: string, name: string) => update((current) => ({ ...current, pages: current.pages?.map((page) => page.id === id ? { ...page, name } : page) }), { group: `${id}:name` })
  /** Moves a page to another place among them, as a step of its own to undo. */
  const placePage = (id: string, to: number) => {
    endGroup()
    update((current) => {
      const moved = current.pages?.find((page) => page.id === id)
      if (!moved || !current.pages) return current
      const rest = current.pages.filter((page) => page !== moved)
      rest.splice(to, 0, moved)
      return { ...current, pages: rest }
    })
  }
  /**
   * Takes a page out, with what is on it and the filters and links mapped to
   * that. With one page left the dashboard is not split any more: what is on
   * that page follows what was above the tabs.
   */
  const removePage = (id: string) => {
    const left = (pages ?? []).filter((page) => page.id !== id)
    endGroup()
    update((current) => {
      const rest = current.items.filter((item) => item.page !== id)
      const remaining = (current.pages ?? []).filter((page) => page.id !== id)
      const joined = remaining.length < pageLimits.min
      const container = pruneGlobal(current.filters, chartItems(current.items)).length ? current.queryContainer : undefined
      const next: DashboardDraft = { ...current, items: joined ? joinPages(rest, remaining[0]!.id, container, current.grid.containerGap) : rest, pages: remaining }
      if (joined) delete next.pages
      const kept = chartHolders(next.items)
      return { ...next, filters: pruneGlobal(current.filters, kept), links: pruneLinks(current.links, kept) }
    })
    // The page that takes the removed one's place is shown: the next, or the one before the last.
    if (current?.id === id) setChosenPage(left[Math.min((pages ?? []).findIndex((page) => page.id === id), left.length - 1)]?.id)
    if (selected?.page === id) { setSelectedId(undefined); if (panel === 'widget') setPanel(null) }
    if (left.length < pageLimits.min && panel === 'pages') setPanel(null)
  }
  /** Moves a widget to another page, or above the tabs, below what is there. The canvas stays on the page shown. */
  const moveItem = (id: string, page: string | undefined) => {
    endGroup()
    update((current) => ({ ...current, items: moveToPage(current.items, id, page, current.grid.containerGap, pruneGlobal(current.filters, chartItems(current.items)).length ? current.queryContainer : undefined) }))
    if (selectedId === id) { setSelectedId(undefined); if (panel === 'widget') setPanel(null) }
  }
  /**
   * A widget dragged from above the tabs onto the page shown, or the other
   * way, where it was let go; what was there made room for it. One step to undo.
   */
  const moveAcross = ({ id, to, items: placed }: GridMove) => {
    // The grid above the tabs goes by an empty key, as it has no page.
    const page = to || undefined
    endGroup()
    update((current) => {
      const moving = current.items.find((item) => item.id === id)
      if (!moving) return current
      const at = new Map(placed.map((place) => [place.id, place]))
      const next = [...gridOf(current, page), moving].map((item) => {
        const place = at.get(item.id)
        return place ? { ...item, x: place.x, y: place.y, w: place.w, h: place.h } : item
      })
      return withGrid({ ...current, items: current.items.filter((item) => item.id !== id) }, page, next)
    })
  }
  /** Where a widget of a split dashboard can be moved to: above the tabs, or any other page. */
  const moveTargets = (item: LayoutItem): MenuItem[] | undefined => pages && [
    ...(item.page !== undefined ? [{ key: 'shared', label: t('dashboard.pages.shared'), onSelect: () => moveItem(item.id, undefined) }] : []),
    ...pages.filter((page) => page.id !== item.page).map((page) => ({ key: page.id, label: page.name, onSelect: () => moveItem(item.id, page.id) })),
  ]
  // A click selects a widget. With the inspector showing settings of something else, it turns to the widget; closed, or showing the chart library, it stays so.
  const focusOn = (item: LayoutItem) => {
    setSelectedId(item.id)
    if (panel === 'page' || panel === 'query') setPanel('widget')
  }
  const focusOnQuery = () => {
    if (panel !== 'page' && panel !== 'widget') return
    endGroup()
    setSelectedId(undefined)
    setPanel('query')
  }
  const remove = (id: string) => {
    // The widget and its mappings must be restored together by one undo.
    update((current) => { const next = current.items.filter((item) => item.id !== id); const kept = chartHolders(next); return { ...current, items: next, filters: pruneGlobal(current.filters, kept), links: pruneLinks(current.links, kept) } })
    if (selectedId === id) { setSelectedId(undefined); setPanel(null) }
  }
  /**
   * Makes a chart widget a tab container, its chart in the first tab, or gives
   * a tab container another tab. Either way the new tab is empty, and shown.
   */
  const addTab = (itemId: string) => {
    const item = items.find((entry) => entry.id === itemId)
    if (!item || (isTabs(item) && item.tabs.length >= tabLimits.max)) return
    endGroup()
    const tabId = newItemId(taken)
    const boxId = isChart(item) ? newItemId([...taken, { id: tabId }]) : itemId
    setItems((current) => current.map((entry) => entry.id !== itemId ? entry
      : isChart(entry) ? intoTabs(entry, boxId, tabId)
        : isTabs(entry) ? insertTab(entry, { id: tabId }, entry.tabs.length) : entry))
    setSelectedId(boxId)
    showTab(boxId, tabId)
  }
  /** Takes a tab out of its container, with the filters and links mapped to it. With one tab left, the container is a chart widget again. */
  const removeTab = (itemId: string, tabId: string) => {
    const box = items.find((item): item is TabsItem => item.id === itemId && isTabs(item))
    if (!box) return
    update((current) => {
      const next = current.items.map((item) => item.id === itemId && isTabs(item) ? withoutTab(item, tabId) : item)
      const kept = chartHolders(next)
      return { ...current, items: next, filters: pruneGlobal(current.filters, kept), links: pruneLinks(current.links, kept) }
    })
    const left = box.tabs.filter((tab) => tab.id !== tabId)
    // A chart widget again, it goes by its last tab's id.
    if (left.length < tabLimits.min) { if (selectedId === itemId) setSelectedId(left[0]!.id) }
    // The tab that takes the removed one's place is shown: the next, or the one before the last.
    else if (activeTab(box).id === tabId) showTab(itemId, left[Math.min(box.tabs.findIndex((tab) => tab.id === tabId), left.length - 1)]!.id)
  }
  /** Makes a tab the one its container shows when the dashboard is opened. The canvas goes on showing the tab it shows. */
  const setDefaultTab = (itemId: string, tabId: string) => {
    const box = items.find((item): item is TabsItem => item.id === itemId && isTabs(item))
    if (!box) return
    endGroup()
    showTab(itemId, activeTab(box).id)
    setItems((current) => current.map((item) => item.id === itemId && isTabs(item) ? withDefaultTab(item, tabId) : item))
  }
  /** Moves a tab to another place among its container's tabs, as a step of its own to undo. */
  const placeTab = (itemId: string, tabId: string, to: number) => {
    endGroup()
    setItems((current) => current.map((item) => item.id === itemId && isTabs(item) ? moveTab(item, tabId, to) : item))
  }
  // A chart picked while an empty box or tab is selected goes into it; otherwise it gets a box of its own below everything.
  const add = (chartId: string) => {
    if (holder && !holder.chartId) {
      fill(holder.id, chartId)
      setPanel('widget')
      return
    }
    const at = gridOf(draft, target)
    const item = { ...place(at, chartId, Math.round(grid.columns / 2), defaultChartHeight, grid.containerGap), id: newItemId(taken) }
    setGrid(target, [...at, item])
    setSelectedId(item.id)
  }
  const addEmpty = () => {
    endGroup()
    const at = gridOf(draft, target)
    const item = { ...place(at, undefined, Math.round(grid.columns / 2), defaultChartHeight, grid.containerGap), id: newItemId(taken) }
    setGrid(target, [...at, item])
    setSelectedId(item.id)
    setPanel('widget')
  }
  /** Puts a chart in an empty chart widget or tab, and selects the box it is in. */
  const fill = (holderId: string, chartId: string) => {
    endGroup()
    setItems((current) => updateHolder(current, holderId, (holder) => ({ ...holder, chartId })))
    setSelectedId(boxOf(holderId)?.id ?? holderId)
  }
  /**
   * Puts another chart, or none, in a chart widget or tab, keeping where it is
   * and how it looks. What was said about the chart it held goes with it: the
   * filters and links mapped to it, its name on the board and its note.
   */
  const rehold = (holderId: string, chartId: string | undefined) => {
    endGroup()
    update((current) => {
      const next = updateHolder(current.items, holderId, (holder) => {
        const held: ChartHolder = { ...holder, ...(chartId ? { chartId } : {}) }
        if (!chartId) delete held.chartId
        delete held.title
        delete held.note
        return held
      })
      const others = chartHolders(next).filter((holder) => holder.id !== holderId)
      return { ...current, items: next, filters: pruneGlobal(current.filters, others), links: pruneLinks(current.links, others) }
    })
  }
  /** A chart dropped onto a tab container's tabs: a new tab where it was let go, shown. */
  const dropTab = (itemId: string, at: number, chartId: string) => {
    const box = items.find((item): item is TabsItem => item.id === itemId && isTabs(item))
    if (!box || chartId === emptyChartDrop || box.tabs.length >= tabLimits.max) return
    endGroup()
    const tabId = newItemId(taken)
    setItems((current) => current.map((item) => item.id === itemId && isTabs(item) ? insertTab(item, { id: tabId, chartId }, at) : item))
    setSelectedId(itemId)
    showTab(itemId, tabId)
  }
  /**
   * A chart dropped onto a chart widget or the tab it shows: into it when it
   * is empty, and in place of what it holds once the author agrees. Dropped
   * onto a tab container's tabs, it is a tab of its own.
   */
  const dropInto = (chartId: string, holderId: string) => {
    const tabs = readTabsDropTarget(holderId)
    if (tabs) { dropTab(tabs.id, tabs.at, chartId); return }
    const target = chartHolders(items).find((holder) => holder.id === holderId)
    if (!target || chartId === emptyChartDrop || target.chartId === chartId) return
    if (!target.chartId) fill(holderId, chartId)
    else setReplacing({ itemId: holderId, chartId })
  }
  // A title goes on top, where a heading is wanted, above the tabs of a split dashboard; text goes below everything, as charts do.
  // Either is written in the inspector, which opens with it.
  const addNote = (type: 'title' | 'text') => {
    endGroup()
    const id = newItemId(taken)
    if (type === 'title') setGrid(undefined, insertAtTop(gridOf(draft, undefined), { id, type, useDashboardName: true, x: 0, y: 0, w: grid.columns, h: titleHeight }, grid.containerGap))
    else {
      const at = gridOf(draft, target)
      setGrid(target, [...at, { id, type, x: 0, y: below(at, grid.containerGap), w: Math.round(grid.columns / 2), h: textHeight }])
    }
    setSelectedId(id)
    setPanel('widget')
  }
  /** Changes what a title or text says. Typing into one field is one step to undo. */
  const writeNote = (id: string, patch: Partial<TitleItem> | Partial<TextItem>, group?: string) => update((current) => ({ ...current, items: current.items.map((item) => {
    if (item.id !== id || isChart(item)) return item
    const next: Record<string, unknown> = { ...item, ...patch }
    // Nothing is kept for what is empty or off.
    for (const key of ['useDashboardName', 'title', 'subtitle', 'markdown']) if (next[key] === undefined || next[key] === '' || next[key] === false) delete next[key]
    return next as unknown as LayoutItem
  }) }), group ? { group: `${id}:${group}` } : undefined)
  /** Changes where a title's words sit, keeping only what differs from the default. */
  const styleTitle = (id: string, patch: TitleStyle) => update((current) => ({ ...current, items: current.items.map((item) => {
    if (item.id !== id || item.type !== 'title') return item
    const style: TitleStyle = { ...item.style, ...patch }
    if (style.align === 'left') delete style.align
    if (style.verticalAlign === 'middle') delete style.verticalAlign
    const next: TitleItem = { ...item, style }
    if (!Object.keys(style).length) delete next.style
    return next
  }) }))
  /** Changes a chart widget's or tab's name on the board and note, or a chart widget's header. Typing into one field is one step to undo. */
  const writeChart = (id: string, patch: Pick<ChartItem, 'title' | 'note' | 'hideHeader'>, group?: string) => update((current) => ({ ...current, items: updateHolder(current.items, id, (holder) => {
    const next: Record<string, unknown> = { ...holder, ...patch }
    for (const key of ['title', 'note', 'hideHeader']) if (next[key] === undefined || next[key] === '' || next[key] === false) delete next[key]
    return next as unknown as ChartHolder
  }) }), group ? { group: `${id}:${group}` } : undefined)
  /**
   * Changes how a widget's box looks, given as the frame it is now drawn
   * with; only what differs from the dashboard's and its type's is kept.
   * Picking a colour in the panel is one step to undo.
   */
  const frameItem = (id: string, frame: Frame, live?: boolean) => update((current) => ({ ...current, items: current.items.map((item) => {
    if (item.id !== id) return item
    const kept = keptFrame(frame, frameOf(item.type, undefined, current.frame))
    const next = { ...item, ...(kept ? { frame: kept } : {}) }
    if (!kept) delete next.frame
    return next
  }) }), live ? { group: `${id}:frame` } : undefined)
  /** The same for the query container, whose box is laid out once it is framed. */
  const frameQuery = (frame: Frame, live?: boolean) => update((current) => {
    const layout = splitDashboardGrid(dashboardGrid(onPage(current.items, undefined), true, current.queryContainer, current.queryHeightMode, current.grid.columns, current.grid.containerGap))
    const kept = keptFrame(frame, frameOf('query', undefined))
    const container: QueryContainerLayout = { ...layout.queryContainer!, ...(kept ? { frame: kept } : {}) }
    if (!kept) delete container.frame
    return { ...current, items: replaceOnPage(current.items, undefined, layout.items), queryContainer: container }
  }, live ? { group: 'query:frame' } : undefined)
  const tools: { panel: Panel | 'filters'; icon: IconName; label: string; shortLabel?: string; count?: number }[] = [
    { panel: 'charts', icon: 'chart', label: t('dashboard.palette') },
    { panel: 'filters', icon: 'filter', label: t('dashboard.filters'), shortLabel: t('dashboard.filterTool'), count: kept.length },
  ]
  const panelTitle = panel === 'page' ? t('dashboard.pageSettings') : panel === 'widget' ? t('dashboard.widgetSettings') : panel === 'query' ? t('dashboard.queryContainerSettings') : panel === 'pages' ? t('dashboard.pages.title') : tools.find((tool) => tool.panel === panel)?.label
  const applyPageSettings = () => {
    if (!pageDirty || !pageName.trim()) return
    endGroup()
    const nextGrid = parseGridSettings(pageGrid, grid)
    update((current) => {
      const next = { ...current, name: pageName, description: pageDescription, grid: nextGrid, autoRefresh: pageAutoRefresh || undefined, frame: pageFrame }
      if (nextGrid.columns === current.grid.columns) return next
      // Each grid is rescaled as it is laid out, what is above the tabs with the query container.
      const shared = splitDashboardGrid(changeGridColumns(gridOf(current, undefined), current.grid.columns, nextGrid.columns))
      const scaled = new Map([...shared.items, ...changeGridColumns(current.items.filter((item) => item.page), current.grid.columns, nextGrid.columns)].map((item) => [item.id, item]))
      return { ...next, items: current.items.map((item) => scaled.get(item.id) ?? item), queryContainer: shared.queryContainer }
    })
    setPageEdits({})
  }
  const draftSpec = dashboardDefinition(draft, Boolean(spec?.layout.grid))
  // The draft as the last change left it, so that grids normalizing at once each build on the others.
  const latest = useRef(draft)
  latest.current = draft
  const preview: DashboardPreview = { spec: draftSpec }
  const interaction = useDashboardFilters(kept, chartWidgets, known, queryMode)
  const linking = useDashboardLinks(draftSpec.links ?? [], (link) => linkContext(link, interaction, kept, chartWidgets, known))
  /** A chart widget, or a tab of a tab container, on the canvas: being arranged, it is the box it is in that is selected and removed, or in a tab container the tab. */
  const canvasChart = (box: ChartItem | TabsItem, holder: ChartHolder, look: { frame?: Frame; hideHeader?: boolean; tabs?: ReactNode }, visible = true) => {
    const arranging = previewing ? {} : {
      selected: selectedId === box.id,
      onSelect: () => focusOn(box),
      onConfigure: () => select(box),
      onAddTab: isChart(box) ? () => addTab(box.id) : undefined,
      moveTo: moveTargets(box),
      onRemove: () => isTabs(box) ? setRemovingTab({ item: box.id, tab: holder.id }) : setRemovingId(box.id),
    }
    return holder.chartId
      ? <Widget dashboardId={undefined} exportFrom={{ dashboardId: dashboard?.id, dashboardName: name, unsaved: dirty }} item={holder} {...look} visible={visible} chart={known.find((chart) => chart.id === holder.chartId)}
        conditions={{ filters: kept, values: interaction.values }} colorScheme={colorScheme} board={board} preview={preview} interaction={interaction} linking={linking}
        {...arranging} onDetach={previewing ? undefined : () => rehold(holder.id, undefined)} />
      : <ChartSlot item={holder} {...look} board={board} colorScheme={colorScheme} {...arranging} onChoose={previewing ? undefined : () => { endGroup(); setSelectedId(box.id); setPanel('charts') }} />
  }

  /** A widget on the canvas; on a page out of sight, its charts ask for nothing. */
  const canvasItem = (item: DashboardGridItem, shown: boolean) => {
    if (item.type === 'query') return <QueryContainer frame={item.frame} colorScheme={colorScheme} onReset={interaction.reset} onSelect={previewing ? undefined : focusOnQuery} onConfigure={previewing ? undefined : () => { endGroup(); setSelectedId(undefined); setPanel('query') }} onRemove={previewing ? undefined : () => setRemovingQuery(true)}>
      {shownFilters.length || !pages
        ? <DashboardFilters linking={linking} key={interaction.resetKey} style={filterStyle} filters={kept} shown={shownFilters} interaction={interaction} preview={preview} paramsOf={paramFiltersOf(chartWidgets, known)} />
        : <p className="note small query-container-empty">{t('dashboard.pages.noFilters')}</p>}
    </QueryContainer>
    if (isTabs(item)) {
      // Previewed, as viewed, empty tabs are not offered.
      const offered = previewing ? offeredTabs(item) : item.tabs
      const tab = shownTab(item, offered, activeTabs[item.id])
      if (!tab) return <div className="chart-slot-blank" aria-hidden />
      return <TabsBox item={item} tabs={offered} active={tab.id} nameOf={(tab) => holderName(tab, true)} onActivate={(id) => showTab(item.id, id)} onAdd={previewing ? undefined : () => addTab(item.id)}>
        {(tab, strip, tabShown) => canvasChart(item, tab, { frame: item.frame, tabs: strip }, tabShown && shown)}
      </TabsBox>
    }
    if (!isChart(item)) return <NoteWidget item={item} dashboard={draft} board={board} colorScheme={colorScheme} selected={!previewing && selectedId === item.id}
      onSelect={previewing ? undefined : () => focusOn(item)} onConfigure={previewing ? undefined : () => select(item)} moveTo={previewing ? undefined : moveTargets(item)} onRemove={previewing ? undefined : () => setRemovingId(item.id)} />
    return canvasChart(item, item, { frame: item.frame, hideHeader: item.hideHeader }, shown)
  }
  /** One of the canvas's grids: what is above the tabs, or a page; not split, the whole dashboard. */
  const canvasGrid = (page: string | undefined, shown: boolean) => {
    // Previewed, as viewed, a page with none of its filters shows no query container, and its room is given back.
    const closed = previewing && page === undefined && pages && kept.length > 0 && !shownFilters.length
    const laid = closed ? dashboardGrid(closeUp(onPage(items, undefined), queryContainer, grid.containerGap), false, undefined, 'auto', grid.columns, grid.containerGap) : gridOf(draft, page)
    return <GridLayout items={laid} columns={grid.columns} minWidth={gridMinWidth(grid.columns)} rowHeight={grid.rowHeight} unitScale={gridScale} gap={grid.rowGap} columnGap={grid.columnGap} containerGap={grid.containerGap} autoCompact={grid.autoCompact} editable={!previewing} stackBelow={0}
      handleSelector=".widget-handle, .chart-slot-body, .query-container, .board-note" cancelSelector=".widget-actions, .widget-handle button, .widget-handle a, .chart-slot-body button, .board-note a, .query-container .global-filter, .query-container .query-submit, .query-container-actions"
      onChange={(next) => setGrid(page, next)} dropType={chartDragType} dropSize={{ w: Math.round(grid.columns / 2), h: defaultChartHeight }}
      dropIntoAttribute="data-drop-into" dropIntoExcept={emptyChartDragType} onDropInto={dropInto}
      // Split, widgets are dragged between what is above the tabs and the page shown.
      group={pages && shown ? page ?? '' : undefined}
      onNormalize={(next) => {
        const normalized = withGrid(latest.current, page, next)
        latest.current = normalized
        update(normalized, { replace: true })
        if (!dirty) setStored(JSON.stringify(normalized))
      }}
      onDropItem={(chartId, where, moved) => {
        const item: LayoutItem = { id: newItemId(taken), type: 'chart', ...(chartId === emptyChartDrop ? {} : { chartId }), ...where }
        endGroup(); setGrid(page, [...moved, item]); setSelectedId(item.id)
      }}
      renderItem={(item) => canvasItem(item, shown)}
    />
  }
  const sharedEmpty = Boolean(pages) && !onPage(items, undefined).length && !(kept.length > 0)

  const save = async () => {
    if (!dirty || !name.trim() || saving) return
    if (conflict.needed) { conflict.show(); return }
    endGroup()
    setSaving(true)
    setError(null)
    const body = { name, description, spec: draftSpec as unknown as Record<string, unknown> }
    try {
      if (dashboard) {
        const saved = await unwrap(api.PUT('/dashboards/{id}', { params: { path: { id: dashboard.id } }, body: { ...body, expectedRevision: conflict.base!.revision } }))
        conflict.accept({ ...saved, spec: body.spec })
        setStored(state)
        void reload()
      } else {
        const created = await unwrap(api.POST('/dashboards', { body }))
        conflict.accept(created)
        const folder = search.get('folder')
        // A dashboard made from a folder's menu belongs in that folder.
        if (folder) await unwrap(api.POST('/folders/move', { body: { kind: 'dashboard', id: created.id, folderId: folder } })).catch(() => undefined)
        setStored(state)
        onCreated(created)
        void reload()
        void navigate(`/workbench/dashboards/${created.id}`, { replace: true, state: afterSave })
      }
    } catch (e) {
      const failure = toApiError(e)
      if (!conflict.capture(failure)) setError(failure)
    } finally {
      setSaving(false)
    }
  }

  const applyConflict = (content: SaveContent, latest: Dashboard) => {
    // Earlier states predate the latest revision, which is now the save base.
    // Undoing into one and saving would overwrite the newer changes unprompted.
    reset(dashboardDraft(content))
    setStored(JSON.stringify(dashboardDraft(latest)))
    setSelectedId(undefined)
    setError(null)
  }

  return (
    <div className="dashboard-editor">
      <UnsavedGuard dirty={dirty || pageDirty} />
      <form className="dashboard-editor-bar" onSubmit={(event) => { event.preventDefault(); void save() }}>
        <span className="dashboard-editor-mark"><Icon name="dashboard" size={19} /></span>
        <DashboardName value={name} disabled={saving || previewing} onChange={(name) => { update((current) => ({ ...current, name })); endGroup() }} />
        <span className="dashboard-bar-divider" />
        <div className="dashboard-history-actions">
          <Tooltip title={t('dashboard.undoHint')}><Button variant="ghost" icon={<Icon name="undo" />} aria-label={t('dashboard.undo')} disabled={!canUndo || saving || previewing} onClick={undo} /></Tooltip>
          <Tooltip title={t('dashboard.redoHint')}><Button variant="ghost" icon={<Icon name="redo" />} aria-label={t('dashboard.redo')} disabled={!canRedo || saving || previewing} onClick={redo} /></Tooltip>
        </div>
        <span className="spacer" />
        <div className="dashboard-editor-actions">
          {canManageGrants && dashboard && <Button variant="ghost" disabled={saving} icon={<Icon name="users" />} onClick={() => setGrantsOpen(true)}>{t('dashboard.grants.open')}</Button>}
          <Button variant="ghost" disabled={saving || previewing} aria-label={t('dashboard.pageSettings')} icon={<Icon name="settings" />} onClick={() => { setSelectedId(undefined); setPanel(panel === 'page' ? null : 'page') }}>{t('dashboard.pageSettings')}</Button>
          <span className="dashboard-bar-divider" />
          <Button icon={<Icon name={previewing ? 'edit' : 'eye'} />} disabled={saving || charts.status !== 'ok'} onClick={() => { endGroup(); setPreviewing((current) => !current) }}>{t(previewing ? 'dashboard.exitPreview' : 'dashboard.preview')}</Button>
          <Button variant="primary" type="submit" icon={<Icon name="save" />} loading={saving} disabled={!dirty || !name.trim() || saving}>{saving ? t('common.saving') : t('common.save')}</Button>
        </div>
      </form>
      {error && <div className="dashboard-editor-error"><ErrorAlert error={error} /></div>}
      <SaveConflict state={conflict} local={{ name, description, spec: draftSpec as unknown as Record<string, unknown> }} onApply={applyConflict} prepareLatest={comparableDashboard} />
      <div className={`dashboard-editor-body${previewing ? ' previewing' : ''}`} inert={saving} aria-busy={saving}>
        <nav hidden={previewing} className="dashboard-tool-rail" aria-label={t('dashboard.editorTools')}>
          {tools.map((tool) => <Fragment key={tool.panel}>
            <button type="button" className={`dashboard-tool${(tool.panel === 'filters' ? filtersOpen : panel === tool.panel) ? ' active' : ''}`} aria-label={tool.label} aria-pressed={tool.panel === 'filters' ? filtersOpen : panel === tool.panel} onClick={() => tool.panel === 'filters' ? openFilters() : setPanel(panel === tool.panel ? null : tool.panel)}>
              <span className="dashboard-tool-icon"><Icon name={tool.icon} size={21} />{Boolean(tool.count) && <span className="dashboard-tool-count">{tool.count}</span>}</span>
              <span>{tool.shortLabel ?? tool.label}</span>
            </button>
            {tool.panel === 'charts' && (['title', 'text'] as const).map((type) => <Tooltip key={type} title={t(`dashboard.note.add${type === 'title' ? 'Title' : 'Text'}Hint`)}>
              <button type="button" className="dashboard-tool" aria-label={t(`dashboard.note.add${type === 'title' ? 'Title' : 'Text'}`)} onClick={() => addNote(type)}>
                <span className="dashboard-tool-icon"><Icon name={type === 'title' ? 'heading' : 'paragraph'} size={21} /></span>
                <span>{t(`dashboard.note.${type}`)}</span>
              </button>
            </Tooltip>)}
            {tool.panel === 'charts' && <Tooltip title={t(!pages ? 'dashboard.pages.splitHint' : pages.length >= pageLimits.max ? 'dashboard.pages.full' : 'dashboard.pages.addHint', { count: pageLimits.max })}>
              <button type="button" className="dashboard-tool" aria-label={t(pages ? 'dashboard.pages.add' : 'dashboard.pages.split')} disabled={Boolean(pages && pages.length >= pageLimits.max)} onClick={addPage}>
                <span className="dashboard-tool-icon"><Icon name="tabs" size={21} />{pages && <span className="dashboard-tool-count">{pages.length}</span>}</span>
                <span>{t('dashboard.pages.tool')}</span>
              </button>
            </Tooltip>}
          </Fragment>)}
          <button type="button" className={`dashboard-tool${linksOpen ? ' active' : ''}`} aria-label={t('dashboard.links')} aria-pressed={linksOpen} onClick={() => { endGroup(); setLinksOpen(true) }}><span className="dashboard-tool-icon"><Icon name="link" size={21} />{links.length > 0 && <span className="dashboard-tool-count">{links.length}</span>}</span><span>{t('dashboard.links')}</span></button>
          <div className="spacer" />
          <Tooltip title={t('dashboard.arrangeHint')}><span className="dashboard-tool-help"><Icon name="help" size={18} /></span></Tooltip>
        </nav>
        <main className="dashboard-stage" role={previewing ? 'region' : undefined} aria-label={t(previewing ? 'dashboard.preview' : 'dashboard.canvas')}>
          <div ref={canvas} className="dashboard-canvas-scroll" onPointerDown={(event) => {
            if (previewing) return
            if (!(event.target as HTMLElement).closest('.widget, .board-note, .query-container, .dashboard-filters, .board-page-tabs, button, a, input, .react-resizable-handle')) { setSelectedId(undefined); if (panel === 'widget') setPanel(null) }
          }}>
            <div className="dashboard-canvas">
              <DashboardLinkChips state={linking} />
              {items.length === 0 && !pages && (previewing ? <p className="note">{t('dashboard.emptyBoard')}</p> : <div className="dashboard-empty-canvas"><span className="dashboard-empty-icon"><Icon name="dashboard" size={32} /></span><h3>{t('dashboard.startBuilding')}</h3><p>{t('dashboard.emptyCanvasHint')}</p><Button icon={<Icon name="plus" />} onClick={() => setPanel('charts')}>{t('dashboard.addChart')}</Button></div>)}
              <ScrollArea value={scrollArea}>
                <GridGroup onMove={moveAcross}>
                {!pages ? canvasGrid(undefined, true) : !(previewing && sharedEmpty) && (
                  // Above the tabs: on every page. Being arranged, it says so while it is empty, and takes what is dragged into it.
                  <div className={`board-shared-area${sharedEmpty ? ' empty' : ''}`} aria-label={t('dashboard.pages.shared')} role="region">
                    {canvasGrid(undefined, true)}
                    {sharedEmpty && !previewing && <p className="board-shared-hint note small">{t('dashboard.pages.sharedHint')}</p>}
                  </div>
                )}
                {pages && current && <>
                  <PageTabs pages={pages} active={current.id} onActivate={setChosenPage} onAdd={previewing ? undefined : addPage} onSettings={previewing ? undefined : () => { endGroup(); setSelectedId(undefined); setPanel('pages') }} />
                  <div className="board-pages">
                    {pages.filter((page) => openedPages.includes(page.id)).map((page) => {
                      const shown = page.id === current.id
                      return <div key={page.id} className={`board-page${shown ? ' shown' : ''}`} role="tabpanel" aria-label={page.name} aria-hidden={!shown} inert={!shown}>
                        {previewing && !onPage(items, page.id).length ? <p className="note board-page-empty">{t('dashboard.pages.emptyPage')}</p> : canvasGrid(page.id, shown)}
                      </div>
                    })}
                  </div>
                </>}
                </GridGroup>
              </ScrollArea>
              {charts.status === 'error' && <Alert tone="error" title={t('dashboard.missingChart')} />}
            </div>
          </div>
        </main>
        {panel && (panel !== 'widget' || selected) && (panel !== 'query' || kept.length > 0) && (panel !== 'pages' || pages) && <aside hidden={previewing} className="dashboard-inspector" aria-label={panelTitle}>
          <header className="dashboard-inspector-header"><h2>{panelTitle}</h2><Tooltip title={t('workbench.hidePanel')}><button type="button" className="wb-icon-button" aria-label={t('workbench.hidePanel')} onClick={() => setPanel(null)}><Icon name="close" /></button></Tooltip></header>
          {panel === 'charts' ? <ChartPalette charts={available} used={new Set(ids)} onAdd={add} onAddEmpty={addEmpty} filling={holder && !holder.chartId ? holderName(holder, isTabs(selected!)) : undefined} /> : <div className="dashboard-inspector-content" onBlurCapture={(event) => {
            // The colour panel is a step of its own until it closes, though its focus moves around it.
            if (!(event.target instanceof Element && event.target.closest('.frame-color-picker'))) endGroup()
          }}>
            {panel === 'page' && <>
              <section className="dashboard-property-section"><h3>{t('dashboard.basicSettings')}</h3>
                <Field label={t('common.name')} htmlFor="dashboard-name" required><Input id="dashboard-name" value={pageName} placeholder={t('dashboard.new')} onChange={(name) => setPageEdits((current) => ({ ...current, name }))} /></Field>
                <Field label={t('common.description')} htmlFor="dashboard-description"><TextArea id="dashboard-description" value={pageDescription} placeholder={t('common.addDescription')} rows={3} onChange={(description) => setPageEdits((current) => ({ ...current, description }))} /></Field>
              </section>
              <section className="dashboard-property-section"><h3>{t('dashboard.canvasLayout')}</h3>
                <Segmented block aria-label={t('dashboard.canvasLayout')} value="grid" onChange={() => {}} options={[{ value: 'grid', label: t('dashboard.gridLayout') }]} />
                <div className="dashboard-layout-preview" aria-hidden>{Array.from({ length: grid.columns }, (_, index) => <span key={index} />)}</div>
                <GridSettingsFields value={pageGrid} onChange={(grid) => setPageEdits((current) => ({ ...current, grid }))} />
              </section>
              <section className="dashboard-property-section"><h3>{t('dashboard.autoRefresh')}</h3>
                <Select<number> block aria-label={t('dashboard.autoRefresh')} value={pageAutoRefresh} options={[0, ...autoRefreshIntervals].map((value) => ({ value, label: autoRefreshLabel(value, t) }))} onChange={(autoRefresh) => setPageEdits((current) => ({ ...current, autoRefresh }))} />
                <p className="note small">{t('dashboard.autoRefreshHint')}</p>
              </section>
              <section className="dashboard-property-section"><h3>{t('dashboard.frame.pageTitle')}</h3>
                <p className="note small">{t('dashboard.frame.pageHint')}</p>
                <FrameSettings id="page-frame" frame={frameOf('chart', undefined, pageFrame)} scheme={colorScheme} onChange={(frame) => setPageEdits((current) => ({ ...current, frame: keptFrame(frame, frameOf('chart', undefined)) ?? null }))} />
              </section>
              <section className="dashboard-property-section"><h3>{t('dashboard.contents')}</h3>
                {pages && <div className="row note"><Icon name="tabs" /><span>{t('dashboard.pages.count', { count: pages.length })}</span></div>}
                <div className="row note"><Icon name="chart" /><span>{t('dashboard.chartCount', { count: chartWidgets.length })}</span></div>
                {items.some(isTabs) && <div className="row note"><Icon name="tabs" /><span>{t('dashboard.tabs.count', { count: items.filter(isTabs).length })}</span></div>}
                {chartHolders(items).some((holder) => !holder.chartId) && <div className="row note"><Icon name="frame" /><span>{t('dashboard.container.emptyCount', { count: chartHolders(items).filter((holder) => !holder.chartId).length })}</span></div>}
                {(['title', 'text'] as const).map((type) => { const count = items.filter((item) => item.type === type).length; return count > 0 && <div key={type} className="row note"><Icon name={type === 'title' ? 'heading' : 'paragraph'} /><span>{t(`dashboard.note.${type}Count`, { count })}</span></div> })}
              </section>
              <section className="dashboard-property-section"><h3>{t('revisions.title')}</h3>
                <RevisionList kind="dashboard" id={savedBoard?.id} revision={savedBoard?.revision} />
              </section>
            </>}
            {panel === 'pages' && pages && <section className="dashboard-property-section"><h3>{t('dashboard.pages.list')}</h3>
              <PageList pages={pages} shown={current?.id} onShow={setChosenPage} onRename={renamePage} onMove={placePage} onRemove={setRemovingPage} />
              <div><Button size="sm" icon={<Icon name="plus" />} disabled={pages.length >= pageLimits.max} onClick={addPage}>{t('dashboard.pages.add')}</Button></div>
              <p className="note small">{t(pages.length >= pageLimits.max ? 'dashboard.pages.full' : 'dashboard.pages.listHint', { count: pageLimits.max })}</p>
            </section>}
            {panel === 'query' && <>
              <section className="dashboard-property-section"><h3>{t('dashboard.containerProperties')}</h3>
                <span className="note small">{t('dashboard.queryHeight')}</span>
                <Segmented block aria-label={t('dashboard.queryHeight')} value={queryHeightMode ?? 'auto'} onChange={(queryHeightMode) => update((current) => ({ ...current, queryHeightMode }))} options={(['auto', 'manual'] as const).map((value) => ({ value, label: t(`dashboard.queryHeight${value === 'auto' ? 'Auto' : 'Manual'}`) }))} />
              </section>
              <section className="dashboard-property-section"><h3>{t('dashboard.frame.title')}</h3>
                <FrameSettings id="query-frame" frame={frameOf('query', queryContainer?.frame)} scheme={colorScheme} onChange={frameQuery} onPicked={endGroup} />
              </section>
              <section className="dashboard-property-section"><FilterStyleSettings style={filterStyle} onChange={(filterStyle) => update((current) => ({ ...current, filterStyle }))} /></section>
              <section className="dashboard-property-section"><h3>{t('dashboard.querySettings')}</h3>
                <span className="note small">{t('dashboard.queryTrigger')}</span>
                <Segmented block aria-label={t('dashboard.queryTrigger')} value={queryMode ?? 'auto'} onChange={(queryMode) => update((current) => ({ ...current, queryMode }))} options={(['auto', 'manual'] as const).map((value) => ({ value, label: t(`dashboard.queryMode${value === 'auto' ? 'Auto' : 'Manual'}`) }))} />
              </section>
            </>}
            {panel === 'widget' && selected && <>
              <section className="dashboard-property-section"><div className="dashboard-selected-chart"><span><Icon name={isChart(selected) ? selected.chartId ? 'chart' : 'frame' : isTabs(selected) ? 'tabs' : selected.type === 'title' ? 'heading' : 'paragraph'} size={22} /></span><div>
                <strong>{isChart(selected) || isTabs(selected) ? nameOf(selected) : t(`dashboard.note.${selected.type}`)}</strong>
                <p className="note small">{isChart(selected) ? t(selected.chartId ? 'dashboard.chartComponent' : 'dashboard.container.emptyComponent') : isTabs(selected) ? t('dashboard.tabs.component', { count: selected.tabs.length }) : t(`dashboard.note.${selected.type}Component`)}</p>
              </div></div></section>
              {isChart(selected) && <section className="dashboard-property-section"><h3>{t('dashboard.container.title')}</h3>
                <Field label={t('dashboard.container.name')} htmlFor="widget-name" hint={t('dashboard.container.nameHint')}><Input id="widget-name" value={selected.title ?? ''} maxLength={noteLimits.title} placeholder={selectedChart?.name ?? t('dashboard.container.namePlaceholder')} onChange={(title) => writeChart(selected.id, { title }, 'title')} /></Field>
                <Field label={t('dashboard.container.note')} htmlFor="widget-note" hint={t('dashboard.container.noteHint')}><TextArea id="widget-note" rows={3} value={selected.note ?? ''} maxLength={noteLimits.note} onChange={(note) => writeChart(selected.id, { note }, 'note')} /></Field>
                <div className="field"><Checkbox checked={Boolean(selected.hideHeader)} onChange={(hideHeader) => writeChart(selected.id, { hideHeader })}>{t('dashboard.container.hideHeader')}</Checkbox><p className="note small">{t('dashboard.container.hideHeaderHint')}</p></div>
                <div className="field"><div><Button size="sm" icon={<Icon name="tabs" />} onClick={() => addTab(selected.id)}>{t('dashboard.tabs.addTabsButton')}</Button></div><p className="note small">{t('dashboard.tabs.addTabsHint')}</p></div>
              </section>}
              {isTabs(selected) && <section className="dashboard-property-section"><h3>{t('dashboard.container.title')}</h3>
                <TabList item={selected} shown={holder?.id} nameOf={(tab) => holderName(tab, true)} onShow={(tabId) => showTab(selected.id, tabId)}
                  onDefault={(tabId) => setDefaultTab(selected.id, tabId)} onMove={(tabId, to) => placeTab(selected.id, tabId, to)} onRemove={(tabId) => setRemovingTab({ item: selected.id, tab: tabId })} />
                <div><Button size="sm" icon={<Icon name="plus" />} disabled={selected.tabs.length >= tabLimits.max} onClick={() => addTab(selected.id)}>{t('dashboard.tabs.add')}</Button></div>
                <p className="note small">{t(selected.tabs.length >= tabLimits.max ? 'dashboard.tabs.full' : 'dashboard.tabs.listHint', { count: tabLimits.max })}</p>
              </section>}
              {isTabs(selected) && holder && <section className="dashboard-property-section"><h3>{t('dashboard.tabs.tab')}</h3>
                <Field label={t('dashboard.container.name')} htmlFor="tab-name" hint={t('dashboard.tabs.nameHint')}><Input id="tab-name" value={holder.title ?? ''} maxLength={noteLimits.title} placeholder={selectedChart?.name ?? t('dashboard.container.namePlaceholder')} onChange={(title) => writeChart(holder.id, { title }, 'title')} /></Field>
                <Field label={t('dashboard.container.note')} htmlFor="tab-note" hint={t('dashboard.container.noteHint')}><TextArea id="tab-note" rows={3} value={holder.note ?? ''} maxLength={noteLimits.note} onChange={(note) => writeChart(holder.id, { note }, 'note')} /></Field>
              </section>}
              {selected.type === 'title' && <section className="dashboard-property-section"><h3>{t('dashboard.note.content')}</h3>
                <Checkbox checked={Boolean(selected.useDashboardName)} onChange={(use) => writeNote(selected.id, use
                  ? { useDashboardName: true, title: undefined, subtitle: undefined }
                  // Starting from what it showed, to change from there.
                  : { useDashboardName: false, title: name.slice(0, noteLimits.title), subtitle: description.slice(0, noteLimits.subtitle) })}>{t('dashboard.note.useDashboardName')}</Checkbox>
                {selected.useDashboardName
                  ? <p className="note small">{t('dashboard.note.useDashboardNameHint')}</p>
                  : <>
                    <Field label={t('dashboard.note.titleText')} htmlFor="note-title"><Input id="note-title" value={selected.title ?? ''} maxLength={noteLimits.title} placeholder={t('dashboard.note.emptyTitle')} onChange={(title) => writeNote(selected.id, { title }, 'title')} /></Field>
                    <Field label={t('dashboard.note.subtitle')} htmlFor="note-subtitle"><TextArea id="note-subtitle" rows={2} value={selected.subtitle ?? ''} maxLength={noteLimits.subtitle} onChange={(subtitle) => writeNote(selected.id, { subtitle }, 'subtitle')} /></Field>
                  </>}
              </section>}
              {selected.type === 'title' && <section className="dashboard-property-section"><h3>{t('dashboard.note.style')}</h3>
                <div className="field"><span className="note small">{t('dashboard.note.align')}</span>
                  <Segmented block aria-label={t('dashboard.note.align')} value={selected.style?.align ?? 'left'} onChange={(align) => styleTitle(selected.id, { align })} options={(['left', 'center', 'right'] as const).map((value) => ({ value, label: t(`dashboard.note.aligns.${value}`) }))} />
                </div>
                <div className="field"><span className="note small">{t('dashboard.note.verticalAlign')}</span>
                  <Segmented block aria-label={t('dashboard.note.verticalAlign')} value={selected.style?.verticalAlign ?? 'middle'} onChange={(verticalAlign) => styleTitle(selected.id, { verticalAlign })} options={(['top', 'middle', 'bottom'] as const).map((value) => ({ value, label: t(`dashboard.note.verticalAligns.${value}`) }))} />
                </div>
              </section>}
              {selected.type === 'text' && <section className="dashboard-property-section"><h3>{t('dashboard.note.content')}</h3>
                <Field label={t('dashboard.note.markdown')} htmlFor="note-markdown" hint={t('dashboard.note.markdownHint')}><TextArea id="note-markdown" rows={14} value={selected.markdown ?? ''} maxLength={noteLimits.markdown} placeholder={t('dashboard.note.markdownPlaceholder')} onChange={(markdown) => writeNote(selected.id, { markdown }, 'markdown')} /></Field>
              </section>}
              <section className="dashboard-property-section"><h3>{t('dashboard.frame.title')}</h3>
                <FrameSettings id="widget-frame" frame={frameOf(selected.type, selected.frame, board)} scheme={colorScheme} onChange={(frame, live) => frameItem(selected.id, frame, live)} onPicked={endGroup} />
                {selected.type !== 'title' && board && <p className="note small">{t('dashboard.frame.followsPage')}</p>}
              </section>
              <section className="dashboard-property-section"><h3>{t('dashboard.componentSize')}</h3><div className="dashboard-size-fields">
                <Field label={t('dashboard.width')} htmlFor="widget-width"><Select id="widget-width" block value={selected.w} options={[...new Set([...Array.from({ length: grid.columns - gridMinWidth(grid.columns) + 1 }, (_, index) => index + gridMinWidth(grid.columns)), selected.w])].sort((a, b) => a - b).map((w) => ({ value: w, label: t('dashboard.gridColumns', { count: w }) }))} onChange={(w) => setItems((current) => current.map((item) => item.id === selected.id ? { ...item, w, x: Math.min(item.x, grid.columns - w) } : item))} /></Field>
                <Field label={t('dashboard.height')} htmlFor="widget-height"><Select id="widget-height" block value={selected.h} options={[...new Set([...Array.from({ length: maxItemHeight - minItemHeight(selected) + 1 }, (_, index) => index + minItemHeight(selected)), selected.h])].sort((a, b) => a - b).map((h) => ({ value: h, label: t('dashboard.gridRows', { count: h }) }))} onChange={(h) => setItems((current) => current.map((item) => item.id === selected.id ? { ...item, h } : item))} /></Field>
              </div><p className="note small">{t(isChart(selected) || isTabs(selected) ? 'dashboard.resizeHint' : 'dashboard.note.resizeHint')}</p></section>
              {holder && <section className="dashboard-property-section"><h3>{t('dashboard.container.chart')}</h3>
                {holder.chartId ? <>
                  <div className="row note"><Icon name="chart" size={14} /><span>{selectedChart?.name ?? t('dashboard.missingChart')}</span></div>
                  {selectedChart && <Link className="dashboard-chart-link" target="_blank" rel="noopener noreferrer" to={`/workbench/charts/${selectedChart.id}`}><Icon name="external" size={14} />{t('dashboard.editSourceChart')}</Link>}
                  <p className="note small">{t('dashboard.container.replaceHint')}</p>
                  <Button size="sm" icon={<Icon name="detach" />} onClick={() => rehold(holder.id, undefined)}>{t('dashboard.container.detachButton')}</Button>
                </> : <>
                  <p className="note small">{t('dashboard.container.chooseHint')}</p>
                  <Button size="sm" icon={<Icon name="chart" />} onClick={() => { endGroup(); setPanel('charts') }}>{t('dashboard.container.choose')}</Button>
                </>}
              </section>}
              {holder?.chartId && <section className="dashboard-property-section"><h3>{t('dashboard.filters')}</h3>{kept.filter((filter) => filter.targets.some((target) => target.item === holder.id)).map((filter) => <div className="dashboard-associated-filter" key={filter.id}><Icon name="filter" size={14} /><span>{filter.label}</span></div>)}
                {!kept.some((filter) => filter.targets.some((target) => target.item === holder.id)) && <p className="note small">{t('dashboard.noAssociatedFilters')}</p>}
                <Button size="sm" onClick={openFilters}>{t('dashboard.configureFilters')}</Button>
              </section>}
              {selectedChart && <section className="dashboard-property-section"><h3>{t('dashboard.dataExport')}</h3>
                {(selectedChart.spec as unknown as ChartSpec).allowExport
                  ? <><div className="row note"><Icon name="download" size={14} /><span>{t('dashboard.exportAllowed')}</span></div><p className="note small">{t('dashboard.exportAllowedHint')}</p></>
                  : <><div className="row note"><Icon name="lock" size={14} /><span>{t('dashboard.exportNotAllowed')}</span></div><p className="note small">{t('dashboard.exportNotAllowedHint')}</p></>}
              </section>}
              <div className="dashboard-property-section"><Button danger icon={<Icon name="trash" />} onClick={() => setRemovingId(selected.id)}>{t('dashboard.removeComponent')}</Button></div>
            </>}
          </div>}
          {panel === 'page' && <footer className="dashboard-settings-footer">
            <Button variant="primary" disabled={!pageDirty || !pageName.trim() || saving} onClick={applyPageSettings}>{t('dashboard.applyPageSettings')}</Button>
          </footer>}
        </aside>}
      </div>
      {canManageGrants && grantsOpen && dashboard && <DashboardGrantsDialog dashboardId={dashboard.id} onClose={() => setGrantsOpen(false)} />}
      {linksOpen && <DashboardLinksDialog links={links} items={chartWidgets} charts={known} fields={fields} loading={datasets.status === 'loading'} error={datasets.status === 'error' ? datasets.error : undefined} onRetry={datasets.reload} onCancel={() => setLinksOpen(false)} onDone={(links) => { if (JSON.stringify(links) !== JSON.stringify(draft.links)) update((current) => ({ ...current, links })); setLinksOpen(false) }} />}
      {filtersOpen && <GlobalFiltersDialog filters={kept} fields={fields} groups={pages && [undefined, ...pages].map((page) => ({ id: page?.id ?? '', label: page?.name ?? t('dashboard.pages.shared'), items: chartItems(onPage(items, page?.id)).map((item) => item.id) }))} error={datasets.status === 'error' ? datasets.error : undefined} onRetry={datasets.reload} onCancel={() => setFiltersOpen(false)} onDone={(filters) => {
        if (JSON.stringify(filters) === JSON.stringify(kept)) { setFiltersOpen(false); return }
        update((current) => {
          // Materialize the legacy top strip in the same grid when configuration is confirmed.
          const layout = splitDashboardGrid(dashboardGrid(onPage(current.items, undefined), filters.length > 0, current.queryContainer, current.queryHeightMode, current.grid.columns, current.grid.containerGap))
          return { ...current, items: replaceOnPage(current.items, undefined, layout.items), queryContainer: layout.queryContainer, filters }
        })
        setFiltersOpen(false)
      }} />}
      <Dialog open={removingQuery} title={t('dashboard.removeQueryContainer')} width={420} onClose={() => setRemovingQuery(false)}
        actions={<><Button onClick={() => setRemovingQuery(false)}>{t('common.cancel')}</Button><Button danger onClick={() => { update((current) => ({ ...current, filters: [], queryContainer: undefined, filterStyle: undefined, queryMode: undefined, queryHeightMode: undefined })); setRemovingQuery(false) }}>{t('dashboard.removeQueryContainer')}</Button></>}>
        <p>{t('dashboard.removeQueryContainerConfirm')}</p>
      </Dialog>
      <Dialog open={Boolean(removing)} title={t('dashboard.removeComponent')} width={420} onClose={() => setRemovingId(undefined)}
        actions={<><Button onClick={() => setRemovingId(undefined)}>{t('common.cancel')}</Button><Button danger onClick={() => { if (removing) remove(removing.id); setRemovingId(undefined) }}>{t('dashboard.removeComponent')}</Button></>}>
        <p>{t(removing?.type === 'title' || removing?.type === 'text' ? 'dashboard.note.removeConfirm' : 'dashboard.removeComponentConfirm', { name: removingName })}</p>
      </Dialog>
      <Dialog open={Boolean(tabRemoved)} title={t('dashboard.tabs.removeTabTitle')} width={420} onClose={() => setRemovingTab(undefined)}
        actions={<><Button onClick={() => setRemovingTab(undefined)}>{t('common.cancel')}</Button><Button danger onClick={() => { if (removingTab) removeTab(removingTab.item, removingTab.tab); setRemovingTab(undefined) }}>{t('dashboard.tabs.removeTabTitle')}</Button></>}>
        <p>{t(removingFrom && removingFrom.tabs.length <= tabLimits.min ? 'dashboard.tabs.removeLastConfirm' : 'dashboard.tabs.removeTabConfirm', { name: tabRemoved ? holderName(tabRemoved, true) : '' })}</p>
      </Dialog>
      <Dialog open={Boolean(pageRemoved)} title={t('dashboard.pages.removeTitle')} width={420} onClose={() => setRemovingPage(undefined)}
        actions={<><Button onClick={() => setRemovingPage(undefined)}>{t('common.cancel')}</Button><Button danger onClick={() => { if (removingPage) removePage(removingPage); setRemovingPage(undefined) }}>{t('dashboard.pages.removeTitle')}</Button></>}>
        <p>{t(onPage(items, pageRemoved?.id).length ? 'dashboard.pages.removeConfirm' : 'dashboard.pages.removeEmptyConfirm', { name: pageRemoved?.name ?? '', count: onPage(items, pageRemoved?.id).length })}</p>
        {pages && pages.length <= pageLimits.min && <p className="note small">{t('dashboard.pages.removeLastHint')}</p>}
      </Dialog>
      <Dialog open={Boolean(replacingItem)} title={t('dashboard.container.replaceTitle')} width={460} onClose={() => setReplacing(undefined)}
        actions={<><Button onClick={() => setReplacing(undefined)}>{t('common.cancel')}</Button><Button variant="primary" onClick={() => { if (replacing) { rehold(replacing.itemId, replacing.chartId); setSelectedId(boxOf(replacing.itemId)?.id) } setReplacing(undefined) }}>{t('dashboard.container.replace')}</Button></>}>
        <p>{t('dashboard.container.replaceConfirm', { from: replacingItem ? holderName(replacingItem) : '', to: replacingWith?.name ?? '' })}</p>
      </Dialog>
    </div>
  )
}

/** A dashboard as its readers see it. */
export function DashboardView({ colorScheme }: { colorScheme: ColorScheme }) {
  const { t } = useTranslation()
  const { id } = useParams()
  const session = useSession()
  const [search] = useSearchParams()
  // Read once: the view leaves the address when the viewer changes the conditions, and must not be read again then.
  const [link] = useState(() => ({ workspace: search.get('ws') ?? undefined, view: search.get('view') ?? undefined }))
  const info = session.state.status === 'ok' ? session.state.data : undefined
  // A share link from another workspace: one the viewer can enter, or null for one they cannot.
  const elsewhere = link.workspace && info?.workspace?.id !== link.workspace ? info?.workspaces?.find((workspace) => workspace.id === link.workspace) ?? null : undefined
  const loaded = useAsync(async () => {
    if (elsewhere !== undefined) return undefined
    const [dashboard, view] = await Promise.all([
      unwrap(api.GET('/dashboards/{id}', { params: { path: { id: id! } } })),
      link.view
        ? unwrap(api.GET('/dashboards/{id}/views/{viewId}', { params: { path: { id: id!, viewId: link.view } } })).catch((error: unknown) => {
          // Expired conditions leave the dashboard as it is by default; other failures are failures.
          if (toApiError(error).code === 'view_not_found') return null
          throw error
        })
        : Promise.resolve(undefined),
    ])
    return { dashboard, view }
  }, [id, elsewhere === undefined])

  if (elsewhere === null || (loaded.status === 'error' && loaded.error.code === 'not_found')) return <Alert tone="warning" title={t('dashboard.unavailable')} />
  if (elsewhere) return <OtherWorkspace name={elsewhere.name} current={info?.workspace?.name ?? ''} workspaceId={elsewhere.id} />
  return (
    <Async state={loaded} reload={loaded.reload}>
      {(result) => {
        if (!result) return null
        const { dashboard, view } = result
        const applied = view ? applicableState(view.state, dashboard.spec as unknown as DashboardSpec, dashboard.charts) : undefined
        const notice = view === null ? t('dashboard.share.expired') : applied?.dropped ? t('dashboard.share.partial') : undefined
        return <View key={`${dashboard.id}:${dashboard.updatedAt}`} dashboard={dashboard} colorScheme={colorScheme} shared={applied?.state} notice={notice} />
      }}
    </Async>
  )
}

/**
 * Offers to move to the workspace a share link's dashboard is in. The session,
 * and with it every tab of the browser, moves too, so it waits for a click.
 */
function OtherWorkspace({ name, current, workspaceId }: { name: string; current: string; workspaceId: string }) {
  const { t } = useTranslation()
  const actions = useSessionActions((destination = '/') => window.location.assign(destination))
  return (
    <section className="card stack">
      <p>{t('dashboard.otherWorkspace', { name, current })}</p>
      <p className="note small">{t('dashboard.switchWorkspaceHint')}</p>
      <div>
        <Button variant="primary" loading={actions.pending} onClick={() => actions.switchWorkspace(workspaceId, window.location.pathname + window.location.search)}>{t('dashboard.switchWorkspace', { name })}</Button>
      </div>
      {actions.error && <ErrorAlert error={actions.error} />}
    </section>
  )
}

/** The dashboard editor of the workbench, for a new dashboard or an existing one. */
export function DashboardEditor({ colorScheme }: { colorScheme: ColorScheme }) {
  const { id } = useParams()
  const { resources } = useWorkbench()
  // Keep the new editor mounted through its first save and URL update.
  const [created, setCreated] = useState<Dashboard>()
  const dashboard = useAsync(() => (id ? unwrap(api.GET('/dashboards/{id}', { params: { path: { id } } })) : Promise.resolve(undefined)), [id])
  const createdFallback = dashboard.status !== 'ok' && created?.id === id && created
  return (
    <Async state={createdFallback ? { status: 'ok', data: createdFallback } : dashboard} reload={dashboard.reload}>
      {(loaded) => <Editor key={loaded?.id === created?.id ? 'new' : loaded?.id ?? 'new'} dashboard={loaded} available={resources.charts} colorScheme={colorScheme} onCreated={setCreated} />}
    </Async>
  )
}
