import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useState } from 'react'
import i18n from 'i18next'
import '../../i18n'
import type { SpecField } from '../../api/spec'
import type { Filter } from '../../lib/policy'
import { PolicyCondition } from './PolicyCondition'

const fields: SpecField[] = [{ key: 'region', label: 'Region', type: 'string', role: 'dimension' }, { key: 'amount', label: 'Amount', type: 'integer', role: 'dimension' }]
const attributes = [{ key: 'regions', name: 'Regions', builtin: false, assignments: [] }]
beforeEach(async () => { await i18n.changeLanguage('en-US') })
afterEach(cleanup)

it('retains mixed and nested filters while editing group logic and removing a nested condition', () => {
  const initial: Filter = { op: 'or', args: [
    { field: 'region', op: 'eq', value: 'East' },
    { op: 'and', args: [{ field: 'region', op: 'in', value: { userAttr: 'regions' } }, { field: 'amount', op: 'gt', value: 10 }] },
  ] }
  const change = vi.fn()
  function Editor() {
    const [filter, setFilter] = useState(initial)
    return <PolicyCondition datasetId="orders" fields={fields} attributes={attributes} filter={filter} onChange={(next) => { change(next); setFilter(next!) }} />
  }
  const { container } = render(<Editor />)
  expect(change).not.toHaveBeenCalled()
  expect(screen.getByText(i18n.t('policy.mixedValues'))).toBeTruthy()
  fireEvent.click(screen.getAllByRole('combobox', { name: i18n.t('policy.conditionLogic') })[0]!)
  fireEvent.click(screen.getByRole('option', { name: i18n.t('policy.and') }))
  expect(change).toHaveBeenLastCalledWith({ ...initial, op: 'and' })
  const nested = container.querySelector('.policy-condition-nested')! as HTMLElement
  fireEvent.click(within(nested).getByRole('button', { name: i18n.t('policy.removeCondition', { n: 2 }) }))
  expect(change).toHaveBeenLastCalledWith({ op: 'and', args: [(initial.args as Filter[])[0], { op: 'and', args: [{ field: 'region', op: 'in', value: { userAttr: 'regions' } }] }] })
})

it('adds dynamic conditions without changing the existing attribute condition', () => {
  const initial: Filter = { field: 'region', op: 'in', value: { userAttr: 'regions' } }
  const change = vi.fn()
  render(<PolicyCondition datasetId="orders" fields={fields} attributes={attributes} filter={initial} onChange={change} />)
  expect((screen.getByRole('radio', { name: i18n.t('policy.dynamic') }) as HTMLInputElement).checked).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: i18n.t('policy.addCondition') }))
  expect(change).toHaveBeenCalledWith({ op: 'and', args: [initial, { field: '', op: 'in', value: { userAttr: '' } }] })
})

it('keeps the displayed scalar value aligned with the remaining condition after deletion', () => {
  const initial: Filter = { op: 'and', args: [
    { field: 'amount', op: 'gt', value: 1000 },
    { field: 'amount', op: 'gt', value: 10 },
  ] }
  const save = vi.fn()
  function Editor() {
    const [filter, setFilter] = useState(initial)
    return <><PolicyCondition datasetId="orders" fields={fields} attributes={attributes} filter={filter} onChange={(next) => setFilter(next!)} /><button onClick={() => save(filter)}>Save</button></>
  }
  render(<Editor />)
  expect(screen.getAllByRole('textbox', { name: i18n.t('filter.value') }).map((input) => (input as HTMLInputElement).value)).toEqual(['1000', '10'])
  fireEvent.click(screen.getByRole('button', { name: i18n.t('policy.removeCondition', { n: 1 }) }))
  const input = screen.getByRole('textbox', { name: i18n.t('filter.value') }) as HTMLInputElement
  expect(input.value).toBe('10')
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(save).toHaveBeenLastCalledWith({ op: 'and', args: [{ field: 'amount', op: 'gt', value: 10 }] })
  // An unfinished numeric edit stays visible without becoming a valid condition.
  fireEvent.change(input, { target: { value: '-' } })
  expect(input.value).toBe('-')
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(save.mock.lastCall?.[0].args[0].value).toBeUndefined()
  fireEvent.change(input, { target: { value: '-20' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(input.value).toBe('-20')
  expect(save.mock.lastCall?.[0].args[0].value).toBe(-20)
})

it('reflects externally replaced scalar conditions rather than retaining old input text', () => {
  const { rerender } = render(<PolicyCondition datasetId="orders" fields={fields} attributes={attributes} filter={{ field: 'amount', op: 'gt', value: 1000 }} onChange={() => {}} />)
  rerender(<PolicyCondition datasetId="orders" fields={fields} attributes={attributes} filter={{ field: 'amount', op: 'gt', value: 10 }} onChange={() => {}} />)
  expect((screen.getByRole('textbox', { name: i18n.t('filter.value') }) as HTMLInputElement).value).toBe('10')
})
