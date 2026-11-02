import { describe, expect, it } from 'vitest'
import { indexOfCharacter } from './client'

describe('indexOfCharacter', () => {
  it('counts characters, of which some take two places in a string', () => {
    const sql = "SELECT '华东😀' AS a, nope"
    expect(indexOfCharacter(sql, 0)).toBe(0)
    expect(indexOfCharacter(sql, [...sql].indexOf('n'))).toBe(sql.indexOf('nope'))
    expect(indexOfCharacter(sql, 1000)).toBe(sql.length)
  })
})
