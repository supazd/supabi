import { describe, expect, it } from 'vitest'
import { historyLimit, recorded, type SqlRun } from './sqlHistory'

const run = (sql: string, at: number, datasourceId = 'a'): SqlRun => ({ sql, datasourceId, at })

describe('the history of what was run', () => {
  it('lists the newest first', () => {
    expect(recorded([run('select 1', 1)], run('select 2', 2)).map((past) => past.sql)).toEqual(['select 2', 'select 1'])
  })

  it('lists SQL run again once, where it was last run', () => {
    const history = recorded([run('select 2', 2), run('select 1', 1)], run('select 1', 3))
    expect(history.map((past) => [past.sql, past.at])).toEqual([['select 1', 3], ['select 2', 2]])
    // Against another data source it is another run.
    expect(recorded(history, run('select 1', 4, 'b'))).toHaveLength(3)
  })

  it('forgets the oldest beyond its limit', () => {
    let history: SqlRun[] = []
    for (let i = 0; i < historyLimit + 5; i++) history = recorded(history, run(`select ${i}`, i))
    expect(history).toHaveLength(historyLimit)
    expect(history.at(-1)!.sql).toBe('select 5')
  })
})
