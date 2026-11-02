import { Visualization, type QueryResult as ChartResult, type Viz, type Cell, type ClickPoint, type HeaderEditing } from '@supabi/charts'
import { Alert, type ColorScheme, type MenuItem } from '@supabi/ui'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { QueryResult } from '../api/client'
import i18n from 'i18next'
import { useFirstWeekDays } from '../auth/session'
import { comparisonName } from '../lib/computes'
import { aggLabel } from '../lib/aggregations'
import { PointMenu } from './PointMenu'

/**
 * What can be done with a value clicked in a chart: drilling down, linking
 * other charts. Clicking opens a menu of it where the click was; a column
 * with nothing to do cannot be clicked.
 */
export interface ClickActions {
  /** The columns whose values can be clicked: a table's, or the category axis of a chart. */
  columns: string[]
  items: (column: string, value: Cell) => MenuItem[]
}

/**
 * Names the columns of a result for people. A column aggregated from a
 * measure carries its field's name, which alone would not say how it was
 * aggregated, nor tell it from the same field aggregated another way.
 */
export function namedColumns(result: QueryResult, language = i18n.language): QueryResult {
  return { ...result, columns: result.columns.map((column) => {
    const name = column.agg ? aggLabel(column.agg, column.label ?? column.name) : column.label ?? column.name
    return column.agg || column.compute ? { ...column, label: column.compute === 'compare' && column.comparison ? comparisonName(name, column.comparison, i18n.getFixedT(language)) : column.compute === 'cumulative' ? i18n.t('compute.cumulativeLabel', { name, lng: language }) : column.compute ? i18n.t('compute.label', { name, lng: language }) : name } : column
  }) }
}

/** Draws a result as a viz describes, with the app's language and wording. */
export function ChartView({
  viz,
  result,
  colorScheme,
  surface,
  height,
  label,
  onColumnResize, clickActions, selection, cellSelections, headerEditing, pageKey,
}: {
  viz: Viz
  result: QueryResult
  colorScheme: ColorScheme
  /** The colour it is drawn on, as #rrggbb, when not the scheme's own surface; colorScheme is then the one whose text reads on it. */
  surface?: string
  height?: number
  label: string
  /** Called when a table column's edge is dragged to a new width; tables cannot be resized without it. */
  onColumnResize?: (column: string, width: number) => void
  clickActions?: ClickActions
  /** The category chosen, drawn emphasised. */
  selection?: { value: Cell }
  /** A table's values chosen, by column, drawn bold. */
  cellSelections?: Record<string, Cell>
  /** Lets a table's headers be picked to group and its groups be named; without it, they are only read. */
  headerEditing?: HeaderEditing
  /** What the rows answer: when it changes a paged table goes back to its first page. */
  pageKey?: string
}) {
  const { t, i18n } = useTranslation()
  const firstWeekDays = useFirstWeekDays()
  // A chart is drawn again whenever it is handed a new viz or result, and it
  // shows: so both stay the same objects until what they say changes, however
  // often whatever is around the chart is drawn again.
  const drawn = useMemo(() => namedColumns(result, i18n.language) as ChartResult, [result, i18n.language])
  const vizKey = JSON.stringify(viz)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- a viz that says the same is the same viz
  const steady = useMemo(() => viz, [vizKey])
  const texts = useMemo(() => ({
    other: t('charts.other'),
    rightAxis: (name: string) => t('charts.rightAxis', { name }),
    target: (target: string, share: string) => t('charts.target', { target, share }),
    total: t('charts.total'),
    totalOfAll: t('charts.totalOfAll'),
    subtotal: (value: string) => t('charts.subtotal', { value }),
    totalsOmitted: t('charts.totalsOmitted'),
    compareWith: (name: string, direction: 'up' | 'down' | 'flat') => t(`charts.compareWith.${direction}`, { name }),
    pages: t('charts.pages'),
    previousPage: t('charts.previousPage'),
    nextPage: t('charts.nextPage'),
    pageOf: (page: string, pages: string) => t('charts.pageOf', { page, pages }),
    rowRange: (from: string, to: string, total: string, truncated: boolean) => t(truncated ? 'charts.rowRangeTruncated' : 'charts.rowRange', { from, to, total }),
    noRows: t('charts.noRows'),
  }), [t])
  const [menu, setMenu] = useState<{ at: ClickPoint; items: MenuItem[] }>()
  const open = (column: string, value: Cell, at: ClickPoint) => {
    const items = clickActions?.items(column, value) ?? []
    if (items.length) setMenu({ at, items })
  }
  const table = viz.type === 'table'
  const category = !table && viz.x !== undefined && clickActions?.columns.includes(viz.x) ? viz.x : undefined
  return (
    <>
    <Visualization
      viz={steady}
      result={drawn}
      colorScheme={colorScheme}
      surface={surface}
      locale={i18n.language}
      firstWeekDays={firstWeekDays}
      height={height}
      aria-label={label}
      texts={texts}
      onColumnResize={onColumnResize}
      headerEditing={headerEditing}
      pageKey={pageKey}
      onSelect={category === undefined ? undefined : (value, at) => open(category, value, at)} selection={selection}
      onCellSelect={table && clickActions?.columns.length ? open : undefined} selectableColumns={table ? clickActions?.columns : undefined} cellSelections={cellSelections}
      renderError={(error) => <Alert tone="error" title={t(`chart.error.${error.code}`, { column: error.column })} />}
    />
    {menu && <PointMenu at={menu.at} items={menu.items} onClose={() => setMenu(undefined)} />}
    </>
  )
}
