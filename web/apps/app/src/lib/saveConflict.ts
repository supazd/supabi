import { canonicalJSON } from './datasetHistory'

export type SaveContent = { name: string; description: string; spec: Record<string, unknown>; datasourceId?: string }
export type SaveSection = 'name' | 'description' | 'definition'
export type SaveChoice = 'local' | 'latest'
export type SaveChoices = Partial<Record<SaveSection, SaveChoice>>
export const saveSections: SaveSection[] = ['name', 'description', 'definition']
export type MergeChoices = Partial<Record<string, SaveChoice>>
export type MergeEntry = {
  id: string
  section: SaveSection | 'source' | 'fields' | 'field' | 'order'
  field?: string
  property?: string
  note?: 'structure' | 'presence' | 'unmatched'
  base: unknown
  local: unknown
  latest: unknown
  change: ReturnType<typeof valueChange>
}
export type SaveMerge = { entries: MergeEntry[]; resolve: (choices: MergeChoices) => SaveContent }

export function valueChange(base: unknown, local: unknown, latest: unknown) {
  const a = canonicalJSON(base), b = canonicalJSON(local), c = canonicalJSON(latest)
  if (a === b && b === c) return 'same'
  if (b === c) return 'both'
  if (a === b) return 'latest'
  if (a === c) return 'local'
  return 'conflict'
}

export function mergeEntry(id: string, section: MergeEntry['section'], base: unknown, local: unknown, latest: unknown): MergeEntry {
  return { id, section, base, local, latest, change: valueChange(base, local, latest) }
}

export function mergeSuggestions(entries: MergeEntry[]): MergeChoices {
  return Object.fromEntries(entries.flatMap(({ id, change }) => change === 'conflict' ? [] : [[id, change === 'local' ? 'local' : 'latest']]))
}

export function mergeValue(entry: MergeEntry, choices: MergeChoices): unknown {
  const choice = choices[entry.id]
  if (choice !== 'local' && choice !== 'latest') throw new Error('Unresolved save conflict')
  return entry[choice]
}

export type SaveDifference = true | { [key: string]: SaveDifference }

/** A display projection only. Arrays stay complete so order and removals are visible. */
export function saveDifferences(...values: unknown[]): SaveDifference | undefined {
  if (values.every((value) => canonicalJSON(value) === canonicalJSON(values[0]))) return undefined
  if (values.every((value) => value == null || typeof value === 'object' && !Array.isArray(value))) {
    const objects = values.map((value) => (value ?? {}) as Record<string, unknown>)
    const keys = [...new Set(objects.flatMap(Object.keys))]
    const entries = keys.flatMap((key) => {
      const difference = saveDifferences(...objects.map((value) => value[key]))
      return difference === undefined ? [] : [[key, difference]]
    })
    if (entries.length) return Object.fromEntries(entries) as SaveDifference
  }
  return true
}

export function sectionValue(content: SaveContent, section: SaveSection): unknown {
  if (section !== 'definition') return content[section]
  // Chart queries/styles and dashboard layout/filter/link references move
  // together. Datasets use the more specific field merge plan instead.
  return { ...(content.datasourceId === undefined ? {} : { datasourceId: content.datasourceId }), ...content.spec }
}

export function sectionChange(base: SaveContent, local: SaveContent, latest: SaveContent, section: SaveSection) {
  return valueChange(sectionValue(base, section), sectionValue(local, section), sectionValue(latest, section))
}

export function saveMerge(base: SaveContent, local: SaveContent, latest: SaveContent): SaveMerge {
  return {
    entries: saveSections.map((section) => mergeEntry(section, section, sectionValue(base, section), sectionValue(local, section), sectionValue(latest, section))),
    resolve: (choices) => resolveSave(local, latest, choices),
  }
}

export function suggestedChoices(base: SaveContent, local: SaveContent, latest: SaveContent): SaveChoices {
  return Object.fromEntries(saveSections.flatMap((section) => {
    const change = sectionChange(base, local, latest, section)
    return change === 'conflict' ? [] : [[section, change === 'local' ? 'local' : 'latest']]
  }))
}

/** No unresolved choices or recursive JSON merge can reach an editor. */
export function resolveSave(local: SaveContent, latest: SaveContent, choices: SaveChoices): SaveContent {
  if (saveSections.some((section) => !choices[section])) throw new Error('Unresolved save conflict')
  const source = choices.definition === 'local' ? local : latest
  return {
    name: (choices.name === 'local' ? local : latest).name,
    description: (choices.description === 'local' ? local : latest).description,
    spec: source.spec,
    ...(source.datasourceId === undefined ? {} : { datasourceId: source.datasourceId }),
  }
}
