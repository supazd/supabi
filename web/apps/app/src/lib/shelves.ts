// The shelves of the chart editor, and the order of what is on them. See
// .agents/design/chart-dashboard.md §2.1.
import { measureName, type BuilderState } from './builder'
import { leaveGroups } from './columnGroups'

/** Where a field can be put: a pivot table's dimensions go down the side or across the top. */
export type Shelf = 'dimension' | 'pivotColumn' | 'metric' | 'column' | 'filter'

/** What is on a shelf, in order: dimensions and columns by key, metrics by output column, filters by id. */
export function shelfKeys(state: BuilderState, shelf: Shelf): string[] {
  const across = new Set(state.vizType === 'pivot' ? (state.pivotColumns ?? []) : [])
  if (shelf === 'dimension') return state.dimensions.filter((key) => !across.has(key))
  if (shelf === 'pivotColumn') return state.dimensions.filter((key) => across.has(key))
  if (shelf === 'metric') return state.measures.map(measureName)
  if (shelf === 'column') return state.columns
  return state.filters.map((filter) => filter.id)
}

/** A list with the item at `from` put at `to`, a place counted among the items before it leaves: 0 is the front, the length the end. */
export function moved<T>(items: T[], from: number, to: number): T[] {
  const next = [...items]
  const [item] = next.splice(from, 1)
  next.splice(to > from ? to - 1 : to, 0, item!)
  return next
}

/**
 * Moves what is on a shelf to a place among its items, counted before it
 * leaves its own; nothing when it would end where it is. A column moved leaves
 * its column groups, and joins the innermost one it lands inside (see
 * pruneColumnGroups), so a group never stretches over the columns between.
 */
export function moveOnShelf(state: BuilderState, shelf: Shelf, key: string, to: number): Partial<BuilderState> | undefined {
  const keys = shelfKeys(state, shelf)
  const from = keys.indexOf(key)
  if (from < 0 || to < 0 || to > keys.length || to === from || to === from + 1) return undefined
  const order = moved(keys, from, to)
  const groups = shelf === 'filter' ? {} : { columnGroups: leaveGroups(state.columnGroups, key) }
  if (shelf === 'filter') return { filters: moved(state.filters, from, to) }
  if (shelf === 'metric') return { measures: moved(state.measures, from, to), ...groups }
  if (shelf === 'column') return { columns: order, ...groups }
  // The shelf's dimensions take the places among all of them that they had, in their new order.
  const members = new Set(keys)
  let next = 0
  return { dimensions: state.dimensions.map((other) => (members.has(other) ? order[next++]! : other)), ...groups }
}

/**
 * Puts what a patch adds to a shelf at a place among the items that were
 * there; the patch as it is when it adds nothing there, or no place is given.
 */
export function placedOnShelf(state: BuilderState, patch: Partial<BuilderState>, shelf: Shelf, at: number | undefined): Partial<BuilderState> {
  if (at === undefined) return patch
  const before = new Set(shelfKeys(state, shelf))
  const next = { ...state, ...patch }
  const keys = shelfKeys(next, shelf)
  const added = keys.filter((key) => !before.has(key))
  if (added.length !== 1) return patch
  // The place is among the items that were there; the new one may already be among them, not last.
  const now = keys.indexOf(added[0]!)
  return { ...patch, ...moveOnShelf(next, shelf, added[0]!, at <= now ? at : at + 1) }
}

/** Where a pointer is among items laid out in rows that wrap. */
export interface ItemBox {
  left: number
  right: number
  top: number
  bottom: number
}

/**
 * The place among items laid out left to right in rows that wrap where a
 * pointer would put something: in the row nearest the pointer, before the
 * item whose left half it is over or past, after the row's last item when
 * beyond it. With no items, the front.
 */
export function dropIndex(boxes: ItemBox[], x: number, y: number): number {
  if (!boxes.length) return 0
  const distance = (box: ItemBox) => (y < box.top ? box.top - y : y > box.bottom ? y - box.bottom : 0)
  const nearest = Math.min(...boxes.map(distance))
  const row = boxes.flatMap((box, index) => (distance(box) === nearest ? [index] : []))
  const before = row.find((index) => x < (boxes[index]!.left + boxes[index]!.right) / 2)
  return before ?? row.at(-1)! + 1
}
