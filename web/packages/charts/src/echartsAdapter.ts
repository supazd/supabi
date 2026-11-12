// The only file that knows the shape of an ECharts option.
import type { EChartsCoreOption } from 'echarts/core'
import { hueColor, inkFor, magnitude, ordinal, paletteColors, type ChartColorScheme, type Ink } from './palette'
import type { ResultColumn } from './result'
import type { Axis, LegendPosition, Style } from './spec'
import type { CartesianData, GaugeData, HeatmapData, SankeyData, SankeyNode, ScatterData, Slice, Stage, TreemapNode } from './transform'

/** Words a chart writes itself, in the reader's language. */
export interface ChartTexts {
  /** The series that gathers what does not fit the palette. */
  other: string
  /** A combo chart's measure read against the right axis, in the legend. */
  rightAxis: (name: string) => string
  /** A gauge's target, and how far the value has come towards it. */
  target: (target: string, share: string) => string
  /** A table's totals. */
  total: string
  /** A table's totals under fewer rows than there are: they are of all the data, not of the rows shown. */
  totalOfAll: string
  /** A pivot table's subtotal of the group with the given value. */
  subtotal: (value: string) => string
  /** Said in place of totals that could not be computed. */
  totalsOmitted: string
  /** What a KPI tile is compared with, and which way it went. */
  compareWith: (name: string, direction: 'up' | 'down' | 'flat') => string
  /** The bar that turns a paged table's pages, and its buttons. */
  pages: string
  previousPage: string
  nextPage: string
  /** Which page is shown, of how many; the numbers written already. */
  pageOf: (page: string, pages: string) => string
  /** Which rows a page shows, and of how many; when there were more than the query took, how many it took, there being no knowing how many more. */
  rowRange: (from: string, to: string, total: string, truncated: boolean) => string
  /** Said under a paged table with no rows. */
  noRows: string
}

interface Options {
  scheme: ChartColorScheme
  /** The colour the chart is drawn on, when not the scheme's own surface. */
  surface?: string
  style?: Style
  texts: ChartTexts
  /** Formats a value of a measure, for tooltips and labels. */
  formatValue: (value: number, column: ResultColumn | undefined) => string
  /** Formats a tick of a value axis that reads the column. */
  formatAxis: (value: number, column: ResultColumn | undefined) => string
  /** Index of the selected category or slice; the others are drawn faded. */
  selected?: number
  /** Whether a click selects, which changes the cursor. */
  selectable?: boolean
}

const faded = 0.3
const percentText = (share: number) => `${(share * 100).toFixed(share >= 0.1 || share === 0 ? 0 : 1)}%`

/**
 * Text as it may be put in a tooltip written by a formatter here. ECharts sets what such a formatter returns as HTML,
 * and the names and values come from the user's data.
 */
const escapes: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const html = (text: unknown) => String(text ?? '').replace(/[&<>"']/g, (char) => escapes[char]!)

function tooltipBox(ink: Ink) {
  return { backgroundColor: ink.surface, borderColor: ink.axis, textStyle: { color: ink.text } }
}

/** Where the legend goes and how much room it takes from the plot. */
type Room = Partial<Record<'top' | 'bottom' | 'left' | 'right', number>>

function legendOf(position: LegendPosition | undefined, shownByDefault: boolean, ink: Ink): { legend?: Record<string, unknown>; room: Room } {
  const where = position ?? (shownByDefault ? 'top' : 'none')
  if (where === 'none') return { room: {} }
  const vertical = where === 'left' || where === 'right'
  const place = { top: { top: 0, left: 0 }, bottom: { bottom: 0, left: 0 }, left: { left: 0, top: 'middle' }, right: { right: 0, top: 'middle' } }[where]
  return {
    legend: { type: 'scroll', orient: vertical ? 'vertical' : 'horizontal', ...place, icon: 'roundRect', itemWidth: 10, itemHeight: 10, textStyle: { color: ink.textSecondary }, pageTextStyle: { color: ink.textSecondary } },
    room: { [where]: vertical ? 120 : 32 },
  }
}

function base(options: Options, legendByDefault: boolean) {
  const ink = inkFor(options.scheme, options.surface)
  const { legend, room } = legendOf(options.style?.legend, legendByDefault, ink)
  return {
    ink,
    room,
    option: {
      color: paletteColors(options.style?.palette, options.scheme),
      backgroundColor: 'transparent',
      textStyle: { color: ink.textSecondary },
      // One series is named by the chart's title; a legend would only repeat it.
      legend,
    },
  }
}

/** The plot's margins: room for the legend, and for axis titles. */
function gridOf(room: Room, titled: { x?: boolean; y?: boolean; y2?: boolean } = {}) {
  return {
    left: (room.left ?? 0) + (titled.y ? 28 : 8),
    right: (room.right ?? 0) + (titled.y2 ? 28 : 16),
    top: (room.top ?? 0) + 16,
    bottom: (room.bottom ?? 0) + (titled.x ? 28 : 8),
    containLabel: true,
  }
}

function axisOf(kind: 'value' | 'category', settings: Axis | undefined, ink: Ink, where: 'x' | 'y', format?: (value: number) => string) {
  const name = settings?.title ? { name: settings.title, nameLocation: 'middle', nameGap: where === 'x' ? 28 : 44, nameTextStyle: { color: ink.textSecondary } } : {}
  const label = { color: ink.textSecondary, show: !settings?.hideLabels }
  if (kind === 'category') {
    return {
      type: 'category',
      ...name,
      axisLine: { lineStyle: { color: ink.axis } },
      axisTick: { show: false },
      axisLabel: { ...label, rotate: settings?.rotate ?? 0 },
    }
  }
  return {
    type: 'value',
    ...name,
    ...(settings?.min !== undefined ? { min: settings.min } : {}),
    ...(settings?.max !== undefined ? { max: settings.max } : {}),
    axisLabel: { ...label, ...(format ? { formatter: format } : {}) },
    splitLine: { show: !settings?.hideGrid, lineStyle: { color: ink.grid } },
  }
}

/**
 * The colour of each measure: the hue the chart gives it, or else the next
 * colour of the palette that no measure was given, so two never share one.
 */
function seriesColors(names: (string | undefined)[], options: Options): string[] {
  const given = options.style?.colors ?? {}
  const taken = new Set(Object.values(given))
  const rest = paletteColors(options.style?.palette, options.scheme).filter((color) => ![...taken].some((hue) => hueColor(hue, options.scheme) === color))
  let next = 0
  return names.map((name) => {
    const hue = name === undefined ? undefined : given[name]
    return hue ? hueColor(hue, options.scheme) : rest[next++ % rest.length]!
  })
}

export function cartesianOption(type: 'bar' | 'hbar' | 'line' | 'area' | 'combo', stacked: boolean, data: CartesianData, options: Options, combo: { lines?: string[]; rightAxis?: string[] } = {}): EChartsCoreOption {
  const style = options.style ?? {}
  const horizontal = type === 'hbar'
  const percent = stacked && Boolean(style.percent)
  const legendByDefault = data.series.length > 1
  const { ink, room, option } = base(options, legendByDefault)
  const right = new Set(combo.rightAxis ?? [])
  const lines = new Set(combo.lines ?? [])
  const colors = seriesColors(data.series.map((item) => item.column?.name), options)
  // Shares of each category's whole, for a stack drawn to 100%.
  const totals = data.categories.map((_, i) => data.series.reduce((sum, item) => sum + Math.abs(item.data[i] ?? 0), 0))
  const shareOf = (value: number | null, i: number) => (value === null || !totals[i] ? null : Math.abs(value) / totals[i]!)
  const labelPosition = (bar: boolean) => (bar && stacked ? 'inside' : horizontal ? 'right' : 'top')
  const emphasised = (values: (number | null)[]) =>
    options.selected === undefined ? values : values.map((value, index) => (index === options.selected ? value : { value, itemStyle: { opacity: faded } }))

  const series = data.series.map(({ column, ...item }, at) => {
    const onRight = type === 'combo' && column !== undefined && right.has(column.name)
    const bar = type === 'bar' || type === 'hbar' || (type === 'combo' && !(column && lines.has(column.name)))
    const values = percent ? item.data.map(shareOf) : item.data
    const write = (value: unknown, index?: number) => {
      if (typeof value !== 'number') return '—'
      if (!percent) return options.formatValue(value, column)
      // A share is written with what it is a share of.
      const raw = index === undefined ? undefined : item.data[index]
      return raw === null || raw === undefined ? percentText(value) : `${percentText(value)}（${options.formatValue(raw, column)}）`
    }
    const color = colors[at]!
    const common = {
      ...item,
      name: onRight ? options.texts.rightAxis(item.name) : item.name,
      tooltip: { valueFormatter: (value: unknown, index: number) => write(value, index) },
      cursor: options.selectable ? 'pointer' : 'default',
      label: style.labels === 'value'
        ? { show: true, position: labelPosition(bar), color: bar && stacked ? ink.surface : ink.textSecondary, formatter: (p: { value: unknown }) => (percent && typeof p.value === 'number' ? percentText(p.value) : write(p.value)) }
        : undefined,
      ...(onRight ? { yAxisIndex: 1 } : {}),
    }
    if (bar) {
      return {
        ...common,
        data: emphasised(values),
        type: 'bar' as const,
        stack: stacked ? 'total' : undefined,
        barMaxWidth: style.barWidth ?? 28,
        // A gap in the surface colour separates touching fills; the data end is rounded, away from the baseline.
        itemStyle: { color, borderRadius: stacked ? 0 : horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0], borderColor: ink.surface, borderWidth: stacked ? 1 : 0 },
      }
    }
    return {
      ...common,
      data: values,
      // A line has no separate marks to fade; the selected point is marked instead.
      markLine: options.selected === undefined ? undefined : { silent: true, symbol: 'none', label: { show: false }, lineStyle: { color: ink.axis }, data: [{ xAxis: options.selected }] },
      type: 'line' as const,
      stack: stacked && type === 'area' ? 'total' : undefined,
      itemStyle: { color },
      lineStyle: { width: 2, color },
      smooth: Boolean(style.smooth),
      symbol: 'circle',
      symbolSize: 8,
      showSymbol: Boolean(style.points) || style.labels === 'value',
      connectNulls: false,
      areaStyle: type === 'area' ? { opacity: stacked ? 0.75 : 0.18 } : undefined,
    }
  })

  // The value axis is written the way its first measure is; a stack to 100% in percentages.
  const leftColumn = data.series.find((item) => !(item.column && right.has(item.column.name)))?.column ?? data.series[0]?.column
  const rightColumn = data.series.find((item) => item.column && right.has(item.column.name))?.column
  const valueFormat = (column: ResultColumn | undefined) => (value: number) => (percent ? percentText(value) : options.formatAxis(value, column))
  const valueSettings = horizontal ? style.xAxis : style.yAxis
  const categorySettings = horizontal ? style.yAxis : style.xAxis
  const valueAxis = { ...axisOf('value', valueSettings, ink, horizontal ? 'x' : 'y', valueFormat(leftColumn)), ...(percent ? { max: 1 } : {}) }
  const categoryAxis = {
    ...axisOf('category', categorySettings, ink, horizontal ? 'y' : 'x'),
    data: data.categories,
    boundaryGap: type !== 'line' && type !== 'area',
    // The first category is read first: at the top when the categories run down the side.
    inverse: horizontal,
  }
  const yAxes = rightColumn
    ? [valueAxis, { ...axisOf('value', style.y2Axis, ink, 'y', valueFormat(rightColumn)), splitLine: { show: false } }]
    : valueAxis
  // Labels beyond the ends of the bars need room the axes do not leave.
  const labelled = style.labels === 'value' && !stacked
  const grid = gridOf(room, { x: Boolean(style.xAxis?.title), y: Boolean(style.yAxis?.title), y2: Boolean(rightColumn && style.y2Axis?.title) })
  return {
    ...option,
    grid: labelled ? (horizontal ? { ...grid, right: grid.right + 56 } : { ...grid, top: grid.top + 12 }) : grid,
    tooltip: { trigger: 'axis', axisPointer: { type: type === 'line' || type === 'area' ? 'line' : 'shadow' }, ...tooltipBox(ink) },
    xAxis: horizontal ? valueAxis : categoryAxis,
    yAxis: horizontal ? categoryAxis : yAxes,
    series,
  }
}

export function scatterOption(data: ScatterData, options: Options): EChartsCoreOption {
  const style = options.style ?? {}
  const { ink, room, option } = base(options, data.series.length > 1)
  const colors = paletteColors(style.palette, options.scheme)
  const largest = Math.max(0, ...data.series.flatMap((item) => item.points.map((point) => point.value[2] ?? 0)))
  const { x, y, size } = data.columns
  const name = (column: ResultColumn) => column.label ?? column.name
  return {
    ...option,
    grid: gridOf(room, { x: true, y: true }),
    tooltip: {
      trigger: 'item',
      ...tooltipBox(ink),
      formatter: (p: { data: { name: string; value: number[] }; marker: string }) =>
        [
          `${p.marker}${html(p.data.name)}`,
          `${html(name(x))}: ${html(options.formatValue(p.data.value[0]!, x))}`,
          `${html(name(y))}: ${html(options.formatValue(p.data.value[1]!, y))}`,
          ...(size ? [`${html(name(size))}: ${html(options.formatValue(p.data.value[2]!, size))}`] : []),
        ].join('<br/>'),
    },
    // Both axes are values, so each is named by its measure unless the chart names it.
    xAxis: { ...axisOf('value', { ...style.xAxis, title: style.xAxis?.title ?? name(x) }, ink, 'x', (value) => options.formatAxis(value, x)), scale: style.xAxis?.min === undefined },
    yAxis: { ...axisOf('value', { ...style.yAxis, title: style.yAxis?.title ?? name(y) }, ink, 'y', (value) => options.formatAxis(value, y)), scale: style.yAxis?.min === undefined },
    series: data.series.map((item, at) => ({
      type: 'scatter',
      name: item.name,
      data: item.points,
      // A bubble's area, not its width, says how much.
      symbolSize: size ? (value: number[]) => 8 + 32 * Math.sqrt(largest > 0 ? (value[2] ?? 0) / largest : 0) : 8,
      // A ring in the surface colour keeps overlapping points apart.
      itemStyle: { color: item.other ? ink.axis : colors[at], borderColor: ink.surface, borderWidth: 2, opacity: 0.9 },
      label: style.labels === 'value' ? { show: true, position: 'top', color: ink.textSecondary, formatter: (p: { data: { name: string } }) => p.data.name } : undefined,
    })),
  }
}

export function pieOption(name: string, slices: Slice[], column: ResultColumn | undefined, options: Options): EChartsCoreOption {
  const style = options.style ?? {}
  const { ink, room, option } = base(options, true)
  const labels = style.labels ?? 'percent'
  const vertical = (room.left ?? room.right) !== undefined
  return {
    ...option,
    tooltip: {
      trigger: 'item',
      ...tooltipBox(ink),
      valueFormatter: (value: unknown) => (typeof value === 'number' ? options.formatValue(value, column) : '—'),
    },
    series: [
      {
        name,
        type: 'pie',
        radius: [style.solid ? 0 : '45%', '72%'],
        center: [vertical ? (room.left ? '60%' : '40%') : '50%', room.top ? '56%' : room.bottom ? '46%' : '50%'],
        data: slices.map((slice, index) => ({
          name: slice.name,
          value: slice.value,
          itemStyle: options.selected !== undefined && index !== options.selected ? { opacity: faded } : undefined,
          cursor: options.selectable && slice.raw !== undefined ? 'pointer' : 'default',
        })),
        // Each slice states its share; names are in the legend, where they
        // are not cut off when the chart is small.
        label: labels === 'none' ? { show: false } : { color: ink.textSecondary, formatter: labels === 'value' ? (p: { value: number }) => options.formatValue(p.value, column) : '{d}%' },
        labelLine: { show: labels !== 'none', lineStyle: { color: ink.axis } },
        itemStyle: { borderColor: ink.surface, borderWidth: 2 },
      },
    ],
  }
}

export function funnelOption(name: string, stages: Stage[], column: ResultColumn | undefined, options: Options): EChartsCoreOption {
  const style = options.style ?? {}
  // The stages are named beside them, so a legend is only there when asked for.
  const { ink, room, option } = base(options, false)
  const labels = style.labels ?? 'percent'
  const colors = ordinal(stages.length, options.scheme)
  const top = (room.top ?? 0) + 8
  const bottom = (room.bottom ?? 0) + 8
  return {
    ...option,
    tooltip: {
      trigger: 'item',
      ...tooltipBox(ink),
      formatter: (p: { name: string; value: number; dataIndex: number; marker: string }) => `${p.marker}${html(p.name)}<br/>${html(options.formatValue(p.value, column))}（${percentText(stages[p.dataIndex]?.share ?? 0)}）`,
    },
    series: [
      {
        name,
        type: 'funnel',
        sort: 'none',
        gap: 2,
        left: (room.left ?? 0) + 8,
        right: (room.right ?? 0) + 8,
        width: '60%',
        top,
        bottom,
        minSize: '8%',
        data: stages.map((stage, index) => ({ name: stage.name, value: stage.value, itemStyle: { color: colors[index] } })),
        // Each stage is named beside it, with how much of the first stage reaches it.
        label: {
          position: 'right',
          color: ink.textSecondary,
          formatter: (p: { name: string; value: number; dataIndex: number }) =>
            labels === 'none' ? p.name : `${p.name}  ${labels === 'value' ? options.formatValue(p.value, column) : percentText(stages[p.dataIndex]?.share ?? 0)}`,
        },
        labelLine: { lineStyle: { color: ink.axis } },
        itemStyle: { borderColor: ink.surface, borderWidth: 1 },
      },
    ],
  }
}

export function treemapOption(name: string, tiles: TreemapNode[], column: ResultColumn | undefined, options: Options): EChartsCoreOption {
  const style = options.style ?? {}
  const grouped = tiles.some((tile) => tile.children)
  const { ink, room, option } = base(options, grouped)
  const colors = paletteColors(style.palette, options.scheme)
  const whole = tiles.reduce((sum, tile) => sum + tile.value, 0)
  const write = (value: number) => (style.labels === 'percent' ? percentText(whole > 0 ? value / whole : 0) : options.formatValue(value, column))
  const label = { color: '#ffffff', overflow: 'truncate', formatter: (p: { name: string; value: number }) => (style.labels === 'value' || style.labels === 'percent' ? `${p.name}\n${write(p.value)}` : p.name) }
  // One group a colour; without groups the tiles are all one colour, told apart by the gaps between them.
  const data = tiles.map((tile, at) => ({ ...tile, itemStyle: { color: grouped ? colors[at % colors.length] : colors[0] } }))
  return {
    ...option,
    // The legend of a treemap names its groups, which are not series of their own; see the series that stands for them below.
    legend: option.legend ? { ...option.legend, data: tiles.map((tile) => tile.name), selectedMode: false } : undefined,
    tooltip: { trigger: 'item', ...tooltipBox(ink), formatter: (p: { name: string; value: number; marker: string }) => `${p.marker}${html(p.name)}<br/>${html(options.formatValue(p.value, column))}` },
    series: [
      {
        name,
        type: 'treemap',
        roam: false,
        nodeClick: false,
        breadcrumb: { show: false },
        left: room.left ?? 0,
        right: room.right ?? 0,
        top: room.top ?? 0,
        bottom: room.bottom ?? 0,
        data,
        label,
        upperLabel: { show: false },
        itemStyle: { color: colors[0], borderColor: ink.surface, borderWidth: 2, gapWidth: 2 },
        levels: grouped ? [{ itemStyle: { borderColor: ink.surface, borderWidth: 0, gapWidth: 2 } }, { itemStyle: { borderColor: ink.surface, borderWidth: 1, gapWidth: 1 } }] : undefined,
      },
      // A legend lists what series give it, and a treemap gives none: its
      // groups were named in the legend and never drawn there. This series
      // draws nothing itself and gives the legend each group with its colour.
      ...(grouped && option.legend
        ? [{ type: 'pie', radius: 0, silent: true, label: { show: false }, labelLine: { show: false }, tooltip: { show: false }, data: data.map((tile) => ({ name: tile.name, value: 1, itemStyle: tile.itemStyle })) }]
        : []),
    ],
  }
}

export function heatmapOption(data: HeatmapData, options: Options): EChartsCoreOption {
  const style = options.style ?? {}
  const ink = inkFor(options.scheme, options.surface)
  const ramp = magnitude(options.scheme)
  const span = data.max - data.min
  // Text on a cell takes whichever ink stands out from it.
  const strong = (value: number) => (span > 0 ? (value - data.min) / span : 0.5) > 0.55
  const labelColor = (value: number) => (options.scheme === 'light' ? (strong(value) ? '#ffffff' : ink.text) : strong(value) ? '#0b0b0b' : ink.text)
  return {
    backgroundColor: 'transparent',
    textStyle: { color: ink.textSecondary },
    grid: { ...gridOf({ bottom: 40 }, { x: Boolean(style.xAxis?.title), y: Boolean(style.yAxis?.title) }) },
    tooltip: {
      trigger: 'item',
      ...tooltipBox(ink),
      formatter: (p: { value: [number, number, number] }) => `${html(data.rows[p.value[1]])} · ${html(data.columns[p.value[0]])}<br/>${html(options.formatValue(p.value[2], data.column))}`,
    },
    xAxis: { ...axisOf('category', style.xAxis, ink, 'x'), data: data.columns, splitArea: { show: false } },
    yAxis: { ...axisOf('category', style.yAxis, ink, 'y'), data: data.rows, inverse: true, splitArea: { show: false } },
    // The scale stands in for a legend: how dark a cell is says how much.
    visualMap: {
      type: 'continuous',
      min: data.min,
      max: span > 0 ? data.max : data.min + 1,
      calculable: false,
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
      itemHeight: 160,
      itemWidth: 10,
      inRange: { color: ramp },
      textStyle: { color: ink.textSecondary },
      formatter: (value: number) => options.formatAxis(value, data.column),
    },
    series: [
      {
        type: 'heatmap',
        name: data.column.label ?? data.column.name,
        data: data.cells.map((cell) => ({ value: cell, label: { color: labelColor(cell[2]) } })),
        label: { show: style.labels === 'value', formatter: (p: { value: [number, number, number] }) => options.formatValue(p.value[2], data.column) },
        itemStyle: { borderColor: ink.surface, borderWidth: 2, borderRadius: 2 },
      },
    ],
  }
}

/** Where a scale ends when nothing says: the value rounded up at its first digit, so it is never past the end. */
export function roundedUp(value: number, min: number): number {
  if (value <= min) return min + 100
  const step = 10 ** Math.floor(Math.log10(value - min))
  return min + Math.ceil((value - min) / step) * step
}

export function gaugeOption(data: GaugeData, options: Options): EChartsCoreOption {
  const style = options.style ?? {}
  const ink = inkFor(options.scheme, options.surface)
  const min = style.gauge?.min ?? 0
  const max = data.target !== undefined ? (data.target ?? min + 1) : (style.gauge?.max ?? roundedUp(data.value ?? 0, min))
  const value = data.value ?? min
  const share = max > min ? (value - min) / (max - min) : 0
  const detail = data.value === null ? '—' : options.formatValue(data.value, data.column)
  const below =
    data.target !== undefined && data.target !== null ? options.texts.target(options.formatValue(data.target, data.column), percentText(Math.max(0, share))) : data.label
  return {
    backgroundColor: 'transparent',
    series: [
      {
        type: 'gauge',
        min,
        max: max > min ? max : min + 1,
        startAngle: 210,
        endAngle: -30,
        radius: '90%',
        center: ['50%', '58%'],
        progress: { show: true, width: 14, roundCap: true, itemStyle: { color: paletteColors(style.palette, options.scheme)[0] } },
        axisLine: { roundCap: true, lineStyle: { width: 14, color: [[1, ink.grid]] } },
        pointer: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        anchor: { show: false },
        title: { show: true, offsetCenter: [0, '32%'], color: ink.textSecondary, fontSize: 13 },
        detail: { valueAnimation: false, offsetCenter: [0, '-4%'], color: ink.text, fontSize: 28, fontWeight: 600, formatter: () => detail },
        data: [{ value: Math.min(Math.max(value, min), max > min ? max : min + 1), name: below }],
      },
    ],
  }
}

export function sankeyOption(data: SankeyData, options: Options): EChartsCoreOption {
  const style = options.style ?? {}
  const ink = inkFor(options.scheme, options.surface)
  const colors = paletteColors(style.palette, options.scheme)
  const byId = new Map(data.nodes.map((node) => [node.id, node]))
  const last = Math.max(0, ...data.nodes.map((node) => node.level))
  const share = (value: number) => percentText(data.whole > 0 ? value / data.whole : 0)
  const amount = (value: number) => options.formatValue(value, data.column)
  // The first level's values carry the palette; later levels are neutral, and each flow takes the colour of where it comes from.
  let next = 0
  const colorOf = (node: SankeyNode) => (node.level === 0 && !node.other ? colors[next++ % colors.length] : ink.axis)
  const label = (node: SankeyNode | undefined) => {
    if (!node) return ''
    if (style.labels === 'value') return `${node.name}  ${amount(node.value)}`
    if (style.labels === 'percent') return `${node.name}  ${share(node.value)}`
    return node.name
  }
  return {
    backgroundColor: 'transparent',
    textStyle: { color: ink.textSecondary },
    tooltip: {
      trigger: 'item',
      ...tooltipBox(ink),
      formatter: (p: { dataType: 'node' | 'edge'; data: { name?: string; source?: string; target?: string; value: number } }) =>
        p.dataType === 'edge'
          ? `${html(byId.get(p.data.source!)?.name)} → ${html(byId.get(p.data.target!)?.name)}<br/>${html(amount(p.data.value))}（${share(p.data.value)}）`
          : `${html(byId.get(p.data.name!)?.name)}<br/>${html(amount(p.data.value))}（${share(p.data.value)}）`,
    },
    series: [
      {
        type: 'sankey',
        left: 8,
        right: 8,
        top: 8,
        bottom: 8,
        nodeWidth: 12,
        nodeGap: 10,
        nodeAlign: style.nodeAlign ?? 'justify',
        layoutIterations: 32,
        draggable: false,
        emphasis: { focus: 'adjacency' },
        // Names are kept apart by level, so a value at two levels is two nodes; each is labelled by its value alone.
        // The last level is labelled on its left, inside the plot.
        data: data.nodes.map((node) => ({ name: node.id, value: node.value, itemStyle: { color: colorOf(node), borderColor: ink.surface, borderWidth: 1 }, ...(node.level === last ? { label: { position: 'left' } } : {}) })),
        links: data.links,
        label: { color: ink.textSecondary, formatter: (p: { name: string }) => label(byId.get(p.name)) },
        lineStyle: { color: 'source', opacity: 0.35, curveness: 0.5 },
      },
    ],
  }
}
