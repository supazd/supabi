// Works out which names can be written at a place in a SQL statement: the
// columns of the tables that the query around that place reads from, where a
// subquery or a WITH query counts as a table whose columns are what it
// selects. It reads only as much of SQL as that takes, and treats the rest
// as words.
import type { CodeTable } from './types'

export interface Suggestion {
  label: string
  kind: 'column' | 'table' | 'schema'
  detail?: string
}

interface Token {
  type: 'word' | 'quoted' | 'string' | 'number' | 'punct'
  text: string
  from: number
  to: number
}
/** What is between a pair of parentheses, or the whole statement. */
interface Group {
  type: 'group'
  items: Item[]
  from: number
  to: number
  parent: Group | null
}
type Item = Token | Group

interface Column {
  name: string
  type?: string
}
/** Something a query reads from, under the name it is referred to by. */
interface Source {
  name: string
  columns: Column[]
}
/** The WITH queries that can be read from at some place. */
interface Scope {
  queries: Map<string, Group>
  outer?: Scope
}

// In order: space, comment, string, quoted name, word, number, a {{parameter}}
// or ${reference} standing for a value, anything else.
const lexer = /(\s+)|(--[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|('(?:[^'\\]|\\[\s\S]|'')*(?:'|$))|("(?:[^"]|"")*(?:"|$)|`(?:[^`]|``)*(?:`|$))|([\p{L}_][\p{L}\p{N}_$]*)|(\d[\p{L}\p{N}_.]*)|(\{\{[^}\n]*\}\}|\$\{[^}\n]*\})|([\s\S])/gsuy

function tokenize(text: string, pos: number): { tokens: Token[]; inText: boolean } {
  const tokens: Token[] = []
  let inText = false
  for (const match of text.matchAll(lexer)) {
    const from = match.index
    const to = from + match[0].length
    const closed = (mark: string) => match[0].length > 1 && match[0].endsWith(mark)
    if (match[2] !== undefined) {
      // A line comment goes on to the end of its line; the cursor after it is still in it.
      const open = match[0].startsWith('--') || !closed('*/')
      if (from < pos && (pos < to || (open && pos === to))) inText = true
    } else if (match[3] !== undefined || match[4] !== undefined) {
      if (from < pos && (pos < to || (!closed(match[0][0]!) && pos === to))) inText = true
      tokens.push({ type: match[3] !== undefined ? 'string' : 'quoted', text: match[0], from, to })
    } else if (match[5] !== undefined) tokens.push({ type: 'word', text: match[0], from, to })
    else if (match[6] !== undefined || match[7] !== undefined) tokens.push({ type: 'number', text: match[0], from, to })
    else if (match[8] !== undefined) tokens.push({ type: 'punct', text: match[0], from, to })
  }
  return { tokens, inText }
}

function nest(tokens: Token[], end: number): Group {
  const root: Group = { type: 'group', items: [], from: -1, to: end, parent: null }
  let current = root
  for (const token of tokens) {
    if (token.type === 'punct' && token.text === '(') {
      const group: Group = { type: 'group', items: [], from: token.from, to: end, parent: current }
      current.items.push(group)
      current = group
    } else if (token.type === 'punct' && token.text === ')') {
      current.to = token.from
      current = current.parent ?? root
    } else current.items.push(token)
  }
  return root
}

// Not type guards: a guard that also tests the text would rule out tokens altogether where it fails.
const isWord = (item: Item | undefined, ...words: string[]): boolean => item?.type === 'word' && words.includes(item.text.toLowerCase())
const isPunct = (item: Item | undefined, text: string): boolean => item?.type === 'punct' && item.text === text
const isName = (item: Item | undefined): item is Token => item?.type === 'word' || item?.type === 'quoted'
const isGroup = (item: Item | undefined): item is Group => item?.type === 'group'
const nameOf = (token: Token) => (token.type === 'quoted' ? token.text.slice(1, token.text.length > 1 && token.text.endsWith(token.text[0]!) ? -1 : undefined) : token.text)
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const hasSelect = (group: Group) => group.items.some((item) => isWord(item, 'select'))

const setOperations = ['union', 'intersect', 'except', 'minus']
// Words that follow a table and are therefore not its alias.
const afterTable = 'where join left right inner outer full cross natural on using group order having limit offset union intersect except minus window qualify prewhere final sample array global any all asof semi anti fetch for lateral tablesample settings format pivot unpivot returning set values select as'.split(' ')
// Words an expression can end in, or continue with, that are not an alias for it.
const notAnAlias = 'end null true false asc desc and or not as is in like ilike between then else when distinct all over from'.split(' ')
// The words that start the parts of a query. What can be written depends on the last one.
const clauses = 'select from join where on using group order having limit offset by set values window qualify prewhere'.split(' ')

/** One of the queries in a group, and where it starts. */
interface Segment {
  items: Item[]
  from: number
}

/** The parts of a group that are queries of their own: one, unless it combines several with UNION and the like. */
function segments(group: Group): Segment[] {
  const out: Segment[] = [{ items: [], from: group.from }]
  for (const item of group.items) {
    if (isWord(item, ...setOperations)) out.push({ items: [], from: item.to })
    else out.at(-1)!.items.push(item)
  }
  return out
}

/** The WITH queries a group defines, by name. */
function scopeOf(group: Group, outer?: Scope): Scope {
  const queries = new Map<string, Group>()
  const items = group.items
  if (isWord(items[0], 'with')) {
    for (let i = 1; i < items.length && !isWord(items[i], 'select'); i++) {
      // name AS ( … ), where words such as MATERIALIZED can come before the parenthesis.
      if (!isWord(items[i], 'as') || !isName(items[i - 1])) continue
      const body = items.slice(i + 1, i + 4).find(isGroup)
      if (body) queries.set(nameOf(items[i - 1] as Token).toLowerCase(), body)
    }
  }
  return { queries, outer }
}

class Analysis {
  constructor(private readonly tables: CodeTable[]) {}

  /** The columns of a table named in a statement, or nothing when no such table is known. */
  table(parts: string[], scope: Scope, depth: number): Column[] | undefined {
    const name = parts.at(-1)!
    if (parts.length === 1) {
      for (let at: Scope | undefined = scope; at; at = at.outer) {
        const query = at.queries.get(name.toLowerCase())
        if (query) return this.selected(query, at, depth + 1)
      }
    }
    const schema = parts.at(-2)
    const found = this.tables.find((table) => same(table.name, name) && (schema === undefined ? !table.schema : same(table.schema ?? '', schema)))
    return found?.columns
  }

  /** What one query reads from. */
  sources(segment: Item[], scope: Scope, depth: number): Source[] {
    const sources: Source[] = []
    for (let i = 0; i < segment.length; i++) {
      if (!isWord(segment[i], 'from', 'join')) continue
      // One table, or several separated by commas.
      for (i++; ; i++) {
        if (isWord(segment[i], 'lateral')) i++
        const item = segment[i]
        let name = ''
        let columns: Column[] = []
        if (isGroup(item)) {
          if (hasSelect(item)) columns = this.selected(item, scope, depth + 1)
          i++
        } else if (isName(item) && !isWord(item, ...afterTable)) {
          const parts = [nameOf(item)]
          for (i++; isPunct(segment[i], '.') && isName(segment[i + 1]); i += 2) parts.push(nameOf(segment[i + 1] as Token))
          if (isGroup(segment[i])) i++ // the arguments of a function that returns a table
          columns = this.table(parts, scope, depth) ?? []
          name = parts.at(-1)!
        } else break
        if (isWord(segment[i], 'as')) i++
        const alias = segment[i]
        if (isName(alias) && !isWord(alias, ...afterTable)) {
          name = nameOf(alias)
          i++
          if (isGroup(segment[i])) i++ // names given to its columns
        }
        sources.push({ name, columns })
        if (!isPunct(segment[i], ',')) break
      }
      i--
    }
    return sources
  }

  /** The columns a query in parentheses returns: those of the first of its queries. */
  selected(group: Group, outer: Scope | undefined, depth: number): Column[] {
    if (depth > 8) return [] // a query that reads from itself
    const scope = scopeOf(group, outer)
    const segment = segments(group)[0]!.items
    const start = segment.findIndex((item) => isWord(item, 'select'))
    if (start < 0) return []
    const end = segment.findIndex((item, index) => index > start && isWord(item, 'from'))
    const list = segment.slice(start + 1, end < 0 ? undefined : end)
    const sources = this.sources(segment, scope, depth)
    const everything = () => sources.flatMap((source) => source.columns)
    const from = (qualifier: string) => sources.find((source) => same(source.name, qualifier))?.columns ?? []

    const columns: Column[] = []
    let expression: Item[] = []
    const finish = () => {
      const e = isWord(expression[0], 'distinct', 'all') ? expression.slice(1) : expression
      expression = []
      const last = e.at(-1)
      const before = e.at(-2)
      if (!last) return
      if (isPunct(last, '*')) {
        const qualifier = e.at(-3)
        columns.push(...(isPunct(before, '.') && isName(qualifier) ? from(nameOf(qualifier)) : e.length === 1 ? everything() : []))
      } else if (isName(last) && isWord(before, 'as')) {
        columns.push({ name: nameOf(last) })
      } else if (isName(last) && e.every((item, index) => (index % 2 === 0 ? isName(item) : isPunct(item, '.')))) {
        // A column on its own keeps its name, and its type when the table is known.
        const name = nameOf(last)
        const candidates = e.length >= 3 ? from(nameOf(e.at(-3) as Token)) : everything()
        columns.push({ name, type: candidates.find((column) => same(column.name, name))?.type })
      } else if (isName(last) && !isWord(last, ...notAnAlias) && before && !isPunct(before, '.') && before.type !== 'punct' && !isWord(before, ...notAnAlias)) {
        columns.push({ name: nameOf(last) }) // an alias written without AS
      }
    }
    for (const item of list) {
      if (isPunct(item, ',')) finish()
      else expression.push(item)
    }
    finish()
    return columns
  }
}

/**
 * The names that can be written at pos, and where the name being written
 * starts. Null when there is nothing to offer, which leaves the field to
 * other suggestions such as keywords.
 */
export function suggest(text: string, pos: number, tables: CodeTable[], explicit: boolean): { from: number; options: Suggestion[] } | null {
  const { tokens, inText } = tokenize(text, pos)
  if (inText) return null

  // The statement the cursor is in, when there are several.
  const ends = tokens.filter((token) => token.type === 'punct' && token.text === ';').map((token) => token.from)
  const start = Math.max(-1, ...ends.filter((end) => end < pos))
  const end = Math.min(text.length, ...ends.filter((at) => at >= pos))
  const statement = tokens.filter((token) => token.from > start && token.to <= end)

  // The word being written, and the names it is qualified by: a.b.wor|
  const partial = statement.find((token) => token.type === 'word' && token.from < pos && pos <= token.to)
  const from = partial ? partial.from : pos
  const before = statement.filter((token) => token.to <= from)
  const qualifiers: string[] = []
  let rest = before.length
  while (isPunct(before[rest - 1], '.') && isName(before[rest - 2])) {
    qualifiers.unshift(nameOf(before[rest - 2] as Token))
    rest -= 2
  }
  if (isPunct(before[rest - 1], '.')) return null // after a dot that follows no name

  // From the statement inwards: the groups the cursor is in.
  const root = nest(statement, end)
  const path = [root]
  for (let inner: Group | undefined = root; inner; ) {
    inner = inner.items.find((item): item is Group => isGroup(item) && item.from < pos && pos <= item.to)
    if (inner) path.push(inner)
  }
  const innermost = path.at(-1)!
  // The query the cursor is in, and the queries around that one.
  const queries = path.filter((group) => group === root || hasSelect(group))
  const analysis = new Analysis(tables)
  const scopes = new Map<Group, Scope>()
  let scope: Scope | undefined
  for (const group of path) {
    scope = scopeOf(group, scope)
    scopes.set(group, scope)
  }
  const segmentAt = (group: Group) => segments(group).findLast((segment) => segment.from < pos)!.items
  const sourcesAt = (group: Group) => analysis.sources(segmentAt(group), scopes.get(group)!, 0)
  const block = queries.at(-1)!
  const here = scopes.get(block)!

  const columns = (list: Column[], detail?: string): Suggestion[] => list.map((column) => ({ label: column.name, kind: 'column', detail: detail ?? column.type }))
  const done = (options: Suggestion[]) => {
    const seen = new Set<string>()
    const unique = options.filter((option) => !seen.has(option.label) && seen.add(option.label))
    return unique.length > 0 ? { from, options: unique } : null
  }

  // Where a table is expected: straight after FROM or JOIN, or after a comma in FROM.
  // It is decided by what precedes the name at the level of the query itself;
  // inside the parentheses of a function, say, a table is never expected.
  const nameStart = before[rest]?.from ?? from
  const level = innermost === block ? segmentAt(block).filter((item) => (isGroup(item) ? item.to < nameStart : item.to <= nameStart)) : []
  const last = level.at(-1)
  const clause = level.findLast((item) => isWord(item, ...clauses))
  const inFrom = isWord(clause, 'from', 'join')
  const tableExpected = inFrom && (last === clause || isWord(last, 'lateral') || (isPunct(last, ',') && isWord(clause, 'from')))

  if (qualifiers.length > 0) {
    if (qualifiers.length === 1) {
      const qualifier = qualifiers[0]!
      if (!tableExpected) {
        // An alias or table of this query, or of one around it.
        for (const group of [...queries].reverse()) {
          const source = sourcesAt(group).find((candidate) => same(candidate.name, qualifier))
          if (source) return done(columns(source.columns))
        }
      }
      const inSchema = tables.filter((table) => table.schema && same(table.schema, qualifier))
      if (inSchema.length > 0) return done(inSchema.map((table) => ({ label: table.name, kind: 'table' })))
    }
    return done(columns(analysis.table(qualifiers, here, 0) ?? []))
  }

  if (inFrom && !tableExpected) return null // after a table: an alias, or a keyword
  if (tableExpected) {
    const withQueries: Suggestion[] = []
    for (let at: Scope | undefined = here; at; at = at.outer) {
      for (const name of at.queries.keys()) withQueries.push({ label: name, kind: 'table', detail: 'WITH' })
    }
    const schemas = [...new Set(tables.flatMap((table) => (table.schema ? [table.schema] : [])))]
    return done([
      ...withQueries,
      ...tables.filter((table) => !table.schema).map((table): Suggestion => ({ label: table.name, kind: 'table' })),
      ...schemas.map((schema): Suggestion => ({ label: schema, kind: 'schema' })),
    ])
  }

  if (!partial && !explicit) return null
  const sources = sourcesAt(block)
  const several = sources.filter((source) => source.columns.length > 0).length > 1
  return done([
    // With several tables, which one a column is from says more than its type.
    ...sources.flatMap((source) => columns(source.columns, several && source.name ? source.name : undefined)),
    ...sources.filter((source) => source.name).map((source): Suggestion => ({ label: source.name, kind: 'table' })),
  ])
}
