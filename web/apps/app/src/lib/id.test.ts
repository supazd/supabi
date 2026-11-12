import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomId } from './id'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('a random ID', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('is a UUID where the browser makes one', () => {
    expect(randomId()).toMatch(uuid)
  })

  it('is one all the same over plain HTTP, where the browser has no randomUUID', () => {
    // What a page not served over HTTPS or from localhost is given.
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) })
    const made = Array.from({ length: 50 }, randomId)
    for (const id of made) expect(id).toMatch(uuid)
    expect(new Set(made).size).toBe(made.length)
  })
})
