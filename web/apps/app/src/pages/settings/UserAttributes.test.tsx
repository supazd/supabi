import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { openPopup } from '@supabi/ui/testing'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import i18n from 'i18next'
import '../../i18n'

const server = vi.hoisted(() => ({ admin: true, put: vi.fn(), remove: vi.fn() }))
vi.mock('../../auth/session', () => ({ useSession: () => ({ atLeast: () => server.admin }) }))
vi.mock('../../api/client', async (original) => ({
  ...(await original<typeof import('../../api/client')>()),
  api: {
    GET: async (path: string) => ({ data: path === '/users' ? [{ id: 'u1', email: 'one@example.com', displayName: 'One', status: 'active' }]
      : path === '/groups' ? [{ id: 'g1', name: 'East group', userIds: ['u1'] }]
      : [{ key: 'email', name: 'email', builtin: true, assignments: [] }, { key: 'regions', name: 'Regions', builtin: false, assignments: [{ subject: { group: 'g1' }, values: ['East'] }] }], response: { ok: true } }),
    PUT: server.put,
    DELETE: server.remove,
  },
}))
import { UserAttributes } from './UserAttributes'

beforeEach(async () => {
  server.admin = true
  server.put.mockReset().mockResolvedValue({ data: {}, response: { ok: true } })
  server.remove.mockReset().mockResolvedValue({ data: undefined, response: { ok: true } })
  await i18n.changeLanguage('en-US')
})
afterEach(cleanup)

it('shows inherited values and saves an explicit override without removing the group assignment', async () => {
  render(<UserAttributes />)
  expect(await screen.findByText(/Inherited from groups/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Edit Regions for One' }))
  fireEvent.click(screen.getByRole('radio', { name: i18n.t('attribute.setValues') }))
  fireEvent.change(screen.getByRole('textbox', { name: i18n.t('attribute.values') }), { target: { value: 'West\nSouth' } })
  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.save') }))
  await waitFor(() => expect(server.put).toHaveBeenCalledWith('/user-attributes/{key}', {
    params: { path: { key: 'regions' } }, body: { name: 'Regions', assignments: [{ subject: { group: 'g1' }, values: ['East'] }, { subject: { user: 'u1' }, values: ['West', 'South'] }] },
  }))
})

it('lets developers inspect attributes without offering assignment or definition writes', async () => {
  server.admin = false
  render(<UserAttributes />)
  expect(await screen.findByText(/Inherited from groups/)).toBeTruthy()
  expect(screen.getByText('East')).toBeTruthy()
  expect(screen.queryByRole('button', { name: i18n.t('attribute.bulk') })).toBeNull()
  expect(screen.queryByRole('button', { name: i18n.t('attribute.add') })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Edit Regions for One' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'More actions for Regions' })).toBeNull()
})

it('deletes an attribute from its column, once asked', async () => {
  render(<UserAttributes />)
  openPopup(await screen.findByRole('button', { name: 'More actions for Regions' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: i18n.t('attribute.delete') }))
  expect(server.remove).not.toHaveBeenCalled()
  fireEvent.click(within(await screen.findByRole('dialog', { name: 'Delete attribute: Regions' })).getByRole('button', { name: i18n.t('common.confirmDelete') }))
  await waitFor(() => expect(server.remove).toHaveBeenCalledExactlyOnceWith('/user-attributes/{key}', { params: { path: { key: 'regions' } } }))
})
