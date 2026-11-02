// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { openPopup } from '@supabi/ui/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../i18n'
import i18n from 'i18next'
import type { Style } from '@supabi/charts'
import { ChartStyleSettings } from './ChartStyleSettings'

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  localStorage.clear()
})
afterEach(cleanup)

function settings(type: 'table' | 'pivot', style: Style | undefined, onStyle = vi.fn()) {
  render(<ChartStyleSettings type={type} style={style} onStyle={onStyle} measures={[]} split={false} stackable={false} stacked={false} onStacked={() => {}} lines={[]} rightAxis={[]} onCombo={() => {}} colorScheme="light" />)
  return onStyle
}

describe('table paging settings', () => {
  it('chooses how a table pages, and a page size only for pages of a size', async () => {
    const onStyle = settings('table', { striped: true })
    expect(screen.queryByRole('spinbutton', { name: 'Rows a page' })).toBeNull()
    openPopup(screen.getByRole('combobox', { name: 'Pages' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Pages' }))
    expect(onStyle).toHaveBeenLastCalledWith({ striped: true, paging: 'pages' })
    cleanup()

    settings('table', { paging: 'pages' }, onStyle)
    const size = screen.getByRole('spinbutton', { name: 'Rows a page' })
    // Rows come whole.
    fireEvent.change(size, { target: { value: '2.5' } })
    fireEvent.blur(size)
    expect(onStyle).toHaveBeenCalledTimes(1)
    fireEvent.change(size, { target: { value: '50' } })
    fireEvent.blur(size)
    expect(onStyle).toHaveBeenLastCalledWith({ paging: 'pages', pageSize: 50 })
    cleanup()

    settings('table', { paging: 'auto', pageSize: 50 }, onStyle)
    expect(screen.queryByRole('spinbutton', { name: 'Rows a page' })).toBeNull()
    expect(screen.getByText(/As many rows a page/)).toBeTruthy()
    openPopup(screen.getByRole('combobox', { name: 'Pages' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Show all' }))
    // The page size stays in the draft for when pages come back; the builder writes it only with them.
    expect(onStyle).toHaveBeenLastCalledWith({ pageSize: 50 })
  })

  it('offers no paging on a pivot table', () => {
    settings('pivot', undefined)
    expect(screen.queryByRole('combobox', { name: 'Pages' })).toBeNull()
  })
})
