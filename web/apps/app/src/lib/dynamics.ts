import { useState } from 'react'
import { aggregations, aggsFor, isTemporal, type Aggregation, type SpecField } from '../api/spec'
import type { ChartSpec, Grain, MeasureCompute } from './builder'

export interface DynamicOption {
  id: string
  field: string
  label?: string
  agg?: Aggregation
  grain?: Grain
}

/** A stable output column whose source is chosen by the chart's reader. */
export interface DynamicField {
  id: string
  kind: 'dimension' | 'measure'
  label: string
  alias: string
  options: DynamicOption[]
  allowEmpty?: boolean
}

export type DynamicSelections = Record<string, string>
export const dynamicLimits = { fields: 16, options: 64 } as const

export function dynamicSelection(dynamic: DynamicField, values: DynamicSelections): string {
  const value = values[dynamic.id]
  if (value === '' && dynamic.kind === 'dimension' && dynamic.allowEmpty) return ''
  return dynamic.options.some((option) => option.id === value) ? value! : dynamic.options[0]?.id ?? ''
}

/** Query columns keep their identity when the selected field or aggregation changes. */
export function dynamicColumn(dynamic: DynamicField, option: DynamicOption, compute?: MeasureCompute): Record<string, unknown> {
  return {
    alias: dynamic.alias,
    field: option.field,
    ...(dynamic.kind === 'measure' && option.agg ? { agg: option.agg } : {}),
    ...(dynamic.kind === 'dimension' && option.grain ? { grain: option.grain } : {}),
    ...(option.label ? compute ? { baseLabel: option.label } : { label: option.label } : {}),
    ...(compute ? { compute } : {}),
  }
}

/** Resolve only the temporary choices; the saved spec continues to contain its defaults. */
export function resolveDynamicSpec(spec: ChartSpec, values: DynamicSelections = {}): ChartSpec {
  if (!spec.dynamics?.length) return spec
  const dimensions = [...((spec.query.dimensions as Record<string, unknown>[] | undefined) ?? [])]
  const measures = [...((spec.query.measures as Record<string, unknown>[] | undefined) ?? [])]
  const removed = new Set<string>()
  for (const dynamic of spec.dynamics) {
    const selected = dynamicSelection(dynamic, values)
    const columns = dynamic.kind === 'dimension' ? dimensions : measures
    // Saved API charts may use the field name as an implicit output alias.
    const index = columns.findIndex((column) => (column.alias || column.field) === dynamic.alias)
    if (index < 0) continue
    const option = dynamic.options.find((option) => option.id === selected)
    if (option) columns[index] = dynamicColumn(dynamic, option, columns[index]!.compute as MeasureCompute | undefined)
    else if (dynamic.kind === 'dimension' && dynamic.allowEmpty) {
      columns.splice(index, 1)
      removed.add(dynamic.alias)
    }
  }
  if (removed.size) for (let i = 0; i < measures.length; i++) {
    const compute = measures[i]!.compute as MeasureCompute | undefined
    if (compute?.type === 'percent_of_total' && compute.within) measures[i] = { ...measures[i], compute: { ...compute, within: compute.within.filter((name) => !removed.has(name)) } }
    // Without the dimension it runs along, a running total is the plain aggregate (Query.PruneCompute).
    if (compute?.type === 'cumulative' && removed.has(compute.along)) {
      const next = { ...measures[i] }
      delete next.compute
      measures[i] = next
    }
  }
  let viz = { ...spec.viz }
  if (removed.size && viz.hiddenColumns) {
    viz.hiddenColumns = viz.hiddenColumns.filter((name) => !removed.has(name))
    if (!viz.hiddenColumns.length) delete viz.hiddenColumns
  }
  if (viz.type !== 'table' && removed.size) {
    // A heatmap needs both of its dimensions; a pivot table keeps those that are left.
    const lost = viz.type === 'heatmap' && [...(viz.rows ?? []), ...(viz.columns ?? [])].some((name) => removed.has(name))
    if (viz.type === 'pivot') {
      viz.rows = viz.rows?.filter((name) => !removed.has(name))
      viz.columns = viz.columns?.filter((name) => !removed.has(name))
    }
    // A sankey diagram keeps the levels that are left, and needs two.
    if (viz.type === 'sankey') viz.levels = viz.levels?.filter((name) => !removed.has(name))
    if (!dimensions.length || lost || (viz.type === 'pivot' && !viz.rows?.length && !viz.columns?.length) || (viz.type === 'sankey' && (viz.levels?.length ?? 0) < 2)) viz = { type: 'table' }
    else {
      if (viz.x && removed.has(viz.x)) viz.x = String(dimensions[0]!.alias ?? dimensions[0]!.field)
      if (viz.series && (removed.has(viz.series) || viz.series === viz.x)) delete viz.series
    }
  }
  const query: Record<string, unknown> = { ...spec.query, dimensions, measures }
  if (removed.size && Array.isArray(spec.query.totals)) {
    const totals = prunedTotals(spec.query.totals as string[][], dimensions.map((dimension) => String(dimension.alias || dimension.field)))
    if (totals.length) query.totals = totals
    else delete query.totals
  }
  return { ...spec, query, viz }
}

/**
 * Fits totals to the dimensions a query has left, as the server does
 * (Query.PruneTotals): a dimension that is gone is dropped from each total,
 * and a total that now groups by every dimension, or by the same ones as
 * another, goes.
 */
export function prunedTotals(totals: string[][], names: string[]): string[][] {
  const out: string[][] = []
  for (const keep of totals) {
    const kept = keep.filter((name) => names.includes(name))
    if (kept.length < names.length && !out.some((other) => other.length === kept.length && other.every((name) => kept.includes(name)))) out.push(kept)
  }
  return out
}

export function hasQueryOutput(query: ChartSpec['query']): boolean {
  if (query.mode === 'detail') return Array.isArray(query.columns) && query.columns.length > 0
  return (Array.isArray(query.dimensions) && query.dimensions.length > 0) || (Array.isArray(query.measures) && query.measures.length > 0)
}

/** Validate the whole chart: several optional dimensions may all be cleared together. */
export function dynamicOutputProblem(spec: ChartSpec): 'needsOutput' | undefined {
  const optional = spec.dynamics?.filter((dynamic) => dynamic.kind === 'dimension' && dynamic.allowEmpty) ?? []
  if (optional.length && !hasQueryOutput(resolveDynamicSpec(spec, Object.fromEntries(optional.map((dynamic) => [dynamic.id, '']))).query)) return 'needsOutput'
}

/** Refuse a spec the builder cannot reproduce without silently losing a choice. */
export function validDynamics(dynamics: DynamicField[], fields: SpecField[]): boolean {
  if (dynamics.length > dynamicLimits.fields) return false
  const ids = new Set<string>()
  const aliases = new Set(fields.map((field) => field.key))
  for (const dynamic of dynamics) {
    if (!dynamic.id || ids.has(dynamic.id) || !dynamic.alias || aliases.has(dynamic.alias) || !dynamic.label.trim() || !['dimension', 'measure'].includes(dynamic.kind) || !dynamic.options.length || dynamic.options.length > dynamicLimits.options) return false
    if (dynamic.allowEmpty && dynamic.kind !== 'dimension') return false
    ids.add(dynamic.id)
    aliases.add(dynamic.alias)
    const optionIds = new Set<string>()
    for (const option of dynamic.options) {
      const field = fields.find((field) => field.key === option.field)
      if (!option.id || optionIds.has(option.id) || !field) return false
      optionIds.add(option.id)
      if (dynamic.kind === 'dimension') {
        if (field.role !== 'dimension' || option.agg || (option.grain && (!isTemporal(field.type) || !['year', 'quarter', 'month', 'week', 'day'].includes(option.grain)))) return false
        // A metric aggregates by itself; anything else says how it is aggregated.
      } else if (option.grain || (field.role === 'metric' ? Boolean(option.agg) : !option.agg || !aggregations.includes(option.agg) || !aggsFor(field.type).includes(option.agg))) return false
    }
  }
  return true
}

/** Temporary selections expire when a slot changes, without making the chart dirty. */
export function useDynamicSelections(dynamics: DynamicField[], scope = '') {
  const keys = Object.fromEntries(dynamics.map((dynamic) => [dynamic.id, JSON.stringify([scope, dynamic])]))
  const key = JSON.stringify(keys)
  const [stored, setStored] = useState({ key, keys, values: {} as DynamicSelections })
  let current = stored
  if (stored.key !== key) {
    current = { key, keys, values: Object.fromEntries(Object.entries(stored.values).filter(([id]) => keys[id] !== undefined && keys[id] === stored.keys[id])) }
    setStored(current)
  }
  return {
    values: current.values,
    setValue: (id: string, value: string) => setStored((current) => current.keys[id] !== keys[id] ? current : { ...current, values: { ...current.values, [id]: value } }),
  }
}
