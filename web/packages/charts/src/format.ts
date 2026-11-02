// How numbers and dates are written for people to read. See .agents/design/dataset.md §5.5.
import type { Cell, QueryResult, ResultColumn } from './result'

export interface NumberFormat {
  /**
   * None shows the number as it is, and goes with nothing else; a number is
   * meant when this is left out; a percent shows a ratio as a percentage, 0.25
   * as 25%. A column without a format is shown as with none.
   */
  style?: NumberStyle
  /** A fixed number of decimal places. Without it, up to two are shown and trailing zeros are left out. */
  decimals?: number
  /** Whether thousands are separated. They are unless this is false. */
  grouping?: boolean
  /** Divides the number before it is shown. Auto picks a unit for each value by the locale. */
  unit?: NumberUnit
  prefix?: string
  suffix?: string
}

export type NumberStyle = 'none' | 'number' | 'percent'

export const numberStyles: NumberStyle[] = ['none', 'number', 'percent']

export type NumberUnit = 'auto' | 'K' | 'wan' | 'M' | 'yi' | 'B'

/** In order of size, the two systems interleaved. */
export const numberUnits: NumberUnit[] = ['auto', 'K', 'wan', 'M', 'yi', 'B']

/** Powers of ten each fixed unit divides by, and how it is written. */
const fixedUnits: Record<Exclude<NumberUnit, 'auto'>, { exponent: number; symbol: string }> = {
  K: { exponent: 3, symbol: 'K' },
  wan: { exponent: 4, symbol: '万' },
  M: { exponent: 6, symbol: 'M' },
  yi: { exponent: 8, symbol: '亿' },
  B: { exponent: 9, symbol: 'B' },
}

/** How a date is written; how much of it, the grain says. A date has no "none": a month's first day says nothing of the month. */
export interface DateFormat {
  /** 2026-01-05, 2026/01/05 or 2026年1月5日. Dash when left out. */
  date?: DateStyle
  /** How much of the time of day a timestamp not grouped by a grain shows. Second when left out. */
  time?: TimeStyle
  /** A week as its first and last days, its first day or its number in the year. Range when left out. */
  week?: WeekStyle
}

export type DateStyle = 'dash' | 'slash' | 'chinese'
export type TimeStyle = 'second' | 'minute' | 'none'
export type WeekStyle = 'range' | 'start' | 'number'

export const dateStyles: DateStyle[] = ['dash', 'slash', 'chinese']
export const timeStyles: TimeStyle[] = ['second', 'minute', 'none']
export const weekStyles: WeekStyle[] = ['range', 'start', 'number']

/** A column's format: a number takes the number properties, a date the date properties. */
export interface DisplayFormat extends NumberFormat, DateFormat {}

export const isNumeric = (column: Pick<ResultColumn, 'type'>) => column.type === 'integer' || column.type === 'decimal' || column.type === 'float'
export const isTemporal = (column: Pick<ResultColumn, 'type'>) => column.type === 'date' || column.type === 'timestamp'

/**
 * Moves the decimal point of a number written in decimal. Decimals arrive as
 * text so they keep every digit; dividing them as floating point would not.
 */
export function shiftDecimal(value: string, by: number): string {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(value.trim())
  if (!match || !(match[2] || match[3])) return String(Number(value) * 10 ** by)
  const [, sign, whole = '', fraction = ''] = match
  let digits = whole + fraction
  let point = whole.length + by
  if (point < 0) {
    digits = '0'.repeat(-point) + digits
    point = 0
  }
  if (point > digits.length) digits += '0'.repeat(point - digits.length)
  const integer = digits.slice(0, point).replace(/^0+(?=\d)/, '') || '0'
  const rest = digits.slice(point)
  return sign + integer + (rest ? '.' + rest : '')
}

function scaled(value: number | string, exponent: number): number | string {
  return typeof value === 'string' ? shiftDecimal(value, exponent) : value * 10 ** exponent
}

/** Whether a format leaves the number as it is: none, or no format at all. */
export const isPlain = (format: NumberFormat | undefined): boolean => !format || format.style === 'none'

/**
 * A number as the query returned it: no separators, no unit, no rounding. A
 * decimal arrives as text and is shown as it came, trailing zeros and all; a
 * floating-point number is cut to the digits it holds, so 0.1 + 0.2 is not
 * shown as 0.30000000000000004.
 */
function plain(value: number | string, locale: string | undefined): string {
  if (typeof value === 'string') return value
  const digits = Number.isInteger(value) ? { maximumFractionDigits: 0 } : { maximumSignificantDigits: 15 }
  return new Intl.NumberFormat(locale, { ...digits, useGrouping: false, signDisplay: 'negative' }).format(value)
}

/** Formats a number. Without a format, or with none, it is shown as it is. */
export function formatNumber(value: number | string, format: NumberFormat | undefined, locale: string | undefined): string {
  if (!format || format.style === 'none') return plain(value, locale)
  const fixed = format.unit && format.unit !== 'auto' && format.style !== 'percent' ? fixedUnits[format.unit] : undefined
  const intl = new Intl.NumberFormat(locale, {
    style: format.style === 'percent' ? 'percent' : 'decimal',
    notation: format.unit === 'auto' && format.style !== 'percent' ? 'compact' : 'standard',
    minimumFractionDigits: format.decimals ?? 0,
    maximumFractionDigits: format.decimals ?? 2,
    useGrouping: format.grouping ?? true,
    signDisplay: 'negative',
  })
  // Intl takes decimal strings as exact numbers; its types only say number.
  const parts = intl.formatToParts((fixed ? scaled(value, -fixed.exponent) : value) as number)
  // The sign goes before the prefix: -¥1,234, not ¥-1,234.
  const sign = parts.filter((part) => part.type === 'minusSign').map((part) => part.value).join('')
  const body = parts.filter((part) => part.type !== 'minusSign').map((part) => part.value).join('')
  return sign + (format.prefix ?? '') + body + (fixed?.symbol ?? '') + (format.suffix ?? '')
}

/**
 * Formats a tick of a value axis. The ticks decide the decimals, up to two;
 * the rest of the format applies as it is. Without a format, a tick is
 * written plainly, and a large one is shortened so the labels fit.
 */
export function formatAxis(value: number, format: NumberFormat | undefined, locale: string | undefined): string {
  if (!isPlain(format)) return formatNumber(value, { ...format, decimals: undefined }, locale)
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2, useGrouping: false, notation: Math.abs(value) >= 1e6 ? 'compact' : 'standard' }).format(value)
}

const pad = (n: number) => String(n).padStart(2, '0')

const dayMs = 86_400_000

/** The days since 1970-01-01 of a calendar date; there are no time zones in it. */
const dayNumber = (year: number, month: number, day: number) => Date.UTC(year, month - 1, day) / dayMs

function calendarDate(days: number): [number, number, number] {
  const date = new Date(days * dayMs)
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()]
}

/** The first day of week 1 of a year, for weeks that start where `aligned`, one of their first days, does. */
function firstWeek(year: number, aligned: number, firstWeekDays: number): number {
  const january1 = dayNumber(year, 1, 1)
  const start = january1 - ((((january1 - aligned) % 7) + 7) % 7)
  return 7 - (january1 - start) >= firstWeekDays ? start : start + 7
}

/**
 * The year a week counts in and its number there, from its first day. Week 1
 * is the first with at least `firstWeekDays` of its days in the year; the days
 * before it are in the last week of the year before. That year is not always
 * the year of the first day: 2025-12-29 begins week 1 of 2026 by ISO 8601.
 */
export function weekOfYear(year: number, month: number, day: number, firstWeekDays: number): [number, number] {
  const days = dayNumber(year, month, day)
  const [endYear] = calendarDate(days + 6)
  const counted = days >= firstWeek(endYear, days, firstWeekDays) ? endYear : endYear - 1
  return [counted, (days - firstWeek(counted, days, firstWeekDays)) / 7 + 1]
}

function writeDay(year: number, month: number, day: number, style: DateStyle): string {
  if (style === 'chinese') return `${year}年${month}月${day}日`
  const sep = style === 'slash' ? '/' : '-'
  return `${year}${sep}${pad(month)}${sep}${pad(day)}`
}

function writeWeek(year: number, month: number, day: number, style: DateStyle, week: WeekStyle, firstWeekDays: number): string {
  if (week === 'start') return writeDay(year, month, day, style)
  if (week === 'number') {
    const [counted, n] = weekOfYear(year, month, day, firstWeekDays)
    return style === 'chinese' ? `${counted}年第${n}周` : `${counted}${style === 'slash' ? '/' : '-'}W${pad(n)}`
  }
  const [endYear, endMonth, endDay] = calendarDate(dayNumber(year, month, day) + 6)
  // The end says its month always, and its year when the week crosses into another.
  const end =
    endYear !== year ? writeDay(endYear, endMonth, endDay, style)
    : style === 'chinese' ? `${endMonth}月${endDay}日`
    : `${pad(endMonth)}${style === 'slash' ? '/' : '-'}${pad(endDay)}`
  return `${writeDay(year, month, day, style)} ~ ${end}`
}

const dateValue = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/

/**
 * Writes a date or a timestamp as its format says, to the grain it was
 * truncated to: the first day of a month stands for the month. Times arrive
 * in the query's time zone and are written as they came. The writing is the
 * same in every language, as 万 and 亿 are.
 */
export function formatDate(value: string, column: Pick<ResultColumn, 'type' | 'format' | 'grain'>, firstWeekDays = 4): string {
  const match = dateValue.exec(value)
  if (!match) return value.replace('T', ' ')
  const [year = 0, month = 1, day = 1, hour = 0, minute = 0, second = 0] = match.slice(1).map((part) => Number(part ?? 0))
  const style = column.format?.date ?? 'dash'
  const sep = style === 'slash' ? '/' : '-'
  const time = (parts: number[]) => parts.map(pad).join(':')
  switch (column.grain) {
    case 'year':
      return style === 'chinese' ? `${year}年` : String(year)
    case 'quarter': {
      const quarter = Math.floor((month - 1) / 3) + 1
      return style === 'chinese' ? `${year}年第${quarter}季度` : `${year} Q${quarter}`
    }
    case 'month':
      return style === 'chinese' ? `${year}年${month}月` : `${year}${sep}${pad(month)}`
    case 'week':
      return writeWeek(year, month, day, style, column.format?.week ?? 'range', firstWeekDays)
    case 'day':
      return writeDay(year, month, day, style)
    case 'hour':
      return `${writeDay(year, month, day, style)} ${time([hour, 0])}`
    case 'minute':
      return `${writeDay(year, month, day, style)} ${time([hour, minute])}`
  }
  if (column.type === 'date') return writeDay(year, month, day, style)
  const shown = column.format?.time ?? 'second'
  if (shown === 'none') return writeDay(year, month, day, style)
  return `${writeDay(year, month, day, style)} ${time(shown === 'minute' ? [hour, minute] : [hour, minute, second])}`
}

/**
 * Formats a cell for reading. Decimals arrive as strings and are formatted as
 * such, keeping every digit; dates are written to their grain.
 */
export function formatCell(value: Cell | undefined, column: ResultColumn, locale?: string, firstWeekDays?: number): string {
  if (value === null || value === undefined) return '—'
  if (isNumeric(column) && typeof value !== 'boolean') return formatNumber(value, column.format, locale)
  if (isTemporal(column) && typeof value === 'string') return formatDate(value, column, firstWeekDays)
  return String(value)
}

/**
 * Names a category on an axis, in a legend or a tooltip. Numbers are named as
 * they are, without their format; dates are written as in a table.
 */
export function formatCategory(value: Cell | undefined, column: ResultColumn | undefined, firstWeekDays?: number): string {
  if (value === null || value === undefined) return '—'
  if (column && isTemporal(column) && typeof value === 'string') return formatDate(value, column, firstWeekDays)
  return String(value)
}

/**
 * The result with a chart's own formats in place of the dataset's, on the
 * columns they name and only where they fit: a date's format on dates, a
 * number's on numbers. A drilled column can come back as another type.
 */
export function applyFormats<R extends Pick<QueryResult, 'columns'>>(result: R, formats: Record<string, DisplayFormat> | undefined): R {
  if (!formats || !result.columns.some((column) => formats[column.name])) return result
  const fits = (format: DisplayFormat, column: ResultColumn) => {
    const date = 'date' in format || 'time' in format || 'week' in format
    return date ? isTemporal(column) : isNumeric(column)
  }
  return { ...result, columns: result.columns.map((column) => {
    const format = formats[column.name]
    return format && fits(format, column) ? { ...column, format } : column
  }) }
}
