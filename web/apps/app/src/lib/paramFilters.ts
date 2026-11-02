// Filters that give a dataset parameter its value, where other filters
// restrict a field (.agents/design/chart-dashboard.md 2.11). The server owns the
// rules (internal/content/param.go); what is here mirrors them, so that the
// editor offers only what will be accepted and draws a chart's controls the
// way its viewers see them.
import type { TFunction } from 'i18next'
import type { ParamControl } from '../api/client'
import { makeKey } from '../api/spec'
import type { ChartFilter } from './filters'
import { parse, withoutText, type SqlParam } from './params'

export type ParamControlType = 'input' | 'select'

export interface ParamFilter {
  id: string
  param: string
  /** What viewers start with. Left out, the dataset's default; null or an empty list, no value. */
  value?: unknown
  /** What a dropdown offers, besides its default. */
  options?: unknown[]
  label?: string
  /** How viewers set the value: typed in or picked. Without it the value is fixed. */
  control?: { type: ParamControlType }
}

export const isParamFilter = (filter: object): filter is ParamFilter => typeof (filter as { param?: unknown }).param === 'string'
export const isFieldFilter = (filter: ChartFilter | ParamFilter): filter is ChartFilter => !isParamFilter(filter)

/** The most values a dropdown offers, as many as a field filter lists. */
export const maxParamOptions = 500

/** Whether the filter has a default of its own, rather than following the dataset's. */
export const ownsDefault = (filter: ParamFilter) => filter.value !== undefined

/** The value the filter starts with. */
export const paramDefault = (filter: ParamFilter, param: Pick<SqlParam, 'default'> | undefined): unknown => (ownsDefault(filter) ? filter.value : param?.default)

/** The values in a parameter's value: those of a list, or the value itself. Null gives none. */
export function paramItems(value: unknown): unknown[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

const keyOf = (value: unknown) => JSON.stringify(value)
export const sameParamValue = (left: unknown, right: unknown) => keyOf(left ?? null) === keyOf(right ?? null)

/** What a dropdown offers: the default's values the author did not list, then the author's. */
export function paramOptions(filter: ParamFilter, param: SqlParam): unknown[] {
  if (param.type === 'boolean') return [true, false]
  const listed = new Set((filter.options ?? []).map(keyOf))
  const missing = paramItems(paramDefault(filter, param)).filter((value) => {
    if (listed.has(keyOf(value))) return false
    listed.add(keyOf(value))
    return true
  })
  return [...missing, ...(filter.options ?? [])]
}

/**
 * The parameters the SQL cannot run without, as ParamsRequiringInput finds
 * them on the server: those required, and those written outside [[ ]].
 */
export function paramsNeedingValue(sql: string | undefined, params: SqlParam[]): Set<string> {
  const out = new Set(params.filter((param) => param.required).map((param) => param.name))
  const plain = withoutText(sql ?? '')
  let outside = ''
  let depth = 0
  for (let i = 0; i < plain.length; i++) {
    if (plain.startsWith('[[', i)) {
      depth++
      outside += '  '
      i++
    } else if (depth > 0 && plain.startsWith(']]', i)) {
      depth--
      outside += '  '
      i++
    } else outside += depth > 0 ? ' ' : plain[i]
  }
  for (const match of outside.matchAll(/\{\{([^{}]*)\}\}/g)) out.add(match[1]!.trim())
  return out
}

/** What showing the filter takes from its dataset, worked out as the server works it out for viewers. */
export function paramControl(filter: ParamFilter, param: SqlParam, needsValue: boolean): ParamControl {
  const value = paramDefault(filter, param)
  return {
    type: param.type,
    ...(param.multi ? { multi: true } : {}),
    ...(needsValue ? { needsValue: true } : {}),
    ...(value !== undefined && value !== null ? { default: value } : {}),
    ...(filter.control?.type === 'select' ? { options: paramOptions(filter, param) } : {}),
  }
}

type Relative = { relative: string }
export const isRelative = (value: unknown): value is Relative => typeof value === 'object' && value !== null && typeof (value as { relative?: unknown }).relative === 'string'
const relativeDay = /^today(?:([+-])(\d+)d)?$/

/**
 * The day a relative day is now, as year, month and day, taking today to be
 * what it is in the time zone queries use, as the server does; in the
 * browser's own without one. Undefined when it is not a relative day.
 */
function relativeDate(expr: string, timeZone: string | undefined, now: Date): [number, number, number] | undefined {
  const match = relativeDay.exec(expr.replaceAll(' ', ''))
  if (!match) return undefined
  let today = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
  if (timeZone) {
    try {
      today = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now).split('-').map(Number)
    } catch {
      // A zone the browser does not know: its own day is the best guess.
    }
  }
  const day = new Date(Date.UTC(today[0]!, today[1]! - 1, today[2]! + (match[1] ? Number(`${match[1]}${match[2]}`) : 0)))
  return [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()]
}
const two = (n: number) => String(n).padStart(2, '0')

/** A day relative to today as a dropdown shows it: what it is called, and which day that is now. */
export function relativeDayLabel(expr: string, t: TFunction, timeZone?: string, now = new Date()): string {
  const date = relativeDate(expr, timeZone, now)
  if (!date) return expr
  const match = relativeDay.exec(expr.replaceAll(' ', ''))!
  const days = match[1] ? Number(`${match[1]}${match[2]}`) : 0
  const name = days === 0 ? t('params.filter.today') : days === -1 ? t('params.filter.yesterday') : days === 1 ? t('params.filter.tomorrow') : days < 0 ? t('params.filter.daysAgo', { count: -days }) : t('params.filter.daysLater', { count: days })
  return t('params.filter.relativeDay', { name, date: `${two(date[1])}-${two(date[2])}` })
}

/** The day a relative day is now, as YYYY-MM-DD, or undefined when it is not one. */
export function relativeDayValue(expr: string, timeZone?: string, now = new Date()): string | undefined {
  const date = relativeDate(expr, timeZone, now)
  return date && `${date[0]}-${two(date[1])}-${two(date[2])}`
}

/** How one value of a parameter reads. */
export function paramValueLabel(value: unknown, t: TFunction, timeZone?: string): string {
  if (typeof value === 'boolean') return t(value ? 'params.filter.true' : 'params.filter.false')
  if (isRelative(value)) return relativeDayLabel(value.relative, t, timeZone)
  return String(value)
}

/** How a whole value reads: its items, or that it has none. */
export function paramValueSummary(value: unknown, t: TFunction, timeZone?: string): string {
  const items = paramItems(value)
  if (!items.length) return t('filter.any')
  const labels = items.map((item) => paramValueLabel(item, t, timeZone))
  return labels.length > 3 ? t('filter.manyValues', { first: labels.slice(0, 3).join(t('filter.separator')), count: labels.length }) : labels.join(t('filter.separator'))
}

/** One value as the author types it: a relative day as it is written. */
export const paramValueText = (value: unknown): string => (isRelative(value) ? value.relative : value === undefined || value === null ? '' : String(value))

/**
 * What was typed, as a value of the parameter, or undefined when it is not
 * one. Several values are separated by commas. Nothing typed is no value.
 */
export function parseParamText(text: string, param: Pick<SqlParam, 'type' | 'multi'>, relative = true): unknown {
  const one = (item: string) => {
    const value = parse(item.trim(), param.type)
    return !relative && isRelative(value) ? undefined : value
  }
  if (!param.multi) return text.trim() ? one(text) : null
  const items = text.split(',').map((item) => item.trim()).filter(Boolean).map(one)
  return items.includes(undefined) ? undefined : items
}

/** Whether a value fits the parameter: of its type, and a list when it takes several. */
export function fitsParam(value: unknown, param: Pick<SqlParam, 'type' | 'multi'>): boolean {
  if (value === undefined || value === null) return true
  if (Array.isArray(value) !== Boolean(param.multi)) return false
  return paramItems(value).every((item) => {
    if (isRelative(item)) return param.type === 'date' && relativeDay.test(item.relative.replaceAll(' ', ''))
    if (typeof item === 'object') return false
    // A decimal may come as a number, as the server takes it, or as text that keeps its digits.
    if (typeof item === 'number') return param.type === 'integer' ? Number.isSafeInteger(item) : (param.type === 'decimal' || param.type === 'float') && Number.isFinite(item)
    return keyOf(parse(paramValueText(item), param.type)) === keyOf(item)
  })
}

export type ParamFilterProblem = 'missingParam' | 'typeChanged' | 'needsLabel' | 'needsValue' | 'needsDefault'

/** Why the filter cannot be saved as it is, if anything. */
export function paramFilterProblem(filter: ParamFilter, param: SqlParam | undefined, needsValue: boolean): ParamFilterProblem | undefined {
  if (!param) return 'missingParam'
  const single = { type: param.type }
  if (!fitsParam(filter.value, param) || (filter.options ?? []).some((option) => option === null || !fitsParam(option, single))) return 'typeChanged'
  if (!filter.control) return paramItems(filter.value).length ? undefined : 'needsValue'
  if (!filter.label?.trim()) return 'needsLabel'
  if (needsValue && !paramItems(paramDefault(filter, param)).length) return 'needsDefault'
  return undefined
}

/** A new filter for a parameter, fixed to the dataset's default until it is set. */
export function newParamFilter(param: SqlParam, taken: Set<string>): ParamFilter {
  return { id: makeKey(`p_${param.name}`, taken), param: param.name, label: param.label || param.name, control: { type: param.type === 'boolean' ? 'select' : 'input' } }
}

/** The filter as it is written to the chart: nothing that says nothing. */
export function cleanParamFilter(filter: ParamFilter): ParamFilter {
  const out: ParamFilter = { id: filter.id, param: filter.param }
  if (ownsDefault(filter)) out.value = filter.value
  if (filter.control) {
    out.label = filter.label ?? ''
    out.control = { type: filter.control.type }
    if (filter.control.type === 'select' && filter.options?.length) out.options = [...filter.options]
  }
  return out
}

/** The query with the parameters of the chart's parameter filters given their values: chosen, else the filter's own (withParams). */
export function withParamValues(query: Record<string, unknown>, filters: ParamFilter[], values: Record<string, unknown>): Record<string, unknown> {
  const params = { ...(query.params as Record<string, unknown> | undefined) }
  let given = false
  for (const filter of filters) {
    const value = filter.id in values ? values[filter.id] : filter.value
    if (value === undefined) continue
    params[filter.param] = value
    given = true
  }
  return given ? { ...query, params } : query
}

/** The parameters of a dataset spec. */
export const datasetParams = (spec: { params?: unknown } | undefined): SqlParam[] => (Array.isArray(spec?.params) ? (spec.params as SqlParam[]) : [])
