// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../i18n'
import i18n from 'i18next'
import type { QueryResult } from '../api/client'
import { QueryDiagnostics } from './QueryDiagnostics'

const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
const writeText = vi.fn<(text: string) => Promise<void>>()
beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  writeText.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
})
afterEach(() => {
  cleanup()
  if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard)
  else Reflect.deleteProperty(navigator, 'clipboard')
})

function result(requestId = 'qry_first'): QueryResult {
  const base = { by: [], args: ['North', null, false, 2], cached: false, shared: false, durationMs: 5, fetchedAt: '2026-10-18T12:30:00Z', rowCount: 1, truncated: false }
  return {
    columns: [{ name: 'region', label: 'Region', type: 'string', role: 'dimension' }],
    rows: [['North']], meta: { durationMs: 15, cached: false, truncated: true },
    diagnostics: {
      requestId, requestedAt: '2026-10-18T12:31:00Z',
      statements: [
        { ...base, kind: 'main', sql: 'SELECT region FROM orders WHERE region = $1 LIMIT 2', truncated: true },
        { ...base, kind: 'total', sql: 'SELECT SUM(amount) FROM orders WHERE region = $1', cached: true },
        { ...base, kind: 'subtotal', by: ['region'], sql: 'SELECT region, SUM(amount) FROM orders GROUP BY region', args: [], shared: true },
      ],
    },
  }
}

function choose(name: RegExp) {
  fireEvent.click(within(screen.getByRole('tablist', { name: 'Query statement' })).getByRole('tab', { name }))
}

const panel = () => screen.getByRole('tabpanel')
// The editor wraps highlighted words in their own elements once it has parsed the SQL.
const sql = () => screen.getByRole('region', { name: 'SQL' })

describe('query diagnostics', () => {
  it('lists every statement and shows each one with its own SQL, arguments, cache state and truncation', async () => {
    render(<QueryDiagnostics result={result()} stale={false} running={false} notice={null} />)
    expect(screen.getByText('qry_first')).toBeTruthy()
    expect(screen.getByText('Statements').nextSibling!.textContent).toBe('3')
    expect(screen.getByText('15 ms')).toBeTruthy()
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      '1Main query5 msDatabase queryResult truncated',
      '2Grand total5 msCache hit',
      '3Subtotal · by Region5 msShared query',
    ])
    expect(within(panel()).getByText('Result truncated')).toBeTruthy()
    expect(within(panel()).getByText('Database query')).toBeTruthy()
    expect(within(panel()).getByText('1 row')).toBeTruthy()
    await waitFor(() => expect(sql().textContent).toContain(result().diagnostics!.statements[0]!.sql))
    const values = within(screen.getByRole('region', { name: 'Bound arguments' })).getAllByRole('listitem').map((item) => item.querySelector('code')!.textContent)
    expect(values).toEqual(['"North"', 'null', 'false', '2'])
    choose(/Grand total/)
    expect(within(panel()).getByText('Cache hit')).toBeTruthy()
    expect(within(panel()).queryByText('Result truncated')).toBeNull()
    expect(screen.getByText(/original database duration/)).toBeTruthy()
    await waitFor(() => expect(sql().textContent).toContain(result().diagnostics!.statements[1]!.sql))
    choose(/Subtotal/)
    expect(within(panel()).getByText('Shared query')).toBeTruthy()
    expect(within(screen.getByRole('region', { name: 'Bound arguments' })).getByText('No bound arguments')).toBeTruthy()
  })

  it('moves between statements with the arrow keys', () => {
    render(<QueryDiagnostics result={result()} stale={false} running={false} notice={null} />)
    const tabs = screen.getAllByRole('tab')
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowDown' })
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tabs[1])
    fireEvent.keyDown(tabs[1]!, { key: 'End' })
    expect(tabs[2]!.getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(tabs[2]!, { key: 'ArrowDown' })
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true')
  })

  it('shows a single statement without a statement list', () => {
    const data = result()
    data.diagnostics!.statements = data.diagnostics!.statements.slice(0, 1)
    render(<QueryDiagnostics result={data} stale={false} running={false} notice={null} />)
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.getByText('Main query')).toBeTruthy()
  })

  it('copies exact SQL and typed JSON arguments separately and reports clipboard errors', async () => {
    const data = result()
    render(<QueryDiagnostics result={data} stale={false} running={false} notice={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy SQL' }))
    expect(await within(screen.getByRole('region', { name: 'SQL' })).findByText('Copied')).toBeTruthy()
    expect(writeText).toHaveBeenLastCalledWith(data.diagnostics!.statements[0]!.sql)
    fireEvent.click(screen.getByRole('button', { name: 'Copy arguments' }))
    expect(await within(screen.getByRole('region', { name: 'Bound arguments' })).findByText('Copied')).toBeTruthy()
    expect(JSON.parse(writeText.mock.calls.at(-1)![0])).toEqual(['North', null, false, 2])
    writeText.mockRejectedValueOnce(new Error('Permission denied'))
    fireEvent.click(screen.getByRole('button', { name: 'Copy SQL' }))
    expect(await screen.findByText('Could not copy SQL. Select the text and copy it manually.')).toBeTruthy()
  })

  it('labels previous results during edits, reruns and cancellation, and resets the selected statement with a new result', async () => {
    const data = result()
    const view = render(<QueryDiagnostics result={data} stale running notice={null} />)
    expect(screen.getByText(/Query running/)).toBeTruthy()
    choose(/Subtotal/)
    view.rerender(<QueryDiagnostics result={data} stale running={false} notice="cancelled" />)
    expect(screen.getByText(/Query cancelled/)).toBeTruthy()
    expect(within(panel()).getByText('Shared query')).toBeTruthy()
    view.rerender(<QueryDiagnostics result={data} stale running={false} notice={null} />)
    expect(screen.getByText(/configuration has changed/)).toBeTruthy()
    view.rerender(<QueryDiagnostics result={result('qry_second')} stale={false} running={false} notice={null} />)
    await waitFor(() => expect(screen.getAllByRole('tab')[0]!.getAttribute('aria-selected')).toBe('true'))
    expect(screen.queryByText('qry_first')).toBeNull()
    expect(screen.queryByText(/configuration has changed/)).toBeNull()
  })

  it('explains missing diagnostics, failed queries and totals that were not executed', () => {
    const view = render(<QueryDiagnostics stale={false} running={false} notice={null} />)
    expect(screen.getByText(/Run the chart to see/)).toBeTruthy()
    view.rerender(<QueryDiagnostics stale={false} running={false} notice="failed" />)
    expect(screen.getByText(/query failed/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Copy SQL' })).toBeNull()
    const data = result()
    delete data.diagnostics
    view.rerender(<QueryDiagnostics result={data} stale={false} running={false} notice={null} />)
    expect(screen.getByText(/This result has no diagnostics/)).toBeTruthy()
    const omitted = result()
    omitted.meta.totalsOmitted = true
    omitted.diagnostics!.statements = omitted.diagnostics!.statements.slice(0, 1)
    view.rerender(<QueryDiagnostics result={omitted} stale={false} running={false} notice={null} />)
    expect(screen.getByText('No totals: the chart filters on aggregated results.')).toBeTruthy()
    expect(screen.getByText('Statements').nextSibling!.textContent).toBe('1')
  })
})
