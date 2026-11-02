import { verticalCompactor, type Compactor, type LayoutItem } from 'react-grid-layout'

/** Keep the default path unchanged; extra rows belong to collision geometry, not tile size. */
export function gridCompactor(autoCompact: boolean, containerGap: number): Compactor {
  if (autoCompact && containerGap === 0) return verticalCompactor
  return {
    type: autoCompact ? 'vertical' : null,
    allowOverlap: false,
    compact(layout, columns) {
      if (autoCompact) {
        const padded = layout.map((item) => ({ ...item, h: item.h + containerGap }))
        return verticalCompactor.compact(padded, columns).map((item) => ({ ...item, h: item.h - containerGap }))
      }
      // Preserve empty rows, but repair collisions after resizing or changing columns.
      // Check occupied intervals directly instead of walking through every empty row.
      const settled: LayoutItem[] = []
      const positions = new Map<string, number>()
      for (const item of [...layout].sort((a, b) => a.y - b.y || a.x - b.x)) {
        let y = item.y
        const blockers = settled.filter((other) => item.x < other.x + other.w && other.x < item.x + item.w).sort((a, b) => a.y - b.y)
        for (const other of blockers) {
          if (y + item.h + containerGap <= other.y) break
          if (y < other.y + other.h + containerGap) y = other.y + other.h + containerGap
        }
        settled.push({ ...item, y })
        positions.set(item.i, y)
      }
      // Finish the movement cycle, as the built-in vertical compactor does.
      // RGL uses this flag when detecting and reporting the released layout.
      return layout.map((item) => ({ ...item, y: positions.get(item.i)!, moved: false }))
    },
  }
}

/** Shrink horizontal gutters on narrow canvases so every column retains usable width. */
export function gridColumnGap(width: number, columns: number, gap: number): number {
  return Math.min(gap, Math.max(0, (width - columns) / Math.max(1, columns - 1)))
}
