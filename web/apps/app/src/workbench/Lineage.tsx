import { Button, Checkbox, Input, Tooltip } from '@supabi/ui'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router'
import { api, unwrap } from '../api/client'
import { useAsync } from '../api/useAsync'
import { Async } from '../components/Async'
import { Icon, type IconName } from '../components/Icon'
import { columnsOf, foldedAway, lineageKinds, lineageOf, named, only, unread, withLineage, withoutKinds, type LineageGraph, type LineageKind, type LineageNode } from '../lib/lineage'
import { useStored } from '../lib/useStored'
import { SidePanel, StatusItem } from './slots'

export const kindIcons: Record<LineageKind, IconName> = { datasource: 'database', table: 'table', dataset: 'dataset', chart: 'chart', dashboard: 'dashboard' }

// The part of the workbench a resource of each kind is opened in. A table is
// not kept here and has nowhere to be opened.
export const opened: Partial<Record<LineageKind, string>> = {
  datasource: 'datasources',
  dataset: 'datasets',
  chart: 'charts',
  dashboard: 'dashboards',
}

// The drawing, in its own units: resources are cards of one size in columns.
export const boxWidth = 212
export const boxHeight = 46
export const rowGap = 10
export const columnGap = 76
const stripHeight = 36
const pad = 24
const leastZoom = 0.35
const mostZoom = 1.6

interface View {
  x: number
  y: number
  /** How large the drawing is shown: 1 is its own size. */
  k: number
}

const clamp = (value: number, least: number, most: number) => Math.min(Math.max(value, least), most)

/** The view after zooming by `factor` with the point (px, py) of the frame held still. */
function zoomed(view: View, px: number, py: number, factor: number): View {
  const k = clamp(view.k * factor, leastZoom, mostZoom)
  return { k, x: px - (px - view.x) * (k / view.k), y: py - (py - view.y) * (k / view.k) }
}

/**
 * What reads what in the workspace, drawn from the data sources on the left
 * to the dashboards on the right. Choosing a resource marks everything that
 * leads to it and from it and says what that is; the panel beside cuts the
 * drawing down. The drawing is moved by dragging and zoomed like a map.
 */
export function LineageSection() {
  const lineage = useAsync(() => unwrap(api.GET('/lineage')), [])
  return (
    <Async state={lineage} reload={lineage.reload}>
      {(graph) => <LineageMap graph={graph} reload={lineage.reload} />}
    </Async>
  )
}

function LineageMap({ graph, reload }: { graph: LineageGraph; reload: () => void }) {
  const { t } = useTranslation()
  const [params, setParams] = useSearchParams()
  const [search, setSearch] = useState('')
  const [left, setLeft] = useStored<LineageKind[]>('supabi.lineage.hiddenKinds', [])
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [focused, setFocused] = useStored('supabi.lineage.focused', false)
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set())
  const [pointed, setPointed] = useState<string | null>(null)
  const [view, setView] = useState<View>({ x: pad, y: stripHeight + pad, k: 1 })
  // Set while the view is being moved for the user rather than by them: then it glides.
  const [gliding, setGliding] = useState(false)
  const [dragging, setDragging] = useState(false)
  const frame = useRef<HTMLDivElement>(null)

  // What is chosen is in the address, so that it can be linked to.
  const wanted = params.get('focus')
  const setChosen = (id: string | null) =>
    setParams(
      (now) => {
        const next = new URLSearchParams(now)
        if (id) next.set('focus', id)
        else next.delete('focus')
        return next
      },
      { replace: true },
    )

  // Said of a resource whatever is being shown: counted over everything there is.
  const facts = useMemo(() => {
    const readers = new Map<string, number>()
    const sources = new Map<string, number>()
    for (const edge of graph.edges) {
      readers.set(edge.from, (readers.get(edge.from) ?? 0) + 1)
      sources.set(edge.to, (sources.get(edge.to) ?? 0) + 1)
    }
    return { readers, sources, unread: unread(graph) }
  }, [graph])

  const drawn = useMemo(() => {
    const base = withoutKinds(graph, new Set(left))
    const chosen = base.nodes.some((node) => node.id === wanted) ? wanted : null
    // Each thing asked for cuts down what the one before left.
    let kept: Set<string> | null = null
    const narrow = (ids: Set<string>) => {
      kept = kept ? new Set([...ids].filter((id) => kept!.has(id))) : ids
    }
    if (search.trim()) narrow(withLineage(base, named(base, search)))
    if (unreadOnly) narrow(withLineage(base, unread(base)))
    if (focused && chosen) narrow(withLineage(base, [chosen]))
    const asked = kept ? only(base, kept) : base
    const { hidden, counts } = foldedAway(asked, folded)
    const shown = only(asked, new Set(asked.nodes.filter((node) => !hidden.has(node.id)).map((node) => node.id)))
    const columns = columnsOf(shown)

    // A column shorter than the tallest sits at its middle, so lines run level rather than all downhill.
    const tallest = Math.max(0, ...columns.map((column) => column.nodes.length))
    const step = boxHeight + rowGap
    const at = new Map<string, { x: number; y: number }>()
    columns.forEach((column, across) =>
      column.nodes.forEach((node, down) => at.set(node.id, { x: across * (boxWidth + columnGap), y: ((tallest - column.nodes.length) * step) / 2 + down * step })),
    )
    return {
      asked,
      shown,
      columns,
      at,
      counts,
      // Whatever reads something can be folded under it, shown or not.
      foldable: new Set(asked.edges.map((edge) => edge.from)),
      chosen: chosen && asked.nodes.some((node) => node.id === chosen) ? chosen : null,
      width: columns.length * boxWidth + Math.max(0, columns.length - 1) * columnGap,
      height: Math.max(0, tallest * step - rowGap),
    }
  }, [graph, left, wanted, search, unreadOnly, focused, folded])

  const { asked, shown, columns, at, counts, foldable, chosen, width, height } = drawn

  // What is lit: the lineage of what is pointed at, or else of what is chosen.
  const lit = useMemo(() => {
    const id = pointed && at.has(pointed) ? pointed : chosen && at.has(chosen) ? chosen : null
    if (!id) return null
    const { upstream, downstream } = lineageOf(shown, id)
    return { up: new Set([...upstream, id]), down: new Set([...downstream, id]) }
  }, [shown, at, pointed, chosen])
  // What the card lists: everything asked for, folded away or not.
  const chosenLineage = useMemo(() => (chosen ? lineageOf(asked, chosen) : null), [asked, chosen])
  const chosenNode = chosen ? asked.nodes.find((node) => node.id === chosen) : undefined

  const glide = (next: View) => {
    setGliding(true)
    setView(next)
    window.setTimeout(() => setGliding(false), 260)
  }
  const fitted = (): View | null => {
    const el = frame.current
    if (!el || width === 0) return null
    const k = clamp(Math.min((el.clientWidth - pad * 2) / width, (el.clientHeight - stripHeight - pad * 2) / Math.max(height, 1), 1), leastZoom, 1)
    return { k, x: Math.max(pad, (el.clientWidth - width * k) / 2), y: stripHeight + pad }
  }
  // The card of what is chosen covers this much of the frame's right side.
  const cardWidth = 296
  /** The view with the resource in the middle of what the card leaves free; nothing when it is in plain sight already. */
  const centred = (id: string, k: number, always: boolean): View | null => {
    const el = frame.current
    const place = at.get(id)
    if (!el || !place) return null
    const free = el.clientWidth - cardWidth
    const seen = { left: view.x + place.x * view.k, top: view.y + place.y * view.k }
    if (!always && seen.left >= pad && seen.left + boxWidth * view.k <= free - pad && seen.top >= stripHeight && seen.top + boxHeight * view.k <= el.clientHeight - pad) return null
    return { k, x: free / 2 - (place.x + boxWidth / 2) * k, y: (el.clientHeight + stripHeight) / 2 - (place.y + boxHeight / 2) * k }
  }

  // What is chosen is brought into sight when it is not: chosen from a link or
  // the card's lists it may be anywhere, and chosen on the drawing it may be
  // where the card is about to open.
  const settled = useRef(false)
  useLayoutEffect(() => {
    if (!frame.current) return
    if (!settled.current) {
      // The first sight of it: the chosen one in the middle, or else all of it.
      settled.current = true
      const first = (chosen && centred(chosen, 1, true)) || fitted()
      if (first) setView(first)
      return
    }
    if (chosen) {
      const next = centred(chosen, Math.max(view.k, 0.75), false)
      if (next) glide(next)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- moved when what is chosen changes, or first appears in the drawing
  }, [chosen, chosen ? at.has(chosen) : false, width === 0])

  // The wheel moves the drawing; with Ctrl or ⌘ it zooms about the pointer. The
  // listener is added by hand: React's own cannot stop the page from scrolling.
  const drawing = width > 0
  useEffect(() => {
    const el = frame.current
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      if ((event.target as Element).closest('.lineage-card')) return
      event.preventDefault()
      const box = el.getBoundingClientRect()
      if (event.ctrlKey || event.metaKey) setView((now) => zoomed(now, event.clientX - box.left, event.clientY - box.top, Math.exp(-event.deltaY * 0.01)))
      else setView((now) => ({ ...now, x: now.x - event.deltaX, y: now.y - event.deltaY }))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [drawing])

  useEffect(() => {
    if (!chosen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !(event.target as Element).closest('input, textarea, [role="dialog"]')) setChosen(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setChosen only wraps the router's setter
  }, [chosen])

  // Dragging what is between the resources moves the drawing; a click there lets go of what is chosen.
  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest('.lineage-node, .lineage-card, .lineage-tools')) return
    const from = { x: event.clientX, y: event.clientY, view }
    let moved = false
    const move = (now: PointerEvent) => {
      const dx = now.clientX - from.x
      const dy = now.clientY - from.y
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return
      moved = true
      setDragging(true)
      setView({ ...from.view, x: from.view.x + dx, y: from.view.y + dy })
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      setDragging(false)
      if (!moved) setChosen(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }
  const zoomBy = (factor: number) => {
    const el = frame.current
    if (el) glide(zoomed(view, el.clientWidth / 2, el.clientHeight / 2, factor))
  }

  /** A few words under the name: what the resource is, or how much it is used. */
  const noteOf = (node: LineageNode): { text: string; warning?: boolean } => {
    if (node.kind === 'dashboard') return { text: t('lineage.charts', { count: facts.sources.get(node.id) ?? 0 }) }
    if (facts.unread.has(node.id)) return { text: t('lineage.unread'), warning: true }
    const readers = t('lineage.readers', { count: facts.readers.get(node.id) ?? 0 })
    if (node.kind === 'datasource') return { text: node.sourceType ? `${node.sourceType} · ${readers}` : readers }
    return { text: readers }
  }
  const pathOf = (node: LineageNode) => {
    const section = opened[node.kind]
    return section ? `/workbench/${section}/${node.id}` : null
  }
  const fold = (id: string) => {
    const next = new Set(folded)
    if (!next.delete(id)) next.add(id)
    setFolded(next)
  }
  /** Chooses from a list: what was folded away is brought back so that it can be shown. */
  const pick = (id: string) => {
    if (!at.has(id)) setFolded(new Set())
    setChosen(id)
  }
  const chosenPath = chosenNode ? pathOf(chosenNode) : null

  const listed = (title: string, ids: Set<string>, none: string) => (
    <section className="lineage-card-part">
      <h4>
        {title} · {ids.size}
      </h4>
      {ids.size === 0 && <p className="note small">{none}</p>}
      {lineageKinds.map((kind) => {
        const members = asked.nodes.filter((node) => node.kind === kind && ids.has(node.id))
        return (
          members.length > 0 && (
            <ul key={kind} data-kind={kind}>
              {members.map((node) => (
                <li key={node.id}>
                  <button type="button" title={node.name} onClick={() => pick(node.id)}>
                    <span className="lineage-mark small">
                      <Icon name={kindIcons[node.kind]} size={12} />
                    </span>
                    <span>{node.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )
        )
      })}
    </section>
  )

  return (
    <>
      <SidePanel>
        <div className="wb-side-header">
          <span className="wb-side-title">{t('workbench.sections.lineage')}</span>
          <Tooltip title={t('lineage.reload')}>
            <button type="button" className="wb-icon-button" aria-label={t('lineage.reload')} onClick={reload}>
              <Icon name="refresh" />
            </button>
          </Tooltip>
        </div>
        <div className="wb-side-filter">
          <Input size="sm" aria-label={t('lineage.search')} placeholder={t('lineage.search')} value={search} onChange={setSearch} />
        </div>
        <div className="wb-tree lineage-options">
          <div className="wb-row-group">{t('lineage.kindsTitle')}</div>
          {lineageKinds.map((kind) => (
            <label key={kind} className="lineage-option" data-kind={kind}>
              <Checkbox checked={!left.includes(kind)} onChange={(on) => setLeft(on ? left.filter((other) => other !== kind) : [...left, kind])}>
                <span className="lineage-option-name">
                  <span className="lineage-mark small">
                    <Icon name={kindIcons[kind]} size={12} />
                  </span>
                  {t(`lineage.kinds.${kind}`)}
                </span>
              </Checkbox>
              <span className="wb-row-detail">{graph.nodes.filter((node) => node.kind === kind).length}</span>
            </label>
          ))}
          <div className="wb-row-group">{t('lineage.showTitle')}</div>
          <label className="lineage-option">
            <Checkbox checked={unreadOnly} onChange={setUnreadOnly}>
              {t('lineage.unreadOnly')}
            </Checkbox>
            <span className="wb-row-detail">{facts.unread.size}</span>
          </label>
          <label className="lineage-option">
            <Checkbox checked={focused} onChange={setFocused}>
              {t('lineage.focused')}
            </Checkbox>
          </label>
          <div className="lineage-actions">
            <Button size="sm" disabled={columns.length === 0} onClick={() => setFolded(new Set((columns[0]?.nodes ?? []).filter((node) => foldable.has(node.id)).map((node) => node.id)))}>
              {t('lineage.foldAll')}
            </Button>
            <Button size="sm" disabled={folded.size === 0} onClick={() => setFolded(new Set())}>
              {t('lineage.unfoldAll')}
            </Button>
          </div>
        </div>
      </SidePanel>
      <StatusItem>{t('lineage.shown', { shown: shown.nodes.length, total: graph.nodes.length })}</StatusItem>

      {graph.nodes.length === 0 ? (
        <div className="wb-landing">
          <Icon name="lineage" size={40} />
          <p>{t('lineage.none')}</p>
        </div>
      ) : shown.nodes.length === 0 ? (
        <div className="wb-landing">
          <Icon name="search" size={40} />
          <p>{t('lineage.empty')}</p>
        </div>
      ) : (
        <div
          ref={frame}
          className={dragging ? 'lineage dragging' : 'lineage'}
          style={{ backgroundPosition: `${view.x}px ${view.y}px`, backgroundSize: `${24 * view.k}px ${24 * view.k}px` }}
          onPointerDown={startDrag}
        >
          <div className={['lineage-canvas', lit && 'picked', gliding && 'gliding'].filter(Boolean).join(' ')} style={{ width, height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
            <svg className="lineage-lines" width={width} height={height} aria-hidden>
              {shown.edges.map((edge) => {
                const from = at.get(edge.from)
                const to = at.get(edge.to)
                if (!from || !to) return null
                const x1 = from.x + boxWidth
                const y1 = from.y + boxHeight / 2
                const y2 = to.y + boxHeight / 2
                const bend = (to.x - x1) / 2
                const on = lit && ((lit.up.has(edge.from) && lit.up.has(edge.to)) || (lit.down.has(edge.from) && lit.down.has(edge.to)))
                return <path key={`${edge.from}>${edge.to}`} className={on ? 'on' : undefined} d={`M${x1} ${y1}C${x1 + bend} ${y1} ${to.x - bend} ${y2} ${to.x} ${y2}`} />
              })}
            </svg>
            {shown.nodes.map((node) => {
              const place = at.get(node.id)!
              const path = pathOf(node)
              const note = noteOf(node)
              const isFolded = folded.has(node.id)
              const isLit = !lit || lit.up.has(node.id) || lit.down.has(node.id)
              const classes = ['lineage-node', node.id === chosen && 'chosen', isLit && 'related', isFolded && 'folded'].filter(Boolean).join(' ')
              return (
                <div
                  key={node.id}
                  className={classes}
                  data-kind={node.kind}
                  style={{ left: place.x, top: place.y, width: boxWidth, height: boxHeight }}
                  onMouseEnter={() => setPointed(node.id)}
                  onMouseLeave={() => setPointed((now) => (now === node.id ? null : now))}
                >
                  <button
                    type="button"
                    className="lineage-node-name"
                    aria-pressed={node.id === chosen}
                    title={node.name}
                    onClick={() => setChosen(node.id === chosen ? null : node.id)}
                  >
                    <span className="lineage-mark">
                      <Icon name={kindIcons[node.kind]} />
                    </span>
                    <span className="lineage-node-text">
                      <span className="lineage-node-title">{node.name}</span>
                      <span className={note.warning ? 'lineage-node-note warning' : 'lineage-node-note'}>{note.text}</span>
                    </span>
                  </button>
                  {path && (
                    <Link target="_blank" rel="noopener noreferrer" to={path} className="wb-icon-button lineage-node-open" aria-label={`${t('lineage.open')} ${node.name}`} title={t('lineage.open')}>
                      <Icon name="external" size={14} />
                    </Link>
                  )}
                  {foldable.has(node.id) && (
                    <button type="button" className="lineage-node-fold" aria-expanded={!isFolded} aria-label={`${t(isFolded ? 'lineage.unfold' : 'lineage.fold')} ${node.name}`} title={t(isFolded ? 'lineage.unfold' : 'lineage.fold')} onClick={() => fold(node.id)}>
                      {isFolded ? `+${counts.get(node.id) ?? 0}` : <Icon name="minus" size={10} />}
                    </button>
                  )}
                </div>
              )
            })}
          </div>

          {/* The kinds, over their columns wherever the drawing has been moved to. */}
          <div className="lineage-strip">
            {columns.map((column, across) => (
              <div key={column.kind} className={gliding ? 'lineage-head gliding' : 'lineage-head'} data-kind={column.kind} style={{ transform: `translateX(${view.x + across * (boxWidth + columnGap) * view.k}px)`, width: boxWidth * view.k }}>
                <span className="lineage-dot" />
                <span>{t(`lineage.kinds.${column.kind}`)}</span>
                <span className="lineage-head-count">{column.nodes.length}</span>
              </div>
            ))}
          </div>

          <div className="lineage-tools" role="toolbar" aria-label={t('lineage.view')}>
            <Tooltip title={t('lineage.zoomOut')}>
              <button type="button" className="wb-icon-button" aria-label={t('lineage.zoomOut')} disabled={view.k <= leastZoom} onClick={() => zoomBy(1 / 1.25)}>
                <Icon name="minus" />
              </button>
            </Tooltip>
            <Tooltip title={t('lineage.actualSize')}>
              <button type="button" className="lineage-zoom" aria-label={t('lineage.actualSize')} onClick={() => zoomBy(1 / view.k)}>
                {Math.round(view.k * 100)}%
              </button>
            </Tooltip>
            <Tooltip title={t('lineage.zoomIn')}>
              <button type="button" className="wb-icon-button" aria-label={t('lineage.zoomIn')} disabled={view.k >= mostZoom} onClick={() => zoomBy(1.25)}>
                <Icon name="plus" />
              </button>
            </Tooltip>
            <span className="lineage-tools-rule" />
            <Tooltip title={t('lineage.fit')}>
              <button
                type="button"
                className="wb-icon-button"
                aria-label={t('lineage.fit')}
                onClick={() => {
                  const next = fitted()
                  if (next) glide(next)
                }}
              >
                <Icon name="fit" />
              </button>
            </Tooltip>
          </div>
          <p className="lineage-hint">{t('lineage.hint')}</p>

          {chosenNode && chosenLineage && (
            <aside className="lineage-card" data-kind={chosenNode.kind} aria-label={chosenNode.name}>
              <header>
                <span className="lineage-mark">
                  <Icon name={kindIcons[chosenNode.kind]} />
                </span>
                <div className="lineage-card-title">
                  <strong title={chosenNode.name}>{chosenNode.name}</strong>
                  <span className="note small">
                    {t(`lineage.kind.${chosenNode.kind}`)}
                    {` · ${noteOf(chosenNode).text}`}
                  </span>
                </div>
                <button type="button" className="wb-icon-button" aria-label={t('common.close')} onClick={() => setChosen(null)}>
                  <Icon name="close" />
                </button>
              </header>
              <div className="lineage-card-actions">
                {chosenPath && (
                  <Link target="_blank" rel="noopener noreferrer" to={chosenPath}>
                    <Button size="sm" variant="primary">
                      {t('lineage.open')}
                    </Button>
                  </Link>
                )}
                <Button size="sm" onClick={() => setFocused(!focused)}>
                  {t(focused ? 'lineage.showAll' : 'lineage.focus')}
                </Button>
              </div>
              {listed(t('lineage.upstreamTitle'), chosenLineage.upstream, t('lineage.noUpstream'))}
              {listed(t('lineage.downstreamTitle'), chosenLineage.downstream, t('lineage.noDownstream'))}
            </aside>
          )}
        </div>
      )}
    </>
  )
}
