// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from 'i18next'
import '../i18n'

const server = vi.hoisted(() => ({
  post: vi.fn(), get: vi.fn(), writeDraft: vi.fn(), setSession: vi.fn(),
  session: { authenticated: true, setupRequired: false, user: { id: 'user-1' }, workspace: { id: 'current' } },
}))
vi.mock('../api/client', async (original) => ({ ...(await original<typeof import('../api/client')>()), api: { POST: server.post, GET: server.get } }))
vi.mock('./session', () => ({
  useSession: () => ({ state: { status: 'ok', data: server.session }, set: server.setSession }),
}))

import { UnsavedChangesProvider, useUnsavedActions, useUnsavedChanges } from '../components/UnsavedChanges'
import { useSessionActions } from './useSessionActions'

function Editor({ name, hidden = false }: { name: string; hidden?: boolean }) {
  const [text, setText] = useState('')
  const { isSessionChanging } = useUnsavedActions()
  useUnsavedChanges(text !== '')
  return <div hidden={hidden}>
    <input aria-label={name} value={text} onChange={(event) => setText(event.target.value)} />
    <button onClick={() => { if (!isSessionChanging()) server.writeDraft(text) }}>Save {name}</button>
  </div>
}

function Actions({ reload }: { reload: () => void }) {
  const { switchWorkspace, signOut, busy, pending, error, needsRecovery, recovering, retryRecovery } = useSessionActions(reload)
  // Keep these enabled to exercise the hook's protection against repeated invocations.
  return <>
    <button onClick={() => switchWorkspace('next')}>Switch workspace</button>
    <button onClick={() => switchWorkspace('current')}>Current workspace</button>
    <button onClick={() => switchWorkspace('next', '/settings/workspace/general')}>Manage workspace</button>
    <button onClick={signOut}>Sign out</button>
    <button onClick={retryRecovery}>Retry recovery</button>
    <output data-testid="busy">{String(busy)}</output>
    <output data-testid="pending">{String(pending)}</output>
    <output data-testid="needs-recovery">{String(needsRecovery)}</output>
    <output data-testid="recovering">{String(recovering)}</output>
    {error && <div role="alert">{error.code}: {error.message}</div>}
  </>
}

function open(reload = vi.fn()) {
  render(<UnsavedChangesProvider><Editor name="Chart name" /><Editor name="Hidden SQL" hidden /><Actions reload={reload} /></UnsavedChangesProvider>)
  return reload
}

function editBoth() {
  fireEvent.change(screen.getByLabelText('Chart name'), { target: { value: 'Draft chart' } })
  fireEvent.change(screen.getByLabelText('Hidden SQL'), { target: { value: 'select draft' } })
}

function expectDraftsIntact() {
  expect((screen.getByLabelText('Chart name') as HTMLInputElement).value).toBe('Draft chart')
  expect((screen.getByLabelText('Hidden SQL') as HTMLInputElement).value).toBe('select draft')
}

function expectDraftWriteBlocked() {
  const writes = server.writeDraft.mock.calls.length
  fireEvent.click(screen.getByRole('button', { hidden: true, name: 'Save Chart name' }))
  expect(server.writeDraft).toHaveBeenCalledTimes(writes)
}

function refreshIsBlocked() {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

function confirm() {
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Discard and leave' }))
}

function response(status = 204, data?: unknown) {
  return {
    response: { ok: status < 400, status, statusText: '' },
    data,
    error: status < 400 ? undefined : { code: 'temporary_failure', message: 'Please try again' },
  }
}

function deferredResponse() {
  let resolve!: (value: ReturnType<typeof response>) => void
  const promise = new Promise<ReturnType<typeof response>>((done) => { resolve = done })
  return { promise, resolve }
}

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  server.post.mockReset().mockResolvedValue(response())
  server.get.mockReset().mockResolvedValue(response(200, server.session))
  server.writeDraft.mockReset()
  server.setSession.mockReset()
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never
  window.matchMedia ??= (() => ({ matches: false, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined })) as never
  const computedStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => computedStyle(element))
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const actions = [
  { name: 'Switch workspace', path: '/auth/workspace', args: ['/auth/workspace', { body: { workspaceId: 'next' } }] },
  { name: 'Sign out', path: '/auth/logout', args: ['/auth/logout'] },
] as const

describe.each(actions)('$name with unsaved editors', ({ name, path, args }) => {
  it('asks before the POST, preserves drafts on cancellation, and accepts only one confirmed request', async () => {
    const request = deferredResponse()
    server.post.mockReturnValue(request.promise)
    const reload = open(vi.fn(() => { expect(refreshIsBlocked()).toBe(false) }))
    editBoth()

    fireEvent.click(screen.getByRole('button', { hidden: true, name }))
    expect(screen.getByTestId('busy').textContent).toBe('true')
    expect(screen.getByTestId('pending').textContent).toBe('false')
    expect(server.post).not.toHaveBeenCalled()
    expectDraftWriteBlocked()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Stay' }))
    expect(server.post).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
    expect(server.setSession).not.toHaveBeenCalled()
    expectDraftsIntact()
    expect(refreshIsBlocked()).toBe(true)
    expect(screen.getByTestId('busy').textContent).toBe('false')
    fireEvent.click(screen.getByRole('button', { hidden: true, name: 'Save Chart name' }))
    expect(server.writeDraft).toHaveBeenCalledExactlyOnceWith('Draft chart')

    fireEvent.click(screen.getByRole('button', { hidden: true, name }))
    // A competing session action cannot replace the action the user is confirming.
    fireEvent.click(screen.getByRole('button', { hidden: true, name: name === 'Sign out' ? 'Switch workspace' : 'Sign out' }))
    expect(server.post).not.toHaveBeenCalled()
    confirm()
    expect(server.post).toHaveBeenCalledExactlyOnceWith(...args)
    expect(screen.getByTestId('pending').textContent).toBe('true')
    expect(reload).not.toHaveBeenCalled()
    expect(server.setSession).not.toHaveBeenCalled()
    expectDraftsIntact()
    expect(refreshIsBlocked()).toBe(true)
    expectDraftWriteBlocked()

    fireEvent.click(screen.getByRole('button', { hidden: true, name: 'Switch workspace' }))
    fireEvent.click(screen.getByRole('button', { hidden: true, name: 'Sign out' }))
    expect(server.post).toHaveBeenCalledTimes(1)
    await act(async () => { request.resolve(response()) })
    expect(server.get).not.toHaveBeenCalled()
    if (path === '/auth/workspace') {
      expect(reload).toHaveBeenCalledTimes(1)
      expect(server.setSession).not.toHaveBeenCalled()
      expect(refreshIsBlocked()).toBe(false)
    } else {
      expect(server.setSession).toHaveBeenCalledExactlyOnceWith({ authenticated: false, setupRequired: false })
      expect(reload).not.toHaveBeenCalled()
    }
    // Completion keeps actions locked until the actual reload or signed-out shell unmount.
    fireEvent.click(screen.getByRole('button', { hidden: true, name }))
    expect(server.post).toHaveBeenCalledTimes(1)
    expectDraftWriteBlocked()
  })

  it.each(['network', 'http'] as const)('keeps the page and refresh protection after a %s failure, then allows a confirmed retry', async (failure) => {
    const verification = deferredResponse()
    server.get.mockReturnValueOnce(verification.promise)
    if (failure === 'network') server.post.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    else server.post.mockResolvedValueOnce(response(503))
    const reload = open()
    editBoth()
    fireEvent.click(screen.getByRole('button', { hidden: true, name }))
    confirm()

    await waitFor(() => expect(server.get).toHaveBeenCalledExactlyOnceWith('/auth/session'))
    expect(screen.getByTestId('pending').textContent).toBe('true')
    expect(screen.getByTestId('busy').textContent).toBe('true')
    expect(screen.getByTestId('recovering').textContent).toBe('true')
    expectDraftWriteBlocked()
    fireEvent.click(screen.getByRole('button', { hidden: true, name: 'Switch workspace' }))
    fireEvent.click(screen.getByRole('button', { hidden: true, name: 'Sign out' }))
    expect(server.post).toHaveBeenCalledTimes(1)
    expect(reload).not.toHaveBeenCalled()
    expect(server.setSession).not.toHaveBeenCalled()
    expectDraftsIntact()
    expect(refreshIsBlocked()).toBe(true)
    await act(async () => { verification.resolve(response(200, server.session)) })

    expect((await screen.findByRole('alert')).textContent).toContain(failure === 'network' ? 'network_error' : 'temporary_failure')
    expect(server.post).toHaveBeenCalledExactlyOnceWith(...args)
    expect(server.setSession).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
    expect(screen.getByTestId('pending').textContent).toBe('false')
    expect(screen.getByTestId('busy').textContent).toBe('false')
    expectDraftsIntact()
    expect(refreshIsBlocked()).toBe(true)
    fireEvent.click(screen.getByRole('button', { hidden: true, name: 'Save Chart name' }))
    expect(server.writeDraft).toHaveBeenCalledExactlyOnceWith('Draft chart')

    fireEvent.click(screen.getByRole('button', { hidden: true, name }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(server.post).toHaveBeenCalledTimes(1)
    confirm()
    await waitFor(() => expect(path === '/auth/workspace' ? reload : server.setSession).toHaveBeenCalledTimes(1))
    expect(server.post).toHaveBeenCalledTimes(2)
  })

  it.each(['workspace', 'user', 'signed-out'] as const)('adopts the server session if the POST response is lost after the %s has changed', async (changed) => {
    const current = changed === 'signed-out'
      ? { authenticated: false, setupRequired: false }
      : { ...server.session, ...(changed === 'workspace' ? { workspace: { id: 'next' } } : { user: { id: 'user-2' } }) }
    server.post.mockRejectedValueOnce(new TypeError('Response lost'))
    server.get.mockResolvedValueOnce(response(200, current))
    const reload = open(vi.fn(() => { expect(refreshIsBlocked()).toBe(false) }))
    editBoth()
    fireEvent.click(screen.getByRole('button', { hidden: true, name }))
    confirm()

    await waitFor(() => expect(changed === 'signed-out' ? server.setSession : reload).toHaveBeenCalledTimes(1))
    expect(server.post).toHaveBeenCalledExactlyOnceWith(...args)
    expect(server.get).toHaveBeenCalledExactlyOnceWith('/auth/session')
    if (changed === 'signed-out') {
      expect(server.setSession).toHaveBeenCalledExactlyOnceWith(current)
      expect(reload).not.toHaveBeenCalled()
    } else {
      expect(server.setSession).not.toHaveBeenCalled()
      expect(refreshIsBlocked()).toBe(false)
    }
    expect(screen.getByTestId('pending').textContent).toBe('true')
    expect(screen.getByTestId('needs-recovery').textContent).toBe('false')
    expectDraftWriteBlocked()
    fireEvent.click(screen.getByRole('button', { hidden: true, name: 'Switch workspace' }))
    fireEvent.click(screen.getByRole('button', { hidden: true, name: 'Sign out' }))
    expect(server.post).toHaveBeenCalledTimes(1)
  })

  it('locks editors after failed verification and retries only GET until the original session is confirmed', async () => {
    server.post.mockResolvedValueOnce(response(503))
    server.get.mockRejectedValueOnce(new TypeError('Session check unavailable'))
    const verification = deferredResponse()
    server.get.mockReturnValueOnce(verification.promise)
    const reload = open()
    editBoth()
    fireEvent.click(screen.getByRole('button', { hidden: true, name }))
    confirm()

    await waitFor(() => expect(screen.getByTestId('needs-recovery').textContent).toBe('true'))
    expect(screen.getByRole('alert').textContent).toContain('network_error')
    expect(screen.getByTestId('pending').textContent).toBe('true')
    expect(screen.getByTestId('busy').textContent).toBe('true')
    expect(screen.getByTestId('recovering').textContent).toBe('false')
    expect(server.get).toHaveBeenCalledExactlyOnceWith('/auth/session')
    expectDraftsIntact()
    expect(refreshIsBlocked()).toBe(true)
    expectDraftWriteBlocked()
    fireEvent.click(screen.getByRole('button', { hidden: true, name: 'Switch workspace' }))
    fireEvent.click(screen.getByRole('button', { hidden: true, name: 'Sign out' }))
    expect(server.post).toHaveBeenCalledExactlyOnceWith(...args)

    fireEvent.click(screen.getByRole('button', { hidden: true, name: 'Retry recovery' }))
    fireEvent.click(screen.getByRole('button', { hidden: true, name: 'Retry recovery' }))
    expect(server.get).toHaveBeenCalledTimes(2)
    expect(server.get).toHaveBeenLastCalledWith('/auth/session')
    expect(screen.getByTestId('recovering').textContent).toBe('true')
    expect(screen.getByTestId('pending').textContent).toBe('true')
    expect(screen.getByTestId('busy').textContent).toBe('true')
    expectDraftWriteBlocked()
    fireEvent.click(screen.getByRole('button', { hidden: true, name }))
    expect(server.post).toHaveBeenCalledTimes(1)
    expect(reload).not.toHaveBeenCalled()
    expect(server.setSession).not.toHaveBeenCalled()

    await act(async () => { verification.resolve(response(200, server.session)) })
    expect(screen.getByTestId('needs-recovery').textContent).toBe('false')
    expect(screen.getByTestId('recovering').textContent).toBe('false')
    expect(screen.getByTestId('pending').textContent).toBe('false')
    expect(screen.getByTestId('busy').textContent).toBe('false')
    expect(screen.getByRole('alert').textContent).toContain('temporary_failure')
    expect(server.post).toHaveBeenCalledTimes(1)
    expectDraftsIntact()
    expect(refreshIsBlocked()).toBe(true)
    fireEvent.click(screen.getByRole('button', { hidden: true, name: 'Save Chart name' }))
    expect(server.writeDraft).toHaveBeenCalledExactlyOnceWith('Draft chart')
    fireEvent.click(screen.getByRole('button', { hidden: true, name: 'Retry recovery' }))
    expect(server.get).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { hidden: true, name }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(server.post).toHaveBeenCalledTimes(1)
  })
})

describe('workspace changes', () => {
  it('opens the selected workspace settings only after the switch succeeds', async () => {
    const reload = open()
    editBoth()
    fireEvent.click(screen.getByRole('button', { hidden: true, name: 'Manage workspace' }))
    expect(server.post).not.toHaveBeenCalled()
    confirm()
    await waitFor(() => expect(reload).toHaveBeenCalledExactlyOnceWith('/settings/workspace/general'))
    expect(server.post).toHaveBeenCalledExactlyOnceWith('/auth/workspace', { body: { workspaceId: 'next' } })
  })

  it('keeps the settings destination when a lost response is reconciled', async () => {
    server.post.mockRejectedValueOnce(new Error('lost response'))
    server.get.mockResolvedValueOnce(response(200, { ...server.session, workspace: { id: 'next' } }))
    const reload = open()
    fireEvent.click(screen.getByRole('button', { hidden: true, name: 'Manage workspace' }))
    await waitFor(() => expect(reload).toHaveBeenCalledExactlyOnceWith('/settings/workspace/general'))
  })

  it('does nothing when the current workspace is chosen, even with unsaved changes', () => {
    const reload = open()
    editBoth()
    fireEvent.click(screen.getByRole('button', { hidden: true, name: 'Current workspace' }))
    expect(server.post).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(reload).not.toHaveBeenCalled()
    expect(screen.getByTestId('busy').textContent).toBe('false')
    expectDraftsIntact()
    expect(refreshIsBlocked()).toBe(true)
  })

  it('changes a clean workspace without a dialog', async () => {
    const reload = vi.fn(() => { expect(refreshIsBlocked()).toBe(false) })
    open(reload)
    fireEvent.click(screen.getByRole('button', { hidden: true, name: 'Switch workspace' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    expect(server.post).toHaveBeenCalledExactlyOnceWith('/auth/workspace', { body: { workspaceId: 'next' } })
  })
})
