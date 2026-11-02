// Grouping a table's headers in the chart editor. The paths are those of the
// column layout the table draws (layoutColumns), where every column has a
// place, hidden ones too. See .agents/design/chart-dashboard.md §2.7.
import { maxGroupDepth, type ColumnGroup, type ColumnItem } from '@supabi/charts'

/** Headers picked side by side under one group, or at the top. */
export interface HeaderPick {
  /** The path of the group they are in; empty at the top. */
  parent: number[]
  /** Where among the group's items the pick started, and where it reaches. */
  anchor: number
  to: number
}

/**
 * Picks the item at a path; with extend, everything from where the pick
 * started to it, if both are in the same group. Otherwise the pick starts
 * again from the item.
 */
export function pickHeader(pick: HeaderPick | undefined, path: number[], extend: boolean): HeaderPick {
  const parent = path.slice(0, -1)
  const index = path.at(-1)!
  if (extend && pick && pick.parent.join() === parent.join()) return { ...pick, to: index }
  return { parent, anchor: index, to: index }
}

const span = (pick: HeaderPick) => [Math.min(pick.anchor, pick.to), Math.max(pick.anchor, pick.to)] as const

/** The paths of the items picked. */
export function pickedPaths(pick: HeaderPick): number[][] {
  const [from, to] = span(pick)
  return Array.from({ length: to - from + 1 }, (_, i) => [...pick.parent, from + i])
}

const itemsIn = (items: ColumnItem[], path: number[]): ColumnItem[] => path.reduce<ColumnItem[]>((list, index) => (list[index] as ColumnGroup).columns, items)

/** The item at a path, if there is one there. */
export const itemAt = (items: ColumnItem[], path: number[]): ColumnItem | undefined => {
  try {
    return itemsIn(items, path.slice(0, -1))[path.at(-1)!]
  } catch {
    return undefined
  }
}

/** The group picked when the pick is one group alone. */
export function pickedGroup(items: ColumnItem[], pick: HeaderPick): ColumnGroup | undefined {
  const item = pick.anchor === pick.to ? itemAt(items, [...pick.parent, pick.anchor]) : undefined
  return typeof item === 'object' ? item : undefined
}

const depthOf = (item: ColumnItem): number => (typeof item === 'string' ? 0 : 1 + Math.max(0, ...item.columns.map(depthOf)))

/** Whether a group around the picked items would nest no deeper than groups may. */
export function fitsInGroup(items: ColumnItem[], pick: HeaderPick): boolean {
  const [from, to] = span(pick)
  return pick.parent.length + 1 + Math.max(0, ...itemsIn(items, pick.parent).slice(from, to + 1).map(depthOf)) <= maxGroupDepth
}

/** Puts the picked items in a new group, which takes their place; with the path of the group. */
export function groupPicked(items: ColumnItem[], pick: HeaderPick, label: string): { items: ColumnItem[]; path: number[] } {
  const copy = structuredClone(items)
  const [from, to] = span(pick)
  const list = itemsIn(copy, pick.parent)
  list.splice(from, to - from + 1, { label, columns: list.slice(from, to + 1) })
  return { items: copy, path: [...pick.parent, from] }
}

/** Takes a group away, leaving what was in it where it was. */
export function ungroup(items: ColumnItem[], path: number[]): ColumnItem[] {
  const copy = structuredClone(items)
  const list = itemsIn(copy, path.slice(0, -1))
  const group = list[path.at(-1)!] as ColumnGroup
  list.splice(path.at(-1)!, 1, ...group.columns)
  return copy
}

/** Takes a column out of the groups, and a group left with nothing in it away. */
export function leaveGroups(groups: ColumnGroup[] | undefined, column: string): ColumnGroup[] | undefined {
  if (!groups) return groups
  const without = (items: ColumnItem[]): ColumnItem[] =>
    items.flatMap((item): ColumnItem[] => {
      if (typeof item === 'string') return item === column ? [] : [item]
      const columns = without(item.columns)
      return columns.length ? [{ ...item, columns }] : []
    })
  const left = without(groups) as ColumnGroup[]
  return left.length ? left : undefined
}

/** Names a group; a name left empty keeps the one it had. */
export function renameGroup(items: ColumnItem[], path: number[], label: string): ColumnItem[] {
  const name = label.trim()
  if (!name) return items
  const copy = structuredClone(items)
  ;(itemAt(copy, path) as ColumnGroup).label = name
  return copy
}
