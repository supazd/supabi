import { describe, expect, it } from 'vitest'
import { candidateFilter, draftOf, hasCondition, policyOf, simpleOf } from './policy'
import { logicalTypes } from '../api/spec'

describe('data permission drafts', () => {
  const policy = {
    unmatched: 'none' as const,
    rows: [{ subjects: [{ group: 'east' }], filter: { field: 'region', op: 'in', value: ['华东'] } }],
    columns: [{ fields: ['cost'], visibleTo: [{ group: 'finance' }] }],
  }

  it('round-trips a saved policy', () => {
    expect(policyOf(draftOf(policy))).toEqual(policy)
  })

  it('keeps incomplete conditions explicit rather than turning them into unrestricted grants', () => {
    const draft = draftOf(policy)
    draft.rows.push({ subjects: [{ user: 'li' }], filter: {} })
    expect(hasCondition(draft.rows[1]!.filter)).toBe(false)
    expect(policyOf(draft).rows[1]).toEqual({ subjects: [{ user: 'li' }], filter: {} })
    expect(policyOf(draft).rows[0]).toEqual(policy.rows[0])
  })

  it('edits one field equal to some values, and leaves other conditions as written', () => {
    expect(simpleOf(undefined)).toEqual({ values: [] })
    expect(simpleOf({ field: 'region', op: 'in', value: ['华东', '华南'] })).toEqual({ field: 'region', values: ['华东', '华南'] })
    expect(simpleOf({ field: 'region', op: 'eq', value: '华东' })).toEqual({ field: 'region', values: ['华东'] })
    expect(simpleOf({ op: 'or', args: [] })).toBeNull()
    expect(simpleOf({ field: 'amount', op: 'gt', value: 1 })).toBeNull()
  })

  it('takes a condition with a field and no value as unfinished', () => {
    expect(hasCondition(undefined)).toBe(false)
    expect(hasCondition({})).toBe(false)
    expect(hasCondition({ op: 'not', args: [{ op: 'false' }] })).toBe(false)
    expect(hasCondition({ field: 'region', op: 'not_in', value: [] })).toBe(false)
    expect(hasCondition({ field: 'region', op: 'in', value: [] })).toBe(false)
    expect(hasCondition({ field: 'region', op: 'in', value: ['华东'] })).toBe(true)
    expect(hasCondition({ op: 'or', args: [] })).toBe(false)
  })
})

describe('policy candidate searches', () => {
  it('keeps text searches as contains, including literal spaces', () => {
    expect(candidateFilter({ key: 'region', type: 'string' }, ' East ')).toEqual({ field: 'region', op: 'contains', value: ' East ' })
  })

  it.each([
    ['integer', '001001', 1001],
    ['integer', '-12', -12],
    ['decimal', '10000000000000000.01', '10000000000000000.01'],
    ['decimal', '1e3', '1e3'],
    ['float', '1.5e3', 1500],
    ['boolean', 'false', false],
    ['boolean', 'true', true],
    ['date', '2028-02-29', '2028-02-29'],
    ['timestamp', '2026-01-31 08:30', '2026-01-31T08:30'],
    ['timestamp', '2026-01-31T08:30:00.123456', '2026-01-31T08:30:00.123456'],
  ] as const)('searches %s using a typed exact value: %s', (type, search, value) => {
    expect(candidateFilter({ key: 'value', type }, search)).toEqual({ field: 'value', op: 'eq', value })
  })

  it.each([
    ['integer', '-'], ['integer', '1.5'], ['integer', '9007199254740992'],
    ['decimal', '.'], ['decimal', 'NaN'], ['float', '1e'], ['float', 'Infinity'],
    ['boolean', 'f'], ['date', '2026-02'], ['date', '2026-02-30'],
    ['timestamp', '2026-01-31T08:'], ['timestamp', '2026-01-31T24:00'],
  ] as const)('does not query incomplete or invalid %s input: %s', (type, search) => {
    expect(candidateFilter({ key: 'value', type }, search)).toBeNull()
  })

  it('leaves an empty search unfiltered for every field type', () => {
    for (const type of logicalTypes) expect(candidateFilter({ key: 'value', type }, '')).toBeUndefined()
  })
})
