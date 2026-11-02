import { useState } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FilterOptions } from '../components/FilterControl'
import type { ChartFilter } from './filters'
import { useCascadeChange } from './cascade'

afterEach(cleanup)
const filters: ChartFilter[] = [
  { id: 'region', field: 'region', op: 'in', control: { type: 'select' }, value: ['North'] },
  { id: 'city', field: 'city', op: 'in', control: { type: 'select' }, value: ['Alpha'], dependsOn: ['region'] },
  { id: 'status', field: 'status', op: 'in', control: { type: 'select' } },
  { id: 'category', field: 'category', op: 'in', control: { type: 'select' } },
  { id: 'product', field: 'product', op: 'in', control: { type: 'select' }, dependsOn: ['category'] },
]
function setup(skip?: (filter: ChartFilter) => boolean) {
  const finish: Record<string, (answer: FilterOptions) => void> = {}
  const load = vi.fn((parent: ChartFilter) => new Promise<FilterOptions>((resolve) => { finish[parent.id] = resolve }))
  const committed = vi.fn()
  const hook = renderHook(({context}) => {
    const [values, setValues] = useState<Record<string, unknown>>({})
    const cascade = useCascadeChange({ filters, values, commit: (next) => { committed(next); setValues(next) }, load, context, skip })
    return {values, ...cascade}
  }, {initialProps: {context: 'initial'}})
  const choose = (id: string, value: unknown) => act(() => { void hook.result.current.change(filters.find((filter) => filter.id === id)!, value) })
  const resolve = (id: string, values: unknown[]) => act(async () => { finish[id]!({values, truncated: false}) })
  return {...hook, choose, resolve, committed, load}
}

describe('concurrent cascade choices', () => {
  it('merges an independent choice with the inferred parent without committing an unresolved child', async () => {
    const {result, choose, resolve, committed, load} = setup()
    choose('city', ['Beta'])
    expect(result.current.shown('city', ['Alpha'])).toEqual(['Beta'])
    choose('status', ['Open'])
    expect(result.current.values).toEqual({status: ['Open']})
    expect(result.current.shown('city', ['Alpha'])).toEqual(['Beta'])
    await resolve('region', ['South'])
    expect(result.current.values).toEqual({region: ['South'], city: ['Beta'], status: ['Open']})
    expect(load).toHaveBeenCalledTimes(1)
    expect(committed.mock.calls.some(([values]) => values.city?.[0] === 'Beta' && values.region?.[0] !== 'South')).toBe(false)
  })

  it.each([['region', 'category'], ['category', 'region']])('merges independent cascades when %s finishes before %s', async (first, second) => {
    const {result, choose, resolve} = setup()
    choose('city', ['Beta'])
    choose('product', ['Book'])
    const answers: Record<string, string[]> = {region: ['South'], category: ['Reading']}
    await resolve(first, answers[first]!)
    await resolve(second, answers[second]!)
    expect(result.current.values).toEqual({region: ['South'], city: ['Beta'], category: ['Reading'], product: ['Book']})
  })

  it('discards a late child lookup after a new parent selection', async () => {
    const {result, choose, resolve} = setup()
    choose('city', ['Beta'])
    choose('region', ['North'])
    await resolve('region', ['South'])
    expect(result.current.values).toEqual({region: ['North'], city: null})
    expect(result.current.shown('city', null)).toBeNull()
  })

  it('discards all pending lookups when their query context changes', async () => {
    const {result, choose, resolve, rerender, committed} = setup()
    choose('city', ['Beta'])
    choose('product', ['Book'])
    rerender({context: 'different dataset'})
    await resolve('region', ['South'])
    await resolve('category', ['Reading'])
    expect(result.current.values).toEqual({})
    expect(result.current.shown('city', ['Alpha'])).toEqual(['Alpha'])
    expect(committed).not.toHaveBeenCalled()
  })

  it('keeps the local parent value available when a global filter owns its inference', () => {
    const {result, choose, load} = setup((filter) => filter.id === 'region')
    choose('region', ['North'])
    choose('city', ['Beta'])
    expect(result.current.values).toEqual({region: ['North'], city: ['Beta']})
    expect(load).not.toHaveBeenCalled()
  })
})
