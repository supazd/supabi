import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAsync } from './useAsync'

afterEach(cleanup)

describe('useAsync', () => {
  it('loads nothing while it waits, loads once it stops, and then never waits again', async () => {
    const answers: ((value: string) => void)[] = []
    const load = vi.fn(() => new Promise<string>((resolve) => { answers.push(resolve) }))
    const { result, rerender } = renderHook(({ wait, dep }) => useAsync(load, [dep], { wait }), { initialProps: { wait: true, dep: 1 } })
    expect(load).not.toHaveBeenCalled()
    expect(result.current.status).toBe('loading')
    rerender({ wait: true, dep: 2 })
    expect(load).not.toHaveBeenCalled()

    rerender({ wait: false, dep: 2 })
    expect(load).toHaveBeenCalledTimes(1)
    // Waiting again neither drops the answer on its way nor holds back the next load.
    rerender({ wait: true, dep: 2 })
    await act(async () => answers[0]!('first'))
    expect(result.current).toMatchObject({ status: 'ok', data: 'first' })
    expect(load).toHaveBeenCalledTimes(1)
    rerender({ wait: true, dep: 3 })
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('aborts a load that is no longer wanted, and does not report it as failed', async () => {
    const signals: AbortSignal[] = []
    const answers: ((value: string) => void)[] = []
    const load = vi.fn((signal: AbortSignal) => {
      signals.push(signal)
      return new Promise<string>((resolve, reject) => {
        answers.push(resolve)
        signal.addEventListener('abort', () => reject(new Error('aborted')))
      })
    })
    const { result, rerender, unmount } = renderHook(({ dep }) => useAsync(load, [dep]), { initialProps: { dep: 1 } })
    expect(signals[0]!.aborted).toBe(false)
    // Changed conditions: the load for the old ones stops.
    await act(async () => rerender({ dep: 2 }))
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false])
    expect(result.current.status).toBe('loading')
    await act(async () => answers[1]!('second'))
    expect(result.current).toMatchObject({ status: 'ok', data: 'second' })
    // The same conditions again ask for nothing, and stop nothing.
    rerender({ dep: 2 })
    expect(load).toHaveBeenCalledTimes(2)
    await act(async () => rerender({ dep: 3 }))
    unmount()
    expect(signals[2]!.aborted).toBe(true)
  })
})
