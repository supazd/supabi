import { axisKinds, hueColor, hues, paletteColors, shareTypes, styleApplies, type Axis, type ChartColorScheme, type Hue, type LabelContent, type LegendPosition, type PaletteName, type Style, type VizType } from '@supabi/charts'
import { Button, Checkbox, Input, Segmented, Select, Tooltip } from '@supabi/ui'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { maxTotals } from '../lib/builder'
import { ConfigSection } from './ConfigSection'

/** A measure of the chart, by its column, with what the chart calls it. */
export interface StyledMeasure {
  column: string
  name: string
}

/**
 * Whether a pivot table with totals also shows the subtotals of its outer
 * dimensions; `fit` is false when that would be more totals than a query may ask for.
 */
interface Subtotals {
  on: boolean
  fit: boolean
  onChange: (on: boolean) => void
}

interface Props {
  type: VizType
  style: Style | undefined
  onStyle: (style: Style | undefined) => void
  measures: StyledMeasure[]
  /** Whether a column's values split the measure into series, which then take the palette's order. */
  split: boolean
  /** Whether stacking means anything here: more than one series of a type that stacks. */
  stackable: boolean
  stacked: boolean
  onStacked: (stacked: boolean) => void
  /** A combo chart's measures drawn as lines and read against the right axis, by column. */
  lines: string[]
  rightAxis: string[]
  onCombo: (patch: { lines?: string[]; rightAxis?: string[] }) => void
  colorScheme: ChartColorScheme
  disabled?: boolean
  /** Whether the table shows the database's totals; absent where a table has none to show. */
  totals?: { on: boolean; onChange: (on: boolean) => void; omitted: boolean; subtotals?: Subtotals }
  /** A KPI tile's measure and the measure it is compared against, by column. */
  compare?: Record<string, string>
  onCompare?: (compare: Record<string, string> | undefined) => void
}

/** Drops what is not set, so a setting put back to its default leaves nothing behind. */
function compact<T extends object>(value: T): T | undefined {
  const entries = Object.entries(value).filter(([, inner]) => inner !== undefined && inner !== false && inner !== '' && !(typeof inner === 'object' && inner !== null && Object.keys(inner).length === 0))
  return entries.length ? (Object.fromEntries(entries) as T) : undefined
}

/**
 * A number typed in a box, taken when it is left or Enter is pressed so the
 * chart is not drawn again at every digit. Left empty, there is none.
 */
function NumberField({ label, value, onChange, min, max, step, whole, placeholder, disabled }: { label: string; value: number | undefined; onChange: (value: number | undefined) => void; min?: number; max?: number; step?: number; /** Only whole numbers, which is what a count of rows or pixels is. */ whole?: boolean; placeholder?: string; disabled?: boolean }) {
  const id = useId()
  const [draft, setDraft] = useState<string | null>(null)
  const text = draft ?? (value === undefined ? '' : String(value))
  const parsed = text.trim() ? Number(text) : undefined
  const valid = parsed === undefined || (Number.isFinite(parsed) && (!whole || Number.isInteger(parsed)) && (min === undefined || parsed >= min) && (max === undefined || parsed <= max))
  const commit = () => {
    if (draft === null || !valid) return
    if (parsed !== value) onChange(parsed)
    setDraft(null)
  }
  return (
    <div className="style-field" onBlur={commit} onKeyDown={(event) => event.key === 'Enter' && commit()}>
      <label htmlFor={id} className="small">{label}</label>
      <Input id={id} size="sm" type="number" min={min} max={max} step={step} value={text} invalid={!valid} disabled={disabled} placeholder={placeholder} onChange={setDraft} />
    </div>
  )
}

/** Text typed in a box, taken when it is left, as NumberField is. */
function TextField({ label, value, onChange, maxLength, disabled }: { label: string; value: string | undefined; onChange: (value: string | undefined) => void; maxLength: number; disabled?: boolean }) {
  const id = useId()
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft === null) return
    const next = draft.trim() || undefined
    if (next !== value) onChange(next)
    setDraft(null)
  }
  return (
    <div className="style-field" onBlur={commit} onKeyDown={(event) => event.key === 'Enter' && commit()}>
      <label htmlFor={id} className="small">{label}</label>
      <Input id={id} size="sm" value={draft ?? value ?? ''} maxLength={maxLength} disabled={disabled} onChange={setDraft} />
    </div>
  )
}

/** The palette's colours to pick one from, or none to take the next in order. */
function Swatches({ label, value, onChange, scheme, disabled }: { label: string; value: Hue | undefined; onChange: (hue: Hue | undefined) => void; scheme: ChartColorScheme; disabled?: boolean }) {
  const { t } = useTranslation()
  return (
    <div className="swatches" role="radiogroup" aria-label={label}>
      <Tooltip title={t('chartStyle.autoColor')}>
        <button type="button" role="radio" className="swatch swatch-auto" aria-checked={value === undefined} aria-label={t('chartStyle.autoColor')} disabled={disabled} onClick={() => onChange(undefined)} />
      </Tooltip>
      {hues.map((hue) => (
        <Tooltip key={hue} title={t(`chartStyle.hues.${hue}`)}>
          <button type="button" role="radio" className="swatch" aria-checked={value === hue} aria-label={t(`chartStyle.hues.${hue}`)} disabled={disabled} style={{ background: hueColor(hue, scheme) }} onClick={() => onChange(hue)} />
        </Tooltip>
      ))}
    </div>
  )
}

/**
 * The settings of how a chart looks, in groups for the chosen type. A group
 * the type has nothing for is not shown.
 */
export function ChartStyleSettings({ type, style, onStyle, measures, split, stackable, stacked, onStacked, lines, rightAxis, onCombo, colorScheme, disabled, totals, compare = {}, onCompare }: Props) {
  const { t } = useTranslation()
  const current = style ?? {}
  const set = (patch: Partial<Style>) => onStyle(compact({ ...current, ...patch }))
  const applies = (key: keyof typeof styleApplies) => styleApplies[key].includes(type)
  const kinds = axisKinds(type)
  const setAxis = (key: 'xAxis' | 'yAxis' | 'y2Axis', patch: Partial<Axis>) => set({ [key]: compact({ ...current[key], ...patch }) })
  const combo = type === 'combo'
  const target = type === 'gauge' && measures.length > 1

  const series = (
    <>
      {stackable && (
        <Checkbox checked={stacked} disabled={disabled} onChange={onStacked}>
          {t('explore.stacked')}
        </Checkbox>
      )}
      {stackable && stacked && applies('percent') && (
        <Checkbox checked={Boolean(current.percent)} disabled={disabled} onChange={(percent) => set({ percent })}>
          {t('chartStyle.percent')}
        </Checkbox>
      )}
      {applies('smooth') && (
        <Checkbox checked={Boolean(current.smooth)} disabled={disabled} onChange={(smooth) => set({ smooth })}>
          {t('chartStyle.smooth')}
        </Checkbox>
      )}
      {applies('points') && (
        <Checkbox checked={Boolean(current.points)} disabled={disabled} onChange={(points) => set({ points })}>
          {t('chartStyle.points')}
        </Checkbox>
      )}
      {applies('solid') && (
        <Checkbox checked={Boolean(current.solid)} disabled={disabled} onChange={(solid) => set({ solid })}>
          {t('chartStyle.solid')}
        </Checkbox>
      )}
      {applies('nodeAlign') && (
        <div className="style-field">
          <span className="small">{t('chartStyle.nodeAlign')}</span>
          <Select<'justify' | 'left' | 'right'>
            size="sm"
            block
            aria-label={t('chartStyle.nodeAlign')}
            value={current.nodeAlign ?? 'justify'}
            disabled={disabled}
            options={(['justify', 'left', 'right'] as const).map((value) => ({ value, label: t(`chartStyle.nodeAligns.${value}`) }))}
            onChange={(value) => set({ nodeAlign: value === 'justify' ? undefined : value })}
          />
        </div>
      )}
      {applies('barWidth') && (
        <NumberField label={t('chartStyle.barWidth')} value={current.barWidth} min={4} max={80} step={1} whole placeholder={t('chartStyle.barWidthDefault')} disabled={disabled} onChange={(barWidth) => set({ barWidth })} />
      )}
      {applies('gauge') && (
        <>
          <NumberField label={t('chartStyle.gaugeMin')} value={current.gauge?.min} placeholder="0" disabled={disabled} onChange={(min) => set({ gauge: compact({ ...current.gauge, min }) })} />
          {target ? (
            <p className="note small">{t('chartStyle.gaugeTarget', { name: measures[1]!.name })}</p>
          ) : (
            <NumberField label={t('chartStyle.gaugeMax')} value={current.gauge?.max} placeholder={t('chartStyle.auto')} disabled={disabled} onChange={(max) => set({ gauge: compact({ ...current.gauge, max }) })} />
          )}
        </>
      )}
      {combo &&
        measures.map((measure) => (
          <div className="combo-measure" key={measure.column}>
            <span className="combo-measure-name" title={measure.name}>{measure.name}</span>
            <Segmented
              aria-label={t('chartStyle.drawAs', { name: measure.name })}
              value={lines.includes(measure.column) ? 'line' : 'bar'}
              options={[{ value: 'bar', label: t('chartStyle.asBar') }, { value: 'line', label: t('chartStyle.asLine') }]}
              onChange={(as) => onCombo({ lines: as === 'line' ? [...lines, measure.column] : lines.filter((name) => name !== measure.column) })}
            />
            <Checkbox checked={rightAxis.includes(measure.column)} disabled={disabled} onChange={(on) => onCombo({ rightAxis: on ? [...rightAxis, measure.column] : rightAxis.filter((name) => name !== measure.column) })}>
              {t('chartStyle.rightAxis')}
            </Checkbox>
          </div>
        ))}
      {combo && rightAxis.length > 0 && <p className="note small">{t('chartStyle.rightAxisHint')}</p>}
    </>
  )
  const hasSeries = stackable || ['smooth', 'points', 'solid', 'barWidth', 'gauge', 'nodeAlign'].some((key) => applies(key as keyof typeof styleApplies)) || combo

  const share = shareTypes.includes(type)
  // A sankey diagram names its nodes and says nothing more by default; the other shares say their percentage.
  const unlabelled: LabelContent = type === 'sankey' ? 'none' : 'percent'
  const labelOptions: LabelContent[] = type === 'sankey' ? ['none', 'value', 'percent'] : share ? ['percent', 'value', 'none'] : ['value']
  const legend = applies('legend') && (
    <Select<LegendPosition | 'auto'>
      size="sm"
      block
      aria-label={t('chartStyle.legend')}
      value={current.legend ?? 'auto'}
      disabled={disabled}
      options={(['auto', 'top', 'bottom', 'left', 'right', 'none'] as const).map((value) => ({ value, label: t(`chartStyle.legends.${value}`) }))}
      onChange={(value) => set({ legend: value === 'auto' ? undefined : value })}
    />
  )
  const labels = applies('labels') && (share ? (
    <Select<LabelContent>
      size="sm"
      block
      aria-label={t('chartStyle.labels')}
      value={current.labels ?? unlabelled}
      disabled={disabled}
      options={labelOptions.map((value) => ({ value, label: t(type === 'sankey' && value === 'none' ? 'chartStyle.namesOnly' : `chartStyle.labelContents.${value}`) }))}
      // A share is what the chart says by default, so choosing it says nothing.
      onChange={(value) => set({ labels: value === unlabelled ? undefined : value })}
    />
  ) : (
    <Checkbox checked={current.labels === 'value'} disabled={disabled} onChange={(on) => set({ labels: on ? 'value' : undefined })}>
      {t(type === 'scatter' ? 'chartStyle.pointNames' : 'chartStyle.showValues')}
    </Checkbox>
  ))

  const palette = applies('palette') && (
    <Select<PaletteName | 'default'>
      size="sm"
      block
      aria-label={t('chartStyle.palette')}
      value={current.palette ?? 'default'}
      disabled={disabled}
      options={(['default', 'fresh', 'warm'] as const).map((value) => ({
        value,
        label: t(`chartStyle.palettes.${value}`),
        icon: (
          <span className="palette-preview" aria-hidden="true">
            {paletteColors(value === 'default' ? undefined : value, colorScheme).slice(0, 4).map((color) => <span key={color} style={{ background: color }} />)}
          </span>
        ),
      }))}
      onChange={(value) => set({ palette: value === 'default' ? undefined : value })}
    />
  )
  // Colours are given to measures; series made from a column's values take the palette's order.
  const colors = applies('colors') && !split && measures.length > 0 && measures.map((measure) => (
    <div className="style-field" key={measure.column}>
      <span className="small">{measure.name}</span>
      <Swatches
        label={t('chartStyle.colorOf', { name: measure.name })}
        value={current.colors?.[measure.column]}
        scheme={colorScheme}
        disabled={disabled}
        onChange={(hue) => {
          const rest = Object.fromEntries(Object.entries(current.colors ?? {}).filter(([column]) => column !== measure.column))
          set({ colors: compact(hue ? { ...rest, [measure.column]: hue } : rest) })
        }}
      />
    </div>
  ))

  const axis = (key: 'xAxis' | 'yAxis' | 'y2Axis', kind: 'value' | 'category') => {
    const settings = current[key]
    return (
      <div className="style-axis" key={key} role="group" aria-label={t(`chartStyle.axes.${key}`)}>
        <span className="style-axis-title">{t(`chartStyle.axes.${key}`)}</span>
        <TextField label={t('chartStyle.axisTitle')} value={settings?.title} maxLength={50} disabled={disabled} onChange={(title) => setAxis(key, { title })} />
        {kind === 'value' ? (
          <>
            <div className="style-range">
              <NumberField label={t('chartStyle.axisMin')} value={settings?.min} placeholder={t('chartStyle.auto')} disabled={disabled} onChange={(min) => setAxis(key, { min })} />
              <NumberField label={t('chartStyle.axisMax')} value={settings?.max} placeholder={t('chartStyle.auto')} disabled={disabled} onChange={(max) => setAxis(key, { max })} />
            </div>
            {settings?.min !== undefined && settings.max !== undefined && settings.min >= settings.max && <span className="note small warning">{t('chartStyle.axisRange')}</span>}
            <Checkbox checked={Boolean(settings?.hideGrid)} disabled={disabled} onChange={(hideGrid) => setAxis(key, { hideGrid })}>
              {t('chartStyle.hideGrid')}
            </Checkbox>
          </>
        ) : (
          <Select<'0' | '45' | '90'>
            size="sm"
            block
            aria-label={t('chartStyle.rotate')}
            value={String(settings?.rotate ?? 0) as '0'}
            disabled={disabled}
            options={(['0', '45', '90'] as const).map((value) => ({ value, label: t(`chartStyle.rotations.${value}`) }))}
            onChange={(value) => setAxis(key, { rotate: value === '0' ? undefined : (Number(value) as 45 | 90) })}
          />
        )}
        <Checkbox checked={Boolean(settings?.hideLabels)} disabled={disabled} onChange={(hideLabels) => setAxis(key, { hideLabels })}>
          {t('chartStyle.hideLabels')}
        </Checkbox>
      </div>
    )
  }
  const axes = [
    kinds.xAxis && axis('xAxis', kinds.xAxis),
    kinds.yAxis && axis('yAxis', kinds.yAxis),
    kinds.y2Axis && rightAxis.length > 0 && axis('y2Axis', kinds.y2Axis),
  ].filter(Boolean)

  const table = applies('striped') && (
    <ConfigSection storageKey="supabi.chart.section.table" title={t('chartStyle.table')}>
      {totals && (
        <>
          <Checkbox checked={totals.on} disabled={disabled} onChange={totals.onChange}>
            {t('chartStyle.totals')}
          </Checkbox>
          {totals.on && <p className="note small">{t(totals.omitted ? 'chartStyle.totalsOmitted' : 'chartStyle.totalsHint')}</p>}
          {totals.on && totals.subtotals && (
            <>
              <Checkbox checked={totals.subtotals.on && totals.subtotals.fit} disabled={disabled || !totals.subtotals.fit} onChange={totals.subtotals.onChange}>
                {t('chartStyle.subtotals')}
              </Checkbox>
              {!totals.subtotals.fit ? <p className="note small">{t('chartStyle.subtotalsTooMany', { max: maxTotals })}</p> : totals.subtotals.on && !totals.omitted && <p className="note small">{t('chartStyle.subtotalsHint')}</p>}
            </>
          )}
        </>
      )}
      <Checkbox checked={Boolean(current.striped)} disabled={disabled} onChange={(striped) => set({ striped })}>
        {t('chartStyle.striped')}
      </Checkbox>
      <Checkbox checked={Boolean(current.freeze)} disabled={disabled} onChange={(freeze) => set({ freeze })}>
        {t('chartStyle.freeze')}
      </Checkbox>
      {applies('merge') && (
        <>
          <Checkbox checked={Boolean(current.merge)} disabled={disabled} onChange={(merge) => set({ merge })}>
            {t('chartStyle.merge')}
          </Checkbox>
          {current.merge && <p className="note small">{t('chartStyle.mergeHint')}</p>}
        </>
      )}
      {applies('paging') && (
        <>
          <div className="style-field">
            <span className="small">{t('chartStyle.paging')}</span>
            <Select<'all' | 'pages' | 'auto'>
              size="sm"
              block
              aria-label={t('chartStyle.paging')}
              value={current.paging ?? 'all'}
              disabled={disabled}
              options={(['all', 'pages', 'auto'] as const).map((value) => ({ value, label: t(`chartStyle.pagings.${value}`) }))}
              onChange={(value) => set({ paging: value === 'all' ? undefined : value })}
            />
          </div>
          {current.paging === 'pages' && (
            <NumberField label={t('chartStyle.pageSize')} value={current.pageSize} min={1} max={1000} step={1} whole placeholder={t('chartStyle.pageSizeDefault')} disabled={disabled} onChange={(pageSize) => set({ pageSize })} />
          )}
          {current.paging === 'auto' && <p className="note small">{t('chartStyle.pagingAutoHint')}</p>}
        </>
      )}
      <div className="style-field">
        <span className="small">{t('chartStyle.density')}</span>
        <Select<'compact' | 'normal' | 'comfortable'>
          size="sm"
          block
          aria-label={t('chartStyle.density')}
          value={current.density ?? 'normal'}
          disabled={disabled}
          options={(['compact', 'normal', 'comfortable'] as const).map((value) => ({ value, label: t(`chartStyle.densities.${value}`) }))}
          onChange={(value) => set({ density: value === 'normal' ? undefined : value })}
        />
      </div>
      {current.widths && Object.keys(current.widths).length > 0 ? (
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => set({ widths: undefined })}>{t('chartStyle.resetWidths')}</Button>
      ) : (
        <p className="note small">{t('chartStyle.widthsHint')}</p>
      )}
    </ConfigSection>
  )

  // A measure compared against is no tile of its own, and cannot be compared in turn.
  const references = new Set(Object.values(compare))
  const compared = Object.keys(compare).length > 0
  const kpi = type === 'kpi' && (
    <ConfigSection storageKey="supabi.chart.section.kpi" title={t('chartStyle.kpi')}>
      <div className="style-field">
        <span className="small">{t('chartStyle.textAlign')}</span>
        <Segmented
          block
          aria-label={t('chartStyle.textAlign')}
          value={current.textAlign ?? 'left'}
          options={(['left', 'center'] as const).map((value) => ({ value, label: t(`chartStyle.textAligns.${value}`) }))}
          onChange={(value) => set({ textAlign: value === 'left' ? undefined : value })}
        />
      </div>
      <div className="style-field">
        <span className="small">{t('chartStyle.size')}</span>
        <Segmented
          block
          aria-label={t('chartStyle.size')}
          value={current.size ?? 'normal'}
          options={(['small', 'normal', 'large'] as const).map((value) => ({ value, label: t(`chartStyle.sizes.${value}`) }))}
          onChange={(value) => set({ size: value === 'normal' ? undefined : value })}
        />
      </div>
      {measures.length > 1 && onCompare && measures.filter((measure) => !references.has(measure.column)).map((measure) => (
        <div className="style-field" key={measure.column}>
          <span className="small">{t('chartStyle.compareOf', { name: measure.name })}</span>
          <Select<string>
            size="sm"
            block
            aria-label={t('chartStyle.compareOf', { name: measure.name })}
            value={compare[measure.column] ?? ''}
            disabled={disabled}
            options={[{ value: '', label: t('chartStyle.noCompare') }, ...measures.filter((other) => other.column !== measure.column && !compare[other.column]).map((other) => ({ value: other.column, label: other.name }))]}
            onChange={(value) => {
              const rest = Object.fromEntries(Object.entries(compare).filter(([tile]) => tile !== measure.column))
              onCompare(compact(value ? { ...rest, [measure.column]: value } : rest))
            }}
          />
        </div>
      ))}
      {compared && (
        <>
          <div className="style-field">
            <span className="small">{t('chartStyle.compareAs')}</span>
            <Select<'percent' | 'diff' | 'both'>
              size="sm"
              block
              aria-label={t('chartStyle.compareAs')}
              value={current.compareAs ?? 'percent'}
              disabled={disabled}
              options={(['percent', 'diff', 'both'] as const).map((value) => ({ value, label: t(`chartStyle.compareAses.${value}`) }))}
              onChange={(value) => set({ compareAs: value === 'percent' ? undefined : value })}
            />
          </div>
          <Checkbox checked={Boolean(current.redUp)} disabled={disabled} onChange={(redUp) => set({ redUp })}>
            {t('chartStyle.redUp')}
          </Checkbox>
        </>
      )}
    </ConfigSection>
  )

  return (
    <>
      {table}
      {kpi}
      {hasSeries && (
        <ConfigSection storageKey="supabi.chart.section.style" title={t('explore.style')}>
          {series}
        </ConfigSection>
      )}
      {(legend || labels) && (
        <ConfigSection storageKey="supabi.chart.section.legend" title={t('chartStyle.legendAndLabels')}>
          {legend && <div className="style-field"><span className="small">{t('chartStyle.legend')}</span>{legend}</div>}
          {labels && (share ? <div className="style-field"><span className="small">{t('chartStyle.labels')}</span>{labels}</div> : labels)}
        </ConfigSection>
      )}
      {(palette || colors) && (
        <ConfigSection storageKey="supabi.chart.section.colors" title={t('chartStyle.colors')}>
          {palette && <div className="style-field"><span className="small">{t('chartStyle.palette')}</span>{palette}</div>}
          {colors}
        </ConfigSection>
      )}
      {axes.length > 0 && (
        <ConfigSection storageKey="supabi.chart.section.axes" title={t('chartStyle.axesTitle')}>
          {axes}
        </ConfigSection>
      )}
    </>
  )
}
