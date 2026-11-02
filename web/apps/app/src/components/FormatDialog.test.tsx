import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from 'i18next'
import '../i18n'
import type { DateFormat, NumberFormat } from '@supabi/charts'
import { openPopup } from '@supabi/ui/testing'
import { FormatDialog, cleanFormat } from './FormatDialog'

beforeEach(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
  window.matchMedia ??= (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })) as never
  await i18n.changeLanguage('en-US')
})
afterEach(cleanup)

const money: NumberFormat = { decimals: 2, prefix: '¥' }
/** The dialog on a chart, which can follow the dataset. */
const onChart = (value: NumberFormat | undefined, inherited?: NumberFormat) => {
  const done = vi.fn()
  render(<FormatDialog name="Revenue" value={value} inherited={{ format: inherited }} onDone={done} onCancel={() => undefined} />)
  return done
}
/** The dialog on a field of a dataset, where nothing is followed. */
const onDataset = (value: NumberFormat | undefined) => {
  const done = vi.fn()
  render(<FormatDialog name="Revenue" value={value} onDone={done} onCancel={() => undefined} />)
  return done
}
const choose = (name: string) => fireEvent.click(screen.getByRole('radio', { name }))
const confirm = () => fireEvent.click(screen.getByRole('button', { name: 'OK' }))

describe('format dialog on a chart', () => {
  it('follows the dataset unless it says otherwise, and previews what that is', () => {
    const done = onChart(undefined, money)
    expect(screen.getByRole('radio', { name: 'Follow the dataset' }).getAttribute('aria-checked')).toBe('true')
    screen.getByText('¥1,234,567.89')
    confirm()
    expect(done).toHaveBeenCalledExactlyOnceWith(undefined)
  })

  it('starts a number from the dataset format', () => {
    const done = onChart(undefined, money)
    choose('Number')
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Prefix' }).value).toBe('¥')
    fireEvent.change(screen.getByRole('textbox', { name: 'Suffix' }), { target: { value: ' CNY' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Thousands separator' }))
    screen.getByText('¥1234567.89 CNY')
    confirm()
    expect(done).toHaveBeenCalledExactlyOnceWith({ decimals: 2, grouping: false, prefix: '¥', suffix: ' CNY' })
  })

  it('sets the dataset format aside with none', () => {
    const done = onChart(undefined, money)
    choose('None')
    screen.getByText('1234567.891', { selector: 'strong' })
    expect(screen.queryByRole('textbox', { name: 'Prefix' })).toBeNull()
    confirm()
    expect(done).toHaveBeenCalledExactlyOnceWith({ style: 'none' })
  })

  it('goes back to the dataset format', () => {
    const done = onChart({ unit: 'wan' }, money)
    expect(screen.getByRole('radio', { name: 'Number' }).getAttribute('aria-checked')).toBe('true')
    choose('Follow the dataset')
    confirm()
    expect(done).toHaveBeenCalledExactlyOnceWith(undefined)
  })
})

describe('format dialog on a dataset', () => {
  it('has nothing to follow, and saves none as no format', () => {
    const done = onDataset(undefined)
    expect(screen.queryByRole('radio', { name: 'Follow the dataset' })).toBeNull()
    expect(screen.getByRole('radio', { name: 'None' }).getAttribute('aria-checked')).toBe('true')
    confirm()
    expect(done).toHaveBeenCalledExactlyOnceWith(undefined)
  })

  it('shows a percentage without a unit', () => {
    const done = onDataset({ unit: 'wan' })
    screen.getByRole('combobox', { name: 'Unit' })
    choose('Percentage')
    expect(screen.queryByRole('combobox', { name: 'Unit' })).toBeNull()
    screen.getByText('23.45%')
    confirm()
    expect(done).toHaveBeenCalledExactlyOnceWith({ style: 'percent' })
  })

  it('takes no more than 16 characters before or after the number', () => {
    onDataset({})
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Prefix' }).maxLength).toBe(16)
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Suffix' }).maxLength).toBe(16)
  })
})

describe('cleanFormat', () => {
  it('leaves out what says the same as leaving it out', () => {
    expect(cleanFormat({ style: 'number', grouping: true, prefix: '', suffix: '' })).toEqual({})
    expect(cleanFormat({ style: 'percent', unit: 'wan', decimals: 0, grouping: false })).toEqual({ style: 'percent', decimals: 0, grouping: false })
    expect(cleanFormat({ style: 'none', unit: 'wan', prefix: '¥' })).toEqual({ style: 'none' })
  })
})

describe('format dialog of a date', () => {
  const dateDialog = (value: DateFormat | undefined, options: { inherited?: DateFormat; type?: 'date' | 'timestamp'; onChart?: boolean } = {}) => {
    const done = vi.fn()
    render(<FormatDialog name="Ordered" type={options.type ?? 'timestamp'} value={value} inherited={options.onChart ? { format: options.inherited } : undefined} onDone={done} onCancel={() => undefined} />)
    return done
  }
  const preview = () => within(screen.getByRole('region', { name: 'Preview' }))

  it('previews each grain, and saves nothing for the default writing on a dataset', () => {
    const done = dateDialog(undefined)
    expect(screen.getByRole('radio', { name: 'Dashes' }).getAttribute('aria-checked')).toBe('true')
    preview().getByText('2026 Q1')
    preview().getByText('2026-01')
    preview().getByText('2026-01-05 ~ 01-11')
    preview().getByText('2026-01-05 13:45:12')
    confirm()
    expect(done).toHaveBeenCalledExactlyOnceWith(undefined)
  })

  it('writes in Chinese, weeks by number and the time to the minute', async () => {
    const done = dateDialog(undefined)
    choose('Chinese')
    preview().getByText('2026年1月')
    openPopup(screen.getByRole('combobox', { name: 'Grouped by week' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Week number' }))
    preview().getByText('2026年第2周')
    screen.getByText('Counted by the workspace’s first-week setting')
    openPopup(screen.getByRole('combobox', { name: 'Time when not grouped' }))
    fireEvent.click(await screen.findByRole('option', { name: 'To the minute' }))
    preview().getByText('2026年1月5日 13:45')
    confirm()
    expect(done).toHaveBeenCalledExactlyOnceWith({ date: 'chinese', time: 'minute', week: 'number' })
  })

  it('has no time of day for a date', () => {
    dateDialog({ date: 'slash' }, { type: 'date' })
    expect(screen.queryByRole('combobox', { name: 'Time when not grouped' })).toBeNull()
    preview().getByText('2026/01/05')
    expect(preview().queryByText('Not grouped')).toBeNull()
  })

  it('follows the dataset on a chart, or sets it aside for the default writing', () => {
    const done = dateDialog(undefined, { onChart: true, inherited: { date: 'chinese' } })
    expect(screen.getByRole('radio', { name: 'Follow the dataset' }).getAttribute('aria-checked')).toBe('true')
    preview().getByText('2026年1月')
    expect(screen.queryByRole('combobox', { name: 'Grouped by week' })).toBeNull()
    choose('Dashes')
    confirm()
    expect(done).toHaveBeenCalledExactlyOnceWith({})
  })
})
