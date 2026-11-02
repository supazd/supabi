import { useCallback, useState } from 'react'
import type { Cell, ResultColumn } from '@supabi/charts'
import type { Chart } from '../api/client'
import type { ChartSpec } from './builder'
import type { FilterField, FilterTarget } from './filters'
import type { ChartHolder } from './layout'

export interface DashboardLink {
  id: string
  label: string
  source: { item: string; column: string }
  targets: FilterTarget[]
}

/** The links whose source and some targets are among the given chart widgets and tabs, with those targets only. */
export function pruneLinks(links: DashboardLink[], items: { id: string }[]): DashboardLink[] {
  return links.filter((link) => items.some((item) => item.id === link.source.item))
    .map((link) => ({ ...link, targets: link.targets.filter((target) => items.some((item) => item.id === target.item)) }))
    .filter((link) => link.targets.length > 0)
}

export function linkColumns(spec: ChartSpec): { column: string; field: string; grain?: string }[] {
  if (!['bar', 'hbar', 'pie', 'table'].includes(spec.viz.type)) return []
  const query = spec.query as { mode?: string; columns?: (string | { field: string })[]; dimensions?: { field: string; alias?: string; grain?: string }[] }
  const columns = query.mode === 'detail'
    ? (query.columns ?? []).map((c) => ({ column: typeof c === 'string' ? c : c.field, field: typeof c === 'string' ? c : c.field }))
    : (query.dimensions ?? []).map((d) => ({ column: d.alias ?? d.field, field: d.field, grain: d.grain }))
  return columns.filter((c) => (spec.viz.type === 'table' || c.column === spec.viz.x) && !spec.dynamics?.some((d) => d.alias === c.column))
}

/**
 * What a chart widget is called in lists of widgets: the name it has on the
 * board, or its chart's, numbered where the chart is on the board more than once.
 */
export function widgetName(item: ChartHolder, items: ChartHolder[], charts: { id: string; name: string }[]): string {
  if (item.title) return item.title
  const name = charts.find((chart) => chart.id === item.chartId)?.name ?? item.id
  return name + (items.filter((entry) => entry.chartId === item.chartId).length > 1 ? ` #${items.indexOf(item) + 1}` : '')
}

export function linkSources(items: ChartHolder[], charts: Chart[], fields: FilterField[]) {
  return items.flatMap((item) => {
    const chart = charts.find((chart) => chart.id === item.chartId)
    if (!chart) return []
    return linkColumns(chart.spec as unknown as ChartSpec).flatMap((column) => {
      const field = fields.find((f) => f.item === item.id && !f.aggregate && f.target.field === column.field)
      return field ? [{ ...column, item: item.id, label: `${widgetName(item, items, charts)} · ${field.label}${column.column !== column.field ? ` (${column.column})` : ''}`, type: field.type }] : []
    })
  })
}

/** Reconcile each source before children fetch, preserving unrelated selections. */
export function useDashboardLinks(links: DashboardLink[], context: (link: DashboardLink) => unknown, initial: Record<string, Cell> = {}) {
  // A new source selection invalidates clicks previously made in its targets.
  // This clears state only; it never simulates another chart click.
  const clearDownstream = (next: Record<string, Cell>, changed: string[]) => {
    const affected = new Set(changed)
    let pending = [...changed]
    while (pending.length) {
      const targets = links.filter((link) => pending.includes(link.id)).flatMap((link) => link.targets.map((target) => target.item))
      pending = links.filter((link) => !affected.has(link.id) && targets.includes(link.source.item)).map((link) => link.id)
      for (const id of pending) { affected.add(id); delete next[id] }
    }
    return next
  }
  const keys = Object.fromEntries(links.map((link) => [link.id, JSON.stringify([link, context(link)])]))
  const key = JSON.stringify(keys)
  // Clicks a share link carries are where the viewer starts.
  const [stored, setStored] = useState({ key, keys, values: initial })
  const changed = Object.keys(stored.values).filter((id) => keys[id] !== stored.keys[id])
  const values = stored.key === key ? stored.values : changed.some((id) => keys[id] === undefined) ? {} : clearDownstream(
    Object.fromEntries(Object.entries(stored.values).filter(([id]) => !changed.includes(id))), changed,
  )
  if (stored.key !== key) setStored({ key, keys, values })
  const clear = (id: string) => setStored((current) => {
    if (current.key !== key) return current
    const next = { ...current.values }; delete next[id]
    return { key, keys, values: clearDownstream(next, [id]) }
  })
  // The columns of the sources as their charts last returned them, which say how a value clicked there is written.
  const [described, setDescribed] = useState<Record<string, ResultColumn>>({})
  const describe = useCallback((item: string, columns: ResultColumn[]) => setDescribed((current) => {
    let next = current
    for (const column of columns) {
      const at = `${item}\u0001${column.name}`
      if (JSON.stringify(current[at]) !== JSON.stringify(column)) next = { ...next, [at]: column }
    }
    return next
  }), [])
  const columnOf = (id: string) => {
    const link = links.find((entry) => entry.id === id)
    return link && described[`${link.source.item}\u0001${link.source.column}`]
  }
  const select = (item: string, column: string, value: Cell) => setStored((current) => {
    if (current.key !== key) return current
    const next = { ...current.values }
    const matching = links.filter((link) => link.source.item === item && link.source.column === column)
    const cancel = matching.every((link) => link.id in next && JSON.stringify(next[link.id]) === JSON.stringify(value))
    for (const link of matching) {
      if (cancel) delete next[link.id]
      else next[link.id] = value
    }
    return { key, keys, values: clearDownstream(next, matching.map((link) => link.id)) }
  })
  return { links, values, clear, select, describe, columnOf }
}
export type DashboardLinksState = ReturnType<typeof useDashboardLinks>
