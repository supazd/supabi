import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from 'i18next'
import '../i18n'
import type { AssistantEvent, AssistantMessage, Conversation } from './stream'

const server = vi.hoisted(() => ({
  configured: true,
  isOrgAdmin: false,
  conversations: [] as Conversation[],
  messages: {} as Record<string, AssistantMessage[]>,
  get: vi.fn(), post: vi.fn(), patch: vi.fn(), remove: vi.fn(),
}))
vi.mock('../auth/session', () => ({ useSession: () => ({ isOrgAdmin: server.isOrgAdmin, state: { status: 'ok', data: { workspace: { id: 'ws1' } } } }) }))
// A chart is drawn by the chart package, which needs a browser; here it shows what it was handed.
vi.mock('../components/ChartView', () => ({
  ChartView: ({ viz, result, height, colorScheme }: { viz: unknown; result: { rows: unknown[][] }; height: number; colorScheme: string }) => (
    <div data-testid="chart" data-scheme={colorScheme} data-height={height}>{JSON.stringify({ viz, rows: result.rows })}</div>
  ),
}))
vi.mock('../api/client', async (original) => ({
  ...(await original<typeof import('../api/client')>()),
  api: { GET: server.get, POST: server.post, PATCH: server.patch, DELETE: server.remove },
}))
import { Assistant } from './Assistant'

const response = (data: unknown) => ({ data, response: { ok: true } })
const at = '2026-10-22T10:00:00Z'
const message = (id: string, seq: number, role: 'user' | 'assistant', text: string, status: AssistantMessage['status'] = 'done', error?: string): AssistantMessage =>
  ({ id, seq, role, status, error, createdAt: at, parts: text ? [{ type: 'text', text }] : [] })

/** Answers the next request for an answer with these events; with open, the stream stays open until it is aborted. */
function answerWith(events: AssistantEvent[], { open = false } = {}) {
  const fetch = vi.fn(async (_path: string, init: RequestInit) => {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        if (!open) controller.close()
        init.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')))
      },
    })
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

function open(path = '/assistant') {
  const router = createMemoryRouter([{ path: '/assistant/:id?', element: <Assistant colorScheme="dark" /> }, { path: '/settings/*', element: <p>settings</p> }], { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return router
}

const box = () => screen.getByRole('textbox', { name: 'Message' })

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  server.configured = true
  server.isOrgAdmin = false
  server.conversations = []
  server.messages = {}
  server.get.mockReset().mockImplementation(async (path: string, init?: { params?: { path?: { id?: string } } }) => {
    if (path === '/assistant') return response({ configured: server.configured })
    if (path === '/assistant/conversations') return response(server.conversations)
    return response(server.messages[init!.params!.path!.id!] ?? [])
  })
  server.post.mockReset().mockImplementation(async () => {
    const created = { id: 'c1', title: '', createdAt: at, updatedAt: at }
    server.conversations = [created]
    return response(created)
  })
  server.patch.mockReset()
  server.remove.mockReset()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Assistant', () => {
  it('lists a figure the answer worked out among its sources, with the formula citing its inputs', async () => {
    const source = { n: 1, dashboardId: 'db1', dashboardName: '销售看板', itemId: 'wa', chartName: '营收', dashboardRevision: 1, chartRevision: 1, datasetRevision: 1, conditions: [], state: {}, rows: 2, truncated: false }
    const calculation = { n: 2, expression: '(a - b) / b * 100', result: '25', inputs: [{ name: 'a', label: '华东', value: '100', source: 1 }, { name: 'b', label: '华南', value: '80', source: 1 }] }
    server.conversations = [{ id: 'c1', title: '差额', createdAt: at, updatedAt: at }]
    server.messages.c1 = [message('m1', 1, 'user', '华东比华南高多少'), { ...message('m2', 2, 'assistant', ''), parts: [
      { type: 'tool', callId: 'q', tool: 'query_chart', done: true, subject: '销售看板 › 营收', source },
      { type: 'tool', callId: 'k', tool: 'calculate', done: true, subject: '(华东 − 华南) ÷ 华南 × 100 = 25', calculation },
      { type: 'text', text: '华东比华南高 25% [2]。' },
    ] }]
    open('/assistant/c1')
    // Folded, the sources say how many there are and which dashboards they are on.
    const toggle = await screen.findByRole('button', { name: '2 sources · 销售看板' })
    expect(screen.queryByRole('list', { name: 'Sources' })).toBeNull()
    // A citation unfolds them and goes to its source.
    Element.prototype.scrollIntoView = vi.fn()
    fireEvent.click(screen.getByRole('button', { name: '2' }))
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const sources = screen.getByRole('list', { name: 'Sources' })
    const worked = sources.querySelectorAll('li')[1]!
    expect(document.activeElement).toBe(worked)
    expect(worked.textContent).toBe('2Worked out: (华东1 − 华南1) ÷ 华南1 × 100 = 25华东: 100 · 华南: 80')
    expect(worked.querySelectorAll('sup button')).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: 'Looked things up 2 times' }))
    expect(screen.getByText('Worked out: (华东 − 华南) ÷ 华南 × 100 = 25')).toBeTruthy()
  })

  it('draws a chart where the answer drew it, with its data and how it worked a series out', async () => {
    const source = { n: 1, dashboardId: 'db1', dashboardName: '销售看板', itemId: 'wa', chartName: '营收', dashboardRevision: 1, chartRevision: 1, datasetRevision: 1, conditions: [], state: {}, rows: 260, truncated: true }
    const chart = {
      n: 2, title: '华东每月同比', viz: { type: 'bar', x: 'month', y: ['growth'] }, sources: [1],
      columns: [{ name: 'month', type: 'date' as const, role: 'dimension' as const, grain: 'month' as const }, { name: 'growth', type: 'decimal' as const, role: 'measure' as const, label: '同比增长率' }],
      rows: [['2026-01-01', null], ['2026-02-01', '0.205']],
      calculations: [{ series: 'growth', name: '同比增长率', expression: '(now - last) / last', inputs: [{ name: 'now', label: '今年', source: 1 }, { name: 'last', label: '去年', source: 1 }] }],
    }
    server.conversations = [{ id: 'c1', title: '同比', createdAt: at, updatedAt: at }]
    server.messages.c1 = [message('m1', 1, 'user', '华东每月同比'), { ...message('m2', 2, 'assistant', ''), parts: [
      { type: 'tool', callId: 'q', tool: 'query_chart', done: true, subject: '销售看板 › 营收', source },
      { type: 'tool', callId: 'x', tool: 'draw_chart', done: true, failed: true },
      { type: 'tool', callId: 'd', tool: 'draw_chart', done: true, subject: chart.title, chart },
      { type: 'text', text: '2 月同比最高，为 20.5% [2]。' },
    ] }]
    open('/assistant/c1')
    const figure = (await screen.findByTestId('chart')).closest('figure')!
    expect(screen.getByTestId('chart').textContent).toBe(JSON.stringify({ viz: chart.viz, rows: chart.rows }))
    expect(screen.getByTestId('chart').dataset).toMatchObject({ scheme: 'dark', height: '280' })
    expect(figure.textContent).toBe(
      '华东每月同比' + JSON.stringify({ viz: chart.viz, rows: chart.rows }) +
      'Data from1' + 'Worked out row by row: 同比增长率 = (今年1 − 去年1) ÷ 去年12' +
      'Of [1], only the first 200 rows the assistant read are drawn, not all of them' +
      '1 row could not be worked out: a figure is missing or a divisor is zero',
    )
    // The chart sits before the text, as it was drawn; the steps keep the attempt that failed and not the chart.
    expect(figure.compareDocumentPosition(screen.getByText(/2 月同比最高/)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Looked things up 2 times' }))
    expect(screen.getByText('Drew a chart (did not work)')).toBeTruthy()
    // Its series worked out is a source of its own, which its citation goes to.
    Element.prototype.scrollIntoView = vi.fn()
    fireEvent.click(within(figure).getByRole('button', { name: '2' }))
    const sources = screen.getByRole('list', { name: 'Sources' })
    expect(sources.querySelectorAll('li')[1]!.textContent).toBe('2Worked out row by row: 同比增长率 = (今年1 − 去年1) ÷ 去年1In the chart 华东每月同比')
    expect(screen.getByRole('button', { name: '2 sources · 销售看板' }).getAttribute('aria-expanded')).toBe('true')
  })

  it('shows the tools an answer called, folded once done, and the sources its figures cite', async () => {
    const source = {
      n: 1, dashboardId: 'db1', dashboardName: '销售看板', itemId: 'wa', chartName: '营收', dashboardRevision: 3, chartRevision: 2, datasetRevision: 5,
      conditions: [{ kind: 'filter' as const, label: '大区', value: ['华东', '华南'] }, { kind: 'drill' as const, label: '地区', value: ['华东'], text: '华东' }],
      state: { filters: { g: ['华东', '华南'] } }, rows: 2, truncated: false, dataAt: at,
    }
    const running = { type: 'tool' as const, callId: 'c1', tool: 'query_chart', done: false }
    const done = { ...running, done: true, subject: '销售看板 › 营收', source }
    const parts = [done, { type: 'text' as const, text: '华东是 100 [1]。' }]
    answerWith([
      { type: 'start', question: message('m1', 1, 'user', '华东'), answer: message('m2', 2, 'assistant', '', 'generating') },
      { type: 'status', status: 'thinking' },
      { type: 'tool', part: running },
      { type: 'tool', part: done },
      { type: 'delta', text: '华东是 100 [1]。' },
      { type: 'done', answer: { ...message('m2', 2, 'assistant', '', 'done'), parts } },
    ])
    server.post.mockImplementation(async (path: string) => {
      if (path === '/dashboards/{id}/views') return response({ id: 'dv1', state: source.state, expiresAt: at })
      const created = { id: 'c1', title: '', createdAt: at, updatedAt: at }
      server.conversations = [created]
      return response(created)
    })
    const tab = { location: { href: '' }, close: vi.fn() }
    vi.stubGlobal('open', vi.fn(() => tab))
    open()
    await waitFor(() => expect((box() as HTMLTextAreaElement).disabled).toBe(false))
    fireEvent.change(box(), { target: { value: '华东' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    const steps = await screen.findByRole('button', { name: 'Looked something up' })
    expect(screen.queryByText('Read: 销售看板 › 营收')).toBeNull()
    fireEvent.click(steps)
    expect(screen.getByText('Read: 销售看板 › 营收')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '1 source · 销售看板' }))
    const sources = screen.getByRole('list', { name: 'Sources' })
    expect(sources.textContent).toContain('销售看板 › 营收')
    expect(sources.textContent).toContain('大区: 华东, 华南 · Drilled down: 华东')
    expect(sources.textContent).toContain('2 rows')
    // The citation is a button that goes to its source.
    expect(screen.getByRole('button', { name: '1' }).closest('sup')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    await waitFor(() => expect(tab.location.href).toBe(`${window.location.origin}/w/ws1/dashboards/db1?view=dv1`))
    expect(server.post).toHaveBeenCalledWith('/dashboards/{id}/views', { params: { path: { id: 'db1' } }, body: { state: source.state, validDays: 30 } })
  })

  it('starts a conversation with the first message and shows the answer as it is written', async () => {
    const question = message('m1', 1, 'user', '上个月\n怎么样')
    const answer = message('m2', 2, 'assistant', '', 'generating')
    const fetch = answerWith([
      { type: 'start', question, answer },
      { type: 'status', status: 'thinking' },
      { type: 'delta', text: '还查不到，' },
      { type: 'delta', text: '**抱歉**' },
      { type: 'done', answer: message('m2', 2, 'assistant', '还查不到，**抱歉**') },
      { type: 'title', title: '上月情况' },
    ])
    const router = open()
    expect(await screen.findByRole('heading', { name: 'How can I help?' })).toBeTruthy()
    await waitFor(() => expect((box() as HTMLTextAreaElement).disabled).toBe(false))
    fireEvent.change(box(), { target: { value: '上个月\n怎么样' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/assistant/c1'))
    expect(fetch).toHaveBeenCalledWith('/api/v1/assistant/conversations/c1/messages', expect.objectContaining({ method: 'POST', body: JSON.stringify({ text: '上个月\n怎么样' }) }))
    const strong = await screen.findByText('抱歉')
    expect(strong.tagName).toBe('STRONG')
    expect(screen.getByText(/上个月/).textContent).toBe('上个月\n怎么样')
    expect((box() as HTMLTextAreaElement).value).toBe('')
    // The list is read again for the title.
    await waitFor(() => expect(server.get.mock.calls.filter(([path]) => path === '/assistant/conversations').length).toBeGreaterThan(1))
  })

  it('sends with Enter, but not while an input method composes or with Shift', async () => {
    const fetch = answerWith([])
    open()
    await waitFor(() => expect((box() as HTMLTextAreaElement).disabled).toBe(false))
    fireEvent.change(box(), { target: { value: '你好' } })
    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true })
    fireEvent.keyDown(box(), { key: 'Enter', keyCode: 229 })
    fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true })
    await act(async () => {})
    expect(server.post).not.toHaveBeenCalled()
    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(fetch).toHaveBeenCalled())
  })

  it('stops an answer, keeping what was written', async () => {
    server.conversations = [{ id: 'c1', title: '故事', createdAt: at, updatedAt: at }]
    const fetch = answerWith([
      { type: 'start', question: message('m1', 1, 'user', '讲个故事'), answer: message('m2', 2, 'assistant', '', 'generating') },
      { type: 'delta', text: '从前有座山' },
    ], { open: true })
    open('/assistant/c1')
    await waitFor(() => expect((box() as HTMLTextAreaElement).disabled).toBe(false))
    fireEvent.change(box(), { target: { value: '讲个故事' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText('从前有座山')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(await screen.findByText('Stopped')).toBeTruthy()
    expect((fetch.mock.calls[0]![1] as RequestInit).signal!.aborted).toBe(true)
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
  })

  it('lets a request still naming the conversation end without touching the next answer', async () => {
    server.conversations = [{ id: 'c1', title: '问', createdAt: at, updatedAt: at }]
    const encoder = new TextEncoder()
    const streams: ReadableStreamDefaultController<Uint8Array>[] = []
    const send = (c: ReadableStreamDefaultController<Uint8Array>, event: AssistantEvent) => c.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start: (c) => { streams.push(c) } }), { status: 200 })))
    open('/assistant/c1')
    await waitFor(() => expect((box() as HTMLTextAreaElement).disabled).toBe(false))
    fireEvent.change(box(), { target: { value: '一' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(streams).toHaveLength(1))
    // The first answer is done; its request stays open while the title is written.
    send(streams[0]!, { type: 'start', question: message('m1', 1, 'user', '一'), answer: message('m2', 2, 'assistant', '', 'generating') })
    send(streams[0]!, { type: 'done', answer: message('m2', 2, 'assistant', '第一个回答') })
    expect(await screen.findByText('第一个回答')).toBeTruthy()
    fireEvent.change(box(), { target: { value: '二' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(streams).toHaveLength(2))
    send(streams[1]!, { type: 'start', question: message('m3', 3, 'user', '二'), answer: message('m4', 4, 'assistant', '', 'generating') })
    send(streams[1]!, { type: 'delta', text: '第二个回答写到一半' })
    expect(await screen.findByText('第二个回答写到一半')).toBeTruthy()
    // The title comes, and the first request ends.
    send(streams[0]!, { type: 'title', title: '标题' })
    streams[0]!.close()
    await act(async () => { await new Promise((r) => setTimeout(r, 100)) })
    expect(screen.queryByText('Stopped')).toBeNull()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy()
    send(streams[1]!, { type: 'done', answer: message('m4', 4, 'assistant', '第二个回答写完了') })
    streams[1]!.close()
    expect(await screen.findByText('第二个回答写完了')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
  })

  it('says why an answer failed, and writes the last one again', async () => {
    server.conversations = [{ id: 'c1', title: '问', createdAt: at, updatedAt: at }]
    server.messages.c1 = [message('m1', 1, 'user', '你好'), message('m2', 2, 'assistant', '', 'failed', 'unauthorized')]
    const fetch = answerWith([
      { type: 'start', answer: message('m2', 2, 'assistant', '', 'generating') },
      { type: 'done', answer: message('m2', 2, 'assistant', '你好！') },
    ])
    open('/assistant/c1')
    expect(await screen.findByText('The model service refused access. Ask an administrator to check the API key.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('你好！')).toBeTruthy()
    expect(fetch).toHaveBeenCalledWith('/api/v1/assistant/messages/m2/retry', expect.objectContaining({ method: 'POST' }))
  })

  it('cannot be used before a model is set, and sends administrators to set one', async () => {
    server.configured = false
    server.isOrgAdmin = true
    open()
    expect(await screen.findByText('An administrator has not set a model for the assistant yet.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Set up models' }).getAttribute('href')).toBe('/settings/system/ai')
    expect((box() as HTMLTextAreaElement).disabled).toBe(true)
  })

  it('shows why a message was refused', async () => {
    server.conversations = [{ id: 'c1', title: '问', createdAt: at, updatedAt: at }]
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'assistant_busy', message: 'busy' }), { status: 409 })))
    open('/assistant/c1')
    await waitFor(() => expect((box() as HTMLTextAreaElement).disabled).toBe(false))
    fireEvent.change(box(), { target: { value: '再问' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText('This conversation is being answered. Wait for it to finish, or stop it, before sending.')).toBeTruthy()
    // What was typed is kept, to send again.
    expect((box() as HTMLTextAreaElement).value).toBe('再问')
  })
})
