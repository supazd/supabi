// The shape of a dataset spec, as far as the interface edits it. The server
// owns the full definition (.agents/design/dataset.md) and validates it; parts
// this file does not model are carried through unchanged.
import type { DisplayFormat } from '@supabi/charts'
import type { LogicalType } from './client'

export const logicalTypes: LogicalType[] = ['string', 'integer', 'decimal', 'float', 'boolean', 'date', 'timestamp']
export const aggregations = ['sum', 'avg', 'min', 'max', 'count', 'count_distinct'] as const
export type Aggregation = (typeof aggregations)[number]

/**
 * What a field is. A dimension and a measure have a value on every row, and a
 * measure is aggregated when it is used; a metric aggregates inside its own
 * expression, so it is used as it is.
 */
export type FieldRole = 'dimension' | 'measure' | 'metric'
export const fieldRoles = ['dimension', 'measure', 'metric'] as const

/**
 * A field of a dataset. `key` is the internal ID that charts and expressions
 * are stored with; people only ever see `label`, the name.
 */
export interface SpecField {
  key: string
  label: string
  /** The column of the source the field reads, by the name the source gives it. Never quoted: the server does that. */
  column?: string
  /** What a calculated field computes. A field has a column or an expression, never both. */
  expr?: string
  /**
   * The language the expression is written in: the platform's own functions,
   * which mean the same on every database, or when absent the SQL of the data
   * source. See .agents/design/expressions.md.
   */
  syntax?: 'standard'
  description?: string
  type: LogicalType
  /** What it is. How a measure is aggregated is for each chart to say, not the dataset. */
  role: FieldRole
  /** How its numbers or dates are written. Only a number or a date has one. See .agents/design/dataset.md §5.5. */
  format?: DisplayFormat
  hidden?: boolean
  [other: string]: unknown
}

export interface DatasetSpec {
  specVersion: number
  source: { type: string; sql?: string; schema?: string; table?: string }
  fields: SpecField[]
  [other: string]: unknown
}

export const isNumeric = (type: LogicalType) => type === 'integer' || type === 'decimal' || type === 'float'
export const isTemporal = (type: LogicalType) => type === 'date' || type === 'timestamp'

/** A field read straight from a column of the source, as opposed to a calculated one. */
export const isColumn = (field: Pick<SpecField, 'column'>) => field.column !== undefined

/** The aggregations that make sense for a type. */
export function aggsFor(type: LogicalType): Aggregation[] {
  if (isNumeric(type)) return [...aggregations]
  if (type === 'boolean') return ['count', 'count_distinct']
  return ['count', 'count_distinct', 'min', 'max']
}

/** The type an aggregation yields, as the server's Agg.ResultType decides it. */
export function aggResultType(agg: Aggregation | undefined, type: LogicalType): LogicalType {
  if (agg === 'count' || agg === 'count_distinct') return 'integer'
  if (agg === 'avg') return type === 'float' ? 'float' : 'decimal'
  // Sums of integers can outgrow int64.
  if (agg === 'sum' && type === 'integer') return 'decimal'
  return type
}

/** Whether a field can be a measure: only a number is aggregated as one. */
export const canBeMeasure = (field: Pick<SpecField, 'type'>): boolean => isNumeric(field.type)

const numberProperties = ['style', 'decimals', 'grouping', 'unit', 'prefix', 'suffix'] as const
const dateProperties = ['date', 'time', 'week'] as const

/**
 * What of a format a value of the type can keep: a number the format of a
 * number, a date that of a date, less the time of day when it has none.
 * Nothing when a number becomes a date or a date a number, or the type is
 * neither; a date's format that says only what is meant anyway is no format.
 */
export function formatFor(format: DisplayFormat | undefined, type: LogicalType): DisplayFormat | undefined {
  if (!format) return undefined
  if (isNumeric(type)) return dateProperties.some((key) => format[key] !== undefined) ? undefined : format
  if (!isTemporal(type) || numberProperties.some((key) => format[key] !== undefined)) return undefined
  const kept: DisplayFormat = { ...format }
  if (type === 'date') delete kept.time
  return Object.keys(kept).length ? kept : undefined
}

/**
 * Gives a field a role, keeping the rest of it. Every change of type comes
 * through here too: only a number can be a measure, so a measure that stops
 * being one becomes a dimension, and only a number or a date keeps a display
 * format that fits it.
 */
export function withRole(field: SpecField, role: FieldRole): SpecField {
  const { format, ...kept } = field
  const fitting = formatFor(format, field.type)
  const rest = fitting ? { ...kept, format: fitting } : kept
  return { ...rest, role: role === 'measure' && !canBeMeasure(field) ? 'dimension' : role }
}

/**
 * The field proposed for a newly detected column. Numeric columns become
 * measures, except identifiers: those are numbers, but adding them up is
 * never meant.
 */
export function fieldFromColumn(column: { name: string; type: LogicalType }, taken: Set<string>, labels: SpecField[]): SpecField {
  const looksLikeId = /(^|_)id$/.test(column.name.toLowerCase())
  const field: SpecField = { key: makeKey(column.name, taken), label: uniqueLabel(column.name, labels), column: column.name, type: column.type, role: 'dimension' }
  return isNumeric(column.type) && !looksLikeId ? withRole(field, 'measure') : field
}

const randomSuffix = () => Math.random().toString(36).slice(2, 8).padEnd(6, '0')

/**
 * Makes the internal ID of a new field from a column name or a field name.
 * It is readable when the name allows it and random otherwise, and is never
 * shown: nothing may rely on what it says.
 */
export function makeKey(name: string, taken: Set<string>, random: () => string = randomSuffix): string {
  let base = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (!base) base = `f_${random()}`
  else if (!/^[a-z]/.test(base)) base = `f_${base}`
  base = base.slice(0, 50)
  let key = base
  for (let n = 2; taken.has(key); n++) key = `${base}_${n}`
  taken.add(key)
  return key
}

// ---- names ----

export const maxLabelLength = 100

/** The form in which names are compared: differing only in case is the same name. */
export const foldLabel = (label: string) => label.trim().toLowerCase()

/** Whether a name is well formed. Braces are excluded because expressions refer to fields as ${name}. */
export const validLabel = (label: string) => {
  const length = [...label].length
  return length >= 1 && length <= maxLabelLength && label === label.trim() && !/[{}\r\n]/.test(label)
}

/** Keys of the fields whose name is malformed or shared with another field. */
export function labelProblems(fields: SpecField[]): Map<string, 'invalid' | 'duplicate'> {
  const counts = new Map<string, number>()
  for (const field of fields) counts.set(foldLabel(field.label), (counts.get(foldLabel(field.label)) ?? 0) + 1)
  const problems = new Map<string, 'invalid' | 'duplicate'>()
  for (const field of fields) {
    if (!validLabel(field.label)) problems.set(field.key, 'invalid')
    else if ((counts.get(foldLabel(field.label)) ?? 0) > 1) problems.set(field.key, 'duplicate')
  }
  return problems
}

/** Returns the name, or the name with a number added when a field already has it. */
export function uniqueLabel(label: string, fields: SpecField[]): string {
  const used = new Set(fields.map((field) => foldLabel(field.label)))
  let candidate = label
  for (let n = 2; used.has(foldLabel(candidate)); n++) candidate = `${label} ${n}`
  return candidate
}

// ---- expressions ----
//
// An expression refers to other fields as ${...}. It is stored with internal
// IDs inside the braces and written by people with names; these two functions
// convert between the forms. See .agents/design/dataset.md 6.4.

const reference = /\$\{([^}]*)\}/g

/** The internal IDs a stored expression refers to. */
export const refsOf = (expr: string) => [...expr.matchAll(reference)].map((match) => match[1]!.trim())

/** The fields whose expression refers to the given one. */
export const referencedBy = (key: string, fields: SpecField[]) => fields.filter((field) => field.key !== key && refsOf(field.expr ?? '').includes(key))

/** Stored form to written form. An ID no field has is left as it is. */
export function toWrittenExpr(expr: string, fields: SpecField[]): string {
  const labels = new Map(fields.map((field) => [field.key, field.label]))
  return expr.replace(reference, (whole, inner: string) => {
    const label = labels.get(inner.trim())
    return label === undefined ? whole : `\${${label}}`
  })
}

/** Written form to stored form, with the names that match no field. */
export function toStoredExpr(text: string, fields: SpecField[]): { expr: string; unknown: string[] } {
  const keys = new Map(fields.map((field) => [foldLabel(field.label), field.key]))
  const unknown: string[] = []
  const expr = text.replace(reference, (whole, inner: string) => {
    const key = keys.get(foldLabel(inner))
    if (key === undefined) {
      unknown.push(inner.trim())
      return whole
    }
    return `\${${key}}`
  })
  return { expr, unknown }
}
