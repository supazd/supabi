import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openSqlDataset, openSqlEditor, readSqlHandoff, reserveSqlDestination, returnSqlHandoff } from './sqlHandoff'

const original = { sql: 'SELECT amount FROM orders', datasourceId: 'warehouse', params: [] }
let cleanup: (() => void) | undefined
const browserTab = () => ({ opener: window, location: { replace: vi.fn() } })

beforeEach(() => { localStorage.clear(); vi.spyOn(window, 'focus').mockImplementation(() => undefined) })
afterEach(() => {
  cleanup?.()
  cleanup = undefined
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/** Deliver storage events as another same-origin browser tab would. */
function connectTabs() {
  const setItem = Storage.prototype.setItem
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    setItem.call(this, key, value)
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: value }))
  })
}

describe('SQL across browser tabs', () => {
  it('opens exploration with the dataset draft SQL, then updates only the requesting editor and waits for acceptance', async () => {
    const tab = browserTab()
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window)
    const onApply = vi.fn()
    cleanup = openSqlEditor(original, { datasetName: 'Dataset', onApply })
    const url = new URL(tab.location.replace.mock.calls[0]![0] as string, window.location.origin)
    expect(url.pathname).toBe('/explore')
    expect(url.href).not.toContain('SELECT')
    expect(open).toHaveBeenCalledWith('about:blank', '_blank')
    expect(tab.opener).toBeNull()
    const transfer = readSqlHandoff(url.search)!
    expect(transfer).toMatchObject({ handoff: original, datasetName: 'Dataset' })

    connectTabs()
    const changed = { ...original, sql: 'SELECT amount, region FROM orders' }
    expect(await returnSqlHandoff(transfer.returnTo!, changed)).toBe(true)
    expect(onApply).toHaveBeenCalledExactlyOnceWith(changed)
    cleanup()
    expect(await returnSqlHandoff(transfer.returnTo!, changed)).toBe(false)
    expect(onApply).toHaveBeenCalledTimes(1)
  })

  it('does not report success when the receiving tab cannot acknowledge the change', async () => {
    vi.useFakeTimers()
    const tab = browserTab()
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window)
    cleanup = openSqlEditor(original, { onApply: vi.fn() })
    const transfer = readSqlHandoff(new URL(tab.location.replace.mock.calls[0]![0] as string, window.location.origin).search)!
    const delivered = returnSqlHandoff(transfer.returnTo!, original)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await delivered).toBe(false)
  })

  it('hands SQL to a reserved dataset tab while preserving its destination folder', () => {
    const replace = vi.fn()
    const tab = { opener: window, location: { replace } } as unknown as Window
    const open = vi.spyOn(window, 'open').mockReturnValue(tab)
    expect(reserveSqlDestination()).toBe(tab)
    expect(tab.opener).toBeNull()
    expect(open).toHaveBeenCalledWith('about:blank', '_blank')
    openSqlDataset(original, { folderId: 'folder one' }, tab)
    const url = new URL(replace.mock.calls[0]![0] as string, window.location.origin)
    expect(url.pathname).toBe('/workbench/datasets/new')
    expect(url.searchParams.get('folder')).toBe('folder one')
    expect(readSqlHandoff(url.search)).toEqual({ handoff: original })
  })

  it('rejects expired or malformed transfers and releases the listener when its page closes', async () => {
    vi.useFakeTimers()
    const tab = browserTab()
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window)
    cleanup = openSqlEditor(original, { onApply: vi.fn() })
    const search = new URL(tab.location.replace.mock.calls[0]![0] as string, window.location.origin).search
    const transfer = readSqlHandoff(search)!
    vi.setSystemTime(Date.now() + 13 * 60 * 60 * 1000)
    expect(readSqlHandoff(search)).toBeUndefined()
    expect(readSqlHandoff('?handoff=../bad')).toBeUndefined()
    window.dispatchEvent(new Event('pagehide'))
    expect(await returnSqlHandoff(transfer.returnTo!, original)).toBe(false)
  })

  it('reports blocked SQL tabs and discards their unused transfers', () => {
    vi.spyOn(window, 'open').mockReturnValue(null)
    expect(() => openSqlEditor(original, { onApply: vi.fn() })).toThrow(expect.objectContaining({ code: 'browser_popup_blocked' }))
    expect(Object.keys(localStorage).filter((key) => key.startsWith('supabi.sqlHandoff.'))).toEqual([])
  })

  it('does not acknowledge a reply the original editor rejects during a session change', async () => {
    vi.useFakeTimers()
    const tab = browserTab()
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window)
    const onApply = vi.fn(() => false as const)
    cleanup = openSqlEditor(original, { onApply })
    const transfer = readSqlHandoff(new URL(tab.location.replace.mock.calls[0]![0] as string, window.location.origin).search)!
    connectTabs()
    const delivered = returnSqlHandoff(transfer.returnTo!, original)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await delivered).toBe(false)
    expect(onApply).toHaveBeenCalledExactlyOnceWith(original)
  })
})
