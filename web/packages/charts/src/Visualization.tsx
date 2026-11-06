import { BarChart, FunnelChart, GaugeChart, HeatmapChart, LineChart, PieChart, SankeyChart, ScatterChart, TreemapChart } from 'echarts/charts'
import { GridComponent, LegendComponent, MarkLineComponent, TooltipComponent, VisualMapContinuousComponent } from 'echarts/components'
import * as echarts from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { cartesianOption, funnelOption, gaugeOption, heatmapOption, pieOption, sankeyOption, scatterOption, treemapOption, type ChartTexts } from './echartsAdapter'
import { applyFormats, formatAxis, formatCategory, formatNumber } from './format'
import type { ChartColorScheme } from './palette'
import type { Cell, ClickPoint, QueryResult, ResultColumn } from './result'
import { ChartSpecError, type Viz } from './spec'
import { Pivot, Table, Tiles, type HeaderEditing } from './Tables'
import { toCartesian, toGauge, toHeatmap, toPivot, toSankey, toScatter, toSlices, toStages, toTiles, toTreemap, type Labeler } from './transform'

echarts.use([BarChart, LineChart, PieChart, ScatterChart, SankeyChart, FunnelChart, TreemapChart, HeatmapChart, GaugeChart, GridComponent, LegendComponent, MarkLineComponent, TooltipComponent, VisualMapContinuousComponent, CanvasRenderer])

const defaultTexts: ChartTexts = {
  other: 'Other',
  rightAxis: (name) => `${name} (right axis)`,
  target: (target, share) => `Target ${target} · ${share}`,
  total: 'Total',
  totalOfAll: 'Total (all data)',
  subtotal: (value) => `${value} subtotal`,
  totalsOmitted: 'No totals: the chart filters on aggregated results.',
  compareWith: (name, direction) => `${direction === 'up' ? 'above' : direction === 'down' ? 'below' : 'level with'} ${name}`,
  pages: 'Pages',
  previousPage: 'Previous page',
  nextPage: 'Next page',
  pageOf: (page, pages) => `${page} / ${pages}`,
  rowRange: (from, to, total, truncated) => (truncated ? `Rows ${from}–${to}; more rows matched than the limit, only the first ${total} are shown` : `Rows ${from}–${to} of ${total}`),
  noRows: 'No rows',
}

export interface VisualizationProps {
  viz: Viz
  result: QueryResult
  colorScheme?: ChartColorScheme
  /** The colour the chart is drawn on, as #rrggbb, when not the scheme's own surface; colorScheme is then the one whose text reads on it. */
  surface?: string
  /** BCP 47 tag used to format numbers, e.g. zh-CN. */
  locale?: string
  /** How many days of a year's first week are in that year, which numbers weeks written by number; 4 when left out. */
  firstWeekDays?: number
  /**
   * How tall it is drawn, in pixels; 320 when left out. A KPI left without
   * one fills the box it is in instead, and in a box that grows with what it
   * holds it asks for room enough for its figures.
   */
  height?: number
  /** Accessible name; a chart is an image to assistive technology. */
  'aria-label': string
  /** Words the chart writes itself, in the reader's language. */
  texts?: Partial<ChartTexts>
  /** Rendered instead of the chart when the spec does not fit the result. */
  renderError?: (error: ChartSpecError) => ReactNode
  /** Called with the category value when a bar, point or slice is clicked, and where on the screen that was. */
  onSelect?: (value: Cell, at: ClickPoint) => void
  /** Tables expose only explicitly mapped columns; totals are never clickable. */
  onCellSelect?: (column: string, value: Cell, at: ClickPoint) => void
  selectableColumns?: string[]
  cellSelections?: Record<string, Cell>
  /** The currently selected category, drawn emphasised. */
  selection?: { value: Cell }
  /** Called when a table column's edge is dragged to a new width; without it, a table's widths are fixed. */
  onColumnResize?: (column: string, width: number) => void
  /** Lets a table's headers be picked to group, and its groups be named; without it, they are only read. */
  headerEditing?: HeaderEditing
  /** What the rows answer: when it changes a paged table goes back to its first page. */
  pageKey?: string
}

/**
 * A chart drawn by ECharts. A click on a mark says which of the data it is,
 * and where the pointer was. byAxis takes a click anywhere over a category,
 * as on lines and areas, whose points are not drawn unless asked for.
 */
function Canvas({ option, height, label, onClick, byAxis = false }: { option: echarts.EChartsCoreOption; height: number; label: string; onClick?: (index: number, at: ClickPoint) => void; byAxis?: boolean }) {
  const container = useRef<HTMLDivElement>(null)
  // Kept in a ref so a new callback does not rebuild the chart.
  const click = useRef(onClick)
  click.current = onClick
  useEffect(() => {
    const element = container.current
    if (!element) return
    const instance = echarts.init(element)
    instance.setOption(option)
    instance.on('click', (params) => {
      if (byAxis) return
      // Where the pointer was; a click without one is placed at the chart's corner.
      const pointer = (params.event as { event?: MouseEvent } | undefined)?.event
      const box = element.getBoundingClientRect()
      click.current?.(params.dataIndex, pointer ? { x: pointer.clientX, y: pointer.clientY } : { x: box.left, y: box.top })
    })
    if (byAxis) {
      const zr = instance.getZr()
      // The category under the pointer, within the plot.
      const categoryAt = (event: { offsetX: number; offsetY: number }) => {
        const point = [event.offsetX, event.offsetY]
        if (!instance.containPixel('grid', point)) return undefined
        const [index] = instance.convertFromPixel({ gridIndex: 0 }, point) as number[]
        return typeof index === 'number' && Number.isFinite(index) ? Math.round(index) : undefined
      }
      zr.on('click', (event) => {
        const index = categoryAt(event)
        const pointer = event.event as unknown as MouseEvent | undefined
        if (index !== undefined && pointer) click.current?.(index, { x: pointer.clientX, y: pointer.clientY })
      })
      // Over the plot the pointer says it can be clicked; elsewhere ECharts says what it would.
      zr.on('mousemove', (event) => {
        if (click.current && categoryAt(event) !== undefined) zr.setCursorStyle('pointer')
      })
    }
    const observer = new ResizeObserver(() => instance.resize())
    observer.observe(element)
    return () => {
      observer.disconnect()
      instance.dispose()
    }
  }, [option, byAxis])
  return <div ref={container} role="img" aria-label={label} style={{ width: '100%', height }} />
}

/** Draws a query result the way a viz describes. */
export function Visualization({ viz, result: received, colorScheme = 'light', surface, locale, firstWeekDays, height: given, 'aria-label': ariaLabel, texts: givenTexts, renderError, onSelect, selection, onColumnResize, onCellSelect, selectableColumns, cellSelections, headerEditing, pageKey }: VisualizationProps) {
  const height = given ?? 320
  const selectable = Boolean(onSelect)
  const selected = selection ? { value: selection.value } : undefined
  const selectedKey = selected ? JSON.stringify(selected.value) : undefined
  const result = useMemo(() => applyFormats(received, viz.formats), [received, viz.formats])
  const built = useMemo(() => {
    const indexOf = (values: (Cell | undefined)[]) => {
      if (selectedKey === undefined) return undefined
      const index = values.findIndex((value) => value !== undefined && JSON.stringify(value) === selectedKey)
      return index < 0 ? undefined : index
    }
    // An axis is written the way the first measure it reads is.
    const first = result.columns.find((column) => column.name === viz.y?.[0])
    const texts = { ...defaultTexts, ...givenTexts }
    const label: Labeler = (cell, column) => formatCategory(cell, column, firstWeekDays)
    const options = {
      scheme: colorScheme,
      surface,
      style: viz.style,
      texts,
      selectable,
      formatValue: (value: number, column: ResultColumn | undefined) => formatNumber(value, column?.format, locale),
      formatAxis: (value: number, column: ResultColumn | undefined) => formatAxis(value, column?.format, locale),
    }
    try {
      switch (viz.type) {
        case 'table':
          if (result.columns.length && result.columns.every((column) => viz.hiddenColumns?.includes(column.name))) throw new ChartSpecError('no_visible_columns')
          return {}
        case 'bar':
        case 'hbar':
        case 'line':
        case 'area':
        case 'combo': {
          const data = toCartesian(viz, result, texts.other, label)
          const option = cartesianOption(viz.type, Boolean(viz.stacked), data, { ...options, selected: indexOf(data.raw) }, { lines: viz.lines, rightAxis: viz.rightAxis })
          return { option, raw: data.raw as (Cell | undefined)[] }
        }
        case 'scatter':
          return { option: scatterOption(toScatter(viz, result, texts.other, label), options) }
        case 'pie': {
          const slices = toSlices(viz, result, texts.other, label)
          const raw = slices.map((slice) => slice.raw)
          return { option: pieOption(ariaLabel, slices, first, { ...options, selected: indexOf(raw) }), raw }
        }
        case 'funnel':
          return { option: funnelOption(ariaLabel, toStages(viz, result, label), first, options) }
        case 'treemap':
          return { option: treemapOption(ariaLabel, toTreemap(viz, result, texts.other, label), first, options) }
        case 'heatmap':
          return { option: heatmapOption(toHeatmap(viz, result, label), options) }
        case 'gauge':
          return { option: gaugeOption(toGauge(viz, result), options) }
        case 'sankey':
          return { option: sankeyOption(toSankey(viz, result, texts.other, label), options) }
        case 'kpi':
          toTiles(viz, result) // surfaces spec errors here rather than while rendering
          return {}
        case 'pivot':
          toPivot(viz, result)
          return {}
        default:
          return {}
      }
    } catch (error) {
      if (error instanceof ChartSpecError) return { error }
      throw error
    }
  }, [viz, result, colorScheme, surface, locale, firstWeekDays, givenTexts, ariaLabel, selectable, selectedKey])

  if (built.error) return <>{renderError?.(built.error) ?? null}</>
  if (built.option) {
    const raw = built.raw
    const click = onSelect
      ? (index: number, at: ClickPoint) => {
          const value = raw?.[index]
          if (value !== undefined) onSelect(value, at)
        }
      : undefined
    // Lines and areas are clicked anywhere over a category: their points are not drawn unless asked for.
    const byAxis = viz.type === 'line' || viz.type === 'area' || viz.type === 'combo'
    return <Canvas option={built.option} height={height} label={ariaLabel} onClick={click} byAxis={byAxis} />
  }
  const texts = { ...defaultTexts, ...givenTexts }
  if (viz.type === 'kpi') {
    return (
      <div role="group" aria-label={ariaLabel} style={{ height: given ?? '100%' }}>
        <Tiles viz={viz} result={result} scheme={colorScheme} surface={surface} locale={locale} firstWeekDays={firstWeekDays} texts={texts} />
      </div>
    )
  }
  const table = { viz, result, scheme: colorScheme, surface, locale, firstWeekDays, height, label: ariaLabel, texts, onColumnResize, onCellSelect, selectableColumns, cellSelections }
  return viz.type === 'pivot' ? <Pivot {...table} /> : <Table {...table} headerEditing={headerEditing} pageKey={pageKey} />
}
