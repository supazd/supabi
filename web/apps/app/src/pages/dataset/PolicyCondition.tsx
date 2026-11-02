import { Button, Input, MultiSelect, Radio, Select } from '@supabi/ui'
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { api, unwrap, type Schemas } from '../../api/client'
import { isNumeric, isTemporal, type SpecField } from '../../api/spec'
import { Icon } from '../../components/Icon'
import { attributeOf, candidateFilter, type Filter } from '../../lib/policy'
import { opText, type FilterOp } from '../../lib/filters'

export type Attribute = Schemas['UserAttribute']
export const attributeName = (a: Attribute, t: (key: string) => string) => a.builtin ? t(`attribute.builtins.${a.key}`) : a.name

type Props = { datasetId: string; fields: SpecField[]; attributes: Attribute[]; filter?: Filter; onChange: (filter?: Filter) => void }
type Mode = 'fixed' | 'dynamic' | 'mixed'
const isGroup = (filter?: Filter) => (filter?.op === 'and' || filter?.op === 'or') && Array.isArray(filter.args)
const empty = (dynamic = false): Filter => ({ field: '', op: 'in', value: dynamic ? { userAttr: '' } : [] })
function modeOf(filter?: Filter): Mode {
  if (!isGroup(filter)) return attributeOf(filter) !== undefined ? 'dynamic' : 'fixed'
  const modes = (filter!.args as Filter[]).map(modeOf)
  return modes.every((mode) => mode === 'dynamic') && modes.length > 0 ? 'dynamic' : modes.every((mode) => mode === 'fixed') ? 'fixed' : 'mixed'
}
function withMode(filter: Filter | undefined, dynamic: boolean, fields: SpecField[]): Filter {
  if (isGroup(filter)) return { ...filter, args: (filter!.args as Filter[]).map((arg) => withMode(arg, dynamic, fields)) }
  const field = fields.find((item) => item.key === filter?.field)
  return { ...empty(dynamic), field: field && (!dynamic || field.type === 'string') ? field.key : '' }
}

/** Keep typed server values intact, including decimal strings and null. */
function FixedValues({ datasetId, field, value, onChange }: { datasetId: string; field: SpecField; value: unknown; onChange: (values: unknown[]) => void }) {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')
  const [options, setOptions] = useState<unknown[]>([])
  const [truncated, setTruncated] = useState(false)
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(true)
  const selected = Array.isArray(value) ? value : []
  useEffect(() => {
    let current = true
    const timer = setTimeout(() => {
      const filter = candidateFilter(field, search)
      setFailed(false)
      setTruncated(false)
      setOptions([])
      if (filter === null) { setLoading(false); return }
      setLoading(true)
      void unwrap(api.POST('/query', { body: { query: { version: 1, dataset: datasetId, dimensions: [{ field: field.key }], ...(filter ? { filter } : {}), limit: 500 } } }))
        .then((result) => { if (current) { setOptions(result.rows.map((row) => row[0])); setTruncated(result.meta.truncated) } })
        .catch(() => { if (current) setFailed(true) })
        .finally(() => { if (current) setLoading(false) })
    }, search ? 250 : 0)
    return () => { current = false; clearTimeout(timer) }
  }, [datasetId, field, search])
  const keyOf = (item: unknown) => JSON.stringify(item) ?? 'null'
  const listed = [...new Map([...selected, ...options].map((item) => [keyOf(item), item])).entries()]
  return <div className="policy-condition-value">
    <MultiSelect<string> wrap aria-label={t('filter.value')} placeholder={t('filter.value')} value={selected.map(keyOf)} loading={loading}
      options={listed.map(([key, item]) => ({ value: key, label: String(item) }))} onSearch={setSearch} onChange={(keys) => onChange(keys.map((key) => JSON.parse(key)))} />
    {failed && <span className="note small" role="alert">{t('filter.optionsFailed')}</span>}
    {truncated && <span className="note small">{t('filter.moreOptions', { count: options.length })}</span>}
  </div>
}

function ScalarValue({ field, filter, onChange }: { field: SpecField; filter: Filter; onChange: (filter: Filter) => void }) {
  const { t } = useTranslation()
  // Keep unfinished text only for the exact condition that produced it. A
  // different condition may occupy this slot after another condition is removed.
  const [draft, setDraft] = useState({ filter, text: String(filter.value ?? '') })
  const text = draft.filter === filter ? draft.text : String(filter.value ?? '')
  const parsed = candidateFilter(field, text)
  return <Input aria-label={t('filter.value')} value={text} invalid={!!text && parsed === null} placeholder={isTemporal(field.type) ? 'YYYY-MM-DD' : t('filter.value')}
    onChange={(text) => {
      const next = { ...filter, value: candidateFilter(field, text)?.value }
      setDraft({ filter: next, text })
      onChange(next)
    }} />
}

function Leaf({ datasetId, fields, attributes, filter, onChange, mixed, remove }: Props & { mixed: boolean; remove?: ReactNode }) {
  const { t } = useTranslation()
  const attribute = attributeOf(filter)
  const dynamic = attribute !== undefined
  const field = String(filter?.field ?? '')
  const selected = fields.find((item) => item.key === field)
  const op = String(filter?.op ?? 'in') as FilterOp
  const ops: FilterOp[] = ['in', 'not_in', 'eq', 'ne', ...(selected && (isNumeric(selected.type) || isTemporal(selected.type)) ? ['gt', 'gte', 'lt', 'lte'] as FilterOp[] : []), ...(selected?.type === 'string' ? ['contains', 'not_contains', 'starts_with', 'ends_with'] as FilterOp[] : []), 'is_null', 'not_null']
  const known = !filter || (ops.includes(op) && Object.keys(filter).every((key) => ['field', 'op', 'value'].includes(key)))
  if (!known && attribute === undefined) return <div className="stack">
    <p className="note small">{t('policy.complexCondition')}</p>
    <pre className="policy-filter-code">{JSON.stringify(filter, null, 2)}</pre>
    <div className="row"><Button size="sm" onClick={() => onChange(empty())}>{t('policy.replaceCondition')}</Button>{remove}</div>
  </div>
  return <div className={`policy-condition-line${mixed ? ' mixed' : ''}`}>
    {mixed && <div><Select<'fixed' | 'dynamic'> block aria-label={t('policy.valueSource')} value={dynamic ? 'dynamic' : 'fixed'} options={[{ value: 'fixed', label: t('policy.fixed') }, { value: 'dynamic', label: t('policy.dynamic') }]} onChange={(mode) => onChange(withMode(filter, mode === 'dynamic', fields))} /></div>}
    <div><Select<string> block search searchBy="label" aria-label={t('policy.conditionField')} placeholder={t('policy.conditionField')} value={field || undefined}
      options={fields.filter((item) => item.role !== 'metric' && (!dynamic || item.type === 'string')).map((item) => ({ value: item.key, label: item.label }))}
      onChange={(key) => onChange({ field: key, op: 'in', value: dynamic ? { userAttr: attribute } : [] })} /></div>
    <div><Select<FilterOp> block aria-label={t('filter.condition')} value={dynamic ? 'in' : op} disabled={dynamic} options={(dynamic ? ['in'] as FilterOp[] : ops).map((value) => ({ value, label: value === 'in' ? t('policy.belongsTo') : value === 'not_in' ? t('policy.notBelongsTo') : opText(value, t) }))}
      onChange={(next) => onChange({ field, op: next, ...(['is_null', 'not_null'].includes(next) ? {} : { value: ['in', 'not_in'].includes(next) ? [] : undefined }) })} /></div>
    <div className="policy-condition-value">
      {dynamic ? <Select<string> block search searchBy="label" aria-label={t('attribute.title')} placeholder={t('policy.selectAttribute')} value={attribute || undefined}
        options={attributes.map((a) => ({ value: a.key, label: attributeName(a, t) }))} onChange={(key) => onChange({ field, op: 'in', value: { userAttr: key } })} />
        : !selected ? <Input aria-label={t('filter.value')} placeholder={t('filter.value')} value="" onChange={() => {}} disabled />
        : ['in', 'not_in'].includes(op) ? <FixedValues key={field} datasetId={datasetId} field={selected} value={filter?.value} onChange={(values) => onChange({ field, op, value: values })} />
        : !['is_null', 'not_null'].includes(op) && <ScalarValue key={`${field}:${op}`} field={selected} filter={filter!} onChange={onChange} />}
    </div>
    <div className="policy-condition-remove">{remove}</div>
  </div>
}

/** Existing expression trees keep their nesting; only their presentation is flattened. */
function Conditions({ mode, nested = false, ...props }: Props & { mode: Mode; nested?: boolean }) {
  const { t } = useTranslation()
  const { filter, onChange } = props
  const grouped = isGroup(filter)
  const args = grouped ? filter!.args as Filter[] : [filter]
  const blank = () => empty(mode === 'dynamic')
  return <div className={nested ? 'policy-condition-nested' : 'policy-condition-body'}>
    <div className="policy-config-line">
      <span className="note">{t('policy.permissionRule')}</span>
      <div><Select<string> aria-label={t('policy.conditionLogic')} value={grouped ? String(filter!.op) : 'and'} options={[{ value: 'and', label: t('policy.and') }, { value: 'or', label: t('policy.or') }]}
        onChange={(op) => onChange({ op, args: args.map((arg) => arg ?? blank()) })} /></div>
    </div>
    <div className="policy-condition-list">
      {args.map((arg, index) => {
        const remove = args.length > 1 ? <Button size="sm" variant="ghost" icon={<Icon name="trash" />} aria-label={t('policy.removeCondition', { n: index + 1 })} onClick={() => onChange({ ...filter, args: args.filter((_, i) => i !== index) })} /> : undefined
        const change = (next?: Filter) => onChange(grouped ? { ...filter, args: args.map((other, i) => i === index ? next ?? blank() : other) } : next)
        return isGroup(arg) ? <div className="policy-condition-branch" key={index}><Conditions {...props} nested mode={mode} filter={arg} onChange={change} />{remove}</div>
          : <Leaf {...props} key={index} mixed={mode === 'mixed'} filter={arg} onChange={change} remove={remove} />
      })}
      <div><Button size="sm" variant="ghost" icon={<Icon name="plus" />} onClick={() => onChange({ op: grouped ? filter!.op : 'and', args: [...args.map((arg) => arg ?? blank()), blank()] })}>{t('policy.addCondition')}</Button></div>
    </div>
  </div>
}

export function PolicyCondition(props: Props) {
  const { t } = useTranslation()
  const [individual, setIndividual] = useState(false)
  const mode = individual ? 'mixed' : modeOf(props.filter)
  const multiple = isGroup(props.filter) && (props.filter!.args as Filter[]).length > 1
  return <div className="policy-condition-editor">
    <div className="policy-config-line">
      <span className="note">{t('policy.valueSource')}</span>
      <div className="row" role="group" aria-label={t('policy.valueSource')}>
        <Radio checked={mode === 'fixed'} onChange={() => { setIndividual(false); props.onChange(withMode(props.filter, false, props.fields)) }}>{t('policy.fixed')}</Radio>
        <Radio checked={mode === 'dynamic'} onChange={() => { setIndividual(false); props.onChange(withMode(props.filter, true, props.fields)) }}>{t('policy.dynamic')}</Radio>
        {(multiple || mode === 'mixed') && <Radio checked={mode === 'mixed'} onChange={() => setIndividual(true)}>{t('policy.mixedValues')}</Radio>}
      </div>
    </div>
    <Conditions {...props} mode={mode} />
  </div>
}
