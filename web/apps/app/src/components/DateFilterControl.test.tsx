import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { openPopup } from '@supabi/ui/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../i18n'
import { api } from '../api/client'
import type { ChartFilter } from '../lib/filters'
import { DateFilterControl } from './DateFilterControl'
import { FilterDialog } from './FilterDialog'

afterEach(cleanup)
beforeEach(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
  window.matchMedia ??= (() => ({ matches: false, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined })) as never
  await i18n.changeLanguage('en-US')
})

const ok = () => screen.getByRole<HTMLButtonElement>('button', { name: 'OK' })

async function choose(label: string, value: string) {
  openPopup(screen.getByRole('combobox', { name: label }))
  fireEvent.click(await screen.findByRole('option', { name: value }))
}

describe('DateFilterControl', () => {
  it('prevents confirming an invalid numeric condition instead of saving the previous number', async () => {
    const done = vi.fn()
    render(<FilterDialog filter={{ id: 'amount', field: 'amount', op: 'gte', value: 10 }} field={{ key: 'amount', label: 'Amount', type: 'decimal', role: 'measure' }}
      isNew={false} loadOptions={async () => ({ values: [], truncated: false })} onDone={done} onCancel={() => undefined} />)
    const input = await screen.findByRole('textbox', { name: 'Value' })
    fireEvent.change(input, { target: { value: '-' } })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'OK' }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(done).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '-15' } })
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(done).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ value: -15 }))
  })

  it('prevents confirming an incomplete last-N count and restores validity after correction', async () => {
    const change = vi.fn(), validity = vi.fn()
    render(<DateFilterControl control={{ type: 'relative' }} label="Order date" value={{ last: { n: 3, unit: 'month' } }} onChange={change} onValidityChange={validity} />)
    fireEvent.click(screen.getByRole('button', { name: /^Order date/ }))
    const count = await screen.findByRole('textbox', { name: 'How many' })
    fireEvent.change(count, { target: { value: '' } })
    expect(ok().disabled).toBe(true)
    expect(validity).toHaveBeenLastCalledWith(false)
    expect(change).not.toHaveBeenCalled()
    fireEvent.change(count, { target: { value: '2.5' } })
    expect(ok().disabled).toBe(true)
    fireEvent.change(count, { target: { value: '2' } })
    expect(ok().disabled).toBe(false)
    fireEvent.click(ok())
    expect(change).toHaveBeenCalledExactlyOnceWith({ last: { n: 2, unit: 'month' } })
    expect(validity).toHaveBeenLastCalledWith(true)
  })

  it('offers the named periods as buttons', async () => {
    const change = vi.fn()
    render(<DateFilterControl control={{ type: 'relative' }} label="Order date" value={{}} onChange={change} />)
    fireEvent.click(screen.getByRole('button', { name: /^Order date/ }))
    fireEvent.click(await screen.findByRole('radio', { name: 'Last 30 days' }))
    expect(screen.getByRole('radio', { name: 'Last 30 days' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(ok())
    expect(change).toHaveBeenCalledExactlyOnceWith({ last: { n: 30, unit: 'day' }, includeCurrent: true })
  })

  it('says a moving start as a count of periods ago or from now', async () => {
    const change = vi.fn()
    render(<DateFilterControl control={{ type: 'relative' }} label="Order date" value={{ bounds: { start: { relative: { n: 0, unit: 'day' } } } }} onChange={change} />)
    fireEvent.click(screen.getByRole('button', { name: /^Order date/ }))
    const count = await screen.findByRole<HTMLInputElement>('textbox', { name: 'Start (included) · How many' })
    fireEvent.change(count, { target: { value: '-' } })
    expect(count.value).toBe('-')
    expect(ok().disabled).toBe(true)
    fireEvent.change(count, { target: { value: '7' } })
    await choose('Start (included) · Before or after', 'ago')
    fireEvent.click(ok())
    expect(change).toHaveBeenCalledExactlyOnceWith({ bounds: { start: { relative: { n: -7, unit: 'day' } } } })
  })

  it('says the end of a range as the last period it keeps', async () => {
    const change = vi.fn()
    render(<DateFilterControl control={{ type: 'relative' }} label="Order date" value={{ bounds: { start: { fixed: '2026-01-04' }, end: { relative: { n: 1, unit: 'day' } } } }} onChange={change} />)
    fireEvent.click(screen.getByRole('button', { name: /^Order date/ }))
    // An end one day on keeps today: nothing ago.
    const count = await screen.findByRole<HTMLInputElement>('textbox', { name: 'End (included) · How many' })
    expect(count.value).toBe('0')
    fireEvent.change(count, { target: { value: '2' } })
    await choose('End (included) · Before or after', 'ago')
    fireEvent.click(ok())
    expect(change).toHaveBeenCalledExactlyOnceWith({ bounds: { start: { fixed: '2026-01-04' }, end: { relative: { n: -1, unit: 'day' } } } })
  })

  it('shows a fixed end as the last day kept', async () => {
    render(<DateFilterControl control={{ type: 'relative' }} label="Order date" value={{ bounds: { start: { fixed: '2026-01-04' }, end: { fixed: '2026-02-01' } } }} onChange={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: /^Order date/ }))
    expect((await screen.findByRole('button', { name: 'End (included) · Fixed dates' })).textContent).toContain('2026-01-31')
  })

  it('discards canceled edits when the panel is reopened', async () => {
    const change = vi.fn()
    render(<DateFilterControl control={{ type: 'relative' }} label="Order date" value={{ bounds: { start: { relative: { n: -3, unit: 'day' } } } }} onChange={change} />)
    fireEvent.click(screen.getByRole('button', { name: /^Order date/ }))
    fireEvent.change(await screen.findByRole('textbox', { name: 'Start (included) · How many' }), { target: { value: '7' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(change).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByRole('button', { name: /^Order date/ }).getAttribute('aria-expanded')).toBe('false'))
    fireEvent.click(screen.getByRole('button', { name: /^Order date/ }))
    expect((await screen.findByRole<HTMLInputElement>('textbox', { name: 'Start (included) · How many' })).value).toBe('3')
  })

  it('confirms a special null-date selection without retaining old interval fields', async () => {
    const change = vi.fn()
    render(<DateFilterControl control={{ type: 'relative' }} label="Order date" value={{ current: 'month' }} onChange={change} />)
    fireEvent.click(screen.getByRole('button', { name: /^Order date/ }))
    fireEvent.click(await screen.findByRole('radio', { name: 'Special values' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Null dates' }))
    expect(change).not.toHaveBeenCalled()
    fireEvent.click(ok())
    expect(change).toHaveBeenCalledExactlyOnceWith({ special: 'is_null' })
  })

  it('rejects empty or unbounded intervals before confirmation', async () => {
    render(<DateFilterControl control={{ type: 'relative' }} label="Order date" value={{ bounds: { start: { relative: { n: 0, unit: 'day' } }, end: { relative: { n: 0, unit: 'day' } } } }} onChange={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: /^Order date/ }))
    // Starting today and ending yesterday keeps nothing.
    expect((await screen.findByRole<HTMLButtonElement>('button', { name: 'OK' })).disabled).toBe(true)
    fireEvent.change(screen.getByRole('textbox', { name: 'End (included) · How many' }), { target: { value: '0' } })
    expect(ok().disabled).toBe(false)
    await choose('Start (included)', 'Unbounded')
    await choose('End (included)', 'Unbounded')
    expect(screen.getByRole('alert').textContent).toBe('The start and the end cannot both be unbounded.')
    expect(ok().disabled).toBe(true)
  })

  it('discards an open editor when the filter is taken over', async () => {
    const change = vi.fn()
    const props = { control: { type: 'relative' as const }, label: 'Order date', value: { bounds: { start: { relative: { n: -3, unit: 'day' } } } }, onChange: change }
    const view = render(<DateFilterControl {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /^Order date/ }))
    fireEvent.change(await screen.findByRole('textbox', { name: 'Start (included) · How many' }), { target: { value: '7' } })
    view.rerender(<DateFilterControl {...props} disabled />)
    view.rerender(<DateFilterControl {...props} />)
    expect(screen.getByRole('button', { name: /^Order date/ }).getAttribute('aria-expanded')).toBe('false')
    expect(change).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /^Order date/ }))
    expect((await screen.findByRole<HTMLInputElement>('textbox', { name: 'Start (included) · How many' })).value).toBe('3')
  })

  it('clears to any time from the dates it shows', async () => {
    const change = vi.fn()
    render(<DateFilterControl control={{ type: 'relative' }} label="Order date" value={{ special: 'not_null' }} onChange={change} />)
    fireEvent.click(screen.getByRole('button', { name: /^Order date/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Clear' }))
    expect(screen.getByText('Any time')).toBeTruthy()
    fireEvent.click(ok())
    expect(change).toHaveBeenCalledExactlyOnceWith({})
  })

  it('keeps the draft when the selected way is clicked again', async () => {
    render(<DateFilterControl control={{ type: 'relative' }} label="Order date" value={{ bounds: { start: { relative: { n: -3, unit: 'day' } } } }} onChange={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: /^Order date/ }))
    const count = await screen.findByRole<HTMLInputElement>('textbox', { name: 'Start (included) · How many' })
    fireEvent.change(count, { target: { value: '7' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Advanced' }))
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Start (included) · How many' }).value).toBe('7')
  })

  it('shows the dates the server resolves, and carries them over to fixed dates', async () => {
    const resolve = vi.spyOn(api, 'POST').mockResolvedValue({ data: { start: '2026-10-01T00:00:00', end: '2026-11-01T00:00:00' }, response: new Response(null, { status: 200 }) } as never)
    const change = vi.fn()
    render(<DateFilterControl control={{ type: 'relative' }} label="Order date" value={{ current: 'month' }} onChange={change} />)
    fireEvent.click(screen.getByRole('button', { name: /^Order date/ }))
    expect(await screen.findByText('2026-10-01 ~ 2026-10-31')).toBeTruthy()
    expect(resolve).toHaveBeenCalledWith('/time-ranges/resolve', { body: { range: { current: 'month' } } })
    fireEvent.click(screen.getByRole('radio', { name: 'Fixed dates' }))
    fireEvent.click(ok())
    expect(change).toHaveBeenCalledExactlyOnceWith({ start: '2026-10-01', end: '2026-11-01' })
    resolve.mockRestore()
  })

  it('refuses a range the server finds empty', async () => {
    const resolve = vi.spyOn(api, 'POST').mockResolvedValue({ error: { code: 'invalid_time_range', message: 'start must be before end' }, response: new Response(null, { status: 400 }) } as never)
    render(<DateFilterControl control={{ type: 'relative' }} label="Order date" value={{ bounds: { start: { fixed: '2026-01-04' }, end: { relative: { n: -400, unit: 'day' } } } }} onChange={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: /^Order date/ }))
    expect((await screen.findByRole('alert')).textContent).toBe('The start must come before the end.')
    // The editor reports its validity to the panel in an effect, so the button follows the alert a render later.
    await waitFor(() => expect(ok().disabled).toBe(true))
    resolve.mockRestore()
  })

  it('shows the range of an advanced value on the trigger', () => {
    render(<DateFilterControl control={{ type: 'relative' }} label="Order date" value={{ bounds: { start: { relative: { n: -6, unit: 'day' } }, end: { relative: { n: 1, unit: 'day' } } } }} onChange={() => undefined} />)
    expect(screen.getByRole('button', { name: 'Order date · 6 days ago ~ today' })).toBeTruthy()
  })
})

describe('date filters in the filter dialog', () => {
  const orderDate = { key: 'order_date', label: 'Order date', type: 'date' as const, role: 'dimension' as const }
  const open = (filter: ChartFilter) => {
    const done = vi.fn()
    render(<FilterDialog filter={filter} field={orderDate} isNew={false} loadOptions={async () => ({ values: [], truncated: false })} onDone={done} onCancel={() => undefined} />)
    return done
  }

  it('edits the dates in the dialog itself', () => {
    const done = open({ id: 'd', field: 'order_date', op: 'time', value: {} })
    fireEvent.click(screen.getByRole('radio', { name: 'Last month' }))
    fireEvent.click(ok())
    expect(done).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ op: 'time', value: { last: { n: 1, unit: 'month' } } }))
  })

  it('reads a null condition saved before as its special value', () => {
    const done = open({ id: 'd', field: 'order_date', op: 'is_null' })
    expect(screen.getByRole('radio', { name: 'Null dates' }).getAttribute('aria-checked') ?? (screen.getByRole<HTMLInputElement>('radio', { name: 'Null dates' }).checked ? 'true' : 'false')).toBe('true')
    fireEvent.click(ok())
    expect(done).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ op: 'time', value: { special: 'is_null' } }))
  })

  it('opens a calendar of two days saved before as the date range panel', () => {
    const done = open({ id: 'd', field: 'order_date', op: 'time', value: { start: '2026-01-01', end: '2026-02-01' }, label: 'Order date', control: { type: 'date_range' } })
    expect(screen.getByRole('radio', { name: 'Fixed dates' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(ok())
    expect(done).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ control: { type: 'relative' }, value: { start: '2026-01-01', end: '2026-02-01' } }))
  })
})

describe('date granularity, weeks and empty dates', () => {
  const panel = async (value: object, change = vi.fn()) => {
    render(<DateFilterControl control={{ type: 'relative' }} label="Order date" value={value} onChange={change} />)
    fireEvent.click(screen.getByRole('button', { name: /^Order date/ }))
    await screen.findByRole('combobox', { name: 'Granularity' })
    return change
  }

  it('keeps rows without a date when asked, whatever period is chosen after', async () => {
    const change = await panel({ current: 'month' })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include empty dates' }))
    expect(screen.getByText('This month (with empty dates)')).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: 'Last week' }))
    fireEvent.click(ok())
    expect(change).toHaveBeenCalledExactlyOnceWith({ last: { n: 1, unit: 'week' }, includeNull: true })
  })

  it('offers no empty dates beside the special values, and drops them there', async () => {
    const change = await panel({ current: 'month', includeNull: true })
    fireEvent.click(screen.getByRole('radio', { name: 'Special values' }))
    expect(screen.queryByRole('checkbox', { name: 'Include empty dates' })).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: 'Null dates' }))
    fireEvent.click(ok())
    expect(change).toHaveBeenCalledExactlyOnceWith({ special: 'is_null' })
  })

  it('by month offers months, quarters and years only, and keeps what fits', async () => {
    const change = await panel({ current: 'quarter' })
    await choose('Granularity', 'Year-month')
    expect(screen.queryByRole('radio', { name: 'Today' })).toBeNull()
    expect(screen.queryByRole('radio', { name: 'Advanced' })).toBeNull()
    expect(screen.getByRole('radio', { name: 'This quarter' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('radio', { name: 'Last 6 months' }))
    fireEvent.click(ok())
    expect(change).toHaveBeenCalledExactlyOnceWith({ last: { n: 6, unit: 'month' }, includeCurrent: true, grain: 'month' })
  })

  it('by month clears a period counted in days', async () => {
    const change = await panel({ last: { n: 7, unit: 'day' }, includeCurrent: true })
    await choose('Granularity', 'Year-month')
    expect(screen.getByText('Any time')).toBeTruthy()
    fireEvent.click(ok())
    expect(change).toHaveBeenCalledExactlyOnceWith({ grain: 'month' })
  })

  it('by month picks fixed months, and turns fixed days into the months they fall in', async () => {
    const change = await panel({ start: '2026-01-15', end: '2026-03-11' })
    await choose('Granularity', 'Year-month')
    expect(screen.getByRole('button', { name: 'February 2026' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'April 2026' }))
    fireEvent.click(screen.getByRole('button', { name: 'June 2026' }))
    fireEvent.click(ok())
    expect(change).toHaveBeenCalledExactlyOnceWith({ start: '2026-04-01', end: '2026-07-01', grain: 'month' })
  })

  it('by week offers weeks only, and sets the day they start on', async () => {
    const change = await panel({})
    await choose('Granularity', 'Year-week')
    expect(screen.getAllByRole('radio').filter((radio) => radio.closest('.date-presets')).map((radio) => radio.textContent)).toEqual(['This week', 'Last week', 'Last 4 weeks', 'Custom'])
    fireEvent.click(screen.getByRole('radio', { name: 'This week' }))
    await choose('Weeks run', 'Tuesday to Monday')
    fireEvent.click(ok())
    expect(change).toHaveBeenCalledExactlyOnceWith({ current: 'week', grain: 'week', weekStart: 2 })
  })

  it('by week moves fixed weeks to the new weeks they fall in', async () => {
    const change = await panel({ start: '2026-10-12', end: '2026-10-19', grain: 'week' })
    await choose('Weeks run', 'Sunday to Saturday')
    fireEvent.click(ok())
    expect(change).toHaveBeenCalledExactlyOnceWith({ start: '2026-10-11', end: '2026-10-25', grain: 'week', weekStart: 7 })
  })
})
