import { createContext, useEffect, useMemo, useRef, type ReactNode } from 'react'

/** Where an item is on a grid, in grid units. */
export interface GridPlace { id: string; x: number; y: number; w: number; h: number }

/** An item dragged from one grid of a group onto another, where it was let go. */
export interface GridMove {
  id: string
  /** The keys of the grids it came from and went to. */
  from: string
  to: string
  /** Everything on the grid it went to, itself among it, where it is once room was made for it. */
  items: GridPlace[]
}

/** What is dragged over a grid from another: its size, and where on the screen its top left corner is. */
export interface GridIncoming { id: string; w: number; h: number; left: number; top: number }

/** What a grid of a group does for the group. */
export interface GridMember {
  element: () => HTMLElement | null
  /** Shows what is dragged over it from another grid; null, that it has gone. */
  receive: (incoming: GridIncoming | null) => void
  /** Where everything on it would be if what is dragged over it were let go now. */
  landing: () => GridPlace[] | undefined
  /** Dragged from, whether its item is over another grid; it then keeps the item's place as it was. */
  away: (away: boolean) => void
}

export interface GridDragStart {
  id: string
  w: number
  h: number
  /** Where the item was taken hold of, from its top left corner. */
  grab: { x: number; y: number }
  pointer: { x: number; y: number }
}

export interface GridGroupApi {
  register: (key: string, member: GridMember) => () => void
  start: (key: string, drag: GridDragStart) => void
  /** Ends the drag from that grid: true when the item was let go over another grid and went there. */
  end: (key: string) => boolean
}

export const GridGroupContext = createContext<GridGroupApi | undefined>(undefined)

interface Area { left: number; top: number; right: number; bottom: number }

interface Drag extends GridDragStart {
  from: string
  /** The other grids as they were when the drag started, with how far what they are in was scrolled then. */
  areas: Map<string, Area>
  scroller: HTMLElement | null
  scrolled: { x: number; y: number }
  over?: string
}

/** What the grid scrolls in: the nearest scrolling box around it, or else the page. */
function scrollerOf(node: HTMLElement | null): HTMLElement | null {
  for (let element = node?.parentElement; element; element = element.parentElement) {
    const { overflowY } = window.getComputedStyle(element)
    if (overflowY === 'auto' || overflowY === 'scroll') return element
  }
  return null
}
const scrollOf = (scroller: HTMLElement | null) => scroller ? { x: scroller.scrollLeft, y: scroller.scrollTop } : { x: window.scrollX, y: window.scrollY }

/**
 * Grids an item can be dragged between, such as the areas of a page laid
 * out one above another. Each joins with GridLayout's `group`, by a key of
 * its own; an item let go over another grid is handed to onMove.
 */
export function GridGroup({ onMove, children }: { onMove: (move: GridMove) => void; children: ReactNode }) {
  const members = useRef(new Map<string, GridMember>())
  const drag = useRef<Drag | null>(null)
  const moved = useRef(onMove)
  moved.current = onMove
  const halt = useRef(() => {})
  const api = useMemo<GridGroupApi>(() => {
    // Which grid the pointer is over is told by where the grids were when
    // the drag started. A grid dragged from can grow under the pointer as
    // the item follows it, and push the others away from it for ever.
    const follow = () => {
      const now = drag.current
      if (!now) return
      const scrolled = scrollOf(now.scroller)
      const x = now.pointer.x + scrolled.x - now.scrolled.x
      const y = now.pointer.y + scrolled.y - now.scrolled.y
      let over: string | undefined
      for (const [key, area] of now.areas) if (x >= area.left && x < area.right && y >= area.top && y < area.bottom) over = key
      if (over !== now.over) {
        if (now.over !== undefined) members.current.get(now.over)?.receive(null)
        members.current.get(now.from)?.away(over !== undefined)
        now.over = over
      }
      if (over !== undefined) members.current.get(over)?.receive({ id: now.id, w: now.w, h: now.h, left: now.pointer.x - now.grab.x, top: now.pointer.y - now.grab.y })
    }
    // Taken before the dragged item hears of the move, so that it already knows where it is to be.
    const point = (event: MouseEvent | TouchEvent) => {
      const at = 'touches' in event ? event.touches[0] : event
      if (!drag.current || !at) return
      drag.current.pointer = { x: at.clientX, y: at.clientY }
      follow()
    }
    const listen = (on: boolean) => {
      for (const type of ['mousemove', 'touchmove'] as const) {
        if (on) window.addEventListener(type, point, true)
        else window.removeEventListener(type, point, true)
      }
      // What is scrolled while the pointer stays still brings other grids under it.
      if (on) window.addEventListener('scroll', follow, true)
      else window.removeEventListener('scroll', follow, true)
    }
    const stop = () => {
      const now = drag.current
      if (!now) return
      drag.current = null
      listen(false)
      if (now.over !== undefined) members.current.get(now.over)?.receive(null)
      members.current.get(now.from)?.away(false)
    }
    halt.current = stop
    return {
      register(key, member) {
        members.current.set(key, member)
        return () => {
          if (members.current.get(key) !== member) return
          // A grid gone while dragged from or over, the drag is over for the group.
          if (drag.current?.from === key || drag.current?.over === key) stop()
          members.current.delete(key)
        }
      },
      start(key, start) {
        stop()
        const source = members.current.get(key)?.element() ?? null
        const scroller = scrollerOf(source)
        const areas = new Map<string, Area>()
        for (const [other, member] of members.current) {
          const box = other === key ? undefined : member.element()?.getBoundingClientRect()
          if (box && box.width > 0 && box.height > 0) areas.set(other, { left: box.left, top: box.top, right: box.right, bottom: box.bottom })
        }
        drag.current = { ...start, from: key, areas, scroller, scrolled: scrollOf(scroller) }
        listen(true)
        follow()
      },
      end(key) {
        const now = drag.current
        if (!now || now.from !== key) return false
        const to = now.over
        const items = to === undefined ? undefined : members.current.get(to)?.landing()
        stop()
        if (to === undefined || !items) return false
        moved.current({ id: now.id, from: key, to, items })
        return true
      },
    }
  }, [])
  // Gone in the middle of a drag, it leaves nothing listening.
  useEffect(() => () => halt.current(), [])
  return <GridGroupContext.Provider value={api}>{children}</GridGroupContext.Provider>
}
