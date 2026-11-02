import { Button, Checkbox, Dialog, Field, MultiSelect, Segmented, Select, TextArea, Tooltip } from '@supabi/ui'
import { Fragment, useCallback, useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, unwrap, type ApiError } from '../api/client'
import { makeKey } from '../api/spec'
import { aggLabel } from '../lib/aggregations'
import { alike, canCascade, descendants, validGlobalCascade, rangeOf, compatible, controlsFor, globalOps, isSelect, sameTarget, type ControlType, type FilterField, type FilterOp, type FilterTarget, type GlobalFilter } from '../lib/filters'
import { FilterControl, tilesLimit, type LoadOptions } from './FilterControl'
import { ExactFilterValues, parseFilterValues } from './ExactFilterValues'
import { DateFilterEditor } from './DateFilterEditor'
import { opOption } from './FormulaSymbol'
import { ErrorAlert } from './ErrorAlert'
import { Icon } from './Icon'
import './globalFiltersDialog.css'

const choiceKey = (target: FilterTarget) => target.field ? `field:${target.field}:${target.aggregation ?? ''}` : `measure:${target.measure}`

/** Each selected chart maps this global condition to one of its available fields. */
/** Where the charts are on a split dashboard: above the tabs, or on a page, in that order. Each lists the chart widgets and tabs there. */
export interface ChartGroup { id: string; label: string; items: string[] }

function GlobalFilterSettings({ draft, fields, groups, filters, onChange, onValidityChange }: { draft: GlobalFilter; fields: FilterField[]; groups?: ChartGroup[]; filters: GlobalFilter[]; onChange: (filter: GlobalFilter) => void; onValidityChange: (id: string, valid: boolean) => void }) {
  const { t } = useTranslation()
  const id = useId()
  const [valueValid, setValueValid] = useState(true)
  const [selectedItems, setSelectedItems] = useState(() => draft.targets.map((target) => target.item))
  const [mode, setMode] = useState<'exact' | 'conditional' | 'manual'>(['in', 'not_in'].includes(draft.op) ? 'exact' : 'conditional')
  const [manual, setManual] = useState('')
  const [manualInvalid, setManualInvalid] = useState(false)
  const set = (patch: Partial<GlobalFilter>) => onChange({ ...draft, ...patch })
  const entryOf = (target: FilterTarget) => fields.find((entry) => sameTarget(entry.target, target))
  const first = draft.targets.map(entryOf).find(Boolean)
  const source = entryOf(draft.targets.find((target) => !draft.optionsFrom || target.item === draft.optionsFrom) ?? { item: '' })
  const conditionalOps = first ? globalOps(first).filter((op) => op !== 'in' && op !== 'not_in') : []
  const modes: typeof mode[] = conditionalOps.length ? ['exact', 'conditional', 'manual'] : ['exact', 'manual']
  const controls = first ? controlsFor(draft.op, first.type) : []
  const widgets = [...new Map(fields.map((entry) => [entry.item, entry])).values()]
  const labelOf = (entry: FilterField) => `${entry.agg ? aggLabel(entry.agg, entry.label) : entry.label} · ${t(entry.source === 'chart' ? 'dashboard.chartMeasure' : entry.aggregate ? entry.agg ? 'dashboard.datasetMeasureAggregate' : 'dashboard.datasetMetric' : 'dashboard.datasetField')}`
  const available = (entry: FilterField) => (!first || (draft.targets.length === 1 && first.item === entry.item) || compatible(first, entry))
  const put = (entry: FilterField, previousIndex?: number) => {
    if (!first || (draft.targets.length === 1 && first.item === entry.item && !sameTarget(first.target, entry.target))) {
      const op = globalOps(entry)[0]!
      const targets = alike(entry, fields).filter((target) => selectedItems.includes(target.item))
      setMode(['in', 'not_in'].includes(op) ? 'exact' : 'conditional')
      setValueValid(true)
      setManualInvalid(false)
      setSelectedItems((current) => [...new Set([...current, ...targets.map((target) => target.item)])])
      set({ targets, label: !draft.label || draft.label === first?.label ? entry.label : draft.label, op, control: { type: controlsFor(op, entry.type)[0]!, multi: true }, default: undefined, optionsFrom: undefined, dependsOn: undefined })
    } else {
      const targets = previousIndex !== undefined ? draft.targets.map((target, index) => index === previousIndex ? { ...entry.target } : target) : [...draft.targets, { ...entry.target }]
      set({ targets })
    }
  }
  const loadOptions: LoadOptions | undefined = source?.aggregate && source.type === 'boolean' ? async () => ({ values: [true, false], truncated: false }) : source && !source.aggregate ? async (search) => {
    const query = { version: 1, dataset: source.datasetId, dimensions: [{ field: source.target.field }], limit: 500,
      ...(search && source.type === 'string' ? { filter: { field: source.target.field, op: 'contains', value: search } } : {}) }
    const result = await unwrap(api.POST('/query', { body: { query } }))
    return { values: result.rows.map((row) => row[0]).filter((value) => value !== null), truncated: result.meta.truncated }
  } : undefined
  const excludedParents = new Set([draft.id, ...descendants(filters, draft.id)])
  const cascadeFilters = (next: GlobalFilter) => [...filters.filter((other) => other.id !== next.id), next].map((other) => canCascade(next) || !other.dependsOn ? other : { ...other, dependsOn: other.dependsOn.filter((id) => id !== next.id) })
  const cascadeValid = validGlobalCascade(cascadeFilters(draft), fields)
  const parentChoices = filters.filter((parent) => !excludedParents.has(parent.id) && canCascade(parent)).map((parent) => ({
    value: parent.id,
    label: parent.label,
    disabled: !validGlobalCascade(cascadeFilters({ ...draft, dependsOn: [...new Set([...(draft.dependsOn ?? []), parent.id])] }), fields),
  }))
  const range = rangeOf(draft.default)
  const pending = selectedItems.some((item) => !draft.targets.some((target) => target.item === item))
  const invalidRange = (draft.op === 'between' || draft.op === 'not_between') && range.min != null && range.max != null && range.min > range.max
  const invalidSingle = isSelect(draft.control) && !draft.control.multi && Array.isArray(draft.default) && draft.default.length > 1
  const valid = !invalidSingle && !invalidRange && !(mode === 'manual' && manualInvalid) && valueValid && !pending && cascadeValid && draft.label.trim() && first && draft.targets.every((target) => {
    const entry = entryOf(target)
    return entry && available(entry) && globalOps(entry).includes(draft.op)
  }) && controls.includes(draft.control.type)

  useEffect(() => onValidityChange(draft.id, Boolean(valid)), [draft.id, valid, onValidityChange])
  const changeOp = (op: FilterOp) => { setValueValid(true); set({ op, control: { type: controlsFor(op, first!.type)[0]!, multi: true }, default: undefined, ...(op !== 'in' ? { dependsOn: undefined } : {}) }) }
  const changeMode = (next: typeof mode) => {
    setMode(next); setManualInvalid(false)
    if (next === 'conditional') changeOp(globalOps(first!).find((op) => op !== 'in' && op !== 'not_in')!)
    else {
      if (!['in', 'not_in'].includes(draft.op)) changeOp('in')
      if (next === 'manual') setManual(Array.isArray(draft.default) ? draft.default.map((value) => typeof value === 'string' ? `"${value.replaceAll('"', '""')}"` : String(value)).join('\n') : '')
    }
  }
  const readManual = (text: string) => { setManual(text); const parsed = parseFilterValues(text, first!.type); setManualInvalid(parsed.invalid); if (!parsed.invalid) set({ default: parsed.values }) }
  const exclude = <Checkbox checked={draft.op === 'not_in'} onChange={(on) => set({ op: on ? 'not_in' : 'in', dependsOn: on ? undefined : draft.dependsOn })}>{t('filter.exclude')}</Checkbox>

  return <>
    <div className="global-filter-mappings">
      <section className="global-filter-charts">
        <h3>{t('dashboard.linkedCharts')}</h3>
        <Checkbox checked={widgets.length > 0 && widgets.every((widget) => selectedItems.includes(widget.item))} onChange={(on) => {
          setSelectedItems(on ? widgets.filter((widget) => fields.some((entry) => entry.item === widget.item && available(entry) && globalOps(entry).length)).map((widget) => widget.item) : [])
          if (!on) set({ targets: [], optionsFrom: undefined })
        }}>{t('dashboard.selectAllCharts')}</Checkbox>
        {/* Not split, the charts are all together, under no heading. */}
        {(groups ?? [{ id: '', items: widgets.map((widget) => widget.item) }] as { id: string; label?: string; items: string[] }[]).map((group) => {
          const among = widgets.filter((widget) => group.items.includes(widget.item))
          if (groups && !among.length) return null
          const options = <div className="global-filter-chart-options">{among.map((widget) => <Checkbox key={widget.item} checked={selectedItems.includes(widget.item)} disabled={!selectedItems.includes(widget.item) && !fields.some((entry) => entry.item === widget.item && available(entry) && globalOps(entry).length)} onChange={(on) => {
            setSelectedItems((current) => on ? [...current, widget.item] : current.filter((item) => item !== widget.item))
            if (!on) set({ targets: draft.targets.filter((target) => target.item !== widget.item), ...(draft.optionsFrom === widget.item ? { optionsFrom: undefined } : {}) })
          }}>{widget.chartName}</Checkbox>)}</div>
          return group.label === undefined ? <Fragment key={group.id}>{options}</Fragment> : <div key={group.id} className="global-filter-chart-group" role="group" aria-label={group.label}><h4 className="note small">{group.label}</h4>{options}</div>
        })}
      </section>
      <section className="global-filter-fields">
        <h3>{t('dashboard.filterFields')}</h3>
        <ul className="target-list">
          {widgets.filter((widget) => selectedItems.includes(widget.item)).map((widget) => {
            const targets = draft.targets.map((target, index) => ({ target, index })).filter(({ target }) => target.item === widget.item)
            const candidates = fields.filter((entry) => entry.item === widget.item)
            return (
              <li key={widget.item} className="row">
                <strong>{widget.chartName}</strong>
                <div className="mapping-fields">
                  {(targets.length ? targets : [{ target: undefined, index: undefined }]).map(({ target, index }, position) => <div className="row" key={index ?? 'pending'}>
                    <Select value={target ? choiceKey(target) : undefined} placeholder={t('dashboard.chooseField')}
                      aria-label={t('dashboard.fieldForChart', { name: targets.length > 1 ? `${widget.chartName} (${position + 1})` : widget.chartName })}
                      options={candidates.map((entry) => ({ value: choiceKey(entry.target), label: labelOf(entry), disabled: !available(entry) || globalOps(entry).length === 0 }))}
                      onChange={(key) => { const entry = candidates.find((candidate) => choiceKey(candidate.target) === key); if (entry) put(entry, index) }} />
                    {targets.length > 1 && <Button size="sm" variant="ghost" danger aria-label={t('dashboard.removeFieldMapping', { name: widget.chartName, index: position + 1 })}
                      onClick={() => set({ targets: draft.targets.filter((_, targetIndex) => targetIndex !== index) })}>{t('dashboard.remove')}</Button>}
                  </div>)}
                </div>
              </li>
            )
          })}
        </ul>
        {pending && <p className="note">{t('dashboard.pendingFieldMappings')}</p>}
        {!cascadeValid && <p className="note small" role="alert">{t('filter.cascadeUnmapped')}</p>}
        {draft.targets.length > 1 && <p className="note">{t('dashboard.changeFieldTypeHint')}</p>}
      </section>
    </div>
    <section className="global-filter-conditions">
      <h3>{t('dashboard.filterSettings')}</h3>
      {!first && <div className="global-filter-placeholder"><Icon name="filter" size={28} /><p>{t('dashboard.selectFilterField')}</p></div>}
        {first && <>
          <p className="note">{t(first.aggregate ? 'dashboard.aggregateFilterHint' : 'dashboard.rowFilterHint')}</p>
          <div className="stack">
            {draft.op !== 'time' && globalOps(first).includes('in') && <Segmented block value={mode} aria-label={t('filter.mode')} options={modes.map((value) => ({ value, label: t(`filter.${value}`) }))} onChange={changeMode} />}
            {mode === 'conditional' && draft.op !== 'time' && <Field label={t('filter.condition')} htmlFor={`${id}-op`}>
              <Select<FilterOp> id={`${id}-op`} block value={draft.op} options={globalOps(first).filter((op) => op !== 'in' && op !== 'not_in').map((op) => opOption(op, t))} onChange={changeOp} />
            </Field>}
            {mode === 'exact' && <><ExactFilterValues key={source ? `${source.item}:${choiceKey(source.target)}` : 'empty'} value={draft.default} onChange={(value) => set({ default: value })} multi={Boolean(draft.control.multi)} excluded={draft.op === 'not_in'} loadOptions={loadOptions ?? (async () => ({ values: [], truncated: false }))} /><div className="filter-values-foot">{exclude}</div></>}
            {mode === 'manual' && <><TextArea aria-label={t('filter.manual')} value={manual} onChange={readManual} rows={8} placeholder={t('filter.manualHint')} />{manualInvalid && <p role="alert" className="note danger">{t('filter.invalidValues')}</p>}<div className="filter-values-foot">{exclude}</div></>}
            {draft.op === 'time' && <DateFilterEditor key={draft.control.type} value={draft.default} label={t('filter.defaultValue')} single={draft.control.type === 'date'} onChange={(value) => set({ default: value })} onValidityChange={setValueValid} />}
            {mode === 'conditional' && draft.op !== 'time' && <Field label={t('filter.defaultValue')} htmlFor={`${id}-default`} hint={t('filter.defaultHint')}>
              <FilterControl key={`${source?.item}:${source && choiceKey(source.target)}:${draft.op}`} id={`${id}-default`} control={draft.control} label={t('filter.defaultValue')} value={draft.default} debounce={false} onValidityChange={setValueValid} onChange={(value) => set({ default: value })} loadOptions={loadOptions} />
            </Field>}
            <Field label={t('filter.control')} htmlFor={`${id}-control`}>
              <Select<ControlType> id={`${id}-control`} block value={draft.control.type} options={controls.map((type) => ({ value: type, label: t(`filter.controls.${type}`) }))}
                onChange={(type) => set({ control: { ...draft.control, type }, default: draft.op === 'time' ? undefined : draft.default })} />
            </Field>
            {isSelect(draft.control) && draft.targets.length > 1 && <Field label={t('dashboard.optionsFrom')} htmlFor={`${id}-options`} hint={t('dashboard.optionsFromHint')}>
              <Select id={`${id}-options`} block value={source?.item} options={[...new Map(draft.targets.map((target) => [target.item, { value: target.item, label: entryOf(target)?.chartName ?? target.item }])).values()]} onChange={(optionsFrom) => set({ optionsFrom })} />
            </Field>}
          </div>
          {draft.control.type === 'tiles' && <p className="note small">{t('filter.tilesHint', { count: tilesLimit })}</p>}
          {isSelect(draft.control) && <Checkbox checked={Boolean(draft.control.multi)} onChange={(multi) => set({ control: { ...draft.control, multi }, default: multi || !Array.isArray(draft.default) ? draft.default : draft.default.slice(0, 1) })}>{t('filter.multi')}</Checkbox>}
          {(draft.op === 'between' || draft.op === 'not_between') && <div className="row">
            <Checkbox checked={range.includeMin !== false} onChange={(includeMin) => set({ default: { ...range, includeMin } })}>{t('filter.includeMin')}</Checkbox>
            <Checkbox checked={range.includeMax !== false} onChange={(includeMax) => set({ default: { ...range, includeMax } })}>{t('filter.includeMax')}</Checkbox>
          </div>}
          {canCascade(draft) && !source?.aggregate && <Field label={t('filter.parents')} hint={t('filter.parentsHint')}>
            <MultiSelect aria-label={t('filter.parents')} value={draft.dependsOn ?? []} options={parentChoices} placeholder={t('filter.noParents')} onChange={(dependsOn) => set({ dependsOn })} />
            {cascadeValid && parentChoices.some((parent) => parent.disabled) && <p className="note small">{t('filter.cascadeUnmapped')}</p>}
          </Field>}
          {invalidSingle && <p role="alert" className="note danger">{t('filter.singleValueOnly')}</p>}
          {invalidRange && <p role="alert" className="note danger">{t('filter.rangeInvalid')}</p>}
        </>}
    </section>
  </>
}

/** All changes stay in this dialog until the author confirms the whole collection. */
export function GlobalFiltersDialog({ filters, fields, groups, error, onRetry, onDone, onCancel }: { error?: ApiError; onRetry?: () => void; filters: GlobalFilter[]; fields: FilterField[]; groups?: ChartGroup[]; onDone: (filters: GlobalFilter[]) => void; onCancel: () => void }) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(() => filters.map((filter) => filter.control.type === 'date_range' ? { ...filter, control: { ...filter.control, type: 'relative' as const } } : filter))
  const [active, setActive] = useState(filters[0]?.id)
  const [renaming, setRenaming] = useState<string>()
  const [name, setName] = useState('')
  const [validity, setValidity] = useState<Record<string, boolean>>({})
  const onValidityChange = useCallback((id: string, valid: boolean) => setValidity((current) => current[id] === valid ? current : { ...current, [id]: valid }), [])
  const change = (next: GlobalFilter) => setDraft((current) => current.map((filter) => filter.id === next.id ? next : canCascade(next) || !filter.dependsOn ? filter : { ...filter, dependsOn: filter.dependsOn.filter((id) => id !== next.id) }))
  const commitName = () => { if (name.trim()) setDraft((current) => current.map((filter) => filter.id === renaming ? { ...filter, label: name.trim() } : filter)); setRenaming(undefined) }
  const add = () => {
    const id = makeKey('g', new Set(draft.map((filter) => filter.id)))
    setDraft([...draft, { id, label: '', op: 'in', control: { type: 'select', multi: true }, targets: [] }]); setActive(id)
  }
  const remove = (id: string) => {
    const next = draft.filter((filter) => filter.id !== id).map((filter) => ({ ...filter, ...(filter.dependsOn ? { dependsOn: filter.dependsOn.filter((parent) => parent !== id) } : {}) }))
    setDraft(next); if (active === id) setActive(next[0]?.id)
  }
  return <Dialog open title={t('dashboard.filters')} width={1280} onClose={onCancel} actions={<><Button onClick={onCancel}>{t('common.cancel')}</Button><Button variant="primary" disabled={draft.some((filter) => !validity[filter.id])} onClick={() => onDone(draft)}>{t('common.confirm')}</Button></>}>
    <div className="global-filters-dialog">
      <nav className="global-filter-sidebar" aria-label={t('dashboard.filters')}>
        <Button icon={<Icon name="plus" />} disabled={!fields.length} onClick={add}>{t('dashboard.addFilter')}</Button>
        <div className="global-filter-entries">{draft.map((filter) => <div key={filter.id} className={`global-filter-entry${active === filter.id ? ' active' : ''}`}>
          {renaming === filter.id ? <input className="global-filter-name" autoFocus aria-label={t('filter.label')} value={name} onChange={(event) => setName(event.target.value)} onBlur={commitName} onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); commitName() }
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setRenaming(undefined) }
          }} /> : <button type="button" className="global-filter-select" aria-pressed={active === filter.id} onClick={() => setActive(filter.id)}>{filter.label || t('dashboard.unnamedFilter')}</button>}
          <Tooltip title={t('dashboard.renameFilter')}><Button size="sm" variant="ghost" icon={<Icon name="edit" size={14} />} aria-label={t('dashboard.renameFilterName', { name: filter.label || t('dashboard.unnamedFilter') })} onClick={() => { setActive(filter.id); setName(filter.label); setRenaming(filter.id) }} /></Tooltip>
          <Button size="sm" variant="ghost" danger icon={<Icon name="trash" size={14} />} aria-label={t('dashboard.removeFilter', { name: filter.label || t('dashboard.unnamedFilter') })} onClick={() => remove(filter.id)} />
        </div>)}</div>
        {error && <><ErrorAlert error={error} /><Button onClick={onRetry}>{t('common.retry')}</Button></>}
        {!error && !fields.length && <p className="note small">{t('dashboard.noFilterFields')}</p>}
      </nav>
      {draft.map((filter) => <div key={filter.id} style={{ display: active === filter.id ? 'contents' : 'none' }}>
        <GlobalFilterSettings draft={filter} fields={fields} groups={groups} filters={draft} onChange={change} onValidityChange={onValidityChange} />
      </div>)}
      {!draft.length && <div className="global-filter-empty"><Icon name="filter" size={36} /><h3>{t('dashboard.noGlobalFilters')}</h3><p className="note">{t('dashboard.filtersHint')}</p></div>}
    </div>
  </Dialog>
}
