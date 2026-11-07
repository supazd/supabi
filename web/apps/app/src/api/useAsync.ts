import { useCallback, useEffect, useState } from 'react'
import { ApiError } from './client'

export type AsyncState<T> =
  | { status: 'loading' }
  | { status: 'error'; error: ApiError }
  | {
      status: 'ok'
      data: T
      /** With keepData: a newer load is running, and data is what came before it. */
      pending?: boolean
      /** With keepData: the newer load failed, and data is what came before it. */
      failed?: ApiError
    }

/**
 * Loads data when the component mounts and whenever deps change. With
 * keepData, data once loaded stays while a newer load runs, and when it fails,
 * marked pending or failed instead of giving way to loading or the error.
 * With wait, it loads nothing, and stays loading, until wait is false. Waiting
 * is only for the first load: once wait has been false, it is not looked at
 * again, so no load is ever left without its answer. A load that is no longer
 * wanted, because deps changed or the component went away, is aborted through
 * the signal it is given, so that a request passed it stops on the server too:
 * .agents/design/query-ir.md 6.7.
 */
export function useAsync<T>(load: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[], { keepData = false, wait = false }: { keepData?: boolean; wait?: boolean } = {}): AsyncState<T> & { reload: () => void } {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [waiting, setWaiting] = useState(wait)
  if (waiting && !wait) setWaiting(false)

  useEffect(() => {
    if (waiting) return
    let current = true
    const controller = new AbortController()
    setState((previous) => (keepData && previous.status === 'ok' ? { status: 'ok', data: previous.data, pending: true } : { status: 'loading' }))
    load(controller.signal).then(
      (data) => current && setState({ status: 'ok', data }),
      (error: unknown) => current && setState((previous) => (keepData && previous.status === 'ok' ? { status: 'ok', data: previous.data, failed: toApiError(error) } : { status: 'error', error: toApiError(error) })),
    )
    return () => {
      current = false
      controller.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller lists what load depends on
  }, [...deps, attempt, waiting])

  const reload = useCallback(() => setAttempt((n) => n + 1), [])
  return { ...state, reload }
}

export function toApiError(error: unknown): ApiError {
  return error instanceof ApiError ? error : new ApiError(0, 'unexpected_error', error instanceof Error ? error.message : String(error))
}
