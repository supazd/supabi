import { describe, expect, it } from 'vitest'
import type { Chart } from '../api/client'
import { applicableState, choicesOf, chosenState, type ChoiceSpec, type WidgetChoices } from './dashboardView'

const chart = { id: 'c1', spec: {
  filters: [
    { id: 'region', field: 'region', op: 'in', value: [], control: { type: 'select', multi: true } },
    { id: 'name', field: 'name', op: 'contains', value: 'Alice', control: { type: 'text' } },
    { id: 'fixed', field: 'amount', op: 'gt', value: 0 },
  ],
  dynamics: [{ id: 'metric', kind: 'measure', label: 'Metric', alias: 'm', options: [{ id: 'sum' }, { id: 'avg' }] }],
} } as unknown as Chart
const spec: ChoiceSpec = {
  filters: [{ id: 'g', label: 'G', op: 'gte', control: { type: 'number' }, targets: [{ item: 'w1', field: 'amount' }], default: 100 }],
  links: [{ id: 'l', label: 'L', source: { item: 'w1', column: 'region' }, targets: [] }],
  layout: { items: [{ id: 'w1', type: 'chart', chartId: 'c1', x: 0, y: 0, w: 6, h: 4 }] },
}

describe('share link conditions', () => {
  it('carries only what differs from the dashboard’s defaults, explicit clearing included', () => {
    expect(chosenState(spec, [chart], { values: {}, widgets: {}, links: {}, tabs: {} })).toEqual({})
    expect(chosenState(spec, [chart], {
      values: { g: null },
      widgets: { w1: { useChartFilters: true, chosen: { name: 'Alice', region: ['East'] }, selections: { metric: 'sum' } } },
      links: { l: null },
      tabs: {},
    })).toEqual({ filters: { g: null }, chartFilters: { w1: { region: ['East'] } }, useChartFilters: ['w1'], links: { l: null } })
  })

  it('leaves out what the dashboard no longer has, or values of the wrong form', () => {
    const { state, dropped } = applicableState({
      filters: { g: 200, gone: 1 },
      chartFilters: { w1: { region: 'East', name: 'Bob', fixed: 5 }, w9: { name: 'x' } },
      selections: { w1: { metric: 'avg', other: 'x' } },
      useChartFilters: ['w1', 'w9'],
      links: { l: 'East', m: 'x' },
    }, spec, [chart])
    expect(state).toEqual({ filters: { g: 200 }, chartFilters: { w1: { name: 'Bob' } }, selections: { w1: { metric: 'avg' } }, useChartFilters: ['w1'], links: { l: 'East' } })
    expect(dropped).toBe(true)
    expect(applicableState(state, spec, [chart]).dropped).toBe(false)
  })

  it('takes no choices for titles or text, which a chart may have become', () => {
    const withNotes: ChoiceSpec = { ...spec, layout: { items: [...spec.layout.items, { id: 'w2', type: 'title', title: 'East', x: 0, y: 4, w: 6, h: 1 }] } }
    const { state, dropped } = applicableState({ chartFilters: { w2: { name: 'Bob' } }, useChartFilters: ['w2'] }, withNotes, [chart])
    expect(state).toEqual({})
    expect(dropped).toBe(true)
    expect(chosenState(withNotes, [chart], { values: {}, widgets: { w2: { useChartFilters: true, chosen: {}, selections: {} } }, links: {}, tabs: {} })).toEqual({})
  })

  it('starts the viewer from the shared conditions', () => {
    expect(choicesOf({ filters: { g: 1 }, chartFilters: { w1: { name: 'Bob' } }, useChartFilters: ['w2'], links: { l: 'East' } })).toEqual({
      values: { g: 1 },
      widgets: { w1: { useChartFilters: false, chosen: { name: 'Bob' }, selections: {} }, w2: { useChartFilters: true, chosen: {}, selections: {} } },
      links: { l: 'East' },
      tabs: {},
    })
    expect(choicesOf({ tabs: { t: 'b' } }).tabs).toEqual({ t: 'b' })
  })

  describe('tab containers', () => {
    // Opened on b; c holds no chart, so readers are not offered it.
    const tabbed: ChoiceSpec = { layout: { items: [{ id: 't', type: 'tabs', x: 0, y: 0, w: 6, h: 4, defaultTab: 'b', tabs: [{ id: 'a', chartId: 'c1' }, { id: 'b', chartId: 'c1' }, { id: 'c' }] }] } }
    const choices = (tabs: Record<string, string>) => ({ values: {}, widgets: {}, links: {}, tabs })

    it('carries the tab a container shows only where it is not the one it opens on', () => {
      expect(chosenState(tabbed, [chart], choices({ t: 'a' }))).toEqual({ tabs: { t: 'a' } })
      expect(chosenState(tabbed, [chart], choices({ t: 'b' }))).toEqual({})
      expect(chosenState(tabbed, [chart], choices({}))).toEqual({})
      // A tab not offered is not what is shown.
      expect(chosenState(tabbed, [chart], choices({ t: 'c' }))).toEqual({})
    })

    it('leaves out tabs and containers the dashboard no longer offers', () => {
      const { state, dropped } = applicableState({ tabs: { t: 'a', u: 'a' } }, tabbed, [chart])
      expect(state).toEqual({ tabs: { t: 'a' } })
      expect(dropped).toBe(true)
      expect(applicableState({ tabs: { t: 'c' } }, tabbed, [chart])).toEqual({ state: {}, dropped: true })
      expect(applicableState({ tabs: { t: 'b' } }, tabbed, [chart])).toEqual({ state: { tabs: { t: 'b' } }, dropped: false })
    })
  })
})

describe('drill positions in share links', () => {
  const drilled = { id: 'c3', spec: {
    query: { dimensions: [{ field: 'region' }, { field: 'order_date', grain: 'year', alias: 'year' }] },
    drill: { alias: 'year', levels: [{ field: 'order_date', grain: 'month', label: 'Month' }, { field: 'order_date', grain: 'day', label: 'Day' }] },
  } } as unknown as Chart
  const board: ChoiceSpec = { layout: { items: [{ id: 'w1', type: 'chart', chartId: 'c1', x: 0, y: 0, w: 6, h: 4 }, { id: 'w3', type: 'chart', chartId: 'c3', x: 6, y: 0, w: 6, h: 4 }] } }
  const choices = (widgets: Record<string, WidgetChoices>) => ({ values: {}, widgets, links: {}, tabs: {} })
  const at = (drill?: WidgetChoices['drill']): WidgetChoices => ({ useChartFilters: false, chosen: {}, selections: {}, ...(drill ? { drill } : {}) })

  it('carries where a chart is below its first level, as its breadcrumb shows it', () => {
    const position = { root: 'Year', steps: [{ value: '2024-01-01', text: '2024' }, { value: null, text: 'Missing' }] }
    expect(chosenState(board, [chart, drilled], choices({ w3: at(position) }))).toEqual({ drill: { w3: position } })
    expect(chosenState(board, [chart, drilled], choices({ w3: at({ root: 'Year', steps: [] }) }))).toEqual({})
    // A chart that does not drill carries none.
    expect(chosenState(board, [chart, drilled], choices({ w1: at(position) }))).toEqual({})
  })

  it('drops the position of a chart that no longer drills, or not that deep', () => {
    const steps = (n: number) => Array.from({ length: n }, (_, i) => ({ value: String(2020 + i) }))
    expect(applicableState({ drill: { w3: { root: 'Year', steps: steps(2) } } }, board, [chart, drilled])).toEqual({ state: { drill: { w3: { root: 'Year', steps: steps(2) } } }, dropped: false })
    expect(applicableState({ drill: { w3: { root: 'Year', steps: steps(3) } } }, board, [chart, drilled])).toEqual({ state: {}, dropped: true })
    expect(applicableState({ drill: { w1: { root: 'Region', steps: steps(1) } } }, board, [chart, drilled])).toEqual({ state: {}, dropped: true })
    expect(applicableState({ drill: { w3: { root: 'Year', steps: [{ value: ['x'] }] } } }, board, [chart, drilled]).dropped).toBe(true)
  })

  it('writes values that came without their texts as the chart writes them, by the grain of their level', () => {
    const { widgets } = choicesOf({ drill: { w3: { root: 'Year', steps: [{ value: '2024-01-01' }, { value: '2024-03-01' }, { value: null }] } } }, board, [chart, drilled])
    expect(widgets.w3?.drill).toEqual({ root: 'Year', steps: [{ value: '2024-01-01', text: '2024' }, { value: '2024-03-01', text: '2024-03' }, { value: null }] })
  })
})

describe('the page of a split dashboard', () => {
  const split: ChoiceSpec = { ...spec, layout: { ...spec.layout, pages: [{ id: 'p1', name: '概览' }, { id: 'p2', name: '渠道' }] } }

  it('is carried where it is not the first, and dropped when the dashboard no longer has it', () => {
    const choices = { values: {}, widgets: {}, links: {}, tabs: {} }
    expect(chosenState(split, [chart], { ...choices, page: 'p1' })).toEqual({})
    expect(chosenState(split, [chart], { ...choices, page: 'p2' })).toEqual({ page: 'p2' })
    expect(chosenState(spec, [chart], { ...choices, page: 'p2' })).toEqual({})
    expect(applicableState({ page: 'p2' }, split, [chart])).toEqual({ state: { page: 'p2' }, dropped: false })
    expect(applicableState({ page: 'p3' }, split, [chart])).toEqual({ state: {}, dropped: true })
    expect(choicesOf({ page: 'p2' }).page).toBe('p2')
  })
})

describe('parameter values in share links', () => {
  const withParams = { id: 'c2', spec: { filters: [
    { id: 'p_day', param: 'day', label: 'Day', control: { type: 'input' } },
    { id: 'p_regions', param: 'regions', label: 'Regions', control: { type: 'select' }, options: ['north'] },
  ] }, params: {
    p_day: { type: 'date', needsValue: true, default: { relative: 'today-1d' } },
    p_regions: { type: 'string', multi: true, default: ['east'], options: ['east', 'north'] },
  } } as unknown as Chart
  const board: ChoiceSpec = { layout: { items: [{ id: 'w1', type: 'chart', chartId: 'c2', x: 0, y: 0, w: 6, h: 4 }] } }

  it('are carried where they differ from the default the parameter follows', () => {
    const chosen = (values: Record<string, unknown>) => chosenState(board, [withParams], { values: {}, widgets: { w1: { useChartFilters: false, chosen: values, selections: {} } }, links: {}, tabs: {} })
    expect(chosen({ p_day: { relative: 'today-1d' }, p_regions: ['east'] })).toEqual({})
    expect(chosen({ p_day: '2026-01-02', p_regions: [] })).toEqual({ chartFilters: { w1: { p_day: '2026-01-02', p_regions: [] } } })
  })

  it('are left out when the dropdown no longer offers them, or the SQL cannot do without one', () => {
    const { state, dropped } = applicableState({ chartFilters: { w1: { p_regions: ['north', 'west'], p_day: null } } }, board, [withParams])
    expect(state).toEqual({})
    expect(dropped).toBe(true)
    expect(applicableState({ chartFilters: { w1: { p_regions: ['north'], p_day: '2026-01-02' } } }, board, [withParams]).dropped).toBe(false)
    // A day is one value, never a list, even an empty one.
    expect(applicableState({ chartFilters: { w1: { p_day: [] } } }, board, [withParams]).dropped).toBe(true)
  })
})
