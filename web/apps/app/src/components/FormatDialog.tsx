import { dateStyles, formatDate, formatNumber, isPlain, numberStyles, numberUnits, timeStyles, weekStyles, type DateFormat, type DateStyle, type DisplayFormat, type NumberFormat, type NumberStyle, type NumberUnit, type TimeStyle, type WeekStyle } from '@supabi/charts'
import { Button, Checkbox, Dialog, Field, Input, Segmented, Select } from '@supabi/ui'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LogicalType } from '../api/client'
import { isTemporal } from '../api/spec'
import { useFirstWeekDays, useWeekStart } from '../auth/session'
import './format.css'

const maxAffix = 16
const decimalChoices = Array.from({ length: 11 }, (_, n) => String(n))

/**
 * The format without what says the same as leaving it out, as the server
 * writes it back. A number is meant when no style is given, so it has none.
 */
export function cleanFormat(format: NumberFormat): NumberFormat {
  if (format.style === 'none') return { style: 'none' }
  return {
    ...(format.style === 'percent' ? { style: 'percent' as const } : {}),
    ...(format.decimals !== undefined ? { decimals: format.decimals } : {}),
    ...(format.grouping === false ? { grouping: false } : {}),
    ...(format.unit && format.style !== 'percent' ? { unit: format.unit } : {}),
    ...(format.prefix ? { prefix: format.prefix } : {}),
    ...(format.suffix ? { suffix: format.suffix } : {}),
  }
}

/** Numbers that show what a format does to a column of a type: a large one, a negative one. */
export function formatSamples(format: NumberFormat | undefined, type?: LogicalType): string[] {
  if (format?.style === 'percent') return ['0.2345', '-0.05']
  return type === 'integer' ? ['1234567', '-1234'] : ['1234567.891', '-1234.5']
}

/** A few numbers written the way a format writes them. */
export function FormatPreview({ format, type }: { format: NumberFormat | undefined; type?: LogicalType }) {
  const { t, i18n } = useTranslation()
  return (
    <section className="format-preview" aria-label={t('format.preview')}>
      <span className="format-preview-title">{t('format.preview')}</span>
      {formatSamples(format, type).map((sample) => (
        <div key={sample} className="format-preview-row">
          <span className="format-preview-from">{sample}</span>
          <span className="format-preview-arrow" aria-hidden="true">→</span>
          <strong className="format-preview-to">{formatNumber(sample, format, i18n.language)}</strong>
        </div>
      ))}
    </section>
  )
}

/** What is chosen: a style, or on a chart, whatever the dataset says. */
type Choice = 'inherit' | NumberStyle

interface FormatDialogProps {
  name: string
  /** The type of the values, which says whether they are numbers or dates, and which the preview takes its examples from. */
  type?: LogicalType
  /** The format set here; undefined when nothing is. */
  value: DisplayFormat | undefined
  /** On a chart, the dataset's format for the column, which it follows unless it sets its own. */
  inherited?: { format: DisplayFormat | undefined }
  onDone: (format: DisplayFormat | undefined) => void
  onCancel: () => void
}

/** Sets how a number or a date is written. */
export function FormatDialog(props: FormatDialogProps) {
  return props.type && isTemporal(props.type) ? <DateFormatDialog {...props} type={props.type} /> : <NumberFormatDialog {...props} />
}

/**
 * Sets how a number is written. On a dataset a field without a format is
 * shown as it is, the style none; on a chart a column can also follow the
 * dataset, which is what it does unless it says otherwise.
 */
function NumberFormatDialog({ name, value, inherited, type, onDone, onCancel }: FormatDialogProps) {
  const { t } = useTranslation()
  const [choice, setChoice] = useState<Choice>(() => (value ? (value.style ?? 'number') : inherited ? 'inherit' : 'none'))
  // The settings of a number or a percentage start from what it looked like,
  // and survive a look at another style.
  const [draft, setDraft] = useState<NumberFormat>(() => [value, inherited?.format].find((format) => !isPlain(format)) ?? {})
  const patch = (next: Partial<NumberFormat>) => setDraft((current) => ({ ...current, ...next }))

  // What is saved: nothing for the dataset's format or, on a dataset, for none.
  const result = (): NumberFormat | undefined => {
    if (choice === 'inherit') return undefined
    if (choice === 'none') return inherited ? { style: 'none' } : undefined
    return cleanFormat({ ...draft, style: choice === 'percent' ? 'percent' : undefined })
  }
  const shown = choice === 'inherit' ? inherited?.format : (result() ?? { style: 'none' })
  const percent = choice === 'percent'
  const note =
    choice === 'inherit' ? (isPlain(inherited?.format) ? t('format.inheritNone') : t('format.inheritHint'))
    : choice === 'none' ? t('format.noneHint')
    : percent ? t('format.percentHint')
    : undefined

  return (
    <Dialog
      open
      title={t('format.titleOf', { name })}
      width={520}
      onClose={onCancel}
      actions={
        <>
          <Button onClick={onCancel}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={() => onDone(result())}>
            {t('common.confirm')}
          </Button>
        </>
      }
    >
      <div className="format-dialog">
        <Segmented<Choice>
          aria-label={t('format.style')}
          value={choice}
          options={[...(inherited ? ['inherit' as const] : []), ...numberStyles].map((option) => ({
            value: option,
            label: option === 'inherit' ? t('format.inherit') : t(`format.styles.${option}`),
          }))}
          onChange={setChoice}
        />
        <FormatPreview format={shown} type={type} />
        {note && <p className="format-note">{note}</p>}
        {(choice === 'number' || percent) && (
          <div className="format-form">
            <Field label={t('format.decimals')} htmlFor="format-decimals">
              <Select<string>
                id="format-decimals"
                block
                value={draft.decimals === undefined ? 'auto' : String(draft.decimals)}
                options={[{ value: 'auto', label: t('format.decimalsAuto') }, ...decimalChoices.map((n) => ({ value: n, label: n }))]}
                onChange={(decimals) => patch({ decimals: decimals === 'auto' ? undefined : Number(decimals) })}
              />
            </Field>
            {/* A percentage is never divided by a unit. */}
            {!percent && (
              <Field label={t('format.unit')} htmlFor="format-unit" hint={draft.unit === 'auto' ? t('format.unitAutoHint') : undefined}>
                <Select<NumberUnit | 'none'>
                  id="format-unit"
                  block
                  value={draft.unit ?? 'none'}
                  options={(['none', ...numberUnits] as const).map((unit) => ({ value: unit, label: t(`format.units.${unit}`) }))}
                  onChange={(unit) => patch({ unit: unit === 'none' ? undefined : unit })}
                />
              </Field>
            )}
            <div className="format-wide">
              <Checkbox checked={draft.grouping !== false} onChange={(grouping) => patch({ grouping })}>
                {t('format.grouping')}
              </Checkbox>
            </div>
            <Field label={t('format.prefix')} htmlFor="format-prefix">
              <Input id="format-prefix" maxLength={maxAffix} placeholder={t('format.prefixExample')} value={draft.prefix ?? ''} onChange={(prefix) => patch({ prefix })} />
            </Field>
            <Field label={t('format.suffix')} htmlFor="format-suffix">
              <Input id="format-suffix" maxLength={maxAffix} placeholder={t('format.suffixExample')} value={draft.suffix ?? ''} onChange={(suffix) => patch({ suffix })} />
            </Field>
          </div>
        )}
      </div>
    </Dialog>
  )
}

/** The format of a date without what says the same as leaving it out; a date has no time of day. */
export function cleanDateFormat(format: DateFormat, type: LogicalType): DateFormat {
  return {
    ...(format.date && format.date !== 'dash' ? { date: format.date } : {}),
    ...(format.time && format.time !== 'second' && type === 'timestamp' ? { time: format.time } : {}),
    ...(format.week && format.week !== 'range' ? { week: format.week } : {}),
  }
}

/** A day, and the first day of its week, that show what a format makes of a date. */
const sampleDay = '2026-01-05T13:45:12'
const sampleWeek = (weekStart: number) => (weekStart === 7 ? '2026-01-04' : '2026-01-05')

/** How a date of a type is written without a grain, as a field's format is summed up. */
export function dateSample(format: DateFormat | undefined, type: LogicalType): string {
  return formatDate(sampleDay, { type: type as 'date' | 'timestamp', format })
}

/** A date written to a few grains, the way a format writes it. */
export function DatePreview({ format, type }: { format: DateFormat | undefined; type: LogicalType }) {
  const { t } = useTranslation()
  const weekStart = useWeekStart()
  const firstWeekDays = useFirstWeekDays()
  const column = { type: type as 'date' | 'timestamp', format }
  const rows: { key: string; value: string }[] = [
    ...(['quarter', 'month'] as const).map((grain) => ({ key: grain, value: formatDate(sampleDay, { ...column, grain }) })),
    { key: 'week', value: formatDate(sampleWeek(weekStart), { ...column, grain: 'week' as const }, firstWeekDays) },
    { key: 'day', value: formatDate(sampleDay, { ...column, grain: 'day' }) },
    ...(type === 'timestamp' ? [{ key: 'none', value: formatDate(sampleDay, column) }] : []),
  ]
  return (
    <section className="format-preview" aria-label={t('format.preview')}>
      <span className="format-preview-title">{t('format.preview')}</span>
      {rows.map((row) => (
        <div key={row.key} className="format-preview-row">
          <span className="format-preview-from">{t(`format.date.by.${row.key}`)}</span>
          <span className="format-preview-arrow" aria-hidden="true">→</span>
          <strong className="format-preview-to">{row.value}</strong>
        </div>
      ))}
    </section>
  )
}

/**
 * Sets how a date is written; the grain says how much of it. A date has no
 * none: its default writing is what a field without a format gets. On a
 * chart a column can also follow the dataset.
 */
function DateFormatDialog({ name, value, inherited, type, onDone, onCancel }: FormatDialogProps & { type: LogicalType }) {
  const { t } = useTranslation()
  const [choice, setChoice] = useState<'inherit' | DateStyle>(() => (value ? (value.date ?? 'dash') : inherited ? 'inherit' : 'dash'))
  const [draft, setDraft] = useState<DateFormat>(() => value ?? inherited?.format ?? {})
  const patch = (next: Partial<DateFormat>) => setDraft((current) => ({ ...current, ...next }))

  // What is saved: nothing for the dataset's format or, on a dataset, for the default writing.
  const result = (): DateFormat | undefined => {
    if (choice === 'inherit') return undefined
    const clean = cleanDateFormat({ ...draft, date: choice }, type)
    return inherited || Object.keys(clean).length ? clean : undefined
  }
  const shown = choice === 'inherit' ? inherited?.format : result()
  const week = draft.week ?? 'range'

  return (
    <Dialog
      open
      title={t('format.titleOf', { name })}
      width={520}
      onClose={onCancel}
      actions={
        <>
          <Button onClick={onCancel}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={() => onDone(result())}>
            {t('common.confirm')}
          </Button>
        </>
      }
    >
      <div className="format-dialog">
        <Segmented<'inherit' | DateStyle>
          aria-label={t('format.date.style')}
          value={choice}
          options={[...(inherited ? ['inherit' as const] : []), ...dateStyles].map((option) => ({
            value: option,
            label: option === 'inherit' ? t('format.inherit') : t(`format.date.styles.${option}`),
          }))}
          onChange={setChoice}
        />
        <DatePreview format={shown} type={type} />
        <p className="format-note">{choice === 'inherit' ? t(inherited?.format ? 'format.inheritHint' : 'format.date.inheritDefault') : t('format.date.grainHint')}</p>
        {choice !== 'inherit' && (
          <div className="format-form">
            <Field label={t('format.date.week')} htmlFor="format-week" hint={week === 'number' ? t('format.date.weekNumberHint') : undefined}>
              <Select<WeekStyle>
                id="format-week"
                block
                value={week}
                options={weekStyles.map((option) => ({ value: option, label: t(`format.date.weeks.${option}`) }))}
                onChange={(next) => patch({ week: next })}
              />
            </Field>
            {type === 'timestamp' && (
              <Field label={t('format.date.time')} htmlFor="format-time">
                <Select<TimeStyle>
                  id="format-time"
                  block
                  value={draft.time ?? 'second'}
                  options={timeStyles.map((option) => ({ value: option, label: t(`format.date.times.${option}`) }))}
                  onChange={(next) => patch({ time: next })}
                />
              </Field>
            )}
          </div>
        )}
      </div>
    </Dialog>
  )
}
