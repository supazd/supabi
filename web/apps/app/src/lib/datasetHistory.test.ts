import { describe, expect, it } from 'vitest'
import { canonicalJSON, diffLines, revisionChanges, type Revision } from './datasetHistory'

const revision = (spec: Record<string, unknown>): Revision => ({ revision: 1, name: 'Orders', description: '', datasourceId: 'src', datasourceName: 'Warehouse', createdAt: '2026-10-18T00:00:00Z', spec: { source: { type: 'sql', sql: 'SELECT amount' }, fields: [], ...spec } })

describe('dataset history comparison', () => {
  it('compares field identities, preserves renames and reports formats, parameters and other settings', () => {
    const before = revision({ fields: [{ key: 'sales', label: 'Sales', type: 'decimal', format: { decimals: 2 } }, { key: 'gone', label: 'Old field' }], params: [{ name: 'region', label: 'Region', required: false }], cache: { ttlSeconds: 10 } })
    const after = revision({ fields: [{ key: 'sales', label: 'Revenue', type: 'decimal', hidden: true, format: { decimals: 4 } }, { key: 'new', label: 'New field' }], params: [{ name: 'region', label: 'Sales region', required: true }], cache: { ttlSeconds: 20 } })
    const changes = revisionChanges(before, after)
    expect(changes).toEqual(expect.arrayContaining([
      { section: 'field', name: 'Revenue', property: 'label', before: 'Sales', after: 'Revenue' },
      { section: 'field', name: 'Revenue', property: 'format', before: { decimals: 2 }, after: { decimals: 4 } },
      expect.objectContaining({ section: 'field', name: 'Old field', property: 'removed' }),
      expect.objectContaining({ section: 'field', name: 'New field', property: 'added' }),
      { section: 'field', name: 'Revenue', property: 'hidden', before: undefined, after: true },
      { section: 'parameter', name: 'Sales region', property: 'label', before: 'Region', after: 'Sales region' },
      { section: 'parameter', name: 'Sales region', property: 'required', before: false, after: true },
      { section: 'settings', property: 'cache', before: { ttlSeconds: 10 }, after: { ttlSeconds: 20 } },
    ]))
    expect(changes).toHaveLength(8)
  })

  it('ignores object key order and reports a change in field order', () => {
    expect(canonicalJSON({ a: 1, b: { x: 2, y: 3 } })).toBe(canonicalJSON({ b: { y: 3, x: 2 }, a: 1 }))
    const a = { key: 'a', label: 'First' }, b = { key: 'b', label: 'Second' }
    expect(revisionChanges(revision({ fields: [a, b] }), revision({ fields: [b, a] }))).toEqual([{ section: 'field', property: 'order', before: ['First', 'Second'], after: ['Second', 'First'] }])
  })
})

describe('SQL line comparison', () => {
  it('retains line numbers around an insertion and a replacement', () => {
    expect(diffLines('SELECT amount\nFROM orders\nWHERE paid\n', 'SELECT amount\nFROM orders\nWHERE paid = true\nORDER BY amount\n')).toEqual([
      { kind: 'same', text: 'SELECT amount', before: 1, after: 1 },
      { kind: 'same', text: 'FROM orders', before: 2, after: 2 },
      { kind: 'removed', text: 'WHERE paid', before: 3 },
      { kind: 'added', text: 'WHERE paid = true', after: 3 },
      { kind: 'added', text: 'ORDER BY amount', after: 4 },
      { kind: 'same', text: '', before: 4, after: 5 },
    ])
  })
  it.each([['', 'SELECT 1'], ['a\na\nb', 'a\nb\nb'], ['SELECT 1', ''], [Array.from({ length: 1100 }, (_, i) => `old ${i}`).join('\n'), Array.from({ length: 1100 }, (_, i) => `new ${i}`).join('\n')]])('retains both texts, including large replacements', (before, after) => {
    const diff = diffLines(before, after)
    expect(diff.filter((line) => line.kind !== 'added').map((line) => line.text).join('\n')).toBe(before)
    expect(diff.filter((line) => line.kind !== 'removed').map((line) => line.text).join('\n')).toBe(after)
  })
})
