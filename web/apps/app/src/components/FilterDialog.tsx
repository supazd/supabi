import { Button, Checkbox, Dialog, Field, Input, MultiSelect, Segmented, Select, TextArea } from '@supabi/ui'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { aggsFor, isNumeric, isTemporal, type Aggregation, type SpecField } from '../api/spec'
import { aggregateOps, asTimeFilter, canCascade, controlsFor, descendants, rangeOf, filterProblem, isSelect, opsFor, valueControl, withOp, type ChartFilter, type ControlType, type FilterOp } from '../lib/filters'
import { FilterControl, tilesLimit, type LoadOptions } from './FilterControl'
import { DateFilterEditor } from './DateFilterEditor'
import { aggOption, opOption } from './FormulaSymbol'
import { ExactFilterValues, parseFilterValues } from './ExactFilterValues'
import './filters.css'
import { TypeMark } from './TypeMark'


const serializeValues = (value: unknown) => Array.isArray(value) ? value.map((item) => typeof item === 'string' ? `"${item.replaceAll('"', '""')}"` : String(item)).join('\n') : ''

type Mode = 'exact' | 'conditional' | 'manual'

export function FilterDialog({ filter, field, isNew, loadOptions, onDone, onCancel, availableFilters = [], fields = [], allowAggregation = true }: {
  filter: ChartFilter; field: SpecField; isNew: boolean; loadOptions: LoadOptions; onDone: (filter: ChartFilter) => void; onCancel: () => void; availableFilters?: ChartFilter[]; fields?: SpecField[]; allowAggregation?: boolean
}) {
  const { t } = useTranslation()
  // A date is filtered with the date editor alone; filters saved before it are read its way.
  const dated = isTemporal(field.type) && field.role !== 'metric'
  const [draft, setDraft] = useState(() => (dated ? asTimeFilter(filter) : filter))
  const [mode, setMode] = useState<Mode>(['in', 'not_in'].includes(filter.op) ? 'exact' : 'conditional')
  const [manual, setManual] = useState(serializeValues(filter.value))
  const [manualInvalid, setManualInvalid] = useState(false)
  const [valueValid, setValueValid] = useState(true)
  const set = (patch: Partial<ChartFilter>) => setDraft((current) => ({ ...current, ...patch }))
  const aggregated = field.role === 'metric' || Boolean(draft.aggregation)
  const ops = aggregated ? aggregateOps(field.type) : opsFor(field.type)
  const modes: Mode[] = ops.includes('in') ? ['exact', 'conditional', 'manual'] : ['conditional']
  const controls = controlsFor(draft.op, field.type)
  const control = valueControl(draft, field.type)
  const problem = filterProblem(draft)
  const invalidSingle = isSelect(draft.control) && !draft.control?.multi && Array.isArray(draft.value) && draft.value.length > 1
  const range = rangeOf(draft.value)
  const invalidRange = (draft.op === 'between' || draft.op === 'not_between') && range.min != null && range.max != null && range.min > range.max
  const excludedParents = new Set([draft.id, ...descendants(availableFilters, draft.id)])
  const parents = availableFilters.filter((candidate) => !excludedParents.has(candidate.id) && canCascade(candidate) && fields.find((entry) => entry.key === candidate.field)?.role !== 'metric')
  const changeOp = (op: FilterOp) => { setValueValid(true); setDraft((current) => { const next = withOp(current, op, field.type); return { ...next, ...(op !== 'in' ? { dependsOn: undefined } : {}) } }) }
  const changeMode = (next: Mode) => {
    if (next === mode) return
    setMode(next)
    setValueValid(true)
    const op = next === 'conditional' ? ops.find((entry) => entry !== 'in' && entry !== 'not_in')! : draft.op === 'not_in' ? 'not_in' : 'in'
    setDraft((current) => withOp(current, op, field.type))
    if (next === 'manual') setManual(serializeValues(draft.value))
    setManualInvalid(false)
  }
  const readManual = (text: string) => { setManual(text); const parsed = parseFilterValues(text, field.type); setManualInvalid(parsed.invalid); if (!parsed.invalid) set({ value: parsed.values }) }
  const changeScope = (scope: 'detail' | 'result') => {
    const aggregation = scope === 'result' ? 'sum' as const : undefined
    set({ aggregation, op: 'between', value: undefined, dependsOn: undefined, ...(draft.control ? { control: { type: 'number_range' } } : {}) })
    setMode('conditional')
  }
  const valueLabel = t(draft.control ? 'filter.defaultValue' : 'filter.value')
  const opSelect = <Select<FilterOp> block value={draft.op} aria-label={t('filter.condition')} options={ops.filter((op) => op !== 'in' && op !== 'not_in').map((op) => opOption(op, t))} onChange={changeOp} />
  const excluded = draft.op === 'not_in'
  const excludeBox = <Checkbox checked={excluded} onChange={(on) => changeOp(on ? 'not_in' : 'in')}>{t('filter.exclude')}</Checkbox>
  return <Dialog open title={t(isNew ? 'filter.add' : 'filter.edit')} onClose={onCancel} width={600}
    actions={<><Button onClick={onCancel}>{t('common.cancel')}</Button><Button variant="primary" disabled={Boolean(problem) || invalidSingle || !valueValid || invalidRange || mode === 'manual' && manualInvalid}
      onClick={() => onDone({ ...draft, ...(!canCascade(draft) || aggregated ? { dependsOn: undefined } : {}) })}>{t('common.confirm')}</Button></>}>
    <div className="filter-config-heading">
      <span className="filter-config-field"><TypeMark type={field.type} /><strong>{field.label}</strong></span>
      {field.role === 'measure' && isNumeric(field.type)
        ? <span className="filter-scope">
          <Segmented value={aggregated ? 'result' : 'detail'} aria-label={t('filter.scope')} onChange={changeScope}
            options={(['detail', 'result'] as const).map((scope) => ({ value: scope, label: t(`filter.${scope}`), disabled: scope === 'result' && !allowAggregation }))} />
        </span>
        : <span className="note small">{t(aggregated ? 'filter.result' : 'filter.detail')}</span>}
    </div>
    {field.role === 'measure' && isNumeric(field.type) && <p className="note small filter-scope-hint">{t(aggregated ? 'filter.resultHint' : 'filter.detailHint')}</p>}
    <section className="filter-config-section">
      {modes.length > 1 && <Segmented block value={mode} aria-label={t('filter.mode')} onChange={changeMode} options={modes.map((entry) => ({ value: entry, label: t(`filter.${entry}`) }))} />}
      {field.role === 'measure' && isNumeric(field.type) && aggregated && <div className="filter-condition-row">
        <Field label={t('filter.aggregation')}><Select<Aggregation> block value={draft.aggregation} aria-label={t('filter.aggregation')} options={aggsFor(field.type).map((agg) => aggOption(agg, t))} onChange={(aggregation) => set({ aggregation })} /></Field>
      </div>}
      {dated && <DateFilterEditor key={draft.control?.type === 'date' ? 'single' : 'range'} value={draft.value} label={valueLabel} single={draft.control?.type === 'date'}
        onChange={(value) => set({ value })} onValidityChange={setValueValid} />}
      {mode === 'conditional' && !dated && <div className="filter-condition-row">
          <Field label={t('filter.condition')}>{opSelect}</Field>
          {control && <Field label={valueLabel}>
            <FilterControl key={`${draft.op}:${control.type}`} control={control} value={draft.value} debounce={false} label={valueLabel} loadOptions={loadOptions} onValidityChange={setValueValid} onChange={(value) => set({ value })} />
          </Field>}
      </div>}
      {(draft.op === 'between' || draft.op === 'not_between') && <div className="row">
        <Checkbox checked={range.includeMin !== false} onChange={(includeMin) => set({ value: { ...range, includeMin } })}>{t('filter.includeMin')}</Checkbox>
        <Checkbox checked={range.includeMax !== false} onChange={(includeMax) => set({ value: { ...range, includeMax } })}>{t('filter.includeMax')}</Checkbox>
      </div>}
      {(draft.op === 'like' || draft.op === 'not_like') && <p className="note small">{t('filter.patternHint')}</p>}
      {mode === 'exact' && <>
        <ExactFilterValues value={draft.value} onChange={(value) => set({ value })} multi={!draft.control || Boolean(draft.control.multi)} excluded={excluded} loadOptions={loadOptions} />
        <div className="filter-values-foot">{excludeBox}</div>
      </>}
      {mode === 'manual' && <div className="stack">
        <TextArea aria-label={t('filter.manual')} value={manual} onChange={readManual} rows={7} placeholder={t('filter.manualHint')} />
        <div className="filter-values-foot">
          <label className="filter-csv-input">{t('filter.uploadCSV')}<input type="file" accept=".csv,text/csv" onChange={(event) => { const file = event.target.files?.[0]; if (file) void file.text().then(readManual); event.target.value = '' }} /></label>
          {manualInvalid && <p className="note small danger" role="alert">{t('filter.invalidValues')}</p>}
          {excludeBox}
        </div>
      </div>}
      {invalidSingle && <p role="alert" className="note small danger">{t('filter.singleValueOnly')}</p>}
      {invalidRange && <p role="alert" className="note small danger">{t('filter.rangeInvalid')}</p>}
    </section>
    <section className={`filter-config-section filter-config-display${draft.control ? ' on' : ''}`}>
      <div className="filter-config-toggle">
        <Checkbox checked={Boolean(draft.control)} disabled={!controls.length} onChange={(on) => set({ control: on ? { type: controls[0]!, multi: true } : undefined, label: draft.label ?? field.label, ...(!on ? { dependsOn: undefined } : {}) })}>{t('filter.interactive')}</Checkbox>
        <p className="note small">{t(controls.length ? 'filter.interactiveHint' : 'filter.noControl')}</p>
      </div>
      {draft.control && <>
        <div className="filter-pair">
          <Field label={t('filter.label')} required><Input aria-label={t('filter.label')} value={draft.label ?? ''} invalid={problem === 'needsLabel'} onChange={(label) => set({ label })} /></Field>
          <Field label={t('filter.control')} hint={draft.control.type === 'tiles' ? t('filter.tilesHint', { count: tilesLimit }) : undefined}><Select<ControlType> block aria-label={t('filter.control')} value={draft.control.type} options={controls.map((type) => ({ value: type, label: t(`filter.controls.${type}`) }))}
            onChange={(type) => set({ control: { ...draft.control, type }, ...(isTemporal(field.type) ? { value: undefined } : {}) })} /></Field>
        </div>
        {isSelect(draft.control) && <Checkbox checked={Boolean(draft.control.multi)} onChange={(multi) => set({ control: { ...draft.control!, multi }, value: multi || !Array.isArray(draft.value) ? draft.value : draft.value.slice(0, 1) })}>{t('filter.multi')}</Checkbox>}
        {canCascade(draft) && !aggregated && <Field label={t('filter.parents')} hint={t('filter.parentsHint')}><MultiSelect value={draft.dependsOn ?? []} aria-label={t('filter.parents')} placeholder={t('filter.noParents')} options={parents.map((parent) => ({ value: parent.id, label: parent.label ?? parent.field }))} onChange={(dependsOn) => set({ dependsOn })} /></Field>}
      </>}
    </section>
  </Dialog>
}
