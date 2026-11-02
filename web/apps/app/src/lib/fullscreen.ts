import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Shows one part of the page over everything else, and the browser's own
 * bars go too where it allows. The whole document goes full screen rather
 * than the part, so menus and dialogs, which open at the end of the document,
 * still show; the part covers the rest of the page by itself. Escape leaves.
 */
export function useFullscreen(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(false)
  // Whether the browser went full screen for this, so leaving undoes only what was done here.
  const entered = useRef(false)
  const set = useCallback((next: boolean) => {
    setOn(next)
    if (next) {
      void document.documentElement.requestFullscreen?.().then(() => { entered.current = true }, () => undefined)
    } else if (entered.current && document.fullscreenElement) {
      entered.current = false
      void document.exitFullscreen().catch(() => undefined)
    }
  }, [])
  useEffect(() => {
    if (!on) return
    // The browser leaving full screen, by Escape or by its own controls, leaves here too.
    const changed = () => {
      if (document.fullscreenElement) return
      entered.current = false
      setOn(false)
    }
    // Where the browser would not go full screen, Escape still leaves, unless it closes a menu or a dialog.
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.fullscreenElement || document.querySelector('[role="dialog"], [data-radix-popper-content-wrapper]')) return
      setOn(false)
    }
    document.addEventListener('fullscreenchange', changed)
    document.addEventListener('keydown', keydown)
    return () => {
      document.removeEventListener('fullscreenchange', changed)
      document.removeEventListener('keydown', keydown)
    }
  }, [on])
  useEffect(() => () => {
    if (entered.current && document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
  }, [])
  return [on, set]
}
