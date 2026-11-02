// Drilling down a chart: the levels an author lays out below one of its
// dimensions, and where a viewer is among them. The server resolves every
// level; the page only says which values were clicked on the way down. See
// .agents/design/chart-dashboard.md §2.10.
import { formatCategory, type Cell, type ResultColumn } from '@supabi/charts'
import type { TFunction } from 'i18next'
import { isTemporal, type SpecField } from '../api/spec'
import type { Grain } from './builder'

/** A level below the first: a dimension of the dataset, at a grain for a date. */
export interface DrillLevel {
  field: string
  grain?: Grain
  /** What the level is called, written when it is set up: viewers of a dashboard cannot read the dataset. */
  label?: string
}

export interface Drill {
  /** The output column of the dimension that is the first level. */
  alias: string
  levels: DrillLevel[]
}

/** The most levels below the first (internal/content/drill.go). */
export const maxDrillLevels = 7

/** The charts where clicking a value picks one of the drilled column's values. */
export const drillTypes = ['bar', 'hbar', 'line', 'area', 'combo', 'pie', 'table'] as const

/** A dimension as a level: a field, and the grain of a date. */
export interface Grouping {
  field: string
  grain?: Grain
}

/**
 * Whether every period of the inner grain falls within one of the outer: a
 * week runs across months and years, so it holds days, but no month holds it.
 */
export function within(outer: Grain | undefined, inner: Grain | undefined): boolean {
  if (outer === 'week') return inner === 'day'
  const nested: (Grain | undefined)[] = ['year', 'quarter', 'month', 'day']
  const i = nested.indexOf(outer)
  const j = nested.indexOf(inner)
  return i >= 0 && j > i
}

export type DrillProblem = 'unknownField' | 'repeated' | 'grain'

/**
 * What is wrong with levels below a first one, the first thing to put right:
 * a level that is no dimension of the dataset, two levels alike or one that
 * is another of the chart's dimensions, or a date that does not get finer.
 */
export function drillProblem(first: Grouping, levels: Grouping[], others: Grouping[], fields: SpecField[]): DrillProblem | undefined {
  const seen = new Set([first, ...others].map((grouping) => JSON.stringify([grouping.field, grouping.grain ?? null])))
  let above = first
  for (const level of levels) {
    const field = fields.find((candidate) => candidate.key === level.field)
    if (!field || field.role !== 'dimension' || Boolean(level.grain) !== isTemporal(field.type)) return 'unknownField'
    const key = JSON.stringify([level.field, level.grain ?? null])
    if (seen.has(key)) return 'repeated'
    seen.add(key)
    if (level.field === above.field && !within(above.grain, level.grain)) return 'grain'
    above = level
  }
  return undefined
}

/** The grains finer than a date's, one by one, that a drill down it starts with. */
export function finerGrains(grain: Grain | undefined): Grain[] {
  if (grain === 'week') return ['day']
  const nested: Grain[] = ['year', 'quarter', 'month', 'day']
  const at = grain ? nested.indexOf(grain) : -1
  return at < 0 ? [] : nested.slice(at + 1)
}

/** What a level is called: its field, and the grain of a date. */
export function levelLabel(level: Grouping, fields: SpecField[], t: TFunction): string {
  const name = fields.find((field) => field.key === level.field)?.label ?? level.field
  return level.grain ? `${name} · ${t(`explore.grains.${level.grain}`)}` : name
}

/**
 * Where a viewer is: the values clicked on the way down, each with how the
 * chart wrote it, and what the first level is called. Empty is the first level.
 * A value without its text came in a share link that the server wrote, which
 * has only the value; the breadcrumb then writes it.
 */
export interface DrillPosition {
  root: string
  steps: { value: Cell; text?: string }[]
}

/** How a step is written in a breadcrumb: as the chart wrote it, or from the value. */
export const stepText = (step: DrillPosition['steps'][number], t: TFunction) => step.text ?? drillText(step.value, undefined, t)

/**
 * The texts of the values a share link brought without them, written from
 * the values as the chart would: a date by the grain of its level. Missing
 * values and empty text are left for the breadcrumb to name.
 */
export function withStepTexts(position: DrillPosition, drill: Drill, firstGrain: Grain | undefined): DrillPosition {
  return {
    ...position,
    steps: position.steps.map((step, depth) => {
      if (step.text !== undefined || step.value === null || step.value === '') return step
      const grain = depth === 0 ? firstGrain : drill.levels[depth - 1]?.grain
      return { ...step, text: formatCategory(step.value, grain ? ({ name: '', type: 'date', role: 'dimension', grain } as ResultColumn) : undefined) }
    }),
  }
}

/** The values to send for a position, as the server takes them. */
export const drillPath = (position: DrillPosition | undefined): Cell[] => position?.steps.map((step) => step.value) ?? []

/** A value as the chart wrote it, for the breadcrumb: missing values and empty text are named. */
export function drillText(value: Cell, column: ResultColumn | undefined, t: TFunction, firstWeekDays?: number): string {
  if (value === null) return t('drill.null')
  if (value === '') return t('drill.empty')
  return formatCategory(value, column, firstWeekDays)
}

/** The position one level further down, through the value clicked in the column as it is now. */
export function drilledInto(position: DrillPosition | undefined, value: Cell, column: ResultColumn | undefined, t: TFunction, firstWeekDays?: number): DrillPosition {
  return {
    root: position?.root ?? column?.label ?? column?.name ?? '',
    steps: [...(position?.steps ?? []), { value, text: drillText(value, column, t, firstWeekDays) }],
  }
}

/** The menu entry that goes one level down, or none at the last. */
export function drillDown(drill: Drill | undefined, position: DrillPosition | undefined, t: TFunction): { label: string } | undefined {
  const depth = position?.steps.length ?? 0
  const next = drill?.levels[depth]
  return next && { label: t('drill.to', { name: next.label ?? next.field }) }
}
