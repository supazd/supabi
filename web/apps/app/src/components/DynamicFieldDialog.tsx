import { Button, Checkbox, Dialog, Field, Input, Select, Tooltip } from '@supabi/ui'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isTemporal, makeKey, type Aggregation, type SpecField } from '../api/spec'
import { aggChoices, grains, type Grain } from '../lib/builder'
import { dynamicLimits, validDynamics, type DynamicField, type DynamicOption } from '../lib/dynamics'
import { dynamicOptionLabel } from './DynamicControls'
import { aggOption } from './FormulaSymbol'
import { Icon } from './Icon'
import './dynamics.css'

export function DynamicFieldDialog({ dynamic, fields, onDone, onCancel }: {
  dynamic: DynamicField
  fields: SpecField[]
  onDone: (dynamic: DynamicField) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  // A label that only repeats the default name is not the author's own; it is shown as the default again.
  const [draft, setDraft] = useState(() => ({ ...dynamic, options: dynamic.options.map((option) => option.label && option.label === dynamicOptionLabel({ ...option, label: undefined }, fields, t) ? { ...option, label: undefined } : option) }))
  const available = fields.filter((field) => !field.hidden && (draft.kind === 'measure' || field.role === 'dimension'))
  const patch = (id: string, next: Partial<DynamicOption>) => setDraft((current) => ({ ...current, options: current.options.map((option) => option.id === id ? { ...option, ...next } : option) }))
  const move = (index: number, offset: number) => setDraft((current) => {
    const options = [...current.options]
    const target = index + offset
    if (target < 0 || target >= options.length) return current
    ;[options[index], options[target]] = [options[target]!, options[index]!]
    return { ...current, options }
  })
  const add = (key: string) => {
    if (draft.options.length >= dynamicLimits.options) return
    const field = available.find((field) => field.key === key)!
    const id = makeKey('option', new Set(draft.options.map((option) => option.id)))
    const option: DynamicOption = { id, field: key,
      ...(draft.kind === 'dimension' && isTemporal(field.type) ? { grain: 'month' as const } : {}),
      // A measure starts summed and a dimension counted; a metric aggregates by itself.
      ...(draft.kind === 'measure' && field.role !== 'metric' ? { agg: aggChoices(field)[0]! } : {}),
    }
    setDraft((current) => ({ ...current, options: [...current.options, option] }))
  }
  // Every choice is saved with its name: viewers of a dashboard cannot read the dataset to name it.
  const clean: DynamicField = { ...draft, label: draft.label.trim(), options: draft.options.map(({ label, ...option }) => ({ ...option, label: label?.trim() || dynamicOptionLabel(option, fields, t) })) }
  const valid = validDynamics([clean], fields)
  const problem = !clean.label ? 'needsLabel' : !clean.options.length ? 'needsOptions' : !valid ? 'invalid' : undefined
  return (
    <Dialog open title={t('dynamics.configure', { name: t(`dynamics.${dynamic.kind}`) })} width={740} onClose={onCancel}
      actions={<><Button onClick={onCancel}>{t('common.cancel')}</Button><Button variant="primary" disabled={Boolean(problem)} onClick={() => onDone(clean)}>{t('common.confirm')}</Button></>}>
      <div className="dynamic-dialog">
        <Field label={t('dynamics.label')} htmlFor="dynamic-label" required>
          <Input id="dynamic-label" invalid={!draft.label.trim()} value={draft.label} onChange={(label) => setDraft((current) => ({ ...current, label }))} />
        </Field>
        <div className="dynamic-choice-header"><strong>{t('dynamics.choices')}</strong><span className="note small">{t('dynamics.defaultHint')}</span></div>
        <div className="dynamic-choices">
          {draft.options.map((option, index) => {
            const field = fields.find((field) => field.key === option.field)!
            const name = dynamicOptionLabel(option, fields, t)
            const defaultName = dynamicOptionLabel({ ...option, label: undefined }, fields, t)
            const aggregates = field.role === 'metric' ? [] : aggChoices(field)
            return (
              <div key={option.id} className="dynamic-choice">
                <span className="dynamic-choice-index">{index + 1}</span>
                <div className="dynamic-choice-name">
                  <span className="note small" title={defaultName}>{defaultName}</span>
                  <Input size="sm" aria-label={`${t('dynamics.optionLabel')} ${index + 1}`} placeholder={t('dynamics.labelPlaceholder')} value={option.label ?? ''} onChange={(label) => patch(option.id, { label })} />
                </div>
                <div className="dynamic-choice-setting">
                  {draft.kind === 'dimension' && isTemporal(field.type) && <Select<Grain | ''> block size="sm" aria-label={`${t('dynamics.grain')} ${index + 1}`} value={option.grain ?? ''}
                    options={[{ value: '', label: t('dynamics.rawDate') }, ...grains.map((value) => ({ value, label: t(`explore.grains.${value}`) }))]}
                    onChange={(grain) => patch(option.id, { grain: grain || undefined })} />}
                  {draft.kind === 'measure' && aggregates.length > 0 && <Select<Aggregation> block size="sm" aria-label={`${t('dynamics.aggregation')} ${index + 1}`} value={option.agg ?? aggregates[0]}
                    options={aggregates.map((value) => aggOption(value, t))}
                    onChange={(agg) => patch(option.id, { agg })} />}
                </div>
                <div className="dynamic-choice-actions">
                  <Tooltip title={t('dynamics.moveUp', { name })}><button type="button" className="wb-icon-button dynamic-move-up" aria-label={t('dynamics.moveUp', { name })} disabled={index === 0} onClick={() => move(index, -1)}><Icon name="chevronDown" size={14} /></button></Tooltip>
                  <Tooltip title={t('dynamics.moveDown', { name })}><button type="button" className="wb-icon-button" aria-label={t('dynamics.moveDown', { name })} disabled={index === draft.options.length - 1} onClick={() => move(index, 1)}><Icon name="chevronDown" size={14} /></button></Tooltip>
                  <Tooltip title={t('dynamics.removeOption', { name })}><button type="button" className="wb-icon-button" aria-label={t('dynamics.removeOption', { name })} onClick={() => setDraft((current) => ({ ...current, options: current.options.filter((item) => item.id !== option.id) }))}><Icon name="close" size={14} /></button></Tooltip>
                </div>
              </div>
            )
          })}
        </div>
        {/* Remounted after each pick so it is empty again, ready for the next. */}
        <Select key={draft.options.length} block search disabled={draft.options.length >= dynamicLimits.options} aria-label={t('dynamics.addChoice')} placeholder={t('dynamics.addChoice')} value={undefined} options={available.map((field) => ({ value: field.key, label: field.label }))} onChange={add} />
        {draft.options.length >= dynamicLimits.options && <span className="note small">{t('dynamics.limitOptions', { count: dynamicLimits.options })}</span>}
        {problem && <p className="note small" role="status">{t(`dynamics.problems.${problem}`)}</p>}
        {draft.kind === 'dimension' && <Checkbox checked={Boolean(draft.allowEmpty)} onChange={(allowEmpty) => setDraft((current) => ({ ...current, allowEmpty }))}>{t('dynamics.allowEmpty')}</Checkbox>}
      </div>
    </Dialog>
  )
}
