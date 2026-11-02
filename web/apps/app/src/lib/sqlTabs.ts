// The local query tabs of data exploration.
// Kept in the browser, so the page opens the way it was left.

/** One open tab. */
export interface Tab {
  key: string
  /** The dataset draft being edited; absent for temporary queries. */
  datasetName?: string
  /** The original editor's return token. */
  handoff?: string
  /** Destination folder when creating a dataset from this query. */
  folderId?: string
  /** The number in a temporary query name, such as "Query 2". */
  n?: number
}

export interface Tabs {
  open: Tab[]
  /** The key of the tab that shows. */
  active: string
}

let made = 0
const newKey = () => `t${Date.now().toString(36)}${(made++).toString(36)}`

/** A return token identifies one dataset editing session; other queries are independent. */
export function opened(tabs: Tabs, what: Pick<Tab, 'datasetName' | 'handoff' | 'folderId'>): Tabs {
  const there = what.handoff ? tabs.open.find((tab) => tab.handoff === what.handoff) : undefined
  if (there) return { ...tabs, active: there.key }
  const tab: Tab = { key: newKey(), ...what }
  const taken = new Set(tabs.open.map((other) => other.n))
  tab.n = 1
  while (taken.has(tab.n)) tab.n++
  return { open: [...tabs.open, tab], active: tab.key }
}

/**
 * The tabs without one. When it was the one showing, the tab after it shows,
 * or the one before it when it was the last. There is always a tab: closing
 * the only one leaves an empty one in its place.
 */
export function closed(tabs: Tabs, key: string): Tabs {
  const index = tabs.open.findIndex((tab) => tab.key === key)
  if (index < 0) return tabs
  const open = tabs.open.filter((tab) => tab.key !== key)
  if (open.length === 0) return opened({ open, active: '' }, {})
  return { open, active: tabs.active === key ? open[Math.min(index, open.length - 1)]!.key : tabs.active }
}
