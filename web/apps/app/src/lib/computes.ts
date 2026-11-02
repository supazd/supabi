import type { TFunction } from 'i18next'
import type { Aggregation } from '../api/spec'
import type { CompareCompute, MeasureCompute } from './builder'
import type { TimeValue } from './filters'

export function computeName(name: string, compute: MeasureCompute | undefined, t: TFunction): string {
  if (!compute) return name
  if (compute.type === 'percent_of_total') return t('compute.label', { name })
  if (compute.type === 'cumulative') return t('compute.cumulativeLabel', { name })
  return comparisonName(name, compute, t)
}

/**
 * Whether a measure aggregated this way can run: only these carry from one
 * group's value to the next (.agents/design/query-ir.md §3.5). A metric of the
 * dataset has no aggregation of its own and cannot.
 */
export const accumulates = (agg: Aggregation | undefined): boolean => agg === 'sum' || agg === 'count' || agg === 'min' || agg === 'max'

export function comparisonName(name: string, comparison: Pick<CompareCompute, 'offset' | 'output'>, t: TFunction): string {
  const period = comparison.offset.n === 1 && comparison.offset.unit === 'year' ? t('compute.yoy') : t('compute.previous', { n: comparison.offset.n, unit: t(`compute.units.${comparison.offset.unit}`) })
  return t('compute.comparisonLabel', { name, period, output: t(`compute.outputs.${comparison.output}`) })
}

export const percentCompute = (compute: MeasureCompute | undefined): boolean => compute?.type === 'percent_of_total' || compute?.type === 'compare' && compute.output === 'ratio'
export const finiteTime = (value: TimeValue): boolean => !value.includeNull && !value.special && Boolean(value.last || value.current || value.start && value.end || value.bounds?.start && value.bounds?.end)
