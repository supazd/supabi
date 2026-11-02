import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from 'i18next'
import '../i18n'
import type { ParamFilter } from '../lib/paramFilters'
import type { SqlParam } from '../lib/params'
import { ParamFilterControl } from './ParamFilterControl'
import { ParamFilterDialog } from './ParamFilterDialog'

beforeEach(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
  window.matchMedia ??= (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })) as never
  await i18n.changeLanguage('en-US')
})
afterEach(cleanup)

const regions: SqlParam = { name: 'regions', label: 'Regions', type: 'string', multi: true, default: ['East', 'South'] }
const qty: SqlParam = { name: 'qty', type: 'integer', default: 1 }
const dialog = (filter: ParamFilter, param: SqlParam, needsValue = false) => {
  const done = vi.fn()
  render(<ParamFilterDialog filter={filter} param={param} needsValue={needsValue} isNew onDone={done} onCancel={() => undefined} />)
  return done
}
const ok = () => screen.getByRole<HTMLButtonElement>('button', { name: 'OK' })

describe('parameter settings', () => {
  it('lists the dataset’s default as options to pick from, following it until the author picks another', () => {
    const done = dialog({ id: 'p', param: 'regions', label: 'Regions', control: { type: 'input' } }, regions)
    fireEvent.click(screen.getByRole('radio', { name: 'Dropdown' }))
    expect(screen.getAllByRole<HTMLInputElement>('textbox', { name: /^Option/ }).map((input) => input.value)).toEqual(['East', 'South'])
    expect(screen.getByText(/^Default follows the dataset: East.+South$/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add an option' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Option 3' }), { target: { value: 'North' } })
    fireEvent.click(ok())
    expect(done).toHaveBeenCalledExactlyOnceWith({ id: 'p', param: 'regions', label: 'Regions', control: { type: 'select' }, options: ['East', 'South', 'North'] })
  })

  it('sets a default of its own when another is picked, and follows the dataset again on request', () => {
    const done = dialog({ id: 'p', param: 'regions', label: 'Regions', control: { type: 'select' }, options: ['North'] }, regions)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Make South the default' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Make North the default' }))
    fireEvent.click(ok())
    expect(done).toHaveBeenLastCalledWith(expect.objectContaining({ value: ['East', 'North'] }))
    fireEvent.click(screen.getByRole('button', { name: 'Use the dataset’s default' }))
    fireEvent.click(ok())
    expect(done.mock.lastCall![0]).not.toHaveProperty('value')
  })

  it('fixes a value viewers do not see, which it must have', () => {
    const done = dialog({ id: 'p', param: 'qty', label: 'qty', control: { type: 'input' } }, qty)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show as chart filter' }))
    const value = screen.getByRole('textbox', { name: 'Value' })
    fireEvent.change(value, { target: { value: '' } })
    expect(ok().disabled).toBe(true)
    fireEvent.change(value, { target: { value: 'many' } })
    expect(ok().disabled).toBe(true)
    fireEvent.change(value, { target: { value: '5' } })
    fireEvent.click(ok())
    expect(done).toHaveBeenCalledExactlyOnceWith({ id: 'p', param: 'qty', value: 5 })
  })

  it('needs a default for a parameter the SQL cannot do without', () => {
    dialog({ id: 'p', param: 'qty', label: 'qty', control: { type: 'input' } }, { ...qty, default: undefined }, true)
    expect(ok().disabled).toBe(true)
    expect(screen.getByRole('alert').textContent).toContain('needs a default')
    fireEvent.change(screen.getByRole('textbox', { name: 'Default value' }), { target: { value: '3' } })
    expect(ok().disabled).toBe(false)
  })
})

describe('a parameter’s control', () => {
  it('picks from what the dropdown offers, and is never left empty where the SQL needs a value', () => {
    const change = vi.fn()
    render(<ParamFilterControl kind="select" info={{ type: 'string', needsValue: true, default: 'East', options: ['East', 'North'] }} value="East" onChange={change} label="Region" />)
    expect(screen.getByRole('combobox', { name: 'Region' }).textContent).toContain('East')
    expect(change).not.toHaveBeenCalled()
  })

  it('reads what is typed as the parameter’s type, after a pause unless told otherwise', () => {
    const change = vi.fn()
    render(<ParamFilterControl kind="input" info={{ type: 'integer' }} value={1} onChange={change} label="Qty" debounce={false} />)
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Qty' })
    fireEvent.change(input, { target: { value: 'x' } })
    expect(change).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '7' } })
    expect(change).toHaveBeenLastCalledWith(7)
    fireEvent.change(input, { target: { value: '' } })
    expect(change).toHaveBeenLastCalledWith(null)
  })
})
