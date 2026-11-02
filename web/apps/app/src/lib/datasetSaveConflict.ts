import { canonicalJSON } from './datasetHistory'
import { mergeEntry, mergeValue, sectionValue, type MergeChoices, type MergeEntry, type SaveContent, type SaveMerge } from './saveConflict'

type Field = Record<string, unknown> & { key: string }
// These attributes do not change how a field is computed. Format stays one
// property: its style, precision and units must not be combined recursively.
const attributes = ['label', 'description', 'format', 'hidden']
const definition = (field: Field) => Object.fromEntries(Object.entries(field).filter(([key]) => !attributes.includes(key)))
const withoutFields = (content: SaveContent): SaveContent => ({ ...content, spec: Object.fromEntries(Object.entries(content.spec).filter(([key]) => key !== 'fields')) })

function fieldMap(value: unknown): Map<string, Field> | undefined {
  if (!Array.isArray(value)) return
  const fields = new Map<string, Field>()
  for (const field of value) {
    if (!field || typeof field !== 'object' || Array.isArray(field) || typeof field.key !== 'string' || !field.key || fields.has(field.key)) return
    fields.set(field.key, field as Field)
  }
  return fields
}

/** Keep the chosen order, inserting fields unique to the other side beside
 * their next surviving neighbour (or at the end). Never drop a retained field. */
function fieldOrder(preferred: string[], other: string[], retained: Set<string>): string[] {
  const result = preferred.filter((key) => retained.has(key))
  for (let i = 0; i < other.length; i++) {
    const key = other[i]!
    if (!retained.has(key) || result.includes(key)) continue
    const next = other.slice(i + 1).find((key) => result.includes(key))
    result.splice(next === undefined ? result.length : result.indexOf(next), 0, key)
  }
  return result
}

/** A three-way merge by stable field identity, with conservative boundaries
 * for source configuration, field definitions, and additions/deletions. */
export function datasetSaveMerge(base: SaveContent, local: SaveContent, latest: SaveContent): SaveMerge {
  const entries: MergeEntry[] = (['name', 'description'] as const).map((key) => mergeEntry(key, key, base[key], local[key], latest[key]))
  const configs = [base, local, latest].map(withoutFields)
  const source = mergeEntry('source', 'source', ...configs.map((content) => sectionValue(content, 'definition')) as [unknown, unknown, unknown])
  entries.push(source)
  const [original, mine, theirs] = [base, local, latest].map((content) => fieldMap(content.spec.fields))
  let resolveFields: (choices: MergeChoices) => unknown

  if (!original || !mine || !theirs) {
    // An invalid/legacy identity cannot safely be matched by label or position.
    const fields = { ...mergeEntry('fields', 'fields', base.spec.fields, local.spec.fields, latest.spec.fields), note: 'unmatched' as const }
    entries.push(fields)
    resolveFields = (choices) => mergeValue(fields, choices)
  } else {
    const keys = [...new Set([...original.keys(), ...theirs.keys(), ...mine.keys()])]
    const resolvers = keys.map((key) => {
      const a = original.get(key), b = mine.get(key), c = theirs.get(key)
      const field = String(a?.label || b?.label || c?.label || key)
      const id = JSON.stringify(['field', key])
      const complete = a && b && c
      const stable = complete && canonicalJSON(definition(a)) === canonicalJSON(definition(b)) && canonicalJSON(definition(a)) === canonicalJSON(definition(c))
      if (!stable) {
        const entry: MergeEntry = { ...mergeEntry(id, 'field', a, b, c), field, note: complete ? 'structure' : 'presence' }
        entries.push(entry)
        return (choices: MergeChoices) => mergeValue(entry, choices) as Field | undefined
      }
      const properties = attributes.map((property) => ({ ...mergeEntry(JSON.stringify(['field', key, property]), 'field', a[property], b[property], c[property]), field, property }))
      entries.push(...properties)
      return (choices: MergeChoices) => {
        const result = { ...a }
        for (const entry of properties) {
          const value = mergeValue(entry, choices)
          if (value === undefined) delete result[entry.property]
          else result[entry.property] = value
        }
        return result
      }
    })

    // Membership changes have their own entries. Compare the order of common
    // original fields so independent additions/deletions are not false conflicts.
    const common = new Set([...original.keys()].filter((key) => mine.has(key) && theirs.has(key)))
    const orders = [original, mine, theirs].map((fields) => [...fields.keys()].filter((key) => common.has(key)))
    const order = mergeEntry('order', 'order', orders[0], orders[1], orders[2])
    entries.push({ ...order, base: orders[0]!.map((key) => original.get(key)!.label || key), local: orders[1]!.map((key) => original.get(key)!.label || key), latest: orders[2]!.map((key) => original.get(key)!.label || key) })
    resolveFields = (choices) => {
      mergeValue(order, choices)
      const fields = new Map(resolvers.flatMap((resolve) => {
        const field = resolve(choices)
        return field ? [[field.key, field] as const] : []
      }))
      const [preferred, other] = choices.order === 'local' ? [mine, theirs] : [theirs, mine]
      return fieldOrder([...preferred.keys()], [...other.keys()], new Set(fields.keys())).map((key) => fields.get(key)!)
    }
  }

  return {
    entries,
    resolve: (choices) => {
      // Validate every choice before constructing the result, including source
      // selection. No unresolved group may silently default to the latest side.
      entries.forEach((entry) => mergeValue(entry, choices))
      const selected = choices.source === 'local' ? configs[1]! : configs[2]!
      const fields = resolveFields(choices)
      return structuredClone({
        name: mergeValue(entries[0]!, choices) as string,
        description: mergeValue(entries[1]!, choices) as string,
        ...(selected.datasourceId === undefined ? {} : { datasourceId: selected.datasourceId }),
        spec: { ...selected.spec, ...(fields === undefined ? {} : { fields }) },
      })
    },
  }
}
