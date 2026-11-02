import { useCallback, useState } from 'react'

/** State kept in the browser, so the workbench opens the way it was left. */
export function useStored<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const saved = localStorage.getItem(key)
      return saved === null ? initial : (JSON.parse(saved) as T)
    } catch {
      return initial
    }
  })
  const set = useCallback(
    (next: T) => {
      setValue(next)
      try {
        localStorage.setItem(key, JSON.stringify(next))
      } catch {
        // storage can be unavailable (private mode, embedded frames)
      }
    },
    [key],
  )
  return [value, set]
}
