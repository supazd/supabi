import { describe, expect, it } from 'vitest'
import { verticalCompactor, type LayoutItem } from 'react-grid-layout'
import { gridColumnGap, gridCompactor } from './gridCompactor'

const tiles = [
  { i: 'a', x: 0, y: 5, w: 48, h: 32 },
  { i: 'b', x: 48, y: 8, w: 48, h: 32 },
  { i: 'c', x: 0, y: 40, w: 96, h: 16 },
]

describe('grid spacing and compaction', () => {
  it('uses the existing compactor for the original defaults', () => {
    expect(gridCompactor(true, 0)).toBe(verticalCompactor)
  })
  it('compacts with extra clearance while preserving actual tile heights', () => {
    const compactor = gridCompactor(true, 3)
    const result = compactor.compact(tiles, 96)
    expect(result.map(({ y, h }) => ({ y, h }))).toEqual([{ y: 0, h: 32 }, { y: 0, h: 32 }, { y: 35, h: 16 }])
    expect(compactor.compact(result, 96)).toEqual(result)
    expect(tiles[0]!.y).toBe(5)
  })
  it('preserves authored empty rows and only moves colliding tiles downward', () => {
    const compactor = gridCompactor(false, 5)
    const result = compactor.compact([...tiles, { i: 'd', x: 0, y: 10000, w: 96, h: 16 }], 96)
    expect(result.map(({ y }) => y)).toEqual([5, 8, 45, 10000])
    expect(compactor.compact(result, 96)).toEqual(result)
  })
  it.each([true, false])('maintains clearance across irregular overlapping layouts (compact %s)', (auto) => {
    let seed = 17
    const next = () => (seed = (seed * 48271) % 2147483647)
    const input: LayoutItem[] = Array.from({ length: 100 }, (_, i) => ({ i: String(i), x: next() % 80, y: next() % 300, w: 16, h: 16 + next() % 32 }))
    const compactor = gridCompactor(auto, 4)
    const result = compactor.compact(input, 96)
    for (let a = 0; a < result.length; a++) for (let b = a + 1; b < result.length; b++) {
      const one = result[a]!, two = result[b]!
      if (one.x < two.x + two.w && two.x < one.x + one.w) expect(one.y + one.h + 4 <= two.y || two.y + two.h + 4 <= one.y).toBe(true)
    }
    expect(compactor.compact(result, 96)).toEqual(result)
  })
  it('keeps column widths positive with large gaps on narrow canvases', () => {
    expect(gridColumnGap(1200, 96, 1.5)).toBe(1.5)
    const gap = gridColumnGap(320, 192, 24)
    expect((320 - 191 * gap) / 192).toBeGreaterThanOrEqual(1)
  })
})
