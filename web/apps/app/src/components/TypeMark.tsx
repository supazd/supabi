import { Tooltip } from '@supabi/ui'
import { useTranslation } from 'react-i18next'
import type { LogicalType } from '../api/client'
import { isNumeric, isTemporal } from '../api/spec'
import { Icon, type IconName } from './Icon'

/** What a value is, as far as its mark goes: a date and a moment are both times, drawn apart. */
export type MarkKind = 'text' | 'number' | 'boolean' | 'date' | 'time'

const icons: Record<MarkKind, IconName> = { text: 'text', number: 'number', boolean: 'toggle', date: 'calendar', time: 'clock' }
// A yes-or-no is coloured as text is, and a date as a time is.
const colours: Record<MarkKind, string> = { text: 'text', number: 'number', boolean: 'text', date: 'time', time: 'time' }

const mark = (kind: MarkKind) => (
  <span className={`type-mark ${colours[kind]}`} aria-hidden>
    <Icon name={icons[kind]} size={14} />
  </span>
)

/** The mark alone, for where what it stands for is said some other way. */
export const KindMark = ({ kind }: { kind: MarkKind }) => mark(kind)

const kindOfType = (type: LogicalType): MarkKind => (isNumeric(type) ? 'number' : type === 'boolean' ? 'boolean' : isTemporal(type) ? (type === 'date' ? 'date' : 'time') : 'text')

/** A small mark for a field's type, so a list of fields can be scanned at a glance. */
export function TypeMark({ type, named }: { type: LogicalType; /** The type's name is right beside the mark, so pointing at it need not say it again. */ named?: boolean }) {
  const { t } = useTranslation()
  return (
    <Tooltip title={named ? undefined : t(`dataset.types.${type}`)}>
      {mark(kindOfType(type))}
    </Tooltip>
  )
}
