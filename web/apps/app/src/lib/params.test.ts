import { describe, expect, it } from 'vitest'
import { draftsFor, paramNames, withoutText, remember, toDraft, toParam, validDefault, withMulti, type ParamDraft } from './params'

const draft = (patch: Partial<ParamDraft>): ParamDraft => ({ name: 'p', type: 'string', text: '', rest: {}, ...patch })

describe('paramNames', () => {
  it('finds the parameters of the SQL, once each, in the order they appear', () => {
    const sql = 'SELECT * FROM t WHERE dt >= {{since}} [[ AND region IN {{ regions }} ]] AND dt < {{until}} OR dt = {{since}}'
    expect(paramNames(sql)).toEqual({ names: ['since', 'regions', 'until'], invalid: [] })
  })

  it('sets apart what cannot be a name', () => {
    expect(paramNames('{{Since}} {{1st}} {{ok_1}} {{}} {{a b}}')).toEqual({ names: ['ok_1'], invalid: ['Since', '1st', '', 'a b'] })
    expect(paramNames("SELECT '{}' AS j, arr[1]")).toEqual({ names: [], invalid: [] })
  })
})

describe('what is not SQL', () => {
  const names = (sql: string) => paramNames(sql).names

  it('names no parameter: a string, a quoted name, a comment', () => {
    // A string that says {{status}}, which may be a value the data has.
    expect(paramNames("WHERE status = '{{status}}'")).toEqual({ names: [], invalid: [] })
    expect(names("WHERE name LIKE '%{{word}}%' AND status = {{status}}")).toEqual(['status'])
    expect(names("WHERE a = 'it''s {{word}}' AND status = {{status}}")).toEqual(['status'])
    expect(names('SELECT "{{a}}", `{{b}}` FROM t WHERE status = {{status}}')).toEqual(['status'])
    expect(names('WHERE status = {{status}} -- AND day = {{day}}\nAND region = {{region}}')).toEqual(['status', 'region'])
    expect(names('WHERE status = {{status}} /* AND day = {{day}} */ AND region = {{region}}')).toEqual(['status', 'region'])
    expect(paramNames("WHERE a = '{{Bad Name}}'").invalid).toEqual([])
  })

  it('is told apart from SQL the way the server tells it', () => {
    expect(names("WHERE a = '--' AND status = {{status}}")).toEqual(['status'])
    expect(names("WHERE a = '/*' AND status = {{status}} -- don't")).toEqual(['status'])
    expect(names("WHERE a = '' AND status = {{status}}")).toEqual(['status'])
    // Never closed: text to the end.
    expect(names("WHERE status = {{status}} AND a = '{{word}}")).toEqual(['status'])
    expect(names('WHERE status = {{status}} /* {{day}}')).toEqual(['status'])
  })

  it('keeps every position', () => {
    const sql = "SELECT '{{a}}', \"b\" -- c\nFROM t /* d */ WHERE x = {{x}}"
    const blanked = withoutText(sql)
    expect(blanked).toHaveLength(sql.length)
    expect(blanked.indexOf('{{x}}')).toBe(sql.indexOf('{{x}}'))
    expect(blanked).not.toContain('{{a}}')
  })
})

describe('defaults', () => {
  it('are stored as a value of the parameter’s type', () => {
    expect(toParam(draft({ text: ' 华东 ' }))).toEqual({ name: 'p', type: 'string', default: '华东' })
    expect(toParam(draft({ type: 'integer', text: '-12' }))).toEqual({ name: 'p', type: 'integer', default: -12 })
    expect(toParam(draft({ type: 'float', text: '1.5e3' }))).toEqual({ name: 'p', type: 'float', default: 1500 })
    // A decimal keeps every digit it was written with.
    expect(toParam(draft({ type: 'decimal', text: '10000000000000000.01' }))).toEqual({ name: 'p', type: 'decimal', default: '10000000000000000.01' })
    expect(toParam(draft({ type: 'boolean', text: 'false' }))).toEqual({ name: 'p', type: 'boolean', default: false })
    expect(toParam(draft({ type: 'date', text: '2026-01-31' }))).toEqual({ name: 'p', type: 'date', default: '2026-01-31' })
    expect(toParam(draft({ type: 'timestamp', text: '2026-01-31 08:30' }))).toEqual({ name: 'p', type: 'timestamp', default: '2026-01-31 08:30' })
  })

  it('can be a day worked out when the query runs', () => {
    expect(toParam(draft({ type: 'date', text: 'today' }))).toEqual({ name: 'p', type: 'date', default: { relative: 'today' } })
    expect(toParam(draft({ type: 'date', text: 'today - 1d' }))).toEqual({ name: 'p', type: 'date', default: { relative: 'today-1d' } })
  })

  it('are left out when nothing is typed, and refused when it is not a value of the type', () => {
    expect(toParam(draft({ type: 'integer', text: '  ' }))).toEqual({ name: 'p', type: 'integer' })
    for (const [type, text] of [['integer', '1.5'], ['integer', 'abc'], ['float', 'abc'], ['decimal', '1e3'], ['boolean', 'yes'], ['date', '2026-13-01'], ['date', 'yesterday'], ['date', 'today-1'], ['timestamp', '08:30']] as const) {
      expect(validDefault(draft({ type, text })), `${type} ${text}`).toBe(false)
    }
  })

  it('take several values or one', () => {
    const one = toDraft({ name: 'regions', type: 'string', label: '地区', default: '华东' })
    const several = withMulti({ ...one, text: '华东, 华南, ' }, true)
    expect(toParam(several)).toEqual({ name: 'regions', type: 'string', label: '地区', multi: true, default: ['华东', '华南'] })
    expect(toParam(withMulti({ ...several, text: '1, x', type: 'integer' }, true))).toBeUndefined()
    // Taking one again leaves no trace of having taken several.
    expect(toParam(withMulti({ ...several, text: '华东' }, false))).toEqual({ name: 'regions', type: 'string', label: '地区', default: '华东' })
  })

  it('keep what this page does not edit, and round-trip', () => {
    const stored = { name: 'regions', type: 'string' as const, label: '地区', multi: true, required: true, default: ['华东', '华南'] }
    expect(toDraft(stored)).toEqual({ name: 'regions', type: 'string', text: '华东, 华南', rest: { label: '地区', multi: true, required: true } })
    expect(toParam(toDraft(stored))).toEqual(stored)
    const relative = { name: 'since', type: 'date' as const, default: { relative: 'today-30d' } }
    expect(toDraft(relative).text).toBe('today-30d')
    expect(toParam(toDraft(relative))).toEqual(relative)
    expect(toParam(toDraft({ name: 'n', type: 'integer' }))).toEqual({ name: 'n', type: 'integer' })
  })
})

describe('draftsFor and remember', () => {
  it('follow the SQL, keeping what was said about a name that comes back', () => {
    let known: ParamDraft[] = []
    expect(draftsFor('SELECT {{a}}, {{b}}', known)).toEqual([draft({ name: 'a' }), draft({ name: 'b' })])
    known = remember(known, draft({ name: 'b', type: 'integer', text: '3' }))
    expect(draftsFor('SELECT {{b}}, {{a}}', known).map((item) => `${item.name}:${item.type}:${item.text}`)).toEqual(['b:integer:3', 'a:string:'])
    // Gone from the SQL, it is not shown; back again, it is as it was.
    expect(draftsFor('SELECT {{a}}', known).map((item) => item.name)).toEqual(['a'])
    expect(draftsFor('SELECT {{b}}', known)[0]).toMatchObject({ type: 'integer', text: '3' })
    known = remember(known, draft({ name: 'b', type: 'date', text: 'today' }))
    expect(known).toHaveLength(1)
  })
})
