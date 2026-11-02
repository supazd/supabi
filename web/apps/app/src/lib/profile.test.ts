import { describe, expect, it } from 'vitest'
import { profileColumn } from './profile'

describe('profileColumn', () => {
  it('counts what is absent and what differs, and samples what is seen most', () => {
    const rows = [['web'], ['app'], [null], ['app'], ['store'], ['app'], ['web'], [undefined]]
    expect(profileColumn(rows, 0, 2)).toEqual({ total: 8, nulls: 2, distinct: 3, samples: ['app', 'web'] })
  })

  it('keeps the order values were seen in when they are as frequent', () => {
    expect(profileColumn([[3], [1], [2]], 0).samples).toEqual([3, 1, 2])
  })

  it('tells a number from the text that writes it', () => {
    expect(profileColumn([[1], ['1']], 0).distinct).toBe(2)
  })

  it('describes no rows as nothing', () => {
    expect(profileColumn([], 0)).toEqual({ total: 0, nulls: 0, distinct: 0, samples: [] })
  })
})
