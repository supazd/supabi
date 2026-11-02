import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from 'i18next'
import '../i18n'
import type { ChartFilter } from '../lib/filters'
import { FilterDialog } from './FilterDialog'
import { describeCondition, describeValue } from '../lib/filters'
import { aggLabel } from '../lib/aggregations'
import { parseFilterValues } from './ExactFilterValues'

beforeEach(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
  window.matchMedia ??= (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })) as never
  await i18n.changeLanguage('en-US')
})
afterEach(cleanup)
const textField = { key: 'region', label: 'Region', type: 'string' as const, role: 'dimension' as const }
const choices = async () => ({ values: ['East', 'West'], truncated: false })
const initial: ChartFilter = { id: 'region', field: 'region', op: 'in', label: 'Region', control: { type: 'select' }, value: ['East'] }
const dialog = (filter: ChartFilter = initial) => {
  const done = vi.fn()
  render(<FilterDialog filter={filter} field={textField} isNew={false} loadOptions={choices} onDone={done} onCancel={() => undefined} />)
  return done
}

describe('filter configuration', () => {
  it('preserves an interactive comparison when its active condition tab is clicked again', () => {
    const done = vi.fn()
    const filter: ChartFilter = { id: 'quantity', field: 'quantity', op: 'gte', value: 100, label: 'Quantity', control: { type: 'number' } }
    render(<FilterDialog filter={filter} field={{ key: 'quantity', label: 'Quantity', type: 'integer', role: 'measure' }}
      isNew={false} loadOptions={choices} onDone={done} onCancel={() => undefined} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Conditions' }))
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Default value' }).value).toBe('100')
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(done).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(filter))
  })

  it('keeps an invalid manual draft and its validation when its active tab is clicked again', () => {
    const done = dialog()
    fireEvent.click(screen.getByRole('radio', { name: 'Manual input' }))
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Manual input' })
    fireEvent.change(input, { target: { value: '"unfinished' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Manual input' }))
    expect(input.value).toBe('"unfinished')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'OK' }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(done).not.toHaveBeenCalled()
  })

  it('keeps implicit single selection single when editing exact choices', async () => {
    const done = dialog()
    fireEvent.click(await screen.findByRole('radio', { name: 'West' }))
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(done.mock.calls[0]![0].value).toEqual(['West'])
  })

  it('excludes the chosen values with one checkbox and says so where they are chosen', async () => {
    const done = dialog()
    await screen.findByRole('radio', { name: 'West' })
    expect(screen.getByText('1 selected')).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Exclude selected values' }))
    expect(screen.getByText('1 to exclude')).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: 'Manual input' }))
    expect(screen.getByRole<HTMLButtonElement>('checkbox', { name: 'Exclude selected values' }).getAttribute('data-state')).toBe('checked')
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(done).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ op: 'not_in', value: ['East'] }))
  })

  it('blocks multiple pasted defaults for a single-choice control', () => {
    dialog()
    fireEvent.click(screen.getByRole('radio', { name: 'Manual input' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Manual input' }), { target: { value: 'East\nWest' } })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'OK' }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Several values' }))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'OK' }).disabled).toBe(false)
  })

  it('keeps quoted, comma and newline values when opening manual input', () => {
    const values = [' North ', '', '  ', 'a,b', 'say "hello"', 'two\nlines']
    const done = dialog({ ...initial, control: { type: 'select', multi: true }, value: values })
    fireEvent.click(screen.getByRole('radio', { name: 'Manual input' }))
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Manual input' })
    fireEvent.change(input, { target: { value: `${input.value}\nlast` } })
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(done.mock.calls[0]![0].value).toEqual([...values, 'last'])
  })

  it('imports exact string values from CSV without retaining the previous selection', async () => {
    const done = dialog({ ...initial, control: { type: 'select', multi: true } })
    fireEvent.click(screen.getByRole('radio', { name: 'Manual input' }))
    const csv = '" North ","","two\nlines","say ""hello"""\n\n'
    const file = new File([csv], 'values.csv', { type: 'text/csv' })
    Object.defineProperty(file, 'text', { value: async () => csv })
    fireEvent.change(screen.getByLabelText('Import CSV'), { target: { files: [file] } })
    await waitFor(() => expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Manual input' }).value).toBe(csv))
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(done.mock.calls[0]![0].value).toEqual([' North ', '', 'two\nlines', 'say "hello"'])
  })

  it('blocks confirmation for an invalid edited numeric range', async () => {
    render(<FilterDialog filter={{ id: 'n', field: 'amount', op: 'between', value: [1, 10] }} field={{ key: 'amount', label: 'Amount', type: 'decimal', role: 'measure' }} isNew={false} loadOptions={choices} onDone={() => undefined} onCancel={() => undefined} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Value · Min' }), { target: { value: '50' } })
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'OK' }).disabled).toBe(true))
    fireEvent.change(screen.getByRole('textbox', { name: 'Value · Min' }), { target: { value: '5' } })
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'OK' }).disabled).toBe(false))
  })

  it('does not offer cascades for a boolean aggregate metric', () => {
    render(<FilterDialog filter={{ ...initial, field: 'flag' }} field={{ key: 'flag', label: 'Flag', type: 'boolean', role: 'metric' }} isNew={false} loadOptions={choices} onDone={() => undefined} onCancel={() => undefined} />)
    expect(screen.queryByRole('combobox', { name: 'Parent filters' })).toBeNull()
  })

  it('describes strict interval boundaries without claiming inclusivity', () => {
    expect(describeValue('between', { min: 5, includeMin: false }, i18n.t.bind(i18n))).toBe('> 5')
    expect(describeValue('not_between', { min: 5, max: 10, includeMin: false }, i18n.t.bind(i18n))).toBe('(5, 10]')
  })

  it('writes conditions as a formula would, keeping words where there is no symbol', () => {
    const t = i18n.t.bind(i18n)
    expect(describeCondition('eq', 'app', t)).toBe('= app')
    expect(describeCondition('gte', 100, t)).toBe('≥ 100')
    expect(describeCondition('in', ['app'], t)).toBe('= app')
    expect(describeCondition('not_in', ['app'], t)).toBe('≠ app')
    expect(describeCondition('in', ['a', 'b'], t)).toBe('IN (a, b)')
    expect(describeCondition('not_in', ['a', 'b', 'c', 'd', 'e'], t)).toBe('NOT IN (a, b, c, +2)')
    expect(describeCondition('in', [], t)).toBe('Any')
    expect(describeCondition('between', { min: 1, max: 10 }, t)).toBe('[1, 10]')
    expect(describeCondition('not_between', { min: 1, max: 10, includeMax: false }, t)).toBe('NOT [1, 10)')
    expect(describeCondition('between', { min: 5 }, t)).toBe('≥ 5')
    // Leaving out one bound keeps the other side of it.
    expect(describeCondition('not_between', { min: 5 }, t)).toBe('< 5')
    expect(describeCondition('not_between', { max: 10, includeMax: false }, t)).toBe('≥ 10')
    expect(describeCondition('is_null', undefined, t)).toBe('IS NULL')
    expect(describeCondition('contains', 'pa', t)).toBe('contains pa')
  })

  it('names an aggregated column as a function of it, in every language', () => {
    expect(aggLabel('sum', 'Amount')).toBe('SUM(Amount)')
    expect(aggLabel('count_distinct', '用户id')).toBe('COUNT(DISTINCT 用户id)')
  })

  it('parses quoted CSV cells and rejects invalid numbers without losing their type', () => {
    expect(parseFilterValues('"a,b",c\n"two\nlines","say ""hello"""', 'string')).toEqual({ values: ['a,b', 'c', 'two\nlines', 'say "hello"'], invalid: false })
    expect(parseFilterValues('1\t2\n1', 'integer')).toEqual({ values: [1, 2], invalid: false })
    expect(parseFilterValues('1.5', 'integer').invalid).toBe(true)
    expect(parseFilterValues('"unterminated', 'string').invalid).toBe(true)
  })

  it('preserves quoted string cells while ignoring unquoted empty cells and blank lines', () => {
    expect(parseFilterValues('\n \r\n," North ","",West\t" \t "\r\n"two\r\nlines","say ""hello"""\n\n', 'string')).toEqual({
      values: [' North ', '', 'West', ' \t ', 'two\r\nlines', 'say "hello"'], invalid: false,
    })
    expect(parseFilterValues('\r\n \t ,\n', 'string')).toEqual({ values: [], invalid: false })
    expect(parseFilterValues('  " North "  , West ', 'string')).toEqual({ values: [' North ', 'West'], invalid: false })
  })

  it('does not reinterpret an explicit empty numeric or boolean CSV cell as a value', () => {
    for (const type of ['integer', 'decimal', 'boolean']) expect(parseFilterValues('""', type).invalid).toBe(true)
    expect(parseFilterValues('" 1 ", 2', 'integer')).toEqual({ values: [1, 2], invalid: false })
    expect(parseFilterValues('"true",false', 'boolean')).toEqual({ values: [true, false], invalid: false })
    expect(parseFilterValues('"North"extra', 'string').invalid).toBe(true)
  })
})
