// @vitest-environment jsdom
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { openPopup } from '@supabi/ui/testing'
import { useState } from 'react'
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../i18n'
import i18n from 'i18next'

const server = vi.hoisted(() => {
  interface Call {
    method: string
    path: string
    id?: string
    filterId?: string
    body?: Record<string, unknown>
    signal?: AbortSignal
  }
  const answer = (data: unknown, status = 200) => ({ data, response: { ok: status < 400, status, statusText: '' }, error: status < 400 ? undefined : data })
  const state = {
    calls: [] as Call[],
    datasets: [] as Record<string, unknown>[],
    charts: [] as Record<string, unknown>[],
    folders: [] as Record<string, unknown>[],
    failDataset: '',
    /** Whether a table whose headers can be grouped is drawn as well, for the tests that pick them. */
    drawTables: false,
    query: null as null | ((body: Record<string, unknown>, signal?: AbortSignal) => Promise<ReturnType<typeof answer>>),
    chartData: null as null | ((body: Record<string, unknown>, signal?: AbortSignal) => Promise<ReturnType<typeof answer>>),
    save: null as null | ((body: Record<string, unknown>) => Promise<ReturnType<typeof answer>>),
    options: null as null | ((filterId: string, body: Record<string, unknown>) => Promise<ReturnType<typeof answer>>),
    queryRows: { default: 1000, max: 10000 },
  }
  const handle = (method: string) => async (path: string, options?: { params?: { path?: { id?: string; filterId?: string } }; body?: Record<string, unknown>; signal?: AbortSignal }) => {
    const id = options?.params?.path?.id
    const body = options?.body
    const signal = options?.signal
    state.calls.push({ method, path, id, filterId: options?.params?.path?.filterId, body, signal })
    switch (`${method} ${path}`) {
      case 'GET /datasets':
        return answer(state.datasets.map(({ id, name, folderId }) => ({ id, name, folderId })))
      case 'GET /folders':
        return answer(state.folders)
      case 'GET /datasets/{id}':
        return state.failDataset === id ? answer({ code: 'temporary', message: 'Dataset temporarily unavailable' }, 503) : answer(state.datasets.find((dataset) => dataset.id === id))
      case 'GET /charts/{id}':
        return answer({ description: '', revision: 1, ...state.charts.find((chart) => chart.id === id) })
      case 'POST /query': {
        if (state.query) return state.query(body!, signal)
        const query = body!.query as { dataset: string; columns?: string[] }
        return answer({ columns: [{ name: query.columns?.[0] ?? 'region', type: 'string', role: 'dimension' }], rows: [[query.dataset === 'orders' ? 'North' : 'Warehouse']], meta: { durationMs: 4 } })
      }
      case 'POST /charts/{id}/data':
      case 'POST /charts/preview/data':
        if (state.chartData) return state.chartData(body!, signal)
        return answer({ columns: [{ name: 'region', type: 'string', role: 'dimension' }], rows: [['North']], meta: { durationMs: 4 } })
      case 'POST /charts/preview/filters/{filterId}/options':
      case 'POST /charts/{id}/filters/{filterId}/options':
        return state.options ? state.options(options!.params!.path!.filterId!, body!) : answer({ values: [], truncated: false })
      case 'PUT /charts/{id}':
        return state.save ? state.save(body!) : answer({ ...state.charts.find((chart) => chart.id === id), id, ...body, revision: Number(body!.expectedRevision) + 1 })
      case 'POST /charts': {
        const chart = { id: 'chart_created', datasetId: ((body!.spec as Record<string, unknown>).query as Record<string, unknown>).dataset, ...body }
        state.charts.push(chart)
        return answer(chart, 201)
      }
    }
    return answer([])
  }
  return { state, answer, api: { GET: handle('GET'), POST: handle('POST'), PUT: handle('PUT'), DELETE: handle('DELETE') } }
})

vi.mock('../api/client', async (original) => ({ ...(await original<typeof import('../api/client')>()), api: server.api }))
vi.mock('../auth/session', () => ({ useSession: () => ({ atLeast: () => true }), useWeekStart: () => 1, useFirstWeekDays: () => 4, useWorkspaceTimezone: () => undefined, useQueryRows: () => server.state.queryRows }))
// A table whose headers can be grouped is drawn too where a test asks, so they can be picked.
// What a value clicked offers is drawn as buttons below it.
vi.mock('../components/ChartView', async (original) => {
  const actual = await original<typeof import('../components/ChartView')>()
  const { useState } = await vi.importActual<typeof import('react')>('react')
  type Item = { key: string; label: unknown; onSelect?: () => void }
  function Clicks({ actions }: { actions: NonNullable<Parameters<typeof actual.ChartView>[0]['clickActions']> }) {
    const [items, setItems] = useState<Item[]>([])
    return <>
      {actions.columns.map((column) => <button key={column} onClick={() => setItems(actions.items(column, 'North'))}>Click North in {column}</button>)}
      {items.map((item) => <button key={item.key} onClick={() => { setItems([]); item.onSelect?.() }}>{String(item.label)}</button>)}
    </>
  }
  return {
    ...actual,
    ChartView: (props: Parameters<typeof actual.ChartView>[0]) => (
      <>
        <div data-testid="chart" data-viz={JSON.stringify(props.viz)} />
        {props.clickActions && <Clicks actions={props.clickActions} />}
        {props.headerEditing && server.state.drawTables && <actual.ChartView {...props} />}
      </>
    ),
  }
})

import { WorkbenchProvider } from '../workbench/context'
import type { Slots } from '../components/EditorPanels'
import { ChartEditor } from './ChartEditor'
import { UnsavedChangesProvider } from '../components/UnsavedChanges'
import { buildSpec, type BuilderState } from '../lib/builder'
import type { SpecField } from '../api/spec'

function Page() {
  const [slots, setSlots] = useState<Slots>({ side: null, aside: null, bottom: null, status: null })
  const [bottom] = useState(() => (node: HTMLElement | null) => setSlots((current) => current.bottom === node ? current : { ...current, bottom: node }))
  const location = useLocation()
  return (
    <WorkbenchProvider slots={slots} recent={[]}>
      <ChartEditor colorScheme="light" />
      <div data-testid="bottom" ref={bottom} />
      <output data-testid="where">{location.pathname}{location.search}</output>
    </WorkbenchProvider>
  )
}

function open(path = '/workbench/charts/new') {
  const router = createMemoryRouter([{ path: '/workbench/charts/new', element: <Page /> }, { path: '/workbench/charts/:id', element: <Page /> }], { initialEntries: [path] })
  return { ...render(<UnsavedChangesProvider><RouterProvider router={router} /></UnsavedChangesProvider>), router }
}

const calls = (method: string, path: string) => server.state.calls.filter((call) => call.method === method && call.path === path)
const picker = () => screen.getByRole<HTMLInputElement>('combobox', { name: 'Search datasets' })
const title = () => screen.getByRole<HTMLInputElement>('textbox', { name: 'Chart name', hidden: true })
const description = () => screen.getByRole<HTMLInputElement>('textbox', { name: 'Description' })
const fields = () => within(document.querySelector<HTMLElement>('.outline-list')!)
const columns = () => screen.getByText('Columns', { selector: '.shelf-label' }).closest<HTMLElement>('.shelf')!

const changeDataset = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Change dataset' })

async function choose(name: string) {
  // Once a dataset is chosen, its name is text and another is chosen from the button beside it.
  fireEvent.click(screen.queryByRole('button', { name: 'Change dataset' }) ?? picker())
  fireEvent.change(picker(), { target: { value: name } })
  fireEvent.click(await screen.findByText(name, { selector: '.wb-row-name' }))
}

async function addDimension(name: string) {
  const source = (await fields().findByText(name)).closest<HTMLElement>('[draggable]')!
  const shelf = screen.getByText('Dimensions', { selector: '.shelf-label' }).closest<HTMLElement>('.shelf')!
  const dataTransfer = { setData: () => undefined, effectAllowed: '' }
  fireEvent.dragStart(source, { dataTransfer })
  fireEvent.dragOver(shelf, { dataTransfer })
  fireEvent.drop(shelf, { dataTransfer })
  fireEvent.dragEnd(source, { dataTransfer })
}

async function addColumn(name: string) {
  const source = (await fields().findByText(name)).closest<HTMLElement>('[draggable]')!
  const dataTransfer = { setData: () => undefined, effectAllowed: '' }
  fireEvent.dragStart(source, { dataTransfer })
  fireEvent.dragOver(columns(), { dataTransfer })
  fireEvent.drop(columns(), { dataTransfer })
  fireEvent.dragEnd(source, { dataTransfer })
}

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  localStorage.clear()
  server.state.calls = []
  server.state.charts = []
  server.state.failDataset = ''
  server.state.drawTables = false
  server.state.query = null
  server.state.chartData = null
  server.state.save = null
  server.state.options = null
  server.state.queryRows = { default: 1000, max: 10000 }
  server.state.folders = [
    { id: 'commerce', kind: 'dataset', name: 'Commerce', private: false },
    { id: 'regional', kind: 'dataset', name: 'Regional', parentId: 'commerce', private: false },
    { id: 'charts', kind: 'chart', name: 'Executive reports', private: false },
  ]
  server.state.datasets = [
    { id: 'orders', name: 'Orders', datasourceId: 'src', folderId: 'regional', spec: { specVersion: 1, source: { type: 'table', table: 'orders' }, fields: [{ key: 'region', label: 'Region', type: 'string', role: 'dimension', column: 'region' }] } },
    { id: 'inventory', name: 'Inventory', datasourceId: 'src', spec: { specVersion: 1, source: { type: 'table', table: 'inventory' }, fields: [{ key: 'sku', label: 'SKU', type: 'string', role: 'dimension', column: 'sku' }] } },
  ]
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never
  window.matchMedia ??= (() => ({ matches: false, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined })) as never
  // jsdom has ordinary computed styles, but no pseudo-element measurements used by Ant's scrollbar probe.
  const computedStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => computedStyle(element))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function filteredChart(query: Record<string, unknown> = {}) {
  const dataset = server.state.datasets[0]!.spec as { fields: Record<string, unknown>[] }
  dataset.fields.push({ key: 'amount', label: 'Amount', type: 'decimal', role: 'measure', column: 'amount' })
  const filters = [
    { id: 'fixed_region', field: 'region', op: 'in', value: ['North'] },
    { id: 'amount_min', field: 'amount', op: 'gte', value: 10, label: 'Amount', control: { type: 'number' } },
  ]
  server.state.charts = [{ id: 'filtered', name: 'Filtered regions', datasetId: 'orders', spec: { specVersion: 1, query: { version: 1, dataset: 'orders', mode: 'detail', columns: ['region'], ...query }, viz: { type: 'table' }, filters } }]
  return filters
}

const previewFilters = () => within(screen.getByRole('group', { name: 'Filters' }))

it('resolves saves against successive latest revisions without overwriting intervening chart changes', async () => {
  filteredChart()
  server.state.charts[0] = { ...server.state.charts[0], revision: 1, description: '' }
  open('/workbench/charts/filtered')
  await waitFor(() => expect(title().readOnly).toBe(false))
  const initialQueries = calls('POST', '/query').length
  fireEvent.change(title(), { target: { value: 'My title' } })
  const first = server.state.charts[0]!
  server.state.charts[0] = { ...first, revision: 2, name: 'Remote title', spec: { ...(first.spec as Record<string, unknown>), allowExport: true } }
  server.state.save = async (body) => {
    const latest = server.state.charts[0]!
    if (body.expectedRevision !== latest.revision) return server.answer({ code: 'resource_revision_conflict' }, 409)
    const saved = { ...latest, ...body, revision: Number(latest.revision) + 1 }
    server.state.charts[0] = saved
    return server.answer(saved)
  }
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  const dialog = within(await screen.findByRole('dialog', { name: 'Resolve save conflict' }))
  const choices = within(await dialog.findByRole('group', { name: 'Name' }))
  fireEvent.click(choices.getByRole('radio', { name: 'Use my changes' }))
  fireEvent.click(dialog.getByRole('button', { name: 'Apply to draft' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(calls('PUT', '/charts/{id}')).toHaveLength(1)
  expect(title().value).toBe('My title')
  await waitFor(() => expect(calls('POST', '/query').length).toBeGreaterThan(initialQueries))
  server.state.charts[0] = { ...server.state.charts[0], revision: 3, description: 'Changed again' }
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(await screen.findByText('Revision 2 → 3')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Apply to draft' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(calls('PUT', '/charts/{id}')).toHaveLength(3))
  const writes = calls('PUT', '/charts/{id}').map((call) => call.body!)
  expect(writes.map((body) => body.expectedRevision)).toEqual([1, 2, 3])
  expect(writes[2]).toMatchObject({ name: 'My title', description: 'Changed again', spec: { allowExport: true } })
})

it('does not report a conflict for stored defaults the builder drops', async () => {
  filteredChart()
  // The builder writes no allowExport: false, so the draft never carries it.
  const stored = server.state.charts[0]!
  server.state.charts[0] = { ...stored, revision: 1, description: '', spec: { ...(stored.spec as Record<string, unknown>), allowExport: false } }
  open('/workbench/charts/filtered')
  await waitFor(() => expect(title().readOnly).toBe(false))
  fireEvent.change(title(), { target: { value: 'My title' } })
  const first = server.state.charts[0]!
  server.state.charts[0] = { ...first, revision: 2, spec: { ...(first.spec as Record<string, unknown>), allowExport: true } }
  server.state.save = async (body) => {
    const latest = server.state.charts[0]!
    if (body.expectedRevision !== latest.revision) return server.answer({ code: 'resource_revision_conflict' }, 409)
    return server.answer({ ...latest, ...body, revision: Number(latest.revision) + 1 })
  }
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  const dialog = within(await screen.findByRole('dialog', { name: 'Resolve save conflict' }))
  await dialog.findByText('Revision 1 → 2')
  // Only the other editor changed the configuration: it is taken automatically.
  expect(dialog.getByRole<HTMLButtonElement>('button', { name: 'Apply to draft' }).disabled).toBe(false)
  fireEvent.click(dialog.getByRole('button', { name: 'Apply to draft' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(calls('PUT', '/charts/{id}')).toHaveLength(2))
  expect(calls('PUT', '/charts/{id}')[1]!.body).toMatchObject({ name: 'My title', expectedRevision: 2, spec: { allowExport: true } })
})

it('reports a dataset changed during the save as a dependency conflict, not a content merge', async () => {
  filteredChart()
  server.state.charts[0] = { ...server.state.charts[0], revision: 1, description: '' }
  open('/workbench/charts/filtered')
  await waitFor(() => expect(title().readOnly).toBe(false))
  fireEvent.change(title(), { target: { value: 'My title' } })
  server.state.save = async () => server.answer({ code: 'dataset_revision_conflict', message: '' }, 409)
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(await screen.findByText('A dataset this content uses changed while it was being saved. Your edits are kept. Reload the latest dataset before saving again.')).toBeTruthy()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(title().value).toBe('My title')
})
const previewAmount = () => previewFilters().getByRole<HTMLInputElement>('textbox', { name: 'Amount' })
const lastQuery = () => calls('POST', '/query').at(-1)!.body!.query as Record<string, unknown>
const querySummary = () => within(document.querySelector<HTMLElement>('.chart-bar')!).getByRole('status')

function diagnosticAnswer(requestId: string, amount: number) {
  return server.answer({
    columns: [{ name: 'region', type: 'string', role: 'dimension' }], rows: [[requestId]],
    meta: { durationMs: 2, cached: false, truncated: false },
    diagnostics: {
      requestId, requestedAt: '2026-10-18T12:30:00Z',
      statements: [{ kind: 'main', by: [], sql: 'SELECT region FROM orders WHERE amount >= $1', args: [amount], durationMs: 2, cached: false, shared: false, fetchedAt: '2026-10-18T12:30:00Z', rowCount: 1, truncated: false }],
    },
  })
}

function dynamicChart(query: Record<string, unknown> = {}) {
  const dataset = server.state.datasets[0]!.spec as { fields: SpecField[] }
  dataset.fields.push(
    { key: 'channel', label: 'Channel', type: 'string', role: 'dimension', column: 'channel' },
    { key: 'amount', label: 'Amount', type: 'decimal', role: 'measure', column: 'amount' },
  )
  const state: BuilderState = {
    dimensions: ['dynamic_group'], measures: [{ field: 'dynamic_metric' }], columns: [], labels: {}, grain: 'month', filters: [], vizType: 'table', stacked: false,
    dynamics: [
      { id: 'group', alias: 'dynamic_group', kind: 'dimension', label: 'Group by', allowEmpty: true, options: [{ id: 'region', field: 'region' }, { id: 'channel', field: 'channel' }] },
      { id: 'metric', alias: 'dynamic_metric', kind: 'measure', label: 'Metric', options: [{ id: 'sum', field: 'amount', agg: 'sum' }, { id: 'avg', field: 'amount', agg: 'avg', label: 'Average amount' }] },
    ],
  }
  const spec = buildSpec('orders', state, dataset.fields)
  server.state.charts = [{ id: 'dynamic', name: 'Dynamic report', datasetId: 'orders', spec: { ...spec, query: { ...spec.query, ...query } } }]
  return spec
}

async function pickSelect(label: string, option: string) {
  openPopup(screen.getByRole('combobox', { name: label }))
  fireEvent.click(await screen.findByRole('option', { name: option }))
}

function dragDynamic(name: string, target: string) {
  const source = fields().getByRole('button', { name })
  const shelf = screen.getByText(target, { selector: '.shelf-label' }).closest<HTMLElement>('.shelf')!
  const dataTransfer = { setData: () => undefined, effectAllowed: '', dropEffect: '' }
  fireEvent.dragStart(source, { dataTransfer })
  fireEvent.dragOver(shelf, { dataTransfer })
  const highlighted = shelf.classList.contains('drop')
  fireEvent.drop(shelf, { dataTransfer })
  fireEvent.dragEnd(source, { dataTransfer })
  return { highlighted, dropEffect: dataTransfer.dropEffect }
}

describe('chart control style', () => {
  it('previews style changes, saves them with the chart, and restores them without changing filter defaults', async () => {
    const defaults = filteredChart()
    const view = open('/workbench/charts/filtered')
    await screen.findByRole('textbox', { name: 'Amount' })
    const bar = screen.getByRole('group', { name: 'Filters' })
    expect(bar.getAttribute('data-layout')).toBe('horizontal')
    fireEvent.click(screen.getByRole('button', { name: 'Chart control style' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Stacked' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Compact' }))
    expect(bar.getAttribute('data-layout')).toBe('vertical')
    expect(bar.getAttribute('data-density')).toBe('compact')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls('PUT', '/charts/{id}')).toHaveLength(1))
    const saved = calls('PUT', '/charts/{id}')[0]!.body!
    expect(saved.spec).toMatchObject({ filterStyle: { layout: 'vertical', density: 'compact' }, filters: defaults })
    view.unmount()
    server.state.charts[0] = { ...server.state.charts[0], ...saved }
    open('/workbench/charts/filtered')
    await screen.findByRole('textbox', { name: 'Amount' })
    expect(screen.getByRole('group', { name: 'Filters' }).getAttribute('data-layout')).toBe('vertical')
    expect(screen.getByRole('group', { name: 'Filters' }).getAttribute('data-density')).toBe('compact')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true)
  })

  it('does not expose style editing for read-only charts', async () => {
    filteredChart({ offset: 25 })
    open('/workbench/charts/filtered')
    await screen.findByRole('textbox', { name: 'Amount' })
    expect(screen.queryByRole('button', { name: 'Chart control style' })).toBeNull()
  })
})

describe('chart editor dynamic fields', () => {
  it('drags dynamic dimensions and metrics from the outline to their shelves and saves their candidates', async () => {
    open('/workbench/charts/new?dataset=orders')
    await screen.findByRole('textbox', { name: 'Chart name' })
    await fields().findByText('Region')
    fireEvent.click(screen.getByRole('radio', { name: 'Aggregated' }))
    expect(document.querySelector('.shelves .dynamic-shelf-add')).toBeNull()
    expect(dragDynamic('Add dynamic dimension', 'Dimensions')).toEqual({ highlighted: true, dropEffect: 'copy' })
    await pickSelect('Add candidate field', 'Region')
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'OK' }))
    await screen.findByRole('combobox', { name: 'Dynamic dimension' })
    expect(dragDynamic('Add dynamic metric', 'Metrics')).toEqual({ highlighted: true, dropEffect: 'copy' })
    await pickSelect('Add candidate field', 'Region')
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'OK' }))
    await screen.findByRole('combobox', { name: 'Dynamic metric' })
    fireEvent.change(title(), { target: { value: 'Dynamic report' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls('POST', '/charts')).toHaveLength(1))
    expect(calls('POST', '/charts')[0]!.body!.spec).toMatchObject({ dynamics: [
      { kind: 'dimension', options: [{ field: 'region' }] },
      { kind: 'measure', options: [{ field: 'region', agg: 'count_distinct' }] },
    ] })
  })

  it('rejects incompatible shelves and leaves no field or query behind when configuration is cancelled', async () => {
    open('/workbench/charts/new?dataset=orders')
    await screen.findByRole('textbox', { name: 'Chart name' })
    await fields().findByText('Region')
    fireEvent.click(screen.getByRole('radio', { name: 'Aggregated' }))
    for (const [source, target] of [['Add dynamic dimension', 'Metrics'], ['Add dynamic metric', 'Dimensions'], ['Add dynamic dimension', 'Filters'], ['Add dynamic metric', 'Filters']]) {
      expect(dragDynamic(source!, target!)).toEqual({ highlighted: false, dropEffect: 'none' })
      expect(screen.queryByRole('dialog')).toBeNull()
    }
    dragDynamic('Add dynamic dimension', 'Dimensions')
    await pickSelect('Add candidate field', 'Region')
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect(document.querySelector('.shelves .dynamic-chip')).toBeNull()
    expect(calls('POST', '/query')).toHaveLength(0)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true)
  })

  it('keeps dynamic entries searchable but disables adding them to detail tables', async () => {
    open('/workbench/charts/new?dataset=orders')
    await screen.findByRole('textbox', { name: 'Chart name' })
    await fields().findByText('Region')
    const dimension = fields().getByRole('button', { name: 'Add dynamic dimension' })
    expect(dimension.getAttribute('aria-disabled')).toBe('true')
    expect(dimension.getAttribute('draggable')).toBe('false')
    fireEvent.click(dimension)
    expect(screen.queryByRole('dialog')).toBeNull()
    dragDynamic('Add dynamic dimension', 'Columns')
    dragDynamic('Add dynamic metric', 'Filters')
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.change(screen.getByRole('textbox', { name: 'Search fields' }), { target: { value: 'Dynamic metric' } })
    expect(fields().queryByRole('button', { name: 'Add dynamic dimension' })).toBeNull()
    expect(fields().getByRole('button', { name: 'Add dynamic metric' })).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: 'Aggregated' }))
    const metric = fields().getByRole('button', { name: 'Add dynamic metric' })
    expect(metric.getAttribute('aria-disabled')).toBe('false')
    fireEvent.click(metric)
    expect(screen.getByRole('dialog', { name: 'Configure Dynamic metric' })).toBeTruthy()
  })

  it('disables dynamic entries at the field limit and enables them after removing a slot', async () => {
    const spec = dynamicChart()
    const template = spec.dynamics![1]!
    for (let index = 2; index < 16; index++) {
      const alias = `extra_${index}`
      spec.dynamics!.push({ ...template, id: alias, alias, label: `Extra ${index}` })
      ;(spec.query.measures as Record<string, unknown>[]).push({ field: 'amount', agg: 'sum', alias })
    }
    open('/workbench/charts/dynamic')
    await screen.findByRole('textbox', { name: 'Chart name' })
    await fields().findByText('Region')
    const source = fields().getByRole('button', { name: 'Add dynamic metric' })
    expect(source.getAttribute('aria-disabled')).toBe('true')
    expect(source.getAttribute('draggable')).toBe('false')
    fireEvent.click(source)
    dragDynamic('Add dynamic metric', 'Metrics')
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Extra 15' }))
    expect(source.getAttribute('draggable')).toBe('true')
    dragDynamic('Add dynamic metric', 'Metrics')
    expect(screen.getByRole('dialog', { name: 'Configure Dynamic metric' })).toBeTruthy()
  })

  it('changes query fields and aggregations while keeping Save disabled and preserving defaults', async () => {
    const saved = dynamicChart()
    open('/workbench/charts/dynamic')
    await screen.findByRole('combobox', { name: 'Group by' })
    await waitFor(() => expect(lastQuery().dimensions).toEqual([{ alias: 'dynamic_group', field: 'region' }]))
    await pickSelect('Group by', 'Channel')
    await waitFor(() => expect(lastQuery().dimensions).toEqual([{ alias: 'dynamic_group', field: 'channel' }]))
    await pickSelect('Metric', 'Average amount')
    await waitFor(() => expect(lastQuery().measures).toEqual([{ field: 'amount', agg: 'avg', alias: 'dynamic_metric', label: 'Average amount' }]))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true)
    fireEvent.change(title(), { target: { value: 'Renamed dynamic report' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls('PUT', '/charts/{id}')).toHaveLength(1))
    expect(calls('PUT', '/charts/{id}')[0]!.body!.spec).toEqual(saved)
  })

  it('allows no dimension and waits for Run with automatic queries off', async () => {
    dynamicChart()
    localStorage.setItem('supabi.chart.autoRun', 'false')
    open('/workbench/charts/dynamic')
    await screen.findByRole('combobox', { name: 'Group by' })
    await waitFor(() => expect(calls('POST', '/query')).toHaveLength(1))
    await pickSelect('Group by', 'None')
    expect(calls('POST', '/query')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    await waitFor(() => expect(lastQuery().dimensions).toEqual([]))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true)
  })

  it('keeps an incomplete optional-dimension draft editable but prevents empty previews and invalid saves', async () => {
    dynamicChart()
    open('/workbench/charts/dynamic')
    await screen.findByRole('button', { name: 'Remove Metric' })
    fireEvent.click(screen.getByRole('button', { name: 'Remove Metric' }))
    await screen.findByText('Before saving, keep at least one metric or a dimension that cannot be cleared.')
    await waitFor(() => expect(lastQuery().measures).toEqual([]))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(calls('PUT', '/charts/{id}')).toHaveLength(0)

    const queried = calls('POST', '/query').length
    await pickSelect('Group by', 'None')
    await screen.findByText('No output columns remain. Select a dimension or add a metric to preview the chart.')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Run' }).disabled).toBe(true)
    expect(calls('POST', '/query')).toHaveLength(queried)

    // Repair the draft without having to discard the optional dimension or its choices.
    fireEvent.click(screen.getByRole('button', { name: 'Add dynamic metric' }))
    await pickSelect('Add candidate field', 'Amount')
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'OK' }))
    await waitFor(() => {
      expect(screen.queryByText('Before saving, keep at least one metric or a dimension that cannot be cleared.')).toBeNull()
      expect(lastQuery().dimensions).toEqual([])
      expect(lastQuery().measures).toHaveLength(1)
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(false)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls('PUT', '/charts/{id}')).toHaveLength(1))
    expect(calls('PUT', '/charts/{id}')[0]!.body!.spec).toMatchObject({
      query: { dimensions: [{ alias: 'dynamic_group', field: 'region' }] },
      dynamics: [{ id: 'group', allowEmpty: true }, { kind: 'measure' }],
    })
  })

  it('edits candidate order as the saved default and removes slots from both query and selectors', async () => {
    dynamicChart()
    open('/workbench/charts/dynamic')
    fireEvent.click(await screen.findByRole('button', { name: 'Configure Group by' }))
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.click(dialog.getByRole('button', { name: 'Move Channel up' }))
    fireEvent.click(dialog.getByRole('button', { name: 'OK' }))
    await waitFor(() => expect(lastQuery().dimensions).toEqual([{ alias: 'dynamic_group', field: 'channel', label: 'Channel' }]))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls('PUT', '/charts/{id}')).toHaveLength(1))
    expect(calls('PUT', '/charts/{id}')[0]!.body!.spec).toMatchObject({ dynamics: [{ options: [{ id: 'channel' }, { id: 'region' }] }, { id: 'metric' }] })
    fireEvent.click(screen.getByRole('button', { name: 'Remove Group by' }))
    expect(screen.queryByRole('combobox', { name: 'Group by' })).toBeNull()
    await waitFor(() => expect(lastQuery().dimensions).toEqual([]))
  })

  it('sends runtime selections through the saved-chart endpoint in read-only mode', async () => {
    dynamicChart({ offset: 25 })
    const current = server.state.charts[0]!.spec as ReturnType<typeof dynamicChart>
    current.filters = [{ id: 'region', field: 'region', op: 'in', label: 'Regions', control: { type: 'tiles' } }]
    server.state.options = async () => server.answer({ values: ['North', 'South'], truncated: false })
    open('/workbench/charts/dynamic')
    await screen.findByRole('combobox', { name: 'Group by' })
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    await pickSelect('Group by', 'Channel')
    await waitFor(() => expect(calls('POST', '/charts/{id}/data').at(-1)!.body).toEqual({ diagnostics: true, filters: {}, selections: { group: 'channel' } }))
    await waitFor(() => expect(calls('POST', '/charts/{id}/filters/{filterId}/options').at(-1)).toMatchObject({
      id: 'dynamic', filterId: 'region', body: { filters: {}, selections: { group: 'channel' } },
    }))
    const regions = within(screen.getByRole('group', { name: 'Regions' }))
    fireEvent.click(await regions.findByRole('button', { name: 'South' }))
    await waitFor(() => expect(calls('POST', '/charts/{id}/data').at(-1)!.body).toEqual({ diagnostics: true, filters: { region: ['South'] }, selections: { group: 'channel' } }))
    expect(calls('POST', '/charts/preview/filters/{filterId}/options')).toHaveLength(0)
    expect(calls('POST', '/charts/{id}/filters/{filterId}/options').every((call) => call.body?.spec === undefined)).toBe(true)
    expect(calls('POST', '/query')).toHaveLength(0)
  })

  it('automatically re-queries implicit dimension and metric aliases in read-only mode', async () => {
    dynamicChart({ offset: 25 })
    const saved = server.state.charts[0]!.spec as ReturnType<typeof dynamicChart>
    saved.query.dimensions = [{ field: 'region' }]
    saved.query.measures = [{ field: 'amount' }]
    saved.dynamics![0]!.alias = 'region'
    saved.dynamics![1]!.alias = 'amount'
    const original = structuredClone(saved)
    open('/workbench/charts/dynamic')
    await screen.findByRole('combobox', { name: 'Group by' })
    await waitFor(() => expect(calls('POST', '/charts/{id}/data')).toHaveLength(1))
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    await pickSelect('Group by', 'Channel')
    await waitFor(() => expect(calls('POST', '/charts/{id}/data').at(-1)!.body).toEqual({ diagnostics: true, filters: {}, selections: { group: 'channel' } }))
    await pickSelect('Metric', 'Average amount')
    await waitFor(() => expect(calls('POST', '/charts/{id}/data').at(-1)!.body).toEqual({ diagnostics: true, filters: {}, selections: { group: 'channel', metric: 'avg' } }))
    expect(calls('POST', '/charts/{id}/data')).toHaveLength(3)
    expect(calls('POST', '/query')).toHaveLength(0)
    expect(saved).toEqual(original)
  })
})

describe('chart editor cascading filter values', () => {
  function cascadingChart() {
    const dataset = server.state.datasets[0]!.spec as { fields: SpecField[] }
    dataset.fields.push({ key: 'city', label: 'City', type: 'string', role: 'dimension', column: 'city' })
    const filters = [
      { id: 'region', field: 'region', op: 'in', label: 'Regions', value: ['North'], control: { type: 'tiles' } },
      { id: 'city', field: 'city', op: 'in', label: 'Cities', value: ['Alpha'], control: { type: 'tiles' }, dependsOn: ['region'] },
    ]
    server.state.charts = [{ id: 'cascading', name: 'Cascading report', datasetId: 'orders', spec: { specVersion: 1, query: { version: 1, dataset: 'orders', mode: 'detail', columns: ['region', 'city'] }, viz: { type: 'table' }, filters } }]
    server.state.options = async (id, body) => {
      const values = body.filters as Record<string, string[] | null>
      const region = values.region === undefined ? ['North'] : values.region
      return server.answer({ values: id === 'region' ? body.related ? values.city?.includes('Beta') ? ['South'] : ['North'] : ['North', 'South'] : region?.includes('North') ? ['Alpha'] : region?.includes('South') ? ['Beta'] : ['Alpha', 'Beta'], truncated: false })
    }
  }

  it('refreshes child candidates, clears their old defaults, and matches a selected child to its parent', async () => {
    cascadingChart()
    open('/workbench/charts/cascading')
    const regions = within(await screen.findByRole('group', { name: 'Regions' }))
    fireEvent.click(await regions.findByRole('button', { name: 'South' }))
    const cities = within(screen.getByRole('group', { name: 'Cities' }))
    await cities.findByRole('button', { name: 'Beta' })
    expect(cities.queryByRole('button', { name: 'Alpha' })).toBeNull()
    await waitFor(() => expect(lastQuery().filter).toEqual({ op: 'and', args: [{ field: 'region', op: 'in', value: ['South'] }] }))
    fireEvent.click(regions.getByRole('button', { name: 'Any' }))
    fireEvent.click(await cities.findByRole('button', { name: 'Beta' }))
    await waitFor(() => expect(lastQuery().filter).toEqual({ op: 'and', args: [{ field: 'region', op: 'in', value: ['South'] }, { field: 'city', op: 'in', value: ['Beta'] }] }))
    expect(calls('POST', '/charts/preview/filters/{filterId}/options').some((call) => call.filterId === 'region' && call.body?.related === true)).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true)
  })

  it('loads candidates and reverse relationships from the saved chart in read-only mode', async () => {
    cascadingChart()
    const saved = server.state.charts[0]!.spec as { query: Record<string, unknown> }
    saved.query.offset = 25
    open('/workbench/charts/cascading')
    const regions = within(await screen.findByRole('group', { name: 'Regions' }))
    fireEvent.click(await regions.findByRole('button', { name: 'Any' }))
    const cities = within(screen.getByRole('group', { name: 'Cities' }))
    fireEvent.click(await cities.findByRole('button', { name: 'Beta' }))
    await waitFor(() => expect(calls('POST', '/charts/{id}/data').at(-1)!.body).toEqual({ diagnostics: true, filters: { region: ['South'], city: ['Beta'] } }))
    expect(calls('POST', '/charts/{id}/filters/{filterId}/options').find((call) => call.body?.related)).toMatchObject({
      id: 'cascading', filterId: 'region', body: { filters: { region: null, city: ['Beta'] }, selections: {}, related: true },
    })
    expect(calls('POST', '/charts/preview/filters/{filterId}/options')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('does not overwrite a newer parent choice with a late reverse relationship response', async () => {
    cascadingChart()
    const normal = server.state.options!
    let finish!: (result: ReturnType<typeof server.answer>) => void
    server.state.options = (id, body) => body.related ? new Promise((resolve) => { finish = resolve }) : normal(id, body)
    open('/workbench/charts/cascading')
    const regions = within(await screen.findByRole('group', { name: 'Regions' }))
    fireEvent.click(await regions.findByRole('button', { name: 'Any' }))
    const cities = within(screen.getByRole('group', { name: 'Cities' }))
    fireEvent.click(await cities.findByRole('button', { name: 'Beta' }))
    await waitFor(() => expect(finish).toBeDefined())
    fireEvent.click(regions.getByRole('button', { name: 'North' }))
    await act(async () => finish(server.answer({ values: ['South'], truncated: false })))
    await waitFor(() => expect(lastQuery().filter).toEqual({ op: 'and', args: [{ field: 'region', op: 'in', value: ['North'] }] }))
  })

  it('clears sibling defaults before matching the parent of a newly selected child', async () => {
    cascadingChart()
    const dataset = server.state.datasets[0]!.spec as { fields: SpecField[] }
    dataset.fields.push({ key: 'province', label: 'Province', type: 'string', role: 'dimension', column: 'province' })
    const saved = server.state.charts[0]!.spec as { filters: Record<string, unknown>[] }
    delete saved.filters[0]!.value
    saved.filters.push({ id: 'province', field: 'province', op: 'in', label: 'Provinces', value: ['North province'], control: { type: 'tiles' }, dependsOn: ['region'] })
    server.state.options = async (id, body) => {
      const values = body.filters as Record<string, string[] | null>
      const options = id === 'region' ? body.related ? values.province === null && values.city?.includes('Beta') ? ['South'] : [] : ['North', 'South'] : id === 'city' ? ['Alpha', 'Beta'] : ['North province', 'South province']
      return server.answer({ values: options, truncated: false })
    }
    open('/workbench/charts/cascading')
    const cities = within(await screen.findByRole('group', { name: 'Cities' }))
    fireEvent.click(await cities.findByRole('button', { name: 'Beta' }))
    await waitFor(() => expect(lastQuery().filter).toEqual({ op: 'and', args: [{ field: 'region', op: 'in', value: ['South'] }, { field: 'city', op: 'in', value: ['Beta'] }] }))
    expect(calls('POST', '/charts/preview/filters/{filterId}/options').find((call) => call.body?.related)?.body?.filters).toMatchObject({ city: ['Beta'], province: null })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true)
    expect(saved.filters[2]!.value).toEqual(['North province'])
  })

  it('recomputes all ancestors of a third-level selection without their old defaults', async () => {
    cascadingChart()
    const dataset = server.state.datasets[0]!.spec as { fields: SpecField[] }
    dataset.fields.push({ key: 'district', label: 'District', type: 'string', role: 'dimension', column: 'district' })
    const saved = server.state.charts[0]!.spec as { filters: Record<string, unknown>[] }
    saved.filters.push({ id: 'district', field: 'district', op: 'in', label: 'Districts', control: { type: 'tiles' }, dependsOn: ['city'] })
    server.state.options = async (id, body) => {
      const values = body.filters as Record<string, string[] | null>
      const related = body.related && values.region === null && values.city === null && values.district?.includes('Beta district')
      return server.answer({ values: id === 'district' ? ['Beta district'] : body.related ? related ? id === 'city' ? ['Beta'] : ['South'] : [] : id === 'city' ? ['Alpha', 'Beta'] : ['North', 'South'], truncated: false })
    }
    open('/workbench/charts/cascading')
    const districts = within(await screen.findByRole('group', { name: 'Districts' }))
    fireEvent.click(await districts.findByRole('button', { name: 'Beta district' }))
    await waitFor(() => expect(lastQuery().filter).toEqual({ op: 'and', args: [
      { field: 'region', op: 'in', value: ['South'] }, { field: 'city', op: 'in', value: ['Beta'] }, { field: 'district', op: 'in', value: ['Beta district'] },
    ] }))
    const reverse = calls('POST', '/charts/preview/filters/{filterId}/options').filter((call) => call.body?.related)
    expect(reverse).toHaveLength(2)
    // The chart is asked once with the inferred ancestors, never without them in between.
    expect(calls('POST', '/query').some((call) => JSON.stringify((call.body!.query as Record<string, unknown>).filter).includes('Beta district') && !JSON.stringify((call.body!.query as Record<string, unknown>).filter).includes('South'))).toBe(false)
    for (const call of reverse) expect(call.body!.filters).toEqual({ region: null, city: null, district: ['Beta district'] })
    expect(saved.filters.slice(0, 2).map((filter) => filter.value)).toEqual([['North'], ['Alpha']])
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true)
  })

  it('cleans references when the parent filter is removed', async () => {
    cascadingChart()
    open('/workbench/charts/cascading')
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Regions' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls('PUT', '/charts/{id}')).toHaveLength(1))
    expect(calls('PUT', '/charts/{id}')[0]!.body!.spec).toMatchObject({ filters: [{ id: 'city' }] })
    expect(((calls('PUT', '/charts/{id}')[0]!.body!.spec as { filters: { dependsOn?: string[] }[] }).filters[0]!).dependsOn).toBeUndefined()
  })
})

describe('chart editor interactive preview filters', () => {
  it('keeps aggregate filter scope unavailable for detail tables', async () => {
    filteredChart()
    open('/workbench/charts/filtered')
    fireEvent.click(await screen.findByRole('button', { name: 'Filter settings of Amount' }))
    const option = within(await screen.findByRole('dialog')).getByRole<HTMLButtonElement>('radio', { name: 'Aggregate results' })
    expect(option.disabled).toBe(true)
    // Choosing it does nothing.
    fireEvent.click(option)
    expect(screen.queryByRole('combobox', { name: 'Aggregation' })).toBeNull()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect(lastQuery().mode).toBe('detail')
    expect(lastQuery().having).toBeUndefined()
  })

  it('shows interactive controls, keeps fixed conditions, and previews zero or empty values without changing saved defaults', async () => {
    const defaults = filteredChart()
    open('/workbench/charts/filtered')
    await screen.findByRole('group', { name: 'Filters' })
    expect(previewFilters().getAllByRole('textbox')).toHaveLength(1)
    expect(previewFilters().queryByText('Region')).toBeNull()
    expect(previewAmount().value).toBe('10')
    await waitFor(() => expect(lastQuery().filter).toEqual({ op: 'and', args: [{ field: 'region', op: 'in', value: ['North'] }, { field: 'amount', op: 'gte', value: 10 }] }))

    fireEvent.change(previewAmount(), { target: { value: '0' } })
    await waitFor(() => expect(lastQuery().filter).toEqual({ op: 'and', args: [{ field: 'region', op: 'in', value: ['North'] }, { field: 'amount', op: 'gte', value: 0 }] }))
    fireEvent.change(previewAmount(), { target: { value: '' } })
    await waitFor(() => expect(lastQuery().filter).toEqual({ op: 'and', args: [{ field: 'region', op: 'in', value: ['North'] }] }))

    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true)
    fireEvent.change(title(), { target: { value: 'Renamed filtered regions' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls('PUT', '/charts/{id}')).toHaveLength(1))
    expect(calls('PUT', '/charts/{id}')[0]!.body!.spec).toMatchObject({ filters: defaults })
    expect(previewAmount().value).toBe('')
  })

  it('waits for Run when automatic queries are turned off', async () => {
    filteredChart()
    localStorage.setItem('supabi.chart.autoRun', 'false')
    open('/workbench/charts/filtered')
    await screen.findByRole('group', { name: 'Filters' })
    await waitFor(() => expect(calls('POST', '/query')).toHaveLength(1))
    vi.useFakeTimers()
    fireEvent.change(previewAmount(), { target: { value: '75' } })
    expect(calls('POST', '/query')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    expect(calls('POST', '/query')).toHaveLength(2)
    expect(lastQuery().filter).toMatchObject({ args: [{ field: 'region' }, { field: 'amount', value: 75 }] })
    vi.useRealTimers()
    await waitFor(() => expect(calls('POST', '/query')).toHaveLength(2))
  })

  it('resets a preview value after its definition changes and cancels edits pending on the previous control', async () => {
    filteredChart()
    open('/workbench/charts/filtered')
    await screen.findByRole('group', { name: 'Filters' })
    fireEvent.change(previewAmount(), { target: { value: '90' } })
    await waitFor(() => expect(lastQuery().filter).toMatchObject({ args: [{ field: 'region' }, { field: 'amount', value: 90 }] }))

    fireEvent.click(screen.getByRole('button', { name: 'Filter settings of Amount' }))
    let dialog = within(await screen.findByRole('dialog'))
    vi.useFakeTimers()
    fireEvent.change(dialog.getByRole('textbox', { name: 'Default value' }), { target: { value: '20' } })
    act(() => vi.advanceTimersByTime(400))
    fireEvent.click(dialog.getByRole('button', { name: 'OK' }))
    vi.useRealTimers()
    await waitFor(() => expect(previewAmount().value).toBe('20'))
    await waitFor(() => expect(lastQuery().filter).toMatchObject({ args: [{ field: 'region' }, { field: 'amount', op: 'gte', value: 20 }] }))

    vi.useFakeTimers()
    fireEvent.change(previewAmount(), { target: { value: '80' } })
    fireEvent.click(screen.getByRole('button', { name: 'Filter settings of Amount' }))
    dialog = within(screen.getByRole('dialog'))
    openPopup(dialog.getByRole('combobox', { name: 'Condition' }))
    fireEvent.click(screen.getByRole('option', { name: 'is at most' }))
    fireEvent.click(dialog.getByRole('button', { name: 'OK' }))
    act(() => vi.advanceTimersByTime(400))
    vi.useRealTimers()
    await waitFor(() => expect(previewAmount().value).toBe('20'))
    await waitFor(() => expect(lastQuery().filter).toMatchObject({ args: [{ field: 'region' }, { field: 'amount', op: 'lte', value: 20 }] }))
  })

  it('clears controls and temporary values when switching datasets', async () => {
    filteredChart()
    open('/workbench/charts/filtered')
    await screen.findByRole('group', { name: 'Filters' })
    fireEvent.change(previewAmount(), { target: { value: '90' } })
    await waitFor(() => expect(lastQuery().filter).toMatchObject({ args: [{ field: 'region' }, { field: 'amount', value: 90 }] }))
    await choose('Inventory')
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Change dataset' }))
    expect(await fields().findByText('SKU')).toBeTruthy()
    expect(screen.queryByRole('group', { name: 'Filters' })).toBeNull()
    await addColumn('SKU')
    await waitFor(() => expect(lastQuery()).toMatchObject({ dataset: 'inventory', columns: ['sku'] }))
    expect(lastQuery()).not.toHaveProperty('filter')
  })

  it('does not mark the saved chart as modified when only preview values change', async () => {
    filteredChart()
    const { router } = open('/workbench/charts/filtered')
    await screen.findByRole('group', { name: 'Filters' })
    fireEvent.change(previewAmount(), { target: { value: '90' } })
    await waitFor(() => expect(lastQuery().filter).toMatchObject({ args: [{ field: 'region' }, { field: 'amount', value: 90 }] }))
    await act(async () => { await router.navigate('/workbench/charts/new?dataset=inventory') })
    expect(await fields().findByText('SKU')).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(calls('PUT', '/charts/{id}')).toHaveLength(0)
  })

  it('sends temporary values through the saved-chart endpoint for charts the editor cannot rewrite', async () => {
    filteredChart({ offset: 25 })
    open('/workbench/charts/filtered')
    await screen.findByRole('group', { name: 'Filters' })
    await waitFor(() => expect(calls('POST', '/charts/{id}/data')).toHaveLength(1))
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(calls('POST', '/query')).toHaveLength(0)
    fireEvent.change(previewAmount(), { target: { value: '90' } })
    await waitFor(() => expect(calls('POST', '/charts/{id}/data').at(-1)!.body).toEqual({ diagnostics: true, filters: { amount_min: 90 } }))
    fireEvent.change(previewAmount(), { target: { value: '' } })
    await waitFor(() => expect(calls('POST', '/charts/{id}/data').at(-1)!.body).toEqual({ diagnostics: true, filters: { amount_min: null } }))
    expect(calls('POST', '/query')).toHaveLength(0)
  })
})

describe('table column visibility', () => {
  it.each(['detail', 'table'] as const)('saves, reopens and restores %s columns without changing the query', async (vizType) => {
    const dataset = server.state.datasets[0]!.spec as { fields: SpecField[] }
    dataset.fields.push(
      { key: 'id', label: 'ID', column: 'id', type: 'integer', role: 'dimension' },
      { key: 'amount', label: 'Amount', column: 'amount', type: 'decimal', role: 'measure' },
    )
    const state: BuilderState = {
      vizType, dimensions: vizType === 'table' ? ['id', 'region'] : [], columns: vizType === 'detail' ? ['id', 'region', 'amount'] : [],
      measures: vizType === 'table' ? [{ field: 'amount', agg: 'sum' }, { field: 'amount', agg: 'sum', alias: 'share', compute: { type: 'percent_of_total', within: ['region'] } }] : [],
      labels: {}, grain: 'month', filters: [], stacked: false, sort: [{ by: 'amount', desc: true }],
    }
    const original = buildSpec('orders', state, dataset.fields)
    server.state.charts = [{ id: 'visibility', name: 'Visibility', datasetId: 'orders', spec: original }]
    open('/workbench/charts/visibility')
    await screen.findByRole('button', { name: 'Options for ID' })
    await screen.findByTestId('chart')
    const before = calls('POST', '/query').length
    const hiddenColumns = vizType === 'detail' ? ['id'] : ['id', 'amount']
    for (const name of vizType === 'detail' ? ['ID'] : ['ID', 'SUM(Amount)']) {
      openPopup(screen.getByRole('button', { name: `Options for ${name}` }))
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Hide in table' }))
    }
    expect(screen.getAllByText('Hidden', { selector: '.chip-tag' })).toHaveLength(hiddenColumns.length)
    expect(JSON.parse(screen.getByTestId('chart').getAttribute('data-viz')!)).toMatchObject({ hiddenColumns })
    expect(calls('POST', '/query')).toHaveLength(before)
    expect(lastQuery()).toEqual(original.query)
    fireEvent.click(screen.getByRole('button', { name: /Save$/ }))
    await waitFor(() => expect(calls('PUT', '/charts/{id}')).toHaveLength(1))
    const saved = calls('PUT', '/charts/{id}')[0]!.body!
    expect(saved.spec).toEqual({ ...original, viz: { ...original.viz, hiddenColumns } })
    cleanup()
    server.state.charts[0] = { ...server.state.charts[0], ...saved }
    open('/workbench/charts/visibility')
    await screen.findByRole('button', { name: 'Options for ID' })
    expect(screen.getAllByText('Hidden', { selector: '.chip-tag' })).toHaveLength(hiddenColumns.length)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Save$/ }).disabled).toBe(true)
    for (const name of vizType === 'detail' ? ['ID'] : ['ID', 'SUM(Amount)']) {
      openPopup(screen.getByRole('button', { name: `Options for ${name}` }))
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Show in table' }))
    }
    fireEvent.click(screen.getByRole('button', { name: /Save$/ }))
    await waitFor(() => expect(calls('PUT', '/charts/{id}')).toHaveLength(2))
    expect(calls('PUT', '/charts/{id}')[1]!.body!.spec).toEqual(original)
  })

  it('marks dynamic fields hidden and keeps a mandatory column visible when a dimension can be cleared', async () => {
    dynamicChart()
    open('/workbench/charts/dynamic')
    openPopup(await screen.findByRole('button', { name: 'Options for Metric' }))
    expect((await screen.findByRole('menuitem', { name: 'Keep at least one column visible' })).getAttribute('aria-disabled')).toBe('true')
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    openPopup(screen.getByRole('button', { name: 'Options for Group by' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Hide in table' }))
    expect(screen.getByText('Hidden', { selector: '.chip-tag' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Save$/ }))
    await waitFor(() => expect(calls('PUT', '/charts/{id}')).toHaveLength(1))
    expect(calls('PUT', '/charts/{id}')[0]!.body!.spec).toMatchObject({ viz: { hiddenColumns: ['dynamic_group'] } })
  })
})

describe('chart editor field order', () => {
  const shelfOf = (label: string) => screen.getByText(label, { selector: '.shelf-label' }).closest<HTMLElement>('.shelf')!
  const chips = (shelf: HTMLElement) => [...shelf.querySelectorAll<HTMLElement>('[data-shelf]')]
  // jsdom lays nothing out: the fields on a shelf stand side by side in one row, 100 pixels apart.
  const layOut = (shelf: HTMLElement) =>
    chips(shelf).forEach((chip, i) => {
      chip.getBoundingClientRect = () => ({ left: i * 100, right: i * 100 + 80, top: 0, bottom: 24, width: 80, height: 24, x: i * 100, y: 0, toJSON: () => undefined })
    })
  // A drag event at a point, which jsdom's events do not carry.
  const at = (type: 'dragOver' | 'drop', target: HTMLElement, x: number, dataTransfer: object) => {
    const event = createEvent[type](target, { dataTransfer })
    Object.defineProperties(event, { clientX: { value: x }, clientY: { value: 12 } })
    fireEvent(target, event)
  }
  const keysOn = (shelf: HTMLElement) => chips(shelf).map((chip) => chip.dataset.key)

  async function grouped() {
    const dataset = server.state.datasets[0]!.spec as { fields: SpecField[] }
    dataset.fields.push(
      { key: 'channel', label: 'Channel', type: 'string', role: 'dimension', column: 'channel' },
      { key: 'status', label: 'Status', type: 'string', role: 'dimension', column: 'status' },
      { key: 'amount', label: 'Amount', type: 'decimal', role: 'measure', column: 'amount' },
    )
    const state: BuilderState = {
      vizType: 'table', dimensions: ['region', 'channel'], columns: [], measures: [{ field: 'amount', agg: 'sum' }, { field: 'amount', agg: 'avg', alias: 'avg_amount' }],
      labels: {}, grain: 'month', stacked: false,
      filters: [{ id: 'a', field: 'region', op: 'in', value: ['North'] }, { id: 'b', field: 'channel', op: 'in', value: ['web'] }],
    }
    server.state.charts = [{ id: 'ordered', name: 'Ordered', datasetId: 'orders', spec: buildSpec('orders', state, dataset.fields) }]
    open('/workbench/charts/ordered')
    await screen.findByRole('button', { name: 'Options for Channel' })
    await waitFor(() => expect(calls('POST', '/query').length).toBeGreaterThan(0))
  }

  it('moves a field to where it is dropped on its own shelf, showing where it would go', async () => {
    await grouped()
    const dimensions = shelfOf('Dimensions')
    layOut(dimensions)
    const dataTransfer = { setData: () => undefined, effectAllowed: '', dropEffect: '' }
    fireEvent.dragStart(chips(dimensions)[1]!, { dataTransfer })
    at('dragOver', dimensions, 10, dataTransfer)
    expect(dataTransfer.dropEffect).toBe('move')
    expect(chips(dimensions)[0]!.classList.contains('drop-before')).toBe(true)
    // Not another shelf: it is not taken there, so a browser never drops it there.
    at('dragOver', shelfOf('Metrics'), 10, dataTransfer)
    expect(dataTransfer.dropEffect).toBe('none')
    expect(dimensions.querySelector('.drop-before, .drop-after')).toBeNull()
    at('dragOver', dimensions, 10, dataTransfer)
    at('drop', dimensions, 10, dataTransfer)
    fireEvent.dragEnd(chips(dimensions)[0]!, { dataTransfer })
    expect(keysOn(dimensions)).toEqual(['channel', 'region'])
    await waitFor(() => expect(lastQuery().dimensions).toEqual([{ field: 'channel' }, { field: 'region' }]))
    expect(dimensions.querySelector('.drop-before, .drop-after')).toBeNull()

    // Put back where it was, nothing changes and nothing is asked again; no line says it would.
    const asked = calls('POST', '/query').length
    layOut(dimensions)
    fireEvent.dragStart(chips(dimensions)[0]!, { dataTransfer })
    at('dragOver', dimensions, 130, dataTransfer)
    expect(dimensions.querySelector('.drop-before, .drop-after')).toBeNull()
    at('drop', dimensions, 10, dataTransfer)
    expect(keysOn(dimensions)).toEqual(['channel', 'region'])
    expect(calls('POST', '/query')).toHaveLength(asked)
  })

  it('puts a new field where it is dropped, and at the end when dropped past the fields', async () => {
    await grouped()
    const dimensions = shelfOf('Dimensions')
    layOut(dimensions)
    const dataTransfer = { setData: () => undefined, effectAllowed: '', dropEffect: '' }
    fireEvent.dragStart(fields().getByText('Status').closest<HTMLElement>('[draggable]')!, { dataTransfer })
    at('dragOver', dimensions, 170, dataTransfer)
    expect(chips(dimensions)[1]!.classList.contains('drop-after')).toBe(true)
    at('dragOver', dimensions, 50, dataTransfer)
    expect(chips(dimensions)[1]!.classList.contains('drop-before')).toBe(true)
    at('drop', dimensions, 50, dataTransfer)
    expect(keysOn(dimensions)).toEqual(['region', 'status', 'channel'])
  })

  it('moves a field one place with Alt and an arrow or from its menu, keeping it focused, and orders filters the same way', async () => {
    await grouped()
    const dimensions = shelfOf('Dimensions')
    const menu = screen.getByRole('button', { name: 'Options for Region' })
    menu.focus()
    fireEvent.keyDown(menu, { key: 'ArrowRight', altKey: true })
    expect(keysOn(dimensions)).toEqual(['channel', 'region'])
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Options for Region')
    // Without Alt, or already last, nothing moves.
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight', altKey: true })
    expect(keysOn(dimensions)).toEqual(['channel', 'region'])
    // In an alias being written, Alt and an arrow are the caret's.
    openPopup(screen.getByRole('button', { name: 'Options for Region' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add an alias' }))
    fireEvent.keyDown(await screen.findByRole('textbox', { name: /Region/ }), { key: 'ArrowLeft', altKey: true })
    expect(keysOn(dimensions)).toEqual(['channel', 'region'])
    fireEvent.keyDown(screen.getByRole('textbox', { name: /Region/ }), { key: 'Escape' })

    openPopup(screen.getByRole('button', { name: 'Options for Region' }))
    expect((await screen.findByRole('menuitem', { name: 'Move later' })).getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move earlier' }))
    expect(keysOn(dimensions)).toEqual(['region', 'channel'])

    const filters = shelfOf('Filters')
    expect(keysOn(filters)).toEqual(['a', 'b'])
    fireEvent.keyDown(chips(filters)[1]!.querySelector('button')!, { key: 'ArrowLeft', altKey: true })
    expect(keysOn(filters)).toEqual(['b', 'a'])
    fireEvent.click(screen.getByRole('button', { name: /Save$/ }))
    await waitFor(() => expect(calls('PUT', '/charts/{id}')).toHaveLength(1))
    expect((calls('PUT', '/charts/{id}')[0]!.body!.spec as { filters: { id: string }[] }).filters.map((filter) => filter.id)).toEqual(['b', 'a'])
  })
})

describe('table column groups', () => {
  it('groups headers picked on the table, names the group in place, saves it and takes it away', async () => {
    const dataset = server.state.datasets[0]!.spec as { fields: SpecField[] }
    dataset.fields.push(
      { key: 'id', label: 'ID', column: 'id', type: 'integer', role: 'dimension' },
      { key: 'amount', label: 'Amount', column: 'amount', type: 'decimal', role: 'measure' },
    )
    server.state.query = async () => server.answer({
      columns: [{ name: 'id', type: 'integer', role: 'dimension', label: 'ID' }, { name: 'region', type: 'string', role: 'dimension', label: 'Area' }, { name: 'amount', type: 'decimal', role: 'measure', label: 'Amount' }],
      rows: [[1, 'North', '5']],
      meta: { durationMs: 4 },
    })
    const state: BuilderState = { vizType: 'table', dimensions: ['id', 'region'], columns: [], measures: [{ field: 'amount', agg: 'sum' }], labels: {}, grain: 'month', filters: [], stacked: false }
    const original = buildSpec('orders', state, dataset.fields)
    server.state.charts = [{ id: 'grouped', name: 'Grouped', datasetId: 'orders', spec: original }]
    server.state.drawTables = true
    open('/workbench/charts/grouped')
    const table = await screen.findByRole('table', { name: /\(Table\)$/ })
    const viz = () => JSON.parse(screen.getByTestId('chart').getAttribute('data-viz')!)
    const header = (name: RegExp) => within(table).getByRole('columnheader', { name })
    const queries = calls('POST', '/query').length
    expect(within(screen.getByRole('toolbar', { name: 'Column groups' })).queryByRole('button')).toBeNull()

    // Escape lets go of a pick.
    fireEvent.click(header(/^ID/))
    expect(header(/^ID/).getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(header(/^ID/).getAttribute('aria-selected')).toBe('false')

    // An Escape that closes a menu is the menu's; hiding a column lets go of a pick, which may hold it.
    fireEvent.click(header(/^Area/))
    openPopup(screen.getByRole('button', { name: 'Options for ID' }))
    fireEvent.keyDown(await screen.findByRole('menu'), { key: 'Escape' })
    expect(header(/^Area/).getAttribute('aria-selected')).toBe('true')
    openPopup(screen.getByRole('button', { name: 'Options for ID' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Hide in table' }))
    expect(header(/^Area/).getAttribute('aria-selected')).toBe('false')
    openPopup(screen.getByRole('button', { name: 'Options for ID' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Show in table' }))

    fireEvent.click(header(/^ID/))
    fireEvent.click(header(/^Area/), { shiftKey: true })
    fireEvent.click(screen.getByRole('button', { name: 'Group' }))
    const name = within(table).getByRole('textbox', { name: 'Group' })
    fireEvent.change(name, { target: { value: 'Place' } })
    fireEvent.keyDown(name, { key: 'Enter' })
    expect(viz().columnGroups).toEqual([{ label: 'Place', columns: ['id', 'region'] }])
    expect((header(/^Place/) as HTMLTableCellElement).colSpan).toBe(2)
    // How the table is drawn does not change what is asked.
    expect(calls('POST', '/query')).toHaveLength(queries)

    fireEvent.click(screen.getByRole('button', { name: /Save$/ }))
    await waitFor(() => expect(calls('PUT', '/charts/{id}')).toHaveLength(1))
    expect(calls('PUT', '/charts/{id}')[0]!.body!.spec).toEqual({ ...original, viz: { ...original.viz, columnGroups: [{ label: 'Place', columns: ['id', 'region'] }] } })

    fireEvent.click(header(/^Place/))
    fireEvent.click(screen.getByRole('button', { name: 'Ungroup' }))
    expect(viz().columnGroups).toBeUndefined()
  })
})

describe('chart editor save and query actions', () => {
  it('enables Save only for edits and preserves edits made while an earlier save is pending', async () => {
    filteredChart()
    open('/workbench/charts/filtered')
    await screen.findByRole('group', { name: 'Filters' })
    const save = () => screen.getByRole<HTMLButtonElement>('button', { name: /Save$/ })
    expect(save().disabled).toBe(true)
    fireEvent.change(title(), { target: { value: 'First revision' } })
    expect(save().disabled).toBe(false)
    fireEvent.change(title(), { target: { value: 'Filtered regions' } })
    expect(save().disabled).toBe(true)

    let finish!: (result: ReturnType<typeof server.answer>) => void
    server.state.save = () => new Promise((resolve) => { finish = resolve })
    fireEvent.change(title(), { target: { value: 'First revision' } })
    fireEvent.click(save())
    await waitFor(() => expect(calls('PUT', '/charts/{id}')).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: /Saving…/ }))
    expect(calls('PUT', '/charts/{id}')).toHaveLength(1)
    fireEvent.change(title(), { target: { value: 'Second revision' } })
    await act(async () => finish(server.answer({})))
    expect(save().disabled).toBe(false)
    expect(calls('PUT', '/charts/{id}')[0]!.body!.name).toBe('First revision')

    server.state.save = null
    fireEvent.click(save())
    await waitFor(() => expect(save().disabled).toBe(true))
    expect(calls('PUT', '/charts/{id}')[1]!.body!.name).toBe('Second revision')
  })

  it('keeps failed saves available to retry and disables Save after a successful retry', async () => {
    filteredChart()
    open('/workbench/charts/filtered')
    await screen.findByRole('group', { name: 'Filters' })
    server.state.save = async () => server.answer({ code: 'temporary', message: 'Save temporarily unavailable' }, 503)
    fireEvent.change(description(), { target: { value: 'Updated description' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/Save temporarily unavailable/)).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Save$/ }).disabled).toBe(false)
    server.state.save = null
    fireEvent.click(screen.getByRole('button', { name: /Save$/ }))
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: /Save$/ }).disabled).toBe(true))
    expect(screen.queryByText(/Save temporarily unavailable/)).toBeNull()
    expect(calls('PUT', '/charts/{id}')).toHaveLength(2)
  })

  it('shows query duration and the number of displayed rows, including empty results', async () => {
    filteredChart()
    server.state.query = async () => server.answer({ columns: [{ name: 'region', type: 'string', role: 'dimension' }], rows: [['North'], ['South']], meta: { durationMs: 12, truncated: true } })
    open('/workbench/charts/filtered')
    await waitFor(() => expect(querySummary()).toBeTruthy())
    let summary = within(querySummary())
    expect(summary.getByText('Time: 12 ms')).toBeTruthy()
    expect(summary.getByText('Showing 2 rows')).toBeTruthy()
    server.state.query = async () => server.answer({ columns: [{ name: 'region', type: 'string', role: 'dimension' }], rows: [], meta: { durationMs: 3 } })
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    await waitFor(() => expect(querySummary().textContent).toContain('Time: 3 ms'))
    summary = within(querySummary())
    expect(summary.getByText('Showing 0 rows')).toBeTruthy()
  })

  it('keeps SQL and arguments with their result across manual edits, cancellation and reruns', async () => {
    filteredChart()
    server.state.query = async () => diagnosticAnswer('qry_original', 10)
    open('/workbench/charts/filtered')
    await screen.findByRole('group', { name: 'Filters' })
    fireEvent.click(await screen.findByRole('tab', { name: 'Query diagnostics' }))
    await screen.findByText('qry_original')
    expect(calls('POST', '/query')[0]!.body!.options).toEqual({ diagnostics: true })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Run automatically' }))
    fireEvent.change(previewAmount(), { target: { value: '75' } })
    await screen.findByText(/configuration has changed/)
    expect(within(screen.getByRole('region', { name: 'Bound arguments' })).getByText('10')).toBeTruthy()
    const count = calls('POST', '/query').length
    let finish!: (value: ReturnType<typeof server.answer>) => void
    server.state.query = () => new Promise((resolve) => { finish = resolve })
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    await screen.findByText(/Query running/)
    expect(calls('POST', '/query')).toHaveLength(count + 1)
    expect(calls('POST', '/query').at(-1)!.body!.options).toEqual({ diagnostics: true, cache: 'refresh' })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await screen.findByText(/Query cancelled/)
    await act(async () => finish(diagnosticAnswer('qry_cancelled', 75)))
    expect(screen.queryByText('qry_cancelled')).toBeNull()
    expect(screen.getByText('qry_original')).toBeTruthy()
    server.state.query = async () => diagnosticAnswer('qry_current', 75)
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    await screen.findByText('qry_current')
    expect(screen.queryByText('qry_original')).toBeNull()
    expect(screen.queryByText(/configuration has changed/)).toBeNull()
    expect(within(screen.getByRole('region', { name: 'Bound arguments' })).getByText('75')).toBeTruthy()
    server.state.query = async () => server.answer({ code: 'database_error', message: 'Query failed' }, 422)
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    await screen.findByText(/no diagnostics are available for this attempt/)
    expect(screen.queryByText('qry_current')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Copy SQL' })).toBeNull()
  })

  it('cancels an active query, keeps the last result, ignores a late response, and can run again', async () => {
    filteredChart()
    open('/workbench/charts/filtered')
    expect((await screen.findAllByText('North')).length).toBeGreaterThan(0)
    let finish!: (result: ReturnType<typeof server.answer>) => void
    // Deliberately ignore abort in the mock: a late response still must not win.
    server.state.query = () => new Promise((resolve) => { finish = resolve })
    const run = screen.getByRole('button', { name: 'Run' })
    fireEvent.click(run)
    const cancel = await screen.findByRole<HTMLButtonElement>('button', { name: 'Cancel' })
    expect(cancel).toBe(run)
    expect(cancel.disabled).toBe(false)
    const pending = calls('POST', '/query').at(-1)!
    expect(pending.signal?.aborted).toBe(false)
    fireEvent.click(cancel)
    expect(pending.signal?.aborted).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Run' }).disabled).toBe(false)
    expect(screen.getAllByText('North').length).toBeGreaterThan(0)
    await act(async () => finish(server.answer({ columns: [{ name: 'region', type: 'string' }], rows: [['Late result']], meta: { durationMs: 999 } })))
    expect(screen.queryByText('Late result')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(querySummary().textContent).toContain('Time: 4 ms')

    server.state.query = async () => server.answer({ columns: [{ name: 'region', type: 'string', role: 'dimension' }], rows: [['Fresh result']], meta: { durationMs: 8 } })
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    expect((await screen.findAllByText('Fresh result')).length).toBeGreaterThan(0)
    expect(querySummary().textContent).toContain('Time: 8 ms')
  })

  it('does not show an error when the transport rejects an aborted query', async () => {
    filteredChart()
    server.state.query = (_body, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('The query was aborted', 'AbortError')), { once: true })
    })
    open('/workbench/charts/filtered')
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Run' }).disabled).toBe(false))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(calls('POST', '/query')[0]!.signal?.aborted).toBe(true)
  })

  it('aborts an obsolete automatic query and accepts only the latest response', async () => {
    filteredChart()
    const finish: ((result: ReturnType<typeof server.answer>) => void)[] = []
    server.state.query = () => new Promise((resolve) => { finish.push(resolve) })
    open('/workbench/charts/filtered')
    await screen.findByRole('group', { name: 'Filters' })
    await waitFor(() => expect(calls('POST', '/query')).toHaveLength(1))
    const first = calls('POST', '/query')[0]!
    fireEvent.change(previewAmount(), { target: { value: '75' } })
    await waitFor(() => expect(calls('POST', '/query')).toHaveLength(2))
    expect(first.signal?.aborted).toBe(true)
    expect(calls('POST', '/query')[1]!.signal?.aborted).toBe(false)
    await act(async () => finish[1]!(diagnosticAnswer('qry_latest', 75)))
    await act(async () => finish[0]!(diagnosticAnswer('qry_obsolete', 10)))
    expect(screen.getAllByText('qry_latest').length).toBeGreaterThan(0)
    expect(screen.queryByText('qry_obsolete')).toBeNull()
    expect(querySummary().textContent).toContain('Time: 2 ms')
    fireEvent.click(screen.getByRole('tab', { name: 'Query diagnostics' }))
    expect(screen.getByText('qry_latest')).toBeTruthy()
    expect(within(screen.getByRole('region', { name: 'Bound arguments' })).getByText('75')).toBeTruthy()
  })

  it('aborts pending queries when changing datasets and when leaving the editor', async () => {
    filteredChart()
    server.state.query = () => new Promise(() => undefined)
    const view = open('/workbench/charts/filtered')
    await screen.findByRole('group', { name: 'Filters' })
    await waitFor(() => expect(calls('POST', '/query')).toHaveLength(1))
    const first = calls('POST', '/query')[0]!
    await choose('Inventory')
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Change dataset' }))
    expect(await fields().findByText('SKU')).toBeTruthy()
    expect(first.signal?.aborted).toBe(true)
    await addColumn('SKU')
    await waitFor(() => expect(calls('POST', '/query')).toHaveLength(2))
    const second = calls('POST', '/query')[1]!
    expect(second.signal?.aborted).toBe(false)
    view.unmount()
    expect(second.signal?.aborted).toBe(true)
  })

  it('also cancels requests through the saved-chart endpoint for read-only charts', async () => {
    filteredChart({ offset: 25 })
    server.state.chartData = (_body, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('The query was aborted', 'AbortError')), { once: true })
    })
    open('/workbench/charts/filtered')
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Run' }).disabled).toBe(false))
    expect(calls('POST', '/charts/{id}/data')[0]!.signal?.aborted).toBe(true)
    expect(screen.queryByText(/The query was aborted/)).toBeNull()
    expect(calls('POST', '/query')).toHaveLength(0)
  })
})

describe('chart editor dataset selection', () => {
  it('starts in the editor, browses the dataset folders, and saves into the original chart folder', async () => {
    open('/workbench/charts/new?folder=charts')
    expect(await screen.findByRole('textbox', { name: 'Chart name' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Chart type' })).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Run' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true)
    expect(screen.getByText('Choose a dataset on the left to start.')).toBeTruthy()
    expect(picker().getAttribute('aria-expanded')).toBe('true')
    expect(calls('POST', '/query')).toHaveLength(0)

    fireEvent.change(title(), { target: { value: 'Regional overview' } })
    fireEvent.change(description(), { target: { value: 'A description written before choosing data' } })
    fireEvent.click(await screen.findByText('Commerce', { selector: '.wb-row-name' }))
    fireEvent.click(await screen.findByText('Regional', { selector: '.wb-row-name' }))
    fireEvent.click(await screen.findByText('Orders', { selector: '.wb-row-name' }))
    await waitFor(() => expect(fields().getByText('Region')).toBeTruthy())
    expect(title().value).toBe('Regional overview')
    expect(description().value).toBe('A description written before choosing data')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByTestId('where').textContent).toContain('folder=charts')
    expect(calls('POST', '/query')).toHaveLength(0)

    await addColumn('Region')
    await waitFor(() => expect(calls('POST', '/query')).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls('POST', '/charts')).toHaveLength(1))
    expect(calls('POST', '/charts')[0]!.body).toMatchObject({ name: 'Regional overview', description: 'A description written before choosing data', spec: { query: { dataset: 'orders', columns: ['region'] } } })
    expect(calls('POST', '/folders/move')[0]!.body).toEqual({ kind: 'chart', id: 'chart_created', folderId: 'charts' })
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/workbench/charts/chart_created'))
  })

  it('searches across folders, confirms clearing selections, and retains the old dataset if loading the replacement fails', async () => {
    open()
    await screen.findByRole('textbox', { name: 'Chart name' })
    fireEvent.change(picker(), { target: { value: 'ord' } })
    expect(await screen.findByText('Commerce / Regional')).toBeTruthy()
    expect(screen.queryByText('Inventory', { selector: '.wb-row-name' })).toBeNull()
    fireEvent.keyDown(picker(), { key: 'Enter', code: 'Enter', keyCode: 13, which: 13 })
    await addColumn('Region')
    fireEvent.change(title(), { target: { value: 'Kept title' } })
    fireEvent.change(description(), { target: { value: 'Kept description' } })

    await choose('Inventory')
    let dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByText('Change dataset?')).toBeTruthy()
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }))
    expect(within(columns()).getByText('Region')).toBeTruthy()
    expect(calls('GET', '/datasets/{id}').some((call) => call.id === 'inventory')).toBe(false)

    server.state.failDataset = 'inventory'
    await choose('Inventory')
    dialog = within(await screen.findByRole('dialog'))
    fireEvent.click(dialog.getByRole('button', { name: 'Change dataset' }))
    expect(await screen.findByText(/Dataset temporarily unavailable/)).toBeTruthy()
    expect(within(columns()).getByText('Region')).toBeTruthy()
    expect(fields().getByText('Region')).toBeTruthy()
    expect(title().value).toBe('Kept title')
    expect(description().value).toBe('Kept description')

    expect(screen.getByTestId('where').textContent).toBe('/workbench/charts/new?dataset=orders')

    // Retrying replaces what is picked, so it asks again.
    server.state.failDataset = ''
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Change dataset' }))
    expect(await fields().findByText('SKU')).toBeTruthy()
    expect(within(columns()).queryByText('Region')).toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Run' }).disabled).toBe(true)
    expect(title().value).toBe('Kept title')
    expect(description().value).toBe('Kept description')
    await addColumn('SKU')
    await waitFor(() => expect(calls('POST', '/query').at(-1)!.body).toMatchObject({ query: { dataset: 'inventory', columns: ['sku'] } }))
  })

  it('shows empty folders without management actions and lets keyboard focus return from the tree to search', async () => {
    server.state.folders.push({ id: 'empty', kind: 'dataset', name: 'Empty archive', private: false })
    open()
    const tree = await screen.findByRole('tree', { name: 'Datasets' })
    fireEvent.click(await within(tree).findByRole('treeitem', { name: 'Empty archive' }))
    expect(within(tree).getByText('Empty folder')).toBeTruthy()
    expect(calls('GET', '/datasets/{id}')).toHaveLength(0)
    expect(tree.querySelector('.wb-row-more')).toBeNull()
    expect(tree.querySelector('[draggable="true"]')).toBeNull()
    expect(within(tree).queryByRole('link')).toBeNull()
    fireEvent.contextMenu(within(tree).getByRole('treeitem', { name: 'Inventory' }))
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.change(picker(), { target: { value: 'missing dataset' } })
    expect(await screen.findByText('Nothing matches.')).toBeTruthy()
    fireEvent.change(picker(), { target: { value: 'Inventory' } })
    const match = await screen.findByRole('treeitem', { name: 'Inventory' })
    fireEvent.keyDown(picker(), { key: 'ArrowDown', code: 'ArrowDown' })
    expect(document.activeElement).toBe(match)
    fireEvent.keyDown(match, { key: 'Escape', code: 'Escape' })
    expect(document.activeElement).toBe(picker())
    expect(picker().getAttribute('aria-expanded')).toBe('false')
  })

  it('does not show a response from the old dataset after the selection changes', async () => {
    let finishOld!: (result: ReturnType<typeof server.answer>) => void
    server.state.query = () => new Promise((resolve) => { finishOld = resolve })
    open('/workbench/charts/new?dataset=orders')
    await screen.findByRole('textbox', { name: 'Chart name' })
    await addColumn('Region')
    await waitFor(() => expect(calls('POST', '/query')).toHaveLength(1))
    await choose('Inventory')
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Change dataset' }))
    expect(await fields().findByText('SKU')).toBeTruthy()
    server.state.query = null
    await addColumn('SKU')
    expect((await screen.findAllByText('Warehouse')).length).toBeGreaterThan(0)
    await act(async () => finishOld(server.answer({ columns: [{ name: 'region', type: 'string' }], rows: [['Outdated orders']], meta: { durationMs: 40 } })))
    expect(screen.queryByText('Outdated orders')).toBeNull()
    expect(screen.getAllByText('Warehouse').length).toBeGreaterThan(0)
  })

  it('starts a fresh draft when an external new-chart entry navigates to the same page', async () => {
    const { router } = open()
    await screen.findByRole('textbox', { name: 'Chart name' })
    await choose('Orders')
    await addColumn('Region')
    fireEvent.change(title(), { target: { value: 'Previous draft' } })
    fireEvent.change(description(), { target: { value: 'Previous description' } })
    await waitFor(() => expect(calls('POST', '/query')).toHaveLength(1))

    // The add menu starts a new chart even though the editor already occupies this route.
    // The draft is not dropped without asking.
    await act(async () => { void router.navigate('/workbench/charts/new') })
    expect(title().value).toBe('Previous draft')
    await act(async () => { fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Discard and leave' })) })
    expect(title().value).toBe('')
    expect(description().value).toBe('')
    expect(screen.getByText('Choose a dataset on the left to start.')).toBeTruthy()
    expect(fields().queryByText('Region')).toBeNull()
    expect(within(columns()).queryByText('Region')).toBeNull()
    expect(picker().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Run' }).disabled).toBe(true)

    // A dataset's create-chart entry also starts fresh, with that dataset selected.
    await act(async () => { await router.navigate('/workbench/charts/new?dataset=inventory') })
    expect(await fields().findByText('SKU')).toBeTruthy()
    expect(fields().queryByText('Region')).toBeNull()
    expect(title().value).toBe('')
    expect(description().value).toBe('')
    expect(changeDataset().getAttribute('aria-expanded')).toBe('false')
    expect(calls('GET', '/datasets/{id}').at(-1)!.id).toBe('inventory')
    expect(calls('POST', '/query')).toHaveLength(1)
  })

  it('restores an existing chart and queries its selected dataset when opened', async () => {
    server.state.charts = [{ id: 'existing', name: 'Saved regions', description: 'Saved description', datasetId: 'orders', spec: { specVersion: 1, query: { version: 1, dataset: 'orders', mode: 'detail', columns: ['region'] }, viz: { type: 'table' } } }]
    open('/workbench/charts/existing')
    await waitFor(() => expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Chart name' }).value).toBe('Saved regions'))
    expect(description().value).toBe('Saved description')
    // The columns are restored once the dataset has loaded, after the chart itself.
    expect(await within(columns()).findByText('Region')).toBeTruthy()
    expect(changeDataset().getAttribute('aria-expanded')).toBe('false')
    await waitFor(() => expect(calls('POST', '/query')).toHaveLength(1))
    expect(calls('POST', '/query')[0]!.body).toMatchObject({ query: { dataset: 'orders', mode: 'detail', columns: ['region'] } })
    expect((await screen.findAllByText('North')).length).toBeGreaterThan(0)
    fireEvent.click(changeDataset())
    const selected = await screen.findByRole('treeitem', { name: 'Orders', selected: true })
    expect(selected.getAttribute('data-resource-id')).toBe('orders')
    expect(screen.getByRole('treeitem', { name: 'Commerce' }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('treeitem', { name: 'Regional' }).getAttribute('aria-expanded')).toBe('true')
  })

  it('hides fields from the picker while preserving existing chart references', async () => {
    const spec = server.state.datasets[0]!.spec as { fields: SpecField[] }
    spec.fields[0]!.hidden = true
    spec.fields.push({ key: 'channel', label: 'Channel', type: 'string', role: 'dimension', column: 'channel' })
    server.state.charts = [{ id: 'existing', name: 'Saved regions', datasetId: 'orders', spec: { specVersion: 1, query: { version: 1, dataset: 'orders', mode: 'detail', columns: ['region'] }, viz: { type: 'table' } } }]
    open('/workbench/charts/existing')
    await screen.findByRole('textbox', { name: 'Chart name' })
    expect(await within(columns()).findByText('Region')).toBeTruthy()
    expect(await fields().findByText('Channel')).toBeTruthy()
    expect(fields().queryByText('Region')).toBeNull()
    await waitFor(() => expect(calls('POST', '/query')).toHaveLength(1))
    expect(lastQuery()).toMatchObject({ columns: ['region'] })
    fireEvent.change(title(), { target: { value: 'Still uses hidden region' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls('PUT', '/charts/{id}')).toHaveLength(1))
    expect(calls('PUT', '/charts/{id}')[0]!.body).toMatchObject({ spec: { query: { columns: ['region'] } } })
  })

  it('keeps the panel open when its field is clicked, and shows a chosen dataset by name until it is changed', async () => {
    open()
    await screen.findByRole('textbox', { name: 'Chart name' })
    expect(picker().getAttribute('aria-expanded')).toBe('true')
    fireEvent.change(picker(), { target: { value: 'inv' } })
    fireEvent.click(picker())
    expect(picker().getAttribute('aria-expanded')).toBe('true')
    expect(picker().value).toBe('inv')
    fireEvent.click(await screen.findByText('Inventory', { selector: '.wb-row-name' }))
    expect(await fields().findByText('SKU')).toBeTruthy()

    // Chosen, the dataset is named as text, beside the buttons to change and to edit it.
    expect(screen.queryByRole('combobox', { name: 'Search datasets' })).toBeNull()
    const name = screen.getByText('Inventory', { selector: '.dataset-picker-name' })
    expect(screen.getByRole('link', { name: 'Edit dataset' }).closest('.dataset-picker')).toBe(name.closest('.dataset-picker'))
    // Clicking the name or the edit button does not open the tree; the change button does, to search from nothing.
    fireEvent.click(name)
    expect(screen.queryByRole('tree', { name: 'Datasets' })).toBeNull()
    fireEvent.click(changeDataset())
    expect(await screen.findByRole('tree', { name: 'Datasets' })).toBeTruthy()
    expect(picker().value).toBe('')
    expect(picker().placeholder).toBe('Inventory')
    expect(document.activeElement).toBe(picker())
    fireEvent.change(picker(), { target: { value: 'ord' } })
    expect(await screen.findByText('Orders', { selector: '.wb-row-name' })).toBeTruthy()
    // Given up with Escape, the name is back and the focus is on the button that opened the tree.
    fireEvent.keyDown(picker(), { key: 'Escape', code: 'Escape' })
    expect(screen.getByText('Inventory', { selector: '.dataset-picker-name' })).toBeTruthy()
    expect(document.activeElement).toBe(changeDataset())
  })

  it('lets a chart whose dataset cannot be loaded read another one', async () => {
    server.state.charts = [{ id: 'existing', name: 'Saved regions', datasetId: 'orders', spec: { specVersion: 1, query: { version: 1, dataset: 'orders', mode: 'detail', columns: ['region'] }, viz: { type: 'table' } } }]
    server.state.failDataset = 'orders'
    open('/workbench/charts/existing')
    expect(await screen.findByText(/Dataset temporarily unavailable/)).toBeTruthy()
    expect(picker().disabled).toBe(false)
    await choose('Inventory')
    expect(await fields().findByText('SKU')).toBeTruthy()
    expect(screen.queryByText(/Dataset temporarily unavailable/)).toBeNull()
    expect(title().value).toBe('Saved regions')
    expect(screen.getByTestId('where').textContent).toBe('/workbench/charts/existing')
  })
})

describe('chart editor row order and limit', () => {
  function rankedChart(query: Record<string, unknown> = {}) {
    const dataset = server.state.datasets[0]!.spec as { fields: SpecField[] }
    dataset.fields.push({ key: 'amount', label: 'Amount', type: 'decimal', role: 'measure', column: 'amount' })
    server.state.charts = [{ id: 'ranked', name: 'Top regions', datasetId: 'orders', spec: { specVersion: 1, query: { version: 1, dataset: 'orders', dimensions: [{ field: 'region' }], measures: [{ field: 'amount', agg: 'sum' }], ...query }, viz: { type: 'bar', x: 'region', y: ['amount'] } } }]
  }
  const sortBy = async (name: string, direction: string) => {
    openPopup(await screen.findByRole('button', { name: `Options for ${name}` }))
    fireEvent.click(await screen.findByRole('menuitem', { name: direction }))
  }
  const limit = () => screen.getByRole<HTMLInputElement>('spinbutton', { name: 'Most rows shown' })

  it('orders rows from the field menu, limits them once the number is entered, and saves both', async () => {
    rankedChart()
    server.state.query = async () => server.answer({ columns: [{ name: 'region', type: 'string', role: 'dimension' }, { name: 'amount', type: 'decimal', role: 'measure' }], rows: [['North', 3]], meta: { durationMs: 2, truncated: true } })
    open('/workbench/charts/ranked')
    await waitFor(() => expect(calls('POST', '/query')).toHaveLength(1))
    expect(await screen.findByText(/only the first 1 are shown/)).toBeTruthy()

    await sortBy('SUM(Amount)', 'Descending')
    await waitFor(() => expect(lastQuery().sort).toEqual([{ by: 'amount', desc: true }]))
    expect(screen.getByRole('img', { name: 'Sorted descending' })).toBeTruthy()
    await sortBy('Region', 'Ascending')
    await waitFor(() => expect(lastQuery().sort).toEqual([{ by: 'amount', desc: true }, { by: 'region' }]))
    // With more than one key, each says where it comes.
    expect(screen.getByRole('img', { name: 'Sorted descending, key 1' })).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Sorted ascending, key 2' })).toBeTruthy()
    await sortBy('Region', 'Remove sorting')
    await waitFor(() => expect(lastQuery().sort).toEqual([{ by: 'amount', desc: true }]))

    // Nothing is asked for while the number is being typed, nor for one that is no number of rows.
    const queried = calls('POST', '/query').length
    fireEvent.change(limit(), { target: { value: '0' } })
    fireEvent.blur(limit())
    expect(screen.getByText('Enter a whole number from 1 to 10000')).toBeTruthy()
    fireEvent.change(limit(), { target: { value: '10' } })
    expect(calls('POST', '/query')).toHaveLength(queried)
    fireEvent.blur(limit())
    await waitFor(() => expect(lastQuery().limit).toBe(10))
    // Fewer rows than there are is what was asked for, not something to warn about.
    await waitFor(() => expect(screen.queryByText(/only the first 1 are shown/)).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls('PUT', '/charts/{id}')).toHaveLength(1))
    expect((calls('PUT', '/charts/{id}')[0]!.body!.spec as ChartSpecBody).query).toMatchObject({ sort: [{ by: 'amount', desc: true }], limit: 10 })
  })

  it('shows a saved limit above what the server returns as wrong, and that the result stops short of it', async () => {
    rankedChart({ limit: 8000 })
    server.state.queryRows = { default: 100, max: 5000 }
    server.state.query = async () => server.answer({ columns: [{ name: 'region', type: 'string', role: 'dimension' }, { name: 'amount', type: 'decimal', role: 'measure' }], rows: [['North', 3]], meta: { durationMs: 2, truncated: true } })
    open('/workbench/charts/ranked')
    await waitFor(() => expect(calls('POST', '/query')).toHaveLength(1))
    expect(await screen.findByText(/only the first 1 are shown/)).toBeTruthy()
    expect(screen.getByText('Enter a whole number from 1 to 5000')).toBeTruthy()
    fireEvent.change(limit(), { target: { value: '' } })
    expect(limit().placeholder).toBe('Default 100')
  })

  it('configures year-over-year and previous-period output with a shared date filter and restores it', async () => {
    rankedChart()
    const dataset = server.state.datasets[0]!.spec as { fields: SpecField[] }
    dataset.fields.push({ key: 'created', label: 'Created', type: 'timestamp', role: 'dimension', column: 'created' })
    const opened = open('/workbench/charts/ranked')
    await openPopup(await screen.findByRole('button', { name: 'Options for SUM(Amount)' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Measure calculation' }))
    let dialog = within(await screen.findByRole('dialog', { name: 'Amount · Measure calculation' }))
    fireEvent.click(dialog.getByRole('radio', { name: 'Period comparison' }))
    fireEvent.click(dialog.getByRole('radio', { name: 'Year over year' }))
    fireEvent.click(dialog.getByRole('button', { name: 'OK' }))
    const compute = { type: 'compare', timeField: 'created', offset: { n: 1, unit: 'year' }, output: 'ratio' }
    await waitFor(() => expect(lastQuery().measures).toEqual([{ field: 'amount', agg: 'sum', compute }]))
    expect(lastQuery().filter).toEqual({ op: 'and', args: [{ field: 'created', op: 'time', value: { current: 'month' } }] })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls('PUT', '/charts/{id}')).toHaveLength(1))
    const saved = calls('PUT', '/charts/{id}')[0]!.body!
    expect((saved.spec as ChartSpecBody).filters).toMatchObject([{ field: 'created', op: 'time', value: { current: 'month' } }])
    server.state.charts[0] = { ...server.state.charts[0], ...saved }
    opened.unmount()
    open('/workbench/charts/ranked')
    await openPopup(await screen.findByRole('button', { name: 'Options for SUM(Amount) (Year over year · Growth rate)' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Measure calculation' }))
    dialog = within(await screen.findByRole('dialog', { name: 'Amount · Measure calculation' }))
    expect(dialog.getByRole('radio', { name: 'Year over year' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(dialog.getByRole('radio', { name: 'Previous period' }))
    await pickSelect('Time unit', 'month')
    fireEvent.change(dialog.getByRole('spinbutton', { name: 'Periods back' }), { target: { value: '0' } })
    expect(dialog.getByRole<HTMLButtonElement>('button', { name: 'OK' }).disabled).toBe(true)
    fireEvent.change(dialog.getByRole('spinbutton', { name: 'Periods back' }), { target: { value: '1' } })
    await pickSelect('Calculation result', 'Previous value')
    fireEvent.click(dialog.getByRole('button', { name: 'OK' }))
    await waitFor(() => expect(lastQuery().measures).toEqual([{ field: 'amount', agg: 'sum', compute: { ...compute, offset: { n: 1, unit: 'month' }, output: 'value' } }]))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls('PUT', '/charts/{id}')).toHaveLength(2))
    expect((calls('PUT', '/charts/{id}')[1]!.body!.spec as ChartSpecBody).filters).toHaveLength(1)
  })

  it('upgrades an existing single-date control when comparison config sets a period', async () => {
    rankedChart()
    const dataset = server.state.datasets[0]!.spec as { fields: SpecField[] }
    dataset.fields.push({ key: 'created', label: 'Created', type: 'timestamp', role: 'dimension', column: 'created' })
    const spec = server.state.charts[0]!.spec as ChartSpecBody
    spec.filters = [{ id: 'period', label: 'Report date', field: 'created', op: 'time', value: { start: '2026-02-01', end: '2026-02-02' }, control: { type: 'date' } }]
    const opened = open('/workbench/charts/ranked')
    await openPopup(await screen.findByRole('button', { name: 'Options for SUM(Amount)' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Measure calculation' }))
    const dialog = within(await screen.findByRole('dialog', { name: 'Amount · Measure calculation' }))
    fireEvent.click(dialog.getByRole('radio', { name: 'Period comparison' }))
    fireEvent.click(dialog.getByRole('radio', { name: 'Relative dates' }))
    fireEvent.click(dialog.getByRole('radio', { name: 'This month' }))
    fireEvent.click(dialog.getByRole('button', { name: 'OK' }))
    expect(await screen.findByRole('button', { name: 'Report date · This month' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls('PUT', '/charts/{id}')).toHaveLength(1))
    const saved = calls('PUT', '/charts/{id}')[0]!.body!
    expect((saved.spec as ChartSpecBody).filters).toEqual([{ id: 'period', label: 'Report date', field: 'created', op: 'time', value: { current: 'month' }, control: { type: 'relative' } }])
    server.state.charts[0] = { ...server.state.charts[0], ...saved }
    opened.unmount()
    open('/workbench/charts/ranked')
    expect(await screen.findByRole('button', { name: 'Report date · This month' })).toBeTruthy()
  })

  it('configures, previews, saves and restores a grouped percentage, then returns to the original value', async () => {
    rankedChart()
    const opened = open('/workbench/charts/ranked')
    await waitFor(() => expect(lastQuery().measures).toEqual([{ field: 'amount', agg: 'sum' }]))
    await openPopup(screen.getByRole('button', { name: 'Options for SUM(Amount)' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Measure calculation' }))
    const dialog = within(await screen.findByRole('dialog', { name: 'Amount · Measure calculation' }))
    fireEvent.click(dialog.getByRole('radio', { name: 'Within groups' }))
    expect(dialog.getByRole<HTMLButtonElement>('button', { name: 'OK' }).disabled).toBe(true)
    fireEvent.click(dialog.getByRole('checkbox', { name: 'Region' }))
    fireEvent.click(dialog.getByRole('button', { name: 'OK' }))
    await waitFor(() => expect(lastQuery().measures).toEqual([{ field: 'amount', agg: 'sum', compute: { type: 'percent_of_total', within: ['region'] } }]))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls('PUT', '/charts/{id}')).toHaveLength(1))
    server.state.charts[0] = { ...server.state.charts[0], ...calls('PUT', '/charts/{id}')[0]!.body }
    opened.unmount()
    open('/workbench/charts/ranked')
    await openPopup(await screen.findByRole('button', { name: 'Options for SUM(Amount) (% of total)' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Measure calculation' }))
    const restored = within(await screen.findByRole('dialog', { name: 'Amount · Measure calculation' }))
    expect(restored.getByRole('checkbox', { name: 'Region' }).getAttribute('data-state')).toBe('checked')
    fireEvent.click(restored.getByRole('radio', { name: 'Original value' }))
    fireEvent.click(restored.getByRole('button', { name: 'OK' }))
    await waitFor(() => expect(lastQuery().measures).toEqual([{ field: 'amount', agg: 'sum' }]))
  })

  it('runs a sum along a dimension, takes it back when the sum is averaged, and cannot run an average', async () => {
    rankedChart()
    open('/workbench/charts/ranked')
    await waitFor(() => expect(lastQuery().measures).toEqual([{ field: 'amount', agg: 'sum' }]))
    await openPopup(screen.getByRole('button', { name: 'Options for SUM(Amount)' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Measure calculation' }))
    const dialog = within(await screen.findByRole('dialog', { name: 'Amount · Measure calculation' }))
    fireEvent.click(dialog.getByRole('radio', { name: 'Running total' }))
    expect(dialog.getByRole('combobox', { name: 'Run along' }).textContent).toContain('Region')
    fireEvent.click(dialog.getByRole('button', { name: 'OK' }))
    await waitFor(() => expect(lastQuery().measures).toEqual([{ field: 'amount', agg: 'sum', compute: { type: 'cumulative', along: 'region' } }]))
    // An average cannot run: the measure goes back to its original value.
    await openPopup(await screen.findByRole('button', { name: 'Options for SUM(Amount) (running total)' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Average/ }))
    await waitFor(() => expect(lastQuery().measures).toEqual([{ field: 'amount', agg: 'avg' }]))
    await openPopup(await screen.findByRole('button', { name: 'Options for AVG(Amount)' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Measure calculation' }))
    const averaged = within(await screen.findByRole('dialog', { name: 'Amount · Measure calculation' }))
    expect(averaged.getByRole<HTMLButtonElement>('radio', { name: 'Running total' }).disabled).toBe(true)
    expect(averaged.getByText(/Only sums, counts, minimums and maximums can run/)).toBeTruthy()
  })

  it('opens a chart with an order and a limit for editing, and stops ordering by a column taken off', async () => {
    rankedChart({ sort: [{ by: 'region' }], limit: 5 })
    open('/workbench/charts/ranked')
    await waitFor(() => expect(lastQuery()).toMatchObject({ sort: [{ by: 'region' }], limit: 5 }))
    expect(screen.queryByText(/cannot edit yet/)).toBeNull()
    expect(limit().value).toBe('5')
    fireEvent.click(screen.getByRole('button', { name: 'Remove Region' }))
    // Still bars, which need a dimension: nothing is asked for until the chart is a KPI.
    const queried = calls('POST', '/query').length
    expect(await screen.findByText('Bar needs a dimension.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'KPI' }))
    await waitFor(() => expect(calls('POST', '/query').length).toBeGreaterThan(queried))
    expect(lastQuery().dimensions).toEqual([])
    expect(lastQuery()).not.toHaveProperty('sort')
    // Emptied, the server's default number of rows applies again.
    fireEvent.change(limit(), { target: { value: '' } })
    fireEvent.keyDown(limit(), { key: 'Enter' })
    await waitFor(() => expect(lastQuery()).not.toHaveProperty('limit'))
  })

  it('lets the author allow data exports, off by default, and says what a row limit means for them', async () => {
    rankedChart()
    open('/workbench/charts/ranked')
    const allow = await screen.findByRole('checkbox', { name: 'Allow data exports' })
    await waitFor(() => expect(allow.hasAttribute('disabled')).toBe(false))
    expect(allow.getAttribute('data-state')).toBe('unchecked')
    expect(screen.getByText(/developers and admins included/)).toBeTruthy()
    fireEvent.click(allow)
    fireEvent.change(limit(), { target: { value: '10' } })
    fireEvent.blur(limit())
    expect(await screen.findByText('The chart shows at most 10 rows, so exports contain only those rows.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls('PUT', '/charts/{id}')).toHaveLength(1))
    expect((calls('PUT', '/charts/{id}')[0]!.body!.spec as ChartSpecBody & { allowExport?: boolean }).allowExport).toBe(true)
    cleanup()
    rankedChart()
    Object.assign(server.state.charts[0]!.spec as object, { allowExport: true })
    open('/workbench/charts/ranked')
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Allow data exports' }).getAttribute('data-state')).toBe('checked'))
  })

  it('groups the settings into folding sections: General on every chart, the others only when there is something to set', async () => {
    rankedChart()
    open('/workbench/charts/ranked')
    const general = await screen.findByRole('button', { name: 'General' })
    expect(general.getAttribute('aria-expanded')).toBe('true')
    // One measure on one dimension cannot be stacked; the bars still have a width.
    expect(await screen.findByRole('button', { name: 'Style' })).toBeTruthy()
    expect(screen.getByRole('spinbutton', { name: 'Widest bar (pixels)' })).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: 'Stacked' })).toBeNull()
    // Bars have no data points to show, which lines do.
    expect(screen.queryByRole('checkbox', { name: 'Show data points' })).toBeNull()

    // Folded, the settings are out of sight, and stay folded for the next chart opened in this browser.
    fireEvent.click(general)
    expect(general.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('spinbutton', { name: 'Most rows shown' })).toBeNull()
    expect(localStorage.getItem('supabi.chart.section.general')).toBe('true')
    fireEvent.click(general)
    expect(limit()).toBeTruthy()

    // Two measures on bars can be stacked.
    const chart = server.state.charts[0]! as { spec: { query: Record<string, unknown>; viz: Record<string, unknown> } }
    chart.spec.query.measures = [{ field: 'amount', agg: 'sum' }, { field: 'amount', agg: 'avg', alias: 'amount_avg' }]
    chart.spec.viz.y = ['amount', 'amount_avg']
    cleanup()
    open('/workbench/charts/ranked')
    expect(await screen.findByRole('checkbox', { name: 'Stacked' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Style' }))
    expect(screen.queryByRole('checkbox', { name: 'Stacked' })).toBeNull()
    expect((await screen.findByRole('button', { name: 'General' })).getAttribute('aria-expanded')).toBe('true')
  })
})

describe('chart editor tables', () => {
  const aggregated = () => screen.getByRole<HTMLButtonElement>('radio', { name: 'Aggregated' })
  const detailMode = () => screen.getByRole<HTMLButtonElement>('radio', { name: 'Detail' })

  it('offers one kind of table, which groups its rows or lists them as they are', async () => {
    const dataset = server.state.datasets[0]!.spec as { fields: SpecField[] }
    dataset.fields.push({ key: 'amount', label: 'Amount', type: 'decimal', role: 'measure', column: 'amount' })
    open('/workbench/charts/new?dataset=orders')
    await screen.findByRole('textbox', { name: 'Chart name' })
    await fields().findByText('Region')
    // A new chart is a table listing the rows.
    expect(screen.queryByRole('button', { name: 'Detail table' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Table' }).getAttribute('aria-pressed')).toBe('true')
    expect(detailMode().getAttribute('aria-checked')).toBe('true')
    await addColumn('Region')
    await waitFor(() => expect(lastQuery()).toMatchObject({ mode: 'detail', columns: ['region'] }))

    // Grouped, the column becomes a dimension; choosing the table again changes nothing.
    fireEvent.click(aggregated())
    await waitFor(() => expect(lastQuery()).toMatchObject({ dimensions: [{ field: 'region' }] }))
    expect(screen.getByText('Dimensions', { selector: '.shelf-label' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Table' }))
    expect(aggregated().getAttribute('aria-checked')).toBe('true')

    // Another kind of chart has no such choice.
    const metrics = screen.getByText('Metrics', { selector: '.shelf-label' }).closest<HTMLElement>('.shelf')!
    const source = fields().getByText('Amount').closest<HTMLElement>('[draggable]')!
    const dataTransfer = { setData: () => undefined, effectAllowed: '' }
    fireEvent.dragStart(source, { dataTransfer })
    fireEvent.dragOver(metrics, { dataTransfer })
    fireEvent.drop(metrics, { dataTransfer })
    fireEvent.dragEnd(source, { dataTransfer })
    fireEvent.click(screen.getByRole('button', { name: 'Bar' }))
    expect(screen.getByRole('button', { name: 'Bar' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByRole('radio', { name: 'Aggregated' })).toBeNull()
  })

  it('cannot list the rows of a table that filters on aggregated results, and says why', async () => {
    const dataset = server.state.datasets[0]!.spec as { fields: SpecField[] }
    dataset.fields.push({ key: 'amount', label: 'Amount', type: 'decimal', role: 'measure', column: 'amount' })
    server.state.charts = [{ id: 'grouped', name: 'Grouped', datasetId: 'orders', spec: { specVersion: 1, query: { version: 1, dataset: 'orders', dimensions: [{ field: 'region' }], measures: [{ field: 'amount', agg: 'sum' }] }, viz: { type: 'table' }, filters: [{ id: 'big', field: 'amount', op: 'gte', value: 10, aggregation: 'sum' }] } }]
    open('/workbench/charts/grouped')
    await waitFor(() => expect(aggregated().getAttribute('aria-checked')).toBe('true'))
    expect(detailMode().disabled).toBe(true)
    expect(screen.getByText(/cannot filter aggregate results/)).toBeTruthy()
  })
})

describe('chart editor chart type', () => {
  function barChart() {
    const dataset = server.state.datasets[0]!.spec as { fields: SpecField[] }
    dataset.fields.push({ key: 'amount', label: 'Amount', type: 'decimal', role: 'measure', column: 'amount' })
    server.state.charts = [{ id: 'bars', name: 'Bars', datasetId: 'orders', spec: { specVersion: 1, query: { version: 1, dataset: 'orders', dimensions: [{ field: 'region' }], measures: [{ field: 'amount', agg: 'sum' }] }, viz: { type: 'bar', x: 'region', y: ['amount'] } } }]
  }
  const dimensionsShelf = () => screen.getByText('Dimensions', { selector: '.shelf-label' }).closest<HTMLElement>('.shelf')!

  it('stays what the author chose when its fields no longer fit, and says what is missing', async () => {
    barChart()
    open('/workbench/charts/bars')
    await waitFor(() => expect(calls('POST', '/query')).toHaveLength(1))
    fireEvent.change(title(), { target: { value: 'Renamed bars' } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove Region' }))

    expect(screen.getByRole('button', { name: 'Bar' }).getAttribute('aria-pressed')).toBe('true')
    expect(await screen.findByText('Bar needs a dimension.')).toBeTruthy()
    expect(dimensionsShelf().classList.contains('needs')).toBe(true)
    // The last result is not left to be read as this chart, nothing is asked for, and it cannot be saved.
    expect(screen.queryByTestId('chart')).toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Run' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true)
    expect(calls('POST', '/query')).toHaveLength(1)

    // Put back, it is drawn again as bars.
    await addDimension('Region')
    await waitFor(() => expect(calls('POST', '/query')).toHaveLength(2))
    expect(screen.queryByText('Bar needs a dimension.')).toBeNull()
    expect(dimensionsShelf().classList.contains('needs')).toBe(false)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(false)
  })

  it('lets any type be chosen before its fields, and says what each takes', async () => {
    barChart()
    open('/workbench/charts/bars')
    await waitFor(() => expect(calls('POST', '/query')).toHaveLength(1))
    const kpi = screen.getByRole('button', { name: 'KPI' })
    expect(kpi.getAttribute('aria-disabled')).toBeNull()
    fireEvent.click(kpi)
    expect(kpi.getAttribute('aria-pressed')).toBe('true')
    expect(await screen.findByText('KPI takes no dimensions.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Pie' }))
    await waitFor(() => expect(calls('POST', '/query')).toHaveLength(2))
    expect(lastQuery()).toMatchObject({ dimensions: [{ field: 'region' }] })
  })
})

type ChartSpecBody = { query: Record<string, unknown>; filters?: unknown[] }

describe('drilling down', () => {
  function drilledChart() {
    const dataset = server.state.datasets[0]!.spec as { fields: Record<string, unknown>[] }
    dataset.fields.push(
      { key: 'province', label: 'Province', type: 'string', role: 'dimension', column: 'province' },
      { key: 'created', label: 'Created', type: 'date', role: 'dimension', column: 'created' },
      { key: 'amount', label: 'Amount', type: 'decimal', role: 'measure', column: 'amount' },
    )
    server.state.charts = [{ id: 'drilled', name: 'Regions', datasetId: 'orders', spec: {
      specVersion: 1, query: { version: 1, dataset: 'orders', dimensions: [{ field: 'region' }], measures: [{ field: 'amount', agg: 'sum' }] },
      viz: { type: 'bar', x: 'region', y: ['amount'] }, drill: { alias: 'region', levels: [{ field: 'province', label: 'Province' }] },
    } }]
  }

  it('sets the levels from the menu of the dimension, and saves them', async () => {
    drilledChart()
    open('/workbench/charts/drilled')
    await waitFor(() => expect(title().readOnly).toBe(false))
    expect(screen.getByText('Drill', { selector: '.chip-tag' })).toBeTruthy()
    openPopup(screen.getByRole('button', { name: 'Options for Region' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Drill-down…' }))
    const dialog = within(await screen.findByRole('dialog', { name: 'Drill-down of “Region”' }))
    openPopup(dialog.getByRole('combobox', { name: 'Add the next level' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Created' }))
    expect(dialog.getByRole('combobox', { name: 'Grain of level 3' }).textContent).toContain('Month')
    fireEvent.click(dialog.getByRole('button', { name: 'OK' }))
    fireEvent.click(screen.getByRole('button', { name: /Save$/ }))
    await waitFor(() => expect(calls('PUT', '/charts/{id}')).toHaveLength(1))
    expect((calls('PUT', '/charts/{id}')[0]!.body!.spec as { drill: unknown }).drill).toEqual({ alias: 'region', levels: [{ field: 'province', label: 'Province' }, { field: 'created', grain: 'month', label: 'Created · Month' }] })
  })

  it('does not save levels that repeat a dimension of the chart', async () => {
    drilledChart()
    open('/workbench/charts/drilled')
    await waitFor(() => expect(title().readOnly).toBe(false))
    await addDimension('Province')
    expect(await screen.findByText(i18n.t('drill.problems.repeated'))).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Save$/ }).disabled).toBe(true)
  })

  it('drills the preview down through the server, and back from the breadcrumb', async () => {
    drilledChart()
    open('/workbench/charts/drilled')
    await waitFor(() => expect(calls('POST', '/query')).toHaveLength(1))
    fireEvent.click(await screen.findByRole('button', { name: 'Click North in region' }))
    fireEvent.click(screen.getByRole('button', { name: 'Drill down to Province' }))
    await waitFor(() => expect(calls('POST', '/charts/preview/data')).toHaveLength(1))
    const asked = calls('POST', '/charts/preview/data')[0]!.body!
    expect(asked.drill).toEqual(['North'])
    expect((asked.spec as { drill: { alias: string } }).drill.alias).toBe('region')
    const crumbs = await screen.findByRole('navigation', { name: 'Drill-down levels' })
    expect(crumbs.textContent).toBe('Drilled down:regionNorth')
    // At the last level there is nothing left to click.
    expect(screen.queryByRole('button', { name: 'Click North in region' })).toBeNull()
    fireEvent.click(within(crumbs).getByRole('button', { name: 'region' }))
    await waitFor(() => expect(calls('POST', '/query')).toHaveLength(2))
    expect(screen.queryByRole('navigation', { name: 'Drill-down levels' })).toBeNull()
  })
})
