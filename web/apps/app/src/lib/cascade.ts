import { useEffect, useRef, useState } from 'react'
import type { FilterOptions } from '../components/FilterControl'
import { canCascade, cascadeComponent, cascadeParents, cascadeValues, isEmpty, reverseCascadeValues, type FilterControl, type FilterOp } from './filters'

interface CascadeFilter {
  id: string
  op: FilterOp
  control?: FilterControl
  dependsOn?: string[]
}

/**
 * Applies a reader's choice to a cascade in one step. A choice that has parents
 * to infer is shown at once but committed only with its inferred parents, so the
 * chart is not first asked without them. `context` invalidates choices still in
 * flight when the filters or the dynamic selections they were made against change.
 */
export function useCascadeChange<F extends CascadeFilter>({ filters, values, commit, load, context, skip }: {
  filters: F[]
  values: Record<string, unknown>
  commit: (values: Record<string, unknown>) => void
  load: (parent: F, values: Record<string, unknown>) => Promise<FilterOptions>
  context: string
  /** Parents whose value is not the reader's to infer, such as ones taken over by a global filter. */
  skip?: (parent: F) => boolean
}) {
  interface Flight { patch: Record<string, unknown> }
  const flights = useRef(new Map<string, Flight>())
  const latest = useRef(values)
  const received = useRef(values)
  if (received.current !== values) { received.current = values; latest.current = values }
  const [pending, setPending] = useState<Record<string, unknown>>({})
  const showPending = () => setPending(Object.assign({}, ...[...flights.current.values()].map((flight) => flight.patch)))
  const apply = (patch: Record<string, unknown>) => {
    latest.current = { ...latest.current, ...patch }
    commit(latest.current)
  }
  useEffect(() => () => {
    flights.current.clear()
    setPending({})
  }, [context])

  const change = async (filter: F, value: unknown) => {
    // Only another choice in this connected group supersedes its reverse lookup.
    // Independent controls can commit immediately without committing a half-resolved child.
    const group = cascadeComponent(filters, filter.id)
    const key = JSON.stringify(group.map((member) => member.id).sort())
    flights.current.delete(key)
    const changed = cascadeValues(filters, latest.current, filter.id, value)
    const ancestors = canCascade(filter) && !isEmpty(filter.op, value) ? cascadeParents(filters, filter.id) : []
    const cleared = ancestors.length ? reverseCascadeValues(filters, changed, filter.id) : changed
    const inferred = ancestors.filter((parent) => !skip?.(parent))
    const skipped = new Set(ancestors.filter((parent) => skip?.(parent)).map((parent) => parent.id))
    const patch = Object.fromEntries(group.filter((member) => member.id in cleared && !skipped.has(member.id)).map((member) => [member.id, cleared[member.id]]))
    if (!inferred.length) {
      apply(patch)
      showPending()
      return
    }
    const flight = { patch }
    flights.current.set(key, flight)
    showPending()
    const answers = await Promise.allSettled(inferred.map((parent) => load(parent, cleared)))
    // A newer choice in this group or a context change owns the outcome now.
    if (flights.current.get(key) !== flight) return
    answers.forEach((answer, index) => {
      const parent = inferred[index]!
      if (answer.status !== 'fulfilled') return
      const { values: found, truncated } = answer.value
      // Only a complete answer is used, and a single choice only when it is unambiguous.
      if (!truncated && found.length && (parent.control?.multi || found.length === 1)) patch[parent.id] = found
    })
    flights.current.delete(key)
    apply(patch)
    showPending()
  }

  return {
    change,
    isPending: Object.keys(pending).length > 0,
    /** The value a control shows: the reader's latest choice, even before it is committed. */
    shown: (id: string, committed: unknown) => (id in pending ? pending[id] : committed),
  }
}

/** Options depend only on a filter's ancestors, so other choices do not reload its list. */
export function ancestorsKey<F extends CascadeFilter>(filters: F[], id: string, valueOf: (filter: F) => unknown): string {
  return JSON.stringify(cascadeParents(filters, id).map((parent) => [parent.id, valueOf(parent)]))
}
