// Data permissions as the dataset editor edits them. See .agents/design/access-control.md §5.
import type { Schemas, Subject } from '../api/client'
import type { SpecField } from '../api/spec'

type Policy = Schemas['DatasetPolicy']
export type Filter = NonNullable<Schemas['RowRule']['filter']>
type ColumnRule = Schemas['ColumnRule']

/** A row rule draft always carries a condition, which may still be incomplete. */
export interface RowDraft {
  name?: string
  subjects: Subject[]
  filter: Filter
}

export interface Draft {
  unmatched: Policy['unmatched']
  columnMode?: Policy['columnMode']
  rows: RowDraft[]
  columns: ColumnRule[]
}

export const draftOf = (policy: Policy): Draft => ({
  unmatched: policy.unmatched,
  ...(policy.columnMode ? { columnMode: policy.columnMode } : {}),
  rows: policy.rows.map((rule) => ({ ...(rule.name ? { name: rule.name } : {}), subjects: rule.subjects, filter: rule.filter })),
  columns: policy.columns,
})

export const policyOf = (draft: Draft): Policy => ({
  unmatched: draft.unmatched,
  ...(draft.columnMode ? { columnMode: draft.columnMode } : {}),
  rows: draft.rows.map((rule) => ({ ...(rule.name ? { name: rule.name } : {}), subjects: rule.subjects, filter: rule.filter })),
  columns: draft.columns,
})

/** A condition this page edits: one field holding one of some values. Others are kept as written. */
export function simpleOf(filter: Filter | undefined): { field?: string; values: unknown[] } | null {
  if (!filter) return { values: [] }
  const { field, op, value, ...rest } = filter as { field?: unknown; op?: unknown; value?: unknown }
  if (Object.keys(rest).length > 0 || typeof field !== 'string') return null
  if (op === 'in' && Array.isArray(value)) return { field, values: value }
  if (op === 'eq') return { field, values: [value] }
  return null
}


/** Every branch needs a condition; missing values never mean unrestricted rows. */
export function hasCondition(filter: Filter | undefined): boolean {
  if (!filter) return false
  if (filter.op === 'and' || filter.op === 'or') return Array.isArray(filter.args) && filter.args.length > 0 && filter.args.every((arg) => hasCondition(arg as Filter))
  if (attributeOf(filter) !== undefined) return typeof filter.field === 'string' && !!filter.field && !!attributeOf(filter)
  if (['in', 'not_in'].includes(String(filter.op))) return typeof filter.field === 'string' && !!filter.field && Array.isArray(filter.value) && filter.value.length > 0
  if (['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'not_contains', 'starts_with', 'ends_with'].includes(String(filter.op))) return typeof filter.field === 'string' && !!filter.field && filter.value != null && filter.value !== ''
  if (['is_null', 'not_null'].includes(String(filter.op))) return typeof filter.field === 'string' && !!filter.field
  if (filter.op === 'not') return Array.isArray(filter.args) && filter.args.length === 1 && hasCondition(filter.args[0] as Filter)
  return typeof filter.field === 'string' && !!filter.field && !!filter.op && filter.op !== 'false' && filter.value != null
}

/** Text searches contain the input; other types search for an exact value.
 * null means the input is not a complete value yet, so no query is needed. */
export function candidateFilter(field: Pick<SpecField, 'key' | 'type'>, search: string): Filter | null | undefined {
  if (!search) return undefined
  if (field.type === 'string') return { field: field.key, op: 'contains', value: search }
  const text = search.trim()
  let value: unknown
  switch (field.type) {
    case 'integer':
      if (!/^[+-]?\d+$/.test(text) || !Number.isSafeInteger(Number(text))) return null
      value = Number(text)
      break
    case 'decimal':
    case 'float':
      if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text) || !Number.isFinite(Number(text))) return null
      // Keep decimal digits intact when the value travels through JSON.
      value = field.type === 'decimal' ? text : Number(text)
      break
    case 'boolean':
      if (text !== 'true' && text !== 'false') return null
      value = text === 'true'
      break
    case 'date':
    case 'timestamp': {
      const pattern = field.type === 'date' ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}([T ]([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,9})?)?)?$/
      if (!pattern.test(text)) return null
      const day = text.slice(0, 10)
      const date = new Date(`${day}T00:00:00Z`)
      if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day || day.startsWith('0000')) return null
      value = field.type === 'timestamp' ? text.replace(' ', 'T') : text
      break
    }
  }
  return { field: field.key, op: 'eq', value }
}

/** Dynamic attributes are server-resolved; they are never literal query values. */
export function attributeOf(filter?: Filter): string | undefined {
  const value = filter?.value
  if (value && typeof value === 'object' && !Array.isArray(value) && 'userAttr' in value) return String(value.userAttr)
  return undefined
}

export function conditionSummary(filter: Filter | undefined, labels: Map<string, string>, attributes: Map<string, string>, words: { incomplete: string; and: string; or: string; dynamic: string }): string {
  if (!filter || !hasCondition(filter)) return words.incomplete
  if (Array.isArray(filter.args)) return `(${filter.args.map((arg) => conditionSummary(arg as Filter, labels, attributes, words)).join(` ${filter.op === 'and' ? words.and : words.or} `)})`
  const key = String(filter.field ?? '')
  const attribute = attributeOf(filter)
  const value = attribute !== undefined ? `${words.dynamic} · ${attributes.get(attribute) ?? attribute}` : Array.isArray(filter.value) ? filter.value.map((v) => String(v)).join(', ') : String(filter.value ?? '')
  const operators: Record<string, string> = { in: '∈', eq: '=', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤' }
  return `${labels.get(key) ?? key} ${operators[String(filter.op)] ?? String(filter.op)} ${value}`
}
