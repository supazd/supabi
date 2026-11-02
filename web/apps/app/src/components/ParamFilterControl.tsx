import { DateInput, Input, MultiSelect } from '@supabi/ui'
import { useTranslation } from 'react-i18next'
import type { ParamControl } from '../api/client'
import { isRelative, paramItems, paramValueLabel, paramValueText, parseParamText, relativeDayValue, type ParamControlType } from '../lib/paramFilters'
import { useWorkspaceTimezone } from '../auth/session'
import { useDraft } from './FilterControl'
import './filters.css'

export interface ParamFilterControlProps {
  kind: ParamControlType
  /** What the dataset says of the parameter, as the server or the editor works it out. */
  info: ParamControl
  value: unknown
  /** Called with null or an empty list for no value, which a parameter the SQL cannot do without never gets. */
  onChange: (value: unknown) => void
  label: string
  id?: string
  size?: 'sm' | 'md'
  disabled?: boolean
  /** Manual query controls need the latest typed value immediately. Defaults to true. */
  debounce?: boolean
}

const keyOf = (value: unknown) => JSON.stringify(value)

/**
 * The control of a filter giving a dataset parameter its value: a dropdown
 * of the values the author offers, or a box to type one in, as the
 * parameter's type wants it (.agents/design/chart-dashboard.md 2.11).
 */
export function ParamFilterControl(props: ParamFilterControlProps) {
  return props.kind === 'select' ? <ParamSelect {...props} /> : <ParamInput {...props} />
}

function ParamSelect({ info, value, onChange, label, id, size, disabled }: ParamFilterControlProps) {
  const { t } = useTranslation()
  const zone = useWorkspaceTimezone()
  const listed = new Map<string, unknown>()
  // What is chosen is among the choices, even after the author takes it off the list.
  for (const item of [...paramItems(value), ...(info.options ?? [])]) listed.set(keyOf(item), item)
  return (
    <span className="filter-select-control">
      <MultiSelect<string>
        id={id}
        disabled={disabled}
        size={size}
        aria-label={label}
        placeholder={info.needsValue ? undefined : t('filter.any')}
        required={info.needsValue}
        value={paramItems(value).map(keyOf)}
        options={[...listed].map(([key, item]) => ({ value: key, label: paramValueLabel(item, t, zone) }))}
        onChange={(keys) => {
          // A single choice is replaced by the next one picked.
          const next = (info.multi ? keys : keys.slice(-1)).map((key) => listed.get(key))
          if (!next.length && info.needsValue) return
          onChange(info.multi ? next : (next[0] ?? null))
        }}
      />
    </span>
  )
}

function ParamInput({ info, value, onChange, label, id, size, disabled, debounce }: ParamFilterControlProps) {
  const { t } = useTranslation()
  const zone = useWorkspaceTimezone()
  const param = { type: info.type, multi: info.multi }
  // Typed in, a day is a day: one relative to today can only be the default, shown as the day it is.
  const text = paramItems(value).map((item) => (isRelative(item) ? (relativeDayValue(item.relative, zone) ?? item.relative) : paramValueText(item))).join(', ')
  const read = (typed: string) => parseParamText(typed, param, false)
  const missing = (typed: string) => info.needsValue && !paramItems(read(typed)).length
  const [draft, setDraft] = useDraft(text, (typed) => {
    // What cannot be the value yet is kept in the box, marked, until it can.
    const parsed = read(typed)
    if (parsed !== undefined && !missing(typed)) onChange(parsed)
  }, disabled, debounce)
  const invalid = read(draft) === undefined || missing(draft)
  const placeholder = info.needsValue ? t('params.filter.required') : t('filter.any')
  if (info.type === 'date' && !info.multi) {
    return <DateInput disabled={disabled} id={id} size={size} aria-label={label} placeholder={placeholder} value={text || undefined} clearable={!info.needsValue}
      onChange={(day) => { if (day || !info.needsValue) onChange(day ?? null) }} />
  }
  return <Input disabled={disabled} id={id} size={size} aria-label={label} placeholder={info.multi ? t('params.filter.severalPlaceholder') : placeholder} invalid={invalid} value={draft} onChange={setDraft} />
}
