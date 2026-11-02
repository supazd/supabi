import { describe, expect, it } from 'vitest'
import { resolveSave, saveDifferences, sectionChange, suggestedChoices, type SaveContent } from './saveConflict'

const base: SaveContent = { name: 'Revenue', description: 'Monthly', datasourceId: 'warehouse', spec: { fields: [{ key: 'amount', type: 'decimal' }], source: { sql: 'select amount from orders' } } }

describe('save conflict choices', () => {
  it('shows only changed configuration properties without hiding removals or array order', () => {
    expect(saveDifferences({ version: 1, style: { striped: true } }, { version: 1 }, { version: 1, allowExport: true })).toEqual({ style: { striped: true }, allowExport: true })
    expect(saveDifferences(['a', 'b'], ['b', 'a'], ['a', 'b'])).toBe(true)
    expect(saveDifferences({}, {}, {})).toBeUndefined()
  })
  it('preserves independent metadata changes and equal definitions with different key order', () => {
    const local = { ...base, name: 'Net revenue' }
    const latest = { ...base, description: 'Weekly', spec: { source: base.spec.source, fields: base.spec.fields } }
    const choices = suggestedChoices(base, local, latest)
    expect(resolveSave(local, latest, choices)).toEqual({ ...base, name: local.name, description: latest.description })
  })

  it('keeps the complete definition and its source together in the generic merge', () => {
    const local = { ...base, spec: { ...base.spec, source: { sql: 'select total from orders' } } }
    const latest = { ...base, datasourceId: 'new-source', spec: { ...base.spec, fields: [{ key: 'total', type: 'decimal' }] } }
    const choices = suggestedChoices(base, local, latest)
    expect(sectionChange(base, local, latest, 'definition')).toBe('conflict')
    expect(() => resolveSave(local, latest, choices)).toThrow()
    expect(resolveSave(local, latest, { ...choices, definition: 'latest' })).toEqual(latest)
    expect(resolveSave(local, latest, { ...choices, definition: 'local' })).toEqual(local)
  })

  it('never mixes a removed widget with another editor’s new filter referencing it', () => {
    const original = { name: 'Board', description: '', spec: { layout: { items: [{ id: 'w1' }] }, filters: [] } }
    const local = { ...original, spec: { layout: { items: [] }, filters: [] } }
    const latest = { ...original, spec: { ...original.spec, filters: [{ targets: [{ item: 'w1' }] }] } }
    expect(suggestedChoices(original, local, latest).definition).toBeUndefined()
    expect(resolveSave(local, latest, { name: 'latest', description: 'latest', definition: 'latest' }).spec).toEqual(latest.spec)
  })
})
