import type { Schemas } from '../api/client'
import type { DatasetSpec } from '../api/spec'

/** Object key order is not a definition change; array order is. */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item) ?? ''
}

export type Revision = Schemas['DatasetRevision']
export type Change = { section: 'dataset' | 'source' | 'parameter' | 'field' | 'settings'; name?: string; property: string; before: unknown; after: unknown }

/** Compare saved values by field/parameter identity, including attributes the editor does not edit. */
export function revisionChanges(before: Revision, after: Revision): Change[] {
  const result: Change[] = []
  const properties = (section: Change['section'], a: Record<string, unknown>, b: Record<string, unknown>, name?: string, ignored: string[] = []) => {
    for (const property of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!ignored.includes(property) && canonicalJSON(a[property]) !== canonicalJSON(b[property])) result.push({ section, name, property, before: a[property], after: b[property] })
    }
  }
  properties('dataset', { name: before.name, description: before.description, datasourceId: before.datasourceId }, { name: after.name, description: after.description, datasourceId: after.datasourceId })
  const a = before.spec as DatasetSpec, b = after.spec as DatasetSpec
  properties('source', a.source, b.source, undefined, ['sql'])
  const entries = (section: 'field' | 'parameter', left: Record<string, unknown>[], right: Record<string, unknown>[], id: string) => {
    const old = new Map(left.map((item) => [item[id], item]))
    const next = new Map(right.map((item) => [item[id], item]))
    for (const key of new Set([...old.keys(), ...next.keys()])) {
      const previous = old.get(key), current = next.get(key)
      const name = String(current?.label || previous?.label || key)
      if (!previous || !current) result.push({ section, name, property: previous ? 'removed' : 'added', before: previous, after: current })
      else properties(section, previous, current, name, [id])
    }
    // Added/removed fields are already described; compare the order of surviving entries.
    const oldOrder = left.filter((item) => next.has(item[id])).map((item) => item[id])
    const newOrder = right.filter((item) => old.has(item[id])).map((item) => item[id])
    if (canonicalJSON(oldOrder) !== canonicalJSON(newOrder)) result.push({ section, property: 'order', before: left.map((item) => item.label || item[id]), after: right.map((item) => item.label || item[id]) })
  }
  entries('field', a.fields, b.fields, 'key')
  entries('parameter', (a.params ?? []) as Record<string, unknown>[], (b.params ?? []) as Record<string, unknown>[], 'name')
  properties('settings', a, b, undefined, ['source', 'fields', 'params'])
  return result
}

export type DiffLine = { kind: 'same' | 'removed' | 'added'; text: string; before?: number; after?: number }

/** A bounded line diff. Very large replacements use delete/insert without a quadratic allocation. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before === '' ? [] : before.split('\n'), b = after === '' ? [] : after.split('\n')
  let prefix = 0, suffix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - suffix - 1] === b[b.length - suffix - 1]) suffix++
  const rows: DiffLine[] = a.slice(0, prefix).map((text, i) => ({ kind: 'same', text, before: i + 1, after: i + 1 }))
  const n = a.length - prefix - suffix, m = b.length - prefix - suffix
  let i = 0, j = 0
  const removed = () => { rows.push({ kind: 'removed', text: a[prefix + i]!, before: prefix + ++i }) }
  const added = () => { rows.push({ kind: 'added', text: b[prefix + j]!, after: prefix + ++j }) }
  if ((n + 1) * (m + 1) <= 1_000_000) {
    const widths = m + 1, scores = new Uint32Array((n + 1) * widths)
    for (let x = n - 1; x >= 0; x--) for (let y = m - 1; y >= 0; y--) scores[x * widths + y] = a[prefix + x] === b[prefix + y] ? scores[(x + 1) * widths + y + 1]! + 1 : Math.max(scores[(x + 1) * widths + y]!, scores[x * widths + y + 1]!)
    while (i < n || j < m) {
      if (i < n && j < m && a[prefix + i] === b[prefix + j]) rows.push({ kind: 'same', text: a[prefix + i]!, before: prefix + ++i, after: prefix + ++j })
      else if (i < n && (j === m || scores[(i + 1) * widths + j]! >= scores[i * widths + j + 1]!)) removed()
      else added()
    }
  } else { while (i < n) removed(); while (j < m) added() }
  for (let k = suffix; k > 0; k--) rows.push({ kind: 'same', text: a[a.length - k]!, before: a.length - k + 1, after: b.length - k + 1 })
  return rows
}
