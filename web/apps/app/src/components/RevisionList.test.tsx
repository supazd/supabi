import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from 'i18next'
import '../i18n'
import type { Schemas } from '../api/client'

type RequestOptions = { params?: { path?: Record<string, string>; query?: { before?: number } } }
type MockOutcome = { data?: unknown; response: { ok: boolean } }

const server = vi.hoisted(() => ({
  pages: {} as Record<string, Schemas['RevisionPage']>,
  get: vi.fn<(path: string, options?: RequestOptions) => Promise<MockOutcome>>(),
}))
vi.mock('../api/client', async (original) => {
  const real = await original<typeof import('../api/client')>()
  return { ...real, api: { GET: server.get } }
})

import { RevisionList } from './RevisionList'

const saved = (revision: number, name = '销售看板', createdByName: string | null = '张三'): Schemas['RevisionSummary'] =>
  ({ revision, name, createdAt: `2026-10-${10 + revision}T08:00:00Z`, ...(createdByName ? { createdBy: 'u1', createdByName } : {}) })

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN')
  server.pages = {}
  server.get.mockReset().mockImplementation((path, options) =>
    Promise.resolve({ data: server.pages[`${path}?${options?.params?.query?.before ?? ''}`] ?? { items: [] }, response: { ok: true } }))
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const rows = () => within(screen.getByRole('list', { name: '修订历史' })).getAllByRole('listitem').map((row) => row.textContent)

describe('RevisionList', () => {
  it('lists who saved and when, marks the current one and the names it had before', async () => {
    server.pages['/dashboards/{id}/revisions?'] = { items: [saved(3), saved(2, '旧名'), saved(1, '旧名', null)] }
    render(<RevisionList kind="dashboard" id="db_1" revision={3} />)
    await screen.findByRole('list', { name: '修订历史' })
    const [current, renamed, system] = rows()
    expect(current).toMatch(/^v3.*张三当前$/)
    expect(renamed).toMatch(/^v2.*张三当时名为「旧名」$/)
    expect(system).toMatch(/^v1.*系统当时名为「旧名」$/)
    expect(server.get).toHaveBeenCalledWith('/dashboards/{id}/revisions', { params: { path: { id: 'db_1' }, query: { before: undefined } } })
    // History starting at revision 1 has nothing missing to point out.
    expect(screen.queryByText(/之前没有记录/)).toBeNull()
  })

  it('loads older pages, then says where the record starts', async () => {
    server.pages['/charts/{id}/revisions?'] = { items: [saved(9), saved(8)], nextBefore: 8 }
    server.pages['/charts/{id}/revisions?8'] = { items: [saved(7)] }
    render(<RevisionList kind="chart" id="ch_1" revision={9} />)
    fireEvent.click(await screen.findByRole('button', { name: '加载更早版本' }))
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(screen.queryByRole('button', { name: '加载更早版本' })).toBeNull()
    expect(screen.getByText('版本 7 之前没有记录。')).toBeTruthy()
  })

  it('reads again after a save, and asks nothing before the first', async () => {
    const { rerender } = render(<RevisionList kind="chart" />)
    expect(screen.getByText('保存后开始记录修订。')).toBeTruthy()
    expect(server.get).not.toHaveBeenCalled()
    server.pages['/charts/{id}/revisions?'] = { items: [saved(1)] }
    rerender(<RevisionList kind="chart" id="ch_1" revision={1} />)
    await waitFor(() => expect(rows()).toHaveLength(1))
    server.pages['/charts/{id}/revisions?'] = { items: [saved(2), saved(1)] }
    rerender(<RevisionList kind="chart" id="ch_1" revision={2} />)
    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(server.get).toHaveBeenCalledTimes(2)
  })
})
