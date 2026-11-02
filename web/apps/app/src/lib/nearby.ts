import { createContext, useContext, useEffect, useMemo, useState, type RefObject } from 'react'

/** Whether the element is within what the area shows, widened by as much again on every side. Not laid out, it is not known to be. */
function within(element: Element, area: Element | null): boolean {
  const box = element.getBoundingClientRect()
  const shown = area ? area.getBoundingClientRect() : { top: 0, left: 0, bottom: window.innerHeight, right: window.innerWidth, width: window.innerWidth, height: window.innerHeight }
  if ((!box.width && !box.height) || (!shown.width && !shown.height)) return false
  return box.bottom >= shown.top - shown.height && box.top <= shown.bottom + shown.height
    && box.right >= shown.left - shown.width && box.left <= shown.right + shown.width
}

/**
 * Where a board scrolls, which tells the charts on it when they come within a
 * screen of what it shows, in any direction. One observer watches them all,
 * made when the first is watched and let go when the last no longer is.
 */
export class Area {
  private observer?: IntersectionObserver
  private readonly watched = new Map<Element, () => void>()
  private root?: { element: Element | null }

  /** element gives what scrolls; none, and it is the window. It is asked once, when the first chart is watched. */
  constructor(private readonly element: () => Element | null) {}

  /** Calls near once the element has come near, at once if it already is; gives back what stops watching it. */
  watch(element: Element, near: () => void): () => void {
    if (typeof IntersectionObserver === 'undefined') {
      near()
      return () => undefined
    }
    this.root ??= { element: this.element() }
    const root = this.root.element
    // Where it is now is measured at once. The browser says nothing until it next
    // draws the page, and draws nothing for a tab in the background: a board
    // opened there still asks for its first screen.
    if (within(element, root)) {
      near()
      return () => undefined
    }
    // The margin is the size of what the area shows, on each side.
    this.observer ??= new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const told = this.watched.get(entry.target)
        if (!entry.isIntersecting || !told) continue
        this.unwatch(entry.target)
        told()
      }
    }, { root, rootMargin: '100%' })
    this.watched.set(element, near)
    this.observer.observe(element)
    return () => this.unwatch(element)
  }

  private unwatch(element: Element) {
    if (!this.watched.delete(element)) return
    this.observer?.unobserve(element)
    if (this.watched.size) return
    this.observer?.disconnect()
    this.observer = undefined
  }
}

/** The area a board scrolls in, for its charts. Outside any, every chart is near. */
export const ScrollArea = createContext<Area | undefined>(undefined)

/** An area that scrolls in what element gives; another element function is another area. */
export function useArea(element: () => Element | null): Area {
  return useMemo(() => new Area(element), [element])
}

/**
 * Whether the element has come within a screen of what its scroll area shows.
 * Once it has, it stays so: a chart that has asked for its data keeps it up
 * to date wherever it is scrolled to. See .agents/design/chart-dashboard.md 3.11.
 */
export function useNearby(element: RefObject<Element | null>): boolean {
  const area = useContext(ScrollArea)
  const [near, setNear] = useState(() => !area || typeof IntersectionObserver === 'undefined')
  // Not a layout effect: a board finds where it scrolls by an element of its own, which is not yet at hand while its charts lay out.
  useEffect(() => {
    const target = element.current
    if (near || !area || !target) return
    return area.watch(target, () => setNear(true))
  }, [near, area, element])
  return near
}
