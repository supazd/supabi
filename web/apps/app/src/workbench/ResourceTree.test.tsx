import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from 'i18next'
import '../i18n'
import { chartDragType } from '../lib/layout'

const workspace = vi.hoisted(() => {
  const chart = { id: 'sales', name: 'Sales trend', description: '', datasetId: 'orders', revision: 1, vizType: 'bar', updatedAt: '', folderId: 'monthly' }
  return {
    resources: {
      charts: [chart, { ...chart, id: 'total', name: 'Order total', folderId: undefined }],
      datasets: [{ id: 'orders', name: 'Orders', folderId: 'source' }, { id: 'inventory', name: 'Inventory' }],
      folders: [
        { id: 'reports', kind: 'chart', name: 'Reports', private: false },
        { id: 'monthly', kind: 'chart', name: 'Monthly', parentId: 'reports', private: false },
        { id: 'source', kind: 'dataset', name: 'Sources', private: false },
      ],
    },
    reload: vi.fn(async () => undefined),
    post: vi.fn(async () => ({ data: {}, response: { ok: true, status: 200 } })),
  }
})
vi.mock('./context', async (original) => ({
  ...await original<typeof import('./context')>(),
  useWorkbench: () => ({ resources: workspace.resources, loaded: true, error: null, reload: workspace.reload }),
}))
vi.mock('../api/client', async (original) => ({
  ...await original<typeof import('../api/client')>(),
  api: { POST: workspace.post },
}))
import { ChartPalette } from './ChartPalette'
import { ResourceTree } from './ResourceTree'

afterEach(cleanup)
beforeEach(async () => {
  localStorage.clear()
  vi.clearAllMocks()
  await i18n.changeLanguage('en-US')
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
  window.matchMedia ??= (() => ({ matches: false, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined })) as never
})

function open(element: ReactNode, path = '/workbench/dashboards/board') {
  const router = createMemoryRouter([{ path: '*', element }], { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return router
}

function transfer() {
  const values = new Map<string, string>()
  return {
    get types() { return [...values.keys()] },
    setData: (type: string, value: string) => values.set(type, value),
    getData: (type: string) => values.get(type) ?? '',
    effectAllowed: '',
  }
}

describe('resource tree addition mode', () => {
  it('uses the chart folder hierarchy with add actions and no source resource actions or navigation', () => {
    const add = vi.fn()
    const router = open(<ChartPalette charts={workspace.resources.charts} used={new Set(['sales'])} onAdd={add} onAddEmpty={vi.fn()} />)
    const reports = screen.getByRole('treeitem', { name: 'Reports' })
    expect(reports.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('treeitem', { name: 'Monthly' })).toBeNull()
    fireEvent.click(reports)
    fireEvent.click(screen.getByRole('treeitem', { name: 'Monthly' }))
    const sales = screen.getByRole('treeitem', { name: 'Sales trend' })
    expect(sales.getAttribute('aria-level')).toBe('3')
    expect(within(sales).getByText('Added')).toBeTruthy()
    fireEvent.click(sales)
    expect(add).not.toHaveBeenCalled()
    fireEvent.click(within(sales).getByRole('button', { name: 'Add chart Sales trend' }))
    expect(add).toHaveBeenCalledWith('sales')
    expect(router.state.location.pathname).toBe('/workbench/dashboards/board')
    expect(screen.queryByRole('link', { name: 'Sales trend' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Actions|New folder/ })).toBeNull()
    expect(screen.queryByText('Drag a chart onto the canvas, or use + to add it.')).toBeNull()
    expect(reports.draggable).toBe(false)
  })

  it('searches collapsed folders and copies chart IDs without accepting resource moves', () => {
    open(<ChartPalette charts={workspace.resources.charts} used={new Set()} onAdd={vi.fn()} onAddEmpty={vi.fn()} />)
    const search = screen.getByRole('textbox', { name: 'Search charts' })
    fireEvent.change(search, { target: { value: 'sales' } })
    const sales = screen.getByRole('treeitem', { name: 'Sales trend' })
    expect(within(sales).getByText('Reports / Monthly')).toBeTruthy()
    const dataTransfer = transfer()
    fireEvent.dragStart(sales, { dataTransfer })
    expect(dataTransfer.getData(chartDragType)).toBe('sales')
    expect(dataTransfer.getData('text/plain')).toBe('Sales trend')
    expect(dataTransfer.getData('application/x-supabi-node')).toBe('')
    expect(dataTransfer.effectAllowed).toBe('copy')
    fireEvent.change(search, { target: { value: '' } })
    const reports = screen.getByRole('treeitem', { name: 'Reports' })
    expect(reports.getAttribute('aria-expanded')).toBe('false')
    const move = transfer()
    move.setData('application/x-supabi-node', JSON.stringify({ item: 'total' }))
    fireEvent.drop(reports, { dataTransfer: move })
    fireEvent.drop(screen.getByRole('tree'), { dataTransfer: move })
    expect(workspace.post).not.toHaveBeenCalled()
  })

  it('supports folder navigation and adding from the keyboard without changing the sidebar expansion state', () => {
    localStorage.setItem('supabi.workbench.expanded.chart', JSON.stringify(['reports', 'monthly']))
    const add = vi.fn()
    open(<ChartPalette charts={workspace.resources.charts} used={new Set()} onAdd={add} onAddEmpty={vi.fn()} />)
    const reports = screen.getByRole('treeitem', { name: 'Reports' })
    expect(reports.getAttribute('aria-expanded')).toBe('false')
    reports.focus()
    fireEvent.keyDown(reports, { key: 'ArrowRight' })
    fireEvent.keyDown(reports, { key: 'ArrowRight' })
    const monthly = screen.getByRole('treeitem', { name: 'Monthly' })
    expect(document.activeElement).toBe(monthly)
    fireEvent.keyDown(monthly, { key: 'ArrowRight' })
    fireEvent.keyDown(monthly, { key: 'ArrowRight' })
    const sales = screen.getByRole('treeitem', { name: 'Sales trend' })
    expect(document.activeElement).toBe(sales)
    fireEvent.keyDown(sales, { key: 'Enter' })
    expect(add).toHaveBeenCalledExactlyOnceWith('sales')
    fireEvent.keyDown(sales, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(monthly)
    fireEvent.keyDown(monthly, { key: 'ArrowLeft' })
    expect(screen.queryByRole('treeitem', { name: 'Sales trend' })).toBeNull()
    expect(JSON.parse(localStorage.getItem('supabi.workbench.expanded.chart')!)).toEqual(['reports', 'monthly'])
  })
})

describe('resource tree existing modes', () => {
  it('keeps sidebar links, management actions and move dragging', async () => {
    open(<ResourceTree kind="chart" />, '/workbench/charts/total')
    expect(screen.getByRole('button', { name: 'New folder' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Actions Order total' })).toBeTruthy()
    const total = screen.getByRole('link', { name: /Order total/ })
    expect(total.getAttribute('href')).toBe('/workbench/charts/total')
    expect(total.classList.contains('active')).toBe(true)
    const dataTransfer = transfer()
    fireEvent.dragStart(total, { dataTransfer })
    expect(dataTransfer.effectAllowed).toBe('move')
    expect(JSON.parse(dataTransfer.getData('application/x-supabi-node'))).toEqual({ item: 'total' })
    fireEvent.drop(screen.getByRole('button', { name: /^Reports/ }), { dataTransfer })
    await waitFor(() => expect(workspace.post).toHaveBeenCalledWith('/folders/move', { body: { kind: 'chart', id: 'total', folderId: 'reports' } }))
  })

  it('keeps dataset selection visible and read-only with independent keyboard expansion', () => {
    localStorage.setItem('supabi.workbench.expanded.dataset', '[]')
    const select = vi.fn()
    open(<ResourceTree kind="dataset" selection={{ value: 'orders', onSelect: select }} />)
    const source = screen.getByRole('treeitem', { name: 'Sources' })
    const orders = screen.getByRole('treeitem', { name: 'Orders' })
    expect(source.getAttribute('aria-expanded')).toBe('true')
    expect(orders.getAttribute('aria-selected')).toBe('true')
    expect(orders.draggable).toBe(false)
    fireEvent.keyDown(orders, { key: 'Enter' })
    expect(select).toHaveBeenCalledExactlyOnceWith('orders')
    fireEvent.keyDown(orders, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(source)
    fireEvent.keyDown(source, { key: 'ArrowLeft' })
    expect(screen.queryByRole('treeitem', { name: 'Orders' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Actions|New folder/ })).toBeNull()
    expect(localStorage.getItem('supabi.workbench.expanded.dataset')).toBe('[]')
    expect(workspace.post).not.toHaveBeenCalled()
  })
})
