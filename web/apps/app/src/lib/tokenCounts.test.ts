import { describe, expect, it } from 'vitest'
import { formatTokenCount, parseTokenCount } from './tokenCounts'

describe('parseTokenCount', () => {
  it('reads the units providers write, a K being a thousand', () => {
    expect(parseTokenCount('256K')).toBe(256_000)
    expect(parseTokenCount('1.0M')).toBe(1_000_000)
    expect(parseTokenCount('1.1M')).toBe(1_100_000)
    expect(parseTokenCount('1.5k')).toBe(1_500)
    expect(parseTokenCount(' 128 K ')).toBe(128_000)
  })

  it('reads plain numbers, with or without separators', () => {
    expect(parseTokenCount('131072')).toBe(131_072)
    expect(parseTokenCount('128,000')).toBe(128_000)
  })

  it('refuses what is not a positive whole number of tokens', () => {
    for (const text of ['', 'abc', '0', '0K', '12.5', '1.0005K', '-8K', '8G', '1.2.3K']) expect(parseTokenCount(text), text).toBeUndefined()
  })
})

describe('formatTokenCount', () => {
  it('writes the unit that fits, and the number plainly otherwise', () => {
    expect(formatTokenCount(1_000_000)).toBe('1M')
    expect(formatTokenCount(1_500_000)).toBe('1.5M')
    expect(formatTokenCount(256_000)).toBe('256K')
    expect(formatTokenCount(8_000)).toBe('8K')
    expect(formatTokenCount(131_072)).toBe('131,072')
    expect(formatTokenCount(1_048_576)).toBe('1,048,576')
    expect(formatTokenCount(500)).toBe('500')
  })

  it('writes what it reads back the same', () => {
    for (const n of [64_000, 1_000_000, 131_072, 32_768, 2_500]) expect(parseTokenCount(formatTokenCount(n))).toBe(n)
  })
})
