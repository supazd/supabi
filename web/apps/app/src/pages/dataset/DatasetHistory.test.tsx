import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import i18n from 'i18next'
import '../../i18n'
import { DatasetHistory } from './DatasetHistory'
import type { Revision } from '../../lib/datasetHistory'

const get = vi.hoisted(() => vi.fn())
vi.mock('../../api/client', async (original) => ({ ...(await original<typeof import('../../api/client')>()), api: { GET: get } }))
vi.mock('@supabi/ui', async (original) => ({ ...(await original<typeof import('@supabi/ui')>()), CodeEditor: ({ value }: { value: string }) => <pre>{value}</pre> }))

const revision = (n: number): Revision => ({ revision: n, name: `Orders ${n}`, description: '', datasourceId: 'source', datasourceName: 'Warehouse', createdByName: 'Analyst', createdAt: '2026-10-18T00:00:00Z', spec: { specVersion: 1, source: { type: 'sql', sql: `SELECT ${n}` }, fields: [] } })
const ok = (data: unknown) => ({ data, response: { ok: true } })
const props = { datasetId: 'ds', currentRevision: 3, datasources: [{ id: 'source', name: 'Warehouse', type: 'postgres', dataTimezone: 'UTC', settings: {}, hasPassword: false, createdAt: '2026-10-18T00:00:00Z', updatedAt: '2026-10-18T00:00:00Z' }], busy: false, onRestore: vi.fn() }

beforeEach(async () => { vi.resetAllMocks(); await i18n.changeLanguage('en-US') })
afterEach(cleanup)

it('keeps the revision list when an older page fails and can retry and restore an older version', async () => {
  let failed = false
  get.mockImplementation(async (path, options) => {
    if (path.endsWith('/{revision}')) return ok(revision(options.params.path.revision))
    if (!options.params.query?.before) return ok({ items: [revision(3)], nextBefore: 3 })
    if (!failed) { failed = true; throw new Error('Temporarily unavailable') }
    return ok({ items: [revision(2), revision(1)] })
  })
  render(<DatasetHistory {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Load older revisions' }))
  expect(await screen.findByRole('alert')).toBeTruthy()
  expect(screen.getByRole('button', { name: /Revision 3/ })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Load older revisions' }))
  fireEvent.click(await screen.findByRole('button', { name: /Revision 1/ }))
  await screen.findByRole('heading', { name: 'Revision 1' })
  fireEvent.click(screen.getByRole('button', { name: 'Restore as draft' }))
  expect(props.onRestore).toHaveBeenCalledWith(revision(1))
  expect(get).toHaveBeenCalledWith('/datasets/{id}/revisions', { params: { path: { id: 'ds' }, query: { before: 3 } } })
})

it('does not restore stale details when a slower revision request finishes after switching versions', async () => {
  let finish: ((value: ReturnType<typeof ok>) => void) | undefined
  get.mockImplementation((path, options) => {
    if (!path.endsWith('/{revision}')) return Promise.resolve(ok({ items: [revision(3), revision(2)] }))
    if (options.params.path.revision === 3) return new Promise((resolve) => { finish = resolve })
    return Promise.resolve(ok(revision(2)))
  })
  render(<DatasetHistory {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: /Revision 2/ }))
  await screen.findByRole('heading', { name: 'Revision 2' })
  await act(async () => { finish!(ok(revision(3))) })
  fireEvent.click(screen.getByRole('button', { name: 'Restore as draft' }))
  expect(props.onRestore).toHaveBeenCalledWith(revision(2))
  expect(screen.queryByRole('heading', { name: 'Revision 3' })).toBeNull()
})

it('shows a retry for failed history reads and disables restoration while saving', async () => {
  get.mockRejectedValueOnce(new Error('Unavailable')).mockImplementation(async (path) => ok(path.endsWith('/{revision}') ? revision(3) : { items: [revision(3)] }))
  render(<DatasetHistory {...props} busy />)
  fireEvent.click(await screen.findByRole('button', { name: i18n.t('common.retry') }))
  await waitFor(() => expect((screen.getByRole('button', { name: 'Restore as draft' }) as HTMLButtonElement).disabled).toBe(true))
  expect(props.onRestore).not.toHaveBeenCalled()
})
