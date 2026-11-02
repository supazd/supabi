import { useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import ReactGridLayout, { useContainerWidth, type Layout } from 'react-grid-layout'
import { calcGridItemPosition, calcXYRaw, defaultConstraints, type LayoutConstraint, type PositionParams } from 'react-grid-layout/core'
import { gridColumnGap, gridCompactor } from './gridCompactor'
import { GridGroupContext, type GridIncoming, type GridMember, type GridPlace } from './GridGroup'
import 'react-grid-layout/css/styles.css'
import './gridLayout.css'

export interface GridItem {
  id: string
  /** Position and size in grid units: columns across, rows down. */
  x: number
  y: number
  w: number
  h: number
  minH?: number
  /** Fit measured content in both directions; users can still resize the width. */
  autoHeight?: boolean
  maxH?: number
  /** Content that sets the minimum height, plus its surrounding padding/border. */
  minContentSelector?: string
  contentPadding?: number
  /** Never dragged onto another grid of the group this grid is in. */
  keepInGrid?: boolean
}

export interface GridLayoutProps<T extends GridItem> {
  items: T[]
  columns: number
  /** Height of one row in pixels, not counting the gap. */
  rowHeight: number
  gap: number
  columnGap?: number
  containerGap?: number
  autoCompact?: boolean
  minWidth?: number
  /** Scale default component dimensions and empty canvas space for a finer grid. */
  unitScale?: number
  /** When set, items can be dragged by `handleSelector` and resized from their corner. */
  editable?: boolean
  /** CSS selector of the part of an item that drags it. */
  handleSelector?: string
  /** CSS selector of controls inside the handle that must not start a drag. */
  cancelSelector?: string
  onChange?: (items: T[]) => void
  /** Automatic compaction, as distinct from an author's drag or resize. */
  onNormalize?: (items: T[]) => void
  renderItem: (item: T) => ReactNode
  /** Below this container width items are stacked in reading order instead. */
  stackBelow?: number
  /**
   * When set on an editable layout, something dragged from elsewhere on the
   * page can be dropped onto the grid if it carries data of this type.
   */
  dropType?: string
  /** The size, in grid units, of what is dropped. */
  dropSize?: { w: number; h: number }
  /**
   * Called when something is dropped: with the data it carried, where it
   * landed, and the items as they are once they have made room for it.
   */
  onDropItem?: (data: string, place: { x: number; y: number; w: number; h: number }, items: T[]) => void
  /**
   * Items that take what is dropped onto them instead of making room for it
   * carry this attribute, valued with their id. Over one, no room is made;
   * dropped there, onDropInto is called with the data and that id.
   */
  dropIntoAttribute?: string
  /** A drag that also carries data of this type is never taken into an item; room is made for it as for anything else. */
  dropIntoExcept?: string
  onDropInto?: (data: string, itemId: string) => void
  /**
   * The key this grid goes by in the GridGroup around it. Being arranged,
   * its items can then be dragged onto the group's other grids, and theirs
   * onto it; the group is told where they were let go.
   */
  group?: string
}

/** The layout key of what is dragged over a grid from another grid of its group. */
const incomingKey = '__incoming__'

/**
 * Where items end up when something is put among them where it is marked:
 * whatever is in its way moves down, and in turn whatever that comes onto.
 */
function makeRoom(items: { id: string; x: number; y: number; w: number; h: number }[], landed: { x: number; y: number; w: number; h: number }, containerGap: number): Map<string, number> {
  const settled = [landed]
  const lowered = new Map<string, number>()
  for (const item of [...items].sort((a, b) => a.y - b.y || a.x - b.x)) {
    let y = item.y
    for (let hit; (hit = settled.find((other) => item.x < other.x + other.w && other.x < item.x + item.w && y < other.y + other.h + containerGap && other.y < y + item.h + containerGap)); ) y = hit.y + hit.h + containerGap
    settled.push({ x: item.x, y, w: item.w, h: item.h })
    lowered.set(item.id, y)
  }
  return lowered
}

/** Where on the screen a mouse or touch event happened. */
function pointOf(event: Event): { x: number; y: number } {
  const at = 'touches' in event ? (event as TouchEvent).touches[0] ?? (event as TouchEvent).changedTouches[0] : event as MouseEvent
  return { x: at?.clientX ?? 0, y: at?.clientY ?? 0 }
}

/** The pixel height of an item `h` rows tall. */
export function gridItemHeight(h: number, rowHeight: number, gap: number): number {
  return h * (rowHeight + gap) - gap
}

/** Items placed on a grid; optionally rearranged by dragging and resizing. */
export function GridLayout<T extends GridItem>({ items, columns, rowHeight, gap, columnGap = gap, containerGap = 0, autoCompact = true, minWidth, unitScale = 1, editable = false, handleSelector, cancelSelector, onChange, onNormalize, renderItem, stackBelow = 640, dropType, dropSize = { w: 4, h: 4 }, onDropItem, dropIntoAttribute, dropIntoExcept, onDropInto, group }: GridLayoutProps<T>) {
  // Nothing is laid out until the width is known. Laid out for a width that
  // was only assumed, the items would then be seen easing to their real places.
  const { width, containerRef, mounted } = useContainerWidth({ measureBeforeMount: true })
  const horizontalGap = gridColumnGap(width, columns, columnGap)
  const compactor = useMemo(() => gridCompactor(autoCompact, containerGap), [autoCompact, containerGap])
  // The item being resized, at the size it would have if let go now. The
  // library lets an item follow the pointer and marks where it would land;
  // here the item keeps to the grid, so what is seen while resizing is what
  // is got, and what is inside can lay itself out for that size as it goes.
  const [resizing, setResizing] = useState<{ id: string; w: number; h: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  // Set from when the user takes hold of an item until the grid has said where everything ended up.
  const arranging = useRef(false)
  const arranged = () => {
    // Not at once: the grid says where things ended up as it lets go.
    window.setTimeout(() => (arranging.current = false))
  }
  // Something from elsewhere is over the grid, about to be dropped on it.
  const [receiving, setReceiving] = useState(false)
  /** The id of the item under an event that takes drops into itself, if any. */
  const into = (target: EventTarget | null) => (dropIntoAttribute && target instanceof Element ? target.closest(`[${dropIntoAttribute}]`)?.getAttribute(dropIntoAttribute) ?? undefined : undefined)
  useEffect(() => {
    if (!receiving) return
    // However the drag ends, the grid is no longer being dropped on.
    const done = () => setReceiving(false)
    window.addEventListener('dragend', done)
    window.addEventListener('drop', done)
    return () => {
      window.removeEventListener('dragend', done)
      window.removeEventListener('drop', done)
    }
  }, [receiving])
  const pitch = rowHeight + gap
  const itemNodes = useRef(new Map<string, HTMLDivElement>())
  const [contentRows, setContentRows] = useState<Record<string, number>>({})
  useEffect(() => {
    const measure = () => {
      const next: Record<string, number> = {}
      for (const item of items) {
        const content = item.minContentSelector ? itemNodes.current.get(item.id)?.querySelector<HTMLElement>(item.minContentSelector) : undefined
        if (content?.offsetHeight) next[item.id] = Math.ceil((content.offsetHeight + (item.contentPadding ?? 0) + gap) / pitch)
      }
      setContentRows((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next)
    }
    const observer = new ResizeObserver(measure)
    for (const item of items) {
      const content = item.minContentSelector ? itemNodes.current.get(item.id)?.querySelector(item.minContentSelector) : undefined
      if (content) observer.observe(content)
    }
    measure()
    return () => observer.disconnect()
  }, [items, mounted, width, pitch, gap])
  const positionParams = useMemo<PositionParams>(() => ({ cols: columns, containerWidth: width, rowHeight, margin: [horizontalGap, gap], containerPadding: [0, 0], maxRows: Infinity }), [columns, width, rowHeight, horizontalGap, gap])
  const layout = items.map((item) => {
    const maxH = item.maxH ?? 24 * unitScale
    const minH = Math.min(maxH, Math.max(item.minH ?? 2 * unitScale, contentRows[item.id] ?? 0))
    const minW = Math.min(columns, minWidth ?? 2 * unitScale)
    const w = Math.min(columns, Math.max(item.w, minW))
    const h = item.autoHeight && contentRows[item.id] !== undefined ? minH : Math.min(maxH, Math.max(item.h, minH))
    return { i: item.id, x: Math.min(item.x, columns - w), y: item.y, w, h, minW, minH, maxH: item.autoHeight ? h : maxH, resizeHandles: item.autoHeight ? ['e' as const] : ['se' as const] }
  })

  // In a group, being arranged, items are dragged out of this grid onto the others, and in from them.
  const grids = useContext(GridGroupContext)
  const joined = editable && group !== undefined ? grids : undefined
  // What is dragged over this grid from another, and where it would land.
  const [incoming, setIncoming] = useState<GridPlace | null>(null)
  const coming = useRef<GridPlace | null>(null)
  // Dragged over another grid, the item keeps its place here, unmarked, until it is let go.
  const [away, setAway] = useState(false)
  const origin = useRef<{ x: number; y: number } | null>(null)
  const keepPlace = useRef<{ x: number; y: number } | null>(null)
  const constraints = useMemo<LayoutConstraint[]>(() => [...defaultConstraints, { name: 'keepPlaceWhileAway', constrainPosition: (_item, x, y) => keepPlace.current ?? { x, y } }], [])
  // Where the pointer took hold of an item, before it was dragged.
  const pressed = useRef<{ x: number; y: number } | null>(null)
  // An item let go over another grid, while the library still has it here.
  const gone = useRef<string | undefined>(undefined)
  /** The layout with what is dragged in where it would land, room made for it as for a dropped chart. */
  const arrange = (base: Layout, place: GridPlace): Layout => {
    const lowered = makeRoom(base.map((entry) => ({ id: entry.i, x: entry.x, y: entry.y, w: entry.w, h: entry.h })), place, containerGap)
    return compactor.compact([...base.map((entry) => ({ ...entry, y: lowered.get(entry.i) ?? entry.y })), { i: incomingKey, x: place.x, y: place.y, w: place.w, h: place.h }], columns)
  }
  const current = useRef(layout)
  current.current = layout
  const member = useRef<GridMember | null>(null)
  member.current = {
    element: () => containerRef.current,
    receive: (next: GridIncoming | null) => {
      const box = containerRef.current?.getBoundingClientRect()
      let place: GridPlace | null = null
      if (next && box) {
        // Its top left corner marks the cell it would land in, as an item's does dragged within the grid.
        const { x, y } = calcXYRaw(positionParams, next.top - box.top, next.left - box.left)
        const w = Math.min(next.w, columns)
        place = { id: next.id, x: Math.max(0, Math.min(x, columns - w)), y: Math.max(0, y), w, h: next.h }
      }
      if (JSON.stringify(place) === JSON.stringify(coming.current)) return
      coming.current = place
      setIncoming(place)
    },
    landing: () => {
      const place = coming.current
      return place ? arrange(current.current, place).map((entry) => ({ id: entry.i === incomingKey ? place.id : entry.i, x: entry.x, y: entry.y, w: entry.w, h: entry.h })) : undefined
    },
    away: (on: boolean) => {
      keepPlace.current = on ? origin.current : null
      setAway(on)
    },
  }
  useEffect(() => {
    if (!joined || group === undefined) return
    return joined.register(group, {
      element: () => member.current!.element(),
      receive: (next) => member.current!.receive(next),
      landing: () => member.current!.landing(),
      away: (on) => member.current!.away(on),
    })
  }, [joined, group])
  const shown = incoming ? arrange(layout, incoming).map((entry) => entry.i === incomingKey ? { ...entry, static: true } : entry) : layout
  // Use the layout library's rounded boundaries for every background cell too.
  // A full-width, two-row tile avoids accumulated fractional-pixel drift at 1.5px gaps.
  const cell = useMemo(() => {
    if (!editable || !mounted) return undefined
    const cells = Array.from({ length: 2 * columns }, (_, index) => {
      const box = calcGridItemPosition(positionParams, index % columns, Math.floor(index / columns), 1, 1)
      return `<rect x="${box.left}" y="${box.top}" width="${box.width}" height="${box.height}" rx="${Math.max(0, Math.min(6, box.height / 4, box.width / 4))}"/>`
    }).join('')
    return `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${2 * pitch}">${cells}</svg>`)}")`
  }, [columns, positionParams, width, pitch, editable, mounted])

  if (mounted && !editable && width < stackBelow) {
    const ordered = [...items].sort((a, b) => a.y - b.y || a.x - b.x)
    return (
      <div ref={containerRef} style={{ display: 'grid', gap: gap + containerGap * pitch }}>
        {ordered.map((item) => (
          <div ref={(node) => { if (node) itemNodes.current.set(item.id, node); else itemNodes.current.delete(item.id) }} key={item.id} style={{ height: gridItemHeight(layout.find((entry) => entry.i === item.id)!.h, rowHeight, gap) }}>
            {renderItem(item)}
          </div>
        ))}
      </div>
    )
  }

  return (
    // Room is kept under the items of a layout being arranged, to move them into and to drop new ones on.
    <div
      ref={containerRef}
      className={`${editable ? 'lb-grid editable' : 'lb-grid'}${away ? ' away' : ''}`}
      onMouseDownCapture={(event) => { pressed.current = { x: event.clientX, y: event.clientY } }}
      onTouchStartCapture={(event) => { const touch = event.touches[0]; if (touch) pressed.current = { x: touch.clientX, y: touch.clientY } }}
      // Caught on the way down: the library keeps this event to itself.
      onDragLeaveCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setReceiving(false)
      }}
      style={{ '--lb-grid-room': `${2 * unitScale * pitch}px`, '--lb-grid-least': `${gridItemHeight(4 * unitScale, rowHeight, gap)}px` } as CSSProperties}
    >
      {/* The cells items keep to: faint while arranging, plainer while something is being moved or resized. */}
      {mounted && editable && <div className={dragging || resizing || receiving || incoming ? 'lb-grid-cells active' : 'lb-grid-cells'} style={{ maskImage: cell, WebkitMaskImage: cell, maskSize: `${width}px ${2 * pitch}px`, WebkitMaskSize: `${width}px ${2 * pitch}px` }} aria-hidden />}
      {mounted && (
        <ReactGridLayout
          width={width}
          layout={shown}
          constraints={constraints}
          gridConfig={{ cols: columns, rowHeight, margin: [horizontalGap, gap], containerPadding: [0, 0] }}
          compactor={compactor}
          dragConfig={{ enabled: editable, handle: handleSelector, cancel: cancelSelector }}
          resizeConfig={{ enabled: editable }}
          dropConfig={{
            enabled: editable && Boolean(dropType),
            defaultItem: dropSize,
            // Only what was meant for the grid is taken: not a file, nor a piece of text.
            onDragOver: (event) => {
              if (!dropType || !event.dataTransfer?.types.includes(dropType)) return false
              setReceiving(true)
              // Over an item that takes it, nothing makes room; the drop is still taken.
              if (dropIntoAttribute && !(dropIntoExcept && event.dataTransfer.types.includes(dropIntoExcept)) && into(event.target)) return false
              return dropSize
            },
          }}
          onDrop={(_layout, dropped, event) => {
            const dragEvent = event as DragEvent
            const data = dropType ? dragEvent.dataTransfer?.getData(dropType) : undefined
            const container = containerRef.current
            const target = dropIntoExcept && dragEvent.dataTransfer?.types.includes(dropIntoExcept) ? undefined : into(dragEvent.target)
            if (!dropped && data && target && onDropInto) {
              onDropInto(data, target)
              return
            }
            if (!dropped || !data || !onDropItem || !container) return
            // The library marks the cell under the pointer but then puts what is
            // dropped under whatever was there. It is put where it was marked
            // instead, and what was there moves down to make room.
            const row = Math.max(0, Math.round((dragEvent.clientY - container.getBoundingClientRect().top) / pitch))
            const landed = { x: dropped.x, y: row, w: dropped.w, h: dropped.h }
            const lowered = makeRoom(items, landed, containerGap)
            onDropItem(data, landed, items.map((item) => ({ ...item, y: lowered.get(item.id) ?? item.y })))
          }}
          // What is being dropped from elsewhere is also reported as dragged, but never as let go.
          onDragStart={(_layout, before, after, _placeholder, event, node) => {
            const item = items.find((known) => known.id === (before ?? after)?.i)
            if (!item) return
            arranging.current = true
            gone.current = undefined
            setDragging(true)
            if (!joined || group === undefined || item.keepInGrid || !before || !node) return
            origin.current = { x: before.x, y: before.y }
            const box = node.getBoundingClientRect()
            const at = pointOf(event)
            const held = pressed.current ?? at
            joined.start(group, { id: before.i, w: before.w, h: before.h, grab: { x: held.x - box.left, y: held.y - box.top }, pointer: at })
          }}
          onDragStop={(_layout, before) => {
            // Let go over another grid, the item went there: where the library would put it here is not taken.
            if (joined && group !== undefined && joined.end(group) && before) {
              gone.current = before.i
              arranging.current = false
            } else arranged()
            setDragging(false)
          }}
          onResizeStart={() => {
            arranging.current = true
          }}
          onResize={(_layout, _before, _after, placeholder, _event, node) => {
            // What the library hands over is the handle being dragged, inside the item.
            const element = node?.closest<HTMLElement>('.react-grid-item')
            if (!placeholder || !element) return
            element.dataset.gridSnap = ''
            const box = calcGridItemPosition(positionParams, placeholder.x, placeholder.y, placeholder.w, placeholder.h)
            element.style.setProperty('--grid-snap-width', `${box.width}px`)
            element.style.setProperty('--grid-snap-height', `${box.height}px`)
            if (resizing?.id !== placeholder.i || resizing.w !== placeholder.w || resizing.h !== placeholder.h) setResizing({ id: placeholder.i, w: placeholder.w, h: placeholder.h })
          }}
          onResizeStop={(_layout, _before, _after, _placeholder, _event, node) => {
            const element = node?.closest<HTMLElement>('.react-grid-item')
            if (element) delete element.dataset.gridSnap
            element?.style.removeProperty('--grid-snap-width')
            element?.style.removeProperty('--grid-snap-height')
            arranged()
            setResizing(null)
          }}
          onLayoutChange={(reported) => {
            if (!editable || !onChange) return
            // What is dragged in from another grid is not on this one until it is let go here.
            if (coming.current) return
            if (gone.current !== undefined) {
              if (reported.some((entry) => entry.i === gone.current)) return
              gone.current = undefined
            }
            // The library keeps a layout of its own beside the one it is given,
            // and for a moment after the items were changed from outside, by a
            // drop for one, it reports the one it had. Taken, that would be
            // handed back to it just as it moves on to the new one, and the two
            // would chase each other for ever, the items jumping to and fro.
            // So unless the user has just arranged something, only what the
            // library makes of the items it was given is taken from it.
            if (!arranging.current) {
              const made = compactor.compact(layout, columns)
              const agrees = made.every((want) => {
                const got = reported.find((entry) => entry.i === want.i)
                return got !== undefined && got.x === want.x && got.y === want.y && got.w === want.w && got.h === want.h
              })
              if (!agrees) return
            }
            const next = items.map((item) => {
              const placed = reported.find((entry) => entry.i === item.id)
              return placed ? { ...item, x: placed.x, y: placed.y, w: placed.w, h: placed.h } : item
            })
            // The library also reports layouts that change nothing; passing those on would loop.
            if (next.some((item, index) => item.x !== items[index]!.x || item.y !== items[index]!.y || item.w !== items[index]!.w || item.h !== items[index]!.h)) (arranging.current ? onChange : onNormalize ?? onChange)(next)
          }}
        >
          {items.map((item) => (
            <div key={item.id}><div className="lb-grid-item-content" ref={(node) => { if (node) itemNodes.current.set(item.id, node); else itemNodes.current.delete(item.id) }}>{renderItem(resizing?.id === item.id ? { ...item, w: resizing.w, h: resizing.h } : item)}</div></div>
          ))}
          {incoming && <div key={incomingKey} className="react-grid-placeholder" aria-hidden />}
        </ReactGridLayout>
      )}
    </div>
  )
}
