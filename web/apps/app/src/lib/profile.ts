// What a column of a result holds, said in a few numbers: for telling at a
// glance what a field is. It describes the rows it is given and no others.

export interface ColumnProfile {
  /** How many rows were looked at. */
  total: number
  /** How many of them have no value. */
  nulls: number
  /** How many different values there are, an absent one not being one. */
  distinct: number
  /** The values seen most, most often first; of two seen as often, the one seen first. */
  samples: unknown[]
}

/** Describes column `index` of `rows`, with at most `most` values as samples. */
export function profileColumn(rows: unknown[][], index: number, most = 3): ColumnProfile {
  const seen = new Map<string, { value: unknown; count: number }>()
  let nulls = 0
  for (const row of rows) {
    const value = row[index]
    if (value === null || value === undefined) {
      nulls++
      continue
    }
    // Values are told apart as they would be written, with their kind: 1 is not '1'.
    const key = `${typeof value}:${typeof value === 'object' ? JSON.stringify(value) : String(value)}`
    const entry = seen.get(key)
    if (entry) entry.count++
    else seen.set(key, { value, count: 1 })
  }
  const samples = [...seen.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, most)
    .map((entry) => entry.value)
  return { total: rows.length, nulls, distinct: seen.size, samples }
}
