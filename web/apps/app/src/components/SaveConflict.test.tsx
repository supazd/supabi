import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import i18n from 'i18next'
import '../i18n'
import { ApiError, type Dataset } from '../api/client'
import { SaveConflict, useSaveConflict } from './SaveConflict'
import type { SaveContent } from '../lib/saveConflict'

const server = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('../api/client', async (original) => ({ ...await original<typeof import('../api/client')>(), api: { GET: server.get } }))
const base: Dataset = { id: 'dataset', name: 'Original', description: '', datasourceId: 'source', revision: 1, updatedAt: '', validationStatus: 'valid', spec: { source: { sql: 'select old' }, fields: [] } }
const local: SaveContent = { ...base, name: 'Mine', spec: { source: { sql: 'select mine' }, fields: [] } }
const latest: Dataset = { ...base, name: 'Theirs', revision: 2, spec: { source: { sql: 'select theirs' }, fields: [] } }
const applied = vi.fn()
function Harness({ original = base, initial = local, incoming }: { original?: Dataset; initial?: SaveContent; incoming?: SaveContent }) {
  const state = useSaveConflict('dataset', original)
  const [draft, setDraft] = useState(initial)
  useEffect(() => { if (incoming) setDraft(incoming) }, [incoming])
  return <>
    <button onClick={() => state.capture(new ApiError(409, 'resource_revision_conflict', ''))}>Conflict</button>
    <output data-testid="draft">{JSON.stringify(draft)}</output><output data-testid="revision">{state.base!.revision}</output>
    <SaveConflict state={state} local={draft} onApply={async (content, next) => { await applied(content, next); setDraft(content) }} />
  </>
}
beforeEach(async () => {
  vi.resetAllMocks()
  await i18n.changeLanguage('en-US')
  server.get.mockResolvedValue({ data: latest, response: { ok: true } })
})
afterEach(cleanup)
const review = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Conflict' }))
  const dialog = await screen.findByRole('dialog')
  await within(dialog).findByRole('group', { name: 'Name' })
  return within(dialog)
}

it('keeps the draft and base on cancellation and fetches a fresh latest version on reopening', async () => {
  render(<Harness />)
  const dialog = await review()
  expect(dialog.getByRole<HTMLButtonElement>('button', { name: 'Apply to draft' }).disabled).toBe(true)
  fireEvent.click(dialog.getByRole('button', { name: 'Resolve later' }))
  expect(screen.getByTestId('draft').textContent).toBe(JSON.stringify(local))
  expect(screen.getByTestId('revision').textContent).toBe('1')
  expect(applied).not.toHaveBeenCalled()
  server.get.mockResolvedValue({ data: { ...latest, revision: 3 }, response: { ok: true } })
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
  expect(await screen.findByText('Revision 1 → 3')).toBeTruthy()
  expect(server.get).toHaveBeenCalledTimes(2)
})

it('resolves explicit groups into an unsaved draft and updates the base for the next save', async () => {
  render(<Harness />)
  const dialog = await review()
  fireEvent.click(within(dialog.getByRole('group', { name: 'Name' })).getByRole('radio', { name: 'Use latest content' }))
  fireEvent.click(within(dialog.getByRole('group', { name: 'Data source, SQL and parameters' })).getByRole('radio', { name: 'Use my changes' }))
  fireEvent.click(dialog.getByRole('button', { name: 'Apply to draft' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(applied).toHaveBeenCalledWith({ name: latest.name, description: '', spec: local.spec, datasourceId: 'source' }, latest)
  expect(screen.getByTestId('revision').textContent).toBe('2')
  expect(screen.queryByRole('alert')).toBeNull()
})

it('retains the draft when the latest version cannot be read, and allows retry', async () => {
  server.get.mockResolvedValueOnce({ error: { code: 'forbidden' }, response: { ok: false, status: 403 } })
  render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: 'Conflict' }))
  const retry = await screen.findByRole('button', { name: 'Retry' })
  expect(screen.getByTestId('revision').textContent).toBe('1')
  fireEvent.click(retry)
  expect(await screen.findByRole('group', { name: 'Name' })).toBeTruthy()
  expect(applied).not.toHaveBeenCalled()
})

it('does not advance the base if applying the selected definition fails', async () => {
  applied.mockRejectedValue(new ApiError(400, 'conflict_not_editable', ''))
  render(<Harness />)
  const dialog = await review()
  dialog.getAllByRole('radio', { name: 'Use my changes' }).forEach((radio) => fireEvent.click(radio))
  fireEvent.click(dialog.getByRole('button', { name: 'Apply to draft' }))
  expect(await dialog.findByText(i18n.t('errors.conflict_not_editable'))).toBeTruthy()
  expect(screen.getByTestId('revision').textContent).toBe('1')
  expect(screen.getByTestId('draft').textContent).toBe(JSON.stringify(local))
})

it('blocks an outdated comparison and clears its choices before reviewing the changed draft', async () => {
  const { rerender } = render(<Harness />)
  const dialog = await review()
  dialog.getAllByRole('radio', { name: 'Use my changes' }).forEach((radio) => fireEvent.click(radio))
  const apply = dialog.getByRole<HTMLButtonElement>('button', { name: 'Apply to draft' })
  expect(apply.disabled).toBe(false)
  const incoming = { ...local, name: 'Newer draft', spec: { ...local.spec, source: { sql: 'select newer' } } }
  rerender(<Harness incoming={incoming} />)
  expect(apply.disabled).toBe(true)
  fireEvent.click(apply)
  expect(applied).not.toHaveBeenCalled()
  expect(screen.getByTestId('revision').textContent).toBe('1')
  expect(screen.getByTestId('draft').textContent).toBe(JSON.stringify(incoming))

  server.get.mockResolvedValueOnce({ error: { code: 'forbidden' }, response: { ok: false, status: 403 } })
  fireEvent.click(dialog.getByRole('button', { name: 'Compare again' }))
  const retry = await dialog.findByRole('button', { name: 'Retry' })
  expect(screen.getByTestId('draft').textContent).toBe(JSON.stringify(incoming))
  expect(screen.getByTestId('revision').textContent).toBe('1')
  expect(applied).not.toHaveBeenCalled()
  let finish!: (value: unknown) => void
  server.get.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  fireEvent.click(retry)
  expect(dialog.queryByRole<HTMLButtonElement>('button', { name: 'Apply to draft' })?.disabled ?? true).toBe(true)
  const newest = { ...latest, revision: 3 }
  await act(async () => { finish({ data: newest, response: { ok: true } }) })
  expect(dialog.getByText('Revision 1 → 3')).toBeTruthy()
  expect(dialog.getByText('select newer')).toBeTruthy()
  expect(dialog.getAllByRole<HTMLInputElement>('radio').every((radio) => !radio.checked)).toBe(true)
  expect(dialog.getByRole<HTMLButtonElement>('button', { name: 'Apply to draft' }).disabled).toBe(true)
  dialog.getAllByRole('radio', { name: 'Use my changes' }).forEach((radio) => fireEvent.click(radio))
  fireEvent.click(dialog.getByRole('button', { name: 'Apply to draft' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(applied).toHaveBeenCalledWith({ name: incoming.name, description: incoming.description, datasourceId: incoming.datasourceId, spec: incoming.spec }, newest)
  expect(screen.getByTestId('revision').textContent).toBe('3')
})

it('recompares a draft changed during loading and ignores the superseded response', async () => {
  const pending: ((value: unknown) => void)[] = []
  server.get.mockImplementation(() => new Promise((resolve) => { pending.push(resolve) }))
  const { rerender } = render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: 'Conflict' }))
  const dialog = within(await screen.findByRole('dialog'))
  await waitFor(() => expect(pending).toHaveLength(1))
  const incoming = { ...local, name: 'Newer draft', spec: { ...local.spec, source: { sql: 'select newer' } } }
  rerender(<Harness incoming={incoming} />)
  fireEvent.click(dialog.getByRole('button', { name: 'Compare again' }))
  await waitFor(() => expect(pending).toHaveLength(2))
  await act(async () => { pending[0]!({ data: latest, response: { ok: true } }) })
  expect(dialog.queryByText('Revision 1 → 2')).toBeNull()
  expect(dialog.queryByRole('button', { name: 'Apply to draft' })).toBeNull()
  expect(applied).not.toHaveBeenCalled()
  const newest = { ...latest, revision: 3 }
  await act(async () => { pending[1]!({ data: newest, response: { ok: true } }) })
  expect(dialog.getByText('Revision 1 → 3')).toBeTruthy()
  expect(dialog.getByText('select newer')).toBeTruthy()
  dialog.getAllByRole('radio', { name: 'Use my changes' }).forEach((radio) => fireEvent.click(radio))
  fireEvent.click(dialog.getByRole('button', { name: 'Apply to draft' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(applied).toHaveBeenCalledWith({ name: incoming.name, description: incoming.description, datasourceId: incoming.datasourceId, spec: incoming.spec }, newest)
})

it('automatically merges field properties and asks only about the conflicting property', async () => {
  const field = { key: 'amount', label: 'Amount', type: 'decimal', column: 'amount', role: 'measure' }
  const original = { ...base, spec: { ...base.spec, fields: [field] } }
  const initial = { ...original, spec: { ...original.spec, fields: [{ ...field, label: 'Revenue', hidden: true }] } }
  const remote = { ...original, revision: 2, spec: { ...original.spec, fields: [{ ...field, label: 'Net revenue', description: 'After refunds' }] } }
  server.get.mockResolvedValue({ data: remote, response: { ok: true } })
  render(<Harness original={original} initial={initial} />)
  fireEvent.click(screen.getByRole('button', { name: 'Conflict' }))
  const dialog = within(await screen.findByRole('dialog'))
  expect(await dialog.findByText('To resolve: 1')).toBeTruthy()
  expect(dialog.getAllByRole('radio')).toHaveLength(2)
  const automatic = dialog.getByRole('button', { name: /Automatically merged: 2/ })
  expect(automatic.getAttribute('aria-expanded')).toBe('false')
  expect(dialog.queryByText('Keeping latest change')).toBeNull()
  fireEvent.click(automatic)
  expect(automatic.getAttribute('aria-expanded')).toBe('true')
  expect(dialog.getByText('Keeping your change')).toBeTruthy()
  expect(dialog.getByText('Keeping latest change')).toBeTruthy()
  expect(dialog.getByText('After refunds', { selector: '.save-conflict-auto-value *' })).toBeTruthy()
  const group = within(dialog.getByRole('group', { name: 'Field “Amount” · Display name' }))
  fireEvent.click(group.getByRole('radio', { name: 'Use latest content' }))
  expect(dialog.getByText('Ready to apply')).toBeTruthy()
  fireEvent.click(dialog.getByRole('button', { name: 'Apply to draft' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  const merged = { ...original.spec, fields: [{ ...field, label: 'Net revenue', description: 'After refunds', hidden: true }] }
  expect(applied).toHaveBeenCalledWith({ name: base.name, description: '', datasourceId: base.datasourceId, spec: merged }, remote)

  // A further save conflict compares against the accepted server version, not
  // the merged draft: the still-unsaved hidden flag must survive another merge.
  const newest = { ...remote, revision: 3, spec: { ...remote.spec, fields: [{ ...remote.spec.fields[0], description: 'After refunds and tax' }] } }
  server.get.mockResolvedValue({ data: newest, response: { ok: true } })
  fireEvent.click(screen.getByRole('button', { name: 'Conflict' }))
  const second = within(await screen.findByRole('dialog'))
  expect(await second.findByText('Revision 2 → 3')).toBeTruthy()
  expect(second.getByRole('button', { name: /Automatically merged: 2/ }).getAttribute('aria-expanded')).toBe('true')
  expect(second.queryByRole('radio')).toBeNull()
  fireEvent.click(second.getByRole('button', { name: 'Apply to draft' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(JSON.parse(screen.getByTestId('draft').textContent!).spec.fields).toEqual([{ ...field, label: 'Net revenue', description: 'After refunds and tax', hidden: true }])
})

it('makes deletion versus modification explicit without discarding the field on open', async () => {
  const field = { key: 'amount', label: 'Amount', column: 'amount', type: 'decimal', role: 'measure' }
  const original = { ...base, spec: { ...base.spec, fields: [field] } }
  const initial = { ...original, spec: { ...original.spec, fields: [{ ...field, label: 'Revenue' }] } }
  server.get.mockResolvedValue({ data: { ...original, revision: 2, spec: { ...original.spec, fields: [] } }, response: { ok: true } })
  render(<Harness original={original} initial={initial} />)
  fireEvent.click(screen.getByRole('button', { name: 'Conflict' }))
  const dialog = within(await screen.findByRole('dialog'))
  expect(await dialog.findByText('Field not present')).toBeTruthy()
  expect(dialog.getByRole<HTMLButtonElement>('button', { name: 'Apply to draft' }).disabled).toBe(true)
  expect(applied).not.toHaveBeenCalled()
  fireEvent.click(within(dialog.getByRole('group', { name: 'Field “Amount”' })).getByRole('radio', { name: 'Use my changes' }))
  fireEvent.click(dialog.getByRole('button', { name: 'Apply to draft' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(JSON.parse(screen.getByTestId('draft').textContent!).spec.fields).toEqual(initial.spec.fields)
})
