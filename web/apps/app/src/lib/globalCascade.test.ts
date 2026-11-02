import { describe, expect, it } from 'vitest'
import { cascadeComponent, validGlobalCascade, type FilterField, type GlobalFilter } from './filters'

const fields = ['w1', 'w2', 'w3'].map((item) => ({target: {item, field: 'region'}, aggregate: false}) as FilterField)
const filter = (id: string, items: string[], optionsFrom: string, dependsOn: string[] = []): GlobalFilter => ({
  id, label: id, op: 'in', control: {type: 'select'}, targets: items.map((item) => ({item, field: 'region'})), optionsFrom, dependsOn,
})

describe('global cascade source mappings', () => {
  it('requires both directions to cover each option source', () => {
    const parent = filter('parent', ['w1', 'w2'], 'w1')
    const child = filter('child', ['w2'], 'w2', ['parent'])
    expect(validGlobalCascade([parent, child], fields)).toBe(false)
    expect(validGlobalCascade([parent, {...child, targets: parent.targets}], fields)).toBe(true)
  })

  it('checks ancestors and sibling branches throughout the connected group', () => {
    const root = filter('root', ['w1'], 'w1')
    const middle = filter('middle', ['w1', 'w2'], 'w1', ['root'])
    const child = filter('child', ['w1', 'w2'], 'w2', ['middle'])
    const sibling = filter('sibling', ['w1'], 'w1', ['root'])
    const graph = [root, middle, child, sibling, filter('independent', ['w3'], 'w3')]
    expect(cascadeComponent(graph, 'child').map((entry) => entry.id)).toEqual(['root', 'middle', 'child', 'sibling'])
    expect(validGlobalCascade(graph, fields)).toBe(false)
    root.targets.push({item: 'w2', field: 'region'})
    expect(validGlobalCascade(graph, fields)).toBe(false)
    sibling.targets.push({item: 'w2', field: 'region'})
    expect(validGlobalCascade(graph, fields)).toBe(true)
  })

  it('rejects aggregate mappings anywhere in a cascade, stale parents and cycles', () => {
    const parent = filter('parent', ['w1', 'w2'], 'w1')
    const child = filter('child', ['w1', 'w2'], 'w1', ['parent'])
    expect(validGlobalCascade([parent, child], fields.map((entry) => ({...entry, aggregate: entry.target.item === 'w2'})))).toBe(false)
    expect(validGlobalCascade([child], fields)).toBe(false)
    expect(validGlobalCascade([{...parent, dependsOn: ['child']}, child], fields)).toBe(false)
  })
})
