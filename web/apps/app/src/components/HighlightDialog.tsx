import { formatNumber, highlightIcons, highlightOps, hueColor, hues, maxHighlights, type ChartColorScheme, type Highlight, type HighlightIcon, type HighlightOp, type Hue, type NumberFormat } from '@supabi/charts'
import { Button, Dialog, Input, Select, Tooltip } from '@supabi/ui'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from './Icon'
import './highlight.css'

/** A rule as it is being written: its number as typed, and what keeps it apart while the rules move. */
interface Draft {
  id: number
  op: HighlightOp
  value: string
  color: Hue
  icon?: HighlightIcon
}

const glyphs: Record<HighlightIcon, string> = { up: '▲', down: '▼', dot: '●' }
/** The colours new rules take in turn: bad, middling, good, then others. */
const newColors: Hue[] = ['red', 'yellow', 'green', 'blue', 'violet']

/** The number typed, or null when there is none. */
const numberOf = (text: string) => (text.trim() !== '' && Number.isFinite(Number(text)) ? Number(text) : null)

/**
 * Sets the rules of a column's conditional format, one to a line: the first
 * a value meets shades its cell. See .agents/design/chart-dashboard.md §2.8.
 */
export function HighlightDialog({ name, value, format, scheme, onDone, onCancel }: {
  name: string
  value: Highlight[] | undefined
  /** How the column's numbers are written, to show what a threshold is shown as. */
  format: NumberFormat | undefined
  scheme: ChartColorScheme
  onDone: (rules: Highlight[] | undefined) => void
  onCancel: () => void
}) {
  const { t, i18n } = useTranslation()
  const ids = useRef(0)
  const [rules, setRules] = useState<Draft[]>(() => (value ?? []).map((rule) => ({ ...rule, id: ids.current++, value: String(rule.value) })))
  const patch = (id: number, next: Partial<Draft>) => setRules((current) => current.map((rule) => (rule.id === id ? { ...rule, ...next } : rule)))
  const moveUp = (at: number) => setRules((current) => [...current.slice(0, at - 1), current[at]!, current[at - 1]!, ...current.slice(at + 1)])
  const add = () => setRules((current) => [...current, { id: ids.current++, op: 'lt', value: '', color: newColors.find((hue) => !current.some((rule) => rule.color === hue)) ?? 'blue' }])
  const invalid = rules.some((rule) => numberOf(rule.value) === null)
  const done = () => onDone(rules.length ? rules.map(({ op, value, color, icon }) => ({ op, value: numberOf(value)!, color, ...(icon ? { icon } : {}) })) : undefined)

  return (
    <Dialog
      open
      title={t('highlight.titleOf', { name })}
      width={680}
      onClose={onCancel}
      actions={
        <>
          <Button onClick={onCancel}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={invalid} onClick={done}>{t('common.confirm')}</Button>
        </>
      }
    >
      <div className="highlight-dialog">
        <p className="highlight-hint">{t('highlight.hint')}</p>
        {rules.length ? (
          <ol className="highlight-rules">
            {rules.map((rule, at) => {
              const number = numberOf(rule.value)
              return (
                <li key={rule.id} className="highlight-rule" aria-label={t('highlight.rule', { n: at + 1 })}>
                  <Select<HighlightOp> block aria-label={t('highlight.op')} value={rule.op} options={highlightOps.map((op) => ({ value: op, label: t(`filter.ops.${op}`) }))} onChange={(op) => patch(rule.id, { op })} />
                  <Input aria-label={t('highlight.value')} type="number" value={rule.value} invalid={rule.value !== '' && number === null} onChange={(value) => patch(rule.id, { value })} />
                  {/* What the threshold is written as in the column, so 80% is not typed as 80. */}
                  <span className="highlight-shown">{number === null ? '' : t('highlight.shown', { value: formatNumber(number, format, i18n.language) })}</span>
                  <Select<Hue>
                    block
                    aria-label={t('highlight.color')}
                    value={rule.color}
                    options={hues.map((hue) => ({ value: hue, label: t(`chartStyle.hues.${hue}`), icon: <span className="highlight-swatch" style={{ background: hueColor(hue, scheme) }} /> }))}
                    onChange={(color) => patch(rule.id, { color })}
                  />
                  <Select<HighlightIcon | 'none'>
                    block
                    aria-label={t('highlight.icon')}
                    value={rule.icon ?? 'none'}
                    options={(['none', ...highlightIcons] as const).map((icon) => ({ value: icon, label: t(`highlight.icons.${icon}`), ...(icon === 'none' ? {} : { icon: <span aria-hidden="true">{glyphs[icon]}</span> }) }))}
                    onChange={(icon) => patch(rule.id, { icon: icon === 'none' ? undefined : icon })}
                  />
                  <Tooltip title={t('highlight.moveUp')}>
                    <Button variant="ghost" size="sm" icon={<Icon name="sortAsc" size={14} />} aria-label={t('highlight.moveUp')} disabled={at === 0} onClick={() => moveUp(at)} />
                  </Tooltip>
                  <Tooltip title={t('highlight.remove')}>
                    <Button variant="ghost" size="sm" icon={<Icon name="trash" size={14} />} aria-label={t('highlight.remove')} onClick={() => setRules((current) => current.filter((other) => other.id !== rule.id))} />
                  </Tooltip>
                </li>
              )
            })}
          </ol>
        ) : (
          <p className="highlight-empty">{t('highlight.empty')}</p>
        )}
        <div className="highlight-add">
          <Button size="sm" icon={<Icon name="plus" size={14} />} disabled={rules.length >= maxHighlights} onClick={add}>{t('highlight.add')}</Button>
          {rules.length >= maxHighlights && <span className="highlight-hint">{t('highlight.limit', { count: maxHighlights })}</span>}
        </div>
        <p className="highlight-hint">{t('highlight.colorHint')}</p>
      </div>
    </Dialog>
  )
}
