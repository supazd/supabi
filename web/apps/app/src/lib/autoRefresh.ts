// A viewed dashboard's timed refresh. See .agents/design/chart-dashboard.md 3.9.
import type { TFunction } from 'i18next'
import { useEffect, useRef, useState } from 'react'

/** The intervals a dashboard may refresh at, in seconds, as the server accepts them. */
export const autoRefreshIntervals = [60, 300, 900, 1800, 3600] as const

/** An interval in words: "Refresh every 5 minutes"; 0 is no timed refresh. */
export function autoRefreshLabel(seconds: number, t: TFunction): string {
  if (!seconds) return t('dashboard.autoRefreshOff')
  return seconds % 3600 === 0 ? t('dashboard.autoRefreshHours', { count: seconds / 3600 }) : t('dashboard.autoRefreshMinutes', { count: seconds / 60 })
}

/**
 * The maxAge a timed refresh asks the cache for: a little under the interval,
 * so the result this page itself fetched one interval ago always counts as
 * too old, however the network and the timer drifted, while one fetched by
 * someone else since is used.
 */
export function refreshMaxAge(seconds: number): number {
  return seconds - Math.min(Math.floor(seconds / 10), 30)
}

/**
 * Calls refresh every so many seconds while the page is in view. A hidden
 * page waits; when it comes back after the interval has passed, it refreshes
 * at once. Zero seconds never refreshes. Returns when the next refresh is due,
 * in milliseconds since the epoch, while there is one.
 */
export function useAutoRefresh(seconds: number, refresh: () => void): number | undefined {
  const latest = useRef(refresh)
  useEffect(() => {
    latest.current = refresh
  })
  // When the timer last refreshed, or the page opened.
  const [last, setLast] = useState(() => Date.now())
  useEffect(() => {
    if (!seconds) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      clearTimeout(timer)
      if (document.visibilityState === 'hidden') return
      timer = setTimeout(() => {
        setLast(Date.now())
        latest.current()
      }, Math.max(0, last + seconds * 1000 - Date.now()))
    }
    schedule()
    document.addEventListener('visibilitychange', schedule)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', schedule)
    }
  }, [seconds, last])
  return seconds ? last + seconds * 1000 : undefined
}
