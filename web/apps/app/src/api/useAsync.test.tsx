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
})
