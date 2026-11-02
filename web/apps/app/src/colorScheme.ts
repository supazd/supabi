import type { ColorScheme } from '@supabi/ui'

const storageKey = 'supabi.colorScheme'
const darkQuery = '(prefers-color-scheme: dark)'

/** Saved choice first, then what the system prefers. */
export function detectColorScheme(): ColorScheme {
  let saved: string | null = null
  try {
    saved = localStorage.getItem(storageKey)
  } catch {
    // storage can be unavailable (private mode, embedded frames)
  }
  if (saved === 'dark' || saved === 'light') return saved
  return window.matchMedia(darkQuery).matches ? 'dark' : 'light'
}

export function saveColorScheme(colorScheme: ColorScheme) {
  try {
    localStorage.setItem(storageKey, colorScheme)
  } catch {
    // see detectColorScheme
  }
}
