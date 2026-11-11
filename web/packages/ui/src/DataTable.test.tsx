// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DataTable, type DataTableColumn } from './DataTable'

afterEach(cleanup)

interface Item {
  id: number
}

const columns: DataTableColumn<Item>[] = [{ key: 'id', title: 'Number', render: (row) => `row ${row.id}`, sort: (a, b) => a.id - b.id }]
const items = (count: number): Item[] => Array.from({ length: count }, (_, index) => ({ id: index + 1 }))
const table = (rows: Item[], pageKey?: unknown) => <DataTable columns={columns} rows={rows} rowKey={(row) => String(row.id)} pageSize={10} pageKey={pageKey} aria-label="Items" />
/** Goes forward to a page, a page at a time: only the pages beside the current one are offered. */
const goTo = (page: number) => {
  for (let at = 1; at < page; at++) fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
}
/** The table resets its own state a moment after what it is given changes, not as it renders. */
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
const current = () => screen.getByRole('navigation').querySelector('[aria-current="page"]')?.textContent

describe('DataTable', () => {
  it('stays on its page when it is given the same rows in a new array', async () => {
    const { rerender } = render(table(items(35)))
    goTo(3)
    expect(current()).toBe('3')
    expect(screen.getByText('row 21')).toBeTruthy()
    // As a page that filters or maps its rows on every render gives them.
    rerender(table(items(35)))
    await settle()
    expect(current()).toBe('3')
    expect(screen.getByText('row 21')).toBeTruthy()
  })

  it('goes to the last page there is when rows are taken away', async () => {
    const { rerender } = render(table(items(35)))
    goTo(4)
    expect(screen.getByText('row 31')).toBeTruthy()
    rerender(table(items(25)))
    await settle()
    expect(current()).toBe('3')
    expect(screen.getByText('row 21')).toBeTruthy()
    // With a page of rows or fewer there are no pages to choose from, and all of them show.
    rerender(table(items(8)))
    await settle()
    expect(screen.queryByRole('navigation')).toBeNull()
    expect(screen.getByText('row 1')).toBeTruthy()
    rerender(table(items(35)))
    await settle()
    expect(current()).toBe('1')
  })

  it('starts from the first page again when the rows are of something else', async () => {
    const { rerender } = render(table(items(35), 'first result'))
    goTo(3)
    rerender(table(items(35), 'first result'))
    await settle()
    expect(current()).toBe('3')
    rerender(table(items(35), 'second result'))
    await settle()
    expect(current()).toBe('1')
    expect(screen.getByText('row 1')).toBeTruthy()
  })

  it('starts from the first page again when the order changes', async () => {
    render(table(items(35)))
    goTo(3)
    fireEvent.click(screen.getByRole('button', { name: 'Number' }))
    await settle()
    expect(current()).toBe('1')
    expect(screen.getByText('row 1')).toBeTruthy()
  })
})
