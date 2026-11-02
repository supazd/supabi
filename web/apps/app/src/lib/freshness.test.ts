import { describe, expect, it } from 'vitest'
import { fetchedAgo, freshLoads, freshLoadsBy } from './freshness'

describe('fetchedAgo', () => {
  const now = new Date('2026-10-17T09:00:00Z')
  const before = (ms: number) => new Date(now.getTime() - ms)
  it('says just now under a minute', () => {
    expect(fetchedAgo(before(59_000), now, 'en-US', 'just now')).toBe('just now')
  })
  it('counts minutes, then hours, then days', () => {
    expect(fetchedAgo(before(3 * 60_000), now, 'en-US', '')).toBe('3 minutes ago')
    expect(fetchedAgo(before(125 * 60_000), now, 'en-US', '')).toBe('2 hours ago')
    expect(fetchedAgo(before(50 * 3_600_000), now, 'en-US', '')).toBe('2 days ago')
    expect(fetchedAgo(before(3 * 60_000), now, 'zh-CN', '')).toBe('3分钟前')
  })
})

describe('freshLoads', () => {
  it('asks again only for the load a refresh starts, and repeats of it', () => {
    const fresh = freshLoads('0')
    expect(fresh('0', 'a')).toBe(false)
    expect(fresh('1', 'a')).toBe(true)
    // React running the effect a second time, or a retry after a failure.
    expect(fresh('1', 'a')).toBe(true)
    // A filter changed after the refresh: kept results will do.
    expect(fresh('1', 'b')).toBe(false)
    expect(fresh('1', 'a')).toBe(false)
    expect(fresh('2', 'a')).toBe(true)
  })
  it('keeps each list apart', () => {
    const fresh = freshLoadsBy('0')
    expect(fresh('region', '1', 'x')).toBe(true)
    expect(fresh('channel', '1', 'x')).toBe(true)
    expect(fresh('region', '1', 'y')).toBe(false)
    expect(fresh('channel', '0', 'x')).toBe(true)
  })
})
