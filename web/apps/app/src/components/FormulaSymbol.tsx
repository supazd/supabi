import type { TFunction } from 'i18next'
import type { Aggregation } from '../api/spec'
import { aggCodes } from '../lib/aggregations'
import { opSymbols, type FilterOp } from '../lib/filters'

// The symbol marks an option; its words name it, to a reader and to a screen reader.

/** A condition's symbol before its words in a list. Every option keeps the room, so the words line up. */
export const opOption = <T extends FilterOp>(op: T, t: TFunction) => {
  const symbol = opSymbols[op]
  return { value: op, label: t(`filter.ops.${op}`), icon: <span className="formula-symbol" aria-hidden="true">{symbol && symbol.length === 1 ? symbol : ''}</span> }
}

/** An aggregation's function name before its words in a list. */
export const aggOption = <T extends Aggregation>(agg: T, t: TFunction) =>
  ({ value: agg, label: t(`dataset.aggs.${agg}`), icon: <span className="formula-symbol agg" aria-hidden="true">{aggCodes[agg]}</span> })
