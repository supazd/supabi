import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../i18n'
import { FilterControl, FilterLabel, filterCaption, tilesLimit } from './FilterControl'
import i18n from 'i18next'

afterEach(() => { cleanup(); vi.useRealTimers() })

describe('FilterControl ownership changes', () => {
  it('cancels a pending number edit when global control takes over and restores the saved value', () => {
    vi.useFakeTimers()
    const change = vi.fn()
    const props = { control: { type: 'number' as const }, value: 50, onChange: change, label: 'Amount' }
    const view = render(<FilterControl {...props} />)
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Amount' })
    fireEvent.change(input, { target: { value: '90' } })
    view.rerender(<FilterControl {...props} disabled />)
    act(() => vi.advanceTimersByTime(400))
    expect(change).not.toHaveBeenCalled()
    expect(input.disabled).toBe(true)
    expect(input.value).toBe('50')
    view.rerender(<FilterControl {...props} />)
    fireEvent.change(input, { target: { value: '20' } })
    act(() => vi.advanceTimersByTime(400))
    expect(change).toHaveBeenCalledExactlyOnceWith(20)
  })

  it('commits pending input once when switching from automatic to manual queries', () => {
    vi.useFakeTimers()
    const change = vi.fn()
    const props = { control: { type: 'number' as const }, value: 50, onChange: change, label: 'Amount' }
    const view = render(<FilterControl {...props} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Amount' }), { target: { value: '90' } })
    act(() => vi.advanceTimersByTime(100))
    expect(change).not.toHaveBeenCalled()
    view.rerender(<FilterControl {...props} debounce={false} />)
    expect(change).toHaveBeenCalledExactlyOnceWith(90)
    act(() => vi.advanceTimersByTime(400))
    expect(change).toHaveBeenCalledExactlyOnceWith(90)
  })

  it.each(['number', 'number_range'] as const)('lets immediate %s controls build a negative decimal without clearing the condition', (type) => {
    const change = vi.fn()
    const expected = (value: number | null) => type === 'number_range' ? [value, 100] : value
    function Preview() {
      const [value, setValue] = useState<unknown>(expected(25))
      return <FilterControl control={{ type }} value={value} debounce={false} label="Amount" onChange={(next) => { change(next); setValue(next) }} />
    }
    render(<Preview />)
    const input = screen.getAllByRole<HTMLInputElement>('textbox')[0]!
    fireEvent.change(input, { target: { value: '-' } })
    expect(input.value).toBe('-')
    expect(change).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: `${input.value}0` } })
    expect(input.value).toBe('-0')
    expect(change).toHaveBeenLastCalledWith(expected(-0))
    fireEvent.change(input, { target: { value: `${input.value}.` } })
    expect(input.value).toBe('-0.')
    fireEvent.change(input, { target: { value: `${input.value}5` } })
    expect(input.value).toBe('-0.5')
    expect(change).toHaveBeenLastCalledWith(expected(-0.5))
    fireEvent.change(input, { target: { value: '' } })
    expect(input.value).toBe('')
    expect(change).toHaveBeenLastCalledWith(expected(null))
  })
})


it('stops the choice spinner when a global filter takes over during loading', async () => {
  window.matchMedia ??= (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })) as never
  const props = { control: { type: 'select' as const }, label: 'Region', value: [], onChange: vi.fn(), loadOptions: () => new Promise<{ values: unknown[]; truncated: boolean }>(() => undefined) }
  const view = render(<FilterControl {...props} />)
  const box = () => screen.getByRole('combobox', { name: 'Region' })
  await waitFor(() => expect(box().getAttribute('aria-busy')).toBe('true'))
  view.rerender(<FilterControl {...props} disabled />)
  await waitFor(() => expect(box().getAttribute('aria-busy')).toBeNull())
})

describe('choice controls', () => {
  it('falls back from tiles to a dropdown when there are too many values', async () => {
    const many = Array.from({ length: tilesLimit + 1 }, (_, i) => `v${i}`)
    render(<FilterControl control={{ type: 'tiles', multi: true }} value={[]} onChange={() => undefined} label="Values" loadOptions={async () => ({ values: many, truncated: false })} />)
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Values' })).toBeNull())
    expect(screen.getByRole('combobox', { name: 'Values' })).toBeTruthy()
  })

  it('keeps few values as tiles', async () => {
    render(<FilterControl control={{ type: 'tiles', multi: true }} value={[]} onChange={() => undefined} label="Values" loadOptions={async () => ({ values: ['a', 'b'], truncated: false })} />)
    expect(await screen.findByRole('button', { name: 'b' })).toBeTruthy()
  })

  it('says when a control leaves out what is chosen', async () => {
    await i18n.changeLanguage('en-US')
    expect(filterCaption('Region', 'not_in', i18n.t.bind(i18n))).toBe('Region · NOT IN')
    expect(filterCaption('Region', 'not_contains', i18n.t.bind(i18n))).toBe('Region · does not contain')
    expect(filterCaption('Region', 'in', i18n.t.bind(i18n))).toBe('Region')
    render(<FilterLabel label="Region" op="not_in" />)
    expect(screen.getByText('NOT IN').className).toBe('filter-op-tag')
  })
})
