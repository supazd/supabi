import { DateInput, Input, MultiSelect } from '@supabi/ui'
import { DateFilterControl } from './DateFilterControl'
import './filters.css'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { daysOf, fromDays, negatedOps, opText, type FilterControl as Control, type FilterOp, rangeOf } from '../lib/filters'

export interface FilterOptions {
  values: unknown[]
  /** True when the field has more values than are listed. */
  truncated: boolean
}

/**
 * Looks up the values a filter offers, narrowed to those containing `search` when it is not empty.
 * `signal` is aborted once a newer search replaces this one or the control goes away.
 */
export type LoadOptions = (search: string, signal?: AbortSignal) => Promise<FilterOptions>

export interface FilterControlProps {
  control: Control
  value: unknown
  onChange: (value: unknown) => void
  /** Where a select gets its choices. Without it, only what is already chosen is shown. */
  loadOptions?: LoadOptions
  label: string
  id?: string
  size?: 'sm' | 'md'
  disabled?: boolean
  /** Manual query controls need the latest typed value immediately. Defaults to true. */
  debounce?: boolean
  /** Refresh choices whenever upstream filter context changes. */
  optionsKey?: string
  onValidityChange?: (valid: boolean) => void
}

const pause = 350

/**
 * Holds what is being typed and passes it on once the typing pauses, so a
 * chart is not queried again for every key.
 */
export function useDraft<T>(value: T, commit: (value: T) => void, disabled = false, debounce = true, sameValue: (left: T, right: T) => boolean = Object.is): [T, (value: T) => void] {
  const [draft, setDraft] = useState(value)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const pending = useRef<(() => void) | undefined>(undefined)
  const flush = useCallback(() => {
    clearTimeout(timer.current)
    const commitPending = pending.current
    pending.current = undefined
    commitPending?.()
  }, [])
  const key = JSON.stringify(value)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- a value that says the same is the same value
  useEffect(() => setDraft((current) => !disabled && sameValue(current, value) ? current : value), [key, disabled])
  useEffect(() => {
    const cancel = () => { clearTimeout(timer.current); pending.current = undefined }
    if (disabled) cancel()
    return cancel
  }, [disabled, key])
  useEffect(() => { if (!debounce && !disabled) flush() }, [debounce, disabled, flush])
  return [
    draft,
    (next) => {
      if (disabled) return
      setDraft(next)
      clearTimeout(timer.current)
      pending.current = () => commit(next)
      if (debounce) timer.current = setTimeout(flush, pause)
      else flush()
    },
  ]
}

// Values go back to the server exactly as they came, whatever their type, so
// a choice is known by its JSON rather than by its text.
const keyOf = (value: unknown) => JSON.stringify(value)

/** The most values shown as tiles. */
export const tilesLimit = 30

/** What a control is called, saying so when it leaves out what is chosen. */
export function filterCaption(label: string, op: FilterOp, t: TFunction): string {
  return negatedOps.has(op) ? `${label} · ${opText(op, t)}` : label
}

/** A control's label, with a mark for conditions that leave out what is chosen. */
export function FilterLabel({ label, op }: { label: string; op: FilterOp }) {
  const { t } = useTranslation()
  return <>{label}{negatedOps.has(op) && <span className="filter-op-tag">{opText(op, t)}</span>}</>
}

function SelectControl({ control, value, onChange, loadOptions, label, id, size, disabled, optionsKey }: FilterControlProps) {
  const { t } = useTranslation()
  const chosen = Array.isArray(value) ? value : []
  const remote = control.type === 'search_select'
  const [asked, setAsked] = useState('')
  const [options, setOptions] = useState<FilterOptions>({ values: [], truncated: false })
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  useEffect(() => {
    if (!loadOptions || disabled) { setLoading(false); return }
    let current = true
    const controller = new AbortController()
    setLoading(true)
    setFailed(false)
    // The previous list stays in sight while the next one loads, so nothing jumps.
    loadOptions(asked, controller.signal).then(
      (loaded) => current && (setOptions(loaded), setLoading(false)),
      // A filter is still usable without its list: what is chosen stays chosen.
      () => current && (setLoading(false), setFailed(true)),
    )
    return () => {
      current = false
      controller.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadOptions is made anew on every render
  }, [asked, Boolean(loadOptions), disabled, optionsKey])

  // What is chosen is always among the choices, even when the list no longer has it.
  const listed = new Map<string, unknown>()
  for (const item of [...chosen, ...options.values]) listed.set(keyOf(item), item)
  const placeholder = remote ? t('filter.searchToChoose') : options.truncated ? t('filter.moreOptions', { count: options.values.length }) : t('filter.any')
  // Tiles are for a few values; a long list falls back to the dropdown rather than burying the chart.
  if (control.type === 'tiles' && !options.truncated && listed.size <= tilesLimit) return <div className="filter-tiles" role="group" aria-label={label} aria-busy={loading}>
    <button type="button" disabled={disabled} className={!chosen.length ? 'selected' : ''} onClick={() => onChange([])}>{t('filter.any')}</button>
    {[...listed].map(([key, item]) => <button key={key} type="button" disabled={disabled} aria-pressed={chosen.some((value) => keyOf(value) === key)} className={chosen.some((value) => keyOf(value) === key) ? 'selected' : ''}
      onClick={() => onChange(control.multi ? chosen.some((value) => keyOf(value) === key) ? chosen.filter((value) => keyOf(value) !== key) : [...chosen, item] : [item])}>{String(item)}</button>)}
    {failed && <span className="note small" role="alert">{t('filter.optionsFailed')}</span>}
  </div>
  return (
    <span className="filter-select-control" title={failed ? t('filter.optionsFailed') : undefined}>
    <MultiSelect<string>
      id={id}
      disabled={disabled}
      size={size}
      aria-label={label}
      placeholder={placeholder}
      loading={loading}
      value={chosen.map(keyOf)}
      options={[...listed].map(([key, item]) => ({ value: key, label: String(item) }))}
      onChange={(keys) => {
        const next = keys.map((key) => listed.get(key))
        // A single choice is replaced by the next one picked.
        onChange(control.multi ? next : next.slice(-1))
      }}
      onSearch={
        remote
          ? (text) => {
              clearTimeout(timer.current)
              timer.current = setTimeout(() => setAsked(text), pause)
            }
          : undefined
      }
    />
    </span>
  )
}

function TextControl({ value, onChange, label, id, size, disabled, debounce }: FilterControlProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = useDraft(typeof value === 'string' ? value : '', onChange, disabled, debounce)
  return <Input disabled={disabled} id={id} size={size} aria-label={label} placeholder={t('filter.any')} value={draft} onChange={setDraft} />
}

const toText = (side: unknown) => (side === null || side === undefined ? '' : String(side))
const invalidNumber = (text: string) => text.trim() !== '' && !Number.isFinite(Number(text))
const toNumber = (text: string) => (text.trim() === '' || !Number.isFinite(Number(text)) ? null : Number(text))
// Preserve in-progress formatting such as "-0." when the parent echoes numeric 0.
const sameNumberText = (left: string, right: string) => !invalidNumber(left) && !invalidNumber(right) && toNumber(left) === toNumber(right)
const sameRangeText = (left: [string, string], right: [string, string]) => left.every((side, index) => sameNumberText(side, right[index]!))

function NumberControl({ value, onChange, label, id, size, disabled, debounce, onValidityChange }: FilterControlProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = useDraft(toText(value), (text) => { if (debounce !== false || !invalidNumber(text)) onChange(toNumber(text)) }, disabled, debounce, sameNumberText)
  const valid = !invalidNumber(draft)
  useEffect(() => { onValidityChange?.(valid) }, [valid, onValidityChange])
  return <Input disabled={disabled} id={id} size={size} aria-label={label} placeholder={t('filter.any')} invalid={!valid} value={draft} onChange={setDraft} />
}

function NumberRangeControl({ value, onChange, label, id, size, disabled, debounce, onValidityChange }: FilterControlProps) {
  const { t } = useTranslation()
  const range = rangeOf(value)
  const sides = [range.min, range.max]
  const [draft, setDraft] = useDraft<[string, string]>([toText(sides[0]), toText(sides[1])], ([low, high]) => {
    if (!invalidNumber(low) && !invalidNumber(high) && (toNumber(low) === null || toNumber(high) === null || toNumber(low)! <= toNumber(high)!)) onChange(Array.isArray(value) || value == null ? [toNumber(low), toNumber(high)] : { ...range, min: toNumber(low), max: toNumber(high) })
  }, disabled, debounce, sameRangeText)
  const reversed = !invalidNumber(draft[0]) && !invalidNumber(draft[1]) && toNumber(draft[0]) !== null && toNumber(draft[1]) !== null && toNumber(draft[0])! > toNumber(draft[1])!
  const valid = !reversed && !draft.some(invalidNumber)
  useEffect(() => { onValidityChange?.(valid) }, [valid, onValidityChange])
  return (
    <span className="filter-range">
      <Input disabled={disabled} id={id} size={size} aria-label={`${label} · ${t('filter.min')}`} placeholder={t('filter.min')} invalid={reversed || invalidNumber(draft[0])} value={draft[0]} onChange={(low) => setDraft([low, draft[1]])} />
      <span className="muted-inline">–</span>
      <Input disabled={disabled} size={size} aria-label={`${label} · ${t('filter.max')}`} placeholder={t('filter.max')} invalid={reversed || invalidNumber(draft[1])} value={draft[1]} onChange={(high) => setDraft([draft[0], high])} />
    </span>
  )
}

/** The control a filter's value is chosen with. */
export function FilterControl(props: FilterControlProps) {
  const { control, value, onChange, label, id, size, disabled } = props
  switch (control.type) {
    case 'select':
    case 'search_select':
    case 'tiles':
      return <SelectControl {...props} />
    case 'text':
      return <TextControl {...props} />
    case 'number':
      return <NumberControl {...props} />
    case 'number_range':
      return <NumberRangeControl {...props} />
    case 'date': {
      const [first] = daysOf(value)
      return <DateInput disabled={disabled} id={id} size={size} aria-label={label} value={first} onChange={(day) => onChange(fromDays(day, day))} />
    }
    // A calendar of two days was offered before the date range panel; it opens the panel now.
    case 'date_range':
    case 'relative':
      return <DateFilterControl {...props} />
  }
}
