import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import i18n from 'i18next'
import '../../i18n'
import type { Schemas } from '../../api/client'

const server = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('../../api/client', async (original) => ({
  ...(await original<typeof import('../../api/client')>()),
  api: { GET: server.get },
}))
import { AIUsage } from './AIUsage'

const response = (data: unknown) => ({ data, response: { ok: true } })

const usage = (calls: number, costs: Schemas['AICost'][], patch: Partial<Schemas['AIUsage']> = {}): Schemas['AIUsage'] => ({
  calls, failed: 0, stopped: 0, estimated: 0, inputTokens: calls * 1000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: calls * 100, costs, ...patch,
})
const total = usage(5, [{ currency: 'CNY', amount: '12.3' }, { currency: 'USD', amount: '0.0508' }], { failed: 1, stopped: 2, estimated: 1, inputTokens: 406832 })

const groupsBy: Record<string, Schemas['AIUsageGroup'][]> = {
  user: [
    { key: 'u_admin', displayName: 'Admin', email: 'admin@example.com', usage: usage(3, [{ currency: 'USD', amount: '0.0508' }]) },
    { key: 'u_dev', displayName: 'Dev', email: 'dev@example.com', usage: usage(2, [{ currency: 'CNY', amount: '12.3' }]) },
  ],
  workspace: [
    { key: 'ws_sales', workspaceName: 'Sales', usage: usage(3, [{ currency: 'CNY', amount: '12.3' }, { currency: 'USD', amount: '0.05' }]) },
    { key: '', usage: usage(1, [{ currency: 'USD', amount: '0.000001' }]) },
    { key: 'ws_gone', usage: usage(1, [{ currency: 'CNY', amount: '0' }]) },
  ],
  model: [{ key: '["OpenRouter","claude-haiku"]', provider: 'OpenRouter', model: 'claude-haiku', usage: usage(5, [{ currency: 'USD', amount: '0.0508' }]) }],
  purpose: [{ key: 'compression', usage: usage(5, [{ currency: 'USD', amount: '0.0508' }]) }],
  day: [{ key: '2026-10-25', usage: usage(5, [{ currency: 'USD', amount: '0.0508' }]) }],
}

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  server.get.mockReset().mockImplementation(async (_path: string, options: { params: { query: { groupBy: string } } }) =>
    response({ total, answers: 4, groups: groupsBy[options.params.query.groupBy] }))
})
afterEach(cleanup)

it('sums the last 30 days, each currency apart, without a word of the conversations', async () => {
  render(<AIUsage />)
  expect(await screen.findByText('CNY 12.30 · USD 0.0508')).toBeTruthy()
  expect(screen.getByText('5 · 1 failed · 2 stopped')).toBeTruthy()
  expect(screen.getByText(/Input 406,832 · Cache hits 0 · Cache writes 0 · Output 500/)).toBeTruthy()
  expect(screen.getByText('(1 call estimated from the length of its text)')).toBeTruthy()

  const query = server.get.mock.calls[0]![1].params.query
  expect(server.get).toHaveBeenCalledWith('/ai/usage', expect.anything())
  expect(query.groupBy).toBe('user')
  expect(query.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
  // From the start of the day 29 days ago to the end of today.
  const days = (Date.parse(query.to) - Date.parse(query.from)) / 86_400_000
  expect(Math.round(days)).toBe(30)
  expect(Date.parse(query.to)).toBeGreaterThan(Date.now())

  const table = screen.getByRole('table', { name: 'AI usage' })
  expect(within(table).getByText('Admin')).toBeTruthy()
  expect(within(table).getByText('dev@example.com')).toBeTruthy()
  expect(within(table).getByText('CNY 12.30')).toBeTruthy()
})

it('shows a failed load rather than the figures of an earlier choice', async () => {
  render(<AIUsage />)
  await screen.findByText('CNY 12.30 · USD 0.0508')
  server.get.mockResolvedValueOnce({ error: { code: 'unexpected_error', message: 'boom' }, response: { ok: false, status: 500, statusText: 'Internal Server Error' } })
  fireEvent.click(screen.getByRole('radio', { name: 'By model' }))
  expect(await screen.findByRole('button', { name: 'Retry' })).toBeTruthy()
  expect(screen.queryByText('CNY 12.30 · USD 0.0508')).toBeNull()
  expect(screen.queryByRole('table')).toBeNull()
  // The choices stay, to try again or choose another.
  expect(screen.getByRole('radio', { name: 'By model' }).getAttribute('aria-checked')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findByText('OpenRouter · claude-haiku')).toBeTruthy()
})

it('names each grouping as people know it', async () => {
  render(<AIUsage />)
  await screen.findByRole('table', { name: 'AI usage' })
  fireEvent.click(screen.getByRole('radio', { name: 'By workspace' }))
  await waitFor(() => expect(screen.getByRole('columnheader', { name: 'Workspace' })).toBeTruthy())
  const table = screen.getByRole('table', { name: 'AI usage' })
  expect(within(table).getByText('Sales')).toBeTruthy()
  expect(within(table).getByText('CNY 12.30 · USD 0.05')).toBeTruthy()
  // A test of a model is in no workspace, and costs next to nothing rather than nothing.
  expect(within(table).getByText('Tests of models')).toBeTruthy()
  expect(within(table).getByText('USD < 0.0001')).toBeTruthy()
  expect(within(table).getByText('Deleted workspace')).toBeTruthy()

  fireEvent.click(screen.getByRole('radio', { name: 'By model' }))
  expect(await screen.findByText('OpenRouter · claude-haiku')).toBeTruthy()
  fireEvent.click(screen.getByRole('radio', { name: 'By purpose' }))
  expect(await screen.findByText('Context compression')).toBeTruthy()
  fireEvent.click(screen.getByRole('radio', { name: 'By day' }))
  expect(await screen.findByText(new Date('2026-10-25T00:00:00').toLocaleDateString('en-US'))).toBeTruthy()
})
