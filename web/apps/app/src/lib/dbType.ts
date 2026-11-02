// What kind of value a database's own type holds, told from its name. It is
// only for showing a mark beside a column in the list of tables: nothing is
// decided by it, so a guess that is sometimes wrong costs nothing.

export type Kind = 'number' | 'text' | 'time' | 'boolean'

/** The kind of a type as a database names it: "numeric(12,2)", "Nullable(DateTime64(3))", "varchar(20)". */
export function kindOf(dbType: string): Kind {
  // What wraps a type says nothing about it: Nullable(…), LowCardinality(…).
  const name = dbType.toLowerCase().replace(/\b(nullable|lowcardinality)\(/g, '')
  if (/^(bool|bit\b)/.test(name) || name === 'tinyint(1)') return 'boolean'
  if (/^(date|time|year|interval)/.test(name)) return 'time'
  if (/^(u?int|u?(tiny|small|medium|big|large)int|integer|serial|bigserial|smallserial|number|numeric|decimal|dec\b|float|double|real|money|hugeint)/.test(name)) return 'number'
  return 'text'
}
