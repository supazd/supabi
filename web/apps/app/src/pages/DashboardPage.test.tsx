import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { openPopup } from '@supabi/ui/testing'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { useCallback, useRef, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from 'i18next'
import '../i18n'

const server = vi.hoisted(() => {
  const chart = { id: 'chart', name: 'Orders', datasetId: 'orders', spec: {
    specVersion: 1, query: { version: 1, dataset: 'orders', measures: [{ field: 'amount' }] }, viz: { type: 'kpi', y: ['amount'] },
    filters: [{ id: 'amount_local', field: 'amount', op: 'lte', value: 50, label: 'Chart amount', control: { type: 'number' } },
      { id: 'name_local', field: 'name', op: 'contains', value: 'Alice', label: 'Chart name', control: { type: 'text' } }],
  } }
  const dashboard = { id: 'board', name: 'Board', description: '', revision: 1, charts: [chart], spec: { specVersion: 1, layout: { columns: 96, items: [{ id: 'w1', type: 'chart', chartId: 'chart', x: 0, y: 0, w: 6, h: 4 }] },
    filters: [{ id: 'amount_global', label: 'Global amount', op: 'gte', control: { type: 'number' }, default: 100, targets: [{ item: 'w1', field: 'amount' }] }],
  } }
  const initial = structuredClone(dashboard)
  type Request = { path: string; body: Record<string, unknown>; params?: Record<string, string> }
  const behavior = {
    role: 'viewer' as 'viewer' | 'developer' | 'admin',
    saveFailure: false, saveRevision: undefined as number | undefined, savePending: undefined as Promise<void> | undefined, createdReloadPending: undefined as Promise<void> | undefined,
    datasetReloadPending: undefined as Promise<void> | undefined,
    options: undefined as ((request: Request) => { values: unknown[]; truncated: boolean } | Promise<{ values: unknown[]; truncated: boolean }>) | undefined,
    meta: undefined as ((request: Request) => Record<string, unknown>) | undefined,
    result: undefined as { columns: Record<string, unknown>[]; rows: unknown[][] } | undefined,
    dataPending: undefined as Promise<void> | undefined,
    dataFailure: false,
    workspaces: [] as { id: string; name: string; timezone: string; weekStart: number }[],
    views: new Map<string, unknown>(),
  }
  const workspaces = [{ id: 'ws_main', name: 'Main', timezone: 'UTC', weekStart: 1 }, { id: 'ws_other', name: 'Other', timezone: 'UTC', weekStart: 1 }]
  const datasets: Record<string, unknown> = {
    orders: { id: 'orders', spec: { specVersion: 1, source: { type: 'table' }, fields: [
      { key: 'id', label: 'Order ID', type: 'integer', role: 'dimension' },
      { key: 'created', label: 'Created', type: 'date', role: 'dimension' },
      { key: 'amount', label: 'Amount', type: 'decimal', role: 'measure' },
      { key: 'discount', label: 'Discount', type: 'decimal', role: 'measure' },
      { key: 'tax', label: 'Tax', type: 'decimal', role: 'measure' },
    ] } },
    shipments: { id: 'shipments', spec: { specVersion: 1, source: { type: 'table' }, fields: [
      { key: 'id', label: 'Shipment ID', type: 'integer', role: 'dimension' },
      { key: 'sent', label: 'Sent', type: 'timestamp', role: 'dimension' },
    ] } },
  }
  const initialDatasets = structuredClone(datasets)
  const calls: Record<string, unknown>[] = []
  const gets: string[] = []
  const requests: (Request & { method: string })[] = []
  const saved = new Map<string, unknown>()
  const grid: { change?: (items: unknown[]) => void; items: unknown[]; settings: Record<string, unknown>; groups: Record<string, string>; move?: (move: import('@supabi/ui').GridMove) => void } = { items: [], settings: {}, groups: {} }
  const answer = (data: unknown) => ({ data, response: { ok: true, status: 200 } })
  return { dashboard, initial, behavior, datasets, initialDatasets, calls, gets, requests, saved, grid, workspaces, api: {
    GET: async (path: string, options?: { params?: { path?: { id?: string } } }) => {
      gets.push(path)
      const id = options?.params?.path?.id ?? ''
      if (path === '/users' || path === '/groups') return answer([])
      if (path === '/dashboards/{id}/grants') return answer({ subjects: [] })
      if (path === '/dashboards/{id}/revisions') return answer({ items: [{ revision: 1, name: 'Sales', createdAt: '2026-10-20T08:00:00Z' }] })
      if (path === '/exports') return answer({ items: [], unseen: 0, maxRows: 2000000, maxBytes: 536870912, retentionSeconds: 86400, timeoutSeconds: 900 })
      if (path === '/dashboards/{id}/views/{viewId}') {
        const view = behavior.views.get((options?.params?.path as { viewId?: string } | undefined)?.viewId ?? '')
        return view ? answer({ id: 'dv_shared', state: view, expiresAt: '2026-11-18T00:00:00Z' }) : { error: { code: 'view_not_found' }, response: { ok: false, status: 404 } }
      }
      if (path === '/dashboards/{id}' && id === 'missing') return { error: { code: 'not_found' }, response: { ok: false, status: 404 } }
      if (path === '/dashboards/{id}' && id === 'created') await behavior.createdReloadPending
      if (path === '/datasets/{id}') await behavior.datasetReloadPending
      return answer(path === '/dashboards/{id}' ? saved.get(id) ?? dashboard : path === '/datasets/{id}' ? datasets[id] : path === '/charts/{id}' ? dashboard.charts.find((chart) => chart.id === id) : { values: [], truncated: false })
    },
    PUT: async (path: string, options: { body: Record<string, unknown>; params?: { path: { id: string } } }) => {
      calls.push(options.body)
      requests.push({ method: 'PUT', path, body: options.body })
      await behavior.savePending
      if (behavior.saveRevision !== undefined && options.body.expectedRevision !== behavior.saveRevision) return { error: { code: 'resource_revision_conflict' }, response: { ok: false, status: 409 } }
      return behavior.saveFailure ? { error: { code: 'network_error' }, response: { ok: false, status: 503 } } : answer({ ...dashboard, ...options.body, id: options.params?.path.id ?? dashboard.id, revision: Number(options.body.expectedRevision ?? 0) + 1 })
    },
    POST: async (path: string, options: { body: Record<string, unknown>; params?: { path?: Record<string, string> } }) => {
      calls.push(options.body)
      const request = { path, body: structuredClone(options.body), params: options.params?.path }
      requests.push({ method: 'POST', ...request })
      if (path === '/dashboards') {
        const created = { ...dashboard, ...options.body, id: 'created' }
        saved.set(created.id, created)
        return answer(created)
      }
      if (path.endsWith('/options')) return answer(await behavior.options?.(request) ?? { values: [], truncated: false })
      if (path === '/dashboards/{id}/views') return answer({ id: 'dv_new', state: options.body.state, expiresAt: '2026-11-18T00:00:00Z' })
      await behavior.dataPending
      if (behavior.dataFailure) return { error: { code: 'timeout', message: 'too slow' }, response: { ok: false, status: 504 } }
      return answer({ columns: [{ name: 'amount', type: 'decimal', role: 'measure' }], rows: [[300]], ...behavior.result, meta: { durationMs: 1, ...behavior.meta?.(request) } })
    },
  } }
})
vi.mock('../api/client', async (original) => ({ ...await original<typeof import('../api/client')>(), api: server.api }))
vi.mock('../auth/session', async (original) => {
  const session = await original<typeof import('../auth/session')>()
  return { ...session, useWeekStart: () => 1, useSession: () => ({
    atLeast: (min: import('../auth/session').Role) => session.atLeast(server.behavior.role, min),
    state: { status: 'ok', data: { authenticated: true, setupRequired: false, workspace: server.workspaces[0], workspaces: server.behavior.workspaces } },
  }) }
})
// A value clicked opens what can be done with it, here as buttons below the chart.
vi.mock('../components/ChartView', async () => {
  const { useState } = await vi.importActual<typeof import('react')>('react')
  type Item = { key: string; label: string; onSelect?: () => void }
  function ChartView({ clickActions, colorScheme, surface }: { clickActions?: { columns: string[]; items: (column: string, value: string | null) => Item[] }; colorScheme: string; surface?: string }) {
    const [items, setItems] = useState<Item[]>([])
    const column = clickActions?.columns[0]
    return <div data-scheme={colorScheme} data-surface={surface}>Chart result{column !== undefined && <><button onClick={() => setItems(clickActions!.items(column, 'East'))}>Click East</button><button onClick={() => setItems(clickActions!.items(column, null))}>Click missing</button></>}
      {items.map((item) => <button key={item.key} onClick={() => { setItems([]); item.onSelect?.() }}>{item.label}</button>)}</div>
  }
  return { namedColumns: (result: unknown) => result, ChartView }
})
vi.mock('@supabi/ui', async (original) => ({
  ...await original<typeof import('@supabi/ui')>(),
  GridLayout: ({ items, renderItem, onChange, ...settings }: { items: { id: string }[]; renderItem: (item: { id: string }) => ReactNode; onChange?: (items: unknown[]) => void; group?: string }) => {
    server.grid.items = items
    server.grid.change = onChange
    server.grid.settings = settings
    // Which grid each item is on, by the key it joins its group with.
    for (const item of items) if (settings.group !== undefined) server.grid.groups[item.id] = settings.group
    return <div>{items.map((item) => <div key={item.id}>{renderItem(item)}</div>)}</div>
  },
  GridGroup: ({ onMove, children }: { onMove: (move: import('@supabi/ui').GridMove) => void; children: ReactNode }) => {
    server.grid.move = onMove
    return children
  },
}))
vi.mock('../workbench/context', async (original) => ({ ...await original<typeof import('../workbench/context')>(), useWorkbench: () => ({ resources: { charts: server.dashboard.charts, folders: [] }, reload: async () => undefined, slots: { side: null, aside: null, bottom: null, status: null } }) }))
import { DashboardEditor, DashboardView } from './DashboardPage'
import { clockTime } from '../lib/freshness'
import { EditorPanelsProvider } from '../components/EditorPanels'
import { ScrollArea, useArea } from '../lib/nearby'
import { UnsavedChangesProvider } from '../components/UnsavedChanges'

afterEach(cleanup)
beforeEach(async () => {
  server.calls.length = 0
  server.grid.groups = {}
  server.gets.length = 0
  server.requests.length = 0
  server.saved.clear()
  server.behavior.role = 'viewer'
  server.behavior.saveFailure = false
  server.behavior.saveRevision = undefined
  server.behavior.savePending = undefined
  server.behavior.createdReloadPending = undefined
  server.behavior.datasetReloadPending = undefined
  server.behavior.options = undefined
  server.behavior.meta = undefined
  server.behavior.result = undefined
  server.behavior.dataPending = undefined
  server.behavior.dataFailure = false
  server.behavior.workspaces = server.workspaces
  server.behavior.views.clear()
  Object.assign(server.dashboard, structuredClone(server.initial))
  Object.assign(server.datasets, structuredClone(server.initialDatasets))
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
  window.matchMedia ??= (() => ({ matches: false, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined })) as never
  await i18n.changeLanguage('en-US')
})

async function chooseOption(label: string, option: string) {
  openPopup(screen.getByRole('combobox', { name: label }))
  fireEvent.click(await screen.findByRole('option', { name: option }))
}

const chooseMapping = (chart: string, option: string) => chooseOption(`Mapped field for ${chart}`, option)

function openEditor(path = '/workbench/dashboards/board') {
  const router = createMemoryRouter([
    { path: '/workbench/dashboards/new', element: <DashboardEditor colorScheme="light" /> },
    { path: '/workbench/dashboards/:id', element: <DashboardEditor colorScheme="light" /> },
    { path: '/dashboards/:id', element: <h1>Dashboard preview</h1> },
  ], { initialEntries: [path] })
  render(<UnsavedChangesProvider><EditorPanelsProvider slots={{ side: null, aside: null, bottom: null, status: null }} storageKey="test.dashboard"><RouterProvider router={router} /></EditorPanelsProvider></UnsavedChangesProvider>)
  return router
}

async function openFilters() {
  fireEvent.click(await screen.findByRole('button', { name: 'Global filters' }))
}

async function chartAction(action: string, name = 'Orders') {
  const chart = within(await screen.findByRole('article', { name }))
  const more = chart.getByRole('button', { name: `More chart actions: ${name}` })
  if (more.getAttribute('aria-expanded') !== 'true') fireEvent.click(more)
  const button = chart.getByRole('button', { name: action })
  act(() => button.focus())
  fireEvent.click(button)
}

async function removeChart() {
  await chartAction('Remove chart: Orders')
  fireEvent.click(within(await screen.findByRole('dialog', { name: 'Remove component' })).getByRole('button', { name: 'Remove component' }))
}

const saveButton = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Save' })
const saves = () => server.requests.filter(({ method, path }) => method === 'PUT' || path === '/dashboards')
const previewQueries = () => server.requests.filter(({ path }) => path === '/dashboards/preview/items/{itemId}/data')
async function rename(name: string, key = 'Enter') {
  fireEvent.click(await screen.findByRole('button', { name: 'Rename dashboard' }))
  const input = screen.getByRole('textbox', { name: 'Dashboard name' })
  fireEvent.change(input, { target: { value: name } })
  fireEvent.keyDown(input, { key })
}

function addMetricSelector(chart = server.dashboard.charts[0]!, label = 'Metric') {
  Object.assign(chart.spec, {
    query: { version: 1, dataset: chart.datasetId, measures: [{ field: 'amount', agg: 'sum', alias: 'selected_metric' }] },
    viz: { type: 'kpi', y: ['selected_metric'] },
    dynamics: [{ id: 'metric', kind: 'measure', alias: 'selected_metric', label, options: [
      { id: 'amount', field: 'amount', agg: 'sum', label: 'Total amount' },
      { id: 'discount', field: 'discount', agg: 'sum', label: 'Total discount' },
    ] }],
  })
}

function openViewer() {
  const router = createMemoryRouter([{ path: '/dashboards/:id', element: <DashboardView colorScheme="light" /> }], { initialEntries: ['/dashboards/board'] })
  render(<RouterProvider router={router} />)
}

describe('dashboard dynamic and cascade contexts', () => {
  it('switches a dynamic metric without dirtying the dashboard and uses confirmed override metadata', async () => {
    addMetricSelector()
    Object.assign(server.dashboard.charts[0]!.spec, { filters: [
      { id: 'amount_local', field: 'amount', aggregation: 'sum', op: 'lte', value: 50, label: 'Chart amount', control: { type: 'number' } },
      { id: 'discount_local', field: 'discount', aggregation: 'sum', op: 'lte', value: 10, label: 'Chart discount', control: { type: 'number' } },
    ] })
    Object.assign(server.dashboard.spec.filters[0]!, { targets: [{ item: 'w1', measure: 'selected_metric' }] })
    server.behavior.meta = ({ body }) => ({ overriddenFilters: body.useChartFilters ? [] : [(body.selections as Record<string, string>).metric === 'discount' ? 'discount_local' : 'amount_local'] })
    openEditor()
    await screen.findByRole('combobox', { name: 'Metric' })
    await waitFor(() => expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Chart amount' }).disabled).toBe(true))
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Chart discount' }).disabled).toBe(false)
    await chooseOption('Metric', 'Total discount')
    await waitFor(() => {
      expect(previewQueries().at(-1)?.body.selections).toEqual({ metric: 'discount' })
      expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Chart amount' }).disabled).toBe(false)
      expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Chart discount' }).disabled).toBe(true)
    })
    await chartAction('Use chart filters')
    await waitFor(() => {
      expect(previewQueries().at(-1)?.body.useChartFilters).toBe(true)
      expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Chart discount' }).disabled).toBe(false)
    })
    await chartAction('Restore global filters')
    await waitFor(() => expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Chart discount' }).disabled).toBe(true))
    // An explicit empty metadata list wins even if the field mapping would suggest a conflict.
    server.behavior.meta = () => ({ overriddenFilters: [] })
    await chartAction('Refresh chart: Orders')
    await waitFor(() => expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Chart discount' }).disabled).toBe(false))
    expect(saveButton().disabled).toBe(true)
    expect(saves()).toHaveLength(0)
    expect(server.dashboard.charts[0]!.spec.query.measures).toEqual([{ field: 'amount', agg: 'sum', alias: 'selected_metric' }])
  })

  it('loads global candidates using the explicitly selected source widget’s temporary selections', async () => {
    const source = structuredClone(server.dashboard.charts[0]!)
    source.id = 'source_chart'
    source.name = 'Source chart'
    addMetricSelector(source, 'Source metric')
    server.dashboard.charts.push(source)
    server.dashboard.spec.layout.items.push({ id: 'w2', type: 'chart', chartId: source.id, x: 6, y: 0, w: 6, h: 4 })
    Object.assign(server.dashboard.spec.filters[0]!, { op: 'in', control: { type: 'select' }, default: [100], optionsFrom: 'w2', targets: [{ item: 'w1', field: 'id' }, { item: 'w2', field: 'id' }] })
    openEditor()
    const optionRequests = () => server.requests.filter(({ path }) => path === '/dashboards/preview/filters/{filterId}/options')
    await waitFor(() => expect(optionRequests().at(-1)?.body.selections).toEqual({}))
    await chooseOption('Source metric', 'Total discount')
    await waitFor(() => expect(optionRequests().at(-1)?.body).toMatchObject({ selections: { metric: 'discount' }, filters: {}, chartFilters: {} }))
    expect(optionRequests().at(-1)?.params).toEqual({ filterId: 'amount_global' })
    expect(saveButton().disabled).toBe(true)
    expect(saves()).toHaveLength(0)
  })

  it('reverse matches a three-level global cascade with cleared ancestors and siblings', async () => {
    Object.assign(server.dashboard.spec, { filters: [
      { id: 'country', label: 'Country', op: 'in', control: { type: 'tiles' }, default: ['China'], targets: [{ item: 'w1', field: 'country' }] },
      { id: 'province', label: 'Province', op: 'in', control: { type: 'tiles' }, default: ['Beijing'], dependsOn: ['country'], targets: [{ item: 'w1', field: 'province' }] },
      { id: 'city', label: 'City', op: 'in', control: { type: 'tiles' }, default: ['Beijing'], dependsOn: ['province'], targets: [{ item: 'w1', field: 'city' }] },
      { id: 'store', label: 'Store', op: 'in', control: { type: 'tiles' }, default: ['Shop A'], dependsOn: ['province'], targets: [{ item: 'w1', field: 'store' }] },
    ] })
    server.behavior.options = ({ params, body }) => ({ values: params?.filterId === 'city' ? ['Tokyo'] : body.related ? params?.filterId === 'province' ? ['Tokyo Prefecture'] : params?.filterId === 'country' ? ['Japan'] : [] : [], truncated: false })
    openEditor()
    const city = within(await screen.findByRole('group', { name: 'City' }))
    fireEvent.click(await city.findByRole('button', { name: 'Tokyo' }))
    await waitFor(() => expect(previewQueries().at(-1)?.body.filters).toEqual({ country: ['Japan'], province: ['Tokyo Prefecture'], city: ['Tokyo'], store: null }))
    const related = server.requests.filter(({ path, body }) => path === '/dashboards/preview/filters/{filterId}/options' && body.related)
    expect(related.map(({ params }) => params?.filterId)).toEqual(['province', 'country'])
    expect(related[0]?.body.filters).toEqual({ country: null, province: null, city: ['Tokyo'], store: null })
    // Every ancestor is matched against the selected child alone, in one round.
    expect(related[1]?.body.filters).toEqual({ country: null, province: null, city: ['Tokyo'], store: null })
    expect(within(screen.getByRole('group', { name: 'Country' })).getByRole('button', { name: 'Japan' }).getAttribute('aria-pressed')).toBe('true')
    expect(within(screen.getByRole('group', { name: 'Store' })).getByRole('button', { name: 'Any' }).classList.contains('selected')).toBe(true)
    expect(saveButton().disabled).toBe(true)
    expect(server.dashboard.spec.filters[0]!.default).toEqual(['China'])
  })

  it.each(['editor', 'viewer'] as const)('loads chart options in the %s with the same dashboard and dynamic context as chart data', async (mode) => {
    addMetricSelector()
    Object.assign(server.dashboard.charts[0]!.spec.filters[1]!, { op: 'in', value: ['Alice'], control: { type: 'select' } })
    server.behavior.options = () => ({ values: ['Alice', 'Bob'], truncated: false })
    if (mode === 'editor') openEditor()
    else openViewer()
    const endpoint = mode === 'editor' ? '/dashboards/preview/items/{itemId}/filters/{filterId}/options' : '/dashboards/{id}/items/{itemId}/filters/{filterId}/options'
    const options = () => server.requests.filter(({ path }) => path === endpoint)
    await waitFor(() => expect(options().at(-1)?.body).toMatchObject({ filters: {}, chartFilters: {}, selections: {}, useChartFilters: false, search: '', related: false }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Global amount' }), { target: { value: '200' } })
    await waitFor(() => expect(options().at(-1)?.body.filters).toEqual({ amount_global: 200 }))
    await chooseOption('Metric', 'Total discount')
    await waitFor(() => expect(options().at(-1)?.body.selections).toEqual({ metric: 'discount' }))
    const loaded = options().length
    await chooseOption('Chart name', 'Bob')
    const data = mode === 'editor' ? '/dashboards/preview/items/{itemId}/data' : '/dashboards/{id}/items/{itemId}/data'
    await waitFor(() => expect(server.requests.filter(({ path }) => path === data).at(-1)?.body.chartFilters).toEqual({ name_local: ['Bob'] }))
    // A filter's own choice does not narrow its list, so choosing it does not reload it.
    expect(options()).toHaveLength(loaded)
    expect(options().at(-1)?.body).toMatchObject({ filters: { amount_global: 200 }, selections: { metric: 'discount' } })
    expect(options().at(-1)?.params).toEqual({ ...(mode === 'viewer' ? { id: 'board' } : {}), itemId: 'w1', filterId: 'name_local' })
    expect(server.requests.some(({ path }) => path === '/charts/{id}/filters/{filterId}/options')).toBe(false)
    if (mode === 'editor') {
      expect(options().at(-1)?.body).toMatchObject({ spec: server.dashboard.spec })
      expect(saveButton().disabled).toBe(true)
    }
    expect(saves()).toHaveLength(0)
  })
})


describe('chart data exports', () => {
  const exportsOf = () => server.requests.filter(({ path }) => path === '/dashboards/{id}/items/{itemId}/exports')

  it('offers no export where the chart does not allow it, whatever the role', async () => {
    server.behavior.role = 'admin'
    openViewer()
    const chart = within(await screen.findByRole('article', { name: 'Orders' }))
    fireEvent.click(chart.getByRole('button', { name: 'More chart actions: Orders' }))
    expect(chart.getByRole('button', { name: 'Refresh chart: Orders' })).toBeTruthy()
    expect(chart.queryByRole('button', { name: 'Export data: Orders' })).toBeNull()
  })

  it('exports a viewed widget with the values in view and the column names shown', async () => {
    Object.assign(server.dashboard.charts[0]!.spec, { allowExport: true })
    openViewer()
    await screen.findByText('Chart result')
    await chartAction('Export data: Orders')
    const dialog = await screen.findByRole('dialog', { name: 'Export chart data' })
    expect((within(dialog).getByRole('textbox', { name: 'File name' }) as HTMLInputElement).value).toBe('Board - Orders')
    const start = within(dialog).getByRole('button', { name: 'Start export' })
    await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false))
    fireEvent.click(start)
    await waitFor(() => expect(exportsOf()).toHaveLength(1))
    expect(exportsOf()[0]).toMatchObject({ params: { id: 'board', itemId: 'w1' }, body: { format: 'xlsx', name: 'Board - Orders', useChartFilters: false, filters: {}, headers: { amount: 'amount' } } })
  })

  it('exports from the editor while the draft is saved, and waits for a save once it is not', async () => {
    Object.assign(server.dashboard.charts[0]!.spec, { allowExport: true })
    openEditor()
    await screen.findByText('Chart result')
    await chartAction('Configure chart: Orders')
    expect(await screen.findByText('Data exports allowed')).toBeTruthy()
    await chartAction('Export data: Orders')
    const dialog = await screen.findByRole('dialog', { name: 'Export chart data' })
    expect((within(dialog).getByRole('textbox', { name: 'File name' }) as HTMLInputElement).value).toBe('Board - Orders')
    const start = within(dialog).getByRole('button', { name: 'Start export' })
    await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false))
    fireEvent.click(start)
    await waitFor(() => expect(exportsOf()).toHaveLength(1))
    expect(exportsOf()[0]).toMatchObject({ params: { id: 'board', itemId: 'w1' } })

    // An export runs the saved dashboard, so a changed draft must be saved first, in preview too.
    await rename('Renamed')
    const waiting = async () => {
      const chart = within(await screen.findByRole('article', { name: 'Orders' }))
      const more = chart.getByRole('button', { name: 'More chart actions: Orders' })
      if (more.getAttribute('aria-expanded') !== 'true') fireEvent.click(more)
      expect(chart.queryByRole('button', { name: 'Export data: Orders' })).toBeNull()
      expect(chart.getByRole<HTMLButtonElement>('button', { name: 'Save the dashboard to export: Orders' }).disabled).toBe(true)
    }
    await waiting()
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    await waiting()
  })

  it('tells authors when a chart’s data cannot be exported', async () => {
    openEditor()
    await chartAction('Configure chart: Orders')
    expect(await screen.findByText('Data exports not allowed')).toBeTruthy()
  })
})

describe('dashboard filter ownership', () => {
  it('uses the saved chart control style in the dashboard viewer', async () => {
    Object.assign(server.dashboard.charts[0]!.spec, { filterStyle: { layout: 'vertical', density: 'comfortable' } })
    openViewer()
    const control = await screen.findByRole('textbox', { name: 'Chart name' })
    const bar = control.closest('.chart-filter-bar')!
    expect(bar.getAttribute('data-layout')).toBe('vertical')
    expect(bar.getAttribute('data-density')).toBe('comfortable')
    expect(screen.queryByRole('button', { name: 'Chart control style' })).toBeNull()
  })
  it('lets authors select charts before explicitly mapping date fields across datasets', async () => {
    const other = structuredClone(server.dashboard.charts[0]!)
    other.id = 'shipments_chart'
    other.name = 'Shipments'
    other.datasetId = 'shipments'
    server.dashboard.charts.push(other)
    server.dashboard.spec.layout.items.push({ id: 'w2', type: 'chart', chartId: other.id, x: 6, y: 0, w: 6, h: 4 })
    openEditor()
    await openFilters()
    fireEvent.click(await screen.findByRole('button', { name: 'Add global filter' }))
    const dialog = within(screen.getByRole('dialog'))
    fireEvent.click(dialog.getByRole('checkbox', { name: 'Orders' }))
    expect(dialog.getByText('Choose a mapped field for every selected chart.')).toBeTruthy()
    expect(dialog.getByRole<HTMLButtonElement>('button', { name: 'OK' }).disabled).toBe(true)
    // The integer ID is the first dataset field, but checking a chart must not choose it or lock the field type.
    await chooseMapping('Orders', 'Created · Dataset row field')
    fireEvent.click(dialog.getByRole('checkbox', { name: 'Shipments' }))
    expect(dialog.getByRole<HTMLButtonElement>('button', { name: 'OK' }).disabled).toBe(true)
    await chooseMapping('Shipments', 'Sent · Dataset row field')
    fireEvent.click(dialog.getByRole('button', { name: 'OK' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }))
    await waitFor(() => {
      const saved = saves().at(-1)?.body.spec as { filters: { op: string; targets: unknown[] }[] } | undefined
      expect(saved?.filters.at(-1)).toMatchObject({ op: 'time', targets: [{ item: 'w1', field: 'created' }, { item: 'w2', field: 'sent' }] })
    })
  })

  it('resets the condition and default when replacing the only mapped field, even with the same field type', async () => {
    openEditor()
    await openFilters()
    await screen.findByRole('button', { name: 'Add global filter' })
    if (!screen.queryByRole('dialog', { name: 'Global filters' })) await openFilters()
    await chooseMapping('Orders', 'Discount · Dataset row field')
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'OK' }))
    await waitFor(() => {
      const preview = previewQueries().at(-1)?.body.spec as { filters: { targets: unknown[] }[] } | undefined
      expect(preview?.filters[0]?.targets).toEqual([{ item: 'w1', field: 'discount' }])
    })
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Chart amount' }).disabled).toBe(false)
    expect(saves()).toHaveLength(0)
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }))
    await waitFor(() => {
      const saved = saves().at(-1)?.body.spec as { filters: { op: string; targets: unknown[]; default?: unknown }[] } | undefined
      expect(saved?.filters[0]).toMatchObject({ op: 'between', targets: [{ item: 'w1', field: 'discount' }] })
      expect(saved?.filters[0]?.default).toBeUndefined()
    })
  })

  it('edits and deletes one mapping independently after multiple rows select the same field', async () => {
    server.dashboard.spec.filters[0]!.targets.push({ item: 'w1', field: 'discount' })
    openEditor()
    await openFilters()
    await screen.findByRole('button', { name: 'Add global filter' })
    if (!screen.queryByRole('dialog', { name: 'Global filters' })) await openFilters()
    // The dialog lists the charts once their datasets are loaded.
    await screen.findByRole('combobox', { name: 'Mapped field for Orders (1)' })
    await chooseMapping('Orders (1)', 'Tax · Dataset row field')
    await chooseMapping('Orders (2)', 'Tax · Dataset row field')
    await chooseMapping('Orders (2)', 'Amount · Dataset row field')
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'OK' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }))
    await waitFor(() => {
      const saved = saves().at(-1)?.body.spec as { filters: { targets: unknown[] }[] } | undefined
      expect(saved?.filters[0]?.targets).toEqual([{ item: 'w1', field: 'tax' }, { item: 'w1', field: 'amount' }])
    })
    // A finished save reloads the datasets, and the dialog lists no charts until they are back, so it is reopened once the reload has started.
    await waitFor(() => expect(server.gets.filter((path) => path === '/datasets/{id}')).toHaveLength(2))
    if (!screen.queryByRole('dialog', { name: 'Global filters' })) await openFilters()
    await screen.findByRole('combobox', { name: 'Mapped field for Orders (1)' })
    await chooseMapping('Orders (1)', 'Discount · Dataset row field')
    await chooseMapping('Orders (1)', 'Tax · Dataset row field')
    await chooseMapping('Orders (2)', 'Tax · Dataset row field')
    fireEvent.click(screen.getByRole('button', { name: 'Remove mapped field 1 for Orders' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'OK' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }))
    await waitFor(() => {
      const saved = saves().at(-1)?.body.spec as { filters: { targets: unknown[] }[] } | undefined
      expect(saved?.filters[0]?.targets).toEqual([{ item: 'w1', field: 'tax' }])
    })
  })

  it('keeps overridden controls visible and restores each widget’s own values in both directions', async () => {
    const router = createMemoryRouter([{ path: '/dashboards/:id', element: <DashboardView colorScheme="light" /> }], { initialEntries: ['/dashboards/board'] })
    render(<RouterProvider router={router} />)
    const widget = within(await screen.findByRole('article', { name: 'Orders' }))
    expect(screen.queryByRole('heading', { name: 'Board', level: 1 })).toBeNull()
    const amount = widget.getByRole<HTMLInputElement>('textbox', { name: 'Chart amount' })
    const name = widget.getByRole<HTMLInputElement>('textbox', { name: 'Chart name' })
    const more = widget.getByRole('button', { name: 'More chart actions: Orders' })
    expect(amount.disabled).toBe(true)
    expect(amount.value).toBe('50')
    expect(name.disabled).toBe(false)
    await chartAction('Use chart filters')
    expect(amount.disabled).toBe(false)
    expect(document.activeElement).toBe(more)
    expect(more.getAttribute('aria-expanded')).toBe('false')
    await waitFor(() => expect(server.calls.at(-1)?.useChartFilters).toBe(true))
    fireEvent.change(amount, { target: { value: '20' } })
    await waitFor(() => expect(server.calls.at(-1)?.chartFilters).toEqual({ amount_local: 20 }))
    await chartAction('Restore global filters')
    expect(amount.disabled).toBe(true)
    expect(document.activeElement).toBe(more)
    expect(more.getAttribute('aria-expanded')).toBe('false')
    expect(amount.value).toBe('20')
    await waitFor(() => expect(server.calls.at(-1)?.useChartFilters).toBe(false))
    await chartAction('Use chart filters')
    expect(amount.value).toBe('20')
    expect(amount.disabled).toBe(false)
  })

  it.each(['standalone', 'inline preview'])('only exposes reader actions in the %s view', async (mode) => {
    if (mode === 'standalone') {
      const router = createMemoryRouter([{ path: '/dashboards/:id', element: <DashboardView colorScheme="light" /> }], { initialEntries: ['/dashboards/board'] })
      render(<RouterProvider router={router} />)
    } else {
      openEditor()
      await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Preview' }).disabled).toBe(false))
      fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
      await screen.findByRole('region', { name: 'Preview' })
    }
    const chart = within(await screen.findByRole('article', { name: 'Orders' }))
    await chart.findByText('Chart result')
    const more = chart.getByRole('button', { name: 'More chart actions: Orders' })
    expect(more.getAttribute('aria-expanded')).toBe('false')
    expect(chart.queryByRole('button', { name: 'Refresh chart: Orders' })).toBeNull()
    fireEvent.click(more)
    expect(chart.getByRole('button', { name: 'Refresh chart: Orders' })).toBeTruthy()
    expect(chart.getByRole('button', { name: 'Use chart filters' })).toBeTruthy()
    expect(chart.queryByRole('button', { name: 'Configure chart: Orders' })).toBeNull()
    expect(chart.queryByRole('button', { name: 'Remove chart: Orders' })).toBeNull()
    const queryCount = () => server.requests.filter(({ path }) => path.endsWith('/data')).length
    const initialCount = queryCount()
    await chartAction('Refresh chart: Orders')
    await waitFor(() => expect(queryCount()).toBeGreaterThan(initialCount))
    await chartAction('Use chart filters')
    expect(chart.getByRole<HTMLInputElement>('textbox', { name: 'Chart amount' }).disabled).toBe(false)
    expect(saves()).toHaveLength(0)
  })
})

describe('dashboard editor', () => {
  it.each([false, true])('refreshes same-ID dataset fields after conflict resolution and retains the draft (retry: %s)', async (retry) => {
    server.behavior.role = 'developer'
    openEditor()
    await rename('My board')
    await waitFor(() => expect(server.gets.filter((path) => path === '/datasets/{id}')).toHaveLength(1))
    await screen.findByText('Chart result')
    const before = server.datasets.orders as { spec: { fields: unknown[] } }
    server.datasets.orders = { ...before, spec: { ...before.spec, fields: [...before.spec.fields, { key: 'region', column: 'region', label: 'Sales region', type: 'string', role: 'dimension' }] } }
    const latest = { ...structuredClone(server.dashboard), revision: 2, name: 'Remote board', spec: { ...structuredClone(server.dashboard.spec),
      filters: [{ id: 'region_global', label: 'Global region', op: 'in', control: { type: 'select', multi: true }, default: ['East'], targets: [{ item: 'w1', field: 'region' }] }],
    } }
    server.saved.set('board', latest)
    server.behavior.saveRevision = 2
    let finish!: () => void
    let fail!: (error: Error) => void
    server.behavior.datasetReloadPending = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject })
    fireEvent.click(saveButton())
    const conflict = within(await screen.findByRole('dialog', { name: 'Resolve save conflict' }))
    const name = within(await conflict.findByRole('group', { name: 'Name' }))
    fireEvent.click(name.getByRole('radio', { name: 'Use my changes' }))
    fireEvent.click(conflict.getByRole('button', { name: 'Apply to draft' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(server.gets.filter((path) => path === '/datasets/{id}')).toHaveLength(2))
    await openFilters()
    const filters = within(await screen.findByRole('dialog', { name: 'Global filters' }))
    const confirm = () => filters.getByRole<HTMLButtonElement>('button', { name: i18n.t('common.confirm') })
    expect(confirm().disabled).toBe(true)
    if (retry) {
      await act(async () => { fail(new Error('Dataset refresh failed')) })
      const retryButton = await filters.findByRole('button', { name: i18n.t('common.retry') })
      expect(confirm().disabled).toBe(true)
      server.behavior.datasetReloadPending = undefined
      fireEvent.click(retryButton)
    } else await act(async () => { finish() })
    await waitFor(() => expect(confirm().disabled).toBe(false))
    expect(filters.getByRole('combobox', { name: 'Mapped field for Orders' }).textContent).toContain('Sales region')
    expect(saves()).toHaveLength(1)
    fireEvent.click(confirm())
    fireEvent.click(saveButton())
    await waitFor(() => expect(saves()).toHaveLength(2))
    expect(saves()[1]!.body).toMatchObject({ name: 'My board', expectedRevision: 2, spec: { filters: latest.spec.filters } })
  })

  it('keeps the latest layout while resolving a conflicting name, then saves with its revision', async () => {
    server.behavior.role = 'developer'
    openEditor()
    await rename('My board')
    const latest = structuredClone(server.dashboard)
    latest.revision = 2
    latest.name = 'Remote board'
    latest.spec.layout.items[0]!.x = 15
    server.saved.set('board', latest)
    server.behavior.saveRevision = 2
    fireEvent.click(saveButton())
    const dialog = within(await screen.findByRole('dialog', { name: 'Resolve save conflict' }))
    const name = within(await dialog.findByRole('group', { name: 'Name' }))
    fireEvent.click(name.getByRole('radio', { name: 'Use my changes' }))
    fireEvent.click(dialog.getByRole('button', { name: 'Apply to draft' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(saves()).toHaveLength(1)
    expect(screen.getByTitle('My board')).toBeTruthy()
    expect(server.grid.items.find((item) => (item as { id: string }).id === 'w1')).toMatchObject({ id: 'w1', x: 15 })
    // The pre-merge draft predates revision 2; undoing into it would let the
    // next save overwrite the remote layout without another conflict.
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Undo' }).disabled).toBe(true)
    fireEvent.keyDown(document, { key: 'z', metaKey: true })
    expect(screen.getByTitle('My board')).toBeTruthy()
    fireEvent.click(saveButton())
    await waitFor(() => expect(saves()).toHaveLength(2))
    expect(saves().map(({ body }) => body.expectedRevision)).toEqual([1, 2])
    expect(saves()[1]!.body).toMatchObject({ name: 'My board', spec: { layout: { items: [{ id: 'w1', x: 15 }] } } })
  })
  it('hides chart actions behind the more button and closes them by toggle, Escape, or an outside click', async () => {
    openEditor()
    const article = await screen.findByRole('article', { name: 'Orders' })
    const chart = within(article)
    await chart.findByText('Chart result')
    const more = chart.getByRole('button', { name: 'More chart actions: Orders' })
    expect(more.getAttribute('aria-expanded')).toBe('false')
    expect(chart.getAllByRole('button')).toEqual([more])
    const actions = ['Configure chart: Orders', 'Remove chart: Orders', 'Refresh chart: Orders', 'Use chart filters']
    for (const action of actions) expect(chart.queryByRole('button', { name: action })).toBeNull()

    fireEvent.click(more)
    expect(more.getAttribute('aria-expanded')).toBe('true')
    for (const action of actions) expect(chart.getByRole('button', { name: action })).toBeTruthy()
    fireEvent.click(more)
    expect(more.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(more)
    fireEvent.keyDown(more, { key: 'Escape' })
    expect(more.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(more)
    fireEvent.pointerDown(screen.getByRole('main', { name: 'Canvas' }).querySelector('.dashboard-canvas')!)
    expect(more.getAttribute('aria-expanded')).toBe('false')
    expect(chart.queryByRole('button', { name: 'Configure chart: Orders' })).toBeNull()

    const queries = previewQueries().length
    await chartAction('Refresh chart: Orders')
    await waitFor(() => expect(previewQueries().length).toBeGreaterThan(queries))
    expect(document.activeElement).toBe(more)
    expect(more.getAttribute('aria-expanded')).toBe('false')
    expect(saveButton().disabled).toBe(true)
    expect(saves()).toHaveLength(0)
  })

  it.each(['chart actions', 'component properties'])('confirms component removal from %s and preserves mappings on cancel and undo', async (entry) => {
    openEditor()
    const article = await screen.findByRole('article', { name: 'Orders' })
    const save = saveButton()
    const requestRemoval = async () => {
      if (entry === 'chart actions') await chartAction('Remove chart: Orders')
      else {
        await chartAction('Configure chart: Orders')
        fireEvent.click(within(screen.getByRole('complementary', { name: 'Component properties' })).getByRole('button', { name: 'Remove component' }))
      }
    }
    await requestRemoval()
    const dialog = await screen.findByRole('dialog', { name: 'Remove component' })
    expect(dialog.textContent).toContain('Orders')
    expect(dialog.textContent).toMatch(/source chart/i)
    expect(article.isConnected).toBe(true)
    expect(save.disabled).toBe(true)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    if (entry === 'chart actions') {
      const more = within(article).getByRole('button', { name: 'More chart actions: Orders' })
      await waitFor(() => expect(document.activeElement).toBe(more))
      expect(more.getAttribute('aria-expanded')).toBe('false')
    }
    expect(screen.getByRole('article', { name: 'Orders' })).toBeTruthy()
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Chart amount' }).disabled).toBe(true)
    expect(saveButton().disabled).toBe(true)

    await requestRemoval()
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Remove component' })).getByRole('button', { name: 'Remove component' }))
    expect(screen.queryByRole('article', { name: 'Orders' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: 'Global amount' })).toBeNull()
    expect(saveButton().disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(await screen.findByRole('article', { name: 'Orders' })).toBeTruthy()
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Global amount' }).value).toBe('100')
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Chart amount' }).disabled).toBe(true)
    expect(saveButton().disabled).toBe(true)
    expect(server.dashboard.charts).toEqual(server.initial.charts)
    expect(saves()).toHaveLength(0)
  })

  it('has no components tool or clickable component count in page settings', async () => {
    openEditor()
    await screen.findByRole('main', { name: 'Canvas' })
    expect(screen.queryByRole('button', { name: 'Components' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Page settings' }))
    const settings = within(screen.getByRole('complementary', { name: 'Page settings' }))
    expect(settings.getByText('1 charts')).toBeTruthy()
    expect(settings.queryByRole('button', { name: '1 charts' })).toBeNull()
    expect(settings.queryByText('1 global filters')).toBeNull()
    expect(screen.queryByRole('complementary', { name: 'Components' })).toBeNull()
  })

  it('shows the dashboard title only in the toolbar in both edit and inline preview modes', async () => {
    openEditor()
    const canvas = await screen.findByRole('main', { name: 'Canvas' })
    expect(screen.getByTitle('Board')).toBeTruthy()
    expect(screen.getAllByText('Board')).toHaveLength(1)
    expect(within(canvas).queryByText('Board')).toBeNull()
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Preview' }).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    const preview = await screen.findByRole('region', { name: 'Preview' })
    expect(screen.getAllByText('Board')).toHaveLength(1)
    expect(within(preview).queryByText('Board')).toBeNull()
    expect(saves()).toHaveLength(0)
  })

  it('uses live draft filters while editing, keeps viewing values across preview, and saves only filter definitions', async () => {
    openEditor()
    const canvas = within(await screen.findByRole('main', { name: 'Canvas' }))
    const global = canvas.getByRole<HTMLInputElement>('textbox', { name: 'Global amount' })
    const widget = within(await canvas.findByRole('article', { name: 'Orders' }))
    const amount = widget.getByRole<HTMLInputElement>('textbox', { name: 'Chart amount' })
    const name = widget.getByRole<HTMLInputElement>('textbox', { name: 'Chart name' })
    expect(global.value).toBe('100')
    expect(amount.disabled).toBe(true)
    expect(amount.value).toBe('50')
    expect(name.value).toBe('Alice')
    expect(name.disabled).toBe(false)
    await waitFor(() => expect(previewQueries().at(-1)?.body).toMatchObject({ spec: server.initial.spec }))
    expect(server.requests.some(({ path }) => path === '/charts/{id}/data')).toBe(false)

    fireEvent.change(global, { target: { value: '200' } })
    fireEvent.change(name, { target: { value: 'Bob' } })
    await waitFor(() => expect(previewQueries().at(-1)?.body).toMatchObject({ filters: { amount_global: 200 }, chartFilters: { name_local: 'Bob' }, useChartFilters: false }))
    await chartAction('Use chart filters')
    fireEvent.change(amount, { target: { value: '20' } })
    await waitFor(() => expect(previewQueries().at(-1)?.body).toMatchObject({ useChartFilters: true, chartFilters: { amount_local: 20, name_local: 'Bob' } }))
    expect(amount.disabled).toBe(false)
    expect(saveButton().disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Undo' }).disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    const preview = within(await screen.findByRole('region', { name: 'Preview' }))
    expect(preview.getByRole<HTMLInputElement>('textbox', { name: 'Global amount' }).value).toBe('200')
    expect(preview.getByRole<HTMLInputElement>('textbox', { name: 'Chart amount' }).value).toBe('20')
    expect(preview.getByRole<HTMLInputElement>('textbox', { name: 'Chart amount' }).disabled).toBe(false)
    expect(preview.getByRole<HTMLInputElement>('textbox', { name: 'Chart name' }).value).toBe('Bob')
    await chartAction('Restore global filters')
    fireEvent.change(preview.getByRole('textbox', { name: 'Global amount' }), { target: { value: '' } })
    await waitFor(() => expect(previewQueries().at(-1)?.body).toMatchObject({ filters: { amount_global: null }, useChartFilters: false }))
    fireEvent.click(screen.getByRole('button', { name: 'Exit preview' }))
    const edited = within(screen.getByRole('main', { name: 'Canvas' }))
    expect(edited.getByRole<HTMLInputElement>('textbox', { name: 'Global amount' }).value).toBe('')
    expect(edited.getByRole<HTMLInputElement>('textbox', { name: 'Chart amount' }).value).toBe('20')
    expect(edited.getByRole<HTMLInputElement>('textbox', { name: 'Chart amount' }).disabled).toBe(true)
    expect(edited.getByRole<HTMLInputElement>('textbox', { name: 'Chart name' }).value).toBe('Bob')
    expect(saveButton().disabled).toBe(true)
    expect(saves()).toHaveLength(0)

    await rename('Renamed board')
    fireEvent.click(saveButton())
    await waitFor(() => expect(saveButton().disabled).toBe(true))
    expect(saves().at(-1)?.body).toMatchObject({ name: 'Renamed board', spec: server.initial.spec })
    expect(saves().at(-1)?.body).not.toHaveProperty('chartFilters')
    expect(server.dashboard.charts[0]?.spec.filters.map((filter) => filter.value)).toEqual([50, 'Alice'])
  })

  it.each([['Global amount', '200'], ['Chart name', 'Bob']])('keeps pending input in %s when preview opens before the debounce fires', async (label, value) => {
    openEditor()
    const input = await screen.findByRole('textbox', { name: label })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value } })
    fireEvent.blur(input)
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    const preview = within(await screen.findByRole('region', { name: 'Preview' }))
    expect(preview.getByRole<HTMLInputElement>('textbox', { name: label }).value).toBe(value)
    await waitFor(() => expect(previewQueries().at(-1)?.body).toMatchObject(label === 'Global amount'
      ? { filters: { amount_global: 200 } }
      : { chartFilters: { name_local: 'Bob' } }))
    fireEvent.click(screen.getByRole('button', { name: 'Exit preview' }))
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: label }).value).toBe(value)
    expect(saveButton().disabled).toBe(true)
    expect(saves()).toHaveLength(0)
  })

  it('keeps an existing chart’s viewing choices while adding another chart to a new dashboard', async () => {
    const second = structuredClone(server.dashboard.charts[0]!)
    second.id = 'sales_chart'
    second.name = 'Sales'
    server.dashboard.charts.push(second)
    openEditor('/workbench/dashboards/new')
    await rename('New board')
    fireEvent.click(await screen.findByRole('button', { name: 'Add chart Orders' }))
    const first = within(await screen.findByRole('article', { name: 'Orders' }))
    fireEvent.change(first.getByRole('textbox', { name: 'Chart name' }), { target: { value: 'Bob' } })
    await waitFor(() => expect(previewQueries().at(-1)?.body.chartFilters).toEqual({ name_local: 'Bob' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add chart Sales' }))
    await screen.findByRole('article', { name: 'Sales' })
    expect(within(screen.getByRole('article', { name: 'Orders' })).getByRole<HTMLInputElement>('textbox', { name: 'Chart name' }).value).toBe('Bob')
    expect(within(screen.getByRole('article', { name: 'Sales' })).getByRole<HTMLInputElement>('textbox', { name: 'Chart name' }).value).toBe('Alice')
    expect(saves()).toHaveLength(0)
  })

  it('clears temporary values when a global definition changes or is removed', async () => {
    openEditor()
    const global = await screen.findByRole('textbox', { name: 'Global amount' })
    fireEvent.change(global, { target: { value: '200' } })
    await waitFor(() => expect(previewQueries().at(-1)?.body.filters).toEqual({ amount_global: 200 }))
    await openFilters()
    await screen.findByRole('combobox', { name: 'Mapped field for Orders' })
    if (!screen.queryByRole('dialog', { name: 'Global filters' })) await openFilters()
    const dialog = within(screen.getByRole('dialog'))
    fireEvent.change(dialog.getByRole('textbox', { name: 'Default value' }), { target: { value: '350' } })
    // Number controls commit once typing pauses.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)) })
    fireEvent.click(dialog.getByRole('button', { name: 'OK' }))
    await waitFor(() => {
      expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Global amount' }).value).toBe('350')
      expect(previewQueries().at(-1)?.body.filters).toEqual({})
      expect(previewQueries().at(-1)?.body.spec).toMatchObject({ filters: [{ id: 'amount_global', default: 350 }] })
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Global amount' }), { target: { value: '400' } })
    await waitFor(() => expect(previewQueries().at(-1)?.body.filters).toEqual({ amount_global: 400 }))
    await openFilters()
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter: Global amount' }))
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    await waitFor(() => {
      expect(screen.queryByRole('textbox', { name: 'Global amount' })).toBeNull()
      expect(previewQueries().at(-1)?.body.filters).toEqual({})
      expect(previewQueries().at(-1)?.body.spec).not.toHaveProperty('filters')
    })
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Chart amount' }).disabled).toBe(false)
    expect(saves()).toHaveLength(0)
  })

  it('keeps global select options tied to the unsaved draft when switching into preview', async () => {
    Object.assign(server.dashboard.spec.filters[0]!, { op: 'in', control: { type: 'select' }, default: [100] })
    openEditor()
    await screen.findByRole('combobox', { name: 'Global amount' })
    const optionRequests = () => server.requests.filter(({ path }) => path === '/dashboards/preview/filters/{filterId}/options')
    const expected = { spec: server.dashboard.spec, links: {}, filters: {}, chartFilters: {}, selections: {}, search: '', related: false }
    await waitFor(() => expect(optionRequests().at(-1)?.body).toEqual(expected))
    expect(server.gets).not.toContain('/dashboards/{id}/filters/{filterId}/options')
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    const preview = within(await screen.findByRole('region', { name: 'Preview' }))
    expect(preview.getByRole('combobox', { name: 'Global amount' })).toBeTruthy()
    expect(optionRequests().at(-1)?.body).toEqual(expected)
    expect(saveButton().disabled).toBe(true)
    expect(saves()).toHaveLength(0)
  })

  it('keeps panel navigation clean and saves a selected chart’s resized layout', async () => {
    openEditor()
    await openFilters()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Charts' }))
    expect(screen.queryByRole('button', { name: 'Components' })).toBeNull()
    await chartAction('Configure chart: Orders')
    expect(saveButton().disabled).toBe(true)
    await chooseOption('Width', '64 columns')
    expect(saveButton().disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      const saved = saves().at(-1)?.body.spec as { layout: { items: unknown[] }; filters: unknown[] } | undefined
      expect(saved?.layout.items).toEqual([{ id: 'w1', type: 'chart', chartId: 'chart', x: 0, y: 0, w: 64, h: 4 }])
      expect(saved?.filters).toEqual(server.initial.spec.filters)
      expect(saveButton().disabled).toBe(true)
    })
  })

  it('selects chart content without opening properties, and turns an open page settings panel to the chart', async () => {
    openEditor()
    const article = await screen.findByRole('article', { name: 'Orders' })
    const chart = within(article)
    const title = chart.getByRole('heading', { name: 'Orders' })
    const result = await chart.findByText('Chart result')
    const background = screen.getByRole('main', { name: 'Canvas' }).querySelector<HTMLElement>('.dashboard-canvas')!

    for (const target of [article, title, result]) {
      fireEvent.pointerDown(background)
      fireEvent.click(target)
      expect(article.classList.contains('selected')).toBe(true)
      expect(screen.queryByRole('complementary')).toBeNull()
    }

    fireEvent.click(screen.getByRole('button', { name: 'Page settings' }))
    // Filter controls stay interactive and leave the current inspector alone.
    const name = chart.getByRole('textbox', { name: 'Chart name' })
    fireEvent.click(name)
    fireEvent.change(name, { target: { value: 'Bob' } })
    await waitFor(() => expect(previewQueries().at(-1)?.body.chartFilters).toEqual({ name_local: 'Bob' }))
    expect(chart.getByRole<HTMLInputElement>('textbox', { name: 'Chart amount' }).disabled).toBe(true)
    expect(screen.getByRole('complementary', { name: 'Page settings' })).toBeTruthy()
    expect(saveButton().disabled).toBe(true)
    // The chart itself, clicked, turns the open inspector to it.
    for (const target of [article, title, result]) {
      if (!screen.queryByRole('complementary', { name: 'Page settings' })) fireEvent.click(screen.getByRole('button', { name: 'Page settings' }))
      fireEvent.click(target)
      expect(screen.getByRole('complementary', { name: 'Component properties' })).toBeTruthy()
      expect(screen.queryByRole('complementary', { name: 'Page settings' })).toBeNull()
    }
    expect(saveButton().disabled).toBe(true)

    await chartAction('Configure chart: Orders')
    expect(screen.getByRole('complementary', { name: 'Component properties' })).toBeTruthy()
    expect(screen.queryByRole('complementary', { name: 'Page settings' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Components' })).toBeNull()
    expect(screen.getByRole('complementary', { name: 'Component properties' })).toBeTruthy()
    expect(saves()).toHaveLength(0)
  })

  it('removes a deleted component’s mappings before the chart is added again with a reused id', async () => {
    openEditor()
    await removeChart()
    expect(screen.queryByRole('article', { name: 'Orders' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Charts' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add chart Orders' }))
    await chartAction('Configure chart: Orders')
    expect(screen.getByText('This chart has no global filters.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      const saved = saves().at(-1)?.body.spec as { layout: { items: unknown[] }; filters?: unknown[] } | undefined
      expect(saved?.layout.items).toEqual(server.initial.spec.layout.items.map((item) => ({ ...item, w: 48, h: 32 })))
      expect(saved?.filters).toBeUndefined()
    })
  })

  it('commits renames on Enter or blur, cancels on Escape, and makes each rename one undo step', async () => {
    openEditor()
    await screen.findByRole('button', { name: 'Rename dashboard' })
    expect(screen.queryByRole('textbox', { name: 'Dashboard name' })).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    expect(saveButton().disabled).toBe(true)
    await rename('  Updated board  ')
    expect(screen.getByTitle('Updated board')).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'Dashboard name' })).toBeNull()
    expect(saveButton().disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(screen.getByTitle('Board')).toBeTruthy()
    expect(saveButton().disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }))
    expect(screen.getByTitle('Updated board')).toBeTruthy()
    await rename('Discard this name', 'Escape')
    expect(screen.getByTitle('Updated board')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Rename dashboard' }))
    const input = screen.getByRole('textbox', { name: 'Dashboard name' })
    fireEvent.change(input, { target: { value: 'Blurred name' } })
    fireEvent.blur(input)
    expect(screen.getByTitle('Blurred name')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(screen.getByTitle('Updated board')).toBeTruthy()
  })

  it('supports editor undo and redo shortcuts while leaving focused text fields to native undo', async () => {
    openEditor()
    await rename('Updated board')
    fireEvent.keyDown(document, { key: 'z', ctrlKey: true })
    expect(screen.getByTitle('Board')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'z', metaKey: true, shiftKey: true })
    expect(screen.getByTitle('Updated board')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Page settings' }))
    const input = screen.getByRole('textbox', { name: 'Name' })
    const shortcut = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })
    fireEvent(input, shortcut)
    expect(shortcut.defaultPrevented).toBe(false)
    expect(screen.getByTitle('Updated board')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'z', metaKey: true })
    fireEvent.keyDown(document, { key: 'y', ctrlKey: true })
    expect(screen.getByTitle('Updated board')).toBeTruthy()
  })

  it('undoes component deletion and its global filter mappings together', async () => {
    openEditor()
    await removeChart()
    expect(screen.queryByRole('article', { name: 'Orders' })).toBeNull()
    await openFilters()
    expect(screen.queryByText('Global amount')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(await screen.findByRole('article', { name: 'Orders' })).toBeTruthy()
    await openFilters()
    expect(within(screen.getByRole('dialog', { name: 'Global filters' })).getByText('Global amount')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(saveButton().disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }))
    expect(screen.queryByRole('article', { name: 'Orders' })).toBeNull()
    expect(screen.queryByText('Global amount')).toBeNull()
    expect(saveButton().disabled).toBe(false)
  })

  it('uses a successful save as the clean checkpoint without losing undo history', async () => {
    let finishSave!: () => void
    server.behavior.savePending = new Promise<void>((resolve) => { finishSave = resolve })
    const router = openEditor()
    await rename('Updated board')
    fireEvent.click(saveButton())
    await waitFor(() => expect(saves().at(-1)?.body.name).toBe('Updated board'))
    expect(router.state.location.pathname).toBe('/workbench/dashboards/board')
    expect(screen.getByRole('main', { name: 'Canvas' }).closest('[inert]')).not.toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Rename dashboard' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Page settings' }).disabled).toBe(true)
    await act(async () => { finishSave() })
    await waitFor(() => expect(saveButton().disabled).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(screen.getByTitle('Board')).toBeTruthy()
    expect(saveButton().disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }))
    expect(screen.getByTitle('Updated board')).toBeTruthy()
    expect(saveButton().disabled).toBe(true)
    await rename('Another name')
    expect(saveButton().disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(saveButton().disabled).toBe(true)
  })

  it('preserves unsaved edits when saving fails', async () => {
    server.behavior.saveFailure = true
    const router = openEditor()
    await rename('Unsaved board')
    fireEvent.click(saveButton())
    expect(await screen.findByText('Cannot reach the server')).toBeTruthy()
    expect(router.state.location.pathname).toBe('/workbench/dashboards/board')
    expect(screen.getByTitle('Unsaved board')).toBeTruthy()
    expect(saveButton().disabled).toBe(false)
    expect(screen.getByRole('main', { name: 'Canvas' }).closest('[inert]')).toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Rename dashboard' }).disabled).toBe(false)
    expect(screen.queryByRole('heading', { name: 'Dashboard preview' })).toBeNull()
  })

  it('preserves the new dashboard’s history and clean checkpoint across its first saved URL', async () => {
    const router = openEditor('/workbench/dashboards/new')
    await rename('New board')
    fireEvent.click(await screen.findByRole('button', { name: 'Add chart Orders' }))
    await screen.findByRole('article', { name: 'Orders' })
    fireEvent.click(saveButton())
    await waitFor(() => expect(router.state.location.pathname).toBe('/workbench/dashboards/created'))
    expect(saveButton().disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(screen.queryByRole('article', { name: 'Orders' })).toBeNull()
    expect(screen.getByTitle('New board')).toBeTruthy()
    expect(saveButton().disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }))
    expect(await screen.findByRole('article', { name: 'Orders' })).toBeTruthy()
    expect(saveButton().disabled).toBe(true)
    expect(saves()).toHaveLength(1)
    expect(saves()[0]?.method).toBe('POST')
  })

  it('preserves edits made during a failed reload after the first save and can save them again', async () => {
    let failReload!: (error: Error) => void
    server.behavior.createdReloadPending = new Promise<void>((_resolve, reject) => { failReload = reject })
    const router = openEditor('/workbench/dashboards/new')
    await rename('New board')
    fireEvent.click(await screen.findByRole('button', { name: 'Add chart Orders' }))
    await screen.findByRole('article', { name: 'Orders' })
    fireEvent.click(saveButton())
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/workbench/dashboards/created')
      expect(server.gets).toContain('/dashboards/{id}')
      expect(saveButton().disabled).toBe(true)
    })

    // The post-create GET is still pending; the saved response keeps the same editor usable.
    await rename('Edited during reload')
    expect(saveButton().disabled).toBe(false)
    await act(async () => { failReload(new Error('Reload failed')) })
    expect(screen.getByTitle('Edited during reload')).toBeTruthy()
    expect(screen.getByRole('article', { name: 'Orders' })).toBeTruthy()
    expect(saveButton().disabled).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(screen.getByTitle('New board')).toBeTruthy()
    expect(saveButton().disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(screen.queryByRole('article', { name: 'Orders' })).toBeNull()
    expect(saveButton().disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }))
    expect(screen.getByTitle('Edited during reload')).toBeTruthy()
    expect(await screen.findByRole('article', { name: 'Orders' })).toBeTruthy()
    fireEvent.click(saveButton())
    await waitFor(() => expect(saveButton().disabled).toBe(true))
    expect(saves().map(({ method }) => method)).toEqual(['POST', 'PUT'])
    expect(saves().at(-1)?.body.name).toBe('Edited during reload')
    expect(router.state.location.pathname).toBe('/workbench/dashboards/created')
  })

  it.each(['board', 'new'])('previews an unsaved %s dashboard in place without saving and preserves its history', async (id) => {
    const router = openEditor(`/workbench/dashboards/${id}`)
    await rename('Draft preview')
    if (id === 'new') fireEvent.click(await screen.findByRole('button', { name: 'Add chart Orders' }))
    const editingWidget = within(await screen.findByRole('article', { name: 'Orders' }))
    expect(editingWidget.getByRole<HTMLInputElement>('textbox', { name: 'Chart amount' }).value).toBe('50')
    expect(editingWidget.getByRole<HTMLInputElement>('textbox', { name: 'Chart amount' }).disabled).toBe(id === 'board')
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Preview' }).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(await screen.findByRole('region', { name: 'Preview' })).toBeTruthy()
    expect(screen.getByTitle('Draft preview')).toBeTruthy()
    expect(screen.queryByRole('main', { name: 'Canvas' })).toBeNull()
    expect(router.state.location.pathname).toBe(`/workbench/dashboards/${id}`)
    expect(saves()).toHaveLength(0)
    await waitFor(() => expect(server.requests.some(({ path }) => path === '/dashboards/preview/items/{itemId}/data')).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'Exit preview' }))
    expect(screen.getByRole('main', { name: 'Canvas' })).toBeTruthy()
    expect(saveButton().disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    if (id === 'new') expect(screen.queryByRole('article', { name: 'Orders' })).toBeNull()
    else expect(screen.getByTitle('Board')).toBeTruthy()
    expect(saves()).toHaveLength(0)
  })

  it('applies global filters in draft preview and restores each chart’s own controls without dirtying the draft', async () => {
    openEditor()
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Preview' }).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    const preview = within(await screen.findByRole('region', { name: 'Preview' }))
    const widget = within(preview.getByRole('article', { name: 'Orders' }))
    const amount = widget.getByRole<HTMLInputElement>('textbox', { name: 'Chart amount' })
    expect(amount.disabled).toBe(true)
    expect(amount.value).toBe('50')
    fireEvent.change(preview.getByRole('textbox', { name: 'Global amount' }), { target: { value: '200' } })
    await waitFor(() => expect(server.requests.at(-1)?.body.filters).toEqual({ amount_global: 200 }))
    await chartAction('Use chart filters')
    expect(amount.disabled).toBe(false)
    fireEvent.change(amount, { target: { value: '20' } })
    await waitFor(() => expect(server.requests.at(-1)?.body).toMatchObject({ useChartFilters: true, chartFilters: { amount_local: 20 } }))
    await chartAction('Restore global filters')
    expect(amount.disabled).toBe(true)
    expect(amount.value).toBe('20')
    fireEvent.click(screen.getByRole('button', { name: 'Exit preview' }))
    expect(saveButton().disabled).toBe(true)
    expect(saves()).toHaveLength(0)
  })

  it('opens page settings only from its button and clears chart selection on canvas background clicks', async () => {
    openEditor()
    const canvas = await screen.findByRole('main', { name: 'Canvas' })
    expect(screen.queryByRole('complementary', { name: 'Page settings' })).toBeNull()
    const background = canvas.querySelector<HTMLElement>('.dashboard-canvas')!
    fireEvent.pointerDown(background)
    expect(screen.queryByRole('complementary')).toBeNull()
    await chartAction('Configure chart: Orders')
    expect(screen.getByRole('complementary', { name: 'Component properties' })).toBeTruthy()
    fireEvent.pointerDown(background)
    expect(screen.queryByRole('complementary')).toBeNull()
    expect(canvas.querySelector('.widget.selected')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Page settings' }))
    expect(screen.getByRole('complementary', { name: 'Page settings' })).toBeTruthy()
    expect(saveButton().disabled).toBe(true)
  })
})

describe('global cascade configuration validation', () => {
  function configureSources(childItems = ['w2'], dependsOn: string[] = []) {
    const other = structuredClone(server.dashboard.charts[0]!)
    other.id = 'other_chart'
    other.name = 'Other chart'
    server.dashboard.charts.push(other)
    server.dashboard.spec.layout.items.push({id: 'w2', type: 'chart', chartId: other.id, x: 6, y: 0, w: 6, h: 4})
    Object.assign(server.dashboard.spec, {filters: [
      {id: 'parent', label: 'Parent', op: 'in', control: {type: 'select'}, optionsFrom: 'w1', targets: [{item: 'w1', field: 'id'}, {item: 'w2', field: 'id'}]},
      {id: 'child', label: 'Child', op: 'in', control: {type: 'select'}, optionsFrom: 'w2', dependsOn, targets: childItems.map((item) => ({item, field: 'id'}))},
    ]})
  }

  it('disables an asymmetric cascade relationship until the reverse source mapping is added', async () => {
    configureSources()
    openEditor()
    await openFilters()
    await screen.findByRole('button', {name: 'Add global filter'})
    fireEvent.click(screen.getByRole('button', {name: 'Child'}))
    const dialog = within(screen.getByRole('dialog'))
    openPopup(dialog.getByRole('combobox', {name: 'Parent filters'}))
    const parent = await screen.findByRole('option', {name: 'Parent'})
    expect(parent.getAttribute('aria-disabled')).toBe('true')
    expect(dialog.getAllByText('Every filter in a cascade must map row fields to every chart used as an option source in that cascade.').length).toBeGreaterThan(0)
    fireEvent.click(dialog.getByRole('checkbox', {name: 'Orders'}))
    await chooseMapping('Orders', 'Order ID · Dataset row field')
    await chooseOption('Parent filters', 'Parent')
    expect(dialog.getByRole<HTMLButtonElement>('button', {name: 'OK'}).disabled).toBe(false)
    fireEvent.click(dialog.getByRole('button', {name: 'OK'}))
    fireEvent.click(saveButton())
    await waitFor(() => expect((saves().at(-1)?.body.spec as {filters: {dependsOn?: string[]}[]}).filters[1]!.dependsOn).toEqual(['parent']))
  })

  it('blocks removing a source mapping used by an existing descendant', async () => {
    configureSources(['w1', 'w2'], ['parent'])
    openEditor()
    await openFilters()
    await screen.findByRole('button', {name: 'Add global filter'})
    fireEvent.click(screen.getByRole('button', {name: 'Parent'}))
    const dialog = within(screen.getByRole('dialog'))
    fireEvent.click(dialog.getByRole('checkbox', {name: 'Other chart'}))
    expect(dialog.getByRole<HTMLButtonElement>('button', {name: 'OK'}).disabled).toBe(true)
    expect(dialog.getByRole('alert').textContent).toContain('Every filter in a cascade')
    fireEvent.click(dialog.getByRole('checkbox', {name: 'Other chart'}))
    await chooseMapping('Other chart', 'Order ID · Dataset row field')
    expect(dialog.getByRole<HTMLButtonElement>('button', {name: 'OK'}).disabled).toBe(false)
  })
})


describe('global filter modal and query container', () => {
  it('cancels the whole collection, including renames and new filters', async () => {
    openEditor()
    await openFilters()
    expect(screen.queryByRole('complementary')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Rename filter: Global amount' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Label' }), { target: { value: 'Renamed amount' } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Label' }), { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: 'Add global filter' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(saveButton().disabled).toBe(true)
    await openFilters()
    expect(screen.getByRole('button', { name: 'Global amount' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Untitled filter' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Renamed amount' })).toBeNull()
  })

  it('keeps invalid manual input when switching filters and commits the collection as one undo step', async () => {
    openEditor()
    await openFilters()
    fireEvent.click(screen.getByRole('radio', { name: 'Manual input' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Manual input' }), { target: { value: 'not a number' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add global filter' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Orders' }))
    await chooseMapping('Orders', 'Discount · Dataset row field')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'OK' }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Global amount' }))
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Manual input' }).value).toBe('not a number')
    fireEvent.change(screen.getByRole('textbox', { name: 'Manual input' }), { target: { value: '10,20' } })
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(within(screen.getByRole('region', { name: 'Query container' })).getByText('Discount')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(screen.queryByText('Discount')).toBeNull()
    expect(saveButton().disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }))
    fireEvent.click(saveButton())
    await waitFor(() => expect(saves().at(-1)?.body.spec).toMatchObject({
      queryContainer: { x: 0, y: 0, w: 96, h: 8 },
      filters: [{ label: 'Global amount', op: 'in', default: [10, 20] }, { label: 'Discount' }],
    }))
  })

  it('saves moved and resized container coordinates separately from chart items and restores them on undo', async () => {
    openEditor()
    await screen.findByRole('region', { name: 'Query container' })
    const grid = server.grid.items as { id: string; type: string; x: number; y: number; w: number; h: number }[]
    act(() => server.grid.change!(grid.map((item) => item.type === 'query' ? { ...item, x: 6, y: 0, w: 6, h: 3 } : { ...item, y: 0 })))
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(saveButton().disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }))
    fireEvent.click(saveButton())
    await waitFor(() => expect(saves().at(-1)?.body.spec).toMatchObject({
      queryContainer: { x: 6, y: 0, w: 6, h: 3 },
      layout: { items: server.initial.spec.layout.items },
      filters: server.initial.spec.filters,
    }))
  })
})


describe('query container actions', () => {
  async function action(name: string) {
    const container = within(await screen.findByRole('region', { name: 'Query container' }))
    const menu = container.getByRole('button', { name: 'More chart actions: Query container' })
    if (menu.getAttribute('aria-expanded') !== 'true') fireEvent.click(menu)
    fireEvent.click(container.getByRole('button', { name }))
  }

  it('has no header and shares chart control styles, preserving defaults and layout when saved', async () => {
    Object.assign(server.dashboard.spec, { queryContainer: { x: 6, y: 0, w: 6, h: 2 } })
    openEditor()
    const container = within(await screen.findByRole('region', { name: 'Query container' }))
    expect(container.queryByRole('heading')).toBeNull()
    const bar = container.getByRole('group', { name: 'Filters' })
    expect(bar.getAttribute('data-layout')).toBe('horizontal')
    await action('Settings')
    const settings = within(screen.getByRole('complementary', { name: 'Query container settings' }))
    expect(settings.getByText('Chart control style')).toBeTruthy()
    expect(settings.getByRole('radio', { name: 'Automatic' })).toBeTruthy()
    expect(settings.getByRole('radio', { name: 'Automatic height' })).toBeTruthy()
    expect(saveButton().disabled).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: 'Stacked' }))
    // The container's own padding has the same names as the controls' spacing.
    const spacing = () => within(screen.getByRole('radiogroup', { name: 'Spacing' })).getByRole('radio', { name: 'Compact' })
    fireEvent.click(spacing())
    expect(bar.getAttribute('data-layout')).toBe('vertical')
    expect(bar.getAttribute('data-density')).toBe('compact')
    fireEvent.keyDown(spacing(), { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    fireEvent.click(container.getByRole('button', { name: 'More chart actions: Query container' }))
    expect(container.getByRole('button', { name: 'Reset filters' })).toBeTruthy()
    expect(container.queryByRole('button', { name: 'Chart control style' })).toBeNull()
    expect(container.queryByRole('button', { name: 'Query settings' })).toBeNull()
    expect(container.queryByRole('button', { name: 'Settings' })).toBeNull()
    expect(screen.queryByRole('complementary', { name: 'Query container settings' })).toBeNull()
    expect(container.queryByRole('button', { name: 'Remove query container' })).toBeNull()
    expect(bar.getAttribute('data-layout')).toBe('vertical')
    fireEvent.click(screen.getByRole('button', { name: 'Exit preview' }))
    fireEvent.click(saveButton())
    await waitFor(() => expect(saves().at(-1)?.body.spec).toMatchObject({
      filterStyle: { layout: 'vertical', density: 'compact' },
      filters: server.initial.spec.filters,
      queryContainer: { x: 6, y: 0, w: 6, h: 2 },
    }))
  })

  it('removes all global filters together and restores them, the container and style with undo', async () => {
    Object.assign(server.dashboard.spec, { filterStyle: { layout: 'vertical', density: 'comfortable' }, queryContainer: { x: 6, y: 0, w: 6, h: 2 } })
    openEditor()
    await action('Settings')
    await action('Remove query container')
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect(saveButton().disabled).toBe(true)
    await action('Remove query container')
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove query container' }))
    expect(screen.queryByRole('region', { name: 'Query container' })).toBeNull()
    expect(screen.queryByRole('complementary', { name: 'Query container settings' })).toBeNull()
    expect(screen.getByRole('article', { name: 'Orders' })).toBeTruthy()
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Chart amount' }).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    const restored = within(screen.getByRole('region', { name: 'Query container' }))
    expect(restored.getByRole('group', { name: 'Filters' }).getAttribute('data-density')).toBe('comfortable')
    expect(saveButton().disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }))
    fireEvent.click(saveButton())
    await waitFor(() => {
      const spec = saves().at(-1)?.body.spec
      expect(spec).not.toHaveProperty('filters')
      expect(spec).not.toHaveProperty('queryContainer')
      expect(spec).not.toHaveProperty('filterStyle')
    })
  })
})

describe('manual global queries', () => {
  async function settings(mode: 'Manual' | 'Automatic') {
    const container = within(await screen.findByRole('region', { name: 'Query container' }))
    fireEvent.click(container.getByRole('button', { name: 'More chart actions: Query container' }))
    fireEvent.click(container.getByRole('button', { name: 'Settings' }))
    fireEvent.click(screen.getByRole('radio', { name: mode }))
    fireEvent.keyDown(screen.getByRole('radio', { name: mode }), { key: 'Escape' })
  }
  const queryButton = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Query' })
  const dataRequests = () => server.requests.filter(({ path }) => path.endsWith('/data'))

  it.each(['editor', 'viewer'] as const)('batches typed values into one request in the %s, without saving them as defaults', async (mode) => {
    Object.assign(server.dashboard.spec, { queryMode: 'manual' })
    server.dashboard.spec.filters.push({ id: 'name_global', label: 'Global name', op: 'contains', control: { type: 'text' }, default: 'Alice', targets: [{ item: 'w1', field: 'name' }] } as never)
    if (mode === 'editor') openEditor()
    else openViewer()
    const amount = await screen.findByRole('textbox', { name: 'Global amount' })
    await screen.findByText('Chart result')
    const initial = dataRequests().length
    expect(queryButton().disabled).toBe(true)
    fireEvent.change(amount, { target: { value: '2' } })
    fireEvent.change(amount, { target: { value: '20' } })
    fireEvent.change(amount, { target: { value: '200' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Global name' }), { target: { value: 'Bob' } })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)) })
    expect(dataRequests()).toHaveLength(initial)
    if (mode === 'editor') {
      expect(saveButton().disabled).toBe(true)
      fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
      expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Global amount' }).value).toBe('200')
      expect(dataRequests()).toHaveLength(initial)
    }
    fireEvent.click(queryButton())
    await waitFor(() => expect(dataRequests()).toHaveLength(initial + 1))
    expect(dataRequests().at(-1)?.body.filters).toEqual({ amount_global: 200, name_global: 'Bob' })
    expect(queryButton().disabled).toBe(true)
    fireEvent.click(queryButton())
    expect(dataRequests()).toHaveLength(initial + 1)
    expect(server.dashboard.spec.filters[0]!.default).toBe(100)
    expect(saves()).toHaveLength(0)
  })

  it('does not leak pending values to chart refresh and blocks invalid input', async () => {
    Object.assign(server.dashboard.spec, { queryMode: 'manual' })
    openEditor()
    const amount = await screen.findByRole('textbox', { name: 'Global amount' })
    await screen.findByText('Chart result')
    fireEvent.change(amount, { target: { value: '200' } })
    await chartAction('Refresh chart: Orders')
    await waitFor(() => expect(previewQueries()).toHaveLength(2))
    expect(previewQueries().at(-1)?.body.filters).toEqual({})
    fireEvent.change(amount, { target: { value: '-' } })
    expect(queryButton().disabled).toBe(true)
    fireEvent.click(queryButton())
    expect(previewQueries()).toHaveLength(2)
    fireEvent.change(amount, { target: { value: '300' } })
    fireEvent.click(queryButton())
    await waitFor(() => expect(previewQueries()).toHaveLength(3))
    expect(previewQueries().at(-1)?.body.filters).toEqual({ amount_global: 300 })
  })

  it('waits for reverse cascade inference before allowing a manual query', async () => {
    Object.assign(server.dashboard.spec, { queryMode: 'manual', filters: [
      { id: 'country', label: 'Country', op: 'in', control: { type: 'tiles' }, default: ['China'], targets: [{ item: 'w1', field: 'country' }] },
      { id: 'city', label: 'City', op: 'in', control: { type: 'tiles' }, default: ['Beijing'], dependsOn: ['country'], targets: [{ item: 'w1', field: 'city' }] },
    ] })
    let resolve!: (value: { values: unknown[]; truncated: boolean }) => void
    const inference = new Promise<{ values: unknown[]; truncated: boolean }>((done) => { resolve = done })
    server.behavior.options = ({ body, params }) => body.related ? inference : { values: params?.filterId === 'city' ? ['Tokyo'] : ['China'], truncated: false }
    openEditor()
    await screen.findByText('Chart result')
    const initial = dataRequests().length
    fireEvent.click(await within(await screen.findByRole('group', { name: 'City' })).findByRole('button', { name: 'Tokyo' }))
    expect(queryButton().disabled).toBe(true)
    expect(dataRequests()).toHaveLength(initial)
    await act(async () => { resolve({ values: ['Japan'], truncated: false }); await inference })
    expect(queryButton().disabled).toBe(false)
    expect(dataRequests()).toHaveLength(initial)
    fireEvent.click(queryButton())
    await waitFor(() => expect(dataRequests()).toHaveLength(initial + 1))
    expect(dataRequests().at(-1)?.body.filters).toEqual({ country: ['Japan'], city: ['Tokyo'] })
  })

  it('persists the mode with undo/redo and applies pending choices once when returning to automatic', async () => {
    openEditor()
    await screen.findByText('Chart result')
    const initial = previewQueries().length
    await settings('Manual')
    expect(previewQueries()).toHaveLength(initial)
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(screen.queryByRole('button', { name: 'Query' })).toBeNull()
    expect(saveButton().disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }))
    expect(queryButton().disabled).toBe(true)
    fireEvent.change(screen.getByRole('textbox', { name: 'Global amount' }), { target: { value: '400' } })
    fireEvent.click(saveButton())
    await waitFor(() => expect(saves().at(-1)?.body.spec).toMatchObject({ queryMode: 'manual', filters: server.initial.spec.filters }))
    expect(previewQueries()).toHaveLength(initial)
    await settings('Automatic')
    await waitFor(() => expect(previewQueries()).toHaveLength(initial + 1))
    expect(previewQueries().at(-1)?.body.filters).toEqual({ amount_global: 400 })
    fireEvent.change(screen.getByRole('textbox', { name: 'Global amount' }), { target: { value: '500' } })
    await waitFor(() => expect(previewQueries().at(-1)?.body.filters).toEqual({ amount_global: 500 }))
  })
})


describe('query container height mode', () => {
  it('defaults to automatic and persists manual height with undo/redo', async () => {
    openEditor()
    await screen.findByText('Chart result')
    const container = within(screen.getByRole('region', { name: 'Query container' }))
    fireEvent.click(container.getByRole('button', { name: 'More chart actions: Query container' }))
    fireEvent.click(container.getByRole('button', { name: 'Settings' }))
    expect(screen.getByRole('radio', { name: 'Automatic height' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('radio', { name: 'Manual height' }))
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Manual height' }), { key: 'Escape' })
    expect(server.grid.items).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'query', autoHeight: false })]))
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(server.grid.items).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'query', autoHeight: true })]))
    expect(saveButton().disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }))
    fireEvent.click(saveButton())
    await waitFor(() => expect(saves().at(-1)?.body.spec).toMatchObject({ queryHeightMode: 'manual' }))
  })
})

describe('reset global filters', () => {
  const dataRequests = () => server.requests.filter(({ path }) => path.endsWith('/data'))
  const reset = () => {
    const container = within(screen.getByRole('region', { name: 'Query container' }))
    fireEvent.click(container.getByRole('button', { name: 'More chart actions: Query container' }))
    fireEvent.click(container.getByRole('button', { name: 'Reset filters' }))
  }

  it.each(['editor', 'viewer', 'preview'] as const)('restores defaults together in %s and respects manual triggering', async (surface) => {
    Object.assign(server.dashboard.spec, { queryMode: 'manual' })
    server.dashboard.spec.filters.push({ id: 'name_global', label: 'Global name', op: 'contains', control: { type: 'text' }, targets: [{ item: 'w1', field: 'name' }] } as never)
    if (surface === 'viewer') openViewer()
    else openEditor()
    await screen.findByText('Chart result')
    if (surface === 'preview') fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Global amount' }), { target: { value: '200' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Global name' }), { target: { value: 'Bob' } })
    fireEvent.click(screen.getByRole('button', { name: 'Query' }))
    await waitFor(() => expect(dataRequests().at(-1)?.body.filters).toEqual({ amount_global: 200, name_global: 'Bob' }))
    const beforeReset = dataRequests().length
    // Invalid local text must also be discarded, even though it has not been committed.
    fireEvent.change(screen.getByRole('textbox', { name: 'Global amount' }), { target: { value: '-' } })
    reset()
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Global amount' }).value).toBe('100')
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Global name' }).value).toBe('')
    expect(dataRequests()).toHaveLength(beforeReset)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Query' }).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Query' }))
    await waitFor(() => expect(dataRequests()).toHaveLength(beforeReset + 1))
    expect(dataRequests().at(-1)?.body.filters).toEqual({})
    expect(saves()).toHaveLength(0)
    if (surface === 'editor') expect(saveButton().disabled).toBe(true)
    expect(server.dashboard.spec.filters[0]!.default).toBe(100)
  })

  it('applies defaults once in automatic mode and cancels unfinished typing', async () => {
    openEditor()
    await screen.findByText('Chart result')
    fireEvent.change(screen.getByRole('textbox', { name: 'Global amount' }), { target: { value: '200' } })
    await waitFor(() => expect(dataRequests().at(-1)?.body.filters).toEqual({ amount_global: 200 }))
    const beforeReset = dataRequests().length
    fireEvent.change(screen.getByRole('textbox', { name: 'Global amount' }), { target: { value: '300' } })
    reset()
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Global amount' }).value).toBe('100')
    await waitFor(() => expect(dataRequests()).toHaveLength(beforeReset + 1))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)) })
    expect(dataRequests()).toHaveLength(beforeReset + 1)
    expect(dataRequests().at(-1)?.body.filters).toEqual({})
    expect(saveButton().disabled).toBe(true)
  })

  it('discards reverse cascade results that arrive after reset', async () => {
    Object.assign(server.dashboard.spec, { queryMode: 'manual', filters: [
      { id: 'country', label: 'Country', op: 'in', control: { type: 'tiles' }, default: ['China'], targets: [{ item: 'w1', field: 'country' }] },
      { id: 'city', label: 'City', op: 'in', control: { type: 'tiles' }, default: ['Beijing'], dependsOn: ['country'], targets: [{ item: 'w1', field: 'city' }] },
    ] })
    let resolve!: (value: { values: unknown[]; truncated: boolean }) => void
    const inference = new Promise<{ values: unknown[]; truncated: boolean }>((done) => { resolve = done })
    server.behavior.options = ({ body, params }) => body.related ? inference : { values: params?.filterId === 'city' ? ['Beijing', 'Tokyo'] : ['China'], truncated: false }
    openEditor()
    await screen.findByText('Chart result')
    fireEvent.click(await within(await screen.findByRole('group', { name: 'City' })).findByRole('button', { name: 'Tokyo' }))
    reset()
    await act(async () => { resolve({ values: ['Japan'], truncated: false }); await inference })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Query' }).disabled).toBe(true)
    expect((await screen.findByRole('button', { name: 'Beijing' })).getAttribute('aria-pressed')).toBe('true')
    expect((await screen.findByRole('button', { name: 'Tokyo' })).getAttribute('aria-pressed')).toBe('false')
    expect(dataRequests()).toHaveLength(1)
  })
})

describe('dashboard grid settings', () => {
  const editNumber = (label: string, value: string) => {
    const input = screen.getByRole('spinbutton', { name: label })
    fireEvent.change(input, { target: { value } })
    fireEvent.blur(input)
  }

  it('commits settings once, scales charts and filters, supports undo, and saves without requerying', async () => {
    server.dashboard.spec.layout.items[0] = { id: 'w1', type: 'chart', chartId: 'chart', x: 48, y: 0, w: 48, h: 32 }
    openEditor()
    await screen.findByText('Chart result')
    fireEvent.click(screen.getByRole('button', { name: 'Page settings' }))
    const queryCount = previewQueries().length
    expect(saveButton().disabled).toBe(true)
    const input = screen.getByRole('spinbutton', { name: 'Grid columns' })
    fireEvent.change(input, { target: { value: '48' } })
    expect(server.grid.settings.columns).toBe(96)
    expect(saveButton().disabled).toBe(true)
    fireEvent.blur(input)
    expect(server.grid.settings.columns).toBe(96)
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(saves()).toHaveLength(0)
    expect(server.grid.settings.columns).toBe(48)
    expect(server.grid.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'w1', x: 24, w: 24 }), expect.objectContaining({ type: 'query', w: 48 })]))
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(server.grid.settings.columns).toBe(96)
    expect(saveButton().disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }))
    editNumber('Cell height (px)', '12')
    editNumber('Column gap (px)', '3')
    editNumber('Row gap (px)', '4')
    editNumber('Minimum vertical space (rows)', '2')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Compact upward automatically' }))
    expect(server.grid.settings).toMatchObject({ rowHeight: 8, autoCompact: true })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(server.grid.settings).toMatchObject({ columns: 48, rowHeight: 12, columnGap: 3, gap: 4, containerGap: 2, autoCompact: false })
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(server.grid.settings).toMatchObject({ columns: 48, rowHeight: 8, columnGap: 1.5, gap: 1.5, containerGap: 0, autoCompact: true })
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(server.grid.settings).toMatchObject({ editable: false, columns: 48, rowHeight: 12, containerGap: 2, autoCompact: false })
    expect(previewQueries()).toHaveLength(queryCount)
    fireEvent.click(screen.getByRole('button', { name: 'Exit preview' }))
    fireEvent.click(saveButton())
    await waitFor(() => expect(saveButton().disabled).toBe(true))
    const spec = saves().at(-1)!.body.spec as typeof server.dashboard.spec
    expect(spec.layout).toMatchObject({ columns: 48, grid: { rowHeight: 12, columnGap: 3, rowGap: 4, containerGap: 2, autoCompact: false } })
    Object.assign(server.dashboard, { spec })
    cleanup()
    openViewer()
    await screen.findByText('Chart result')
    expect(server.grid.settings).toMatchObject({ columns: 48, rowHeight: 12, columnGap: 3, gap: 4, containerGap: 2, autoCompact: false })
  })

  it('keeps pending page settings across panels and saves only applied values', async () => {
    openEditor()
    await screen.findByText('Chart result')
    await rename('Applied name')
    fireEvent.click(screen.getByRole('button', { name: 'Page settings' }))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Apply' }).disabled).toBe(true)
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Pending name' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), { target: { value: 'Pending description' } })
    // Apply must read the latest value even if focus has not left this field.
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Cell height (px)' }), { target: { value: '16' } })
    fireEvent.click(screen.getByRole('button', { name: 'Page settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Page settings' }))
    expect(screen.getByRole<HTMLInputElement>('spinbutton', { name: 'Cell height (px)' }).value).toBe('16')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Apply' }).disabled).toBe(false)
    fireEvent.click(saveButton())
    await waitFor(() => expect(saveButton().disabled).toBe(true))
    expect(saves().at(-1)!.body.name).toBe('Applied name')
    expect((saves().at(-1)!.body.spec as typeof server.dashboard.spec).layout).not.toHaveProperty('grid')
    expect(server.grid.settings.rowHeight).toBe(8)
    const savedCount = saves().length
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Apply' }).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Apply' }).disabled).toBe(true)
    expect(screen.getByTitle('Pending name')).toBeTruthy()
    expect(server.grid.settings.rowHeight).toBe(16)
    expect(saveButton().disabled).toBe(false)
    expect(saves()).toHaveLength(savedCount)
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(screen.getByTitle('Applied name')).toBeTruthy()
    expect(server.grid.settings.rowHeight).toBe(8)
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Description' }).value).not.toBe('Pending description')
    expect(saveButton().disabled).toBe(true)
  })

  it('shows reset for each non-default grid option and stages resets until Apply', async () => {
    openEditor()
    await screen.findByText('Chart result')
    fireEvent.click(screen.getByRole('button', { name: 'Page settings' }))
    expect(screen.queryByRole('button', { name: /^Reset .* to default$/ })).toBeNull()
    const fields = [
      ['Grid columns', '48', '96'], ['Cell height (px)', '12', '8'],
      ['Column gap (px)', '3', '1.5'], ['Row gap (px)', '4', '1.5'],
      ['Minimum vertical space (rows)', '2', '0'],
    ]
    for (const [label, value] of fields) editNumber(label!, value!)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Compact upward automatically' }))
    expect(screen.getAllByRole('button', { name: /^Reset .* to default$/ })).toHaveLength(6)
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    for (const [label, , defaultValue] of fields) {
      fireEvent.click(screen.getByRole('button', { name: `Reset ${label} to default` }))
      expect(screen.getByRole<HTMLInputElement>('spinbutton', { name: label }).value).toBe(defaultValue)
    }
    fireEvent.click(screen.getByRole('button', { name: 'Reset Compact upward automatically to default' }))
    expect(screen.queryByRole('button', { name: /^Reset .* to default$/ })).toBeNull()
    expect(server.grid.settings).toMatchObject({ columns: 48, rowHeight: 12, columnGap: 3, gap: 4, containerGap: 2, autoCompact: false })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(server.grid.settings).toMatchObject({ columns: 96, rowHeight: 8, columnGap: 1.5, gap: 1.5, containerGap: 0, autoCompact: true })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Apply' }).disabled).toBe(true)
  })

  it('bounds invalid inputs and leaves empty entries unchanged', async () => {
    openEditor()
    await screen.findByText('Chart result')
    fireEvent.click(screen.getByRole('button', { name: 'Page settings' }))
    editNumber('Cell height (px)', '')
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(server.grid.settings.rowHeight).toBe(8)
    expect(saveButton().disabled).toBe(true)
    editNumber('Grid columns', '999')
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(server.grid.settings.columns).toBe(192)
    editNumber('Column gap (px)', '-1')
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(server.grid.settings.columnGap).toBe(0)
    editNumber('Row gap (px)', '1.3')
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(server.grid.settings.gap).toBe(1.5)
  })
})


describe('dashboard click links', () => {
  function setupLinks() {
    const source = { id: 'source', name: 'Regions', datasetId: 'orders', spec: { specVersion: 1, query: { version: 1, dataset: 'orders', dimensions: [{ field: 'id' }], measures: [{ field: 'amount', agg: 'sum' }] }, viz: { type: 'bar', x: 'id', y: ['amount'] } } }
    Object.assign(server.dashboard, { charts: [source, ...server.dashboard.charts], spec: { ...server.dashboard.spec,
      links: [{ id: 'region', label: 'Region', source: { item: 'source', column: 'id' }, targets: [{ item: 'w1', field: 'id' }] }],
      layout: { ...server.dashboard.spec.layout, items: [{ id: 'source', type: 'chart', chartId: 'source', x: 0, y: 0, w: 6, h: 4 }, ...server.dashboard.spec.layout.items] },
    } })
  }
  it('sends clicks only to mapped targets, toggles off, and keeps preview choices out of saves', async () => {
    setupLinks()
    openEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Click East' }))
    // A click only opens the menu; linking is chosen there.
    expect(server.requests.filter((r) => r.path.endsWith('/data') && r.params?.itemId === 'w1').at(-1)?.body.links).toEqual({})
    fireEvent.click(screen.getByRole('button', { name: 'Link charts' }))
    await waitFor(() => expect(server.requests.filter((r) => r.path.endsWith('/data') && r.params?.itemId === 'w1').at(-1)?.body.links).toEqual({ region: 'East' }))
    expect(server.requests.filter((r) => r.path.endsWith('/data') && r.params?.itemId === 'source').at(-1)?.body.links).toEqual({})
    expect(screen.getByRole('button', { name: 'Clear link: Region' })).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: 'Chart name' }), { target: { value: 'Bob' } })
    await waitFor(() => expect(server.requests.filter((r) => r.path.endsWith('/data') && r.params?.itemId === 'w1').at(-1)?.body.chartFilters).toEqual({ name_local: 'Bob' }))
    expect(server.requests.filter((r) => r.path.endsWith('/data') && r.params?.itemId === 'w1').at(-1)?.body.links).toEqual({ region: 'East' })
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(screen.getByRole('button', { name: 'Clear link: Region' })).toBeTruthy()
    // The value linked already offers to let it go.
    fireEvent.click(screen.getByRole('button', { name: 'Click East' }))
    fireEvent.click(screen.getByRole('button', { name: 'Unlink charts' }))
    await waitFor(() => expect(server.requests.filter((r) => r.path.endsWith('/data') && r.params?.itemId === 'w1').at(-1)?.body.links).toEqual({}))
    fireEvent.click(screen.getByRole('button', { name: 'Click missing' }))
    fireEvent.click(screen.getByRole('button', { name: 'Link charts' }))
    await waitFor(() => expect(server.requests.filter((r) => r.path.endsWith('/data') && r.params?.itemId === 'w1').at(-1)?.body.links).toEqual({ region: null }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear link: Region' }))
    await waitFor(() => expect(server.requests.filter((r) => r.path.endsWith('/data') && r.params?.itemId === 'w1').at(-1)?.body.links).toEqual({}))
    fireEvent.click(screen.getByRole('button', { name: 'Exit preview' }))
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('drills a chart down from the menu, links only at its first level, and goes back from the breadcrumb or a reset', async () => {
    setupLinks()
    Object.assign(server.dashboard.charts[0]!.spec, { drill: { alias: 'id', levels: [{ field: 'created', grain: 'month', label: 'Created · Month' }] } })
    server.behavior.result = { columns: [{ name: 'id', label: 'Order ID', type: 'integer', role: 'dimension' }, { name: 'amount', type: 'decimal', role: 'measure' }], rows: [[1, 300]] }
    openViewer()
    const data = (item: string) => server.requests.filter((r) => r.path === '/dashboards/{id}/items/{itemId}/data' && r.params?.itemId === item)
    fireEvent.click(await screen.findByRole('button', { name: 'Click East' }))
    fireEvent.click(screen.getByRole('button', { name: 'Link charts' }))
    await waitFor(() => expect(data('w1').at(-1)?.body.links).toEqual({ region: 'East' }))
    expect(data('source').at(-1)?.body.drill).toBeUndefined()

    // The same value offers both; drilling down lets go of the link clicked on the chart.
    fireEvent.click(screen.getByRole('button', { name: 'Click East' }))
    fireEvent.click(screen.getByRole('button', { name: 'Drill down to Created · Month' }))
    await waitFor(() => expect(data('source').at(-1)?.body.drill).toEqual(['East']))
    await waitFor(() => expect(data('w1').at(-1)?.body.links).toEqual({}))
    const crumbs = screen.getByRole('navigation', { name: 'Drill-down levels' })
    expect(crumbs.textContent).toBe('Drilled down:Order IDEast')
    // At the last level, and with the column linking by its first level only, nothing is left to click.
    expect(screen.queryByRole('button', { name: 'Click East' })).toBeNull()
    // Lists of filter values are not drawn from the level drilled to.
    server.requests.filter((r) => r.path.endsWith('/options')).forEach((r) => expect(r.body.drill).toBeUndefined())

    fireEvent.click(within(crumbs).getByRole('button', { name: 'Order ID' }))
    await waitFor(() => expect(data('source').at(-1)?.body.drill).toBeUndefined())
    expect(screen.queryByRole('navigation', { name: 'Drill-down levels' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Click missing' }))
    fireEvent.click(screen.getByRole('button', { name: 'Drill down to Created · Month' }))
    await waitFor(() => expect(data('source').at(-1)?.body.drill).toEqual([null]))
    expect(screen.getByRole('navigation', { name: 'Drill-down levels' }).textContent).toBe('Drilled down:Order IDMissing')
    const container = within(screen.getByRole('region', { name: 'Query container' }))
    fireEvent.click(container.getByRole('button', { name: 'More chart actions: Query container' }))
    fireEvent.click(container.getByRole('button', { name: 'Reset filters' }))
    await waitFor(() => expect(data('source').at(-1)?.body.drill).toBeUndefined())
    expect(screen.queryByRole('navigation', { name: 'Drill-down levels' })).toBeNull()
  })
  it('saves explicit mappings through the link dialog', async () => {
    setupLinks()
    openEditor()
    await screen.findByRole('button', { name: 'Click East' })
    fireEvent.click(screen.getByRole('button', { name: 'Chart links' }))
    const dialog = await screen.findByRole('dialog', { name: 'Chart links' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), { target: { value: 'Orders link' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(server.requests.some((r) => r.method === 'PUT')).toBe(true))
    const saved = server.requests.find((r) => r.method === 'PUT')!.body.spec as { links: unknown[] }
    expect(saved.links).toEqual([{ id: 'region', label: 'Orders link', source: { item: 'source', column: 'id' }, targets: [{ item: 'w1', field: 'id' }] }])
  })
})


describe('dashboard grants', () => {
  it.each(['developer', 'admin'] as const)('lets a %s open and save dashboard access', async (role) => {
    server.behavior.role = role
    openEditor()
    fireEvent.click(await screen.findByRole('button', { name: i18n.t('dashboard.grants.open') }))
    const picker = await screen.findByRole('combobox', { name: i18n.t('dashboard.grants.title') })
    openPopup(picker)
    fireEvent.click(await screen.findByRole('option', { name: i18n.t('subject.everyone') }))
    fireEvent.keyDown(picker, { key: 'Escape' })
    const dialog = screen.getByRole('dialog', { name: i18n.t('dashboard.grants.title') })
    fireEvent.click(within(dialog).getByRole('button', { name: i18n.t('common.save') }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: i18n.t('dashboard.grants.title') })).toBeNull())
    expect(server.requests).toContainEqual({ method: 'PUT', path: '/dashboards/{id}/grants', body: { subjects: [{ everyone: true }] } })
  })

  it('hides dashboard access management from viewers', async () => {
    openEditor()
    await screen.findByRole('button', { name: i18n.t('dashboard.pageSettings') })
    expect(screen.queryByRole('button', { name: i18n.t('dashboard.grants.open') })).toBeNull()
    expect(server.gets).not.toContain('/dashboards/{id}/grants')
  })
})

describe('dashboard data freshness', () => {
  const dataQueries = () => server.requests.filter(({ path }) => path === '/dashboards/{id}/items/{itemId}/data')

  it('says when a kept result was fetched, and refreshing asks the database again', async () => {
    const fetched = new Date(Date.now() - 5 * 60_000).toISOString()
    server.behavior.meta = (request) => request.body.refresh ? { cached: false, cachedAt: new Date().toISOString() } : { cached: true, cachedAt: fetched }
    openViewer()
    const chart = within(await screen.findByRole('article', { name: 'Orders' }))
    expect(await chart.findByText('Updated 5 minutes ago')).toBeTruthy()
    expect(dataQueries().every(({ body }) => body.refresh === undefined)).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Refresh data' }))
    await waitFor(() => expect(dataQueries().at(-1)?.body.refresh).toBe(true))
    await waitFor(() => expect(chart.queryByText(/^Updated/)).toBeNull())

    // One chart can be refreshed on its own; changing a filter afterwards is not a refresh.
    const before = dataQueries().length
    await chartAction('Refresh chart: Orders')
    await waitFor(() => expect(dataQueries().length).toBe(before + 1))
    expect(dataQueries().at(-1)?.body.refresh).toBe(true)
    fireEvent.change(chart.getByRole('textbox', { name: 'Chart name' }), { target: { value: 'Bob' } })
    await waitFor(() => expect(dataQueries().length).toBe(before + 2))
    expect(dataQueries().at(-1)?.body.refresh).toBeUndefined()
  })
})

describe('looking closer at a chart', () => {
  const dataRequests = () => server.requests.filter(({ path }) => path.endsWith('/data'))

  async function openReader(mode: string) {
    if (mode === 'standalone') return openViewer()
    openEditor()
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Preview' }).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    await screen.findByRole('region', { name: 'Preview' })
  }

  it.each(['standalone', 'inline preview'])('enlarges a chart in the %s view, sharing its result and conditions with the card', async (mode) => {
    await openReader(mode)
    const card = within(await screen.findByRole('article', { name: 'Orders' }))
    await card.findByText('Chart result')
    const asked = dataRequests().length
    await chartAction('Enlarge chart: Orders')
    const dialog = within(await screen.findByRole('dialog', { name: 'Orders' }))
    expect(dialog.getByText('Chart result')).toBeTruthy()
    expect(dataRequests()).toHaveLength(asked)
    // A condition changed in the enlarged chart is the card's too, and stays once it is closed.
    fireEvent.change(dialog.getByRole('textbox', { name: 'Chart name' }), { target: { value: 'Bob' } })
    await waitFor(() => expect(dataRequests().at(-1)?.body.chartFilters).toEqual({ name_local: 'Bob' }))
    expect(dataRequests()).toHaveLength(asked + 1)
    fireEvent.click(dialog.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(card.getByRole<HTMLInputElement>('textbox', { name: 'Chart name' }).value).toBe('Bob')
    expect(saves()).toHaveLength(0)
  })

  it('shows the rows the chart was drawn from, written as the chart writes them, without asking again', async () => {
    Object.assign(server.dashboard.charts[0]!.spec, { viz: { type: 'table', hiddenColumns: ['id'], formats: { amount: { decimals: 2, prefix: '¥' } } } })
    server.behavior.result = {
      columns: [{ name: 'id', type: 'integer', role: 'dimension', label: 'Order ID' }, { name: 'region', type: 'text', role: 'dimension', label: 'Region' }, { name: 'amount', type: 'decimal', role: 'measure', label: 'Amount' }],
      rows: [[1, 'East', '1234.5'], [2, null, '20']],
    }
    server.behavior.meta = () => ({ truncated: true })
    openViewer()
    const card = within(await screen.findByRole('article', { name: 'Orders' }))
    await card.findByText('Chart result')
    const asked = dataRequests().length
    await chartAction('View data: Orders')
    const dialog = within(await screen.findByRole('dialog', { name: 'Data of Orders' }))
    const table = within(dialog.getByRole('table', { name: 'Data of Orders' }))
    // Columns the chart hides are left out, as they are from an export.
    expect(table.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['Region', 'Amount'])
    expect(table.getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell').map((cell) => cell.textContent))).toEqual([['East', '¥1,234.50'], ['—', '¥20.00']])
    expect(dialog.getByText("Only the first 2 rows are shown: the result goes beyond the chart's row limit.")).toBeTruthy()
    expect(dataRequests()).toHaveLength(asked)
  })

  it('leaves both out while the board is being arranged', async () => {
    openEditor()
    const card = within(await screen.findByRole('article', { name: 'Orders' }))
    await card.findByText('Chart result')
    fireEvent.click(card.getByRole('button', { name: 'More chart actions: Orders' }))
    expect(card.getByRole('button', { name: 'Configure chart: Orders' })).toBeTruthy()
    expect(card.queryByRole('button', { name: 'Enlarge chart: Orders' })).toBeNull()
    expect(card.queryByRole('button', { name: 'View data: Orders' })).toBeNull()
  })
})

describe('browser tab title', () => {
  it('names the tab after the dashboard being viewed, and gives it back on leaving', async () => {
    const router = createMemoryRouter([
      { path: '/dashboards/:id', element: <DashboardView colorScheme="light" /> },
      { path: '/', element: <p>Home</p> },
    ], { initialEntries: ['/dashboards/board'] })
    render(<RouterProvider router={router} />)
    await screen.findByRole('article', { name: 'Orders' })
    expect(document.title).toBe('Board - SupaBI')
    await act(() => router.navigate('/'))
    expect(document.title).toBe('SupaBI')
  })

  it('follows the name while the dashboard is edited', async () => {
    openEditor()
    await screen.findByRole('article', { name: 'Orders' })
    expect(document.title).toBe('Board - SupaBI')
    await rename('Sales')
    expect(document.title).toBe('Sales - SupaBI')
  })
})

describe('full screen and timed refresh', () => {
  const dataRequests = () => server.requests.filter(({ path }) => path === '/dashboards/{id}/items/{itemId}/data')
  const showPage = (state: 'hidden' | 'visible') => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: state })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
  }
  afterEach(() => {
    vi.useRealTimers()
    delete (document as { visibilityState?: unknown }).visibilityState
  })

  it('refreshes at the author’s interval with a max age, waits while hidden, and follows the reader’s choice', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    Object.assign(server.dashboard.spec, { autoRefresh: 60 })
    openViewer()
    await screen.findByText('Chart result')
    expect(screen.getByRole('combobox', { name: 'Timed refresh' }).textContent).toContain('Refresh every minute')
    const asked = dataRequests().length
    await act(() => vi.advanceTimersByTimeAsync(60_000))
    await waitFor(() => expect(dataRequests()).toHaveLength(asked + 1))
    // A little under the interval, so what this page fetched a minute ago counts as too old.
    expect(dataRequests().at(-1)!.body).toMatchObject({ maxAge: 54 })
    expect(dataRequests().at(-1)!.body.refresh).toBeUndefined()

    // A hidden page waits, and refreshes at once when it is back after the interval.
    showPage('hidden')
    await act(() => vi.advanceTimersByTimeAsync(120_000))
    expect(dataRequests()).toHaveLength(asked + 1)
    showPage('visible')
    await act(() => vi.advanceTimersByTimeAsync(0))
    await waitFor(() => expect(dataRequests()).toHaveLength(asked + 2))

    // The reader turns it off for this page; refreshing by hand still asks the database.
    await chooseOption('Timed refresh', 'No timed refresh')
    await act(() => vi.advanceTimersByTimeAsync(180_000))
    expect(dataRequests()).toHaveLength(asked + 2)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh data' }))
    await waitFor(() => expect(dataRequests().at(-1)!.body).toMatchObject({ refresh: true }))
    expect(dataRequests().at(-1)!.body.maxAge).toBeUndefined()
    expect(saves()).toHaveLength(0)
  })

  it('saves the interval chosen in page settings, and leaves it out when off', async () => {
    openEditor()
    await screen.findByRole('main', { name: 'Canvas' })
    fireEvent.click(screen.getByRole('button', { name: 'Page settings' }))
    await chooseOption('Timed refresh', 'Refresh every 5 minutes')
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    fireEvent.click(saveButton())
    await waitFor(() => expect(saves()).toHaveLength(1))
    expect(saves()[0]!.body.spec).toMatchObject({ autoRefresh: 300 })
    await chooseOption('Timed refresh', 'No timed refresh')
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(saveButton().disabled).toBe(false))
    fireEvent.click(saveButton())
    await waitFor(() => expect(saves()).toHaveLength(2))
    expect(saves()[1]!.body.spec).not.toHaveProperty('autoRefresh')
  })

  it('covers the page in full screen, and leaves on Escape or by the button', async () => {
    server.behavior.role = 'developer'
    openViewer()
    await screen.findByText('Chart result')
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }))
    expect(document.querySelector('.board-view.fullscreen')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.querySelector('.board-view.fullscreen')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }))
    fireEvent.click(screen.getByRole('button', { name: 'Exit full screen' }))
    expect(document.querySelector('.board-view.fullscreen')).toBeNull()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy()
  })
})

describe('feedback while a board is asked for its data again', () => {
  const dataRequests = () => server.requests.filter(({ path }) => path === '/dashboards/{id}/items/{itemId}/data')
  const hold = () => {
    let answer!: () => void
    server.behavior.dataPending = new Promise<void>((resolve) => { answer = resolve })
    return () => {
      server.behavior.dataPending = undefined
      act(answer)
    }
  }

  it('keeps each chart while it is asked for again, under a bar, and fades it while conditions change', async () => {
    openViewer()
    const article = await screen.findByRole('article', { name: 'Orders' })
    const card = within(article)
    await card.findByText('Chart result')
    let answer = hold()
    await chartAction('Refresh chart: Orders')
    await waitFor(() => expect(card.getByRole('progressbar', { name: 'Loading data: Orders' })).toBeTruthy())
    expect(card.getByText('Chart result')).toBeTruthy()
    expect(article.className).not.toContain('outdated')
    expect(screen.getByText('Loading data…')).toBeTruthy()
    answer()
    await waitFor(() => expect(card.queryByRole('progressbar')).toBeNull())

    // What answers the conditions before is faded until the new answer comes.
    answer = hold()
    fireEvent.change(card.getByRole('textbox', { name: 'Chart name' }), { target: { value: 'Bob' } })
    await waitFor(() => expect(article.className).toContain('outdated'))
    expect(card.getByText('Chart result')).toBeTruthy()
    answer()
    await waitFor(() => expect(article.className).not.toContain('outdated'))
    expect(dataRequests().at(-1)!.body.chartFilters).toEqual({ name_local: 'Bob' })
  })

  it('keeps a chart whose refresh failed, says so, and asks again on a click', async () => {
    openViewer()
    const card = within(await screen.findByRole('article', { name: 'Orders' }))
    await card.findByText('Chart result')
    server.behavior.dataFailure = true
    await chartAction('Refresh chart: Orders')
    const warning = await card.findByRole('button', { name: /^Refresh failed; the data shown is from before\./ })
    expect(card.getByText('Chart result')).toBeTruthy()
    expect(screen.getByText('1 chart failed to refresh')).toBeTruthy()
    server.behavior.dataFailure = false
    fireEvent.click(warning)
    await waitFor(() => expect(card.queryByRole('button', { name: /^Refresh failed/ })).toBeNull())
    // Trying a refresh again is still a refresh.
    expect(dataRequests().at(-1)!.body).toMatchObject({ refresh: true })
    expect(screen.queryByText(/failed to refresh/)).toBeNull()

    // Failing to answer changed conditions shows why, not the chart for the conditions before.
    server.behavior.dataFailure = true
    fireEvent.change(card.getByRole('textbox', { name: 'Chart name' }), { target: { value: 'Bob' } })
    await waitFor(() => expect(card.queryByText('Chart result')).toBeNull())
    expect(card.getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(card.queryByRole('button', { name: /^Refresh failed/ })).toBeNull()
  })

  it('tells when the board’s data is from: when its oldest chart’s was fetched', async () => {
    server.dashboard.spec.layout.items.push({ id: 'w2', type: 'chart', chartId: 'chart', x: 6, y: 0, w: 6, h: 4 })
    const older = '2026-10-19T10:00:00Z'
    server.behavior.meta = ({ params }) => ({ cachedAt: params?.itemId === 'w1' ? older : '2026-10-19T10:05:00Z' })
    openViewer()
    await waitFor(() => expect(screen.getAllByText('Chart result')).toHaveLength(2))
    expect(await screen.findByText(`Data as of ${clockTime(new Date(older), new Date(), 'en-US')}`)).toBeTruthy()
  })
})

describe('share links', () => {
  const dataRequests = () => server.requests.filter(({ path }) => path === '/dashboards/{id}/items/{itemId}/data')
  const viewRequests = () => server.requests.filter(({ path }) => path === '/dashboards/{id}/views')
  function openLink(path: string) {
    const router = createMemoryRouter([{ path: '/dashboards/:id', element: <DashboardView colorScheme="light" /> }], { initialEntries: [path] })
    render(<UnsavedChangesProvider><RouterProvider router={router} /></UnsavedChangesProvider>)
    return router
  }
  const link = (search: string) => `${window.location.origin}/dashboards/board?${search}`

  it('gives the dashboard’s address when nothing differs from its defaults', async () => {
    openLink('/dashboards/board')
    await screen.findByText('Chart result')
    fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    const dialog = within(await screen.findByRole('dialog', { name: 'Share dashboard' }))
    expect(dialog.getByRole<HTMLInputElement>('textbox', { name: 'Share link' }).value).toBe(link('ws=ws_main'))
    expect(dialog.queryByRole('checkbox', { name: 'Include the current conditions' })).toBeNull()
    expect(viewRequests()).toHaveLength(0)
  })

  it('keeps the conditions in view on the server when asked to, for as long as chosen', async () => {
    openLink('/dashboards/board')
    const card = within(await screen.findByRole('article', { name: 'Orders' }))
    await card.findByText('Chart result')
    fireEvent.change(card.getByRole('textbox', { name: 'Chart name' }), { target: { value: 'Bob' } })
    await waitFor(() => expect(dataRequests().at(-1)!.body.chartFilters).toEqual({ name_local: 'Bob' }))
    await chartAction('Use chart filters')
    fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    const dialog = within(await screen.findByRole('dialog', { name: 'Share dashboard' }))
    const address = dialog.getByRole<HTMLInputElement>('textbox', { name: 'Share link' })
    expect(address.value).toBe(link('ws=ws_main'))
    fireEvent.click(dialog.getByRole('checkbox', { name: 'Include the current conditions' }))
    await waitFor(() => expect(address.value).toBe(link('ws=ws_main&view=dv_new')))
    // Only what differs from the dashboard's own is carried, and said in words, a kind to a row.
    expect(viewRequests()[0]!.body).toEqual({ state: { chartFilters: { w1: { name_local: 'Bob' } }, useChartFilters: ['w1'] }, validDays: 30 })
    const parts = within(dialog.getByRole('list', { name: 'Conditions to include' }))
    expect(parts.getAllByRole('checkbox').map((box) => box.getAttribute('aria-checked') ?? String((box as HTMLInputElement).checked))).toEqual(['true'])
    expect(parts.getByText(/Orders · Chart name .*Bob; Orders · uses its own filters/)).toBeTruthy()
    expect(dialog.getByText('Whoever opens the link sees these filter values, even without access to the data they select.')).toBeTruthy()
    await chooseOption('Conditions valid for', '7 days')
    await waitFor(() => expect(viewRequests().at(-1)!.body.validDays).toBe(7))
    // With every kind unticked, nothing is carried: the link is the dashboard's address again.
    fireEvent.click(parts.getByRole('checkbox', { name: 'Chart filters' }))
    await waitFor(() => expect(address.value).toBe(link('ws=ws_main')))
    expect(dialog.getByText('Nothing is ticked, so the link is the dashboard’s address.')).toBeTruthy()
    expect(dialog.queryByText('Whoever opens the link sees these filter values, even without access to the data they select.')).toBeNull()
  })

  it('opens with the shared conditions the dashboard can still take, and forgets the link once they change', async () => {
    server.behavior.views.set('dv_shared', { filters: { amount_global: 500 }, chartFilters: { w1: { name_local: 'Carol', gone: 1 } }, links: { nope: 'East' } })
    const router = openLink('/dashboards/board?ws=ws_main&view=dv_shared')
    const card = within(await screen.findByRole('article', { name: 'Orders' }))
    await card.findByText('Chart result')
    expect(dataRequests()[0]!.body).toMatchObject({ filters: { amount_global: 500 }, chartFilters: { name_local: 'Carol' } })
    expect(screen.getByText('Some of the shared conditions no longer apply; the rest are applied.')).toBeTruthy()
    expect(router.state.location.search).toBe('?ws=ws_main&view=dv_shared')
    fireEvent.change(card.getByRole('textbox', { name: 'Chart name' }), { target: { value: 'Dave' } })
    await waitFor(() => expect(router.state.location.search).toBe('?ws=ws_main'))
  })

  it('carries the tab each tab container shows, and opens on it', async () => {
    server.dashboard.charts.push({ ...structuredClone(server.dashboard.charts[0]!), id: 'chart2', name: 'Revenue' })
    server.dashboard.spec.layout.items = [{ id: 'w5', type: 'tabs', x: 0, y: 0, w: 48, h: 32, tabs: [{ id: 'w1', chartId: 'chart' }, { id: 'w2', chartId: 'chart2' }] }] as never
    openLink('/dashboards/board')
    await screen.findByText('Chart result')
    fireEvent.click(screen.getByRole('tab', { name: 'Revenue' }))
    fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    const dialog = within(await screen.findByRole('dialog', { name: 'Share dashboard' }))
    // Only the tab differs from what the dashboard opens with, so it is all there is to tick, and no filter values are said to be shown.
    fireEvent.click(dialog.getByRole('checkbox', { name: 'Include the current conditions' }))
    await waitFor(() => expect(viewRequests()[0]!.body).toEqual({ state: { tabs: { w5: 'w2' } }, validDays: 30 }))
    const parts = within(dialog.getByRole('list', { name: 'Conditions to include' }))
    expect(parts.getAllByRole('checkbox')).toHaveLength(1)
    expect(parts.getByRole('checkbox', { name: 'Pages and tabs shown' })).toBeTruthy()
    expect(parts.getByText('Revenue')).toBeTruthy()
    expect(dialog.queryByText('Whoever opens the link sees these filter values, even without access to the data they select.')).toBeNull()
    cleanup()

    // Opened from the link, the container shows that tab, and only that tab's chart is asked for.
    server.requests.length = 0
    server.behavior.views.set('dv_shared', { tabs: { w5: 'w2', gone: 'w1' } })
    const router = openLink('/dashboards/board?ws=ws_main&view=dv_shared')
    await screen.findByText('Chart result')
    expect(screen.getByRole('tab', { name: 'Revenue' }).getAttribute('aria-selected')).toBe('true')
    expect(dataRequests().map((request) => request.params?.itemId)).toEqual(['w2'])
    expect(screen.getByText('Some of the shared conditions no longer apply; the rest are applied.')).toBeTruthy()
    // Going to another tab changes the conditions, so the address no longer names the shared ones.
    fireEvent.click(screen.getByRole('tab', { name: 'Orders' }))
    await waitFor(() => expect(router.state.location.search).toBe('?ws=ws_main'))
  })

  it('carries only the kinds of condition left ticked', async () => {
    server.dashboard.charts.push({ ...structuredClone(server.dashboard.charts[0]!), id: 'chart2', name: 'Revenue' })
    server.dashboard.spec.layout.items = [{ id: 'w5', type: 'tabs', x: 0, y: 0, w: 48, h: 32, tabs: [{ id: 'w1', chartId: 'chart' }, { id: 'w2', chartId: 'chart2' }] }] as never
    openLink('/dashboards/board')
    await screen.findByText('Chart result')
    fireEvent.change(screen.getByRole('textbox', { name: 'Global amount' }), { target: { value: '200' } })
    await waitFor(() => expect(dataRequests().at(-1)!.body.filters).toEqual({ amount_global: 200 }))
    fireEvent.click(screen.getByRole('tab', { name: 'Revenue' }))
    fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    const dialog = within(await screen.findByRole('dialog', { name: 'Share dashboard' }))
    fireEvent.click(dialog.getByRole('checkbox', { name: 'Include the current conditions' }))
    await waitFor(() => expect(viewRequests().at(-1)!.body.state).toEqual({ filters: { amount_global: 200 }, tabs: { w5: 'w2' } }))
    const parts = within(dialog.getByRole('list', { name: 'Conditions to include' }))
    expect(parts.getByText('Global amount ≥ 200')).toBeTruthy()
    fireEvent.click(parts.getByRole('checkbox', { name: 'Global filters' }))
    await waitFor(() => expect(viewRequests().at(-1)!.body.state).toEqual({ tabs: { w5: 'w2' } }))
    // What is left carries no filter values.
    expect(dialog.queryByText('Whoever opens the link sees these filter values, even without access to the data they select.')).toBeNull()
  })

  it('opens with the dashboard’s defaults once the shared conditions have expired', async () => {
    openLink('/dashboards/board?ws=ws_main&view=dv_gone')
    await screen.findByText('Chart result')
    expect(screen.getByText('The shared conditions have expired; the dashboard shows its defaults.')).toBeTruthy()
    expect(dataRequests()[0]!.body).toMatchObject({ filters: {}, chartFilters: {} })
  })

  it('offers to move to the workspace of the link, and does not move by itself', async () => {
    openLink('/dashboards/board?ws=ws_other')
    expect(await screen.findByText('This dashboard is in the workspace “Other”; you are in “Main”.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Switch to “Other”' })).toBeTruthy()
    expect(server.gets).not.toContain('/dashboards/{id}')
    expect(server.requests.some(({ path }) => path === '/auth/workspace')).toBe(false)
  })

  it.each([['a workspace the viewer cannot enter', '/dashboards/board?ws=ws_elsewhere'], ['a dashboard that cannot be seen', '/dashboards/missing']])('says the dashboard is unavailable for %s', async (_, path) => {
    openLink(path)
    expect(await screen.findByText('This dashboard does not exist, or you do not have access to it. Its author or an administrator can help.')).toBeTruthy()
  })
})

describe('titles and text', () => {
  const dataRequests = () => server.requests.filter(({ path }) => path === '/dashboards/{id}/items/{itemId}/data')
  const addNotes = (...items: Record<string, unknown>[]) => (server.dashboard.spec.layout.items as unknown[]).push(...items)

  it('shows the dashboard’s name, titles of their own and Markdown, asking no data for them', async () => {
    server.dashboard.description = 'Daily figures'
    addNotes(
      { id: 'w2', type: 'title', x: 0, y: 4, w: 96, h: 8, useDashboardName: true },
      { id: 'w3', type: 'title', x: 0, y: 12, w: 96, h: 8, title: 'East', subtitle: 'By order date' },
      { id: 'w4', type: 'text', x: 0, y: 20, w: 48, h: 16, markdown: '**Paid** orders <script>alert(1)</script>\n[docs](https://example.com) [bad](javascript:alert(1))' },
      { id: 'w5', type: 'text', x: 48, y: 20, w: 48, h: 16 },
    )
    openViewer()
    await screen.findByText('Chart result')
    const named = within(screen.getByRole('article', { name: 'Board' }))
    expect(named.getByRole('heading', { name: 'Board' })).toBeTruthy()
    expect(named.getByText('Daily figures')).toBeTruthy()
    const own = within(screen.getByRole('article', { name: 'East' }))
    expect(own.getByText('By order date')).toBeTruthy()
    const [text, empty] = screen.getAllByRole('article', { name: 'Text' })
    expect(text!.querySelector('strong')?.textContent).toBe('Paid')
    expect(text!.querySelector('script')).toBeNull()
    expect(text!.textContent).toContain('<script>alert(1)</script>')
    expect(within(text!).getByRole('link', { name: 'docs' }).getAttribute('target')).toBe('_blank')
    expect(within(text!).queryByRole('link', { name: 'bad' })).toBeNull()
    // Nothing written is nothing shown, not a prompt to write it.
    expect(empty!.textContent).toBe('')
    expect(empty!.classList.contains('card')).toBe(false)
    expect(new Set(dataRequests().map(({ params }) => params?.itemId))).toEqual(new Set(['w1']))
  })

  it('says nothing about data on a board without charts', async () => {
    Object.assign(server.dashboard.spec, { filters: [], autoRefresh: 60, layout: { columns: 96, items: [{ id: 'w1', type: 'text', x: 0, y: 0, w: 48, h: 16, markdown: 'Notes' }] } })
    openViewer()
    await screen.findByText('Notes')
    expect(screen.queryByRole('button', { name: 'Refresh data' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Timed refresh' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Share' })).toBeTruthy()
    expect(dataRequests()).toHaveLength(0)
  })

  it('adds a title on top that follows the name, and text below, both written in the inspector', async () => {
    server.behavior.role = 'developer'
    openEditor()
    await screen.findByText('Chart result')
    fireEvent.click(screen.getByRole('button', { name: 'Add a title' }))
    const inspector = () => within(screen.getByRole('complementary', { name: 'Component properties' }))
    const useName = () => inspector().getByRole('checkbox', { name: 'Use the dashboard’s name and description' })
    expect(useName().getAttribute('aria-checked')).toBe('true')
    expect(within(screen.getByRole('article', { name: 'Board' })).getByRole('heading', { name: 'Board' })).toBeTruthy()
    // Taking hold of it to move it keeps it selected, as with a chart; the background lets go.
    fireEvent.pointerDown(screen.getByRole('article', { name: 'Board' }))
    expect(screen.getByRole('complementary', { name: 'Component properties' })).toBeTruthy()
    fireEvent.pointerDown(screen.getByRole('main', { name: 'Canvas' }).querySelector<HTMLElement>('.dashboard-canvas')!)
    expect(screen.queryByRole('complementary', { name: 'Component properties' })).toBeNull()
    await chartAction('Configure Board', 'Board')
    await rename('Sales')
    expect(within(await screen.findByRole('article', { name: 'Sales' })).getByRole('heading', { name: 'Sales' })).toBeTruthy()

    // Written by hand from what it showed; typing into a field is one step to undo.
    fireEvent.click(useName())
    const title = inspector().getByRole<HTMLInputElement>('textbox', { name: 'Title' })
    expect(title.value).toBe('Sales')
    fireEvent.change(title, { target: { value: 'Ea' } })
    fireEvent.change(title, { target: { value: 'East' } })
    fireEvent.blur(title)
    expect(within(screen.getByRole('article', { name: 'East' })).getByRole('heading', { name: 'East' })).toBeTruthy()
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })
    expect(screen.getByRole('article', { name: 'Sales' })).toBeTruthy()
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true, shiftKey: true })
    expect(screen.getByRole('article', { name: 'East' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Add text' }))
    const text = within(screen.getByRole('article', { name: 'Text' }))
    expect(text.getByText('No text yet. Write it in the panel on the right.')).toBeTruthy()
    fireEvent.change(inspector().getByRole('textbox', { name: 'Markdown' }), { target: { value: '**Paid** orders' } })
    expect(text.getByText('Paid').tagName).toBe('STRONG')

    fireEvent.click(saveButton())
    await waitFor(() => expect(saves()).toHaveLength(1))
    // The legacy filter strip is laid out on the grid too, so the chart is below it, and both below the title.
    expect(saves()[0]!.body.spec).toMatchObject({
      queryContainer: { x: 0, y: 8, w: 96, h: 8 },
      layout: { items: [
        { id: 'w2', type: 'title', title: 'East', x: 0, y: 0, w: 96, h: 8 },
        { id: 'w1', type: 'chart', chartId: 'chart', x: 0, y: 16, w: 6, h: 4 },
        { id: 'w3', type: 'text', markdown: '**Paid** orders', x: 0, y: 20, w: 48, h: 16 },
      ] },
    })
    const saved = (saves()[0]!.body.spec as { layout: { items: Record<string, unknown>[] } }).layout.items
    expect(saved.map((item) => Object.keys(item).filter((key) => ['minH', 'useDashboardName', 'subtitle'].includes(key)))).toEqual([[], [], []])
  })

  it('places a title and gives it a background and a border, keeping only what differs from the default', async () => {
    server.behavior.role = 'developer'
    addNotes({ id: 'w2', type: 'title', x: 0, y: 4, w: 96, h: 8, title: 'East', style: { align: 'right' } })
    openEditor()
    await screen.findByText('Chart result')
    const article = () => screen.getByRole('article', { name: 'East' })
    expect(article().className).toContain('h-right')
    expect(article().className).toContain('v-middle')
    expect(article().className).not.toContain('boxed')
    await chartAction('Configure East', 'East')
    const inspector = within(screen.getByRole('complementary', { name: 'Component properties' }))
    const choose = (group: string, name: string) => fireEvent.click(within(inspector.getByRole('radiogroup', { name: group })).getByRole('radio', { name }))
    choose('Horizontal alignment', 'Center')
    choose('Vertical alignment', 'Top')
    choose('Light theme background', 'Blue')
    fireEvent.click(inspector.getByRole('checkbox', { name: 'Show border' }))
    expect(article().className).toContain('h-center')
    expect(article().className).toContain('v-top')
    expect(article().className).toContain('boxed')
    expect(article().className).toContain('bordered')
    expect(article().style.getPropertyValue('--lb-color-surface')).toBe('#e5effa')
    // Each choice is a step to undo.
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })
    expect(article().className).not.toContain(' bordered')
    expect(article().className).toContain('boxed')
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true, shiftKey: true })
    expect(article().className).toContain(' bordered')

    // Choosing what the title would be anyway keeps nothing for it.
    choose('Horizontal alignment', 'Left')
    choose('Light theme background', 'Default background')
    choose('Padding', 'Normal')
    // The page's own colour, as every widget has by default.
    expect(article().style.background).toBe('rgb(255, 255, 255)')
    expect(article().className).not.toContain('lb-ink')
    fireEvent.click(saveButton())
    await waitFor(() => expect(saves()).toHaveLength(1))
    const items = (saves()[0]!.body.spec as { layout: { items: Record<string, unknown>[] } }).layout.items
    const saved = items.find((item) => item.id === 'w2')
    expect(saved?.style).toEqual({ verticalAlign: 'top' })
    expect(saved?.frame).toEqual({ border: true })
  })

  it('takes a colour of the author’s own from the panel, drawing what is in it to suit, as one step to undo', async () => {
    server.behavior.role = 'developer'
    addNotes({ id: 'w2', type: 'title', x: 0, y: 4, w: 96, h: 8, title: 'East', subtitle: 'By order date', frame: { background: 'blue' } })
    openEditor()
    await screen.findByText('Chart result')
    const article = () => screen.getByRole('article', { name: 'East' })
    await chartAction('Configure East', 'East')
    const inspector = () => within(screen.getByRole('complementary', { name: 'Component properties' }))
    const custom = () => inspector().getByRole('radio', { name: 'Custom color' })
    expect(custom().getAttribute('aria-checked')).toBe('false')
    fireEvent.click(custom())
    const value = await screen.findByRole<HTMLInputElement>('textbox', { name: 'Hex value' })
    expect(value.value).toBe('')
    expect(screen.getByText('Picking the color for: Light theme')).toBeTruthy()
    // Not yet a colour, or not one at all, changes nothing.
    fireEvent.change(value, { target: { value: '1F3A' } })
    expect(value.getAttribute('aria-invalid')).toBeNull()
    fireEvent.change(value, { target: { value: '1F3A5Z' } })
    expect(value.getAttribute('aria-invalid')).toBe('true')
    expect(article().style.getPropertyValue('--lb-color-surface')).toBe('#e5effa')
    // A dark colour is drawn on in the dark scheme's colours, a light one in the light scheme's.
    fireEvent.change(value, { target: { value: '#1F3A5F' } })
    expect(article().style.background).toBe('rgb(31, 58, 95)')
    expect(article().className).toContain('own-color')
    expect(article().style.getPropertyValue('--lb-color-text')).toBe('#eceef2')
    fireEvent.change(value, { target: { value: 'ffd966' } })
    expect(article().style.background).toBe('rgb(255, 217, 102)')
    expect(article().style.getPropertyValue('--lb-color-text')).toBe('#11141a')
    expect(custom().getAttribute('aria-checked')).toBe('true')
    fireEvent.keyDown(value, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Hex value' })).toBeNull())

    // Everything picked in the panel goes back at once.
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })
    expect(article().style.getPropertyValue('--lb-color-surface')).toBe('#e5effa')
    expect(article().className).not.toContain('own-color')
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true, shiftKey: true })
    expect(article().style.background).toBe('rgb(255, 217, 102)')
  })

  it('gives the dark theme a background of its own, or lets it follow the light one', async () => {
    server.behavior.role = 'developer'
    addNotes({ id: 'w2', type: 'title', x: 0, y: 4, w: 96, h: 8, title: 'East', frame: { background: '#ffd966' } })
    openEditor()
    await screen.findByText('Chart result')
    await chartAction('Configure East', 'East')
    const inspector = within(screen.getByRole('complementary', { name: 'Component properties' }))
    const themes = within(inspector.getByRole('radiogroup', { name: 'Theme to set the background for' }))
    // The theme being looked at is the one set to begin with.
    expect(themes.getByRole('radio', { name: 'Light theme' }).getAttribute('aria-checked')).toBe('true')
    // Each theme shows what it has chosen beside its name.
    const dot = (name: string) => themes.getByRole('radio', { name }).querySelector<HTMLElement>('.frame-mode-dot')!.style.background
    expect(dot('Light theme')).toBe('rgb(255, 217, 102)')
    expect(dot('Dark theme')).toBe('rgb(255, 217, 102)')
    fireEvent.click(themes.getByRole('radio', { name: 'Dark theme' }))
    expect(inspector.queryByRole('button', { name: 'Same as light theme' })).toBeNull()
    const dark = within(inspector.getByRole('radiogroup', { name: 'Dark theme background' }))
    // The swatches show the dark theme's colours.
    expect(dark.getByRole('radio', { name: 'Default background' }).style.background).toBe('rgb(21, 24, 30)')
    expect(dark.getByRole('radio', { name: 'Blue' }).style.background).toBe('rgb(57, 135, 229)')
    expect(dark.getByRole('radio', { name: 'Custom color' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(dark.getByRole('radio', { name: 'Light grey' }))
    // The light theme, which is shown, keeps its colour.
    expect(screen.getByRole('article', { name: 'East' }).style.background).toBe('rgb(255, 217, 102)')
    expect(dark.getByRole('radio', { name: 'Light grey' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(inspector.getByRole('button', { name: 'Same as light theme' }))
    expect(dark.getByRole('radio', { name: 'Custom color' }).getAttribute('aria-checked')).toBe('true')
    expect(dot('Dark theme')).toBe('rgb(255, 217, 102)')
    fireEvent.click(dark.getByRole('radio', { name: 'Default background' }))
    expect(dot('Dark theme')).toBe('rgb(21, 24, 30)')
    fireEvent.click(saveButton())
    await waitFor(() => expect(saves()).toHaveLength(1))
    const items = (saves()[0]!.body.spec as { layout: { items: Record<string, unknown>[] } }).layout.items
    expect(items.find((item) => item.id === 'w2')?.frame).toEqual({ background: '#ffd966', backgroundDark: 'default' })
  })

  it('removes a title after asking, and keeps titles and text out of filter and link choices', async () => {
    server.behavior.role = 'developer'
    addNotes({ id: 'w2', type: 'title', x: 0, y: 4, w: 96, h: 8, title: 'East' })
    openEditor()
    await screen.findByText('Chart result')
    await openFilters()
    const filters = within(await screen.findByRole('dialog', { name: 'Global filters' }))
    expect(filters.queryByText('East')).toBeNull()
    fireEvent.click(filters.getByRole('button', { name: i18n.t('common.cancel') }))
    await chartAction('Remove East', 'East')
    const dialog = within(await screen.findByRole('dialog', { name: 'Remove component' }))
    expect(dialog.getByText('Remove “East” from this dashboard? You can undo this change.')).toBeTruthy()
    fireEvent.click(dialog.getByRole('button', { name: 'Remove component' }))
    await waitFor(() => expect(screen.queryByRole('article', { name: 'East' })).toBeNull())
  })
})

describe('chart containers', () => {
  type GridHooks = { onDropItem: (data: string, place: { x: number; y: number; w: number; h: number }, items: unknown[]) => void; onDropInto: (data: string, itemId: string) => void }
  const grid = () => server.grid.settings as GridHooks
  const chartItem = () => (server.dashboard.spec.layout.items as Record<string, unknown>[])[0]!
  const addRevenue = () => server.dashboard.charts.push({ ...structuredClone(server.dashboard.charts[0]!), id: 'chart2', name: 'Revenue' })
  const savedSpec = () => saves()[0]!.body.spec as { frame?: unknown; filters?: unknown[]; layout: { items: Record<string, unknown>[] } }

  it('goes by a name of its own on the board, with a note, and leaves its header off when viewed', async () => {
    Object.assign(chartItem(), { title: 'Paid orders', note: 'Paid only.\nRefunds excluded.', hideHeader: true })
    openViewer()
    await screen.findByText('Chart result')
    const card = screen.getByRole('article', { name: 'Paid orders' })
    expect(card.className).toContain('header-hidden')
    expect(within(card).getByRole('heading', { name: 'Paid orders' })).toBeTruthy()
    expect(within(card).getByRole('button', { name: 'Note: Paid orders' })).toBeTruthy()
    expect(within(card).queryByText('Hidden when viewed')).toBeNull()
    expect(screen.queryByRole('article', { name: 'Orders' })).toBeNull()
  })

  it('keeps its header while arranging, faded, and takes its name, note, header and frame from the inspector', async () => {
    server.behavior.role = 'developer'
    openEditor()
    await screen.findByText('Chart result')
    await chartAction('Configure chart: Orders')
    const inspector = within(screen.getByRole('complementary', { name: 'Component properties' }))
    expect(inspector.getByRole<HTMLInputElement>('textbox', { name: 'Display name' }).placeholder).toBe('Orders')
    fireEvent.change(inspector.getByRole('textbox', { name: 'Display name' }), { target: { value: 'Paid orders' } })
    fireEvent.change(inspector.getByRole('textbox', { name: 'Note' }), { target: { value: 'Paid only.' } })
    fireEvent.click(inspector.getByRole('checkbox', { name: 'Hide header' }))
    const card = screen.getByRole('article', { name: 'Paid orders' })
    expect(card.className).toContain('header-faded')
    expect(within(card).getByText('Hidden when viewed')).toBeTruthy()
    expect(within(card).getByRole('button', { name: 'Note: Paid orders' })).toBeTruthy()
    expect(card.className).toContain('bordered')
    fireEvent.click(inspector.getByRole('checkbox', { name: 'Show border' }))
    expect(card.className).toContain('borderless')
    fireEvent.click(saveButton())
    await waitFor(() => expect(saves()).toHaveLength(1))
    expect(savedSpec().layout.items[0]).toMatchObject({ id: 'w1', chartId: 'chart', title: 'Paid orders', note: 'Paid only.', hideHeader: true, frame: { border: false } })
  })

  it('lays out an empty box and fills it from the library, or with a chart dropped onto it', async () => {
    server.behavior.role = 'developer'
    addRevenue()
    openEditor()
    await screen.findByText('Chart result')
    act(() => grid().onDropItem('empty', { x: 0, y: 40, w: 48, h: 32 }, server.grid.items))
    const empty = () => screen.getByRole('article', { name: 'Empty chart container' })
    expect(within(empty()).getByText('Drag a chart here from the chart library')).toBeTruthy()
    fireEvent.click(within(empty()).getByRole('button', { name: 'Choose from the chart library' }))
    expect(screen.getByText('Click a chart to put it in “Empty chart container”')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Put in the container Revenue' }))
    expect(await screen.findByRole('article', { name: 'Revenue' })).toBeTruthy()
    expect(screen.queryByRole('article', { name: 'Empty chart container' })).toBeNull()

    // Another empty box takes a chart dropped onto it at once; one with a chart asks first.
    act(() => grid().onDropItem('empty', { x: 0, y: 80, w: 48, h: 32 }, server.grid.items))
    const emptyId = (server.grid.items as { id: string; type: string; chartId?: string }[]).find((item) => item.type === 'chart' && !item.chartId)!.id
    act(() => grid().onDropInto('chart', emptyId))
    expect(screen.getAllByRole('article', { name: 'Orders' })).toHaveLength(2)
    expect(screen.queryByRole('dialog', { name: 'Replace chart' })).toBeNull()

    // Viewed in the page's preview, an empty box is blank.
    act(() => grid().onDropItem('empty', { x: 0, y: 120, w: 48, h: 32 }, server.grid.items))
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(screen.queryByRole('article', { name: 'Empty chart container' })).toBeNull()
  })

  it('takes a chart out or puts another in its place, and what was said about it goes with it', async () => {
    server.behavior.role = 'developer'
    addRevenue()
    Object.assign(chartItem(), { title: 'Paid orders', note: 'Paid only.', frame: { padding: 'compact' } })
    openEditor()
    await screen.findByText('Chart result')
    act(() => grid().onDropInto('chart2', 'w1'))
    const dialog = within(await screen.findByRole('dialog', { name: 'Replace chart' }))
    expect(dialog.getByText(/Replace “Paid orders” with “Revenue”/)).toBeTruthy()
    fireEvent.click(dialog.getByRole('button', { name: 'Replace' }))
    const replaced = await screen.findByRole('article', { name: 'Revenue' })
    expect(replaced.className).toContain('pad-compact')
    expect(within(replaced).queryByRole('button', { name: 'Note: Revenue' })).toBeNull()
    // The chart and what was said about it come back together.
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })
    expect(screen.getByRole('article', { name: 'Paid orders' })).toBeTruthy()

    await chartAction('Take out chart: Paid orders', 'Paid orders')
    expect(screen.getByRole('article', { name: 'Empty chart container' }).className).toContain('pad-compact')
    fireEvent.click(saveButton())
    await waitFor(() => expect(saves()).toHaveLength(1))
    const spec = savedSpec()
    expect(spec.filters).toBeUndefined()
    expect(spec.layout.items[0]).toMatchObject({ id: 'w1', type: 'chart', frame: { padding: 'compact' } })
    expect(Object.keys(spec.layout.items[0]!)).not.toContain('chartId')
    expect(Object.keys(spec.layout.items[0]!)).not.toContain('title')
  })

  it('frames charts and text by the page’s default unless they say otherwise; titles keep their own', async () => {
    server.behavior.role = 'developer'
    ;(server.dashboard.spec.layout.items as unknown[]).push(
      { id: 't1', type: 'title', x: 0, y: 8, w: 96, h: 8, title: 'East' },
      { id: 'x1', type: 'text', x: 0, y: 16, w: 48, h: 16, markdown: 'Notes' },
    )
    openEditor()
    await screen.findByText('Chart result')
    fireEvent.click(screen.getByRole('button', { name: 'Page settings' }))
    const page = within(screen.getByRole('complementary', { name: 'Page settings' }))
    fireEvent.click(page.getByRole('checkbox', { name: 'Show border' }))
    fireEvent.click(within(page.getByRole('radiogroup', { name: 'Padding' })).getByRole('radio', { name: 'Compact' }))
    // Staged until applied, as the rest of the page settings are.
    expect(screen.getByRole('article', { name: 'Orders' }).className).toContain('bordered')
    fireEvent.click(page.getByRole('button', { name: 'Apply' }))
    for (const name of ['Orders', 'Text']) expect(screen.getByRole('article', { name }).className).toMatch(/borderless pad-compact/)
    expect(screen.getByRole('article', { name: 'East' }).className).toContain('pad-normal')

    // A chart that says otherwise keeps its own.
    await chartAction('Configure chart: Orders')
    fireEvent.click(within(screen.getByRole('complementary', { name: 'Component properties' })).getByRole('checkbox', { name: 'Show border' }))
    expect(screen.getByRole('article', { name: 'Orders' }).className).toMatch(/bordered pad-compact/)
    fireEvent.click(saveButton())
    await waitFor(() => expect(saves()).toHaveLength(1))
    expect(savedSpec().frame).toEqual({ border: false, padding: 'compact' })
    expect(savedSpec().layout.items[0]!.frame).toEqual({ border: true })
    expect(savedSpec().layout.items[1]!.frame).toBeUndefined()
  })

  it('turns the inspector to what is clicked while it shows the settings of something else', async () => {
    server.behavior.role = 'developer'
    openEditor()
    await screen.findByText('Chart result')
    const inspector = (name: string) => screen.queryByRole('complementary', { name })
    // Closed, a click only selects.
    fireEvent.click(screen.getByRole('article', { name: 'Orders' }))
    expect(inspector('Component properties')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Page settings' }))
    expect(inspector('Page settings')).toBeTruthy()
    fireEvent.click(screen.getByRole('article', { name: 'Orders' }))
    expect(inspector('Component properties')).toBeTruthy()
    fireEvent.click(screen.getByRole('region', { name: 'Query container' }))
    expect(inspector('Query container settings')).toBeTruthy()
    fireEvent.click(screen.getByRole('article', { name: 'Orders' }))
    expect(inspector('Component properties')).toBeTruthy()
  })

  it('lets a card’s background through as far as its transparency says, opaque by default, as one step to undo', async () => {
    server.behavior.role = 'developer'
    openEditor()
    await screen.findByText('Chart result')
    const card = () => screen.getByRole('article', { name: 'Orders' })
    // A card is opaque in the page's own colour unless told otherwise.
    expect(card().style.background).toBe('rgb(255, 255, 255)')
    await chartAction('Configure chart: Orders')
    const inspector = within(screen.getByRole('complementary', { name: 'Component properties' }))
    const slider = inspector.getByRole<HTMLInputElement>('slider', { name: 'Transparency' })
    expect(slider.value).toBe('0')
    expect(within(inspector.getByRole('radiogroup', { name: 'Light theme background' })).getByRole('radio', { name: 'Default background' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.change(slider, { target: { value: '40' } })
    fireEvent.change(slider, { target: { value: '100' } })
    fireEvent.pointerUp(slider)
    expect(card().style.background).toBe('rgba(255, 255, 255, 0)')
    expect(inspector.getByText('100%')).toBeTruthy()
    // Dragging the slider is one step to undo.
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })
    expect(card().style.background).toBe('rgb(255, 255, 255)')
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true, shiftKey: true })
    fireEvent.click(saveButton())
    await waitFor(() => expect(saves()).toHaveLength(1))
    expect((saves()[0]!.body.spec as { layout: { items: Record<string, unknown>[] } }).layout.items[0]!.frame).toEqual({ transparency: 100 })
  })

  it('gives a title the same background and transparency as any widget', async () => {
    server.behavior.role = 'developer'
    ;(server.dashboard.spec.layout.items as unknown[]).push({ id: 't1', type: 'title', x: 0, y: 8, w: 96, h: 8, title: 'East' })
    openEditor()
    await screen.findByText('Chart result')
    const title = () => screen.getByRole('article', { name: 'East' })
    expect(title().style.background).toBe('rgb(255, 255, 255)')
    await chartAction('Configure East', 'East')
    const slider = within(screen.getByRole('complementary', { name: 'Component properties' })).getByRole<HTMLInputElement>('slider', { name: 'Transparency' })
    expect(slider.disabled).toBe(false)
    fireEvent.change(slider, { target: { value: '100' } })
    expect(title().style.background).toBe('rgba(255, 255, 255, 0)')
  })

  it('draws a chart on a colour of the author’s own in the scheme that reads on it, and enlarged on the dialog’s', async () => {
    Object.assign(chartItem(), { frame: { background: '#1f3a5f' } })
    openViewer()
    const drawn = await screen.findByText('Chart result')
    expect(drawn.dataset).toMatchObject({ scheme: 'dark', surface: '#1f3a5f' })
    const card = screen.getByRole('article', { name: 'Orders' })
    expect(card.style.getPropertyValue('--lb-color-surface')).toBe('#1f3a5f')
    fireEvent.click(within(card).getByRole('button', { name: 'More chart actions: Orders' }))
    fireEvent.click(within(card).getByRole('button', { name: 'Enlarge chart: Orders' }))
    const enlarged = within(await screen.findByRole('dialog', { name: 'Orders' })).getByText('Chart result')
    expect(enlarged.dataset.scheme).toBe('light')
    expect(enlarged.dataset.surface).toBeUndefined()
  })
})

describe('tab containers', () => {
  type GridHooks = { onDropInto: (data: string, itemId: string) => void }
  const grid = () => server.grid.settings as GridHooks
  const addRevenue = () => server.dashboard.charts.push({ ...structuredClone(server.dashboard.charts[0]!), id: 'chart2', name: 'Revenue' })
  // The board's chart, in the first tab of a container with Revenue and an empty tab after it.
  const tabbed = () => {
    addRevenue()
    server.dashboard.spec.layout.items = [{ id: 'w5', type: 'tabs', x: 0, y: 0, w: 48, h: 32, frame: { border: false }, tabs: [{ id: 'w1', chartId: 'chart' }, { id: 'w2', chartId: 'chart2', note: 'Paid only.' }, { id: 'w3' }] }] as never
  }
  const asked = (path = '/dashboards/{id}/items/{itemId}/data') => server.requests.filter((request) => request.path === path).map((request) => request.params?.itemId)
  const tab = (name: string) => screen.getByRole('tab', { name })
  const savedSpec = () => saves().at(-1)!.body.spec as { filters?: { targets: { item: string }[] }[]; layout: { items: Record<string, unknown>[] } }

  it('shows one tab at a time, asking for a tab’s data when it is first opened and keeping it after', async () => {
    tabbed()
    openViewer()
    await screen.findByText('Chart result')
    // Readers are not offered empty tabs.
    expect(screen.getAllByRole('tab').map((entry) => entry.textContent)).toEqual(['Orders', 'Revenue'])
    expect(tab('Orders').getAttribute('aria-selected')).toBe('true')
    expect(asked()).toEqual(['w1'])
    fireEvent.click(tab('Revenue'))
    await waitFor(() => expect(asked()).toEqual(['w1', 'w2']))
    expect(screen.getByRole('tabpanel', { name: 'Revenue' }).getAttribute('aria-hidden')).toBe('false')
    expect(screen.getByRole('button', { name: 'Note: Revenue' })).toBeTruthy()
    // Going back shows what it had.
    fireEvent.click(screen.getByRole('tab', { name: 'Orders' }))
    expect(screen.getByRole('tab', { name: 'Orders' }).getAttribute('aria-selected')).toBe('true')
    expect(asked()).toEqual(['w1', 'w2'])

    // Conditions changed, only the tab shown asks again; the other asks once it is opened.
    fireEvent.change(screen.getByRole('textbox', { name: 'Global amount' }), { target: { value: '200' } })
    await waitFor(() => expect(asked()).toEqual(['w1', 'w2', 'w1']))
    fireEvent.click(screen.getByRole('tab', { name: 'Revenue' }))
    await waitFor(() => expect(asked()).toEqual(['w1', 'w2', 'w1', 'w2']))
    // Refreshing the board asks only for what is shown.
    fireEvent.click(screen.getByRole('button', { name: 'Refresh data' }))
    await waitFor(() => expect(asked()).toHaveLength(5))
    expect(asked().at(-1)).toBe('w2')
  })

  it('moves between tabs from the keyboard', async () => {
    tabbed()
    openViewer()
    await screen.findByText('Chart result')
    act(() => tab('Orders').focus())
    fireEvent.keyDown(tab('Orders'), { key: 'ArrowRight' })
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Revenue' })))
    expect(screen.getByRole('tab', { name: 'Revenue' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Orders' }).getAttribute('aria-selected')).toBe('true'))
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Revenue' }).getAttribute('aria-selected')).toBe('true'))
  })

  it('makes a chart widget a tab container keeping its id, and fills the new tab from the library', async () => {
    server.behavior.role = 'developer'
    addRevenue()
    openEditor()
    await screen.findByText('Chart result')
    await chartAction('Add tabs: Orders')
    expect(screen.getAllByRole('tab').map((entry) => entry.textContent)).toEqual(['Orders', 'Empty tab'])
    expect(screen.getByRole('tab', { name: 'Empty tab' }).getAttribute('aria-selected')).toBe('true')
    await chartAction('Configure chart: Empty tab', 'Empty tab')
    const inspector = within(screen.getByRole('complementary', { name: 'Component properties' }))
    expect(inspector.getByText('Tab container')).toBeTruthy()
    fireEvent.click(inspector.getByRole('button', { name: 'Choose from the chart library' }))
    expect(screen.getByText('Click a chart to put it in “Empty tab”')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Put in the container Revenue' }))
    expect(await screen.findByRole('tab', { name: 'Revenue' })).toBeTruthy()
    fireEvent.click(saveButton())
    await waitFor(() => expect(saves()).toHaveLength(1))
    const [box] = savedSpec().layout.items
    expect(box).toMatchObject({ type: 'tabs', x: 0, y: 0, w: 6, h: 4, tabs: [{ id: 'w1', chartId: 'chart' }, { chartId: 'chart2' }] })
    expect(box!.id).not.toBe('w1')
    // The filter mapped to the chart is still mapped to it, in its tab.
    expect(savedSpec().filters?.[0]?.targets).toEqual([{ item: 'w1', field: 'amount' }])
  })

  it('names, fills and replaces the tab shown from the inspector and by dropping charts', async () => {
    server.behavior.role = 'developer'
    tabbed()
    openEditor()
    await screen.findByText('Chart result')
    // Arranging, empty tabs are offered too.
    expect(screen.getAllByRole('tab').map((entry) => entry.textContent)).toEqual(['Orders', 'Revenue', 'Empty tab'])
    fireEvent.click(screen.getByRole('tab', { name: 'Empty tab' }))
    act(() => grid().onDropInto('chart', 'w3'))
    expect(screen.queryByRole('dialog', { name: 'Replace chart' })).toBeNull()
    expect(screen.getAllByRole('tab').map((entry) => entry.textContent)).toEqual(['Orders', 'Revenue', 'Orders'])
    act(() => grid().onDropInto('chart2', 'w3'))
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Replace chart' })).getByRole('button', { name: 'Replace' }))
    expect(screen.getAllByRole('tab').map((entry) => entry.textContent)).toEqual(['Orders', 'Revenue', 'Revenue'])
    await chartAction('Configure chart: Revenue', 'Revenue')
    const inspector = within(screen.getByRole('complementary', { name: 'Component properties' }))
    // The tab shown is set right under the list of tabs.
    expect(inspector.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent).slice(0, 3)).toEqual(['Container', 'Current tab', 'Appearance'])
    fireEvent.change(inspector.getByRole('textbox', { name: 'Display name' }), { target: { value: 'Revenue again' } })
    expect(screen.getByRole('tab', { name: 'Revenue again' })).toBeTruthy()
    // The inspector follows the tab shown.
    fireEvent.click(inspector.getByRole('button', { name: 'Revenue' }))
    expect(inspector.getByRole<HTMLInputElement>('textbox', { name: 'Note' }).value).toBe('Paid only.')
    expect(screen.getByRole('tab', { name: 'Revenue' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(saveButton())
    await waitFor(() => expect(saves()).toHaveLength(1))
    expect(savedSpec().layout.items[0]!.tabs).toEqual([{ id: 'w1', chartId: 'chart' }, { id: 'w2', chartId: 'chart2', note: 'Paid only.' }, { id: 'w3', chartId: 'chart2', title: 'Revenue again' }])
  })

  it('removes tabs with what is mapped to them, and with one left is a chart widget again, undone in one step', async () => {
    server.behavior.role = 'developer'
    tabbed()
    openEditor()
    await screen.findByText('Chart result')
    await chartAction('Remove tab: Orders')
    const dialog = within(await screen.findByRole('dialog', { name: 'Remove tab' }))
    expect(dialog.getByText(/Remove the tab “Orders”\?/)).toBeTruthy()
    fireEvent.click(dialog.getByRole('button', { name: 'Remove tab' }))
    expect(screen.getAllByRole('tab').map((entry) => entry.textContent)).toEqual(['Revenue', 'Empty tab'])
    // The tab that took its place is shown.
    expect(screen.getByRole('tab', { name: 'Revenue' }).getAttribute('aria-selected')).toBe('true')
    await chartAction('Configure chart: Revenue', 'Revenue')
    const inspector = within(screen.getByRole('complementary', { name: 'Component properties' }))
    fireEvent.click(inspector.getByRole('button', { name: 'Remove tab: Empty tab' }))
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Remove tab' })).getByRole('button', { name: 'Remove tab' }))
    expect(screen.queryByRole('tab')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Revenue' })).toBeTruthy()
    fireEvent.click(saveButton())
    await waitFor(() => expect(saves()).toHaveLength(1))
    expect(savedSpec().layout.items).toEqual([{ id: 'w2', type: 'chart', chartId: 'chart2', note: 'Paid only.', x: 0, y: 0, w: 48, h: 32, frame: { border: false } }])
    expect(savedSpec().filters).toBeUndefined()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(screen.getAllByRole('tab').map((entry) => entry.textContent)).toEqual(['Revenue', 'Empty tab'])
  })

  it('opens on the tab shown first, unless that one is empty', async () => {
    tabbed()
    Object.assign(server.dashboard.spec.layout.items[0]!, { defaultTab: 'w2' })
    openViewer()
    await screen.findByText('Chart result')
    expect(tab('Revenue').getAttribute('aria-selected')).toBe('true')
    expect(asked()).toEqual(['w2'])
    cleanup()
    server.requests.length = 0
    Object.assign(server.dashboard.spec.layout.items[0]!, { defaultTab: 'w3' })
    openViewer()
    await screen.findByText('Chart result')
    expect(tab('Orders').getAttribute('aria-selected')).toBe('true')
  })

  it('makes a tab the one shown first by its star, and moves tabs by their handles without changing it', async () => {
    server.behavior.role = 'developer'
    tabbed()
    openEditor()
    await screen.findByText('Chart result')
    await chartAction('Configure chart: Orders')
    const inspector = within(screen.getByRole('complementary', { name: 'Component properties' }))
    const star = (name: string) => inspector.getByRole('button', { name: `Shown first: ${name}` })
    expect(star('Orders').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(star('Revenue'))
    expect(star('Revenue').getAttribute('aria-pressed')).toBe('true')
    expect(star('Orders').getAttribute('aria-pressed')).toBe('false')
    // The canvas goes on showing what it showed.
    expect(tab('Orders').getAttribute('aria-selected')).toBe('true')
    // From the keyboard, a tab moves one place at a time and keeps the focus.
    const grip = inspector.getByRole('button', { name: 'Move “Revenue”, 2 of 3' })
    act(() => grip.focus())
    fireEvent.keyDown(grip, { key: 'ArrowUp' })
    const moved = inspector.getByRole('button', { name: 'Move “Revenue”, 1 of 3' })
    await waitFor(() => expect(document.activeElement).toBe(moved))
    expect(screen.getAllByRole('tab').map((entry) => entry.textContent)).toEqual(['Revenue', 'Orders', 'Empty tab'])
    // Dragged by its handle, a tab goes before or after the row it is dropped on.
    const dataTransfer = { setData: () => undefined, setDragImage: () => undefined, effectAllowed: '', dropEffect: '' }
    const row = (name: string) => inspector.getByRole('button', { name: new RegExp(`^Move “${name}”`) }).closest('li')!
    fireEvent.dragStart(inspector.getByRole('button', { name: /^Move “Empty tab”/ }), { dataTransfer })
    fireEvent.dragOver(row('Revenue'), { dataTransfer, clientY: 0 })
    expect(row('Revenue').className).toContain('drop-before')
    fireEvent.drop(row('Revenue'), { dataTransfer, clientY: 0 })
    expect(screen.getAllByRole('tab').map((entry) => entry.textContent)).toEqual(['Empty tab', 'Revenue', 'Orders'])
    expect(star('Revenue').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(saveButton())
    await waitFor(() => expect(saves()).toHaveLength(1))
    expect(savedSpec().layout.items[0]).toMatchObject({ defaultTab: 'w2', tabs: [{ id: 'w3' }, { id: 'w2' }, { id: 'w1' }] })
    // Each change is a step of its own to undo.
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(screen.getAllByRole('tab').map((entry) => entry.textContent)).toEqual(['Revenue', 'Orders', 'Empty tab'])
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(star('Orders').getAttribute('aria-pressed')).toBe('true')
  })

  it('takes a chart dragged onto its tabs as a new tab where it is let go', async () => {
    server.behavior.role = 'developer'
    tabbed()
    openEditor()
    await screen.findByText('Chart result')
    const bar = () => screen.getByRole('tablist').closest<HTMLElement>('.widget-tab-bar')!
    const chart = { types: ['application/x-supabi-chart'] }
    // An empty box dragged from the library is not taken in among the tabs.
    fireEvent.dragEnter(bar(), { dataTransfer: { types: ['application/x-supabi-chart', 'application/x-supabi-empty-chart'] } })
    expect(bar().className).not.toContain('drop-over')
    // Over the tabs, a line shows where the chart would go: here before the first. (Drag events here carry no pointer position of their own.)
    const over = createEvent.dragOver(bar(), { dataTransfer: chart })
    Object.defineProperty(over, 'clientX', { value: -1 })
    fireEvent.dragEnter(bar(), { dataTransfer: chart })
    fireEvent(bar(), over)
    expect(bar().className).toContain('drop-over')
    expect(bar().querySelector('.widget-tab-insert')).toBeTruthy()
    expect(bar().dataset.dropInto).toBe('tabs:w5:0')
    // The grid takes the drop; the browser then tells the window the drag is over.
    act(() => grid().onDropInto('chart2', bar().dataset.dropInto!))
    act(() => { window.dispatchEvent(new Event('drop')) })
    expect(bar().className).not.toContain('drop-over')
    expect(screen.getAllByRole('tab').map((entry) => entry.textContent)).toEqual(['Revenue', 'Orders', 'Revenue', 'Empty tab'])
    // The new tab is shown, and the one shown first is still the first that was.
    expect(screen.getAllByRole('tab')[0]!.getAttribute('aria-selected')).toBe('true')
    // Moved off the tabs, or let go elsewhere, they are no longer lit up.
    fireEvent.dragEnter(bar(), { dataTransfer: chart })
    expect(bar().className).toContain('drop-over')
    fireEvent.dragLeave(bar(), { dataTransfer: chart })
    expect(bar().className).not.toContain('drop-over')
    fireEvent.dragEnter(bar(), { dataTransfer: chart })
    act(() => { window.dispatchEvent(new Event('dragend')) })
    expect(bar().className).not.toContain('drop-over')
    expect(bar().querySelector('.widget-tab-insert')).toBeNull()
    // Let go right of every tab, it goes last.
    fireEvent.dragEnter(bar(), { dataTransfer: chart })
    fireEvent.dragOver(bar(), { dataTransfer: chart })
    act(() => grid().onDropInto('chart', bar().dataset.dropInto!))
    expect(screen.getAllByRole('tab').map((entry) => entry.textContent)).toEqual(['Revenue', 'Orders', 'Revenue', 'Empty tab', 'Orders'])
    fireEvent.click(saveButton())
    await waitFor(() => expect(saves()).toHaveLength(1))
    const box = savedSpec().layout.items[0]!
    expect(box.defaultTab).toBe('w1')
    expect((box.tabs as { chartId?: string }[]).map((tab) => tab.chartId)).toEqual(['chart2', 'chart', 'chart2', undefined, 'chart'])
    // Each drop is a step of its own to undo.
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(screen.getAllByRole('tab')).toHaveLength(4)
  })

  it('takes no more charts onto tabs that are full', async () => {
    server.behavior.role = 'developer'
    tabbed()
    const box = server.dashboard.spec.layout.items[0] as unknown as { tabs: { id: string }[] }
    box.tabs = Array.from({ length: 20 }, (_, index) => ({ id: `t${index}`, chartId: 'chart' }))
    openEditor()
    await screen.findByText('Chart result')
    const bar = () => screen.getByRole('tablist').closest<HTMLElement>('.widget-tab-bar')!
    fireEvent.dragEnter(bar(), { dataTransfer: { types: ['application/x-supabi-chart'] } })
    expect(within(bar()).getByText('Up to 20 tabs')).toBeTruthy()
    expect(bar().querySelector('.widget-tab-insert')).toBeNull()
    act(() => grid().onDropInto('chart2', bar().dataset.dropInto!))
    expect(screen.getAllByRole('tab')).toHaveLength(20)
    expect(saveButton().disabled).toBe(true)
  })

  it('leaves empty tabs out of the preview, and is blank with none filled', async () => {
    server.behavior.role = 'developer'
    tabbed()
    openEditor()
    await screen.findByText('Chart result')
    fireEvent.click(screen.getByRole('tab', { name: 'Empty tab' }))
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(screen.getAllByRole('tab').map((entry) => entry.textContent)).toEqual(['Orders', 'Revenue'])
    expect(screen.getByRole('tab', { name: 'Orders' }).getAttribute('aria-selected')).toBe('true')
    expect(asked('/dashboards/preview/items/{itemId}/data')).not.toContain('w2')
  })
})

describe('asking for data as charts come near', () => {
  /** Stands in for the browser, which says when an element comes within the margin of the area it scrolls in. */
  class Observer {
    static all: Observer[] = []
    readonly targets = new Set<Element>()
    constructor(readonly callback: IntersectionObserverCallback, readonly options: IntersectionObserverInit = {}) { Observer.all.push(this) }
    observe(target: Element) { this.targets.add(target) }
    unobserve(target: Element) { this.targets.delete(target) }
    disconnect() { this.targets.clear() }
    takeRecords() { return [] }
  }
  const watching = () => Observer.all.filter((observer) => observer.targets.size > 0)
  const comeNear = (name: string) => {
    const target = screen.getByRole('article', { name })
    act(() => {
      for (const observer of watching()) if (observer.targets.has(target)) observer.callback([{ target, isIntersecting: true } as unknown as IntersectionObserverEntry], observer as unknown as IntersectionObserver)
    })
  }
  const dataPath = '/dashboards/{id}/items/{itemId}/data'
  const asked = (path = dataPath) => server.requests.filter((request) => request.path === path).map((request) => request.params?.itemId)
  const lastAsked = () => server.requests.filter((request) => request.path === dataPath).at(-1)!
  const furtherDown = () => server.dashboard.spec.layout.items.push({ id: 'w2', type: 'chart', chartId: 'chart', x: 0, y: 40, w: 6, h: 4, title: 'Further down' } as never)
  // The charts on the first screen, by name; the others are far below it.
  let firstScreen: string[] = []
  beforeEach(() => {
    Observer.all = []
    firstScreen = []
    vi.stubGlobal('IntersectionObserver', Observer)
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const far = this.matches('article.widget') && !firstScreen.includes(this.getAttribute('aria-label') ?? '')
      return { x: 0, y: far ? 10_000 : 0, top: far ? 10_000 : 0, left: 0, bottom: far ? 10_100 : 800, right: 1000, width: 1000, height: far ? 100 : 800, toJSON: () => ({}) }
    })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('asks at once for the charts on the first screen, without waiting for the browser to say where they are', async () => {
    // A board opened in a tab in the background, which the browser does not draw.
    furtherDown()
    firstScreen = ['Orders']
    openViewer()
    await within(await screen.findByRole('article', { name: 'Orders' })).findByText('Chart result')
    expect(asked()).toEqual(['w1'])
    expect(within(screen.getByRole('article', { name: 'Further down' })).getByText('Loading…')).toBeTruthy()
    expect(watching().flatMap((observer) => [...observer.targets].map((target) => target.getAttribute('aria-label')))).toEqual(['Further down'])
  })

  it('asks for a chart’s data once it comes within a screen, and the toolbar counts only the charts that have asked', async () => {
    furtherDown()
    server.behavior.meta = () => ({ cached: false, cachedAt: new Date().toISOString() })
    openViewer()
    const further = within(await screen.findByRole('article', { name: 'Further down' }))
    const orders = within(screen.getByRole('article', { name: 'Orders' }))
    // Not near yet, nothing is asked for; the chart looks as if loading, but the toolbar does not say so.
    expect(asked()).toEqual([])
    expect(further.getByText('Loading…')).toBeTruthy()
    expect(screen.queryByText('Loading data…')).toBeNull()
    expect(screen.queryByText(/^Data as of/)).toBeNull()

    comeNear('Orders')
    await orders.findByText('Chart result')
    expect(asked()).toEqual(['w1'])
    // The toolbar hears from the chart once it is drawn.
    expect(await screen.findByText(/^Data as of/)).toBeTruthy()
    expect(screen.queryByText('Loading data…')).toBeNull()

    // Asked once, a chart keeps up with the board; one not yet near goes on waiting.
    fireEvent.click(screen.getByRole('button', { name: 'Refresh data' }))
    await waitFor(() => expect(asked()).toEqual(['w1', 'w1']))
    expect(further.getByText('Loading…')).toBeTruthy()

    // Refreshed before it came near, its first answer is from the database too.
    comeNear('Further down')
    await further.findByText('Chart result')
    expect(asked()).toEqual(['w1', 'w1', 'w2'])
    expect(lastAsked().body).toMatchObject({ refresh: true })
    // Both have asked: nothing is watched any more.
    expect(watching()).toHaveLength(0)
  })

  it('asks, once near, for the conditions chosen meanwhile', async () => {
    furtherDown()
    openViewer()
    const further = within(await screen.findByRole('article', { name: 'Further down' }))
    comeNear('Orders')
    await waitFor(() => expect(asked()).toEqual(['w1']))
    fireEvent.change(further.getByRole('textbox', { name: 'Chart name' }), { target: { value: 'Bob' } })
    // Past the pause before a typed value counts.
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)))
    expect(asked()).toEqual(['w1'])
    comeNear('Further down')
    await waitFor(() => expect(asked()).toEqual(['w1', 'w2']))
    expect(lastAsked().body.chartFilters).toEqual({ name_local: 'Bob' })
    expect(lastAsked().body.refresh).toBeUndefined()
  })

  /** A page the board scrolls in, which says so, as the dashboards page does. */
  function Page() {
    const content = useRef<HTMLDivElement>(null)
    const area = useArea(useCallback(() => content.current, []))
    return <div ref={content} className="page"><ScrollArea value={area}><DashboardView colorScheme="light" /></ScrollArea></div>
  }

  it('watches the area the board scrolls in: the page it is on, the board itself in full screen, and the canvas while arranging', async () => {
    furtherDown()
    const router = createMemoryRouter([{ path: '/dashboards/:id', element: <Page /> }], { initialEntries: ['/dashboards/board'] })
    render(<RouterProvider router={router} />)
    await screen.findByRole('article', { name: 'Orders' })
    // One observer for the board, a screen's worth on every side of what the area shows.
    expect(watching().map((observer) => observer.options)).toEqual([{ root: document.querySelector('.page'), rootMargin: '100%' }])
    expect(watching()[0]!.targets.size).toBe(2)
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }))
    await waitFor(() => expect(watching().map((observer) => observer.options.root)).toEqual([document.querySelector('.board-view.fullscreen')]))
    // Leaving full screen, the board scrolls in the page again.
    fireEvent.click(screen.getByRole('button', { name: 'Exit full screen' }))
    await waitFor(() => expect(watching().map((observer) => observer.options.root)).toEqual([document.querySelector('.page')]))
    expect(asked()).toEqual([])
    cleanup()

    Observer.all = []
    openEditor()
    await screen.findByRole('article', { name: 'Orders' })
    expect(watching().map((observer) => observer.options.root)).toEqual([document.querySelector('.dashboard-canvas-scroll')])
    expect(previewQueries()).toHaveLength(0)
    comeNear('Orders')
    await waitFor(() => expect(asked('/dashboards/preview/items/{itemId}/data')).toEqual(['w1']))
  })

  it('asks for the tab a tab container shows once the container is near, and for another when it is opened', async () => {
    server.dashboard.charts.push({ ...structuredClone(server.dashboard.charts[0]!), id: 'chart2', name: 'Revenue' })
    server.dashboard.spec.layout.items = [{ id: 'w5', type: 'tabs', x: 0, y: 0, w: 48, h: 32, tabs: [{ id: 'w1', chartId: 'chart' }, { id: 'w2', chartId: 'chart2' }] }] as never
    openViewer()
    await screen.findByRole('tab', { name: 'Orders' })
    expect(asked()).toEqual([])
    comeNear('Orders')
    await waitFor(() => expect(asked()).toEqual(['w1']))
    fireEvent.click(screen.getByRole('tab', { name: 'Revenue' }))
    comeNear('Revenue')
    await waitFor(() => expect(asked()).toEqual(['w1', 'w2']))
  })

  it('asks for a chart’s own lists only once it is near, and marks it busy until then', async () => {
    furtherDown()
    Object.assign(server.dashboard.charts[0]!.spec.filters[1]!, { op: 'in', value: ['Alice'], control: { type: 'select' } })
    server.behavior.options = () => ({ values: ['Alice', 'Bob'], truncated: false })
    const listed = () => asked('/dashboards/{id}/items/{itemId}/filters/{filterId}/options')
    openViewer()
    const further = await screen.findByRole('article', { name: 'Further down' })
    expect(further.getAttribute('aria-busy')).toBe('true')
    comeNear('Orders')
    const orders = screen.getByRole('article', { name: 'Orders' })
    await within(orders).findByText('Chart result')
    await waitFor(() => expect(listed()).toContain('w1'))
    expect(orders.getAttribute('aria-busy')).toBe('false')
    expect(listed()).not.toContain('w2')

    // Refreshing the board asks again for the lists of the charts that are near, and only theirs.
    const before = listed().length
    fireEvent.click(screen.getByRole('button', { name: 'Refresh data' }))
    await waitFor(() => expect(listed().length).toBeGreaterThan(before))
    expect(listed()).not.toContain('w2')
    comeNear('Further down')
    await waitFor(() => expect(listed()).toContain('w2'))
    expect(further.getAttribute('aria-busy')).toBe('false')
  })

  it('asks, once near, for data no older than a timed refresh since allows', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    Object.assign(server.dashboard.spec, { autoRefresh: 60 })
    furtherDown()
    openViewer()
    await screen.findByRole('article', { name: 'Further down' })
    comeNear('Orders')
    await waitFor(() => expect(asked()).toEqual(['w1']))
    await act(() => vi.advanceTimersByTimeAsync(60_000))
    await waitFor(() => expect(asked()).toEqual(['w1', 'w1']))
    comeNear('Further down')
    await waitFor(() => expect(asked()).toEqual(['w1', 'w1', 'w2']))
    expect(lastAsked().body).toMatchObject({ maxAge: 54 })
    expect(lastAsked().body.refresh).toBeUndefined()
  })
})

describe('dashboard pages', () => {
  const asked = () => server.requests.filter((request) => request.path === '/dashboards/{id}/items/{itemId}/data').map((request) => request.params?.itemId)
  const viewRequests = () => server.requests.filter(({ path }) => path === '/dashboards/{id}/views')
  const page = (name: string) => screen.getByRole('tab', { name })
  const savedSpec = () => saves().at(-1)!.body.spec as { filters?: { id: string; targets: { item: string }[] }[]; queryContainer?: Record<string, unknown>; layout: { pages?: { id: string; name: string }[]; items: Record<string, unknown>[] } }
  // A title above the tabs; Orders on the first page and Revenue on the second. The global amount reaches both, and one filter only Revenue.
  const split = () => {
    server.dashboard.charts.push({ ...structuredClone(server.dashboard.charts[0]!), id: 'chart2', name: 'Revenue' })
    Object.assign(server.dashboard.spec, {
      layout: { columns: 96, pages: [{ id: 'p1', name: 'Overview' }, { id: 'p2', name: 'Channels' }], items: [
        { id: 'w9', type: 'title', x: 0, y: 0, w: 96, h: 8, title: 'All pages' },
        { id: 'w1', type: 'chart', chartId: 'chart', page: 'p1', x: 0, y: 0, w: 48, h: 32 },
        { id: 'w2', type: 'chart', chartId: 'chart2', page: 'p2', x: 0, y: 0, w: 48, h: 32 },
      ] },
      queryContainer: { x: 0, y: 8, w: 96, h: 8 },
      filters: [
        { id: 'amount_global', label: 'Global amount', op: 'gte', control: { type: 'number' }, default: 100, targets: [{ item: 'w1', field: 'amount' }, { item: 'w2', field: 'amount' }] },
        { id: 'revenue_only', label: 'Revenue amount', op: 'gte', control: { type: 'number' }, targets: [{ item: 'w2', field: 'amount' }] },
      ],
    })
  }
  function openAt(path: string) {
    const router = createMemoryRouter([{ path: '/dashboards/:id', element: <DashboardView colorScheme="light" /> }], { initialEntries: [path] })
    render(<UnsavedChangesProvider><RouterProvider router={router} /></UnsavedChangesProvider>)
    return router
  }

  it('shows what is above the tabs on every page, and asks for a page’s charts when it is first opened', async () => {
    split()
    const router = openAt('/dashboards/board')
    await screen.findByText('Chart result')
    expect(screen.getByRole('heading', { name: 'All pages' })).toBeTruthy()
    expect(screen.getAllByRole('tab').map((entry) => entry.textContent)).toEqual(['Overview', 'Channels'])
    expect(page('Overview').getAttribute('aria-selected')).toBe('true')
    expect(asked()).toEqual(['w1'])
    expect(document.title).toBe('Board - Overview - SupaBI')
    // Each page shows the filters of its charts.
    expect(screen.getByRole('textbox', { name: 'Global amount' })).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'Revenue amount' })).toBeNull()

    fireEvent.click(page('Channels'))
    await waitFor(() => expect(asked()).toEqual(['w1', 'w2']))
    expect(screen.getByRole('tabpanel', { name: 'Channels' }).getAttribute('aria-hidden')).toBe('false')
    expect(screen.getAllByRole('tabpanel', { hidden: true }).map((panel) => [panel.getAttribute('aria-label'), panel.getAttribute('aria-hidden')])).toEqual([['Overview', 'true'], ['Channels', 'false']])
    expect(screen.getByRole('textbox', { name: 'Revenue amount' })).toBeTruthy()
    expect(document.title).toBe('Board - Channels - SupaBI')
    expect(router.state.location.search).toBe('?page=p2')

    // A filter on every page has one value: changed here, the page out of sight asks once it is opened again.
    fireEvent.change(screen.getByRole('textbox', { name: 'Global amount' }), { target: { value: '200' } })
    await waitFor(() => expect(asked()).toEqual(['w1', 'w2', 'w2']))
    fireEvent.click(page('Overview'))
    await waitFor(() => expect(asked()).toEqual(['w1', 'w2', 'w2', 'w1']))
    expect(router.state.location.search).toBe('')
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Global amount' }).value).toBe('200')
    // Refreshing asks for what is in view only.
    fireEvent.click(screen.getByRole('button', { name: 'Refresh data' }))
    await waitFor(() => expect(asked()).toHaveLength(5))
    expect(asked().at(-1)).toBe('w1')
  })

  it('opens on the page the address names, and carries it in a share link', async () => {
    split()
    openAt('/dashboards/board?page=p2')
    await screen.findByText('Chart result')
    expect(page('Channels').getAttribute('aria-selected')).toBe('true')
    expect(asked()).toEqual(['w2'])
    fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    const dialog = within(await screen.findByRole('dialog', { name: 'Share dashboard' }))
    fireEvent.click(dialog.getByRole('checkbox', { name: 'Include the current conditions' }))
    await waitFor(() => expect(viewRequests()[0]!.body).toEqual({ state: { page: 'p2' }, validDays: 30 }))
    expect(within(dialog.getByRole('list', { name: 'Conditions to include' })).getByText('Page: Channels')).toBeTruthy()
    cleanup()

    // Opened from the link, the dashboard shows that page; a page it no longer has is dropped.
    server.requests.length = 0
    server.behavior.views.set('dv_shared', { page: 'p2' })
    openAt('/dashboards/board?ws=ws_main&view=dv_shared')
    await screen.findByText('Chart result')
    expect(page('Channels').getAttribute('aria-selected')).toBe('true')
    cleanup()
    server.behavior.views.set('dv_shared', { page: 'gone' })
    openAt('/dashboards/board?ws=ws_main&view=dv_shared')
    await screen.findByText('Chart result')
    expect(page('Overview').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('Some of the shared conditions no longer apply; the rest are applied.')).toBeTruthy()
  })

  it('shows no query container on a page none of whose charts is filtered', async () => {
    split()
    server.dashboard.spec.filters = [server.dashboard.spec.filters[1]!]
    openAt('/dashboards/board')
    await screen.findByText('Chart result')
    expect(screen.queryByRole('region', { name: 'Query container' })).toBeNull()
    fireEvent.click(page('Channels'))
    expect(await screen.findByRole('textbox', { name: 'Revenue amount' })).toBeTruthy()
  })

  it('splits a dashboard into pages, the title and the query container going above the tabs', async () => {
    server.behavior.role = 'developer'
    server.dashboard.spec.layout.items.unshift({ id: 'w9', type: 'title', x: 0, y: 0, w: 96, h: 8, title: 'All pages' } as never)
    server.dashboard.spec.layout.items[1]!.y = 16
    Object.assign(server.dashboard.spec, { queryContainer: { x: 0, y: 8, w: 96, h: 8 } })
    openEditor()
    await screen.findByText('Chart result')
    fireEvent.click(screen.getByRole('button', { name: 'Split into pages' }))
    expect(screen.getAllByRole('tab').map((entry) => entry.textContent)).toEqual(['Page 1', 'Page 2'])
    // The new page is shown, empty, and the title is still in view above the tabs.
    expect(page('Page 2').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('heading', { name: 'All pages' })).toBeTruthy()
    expect(document.title).toBe('Board - Page 2 - SupaBI')
    // Another page, from the plus beside the tabs.
    const tools = within(screen.getByRole('navigation', { name: 'Dashboard editing tools' }))
    expect(tools.getByRole('button', { name: 'Add page' })).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'Add page' }).find((button) => !tools.queryAllByRole('button').includes(button))!)
    expect(screen.getAllByRole('tab').map((entry) => entry.textContent)).toEqual(['Page 1', 'Page 2', 'Page 3'])
    fireEvent.click(saveButton())
    await waitFor(() => expect(saves()).toHaveLength(1))
    const spec = savedSpec()
    expect(spec.layout.pages?.map((entry) => entry.name)).toEqual(['Page 1', 'Page 2', 'Page 3'])
    expect(spec.queryContainer).toMatchObject({ x: 0, y: 8 })
    expect(spec.layout.items).toEqual([
      { id: 'w9', type: 'title', x: 0, y: 0, w: 96, h: 8, title: 'All pages' },
      { id: 'w1', type: 'chart', chartId: 'chart', page: spec.layout.pages![0]!.id, x: 0, y: 0, w: 6, h: 4 },
    ])
    // Ids are unique among widgets and pages.
    expect(new Set([...spec.layout.items.map((item) => item.id), ...spec.layout.pages!.map((entry) => entry.id)]).size).toBe(5)
    // Splitting is one step to undo.
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(screen.queryByRole('tab')).toBeNull()
  })

  it('adds charts to the page shown, moves them to another page, and names and removes pages', async () => {
    server.behavior.role = 'developer'
    split()
    openEditor()
    await screen.findByText('Chart result')
    fireEvent.click(page('Channels'))
    fireEvent.click(screen.getByRole('button', { name: 'Charts' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Add chart Orders' }))
    // The page out of sight keeps its own.
    expect(await within(screen.getByRole('tabpanel', { name: 'Channels' })).findByRole('article', { name: 'Orders' })).toBeTruthy()
    // Moved to the first page, it is no longer on this one.
    const card = within(screen.getByRole('article', { name: 'Revenue' }))
    fireEvent.click(card.getByRole('button', { name: 'More chart actions: Revenue' }))
    openPopup(card.getByRole('button', { name: 'Move to' }))
    expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual(['Shared area', 'Overview'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Overview' }))
    await waitFor(() => expect(within(screen.getByRole('tabpanel', { name: 'Channels' })).queryByRole('article', { name: 'Revenue' })).toBeNull())

    // Pages are named and removed in their own panel.
    fireEvent.click(screen.getByRole('button', { name: 'Manage pages' }))
    const inspector = within(screen.getByRole('complementary', { name: 'Pages' }))
    fireEvent.change(inspector.getByRole('textbox', { name: 'Name of page 2' }), { target: { value: 'Sales' } })
    expect(page('Sales')).toBeTruthy()
    fireEvent.click(inspector.getByRole('button', { name: 'Delete page: Sales' }))
    const dialog = within(await screen.findByRole('dialog', { name: 'Delete page' }))
    expect(dialog.getByText(/The 1 component on it is removed with it/)).toBeTruthy()
    fireEvent.click(dialog.getByRole('button', { name: 'Delete page' }))
    // With one page left the dashboard is not split: what is above the tabs is on top, and the last page follows.
    expect(screen.queryByRole('tab')).toBeNull()
    fireEvent.click(saveButton())
    await waitFor(() => expect(saves()).toHaveLength(1))
    const spec = savedSpec()
    expect(spec.layout.pages).toBeUndefined()
    expect(spec.layout.items.map((item) => [item.id, item.page, item.y])).toEqual([['w9', undefined, 0], ['w1', undefined, 16], ['w2', undefined, 48]])
    // The filter mapped to the chart removed with its page is no longer.
    expect(spec.filters?.map((filter) => filter.id)).toEqual(['amount_global', 'revenue_only'])
    expect(spec.filters?.[0]?.targets.map((target) => target.item)).toEqual(['w1', 'w2'])
  })

  it('moves a widget dragged from the page shown into the area above the tabs where it was let go, as one step to undo', async () => {
    server.behavior.role = 'developer'
    split()
    openEditor()
    await screen.findByText('Chart result')
    // What is above the tabs and the page shown are dragged between; a page out of sight is not.
    expect(server.grid.groups).toMatchObject({ w9: '', w1: 'p1' })
    expect(server.grid.groups.w2).toBeUndefined()
    // Let go below the title, where the query container was: it moved down to make room.
    act(() => server.grid.move!({ id: 'w1', from: 'p1', to: '', items: [
      { id: 'query-container', x: 0, y: 40, w: 96, h: 8 },
      { id: 'w9', x: 0, y: 0, w: 96, h: 8 },
      { id: 'w1', x: 0, y: 8, w: 48, h: 32 },
    ] }))
    expect(within(screen.getByRole('region', { name: 'Shared area' })).getByRole('article', { name: 'Orders' })).toBeTruthy()
    expect(within(screen.getByRole('tabpanel', { name: 'Overview' })).queryByRole('article', { name: 'Orders' })).toBeNull()

    fireEvent.click(saveButton())
    await waitFor(() => expect(saves()).toHaveLength(1))
    const spec = savedSpec()
    expect(spec.layout.items).toEqual([
      { id: 'w9', type: 'title', x: 0, y: 0, w: 96, h: 8, title: 'All pages' },
      { id: 'w1', type: 'chart', chartId: 'chart', x: 0, y: 8, w: 48, h: 32 },
      { id: 'w2', type: 'chart', chartId: 'chart2', page: 'p2', x: 0, y: 0, w: 48, h: 32 },
    ])
    expect(spec.queryContainer).toEqual({ x: 0, y: 40, w: 96, h: 8 })
    // Mapped by id, its filters go with it.
    expect(spec.filters?.map((filter) => filter.targets.map((target) => target.item))).toEqual([['w1', 'w2'], ['w2']])

    // One step undoes it: the chart is back on its page, the query container where it was.
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(within(screen.getByRole('tabpanel', { name: 'Overview' })).getByRole('article', { name: 'Orders' })).toBeTruthy()
    fireEvent.click(saveButton())
    await waitFor(() => expect(saves()).toHaveLength(2))
    expect(savedSpec().layout.items.find((entry) => entry.id === 'w1')).toEqual({ id: 'w1', type: 'chart', chartId: 'chart', page: 'p1', x: 0, y: 0, w: 48, h: 32 })
    expect(savedSpec().queryContainer).toEqual({ x: 0, y: 8, w: 96, h: 8 })
  })
})
