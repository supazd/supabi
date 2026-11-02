import { describe, expect, it } from 'vitest'
import { applyFormats, formatAxis, formatCategory, formatCell, formatDate, formatNumber, shiftDecimal, weekOfYear, type DateFormat } from './format'
import type { QueryResult, ResultColumn } from './result'

const measure = (type: ResultColumn['type'], format?: ResultColumn['format']): ResultColumn => ({ name: 'c', type, role: 'measure', format })
const dimension = (type: ResultColumn['type']): ResultColumn => ({ name: 'c', type, role: 'dimension' })

describe('formatCell without a format', () => {
  it('shows a number as it is, measure or dimension', () => {
    expect(formatCell(1234567, measure('integer'), 'zh-CN')).toBe('1234567')
    expect(formatCell(2026, dimension('integer'), 'zh-CN')).toBe('2026')
    expect(formatCell(1478.085, measure('float'), 'en-US')).toBe('1478.085')
  })

  it('keeps the digits of a decimal, which arrives as text', () => {
    expect(formatCell('233.8747201876710543', measure('decimal'), 'en-US')).toBe('233.8747201876710543')
    expect(formatCell('9999999999999.99', dimension('decimal'), 'en-US')).toBe('9999999999999.99')
    expect(formatCell('1854951.70', measure('decimal'), 'en-US')).toBe('1854951.70')
  })

  it('does not show the noise of floating point', () => {
    expect(formatCell(0.1 + 0.2, measure('float'), 'en-US')).toBe('0.3')
  })

  it('shows a dash for no value, and text as it is', () => {
    expect(formatCell(null, measure('integer'))).toBe('—')
    expect(formatCell('east', dimension('string'))).toBe('east')
  })

  it('shows none the same way, setting aside the rest', () => {
    expect(formatCell(1234567.5, measure('float', { style: 'none' }), 'en-US')).toBe('1234567.5')
  })
})

describe('formatNumber', () => {
  it('fixes the decimals', () => {
    expect(formatNumber(1234.5, { decimals: 2 }, 'en-US')).toBe('1,234.50')
    expect(formatNumber(1234.5, { decimals: 0 }, 'en-US')).toBe('1,235')
  })

  it('can leave thousands unseparated', () => {
    expect(formatNumber(1234567, { grouping: false }, 'en-US')).toBe('1234567')
  })

  it('writes separators the way the locale does', () => {
    expect(formatNumber(1234.5, { decimals: 1 }, 'de-DE')).toBe('1.234,5')
  })

  it('divides by a fixed unit and names it', () => {
    expect(formatNumber(1234567.891, { decimals: 2, unit: 'wan', prefix: '¥', suffix: '元' }, 'zh-CN')).toBe('¥123.46万元')
    expect(formatNumber(1234567, { decimals: 1, unit: 'yi' }, 'en-US')).toBe('0.0亿')
    expect(formatNumber(1234567, { unit: 'M' }, 'en-US')).toBe('1.23M')
    expect(formatNumber(1234567, { unit: 'K', decimals: 0 }, 'en-US')).toBe('1,235K')
    expect(formatNumber(3e9, { unit: 'B' }, 'en-US')).toBe('3B')
  })

  it('divides a decimal without losing digits', () => {
    expect(formatNumber('123456789012345678.99', { unit: 'yi', decimals: 2 }, 'en-US')).toBe('1,234,567,890.12亿')
  })

  it('picks a unit by the locale with auto', () => {
    expect(formatNumber(123456, { unit: 'auto' }, 'zh-CN')).toBe('12.35万')
    expect(formatNumber(123456, { unit: 'auto' }, 'en-US')).toBe('123.46K')
  })

  it('separates thousands and keeps two decimals at most, as a number', () => {
    expect(formatNumber(1478.085, { style: 'number' }, 'en-US')).toBe('1,478.09')
    expect(formatNumber(1234567, {}, 'en-US')).toBe('1,234,567')
  })

  it('shows a ratio as a percentage', () => {
    expect(formatNumber(0.2345, { style: 'percent' }, 'en-US')).toBe('23.45%')
    expect(formatNumber('0.07', { style: 'percent', decimals: 1 }, 'en-US')).toBe('7.0%')
  })

  it('puts the sign before the prefix', () => {
    expect(formatNumber(-1234, { prefix: '¥' }, 'en-US')).toBe('-¥1,234')
    expect(formatNumber('-0.001', { prefix: '¥', decimals: 2 }, 'en-US')).toBe('¥0.00')
  })
})

describe('formatAxis', () => {
  it('lets the ticks decide the decimals', () => {
    expect(formatAxis(2000, { decimals: 2, prefix: '¥' }, 'en-US')).toBe('¥2,000')
    expect(formatAxis(0.125, { style: 'percent', decimals: 0 }, 'en-US')).toBe('12.5%')
  })

  it('writes ticks plainly without a format, shortening large ones', () => {
    expect(formatAxis(2500000, undefined, 'en-US')).toBe('2.5M')
    expect(formatAxis(25000, undefined, 'en-US')).toBe('25000')
    expect(formatAxis(25000, { style: 'none' }, 'en-US')).toBe('25000')
  })
})

describe('shiftDecimal', () => {
  it('moves the point either way', () => {
    expect(shiftDecimal('1234.5', -4)).toBe('0.12345')
    expect(shiftDecimal('-0.5', 2)).toBe('-50')
    expect(shiftDecimal('12', 3)).toBe('12000')
    expect(shiftDecimal('.5', -1)).toBe('0.05')
  })
})

describe('applyFormats', () => {
  const result: QueryResult = {
    columns: [
      { name: 'region', type: 'string', role: 'dimension' },
      { name: 'revenue', type: 'decimal', role: 'measure', format: { prefix: '¥' } },
    ],
    rows: [],
  }

  it('replaces the dataset format whole', () => {
    const applied = applyFormats(result, { revenue: { unit: 'wan' } })
    expect(applied.columns[1]!.format).toEqual({ unit: 'wan' })
  })

  it('leaves text columns and unchanged results alone', () => {
    expect(applyFormats(result, { region: { unit: 'wan' } }).columns[0]!.format).toBeUndefined()
    expect(applyFormats(result, undefined)).toBe(result)
  })

  it('puts a format on a date too', () => {
    const dated: QueryResult = { columns: [{ name: 'month', type: 'timestamp', role: 'dimension', grain: 'month' }], rows: [] }
    expect(applyFormats(dated, { month: { date: 'chinese' } }).columns[0]!.format).toEqual({ date: 'chinese' })
  })
})

describe('formatDate', () => {
  const timestamp = (grain?: ResultColumn['grain'], format?: DateFormat) => ({ type: 'timestamp' as const, grain, format })
  const date = (grain?: ResultColumn['grain'], format?: DateFormat) => ({ type: 'date' as const, grain, format })

  it('writes a date to its grain, so a month is not its first day', () => {
    const at = '2026-01-01T00:00:00'
    expect(formatDate(at, timestamp('year'))).toBe('2026')
    expect(formatDate('2026-04-01T00:00:00', timestamp('quarter'))).toBe('2026 Q2')
    expect(formatDate(at, timestamp('month'))).toBe('2026-01')
    expect(formatDate(at, timestamp('day'))).toBe('2026-01-01')
    expect(formatDate('2026-01-05T13:00:00', timestamp('hour'))).toBe('2026-01-05 13:00')
    expect(formatDate('2026-01-05T13:45:00', timestamp('minute'))).toBe('2026-01-05 13:45')
    expect(formatDate('2026-03-01', date('month'))).toBe('2026-03')
  })

  it('writes a value not grouped by a grain whole, a timestamp to the second', () => {
    expect(formatDate('2026-01-05', date())).toBe('2026-01-05')
    expect(formatDate('2026-01-05T13:45:12', timestamp())).toBe('2026-01-05 13:45:12')
    expect(formatDate('2026-01-05T00:00:00', timestamp())).toBe('2026-01-05 00:00:00')
  })

  it('writes with slashes or in Chinese', () => {
    const at = '2026-01-05T13:45:12'
    expect(formatDate(at, timestamp('month', { date: 'slash' }))).toBe('2026/01')
    expect(formatDate(at, timestamp('day', { date: 'slash' }))).toBe('2026/01/05')
    expect(formatDate(at, timestamp(undefined, { date: 'slash' }))).toBe('2026/01/05 13:45:12')
    expect(formatDate(at, timestamp('year', { date: 'chinese' }))).toBe('2026年')
    expect(formatDate(at, timestamp('quarter', { date: 'chinese' }))).toBe('2026年第1季度')
    expect(formatDate(at, timestamp('month', { date: 'chinese' }))).toBe('2026年1月')
    expect(formatDate(at, timestamp('day', { date: 'chinese' }))).toBe('2026年1月5日')
    expect(formatDate(at, timestamp('hour', { date: 'chinese' }))).toBe('2026年1月5日 13:00')
  })

  it('shows as much of the time of day as the format says, when there is no grain', () => {
    const at = '2026-01-05T13:45:12'
    expect(formatDate(at, timestamp(undefined, { time: 'minute' }))).toBe('2026-01-05 13:45')
    expect(formatDate(at, timestamp(undefined, { time: 'none' }))).toBe('2026-01-05')
    // A grain says how much, whatever the time setting.
    expect(formatDate(at, timestamp('hour', { time: 'none' }))).toBe('2026-01-05 13:00')
    expect(formatDate('2026-01-05', date(undefined, { time: 'minute' }))).toBe('2026-01-05')
  })

  it('writes a week as its first and last days, its first day or its number', () => {
    expect(formatDate('2026-01-05', date('week'))).toBe('2026-01-05 ~ 01-11')
    expect(formatDate('2026-01-26T00:00:00', timestamp('week'))).toBe('2026-01-26 ~ 02-01')
    expect(formatDate('2025-12-29', date('week'))).toBe('2025-12-29 ~ 2026-01-04')
    expect(formatDate('2026-01-05', date('week', { date: 'slash' }))).toBe('2026/01/05 ~ 01/11')
    expect(formatDate('2026-01-05', date('week', { date: 'chinese' }))).toBe('2026年1月5日 ~ 1月11日')
    expect(formatDate('2025-12-29', date('week', { date: 'chinese' }))).toBe('2025年12月29日 ~ 2026年1月4日')
    expect(formatDate('2026-01-05', date('week', { week: 'start' }))).toBe('2026-01-05')
    expect(formatDate('2026-01-05', date('week', { week: 'number' }))).toBe('2026-W02')
    expect(formatDate('2026-01-05', date('week', { week: 'number', date: 'slash' }))).toBe('2026/W02')
    expect(formatDate('2026-01-05', date('week', { week: 'number', date: 'chinese' }))).toBe('2026年第2周')
  })

  it('numbers a week in the year it counts in, by the first-week rule', () => {
    const number = { week: 'number' as const }
    // 1 January 2026 is a Thursday: four days of that week are in 2026.
    expect(formatDate('2025-12-29', date('week', number), 4)).toBe('2026-W01')
    expect(formatDate('2025-12-29', date('week', number), 1)).toBe('2026-W01')
    expect(formatDate('2025-12-29', date('week', number), 7)).toBe('2025-W52')
    expect(formatDate('2026-01-05', date('week', number), 7)).toBe('2026-W01')
    // 1 January 2027 is a Friday: three days of that week are in 2027.
    expect(formatDate('2026-12-28', date('week', number), 4)).toBe('2026-W53')
    expect(formatDate('2026-12-28', date('week', number), 1)).toBe('2027-W01')
    expect(formatDate('2027-01-04', date('week', number), 7)).toBe('2027-W01')
  })

  it('leaves what is not a date as it is', () => {
    expect(formatDate('soon', timestamp('month'))).toBe('soon')
  })
})

describe('weekOfYear', () => {
  it('counts weeks starting on Sunday from their first day', () => {
    // Sunday 28 December 2025 starts the week of 1 January.
    expect(weekOfYear(2025, 12, 28, 1)).toEqual([2026, 1])
    // Only three of its days are in 2026.
    expect(weekOfYear(2025, 12, 28, 4)).toEqual([2025, 53])
    expect(weekOfYear(2025, 12, 28, 7)).toEqual([2025, 52])
    expect(weekOfYear(2026, 1, 4, 7)).toEqual([2026, 1])
  })

  it('agrees with ISO 8601 for weeks starting on Monday', () => {
    expect(weekOfYear(2020, 12, 28, 4)).toEqual([2020, 53])
    expect(weekOfYear(2021, 1, 4, 4)).toEqual([2021, 1])
    expect(weekOfYear(2024, 12, 30, 4)).toEqual([2025, 1])
    expect(weekOfYear(2026, 6, 29, 4)).toEqual([2026, 27])
  })
})

describe('formatCell and formatCategory with dates', () => {
  it('writes a date column the way its format says', () => {
    const month: ResultColumn = { name: 'm', type: 'timestamp', role: 'dimension', grain: 'month', format: { date: 'chinese' } }
    expect(formatCell('2026-01-01T00:00:00', month)).toBe('2026年1月')
    expect(formatCategory('2026-01-01T00:00:00', month)).toBe('2026年1月')
    expect(formatCategory(null, month)).toBe('—')
  })

  it('numbers weeks as the workspace counts them', () => {
    const week: ResultColumn = { name: 'w', type: 'date', role: 'dimension', grain: 'week', format: { week: 'number' } }
    expect(formatCell('2025-12-29', week, 'zh-CN', 7)).toBe('2025-W52')
    expect(formatCategory('2025-12-29', week, 7)).toBe('2025-W52')
  })

  it('names a number category as it is', () => {
    expect(formatCategory(2026, { name: 'y', type: 'integer', role: 'dimension', format: { unit: 'K' } })).toBe('2026')
  })
})
