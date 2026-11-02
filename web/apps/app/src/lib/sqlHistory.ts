// What was run in data exploration, kept in the browser so that a query
// written over can be found again.
import type { SqlParam } from './params'

/** One run of a piece of SQL. */
export interface SqlRun {
  sql: string
  datasourceId: string
  params?: SqlParam[]
  /** When it was run, in milliseconds since the epoch. */
  at: number
  /** How many rows came back and how long it took, when it worked. */
  rows?: number
  ms?: number
  /** What went wrong, when it did not. */
  error?: string
}

/** How many runs are kept. Older ones are forgotten. */
export const historyLimit = 50

/**
 * The history after a run, newest first. Running the same SQL against the
 * same data source again moves it to the front rather than listing it twice.
 */
export function recorded(history: SqlRun[], run: SqlRun): SqlRun[] {
  return [run, ...history.filter((past) => past.sql !== run.sql || past.datasourceId !== run.datasourceId)].slice(0, historyLimit)
}
