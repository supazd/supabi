/** Result of a query, as returned by the API. See .agents/design/query-ir.md §4. */
import type { DisplayFormat } from './format'

export type ColumnType = 'string' | 'integer' | 'decimal' | 'float' | 'boolean' | 'date' | 'timestamp'

/** What a dimension's dates were truncated to. */
export type Grain = 'year' | 'quarter' | 'month' | 'week' | 'day' | 'hour' | 'minute'

export interface ResultColumn {
  name: string
  type: ColumnType
  role: 'dimension' | 'measure'
  /** Display name from the dataset. */
  label?: string
  /** How the column's numbers or dates are written; a count has none. */
  format?: DisplayFormat
  /** What a dimension's dates were truncated to, which says how much of them to write. */
  grain?: Grain
}

/** Decimals arrive as strings so they keep their precision in transit. */
export type Cell = string | number | boolean | null

/** The measures over coarser groups: grouped by the dimensions in `by`, then the measures. */
export interface QueryTotal {
  by: string[]
  columns: ResultColumn[]
  rows: Cell[][]
}

export interface QueryResult {
  columns: ResultColumn[]
  rows: Cell[][]
  /** The totals the query asked for, which the database computed. */
  totals?: QueryTotal[]
  meta?: {
    /** Totals were asked for but not computed: a condition on results would not mean the same over coarser groups. */
    totalsOmitted?: boolean
    /** There were more rows than the query took. */
    truncated?: boolean
  }
}

/** Where on the screen a value was clicked, to open what it offers there. */
export interface ClickPoint {
  x: number
  y: number
}
