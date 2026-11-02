import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import i18n from 'i18next'
import '../../i18n'
import type { Dataset, LogicalType } from '../../api/client'

const server = vi.hoisted(() => ({
  type: 'integer' as string,
  empty: false,
  blankCondition: false,
  users: [] as { id: string; displayName: string; email: string; status: string }[],
  role: 'developer' as 'viewer' | 'developer' | 'admin',
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
}))

vi.mock('../../auth/session', async (original) => {
  const session = await original<typeof import('../../auth/session')>()
  return { ...session, useSession: () => ({ atLeast: (min: import('../../auth/session').Role) => session.atLeast(server.role, min) }) }
})

vi.mock('../../api/client', async (original) => ({
  ...(await original<typeof import('../../api/client')>()),
  api: {
    GET: async (path: string, options: unknown) => {
      server.get(path, options)
      const policy = { unmatched: 'all', rows: server.empty ? [] : [{ subjects: [{ everyone: true }], filter: server.blankCondition ? {} : { field: 'value', op: 'in', value: [] } }], columns: [] }
      const dataset = { id: 'orders', name: 'Orders', spec: { fields: [{ key: 'value', label: 'Value', type: server.type, role: 'dimension' }] } }
      const data = path === '/users' ? server.users : path === '/user-attributes' ? [{ key: 'regions', name: 'Regions', builtin: false, assignments: [] }] : path === '/datasets' ? [dataset] : path === '/datasets/{id}' ? dataset : path === '/datasets/{id}/policy' ? policy : []
      return { data, response: { ok: true } }
    },
    POST: server.post,
    PUT: server.put,
  },
}))

import { DatasetPermissions } from './DatasetPermissions'

const dataset = (): Dataset => ({ id: 'orders', name: 'Orders', description: '', datasourceId: 'source', revision: 1, validationStatus: 'valid', updatedAt: '', spec: { fields: [{ key: 'value', label: 'Value', type: server.type, role: 'dimension' }] } })

beforeEach(async () => {
  vi.resetAllMocks()
  server.empty = false
  server.blankCondition = false
  server.users = []
  server.role = 'developer'
  await i18n.changeLanguage('en-US')
  server.put.mockImplementation(async (_path, { body }) => ({ data: body, response: { ok: true } }))
})
afterEach(cleanup)

it('blocks saving and previewing an incomplete rule until its condition is complete', async () => {
  server.blankCondition = true
  server.type = 'string'
  server.post.mockResolvedValue({ data: { rows: [['East']], meta: { truncated: false } }, response: { ok: true } })
  render(<DatasetPermissions dataset={dataset()} />)
  expect((await screen.findByRole('button', { name: i18n.t('policy.previewTitle') }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole('button', { name: i18n.t('common.save') }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.edit') }))
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).queryByText('All rows')).toBeNull()
  expect((within(dialog).getByRole('button', { name: i18n.t('policy.applyRule') }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(within(dialog).getByRole('combobox', { name: i18n.t('policy.conditionField') }))
  fireEvent.click(await screen.findByRole('option', { name: 'Value' }))
  await waitFor(() => expect(screen.queryByPlaceholderText('Search')).toBeNull())
  fireEvent.click(within(dialog).getByRole('combobox', { name: i18n.t('filter.value') }))
  fireEvent.click(await screen.findByRole('option', { name: 'East' }))
  fireEvent.keyDown(screen.getByPlaceholderText('Search'), { key: 'Escape' })
  fireEvent.click(within(dialog).getByRole('button', { name: i18n.t('policy.applyRule') }))
  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.save') }))
  await waitFor(() => expect(server.put).toHaveBeenCalledTimes(1))
  const rows = server.put.mock.calls[0]![1].body.rows
  expect(rows.at(-1).filter).toEqual({ field: 'value', op: 'in', value: ['East'] })
})

it('waits for a complete numeric search before querying', async () => {
  server.type = 'integer'
  server.post.mockResolvedValue({ data: { rows: [[1]], meta: { truncated: false } }, response: { ok: true } })
  render(<DatasetPermissions dataset={dataset()} />)
  fireEvent.click(await screen.findByRole('button', { name: i18n.t('common.edit') }))
  fireEvent.click(screen.getByRole('combobox', { name: i18n.t('filter.value') }))
  expect(await screen.findByRole('option', { name: '1' })).toBeTruthy()
  fireEvent.change(screen.getByPlaceholderText('Search'), { target: { value: '-' } })
  await waitFor(() => expect(screen.queryByRole('option', { name: '1' })).toBeNull())
  expect(server.post).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each([
  ['integer', '001001', 1001, 1001],
  ['decimal', '1e3', '1e3', '1000.00'],
] satisfies [LogicalType, string, unknown, unknown][])('finds and saves a %s value outside the initial candidate page', async (type, search, typed, returned) => {
  server.type = type
  server.post.mockImplementation(async (_path, { body }) => {
    const filter = body.query.filter
    if (filter && (filter.op !== 'eq' || filter.value !== typed)) {
      return { error: { code: 'invalid_filter_value', message: 'Invalid typed search' }, response: { ok: false, status: 400 } }
    }
    // The requested value is absent from the first, truncated candidate page.
    return { data: { rows: filter ? [[returned]] : [[1]], meta: { truncated: !filter } }, response: { ok: true } }
  })
  render(<DatasetPermissions dataset={dataset()} />)
  fireEvent.click(await screen.findByRole('button', { name: i18n.t('common.edit') }))
  fireEvent.click(screen.getByRole('combobox', { name: i18n.t('filter.value') }))
  expect(await screen.findByRole('option', { name: '1' })).toBeTruthy()
  fireEvent.change(screen.getByPlaceholderText('Search'), { target: { value: search } })
  const option = await screen.findByRole('option', { name: String(returned) })
  expect(server.post).toHaveBeenLastCalledWith('/query', { body: { query: {
    version: 1, dataset: 'orders', dimensions: [{ field: 'value' }], limit: 500,
    filter: { field: 'value', op: 'eq', value: typed },
  } } })
  fireEvent.click(option)
  fireEvent.keyDown(screen.getByPlaceholderText('Search'), { key: 'Escape' })
  fireEvent.click(screen.getByRole('button', { name: i18n.t('policy.applyRule') }))
  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.save') }))
  await waitFor(() => expect(server.put).toHaveBeenCalledWith('/datasets/{id}/policy', {
    params: { path: { id: 'orders' } },
    body: { unmatched: 'all', rows: [{ subjects: [{ everyone: true }], filter: { field: 'value', op: 'in', value: [returned] } }], columns: [] },
  }))
})

it('does not load or edit permissions for viewers', () => {
  server.role = 'viewer'
  render(<DatasetPermissions dataset={dataset()} />)
  expect(screen.queryByRole('button')).toBeNull()
  expect(server.get).not.toHaveBeenCalled()
})

it.each(['developer', 'admin'] as const)('lets a %s configure and save permissions', async (role) => {
  server.role = role
  server.post.mockResolvedValue({ data: { rows: [[1]], meta: { truncated: false } }, response: { ok: true } })
  render(<DatasetPermissions dataset={dataset()} />)
  fireEvent.click(await screen.findByRole('button', { name: i18n.t('common.edit') }))
  fireEvent.click(screen.getByRole('combobox', { name: i18n.t('filter.value') }))
  fireEvent.click(await screen.findByRole('option', { name: '1' }))
  fireEvent.keyDown(screen.getByPlaceholderText('Search'), { key: 'Escape' })
  expect(server.get).toHaveBeenCalledWith('/users', undefined)
  expect(server.get).toHaveBeenCalledWith('/groups', undefined)
  fireEvent.click(screen.getByRole('button', { name: i18n.t('policy.applyRule') }))
  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.save') }))
  await waitFor(() => expect(server.put).toHaveBeenCalledWith('/datasets/{id}/policy', {
    params: { path: { id: 'orders' } },
    body: { unmatched: 'all', rows: [{ subjects: [{ everyone: true }], filter: { field: 'value', op: 'in', value: [1] } }], columns: [] },
  }))
})

it('reports unsaved permission edits to the dataset editor and clears them on discard', async () => {
  server.post.mockResolvedValue({ data: { rows: [[1]], meta: { truncated: false } }, response: { ok: true } })
  const onDirtyChange = vi.fn()
  render(<DatasetPermissions dataset={dataset()} onDirtyChange={onDirtyChange} />)
  fireEvent.click(await screen.findByRole('radio', { name: i18n.t('policy.unmatchedNone') }))
  await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true))
  fireEvent.click(screen.getByRole('button', { name: i18n.t('policy.discard') }))
  await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false))
  expect(server.get.mock.calls.some(([path]) => path === '/datasets' || path === '/datasets/{id}')).toBe(false)
})


it('keeps dynamic conditions incomplete until an attribute is selected and saves the reference', async () => {
  server.type = 'string'
  server.post.mockResolvedValue({ data: { rows: [['East']], meta: { truncated: false } }, response: { ok: true } })
  render(<DatasetPermissions dataset={dataset()} />)
  fireEvent.click(await screen.findByRole('button', { name: i18n.t('common.edit') }))
  fireEvent.click(screen.getByRole('radio', { name: i18n.t('policy.dynamic') }))
  expect((screen.getByRole('button', { name: i18n.t('policy.applyRule') }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('combobox', { name: i18n.t('attribute.title') }))
  fireEvent.click(await screen.findByRole('option', { name: 'Regions' }))
  fireEvent.click(screen.getByRole('button', { name: i18n.t('policy.applyRule') }))
  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.save') }))
  await waitFor(() => expect(server.put).toHaveBeenCalledWith('/datasets/{id}/policy', expect.objectContaining({ body: expect.objectContaining({ rows: [{ subjects: [{ everyone: true }], filter: { field: 'value', op: 'in', value: { userAttr: 'regions' } } }] }) })))
})

it('does not publish incomplete additional conditions or discard edits on cancel without confirmation', async () => {
  server.type = 'string'
  server.post.mockResolvedValue({ data: { rows: [['East']], meta: { truncated: false } }, response: { ok: true } })
  render(<DatasetPermissions dataset={dataset()} />)
  fireEvent.click(await screen.findByRole('button', { name: i18n.t('common.edit') }))
  fireEvent.click(screen.getByRole('combobox', { name: i18n.t('filter.value') }))
  fireEvent.click(await screen.findByRole('option', { name: 'East' }))
  fireEvent.keyDown(screen.getByPlaceholderText('Search'), { key: 'Escape' })
  fireEvent.click(screen.getByRole('button', { name: i18n.t('policy.addCondition') }))
  expect((screen.getByRole('button', { name: i18n.t('policy.applyRule') }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.cancel') }))
  const confirm = screen.getByRole('dialog', { name: i18n.t('policy.discard') })
  fireEvent.click(within(confirm).getByRole('button', { name: i18n.t('policy.discard') }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(server.put).not.toHaveBeenCalled()
  expect((screen.getByRole('button', { name: i18n.t('common.save') }) as HTMLButtonElement).disabled).toBe(true)
})

it('copies a rule without overwriting the original and preserves names on save', async () => {
  server.type = 'string'
  server.post.mockResolvedValue({ data: { rows: [['East']], meta: { truncated: false } }, response: { ok: true } })
  render(<DatasetPermissions dataset={dataset()} />)
  fireEvent.click(await screen.findByRole('button', { name: i18n.t('policy.copy') }))
  fireEvent.click(screen.getByRole('combobox', { name: i18n.t('filter.value') }))
  fireEvent.click(await screen.findByRole('option', { name: 'East' }))
  fireEvent.keyDown(screen.getByPlaceholderText('Search'), { key: 'Escape' })
  fireEvent.change(screen.getByRole('textbox', { name: i18n.t('policy.ruleName') }), { target: { value: 'Eastern team' } })
  fireEvent.click(screen.getByRole('button', { name: i18n.t('policy.applyRule') }))
  expect(screen.getByText('Eastern team')).toBeTruthy()
  expect(screen.getAllByRole('button', { name: i18n.t('common.edit') })).toHaveLength(2)
  // The untouched original is still incomplete, so saving cannot accidentally grant all rows.
  expect((screen.getByRole('button', { name: i18n.t('common.save') }) as HTMLButtonElement).disabled).toBe(true)
  expect(server.put).not.toHaveBeenCalled()
})

it('enables on the first saved rule and disables on removal of the last rule', async () => {
  server.empty = true
  render(<DatasetPermissions dataset={dataset()} />)
  expect(await screen.findByText(i18n.t('policy.emptyTitle'))).toBeTruthy()
  expect(screen.queryByRole('button', { name: i18n.t('common.save') })).toBeNull()
  expect(screen.queryByRole('region', { name: i18n.t('policy.scopeTitle') })).toBeNull()
  expect(screen.queryByRole('table')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: i18n.t('policy.addRule') }))
  const editor = screen.getByRole('dialog')
  expect(within(editor).queryByText('All rows')).toBeNull()
  expect(within(editor).getByRole('combobox', { name: i18n.t('policy.conditionField') })).toBeTruthy()
  expect((within(editor).getByRole('button', { name: i18n.t('policy.applyRule') }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('radio', { name: i18n.t('policy.columnType') }))
  fireEvent.click(screen.getByRole('combobox', { name: i18n.t('policy.sensitiveFields') }))
  fireEvent.click(await screen.findByRole('option', { name: 'Value' }))
  fireEvent.keyDown(screen.getByRole('combobox', { name: i18n.t('policy.sensitiveFields') }), { key: 'Escape' })
  fireEvent.click(screen.getByRole('button', { name: i18n.t('policy.applyRule') }))
  expect(screen.getByRole('region', { name: i18n.t('policy.scopeTitle') })).toBeTruthy()
  expect((screen.getByRole('radio', { name: i18n.t('policy.unmatchedNone') }) as HTMLInputElement).checked).toBe(true)
  expect(screen.getByRole('region', { name: i18n.t('policy.detailsTitle') })).toBeTruthy()
  fireEvent.click(screen.getByRole('radio', { name: i18n.t('policy.columnHidden') }))
  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.save') }))
  await waitFor(() => expect((screen.getByRole('button', { name: i18n.t('common.save') }) as HTMLButtonElement).disabled).toBe(true))
  expect(server.put.mock.calls[0]![1].body.columnMode).toBe('hidden')
  expect(server.put.mock.calls[0]![1].body.unmatched).toBe('none')
  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.delete') }))
  expect(screen.getByText(i18n.t('policy.deleteLastHint'))).toBeTruthy()
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: i18n.t('common.delete') }))
  expect(screen.getByText(i18n.t('policy.pendingDisableTitle'))).toBeTruthy()
  // Removing a rule is still a draft until explicitly saved.
  expect(server.put).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.save') }))
  expect(await screen.findByText(i18n.t('policy.emptyTitle'))).toBeTruthy()
  expect(server.put.mock.calls[1]![1].body).toEqual({ unmatched: 'none', columnMode: 'hidden', rows: [], columns: [] })
  expect(screen.queryByRole('table')).toBeNull()
  expect(screen.getByRole('button', { name: i18n.t('policy.addRule') })).toBeTruthy()
})


it('searches preview users by display name and email and previews the selected identity', async () => {
  server.type = 'integer'
  server.users = [
    { id: 'u1', displayName: 'Alice', email: 'sales@example.com', status: 'active' },
    { id: 'u2', displayName: 'Bob', email: 'finance@example.com', status: 'active' },
    { id: 'u3', displayName: 'Inactive', email: 'inactive@example.com', status: 'disabled' },
  ]
  server.post.mockImplementation(async (path) => ({ data: path === '/query' ? { rows: [[1]], meta: { truncated: false } } : { restricted: true, hiddenFields: [], result: { columns: [], rows: [] } }, response: { ok: true } }))
  render(<DatasetPermissions dataset={dataset()} />)
  fireEvent.click(await screen.findByRole('button', { name: i18n.t('common.edit') }))
  fireEvent.click(screen.getByRole('combobox', { name: i18n.t('filter.value') }))
  fireEvent.click(await screen.findByRole('option', { name: '1' }))
  fireEvent.keyDown(screen.getByPlaceholderText('Search'), { key: 'Escape' })
  fireEvent.click(screen.getByRole('button', { name: i18n.t('policy.applyRule') }))
  fireEvent.click(screen.getByRole('button', { name: i18n.t('policy.previewTitle') }))
  const dialog = screen.getByRole('dialog', { name: i18n.t('policy.previewTitle') })
  expect((within(dialog).getByRole('button', { name: i18n.t('policy.preview') }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(within(dialog).getByRole('combobox', { name: i18n.t('policy.previewUser') }))
  expect(screen.queryByRole('option', { name: 'Inactive (inactive@example.com)' })).toBeNull()
  const search = screen.getByPlaceholderText('Search')
  fireEvent.change(search, { target: { value: 'alice' } })
  expect(await screen.findByRole('option', { name: 'Alice (sales@example.com)' })).toBeTruthy()
  expect(screen.queryByRole('option', { name: 'Bob (finance@example.com)' })).toBeNull()
  fireEvent.change(search, { target: { value: 'FINANCE@' } })
  expect(await screen.findByRole('option', { name: 'Bob (finance@example.com)' })).toBeTruthy()
  expect(screen.queryByRole('option', { name: 'Alice (sales@example.com)' })).toBeNull()
  fireEvent.click(screen.getByRole('option', { name: 'Bob (finance@example.com)' }))
  fireEvent.click(within(dialog).getByRole('button', { name: i18n.t('policy.preview') }))
  await waitFor(() => expect(server.post).toHaveBeenLastCalledWith('/datasets/{id}/policy/preview', expect.objectContaining({ body: expect.objectContaining({ userId: 'u2' }) })))
})
