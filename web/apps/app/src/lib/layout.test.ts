import { describe, expect, it } from 'vitest'
import { newItemId, place, dashboardGrid, splitDashboardGrid, changeGridColumns, defaultGridSettings, readGridSettings, insertAtTop, below, minItemHeight, chartHolders, chartItems, intoTabs, withoutTab, updateHolder, defaultTabOf, withDefaultTab, moveTab, insertTab, tabsDropTarget, readTabsDropTarget, onPage, replaceOnPage, splitIntoPages, joinPages, moveToPage, newPageName, shownPage, closeUp, type ChartItem, type DashboardGridItem, type LayoutItem, type TabsItem } from './layout'

const item = (id: string, x: number, y: number, w: number, h: number): LayoutItem => ({ id, type: 'chart', chartId: `ch_${id}`, x, y, w, h })

describe('layout', () => {
  it('keeps legacy rendering defaults and honors explicit grid settings', () => {
    expect(readGridSettings({ columns: 12, items: [] })).toEqual(defaultGridSettings)
    expect(readGridSettings({ columns: 24, items: [], grid: { ...defaultGridSettings, autoCompact: false } })).toEqual({ ...defaultGridSettings, columns: 24, autoCompact: false })
  })

  it('rescales shared column boundaries without changing vertical positions or mutating originals', () => {
    const original = [item('a', 0, 5, 48, 32), item('b', 48, 12, 48, 32)]
    const scaled = changeGridColumns(original, 96, 25)
    expect(scaled.map(({ x, y, w }) => ({ x, y, w }))).toEqual([{ x: 0, y: 5, w: 13 }, { x: 13, y: 12, w: 12 }])
    expect(original[0]!.w).toBe(48)
    expect(changeGridColumns([item('edge', 95, 0, 1, 16)], 96, 12)[0]).toMatchObject({ x: 10, w: 2 })
  })

  it('leaves the requested rows when adding charts and materializing legacy filters', () => {
    const charts = [item('a', 0, 0, 24, 32)]
    expect(place(charts, 'b', 24, 32, 3).y).toBe(35)
    const grid = dashboardGrid(charts, true, undefined, 'auto', 48, 3)
    expect(grid[0]).toMatchObject({ w: 48, y: 0 })
    expect(grid[1]!.y).toBe(11)
  })
  it('finds an unused id', () => {
    expect(newItemId([])).toBe('w1')
    expect(newItemId([{ id: 'w1' }, { id: 'w3' }])).toBe('w4')
    expect(newItemId([{ id: 'w2' }])).toBe('w3')
  })

  it('places a new widget below everything else', () => {
    expect(place([], 'ch_a')).toEqual({ id: 'w1', type: 'chart', chartId: 'ch_a', x: 0, y: 0, w: 48, h: 32 })
    const placed = place([item('w1', 0, 0, 8, 4), item('w2', 8, 0, 4, 6)], 'ch_b')
    expect([placed.id, placed.x, placed.y]).toEqual(['w3', 0, 6])
  })

  it('lets titles and text be shorter than charts, without saving what only the grid needs', () => {
    const title: LayoutItem = { id: 't', type: 'title', useDashboardName: true, x: 0, y: 0, w: 96, h: 8 }
    const text: LayoutItem = { id: 'n', type: 'text', markdown: '**口径**', x: 0, y: 8, w: 48, h: 16 }
    const grid = dashboardGrid([item('a', 0, 24, 48, 32), title, text], true, { x: 0, y: 56, w: 96, h: 8 })
    expect(grid.map((entry) => entry.minH)).toEqual([6, undefined, 4, 4])
    expect(splitDashboardGrid(grid)).toEqual({ items: [item('a', 0, 24, 48, 32), title, text], queryContainer: { x: 0, y: 56, w: 96, h: 8 } })
    expect([minItemHeight(item('a', 0, 0, 1, 1)), minItemHeight(title), minItemHeight(text)]).toEqual([16, 4, 4])
  })

  it('puts a title on top, moving the rest down, and text below everything', () => {
    const items = [item('a', 0, 0, 48, 32), item('b', 48, 4, 48, 32)]
    expect(insertAtTop(items, { ...item('t', 0, 9, 96, 8) }, 2).map(({ id, y }) => [id, y])).toEqual([['t', 0], ['a', 10], ['b', 14]])
    expect(insertAtTop<LayoutItem>([], item('t', 0, 0, 96, 8))).toEqual([item('t', 0, 0, 96, 8)])
    expect(below(items, 2)).toBe(38)
    expect(below([])).toBe(0)
  })
})

describe('tab containers', () => {
  const tabs: TabsItem = { id: 'w5', type: 'tabs', x: 0, y: 0, w: 48, h: 32, frame: { border: false }, tabs: [{ id: 'w1', chartId: 'ch_a', title: '销售额' }, { id: 'w6' }, { id: 'w7', chartId: 'ch_b' }] }

  it('counts each tab as a chart widget of its own, and its ids as taken', () => {
    const items: LayoutItem[] = [tabs, item('w2', 48, 0, 48, 32), { id: 'w3', type: 'text', x: 0, y: 32, w: 48, h: 16 }]
    expect(chartHolders(items).map((holder) => holder.id)).toEqual(['w1', 'w6', 'w7', 'w2'])
    expect(chartItems(items).map((holder) => holder.id)).toEqual(['w1', 'w7', 'w2'])
    expect(newItemId([{ id: 'w1', tabs: [{ id: 'w2' }, { id: 'w3' }] }])).toBe('w4')
    // A tab container is as tall at least as a chart.
    expect(dashboardGrid([tabs], false)[0]!.minH).toBeUndefined()
    expect(minItemHeight(tabs)).toBe(16)
  })

  it('makes a chart widget a tab container, its chart in the first tab under the same id', () => {
    const chart: ChartItem = { id: 'w1', type: 'chart', chartId: 'ch_a', title: '销售额', note: '口径', hideHeader: true, x: 8, y: 16, w: 48, h: 32, frame: { background: 'blue' } }
    expect(intoTabs(chart, 'w5', 'w6')).toEqual({ id: 'w5', type: 'tabs', x: 8, y: 16, w: 48, h: 32, frame: { background: 'blue' }, tabs: [{ id: 'w1', chartId: 'ch_a', title: '销售额', note: '口径' }, { id: 'w6' }] })
    expect(intoTabs({ id: 'w1', type: 'chart', x: 0, y: 0, w: 1, h: 1 }, 'w2', 'w3').tabs).toEqual([{ id: 'w1' }, { id: 'w3' }])
  })

  it('takes a tab out, and with one left is a chart widget again by its id', () => {
    expect(withoutTab(tabs, 'w6')).toEqual({ ...tabs, tabs: [tabs.tabs[0], tabs.tabs[2]] })
    const two: TabsItem = { ...tabs, tabs: [tabs.tabs[0]!, tabs.tabs[2]!] }
    expect(withoutTab(two, 'w1')).toEqual({ id: 'w7', type: 'chart', chartId: 'ch_b', x: 0, y: 0, w: 48, h: 32, frame: { border: false } })
  })

  it('shows a tab of its choice first, written down only when it is not the first', () => {
    expect(defaultTabOf(tabs).id).toBe('w1')
    expect(withDefaultTab(tabs, 'w7')).toEqual({ ...tabs, defaultTab: 'w7' })
    expect(withDefaultTab({ ...tabs, defaultTab: 'w7' }, 'w1')).toEqual(tabs)
    expect(defaultTabOf({ ...tabs, defaultTab: 'gone' }).id).toBe('w1')
  })

  it('moves a tab, keeping the tab shown first', () => {
    const ids = (item: TabsItem) => item.tabs.map((tab) => tab.id)
    expect(ids(moveTab(tabs, 'w7', 0))).toEqual(['w7', 'w1', 'w6'])
    expect(ids(moveTab(tabs, 'w1', 2))).toEqual(['w6', 'w7', 'w1'])
    expect(moveTab(tabs, 'w1', 2).defaultTab).toBe('w1')
    // Moved to the front, the tab shown first needs no saying.
    expect(moveTab({ ...tabs, defaultTab: 'w7' }, 'w7', 0).defaultTab).toBeUndefined()
    expect(moveTab(tabs, 'nope', 0)).toBe(tabs)
  })

  it('takes another tab at a place among its tabs, keeping the tab shown first', () => {
    const ids = (item: TabsItem) => item.tabs.map((tab) => tab.id)
    expect(ids(insertTab(tabs, { id: 'w9', chartId: 'ch_c' }, 1))).toEqual(['w1', 'w9', 'w6', 'w7'])
    expect(ids(insertTab(tabs, { id: 'w9' }, 99))).toEqual(['w1', 'w6', 'w7', 'w9'])
    // Put before the first, the one that was first is still shown first.
    expect(insertTab(tabs, { id: 'w9' }, 0)).toMatchObject({ defaultTab: 'w1', tabs: [{ id: 'w9' }, { id: 'w1' }, { id: 'w6' }, { id: 'w7' }] })
    expect(readTabsDropTarget(tabsDropTarget('w5', 2))).toEqual({ id: 'w5', at: 2 })
    expect(readTabsDropTarget('w5')).toBeUndefined()
  })

  it('keeps the tab shown first when another is taken out, and falls back to the first when it is', () => {
    expect(withoutTab({ ...tabs, defaultTab: 'w7' }, 'w1')).toMatchObject({ defaultTab: 'w7', tabs: [{ id: 'w6' }, { id: 'w7' }] })
    expect((withoutTab({ ...tabs, defaultTab: 'w6' }, 'w1') as TabsItem).defaultTab).toBeUndefined()
    expect((withoutTab({ ...tabs, defaultTab: 'w7' }, 'w7') as TabsItem).defaultTab).toBeUndefined()
    expect(withoutTab({ ...tabs, tabs: tabs.tabs.slice(0, 2), defaultTab: 'w6' }, 'w1')).not.toHaveProperty('defaultTab')
  })

  it('changes a chart widget or a tab wherever it is', () => {
    const items: LayoutItem[] = [tabs, item('w2', 48, 0, 48, 32)]
    const changed = updateHolder(items, 'w6', (holder) => ({ ...holder, chartId: 'ch_c' }))
    expect((changed[0] as TabsItem).tabs[1]).toEqual({ id: 'w6', chartId: 'ch_c' })
    expect(changed[1]).toBe(items[1])
    expect(updateHolder(items, 'w2', (holder) => ({ ...holder, title: '订单' }))[1]).toEqual({ ...item('w2', 48, 0, 48, 32), title: '订单' })
  })
})


describe('query container layout', () => {
  it('places legacy filters above charts without mutating the saved layout or shifting twice', () => {
    const charts = [item('w1', 0, 0, 6, 4)]
    const grid = dashboardGrid(charts, true)
    expect(charts[0]?.y).toBe(0)
    expect(grid[1]?.y).toBe(8)
    const saved = splitDashboardGrid(grid)
    expect(dashboardGrid(saved.items, true, saved.queryContainer)).toEqual(grid)
    expect(saved.items.every((entry) => entry.type === 'chart')).toBe(true)
  })

  it('keeps the query container id stable when charts are added and avoids chart id collisions', () => {
    const chart = item('w1', 0, 0, 6, 4)
    const grid = dashboardGrid([chart], true)
    expect(dashboardGrid([chart, place(grid, 'next')], true)[0]?.id).toBe(grid[0]?.id)
    const collision = dashboardGrid([item('query-container', 0, 0, 6, 4)], true)
    expect(new Set(collision.map((entry) => entry.id)).size).toBe(2)
  })
})

describe('pages', () => {
  const pages: [{ id: string; name: string }, { id: string; name: string }] = [{ id: 'p1', name: '概览' }, { id: 'p2', name: '渠道' }]
  const title: LayoutItem = { id: 't', type: 'title', useDashboardName: true, x: 0, y: 0, w: 96, h: 8 }
  const note: LayoutItem = { id: 'n', type: 'text', x: 0, y: 8, w: 48, h: 16 }

  it('tells the widgets on a page from those above the tabs, and lays out one group anew in place', () => {
    const items = [title, { ...item('a', 0, 0, 48, 32), page: 'p1' }, { ...item('b', 0, 0, 48, 32), page: 'p2' }, note]
    expect(onPage(items, undefined).map((entry) => entry.id)).toEqual(['t', 'n'])
    expect(onPage(items, 'p2').map((entry) => entry.id)).toEqual(['b'])
    // The page's widgets keep their place among the others; what is given is put on the page.
    const next = replaceOnPage(items, 'p1', [item('c', 0, 0, 48, 32), item('a', 0, 32, 48, 32)])
    expect(next.map((entry) => [entry.id, entry.page])).toEqual([['t', undefined], ['c', 'p1'], ['a', 'p1'], ['b', 'p2'], ['n', undefined]])
    // Above the tabs, nothing names a page.
    expect(replaceOnPage(items, undefined, [{ ...title, page: 'p1' } as LayoutItem]).map((entry) => [entry.id, 'page' in entry])).toEqual([['t', false], ['a', true], ['b', true]])
    // Not split, it is the widgets given.
    expect(replaceOnPage([title, note], undefined, [note, title])).toEqual([note, title])
  })

  it('splits a dashboard: titles and text above the charts, and the query container, go above the tabs', () => {
    const grid: DashboardGridItem[] = [
      { id: 'query-container', type: 'query', x: 0, y: 40, w: 96, h: 8, autoHeight: true, keepInGrid: true, minH: 6, maxH: 192, minContentSelector: '.dashboard-filters', contentPadding: 26 },
      title, note, item('a', 0, 24, 48, 32), item('b', 48, 30, 48, 16), { id: 'm', type: 'text', x: 0, y: 70, w: 48, h: 16 },
    ]
    const split = splitIntoPages(grid, pages)
    expect(split.map((entry) => [entry.id, entry.y, 'page' in entry ? entry.page : undefined])).toEqual([
      // The query container was among the charts: it goes below what is above them.
      ['query-container', 24, undefined], ['t', 0, undefined], ['n', 8, undefined],
      // The rest is the first page, from its top.
      ['a', 0, 'p1'], ['b', 6, 'p1'], ['m', 46, 'p1'],
    ])
    // Above the charts, the query container stays where it was.
    expect(splitIntoPages([{ ...grid[0]!, y: 0 }, item('a', 0, 8, 48, 32)] as DashboardGridItem[], pages).map((entry) => [entry.id, entry.y])).toEqual([['query-container', 0], ['a', 0]])
  })

  it('joins the page left to what is above the tabs, and moves a widget below what is on another page', () => {
    const items = [title, { ...item('a', 0, 0, 48, 32), page: 'p1' }, { ...item('b', 0, 4, 48, 32), page: 'p2' }]
    expect(joinPages(items, 'p2', { x: 0, y: 8, w: 96, h: 8 }, 2).map((entry) => [entry.id, entry.y, 'page' in entry])).toEqual([['t', 0, false], ['b', 22, false]])
    const moved = moveToPage(items, 'a', 'p2', 2)
    expect(moved.find((entry) => entry.id === 'a')).toMatchObject({ page: 'p2', x: 0, y: 38, w: 48, h: 32 })
    const up = moveToPage(items, 'b', undefined, 0, { x: 0, y: 8, w: 96, h: 8 })
    expect('page' in up.find((entry) => entry.id === 'b')!).toBe(false)
    expect(up.find((entry) => entry.id === 'b')!.y).toBe(16)
  })

  it('names a new page by the first number not taken, and shows the page chosen while there is one', () => {
    const nameOf = (n: number) => `Page ${n}`
    expect(newPageName([], nameOf)).toBe('Page 1')
    expect(newPageName([{ id: 'a', name: 'Page 1' }, { id: 'b', name: 'Page 3' }], nameOf)).toBe('Page 2')
    expect(shownPage(pages, 'p2')?.id).toBe('p2')
    expect(shownPage(pages, 'gone')?.id).toBe('p1')
    expect(shownPage(undefined, 'p1')).toBeUndefined()
  })

  it('gives back the room of a query container not shown, unless something is beside it', () => {
    const container = { x: 0, y: 8, w: 96, h: 8 }
    expect(closeUp([title, item('a', 0, 16, 48, 32)], container).map((entry) => entry.y)).toEqual([0, 8])
    // Never above where the container was.
    expect(closeUp([title, item('a', 0, 16, 48, 32)], container, 2).map((entry) => entry.y)).toEqual([0, 8])
    expect(closeUp([title, item('a', 0, 26, 48, 32)], container, 2).map((entry) => entry.y)).toEqual([0, 16])
    // Those below move together: one starting in the gap after the container does not end up over the one under it.
    expect(closeUp([title, item('a', 0, 17, 48, 10), item('b', 0, 27, 48, 4)], container, 2).map((entry) => entry.y)).toEqual([0, 8, 18])
    expect(closeUp([title, item('a', 0, 16, 48, 32), item('b', 48, 10, 48, 4)], { ...container, w: 48 }).map((entry) => entry.y)).toEqual([0, 16, 10])
    expect(closeUp([title], undefined)).toEqual([title])
  })
})
