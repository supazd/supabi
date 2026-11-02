import { clickhouse, formatDialect, mysql, postgresql, sql, trino, type DialectOptions } from 'sql-formatter'

// By the names of the kinds of data source, as the editor's own dialects are.
const dialects: Record<string, DialectOptions> = {
  postgres: postgresql,
  mysql,
  starrocks: mysql,
  doris: mysql,
  clickhouse,
  trino,
}

/**
 * SQL laid out one clause to a line, as the given kind of database writes
 * it. {{parameters}} and ${references} are kept as they are, and so are the
 * [[ ]] around a part that is left out without a value: taken apart, they
 * would be brackets to the database. Throws when the SQL cannot be read.
 */
export function format(text: string, dialect?: string): string {
  const formatted = formatDialect(text, {
    dialect: dialects[dialect ?? ''] ?? sql,
    tabWidth: 2,
    keywordCase: 'upper',
    paramTypes: { custom: [{ regex: String.raw`\{\{[^}\n]*\}\}` }, { regex: String.raw`\$\{[^}\n]*\}` }, { regex: String.raw`\[\[|\]\]` }] },
  })
  // An opening [[ is left at the end of the line before what it holds. It reads better in front of it.
  return formatted.replace(/ \[\[\n(\s*)/g, '\n$1[[ ')
}
