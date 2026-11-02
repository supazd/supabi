import { describe, expect, it } from 'vitest'
import { datasetSaveMerge } from './datasetSaveConflict'
import { mergeSuggestions, type SaveContent, type SaveMerge } from './saveConflict'

const amount = { key: 'amount', label: 'Amount', column: 'amount', type: 'decimal', role: 'measure', description: 'Gross revenue' }
const region = { key: 'region', label: 'Region', column: 'region', type: 'string', role: 'dimension' }
const date = { key: 'date', label: 'Date', column: 'date', type: 'date', role: 'dimension' }
const dataset = (fields: Record<string, unknown>[]): SaveContent => ({ name: 'Orders', description: '', datasourceId: 'warehouse', spec: { specVersion: 1, source: { type: 'sql', sql: 'select * from orders' }, fields } })
const auto = (plan: SaveMerge) => plan.resolve(mergeSuggestions(plan.entries))
const conflicts = (plan: SaveMerge) => plan.entries.filter((entry) => entry.change === 'conflict')

describe('dataset field merge', () => {
  it('combines different attributes of one field and edits to other fields', () => {
    const base = dataset([amount, region])
    const local = dataset([{ ...amount, label: 'Revenue', format: { decimals: 2 } }, region])
    const latest = dataset([{ ...amount, description: 'Net of discounts', hidden: true }, { ...region, label: 'Sales region' }])
    const plan = datasetSaveMerge(base, local, latest)
    expect(conflicts(plan)).toEqual([])
    expect(auto(plan).spec.fields).toEqual([{ ...amount, label: 'Revenue', format: { decimals: 2 }, description: 'Net of discounts', hidden: true }, { ...region, label: 'Sales region' }])
  })

  it('requires a choice only for the same property changed differently', () => {
    const plan = datasetSaveMerge(dataset([amount]), dataset([{ ...amount, label: 'Revenue', hidden: true }]), dataset([{ ...amount, label: 'Total', description: 'Latest description' }]))
    const [conflict] = conflicts(plan)
    expect(conflicts(plan)).toHaveLength(1)
    expect(conflict!.property).toBe('label')
    expect(() => auto(plan)).toThrow('Unresolved save conflict')
    const result = plan.resolve({ ...mergeSuggestions(plan.entries), [conflict!.id]: 'latest' })
    expect(result.spec.fields).toEqual([{ ...amount, label: 'Total', hidden: true, description: 'Latest description' }])
  })

  it('accepts identical changes and preserves an explicit property removal', () => {
    const initial = { ...amount, hidden: true, format: { style: 'number', decimals: 2 } }
    const cleared: Record<string, unknown> = { ...initial }
    for (const property of ['description', 'hidden', 'format']) delete cleared[property]
    const plan = datasetSaveMerge(dataset([initial]), dataset([{ ...cleared, label: 'Revenue' }]), dataset([{ ...initial, label: 'Revenue' }]))
    expect(auto(plan).spec.fields).toStrictEqual([{ ...cleared, label: 'Revenue' }])
    expect(plan.entries.find((entry) => entry.property === 'label')!.change).toBe('both')
  })

  it('does not recursively combine different number format settings', () => {
    const initial = { ...amount, format: { style: 'number', decimals: 2 } }
    const local = { ...initial, format: { style: 'percent', decimals: 2 } }
    const latest = { ...initial, format: { style: 'number', decimals: 0 } }
    const plan = datasetSaveMerge(dataset([initial]), dataset([local]), dataset([latest]))
    expect(conflicts(plan).map((entry) => entry.property)).toEqual(['format'])
    expect(plan.resolve({ ...mergeSuggestions(plan.entries), [conflicts(plan)[0]!.id]: 'local' }).spec.fields).toEqual([local])
  })

  it('keeps source, SQL, parameters and unmodeled dataset settings in a single group', () => {
    const base = dataset([amount])
    base.spec.params = [{ name: 'region', default: 'East' }]
    base.spec.cache = { ttlSeconds: 30 }
    const local = { ...dataset([{ ...amount, label: 'Revenue' }]), spec: { ...base.spec, source: { type: 'sql', sql: 'select * from orders where region = {{region}}' }, fields: [{ ...amount, label: 'Revenue' }] } }
    const latest = { ...base, datasourceId: 'other-warehouse', spec: { ...base.spec, params: [{ name: 'region', default: 'West' }], cache: { ttlSeconds: 60 }, fields: [{ ...amount, hidden: true }] } }
    const plan = datasetSaveMerge(base, local, latest)
    expect(conflicts(plan).map((entry) => entry.section)).toEqual(['source'])
    const result = plan.resolve({ ...mergeSuggestions(plan.entries), source: 'latest' })
    expect(result).toEqual({ ...latest, spec: { ...latest.spec, fields: [{ ...amount, label: 'Revenue', hidden: true }] } })
  })

  it('merges a source change with independent field attributes without dropping unknown metadata', () => {
    const field = { ...amount, synonyms: ['Sales'], extension: { enabled: true } }
    const base = dataset([field])
    base.spec.cache = { ttlSeconds: 30 }
    const local = { ...base, spec: { ...base.spec, fields: [{ ...field, hidden: true }] } }
    const latest = { ...base, spec: { ...base.spec, source: { type: 'sql', sql: 'select * from orders where amount > 0' } } }
    expect(auto(datasetSaveMerge(base, local, latest))).toEqual({ ...latest, spec: { ...latest.spec, fields: [{ ...field, hidden: true }] } })
  })

  it.each([
    { type: 'string', role: 'dimension' },
    { column: undefined, expr: '${amount} * 2', syntax: 'standard' },
    { column: 'net_amount' },
    { extension: { changed: true } },
  ])('chooses an entire field when its definition changes: %j', (changes) => {
    const local = { ...amount, ...changes }
    const latest = { ...amount, label: 'Revenue' }
    const plan = datasetSaveMerge(dataset([amount, region]), dataset([local, { ...region, hidden: true }]), dataset([latest, region]))
    expect(conflicts(plan)).toHaveLength(1)
    expect(conflicts(plan)[0]).toMatchObject({ section: 'field', note: 'structure' })
    expect(conflicts(plan)[0]!.property).toBeUndefined()
    expect(plan.resolve({ ...mergeSuggestions(plan.entries), [conflicts(plan)[0]!.id]: 'latest' }).spec.fields).toEqual([latest, { ...region, hidden: true }])
  })

  it('merges independent additions and an unmodified field deletion while retaining their position', () => {
    const local = { key: 'local', label: 'Local', expr: '1', type: 'integer', role: 'dimension' }
    const remote = { key: 'remote', label: 'Remote', expr: '2', type: 'integer', role: 'dimension' }
    const plan = datasetSaveMerge(dataset([amount, region, date]), dataset([amount, local, date]), dataset([amount, region, remote, date]))
    expect(conflicts(plan)).toEqual([])
    expect(auto(plan).spec.fields).toEqual([amount, remote, local, date])
  })

  it.each(['local', 'latest'] as const)('requires an explicit delete-versus-edit choice, with deletion on %s', (deleted) => {
    const edited = { ...amount, hidden: true }
    const sides = deleted === 'local' ? [[], [edited]] : [[edited], []]
    const plan = datasetSaveMerge(dataset([amount]), dataset(sides[0]!), dataset(sides[1]!))
    expect(conflicts(plan)).toHaveLength(1)
    expect(conflicts(plan)[0]).toMatchObject({ section: 'field', note: 'presence' })
    const choices = mergeSuggestions(plan.entries), id = conflicts(plan)[0]!.id
    expect(plan.resolve({ ...choices, [id]: deleted }).spec.fields).toEqual([])
    expect(plan.resolve({ ...choices, [id]: deleted === 'local' ? 'latest' : 'local' }).spec.fields).toEqual([edited])
  })

  it('does not merge different fields added with the same identity', () => {
    const plan = datasetSaveMerge(dataset([]), dataset([amount]), dataset([{ ...amount, column: 'net_amount' }]))
    expect(conflicts(plan)).toHaveLength(1)
    expect(() => auto(plan)).toThrow('Unresolved save conflict')
    const identical = datasetSaveMerge(dataset([]), dataset([amount]), dataset([amount]))
    expect(auto(identical).spec.fields).toEqual([amount])
  })

  it('matches fields by key through reorder and rename, keeping independent attributes', () => {
    const plan = datasetSaveMerge(dataset([amount, region, date]), dataset([date, { ...amount, label: 'Revenue' }, region]), dataset([{ ...amount, hidden: true }, region, date]))
    expect(auto(plan).spec.fields).toEqual([date, { ...amount, label: 'Revenue', hidden: true }, region])
  })

  it('requires an order choice for incompatible reorders without losing field edits', () => {
    const plan = datasetSaveMerge(dataset([amount, region, date]), dataset([region, amount, { ...date, hidden: true }]), dataset([amount, date, { ...region, label: 'Area' }]))
    expect(conflicts(plan).map((entry) => entry.section)).toEqual(['order'])
    expect(plan.resolve({ ...mergeSuggestions(plan.entries), order: 'latest' }).spec.fields).toEqual([amount, { ...date, hidden: true }, { ...region, label: 'Area' }])
  })

  it.each([{ fields: [amount, amount] }, { fields: [{ label: 'No identity' }] }])('falls back to the entire list for ambiguous field identities: %j', ({ fields }) => {
    const base = dataset([amount])
    const local = dataset(fields)
    const latest = dataset([{ ...amount, hidden: true }])
    const plan = datasetSaveMerge(base, local, latest)
    expect(conflicts(plan).map((entry) => entry.section)).toEqual(['fields'])
    expect(plan.resolve({ ...mergeSuggestions(plan.entries), fields: 'latest' }).spec.fields).toEqual(latest.spec.fields)
  })

  it('does not mutate any input or share mutable fields with the resolved draft', () => {
    const base = dataset([amount]), local = dataset([{ ...amount, label: 'Revenue' }]), latest = dataset([{ ...amount, format: { decimals: 2 } }])
    const before = structuredClone([base, local, latest])
    const result = auto(datasetSaveMerge(base, local, latest))
    const fields = result.spec.fields as { format: { decimals: number } }[]
    fields[0]!.format.decimals = 0
    expect([base, local, latest]).toEqual(before)
  })
})
