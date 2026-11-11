// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useImperativeHandle, useState, type ReactNode } from 'react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../i18n'
import i18n from 'i18next'

// The server, as far as this page talks to it.
const server = vi.hoisted(() => {
  interface Call {
    method: string
    path: string
    id?: string
    body?: Record<string, unknown>
  }
  const state = { calls: [] as Call[], workspaceId: 'ws', userId: 'user', sources: [{ id: 'src', name: '仓库', type: 'postgres' }], truncated: false }
  const answer = (data: unknown, status = 200) => Promise.resolve({ data, response: { ok: status < 400, status, statusText: '' }, error: status < 400 ? undefined : data })
  const handle = (method: string) => (path: string, options?: { params?: { path?: { id?: string } }; body?: Record<string, unknown> }) => {
    const id = options?.params?.path?.id
    const body = options?.body
    state.calls.push({ method, path, id, body })
    switch (`${method} ${path}`) {
      case 'GET /datasources':
        return answer([...state.sources])
      case 'GET /datasources/{id}/tables':
        return answer({ truncated: false, tables: [{ path: ['public'], schema: 'public', name: 'orders', comment: '订单', columns: [{ name: 'amount', dbType: 'numeric', comment: '金额' }] }] })
      case 'POST /datasources/{id}/describe':
        return answer([{ name: 'n', type: 'integer', dbType: 'int4' }])
      case 'POST /datasets/preview':
        return answer({ columns: [{ name: 'n', type: 'integer' }], rows: [[3], [1], [2]], meta: { durationMs: 7, truncated: state.truncated } })
      case 'POST /datasources/{id}/explain':
        return answer({ columns: ['QUERY PLAN'], rows: [['Seq Scan on orders'], ['  Filter: (n > 1)']] })
    }
    return answer([])
  }
  return { state, api: { GET: handle('GET'), POST: handle('POST'), PUT: handle('PUT'), DELETE: handle('DELETE') } }
})

vi.mock('../api/client', async (original) => ({ ...(await original<typeof import('../api/client')>()), api: server.api }))
vi.mock('../auth/session', () => ({ useSession: () => ({ state: { status: 'ok', data: { user: { id: server.state.userId }, workspace: { id: server.state.workspaceId } } }, atLeast: () => true }) }))
// The editor is a text box here: what is tested is the page around it.
vi.mock('@supabi/ui', async (original) => {
  const ui = await original<typeof import('@supabi/ui')>()
  return {
    ...ui,
    CodeEditor: ({ value, onChange, handle, 'aria-label': label }: import('@supabi/ui').CodeEditorProps) => {
      useImperativeHandle(handle, () => ({ insert: (text: string) => onChange(value + text), replace: () => undefined, selection: () => null }))
      return <textarea aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} />
    },
  }
})

import { EditorPanelsProvider, type Slots } from '../components/EditorPanels'
import { SqlExplore } from './SqlExplore'
import { openSqlEditor, readSqlHandoff } from '../lib/sqlHandoff'
import { UnsavedChangesProvider, useUnsavedActions } from '../components/UnsavedChanges'

function LeaveWorkspace({ onLeave }: { onLeave: () => void }) {
  const { confirmDiscard } = useUnsavedActions()
  return <button onClick={() => confirmDiscard(onLeave)}>Leave workspace</button>
}

function refreshIsBlocked() {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

function Where() {
  const location = useLocation()
  return (
    <>
      <output data-testid="where">{location.pathname}</output>
      <output data-testid="state">{JSON.stringify(location.state)}</output>
    </>
  )
}

/** The page inside its independent frame: the schema, result and status panels. */
function Page() {
  const location = useLocation()
  const [slots, setSlots] = useState<Slots>({ side: null, aside: null, bottom: null, status: null })
  const slot = (name: keyof Slots) => (node: HTMLElement | null) => setSlots((current) => (current[name] === node ? current : { ...current, [name]: node }))
  const [side] = useState(() => slot('side'))
  const [aside] = useState(() => slot('aside'))
  const [bottom] = useState(() => slot('bottom'))
  const [status] = useState(() => slot('status'))
  return (
    <EditorPanelsProvider slots={slots} storageKey="supabi.explore">
      <aside data-testid="side" ref={side} />
      <div data-testid="aside" ref={aside} />
      <main>
        <SqlExplore active={location.pathname.startsWith('/explore')} />
      </main>
      <div data-testid="bottom" ref={bottom} />
      <footer data-testid="status" ref={status} />
      <Where />
    </EditorPanelsProvider>
  )
}

const open = (path: string, controls?: ReactNode): ReactNode => (
  <MemoryRouter initialEntries={[path]}>
    <UnsavedChangesProvider>{controls}<Page /></UnsavedChangesProvider>
  </MemoryRouter>
)

const editor = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Source SQL' })
/** The editor of the tab that shows, once what the tab is of has arrived. */
const ready = async () => {
  await waitFor(() => expect(document.querySelector('.sql-tab-body:not([hidden]) textarea')).toBeTruthy())
  return document.querySelector<HTMLTextAreaElement>('.sql-tab-body:not([hidden]) textarea')!
}
const calls = (method: string, path: string) => server.state.calls.filter((call) => call.method === method && call.path === path)

let browserTab: Window

beforeEach(async () => {
  server.state.truncated = false
  await i18n.changeLanguage('en-US')
  localStorage.clear()
  sessionStorage.clear()
  server.state.calls = []
  server.state.userId = 'user'
  server.state.workspaceId = 'ws'
  server.state.sources = [{ id: 'src', name: '仓库', type: 'postgres' }]
  browserTab = { opener: window, location: { replace: vi.fn() }, close: vi.fn() } as unknown as Window
  vi.spyOn(window, 'open').mockReturnValue(browserTab)
  vi.spyOn(window, 'focus').mockImplementation(() => undefined)
  vi.spyOn(window, 'close').mockImplementation(() => undefined)
  // The table library asks the browser how wide the page is, and watches what it draws for changes of size.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never
  window.matchMedia ??= (() => ({ matches: false, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined })) as never
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('data exploration', () => {
  it('starts with local query tabs and a schema panel, without resource saving', async () => {
    render(open('/explore'))
    expect(await screen.findByRole('tab', { name: 'Query 1' })).toBeTruthy()
    expect(screen.getByTestId('side').textContent).toBe('')
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(server.state.calls.every((call) => call.path.startsWith('/datasources'))).toBe(true)
    // The tables are in a panel of their own. What was written about a table is shown with it.
    const aside = within(screen.getByTestId('aside'))
    expect(await aside.findByText('orders')).toBeTruthy()
    expect(aside.getByText('订单')).toBeTruthy()
    expect((await ready()).value).toBe('')
  })

  it.each(['QuotaExceededError', 'SecurityError'])('protects temporary SQL when draft storage fails with %s, including hidden tabs', async (errorName) => {
    const setItem = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key.startsWith('supabi.explore.draft.')) throw new DOMException('Draft storage unavailable', errorName)
      setItem.call(this, key, value)
    })
    const onLeave = vi.fn()
    render(open('/explore', <LeaveWorkspace onLeave={onLeave} />))
    const query = await ready()
    expect(refreshIsBlocked()).toBe(false)
    fireEvent.change(query, { target: { value: 'SELECT only_in_memory' } })
    expect(refreshIsBlocked()).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Leave workspace' }))
    expect(onLeave).not.toHaveBeenCalled()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Stay' }))
    expect(query.value).toBe('SELECT only_in_memory')

    fireEvent.click(screen.getByRole('button', { name: 'New query' }))
    expect((await ready()).value).toBe('')
    expect(refreshIsBlocked()).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Leave workspace' }))
    expect(onLeave).not.toHaveBeenCalled()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Discard and leave' }))
    expect(onLeave).toHaveBeenCalledTimes(1)
  })

  it('protects a failed update to a previously stored draft until storage recovers or the query is cleared', async () => {
    render(open('/explore'))
    const query = await ready()
    fireEvent.change(query, { target: { value: 'SELECT persisted' } })
    expect(refreshIsBlocked()).toBe(false)

    const setItem = Storage.prototype.setItem
    let failing = true
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (failing && key.startsWith('supabi.explore.draft.')) throw new DOMException('Quota exceeded', 'QuotaExceededError')
      setItem.call(this, key, value)
    })
    fireEvent.change(query, { target: { value: 'SELECT unpersisted_change' } })
    expect(refreshIsBlocked()).toBe(true)
    failing = false
    fireEvent.change(query, { target: { value: 'SELECT recovered' } })
    expect(refreshIsBlocked()).toBe(false)
    const draftKey = Object.keys(localStorage).find((key) => key.startsWith('supabi.explore.draft.'))!
    expect(JSON.parse(localStorage.getItem(draftKey)!).sql).toBe('SELECT recovered')

    failing = true
    fireEvent.change(query, { target: { value: 'SELECT another_change' } })
    expect(refreshIsBlocked()).toBe(true)
    fireEvent.change(query, { target: { value: '' } })
    expect(refreshIsBlocked()).toBe(false)
  })

  it.each(['tab list', 'all storage'])('recovers a new query after a failed %s write before allowing departure', async (failure) => {
    const page = render(open('/explore'))
    fireEvent.change(await ready(), { target: { value: 'SELECT first_query' } })
    const tabsKey = 'supabi.explore.tabs.user.ws'
    const setItem = Storage.prototype.setItem
    let failing = true
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (failing && (failure === 'all storage' || key === tabsKey)) throw new DOMException('Quota exceeded', 'QuotaExceededError')
      setItem.call(this, key, value)
    })
    fireEvent.click(screen.getByRole('button', { name: 'New query' }))
    fireEvent.change(await ready(), { target: { value: 'SELECT new_query' } })
    expect(JSON.parse(localStorage.getItem(tabsKey)!).open).toHaveLength(1)
    expect(refreshIsBlocked()).toBe(true)

    failing = false
    fireEvent.change(await ready(), { target: { value: 'SELECT recovered_query' } })
    expect(JSON.parse(localStorage.getItem(tabsKey)!).open).toHaveLength(2)
    expect(refreshIsBlocked()).toBe(false)
    page.unmount()

    render(open('/explore'))
    expect((await ready()).value).toBe('SELECT recovered_query')
    expect(screen.getByRole('tab', { name: 'Query 2' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('tab', { name: 'Query 1' }))
    expect((await ready()).value).toBe('SELECT first_query')
  })

  it('keeps protection if tab-list recovery succeeds but the draft still cannot be written', async () => {
    const page = render(open('/explore'))
    await ready()
    const tabsKey = 'supabi.explore.tabs.user.ws'
    const setItem = Storage.prototype.setItem
    let failure: 'tabs' | 'draft' | undefined = 'tabs'
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if ((failure === 'tabs' && key === tabsKey) || (failure === 'draft' && key.startsWith('supabi.explore.draft.'))) throw new DOMException('Quota exceeded', 'QuotaExceededError')
      setItem.call(this, key, value)
    })
    fireEvent.click(screen.getByRole('button', { name: 'New query' }))
    fireEvent.change(await ready(), { target: { value: 'SELECT missing_tab' } })
    expect(refreshIsBlocked()).toBe(true)

    failure = 'draft'
    fireEvent.click(screen.getByRole('tab', { name: 'Query 1' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Query 2' }))
    expect(JSON.parse(localStorage.getItem(tabsKey)!).open).toHaveLength(2)
    fireEvent.change(await ready(), { target: { value: 'SELECT missing_draft' } })
    expect(refreshIsBlocked()).toBe(true)

    failure = undefined
    fireEvent.change(await ready(), { target: { value: 'SELECT both_saved' } })
    expect(refreshIsBlocked()).toBe(false)
    page.unmount()
    render(open('/explore'))
    expect((await ready()).value).toBe('SELECT both_saved')
  })

  it('runs the SQL and shows the rows, sorted by a column on demand; and the plan', async () => {
    render(open('/explore'))
    await screen.findByRole('tab', { name: 'Query 1' })
    fireEvent.change(await ready(), { target: { value: 'SELECT n FROM t' } })
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    const bottom = within(screen.getByTestId('bottom'))
    const cells = () => [...screen.getByTestId('bottom').querySelectorAll('tbody td .tabular')].map((cell) => cell.textContent)
    await waitFor(() => expect(cells()).toEqual(['3', '1', '2']))
    expect(calls('POST', '/datasets/preview')[0]!.body).toMatchObject({ datasourceId: 'src', limit: 1000 })
    fireEvent.click(bottom.getByRole('columnheader', { name: /n/ }))
    await waitFor(() => expect(cells()).toEqual(['1', '2', '3']))
    // What was run is in the history.
    fireEvent.click(bottom.getByRole('tab', { name: 'History' }))
    expect(bottom.getByText('SELECT n FROM t')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Query plan' }))
    await waitFor(() => expect(screen.getByTestId('bottom').querySelector('.sql-plan')?.textContent).toBe('Seq Scan on orders\n  Filter: (n > 1)'))
    expect(calls('POST', '/datasources/{id}/explain')[0]!.body).toMatchObject({ source: { type: 'sql', sql: 'SELECT n FROM t' } })
  })

  it('says the rows stop short when the server held them to fewer than were asked for', async () => {
    server.state.truncated = true
    render(open('/explore'))
    await screen.findByRole('tab', { name: 'Query 1' })
    fireEvent.change(await ready(), { target: { value: 'SELECT n FROM t' } })
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    expect(await within(screen.getByTestId('bottom')).findByText('First 3 rows; there are more')).toBeTruthy()
  })

  it('finds a newly added data source on return and keeps query results during subsequent refreshes', async () => {
    server.state.sources = []
    render(open('/explore'))
    await screen.findByText(i18n.t('dataset.needDatasource'))
    server.state.sources = [{ id: 'src', name: '仓库', type: 'postgres' }]
    fireEvent(window, new Event('focus'))
    fireEvent.change(await ready(), { target: { value: 'SELECT n FROM t' } })
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    const bottom = within(screen.getByTestId('bottom'))
    await bottom.findByRole('table')
    fireEvent(window, new Event('focus'))
    await waitFor(() => expect(calls('GET', '/datasources')).toHaveLength(3))
    expect((await ready()).value).toBe('SELECT n FROM t')
    expect(bottom.getByRole('table')).toBeTruthy()
  })

  it('keeps runs from other exploration windows and synchronizes their history changes', async () => {
    render(open('/explore'))
    fireEvent.change(await ready(), { target: { value: 'SELECT n FROM t' } })
    const historyKey = 'supabi.explore.history.user.ws'
    const other = { sql: 'SELECT 42', datasourceId: 'src', at: 1, rows: 1, ms: 1 }
    localStorage.setItem(historyKey, JSON.stringify([other]))
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    await within(screen.getByTestId('bottom')).findByRole('table')
    expect(JSON.parse(localStorage.getItem(historyKey)!).map((run: { sql: string }) => run.sql)).toEqual(['SELECT n FROM t', 'SELECT 42'])
    const bottom = within(screen.getByTestId('bottom'))
    fireEvent.click(bottom.getByRole('tab', { name: 'History' }))
    expect(bottom.getByText('SELECT 42')).toBeTruthy()
    localStorage.setItem(historyKey, '[]')
    fireEvent(window, new StorageEvent('storage', { key: historyKey, newValue: '[]' }))
    expect(bottom.getByText(i18n.t('workbench.historyEmpty'))).toBeTruthy()
  })

  it('opens the current dataset SQL in a separate browser tab and applies it to that same unsaved editor', async () => {
    const onApply = vi.fn()
    const close = openSqlEditor({ sql: 'SELECT 7 AS n', datasourceId: 'src', params: [] }, { datasetName: 'Orders dataset', onApply })
    const path = String(vi.mocked(browserTab.location.replace).mock.calls[0]![0])
    const setItem = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      setItem.call(this, key, value)
      window.dispatchEvent(new StorageEvent('storage', { key, newValue: value }))
    })
    try {
      const page = render(open(path))
      expect((await ready()).value).toBe('SELECT 7 AS n')
      expect(refreshIsBlocked()).toBe(false)
      expect(screen.getByText(i18n.t('workbench.editingDatasetSql', { name: 'Orders dataset' }))).toBeTruthy()
      fireEvent.change(await ready(), { target: { value: 'SELECT 9 AS n' } })
      expect(refreshIsBlocked()).toBe(true)
      fireEvent.click(screen.getByRole('button', { name: 'Apply and return to dataset' }))
      await waitFor(() => expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ sql: 'SELECT 9 AS n' })))
      expect(screen.getByTestId('where').textContent).toBe('/explore')
      expect(window.open).toHaveBeenCalledTimes(1)
      expect(browserTab.location.replace).toHaveBeenCalledTimes(1)
      expect(server.state.calls.filter((call) => call.method !== 'GET')).toHaveLength(0)
      await waitFor(() => expect(window.close).toHaveBeenCalledTimes(1))
      expect(refreshIsBlocked()).toBe(false)
      // Applying and reloading preserves the local query and its return address.
      page.unmount()
      render(open(path))
      expect((await ready()).value).toBe('SELECT 9 AS n')
      fireEvent.click(screen.getByRole('button', { name: 'Apply and return to dataset' }))
      await waitFor(() => expect(onApply).toHaveBeenCalledTimes(2))
      expect(server.state.calls.filter((call) => call.method !== 'GET')).toHaveLength(0)
    } finally {
      close()
    }
  })

  it('restores a new query after reloading a dataset SQL window without its handoff in the address', async () => {
    const close = openSqlEditor({ sql: 'SELECT 7 AS n', datasourceId: 'src' }, { datasetName: 'Orders dataset', onApply: () => undefined })
    try {
      const path = String(vi.mocked(browserTab.location.replace).mock.calls[0]![0])
      const first = render(open(path))
      await ready()
      fireEvent.click(screen.getByRole('button', { name: 'New query' }))
      fireEvent.change(await ready(), { target: { value: 'SELECT unsaved_query' } })
      expect(screen.getByTestId('where').textContent).toBe('/explore')
      first.unmount()

      render(open('/explore'))
      expect((await ready()).value).toBe('SELECT unsaved_query')
      expect(screen.getByRole('tab', { name: 'Orders dataset' })).toBeTruthy()
      fireEvent.click(screen.getByRole('tab', { name: 'Orders dataset' }))
      expect((await ready()).value).toBe('SELECT 7 AS n')
      expect(screen.getByRole('button', { name: 'Apply and return to dataset' })).toBeTruthy()
    } finally {
      close()
    }
  })

  it('uses each explicit handoff even if a new window inherits the opener\'s session storage', async () => {
    const firstClose = openSqlEditor({ sql: 'SELECT 7 AS n', datasourceId: 'src' }, { datasetName: 'Orders dataset', onApply: () => undefined })
    const firstPath = String(vi.mocked(browserTab.location.replace).mock.calls[0]![0])
    let secondClose: (() => void) | undefined
    try {
      let page = render(open(firstPath))
      fireEvent.change(await ready(), { target: { value: 'SELECT first_window_draft' } })
      page.unmount()

      // Retaining sessionStorage models its initial copy from an opener.
      secondClose = openSqlEditor({ sql: 'SELECT 17 AS n', datasourceId: 'src' }, { datasetName: 'Orders dataset', onApply: () => undefined })
      const secondPath = String(vi.mocked(browserTab.location.replace).mock.calls[1]![0])
      page = render(open(secondPath))
      expect((await ready()).value).toBe('SELECT 17 AS n')
      fireEvent.change(await ready(), { target: { value: 'SELECT second_window_draft' } })
      page.unmount()

      page = render(open(firstPath))
      expect((await ready()).value).toBe('SELECT first_window_draft')
      page.unmount()
      render(open(secondPath))
      expect((await ready()).value).toBe('SELECT second_window_draft')
    } finally {
      firstClose()
      secondClose?.()
    }
  })

  it('restores the other workspace\'s default drafts after switching from a dataset SQL window', async () => {
    server.state.workspaceId = 'other_workspace'
    let page = render(open('/explore'))
    fireEvent.change(await ready(), { target: { value: 'SELECT other_workspace_draft' } })
    page.unmount()

    server.state.workspaceId = 'ws'
    const close = openSqlEditor({ sql: 'SELECT 7 AS n', datasourceId: 'src' }, { datasetName: 'Orders dataset', onApply: () => undefined })
    try {
      const path = String(vi.mocked(browserTab.location.replace).mock.calls[0]![0])
      page = render(open(path))
      expect((await ready()).value).toBe('SELECT 7 AS n')
      page.unmount()

      // A workspace switch reloads the application, retaining the window's session storage.
      server.state.workspaceId = 'other_workspace'
      render(open('/explore'))
      expect((await ready()).value).toBe('SELECT other_workspace_draft')
      expect(screen.queryByRole('tab', { name: 'Orders dataset' })).toBeNull()
    } finally {
      close()
    }
  })

  it('shows the first rows of a table without touching what is being written', async () => {
    render(open('/explore'))
    fireEvent.change(await ready(), { target: { value: 'SELECT mine' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Look at the first 100 rows public.orders' }))
    await waitFor(() => expect(calls('POST', '/datasets/preview')).toHaveLength(1))
    expect(calls('POST', '/datasets/preview')[0]!.body).toMatchObject({ limit: 100, spec: { source: { sql: 'SELECT * FROM public.orders' } } })
    await waitFor(() => expect(screen.getByTestId('bottom').querySelectorAll('tbody td .tabular')).toHaveLength(3))
    expect(editor().value).toBe('SELECT mine')
    // A look is not something that was run: the history has nothing of it.
    fireEvent.click(within(screen.getByTestId('bottom')).getByRole('tab', { name: 'History' }))
    expect(within(screen.getByTestId('bottom')).queryByText('SELECT * FROM public.orders')).toBeNull()
  })
  it('creates a dataset draft directly, carrying SQL, parameters and the destination folder', async () => {
    const page = render(open('/explore?folder=reports'))
    fireEvent.change(await ready(), { target: { value: 'SELECT {{region}} AS region' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Display name of region' }), { target: { value: 'Sales region' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'region is required' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Default of region' }), { target: { value: 'East' } })
    // Removing a placeholder and undoing that edit preserves its configuration.
    fireEvent.change(await ready(), { target: { value: 'SELECT 1' } })
    expect(screen.queryByRole('textbox', { name: 'Display name of region' })).toBeNull()
    fireEvent.change(await ready(), { target: { value: 'SELECT {{region}} AS region' } })
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Display name of region' }).value).toBe('Sales region')
    page.unmount()
    render(open('/explore'))
    await ready()
    expect(screen.getByRole('checkbox', { name: 'region is required' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Display name of region' }).value).toBe('Sales region')
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Create dataset' }))
    const url = new URL(vi.mocked(browserTab.location.replace).mock.calls[0]![0], window.location.origin)
    expect(url.pathname).toBe('/workbench/datasets/new')
    expect(url.searchParams.get('folder')).toBe('reports')
    expect(readSqlHandoff(url.search)?.handoff).toMatchObject({ sql: 'SELECT {{region}} AS region', datasourceId: 'src', params: [{ name: 'region', type: 'string', label: 'Sales region', required: true, default: 'East' }] })
    expect(server.state.calls.filter((call) => call.method !== 'GET')).toHaveLength(0)
  })

  it('applies parameter-only edits and can clear labels and required flags without losing other settings', async () => {
    const onApply = vi.fn()
    const sql = 'SELECT n FROM t WHERE region IN {{regions}}'
    const close = openSqlEditor({ sql, datasourceId: 'src', params: [{ name: 'regions', type: 'string', label: 'Regions', multi: true, default: ['East', 'South'], extra: 'preserved' }] }, { datasetName: 'Orders', onApply })
    const path = String(vi.mocked(browserTab.location.replace).mock.calls[0]![0])
    const setItem = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      setItem.call(this, key, value)
      window.dispatchEvent(new StorageEvent('storage', { key, newValue: value }))
    })
    try {
      render(open(path))
      await ready()
      expect(refreshIsBlocked()).toBe(false)
      fireEvent.change(screen.getByRole('textbox', { name: 'Display name of regions' }), { target: { value: 'Sales regions' } })
      fireEvent.click(screen.getByRole('checkbox', { name: 'regions is required' }))
      expect(refreshIsBlocked()).toBe(true)
      const param = { name: 'regions', type: 'string', label: 'Sales regions', required: true, multi: true, default: ['East', 'South'], extra: 'preserved' }
      fireEvent.click(screen.getByRole('button', { name: 'Apply and return to dataset' }))
      await waitFor(() => expect(onApply).toHaveBeenLastCalledWith({ sql, datasourceId: 'src', params: [param] }))
      await waitFor(() => expect(refreshIsBlocked()).toBe(false))

      fireEvent.change(screen.getByRole('textbox', { name: 'Display name of regions' }), { target: { value: '' } })
      fireEvent.click(screen.getByRole('checkbox', { name: 'regions is required' }))
      expect(refreshIsBlocked()).toBe(true)
      fireEvent.click(screen.getByRole('button', { name: 'Apply and return to dataset' }))
      await waitFor(() => expect(onApply).toHaveBeenLastCalledWith({ sql, datasourceId: 'src', params: [{ name: 'regions', type: 'string', multi: true, default: ['East', 'South'], extra: 'preserved' }] }))
      expect(server.state.calls.filter((call) => call.method !== 'GET')).toHaveLength(0)
    } finally {
      close()
    }
  })

  it('retains temporary queries across reloads and isolates drafts between users', async () => {
    let page = render(open('/explore'))
    fireEvent.change(await ready(), { target: { value: 'SELECT first' } })
    fireEvent.click(screen.getByRole('button', { name: 'New query' }))
    fireEvent.change(await ready(), { target: { value: 'SELECT second' } })
    page.unmount()
    page = render(open('/explore'))
    expect((await ready()).value).toBe('SELECT second')
    fireEvent.click(screen.getByRole('tab', { name: 'Query 1' }))
    expect((await ready()).value).toBe('SELECT first')
    page.unmount()
    server.state.userId = 'another'
    render(open('/explore'))
    expect((await ready()).value).toBe('')
  })

  it('asks before closing a query with SQL that has not been shown since the page was reloaded', async () => {
    let page = render(open('/explore'))
    fireEvent.change(await ready(), { target: { value: 'SELECT first' } })
    fireEvent.click(screen.getByRole('button', { name: 'New query' }))
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'New query' }))
    fireEvent.change(await ready(), { target: { value: 'SELECT third' } })
    page.unmount()
    page = render(open('/explore'))
    expect((await ready()).value).toBe('SELECT third')

    // The first query has not been shown, and is known to hold SQL from what is kept of it.
    const closeFirst = screen.getByRole('button', { name: 'Close Query 1' })
    expect(closeFirst.className).toContain('dirty')
    fireEvent.click(closeFirst)
    expect(await screen.findByRole('dialog', { name: 'Close "Query 1"?' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(screen.getByRole('tab', { name: 'Query 1' }))
    expect((await ready()).value).toBe('SELECT first')

    // An empty one closes without asking.
    fireEvent.click(screen.getByRole('button', { name: 'Close Query 2' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('tab', { name: 'Query 2' })).toBeNull()
  })

  it('keeps SQL when the original dataset editor is gone and does not create another dataset', async () => {
    const close = openSqlEditor({ sql: 'SELECT 1', datasourceId: 'src' }, { datasetName: 'Orders', onApply: vi.fn() })
    const path = String(vi.mocked(browserTab.location.replace).mock.calls[0]![0])
    render(open(path))
    fireEvent.change(await ready(), { target: { value: 'SELECT changed' } })
    close()
    fireEvent.click(screen.getByRole('button', { name: 'Apply and return to dataset' }))
    expect(await screen.findByText(i18n.t('workbench.sqlApplyUnavailable'))).toBeTruthy()
    expect(editor().value).toBe('SELECT changed')
    expect(window.close).not.toHaveBeenCalled()
    expect(server.state.calls.filter((call) => call.method !== 'GET')).toHaveLength(0)
  })

  it('keeps the query when the browser blocks a dataset tab', async () => {
    vi.mocked(window.open).mockReturnValue(null)
    render(open('/explore'))
    fireEvent.change(await ready(), { target: { value: 'SELECT 42' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create dataset' }))
    expect(await screen.findByText(/Allow browser pop-ups/)).toBeTruthy()
    expect(editor().value).toBe('SELECT 42')
    expect(server.state.calls.filter((call) => call.method !== 'GET')).toHaveLength(0)
  })

})
