import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { openPopup } from '@supabi/ui/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from 'i18next'
import '../i18n'
import { ApiError, type Chart, type LogicalType } from '../api/client'
import type { FilterField } from '../lib/filters'
import type { ChartItem } from '../lib/layout'
import type { DashboardLink } from '../lib/links'
import { DashboardLinksDialog } from './DashboardLinksDialog'

const charts = [
  { id: 'c1', name: 'Regions', datasetId: 'sales', spec: { query: { dimensions: [{ field: 'region' }, { field: 'city' }, { field: 'amount' }] }, viz: { type: 'table' } } },
  { id: 'c2', name: 'Orders', datasetId: 'sales', spec: { query: { dimensions: [{ field: 'region' }] }, viz: { type: 'bar', x: 'region' } } },
  { id: 'c3', name: 'Customers', datasetId: 'customers', spec: { query: { dimensions: [{ field: 'area' }] }, viz: { type: 'pie', x: 'area' } } },
] as unknown as Chart[]
const items = charts.map((chart, i) => ({ id: `w${i + 1}`, chartId: chart.id })) as ChartItem[]
const field = (item: string, key: string, label: string, type: LogicalType = 'string'): FilterField => {
  const chart = charts[Number(item[1]) - 1]!
  return { item, chartId: chart.id, chartName: chart.name, datasetId: chart.datasetId, target: { item, field: key }, label, type, aggregate: false, source: 'dataset', identity: `${chart.datasetId}:${key}` }
}
const fields = [field('w1', 'region', 'Region'), field('w1', 'city', 'City'), field('w1', 'amount', 'Revenue', 'decimal'), field('w2', 'region', 'Region'), field('w2', 'city', 'City'), field('w3', 'area', 'Area')]
const initial: DashboardLink[] = [{ id: 'region', label: 'Region link', source: { item: 'w1', column: 'region' }, targets: [{ item: 'w2', field: 'region' }] }]
const setup = (links = initial, extra = {}) => {
  const onDone = vi.fn(), onCancel = vi.fn()
  render(<DashboardLinksDialog links={links} items={items} charts={charts} fields={fields} onDone={onDone} onCancel={onCancel} {...extra} />)
  return { onDone, onCancel }
}
const choose = async (label: string, option: string) => {
  const trigger = screen.getByRole('combobox', { name: label })
  openPopup(trigger)
  fireEvent.click(await screen.findByRole('option', { name: option }))
  await waitFor(() => expect(document.activeElement).toBe(trigger))
}
beforeEach(async () => { await i18n.changeLanguage('en-US') })
afterEach(cleanup)

describe('chart link settings', () => {
  it('creates a rule, matches fields from the same dataset, and keeps edits local until confirmed', async () => {
    const { onDone } = setup([])
    fireEvent.click(screen.getAllByRole('button', { name: 'Add link' })[0]!)
    expect((screen.getByRole('button', { name: 'OK' }) as HTMLButtonElement).disabled).toBe(true)
    await choose('Add target chart…', 'Orders')
    expect(screen.getByRole('combobox', { name: 'Orders · Target field' }).textContent).toBe('Region')
    expect(onDone).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(onDone.mock.calls[0]![0]).toEqual([expect.objectContaining({ source: { item: 'w1', column: 'region' }, targets: [{ item: 'w2', field: 'region' }] })])
  })

  it('searches available charts, maps one field per target, and replaces rather than appends fields', async () => {
    const { onDone } = setup()
    const trigger = screen.getByRole('combobox', { name: 'Add target chart…' })
    openPopup(trigger)
    await act(async () => { fireEvent.change(screen.getByRole('combobox', { expanded: true, name: '' }), { target: { value: 'customer' } }) })
    expect(screen.queryByRole('option', { name: 'Orders' })).toBeNull()
    fireEvent.click(screen.getByRole('option', { name: 'Customers' }))
    await waitFor(() => expect(document.activeElement).toBe(trigger))
    expect((screen.getByRole('button', { name: 'OK' }) as HTMLButtonElement).disabled).toBe(true)
    await choose('Customers · Target field', 'Area')
    await choose('Orders · Target field', 'City')
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(onDone.mock.calls[0]![0][0].targets).toEqual([{ item: 'w2', field: 'city' }, { item: 'w3', field: 'area' }])
    expect(screen.queryByRole('button', { name: 'Add field mapping' })).toBeNull()
    expect(trigger.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Remove target: Orders' }))
    await choose('Add target chart…', 'Orders')
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(onDone.mock.calls[1]![0][0].targets).toEqual([{ item: 'w3', field: 'area' }, { item: 'w2', field: 'region' }])
  })

  it('requires an explicit choice when an older target has multiple fields, and leaves cancellation untouched', async () => {
    const original = [{ ...initial[0]!, targets: [{ item: 'w2', field: 'region' }, { item: 'w2', field: 'city' }] }]
    const { onDone, onCancel } = setup(original)
    expect((screen.getByRole('button', { name: 'OK' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getAllByRole('combobox', { name: 'Orders · Target field' })).toHaveLength(1)
    await choose('Orders · Target field', 'City')
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(onDone.mock.calls[0]![0][0].targets).toEqual([{ item: 'w2', field: 'city' }])
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledOnce()
    expect(original[0]!.targets).toHaveLength(2)
  })

  it('keeps compatible mappings when changing fields, but removes self-targets and incompatible mappings', async () => {
    const { onDone } = setup([{ ...initial[0]!, targets: [...initial[0]!.targets, { item: 'w3', field: 'area' }] }])
    await choose('Clicked field', 'City')
    expect(screen.getByRole('combobox', { name: 'Orders · Target field' }).textContent).toBe('Region')
    await choose('Source chart', 'Orders')
    expect(screen.queryByRole('combobox', { name: 'Orders · Target field' })).toBeNull()
    expect(screen.getByText('Removed 1 incompatible field mappings. Other mappings were kept.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(onDone.mock.calls[0]![0][0].targets).toEqual([{ item: 'w3', field: 'area' }])
    await choose('Source chart', 'Regions')
    await choose('Clicked field', 'Revenue')
    expect((screen.getByRole('button', { name: 'OK' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Select at least one target chart.')).toBeTruthy()
  })

  it('searches chart labels rather than internal widget IDs', async () => {
    setup()
    openPopup(screen.getByRole('combobox', { name: 'Source chart' }))
    await act(async () => { fireEvent.change(screen.getByRole('combobox', { expanded: true, name: '' }), { target: { value: 'Orders' } }) })
    expect(screen.queryByRole('option', { name: 'Regions' })).toBeNull()
    fireEvent.click(screen.getByRole('option', { name: 'Orders' }))
    expect(screen.getByRole('combobox', { name: 'Source chart' }).textContent).toBe('Orders')
  })

  it('blocks saving while fields are unavailable and offers a retry on load failure', () => {
    const onRetry = vi.fn()
    const { onDone } = setup(initial, { error: new ApiError(503, 'network_error', 'Offline'), onRetry })
    expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(onDone).not.toHaveBeenCalled()
  })

  it('retains drafts between rules and restores a deleted rule at its previous position', () => {
    const second: DashboardLink = { ...initial[0]!, id: 'second', label: 'Second' }
    const { onDone, onCancel } = setup([...initial, second])
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Renamed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Second' }))
    fireEvent.click(screen.getByRole('button', { name: 'Renamed' }))
    expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Renamed')
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'Undo deletion' }))
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(onDone.mock.calls[0]![0].map((link: DashboardLink) => link.label)).toEqual(['Renamed', 'Second'])
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledOnce()
    expect(initial[0]!.label).toBe('Region link')
  })

  it('allows clearing all rules, while preventing empty names and incomplete rules from being saved', () => {
    const { onDone } = setup()
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: '  ' } })
    expect((screen.getByRole('button', { name: 'OK' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Enter a link name.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(onDone).toHaveBeenCalledWith([])
  })
})
