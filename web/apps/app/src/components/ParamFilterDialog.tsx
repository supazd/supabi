import { Button, Checkbox, Dialog, Field, Input, Radio, Segmented, Tooltip } from '@supabi/ui'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SqlParam } from '../lib/params'
import { maxParamOptions, ownsDefault, paramDefault, paramItems, paramOptions, paramValueLabel, paramValueSummary, paramValueText, parseParamText, type ParamControlType, type ParamFilter } from '../lib/paramFilters'
import { Icon } from './Icon'
import './filters.css'
import { TypeMark } from './TypeMark'
import { useWorkspaceTimezone } from '../auth/session'

const keyOf = (value: unknown) => JSON.stringify(value)
const textOf = (value: unknown) => paramItems(value).map(paramValueText).join(', ')

/** An option of a dropdown as it is being typed, and whether it is among the defaults. */
interface Row {
  id: number
  text: string
  chosen: boolean
}

/**
 * The settings of a filter giving a dataset parameter its value: fixed, or
 * shown for viewers to type in or pick from options the author lists, and
 * the value it starts with, the dataset's unless the chart says otherwise
 * (.agents/design/chart-dashboard.md 2.11).
 */
export function ParamFilterDialog({ filter, param, needsValue, isNew, onDone, onCancel }: {
  filter: ParamFilter
  param: SqlParam
  /** The SQL cannot run without a value: the parameter is required, or used outside [[ ]]. */
  needsValue: boolean
  isNew: boolean
  onDone: (filter: ParamFilter) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const zone = useWorkspaceTimezone()
  const name = param.label || param.name
  const boolean = param.type === 'boolean'
  const multi = Boolean(param.multi)
  const [label, setLabel] = useState(filter.label ?? name)
  const [shown, setShown] = useState(Boolean(filter.control))
  const [kind, setKind] = useState<ParamControlType>(filter.control?.type ?? (boolean ? 'select' : 'input'))
  // Whether the filter sets its own default rather than following the dataset's. A fixed value is always its own.
  const [own, setOwn] = useState(ownsDefault(filter))
  const start = paramDefault(filter, param)
  const [text, setText] = useState(textOf(start))
  const ids = useRef(0)
  const row = (value: unknown, chosen: boolean): Row => ({ id: ++ids.current, text: paramValueText(value), chosen })
  const [rows, setRows] = useState<Row[]>(() => {
    const defaults = new Set(paramItems(start).map(keyOf))
    return paramOptions(filter, param).map((value) => row(value, defaults.has(keyOf(value))))
  })
  const [truth, setTruth] = useState<boolean | null>(() => (typeof start === 'boolean' ? start : null))

  const fixed = !shown
  const listed = shown && kind === 'select'
  const single = { type: param.type }
  const parsedRows = rows.filter((entry) => entry.text.trim()).map((entry) => ({ ...entry, value: parseParamText(entry.text, single) }))
  const badRow = (entry: Row) => entry.text.trim() !== '' && parseParamText(entry.text, single) === undefined
  const repeated = parsedRows.some((entry, i) => entry.value !== undefined && parsedRows.findIndex((other) => keyOf(other.value) === keyOf(entry.value)) !== i)
  // What the filter starts with, as the settings stand; undefined while something typed cannot be read.
  const ownValue: unknown = (() => {
    if (!listed) return parseParamText(text, param)
    if (boolean) return truth
    const chosen = parsedRows.filter((entry) => entry.chosen).map((entry) => entry.value)
    return multi ? chosen : (chosen[0] ?? null)
  })()
  const value = fixed || own ? ownValue : undefined
  const effective = fixed || own ? ownValue : param.default
  const problem = (() => {
    if (shown && !label.trim()) return 'needsLabel'
    if ((fixed || own) && ownValue === undefined) return 'invalid'
    if (listed && !boolean && (rows.some(badRow) || repeated)) return 'invalidOptions'
    if (listed && parsedRows.length > maxParamOptions) return 'tooManyOptions'
    if (fixed && !paramItems(ownValue).length) return 'needsValue'
    if (needsValue && !paramItems(effective).length) return 'needsDefault'
    return undefined
  })()

  const choose = (id: number) => {
    setOwn(true)
    setRows((current) => current.map((entry) => (multi ? (entry.id === id ? { ...entry, chosen: !entry.chosen } : entry) : { ...entry, chosen: entry.id === id })))
  }
  const follow = () => {
    setOwn(false)
    const defaults = paramItems(param.default)
    const keys = new Set(defaults.map(keyOf))
    setText(textOf(param.default))
    setTruth(typeof param.default === 'boolean' ? param.default : null)
    setRows((current) => {
      const present = new Set(current.map((entry) => keyOf(parseParamText(entry.text, single))))
      return [...defaults.filter((item) => !present.has(keyOf(item))).map((item) => row(item, true)), ...current.map((entry) => ({ ...entry, chosen: keys.has(keyOf(parseParamText(entry.text, single))) }))]
    })
  }
  const done = () => onDone({
    id: filter.id,
    param: filter.param,
    ...(value !== undefined ? { value } : {}),
    ...(shown ? { label: label.trim(), control: { type: kind }, ...(listed && !boolean ? { options: parsedRows.map((entry) => entry.value) } : {}) } : {}),
  })

  const placeholder = t(`params.filter.placeholders.${param.type}`)
  const defaultLine = shown && (
    <p className="note small param-default-line">
      {own ? <>
        {t('params.filter.ownDefault')}
        <Button size="sm" variant="ghost" onClick={follow}>{t('params.filter.follow')}</Button>
      </> : param.default === undefined || param.default === null ? t('params.filter.followingNone') : t('params.filter.following', { value: paramValueSummary(param.default, t, zone) })}
    </p>
  )
  return <Dialog open title={t(isNew ? 'params.filter.add' : 'params.filter.edit')} onClose={onCancel} width={560}
    actions={<><Button onClick={onCancel}>{t('common.cancel')}</Button><Button variant="primary" disabled={Boolean(problem)} onClick={done}>{t('common.confirm')}</Button></>}>
    <div className="filter-config-heading">
      <span className="filter-config-field"><TypeMark type={param.type} /><strong>{name}</strong></span>
      <span className="note small">{t('params.filter.about', { name: param.name })}</span>
    </div>
    <section className={`filter-config-section filter-config-display${shown ? ' on' : ''}`}>
      <div className="filter-config-toggle">
        <Checkbox checked={shown} onChange={(on) => { setShown(on); if (!on) setOwn(true) }}>{t('filter.interactive')}</Checkbox>
        <p className="note small">{t(shown ? 'filter.interactiveHint' : 'params.filter.fixedHint')}</p>
      </div>
      {shown && <div className="filter-pair">
        <Field label={t('filter.label')} required><Input aria-label={t('filter.label')} value={label} invalid={problem === 'needsLabel'} onChange={setLabel} /></Field>
        <Field label={t('filter.control')}>
          <Segmented block aria-label={t('filter.control')} value={kind} onChange={setKind}
            options={(['input', 'select'] as const).map((type) => ({ value: type, label: t(`params.filter.kinds.${type}`), disabled: type === 'input' && boolean }))} />
        </Field>
      </div>}
    </section>
    <section className="filter-config-section">
      {defaultLine}
      {!listed && <Field label={t(fixed ? 'filter.value' : 'filter.defaultValue')} hint={param.type === 'date' ? t('params.filter.relativeHint') : multi ? t('params.filter.severalHint') : undefined}>
        <Input aria-label={t(fixed ? 'filter.value' : 'filter.defaultValue')} value={text} placeholder={placeholder} invalid={problem === 'invalid'}
          onChange={(typed) => { setText(typed); setOwn(true) }} />
      </Field>}
      {listed && boolean && <div className="param-option-list" role="radiogroup" aria-label={t('filter.defaultValue')}>
        {[true, false].map((option) => <Radio key={String(option)} checked={truth === option} onChange={() => { setOwn(true); setTruth(option) }}>{paramValueLabel(option, t)}</Radio>)}
        {!needsValue && <Radio checked={truth === null} onChange={() => { setOwn(true); setTruth(null) }}>{t('filter.any')}</Radio>}
      </div>}
      {listed && !boolean && <>
        <p className="note small">{t(multi ? 'params.filter.optionsHintSeveral' : 'params.filter.optionsHint')}{param.type === 'date' ? ` ${t('params.filter.relativeHint')}` : ''}</p>
        <ul className="param-option-list">
          {rows.map((entry, i) => {
            const shownAs = parseParamText(entry.text, single)
            return <li key={entry.id} className="param-option-row">
              {multi
                ? <Checkbox checked={entry.chosen} aria-label={t('params.filter.isDefault', { value: entry.text })} onChange={() => choose(entry.id)} />
                : <Radio checked={entry.chosen} aria-label={t('params.filter.isDefault', { value: entry.text })} onChange={() => choose(entry.id)} />}
              <Input aria-label={t('params.filter.option', { n: i + 1 })} value={entry.text} placeholder={placeholder} invalid={badRow(entry)}
                onChange={(typed) => setRows((current) => current.map((other) => (other.id === entry.id ? { ...other, text: typed } : other)))} />
              <span className="note small param-option-shown">{shownAs !== undefined && shownAs !== null && typeof shownAs === 'object' ? paramValueLabel(shownAs, t, zone) : ''}</span>
              <span className="param-option-actions">
                <Tooltip title={t('params.filter.moveUp', { value: entry.text })}><button type="button" className="wb-icon-button param-move-up" aria-label={t('params.filter.moveUp', { value: entry.text })} disabled={i === 0}
                  onClick={() => setRows((current) => [...current.slice(0, i - 1), current[i]!, current[i - 1]!, ...current.slice(i + 1)])}><Icon name="chevronDown" size={14} /></button></Tooltip>
                <Tooltip title={t('params.filter.removeOption', { value: entry.text })}><button type="button" className="wb-icon-button" aria-label={t('params.filter.removeOption', { value: entry.text })}
                  onClick={() => { if (entry.chosen) setOwn(true); setRows((current) => current.filter((other) => other.id !== entry.id)) }}><Icon name="close" size={14} /></button></Tooltip>
              </span>
            </li>
          })}
          {!multi && !needsValue && <li className="param-option-row">
            <Radio checked={own && !rows.some((entry) => entry.chosen)} onChange={() => { setOwn(true); setRows((current) => current.map((entry) => ({ ...entry, chosen: false }))) }}>{t('filter.any')}</Radio>
          </li>}
        </ul>
        <div><Button size="sm" icon={<Icon name="plus" size={14} />} onClick={() => setRows((current) => [...current, row('', false)])}>{t('params.filter.addOption')}</Button></div>
      </>}
      {problem && problem !== 'needsLabel' && <p role="alert" className="note small danger">{t(`params.filter.problems.${problem}`, { max: maxParamOptions })}</p>}
    </section>
  </Dialog>
}
