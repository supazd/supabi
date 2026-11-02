import { Button, Checkbox, DateInput, DayCalendar, Input, MonthRangeCalendar, Radio, RangeCalendar, Segmented, Select, WeekRangeCalendar } from '@supabi/ui'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, ApiError, unwrap } from '../api/client'
import { useWeekStart } from '../auth/session'
import { daysIn, daysOf, describeTime, fromDays, grainPresets, grainUnits, hasInterval, isEmpty, monthAfter, shiftDay, timeGrains, timeModeOf, timePresets, timeUnits, type TimeBound, type TimeGrain, type TimeMode, type TimeUnit, type TimeValue } from '../lib/filters'

export type DateMode = 'dynamic' | 'fixed' | 'advanced' | 'special'

/** The way a time value was written: by a period, by days, by its two ends, or as missing dates. */
export const dateModeOf = (value: unknown): DateMode => {
  const time = (value ?? {}) as TimeValue
  return time.bounds ? 'advanced' : time.special ? 'special' : time.start || time.end ? 'fixed' : 'dynamic'
}

/** The ways a range can be written in each grain: ends set apart need days. */
const grainModes: Record<TimeGrain, DateMode[]> = { day: ['dynamic', 'fixed', 'advanced', 'special'], month: ['dynamic', 'fixed', 'special'], week: ['dynamic', 'fixed', 'special'] }

/** Whether "the last N" is written out rather than offered by name in a grain. */
const customIn = (time: TimeValue, grain: TimeGrain) => Boolean(time.last) && !(grainPresets[grain] as TimeMode[]).includes(timeModeOf(time))

/** Whether a period chosen from now can be said in a grain, by name or as "the last N". */
const fitsGrain = (time: TimeValue, grain: TimeGrain) => (grainPresets[grain] as TimeMode[]).includes(timeModeOf(time)) || Boolean(time.last && grainUnits[grain].includes(time.last.unit))

const isoWeekdays = [1, 2, 3, 4, 5, 6, 7] as const

const wholeNumber = (text: string) => /^\d+$/.test(text.trim()) ? Number(text) : Number.NaN
const isDay = (text: string) => /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`)) && new Date(`${text}T00:00:00Z`).toISOString().startsWith(text)

/** Dates as the server resolved them; 'invalid' when it found the range empty or reversed. */
type Resolved = { start?: string; end?: string } | 'invalid' | undefined

/**
 * The dates a time value keeps today, as the server resolves them: in the
 * workspace's time zone and with its first day of the week, which the browser
 * cannot know. Without an answer the value is said in words instead.
 */
function useResolved(value: TimeValue, asked: boolean): Resolved {
  const [resolved, setResolved] = useState<Resolved>()
  const key = JSON.stringify(value)
  useEffect(() => {
    setResolved(undefined)
    if (!asked) return
    let current = true
    const timer = setTimeout(() => {
      unwrap(api.POST('/time-ranges/resolve', { body: { range: value as Record<string, unknown> } })).then(
        (dates) => { if (current) setResolved(dates) },
        (error) => { if (current) setResolved(error instanceof ApiError && error.code === 'invalid_time_range' ? 'invalid' : undefined) },
      )
    }, 150)
    return () => { current = false; clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the value is compared by what it says
  }, [key, asked])
  return resolved
}

// A wall time as a day when it is midnight. The end of a range is not kept, so its day is the one before.
const shown = (at: string, end: boolean) => at.endsWith('T00:00:00') ? (end ? shiftDay(at, -1) : at.slice(0, 10)) : at.slice(0, 16).replace('T', ' ')

/** A day typed in, kept as typed until it is a day. */
function DayText({ value, onChange, label, onValidity }: { value?: string; onChange: (day?: string) => void; label: string; onValidity: (valid: boolean) => void }) {
  const [text, setText] = useState(value ?? '')
  useEffect(() => setText(value ?? ''), [value])
  const valid = !text || isDay(text)
  useEffect(() => onValidity(valid), [valid, onValidity])
  return <Input aria-label={label} placeholder="YYYY-MM-DD" value={text} invalid={!valid} onChange={(next) => { setText(next); if (!next) onChange(undefined); else if (isDay(next)) onChange(next) }} />
}

type BoundKind = 'unlimited' | 'fixed' | 'dynamic'

/**
 * One end of a range. Both ends are said as kept, as people read a range;
 * the value keeps its end one period on, where the range stops.
 */
function BoundRow({ edge, bound, onChange, onValidity }: { edge: 'start' | 'end'; bound?: TimeBound; onChange: (bound?: TimeBound) => void; onValidity: (valid: boolean) => void }) {
  const { t } = useTranslation()
  const label = t(edge === 'start' ? 'filter.time.startBound' : 'filter.time.endBound')
  const kind: BoundKind = bound?.fixed ? 'fixed' : bound?.relative ? 'dynamic' : 'unlimited'
  // The value's end lies one period beyond the last one kept.
  const beyond = edge === 'end' ? 1 : 0
  const offset = (bound?.relative?.n ?? beyond) - beyond
  const [count, setCount] = useState(String(Math.abs(offset)))
  useEffect(() => setCount((current) => wholeNumber(current) === Math.abs(offset) ? current : String(Math.abs(offset))), [offset])
  const n = wholeNumber(count)
  const valid = kind !== 'dynamic' || Number.isSafeInteger(n) && n <= 1000000
  useEffect(() => onValidity(valid), [valid, onValidity])
  const relative = (next: { n?: number; unit?: TimeUnit; ago?: boolean }) => {
    const size = next.n ?? Math.abs(offset)
    // Nothing ago is this period, said as the count back from it.
    const ago = next.ago ?? offset <= 0
    onChange({ relative: { n: (ago ? -size : size) + beyond, unit: next.unit ?? bound!.relative!.unit } })
  }
  const today = new Date().toLocaleDateString('en-CA')
  return <div className="date-bound-row" role="group" aria-label={label}>
    <span className="date-bound-label">{label}</span>
    <Select<BoundKind> value={kind} aria-label={label} options={(['fixed', 'dynamic', 'unlimited'] as const).map((key) => ({ value: key, label: t(`filter.time.bounds.${key}`) }))}
      onChange={(next) => onChange(next === 'unlimited' ? undefined : next === 'fixed' ? { fixed: shiftDay(today, beyond) } : { relative: { n: beyond, unit: 'day' } })} />
    {kind === 'fixed' && <DateInput aria-label={`${label} · ${t('filter.time.fixed')}`} value={shiftDay(bound!.fixed!, -beyond)} onChange={(day) => onChange(day ? { fixed: shiftDay(day, beyond) } : undefined)} />}
    {kind === 'dynamic' && <>
      <span className="date-bound-count"><Input aria-label={`${label} · ${t('filter.time.count')}`} value={count} invalid={!valid} onChange={(text) => { setCount(text); const next = wholeNumber(text); if (Number.isSafeInteger(next) && next <= 1000000) relative({ n: next }) }} /></span>
      <Select<TimeUnit> aria-label={`${label} · ${t('filter.time.unit')}`} value={bound!.relative!.unit} options={timeUnits.map((unit) => ({ value: unit, label: t(`filter.time.units.${unit}`) }))} onChange={(unit) => relative({ unit })} />
      <Select<'ago' | 'later'> aria-label={`${label} · ${t('filter.time.direction')}`} value={offset > 0 ? 'later' : 'ago'} options={(['ago', 'later'] as const).map((key) => ({ value: key, label: t(`filter.time.${key}`) }))} onChange={(direction) => relative({ ago: direction === 'ago' })} />
    </>}
  </div>
}

/**
 * Everything a date filter can say, laid open: a period by name or the last
 * few of a unit, a run of days, months or weeks, two ends each fixed, moving
 * or open, or missing dates. The dates it keeps today are shown above it as it
 * changes.
 */
export function DateFilterEditor({ value, onChange, label, single = false, onValidityChange }: {
  value: unknown
  onChange: (value: TimeValue) => void
  /** What the value is: the filter's value, or what viewers start from. */
  label: string
  /** One day, for a control that offers one. */
  single?: boolean
  onValidityChange?: (valid: boolean) => void
}) {
  const { t } = useTranslation()
  const time = (value ?? {}) as TimeValue
  const workspaceWeek = useWeekStart()
  const weekStart = time.weekStart ?? workspaceWeek
  const [grain, setGrain] = useState<TimeGrain>(single ? 'day' : time.grain ?? 'day')
  const [mode, setMode] = useState<DateMode>(single ? 'fixed' : dateModeOf(value))
  const [custom, setCustom] = useState(customIn(time, grain))
  // Kept while no dates are chosen, so that choosing them keeps empty dates too.
  const [includeNull, setIncludeNull] = useState(Boolean(time.includeNull))
  // Parts still being typed, which the value does not hold yet.
  const [typing, setTyping] = useState<Record<string, boolean>>({})
  const report = (part: string) => (valid: boolean) => setTyping((current) => current[part] === !valid ? current : { ...current, [part]: !valid })
  const [count, setCount] = useState(String(time.last?.n ?? 3))
  const lastCount = wholeNumber(count)
  const countValid = !custom || mode !== 'dynamic' || Number.isSafeInteger(lastCount) && lastCount >= 1

  const { start, end } = time.bounds ?? {}
  const unbounded = mode === 'advanced' && !start && !end
  const reversed = Boolean(time.start && time.end && time.start >= time.end
    || start?.fixed && end?.fixed && start.fixed >= end.fixed
    || start?.relative && end?.relative && start.relative.unit === end.relative.unit && start.relative.n >= end.relative.n)
  const typed = Object.entries(typing).some(([part, invalid]) => invalid && part.startsWith(mode))
  const empty = isEmpty('time', time)
  const resolved = useResolved(time, !empty && !time.special && !reversed && !typed && countValid)
  const valid = countValid && !typed && !unbounded && !reversed && resolved !== 'invalid'
  useEffect(() => { onValidityChange?.(valid) }, [valid, onValidityChange])

  /**
   * The value as chosen, with how it is chosen: the grain, the day its weeks
   * start on, and whether empty dates are kept, which say nothing alone.
   */
  const change = (next: TimeValue, how: { grain?: TimeGrain; includeNull?: boolean; weekStart?: number | null } = {}) => {
    const interval = { ...next }
    delete interval.grain
    delete interval.weekStart
    delete interval.includeNull
    const nextGrain = how.grain ?? grain
    const week = how.weekStart === undefined ? time.weekStart : how.weekStart ?? undefined
    const keepNull = (how.includeNull ?? includeNull) && hasInterval(interval) && !interval.special
    onChange({ ...interval, ...(nextGrain !== 'day' ? { grain: nextGrain } : {}), ...(nextGrain === 'week' && week ? { weekStart: week } : {}), ...(keepNull ? { includeNull: true } : {}) })
  }

  const switchTo = (next: DateMode) => {
    if (next === mode) return
    setMode(next)
    setCustom(false)
    // What was chosen carries over where it can be said the new way.
    const days = resolved && resolved !== 'invalid' && resolved.start?.endsWith('T00:00:00') && resolved.end?.endsWith('T00:00:00') ? [resolved.start.slice(0, 10), shown(resolved.end, true)] as const : undefined
    if (next === 'fixed') change(days ? fromDays(...daysIn(grain, [days[0], days[1]], weekStart)) : {})
    else if (next === 'advanced') change({ bounds: days ? { start: { fixed: days[0] }, end: { fixed: shiftDay(days[1], 1) } } : { start: { relative: { n: -6, unit: 'day' } }, end: { relative: { n: 1, unit: 'day' } } } })
    else change({})
  }

  // Changing the grain keeps what can be said in the new one: days become the whole months or weeks they fall in.
  const switchGrain = (next: TimeGrain) => {
    if (next === grain) return
    setGrain(next)
    if (mode === 'fixed') return change(fromDays(...daysIn(next, daysOf(time), weekStart)), { grain: next })
    if (mode === 'advanced' && !grainModes[next].includes('advanced')) {
      setMode('dynamic')
      setCustom(false)
      return change({}, { grain: next })
    }
    if (mode === 'dynamic') {
      const keeps = fitsGrain(time, next)
      setCustom(keeps && customIn(time, next))
      return change(keeps ? time : {}, { grain: next })
    }
    change(time, { grain: next })
  }

  // Fixed weeks move to the new weeks they fall in.
  const switchWeek = (next: number | null) => change(mode === 'fixed' && hasInterval(time) ? fromDays(...daysIn('week', daysOf(time), next ?? workspaceWeek)) : time, { weekStart: next })

  const dates = empty ? t('filter.time.all')
    : time.special ? t(`filter.time.${time.special}`)
    : resolved && resolved !== 'invalid' ? [resolved.start ? shown(resolved.start, false) : t('filter.time.unlimited'), resolved.end ? shown(resolved.end, true) : t('filter.time.unlimited')].filter((day, index, both) => index === 0 || day !== both[0]).join(' ~ ')
    : describeTime({ ...time, includeNull: false }, t)
  const preview = !empty && time.includeNull && !time.special ? t('filter.time.withNull', { range: dates }) : dates
  const presets = grainPresets[grain]
  const units = grainUnits[grain]
  const fallback = { n: grain === 'week' ? 4 : 3, unit: grain === 'week' ? 'week' : 'month' } as const
  const unit = time.last && units.includes(time.last.unit) ? time.last.unit : fallback.unit
  const weekSpan = (first: number) => t('filter.time.weekSpan', { first: t(`filter.time.weekdays.${first}`), last: t(`filter.time.weekdays.${first === 1 ? 7 : first - 1}`) })

  return <div className="date-editor">
    {!single && <div className="date-editor-head">
      <Select<TimeGrain> aria-label={t('filter.time.grain')} value={grain} options={timeGrains.map((key) => ({ value: key, label: t(`filter.time.grains.${key}`) }))} onChange={switchGrain} />
      <Segmented block value={mode} aria-label={t('filter.mode')} onChange={switchTo} options={grainModes[grain].map((key) => ({ value: key, label: t(`filter.time.${key}`) }))} />
    </div>}
    <div className="date-preview" aria-live="polite">
      <span className="note small">{label}</span>
      <strong className={empty ? 'placeholder' : undefined}>{preview}</strong>
      {!empty && <Button size="sm" variant="ghost" onClick={() => { setCustom(false); change({}) }}>{t('filter.time.clear')}</Button>}
    </div>
    {unbounded && <p className="note small danger" role="alert">{t('filter.time.bothUnbounded')}</p>}
    {(reversed || resolved === 'invalid') && <p className="note small danger" role="alert">{t('filter.time.reversed')}</p>}

    {single && <DayCalendar value={daysOf(time)[0]} onChange={(day) => change(day ? fromDays(day, day) : {})} />}

    {!single && mode === 'dynamic' && <>
      <div className="date-presets" role="radiogroup" aria-label={t('filter.time.dynamic')}>
        {presets.map((key) => <button key={key} type="button" role="radio" aria-checked={!custom && timeModeOf(time) === key} onClick={() => { setCustom(false); change(timePresets[key]) }}>{t(`filter.time.${key}`)}</button>)}
        <button type="button" role="radio" aria-checked={custom} onClick={() => { if (custom) return; setCustom(true); const last = time.last && units.includes(time.last.unit) ? time.last : fallback; setCount(String(last.n)); change({ last, ...(time.includeCurrent ? { includeCurrent: true } : {}) }) }}>{t('filter.time.custom')}</button>
      </div>
      {custom && <div className="date-custom">
        <span>{t('filter.time.last')}</span>
        <span className="date-bound-count"><Input aria-label={t('filter.time.count')} value={count} invalid={!countValid} onChange={(text) => { setCount(text); const n = wholeNumber(text); if (Number.isSafeInteger(n) && n >= 1) change({ ...time, last: { n, unit } }) }} /></span>
        <Select<TimeUnit> aria-label={t('filter.time.unit')} value={unit} disabled={units.length === 1} options={units.map((key) => ({ value: key, label: t(`filter.time.units.${key}`) }))} onChange={(next) => change({ ...time, last: { n: time.last?.n ?? fallback.n, unit: next } })} />
        <Checkbox checked={Boolean(time.includeCurrent)} onChange={(includeCurrent) => change({ last: time.last ?? { n: fallback.n, unit }, ...(includeCurrent ? { includeCurrent } : {}) })}>
          {t(unit === 'day' ? 'filter.time.includeToday' : 'filter.time.includeCurrent')}
        </Checkbox>
      </div>}
    </>}

    {!single && mode === 'fixed' && grain === 'day' && <>
      <div className="date-fixed-days">
        <DayText label={t('filter.time.firstDay')} value={daysOf(time)[0]} onValidity={report('fixed.first')} onChange={(day) => change(fromDays(day, daysOf(time)[1]))} />
        <span aria-hidden="true">~</span>
        <DayText label={t('filter.time.lastDay')} value={daysOf(time)[1]} onValidity={report('fixed.last')} onChange={(day) => change(fromDays(daysOf(time)[0], day))} />
      </div>
      <RangeCalendar value={daysOf(time)} onChange={([first, last]) => change(fromDays(first, last))} />
    </>}
    {!single && mode === 'fixed' && grain === 'month' && <MonthRangeCalendar value={[daysOf(time)[0]?.slice(0, 7), daysOf(time)[1]?.slice(0, 7)]} onChange={([first, last]) => change(first && last ? { start: `${first}-01`, end: monthAfter(last) } : {})} />}
    {!single && mode === 'fixed' && grain === 'week' && <WeekRangeCalendar key={weekStart} value={daysOf(time)} weekStart={weekStart} onChange={([first, last]) => change(fromDays(first, last))} />}

    {!single && mode === 'advanced' && <div className="date-bounds">
      <BoundRow edge="start" bound={start} onValidity={report('advanced.start')} onChange={(bound) => change({ bounds: { ...time.bounds, start: bound } })} />
      <BoundRow edge="end" bound={end} onValidity={report('advanced.end')} onChange={(bound) => change({ bounds: { ...time.bounds, end: bound } })} />
    </div>}

    {!single && mode === 'special' && <div className="date-special" role="radiogroup" aria-label={t('filter.time.special')}>
      {(['is_null', 'not_null'] as const).map((key) => <Radio key={key} checked={time.special === key} onChange={() => change({ special: key })}>{t(`filter.time.${key}`)}</Radio>)}
    </div>}

    {!single && mode !== 'special' && <div className="date-options">
      {grain === 'week' && <div className="date-week-logic">
        <span className="note small">{t('filter.time.weekLogic')}</span>
        <Select<number> aria-label={t('filter.time.weekLogic')} value={time.weekStart ?? 0} options={[{ value: 0, label: t('filter.time.weekFollows', { week: weekSpan(workspaceWeek) }) }, ...isoWeekdays.map((day) => ({ value: day, label: weekSpan(day) }))]} onChange={(day) => switchWeek(day || null)} />
      </div>}
      <Checkbox checked={includeNull} onChange={(next) => { setIncludeNull(next); change(time, { includeNull: next }) }}>{t('filter.time.includeNull')}</Checkbox>
    </div>}
  </div>
}
