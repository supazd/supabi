// Parameters of a dataset's SQL, as data exploration edits them. The SQL
// names them as {{name}}; what each one is, and the value it has when none is
// given, is declared beside the SQL. See .agents/design/dataset.md 4.
import type { LogicalType } from '../api/client'

/** A parameter as the dataset stores it. Unrecognized attributes are carried along. */
export interface SqlParam {
  name: string
  type: LogicalType
  label?: string
  multi?: boolean
  required?: boolean
  /** A value, a list of them for a parameter that takes several, or `{ relative: 'today-1d' }` for a day worked out when the query runs. */
  default?: unknown
  [other: string]: unknown
}

/** A parameter while it is being edited: its default is whatever has been typed, valid or not. */
export interface ParamDraft {
  name: string
  type: LogicalType
  text: string
  /** Everything else the stored parameter said. */
  rest: Record<string, unknown>
}

const placeholder = /\{\{([^{}]*)\}\}/g
// The server's rule for a parameter's name.
const validName = /^[a-z][a-z0-9_]{0,62}$/

/**
 * SQL with what is not SQL blanked out: strings, quoted names and comments.
 * Braces in those are text, as they are to the database and to the server
 * (ParseTemplate), so '{{status}}' is a string and names no parameter.
 * Positions are kept.
 */
export function withoutText(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const c = sql[i]!
    let end = i
    if (sql.startsWith('--', i)) {
      const line = sql.indexOf('\n', i)
      end = line < 0 ? sql.length : line + 1
    } else if (sql.startsWith('/*', i)) {
      const close = sql.indexOf('*/', i + 2)
      end = close < 0 ? sql.length : close + 2
    } else if (c === "'" || c === '"' || c === '`') {
      end = i + 1
      // A quote is escaped by doubling it.
      while (end < sql.length && (sql[end] !== c || sql[end + 1] === c)) end += sql[end] === c ? 2 : 1
      end = Math.min(end + 1, sql.length)
    }
    if (end === i) {
      out += c
      i++
    } else {
      out += ' '.repeat(end - i)
      i = end
    }
  }
  return out
}

/** The parameters a piece of SQL uses, in the order they first appear, and the placeholders whose name cannot be one. */
export function paramNames(sql: string): { names: string[]; invalid: string[] } {
  const names: string[] = []
  const invalid: string[] = []
  for (const match of withoutText(sql).matchAll(placeholder)) {
    const name = match[1]!.trim()
    const list = validName.test(name) ? names : invalid
    if (!list.includes(name)) list.push(name)
  }
  return { names, invalid }
}

const relativeDay = /^today([+-]\d+d)?$/
const isRelative = (value: unknown): value is { relative: string } => typeof value === 'object' && value !== null && typeof (value as { relative?: unknown }).relative === 'string'
const one = (value: unknown) => (isRelative(value) ? value.relative : String(value))

export function toDraft(param: SqlParam): ParamDraft {
  const { name, type, default: value, ...rest } = param
  const text = value === undefined || value === null ? '' : Array.isArray(value) ? value.map(one).join(', ') : one(value)
  return { name, type, text, rest }
}

/** A single typed value as the parameter's type wants it, or undefined when it is not one. */
export function parse(text: string, type: LogicalType): unknown {
  switch (type) {
    case 'integer':
      return /^-?\d+$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : undefined
    case 'float':
      return text !== '' && Number.isFinite(Number(text)) ? Number(text) : undefined
    case 'decimal':
      // Kept as written: a decimal must not lose digits on the way.
      return /^-?(\d+\.?\d*|\.\d+)$/.test(text) ? text : undefined
    case 'boolean':
      return text === 'true' ? true : text === 'false' ? false : undefined
    case 'date':
      if (relativeDay.test(text.replaceAll(' ', ''))) return { relative: text.replaceAll(' ', '') }
      return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(text)) ? text : undefined
    case 'timestamp':
      return /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$/.test(text) && !Number.isNaN(Date.parse(text.replace(' ', 'T'))) ? text : undefined
  }
  return text
}

/** Whether what was typed can be the parameter's default. Nothing typed is no default, which is fine. */
export function validDefault(draft: ParamDraft): boolean {
  return toParam(draft) !== undefined
}

/** The parameter as it is stored, or undefined while its default is not a value of its type. */
export function toParam(draft: ParamDraft): SqlParam | undefined {
  const param: SqlParam = { ...draft.rest, name: draft.name, type: draft.type }
  const text = draft.text.trim()
  if (text === '') return param
  if (draft.rest.multi) {
    // A comma left at the end, or two in a row, names no value.
    const values = text.split(',').map((item) => item.trim()).filter(Boolean).map((item) => parse(item, draft.type))
    return values.includes(undefined) ? undefined : { ...param, default: values }
  }
  const value = parse(text, draft.type)
  return value === undefined ? undefined : { ...param, default: value }
}

/** The parameter taking several values, or one. Taking one is said by saying nothing, as the server stores it. */
export function withMulti(draft: ParamDraft, multi: boolean): ParamDraft {
  const rest = Object.fromEntries(Object.entries(draft.rest).filter(([key]) => key !== 'multi'))
  return { ...draft, rest: multi ? { ...rest, multi: true } : rest }
}

/** An empty display name falls back to the parameter's SQL name. */
export function withLabel(draft: ParamDraft, label: string): ParamDraft {
  const rest = Object.fromEntries(Object.entries(draft.rest).filter(([key]) => key !== 'label'))
  return { ...draft, rest: label ? { ...rest, label } : rest }
}

/** Optional parameters omit the flag; SQL outside optional blocks still needs a value. */
export function withRequired(draft: ParamDraft, required: boolean): ParamDraft {
  const rest = Object.fromEntries(Object.entries(draft.rest).filter(([key]) => key !== 'required'))
  return { ...draft, rest: required ? { ...rest, required: true } : rest }
}

/**
 * The parameters to show for a piece of SQL: one for each it names, in the
 * order it names them. What was already said about a name is kept; a new name
 * starts as text with no default.
 */
export function draftsFor(sql: string, known: ParamDraft[]): ParamDraft[] {
  return paramNames(sql).names.map((name) => known.find((draft) => draft.name === name) ?? { name, type: 'string', text: '', rest: {} })
}

/**
 * What is known about parameters after an edit: the changed one replaced or
 * added. A parameter the SQL no longer names is remembered, so that taking a
 * placeholder out and putting it back does not lose what was set.
 */
export function remember(known: ParamDraft[], changed: ParamDraft): ParamDraft[] {
  return known.some((draft) => draft.name === changed.name) ? known.map((draft) => (draft.name === changed.name ? changed : draft)) : [...known, changed]
}
