/**
 * How long ago a result was fetched, in words: "3 minutes ago", "2 hours ago".
 * Under a minute it is justNow.
 */
export function fetchedAgo(at: Date, now: Date, language: string, justNow: string): string {
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000)
  if (minutes < 1) return justNow
  const format = new Intl.RelativeTimeFormat(language, { numeric: 'always' })
  if (minutes < 60) return format.format(-minutes, 'minute')
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return format.format(-hours, 'hour')
  return format.format(-Math.floor(hours / 24), 'day')
}

/** A moment as a clock time, such as 14:32:05, with the date as well when it is not today. */
export function clockTime(at: Date, now: Date, language: string): string {
  const time = { hour: '2-digit', minute: '2-digit', second: '2-digit' } as const
  return at.toDateString() === now.toDateString() ? at.toLocaleTimeString(language, time) : at.toLocaleString(language, { month: 'numeric', day: 'numeric', ...time })
}

/**
 * Decides which loads ask the database again rather than for results kept
 * from before: the first load after refreshKey changes, and that same load
 * repeated (React may run an effect twice, a failed load may be retried).
 * A load of anything else, such as a changed filter, may use kept results.
 */
export function freshLoads(initialKey: string): (refreshKey: string, loadKey: string) => boolean {
  let last: { refreshKey: string; loadKey: string | null } = { refreshKey: initialKey, loadKey: null }
  return (refreshKey, loadKey) => {
    const fresh = refreshKey !== last.refreshKey || loadKey === last.loadKey
    last = { refreshKey, loadKey: fresh ? loadKey : null }
    return fresh
  }
}

/** freshLoads kept apart for each of several lists, such as each filter's options. */
export function freshLoadsBy(initialKey: string): (name: string, refreshKey: string, loadKey: string) => boolean {
  const byName = new Map<string, ReturnType<typeof freshLoads>>()
  return (name, refreshKey, loadKey) => {
    let decide = byName.get(name)
    if (!decide) byName.set(name, (decide = freshLoads(initialKey)))
    return decide(refreshKey, loadKey)
  }
}
