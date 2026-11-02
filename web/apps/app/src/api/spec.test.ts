import { describe, expect, it } from 'vitest'
import { aggsFor, fieldFromColumn, isColumn, labelProblems, makeKey, referencedBy, toStoredExpr, toWrittenExpr, uniqueLabel, validLabel, withRole, type SpecField } from './spec'

const field = (key: string, label: string, patch: Partial<SpecField> = {}): SpecField => ({ key, label, expr: key, type: 'string', role: 'dimension', ...patch })

describe('makeKey', () => {
  it('normalises names into valid keys', () => {
    const taken = new Set<string>()
    expect(makeKey('Region Name', taken)).toBe('region_name')
    expect(makeKey('2024_sales', taken)).toBe('f_2024_sales')
    expect(makeKey('__x__', taken)).toBe('x')
    expect(makeKey('金额 amount（元）', taken)).toBe('amount')
  })

  it('falls back to a random key when nothing of the name survives', () => {
    const taken = new Set<string>()
    expect(makeKey('地区', taken, () => 'k3x9q2')).toBe('f_k3x9q2')
    expect(makeKey('销售额', taken)).toMatch(/^f_[a-z0-9]{6}$/)
  })

  it('never returns a key that is taken', () => {
    const taken = new Set(['amount'])
    expect(makeKey('amount', taken)).toBe('amount_2')
    expect(makeKey('AMOUNT', taken)).toBe('amount_3')
  })
})

describe('fieldFromColumn', () => {
  const from = (name: string, type: SpecField['type']) => fieldFromColumn({ name, type }, new Set(), [])

  it('makes numbers measures, and everything else a dimension', () => {
    expect(from('amount', 'decimal')).toEqual({ key: 'amount', label: 'amount', column: 'amount', type: 'decimal', role: 'measure' })
    expect(from('region', 'string')).toEqual({ key: 'region', label: 'region', column: 'region', type: 'string', role: 'dimension' })
    expect(from('created_at', 'timestamp').role).toBe('dimension')
  })

  it('keeps identifiers as dimensions although they are numbers', () => {
    expect(from('id', 'integer').role).toBe('dimension')
    expect(from('user_id', 'integer').role).toBe('dimension')
    expect(from('paid', 'integer').role).toBe('measure')
  })

  it('gives the field a name no other field has', () => {
    expect(fieldFromColumn({ name: 'Region', type: 'string' }, new Set(), [field('r', 'region')]).label).toBe('Region 2')
  })
})

describe('withRole', () => {
  it('makes only a number a measure', () => {
    expect(withRole(field('amount', '金额', { type: 'decimal' }), 'measure').role).toBe('measure')
    expect(withRole(field('region', '地区'), 'measure').role).toBe('dimension')
    // A measure whose type changed to text becomes a dimension.
    expect(withRole(field('amount', '金额', { role: 'measure' }), 'measure')).toEqual(field('amount', '金额'))
  })

  it('leaves a dimension and a metric without aggregation', () => {
    expect(withRole(field('amount', '金额', { role: 'measure' }), 'dimension')).toEqual(field('amount', '金额'))
    expect(withRole(field('ratio', '比率', { role: 'measure' }), 'metric')).toEqual(field('ratio', '比率', { role: 'metric' }))
  })

  it('keeps the part of a format that fits a new type', () => {
    const money = { decimals: 2, prefix: '¥' }
    expect(withRole(field('amount', '金额', { type: 'integer', format: money }), 'measure').format).toEqual(money)
    // A number that becomes a date, or a date a number, starts without a format.
    expect(withRole(field('amount', '金额', { type: 'date', format: money }), 'dimension').format).toBeUndefined()
    expect(withRole(field('at', '时间', { type: 'integer', format: { date: 'chinese' } }), 'dimension').format).toBeUndefined()
    expect(withRole(field('at', '时间', { type: 'string', format: { date: 'chinese' } }), 'dimension').format).toBeUndefined()
    // A date has no time of day to write.
    expect(withRole(field('at', '时间', { type: 'date', format: { date: 'slash', time: 'minute' } }), 'dimension').format).toEqual({ date: 'slash' })
    expect(withRole(field('at', '时间', { type: 'date', format: { time: 'minute' } }), 'dimension').format).toBeUndefined()
    expect(withRole(field('at', '时间', { type: 'timestamp', format: { time: 'minute' } }), 'dimension').format).toEqual({ time: 'minute' })
  })

  it('knows which aggregations a type takes', () => {
    expect(aggsFor('decimal')).toHaveLength(6)
    expect(aggsFor('string')).toEqual(['count', 'count_distinct', 'min', 'max'])
    expect(aggsFor('boolean')).toEqual(['count', 'count_distinct'])
  })
})

describe('names', () => {
  it('accepts any script, and rejects braces, line breaks, outer spaces and overlong names', () => {
    for (const good of ['订单金额', 'Order amount', 'a', '名'.repeat(100)]) expect(validLabel(good)).toBe(true)
    for (const bad of ['', ' a', 'a ', 'a}b', 'a{b', 'a\nb', '名'.repeat(101)]) expect(validLabel(bad)).toBe(false)
  })

  it('finds names that are malformed or used twice, ignoring case', () => {
    const problems = labelProblems([field('a', 'Region'), field('b', 'region'), field('c', ''), field('d', '金额')])
    expect([...problems]).toEqual([
      ['a', 'duplicate'],
      ['b', 'duplicate'],
      ['c', 'invalid'],
    ])
  })

  it('numbers a name that is taken', () => {
    const fields = [field('a', '金额'), field('b', '金额 2')]
    expect(uniqueLabel('金额', fields)).toBe('金额 3')
    expect(uniqueLabel('地区', fields)).toBe('地区')
  })
})

describe('expressions', () => {
  const fields = [field('amount', '订单金额'), field('user_id', '用户 ID'), field('f_k3x9q2', 'Status')]

  it('is written with names and stored with internal IDs', () => {
    const written = 'SUM(${订单金额}) / NULLIF(COUNT(DISTINCT ${用户 ID}), 0)'
    const stored = 'SUM(${amount}) / NULLIF(COUNT(DISTINCT ${user_id}), 0)'
    expect(toStoredExpr(written, fields)).toEqual({ expr: stored, unknown: [] })
    expect(toWrittenExpr(stored, fields)).toBe(written)
  })

  it('matches names ignoring case and spaces around them', () => {
    expect(toStoredExpr("CASE WHEN ${ status } = 'paid' THEN ${订单金额} END", fields).expr).toBe("CASE WHEN ${f_k3x9q2} = 'paid' THEN ${amount} END")
  })

  it('reports names that match no field, and leaves them in place', () => {
    expect(toStoredExpr('${订单金额} + ${运费} + ${amount}', fields)).toEqual({ expr: '${amount} + ${运费} + ${amount}', unknown: ['运费', 'amount'] })
  })

  it('follows a field through a change of name', () => {
    const renamed = fields.map((item) => (item.key === 'amount' ? { ...item, label: '金额' } : item))
    expect(toWrittenExpr('${amount} * 2', renamed)).toBe('${金额} * 2')
  })

  it('leaves an ID no field has as it is', () => {
    expect(toWrittenExpr('${gone} + 1', fields)).toBe('${gone} + 1')
  })

  it('finds what refers to a field', () => {
    const all = [...fields, field('tier', '档位', { expr: 'CASE WHEN ${amount} > 100 THEN 1 END' }), field('self', '自己', { expr: '${self}' })]
    expect(referencedBy('amount', all).map((item) => item.key)).toEqual(['tier'])
    expect(referencedBy('self', all)).toEqual([])
  })
})

describe('isColumn', () => {
  it('goes by what the field says it reads, never by what the name looks like', () => {
    expect(isColumn({ column: 'amount' })).toBe(true)
    expect(isColumn({ column: '订单 金额 (元)' })).toBe(true)
    expect(isColumn({})).toBe(false)
  })

  it('proposes a field that reads the column under the name the source gives it', () => {
    const field = fieldFromColumn({ name: '订单 金额 (元)', type: 'decimal' }, new Set(), [])
    expect(field.column).toBe('订单 金额 (元)')
    expect(field.expr).toBeUndefined()
  })
})
