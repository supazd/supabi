import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Visualization } from './Visualization'
import { highlightInk, inkFor, type Hue } from './palette'
import type { QueryResult } from './result'
import type { Highlight } from './spec'

const canvas = vi.hoisted(() => ({
  click: undefined as ((event: { dataIndex: number; event?: { event: { clientX: number; clientY: number } } }) => void) | undefined,
  /** A click on the drawing itself, wherever it is: offsets within the chart, as zrender gives them. */
  plotClick: undefined as ((event: { offsetX: number; offsetY: number; event: { clientX: number; clientY: number } }) => void) | undefined,
}))
// A plot 100 pixels from its left, with a category every 50 pixels.
vi.mock('echarts/core', () => ({ use: () => {}, init: () => ({
  setOption: () => {}, on: (_: string, fn: typeof canvas.click) => { canvas.click = fn }, resize: () => {}, dispose: () => {},
  getZr: () => ({ on: (name: string, fn: typeof canvas.plotClick) => { if (name === 'click') canvas.plotClick = fn }, setCursorStyle: () => {} }),
  containPixel: (_: string, [x]: number[]) => x! >= 100,
  convertFromPixel: (_: unknown, [x, y]: number[]) => [(x! - 100) / 50, y],
}) }))
afterEach(cleanup)
const result: QueryResult = { columns: [{ name: 'region', type: 'string', role: 'dimension' }, { name: 'amount', type: 'integer', role: 'measure' }], rows: [[null, 10], ['', 20], ['East', 30]] }

describe('table column visibility', () => {
  const data: QueryResult = {
    columns: [
      { name: 'id', type: 'integer', role: 'dimension' },
      { name: 'region', type: 'string', role: 'dimension' },
      { name: 'amount', type: 'integer', role: 'measure' },
      { name: 'share', type: 'float', role: 'measure', format: { style: 'percent' } },
    ],
    rows: [[2, 'East', 30, 0.75], [1, 'East', 10, 0.25]],
    totals: [{ by: [], columns: [{ name: 'amount', type: 'integer', role: 'measure' }, { name: 'share', type: 'float', role: 'measure' }], rows: [[40, 1]] }],
  }

  it('hides cells and totals without changing row order, grouping, values or cell selection', () => {
    const select = vi.fn()
    const copy = structuredClone(data)
    const { rerender } = render(<Visualization viz={{ type: 'table', hiddenColumns: ['id', 'amount'], style: { freeze: true } }} result={data} aria-label="sales" locale="en-US" onCellSelect={select} selectableColumns={['id', 'region']} />)
    const table = screen.getByRole('table', { name: 'sales' })
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['region', 'share'])
    const rows = within(table).getAllByRole('row')
    expect(rows.map((row) => within(row).queryAllByRole('cell').map((cell) => cell.textContent))).toEqual([[], ['East', '75%'], ['East', '25%'], ['Total', '100%']])
    expect((within(table).getAllByRole('columnheader')[0] as HTMLElement).style.position).toBe('sticky')
    fireEvent.click(within(table).getAllByRole('button', { name: 'East' })[0]!)
    expect(select).toHaveBeenCalledWith('region', 'East', expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }))
    expect(data).toEqual(copy)
    rerender(<Visualization viz={{ type: 'table' }} result={data} aria-label="sales" />)
    expect(within(table).getAllByRole('columnheader')).toHaveLength(4)
  })

  it('keeps detail values aligned and spans only visible columns for omitted totals', () => {
    render(<Visualization viz={{ type: 'table', hiddenColumns: ['id', 'amount'] }} result={{ ...data, columns: data.columns.map((column) => ({ ...column, role: 'dimension' })), totals: undefined, meta: { totalsOmitted: true } }} aria-label="detail" locale="en-US" />)
    expect(screen.getAllByRole('row')[1]!.textContent).toBe('East75%')
    expect(screen.getByText('No totals: the chart filters on aggregated results.').getAttribute('colspan')).toBe('2')
  })

  it('explains an invalid table with every column hidden instead of rendering a blank table', () => {
    render(<Visualization viz={{ type: 'table', hiddenColumns: data.columns.map((column) => column.name) }} result={data} aria-label="sales" renderError={(error) => <p role="alert">{error.code}</p>} />)
    expect(screen.getByRole('alert').textContent).toBe('no_visible_columns')
    expect(screen.queryByRole('table')).toBeNull()
  })
})

describe('merging equal values in a table', () => {
  const data: QueryResult = {
    columns: [
      { name: 'region', type: 'string', role: 'dimension' },
      { name: 'city', type: 'string', role: 'dimension' },
      { name: 'amount', type: 'integer', role: 'measure' },
    ],
    rows: [['East', 'A', 10], ['East', 'B', 10], ['West', 'B', 20]],
    totals: [{ by: [], columns: [{ name: 'amount', type: 'integer', role: 'measure' }], rows: [[40]] }],
  }
  const cells = (table: HTMLElement) => within(table).getAllByRole('row').map((row) => within(row).queryAllByRole('cell').map((cell) => cell.textContent))

  it('writes a run of equal dimension values once at its top, and never merges measures or the total', () => {
    const select = vi.fn()
    const { rerender } = render(<Visualization viz={{ type: 'table', style: { merge: true, striped: true } }} result={data} aria-label="sales" locale="en-US" onCellSelect={select} selectableColumns={['region']} />)
    const table = screen.getByRole('table', { name: 'sales' })
    expect(cells(table)).toEqual([[], ['East', 'A', '10'], ['B', '10'], ['West', 'B', '20'], ['Total', '', '40']])
    const east = within(table).getAllByRole('cell')[0] as HTMLTableCellElement
    expect(east.rowSpan).toBe(2)
    expect(east.style.verticalAlign).toBe('top')
    fireEvent.click(within(table).getByRole('button', { name: 'East' }))
    expect(select).toHaveBeenCalledWith('region', 'East', expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }))
    rerender(<Visualization viz={{ type: 'table', style: { striped: true } }} result={data} aria-label="sales" locale="en-US" />)
    expect(cells(table)).toEqual([[], ['East', 'A', '10'], ['East', 'B', '10'], ['West', 'B', '20'], ['Total', '', '40']])
  })
})

describe('column groups in a table', () => {
  const data: QueryResult = {
    columns: [
      { name: 'region', type: 'string', role: 'dimension', label: '大区' },
      { name: 'revenue', type: 'integer', role: 'measure', label: '销售额' },
      { name: 'profit', type: 'integer', role: 'measure', label: '毛利' },
      { name: 'orders', type: 'integer', role: 'measure', label: '订单数' },
    ],
    rows: [['East', 10, 2, 1]],
  }
  const viz = { type: 'table' as const, columnGroups: [{ label: '业绩', columns: [{ label: '金额', columns: ['revenue', 'profit'] }, 'orders'] }] }
  const header = (table: HTMLElement) =>
    [...table.querySelectorAll('thead tr')].map((row) => [...row.querySelectorAll('th')].map((th) => `${th.textContent}${th.colSpan > 1 ? `/${th.colSpan}` : ''}${th.rowSpan > 1 ? `^${th.rowSpan}` : ''}`))

  it('writes each group over its columns, a column without one up to the top, and keeps each row of the header in view', () => {
    render(<Visualization viz={viz} result={data} aria-label="sales" locale="en-US" />)
    const table = screen.getByRole('table', { name: 'sales' })
    expect(header(table)).toEqual([['大区^3', '业绩/3'], ['金额/2', '订单数^2'], ['销售额', '毛利']])
    expect(within(table).getAllByRole('columnheader').map((th) => (th as HTMLElement).style.top)).toEqual(['0px', '0px', '33px', '33px', '66px', '66px'])
    // Set, not inherited, so each row is as tall as those steps.
    expect(within(table).getAllByRole('columnheader').every((th) => (th as HTMLElement).style.lineHeight === '20px')).toBe(true)
    // Read only: nothing to pick.
    expect(within(table).getByRole('columnheader', { name: '业绩' }).tabIndex).toBe(-1)
  })

  it('leaves out hidden columns, and a group with none shown', () => {
    render(<Visualization viz={{ ...viz, hiddenColumns: ['revenue', 'profit'] }} result={data} aria-label="sales" locale="en-US" />)
    expect(header(screen.getByRole('table', { name: 'sales' }))).toEqual([['大区^2', '业绩'], ['订单数']])
  })

  it('lets the author pick headers, extend the pick with Shift, and rename a group in place', () => {
    const editing = { columns: ['region', 'revenue', 'profit', 'orders'], selected: [[0]], onSelect: vi.fn(), onRenameStart: vi.fn(), onRename: vi.fn() }
    const { rerender } = render(<Visualization viz={viz} result={data} aria-label="sales" locale="en-US" headerEditing={editing} onColumnResize={() => {}} />)
    const table = screen.getByRole('table', { name: 'sales' })
    fireEvent.click(within(table).getByRole('columnheader', { name: /^大区/ }))
    expect(editing.onSelect).toHaveBeenLastCalledWith([0], false)
    fireEvent.click(within(table).getByRole('columnheader', { name: /^订单数/ }), { shiftKey: true })
    expect(editing.onSelect).toHaveBeenLastCalledWith([1, 1], true)
    // Dragging an edge sets a width; it does not pick.
    fireEvent.click(within(table).getByRole('separator', { name: 'orders' }))
    expect(editing.onSelect).toHaveBeenCalledTimes(2)
    expect(within(table).getByRole('columnheader', { name: /^大区/ }).getAttribute('aria-selected')).toBe('true')
    expect(within(table).getByRole('columnheader', { name: '业绩' }).getAttribute('aria-selected')).toBe('false')
    fireEvent.doubleClick(within(table).getByRole('columnheader', { name: '业绩' }))
    expect(editing.onRenameStart).toHaveBeenCalledWith([1])

    rerender(<Visualization viz={viz} result={data} aria-label="sales" locale="en-US" headerEditing={{ ...editing, renaming: [1] }} />)
    const name = within(table).getByRole<HTMLInputElement>('textbox', { name: '业绩' })
    expect(name.maxLength).toBe(50)
    fireEvent.change(name, { target: { value: '本期' } })
    fireEvent.keyDown(name, { key: 'Enter' })
    fireEvent.blur(name)
    expect(editing.onRename).toHaveBeenCalledTimes(1)
    expect(editing.onRename).toHaveBeenCalledWith([1], '本期')
  })
})

describe('column groups while edited', () => {
  it('lays the headers out over every column of the chart, so one the result leaves out keeps its place', () => {
    const data: QueryResult = { columns: [{ name: 'region', type: 'string', role: 'dimension', label: '大区' }, { name: 'revenue', type: 'integer', role: 'measure', label: '销售额' }], rows: [['East', 10]] }
    // A dynamic dimension left empty comes first, outside every group.
    const editing = { columns: ['dyn', 'region', 'revenue'], selected: [], onSelect: vi.fn(), onRenameStart: vi.fn(), onRename: vi.fn() }
    render(<Visualization viz={{ type: 'table', columnGroups: [{ label: '地区', columns: ['region'] }] }} result={data} aria-label="sales" locale="en-US" headerEditing={editing} />)
    const table = screen.getByRole('table', { name: 'sales' })
    expect(within(table).getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['地区', '销售额', '大区'])
    fireEvent.click(within(table).getByRole('columnheader', { name: '地区' }))
    expect(editing.onSelect).toHaveBeenCalledWith([1], false)
  })
})

describe('paging a table', () => {
  const rows = (count: number) => Array.from({ length: count }, (_, i) => [i < 25 ? 'East' : 'West', i + 1])
  const data = (count: number, truncated = false): QueryResult => ({
    columns: [{ name: 'region', type: 'string', role: 'dimension' }, { name: 'n', type: 'integer', role: 'measure' }],
    rows: rows(count),
    totals: [{ by: [], columns: [{ name: 'n', type: 'integer', role: 'measure' }], rows: [[999]] }],
    meta: { truncated },
  })
  const body = (table: HTMLElement) => [...table.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent).join(' '))
  const pager = () => screen.getByRole('group', { name: 'sales · Pages' })

  it('shows a page of the rows at a time, the totals on each, and merges only within the page', () => {
    render(<Visualization viz={{ type: 'table', style: { paging: 'pages', pageSize: 20, merge: true } }} result={data(45)} aria-label="sales" locale="en-US" />)
    const table = screen.getByRole('table', { name: 'sales' })
    expect(body(table)).toHaveLength(20)
    expect(body(table)[0]).toBe('East 1')
    expect(pager().textContent).toContain('Rows 1–20 of 45')
    expect(pager().textContent).toContain('1 / 3')
    expect(within(pager()).getByRole<HTMLButtonElement>('button', { name: 'Previous page' }).disabled).toBe(true)
    fireEvent.click(within(pager()).getByRole('button', { name: 'Next page' }))
    // A run of East cut by the page is written again at the top of the next.
    expect(body(table)[0]).toBe('East 21')
    expect(table.querySelector('tbody td')!.getAttribute('rowspan')).toBe('5')
    expect(table.querySelector('tfoot')!.textContent).toContain('999')
    fireEvent.click(within(pager()).getByRole('button', { name: 'Next page' }))
    expect(body(table)).toEqual(['West 41', '42', '43', '44', '45'])
    expect(pager().textContent).toContain('Rows 41–45 of 45')
    expect(within(pager()).getByRole<HTMLButtonElement>('button', { name: 'Next page' }).disabled).toBe(true)
  })

  it('fits as many rows a page as the height has room for, and says when the query took only some', () => {
    // 200 pixels, less the bar (32), the header (33) and the totals (34), hold three rows of 33.
    render(<Visualization viz={{ type: 'table', style: { paging: 'auto' } }} result={data(10, true)} height={200} aria-label="sales" locale="en-US" />)
    expect(body(screen.getByRole('table', { name: 'sales' }))).toHaveLength(3)
    expect(pager().textContent).toContain('1 / 4')
    expect(pager().textContent).toContain('Rows 1–3; more rows matched than the limit, only the first 10 are shown')
  })

  it('keeps the page for the same rows again, the last there is when fewer, and starts again for rows that answer something else', () => {
    const viz = { type: 'table' as const, style: { paging: 'pages' as const, pageSize: 10 } }
    const { rerender } = render(<Visualization viz={viz} result={data(45)} pageKey="a" aria-label="sales" locale="en-US" />)
    fireEvent.click(within(pager()).getByRole('button', { name: 'Next page' }))
    fireEvent.click(within(pager()).getByRole('button', { name: 'Next page' }))
    fireEvent.click(within(pager()).getByRole('button', { name: 'Next page' }))
    expect(pager().textContent).toContain('4 / 5')
    rerender(<Visualization viz={viz} result={data(45)} pageKey="a" aria-label="sales" locale="en-US" />)
    expect(pager().textContent).toContain('4 / 5')
    rerender(<Visualization viz={viz} result={data(25)} pageKey="a" aria-label="sales" locale="en-US" />)
    expect(pager().textContent).toContain('3 / 3')
    rerender(<Visualization viz={viz} result={data(45)} pageKey="b" aria-label="sales" locale="en-US" />)
    expect(pager().textContent).toContain('1 / 5')
    rerender(<Visualization viz={viz} result={data(0)} pageKey="c" aria-label="sales" locale="en-US" />)
    expect(pager().textContent).toContain('No rows')
    expect(pager().textContent).toContain('1 / 1')
  })

  it('keeps the rows being read in view when automatic pages hold more or fewer rows, and writes page numbers as rows are', () => {
    const viz = { type: 'table' as const, style: { paging: 'auto' as const } }
    // 200 pixels hold three rows a page; turned twice, rows 7–9 are shown.
    const { rerender } = render(<Visualization viz={viz} result={data(1500)} height={200} pageKey="a" aria-label="sales" locale="en-US" />)
    fireEvent.click(within(pager()).getByRole('button', { name: 'Next page' }))
    fireEvent.click(within(pager()).getByRole('button', { name: 'Next page' }))
    expect(pager().textContent).toContain('Rows 7–9')
    expect(pager().textContent).toContain('3 / 500')
    // 332 pixels hold seven: the page with row 7 is the first.
    rerender(<Visualization viz={viz} result={data(1500)} height={332} pageKey="a" aria-label="sales" locale="en-US" />)
    expect(pager().textContent).toContain('Rows 1–7')
    expect(pager().textContent).toContain('1 / 215')
    rerender(<Visualization viz={{ type: 'table', style: { paging: 'pages', pageSize: 1 } }} result={data(1500)} pageKey="a" aria-label="sales" locale="en-US" />)
    expect(pager().textContent).toContain('7 / 1,500')
  })

  it('says the totals are of all the data when the query took fewer rows than there are', () => {
    const { rerender } = render(<Visualization viz={{ type: 'table' }} result={data(10, true)} aria-label="sales" locale="en-US" />)
    const foot = () => screen.getByRole('table', { name: 'sales' }).querySelector('tfoot')!.textContent
    expect(foot()).toContain('Total (all data)')
    rerender(<Visualization viz={{ type: 'table' }} result={data(10)} aria-label="sales" locale="en-US" />)
    expect(foot()).not.toContain('all data')
    expect(foot()).toContain('Total')
  })

  it('shows every row with no bar when not paged', () => {
    render(<Visualization viz={{ type: 'table' }} result={data(45)} aria-label="sales" locale="en-US" />)
    expect(body(screen.getByRole('table', { name: 'sales' }))).toHaveLength(45)
    expect(screen.queryByRole('group', { name: 'sales · Pages' })).toBeNull()
  })
})

describe('clickable chart categories', () => {
  it('emits raw values, including null and empty text, from bars', () => {
    globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
    const select = vi.fn()
    render(<Visualization viz={{ type: 'bar', x: 'region', y: ['amount'] }} result={result} aria-label="regions" onSelect={select} />)
    canvas.click?.({ dataIndex: 0, event: { event: { clientX: 30, clientY: 40 } } }); canvas.click?.({ dataIndex: 1 })
    // Where the pointer was, for what the value offers to open there; without one, the chart's corner.
    expect(select.mock.calls).toEqual([[null, { x: 30, y: 40 }], ['', { x: 0, y: 0 }]])
  })
  it('takes a click anywhere over a category of a line, where no point is drawn', () => {
    globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
    const select = vi.fn()
    render(<Visualization viz={{ type: 'line', x: 'region', y: ['amount'] }} result={result} aria-label="regions" onSelect={select} />)
    canvas.click?.({ dataIndex: 0 })
    expect(select).not.toHaveBeenCalled()
    canvas.plotClick?.({ offsetX: 140, offsetY: 10, event: { clientX: 300, clientY: 200 } })
    canvas.plotClick?.({ offsetX: 40, offsetY: 10, event: { clientX: 200, clientY: 200 } })
    expect(select.mock.calls).toEqual([['', { x: 300, y: 200 }]])
  })
  it('keeps null distinct from a literal dash in a chart with series', () => {
    globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
    const select = vi.fn()
    render(<Visualization viz={{ type: 'bar', x: 'region', y: ['amount'], series: 'series' }} result={{ columns: [...result.columns, { name: 'series', type: 'string', role: 'dimension' }], rows: [[null, 10, 's'], ['—', 20, 's']] }} aria-label="regions" onSelect={select} />)
    canvas.click?.({ dataIndex: 0 }); canvas.click?.({ dataIndex: 1 })
    expect(select.mock.calls.map(([value]) => value)).toEqual([null, '—'])
  })
  it('does not emit the synthetic Other pie slice', () => {
    globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
    const select = vi.fn()
    render(<Visualization viz={{ type: 'pie', x: 'region', y: ['amount'] }} result={{ ...result, rows: Array.from({ length: 10 }, (_, i) => [`r${i}`, 10 - i]) }} aria-label="regions" onSelect={select} />)
    canvas.click?.({ dataIndex: 7 })
    expect(select).not.toHaveBeenCalled()
    canvas.click?.({ dataIndex: 0 })
    expect(select).toHaveBeenCalledWith('r0', expect.anything())
  })
  it('makes only mapped table columns clickable, excluding totals', () => {
    const select = vi.fn()
    render(<Visualization viz={{ type: 'table' }} result={{ ...result, totals: [{ by: [], columns: result.columns, rows: [['Total', 60]] }] }} aria-label="regions" onCellSelect={select} selectableColumns={['region']} />)
    expect(screen.getAllByRole('button')).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: '—' }))
    fireEvent.click(screen.getByRole('button', { name: 'East' }))
    expect(select.mock.calls.map(([column, value]) => [column, value])).toEqual([['region', null], ['region', 'East']])
  })
})

describe('conditional formats', () => {
  const data: QueryResult = {
    columns: [
      { name: 'region', type: 'string', role: 'dimension' },
      { name: 'rate', type: 'float', role: 'measure', format: { style: 'percent' } },
    ],
    rows: [['East', 0.5], ['West', 0.9], ['North', 1.2], ['South', null]],
    totals: [{ by: [], columns: [{ name: 'rate', type: 'float', role: 'measure' }], rows: [[0.5]] }],
  }
  const highlights: Record<string, Highlight[]> = { rate: [{ op: 'lt', value: 0.8, color: 'red', icon: 'down' }, { op: 'gte', value: 1, color: 'green' }] }
  // The shade as the browser writes it back, which is not always as it was set.
  const shade = (hue: Hue) => {
    const probe = document.createElement('td')
    probe.style.background = highlightInk(hue, 'light', inkFor('light')).background
    return probe.style.background
  }
  const rate = (table: HTMLElement) => within(table).getAllByRole('row').slice(1).map((row) => within(row).queryAllByRole('cell').at(-1) as HTMLElement)

  it("shades a table's cells by the first rule they meet, with the rule's icon, and never the total", () => {
    render(<Visualization viz={{ type: 'table', style: { striped: true, highlights } }} result={data} aria-label="rates" locale="en-US" />)
    const [east, west, north, south, total] = rate(screen.getByRole('table', { name: 'rates' }))
    expect(east!.textContent).toBe('▼50%')
    expect(east!.style.background).toBe(shade('red'))
    expect(west!.textContent).toBe('90%')
    expect(west!.style.background).not.toBe(shade('red'))
    expect(north!.textContent).toBe('120%')
    expect(north!.style.background).toBe(shade('green'))
    expect(south!.style.background).not.toBe(shade('red'))
    expect(total!.textContent).toBe('50%')
    expect(total!.style.background).not.toBe(shade('red'))
  })

  it("shades a pivot table's cells, but not its totals", () => {
    render(<Visualization viz={{ type: 'pivot', rows: ['region'], y: ['rate'], style: { highlights } }} result={data} aria-label="rates" locale="en-US" />)
    const table = screen.getByRole('table', { name: 'rates' })
    const cells = within(table).getAllByRole('cell')
    expect(cells.map((cell) => cell.textContent)).toEqual(['▼50%', '90%', '120%', '—', '50%'])
    expect(cells[0]!.style.background).toBe(shade('red'))
    expect(cells[2]!.style.background).toBe(shade('green'))
    expect(cells[4]!.style.background).not.toBe(shade('red'))
  })

  it('leaves a column that is not a number as it is', () => {
    render(<Visualization viz={{ type: 'table', style: { highlights: { region: highlights.rate! } } }} result={data} aria-label="rates" locale="en-US" />)
    const regions = within(screen.getByRole('table', { name: 'rates' })).getAllByRole('cell').filter((cell) => cell.textContent === 'East')
    expect(regions[0]!.style.background).not.toBe(shade('red'))
  })
})
