// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from 'i18next'
import '../i18n'
import { UnsavedChangesProvider, useUnsavedActions, useUnsavedChanges } from './UnsavedChanges'

function Editor({ dirty, hidden = false }: { dirty: boolean; hidden?: boolean }) {
  useUnsavedChanges(dirty)
  return <div hidden={hidden}>Editor</div>
}

function Actions({ first, second }: { first: () => void; second: () => void }) {
  const { confirmDiscard } = useUnsavedActions()
  return <><button onClick={() => confirmDiscard(first)}>First action</button><button onClick={() => confirmDiscard(second)}>Second action</button></>
}

function refreshIsBlocked() {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
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

describe('unsaved editor registrations', () => {
  it('protects all mounted editors, including hidden tabs, until each is saved or unmounted', () => {
    const first = vi.fn()
    const second = vi.fn()
    const page = (visibleDirty: boolean, hiddenDirty: boolean | null) => (
      <StrictMode>
        <UnsavedChangesProvider>
          <Editor dirty={visibleDirty} />
          {hiddenDirty !== null && <Editor dirty={hiddenDirty} hidden />}
          <Actions first={first} second={second} />
        </UnsavedChangesProvider>
      </StrictMode>
    )
    const view = render(page(true, true))
    expect(refreshIsBlocked()).toBe(true)

    view.rerender(page(false, true))
    expect(refreshIsBlocked()).toBe(true)
    fireEvent.click(screen.getByRole('button', { hidden: true, name: 'First action' }))
    expect(first).not.toHaveBeenCalled()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Stay' }))

    view.rerender(page(false, false))
    expect(refreshIsBlocked()).toBe(false)
    fireEvent.click(screen.getByRole('button', { hidden: true, name: 'First action' }))
    expect(first).toHaveBeenCalledTimes(1)

    view.rerender(page(false, true))
    expect(refreshIsBlocked()).toBe(true)
    view.rerender(page(false, null))
    expect(refreshIsBlocked()).toBe(false)
    fireEvent.click(screen.getByRole('button', { hidden: true, name: 'Second action' }))
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('keeps the first requested action while awaiting confirmation and cancellation keeps the protection', () => {
    const first = vi.fn()
    const second = vi.fn()
    render(<UnsavedChangesProvider><Editor dirty /><Actions first={first} second={second} /></UnsavedChangesProvider>)

    fireEvent.click(screen.getByRole('button', { hidden: true, name: 'First action' }))
    fireEvent.click(screen.getByRole('button', { hidden: true, name: 'Second action' }))
    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Stay' }))
    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()
    expect(refreshIsBlocked()).toBe(true)

    fireEvent.click(screen.getByRole('button', { hidden: true, name: 'Second action' }))
    fireEvent.click(screen.getByRole('button', { hidden: true, name: 'First action' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Discard and leave' }))
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    // Confirming an action alone must not disable refresh protection if that action fails.
    expect(refreshIsBlocked()).toBe(true)
  })

  it('removes its refresh listener when the provider unmounts', () => {
    const view = render(<UnsavedChangesProvider><Editor dirty /></UnsavedChangesProvider>)
    expect(refreshIsBlocked()).toBe(true)
    view.unmount()
    expect(refreshIsBlocked()).toBe(false)
  })

  it('restores refresh protection if the confirmed document departure throws', () => {
    const failedDeparture = vi.fn()
    function Departure() {
      const { leaveDocument } = useUnsavedActions()
      return <button onClick={() => {
        try { leaveDocument(() => { throw new Error('reload unavailable') }) } catch { failedDeparture() }
      }}>Leave document</button>
    }
    render(<UnsavedChangesProvider><Editor dirty /><Departure /></UnsavedChangesProvider>)
    fireEvent.click(screen.getByRole('button', { hidden: true, name: 'Leave document' }))
    expect(failedDeparture).toHaveBeenCalledTimes(1)
    expect(refreshIsBlocked()).toBe(true)
  })
})
