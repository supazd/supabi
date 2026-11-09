import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from 'i18next'
import '../i18n'
import type { Role, SessionInfo } from '../auth/session'
import type { ColorScheme } from '@supabi/ui'

const session = vi.hoisted(() => ({ role: 'viewer' as Role, isOrgAdmin: false }))
const roles: Role[] = ['viewer', 'developer', 'admin']
vi.mock('../auth/session', () => ({ useSession: () => ({ atLeast: (min: Role) => roles.indexOf(session.role) >= roles.indexOf(min), isOrgAdmin: session.isOrgAdmin }) }))

import { Topbar } from './Topbar'

const workspace = { id: 'current', name: 'Main workspace', timezone: 'UTC', weekStart: 1, firstWeekDays: 4 as const }
const info: SessionInfo = { authenticated: true, setupRequired: false, user: { id: 'user', displayName: 'Alex', email: 'alex@example.com', isOrgAdmin: false }, workspace, workspaces: [workspace, { id: 'other', name: 'Other workspace', timezone: 'UTC', weekStart: 1, firstWeekDays: 4 as const }] }

function open({ busy = false, pending = busy, path = '/dashboards', data = info, colorScheme = 'light' }: { busy?: boolean; pending?: boolean; path?: string; data?: SessionInfo; colorScheme?: ColorScheme } = {}) {
  const onSwitchWorkspace = vi.fn()
  const onSignOut = vi.fn()
  const onLocaleChange = vi.fn()
  const onColorSchemeChange = vi.fn()
  const router = createMemoryRouter([{ path: '*', element: <Topbar info={data} colorScheme={colorScheme} locale="en-US" onSwitchWorkspace={onSwitchWorkspace} onSignOut={onSignOut} onLocaleChange={onLocaleChange} onColorSchemeChange={onColorSchemeChange} busy={busy} pending={pending} /> }], { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return { router, onSwitchWorkspace, onSignOut, onLocaleChange, onColorSchemeChange }
}

beforeEach(async () => {
  session.role = 'viewer'
  session.isOrgAdmin = false
  await i18n.changeLanguage('en-US')
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

/** Menus open on the press of the pointer, as the browser's own menus do. */
const openMenu = (trigger: HTMLElement) => fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })

describe('Topbar', () => {
  it('opens separate personal, system, and workspace settings destinations', async () => {
    session.role = 'admin'
    session.isOrgAdmin = true
    const { router } = open()
    openMenu(screen.getByRole('button', { name: 'Account menu for Alex' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Personal settings/ }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/personal/account'))
    openMenu(screen.getByRole('button', { name: 'Account menu for Alex' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'System administration' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/system/users'))
    fireEvent.click(screen.getByRole('link', { name: 'Workspace settings' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/workspace'))
  })

  it('lets developers reach workspace attributes without showing system administration', async () => {
    session.role = 'developer'
    open()
    expect(screen.getByRole('link', { name: 'Workspace settings' })).toBeTruthy()
    openMenu(screen.getByRole('button', { name: 'Account menu for Alex' }))
    await screen.findByRole('menuitem', { name: /Personal settings/ })
    expect(screen.queryByText('System administration')).toBeNull()
  })

  it('offers system administration without a selected workspace', async () => {
    session.isOrgAdmin = true
    open({ data: { ...info, workspace: undefined, workspaces: [] } })
    openMenu(screen.getByRole('button', { name: 'Account menu for Alex' }))
    expect(await screen.findByRole('menuitem', { name: 'System administration' })).toBeTruthy()
    expect(screen.queryByText('Workspace settings')).toBeNull()
    // Exports are not tied to the current workspace, so they stay reachable.
    expect(screen.getByRole('button', { name: 'Exports' })).toBeTruthy()
  })

  it('keeps the workspace visible with one membership and hides unavailable navigation and administration', async () => {
    open({ data: { ...info, workspaces: [workspace] } })
    expect(screen.getByRole('link', { name: 'My dashboards' })).toBeTruthy()
    // Viewers export chart data too, so the entry is the same for every role.
    expect(screen.getByRole('button', { name: 'Exports' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Workbench' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Data exploration' })).toBeNull()
    openMenu(screen.getByRole('button', { name: 'Current workspace: Main workspace' }))
    expect((await screen.findByRole('menuitem', { name: 'Main workspace' })).getAttribute('aria-disabled')).toBe('true')
    expect(screen.queryByText('Workspace settings')).toBeNull()
    expect(screen.queryByText('Manage members')).toBeNull()
    openMenu(screen.getByRole('button', { name: 'Account menu for Alex' }))
    expect(await screen.findByText('Personal settings')).toBeTruthy()
    expect(screen.queryByText('System administration')).toBeNull()
  })

  it('orders the destinations with the assistant after the dashboards, exploration after the workbench and workspace settings last', () => {
    session.role = 'developer'
    open({ path: '/settings/workspace/general' })
    const links = within(screen.getByRole('navigation', { name: 'Main navigation' })).getAllByRole('link')
    expect(links.map((link) => link.textContent)).toEqual(['My dashboards', 'AI assistant', 'Workbench', 'Data exploration', 'Workspace settings'])
    expect(links[4]!.getAttribute('aria-current')).toBe('page')
  })

  it('gives viewers their dashboards and the assistant', () => {
    session.role = 'viewer'
    open({ path: '/assistant/conv_1' })
    const links = within(screen.getByRole('navigation', { name: 'Main navigation' })).getAllByRole('link')
    expect(links.map((link) => link.textContent)).toEqual(['My dashboards', 'AI assistant'])
    expect(links[1]!.getAttribute('aria-current')).toBe('page')
  })

  it('opens exploration independently and returns to its current handoff without replacing it', async () => {
    session.role = 'developer'
    const { router } = open({ path: '/explore?handoff=editing' })
    const explore = screen.getByRole('link', { name: 'Data exploration' })
    expect(explore.getAttribute('aria-current')).toBe('page')
    const key = router.state.location.key
    fireEvent.click(explore)
    expect(router.state.location.key).toBe(key)
    fireEvent.click(screen.getByRole('link', { name: 'Workbench' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/workbench'))
    fireEvent.click(screen.getByRole('link', { name: 'Data exploration' }))
    await waitFor(() => expect(router.state.location.pathname + router.state.location.search).toBe('/explore?handoff=editing'))
  })

  it('switches only to another workspace and keeps settings out of the workspace menu', async () => {
    session.role = 'admin'
    const { onSwitchWorkspace } = open()
    openMenu(screen.getByRole('button', { name: 'Current workspace: Main workspace' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Main workspace' }))
    expect(onSwitchWorkspace).not.toHaveBeenCalled()
    expect(screen.queryByRole('menuitem', { name: 'Workspace settings' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Manage members' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Other workspace' }))
    expect(onSwitchWorkspace).toHaveBeenCalledExactlyOnceWith('other')
  })

  it('opens the account menu from the keyboard and invokes nested preferences and sign out', async () => {
    session.isOrgAdmin = true
    const { onLocaleChange, onSignOut } = open()
    const trigger = screen.getByRole('button', { name: 'Account menu for Alex' })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowDown', keyCode: 40 })
    expect(await screen.findByRole('menuitem', { name: 'System administration' })).toBeTruthy()
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape', keyCode: 27 })
    await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'))
    expect(document.activeElement).toBe(trigger)
    fireEvent.keyDown(trigger, { key: 'ArrowDown', keyCode: 40 })
    fireEvent.keyDown(await screen.findByRole('menuitem', { name: /Language/ }), { key: 'ArrowRight' })
    fireEvent.click(await screen.findByRole('menuitem', { name: '简体中文' }))
    expect(onLocaleChange).toHaveBeenCalledExactlyOnceWith('zh-CN')
    openMenu(trigger)
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Sign out' }))
    expect(onSignOut).toHaveBeenCalledTimes(1)
  })

  it('restores the last workbench URL and keeps the tab active for all workbench sections', async () => {
    session.role = 'developer'
    const { router } = open({ path: '/workbench/charts/sales?tab=data' })
    expect(screen.getByRole('link', { name: 'Workbench' }).getAttribute('aria-current')).toBe('page')
    await act(async () => { await router.navigate('/workbench/datasets/orders') })
    fireEvent.click(screen.getByRole('link', { name: 'My dashboards' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/dashboards'))
    expect(screen.getByRole('link', { name: 'Workbench' }).getAttribute('href')).toBe('/workbench/datasets/orders')
    fireEvent.click(screen.getByRole('link', { name: 'Workbench' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/workbench/datasets/orders'))
  })

  it('keeps editor state and location key when the current workbench tab is clicked again', async () => {
    session.role = 'developer'
    const { router } = open()
    await act(async () => { await router.navigate('/workbench/charts/new?dataset=orders', { state: { chartEditorKey: 'active-draft' } }) })
    const location = router.state.location
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    fireEvent(screen.getByRole('link', { name: 'Workbench' }), click)
    expect(click.defaultPrevented).toBe(true)
    expect(router.state.location).toBe(location)
    expect(router.state.location.state).toEqual({ chartEditorKey: 'active-draft' })

    const modifiedClick = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, metaKey: true })
    // Inspect whether the router intercepted the click, then suppress jsdom's external navigation.
    let intercepted = true
    const suppressExternalNavigation = (event: Event) => { intercepted = event.defaultPrevented; event.preventDefault() }
    document.addEventListener('click', suppressExternalNavigation, { once: true })
    fireEvent(screen.getByRole('link', { name: 'Workbench' }), modifiedClick)
    expect(intercepted).toBe(false)
    expect(router.state.location).toBe(location)
  })

  it('keeps narrow-screen language choices in the same menu', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    const { onLocaleChange } = open()
    openMenu(screen.getByRole('button', { name: 'Account menu for Alex' }))
    expect(await screen.findByRole('menuitem', { name: '简体中文' })).toBeTruthy()
    expect(screen.queryByText('Appearance')).toBeNull()
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    expect(screen.queryByRole('menuitem', { name: 'Language' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: '简体中文' }))
    expect(onLocaleChange).toHaveBeenCalledExactlyOnceWith('zh-CN')
  })

  it.each(['light', 'dark'] as const)('switches the %s appearance directly beside the avatar', async (colorScheme) => {
    const { onColorSchemeChange } = open({ colorScheme })
    const button = screen.getByRole('button', { name: colorScheme === 'light' ? 'Switch to dark' : 'Switch to light' })
    fireEvent.click(button)
    expect(onColorSchemeChange).toHaveBeenCalledExactlyOnceWith(colorScheme === 'light' ? 'dark' : 'light')
    openMenu(screen.getByRole('button', { name: 'Account menu for Alex' }))
    await screen.findByRole('menu')
    expect(screen.queryByText('Appearance')).toBeNull()
  })

  it('disables actions during confirmation without announcing an active request', () => {
    open({ busy: true, pending: false })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Account menu for Alex' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Switch to dark' }).disabled).toBe(true)
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('banner').getAttribute('aria-busy')).toBe('false')
  })

  it('disables session actions and navigation while a session change is pending', () => {
    session.role = 'developer'
    const { router, onSignOut, onSwitchWorkspace } = open({ busy: true })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Current workspace: Main workspace' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Account menu for Alex' }).disabled).toBe(true)
    expect(screen.getByRole('status', { name: 'Loading…' })).toBeTruthy()
    fireEvent.click(screen.getByRole('link', { name: 'Workbench' }))
    fireEvent.click(screen.getByRole('link', { name: 'SupaBI · Home' }))
    expect(router.state.location.pathname).toBe('/dashboards')
    expect(onSignOut).not.toHaveBeenCalled()
    expect(onSwitchWorkspace).not.toHaveBeenCalled()
  })
})
