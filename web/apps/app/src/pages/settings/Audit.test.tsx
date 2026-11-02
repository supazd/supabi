import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import i18n from 'i18next'
import '../../i18n'
import type { AuditEvent } from '../../api/client'

const server = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('../../api/client', async (original) => ({
  ...(await original<typeof import('../../api/client')>()),
  api: { GET: server.get },
}))
import { Audit } from './Audit'

const response = (data: unknown) => ({ data, response: { ok: true } })

const event = (id: string, patch: Partial<AuditEvent> = {}): AuditEvent => ({
  id, occurredAt: '2026-10-19T08:00:00Z', category: 'content', action: 'chart.update', outcome: 'success',
  actor: { id: 'alex', email: 'alex@example.com', displayName: 'Alex' }, workspace: { id: 'sales', name: 'Sales' },
  object: { type: 'chart', id: 'ch_1', name: 'Revenue' }, detail: {}, clientIp: '10.0.0.1', forwardedFor: '', userAgent: 'Firefox', ...patch,
})

const query = event('q', {
  category: 'query', action: 'query.run', object: { type: 'dashboard', id: 'db_1', name: 'Sales board' },
  detail: { statements: [{ kind: 'main', datasourceId: 'src_1', sql: 'SELECT region FROM orders', args: ['2026-01-01'], durationMs: 12, rows: 3, cached: true }] },
})
const failedLogin = event('l', {
  category: 'auth', action: 'auth.login', outcome: 'failure', workspace: undefined, object: undefined,
  actor: { email: 'nobody@example.com' }, detail: { reason: 'unknown_account' },
})
const created = event('u', {
  category: 'account', action: 'user.create', workspace: undefined, object: { type: 'user', id: 'u_2', name: 'kim@example.com' },
  detail: { request: { email: 'kim@example.com', password: '[redacted]' } },
})

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  server.get.mockReset().mockImplementation(async (path: string, options?: { params?: { query?: Record<string, string | undefined> } }) => {
    if (path === '/users') return response([{ id: 'alex', email: 'alex@example.com', displayName: 'Alex', status: 'active', isOrgAdmin: false }])
    if (path === '/workspaces') return response([{ id: 'sales', name: 'Sales', timezone: 'UTC', weekStart: 1 }])
    const q = options?.params?.query ?? {}
    if (q.cursor === 'page2') return response({ items: [event('older', { action: 'chart.delete' })] })
    if (q.category === 'auth') return response({ items: [failedLogin] })
    return response({ items: [query, failedLogin, created], nextCursor: 'page2' })
  })
})
afterEach(cleanup)

it('lists events in words, with why a failure failed', async () => {
  render(<Audit />)
  const table = await screen.findByRole('table', { name: 'Audit log' })
  expect(within(table).getByText('Read data')).toBeTruthy()
  expect(within(table).getByText('Dashboard · Sales board')).toBeTruthy()
  expect(within(table).getByText('Failed · No such account')).toBeTruthy()
  expect(within(table).getByText('nobody@example.com')).toBeTruthy()
})

it('asks the server again when a filter changes, and pages on from where it ended', async () => {
  render(<Audit />)
  await screen.findByRole('table', { name: 'Audit log' })
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
  expect(await screen.findByText('Delete chart')).toBeTruthy()
  expect(server.get).toHaveBeenCalledWith('/audit-events', { params: { query: expect.objectContaining({ cursor: 'page2' }) } })
  expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()

  fireEvent.click(screen.getByRole('combobox', { name: 'Event' }))
  fireEvent.click(await screen.findByRole('option', { name: 'Sign-in' }))
  await waitFor(() => expect(server.get).toHaveBeenLastCalledWith('/audit-events', { params: { query: expect.objectContaining({ category: 'auth', cursor: undefined }) } }))
  await waitFor(() => expect(screen.queryByText('Delete chart')).toBeNull())
  expect(screen.getByRole('button', { name: 'Clear filters' })).toBeTruthy()
})

it('shows the statements of a query and what was sent without its password', async () => {
  render(<Audit />)
  await screen.findByRole('table', { name: 'Audit log' })
  fireEvent.click(screen.getByRole('button', { name: 'Details of Read data' }))
  const dialog = await screen.findByRole('dialog', { name: 'Event details' })
  expect(within(dialog).getByText('From the cache')).toBeTruthy()
  expect(within(dialog).getByText('["2026-01-01"]')).toBeTruthy()
  expect(within(dialog).getByText('10.0.0.1')).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))

  fireEvent.click(screen.getByRole('button', { name: 'Details of Create account' }))
  const account = await screen.findByRole('dialog', { name: 'Event details' })
  const sent = within(account).getByRole('region', { name: 'What was sent' })
  expect(sent.textContent).toContain('"password": "[redacted]"')
})
