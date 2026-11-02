import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MonthRangeCalendar, WeekRangeCalendar } from './DateInput'

afterEach(cleanup)

describe('MonthRangeCalendar', () => {
  it('picks a month, then ends the run at the second, either way round', () => {
    const change = vi.fn()
    render(<MonthRangeCalendar value={['2026-01', '2026-01']} onChange={change} />)
    fireEvent.click(screen.getByRole('button', { name: 'May 2026' }))
    expect(change).toHaveBeenLastCalledWith(['2026-05', '2026-05'])
    fireEvent.click(screen.getByRole('button', { name: 'February 2026' }))
    expect(change).toHaveBeenLastCalledWith(['2026-02', '2026-05'])
  })

  it('shows the run it holds and moves a year at a time', () => {
    render(<MonthRangeCalendar value={['2026-02', '2026-04']} onChange={() => {}} />)
    expect(screen.getByRole('button', { name: 'March 2026' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'May 2026' }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'Next year' }))
    expect(screen.queryByRole('button', { name: 'March 2026' })).toBeNull()
    expect(screen.getByRole('button', { name: 'March 2028' })).toBeTruthy()
  })
})

describe('WeekRangeCalendar', () => {
  const day = (name: RegExp) => screen.getAllByRole('button').find((button) => name.test(button.getAttribute('aria-label') ?? ''))!

  it('picks whole weeks starting on the day it is given', () => {
    const change = vi.fn()
    // Tuesday to Monday weeks.
    render(<WeekRangeCalendar value={['2026-10-13', '2026-10-19']} weekStart={2} onChange={change} />)
    fireEvent.click(day(/October 16(th)?, 2026/))
    expect(change).toHaveBeenLastCalledWith(['2026-10-13', '2026-10-19'])
    fireEvent.click(day(/October 29(th)?, 2026/))
    expect(change).toHaveBeenLastCalledWith(['2026-10-13', '2026-11-02'])
  })

  it('ends the run at the first week when the second is earlier', () => {
    const change = vi.fn()
    render(<WeekRangeCalendar value={['2026-10-12', '2026-10-18']} weekStart={1} onChange={change} />)
    fireEvent.click(day(/October 21(st)?, 2026/))
    fireEvent.click(day(/October 7(th)?, 2026/))
    expect(change).toHaveBeenLastCalledWith(['2026-10-05', '2026-10-25'])
  })
})
