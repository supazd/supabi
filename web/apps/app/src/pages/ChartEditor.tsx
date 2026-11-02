import { Alert, Button, Checkbox, Dialog, Input, Menu, Segmented, Select, Tooltip, type ColorScheme, type MenuItem } from '@supabi/ui'
import { applyFormats, groupsOf, layoutColumns, type ColumnItem, type DisplayFormat, type NumberFormat } from '@supabi/charts'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { ApiError, api, unwrap, type Chart, type Dataset, type LogicalType, type QueryResult } from '../api/client'
import { aggResultType, fieldRoles, foldLabel, isNumeric, isTemporal, makeKey, type DatasetSpec, type FieldRole, type SpecField } from '../api/spec'
import { toApiError, useAsync } from '../api/useAsync'
import { Async } from '../components/Async'
import { ChartView, namedColumns } from '../components/ChartView'
import { ChartFilterBar } from '../components/ChartFilterBar'
import { ChartStyleSettings } from '../components/ChartStyleSettings'
import { ColumnGroupTools } from '../components/ColumnGroupTools'
import { ConfigSection } from '../components/ConfigSection'
import { DatasetPicker } from '../components/DatasetPicker'
import { DynamicControls } from '../components/DynamicControls'
import { DynamicFieldDialog } from '../components/DynamicFieldDialog'
import { ErrorAlert } from '../components/ErrorAlert'
import { FilterControl, FilterLabel, filterCaption, type LoadOptions } from '../components/FilterControl'
import { FilterDialog } from '../components/FilterDialog'
import { ParamFilterControl } from '../components/ParamFilterControl'
import { ParamFilterDialog } from '../components/ParamFilterDialog'
import { ComputeDialog } from '../components/ComputeDialog'
import { FormatDialog } from '../components/FormatDialog'
import { HighlightDialog } from '../components/HighlightDialog'
import { Icon, type IconName } from '../components/Icon'
import { TitleText } from '../components/TitleText'
import { QueryDiagnostics, type QueryNotice } from '../components/QueryDiagnostics'
import { ResultRows } from '../components/ResultRows'
import { RevisionList } from '../components/RevisionList'
import { TypeMark } from '../components/TypeMark'
import { addMeasure, aggOptions, buildSpec, chartDrillProblem, drillableColumns, drilled, grains, groupingOf, hasSubtotals, measureName, needsVisibleColumn, otherGroupings, outputNames, pruneColumnGroups, pruneComputes, pruneDrill, pruneHiddenColumns, reaggregated, recomputed, restore, shapeProblem, sortedBy, subtotalsFit, withoutStaleSort, withType, type BuilderState, type BuilderType, type ChartSpec, type Grain, type PickedMeasure } from '../lib/builder'
import { drillDown, drilledInto, drillPath, type DrillPosition } from '../lib/drill'
import { DrillCrumbs } from '../components/DrillCrumbs'
import { DrillDialog } from '../components/DrillDialog'
import { useFirstWeekDays, useQueryRows, useWorkspaceTimezone } from '../auth/session'
import { ancestorsKey, useCascadeChange } from '../lib/cascade'
import { groupPicked, pickHeader, pickedPaths, renameGroup, ungroup, type HeaderPick } from '../lib/columnGroups'
import { dropIndex, moveOnShelf, placedOnShelf, shelfKeys, type Shelf } from '../lib/shelves'
import { accumulates, computeName, percentCompute } from '../lib/computes'
import { aggCodes, aggLabel } from '../lib/aggregations'
import { canCascade, describeCondition, filterProblem, filterable, newFilter, withFilters, type ChartFilter } from '../lib/filters'
import { datasetParams, isFieldFilter, isParamFilter, newParamFilter, paramControl, paramDefault, paramFilterProblem, paramValueSummary, paramsNeedingValue, withParamValues, type ParamFilter } from '../lib/paramFilters'
import type { SqlParam } from '../lib/params'
import { dynamicLimits, dynamicOutputProblem, hasQueryOutput, resolveDynamicSpec, useDynamicSelections, type DynamicField } from '../lib/dynamics'
import { useWorkbench } from '../workbench/context'
import { useStored } from '../lib/useStored'
import { BottomPanel, Resizer, StatusItem, UnsavedGuard, afterSave } from '../workbench/slots'
import { Usages } from '../workbench/Usages'
import { SaveConflict, useSaveConflict } from '../components/SaveConflict'
import type { SaveContent } from '../lib/saveConflict'

// Every kind of chart, in the order they are offered, each with its picture.
// A table is one kind whether it groups the rows or lists them as they are:
// which of the two is chosen beside it (see tableModes).
const vizIcons: [BuilderType, IconName][] = [
  ['bar', 'chart'],
  ['hbar', 'hbar'],
  ['line', 'line'],
  ['area', 'area'],
  ['combo', 'combo'],
  ['pie', 'pie'],
  ['funnel', 'funnel'],
  ['treemap', 'treemap'],
  ['scatter', 'scatter'],
  ['heatmap', 'heatmap'],
  ['sankey', 'sankey'],
  ['gauge', 'gauge'],
  ['kpi', 'number'],
  ['table', 'table'],
  ['pivot', 'pivot'],
]
const tableModes = ['table', 'detail'] as const
// Where a field can be put: dimensions group the rows and metrics are what is
// computed for each group; a detail table has columns instead, and no groups.
// A filter restricts the result without adding a result column.
// A pivot table's dimensions run down the side, on the dimension shelf, or across the top.
type DraggedField = { type: 'field'; field: SpecField } | { type: 'dynamic'; kind: DynamicField['kind'] } | { type: 'param'; param: SqlParam } | { type: 'chip'; shelf: Shelf; key: string }

/** An output column that can be given a display format, and what applies to it without one. */
interface ColumnFormat {
  column: string
  type: LogicalType
  /** The dataset's format for it; a count has none. */
  inherited: DisplayFormat | undefined
}

interface Outcome {
  result: QueryResult
  spec: ChartSpec
  /** What was asked for, to tell whether it is still what is asked for. */
  asked: string
}

const emptySpec = { fields: [] as SpecField[] }
const emptyState = (): BuilderState => ({ dimensions: [], measures: [], columns: [], labels: {}, grain: 'month', filters: [], vizType: 'detail', stacked: false })

/** Preview choices never change saved defaults, and expire when their filter changes. */
function usePreviewFilters(datasetId: string | undefined, filters: (ChartFilter | ParamFilter)[]) {
  const keys = Object.fromEntries(filters.filter((filter) => filter.control).map((filter) => [filter.id, JSON.stringify([datasetId, filter])]))
  const key = JSON.stringify(keys)
  const [stored, setStored] = useState({ key, keys, values: {} as Record<string, unknown> })
  let current = stored
  if (stored.key !== key) {
    // Reconcile before querying so an old value cannot reach a new field or condition.
    current = { key, keys, values: Object.fromEntries(Object.entries(stored.values).filter(([id]) => keys[id] !== undefined && keys[id] === stored.keys[id])) }
    setStored(current)
  }
  return {
    keys,
    values: current.values,
    setValue: (id: string, value: unknown) => setStored((current) => current.keys[id] !== keys[id] ? current : {
      ...current, values: { ...current.values, [id]: value ?? null },
    }),
    setValues: (values: Record<string, unknown>) => setStored((current) => current.key !== key ? current : { ...current, values: { ...values } }),
  }
}

/**
 * The most rows a chart asks for. What is typed is taken when it is left or
 * Enter is pressed, so the chart is not asked for again at every digit; left
 * empty, the server's default applies.
 */
function RowLimit({ value, disabled, paged, onChange }: { value: number | undefined; disabled: boolean; paged: boolean; onChange: (value: number | undefined) => void }) {
  const { t } = useTranslation()
  const id = useId()
  const rows = useQueryRows()
  const [draft, setDraft] = useState<string | null>(null)
  const text = draft ?? (value === undefined ? '' : String(value))
  const parsed = text.trim() ? Number(text) : undefined
  const valid = parsed === undefined || (Number.isInteger(parsed) && parsed >= 1 && parsed <= (rows?.max ?? Infinity))
  // A number that is no number of rows stays, with what is wrong with it, until it is put right.
  const commit = () => {
    if (draft === null || !valid) return
    if (parsed !== value) onChange(parsed)
    setDraft(null)
  }
  return (
    <div className="chart-row-limit" onBlur={commit} onKeyDown={(event) => event.key === 'Enter' && commit()}>
      <label htmlFor={id} className="small">{t('explore.limit')}</label>
      <Input id={id} size="sm" type="number" min={1} max={rows?.max} step={1} value={text} invalid={!valid} disabled={disabled} placeholder={rows && t('explore.limitDefault', { count: rows.default })} onChange={setDraft} />
      {!valid && <span className="note small warning">{t('explore.limitRange', { max: rows?.max })}</span>}
      {/* With pages, what is taken is what the pages turn through, not what one page shows. */}
      {paged && <span className="note small">{t('explore.limitPaged')}</span>}
    </div>
  )
}

function Builder({ chart, colorScheme, editorKey }: { chart?: Chart; colorScheme: ColorScheme; editorKey: string }) {
  const { t } = useTranslation()
  const queryRows = useQueryRows()
  const navigate = useNavigate()
  const [search, setSearch] = useSearchParams()
  const { reload } = useWorkbench()
  const conflict = useSaveConflict('chart', chart)
  const acceptRevision = conflict.accept
  const datasetLoad = useRef(0)
  const [dataset, setDataset] = useState<Dataset>()
  const [datasetRequest, setDatasetRequest] = useState(() => ({ id: chart?.datasetId ?? search.get('dataset') ?? '', initial: true, attempt: 0 }))
  const [loadingDataset, setLoadingDataset] = useState(Boolean(datasetRequest.id))
  const [datasetError, setDatasetError] = useState<ApiError | null>(null)
  const [pendingDataset, setPendingDataset] = useState<string | null>(null)
  const spec = (dataset?.spec as DatasetSpec | undefined) ?? emptySpec
  const visible = useMemo(() => spec.fields.filter((field) => !field.hidden), [spec])
  // The dataset's parameters, and those its SQL cannot run without.
  const params = useMemo(() => datasetParams(dataset?.spec), [dataset])
  const needing = useMemo(() => paramsNeedingValue((dataset?.spec as DatasetSpec | undefined)?.source.sql, params), [dataset, params])
  const paramOf = (filter: ParamFilter) => params.find((param) => param.name === filter.param)

  // A chart this page could not have written is shown, not edited.
  const [readOnly, setReadOnly] = useState(false)

  // A new chart starts as a detail table with nothing on it: the rows as they are, once fields are dragged in.
  const [state, setState] = useState<BuilderState>(emptyState)
  const [name, setName] = useState(chart?.name ?? '')
  const [description, setDescription] = useState(chart?.description ?? '')
  const [running, setRunning] = useState(false)
  const [queryNotice, setQueryNotice] = useState<QueryNotice>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [resolvedDraft, setResolvedDraft] = useState(0)
  const [filter, setFilter] = useState('')
  const [fieldsWidth, setFieldsWidth] = useStored('supabi.chart.fieldsWidth', 220)
  const [configWidth, setConfigWidth] = useStored('supabi.chart.configWidth', 184)
  const [autoRun, setAutoRun] = useStored('supabi.chart.autoRun', true)
  // The field being dragged from the list, and the shelf it is over.
  const dragged = useRef<DraggedField | null>(null)
  // Where what is dragged over a shelf would go, drawn as a line between its items.
  const [dropAt, setDropAt] = useState<{ shelf: Shelf; at: number } | null>(null)
  // Where a new dynamic field goes once it is set up.
  const dynamicAt = useRef<number | undefined>(undefined)
  // What was moved from the keyboard, to be focused again where it lands: moving it in the page can lose the focus.
  const refocus = useRef<{ shelf: Shelf; key: string; label: string | null } | null>(null)
  useEffect(() => {
    const target = refocus.current
    if (!target) return
    refocus.current = null
    const chip = [...document.querySelectorAll<HTMLElement>('[data-shelf]')].find((element) => element.dataset.shelf === target.shelf && element.dataset.key === target.key)
    const buttons = [...(chip?.querySelectorAll<HTMLElement>('button') ?? [])]
    ;(buttons.find((button) => button.getAttribute('aria-label') === target.label) ?? buttons[0])?.focus()
  })
  const [over, setOver] = useState<Shelf | null>(null)
  // The chip whose name is being written, and whether that was given up with Escape.
  const [renaming, setRenaming] = useState<string | null>(null)
  // The filter whose settings are open; `isNew` when it is not on the chart until confirmed.
  // A new filter is put where it was dropped once it is set up.
  const [editing, setEditing] = useState<{ filter: ChartFilter; isNew: boolean; at?: number } | null>(null)
  const [editingParam, setEditingParam] = useState<{ filter: ParamFilter; isNew: boolean } | null>(null)
  const [editingDynamic, setEditingDynamic] = useState<DynamicField | null>(null)
  /** The output column whose display format is being set, with what applies to it without one. */
  const [formatting, setFormatting] = useState<ColumnFormat & { name: string } | null>(null)
  /** The number column whose conditional format is being set, with how its numbers are written. */
  const [highlighting, setHighlighting] = useState<{ column: string; name: string; format: NumberFormat | undefined } | null>(null)
  const [computing, setComputing] = useState<number | null>(null)
  /** The dimension whose drill is being set up. */
  const [drilling, setDrilling] = useState<string | null>(null)
  const firstWeekDays = useFirstWeekDays()
  const zone = useWorkspaceTimezone()
  const abandoned = useRef(false)
  // What is stored, to tell whether there is anything to save.
  const [stored, setStored] = useState(() => JSON.stringify([chart?.name ?? '', chart?.description ?? '', state, chart?.datasetId]))
  const dirty = !readOnly && JSON.stringify([name, description, state, chart ? dataset?.id ?? chart.datasetId : undefined]) !== stored
  const ready = Boolean(dataset) && !loadingDataset

  const hasSelections = Boolean(state.dimensions.length || state.measures.length || state.columns.length || state.filters.length || state.params?.length)

  const requestDataset = (id: string) => {
    setPendingDataset(null)
    setLoadingDataset(true)
    // A chart whose own dataset never loaded is still restored from what it stores, once it does.
    setDatasetRequest({ id, initial: Boolean(chart && !dataset && id === chart.datasetId), attempt: 0 })
  }
  const chooseDataset = (id: string) => {
    if (id === dataset?.id && !loadingDataset) {
      // Choosing what is shown again gives up on a dataset that failed to load.
      setDatasetError(null)
      return
    }
    if (hasSelections) setPendingDataset(id)
    else requestDataset(id)
  }
  // The dataset that failed replaces what has been picked since, so it asks again first.
  const retryDataset = () => {
    if (dataset && hasSelections) setPendingDataset(datasetRequest.id)
    else setDatasetRequest((request) => ({ ...request, attempt: request.attempt + 1 }))
  }

  // Changing the selection never changes the chosen type: a chart that no longer fits it says what it lacks (see shape).
  const select = (patch: Partial<BuilderState>) => setState((current) => pruneDrill(pruneColumnGroups(pruneHiddenColumns(withoutStaleSort({ ...current, ...patch, ...(patch.dimensions ? { measures: pruneComputes(patch.measures ?? current.measures, patch.dimensions) } : {}) })))))

  const detail = state.vizType === 'detail'
  const tabular = detail || state.vizType === 'table'
  const visibilityProblem = !readOnly && needsVisibleColumn(state)
  // From a detail table any type can be asked for: what was picked is carried over, and the type gives way if it does not fit.
  const hasAggregateFilters = state.filters.some((filter) => filter.aggregation || spec.fields.find((field) => field.key === filter.field)?.role === 'metric')
  const fits = (type: BuilderType) => ready && (type !== 'detail' || !hasAggregateFilters)
  const hasTimeDimension = state.dimensions.some((key) => spec.fields.some((field) => field.key === key && isTemporal(field.type)))
  const stackable = (state.vizType === 'bar' || state.vizType === 'hbar' || state.vizType === 'area') && (state.measures.length > 1 || state.dimensions.length === 2)
  const nothingPicked = state.dimensions.length + state.measures.length + state.columns.length === 0
  const current = !dataset ? null : readOnly ? (chart!.spec as unknown as ChartSpec) : buildSpec(dataset.id, state, spec.fields)
  const dynamics = current?.dynamics ?? []
  const dynamicPreview = useDynamicSelections(dynamics, dataset?.id)
  const resolved = current ? resolveDynamicSpec(current, dynamicPreview.values) : null
  const dynamicProblem = current ? dynamicOutputProblem(current) : undefined
  const emptyPreview = Boolean(resolved && !hasQueryOutput(resolved.query))
  // What the fields lack for the chosen type. Until it is put right, nothing is asked for or saved.
  const shape = readOnly ? undefined : shapeProblem(state)
  // Nothing can be asked for: no output, fields that do not fit the type, or nothing picked yet.
  const blocked = emptyPreview || Boolean(shape) || (!readOnly && nothingPicked)
  const preview = usePreviewFilters(dataset?.id, current?.filters ?? [])
  const controls = (current?.filters ?? []).filter((filter) => filter.control)
  // What the chart shows while it is being made: defaults until the author tries another value.
  const asking = resolved ? withParamValues(withFilters(resolved.query, (resolved.filters ?? []).filter(isFieldFilter).map((filter) => filter.id in preview.values ? { ...filter, value: preview.values[filter.id] } : filter), spec.fields), (resolved.filters ?? []).filter(isParamFilter), preview.values) : null
  // Where the preview is drilled down to; a change to the chart takes it back to the first level.
  const configKey = JSON.stringify(current)
  const [drillAt, setDrillAt] = useState<{ key: string; position: DrillPosition }>()
  // Drilling is asked for at once, even when the chart waits to be run by hand.
  const drillAsked = useRef(false)
  const drillTo = (next: { key: string; position: DrillPosition }) => {
    drillAsked.current = true
    setDrillAt(next)
  }
  const position = drillAt?.key === configKey && drillAt.position.steps.length ? drillAt.position : undefined
  const path = drillPath(position)
  // Drilled, the server works the chart out, as it does on a dashboard; the preview is asked for anew.
  const queryKey = JSON.stringify(path.length ? [asking, path] : asking)
  const unfinished = state.filters.find(filterProblem) ?? state.params?.find((filter) => paramFilterProblem(filter, paramOf(filter), needing.has(filter.param)))
  // Headers picked on the table to group, and the group being named, by path in the table drawn: only while the
  // same columns are asked for and shown, so hiding a column lets go of a pick that may hold it.
  const headerKey = JSON.stringify([queryKey, state.hiddenColumns ?? []])
  const [headerState, setHeaderState] = useState<{ key: string; pick?: HeaderPick; renaming?: number[] }>()
  const headers = headerState?.key === headerKey ? headerState : undefined
  const picking = Boolean(headers?.pick)
  useEffect(() => {
    if (!picking) return
    const letGo = (event: KeyboardEvent) => {
      // An Escape that closes a dialog or a menu is that one's.
      if (event.key !== 'Escape' || event.defaultPrevented || (event.target instanceof Element && event.target.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]'))) return
      setHeaderState(undefined)
    }
    window.addEventListener('keydown', letGo)
    return () => window.removeEventListener('keydown', letGo)
  }, [picking])

  // The values of a field, for choosing a filter's value from.
  const optionsOf =
    (filter: ChartFilter, values = preview.values, related = false): LoadOptions =>
    async (text) => {
      if (!dataset || !current) return { values: [], truncated: false }
      const source = spec.fields.find((field) => field.key === filter.field)
      if (source?.role === 'metric' || filter.aggregation) return { values: source?.type === 'boolean' && !filter.aggregation ? [true, false] : [], truncated: false }
      const body = { filters: values, selections: dynamicPreview.values, ...(text ? { search: text } : {}), ...(related ? { related: true } : {}) }
      if (readOnly) return unwrap(api.POST('/charts/{id}/filters/{filterId}/options', {
        params: { path: { id: chart!.id, filterId: filter.id } },
        body,
      }))
      // A newly configured filter already needs candidates, before it is saved onto the shelf.
      const filters = [...(current.filters ?? []).filter((other) => other.id !== filter.id), filter]
      return unwrap(api.POST('/charts/preview/filters/{filterId}/options', {
        params: { path: { filterId: filter.id } },
        body: { ...body, spec: { ...current, filters } as unknown as Record<string, unknown> },
      }))
    }
  // The parameters shape what the lists are drawn from, so a list reloads when one changes.
  const fieldFilters = (current?.filters ?? []).filter(isFieldFilter)
  const cascadeConfiguration = JSON.stringify([current, dynamicPreview.values, ready, (current?.filters ?? []).filter(isParamFilter).map((filter) => preview.values[filter.id])])
  const cascade = useCascadeChange({
    filters: fieldFilters,
    values: preview.values,
    commit: preview.setValues,
    load: (parent, values) => optionsOf(parent, values, true)(''),
    context: cascadeConfiguration,
  })
  // A list reloads when what it is drawn from changes: the chart, the dynamic choices, or its ancestors' values.
  const optionsKeyOf = (filter: ChartFilter) => JSON.stringify([cascadeConfiguration, ancestorsKey(fieldFilters, filter.id, (parent) => parent.id in preview.values ? preview.values[parent.id] : (parent as ChartFilter).value)])

  // A new query cancels the previous one; late responses cannot replace its result.
  const asked = useRef(0)
  const flight = useRef<AbortController | null>(null)
  const cancel = () => {
    ++asked.current
    if (flight.current) setQueryNotice('cancelled')
    flight.current?.abort()
    flight.current = null
    setRunning(false)
  }
  useEffect(() => () => {
    ++asked.current
    flight.current?.abort()
    flight.current = null
  }, [])

  /** fresh asks the database again: running by hand wants what it says now. */
  const run = async (fresh = false) => {
    if (!ready || !resolved || !asking || blocked) return
    const mine = ++asked.current
    flight.current?.abort()
    const controller = new AbortController()
    flight.current = controller
    setRunning(true)
    setQueryNotice(null)
    setError(null)
    try {
      const values = { diagnostics: true, filters: preview.values, ...(dynamics.length ? { selections: dynamicPreview.values } : {}), ...(path.length ? { drill: path } : {}), ...(fresh ? { refresh: true } : {}) }
      const result = readOnly
        ? await unwrap(api.POST('/charts/{id}/data', { params: { path: { id: chart!.id } }, body: values, signal: controller.signal }))
        : path.length
          ? await unwrap(api.POST('/charts/preview/data', { body: { ...values, spec: current as unknown as Record<string, unknown> }, signal: controller.signal }))
          : await unwrap(api.POST('/query', { body: { query: asking, options: { diagnostics: true, ...(fresh ? { cache: 'refresh' as const } : {}) } }, signal: controller.signal }))
      if (mine === asked.current && !controller.signal.aborted) setOutcome({ result, spec: resolved, asked: queryKey })
    } catch (e) {
      if (mine !== asked.current || controller.signal.aborted) return
      setError(toApiError(e))
      setQueryNotice('failed')
      setOutcome(null)
    } finally {
      if (mine === asked.current) {
        flight.current = null
        setRunning(false)
      }
    }
  }

  const save = async () => {
    if (!ready || !current || !dirty || saving || dynamicProblem || visibilityProblem || drillIssue) return
    if (conflict.needed) { conflict.show(); return }
    setSaving(true)
    setError(null)
    const body = { name, description, spec: current as unknown as Record<string, unknown> }
    try {
      if (chart) {
        const saved = await unwrap(api.PUT('/charts/{id}', { params: { path: { id: chart.id } }, body: { ...body, expectedRevision: conflict.base!.revision } }))
        conflict.accept({ ...saved, spec: body.spec })
        setStored(JSON.stringify([name, description, state, dataset?.id]))
        void reload()
      } else {
        const created = await unwrap(api.POST('/charts', { body }))
        conflict.accept(created)
        const folder = search.get('folder')
        // A chart made from a folder's menu belongs in that folder.
        if (folder) await unwrap(api.POST('/folders/move', { body: { kind: 'chart', id: created.id, folderId: folder } })).catch(() => undefined)
        void reload()
        void navigate(`/workbench/charts/${created.id}`, { replace: true, state: afterSave })
      }
    } catch (e) {
      const failure = toApiError(e)
      if (!conflict.capture(failure)) setError(failure)
    } finally {
      setSaving(false)
    }
  }

  const applyConflict = async (content: SaveContent, latest: Chart) => {
    const chosen = content.spec as unknown as ChartSpec
    const loaded = await unwrap(api.GET('/datasets/{id}', { params: { path: { id: String(chosen.query.dataset) } } }))
    const fields = (loaded.spec as DatasetSpec).fields
    const next = restore(chosen, fields)
    if (!next) throw new ApiError(400, 'conflict_not_editable', '')
    ++datasetLoad.current
    ++asked.current
    flight.current?.abort()
    flight.current = null
    setRunning(false)
    setName(content.name); setDescription(content.description)
    setDataset(loaded); setState(next); setReadOnly(false)
    setLoadingDataset(false); setDatasetError(null); setPendingDataset(null)
    setStored(JSON.stringify([latest.name, latest.description, restore(latest.spec as unknown as ChartSpec, fields) ?? emptyState(), latest.datasetId]))
    setError(null); setOutcome(null); setQueryNotice(null)
    setEditing(null); setEditingDynamic(null); setFormatting(null); setHighlighting(null); setComputing(null)
    opened.current = false
    setResolvedDraft((value) => value + 1)
  }

  const prepareLatest = async (latest: Chart) => {
    const loaded = await unwrap(api.GET('/datasets/{id}', { params: { path: { id: latest.datasetId } } }))
    const fields = (loaded.spec as DatasetSpec).fields
    const next = restore(latest.spec as unknown as ChartSpec, fields)
    return next ? { ...latest, spec: buildSpec(loaded.id, next, fields) as unknown as Record<string, unknown> } : latest
  }

  // A chart opens showing its data. After that it follows what is picked,
  // unless the author would rather ask for each query.
  const opened = useRef(false)
  useEffect(() => {
    if (!datasetRequest.id) return
    let active = true
    const request = ++datasetLoad.current
    // A selection can overtake both a previous dataset load and a chart query.
    ++asked.current
    const dropped = flight.current !== null
    flight.current?.abort()
    flight.current = null
    setRunning(false)
    setLoadingDataset(true)
    setQueryNotice(null)
    setDatasetError(null)
    void unwrap(api.GET('/datasets/{id}', { params: { path: { id: datasetRequest.id } } })).then(
      (loaded) => {
        if (!active || request !== datasetLoad.current) return
        const restored = datasetRequest.initial && chart ? restore(chart.spec as unknown as ChartSpec, (loaded.spec as DatasetSpec).fields) : undefined
        const next = restored ?? emptyState()
        setDataset(loaded)
        setState(next)
        setReadOnly(Boolean(datasetRequest.initial && chart && !restored))
        if (datasetRequest.initial && chart) {
          setStored(JSON.stringify([chart.name, chart.description ?? '', next, loaded.id]))
          // Compare the same editable representation as the live draft:
          // omitted defaults must not look like concurrent configuration edits.
          if (restored) acceptRevision({ ...chart, spec: buildSpec(loaded.id, next, (loaded.spec as DatasetSpec).fields) as unknown as Record<string, unknown> })
        }
        setOutcome(null)
        setError(null)
        setFilter('')
        setEditing(null)
        setEditingDynamic(null)
        setRenaming(null)
        dragged.current = null
        setOver(null)
        opened.current = false
        setLoadingDataset(false)
      },
      (error: unknown) => {
        if (!active || request !== datasetLoad.current) return
        setDatasetError(toApiError(error))
        // The dataset shown stays, and so the query given up for the other one is asked again.
        if (dropped) opened.current = false
        setLoadingDataset(false)
      },
    )
    return () => { active = false }
  }, [datasetRequest, chart, acceptRevision])

  // The address of a new chart names the dataset it reads, once that dataset is the one shown.
  useEffect(() => {
    if (chart || !dataset || search.get('dataset') === dataset.id) return
    setSearch((current) => {
      const next = new URLSearchParams(current)
      next.set('dataset', dataset.id)
      return next
    }, { replace: true, state: { chartEditorKey: editorKey } })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- when another dataset is shown, not when the address changes
  }, [dataset?.id])

  useEffect(() => {
    if (!ready) return
    if (blocked) {
      cancel()
      opened.current = true
      return
    }
    if (readOnly || (!nothingPicked && (autoRun || !opened.current || drillAsked.current))) void run()
    drillAsked.current = false
    opened.current = true
    // A chart whose fields come to fit its type again is asked for, though the query may be the one asked before.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- when what is asked for changes, not when anything else does
  }, [queryKey, autoRun, ready, blocked, resolvedDraft])

  // The chart takes the height there is for it. What is measured is a box
  // that never scrolls: one that did would grow scrollbars whenever the chart
  // was a fraction of a pixel too tall, and they would take room of their own.
  const [stage, setStage] = useState<HTMLElement | null>(null)
  const [stageHeight, setStageHeight] = useState(360)
  useEffect(() => {
    if (!stage) return
    // Rounded down: half a pixel too many is already too tall.
    const observer = new ResizeObserver(([entry]) => setStageHeight(Math.floor(entry!.contentRect.height)))
    observer.observe(stage)
    return () => observer.disconnect()
  }, [stage])

  // Fields get onto a shelf by being dragged there. Anything can be a metric:
  // a measure or a dimension is aggregated there, a metric is used as it is.
  const used = (field: SpecField) => state.dimensions.includes(field.key) || state.columns.includes(field.key) || state.measures.some((measure) => measure.field === field.key) || state.dynamics?.some((dynamic) => dynamic.options.some((option) => option.field === field.key))
  // Added last, or at a place among what is on the shelf when dropped there.
  const add = (field: SpecField, shelf: Shelf, at?: number) => {
    const place = (patch: Partial<BuilderState>) => select(placedOnShelf(state, patch, shelf, at))
    // A filter is not on the chart until its settings are confirmed.
    if (shelf === 'filter') setEditing({ filter: newFilter(field, new Set([...state.filters, ...(state.params ?? [])].map((filter) => filter.id))), isNew: true, at })
    else if (shelf === 'metric') place({ measures: addMeasure(state.measures, field, state.dimensions) })
    else if (shelf === 'column') place({ columns: state.columns.includes(field.key) ? state.columns : [...state.columns, field.key] })
    else if (shelf === 'pivotColumn') place({ dimensions: state.dimensions.includes(field.key) ? state.dimensions : [...state.dimensions, field.key], pivotColumns: [...(state.pivotColumns ?? []).filter((key) => key !== field.key), field.key] })
    else if (!state.dimensions.includes(field.key)) place({ dimensions: [...state.dimensions, field.key] })
  }
  // A metric has no value on a row, so it cannot be a column; only a dimension groups.
  const dynamicDisabled = !ready || detail || (state.dynamics?.length ?? 0) >= dynamicLimits.fields
  // A parameter is given a value on the filters, once; it is not on the chart until its settings are confirmed.
  const paramOnShelf = (param: SqlParam) => Boolean(state.params?.some((filter) => filter.param === param.name))
  const addParam = (param: SqlParam) => {
    if (paramOnShelf(param)) return
    setEditingParam({ filter: newParamFilter(param, new Set([...state.filters, ...(state.params ?? [])].map((filter) => filter.id))), isNew: true })
  }
  const accepts = (shelf: Shelf, item: DraggedField | null) => {
    if (!ready || !item) return false
    // What is on a shelf is only ordered there.
    if (item.type === 'chip') return item.shelf === shelf
    if (item.type === 'param') return shelf === 'filter' && !paramOnShelf(item.param)
    if (item.type === 'dynamic') return !dynamicDisabled && shelf === (item.kind === 'dimension' ? 'dimension' : 'metric')
    const field = item.field
    if (shelf === 'metric') return true
    if (shelf === 'filter') return filterable(field, detail)
    return shelf === 'column' ? field.role !== 'metric' : field.role === 'dimension'
  }
  const pivot = state.vizType === 'pivot'
  const across = new Set(pivot ? (state.pivotColumns ?? []) : [])
  const tableLike = tabular || pivot
  const matches = (field: SpecField) => !filter.trim() || foldLabel(field.label).includes(foldLabel(filter))
  const addDynamic = (kind: DynamicField['kind'], at?: number) => {
    if (dynamicDisabled) return
    dynamicAt.current = at
    const taken = new Set([...spec.fields.map((field) => field.key), ...state.dimensions, ...state.measures.flatMap((measure) => [measure.field, measureName(measure)]), ...((current?.query.measures as { alias?: string }[] | undefined) ?? []).flatMap((measure) => measure.alias ? [measure.alias] : []), ...(state.dynamics ?? []).flatMap((dynamic) => [dynamic.id, dynamic.alias])])
    const alias = makeKey(`dynamic_${kind}`, taken)
    const labels = new Set((state.dynamics ?? []).map((dynamic) => dynamic.label))
    const base = t(`dynamics.${kind}`)
    let label = base
    for (let n = 2; labels.has(label); n++) label = `${base} ${n}`
    setEditingDynamic({ id: alias, alias, kind, label, options: [] })
  }
  const hiddenColumn = (column: string) => tabular && Boolean(state.hiddenColumns?.includes(column))
  // The drill the chart is written with, and the dimensions it could be put on.
  const drill = readOnly ? current?.drill : drilled(state, spec.fields)
  const drillIssue = readOnly ? undefined : chartDrillProblem(state, spec.fields)
  const drillable = readOnly ? [] : drillableColumns(state, spec.fields)
  const hiddenMark = (column: string) => hiddenColumn(column) && (
    <Tooltip title={t('explore.hiddenColumnHint')}><span className="chip-tag" tabIndex={0}>{t('explore.columnHidden')}</span></Tooltip>
  )
  const visibilityMenu = (column: string): MenuItem => {
    const hidden = hiddenColumn(column)
    const hiddenColumns = hidden ? state.hiddenColumns!.filter((name) => name !== column) : [...(state.hiddenColumns ?? []), column]
    // The column drilled down is what is clicked, so it stays in sight.
    const drilledColumn = !hidden && drill?.alias === column
    const disabled = !hidden && (drilledColumn || needsVisibleColumn({ ...state, hiddenColumns }))
    return {
      key: 'visibility',
      label: drilledColumn ? t('drill.keepVisible') : disabled ? t('explore.keepVisibleColumn') : t(hidden ? 'explore.showColumn' : 'explore.hideColumn'),
      separated: true,
      disabled,
      onSelect: () => select({ hiddenColumns: hiddenColumns.length ? hiddenColumns : undefined }),
    }
  }
  // One place earlier or later on its shelf, from the field's menu or the keyboard; focused again where it lands.
  const nudge = (shelf: Shelf, key: string, step: -1 | 1, label: string | null) => {
    const from = shelfKeys(state, shelf).indexOf(key)
    const patch = moveOnShelf(state, shelf, key, step < 0 ? from - 1 : from + 2)
    if (!patch) return
    refocus.current = { shelf, key, label }
    select(patch)
  }
  const moveItems = (shelf: Shelf, key: string, name: string): MenuItem[] => {
    if (readOnly) return []
    const keys = shelfKeys(state, shelf)
    const at = keys.indexOf(key)
    const menu = t('explore.fieldMenu', { name })
    return [
      { key: 'move-earlier', label: t('explore.moveEarlier'), separated: true, disabled: at <= 0, onSelect: () => nudge(shelf, key, -1, menu) },
      { key: 'move-later', label: t('explore.moveLater'), disabled: at < 0 || at >= keys.length - 1, onSelect: () => nudge(shelf, key, 1, menu) },
    ]
  }
  // What lets an item on a shelf be dragged to another place there, or moved with Alt and an arrow, and the line
  // drawn before or after it when something dragged would land there.
  const placing = (shelf: Shelf, key: string, name: string) => {
    const keys = shelfKeys(state, shelf)
    const at = keys.indexOf(key)
    const line = dropAt?.shelf !== shelf ? '' : dropAt.at === at ? ' drop-before' : dropAt.at === keys.length && at === keys.length - 1 ? ' drop-after' : ''
    const props = readOnly ? {} : {
      draggable: true,
      onDragStart: (event: React.DragEvent<HTMLElement>) => {
        // Text being written in an alias is dragged as text.
        if (event.target instanceof HTMLInputElement) return
        dragged.current = { type: 'chip', shelf, key }
        event.dataTransfer.setData('text/plain', name)
        event.dataTransfer.effectAllowed = 'move'
      },
      onDragEnd: () => {
        dragged.current = null
        setOver(null)
        setDropAt(null)
      },
      onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
        // In an alias being written, Alt and an arrow move the caret by a word.
        if (!event.altKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') || event.target instanceof HTMLInputElement) return
        event.preventDefault()
        nudge(shelf, key, event.key === 'ArrowLeft' ? -1 : 1, event.target instanceof Element ? event.target.getAttribute('aria-label') : null)
      },
    }
    return { line, props: { 'data-shelf': shelf, 'data-key': key, ...props } }
  }
  // Where on a shelf a pointer would put something: among the items drawn, counted as the shelf's own.
  const dropPlace = (element: HTMLElement, shelf: Shelf, x: number, y: number) => {
    const chips = [...element.querySelectorAll<HTMLElement>('[data-shelf]')].filter((chip) => chip.dataset.shelf === shelf)
    const index = dropIndex(chips.map((chip) => chip.getBoundingClientRect()), x, y)
    const keys = shelfKeys(state, shelf)
    const at = index < chips.length ? keys.indexOf(chips[index]!.dataset.key!) : keys.length
    return at < 0 ? keys.length : at
  }

  const dynamicChip = (dynamic: DynamicField, shelf: Shelf) => {
    const { line, props } = placing(shelf, dynamic.alias, dynamic.label)
    const menu = [...moveItems(shelf, dynamic.alias, dynamic.label), ...(tabular ? [visibilityMenu(dynamic.alias)] : [])]
    return (
    <span key={dynamic.id} className={`field-chip dynamic-chip ${dynamic.kind === 'dimension' ? 'dimension' : 'metric'}${line}`} {...props}>
      {menu.length > 0 && <Menu className="chip-menu" items={menu}>
        <button type="button" aria-label={t('explore.fieldMenu', { name: dynamic.label })}><Icon name="chevronDown" size={12} /></button>
      </Menu>}
      <Tooltip title={t('dynamics.configure', { name: dynamic.label })}>
        <button type="button" className="chip-body" aria-label={t('dynamics.configure', { name: dynamic.label })} onClick={() => setEditingDynamic(dynamic)}><Icon name={dynamic.kind === 'dimension' ? 'layers' : 'chart'} size={14} />{dynamic.label}</button>
      </Tooltip>
      {dynamic.kind === 'measure' && (state.measures.some((measure) => measure.field === dynamic.alias && measure.compute) || dynamic.options.every((option) => {
        const field = spec.fields.find((field) => field.key === option.field)
        return field && isNumeric(aggResultType(option.agg, field.type))
      })) && <button type="button" aria-label={t('compute.title', { name: dynamic.label })} onClick={() => setComputing(state.measures.findIndex((measure) => measure.field === dynamic.alias))}>%</button>}
      {hiddenMark(dynamic.alias)}
      <Tooltip title={t('dynamics.remove', { name: dynamic.label })}>
        <button type="button" aria-label={t('dynamics.remove', { name: dynamic.label })} onClick={() => select({
          dynamics: state.dynamics?.filter((other) => other.id !== dynamic.id),
          dimensions: state.dimensions.filter((key) => key !== dynamic.alias),
          measures: state.measures.filter((measure) => measure.field !== dynamic.alias),
        })}><Icon name="close" size={12} /></button>
      </Tooltip>
    </span>
    )
  }

  const fieldList = (role: FieldRole) => {
    const all = visible.filter((field) => field.role === role)
    return (
      <div className="outline-group">
        <div className={`outline-title ${role}`}>
          {t(`explore.${role}s`)} <span className="muted-inline">· {all.length}</span>
        </div>
        <ul>
          {all.filter(matches).map((field) => (
            <li key={field.key}>
              <div
                className="outline-item"
                draggable
                onDragStart={(event) => {
                  dragged.current = { type: 'field', field }
                  event.dataTransfer.setData('text/plain', field.label)
                  event.dataTransfer.effectAllowed = 'copy'
                }}
                onDragEnd={() => {
                  dragged.current = null
                  setOver(null)
                  setDropAt(null)
                }}
              >
                <TypeMark type={field.type} />
                <span className="outline-name">{field.label}</span>
                {/* Being on the chart is marked, not highlighted: a highlight reads as a selection, and nothing here is selected. */}
                {used(field) && <Tooltip title={t('explore.usedField')}><span className="outline-used" /></Tooltip>}
              </div>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  const dynamicList = (
    <div className="outline-group">
      <div className="outline-title dynamic">{t('dynamics.category')} <span className="muted-inline">· 2</span></div>
      <ul>
        {(['dimension', 'measure'] as const).filter((kind) => !filter.trim() || foldLabel(t(`dynamics.${kind}`)).includes(foldLabel(filter))).map((kind) => (
          <li key={kind}>
            <Tooltip title={detail ? t('dynamics.requiresAggregate') : (state.dynamics?.length ?? 0) >= dynamicLimits.fields ? t('dynamics.limitFields', { count: dynamicLimits.fields }) : t(kind === 'dimension' ? 'dynamics.dragDimension' : 'dynamics.dragMeasure')}>
              <button
                type="button"
                className={`outline-item dynamic-outline-item ${kind === 'dimension' ? 'dimension' : 'metric'}`}
                aria-label={t(kind === 'dimension' ? 'dynamics.addDimension' : 'dynamics.addMeasure')}
                aria-disabled={dynamicDisabled}
                draggable={!dynamicDisabled}
                onClick={() => addDynamic(kind)}
                onDragStart={(event) => {
                  if (dynamicDisabled) { event.preventDefault(); return }
                  dragged.current = { type: 'dynamic', kind }
                  event.dataTransfer.setData('text/plain', t(`dynamics.${kind}`))
                  event.dataTransfer.effectAllowed = 'copy'
                }}
                onDragEnd={() => {
                  dragged.current = null
                  setOver(null)
                  setDropAt(null)
                }}
              >
                <Icon name={kind === 'dimension' ? 'layers' : 'chart'} size={14} />
                <span className="outline-name">{t(`dynamics.${kind}`)}</span>
              </button>
            </Tooltip>
          </li>
        ))}
      </ul>
    </div>
  )

  // The dataset's parameters, given a value on the filters by dragging them there or clicking them.
  const paramList = params.length > 0 && (
    <div className="outline-group">
      <div className="outline-title param">{t('params.title')} <span className="muted-inline">· {params.length}</span></div>
      <ul>
        {params.filter((param) => !filter.trim() || foldLabel(param.label || param.name).includes(foldLabel(filter)) || param.name.includes(filter.trim().toLowerCase())).map((param) => {
          const name = param.label || param.name
          const placed = paramOnShelf(param)
          return (
            <li key={param.name}>
              <Tooltip title={placed ? t('params.filter.onShelf') : t('params.filter.drag')}>
                <button
                  type="button"
                  className="outline-item param-outline-item"
                  aria-label={t('params.filter.addTo', { name })}
                  aria-disabled={!ready || placed}
                  draggable={ready && !placed}
                  onClick={() => ready && addParam(param)}
                  onDragStart={(event) => {
                    if (!ready || placed) { event.preventDefault(); return }
                    dragged.current = { type: 'param', param }
                    event.dataTransfer.setData('text/plain', name)
                    event.dataTransfer.effectAllowed = 'copy'
                  }}
                  onDragEnd={() => {
                    dragged.current = null
                    setOver(null)
                    setDropAt(null)
                  }}
                >
                  <TypeMark type={param.type} />
                  <span className="outline-name">{name}</span>
                  {placed && <span className="outline-used" />}
                </button>
              </Tooltip>
            </li>
          )
        })}
      </ul>
    </div>
  )

  // A field on a shelf. The arrow before it opens what can be done with it: a metric made
  // from a measure or a dimension can be aggregated another way, and anything
  // can be given an alias, the name the chart shows it under.
  const chip = (item: {
    id: string
    tone: FieldRole
    field: SpecField
    /** What it is: the name it has unless the chart gives it an alias. */
    name: string
    alias?: string
    mark?: React.ReactNode
    extra?: React.ReactNode
    items?: MenuItem[]
    /** Set on a numeric column, which can be given a display format of its own. */
    format?: ColumnFormat
    /** The output column it is, which the rows can be ordered by. */
    column: string
    /** What else can be done with it, after its ordering. */
    more?: MenuItem[]
    /** A mark of something set on it, after its format's. */
    tag?: React.ReactNode
    /** The shelf it is on, where it can be moved to another place. */
    shelf: Shelf
    /** What it is on the shelf: its key there. */
    shelfKey: string
    onRename: (alias: string | undefined) => void
    onRemove: () => void
  }) => {
    const { id, field, name, alias, items = [], format, column } = item
    const { line, props } = placing(item.shelf, item.shelfKey, alias ?? name)
    const formatted = format && state.formats?.[format.column]
    // A table's numbers can be shaded by rules; a pivot table's only in its cells, which are its measures'.
    const highlightable = Boolean(format && tableLike && isNumeric(format.type) && (!pivot || item.shelf === 'metric'))
    const highlighted = highlightable && Boolean(state.style?.highlights?.[column])
    const sort = state.sort ?? []
    const place = sort.findIndex((key) => key.by === column)
    const direction = place < 0 ? undefined : sort[place]!.desc ? 'desc' : 'asc'
    const order = (value: 'asc' | 'desc') => ({
      key: `sort-${value}`,
      // The arrow stands where an aggregation's symbol does, so the names line up.
      label: <span className={direction === value ? 'chip-menu-on' : undefined}><span className="formula-symbol agg" aria-hidden="true"><Icon name={value === 'asc' ? 'sortAsc' : 'sortDesc'} size={14} /></span>{t(`explore.sort.${value}`)}</span>,
      separated: value === 'asc',
      onSelect: () => direction !== value && select(sortedBy(state, column, value)),
    })
    return (
      <span key={id} className={`field-chip ${item.tone}${line}`} {...props} draggable={!readOnly && renaming !== id}>
        {/* What it is stays in front, so an alias never hides where a column comes from. */}
        <Menu
          className="chip-menu"
          items={[
            ...items,
            { key: 'alias', label: t(alias ? 'explore.editAlias' : 'explore.addAlias'), separated: items.length > 0, onSelect: () => setRenaming(id) },
            ...(alias ? [{ key: 'reset', label: t('explore.removeAlias'), onSelect: () => item.onRename(undefined) }] : []),
            order('asc'),
            order('desc'),
            ...(direction ? [{ key: 'sort-none', label: t('explore.sort.none'), onSelect: () => select(sortedBy(state, column, undefined)) }] : []),
            ...(tabular ? [visibilityMenu(column)] : []),
            // A table's columns can be lined up another way than numbers right and the rest left.
            ...(tableLike ? (['left', 'center', 'right'] as const).map((value, at) => ({
              key: `align-${value}`,
              label: <span className={state.style?.columnAlign?.[column] === value ? 'chip-menu-on' : undefined}>{t(`chartStyle.aligns.${value}`)}</span>,
              separated: at === 0,
              onSelect: () => {
                const rest = Object.fromEntries(Object.entries(state.style?.columnAlign ?? {}).filter(([name]) => name !== column))
                const columnAlign = state.style?.columnAlign?.[column] === value ? rest : { ...rest, [column]: value }
                select({ style: { ...state.style, columnAlign: Object.keys(columnAlign).length ? columnAlign : undefined } })
              },
            })) : []),
            ...moveItems(item.shelf, item.shelfKey, name),
            ...(item.more ?? []),
            ...(highlightable ? [{ key: 'highlight', label: t('highlight.edit'), separated: true, onSelect: () => setHighlighting({ column, name: alias ?? name, format: (state.formats?.[column] ?? format!.inherited) as NumberFormat | undefined }) }] : []),
            ...(format ? [{ key: 'format', label: t('format.edit'), separated: !highlightable, onSelect: () => setFormatting({ ...format, name: alias ?? name }) }] : []),
          ]}
        >
          {/* No tooltip here: the menu opens where one would be, and says more. */}
          <button type="button" aria-label={t('explore.fieldMenu', { name })}>
            <Icon name="chevronDown" size={12} />
          </button>
        </Menu>
        <TypeMark type={field.type} />
        {item.mark}
        {name}
        {item.extra}
        {hiddenMark(column)}
        {direction && (
          // The place among the keys is only worth saying when there is more than one.
          <Tooltip title={sort.length > 1 ? t(`explore.sort.${direction}Nth`, { n: place + 1 }) : t(`explore.sort.${direction}By`)}>
            <span className="chip-sort" role="img" aria-label={sort.length > 1 ? t(`explore.sort.${direction}Nth`, { n: place + 1 }) : t(`explore.sort.${direction}By`)}>
              <Icon name={direction === 'asc' ? 'sortAsc' : 'sortDesc'} size={12} />
              {sort.length > 1 && place + 1}
            </span>
          </Tooltip>
        )}
        {formatted && (
          <Tooltip title={t('format.customized')}>
            <span className="chip-tag">{t('format.tag')}</span>
          </Tooltip>
        )}
        {highlighted && (
          <Tooltip title={t('highlight.customized')}>
            <span className="chip-tag">{t('highlight.tag')}</span>
          </Tooltip>
        )}
        {item.tag}
        {renaming === id ? (
          <input
            className="chip-input"
            aria-label={t('explore.aliasOf', { name })}
            placeholder={t('explore.alias')}
            autoFocus
            maxLength={100}
            defaultValue={alias ?? ''}
            onFocus={(event) => event.currentTarget.select()}
            onBlur={(event) => {
              const next = event.currentTarget.value.trim()
              // Left empty, or the same as the name it would have anyway, there is no alias.
              if (!abandoned.current) item.onRename(next && next !== name ? next : undefined)
              abandoned.current = false
              setRenaming(null)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') abandoned.current = true
              if (event.key === 'Enter' || event.key === 'Escape') event.currentTarget.blur()
            }}
          />
        ) : (
          alias && (
            <Tooltip title={t('explore.aliasOf', { name })}>
              <span className="chip-alias">
                <span className="muted-inline">·</span> {alias}
              </span>
            </Tooltip>
          )
        )}
        <Tooltip title={t('explore.removeField', { name })}>
          <button type="button" aria-label={t('explore.removeField', { name })} onClick={item.onRemove}>
            <Icon name="close" size={12} />
          </button>
        </Tooltip>
      </span>
    )
  }

  const withLabel = (key: string, alias: string | undefined) => {
    const rest = Object.fromEntries(Object.entries(state.labels).filter(([other]) => other !== key))
    return alias ? { ...rest, [key]: alias } : rest
  }
  // A dimension or a column of a detail table: `shelf` says which list of the state it is in.
  const fieldChip = (field: SpecField, shelf: 'dimensions' | 'columns', on: Shelf) =>
    chip({
      id: `${shelf}:${field.key}`,
      shelf: on,
      shelfKey: field.key,
      tone: shelf === 'columns' ? field.role : 'dimension',
      field,
      name: field.label,
      alias: state.labels[field.key],
      extra: shelf === 'dimensions' && isTemporal(field.type) && <span className="muted-inline">· {t(`explore.grains.${state.grain}`)}</span>,
      // The column is named after the field.
      column: field.key,
      format: isNumeric(field.type) || isTemporal(field.type) ? { column: field.key, type: field.type, inherited: field.format } : undefined,
      more: [
        ...(pivot && shelf === 'dimensions' ? [{
          key: 'move',
          label: t(across.has(field.key) ? 'explore.moveToRows' : 'explore.moveToColumns'),
          separated: true,
          onSelect: () => select({ pivotColumns: across.has(field.key) ? state.pivotColumns?.filter((key) => key !== field.key) : [...(state.pivotColumns ?? []), field.key] }),
        }] : []),
        // A chart drills down one dimension only.
        ...(shelf === 'dimensions' && drillable.includes(field.key) ? [{
          key: 'drill',
          label: drill && drill.alias !== field.key ? t('drill.onlyOne') : t('drill.configure'),
          separated: true,
          disabled: Boolean(drill && drill.alias !== field.key),
          onSelect: () => setDrilling(field.key),
        }] : []),
      ],
      tag: shelf === 'dimensions' && drill?.alias === field.key && (
        <Tooltip title={drillIssue ? t(`drill.problems.${drillIssue}`) : t('drill.customized', { levels: drill.levels.map((level) => level.label ?? level.field).join(' › ') })}>
          <span className={`chip-tag${drillIssue ? ' invalid' : ''}`} tabIndex={0}>{t('drill.tag')}</span>
        </Tooltip>
      ),
      onRename: (alias) => select({ labels: withLabel(field.key, alias) }),
      onRemove: () => select({ [shelf]: state[shelf].filter((key) => key !== field.key), labels: withLabel(field.key, undefined), ...(shelf === 'dimensions' && state.pivotColumns ? { pivotColumns: state.pivotColumns.filter((key) => key !== field.key) } : {}) }),
    })

  // What a metric is called unless the chart says otherwise: a measure or a
  // dimension by how it is aggregated, a metric of the dataset by its own name.
  const metricName = (measure: PickedMeasure, field: SpecField) => {
    const agg = field.role === 'metric' ? undefined : measure.agg
    const name = agg ? aggLabel(agg, field.label) : field.label
    return computeName(name, measure.compute, t)
  }

  // A measure keeps the name of its column when its aggregation changes (see reaggregated).
  const metricChip = (measure: PickedMeasure, index: number) => {
    const dynamic = state.dynamics?.find((dynamic) => dynamic.kind === 'measure' && dynamic.alias === measure.field)
    if (dynamic) return dynamicChip(dynamic, 'metric')
    const field = spec.fields.find((candidate) => candidate.key === measure.field)
    if (!field) return null
    const column = measureName(measure)
    const patch = (next: PickedMeasure) => select({ measures: state.measures.map((other, at) => (at === index ? next : other)) })
    const options = field.role === 'metric' ? [] : aggOptions(state.measures, index, field)
    const agg = field.role === 'metric' ? undefined : measure.agg
    // A count is a count, whatever the field it counts: it does not take the field's format.
    const counted = agg === 'count' || agg === 'count_distinct'
    const baseType = aggResultType(agg, field.type)
    const type = measure.compute?.type === 'percent_of_total' || measure.compute?.type === 'compare' && measure.compute.output !== 'value' ? 'float' : baseType
    return chip({
      id: `metrics:${column}`,
      shelf: 'metric',
      shelfKey: column,
      tone: 'metric',
      field,
      name: metricName(measure, field),
      alias: measure.label,
      items: options.map((value) => ({
        key: value,
        label: <span className={value === agg ? 'chip-menu-on' : undefined}><span className="formula-symbol agg" aria-hidden="true">{aggCodes[value]}</span>{t(`dataset.aggs.${value}`)}</span>,
        onSelect: () => {
          if (value === agg) return
          const next = reaggregated(state, index, value)
          // An aggregation that cannot run takes a running total back to the original value.
          select(isNumeric(aggResultType(value, field.type)) && (measure.compute?.type !== 'cumulative' || accumulates(value)) ? next : recomputed(next, index, undefined))
        },
      })),
      column,
      format: isNumeric(type) || isTemporal(type) ? { column, type, inherited: percentCompute(measure.compute) ? { style: 'percent' } : counted ? undefined : field.format } : undefined,
      more: isNumeric(baseType) ? [{ key: 'compute', label: t('compute.configure'), separated: true, onSelect: () => setComputing(index) }] : undefined,
      onRename: (label) => {
        const next: PickedMeasure = { ...measure }
        if (label) next.label = label
        else delete next.label
        patch(next)
      },
      onRemove: () => select({ measures: state.measures.filter((_, at) => at !== index) }),
    })
  }

  // Two columns under one name can be asked for, but not told apart on the chart.
  const names = [
    ...[...state.dimensions, ...state.columns].map((key) => state.labels[key] ?? spec.fields.find((field) => field.key === key)?.label ?? key),
    ...state.measures.map((measure) => {
      const field = spec.fields.find((candidate) => candidate.key === measure.field)
      return measure.label ?? (field ? metricName(measure, field) : measure.field)
    }),
  ]
  // The metrics as the style settings name them: by column, under the name the chart shows.
  const styledMeasures = state.measures.map((measure) => {
    const dynamic = state.dynamics?.find((slot) => slot.kind === 'measure' && slot.alias === measure.field)
    const field = spec.fields.find((candidate) => candidate.key === measure.field)
    return { column: measureName(measure), name: dynamic?.label ?? measure.label ?? (field ? metricName(measure, field) : measure.field) }
  })
  const repeated = names.find((name, index) => names.findIndex((other) => foldLabel(other) === foldLabel(name)) !== index)

  // A filter on its shelf: what it restricts and to what, and who may change it. Its settings open from it.
  const filterChip = (filter: ChartFilter) => {
    const field = spec.fields.find((candidate) => candidate.key === filter.field)
    if (!field) return null
    const name = filter.label || field.label
    const condition = describeCondition(filter.op, filter.value, t)
    const { line, props } = placing('filter', filter.id, name)
    return (
      <span key={filter.id} className={`field-chip filter${filterProblem(filter) ? ' invalid' : ''}${line}`} {...props}>
        <Tooltip title={t('filter.edit')}>
          <button type="button" className="chip-body" aria-label={t('filter.editOf', { name })} onClick={() => setEditing({ filter, isNew: false })}>
            <TypeMark type={field.type} />
            {name}
            <span className="muted-inline">{condition}</span>
            {!filter.control && <span className="chip-tag">{t('filter.tags.fixed')}</span>}
          </button>
        </Tooltip>
        {filter.control && (
          <Tooltip title={t('filter.interactive')}>
            <span className="chip-filter-icon" role="img" aria-label={t('filter.interactive')}><Icon name="filter" size={12} /></span>
          </Tooltip>
        )}
        <Tooltip title={t('explore.removeField', { name })}>
          <button type="button" aria-label={t('explore.removeField', { name })} onClick={() => select({ filters: state.filters.filter((other) => other.id !== filter.id).map((other) => ({ ...other, ...(other.dependsOn ? { dependsOn: other.dependsOn.filter((id) => id !== filter.id) } : {}) })) })}>
            <Icon name="close" size={12} />
          </button>
        </Tooltip>
      </span>
    )
  }

  // A parameter on the filters: the value it gives the dataset, and who may change it. Its settings open from it.
  const paramChip = (filter: ParamFilter) => {
    const param = paramOf(filter)
    const name = filter.label || param?.label || filter.param
    const problem = paramFilterProblem(filter, param, needing.has(filter.param))
    return (
      <span key={filter.id} className={`field-chip filter param-chip${problem ? ' invalid' : ''}`}>
        <Tooltip title={problem ? t(`params.filter.problems.${problem}`) : t('params.filter.edit')}>
          <button type="button" className="chip-body" aria-label={t('params.filter.editOf', { name })} aria-disabled={!param} onClick={() => param && setEditingParam({ filter, isNew: false })}>
            {param ? <TypeMark type={param.type} /> : <Icon name="warning" size={14} />}
            {name}
            <span className="muted-inline">{paramValueSummary(paramDefault(filter, param), t, zone)}</span>
            <span className="chip-tag">{t('params.filter.tag')}</span>
            {!filter.control && <span className="chip-tag">{t('filter.tags.fixed')}</span>}
          </button>
        </Tooltip>
        {filter.control && (
          <Tooltip title={t('filter.interactive')}>
            <span className="chip-filter-icon" role="img" aria-label={t('filter.interactive')}><Icon name="filter" size={12} /></span>
          </Tooltip>
        )}
        <Tooltip title={t('explore.removeField', { name })}>
          <button type="button" aria-label={t('explore.removeField', { name })} onClick={() => {
            const rest = (state.params ?? []).filter((other) => other.id !== filter.id)
            select({ params: rest.length ? rest : undefined })
          }}>
            <Icon name="close" size={12} />
          </button>
        </Tooltip>
      </span>
    )
  }

  const shelf = (which: Shelf) => {
    const chosen = which === 'column' ? state.columns : which === 'pivotColumn' ? state.dimensions.filter((key) => across.has(key)) : state.dimensions.filter((key) => !across.has(key))
    const empty = which === 'filter' ? state.filters.length === 0 && !state.params?.length : which === 'metric' ? state.measures.length === 0 : chosen.length === 0
    return (
      <div
        className={`shelf${over === which ? ' drop' : ''}${shape?.shelf === which || (shape?.shelf === 'dimension' && which === 'pivotColumn') ? ' needs' : ''}`}
        onDragOver={(event) => {
          const item = dragged.current
          if (!item || !accepts(which, item)) {
            event.dataTransfer.dropEffect = 'none'
            setOver(null)
            setDropAt(null)
            return
          }
          event.preventDefault()
          // Something new lights the shelf up; what is on it already only shows where it would go.
          event.dataTransfer.dropEffect = item.type === 'chip' ? 'move' : 'copy'
          setOver(item.type === 'chip' ? null : which)
          const at = dropPlace(event.currentTarget, which, event.clientX, event.clientY)
          // No line where dropping would leave everything where it is.
          if (item.type === 'chip' && !moveOnShelf(state, which, item.key, at)) setDropAt(null)
          else setDropAt((current) => (current?.shelf === which && current.at === at ? current : { shelf: which, at }))
        }}
        onDragLeave={(event) => {
          // Moving over the items on the shelf is not leaving it.
          if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
          setOver(null)
          setDropAt(null)
        }}
        onDrop={(event) => {
          event.preventDefault()
          const item = dragged.current
          if (item && accepts(which, item)) {
            const at = dropPlace(event.currentTarget, which, event.clientX, event.clientY)
            if (item.type === 'chip') {
              const patch = moveOnShelf(state, which, item.key, at)
              if (patch) select(patch)
            } else if (item.type === 'dynamic') addDynamic(item.kind, at)
            else if (item.type === 'param') addParam(item.param)
            else add(item.field, which, at)
          }
          dragged.current = null
          setOver(null)
          setDropAt(null)
        }}
      >
        <span className="shelf-label">{t(pivot && which === 'dimension' ? 'explore.pivotRows' : `explore.${which}s`)}</span>
        <span className="shelf-items">
          {empty && <span className="shelf-hint">{t('explore.dropHint')}</span>}
          {which === 'filter'
            ? [...(state.params ?? []).map(paramChip), ...state.filters.map(filterChip)]
            : which === 'metric'
              ? state.measures.map(metricChip)
              : chosen.map((key) => {
                const dynamic = state.dynamics?.find((dynamic) => dynamic.alias === key)
                if (dynamic) return dynamicChip(dynamic, which)
                // Hiding removes a field from the picker, not from an existing selection.
                const field = spec.fields.find((field) => field.key === key)
                return field && fieldChip(field, which === 'column' ? 'columns' : 'dimensions', which)
              })}
        </span>
      </div>
    )
  }

  // The preview follows the controls for presentation, but only shows data that was actually queried.
  // A result for fields that no longer fit the chart's type is not shown: it would be read as the chart.
  const shown = shape ? null : outcome && resolved && outcome.asked === queryKey ? { ...outcome, spec: resolved } : outcome
  const stale = !shape && Boolean(outcome) && outcome!.asked !== queryKey

  // Over every column of the chart, as the table lays them out while edited, so one the result leaves out keeps its group.
  const chartColumns = outputNames(state)
  // A table's headers are grouped on the table as it is drawn, and only while it shows what is asked for now.
  const groupingHeaders = !readOnly && tabular && Boolean(shown) && !stale && shown!.spec.viz.type === 'table' && shown!.result.columns.every((column) => chartColumns.includes(column.name))
  const headerLayout: ColumnItem[] = groupingHeaders ? layoutColumns(shown!.spec.viz.columnGroups, chartColumns) : []
  const setHeaderLayout = (items: ColumnItem[]) => {
    const columnGroups = groupsOf(items)
    select({ columnGroups: columnGroups.length ? columnGroups : undefined })
  }
  const headerPick = headers?.pick
  const headerEditing = groupingHeaders
    ? {
        columns: chartColumns,
        selected: headerPick ? pickedPaths(headerPick) : [],
        renaming: headers?.renaming,
        onSelect: (path: number[], extend: boolean) => setHeaderState({ key: headerKey, pick: pickHeader(headerPick, path, extend) }),
        onRenameStart: (path: number[]) => setHeaderState({ key: headerKey, pick: pickHeader(undefined, path, false), renaming: path }),
        onRename: (path: number[], label?: string) => {
          if (label !== undefined) setHeaderLayout(renameGroup(headerLayout, path, label))
          setHeaderState({ key: headerKey, pick: headerPick })
        },
      }
    : undefined
  const groupHeaders = () => {
    const { items, path } = groupPicked(headerLayout, headerPick!, t('explore.columnGroups.defaultName'))
    setHeaderLayout(items)
    // The new group is picked, with its name ready to be written.
    setHeaderState({ key: headerKey, pick: pickHeader(undefined, path, false), renaming: path })
  }

  const columns = shown ? namedColumns(shown.result).columns : []
  const rowsTable = shown && <ResultRows result={shown.result} formats={shown.spec.viz.formats} label={t('explore.result')} />

  const canvas = (
    <section className="chart-main" aria-label={t('explore.result')}>
      {!readOnly && (
        <div className="shelves" inert={loadingDataset}>
          {detail ? (
            shelf('column')
          ) : (
            <>
              {shelf('dimension')}
              {pivot && shelf('pivotColumn')}
              {shelf('metric')}
            </>
          )}
          {shelf('filter')}
          {/* How finely time is cut says nothing unless a dimension is a time. */}
          {hasTimeDimension && (
            <div className="shelf">
              <span className="shelf-label">{t('explore.grain')}</span>
              <span className="shelf-items">
                <Select<Grain> size="sm" aria-label={t('explore.grain')} value={state.grain} options={grains.map((value) => ({ value, label: t(`explore.grains.${value}`) }))} onChange={(grain) => select({ grain })} />
              </span>
            </div>
          )}
        </div>
      )}
      <div className="chart-bar">
        <span className="chart-query-action">
          <Button size="sm" icon={<Icon name={running ? 'stop' : 'play'} />} danger={running} onClick={running ? cancel : () => void run(true)} disabled={!running && (!ready || blocked)}>
            {running ? t('common.cancel') : t('explore.run')}
          </Button>
        </span>
        {!readOnly && (
          <Checkbox checked={autoRun} onChange={setAutoRun}>
            {t('explore.autoRun')}
          </Checkbox>
        )}
        {ready && shown && !blocked && shown.result.meta.truncated && (current?.query.limit === undefined || Number(current.query.limit) > (queryRows?.max ?? Infinity)) && (
          <span className="wb-bottom-note warning chart-query-limit">{t('explore.truncated', { count: shown.result.rows.length })}</span>
        )}
        <div className="chart-query-meta">
          {repeated !== undefined && <span className="wb-bottom-note warning">{t('explore.duplicateName', { name: repeated })}</span>}
          {stale && <span className="wb-bottom-note warning">{t('workbench.staleChart')}</span>}
          {!running && shown && (
            <span className="chart-query-summary" role="status">
              <span>{t('explore.queryTime', { ms: shown.result.meta.durationMs })}</span>
              <span>{t('explore.displayedRows', { count: shown.result.rows.length })}</span>
            </span>
          )}
        </div>
      </div>
      <div className="chart-stage" aria-busy={loadingDataset}>
        {(controls.length > 0 || dynamics.length > 0) && (
          <ChartFilterBar className="chart-preview-filters" style={current?.filterStyle} disabled={!ready} onStyleChange={readOnly ? undefined : (filterStyle) => select({ filterStyle })}>
            <DynamicControls dynamics={dynamics} values={dynamicPreview.values} onChange={dynamicPreview.setValue} fields={spec.fields} disabled={!ready} />
            {controls.map((filter) => {
              if (isParamFilter(filter)) {
                const param = paramOf(filter)
                if (!param) return null
                const label = filter.label || param.label || param.name
                return (
                  <span className="widget-filter" key={preview.keys[filter.id]}>
                    <span className="note small">{label}</span>
                    <ParamFilterControl size="sm" disabled={!ready} debounce={readOnly || autoRun} kind={filter.control!.type} info={paramControl(filter, param, needing.has(param.name))} label={label}
                      value={filter.id in preview.values ? preview.values[filter.id] : paramDefault(filter, param)} onChange={(value) => preview.setValue(filter.id, value)} />
                  </span>
                )
              }
              const label = filter.label || spec.fields.find((field) => field.key === filter.field)?.label || filter.field
              return (
                <span className="widget-filter" key={preview.keys[filter.id]}>
                  <span className="note small"><FilterLabel label={label} op={filter.op} /></span>
                  <FilterControl size="sm" disabled={!ready} debounce={readOnly || autoRun} control={filter.control!} label={filterCaption(label, filter.op, t)}
                    value={cascade.shown(filter.id, filter.id in preview.values ? preview.values[filter.id] : filter.value)}
                    onChange={(value) => void cascade.change(filter, value)} loadOptions={optionsOf(filter)} optionsKey={optionsKeyOf(filter)} />
                </span>
              )
            })}
          </ChartFilterBar>
        )}
        <DrillCrumbs position={position} onBack={(depth) => drillTo({ key: configKey, position: { ...position!, steps: position!.steps.slice(0, depth) } })} />
        {loadingDataset || !dataset ? (
          <p className="empty">{loadingDataset ? t('common.loading') : t('explore.chooseDatasetFirst')}</p>
        ) : !shown || blocked ? (
          <p className="empty">{shape ? t(`explore.shape.${shape.problem}`, { type: t(`vizTypes.${state.vizType}`), max: shape.max }) : running ? t('explore.running') : nothingPicked ? t(detail ? 'explore.pickColumns' : 'explore.pick') : emptyPreview ? t('dynamics.emptyPreview') : t('workbench.notRun')}</p>
        ) : (
          <>
            {groupingHeaders && (
              <ColumnGroupTools
                layout={headerLayout}
                pick={headerPick}
                onGroup={groupHeaders}
                onRename={() => setHeaderState({ key: headerKey, pick: headerPick, renaming: [...headerPick!.parent, headerPick!.anchor] })}
                onUngroup={() => {
                  setHeaderLayout(ungroup(headerLayout, [...headerPick!.parent, headerPick!.anchor]))
                  setHeaderState(undefined)
                }}
              />
            )}
            {/* Clicking anywhere but the headers lets go of those picked. */}
            <div className="chart-fit" ref={setStage} onClick={groupingHeaders ? (event) => !(event.target as Element).closest('thead') && setHeaderState(undefined) : undefined}>
              <ChartView
                viz={shown.spec.viz}
                result={shown.result}
                pageKey={shown.asked}
                colorScheme={colorScheme}
                height={shown.spec.viz.type === 'kpi' ? 96 + (shown.spec.viz.style?.size === 'large' ? 24 : 0) : Math.max(120, stageHeight)}
                onColumnResize={readOnly ? undefined : (column, width) => select({ style: { ...state.style, widths: { ...state.style?.widths, [column]: width } } })}
                headerEditing={headerEditing}
                // A value clicked is drilled into, as on a dashboard, but only while the preview shows what is asked for.
                clickActions={drill && !stale && drillDown(drill, position, t) ? {
                  columns: [drill.alias],
                  items: (column, value) => [{
                    key: 'drill',
                    label: drillDown(drill, position, t)!.label,
                    onSelect: () => drillTo({ key: configKey, position: drilledInto(position, value, applyFormats(namedColumns(shown.result), shown.spec.viz.formats).columns.find((other) => other.name === column), t, firstWeekDays) }),
                  }],
                } : undefined}
                label={t('explore.chartLabel', {
                  measures: columns.filter((column) => column.role === 'measure').map((column) => column.label ?? column.name).join('、'),
                  type: t(`vizTypes.${shown.spec.viz.type}`),
                })}
              />
            </div>
          </>
        )}
      </div>
    </section>
  )

  return (
    <div className="chart-editor">
      {/* A new chart asked for again on this very page starts over, which loses the draft as leaving does. */}
      <UnsavedGuard dirty={dirty} discards={(next) => !chart && (next.state as { chartEditorKey?: string } | null)?.chartEditorKey !== editorKey} />
      <header className="editor-header" inert={saving}>
        <div className="editor-title">
          <TitleText className="name" label={t('explore.chartName')} placeholder={t('explore.chartName')} locked={readOnly || Boolean(chart && !dataset)} value={name} onChange={setName} />
          {(!readOnly || description) && <TitleText className="description" label={t('common.description')} placeholder={t('common.addDescription')} locked={readOnly || Boolean(chart && !dataset)} value={description} onChange={setDescription} />}
        </div>
        {!readOnly && (
          <Button variant="primary" onClick={() => void save()} loading={saving} disabled={!dirty || saving || !ready || !name.trim() || nothingPicked || Boolean(shape) || Boolean(unfinished) || Boolean(dynamicProblem) || visibilityProblem || Boolean(drillIssue)}>
            {saving ? t('common.saving') : t('common.save')}
          </Button>
        )}
      </header>
      {readOnly && <Alert tone="warning" title={t('explore.notEditable')} />}
      {!readOnly && dynamicProblem && <Alert tone="warning" title={t(`dynamics.problems.${dynamicProblem}`)} />}
      {visibilityProblem && <Alert tone="warning" title={t('explore.keepVisibleColumn')}>{t('explore.visibleColumnHint')}</Alert>}
      {drillIssue && <Alert tone="warning" title={t(`drill.problems.${drillIssue}`)} />}
      {error && <ErrorAlert error={error} />}
      {current && <SaveConflict state={conflict} local={{ name, description, spec: current as unknown as Record<string, unknown> }} onApply={applyConflict} prepareLatest={prepareLatest} />}
      {datasetError && (
        <div className="chart-dataset-error">
          <ErrorAlert error={datasetError} />
          <Button size="sm" disabled={loadingDataset} onClick={retryDataset}>{t('common.retry')}</Button>
        </div>
      )}

      <div className="chart-editor-body" inert={saving}>
        {!readOnly && (
          <>
            <aside className="field-outline" style={{ width: fieldsWidth }}>
              <div className="chart-dataset">
                <DatasetPicker
                  value={dataset?.id}
                  selectedName={dataset?.name}
                  onChange={chooseDataset}
                  defaultOpen={!datasetRequest.id}
                  disabled={saving || loadingDataset}
                  actions={dataset && (
                    <Tooltip title={t('explore.editDataset')}>
                      <Link className="wb-icon-button" target="_blank" rel="noopener noreferrer" to={`/workbench/datasets/${dataset.id}`} aria-label={t('explore.editDataset')}><Icon name="external" size={14} /></Link>
                    </Tooltip>
                  )}
                />
              </div>
              <Input size="sm" aria-label={t('dataset.searchFields')} placeholder={t('dataset.searchFields')} value={filter} onChange={setFilter} disabled={!ready} />
              <div className="outline-list" aria-busy={loadingDataset}>
                {loadingDataset ? <p className="wb-side-empty">{t('common.loading')}</p> : dataset && <>
                  {fieldRoles.map((role) => <div key={role}>{fieldList(role)}</div>)}
                  {dynamicList}
                  {paramList}
                </>}
              </div>
            </aside>
            <Resizer direction="horizontal" grows="forward" size={fieldsWidth} min={160} max={420} onResize={setFieldsWidth} label={t('dataset.resizeOutline')} />
            <aside className="chart-config" style={{ width: configWidth }}>
              <h2>{t('explore.chartType')}</h2>
              <div className="viz-types">
                {vizIcons.map(([type, icon]) => {
                  // A table stays the kind of table it is when it is chosen again.
                  const chosen = type === 'table' ? tabular : state.vizType === type
                  return (
                    // Told apart by their pictures; pointing at one says its name.
                    // Any type can be chosen before its fields are; pointing at one says what it takes.
                    <Tooltip key={type} title={!ready ? t('explore.chooseDatasetFirst') : type === 'table' ? t(`vizTypes.${type}`) : `${t(`vizTypes.${type}`)} · ${t(`explore.needs.${type}`)}`}>
                      <button
                        type="button"
                        className={chosen ? 'active' : undefined}
                        aria-label={t(`vizTypes.${type}`)}
                        aria-pressed={chosen}
                        disabled={!ready}
                        onClick={() => !chosen && setState((current) => withType(current, type, spec.fields))}
                      >
                        <Icon name={icon} size={20} />
                      </button>
                    </Tooltip>
                  )
                })}
              </div>
              {/* Whether a table groups its rows changes what can be put on it, so the choice is always in sight, never folded away. */}
              {tabular && (
                <div className="table-mode">
                  <Segmented
                    block
                    aria-label={t('explore.tableMode')}
                    value={detail ? 'detail' : 'table'}
                    options={tableModes.map((mode) => ({ value: mode, label: t(`explore.tableModes.${mode}`), disabled: !ready || !fits(mode) }))}
                    onChange={(mode) => setState((current) => withType(current, mode, spec.fields))}
                  />
                  {ready && !detail && (hasAggregateFilters ? <p className="note small">{t('filter.detailWithMetric')}</p> : dynamics.length > 0 && <p className="note small">{t('dynamics.detailHint')}</p>)}
                </div>
              )}
              {/* A group of a kind of chart shows only when there is something in it. The general settings, which every chart has and are set less often, come last. */}
              <div className="config-sections">
                <ChartStyleSettings
                  type={detail ? 'table' : (state.vizType as Exclude<BuilderType, 'detail'>)}
                  style={state.style}
                  onStyle={(style) => select({ style })}
                  measures={styledMeasures}
                  split={state.dimensions.length === 2}
                  stackable={stackable}
                  stacked={state.stacked}
                  onStacked={(stacked) => select({ stacked })}
                  lines={state.lines ?? styledMeasures.slice(1).map((measure) => measure.column)}
                  rightAxis={state.rightAxis ?? []}
                  onCombo={(patch) => select({ lines: state.lines ?? styledMeasures.slice(1).map((measure) => measure.column), ...patch })}
                  colorScheme={colorScheme}
                  disabled={!ready}
                  totals={(state.vizType === 'table' || pivot) && !detail ? { on: Boolean(state.totals), onChange: (totals) => select({ totals: totals || undefined }), omitted: hasAggregateFilters, ...(pivot && hasSubtotals(state) ? { subtotals: { on: Boolean(state.subtotals), fit: subtotalsFit(state), onChange: (subtotals) => select({ subtotals: subtotals || undefined }) } } : {}) } : undefined}
                  compare={state.compare}
                  onCompare={(compare) => select({ compare })}
                />
                <ConfigSection storageKey="supabi.chart.section.general" title={t('explore.general')}>
                  <RowLimit value={state.limit} disabled={!ready} paged={tabular && Boolean(state.style?.paging)} onChange={(limit) => select({ limit })} />
                  <div className="chart-export-setting">
                    <Checkbox checked={Boolean(state.allowExport)} disabled={!ready} onChange={(allowExport) => select({ allowExport: allowExport || undefined })}>{t('explore.allowExport')}</Checkbox>
                    <p className="note small">{t(state.allowExport && state.limit ? 'explore.allowExportLimited' : 'explore.allowExportHint', { count: state.limit })}</p>
                  </div>
                </ConfigSection>
              </div>
            </aside>
            <Resizer direction="horizontal" grows="forward" size={configWidth} min={120} max={360} onResize={setConfigWidth} label={t('explore.resizeConfig')} />
          </>
        )}
        {canvas}
      </div>

      <Dialog
        open={pendingDataset !== null}
        title={t('explore.changeDatasetTitle')}
        width={440}
        onClose={() => setPendingDataset(null)}
        actions={<><Button onClick={() => setPendingDataset(null)}>{t('common.cancel')}</Button><Button variant="primary" onClick={() => pendingDataset && requestDataset(pendingDataset)}>{t('explore.changeDataset')}</Button></>}
      >
        <p>{t('explore.changeDatasetBody')}</p>
      </Dialog>

      {editing && (
        <FilterDialog
          filter={editing.filter}
          isNew={editing.isNew}
          field={spec.fields.find((field) => field.key === editing.filter.field)!}
          availableFilters={state.filters}
          fields={spec.fields}
          allowAggregation={!detail}
          loadOptions={optionsOf(editing.filter)}
          onCancel={() => setEditing(null)}
          onDone={(next) => {
            const filters = editing.isNew ? [...state.filters, next] : state.filters.map((other) => (other.id === next.id ? next : other))
            const patch = { filters: filters.map((filter) => ({ ...filter, ...(filter.dependsOn ? { dependsOn: filter.dependsOn.filter((id) => filters.some((parent) => parent.id === id && canCascade(parent))) } : {}) })) }
            select(editing.isNew ? placedOnShelf(state, patch, 'filter', editing.at) : patch)
            setEditing(null)
          }}
        />
      )}

      {editingParam && paramOf(editingParam.filter) && (
        <ParamFilterDialog
          filter={editingParam.filter}
          param={paramOf(editingParam.filter)!}
          needsValue={needing.has(editingParam.filter.param)}
          isNew={editingParam.isNew}
          onCancel={() => setEditingParam(null)}
          onDone={(next) => {
            const others = state.params ?? []
            select({ params: editingParam.isNew ? [...others, next] : others.map((other) => (other.id === next.id ? next : other)) })
            setEditingParam(null)
          }}
        />
      )}

      {computing !== null && state.measures[computing] && <ComputeDialog
        value={state.measures[computing]!.compute}
        timeFields={spec.fields.filter((field) => field.role !== 'metric' && isTemporal(field.type))}
        filters={state.filters}
        name={state.measures[computing]!.label ?? spec.fields.find((field) => field.key === state.measures[computing]!.field)?.label ?? state.measures[computing]!.field}
        dimensions={state.dimensions.map((key) => {
          const slot = state.dynamics?.find((slot) => slot.kind === 'dimension' && slot.alias === key)
          const temporal = (field: string) => spec.fields.some((candidate) => candidate.key === field && isTemporal(candidate.type))
          return { key, label: state.labels[key] ?? spec.fields.find((field) => field.key === key)?.label ?? slot?.label ?? key, temporal: slot ? slot.options.every((option) => temporal(option.field)) : temporal(key) }
        })}
        accumulates={(() => {
          const measure = state.measures[computing]!
          const slot = state.dynamics?.find((slot) => slot.kind === 'measure' && slot.alias === measure.field)
          return slot ? slot.options.every((option) => accumulates(option.agg)) : accumulates(measure.agg)
        })()}
        onCancel={() => setComputing(null)}
        onDone={(compute, period) => {
          const patch = recomputed(state, computing, compute)
          if (compute?.type === 'compare' && period) {
            const existing = state.filters.find((filter) => filter.field === compute.timeField && !filter.aggregation)
            const field = spec.fields.find((field) => field.key === compute.timeField)!
            const filter: ChartFilter = { ...(existing ?? newFilter(field, new Set(state.filters.map((filter) => filter.id)))), op: 'time', value: period, ...(existing?.control?.type === 'date' ? { control: { type: 'relative' as const } } : {}) }
            select({ ...patch, filters: existing ? state.filters.map((entry) => entry.id === existing.id ? filter : entry) : [...state.filters, filter] })
          } else select(patch)
          setComputing(null)
        }}
      />}
      {formatting && (
        <FormatDialog
          name={formatting.name}
          value={state.formats?.[formatting.column]}
          inherited={{ format: formatting.inherited }}
          type={formatting.type}
          onDone={(format) => {
            const rest = Object.fromEntries(Object.entries(state.formats ?? {}).filter(([column]) => column !== formatting.column))
            const formats = format ? { ...rest, [formatting.column]: format } : rest
            select({ formats: Object.keys(formats).length ? formats : undefined })
            setFormatting(null)
          }}
          onCancel={() => setFormatting(null)}
        />
      )}
      {highlighting && (
        <HighlightDialog
          name={highlighting.name}
          value={state.style?.highlights?.[highlighting.column]}
          format={highlighting.format}
          scheme={colorScheme}
          onDone={(rules) => {
            const rest = Object.fromEntries(Object.entries(state.style?.highlights ?? {}).filter(([column]) => column !== highlighting.column))
            const highlights = rules ? { ...rest, [highlighting.column]: rules } : rest
            select({ style: { ...state.style, highlights: Object.keys(highlights).length ? highlights : undefined } })
            setHighlighting(null)
          }}
          onCancel={() => setHighlighting(null)}
        />
      )}
      {drilling && (
        <DrillDialog
          first={groupingOf(state, drilling, spec.fields)}
          levels={state.drill?.alias === drilling ? state.drill.levels : undefined}
          others={otherGroupings(state, drilling, spec.fields)}
          fields={spec.fields}
          onCancel={() => setDrilling(null)}
          onDone={(levels) => {
            select({ drill: levels ? { alias: drilling, levels } : undefined })
            setDrilling(null)
          }}
        />
      )}
      {editingDynamic && <DynamicFieldDialog dynamic={editingDynamic} fields={spec.fields} onCancel={() => setEditingDynamic(null)} onDone={(next) => {
        const exists = state.dynamics?.some((dynamic) => dynamic.id === next.id)
        const patch = {
          dynamics: exists ? state.dynamics!.map((dynamic) => dynamic.id === next.id ? next : dynamic) : [...(state.dynamics ?? []), next],
          ...(!exists && next.kind === 'dimension' ? { dimensions: [...state.dimensions, next.alias] } : {}),
          ...(!exists && next.kind === 'measure' ? { measures: [...state.measures, { field: next.alias }] } : {}),
        }
        select(exists ? patch : placedOnShelf(state, patch, next.kind === 'dimension' ? 'dimension' : 'metric', dynamicAt.current))
        setEditingDynamic(null)
      }} />}

      {shown && <StatusItem>{t('explore.rows', { count: shown.result.rows.length, ms: shown.result.meta.durationMs })}</StatusItem>}

      <BottomPanel
        tabs={[
          {
            key: 'data',
            label: t('workbench.data'),
            content: rowsTable ?? <p className="empty">{t('workbench.notRun')}</p>,
          },
          { key: 'diagnostics', label: t('diagnostics.title'), content: <QueryDiagnostics result={outcome?.result} stale={Boolean(outcome && (outcome.asked !== queryKey || blocked || !ready))} running={running} notice={queryNotice} /> },
          { key: 'query', label: t('explore.showQuery'), content: current ? <pre className="code">{JSON.stringify(current, null, 2)}</pre> : <p className="empty">{t('explore.chooseDatasetFirst')}</p> },
          {
            key: 'usages',
            label: t('workbench.usages'),
            // A chart that has not been saved is on no dashboard yet.
            content: chart ? <Usages kind="chart" id={chart.id} /> : <p className="empty">{t('workbench.noUsages')}</p>,
          },
          { key: 'revisions', label: t('revisions.title'), content: <RevisionList kind="chart" id={conflict.base?.id} revision={conflict.base?.revision} /> },
        ]}
      />
    </div>
  )
}

/**
 * The chart editor: pick fields of a dataset, choose how to draw them, save.
 * Dataset selection lives in the editor, including before any is selected.
 */
export function ChartEditor({ colorScheme }: { colorScheme: ColorScheme }) {
  const { id } = useParams()
  const location = useLocation()
  // Choosing inside this editor preserves its draft; a new entry from “+” or
  // a dataset's “create chart” link starts a fresh editor, even on the same path.
  const editorKey = (location.state as { chartEditorKey?: string } | null)?.chartEditorKey ?? location.key
  const chart = useAsync(() => (id ? unwrap(api.GET('/charts/{id}', { params: { path: { id } } })) : Promise.resolve(undefined)), [id])

  return (
    <Async state={chart} reload={chart.reload}>
      {(loadedChart) => <Builder key={loadedChart?.id ?? editorKey} chart={loadedChart} colorScheme={colorScheme} editorKey={editorKey} />}
    </Async>
  )
}
