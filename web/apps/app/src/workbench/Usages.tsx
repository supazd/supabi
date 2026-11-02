import { Button } from '@supabi/ui'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { api, unwrap } from '../api/client'
import { useAsync } from '../api/useAsync'
import { Async } from '../components/Async'
import { Icon } from '../components/Icon'
import { columnsOf, lineageOf, only, type LineageGraph, type LineageNode } from '../lib/lineage'
import { boxHeight, boxWidth, columnGap, kindIcons, opened, rowGap } from './Lineage'

const headHeight = 28

/**
 * What reads a resource, and so what changing or deleting it would affect:
 * the resource and everything that leads from it, drawn as on the map of the
 * workspace's lineage and cut out of it. `stamp` changes when the answer may
 * have: after a save.
 */
export function Usages({ id, stamp }: { kind: 'datasource' | 'dataset' | 'chart'; id: string; stamp?: unknown }) {
  const lineage = useAsync(() => unwrap(api.GET('/lineage')), [stamp])
  return (
    <div className="wb-usages">
      <Async state={lineage} reload={lineage.reload}>
        {(graph) => <Readers graph={graph} id={id} />}
      </Async>
    </div>
  )
}

function Readers({ graph, id }: { graph: LineageGraph; id: string }) {
  const { t } = useTranslation()
  const [pointed, setPointed] = useState<string | null>(null)
  const map = `/workbench/lineage?focus=${encodeURIComponent(id)}`

  const drawn = useMemo(() => {
    const shown = only(graph, new Set([id, ...lineageOf(graph, id).downstream]))
    const columns = columnsOf(shown)
    const tallest = Math.max(0, ...columns.map((column) => column.nodes.length))
    const step = boxHeight + rowGap
    const at = new Map<string, { x: number; y: number }>()
    columns.forEach((column, across) =>
      column.nodes.forEach((node, down) => at.set(node.id, { x: across * (boxWidth + columnGap), y: headHeight + ((tallest - column.nodes.length) * step) / 2 + down * step })),
    )
    return { shown, columns, at, width: columns.length * boxWidth + Math.max(0, columns.length - 1) * columnGap, height: headHeight + Math.max(0, tallest * step - rowGap) }
  }, [graph, id])
  const { shown, columns, at } = drawn

  // Pointing at a reader marks how it comes to read the resource, and what reads it in turn.
  const lit = useMemo(() => {
    if (!pointed || !at.has(pointed)) return null
    const { upstream, downstream } = lineageOf(shown, pointed)
    return { up: new Set([...upstream, pointed]), down: new Set([...downstream, pointed]) }
  }, [shown, at, pointed])

  const pathOf = (node: LineageNode) => {
    if (node.id === id) return null
    const section = opened[node.kind]
    return section ? `/workbench/${section}/${node.id}` : null
  }

  if (shown.nodes.length <= 1) {
    return (
      <div className="wb-usage-none">
        <Icon name="lineage" size={28} />
        <div>
          <strong>{t('workbench.noUsages')}</strong>
          <p className="note small">{t('workbench.noUsagesHint')}</p>
        </div>
        <Link target="_blank" rel="noopener noreferrer" to={map}>
          <Button size="sm">{t('lineage.view')}</Button>
        </Link>
      </div>
    )
  }

  return (
    <>
      <div className="wb-usage-head">
        <Link target="_blank" rel="noopener noreferrer" to={map}>
          <Button size="sm">
            <Icon name="lineage" size={14} />
            {t('lineage.view')}
          </Button>
        </Link>
      </div>
      <div className="wb-usage-graph">
        <div className={lit ? 'lineage-canvas picked' : 'lineage-canvas'} style={{ width: drawn.width, height: drawn.height }}>
          <svg className="lineage-lines" width={drawn.width} height={drawn.height} aria-hidden>
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
          {columns.map((column, across) => (
            <div key={column.kind} className="lineage-head" data-kind={column.kind} style={{ left: across * (boxWidth + columnGap), width: boxWidth, height: headHeight }}>
              <span className="lineage-dot" />
              <span>{t(`lineage.kinds.${column.kind}`)}</span>
              {column.nodes.some((node) => node.id !== id) && <span className="lineage-head-count">{column.nodes.filter((node) => node.id !== id).length}</span>}
            </div>
          ))}
          {shown.nodes.map((node) => {
            const place = at.get(node.id)!
            const path = pathOf(node)
            const isLit = !lit || lit.up.has(node.id) || lit.down.has(node.id)
            const classes = ['lineage-node', node.id === id && 'chosen', isLit && 'related', path && 'linked'].filter(Boolean).join(' ')
            const inside = (
              <span className="lineage-node-name">
                <span className="lineage-mark">
                  <Icon name={kindIcons[node.kind]} />
                </span>
                <span className="lineage-node-text">
                  <span className="lineage-node-title">{node.name}</span>
                  <span className="lineage-node-note">{node.id === id ? t('workbench.thisOne') : t(`lineage.kind.${node.kind}`)}</span>
                </span>
                {path && <Icon name="external" size={14} />}
              </span>
            )
            const common = {
              className: classes,
              'data-kind': node.kind,
              title: node.name,
              style: { left: place.x, top: place.y, width: boxWidth, height: boxHeight },
              onMouseEnter: () => setPointed(node.id),
              onMouseLeave: () => setPointed((now) => (now === node.id ? null : now)),
            }
            return path ? (
              <Link key={node.id} target="_blank" rel="noopener noreferrer" to={path} {...common}>
                {inside}
              </Link>
            ) : (
              <div key={node.id} {...common}>
                {inside}
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}
