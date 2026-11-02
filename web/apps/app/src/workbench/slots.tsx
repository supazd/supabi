// The frame of the workbench owns the side panel, the bottom panel and the
// status bar; the page that is open says what goes in them. A page renders
// these components like any other, and what they hold is drawn in the frame.
import { Tooltip } from '@supabi/ui'
import { useEffect, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { Location } from 'react-router'
import { Icon } from '../components/Icon'
import { LeaveGuard } from '../components/UnsavedChanges'
import { useEditorPanels } from '../components/EditorPanels'
import { useStored } from '../lib/useStored'

/** How long a panel takes to fold; the same as in app.css. */
const foldMs = 160

export type Folding = 'opening' | 'closing' | undefined

/**
 * Says, for as long as it takes, that a panel is being shown or put away, so
 * that it unfolds and folds rather than jumps. Only a change counts: a panel
 * drawn already open is simply there. What is put away stays drawn until it
 * has folded.
 */
export function useFolding(open: boolean): Folding {
  const [was, setWas] = useState(open)
  const [folding, setFolding] = useState<Folding>()
  if (was !== open) {
    setWas(open)
    const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    setFolding(still ? undefined : open ? 'opening' : 'closing')
  }
  useEffect(() => {
    if (!folding) return
    const timer = setTimeout(() => setFolding(undefined), foldMs)
    return () => clearTimeout(timer)
  }, [folding])
  return folding
}

/** The class of what folds along `axis`. What is inside keeps its size and is covered; see app.css. */
export function foldClass(axis: 'x' | 'y', folding: Folding): string {
  return folding ? `wb-fold ${axis} ${folding}` : `wb-fold ${axis}`
}

/** The panel beside the page: what there is to open in this part of the workbench. */
export function SidePanel({ children }: { children: ReactNode }) {
  const { slots } = useEditorPanels()
  return slots.side ? createPortal(children, slots.side) : null
}

/**
 * A panel right before the page, as tall as the page: what the page is
 * written against, such as the tables of a database. It is there only while
 * a page fills it, and the page can put it away.
 */
export function AsidePanel({ label, open = true, children }: { label: string; open?: boolean; children: ReactNode }) {
  const { t } = useTranslation()
  const { slots, storageKey } = useEditorPanels()
  const [width, setWidth] = useStored(`${storageKey}.asideWidth`, 280)
  const folding = useFolding(open)
  if (!slots.aside || !(open || folding)) return null
  return createPortal(
    <div className={foldClass('x', folding)} style={{ width: `calc(${width}px + var(--island-gap))` }}>
      <aside className="wb-aside" style={{ '--wb-panel': `${width}px` } as CSSProperties} aria-label={label}>
        {children}
      </aside>
      <Resizer direction="horizontal" grows="forward" size={width} min={200} max={560} onResize={setWidth} label={t('workbench.resizeSide')} />
    </div>,
    slots.aside,
  )
}

/** A piece of the status bar: a fact about what is open, in a few words. */
export function StatusItem({ tone, children }: { tone?: 'warning'; children: ReactNode }) {
  const { slots } = useEditorPanels()
  return slots.status ? createPortal(<span className={tone ? `wb-status-item ${tone}` : 'wb-status-item'}>{children}</span>, slots.status) : null
}

/**
 * A handle that resizes what is next to it when dragged. `size` is what is
 * being resized; dragging towards `grows` makes it larger, within the limits.
 */
export function Resizer({ direction, grows, size, min, max, onResize, label }: { direction: 'horizontal' | 'vertical'; grows: 'forward' | 'backward'; size: number; min: number; max: number; onResize: (size: number) => void; label: string }) {
  const start = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    // Everything is measured from where the drag began: the size it began
    // with is the only one this handler can rely on while it lasts.
    const origin = direction === 'horizontal' ? event.clientX : event.clientY
    const move = (moved: PointerEvent) => {
      const travelled = (direction === 'horizontal' ? moved.clientX : moved.clientY) - origin
      onResize(Math.min(Math.max(size + (grows === 'forward' ? travelled : -travelled), min), max))
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      document.body.classList.remove('wb-resizing')
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    // Keeps the drag from selecting text, and the cursor steady, wherever the pointer goes.
    document.body.classList.add('wb-resizing')
  }
  return <div className={`wb-resizer ${direction}`} role="separator" aria-orientation={direction === 'horizontal' ? 'vertical' : 'horizontal'} aria-label={label} onPointerDown={start} />
}

export interface BottomTab {
  key: string
  label: ReactNode
  content: ReactNode
}

/**
 * The panel under the page, for what running something produced: rows, the
 * query, what refers to the resource. Collapsed, it is a bar of its tabs.
 * With `tab` given the page says which tab shows, and hears of a change
 * through `onTab`: for a page that has something to show in one of them.
 */
export function BottomPanel({ tabs, extra, tab, onTab }: { tabs: BottomTab[]; extra?: ReactNode; tab?: string; onTab?: (key: string) => void }) {
  const { t } = useTranslation()
  const { slots, bottomOpen, setBottomOpen, bottomHeight, setBottomHeight } = useEditorPanels()
  const [own, setOwn] = useState(tabs[0]?.key)
  const chosen = tab ?? own
  const setChosen = (key: string) => {
    setOwn(key)
    onTab?.(key)
  }
  const active = tabs.find((tab) => tab.key === chosen) ?? tabs[0]
  const folding = useFolding(bottomOpen)
  if (!slots.bottom || !active) return null

  return createPortal(
    <>
      {/* The gap above the panel is what resizes it. */}
      {bottomOpen ? <Resizer direction="vertical" grows="backward" size={bottomHeight} min={120} max={720} onResize={setBottomHeight} label={t('workbench.resizeBottom')} /> : <div className="wb-gap" />}
      <div className="wb-bottom-island">
      <div className="wb-bottom-bar" role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={bottomOpen && tab.key === active.key}
            className={bottomOpen && tab.key === active.key ? 'active' : undefined}
            onClick={() => {
              // Clicking the tab that is showing puts the panel away, as in an editor.
              setBottomOpen(!(bottomOpen && tab.key === active.key))
              setChosen(tab.key)
            }}
          >
            {tab.label}
          </button>
        ))}
        <span className="spacer" />
        {bottomOpen && extra}
        <Tooltip title={bottomOpen ? t('workbench.hidePanel') : t('workbench.showPanel')}>
          <button type="button" className="wb-icon-button" aria-label={bottomOpen ? t('workbench.hidePanel') : t('workbench.showPanel')} onClick={() => setBottomOpen(!bottomOpen)}>
            <Icon name={bottomOpen ? 'minus' : 'chevronDown'} />
          </button>
        </Tooltip>
      </div>
      {(bottomOpen || folding) && (
        <div className={foldClass('y', folding)} style={{ height: bottomHeight }}>
          <div className="wb-bottom-body" role="tabpanel" style={{ height: bottomHeight }}>
            {active.content}
          </div>
        </div>
      )}
      </div>
    </>,
    slots.bottom,
  )
}

/** Marks navigation that follows a save, which must not be asked about. */
export const afterSave = { saved: true }

/**
 * Keeps work that is not saved from being lost by accident: leaving the page
 * asks first, and the status bar says so while it lasts. `discards` tells of
 * a move within the page that would lose the work all the same.
 */
export function UnsavedGuard({ dirty, discards }: { dirty: boolean; discards?: (next: Location) => boolean }) {
  const { t } = useTranslation()
  return (
    <>
      {dirty && <StatusItem tone="warning">{t('workbench.unsaved')}</StatusItem>}
      <LeaveGuard dirty={dirty} discards={discards} />
    </>
  )
}
