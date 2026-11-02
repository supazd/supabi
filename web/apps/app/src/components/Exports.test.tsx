import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from 'i18next'
import '../i18n'
import type { Schemas } from '../api/client'

type RequestOptions = { body?: unknown; signal?: AbortSignal; params?: { path?: Record<string, string>; query?: { before?: string } } }
type MockOutcome = { data?: unknown; error?: unknown; response: { ok: boolean; status?: number; statusText?: string } }
type HistoryPage = { items: Schemas['Export'][]; nextBefore?: string }

const server = vi.hoisted(() => ({
  calls: [] as { path: string; body?: unknown; params?: unknown }[],
  items: [] as Schemas['Export'][],
  nextBefore: undefined as string | undefined,
  pages: {} as Record<string, HistoryPage>,
  get: vi.fn<(path: string, options?: RequestOptions) => Promise<MockOutcome>>(),
  post: vi.fn<(path: string, options?: RequestOptions) => Promise<MockOutcome>>(),
}))
vi.mock('../api/client', async (original) => {
  const real = await original<typeof import('../api/client')>()
  return { ...real, api: { GET: server.get, POST: server.post } }
})

import { ChartExportDialog, ExportCenter, SqlExportDialog, exportFileName } from './Exports'

const response = (data: unknown): Promise<MockOutcome> => Promise.resolve({ data, response: { ok: true } })
const page = (history: HistoryPage): Schemas['ExportPage'] => ({ ...history, unseen: history.items.filter((item) => item.unseen).length, maxRows: 2000000, maxBytes: 536870912, retentionSeconds: 86400, timeoutSeconds: 900 })
const ready = (id: string, name = id): Schemas['Export'] => ({ id, name, format: 'xlsx', source: 'sql', status: 'succeeded', createdAt: '2026-10-18T10:00:00Z', expiresAt: '2099-10-19T10:00:00Z', rows: 2001, sizeBytes: 23456, cancelRequested: false, unseen: false })

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  server.calls = []; server.items = []; server.nextBefore = undefined; server.pages = {}
  server.get.mockReset().mockImplementation((_path, options) => {
    const before = options?.params?.query?.before
    return response(page(before ? server.pages[before] ?? { items: [] } : { items: server.items, nextBefore: server.nextBefore }))
  })
  server.post.mockReset().mockImplementation((path, options) => {
    server.calls.push({ path, body: options?.body, params: options?.params })
    if (path === '/exports/seen') server.items = server.items.map((item) => ({ ...item, unseen: false }))
    return path === '/exports/seen' ? Promise.resolve({ response: { ok: true } }) : response(ready('exp_new'))
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('export dialogs', () => {
  it('submits the SQL and parameter snapshot with XLSX by default', async () => {
    const close = vi.fn()
    const request = { datasourceId: 'source', sql: 'SELECT {{n}}', params: [{ name: 'n', type: 'integer', default: 7 }], name: 'Orders' }
    render(<SqlExportDialog request={request} onClose={close} />)
    const start = await screen.findByRole('button', { name: 'Start export' })
    await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false))
    fireEvent.click(start)
    await waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(server.calls).toEqual([{ path: '/exports', body: { ...request, format: 'xlsx' }, params: undefined }])
  })

  it('also submits CSV without exporting only the preview rows', async () => {
    render(<SqlExportDialog request={{ datasourceId: 'source', sql: 'SELECT * FROM orders', name: 'Orders' }} onClose={() => undefined} />)
    const select = screen.getByRole('combobox', { name: 'File format' })
    fireEvent.pointerDown(select, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    fireEvent.click(await screen.findByRole('option', { name: 'CSV file (.csv)' }))
    const start = screen.getByRole('button', { name: 'Start export' })
    await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false))
    fireEvent.click(start)
    await waitFor(() => expect(server.calls[0]?.body).toEqual({ datasourceId: 'source', sql: 'SELECT * FROM orders', name: 'Orders', format: 'csv' }))
  })

  it('exports a widget with its current values and the page’s column names', async () => {
    const close = vi.fn()
    const request = { filters: { g_region: ['East'] }, chartFilters: {}, selections: { metric: 'avg' }, useChartFilters: false, links: {}, headers: { month: 'Month' } }
    render(<ChartExportDialog dashboardId="db_1" itemId="w1" name="Sales - Revenue" request={request} onClose={close} />)
    expect(screen.getByRole('dialog', { name: 'Export chart data' })).toBeTruthy()
    expect((screen.getByRole('textbox', { name: 'File name' }) as HTMLInputElement).value).toBe('Sales - Revenue')
    const start = screen.getByRole('button', { name: 'Start export' })
    await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false))
    fireEvent.click(start)
    await waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(server.calls).toEqual([{ path: '/dashboards/{id}/items/{itemId}/exports', params: { path: { id: 'db_1', itemId: 'w1' } }, body: { ...request, name: 'Sales - Revenue', format: 'xlsx' } }])
  })
})

describe('suggested file names', () => {
  it('replaces what the server would refuse, so the export does not fail on its default name', () => {
    expect(exportFileName('华东/华南 \\ 销售\n仪表盘')).toBe('华东-华南 - 销售 仪表盘')
    expect(exportFileName('x'.repeat(130))).toHaveLength(120)
  })

  it('suggests a chart export name that can be submitted as it is', () => {
    render(<ChartExportDialog dashboardId="db_1" itemId="w1" name="East/West - Revenue" request={{}} onClose={() => undefined} />)
    expect((screen.getByRole('textbox', { name: 'File name' }) as HTMLInputElement).value).toBe('East-West - Revenue')
  })
})

describe('export center', () => {
  it('lists every source, marks new results seen when opened, and offers only allowed downloads', async () => {
    const item = ready('exp_ready', 'Ready')
    server.items = [
      { ...item, unseen: true },
      { ...item, id: 'exp_chart', name: 'Chart', source: 'chart', dashboardName: 'Sales', chartName: 'Revenue', unseen: true, denied: 'export_chart_disabled' },
      { ...item, id: 'exp_running', name: 'Running', status: 'running' },
      { ...item, id: 'exp_expired', name: 'Expired', status: 'expired' },
    ]
    render(<ExportCenter disabled={false} />)
    await screen.findByLabelText('New results: 2')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Exports' })) })
    const readyItem = await screen.findByRole('article', { name: 'Ready.xlsx' })
    expect(within(readyItem).getByText('Data exploration')).toBeTruthy()
    expect(within(readyItem).getByText('New')).toBeTruthy()
    expect(within(readyItem).getByRole('link', { name: 'Download' }).getAttribute('href')).toBe('/api/v1/exports/exp_ready/file')
    expect(within(readyItem).getByRole('link', { name: 'Download' }).getAttribute('download')).toBe('Ready.xlsx')
    const chart = screen.getByRole('article', { name: 'Chart.xlsx' })
    expect(within(chart).getByText('Sales / Revenue')).toBeTruthy()
    expect(within(chart).getByText('Cannot download: the chart no longer allows exports.')).toBeTruthy()
    expect(within(chart).queryByRole('link', { name: 'Download' })).toBeNull()
    expect(within(screen.getByRole('article', { name: 'Expired.xlsx' })).queryByRole('link', { name: 'Download' })).toBeNull()
    await waitFor(() => expect(server.calls.some((call) => call.path === '/exports/seen')).toBe(true))
    await waitFor(() => expect(screen.queryByLabelText('New results: 2')).toBeNull())
    // What was new stays marked while the list is open.
    expect(within(screen.getByRole('article', { name: 'Ready.xlsx' })).getByText('New')).toBeTruthy()
    fireEvent.click(within(screen.getByRole('article', { name: 'Running.xlsx' })).getByRole('button', { name: 'Cancel task' }))
    await waitFor(() => expect(server.calls.some((call) => call.path === '/exports/{id}/cancel')).toBe(true))
  })

  it('announces a result that arrives later without marking it seen', async () => {
    server.items = [{ ...ready('exp_running', 'Orders'), status: 'running' }]
    render(<ExportCenter disabled={false} />)
    await waitFor(() => expect(server.get).toHaveBeenCalled())
    server.items = [{ ...ready('exp_running', 'Orders'), status: 'failed', errorCode: 'export_row_limit', unseen: true }]
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await screen.findByText('Orders.xlsx failed to export')
    expect(screen.getByLabelText('New results: 1')).toBeTruthy()
    expect(server.calls.some((call) => call.path === '/exports/seen')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'View' }))
    await screen.findByText('The result exceeds the export row limit. Filter the data and retry.')
    await waitFor(() => expect(server.calls.some((call) => call.path === '/exports/seen')).toBe(true))
  })

  it('keeps history pagination', async () => {
    server.items = Array.from({ length: 50 }, (_, i) => ready(`exp_${i}`))
    server.nextBefore = '2026-10-17T10:00:00Z'
    const older = ready('exp_older', 'Older export')
    server.pages[server.nextBefore] = { items: [ready('exp_50'), older] }
    render(<ExportCenter disabled={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Exports' }))
    const more = await screen.findByRole('button', { name: 'Load more' })
    await waitFor(() => expect(more.hasAttribute('disabled')).toBe(false))
    fireEvent.click(more)
    await screen.findByRole('article', { name: 'Older export.xlsx' })
    expect(server.get.mock.calls.some(([path, options]) => path === '/exports' && options?.params?.query?.before === server.nextBefore)).toBe(true)
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
  })

  it('ends pagination when an empty final page follows a full first page', async () => {
    server.items = Array.from({ length: 50 }, (_, i) => ready(`exp_${i}`))
    server.nextBefore = '2026-10-17T10:00:00Z'
    server.pages[server.nextBefore] = { items: [] }
    render(<ExportCenter disabled={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Exports' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull())
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh' })) })
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
    expect(server.get.mock.calls.filter(([, options]) => options?.params?.query?.before)).toHaveLength(1)
  })

  it('aborts a pending read when it goes away, as on switching workspace', async () => {
    let finish!: (result: MockOutcome) => void
    server.get.mockImplementation(() => new Promise<MockOutcome>((resolve) => { finish = resolve }))
    const view = render(<ExportCenter disabled={false} />)
    await waitFor(() => expect(server.get).toHaveBeenCalled())
    const signal = server.get.mock.calls[0]![1]!.signal!
    view.unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => { finish({ data: page({ items: [ready('exp_late', 'Late export')] }), response: { ok: true } }) })
  })

  it('says how exports are made when there are none', async () => {
    render(<ExportCenter disabled={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Exports' }))
    await screen.findByText('No exports yet. Export a chart’s data on a dashboard where the chart allows it; developers can also export SQL results in Data exploration.')
  })
})
