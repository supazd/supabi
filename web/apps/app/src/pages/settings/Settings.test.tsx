import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from 'i18next'
import '../../i18n'
import type { Role, SessionInfo } from '../../auth/session'
import type { Group, GroupMember, Member, User } from '../../api/client'
import { openPopup } from '@supabi/ui/testing'

const server = vi.hoisted(() => ({
  role: 'admin' as Role | undefined, isOrgAdmin: true, workspace: undefined as SessionInfo['workspace'], workspaces: [] as NonNullable<SessionInfo['workspaces']>,
  users: [] as User[], groups: [] as Group[], members: [] as Member[], grants: [] as GroupMember[],
  get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), remove: vi.fn(), reload: vi.fn(),
}))
vi.mock('../../auth/session', () => ({
  roles: ['viewer', 'developer', 'admin'],
  useSession: () => ({
    state: { status: 'ok', data: { authenticated: true, setupRequired: false, user: { id: 'root', displayName: 'Root', email: 'root@example.com', isOrgAdmin: server.isOrgAdmin }, workspace: server.workspace, workspaces: server.workspaces } },
    atLeast: (role: Role) => ['viewer', 'developer', 'admin'].indexOf(server.role ?? '') >= ['viewer', 'developer', 'admin'].indexOf(role),
    isOrgAdmin: server.isOrgAdmin, reload: server.reload,
  }),
}))
vi.mock('../../api/client', async (original) => ({
  ...(await original<typeof import('../../api/client')>()),
  api: { GET: server.get, POST: server.post, PUT: server.put, PATCH: server.patch, DELETE: server.remove },
}))
import { UnsavedChangesProvider } from '../../components/UnsavedChanges'
import { Settings } from './Settings'

const workspace = { id: 'sales', name: 'Sales', timezone: 'UTC', weekStart: 1, firstWeekDays: 4 as const }
const another = { ...workspace, id: 'finance', name: 'Finance' }
const response = (data: unknown) => ({ data, response: { ok: true } })
const systemDefaults = {
  exportRetentionHours: 24, exportTimeoutMinutes: 15, exportMaxRows: 2_000_000, exportMaxSizeMb: 512, auditRetentionDays: 180, queryCacheTtlMinutes: 10,
  queryTimeoutSeconds: 60, queryDefaultRows: 1000, queryMaxRows: 10_000, sessionLifetimeHours: 168, workspaceRetentionDays: 30, mcpEnabled: false,
  assistantCompressPercent: 80, assistantMaxToolCalls: 60,
}

/** Picks an action from the menu at the end of someone's or something's row. */
async function choose(of: string, action: string) {
  openPopup(await screen.findByRole('button', { name: `More actions for ${of}` }))
  fireEvent.click(await screen.findByRole('menuitem', { name: action }))
}

function open(path: string) {
  const onManage = vi.fn()
  const onCurrentDeleted = vi.fn()
  const router = createMemoryRouter([{ path: '/settings/*', element: <Settings onManageWorkspace={onManage} onCurrentWorkspaceDeleted={onCurrentDeleted} /> }], { initialEntries: [path] })
  render(<UnsavedChangesProvider><RouterProvider router={router} /></UnsavedChangesProvider>)
  return { router, onManage, onCurrentDeleted }
}

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  server.role = 'admin'
  server.isOrgAdmin = true
  server.workspace = workspace
  server.workspaces = [workspace, another]
  server.users = [{ id: 'alex', email: 'alex@example.com', displayName: 'Alex', status: 'active', isOrgAdmin: false }]
  server.groups = [{ id: 'east', name: 'East sales', userIds: ['alex'] }]
  server.members = [{ userId: 'alex', email: 'alex@example.com', displayName: 'Alex', status: 'active', isOrgAdmin: false, role: 'viewer' }]
  server.grants = [{ groupId: 'east', name: 'East sales', role: 'developer' }]
  server.get.mockReset().mockImplementation(async (path: string) => response(({
    '/users': server.users, '/groups': server.groups, '/members': server.members, '/group-members': server.grants,
    '/workspaces': [workspace, another], '/user-attributes': [], '/system/settings': { values: {}, defaults: systemDefaults },
  } as Record<string, unknown>)[path]))
  server.post.mockReset().mockResolvedValue(response({}))
  server.put.mockReset().mockResolvedValue(response(workspace))
  server.patch.mockReset().mockResolvedValue(response({}))
  server.remove.mockReset().mockResolvedValue(response({}))
  server.reload.mockReset()
})
afterEach(cleanup)

describe('separate settings scopes', () => {
  it.each([
    ['/settings/personal/account', 'Personal settings', ['My account', 'MCP']],
    ['/settings/system/users', 'System administration', ['User management', 'Groups', 'Workspaces', 'AI models', 'AI usage', 'Audit log', 'General']],
    ['/settings/workspace/general', 'Sales · Workspace settings', ['General', 'Members and access', 'User attributes']],
  ] as const)('shows only the navigation for %s', async (path, title, links) => {
    open(path)
    await screen.findByRole('heading', { level: 1, name: title })
    expect(within(screen.getByRole('navigation', { name: title })).getAllByRole('link').map((link) => link.textContent)).toEqual(links)
    if (path.includes('workspace')) {
      expect(screen.queryByText('All workspaces')).toBeNull()
      expect(screen.queryByRole('button', { name: 'New workspace' })).toBeNull()
    }
    await act(async () => {})
  })

  it('saves which week is a year\'s first with the workspace, once something has changed', async () => {
    open('/settings/workspace/general')
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    openPopup(await screen.findByRole('combobox', { name: 'First week' }))
    fireEvent.click(await screen.findByRole('option', { name: 'First full week' }))
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    await waitFor(() => expect(server.put).toHaveBeenCalledExactlyOnceWith('/workspace', { body: { name: 'Sales', timezone: 'UTC', weekStart: 1, firstWeekDays: 7 } }))
  })

  it('creates a global account without assigning a role or needing a current workspace', async () => {
    server.workspace = undefined
    server.role = undefined
    open('/settings/system/users')
    await screen.findByText('alex@example.com')
    fireEvent.click(screen.getByRole('button', { name: 'Add user' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Email' }), { target: { value: 'new@example.com' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'New user' } })
    fireEvent.change(screen.getByLabelText(/^Initial password/), { target: { value: 'test-password' } })
    expect(screen.queryByRole('combobox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(server.post).toHaveBeenCalledExactlyOnceWith('/users', { body: { email: 'new@example.com', displayName: 'New user', password: 'test-password', isOrgAdmin: false } }))
  })

  it('lets administrators manage a selected workspace from the global list', async () => {
    const { onManage } = open('/settings/system/workspaces')
    fireEvent.click(await screen.findByRole('button', { name: 'Manage workspace: Finance' }))
    expect(onManage).toHaveBeenCalledExactlyOnceWith('finance')
    expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull()
  })

  it('deletes a workspace only once asked, and then offers to restore it or delete it now', async () => {
    let list: unknown[] = [workspace, another]
    server.get.mockImplementation(async (path: string) => response(path === '/workspaces' ? list : path === '/system/settings' ? { values: { workspaceRetentionDays: 7 }, defaults: systemDefaults } : []))
    let answer = () => {}
    server.remove.mockImplementation(() => new Promise((resolve) => {
      answer = () => {
        list = [workspace, { ...another, deletedAt: '2026-10-21T10:00:00Z', purgeAt: '2026-11-20T10:00:00Z' }]
        resolve(response(list[1]))
      }
    }))
    const { onCurrentDeleted } = open('/settings/system/workspaces')
    await choose('Finance', 'Delete')
    const deleting = await screen.findByRole('dialog', { name: 'Delete workspace: Finance' })
    expect(within(deleting).getByText(/After 7 days it is deleted for good/)).toBeTruthy()
    expect(server.remove).not.toHaveBeenCalled()
    fireEvent.click(within(deleting).getByRole('button', { name: 'Confirm delete' }))
    await waitFor(() => expect(server.remove).toHaveBeenCalledExactlyOnceWith('/workspaces/{id}', { params: { path: { id: 'finance' } } }))
    // While it is under way, it cannot be called off.
    expect((within(deleting).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => answer())
    // Another workspace than the session's: only the switcher changes.
    await waitFor(() => expect(server.reload).toHaveBeenCalled())
    expect(onCurrentDeleted).not.toHaveBeenCalled()

    const row = await screen.findByRole('row', { name: /Deleted · gone for good on Nov 20, 2026/ })
    expect(within(row).queryByRole('button', { name: 'Manage workspace: Finance' })).toBeNull()
    fireEvent.click(within(row).getByRole('button', { name: 'Restore workspace: Finance' }))
    const restoring = await screen.findByRole('dialog', { name: 'Restore workspace: Finance' })
    expect(within(restoring).getByText(i18n.t('workspace.restoreNote'))).toBeTruthy()
    fireEvent.click(within(restoring).getByRole('button', { name: 'Cancel' }))
    await choose('Finance', 'Delete now')
    expect(server.post).not.toHaveBeenCalled()
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Delete workspace now: Finance' })).getByRole('button', { name: 'Delete for good' }))
    await waitFor(() => expect(server.post).toHaveBeenCalledExactlyOnceWith('/workspaces/{id}/purge', { params: { path: { id: 'finance' } } }))
  })

  it('starts afresh after deleting the workspace the session is in', async () => {
    const { onCurrentDeleted } = open('/settings/system/workspaces')
    await choose('Sales', 'Delete')
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Confirm delete' }))
    await waitFor(() => expect(onCurrentDeleted).toHaveBeenCalledOnce())
    expect(server.reload).not.toHaveBeenCalled()
  })

  it.each([
    ['still has workspaces, as when the one it was in was deleted', [another], 'auth.chooseWorkspace'],
    ['has no workspace at all', [], 'auth.noWorkspace'],
  ] as const)('tells a session without a current workspace that %s what to do', (_, workspaces, notice) => {
    server.workspace = undefined
    server.workspaces = [...workspaces]
    open('/settings/workspace/general')
    expect(screen.getByText(i18n.t(notice))).toBeTruthy()
  })

  it('keeps account settings accessible without workspace membership', () => {
    server.workspace = undefined
    server.role = undefined
    server.isOrgAdmin = false
    open('/settings/personal/account')
    expect(screen.getByRole('heading', { name: 'Personal settings' })).toBeTruthy()
    expect(screen.getByText('root@example.com')).toBeTruthy()
    expect(server.get).not.toHaveBeenCalled()
  })

  it('blocks workspace administrators from global management without loading its directory', () => {
    server.isOrgAdmin = false
    open('/settings/system/groups')
    expect(screen.getByText(i18n.t('auth.forbidden'))).toBeTruthy()
    expect(server.get).not.toHaveBeenCalled()
  })

  it('limits developers to read-only workspace attributes, including direct URLs', async () => {
    server.isOrgAdmin = false
    server.role = 'developer'
    const { router } = open('/settings/workspace')
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/workspace/attributes'))
    await screen.findByRole('table', { name: 'User attributes' })
    expect(within(screen.getByRole('navigation')).getAllByRole('link').map((link) => link.textContent)).toEqual(['User attributes'])
    expect(screen.queryByRole('button', { name: 'Assign values' })).toBeNull()
    server.get.mockClear()
    await act(async () => { await router.navigate('/settings/workspace/members') })
    expect(screen.getByText(i18n.t('auth.forbidden'))).toBeTruthy()
    expect(server.get).not.toHaveBeenCalled()
  })

  it('shows effective access and retains group access after removing a direct grant', async () => {
    server.remove.mockImplementation(async () => { server.members = []; return response(undefined) })
    open('/settings/workspace/members')
    const row = await screen.findByRole('row', { name: /Alex/ })
    expect(within(row).getByText('Direct: Viewer · East sales: Developer')).toBeTruthy()
    expect(within(row).getByText('Developer')).toBeTruthy()
    await choose('Alex', 'Remove direct access')
    const dialog = await screen.findByRole('dialog', { name: 'Remove direct access for Alex' })
    expect(within(dialog).getByText('Afterwards Alex can still enter this workspace through East sales.')).toBeTruthy()
    expect(server.remove).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove direct access' }))
    await waitFor(() => expect(server.remove).toHaveBeenCalledExactlyOnceWith('/members/{userId}', { params: { path: { userId: 'alex' } } }))
    expect(await screen.findByText('East sales: Developer')).toBeTruthy()
    expect(screen.getByText('alex@example.com')).toBeTruthy()
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Authorised groups' }), { button: 0, ctrlKey: false })
    expect(screen.getByRole('table', { name: 'Authorised groups' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'New group' })).toBeNull()
  })

  it('gives a direct role to someone who is in through a group', async () => {
    server.members = []
    open('/settings/workspace/members')
    const row = await screen.findByRole('row', { name: /Alex/ })
    expect(within(row).getByText('East sales: Developer')).toBeTruthy()
    openPopup(within(row).getByRole('button', { name: 'More actions for Alex' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Grant a direct role' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Admin' }))
    await waitFor(() => expect(server.post).toHaveBeenCalledExactlyOnceWith('/members', { body: { userId: 'alex', role: 'admin' } }))
  })

  it('asks before making someone a system administrator, and never offers it for oneself', async () => {
    server.users = [...server.users, { id: 'root', email: 'root@example.com', displayName: 'Root', status: 'active', isOrgAdmin: true }]
    open('/settings/system/users')
    await screen.findByText('alex@example.com')
    expect(screen.queryByRole('button', { name: 'More actions for Root' })).toBeNull()
    await choose('Alex', 'Make system administrator')
    expect(server.patch).not.toHaveBeenCalled()
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Make system administrator' }))
    await waitFor(() => expect(server.patch).toHaveBeenCalledExactlyOnceWith('/users/{id}', { params: { path: { id: 'alex' } }, body: { isOrgAdmin: true } }))
  })

  it('keeps a list on the page when it cannot be loaded again after a change, and says so', async () => {
    open('/settings/system/users')
    await screen.findByText('alex@example.com')
    server.get.mockRejectedValueOnce(new Error('the server is away'))
    await choose('Alex', 'Make system administrator')
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Make system administrator' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText('alex@example.com')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('finds people by name or email', async () => {
    server.users = [...server.users, { id: 'blair', email: 'b.lee@example.com', displayName: 'Blair', status: 'disabled', isOrgAdmin: false }]
    open('/settings/system/users')
    await screen.findByText('alex@example.com')
    expect(within(screen.getByRole('row', { name: /Blair/ })).getByText('Disabled')).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: 'Search by name or email' }), { target: { value: 'LEE@' } })
    expect(screen.queryByText('alex@example.com')).toBeNull()
    expect(screen.getByText('b.lee@example.com')).toBeTruthy()
  })
})

describe('system settings', () => {
  beforeEach(() => {
    server.put.mockReset().mockImplementation(async (_path: string, { body }: { body: unknown }) => response({ values: body, defaults: systemDefaults }))
  })

  it('leaves a setting at its default until something is typed, and keeps to its range', async () => {
    open('/settings/system/general')
    const rows = await screen.findByLabelText('Most rows per export') as HTMLInputElement
    expect(rows.placeholder).toBe('2000000')
    expect(screen.getByText(/Empty takes the default, 2,000,000 rows/)).toBeTruthy()
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.change(rows, { target: { value: '0' } })
    expect(screen.getByText('A whole number from 1 to 100,000,000.')).toBeTruthy()
    expect(save.disabled).toBe(true)
    fireEvent.change(rows, { target: { value: '1000' } })
    fireEvent.click(save)
    await waitFor(() => expect(server.put).toHaveBeenCalledExactlyOnceWith('/system/settings', { body: { exportMaxRows: 1000 } }))
    await waitFor(() => expect(save.disabled).toBe(true))
    // The session says how many rows queries return, so it is read again.
    expect(server.reload).toHaveBeenCalled()
  })

  it('keeps the default rows to the most, as they will apply', async () => {
    open('/settings/system/general')
    const most = await screen.findByLabelText('Most rows per query')
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    fireEvent.change(most, { target: { value: '500' } })
    expect(screen.getByText('Cannot be more than the most rows per query.')).toBeTruthy()
    expect(save.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Default rows'), { target: { value: '500' } })
    expect(screen.queryByText('Cannot be more than the most rows per query.')).toBeNull()
    fireEvent.click(save)
    await waitFor(() => expect(server.put).toHaveBeenCalledExactlyOnceWith('/system/settings', { body: { queryDefaultRows: 500, queryMaxRows: 500 } }))
  })

  it('asks before deleted workspaces are kept for less time, with anything else it deletes', async () => {
    open('/settings/system/general')
    fireEvent.change(await screen.findByLabelText('Deleted workspaces kept for'), { target: { value: '7' } })
    fireEvent.change(screen.getByLabelText('Audit events kept for'), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('kept for 7 days rather than for 30 days')
    expect(dialog.textContent).toContain('kept for 30 days rather than for 180 days')
    expect(server.put).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(server.put).toHaveBeenCalledExactlyOnceWith('/system/settings', { body: { auditRetentionDays: 30, workspaceRetentionDays: 7 } }))
  })

  it('asks before audit events are kept for less time, as some go within the hour', async () => {
    open('/settings/system/general')
    fireEvent.change(await screen.findByLabelText('Audit events kept for'), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('kept for 30 days rather than for 180 days')
    expect(server.put).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(server.put).toHaveBeenCalledExactlyOnceWith('/system/settings', { body: { auditRetentionDays: 30 } }))
    // Keeping them longer deletes nothing, and asks nothing.
    fireEvent.change(screen.getByLabelText('Audit events kept for'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(server.put).toHaveBeenLastCalledWith('/system/settings', { body: { auditRetentionDays: 0 } }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('takes 0 tool calls as no limit, and keeps the share of the context from 50 to 95', async () => {
    open('/settings/system/general')
    const share = await screen.findByLabelText('Compress context at') as HTMLInputElement
    expect(share.placeholder).toBe('80')
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    fireEvent.change(share, { target: { value: '40' } })
    expect(screen.getByText('A whole number from 50 to 95.')).toBeTruthy()
    expect(save.disabled).toBe(true)
    fireEvent.change(share, { target: { value: '90' } })
    fireEvent.change(screen.getByLabelText('Most tool calls per answer'), { target: { value: '0' } })
    fireEvent.click(save)
    await waitFor(() => expect(server.put).toHaveBeenCalledExactlyOnceWith('/system/settings', { body: { assistantCompressPercent: 90, assistantMaxToolCalls: 0 } }))
  })

  it('turns MCP clients on, and keeps the switch as set once it is', async () => {
    open('/settings/system/general')
    const mcp = await screen.findByRole('checkbox', { name: 'MCP clients' })
    expect(mcp.getAttribute('aria-checked')).toBe('false')
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    fireEvent.click(mcp)
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    await waitFor(() => expect(server.put).toHaveBeenCalledExactlyOnceWith('/system/settings', { body: { mcpEnabled: true } }))
    // Turned off again, it says so rather than following the default.
    await waitFor(() => expect(save.disabled).toBe(true))
    fireEvent.click(mcp)
    fireEvent.click(save)
    await waitFor(() => expect(server.put).toHaveBeenLastCalledWith('/system/settings', { body: { mcpEnabled: false } }))
  })
})

describe('MCP clients', () => {
  const authorizations = (enabled: boolean) => ({
    enabled, address: 'https://bi.example.com/mcp',
    items: [{ id: 'oa_1', clientName: 'Claude Code', redirectHost: 'localhost', authorizedAt: '2026-11-01T08:00:00Z', lastUsedAt: '2026-11-02T08:00:00Z' }],
  })

  it('shows the address to connect, and revokes a client the person allowed', async () => {
    server.get.mockImplementation(async (path: string) => response(path === '/mcp/authorizations' ? authorizations(true) : {}))
    open('/settings/personal/mcp')
    expect(((await screen.findByRole('textbox', { name: 'MCP address' })) as HTMLInputElement).value).toBe('https://bi.example.com/mcp')
    expect(screen.queryByText(/turned MCP off/)).toBeNull()
    expect(screen.getByText('Claude Code')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    const dialog = await screen.findByRole('dialog', { name: 'Revoke Claude Code' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }))
    await waitFor(() => expect(server.remove).toHaveBeenCalledExactlyOnceWith('/mcp/authorizations/{id}', { params: { path: { id: 'oa_1' } } }))
  })

  it('says when an administrator has turned MCP off', async () => {
    server.get.mockImplementation(async (path: string) => response(path === '/mcp/authorizations' ? authorizations(false) : {}))
    open('/settings/personal/mcp')
    expect(await screen.findByText(/An administrator has turned MCP off/)).toBeTruthy()
    expect(screen.getByText('Claude Code')).toBeTruthy()
  })
})
