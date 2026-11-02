import { describe, expect, it } from 'vitest'
import { closed, opened, type Tabs } from './sqlTabs'

const none: Tabs = { open: [], active: '' }

describe('the tabs of data exploration', () => {
  it('opens a dataset editing session once, and shows it where it is when asked again', () => {
    const one = opened(none, { handoff: 'a' })
    const two = opened(one, { handoff: 'b' })
    expect(two.open.map((tab) => tab.handoff)).toEqual(['a', 'b'])
    expect(two.active).toBe(two.open[1]!.key)
    const again = opened(two, { handoff: 'a' })
    expect(again.open).toHaveLength(2)
    expect(again.active).toBe(two.open[0]!.key)
  })

  it('numbers the queries with the first number that is free', () => {
    let tabs = opened(opened(opened(none, {}), { handoff: 'a' }), {})
    expect(tabs.open.map((tab) => tab.n)).toEqual([1, 2, 3])
    tabs = closed(tabs, tabs.open[0]!.key)
    expect(opened(tabs, { datasetName: 'd' }).open.map((tab) => [tab.n, tab.datasetName])).toEqual([[2, undefined], [3, undefined], [1, 'd']])
  })

  it('shows the tab after the one that was closed, or the one before the last', () => {
    const tabs = opened(opened(opened(none, { handoff: 'a' }), { handoff: 'b' }), { handoff: 'c' })
    const [a, b, c] = tabs.open.map((tab) => tab.key) as [string, string, string]
    expect(closed({ ...tabs, active: b }, b).active).toBe(c)
    expect(closed(tabs, c).active).toBe(b)
    // Closing a tab that is not showing leaves what shows.
    expect(closed(tabs, a).active).toBe(c)
    expect(closed(tabs, 'nope')).toBe(tabs)
  })

  it('leaves an empty tab when the only one is closed', () => {
    const one = opened(none, { handoff: 'a' })
    const left = closed(one, one.open[0]!.key)
    expect(left.open).toHaveLength(1)
    expect(left.open[0]).toMatchObject({ n: 1 })
    expect(left.open[0]!.handoff).toBeUndefined()
    expect(left.active).toBe(left.open[0]!.key)
  })
})
