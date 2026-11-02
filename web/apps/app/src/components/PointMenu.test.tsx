// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PointMenu } from './PointMenu'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('a menu opened where something was clicked', () => {
  it('offers its items, and gives the focus back to what had it when closed', async () => {
    vi.useFakeTimers()
    const chosen = vi.fn()
    const closed = vi.fn()
    render(<button type="button">North</button>)
    const value = screen.getByRole('button', { name: 'North' })
    value.focus()
    const { unmount } = render(<PointMenu at={{ x: 10, y: 20 }} items={[{ key: 'drill', label: 'Drill down to City', onSelect: chosen }]} onClose={closed} />)
    // The menu takes the focus while it is open.
    expect(document.activeElement).not.toBe(value)
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Drill down to City' }), { key: 'Escape' })
    expect(closed).toHaveBeenCalled()
    expect(chosen).not.toHaveBeenCalled()
    unmount()
    act(() => { vi.runAllTimers() })
    expect(document.activeElement).toBe(value)
  })
})
