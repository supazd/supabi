import { useCallback, useReducer } from 'react'

type Update<T> = T | ((current: T) => T)
type UpdateOptions = { group?: string; replace?: boolean }
type History<T> = { value: T; past: T[]; future: T[]; group?: string }
type Action<T> = { type: 'update'; next: Update<T>; options?: UpdateOptions } | { type: 'reset'; value: T } | { type: 'undo' | 'redo' | 'endGroup' }

const limit = 100

function reduce<T>(state: History<T>, action: Action<T>): History<T> {
  if (action.type === 'update') {
    const value = typeof action.next === 'function' ? (action.next as (current: T) => T)(state.value) : action.next
    if (JSON.stringify(value) === JSON.stringify(state.value)) {
      return action.options?.replace || action.options?.group === state.group ? state : { ...state, group: undefined }
    }
    // Layout normalization belongs to the edit that caused it, and must not
    // discard the redo branch when it follows an undo.
    if (action.options?.replace) return { ...state, value }
    const grouped = action.options?.group !== undefined && action.options.group === state.group
    return {
      value,
      past: grouped ? state.past : [...state.past, state.value].slice(-limit),
      future: [],
      group: action.options?.group,
    }
  }
  if (action.type === 'reset') return { value: action.value, past: [], future: [] }
  if (action.type === 'undo' && state.past.length) {
    return { value: state.past[state.past.length - 1]!, past: state.past.slice(0, -1), future: [state.value, ...state.future] }
  }
  if (action.type === 'redo' && state.future.length) {
    return { value: state.future[0]!, past: [...state.past, state.value].slice(-limit), future: state.future.slice(1) }
  }
  return state.group === undefined ? state : { ...state, group: undefined }
}

/** Undoable immutable JSON drafts. A save checkpoint belongs to the caller. */
export function useHistory<T>(initial: T) {
  const [state, dispatch] = useReducer(reduce<T>, { value: initial, past: [], future: [] })
  const update = useCallback((next: Update<T>, options?: UpdateOptions) => dispatch({ type: 'update', next, options }), [])
  const undo = useCallback(() => dispatch({ type: 'undo' }), [])
  const redo = useCallback(() => dispatch({ type: 'redo' }), [])
  const endGroup = useCallback(() => dispatch({ type: 'endGroup' }), [])
  /** Start a new history, for a draft whose earlier states must not come back. */
  const reset = useCallback((value: T) => dispatch({ type: 'reset', value }), [])
  return { value: state.value, update, undo, redo, endGroup, reset, canUndo: state.past.length > 0, canRedo: state.future.length > 0 }
}
