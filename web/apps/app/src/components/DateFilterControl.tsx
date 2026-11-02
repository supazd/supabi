import { Button, Popover } from '@supabi/ui'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { describeTime, isEmpty, type TimeValue } from '../lib/filters'
import { DateFilterEditor } from './DateFilterEditor'
import type { FilterControlProps } from './FilterControl'
import { Icon } from './Icon'

/** One compact field; its panel is the date editor, applied when confirmed. */
export function DateFilterControl({ value, onChange, label, id, size, disabled, onValidityChange }: FilterControlProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<TimeValue>((value ?? {}) as TimeValue)
  const [valid, setValid] = useState(true)
  // Each opening starts the editor afresh from the value, leaving nothing of a cancelled one.
  const [opening, setOpening] = useState(0)
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  const changeOpen = (next: boolean) => {
    if (disabled) return
    if (next) { setDraft((value ?? {}) as TimeValue); setValid(true); setOpening((count) => count + 1) }
    setOpen(next)
  }
  useEffect(() => { onValidityChange?.(!open || valid) }, [open, valid, onValidityChange])
  const caption = describeTime(value, t)
  const empty = isEmpty('time', value)
  return <Popover open={open && !disabled} onOpenChange={changeOpen} width={560} content={<div className="date-filter-panel">
    <div className="date-filter-content">
      <DateFilterEditor key={opening} value={draft} label={label} onChange={setDraft} onValidityChange={setValid} />
    </div>
    <div className="date-filter-actions">
      <Button size="sm" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
      <Button size="sm" variant="primary" disabled={!valid} onClick={() => { onChange(draft); setOpen(false) }}>{t('common.confirm')}</Button>
    </div>
  </div>}>
    <button id={id} type="button" disabled={disabled} className={`date-filter-trigger ${size === 'sm' ? 'small' : ''}`} aria-label={`${label} · ${caption}`} title={caption} aria-expanded={open && !disabled}><span className={empty ? 'placeholder' : undefined}>{caption}</span><Icon name="calendar" size={14} /></button>
  </Popover>
}
