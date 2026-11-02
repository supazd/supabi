// The rendering library is an implementation detail of this package: nothing
// exported here mentions it. See .agents/design/architecture.md §11.
export { Visualization, type VisualizationProps } from './Visualization'
export type { HeaderEditing } from './Tables'
export { applyFormats, dateStyles, formatAxis, formatCategory, formatCell, formatDate, formatNumber, isNumeric, isPlain, isTemporal, numberStyles, numberUnits, timeStyles, weekOfYear, weekStyles, type DateFormat, type DateStyle, type DisplayFormat, type NumberFormat, type NumberStyle, type NumberUnit, type TimeStyle, type WeekStyle } from './format'
export type { ChartTexts } from './echartsAdapter'
export { highlightInk, hueColor, hues, inkFor, mix, paletteColors, palettes, type ChartColorScheme, type Hue, type Ink, type PaletteName } from './palette'
export type { Cell, ClickPoint, ColumnType, Grain, QueryResult, QueryTotal, ResultColumn } from './result'
export { ChartSpecError, axisKinds, highlightIcons, highlightOps, maxHighlights, shareTypes, styleApplies, vizTypes, type Axis, type ChartErrorCode, type ColumnGroup, type Highlight, type HighlightIcon, type HighlightOp, type LabelContent, type LegendPosition, type Style, type Viz, type VizType } from './spec'
export { groupsOf, layoutColumns, maxGroupDepth, maxGroupLabel, type ColumnItem } from './columnGroups'
export { maxScatterSeries, maxSeries } from './transform'
