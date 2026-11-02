import { Button, Checkbox, Dialog, Field, Input, Segmented, Select } from '@supabi/ui'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MeasureCompute, CompareCompute, Grain } from '../lib/builder'
import type { SpecField } from '../api/spec'
import { asTimeFilter, type ChartFilter, type TimeValue } from '../lib/filters'
import { finiteTime } from '../lib/computes'
import { DateFilterEditor } from './DateFilterEditor'
import './compute.css'

export function ComputeDialog({ name, value, dimensions, accumulates, timeFields, filters, onDone, onCancel }: {
  name: string
  value: MeasureCompute | undefined
  /** The chart's dimensions; a temporal one is where a running total runs by default. */
  dimensions: { key: string; label: string; temporal?: boolean }[]
  /** Whether the measure, or every option of a dynamic one, is aggregated a way that can run. */
  accumulates: boolean
  timeFields: SpecField[]
  filters: ChartFilter[]
  onDone: (value: MeasureCompute | undefined, period?: TimeValue) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const initial = value?.type === 'compare' ? value : undefined
  const [mode, setMode] = useState<'none' | 'total' | 'within' | 'cumulative' | 'compare'>(initial ? 'compare' : value?.type === 'cumulative' ? 'cumulative' : value?.type === 'percent_of_total' ? value.within?.length ? 'within' : 'total' : 'none')
  const [within, setWithin] = useState(value?.type === 'percent_of_total' ? value.within ?? [] : [])
  const [along, setAlong] = useState(value?.type === 'cumulative' ? value.along : (dimensions.find((dimension) => dimension.temporal) ?? dimensions[0])?.key ?? '')
  const [timeField, setTimeField] = useState(initial?.timeField ?? timeFields[0]?.key ?? '')
  const periodFor = (field: string): TimeValue => {
    const filter = filters.find((filter) => filter.field === field && !filter.aggregation)
    return (filter ? asTimeFilter(filter).value : undefined) as TimeValue ?? { current: 'month' }
  }
  const [period, setPeriod] = useState(() => periodFor(timeField))
  const [valid, setValid] = useState(true)
  const [kind, setKind] = useState<'yoy' | 'previous'>(initial?.offset.unit === 'year' && initial.offset.n === 1 ? 'yoy' : 'previous')
  const [unit, setUnit] = useState<Grain>(initial?.offset.unit ?? 'month')
  const [n, setN] = useState(String(initial?.offset.n ?? 1))
  const [output, setOutput] = useState<CompareCompute['output']>(initial?.output ?? 'ratio')
  const invalid = mode === 'within' && !within.length || mode === 'cumulative' && (!accumulates || !dimensions.some((dimension) => dimension.key === along)) || mode === 'compare' && (!timeField || !finiteTime(period) || !valid || kind === 'previous' && (!Number.isInteger(Number(n)) || Number(n) < 1 || Number(n) > 1000))
  const done = () => {
    if (mode === 'compare') onDone({ type: 'compare', timeField, offset: kind === 'yoy' ? { n: 1, unit: 'year' } : { n: Number(n), unit }, output }, period)
    else if (mode === 'cumulative') onDone({ type: 'cumulative', along })
    else onDone(mode === 'none' ? undefined : { type: 'percent_of_total', ...(mode === 'within' ? { within } : {}) })
  }
  return <Dialog open width={600} title={t('compute.title', { name })} onClose={onCancel} actions={<>
    <Button onClick={onCancel}>{t('common.cancel')}</Button>
    <Button variant="primary" disabled={invalid} onClick={done}>{t('common.confirm')}</Button>
  </>}>
    <div className="compute-dialog">
      <Segmented value={mode} onChange={setMode} aria-label={t('compute.configure')} options={(['none', 'total', ...(dimensions.length ? ['within', 'cumulative'] as const : []), 'compare'] as const).map((value) => ({ value, label: t(`compute.${value}`), disabled: value === 'cumulative' && !accumulates }))} />
      {dimensions.length > 0 && !accumulates && <p className="compute-hint">{t('compute.cannotAccumulate')}</p>}
      {mode === 'cumulative' && <>
        <Field label={t('compute.along')}><Select block aria-label={t('compute.along')} value={along} options={dimensions.map((dimension) => ({ value: dimension.key, label: dimension.label }))} onChange={setAlong} /></Field>
        <p className="compute-hint">{t('compute.cumulativeHint')}</p>
      </>}
      {mode === 'within' && <fieldset className="compute-dimensions">
        <legend>{t('compute.dimensions')}</legend>
        {dimensions.map((dimension) => <Checkbox key={dimension.key} checked={within.includes(dimension.key)} onChange={(checked) => setWithin((current) => checked ? [...current, dimension.key] : current.filter((key) => key !== dimension.key))}>{dimension.label}</Checkbox>)}
      </fieldset>}
      {mode === 'compare' ? <>
        <Field label={t('compute.timeField')}><Select block aria-label={t('compute.timeField')} value={timeField} options={timeFields.map((field) => ({ value: field.key, label: field.label }))} onChange={(field) => { setTimeField(field); setPeriod(periodFor(field)); setValid(true) }} /></Field>
        <DateFilterEditor key={timeField} label={t('compute.period')} value={period} onChange={setPeriod} onValidityChange={setValid} />
        {!finiteTime(period) && <p className="compute-hint">{t('compute.finiteRange')}</p>}
        <Segmented value={kind} onChange={setKind} aria-label={t('compute.compare')} options={[{ value: 'yoy', label: t('compute.yoy') }, { value: 'previous', label: t('compute.mom') }]} />
        {kind === 'previous' && <div className="compute-offset">
          <Field label={t('compute.offset')}><Input aria-label={t('compute.offset')} type="number" value={n} onChange={setN} /></Field>
          <Field label={t('compute.unit')}><Select<Grain> block aria-label={t('compute.unit')} value={unit} options={(['day', 'week', 'month', 'quarter', 'year'] as const).map((value) => ({ value, label: t(`compute.units.${value}`) }))} onChange={setUnit} /></Field>
        </div>}
        <Field label={t('compute.output')}><Select<CompareCompute['output']> block aria-label={t('compute.output')} value={output} options={(['value', 'delta', 'ratio'] as const).map((value) => ({ value, label: t(`compute.outputs.${value}`) }))} onChange={setOutput} /></Field>
        <p className="compute-hint">{t('compute.compareHint')}</p>
      </> : (mode === 'total' || mode === 'within') && <p className="compute-hint">{t('compute.hint')}</p>}
    </div>
  </Dialog>
}
