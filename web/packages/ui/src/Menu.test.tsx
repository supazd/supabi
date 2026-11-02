import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Menu, type MenuItem } from './Menu'

const items = [
  { key: 'disabled', label: 'Unavailable', disabled: true },
  { key: 'settings', label: 'Personal settings' },
  { key: 'sign-out', label: 'Sign out' },
]

function ControlledMenu({ menuItems = items }: { menuItems?: MenuItem[] }) {
  const [open, setOpen] = useState(false)
  return <Menu items={menuItems} open={open} onOpenChange={setOpen}><button type="button">Account</button></Menu>
}

/** A menu opens on the press of the pointer, as the browser's own menus do. */
function pointerOpen(element: HTMLElement) {
  act(() => element.focus())
  fireEvent.pointerDown(element, { button: 0, ctrlKey: false, pointerType: 'mouse' })
}

const keyboardOpen = (element: HTMLElement, key: string) => {
  act(() => element.focus())
  fireEvent.keyDown(element, { key })
}

const isItem = (element: Element | null) => element?.getAttribute('role') === 'menuitem'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('Menu focus', () => {
  it('leaves the items unfocused after pointer opening, so modifier keys show no focus ring', async () => {
    render(<ControlledMenu />)
    const trigger = screen.getByRole('button', { name: 'Account' })
    pointerOpen(trigger)
    expect(await screen.findByRole('menuitem', { name: 'Personal settings' })).toBeTruthy()
    expect(isItem(document.activeElement)).toBe(false)
    fireEvent.keyDown(document.activeElement!, { key: 'Shift', shiftKey: true })
    expect(isItem(document.activeElement)).toBe(false)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
  })

  it.each(['Enter', ' ', 'ArrowDown'])('focuses the first enabled item after opening with %j', async (key) => {
    render(<ControlledMenu />)
    keyboardOpen(screen.getByRole('button', { name: 'Account' }), key)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Personal settings' })))
  })

  it('navigates items with the arrow keys and returns focus with Escape', async () => {
    render(<ControlledMenu />)
    const trigger = screen.getByRole('button', { name: 'Account' })
    keyboardOpen(trigger, 'ArrowDown')
    const settings = await screen.findByRole('menuitem', { name: 'Personal settings' })
    await waitFor(() => expect(document.activeElement).toBe(settings))
    fireEvent.keyDown(settings, { key: 'ArrowDown' })
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Sign out' })))
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'))
    expect(document.activeElement).toBe(trigger)
  })

  it('moves into a pointer-opened menu when ArrowDown is pressed', async () => {
    render(<ControlledMenu />)
    pointerOpen(screen.getByRole('button', { name: 'Account' }))
    await screen.findByRole('menuitem', { name: 'Personal settings' })
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Personal settings' })))
  })

  it.each([false, true])('closes on Tab and leaves the browser to move on from the trigger (shift: %s)', async (shiftKey) => {
    render(<ControlledMenu />)
    const trigger = screen.getByRole('button', { name: 'Account' })
    keyboardOpen(trigger, 'ArrowDown')
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Personal settings' })))
    const tab = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true })
    fireEvent(document.activeElement!, tab)
    await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'))
    // JSDOM does not perform native Tab navigation; focus is ready for the browser to continue.
    expect(document.activeElement).toBe(trigger)
    expect(tab.defaultPrevented).toBe(false)
  })

  it('returns from a submenu before closing the main menu on Escape', async () => {
    render(<ControlledMenu menuItems={[{ key: 'language', label: 'Language', children: [{ key: 'en', label: 'English' }] }]} />)
    const trigger = screen.getByRole('button', { name: 'Account' })
    keyboardOpen(trigger, 'ArrowDown')
    const language = await screen.findByRole('menuitem', { name: 'Language' })
    await waitFor(() => expect(document.activeElement).toBe(language))
    fireEvent.keyDown(language, { key: 'ArrowRight' })
    const english = await screen.findByRole('menuitem', { name: 'English' })
    await waitFor(() => expect(document.activeElement).toBe(english))
    fireEvent.keyDown(english, { key: 'Escape' })
    await waitFor(() => expect(document.activeElement).toBe(language))
    expect(screen.queryByRole('menuitem', { name: 'English' })).toBeNull()
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(language, { key: 'Escape' })
    await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'))
    expect(document.activeElement).toBe(trigger)
  })

  it('preserves child handlers and supports uncontrolled keyboard opening', async () => {
    const onKeyDown = vi.fn()
    const onPointerDown = vi.fn()
    render(<Menu items={items}><button type="button" onKeyDown={onKeyDown} onPointerDown={onPointerDown}>Account</button></Menu>)
    const trigger = screen.getByRole('button', { name: 'Account' })
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'))
    keyboardOpen(trigger, 'ArrowDown')
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Personal settings' })))
    expect(onPointerDown).toHaveBeenCalledOnce()
    expect(onKeyDown).toHaveBeenCalledOnce()
  })

  it('runs the chosen action and does not count the choice as a click on what holds the menu', async () => {
    const onSelect = vi.fn()
    const outer = vi.fn()
    render(<div onClick={outer}><Menu items={[{ key: 'go', label: 'Go', onSelect }]}><button type="button">Actions</button></Menu></div>)
    keyboardOpen(screen.getByRole('button', { name: 'Actions' }), 'Enter')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Go' }))
    expect(onSelect).toHaveBeenCalledOnce()
    expect(outer).not.toHaveBeenCalled()
  })
})
