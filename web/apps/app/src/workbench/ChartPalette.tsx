import { Input, Tooltip } from '@supabi/ui'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import type { ChartSummary } from '../api/client'
import { Icon } from '../components/Icon'
import { chartDragType, emptyChartDragType, emptyChartDrop } from '../lib/layout'
import { ResourceTree } from './ResourceTree'

/**
 * Chart library for the dashboard inspector. Drag a chart onto the canvas or
 * use its button to add it to the first free position; an empty box for a
 * chart, to lay the page out before its charts are chosen, comes first.
 * While an empty box is selected, a chart picked here goes into it.
 */
export function ChartPalette({ charts, used, onAdd, onAddEmpty, filling }: {
  charts: ChartSummary[]
  used: Set<string>
  onAdd: (chartId: string) => void
  onAddEmpty: () => void
  /** The name of the empty box a picked chart goes into, if one is selected. */
  filling?: string
}) {
  const { t } = useTranslation()
  const [filter, setFilter] = useState('')
  const empty = t('dashboard.container.empty')

  return (
    <section className="dashboard-chart-library" aria-label={t('dashboard.palette')}>
      <div className="wb-side-filter">
        <Input size="sm" aria-label={t('dashboard.searchCharts')} placeholder={t('dashboard.searchCharts')} value={filter} onChange={setFilter} />
      </div>
      {filling
        ? <p className="dashboard-palette-filling note small" role="status">{t('dashboard.container.filling', { name: filling })}</p>
        : <div className="wb-row chart-source dashboard-palette-empty" title={t('dashboard.container.emptyHint')} draggable
          onDragStart={(event) => {
            event.dataTransfer.setData(chartDragType, emptyChartDrop)
            event.dataTransfer.setData(emptyChartDragType, '')
            event.dataTransfer.setData('text/plain', empty)
            event.dataTransfer.effectAllowed = 'copy'
          }}>
          <Icon name="frame" />
          <span className="wb-row-name">{empty}</span>
          <Tooltip title={t('dashboard.container.addEmpty')}>
            <button type="button" className="wb-icon-button wb-row-more" aria-label={t('dashboard.container.addEmpty')} onClick={onAddEmpty}><Icon name="plus" /></button>
          </Tooltip>
        </div>}
      <ResourceTree kind="chart" filter={filter} addition={{ items: charts, added: used, onAdd, label: t(filling ? 'dashboard.container.putIn' : 'dashboard.addChart'), addedLabel: t('dashboard.onBoard'), dragType: chartDragType }} />
      {charts.length === 0 && !filter.trim() && <p className="wb-side-empty"><Link target="_blank" rel="noopener noreferrer" to="/workbench/charts/new">{t('workbench.new.chart')}</Link></p>}
    </section>
  )
}
