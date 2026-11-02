import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import i18n from 'i18next'
import '../i18n'
import { EditorPanelsProvider } from '../components/EditorPanels'
import { UnsavedChangesProvider, useUnsavedActions } from '../components/UnsavedChanges'

const server = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), openSqlEditor: vi.fn() }))
vi.mock('../lib/sqlHandoff', async (original) => ({ ...(await original<typeof import('../lib/sqlHandoff')>()), openSqlEditor: server.openSqlEditor }))
vi.mock('../auth/session', () => ({ useSession: () => ({ atLeast: () => true }) }))
vi.mock('../workbench/context', () => ({
  useWorkbench: () => ({ loaded: true, resources: { datasources: [], charts: [] }, reload: vi.fn() }),
}))
vi.mock('../api/client', async (original) => ({
  ...(await original<typeof import('../api/client')>()),
  api: {
    GET: server.get,
    POST: server.post,
    PUT: server.put,
  },
}))

import { DatasetEditor } from './DatasetEditor'
import type { Schemas } from '../api/client'

const noImpact: Schemas['DatasetImpact'] = { revision: 1, confirmationToken: 'unused', changes: [], charts: [], dashboards: [] }
const affected: Schemas['DatasetImpact'] = {
  revision: 1, confirmationToken: 'review-1',
  changes: [{ kind: 'field', key: 'value', label: 'Value', reason: 'role_changed' }, { kind: 'parameter', key: 'region', label: 'Region', reason: 'required' }],
  charts: [{ id: 'sales', name: 'Sales chart', changeIndexes: [0] }],
  dashboards: [{ id: 'overview', name: 'Sales overview', chartIds: ['sales'], changeIndexes: [0, 1] }],
}
const ok = (data: unknown) => ({ data, response: { ok: true } })
const refused = (code: string) => ({ error: { code, message: code }, response: { ok: false, status: 409 } })
const impactCalls = () => server.post.mock.calls.filter(([path]) => path === '/datasets/{id}/impact')
const dataset = {
  id: 'orders', name: 'Orders', description: '', datasourceId: 'source', revision: 1,
  spec: { specVersion: 1, source: { type: 'sql', sql: 'select value from orders' }, fields: [{ key: 'value', column: 'value', label: 'Value', type: 'integer', role: 'dimension' }] },
}

function SessionSwitch() {
  const { confirmDiscard } = useUnsavedActions()
  return <button onClick={() => confirmDiscard(() => undefined)}>Change session</button>
}

async function openDataset() {
  const router = createMemoryRouter([
    { path: '/workbench/datasets/:id', element: <UnsavedChangesProvider><EditorPanelsProvider slots={{ side: null, aside: null, bottom: null, status: null }} storageKey="test.dataset"><DatasetEditor /><SessionSwitch /></EditorPanelsProvider></UnsavedChangesProvider> },
    { path: '/away', element: <p>Away</p> },
  ], { initialEntries: ['/workbench/datasets/orders'] })
  render(<RouterProvider router={router} />)
  await screen.findByRole('button', { name: i18n.t('common.edit') })
  return router
}

async function editDataset() {
  const router = await openDataset()
  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.edit') }))
  fireEvent.click(screen.getByRole('tab', { name: i18n.t('dataset.details') }))
  fireEvent.change(screen.getByRole('textbox', { name: `${i18n.t('dataset.label')} Value` }), { target: { value: 'Revenue' } })
  return router
}

beforeEach(async () => {
  vi.resetAllMocks()
  await i18n.changeLanguage('en-US')
  server.get.mockImplementation(async (path: string) => ok(path === '/datasets/{id}' ? dataset : path === '/usage' ? { charts: [], dashboards: [], datasets: [] } : path === '/datasets/{id}/policy' ? { unmatched: 'all', rows: [{ subjects: [{ everyone: true }], filter: { field: 'value', op: 'gt', value: 10 } }], columns: [] } : []))
  server.put.mockImplementation(async (_path, { body }) => ok({ id: 'orders', revision: 2, ...body }))
  server.post.mockImplementation(async (path) => ok(path === '/datasets/{id}/impact' ? noImpact : path === '/datasources/{id}/describe' ? [{ name: 'value', type: 'integer' }] : { columns: [], rows: [], meta: {} }))
  server.openSqlEditor.mockReturnValue(vi.fn())
})

it('reviews specific chart and dashboard impacts in new tabs, preserves cancellation, and submits the confirmed proposal', async () => {
  server.post.mockImplementation(async (path) => ok(path === '/datasets/{id}/impact' ? affected : { columns: [], rows: [], meta: {} }))
  await editDataset()
  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.save') }))
  const dialog = await screen.findByRole('dialog', { name: i18n.t('dataset.impact.title') })
  expect(within(dialog).getByText(i18n.t('dataset.impact.summary', { charts: 1, dashboards: 1 }))).toBeTruthy()
  expect(within(dialog).getAllByText(i18n.t('dataset.impact.reasons.field.role_changed', { name: 'Value' })).length).toBeGreaterThan(0)
  expect(within(dialog).getAllByText(i18n.t('dataset.impact.reasons.parameter.required', { name: 'Region' })).length).toBeGreaterThan(0)
  for (const name of ['Sales chart', 'Sales overview']) {
    const link = within(dialog).getByRole('link', { name })
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  }
  expect(server.put).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('button', { name: i18n.t('dataset.impact.keepEditing') }))
  expect((screen.getByRole('textbox', { name: `${i18n.t('dataset.label')} Revenue` }) as HTMLInputElement).value).toBe('Revenue')
  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.save') }))
  fireEvent.click(await screen.findByRole('button', { name: i18n.t('dataset.impact.confirm') }))
  await waitFor(() => expect(server.put).toHaveBeenCalledTimes(1))
  expect(server.put.mock.calls[0]![1].body).toEqual({ ...impactCalls()[1]![1].body, expectedRevision: 1, impactToken: 'review-1' })
  await waitFor(() => expect(screen.queryByRole('dialog', { name: i18n.t('dataset.impact.title') })).toBeNull())
  expect((screen.getByRole('button', { name: i18n.t('common.save') }) as HTMLButtonElement).disabled).toBe(true)
})

it('saves harmless changes with the loaded revision and analyzes again against the saved revision', async () => {
  await editDataset()
  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.save') }))
  await waitFor(() => expect(server.put).toHaveBeenCalledTimes(1))
  expect(impactCalls()[0]![1].body.expectedRevision).toBe(1)
  expect(server.put.mock.calls[0]![1].body.expectedRevision).toBe(1)
  expect(server.put.mock.calls[0]![1].body.impactToken).toBeUndefined()
  expect(screen.queryByRole('dialog', { name: i18n.t('dataset.impact.title') })).toBeNull()
  await waitFor(() => expect((screen.getByRole('button', { name: i18n.t('common.save') }) as HTMLButtonElement).disabled).toBe(true))
  fireEvent.change(screen.getByRole('textbox', { name: `${i18n.t('dataset.label')} Revenue` }), { target: { value: 'Net revenue' } })
  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.save') }))
  await waitFor(() => expect(impactCalls()).toHaveLength(2))
  expect(impactCalls()[1]![1].body.expectedRevision).toBe(2)
})

it('saves SQL parameter metadata with field visibility, reloads it, and supports clearing both settings', async () => {
  const params = [{ name: 'regions', type: 'string', label: 'Sales regions', required: true, multi: true, default: ['East', 'South'] }]
  await editDataset()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Hide field Revenue' }))
  fireEvent.click(screen.getByRole('button', { name: i18n.t('dataset.showSource') }))
  fireEvent.click(screen.getByRole('button', { name: i18n.t('dataset.editInExplore') }))
  const sql = 'select value from orders where region in {{regions}}'
  await act(async () => { server.openSqlEditor.mock.calls[0]![1].onApply({ sql, datasourceId: 'source', params }) })
  const parameterList = () => within(screen.getByRole('region', { name: 'Parameters' }))
  expect(parameterList().getByText('Sales regions')).toBeTruthy()
  expect(parameterList().getByText('regions')).toBeTruthy()
  expect(parameterList().getByText('Required')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.save') }))
  await waitFor(() => expect(server.put).toHaveBeenCalledTimes(1))
  const savedBody = server.put.mock.calls[0]![1].body
  expect(savedBody.spec.params).toEqual(params)
  expect(savedBody.spec.fields).toEqual([{ ...dataset.spec.fields[0], label: 'Revenue', hidden: true }])

  cleanup()
  const fallback = server.get.getMockImplementation()!
  server.get.mockImplementation(async (path, options) => path === '/datasets/{id}' ? ok({ ...dataset, ...savedBody, revision: 2 }) : fallback(path, options))
  server.post.mockImplementation(async (path) => ok(path === '/datasets/{id}/impact' ? { ...noImpact, revision: 2 } : { columns: [], rows: [], meta: {} }))
  await openDataset()
  expect(parameterList().getByText('Sales regions')).toBeTruthy()
  expect(parameterList().getByText('Required')).toBeTruthy()
  fireEvent.click(screen.getByRole('tab', { name: i18n.t('dataset.details') }))
  const row = within(screen.getByRole('table', { name: i18n.t('dataset.details') })).getByRole('row', { name: /Revenue/ })
  expect(within(row).getByText('Hidden')).toBeTruthy()
  expect(within(row).queryByRole('checkbox')).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.edit') }))
  expect(screen.getByRole('checkbox', { name: 'Hide field Revenue' }).getAttribute('aria-checked')).toBe('true')
  fireEvent.click(screen.getByRole('checkbox', { name: 'Hide field Revenue' }))
  fireEvent.click(screen.getByRole('button', { name: i18n.t('dataset.showSource') }))
  fireEvent.click(screen.getByRole('button', { name: i18n.t('dataset.editInExplore') }))
  expect(server.openSqlEditor.mock.calls.at(-1)![0].params).toEqual(params)
  const cleared = [{ name: 'regions', type: 'string', multi: true, default: ['East', 'South'] }]
  await act(async () => { server.openSqlEditor.mock.calls.at(-1)![1].onApply({ sql, datasourceId: 'source', params: cleared }) })
  expect(parameterList().queryByText('Sales regions')).toBeNull()
  expect(parameterList().queryByText('Required')).toBeNull()
  expect(parameterList().getByText('regions')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.save') }))
  await waitFor(() => expect(server.put).toHaveBeenCalledTimes(2))
  const updated = server.put.mock.calls[1]![1].body
  expect(updated.spec.params).toEqual(cleared)
  expect(updated.spec.fields[0].hidden).toBeUndefined()
  expect(updated.expectedRevision).toBe(2)
})

it('does not reuse confirmation when downstream resources change', async () => {
  let checks = 0
  server.post.mockImplementation(async (path) => ok(path === '/datasets/{id}/impact' ? { ...affected, confirmationToken: `review-${++checks}` } : { columns: [], rows: [], meta: {} }))
  server.put.mockResolvedValueOnce(refused('dataset_impact_required'))
  await editDataset()
  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.save') }))
  fireEvent.click(await screen.findByRole('button', { name: i18n.t('dataset.impact.confirm') }))
  await waitFor(() => expect(impactCalls()).toHaveLength(2))
  expect(server.put).toHaveBeenCalledTimes(1)
  expect(await screen.findByText(i18n.t('errors.dataset_impact_required'))).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: i18n.t('dataset.impact.confirm') }))
  await waitFor(() => expect(server.put).toHaveBeenCalledTimes(2))
  expect(server.put.mock.calls[1]![1].body.impactToken).toBe('review-2')
  expect(impactCalls()[1]![1].body.expectedRevision).toBe(1)
})

it('keeps edits on a revision conflict without reanalyzing or overwriting a newer dataset', async () => {
  server.post.mockImplementation(async (path) => path === '/datasets/{id}/impact' ? refused('resource_revision_conflict') : ok({ columns: [], rows: [], meta: {} }))
  const router = await editDataset()
  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.save') }))
  expect(await screen.findByText(i18n.t('errors.resource_revision_conflict'))).toBeTruthy()
  fireEvent.click(await screen.findByRole('button', { name: i18n.t('saveConflict.keepEditing') }))
  expect(impactCalls()).toHaveLength(1)
  expect(server.put).not.toHaveBeenCalled()
  expect((screen.getByRole('textbox', { name: `${i18n.t('dataset.label')} Revenue` }) as HTMLInputElement).value).toBe('Revenue')
  await act(async () => { void router.navigate('/away') })
  expect(await screen.findByRole('dialog', { name: i18n.t('workbench.leaveTitle') })).toBeTruthy()
})

it('merges independent attributes of the same field and rechecks impact at the new revision', async () => {
  await editDataset()
  const latest = { ...dataset, name: 'Renamed remotely', revision: 2, spec: { ...dataset.spec, fields: [{ ...dataset.spec.fields[0], description: 'Remote description', hidden: true }] } }
  const get = server.get.getMockImplementation()!
  server.get.mockImplementation((path, options) => path === '/datasets/{id}' ? Promise.resolve(ok(latest)) : get(path, options))
  server.post.mockImplementation(async (path, { body }) => path === '/datasets/{id}/impact'
    ? body.expectedRevision === 1 ? refused('resource_revision_conflict') : ok({ ...noImpact, revision: 2 })
    : ok({ columns: [], rows: [], meta: {} }))
  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.save') }))
  const apply = await screen.findByRole<HTMLButtonElement>('button', { name: i18n.t('saveConflict.apply') })
  expect(apply.disabled).toBe(false)
  fireEvent.click(apply)
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(server.put).not.toHaveBeenCalled()
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: `${i18n.t('dataset.label')} Revenue` }).value).toBe('Revenue')
  expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: `${i18n.t('dataset.fieldDescription')} Revenue` }).value).toBe('Remote description')
  expect(screen.getByRole('checkbox', { name: 'Hide field Revenue' }).getAttribute('aria-checked')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.save') }))
  await waitFor(() => expect(server.put).toHaveBeenCalledTimes(1))
  const body = server.put.mock.calls[0]![1].body
  expect(body.expectedRevision).toBe(2)
  expect(body.name).toBe(latest.name)
  expect(body.spec.fields).toEqual([{ ...dataset.spec.fields[0], label: 'Revenue', description: 'Remote description', hidden: true }])
  expect(body.spec).toEqual(impactCalls()[1]![1].body.spec)
  expect(impactCalls().map(([, { body }]) => body.expectedRevision)).toEqual([1, 2])
})

it('resolves only the conflicting field label and preserves other edits for the next save', async () => {
  await editDataset()
  fireEvent.change(screen.getByRole('textbox', { name: `${i18n.t('dataset.fieldDescription')} Revenue` }), { target: { value: 'My description' } })
  const latest = { ...dataset, revision: 2, spec: { ...dataset.spec, fields: [{ ...dataset.spec.fields[0], label: 'Total', hidden: true }] } }
  const get = server.get.getMockImplementation()!
  server.get.mockImplementation((path, options) => path === '/datasets/{id}' ? Promise.resolve(ok(latest)) : get(path, options))
  server.post.mockImplementation(async (path, { body }) => path === '/datasets/{id}/impact'
    ? body.expectedRevision === 1 ? refused('resource_revision_conflict') : ok({ ...noImpact, revision: 2 })
    : ok({ columns: [], rows: [], meta: {} }))
  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.save') }))
  const dialog = within(await screen.findByRole('dialog', { name: i18n.t('saveConflict.title') }))
  const apply = await dialog.findByRole<HTMLButtonElement>('button', { name: i18n.t('saveConflict.apply') })
  expect(apply.disabled).toBe(true)
  expect(dialog.getAllByRole('radio')).toHaveLength(2)
  fireEvent.click(dialog.getByRole('radio', { name: i18n.t('saveConflict.useLocal') }))
  fireEvent.click(apply)
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(server.put).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.save') }))
  await waitFor(() => expect(server.put).toHaveBeenCalledTimes(1))
  const body = server.put.mock.calls[0]![1].body
  expect(body.expectedRevision).toBe(2)
  expect(body.spec.fields).toEqual([{ ...dataset.spec.fields[0], label: 'Revenue', description: 'My description', hidden: true }])
  expect(impactCalls().map(([, { body }]) => body.expectedRevision)).toEqual([1, 2])
})

it('preserves SQL received while the conflict dialog is open by requiring a fresh comparison', async () => {
  await editDataset()
  fireEvent.click(screen.getByRole('button', { name: i18n.t('dataset.showSource') }))
  fireEvent.click(screen.getByRole('button', { name: i18n.t('dataset.editInExplore') }))
  fireEvent.click(screen.getAllByRole('button', { name: i18n.t('common.close') })[0]!)
  const latest = { ...dataset, name: 'Remote name', revision: 2 }
  const get = server.get.getMockImplementation()!
  server.get.mockImplementation((path, options) => path === '/datasets/{id}' ? Promise.resolve(ok(latest)) : get(path, options))
  server.post.mockImplementation(async (path, { body }) => path === '/datasets/{id}/impact'
    ? body.expectedRevision === 1 ? refused('resource_revision_conflict') : ok({ ...noImpact, revision: 2 })
    : path === '/datasources/{id}/describe' ? ok([{ name: 'value', type: 'integer' }]) : ok({ columns: [], rows: [], meta: {} }))
  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.save') }))
  const apply = await screen.findByRole<HTMLButtonElement>('button', { name: i18n.t('saveConflict.apply') })
  expect(apply.disabled).toBe(false)

  const sql = 'select value from orders where value > {{minimum}}'
  const params = [{ name: 'minimum', type: 'integer', required: true, default: 42 }]
  await act(async () => { expect(server.openSqlEditor.mock.calls[0]![1].onApply({ sql, datasourceId: 'source', params })).not.toBe(false) })
  await waitFor(() => expect(server.post.mock.calls.some(([path, options]) => path === '/datasources/{id}/describe' && options.body.source.sql === sql)).toBe(true))
  expect(apply.disabled).toBe(true)
  fireEvent.click(apply)
  expect(server.put).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog', { name: i18n.t('saveConflict.title') })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: i18n.t('saveConflict.refresh') }))
  const refreshed = await screen.findByRole<HTMLButtonElement>('button', { name: i18n.t('saveConflict.apply') })
  expect(refreshed.disabled).toBe(false)
  fireEvent.click(refreshed)
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(server.put).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.save') }))
  await waitFor(() => expect(server.put).toHaveBeenCalledTimes(1))
  expect(server.put.mock.calls[0]![1].body).toMatchObject({
    expectedRevision: 2, name: latest.name,
    spec: { source: { sql }, params, fields: [{ ...dataset.spec.fields[0], label: 'Revenue' }] },
  })
})

it('preserves fields detected while the conflict dialog is open by requiring a fresh comparison', async () => {
  await editDataset()
  let finish: ((value: ReturnType<typeof ok>) => void) | undefined
  const latest = { ...dataset, name: 'Remote name', revision: 2 }
  const get = server.get.getMockImplementation()!
  server.get.mockImplementation((path, options) => path === '/datasets/{id}' ? Promise.resolve(ok(latest)) : get(path, options))
  server.post.mockImplementation((path, { body }) => path === '/datasets/{id}/impact'
    ? Promise.resolve(body.expectedRevision === 1 ? refused('resource_revision_conflict') : ok({ ...noImpact, revision: 2 }))
    : path === '/datasources/{id}/describe' ? new Promise((resolve) => { finish = resolve }) : Promise.resolve(ok({ columns: [], rows: [], meta: {} })))
  fireEvent.click(screen.getByRole('button', { name: i18n.t('dataset.detect') }))
  await waitFor(() => expect(finish).toBeDefined())
  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.save') }))
  const apply = await screen.findByRole<HTMLButtonElement>('button', { name: i18n.t('saveConflict.apply') })
  expect(apply.disabled).toBe(false)
  await act(async () => { finish!(ok([{ name: 'value', type: 'integer' }, { name: 'extra', type: 'string' }])) })
  expect(apply.disabled).toBe(true)
  fireEvent.click(apply)
  expect(screen.getByRole('dialog', { name: i18n.t('saveConflict.title') })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: i18n.t('saveConflict.refresh') }))
  const refreshed = await screen.findByRole<HTMLButtonElement>('button', { name: i18n.t('saveConflict.apply') })
  expect(refreshed.disabled).toBe(false)
  fireEvent.click(refreshed)
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.getByRole('textbox', { name: `${i18n.t('dataset.label')} extra` })).toBeTruthy()
  expect(server.put).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.save') }))
  await waitFor(() => expect(server.put).toHaveBeenCalledTimes(1))
  const body = server.put.mock.calls[0]![1].body
  expect(body.expectedRevision).toBe(2)
  expect(body.name).toBe(latest.name)
  expect(body.spec.fields.map((field: { key: string }) => field.key)).toEqual(['value', 'extra'])
  expect(body.spec.fields[0].label).toBe('Revenue')
})

it('restarts an unfinished preview after applying a conflict with the same query and ignores the old response', async () => {
  const pending: ((value: ReturnType<typeof ok>) => void)[] = []
  const post = server.post.getMockImplementation()!
  server.post.mockImplementation((path, options) => path === '/datasets/preview' ? new Promise((resolve) => { pending.push(resolve) }) : post(path, options))
  await editDataset()
  await waitFor(() => expect(pending).toHaveLength(1))
  const latest = { ...dataset, name: 'Remote name', revision: 2 }
  const get = server.get.getMockImplementation()!
  server.get.mockImplementation((path, options) => path === '/datasets/{id}' ? Promise.resolve(ok(latest)) : get(path, options))
  server.post.mockImplementation((path, options) => path === '/datasets/preview' ? new Promise((resolve) => { pending.push(resolve) })
    : path === '/datasets/{id}/impact' ? Promise.resolve(refused('resource_revision_conflict')) : post(path, options))
  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.save') }))
  const apply = await screen.findByRole<HTMLButtonElement>('button', { name: i18n.t('saveConflict.apply') })
  expect(apply.disabled).toBe(false)
  fireEvent.click(apply)
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await waitFor(() => expect(pending).toHaveLength(2))
  const result = (value: number) => ok({ columns: [{ name: 'value', label: 'Value', type: 'integer', role: 'dimension' }], rows: [[value]], meta: {} })
  await act(async () => { pending[1]!(result(202)) })
  await act(async () => { pending[0]!(result(101)) })
  fireEvent.click(screen.getByRole('tab', { name: i18n.t('dataset.preview') }))
  const preview = within(screen.getByRole('table', { name: i18n.t('dataset.preview') }))
  expect(preview.getByText('202')).toBeTruthy()
  expect(preview.queryByText('101')).toBeNull()
  expect(server.put).not.toHaveBeenCalled()
})

it('keeps edits made while analysis is pending separate from the confirmed proposal', async () => {
  let finish: ((value: ReturnType<typeof ok>) => void) | undefined
  server.post.mockImplementation((path) => path === '/datasets/{id}/impact' ? new Promise((resolve) => { finish = resolve }) : Promise.resolve(ok({ columns: [], rows: [], meta: {} })))
  await editDataset()
  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.save') }))
  await waitFor(() => expect(finish).toBeDefined())
  fireEvent.change(screen.getByRole('textbox', { name: `${i18n.t('dataset.label')} Revenue` }), { target: { value: 'Later edit' } })
  await act(async () => { finish!(ok(affected)) })
  fireEvent.click(await screen.findByRole('button', { name: i18n.t('dataset.impact.confirm') }))
  await waitFor(() => expect(server.put).toHaveBeenCalledTimes(1))
  expect(server.put.mock.calls[0]![1].body.spec.fields[0].label).toBe('Revenue')
  await waitFor(() => expect(screen.queryByRole('dialog', { name: i18n.t('dataset.impact.title') })).toBeNull())
  expect((screen.getByRole('textbox', { name: `${i18n.t('dataset.label')} Later edit` }) as HTMLInputElement).value).toBe('Later edit')
  expect((screen.getByRole('button', { name: i18n.t('common.save') }) as HTMLButtonElement).disabled).toBe(false)
})

it('applies SQL returned from its tab without losing the dataset field draft', async () => {
  await editDataset()
  fireEvent.click(screen.getByRole('button', { name: i18n.t('dataset.showSource') }))
  fireEvent.click(screen.getByRole('button', { name: i18n.t('dataset.editInExplore') }))
  expect(server.openSqlEditor).toHaveBeenCalledWith(expect.objectContaining({ sql: 'select value from orders', datasourceId: 'source' }), expect.objectContaining({ datasetName: 'Orders' }))
  await act(async () => { server.openSqlEditor.mock.calls[0]![1].onApply({ sql: 'select value from orders where value > 10', datasourceId: 'source', params: [] }) })
  expect((screen.getByRole('textbox', { name: `${i18n.t('dataset.label')} Revenue` }) as HTMLInputElement).value).toBe('Revenue')
  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.save') }))
  await waitFor(() => expect(server.put).toHaveBeenCalledTimes(1))
  expect(server.put.mock.calls[0]![1].body.spec.fields[0].label).toBe('Revenue')
  expect(server.put.mock.calls[0]![1].body.spec.source.sql).toBe('select value from orders where value > 10')
})

it('declines SQL returns while a session change is waiting for confirmation', async () => {
  await editDataset()
  fireEvent.click(screen.getByRole('button', { name: i18n.t('dataset.showSource') }))
  fireEvent.click(screen.getByRole('button', { name: i18n.t('dataset.editInExplore') }))
  fireEvent.click(screen.getAllByRole('button', { name: i18n.t('common.close') })[0]!)
  fireEvent.click(screen.getByRole('button', { name: 'Change session' }))
  expect(await screen.findByRole('dialog', { name: i18n.t('workbench.leaveTitle') })).toBeTruthy()
  let accepted: unknown
  await act(async () => { accepted = server.openSqlEditor.mock.calls[0]![1].onApply({ sql: 'select replacement from orders', datasourceId: 'source', params: [] }) })
  expect(accepted).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: i18n.t('workbench.stay') }))
  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.save') }))
  await waitFor(() => expect(server.put).toHaveBeenCalledTimes(1))
  expect(server.put.mock.calls[0]![1].body.spec.source.sql).toBe('select value from orders')
})

it('preserves edits made during SQL field detection and ignores older source responses', async () => {
  const descriptions: ((value: ReturnType<typeof ok>) => void)[] = []
  server.post.mockImplementation((path) => path === '/datasources/{id}/describe'
    ? new Promise((resolve) => { descriptions.push(resolve) })
    : Promise.resolve(ok(path === '/datasets/{id}/impact' ? noImpact : { columns: [], rows: [], meta: {} })))
  await editDataset()
  fireEvent.click(screen.getByRole('button', { name: i18n.t('dataset.showSource') }))
  fireEvent.click(screen.getByRole('button', { name: i18n.t('dataset.editInExplore') }))
  const apply = server.openSqlEditor.mock.calls[0]![1].onApply
  await act(async () => { apply({ sql: 'select value, stale from orders', datasourceId: 'source', params: [] }) })
  await waitFor(() => expect(descriptions).toHaveLength(1))
  await act(async () => { apply({ sql: 'select value, fresh from orders', datasourceId: 'source', params: [] }) })
  await waitFor(() => expect(descriptions).toHaveLength(2))
  fireEvent.change(screen.getByRole('textbox', { name: `${i18n.t('dataset.label')} Revenue` }), { target: { value: 'Latest name' } })
  await act(async () => { descriptions[1]!(ok([{ name: 'value', type: 'integer' }, { name: 'fresh', type: 'integer' }])) })
  await act(async () => { descriptions[0]!(ok([{ name: 'value', type: 'integer' }, { name: 'stale', type: 'integer' }])) })
  expect((screen.getByRole('textbox', { name: `${i18n.t('dataset.label')} Latest name` }) as HTMLInputElement).value).toBe('Latest name')
  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.save') }))
  await waitFor(() => expect(server.put).toHaveBeenCalledTimes(1))
  const spec = server.put.mock.calls[0]![1].body.spec
  expect(spec.source.sql).toBe('select value, fresh from orders')
  expect(spec.fields.map((field: { column: string }) => field.column)).toEqual(['value', 'fresh'])
  expect(spec.fields[0].label).toBe('Latest name')
})
function historyFixture(oldSpec?: Record<string, unknown>) {
  const old: Schemas['DatasetRevision'] = {
    revision: 1, name: oldSpec ? dataset.name : 'Original orders', description: oldSpec ? '' : 'Original description', datasourceId: oldSpec ? 'source' : 'archive', datasourceName: 'Archive',
    createdAt: '2026-10-16T10:00:00Z', createdByName: 'Analyst',
    spec: oldSpec ?? { ...dataset.spec, source: { type: 'sql', sql: 'select value from archive where region = {{region}}' }, params: [{ name: 'region', type: 'string', label: 'Region', required: true, default: 'East' }], fields: [{ ...dataset.spec.fields[0]!, label: 'Original value', hidden: true, group: 'Historic group', format: { decimals: 2 } }] },
  }
  const current: Schemas['DatasetRevision'] = { ...old, ...dataset, revision: 3, datasourceName: 'Warehouse' }
  const fallback = server.get.getMockImplementation()!
  server.get.mockImplementation(async (path: string, options?: { params?: { path?: { revision?: number } } }) => {
    if (path === '/datasets/{id}') return ok({ ...dataset, revision: 3 })
    if (path === '/datasets/{id}/revisions') return ok({ items: [current, old] })
    if (path === '/datasets/{id}/revisions/{revision}') return ok(options?.params?.path?.revision === 1 ? old : current)
    return fallback(path, options)
  })
  server.put.mockImplementation(async (_path, { body }) => ok({ id: 'orders', revision: 4, ...body }))
  server.post.mockImplementation(async (path) => ok(path === '/datasets/{id}/impact' ? { ...noImpact, revision: 3 } : { columns: [], rows: [], meta: {} }))
  return old
}

async function chooseOldRevision() {
  fireEvent.click(screen.getByRole('tab', { name: i18n.t('dataset.history.title') }))
  fireEvent.click(await screen.findByRole('button', { name: /Revision 1/ }))
  await screen.findByRole('heading', { name: 'Revision 1' })
}

it('compares saved versions without changing the draft and cancels replacing unsaved work', async () => {
  historyFixture()
  await editDataset()
  await chooseOldRevision()
  fireEvent.click(screen.getByRole('radio', { name: i18n.t('dataset.history.compare') }))
  expect(await screen.findByRole('table', { name: i18n.t('dataset.history.sqlDiff') })).toBeTruthy()
  expect(screen.getByText(i18n.t('dataset.history.direction', { before: 1, after: 3 }))).toBeTruthy()
  fireEvent.click(screen.getByRole('combobox', { name: i18n.t('dataset.history.compareWith') }))
  fireEvent.click(await screen.findByRole('option', { name: 'Revision 1' }))
  expect(await screen.findByText(i18n.t('dataset.history.identical'))).toBeTruthy()
  expect(server.put).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: i18n.t('dataset.history.restore') }))
  const dialog = await screen.findByRole('dialog', { name: i18n.t('dataset.history.replaceTitle') })
  fireEvent.click(within(dialog).getByRole('button', { name: i18n.t('common.cancel') }))
  fireEvent.click(screen.getByRole('tab', { name: i18n.t('dataset.details') }))
  expect((screen.getByRole('textbox', { name: `${i18n.t('dataset.label')} Revenue` }) as HTMLInputElement).value).toBe('Revenue')
})

it('restores the complete snapshot only to a draft, then saves against the current revision with impact confirmation', async () => {
  const old = historyFixture()
  server.post.mockImplementation(async (path) => ok(path === '/datasets/{id}/impact' ? { ...affected, revision: 3 } : { columns: [], rows: [], meta: {} }))
  const router = await editDataset()
  await chooseOldRevision()
  fireEvent.click(screen.getByRole('button', { name: i18n.t('dataset.history.restore') }))
  fireEvent.click(within(await screen.findByRole('dialog', { name: i18n.t('dataset.history.replaceTitle') })).getByRole('button', { name: i18n.t('dataset.history.restore') }))
  expect(server.put).not.toHaveBeenCalled()
  expect(impactCalls()).toHaveLength(0)
  expect(screen.getByText(i18n.t('dataset.history.restored', { revision: 1 }))).toBeTruthy()
  expect((screen.getByRole('textbox', { name: `${i18n.t('dataset.label')} Original value` }) as HTMLInputElement).value).toBe('Original value')
  expect(screen.getByRole('checkbox', { name: 'Hide field Original value' }).getAttribute('aria-checked')).toBe('true')
  const parameters = within(screen.getByRole('region', { name: 'Parameters' }))
  expect(parameters.getByText('Region')).toBeTruthy()
  expect(parameters.getByText('Required')).toBeTruthy()
  await act(async () => { void router.navigate('/away') })
  fireEvent.click(await screen.findByRole('button', { name: i18n.t('workbench.stay') }))
  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.save') }))
  fireEvent.click(await screen.findByRole('button', { name: i18n.t('dataset.impact.confirm') }))
  await waitFor(() => expect(server.put).toHaveBeenCalledTimes(1))
  expect(server.put.mock.calls[0]![1].body).toEqual({ name: old.name, description: old.description, datasourceId: old.datasourceId, spec: old.spec, expectedRevision: 3, impactToken: 'review-1' })
  await waitFor(() => expect((screen.getByRole('button', { name: i18n.t('common.save') }) as HTMLButtonElement).disabled).toBe(true))
})

it('restores parameter-only changes as unsaved and retains them on a concurrent revision conflict', async () => {
  const old = historyFixture({ ...dataset.spec, params: [{ name: 'region', type: 'string', label: 'Historic label', required: true }] })
  await editDataset()
  await chooseOldRevision()
  fireEvent.click(screen.getByRole('button', { name: i18n.t('dataset.history.restore') }))
  fireEvent.click(within(await screen.findByRole('dialog', { name: i18n.t('dataset.history.replaceTitle') })).getByRole('button', { name: i18n.t('dataset.history.restore') }))
  expect((screen.getByRole('button', { name: i18n.t('common.save') }) as HTMLButtonElement).disabled).toBe(false)
  server.post.mockImplementation(async (path) => path === '/datasets/{id}/impact' ? refused('resource_revision_conflict') : ok({ columns: [], rows: [], meta: {} }))
  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.save') }))
  expect(await screen.findByText(i18n.t('errors.resource_revision_conflict'))).toBeTruthy()
  fireEvent.click(await screen.findByRole('button', { name: i18n.t('saveConflict.keepEditing') }))
  expect(impactCalls()[0]![1].body.spec).toEqual(old.spec)
  expect(impactCalls()[0]![1].body.expectedRevision).toBe(3)
  expect(server.put).not.toHaveBeenCalled()
  expect((screen.getByRole('button', { name: i18n.t('common.save') }) as HTMLButtonElement).disabled).toBe(false)
})

it('restores a table source from the locked editor without prompting or converting it to SQL', async () => {
  const old = historyFixture({ ...dataset.spec, source: { type: 'table', schema: 'public', table: 'orders' } })
  const router = createMemoryRouter([{ path: '/workbench/datasets/:id', element: <UnsavedChangesProvider><EditorPanelsProvider slots={{ side: null, aside: null, bottom: null, status: null }} storageKey="test.dataset"><DatasetEditor /></EditorPanelsProvider></UnsavedChangesProvider> }], { initialEntries: ['/workbench/datasets/orders'] })
  render(<RouterProvider router={router} />)
  await screen.findByRole('tab', { name: i18n.t('dataset.history.title') })
  await chooseOldRevision()
  fireEvent.click(screen.getByRole('button', { name: i18n.t('dataset.history.restore') }))
  expect(screen.queryByRole('dialog', { name: i18n.t('dataset.history.replaceTitle') })).toBeNull()
  expect(server.put).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.save') }))
  await waitFor(() => expect(server.put).toHaveBeenCalledTimes(1))
  expect(server.put.mock.calls[0]![1].body.spec).toEqual(old.spec)
  expect(server.put.mock.calls[0]![1].body.expectedRevision).toBe(3)
})

it('ignores a field detection started by the draft that has been replaced from history', async () => {
  const old = historyFixture()
  let finish: ((value: ReturnType<typeof ok>) => void) | undefined
  const fallback = server.post.getMockImplementation()!
  server.post.mockImplementation((path, options) => path === '/datasources/{id}/describe' ? new Promise((resolve) => { finish = resolve }) : fallback(path, options))
  await editDataset()
  fireEvent.click(screen.getByRole('button', { name: i18n.t('dataset.showSource') }))
  fireEvent.click(screen.getByRole('button', { name: i18n.t('dataset.editInExplore') }))
  await act(async () => { server.openSqlEditor.mock.calls[0]![1].onApply({ sql: 'select value, discarded from orders', datasourceId: 'source', params: [] }) })
  await waitFor(() => expect(finish).toBeDefined())
  await chooseOldRevision()
  fireEvent.click(screen.getByRole('button', { name: i18n.t('dataset.history.restore') }))
  fireEvent.click(within(await screen.findByRole('dialog', { name: i18n.t('dataset.history.replaceTitle') })).getByRole('button', { name: i18n.t('dataset.history.restore') }))
  await act(async () => { finish!(ok([{ name: 'value', type: 'integer' }, { name: 'discarded', type: 'integer' }])) })
  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.save') }))
  await waitFor(() => expect(server.put).toHaveBeenCalledTimes(1))
  expect(server.put.mock.calls[0]![1].body.spec).toEqual(old.spec)
})

it('restarts an unfinished preview when restoring the same query and ignores the previous response', async () => {
  historyFixture(dataset.spec)
  const pending: ((value: ReturnType<typeof ok>) => void)[] = []
  const fallback = server.post.getMockImplementation()!
  server.post.mockImplementation((path, options) => path === '/datasets/preview' ? new Promise((resolve) => { pending.push(resolve) }) : fallback(path, options))
  await editDataset()
  await waitFor(() => expect(pending).toHaveLength(1))
  await chooseOldRevision()
  fireEvent.click(screen.getByRole('button', { name: i18n.t('dataset.history.restore') }))
  fireEvent.click(within(await screen.findByRole('dialog', { name: i18n.t('dataset.history.replaceTitle') })).getByRole('button', { name: i18n.t('dataset.history.restore') }))
  await waitFor(() => expect(pending).toHaveLength(2))
  const result = (value: number) => ok({ columns: [{ name: 'value', label: 'Value', type: 'integer', role: 'dimension' }], rows: [[value]], meta: {} })
  await act(async () => { pending[1]!(result(202)) })
  await act(async () => { pending[0]!(result(101)) })
  fireEvent.click(screen.getByRole('tab', { name: i18n.t('dataset.preview') }))
  const preview = screen.getByRole('table', { name: i18n.t('dataset.preview') })
  expect(within(preview).getByText('202')).toBeTruthy()
  expect(within(preview).queryByText('101')).toBeNull()
})

afterEach(cleanup)

it('keeps permission edits across tabs, guards navigation, and saves the current dataset policy', async () => {
  const router = createMemoryRouter([
    { path: '/workbench/datasets/:id', element: <UnsavedChangesProvider><EditorPanelsProvider slots={{ side: null, aside: null, bottom: null, status: null }} storageKey="test.dataset"><DatasetEditor /></EditorPanelsProvider></UnsavedChangesProvider> },
    { path: '/away', element: <p>Away</p> },
  ], { initialEntries: ['/workbench/datasets/orders'] })
  render(<RouterProvider router={router} />)
  fireEvent.click(await screen.findByRole('tab', { name: i18n.t('policy.tab') }))
  expect(screen.getByRole('heading', { name: i18n.t('dataset.outline') })).toBeTruthy()
  expect(screen.getByRole('textbox', { name: i18n.t('dataset.searchFields') })).toBeTruthy()
  expect(screen.getByRole('separator', { name: i18n.t('dataset.resizeOutline') })).toBeTruthy()
  fireEvent.click(await screen.findByRole('radio', { name: i18n.t('policy.unmatchedNone') }))
  fireEvent.click(screen.getByRole('tab', { name: i18n.t('dataset.details') }))
  expect(screen.queryByRole('radio', { name: i18n.t('policy.unmatchedNone') })).toBeNull()
  await act(async () => { void router.navigate('/away') })
  expect(await screen.findByRole('dialog', { name: i18n.t('workbench.leaveTitle') })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: i18n.t('workbench.stay') }))
  fireEvent.click(screen.getByRole('tab', { name: i18n.t('policy.tab') }))
  expect((screen.getByRole('radio', { name: i18n.t('policy.unmatchedNone') }) as HTMLInputElement).checked).toBe(true)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: i18n.t('common.save') })) })
  await waitFor(() => expect(server.put).toHaveBeenCalledWith('/datasets/{id}/policy', {
    params: { path: { id: 'orders' } }, body: { unmatched: 'none', rows: [{ subjects: [{ everyone: true }], filter: { field: 'value', op: 'gt', value: 10 } }], columns: [] },
  }))
  await waitFor(() => expect(screen.queryByRole('button', { name: i18n.t('policy.discard') })).toBeNull())
  await act(async () => { await router.navigate('/away') })
  expect(await screen.findByText('Away')).toBeTruthy()
})
