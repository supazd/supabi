import type { Aggregation } from '../api/spec'

/** Each aggregation by its function name, short enough to mark it in a list. */
export const aggCodes: Record<Aggregation, string> = { sum: 'SUM', avg: 'AVG', min: 'MIN', max: 'MAX', count: 'COUNT', count_distinct: 'COUNTD' }

/** A column aggregated, named as a formula would name it, the same in every language: SUM(Amount). */
export function aggLabel(agg: string, name: string): string {
  return agg === 'count_distinct' ? `COUNT(DISTINCT ${name})` : `${agg.toUpperCase()}(${name})`
}
