// A table's column groups: headers over adjacent columns, nested at most
// maxGroupDepth deep. See .agents/design/chart-dashboard.md §2.7.
import type { ColumnGroup } from './spec'

/** How deep groups nest; the header has a row more, for the columns' own names. */
export const maxGroupDepth = 3
/** The longest a group's name may be, as for axis titles and page names. */
export const maxGroupLabel = 50

/** A column by its output name, or a group of more. */
export type ColumnItem = string | ColumnGroup

const leavesOf = (group: ColumnGroup): string[] => group.columns.flatMap((item) => (typeof item === 'string' ? [item] : leavesOf(item)))

/**
 * Every column of `order`, in that order, under the groups that hold them. A
 * group covers its columns from the first to the last, so a column that comes
 * between them joins the innermost group around it; a column that is gone
 * leaves its group, and a group left with none goes. A group that would cross
 * one before it, or nest too deep, is dropped and its columns kept.
 */
export function layoutColumns(groups: ColumnGroup[] | undefined, order: string[]): ColumnItem[] {
  const at = new Map(order.map((name, i) => [name, i]))
  const spans: { label: string; first: number; last: number }[] = []
  const visit = (group: ColumnGroup) => {
    const positions = leavesOf(group).flatMap((name) => (at.has(name) ? [at.get(name)!] : []))
    if (positions.length) {
      const first = Math.min(...positions)
      const last = Math.max(...positions)
      // Groups come parents first, so any group before this one that it meets must hold it.
      const around = spans.filter((span) => span.first <= first && last <= span.last)
      const crosses = spans.some((span) => !(span.last < first || last < span.first) && !around.includes(span))
      if (!crosses && around.length < maxGroupDepth) spans.push({ label: group.label, first, last })
    }
    for (const item of group.columns) if (typeof item !== 'string') visit(item)
  }
  groups?.forEach(visit)

  // Outer groups first where two start together; a group and the one inside it covering the same columns keep their order.
  const opening = [...spans].sort((a, b) => a.first - b.first || b.last - a.last)
  const root: ColumnItem[] = []
  const open: { items: ColumnItem[]; last: number }[] = [{ items: root, last: Infinity }]
  let next = 0
  order.forEach((name, p) => {
    while (opening[next]?.first === p) {
      const span = opening[next++]!
      const group: ColumnGroup = { label: span.label, columns: [] }
      open.at(-1)!.items.push(group)
      open.push({ items: group.columns, last: span.last })
    }
    open.at(-1)!.items.push(name)
    while (open.at(-1)!.last === p) open.pop()
  })
  return root
}

/** The groups of a layout, as a chart keeps them: columns outside every group are not written. */
export const groupsOf = (items: ColumnItem[]): ColumnGroup[] => items.filter((item): item is ColumnGroup => typeof item !== 'string')

/** A cell of a table's header: a group over the columns shown under it, or a column reaching down to the last row. */
export type HeaderCell =
  | { kind: 'group'; label: string; path: number[]; level: number; colSpan: number }
  | { kind: 'column'; name: string; path: number[]; level: number; rowSpan: number }

/**
 * The rows of a table's header, top first, for the columns shown. A group
 * with none of them shown is not drawn. Each cell has its path in the layout:
 * the index of each item from the top.
 */
export function toHeaderRows(items: ColumnItem[], shown: (name: string) => boolean): HeaderCell[][] {
  const count = (item: ColumnItem): number => (typeof item === 'string' ? (shown(item) ? 1 : 0) : item.columns.reduce((n, inner) => n + count(inner), 0))
  const depth = (list: ColumnItem[]): number => Math.max(0, ...list.map((item) => (typeof item === 'string' || count(item) === 0 ? 0 : 1 + depth(item.columns))))
  const height = depth(items) + 1
  const rows: HeaderCell[][] = Array.from({ length: height }, () => [])
  const walk = (list: ColumnItem[], level: number, path: number[]) =>
    list.forEach((item, i) => {
      const at = [...path, i]
      if (typeof item === 'string') {
        if (shown(item)) rows[level]!.push({ kind: 'column', name: item, path: at, level, rowSpan: height - level })
        return
      }
      const colSpan = count(item)
      if (colSpan === 0) return
      rows[level]!.push({ kind: 'group', label: item.label, path: at, level, colSpan })
      walk(item.columns, level + 1, at)
    })
  walk(items, 0, [])
  return rows
}
