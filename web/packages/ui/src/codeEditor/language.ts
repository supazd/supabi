import { pickedCompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { LanguageSupport } from '@codemirror/language'
import { MySQL, PostgreSQL, SQLDialect, StandardSQL, sql } from '@codemirror/lang-sql'
import type { Extension } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { suggest } from './scope'
import type { CodeFunction, CodeTable } from './types'

// ClickHouse has no dialect of its own in the library. This is MySQL's
// vocabulary, which it is closest to, with what its SELECT statements add.
const ClickHouse = SQLDialect.define({
  keywords: `${MySQL.spec.keywords} prewhere final sample array anti semi asof any global format settings qualify totals`,
  types: `${MySQL.spec.types} int8 int16 int32 int64 int128 int256 uint8 uint16 uint32 uint64 uint128 uint256 float32 float64 decimal32 decimal64 decimal128 string fixedstring uuid date32 datetime64 enum8 enum16 tuple map nullable lowcardinality ipv4 ipv6`,
  identifierQuotes: '`"',
  backslashEscapes: true,
  hashComments: true,
  slashComments: true,
})

// By the names of the kinds of data source. Ones that follow another
// database's syntax closely use its dialect.
const dialects: Record<string, SQLDialect> = {
  postgres: PostgreSQL,
  mysql: MySQL,
  starrocks: MySQL,
  doris: MySQL,
  clickhouse: ClickHouse,
}

// A dialect knows hundreds of words, and offered in alphabetical order the
// few that are written all the time are buried: "s" would offer SAVEPOINT
// long before SELECT. The words every statement is built from come first,
// then other common ones; the rest come after names.
const clauses = new Set('select from where group order by having limit join on and or as'.split(' '))
const common = new Set(
  'offset left right inner outer full cross using not in is null like between exists case when then else end distinct union all with asc desc over partition interval cast true false count sum avg min max coalesce'.split(' '),
)

const functions = new Set('count sum avg min max coalesce cast'.split(' '))

function keyword(label: string, type: string): Completion {
  const word = label.toLowerCase()
  // The library tells keywords, types and built-in names apart.
  const kind = functions.has(word) || type === 'variable' ? 'function' : type
  return { label, type: kind, boost: clauses.has(word) ? 8 : common.has(word) ? 5 : -20 }
}

const boosts = { column: 20, table: 14, schema: 12 }

/**
 * Offers the names of tables and columns, by what the query around the
 * cursor reads from. quote is the mark this kind of database puts around a
 * name that cannot be written bare.
 */
export function nameCompletions(tables: CodeTable[], quote: string) {
  return (context: CompletionContext): CompletionResult | null => {
    const found = suggest(context.state.doc.toString(), context.pos, tables, context.explicit)
    if (!found) return null
    return {
      from: found.from,
      options: found.options.map(({ label, kind, detail }) => ({
        label,
        detail,
        type: kind,
        boost: boosts[kind],
        apply: /^[\p{L}_][\p{L}\p{N}_$]*$/u.test(label) ? undefined : quote + label + quote,
      })),
      validFor: /^[\p{L}\p{N}_$]*$/u,
    }
  }
}

/** SQL as one kind of database writes it, completing the names of the given tables. */
export function sqlLanguage(dialect: string | undefined, tables: CodeTable[]) {
  const spoken = dialects[dialect ?? ''] ?? StandardSQL
  // Names are completed here rather than by the library, which does not
  // tell one query of a statement from another.
  const support = sql({ dialect: spoken, upperCaseKeywords: true, keywordCompletion: keyword })
  const quote = spoken === MySQL || spoken === ClickHouse ? '`' : '"'
  const extension: Extension = [support, support.language.data.of({ autocomplete: nameCompletions(tables, quote) })]
  return { language: support.language, extension }
}

// The words of the platform's language for expressions that are not functions.
const expressionWords = 'CASE WHEN THEN ELSE END AND OR NOT IN BETWEEN IS NULL TRUE FALSE'.split(' ')

/**
 * The platform's own language for expressions. It reads like the SQL every
 * database shares, so it is shown as that; what is offered is its own
 * functions, each written with its parentheses and the cursor between them.
 */
export function expressionLanguage(functions: CodeFunction[]) {
  const call = (view: EditorView, completion: Completion, from: number, to: number) => {
    const open = view.state.sliceDoc(to, to + 1) === '('
    const insert = open ? completion.label : `${completion.label}()`
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + completion.label.length + 1 },
      annotations: pickedCompletion.of(completion),
      userEvent: 'input.complete',
    })
  }
  const options: Completion[] = [
    ...functions.map((fn): Completion => ({ label: fn.name, detail: fn.detail, type: 'function', boost: 5, apply: call })),
    ...expressionWords.map((word): Completion => ({ label: word, type: 'keyword' })),
  ]
  const complete = (context: CompletionContext): CompletionResult | null => {
    const word = context.matchBefore(/[A-Za-z_][A-Za-z0-9_]*/)
    if (!word) return null
    // A name is matched however it is typed, and written as the language has it.
    return { from: word.from, options, validFor: /^[A-Za-z0-9_]*$/ }
  }
  const support = new LanguageSupport(StandardSQL.language)
  const extension: Extension = [support, StandardSQL.language.data.of({ autocomplete: complete })]
  return { language: StandardSQL.language, extension }
}
