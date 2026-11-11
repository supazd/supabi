import { formatCell } from '@supabi/charts'
import { Button, DataTable, Dialog, Field, Input, MultiSelect, Radio, Segmented, Select } from '@supabi/ui'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, unwrap, type ApiError, type Dataset, type Schemas } from '../../api/client'
import { isNumeric, type DatasetSpec } from '../../api/spec'
import { toApiError, useAsync } from '../../api/useAsync'
import { useSession } from '../../auth/session'
import { Async } from '../../components/Async'
import { ErrorAlert } from '../../components/ErrorAlert'
import { Icon } from '../../components/Icon'
import { SubjectPicker, loadDirectory, useSubjectName, type Directory } from '../../components/SubjectPicker'
import { conditionSummary, draftOf, hasCondition, policyOf, type Filter, type RowDraft } from '../../lib/policy'
import { PolicyCondition, attributeName, type Attribute } from './PolicyCondition'
import './dataPermissions.css'

type Policy = Schemas['DatasetPolicy']
type ColumnRule = Schemas['ColumnRule']
type Preview = Schemas['PolicyPreview']

/** What one user would see of the dataset, with the permissions as they stand on the page. */
function PreviewAs({ datasetId, spec, directory, policy }: { datasetId: string; spec: DatasetSpec; directory: Directory; policy: Policy }) {
  const { t, i18n } = useTranslation()
  const [userId, setUserId] = useState<string>()
  const [result, setResult] = useState<Preview | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [loading, setLoading] = useState(false)
  const request = useRef(0)
  const labels = new Map(spec.fields.map((field) => [field.key, field.label]))
  const run = async (id: string) => {
    const sequence = ++request.current
    setLoading(true)
    setResult(null)
    setError(null)
    try {
      const next = await unwrap(api.POST('/datasets/{id}/policy/preview', { params: { path: { id: datasetId } }, body: { userId: id, policy } }))
      if (sequence === request.current) setResult(next)
    } catch (e) {
      if (sequence === request.current) { setError(toApiError(e)); setResult(null) }
    } finally {
      if (sequence === request.current) setLoading(false)
    }
  }
  return (
    <section className="stack" aria-label={t('policy.previewTitle')}>
      <p className="note">{t('policy.previewHint')}</p>
      <div className="policy-preview-controls">
        <div className="policy-preview-user">
          <Select<string> block search searchBy="label" aria-label={t('policy.previewUser')} placeholder={t('policy.previewUser')} value={userId}
            options={directory.users.filter((user) => user.status === 'active').map((user) => ({ value: user.id, label: `${user.displayName} (${user.email})` }))} onChange={(id) => { request.current++; setUserId(id); setResult(null); setError(null); setLoading(false) }} />
        </div>
        <Button disabled={!userId} loading={loading} onClick={() => userId && void run(userId)}>{t('policy.preview')}</Button>
      </div>
      {error && <ErrorAlert error={error} />}
      {result && (
        <div className="stack">
          {!result.restricted && <p className="note">{t('policy.previewUnrestricted')}</p>}
          {result.hiddenFields.length > 0 && <p className="note">{t('policy.previewHidden', { fields: result.hiddenFields.map((key) => labels.get(key) ?? key).join(t('policy.listSeparator')) })}</p>}
          <DataTable
            aria-label={t('policy.previewTitle')}
            rows={result.result.rows.map((cells) => ({ cells }))}
            rowKey={(_, index) => String(index)}
            pageSize={20}
            pageKey={result.result}
            empty={t('policy.previewEmpty')}
            columns={result.result.columns.map((column, index) => ({
              key: column.name,
              title: labels.get(column.name) ?? column.label ?? column.name,
              align: isNumeric(column.type) ? ('right' as const) : ('left' as const),
              render: (row: { cells: unknown[] }) => <span className="tabular">{formatCell(row.cells[index] as never, column, i18n.language)}</span>,
            }))}
          />
        </div>
      )}
    </section>
  )
}

type Editing = { kind: 'row'; index: number; rule: RowDraft; original: string } | { kind: 'column'; index: number; rule: ColumnRule; original: string }

function PolicyForm({ dataset, initial, directory, attributes, onDirtyChange }: { dataset: Dataset; initial: Policy; directory: Directory; attributes: Attribute[]; onDirtyChange?: (dirty: boolean) => void }) {
  const { t, i18n } = useTranslation()
  const spec = dataset.spec as unknown as DatasetSpec
  const subjectName = useSubjectName(directory)
  const [attributeList, setAttributeList] = useState(attributes)
  // Returning from attribute settings refreshes the picker without discarding rule drafts.
  useEffect(() => {
    let active = true
    const refresh = () => { void unwrap(api.GET('/user-attributes')).then((items) => { if (active) setAttributeList(items) }).catch(() => { /* Keep the last loaded list; saving still validates references. */ }) }
    window.addEventListener('focus', refresh)
    return () => { active = false; window.removeEventListener('focus', refresh) }
  }, [])
  const [saved, setSaved] = useState(initial)
  const [draft, setDraft] = useState(() => draftOf(initial))
  const [editing, setEditing] = useState<Editing>()
  const [closing, setClosing] = useState(false)
  const [removing, setRemoving] = useState<{ kind: 'row' | 'column'; index: number }>()
  const [previewing, setPreviewing] = useState(false)
  const [search, setSearch] = useState('')
  const [kind, setKind] = useState<'all' | 'row' | 'column'>('all')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const policy = policyOf(draft)
  const enabled = draft.rows.length + draft.columns.length > 0
  const savedEnabled = saved.rows.length + saved.columns.length > 0
  const columnMode = draft.columnMode ?? 'visible'
  const dirty = JSON.stringify(policy) !== JSON.stringify(policyOf(draftOf(saved)))
  const editorDirty = !!editing && JSON.stringify(editing.rule) !== editing.original
  useEffect(() => { onDirtyChange?.(dirty || editorDirty) }, [dirty, editorDirty, onDirtyChange])
  const unfinished = draft.rows.some((rule) => rule.subjects.length === 0 || !hasCondition(rule.filter)) || draft.columns.some((rule) => rule.fields.length === 0)
  const editorUnfinished = editing && (editing.kind === 'row' ? editing.rule.subjects.length === 0 || !hasCondition(editing.rule.filter) : editing.rule.fields.length === 0)
  const savedRows = draftOf(saved).rows
  const fieldLabels = new Map(spec.fields.map((f) => [f.key, f.label]))
  const attrLabels = new Map(attributeList.map((a) => [a.key, attributeName(a, t)]))
  const summary = (filter?: Filter) => conditionSummary(filter, fieldLabels, attrLabels, { incomplete: t('policy.unfinished'), and: t('policy.andShort'), or: t('policy.orShort'), dynamic: t('policy.dynamic') })
  const rows = [
    ...draft.rows.map((rule, index) => ({ kind: 'row' as const, index, name: rule.name || t('policy.rowRule', { n: index + 1 }), description: summary(rule.filter), subjects: rule.subjects,
      invalid: (saved.invalidRows ?? []).includes(index) && JSON.stringify(rule) === JSON.stringify(savedRows[index]) })),
    ...draft.columns.map((rule, index) => ({ kind: 'column' as const, index, name: rule.name || t('policy.columnRule', { n: index + 1 }), description: rule.fields.map((key) => fieldLabels.get(key) ?? key).join(t('policy.listSeparator')), subjects: rule.visibleTo, invalid: false })),
  ].filter((row) => (kind === 'all' || kind === row.kind) && `${row.name} ${row.description} ${row.subjects.map(subjectName).join(' ')}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
  const open = (type: 'row' | 'column', index = -1, copy = false) => {
    if (type === 'row') {
      const rule: RowDraft = index < 0 ? { name: t('policy.rowRule', { n: draft.rows.length + 1 }), subjects: [], filter: {} } : structuredClone(draft.rows[index]!)
      if (copy) rule.name = t('policy.copyName', { name: rule.name || t('policy.rowRule', { n: index + 1 }) })
      setEditing({ kind: type, index: copy ? -1 : index, rule, original: index < 0 || copy ? '' : JSON.stringify(rule) })
    } else {
      const rule: ColumnRule = index < 0 ? { name: t('policy.columnRule', { n: draft.columns.length + 1 }), fields: [], visibleTo: [] } : structuredClone(draft.columns[index]!)
      if (copy) rule.name = t('policy.copyName', { name: rule.name || t('policy.columnRule', { n: index + 1 }) })
      setEditing({ kind: type, index: copy ? -1 : index, rule, original: index < 0 || copy ? '' : JSON.stringify(rule) })
    }
  }
  const close = () => editorDirty ? setClosing(true) : setEditing(undefined)
  const apply = () => {
    if (!editing || editorUnfinished) return
    // Choose the restrictive scope when activating an empty policy, without
    // changing saved scopes or marking an untouched empty page as dirty.
    const next = !enabled && !savedEnabled ? { ...draft, unmatched: 'none' as const } : draft
    if (editing.kind === 'row') setDraft({ ...next, rows: editing.index < 0 ? [...draft.rows, editing.rule] : draft.rows.map((r, i) => i === editing.index ? editing.rule : r) })
    else setDraft({ ...next, columns: editing.index < 0 ? [...draft.columns, editing.rule] : draft.columns.map((r, i) => i === editing.index ? editing.rule : r) })
    setEditing(undefined)
  }
  const save = async () => {
    setSaving(true); setError(null)
    try {
      const next = await unwrap(api.PUT('/datasets/{id}/policy', { params: { path: { id: dataset.id } }, body: policy }))
      setSaved(next); setDraft(draftOf(next))
    } catch (e) { setError(toApiError(e)) } finally { setSaving(false) }
  }
  return <div className="stack policy-form">
    {enabled ? <>
    <section className="stack" aria-labelledby="policy-scope-title">
      <h3 id="policy-scope-title">{t('policy.scopeTitle')}</h3>
      <div className="policy-scope-row" role="group" aria-label={t('policy.rowType')}>
        <span className="note">{t('policy.rowType')}</span>
        <Radio checked={draft.unmatched === 'none'} onChange={() => setDraft({ ...draft, unmatched: 'none' })}>{t('policy.unmatchedNone')}</Radio>
        <Radio checked={draft.unmatched === 'all'} onChange={() => setDraft({ ...draft, unmatched: 'all' })}>{t('policy.unmatchedAll')}</Radio>
      </div>
      <div className="policy-scope-row" role="group" aria-label={t('policy.columnType')}>
        <span className="note">{t('policy.columnType')}</span>
        <Radio checked={columnMode === 'visible'} onChange={() => setDraft({ ...draft, columnMode: 'visible' })}>{t('policy.columnVisible')}</Radio>
        <Radio checked={columnMode === 'hidden'} onChange={() => setDraft({ ...draft, columnMode: 'hidden' })}>{t('policy.columnHidden')}</Radio>
      </div>
    </section>
    <section className="stack policy-details" aria-labelledby="policy-details-title">
      <div className="row policy-details-heading"><h3 id="policy-details-title">{t('policy.detailsTitle')}</h3><span className="note small">{t('policy.listHint')}</span></div>
      <div className="policy-toolbar">
        <Select<'all' | 'row' | 'column'> aria-label={t('policy.ruleType')} value={kind} onChange={setKind} options={[{ value: 'all', label: t('policy.allRules') }, { value: 'row', label: t('policy.rowsTitle') }, { value: 'column', label: t('policy.columnsTitle') }]} />
        <Input aria-label={t('policy.search')} placeholder={t('policy.search')} value={search} onChange={setSearch} clearable />
        <Button disabled={unfinished} onClick={() => setPreviewing(true)}>{t('policy.previewTitle')}</Button>
        <Button disabled={saving} variant="primary" icon={<Icon name="plus" />} onClick={() => open('row')}>{t('policy.addRule')}</Button>
      </div>
    <DataTable aria-label={t('policy.title')} rows={rows} rowKey={(row) => `${row.kind}:${row.index}`} pageSize={15} pageKey={`${kind}:${search}`}
      empty={<div className="policy-empty"><Icon name="dataset" size={30} /><strong>{t(search || kind !== 'all' ? 'policy.noResults' : 'policy.emptyTitle')}</strong>{(search || kind !== 'all') && <p className="note">{t('policy.searchHint')}</p>}</div>}
      columns={[
        { key: 'name', title: t('policy.ruleName'), render: (row) => <div className="policy-rule-name"><strong>{row.name}</strong>{row.invalid && <span className="policy-invalid small">{t('policy.invalidRule')}</span>}</div> },
        { key: 'kind', title: t('policy.ruleType'), render: (row) => <span className={`policy-badge policy-badge--${row.kind}`}>{t(row.kind === 'row' ? 'policy.rowType' : 'policy.columnType')}</span> },
        { key: 'rule', title: t('policy.ruleContent'), render: (row) => <span className="policy-rule-summary">{row.description}</span> },
        { key: 'subjects', title: t('policy.members'), render: (row) => <span className="policy-rule-summary" title={row.subjects.map(subjectName).join(t('policy.listSeparator'))}>{row.subjects.map((subject) => subject.user ? directory.users.find((user) => user.id === subject.user)?.displayName || subjectName(subject) : subjectName(subject)).join(t('policy.listSeparator')) || t('policy.noMembers')}</span> },
        { key: 'actions', title: t('common.actions'), render: (row) => <span className="policy-rule-actions">
          <Button size="sm" variant="ghost" disabled={saving} onClick={() => open(row.kind, row.index)}>{t('common.edit')}</Button>
          <Button size="sm" variant="ghost" disabled={saving} onClick={() => open(row.kind, row.index, true)}>{t('policy.copy')}</Button>
          <Button size="sm" variant="ghost" danger disabled={saving} onClick={() => setRemoving({ kind: row.kind, index: row.index })}>{t('common.delete')}</Button>
        </span> },
      ]} />
    </section>
    </> : <div className="policy-empty policy-disabled">
      <Icon name="dataset" size={48} />
      <strong>{t(savedEnabled ? 'policy.pendingDisableTitle' : 'policy.emptyTitle')}</strong>
      {savedEnabled && <p className="note">{t('policy.pendingDisableHint')}</p>}
      <Button variant="primary" disabled={saving} icon={<Icon name="plus" />} onClick={() => open('row')}>{t('policy.addRule')}</Button>
    </div>}
    {error && <ErrorAlert error={error} />}
    {(enabled || dirty) && <div className="policy-savebar row spread">
      <span className="note small" role="status">{unfinished ? t('policy.unfinished') : dirty ? null : saved.updatedAt ? t('policy.updatedAt', { time: new Date(saved.updatedAt).toLocaleString(i18n.language) }) : t('policy.noChanges')}</span>
      <div className="row">{dirty && <Button disabled={saving} variant="ghost" onClick={() => setDraft(draftOf(saved))}>{t('policy.discard')}</Button>}<Button variant="primary" loading={saving} disabled={!dirty || unfinished} onClick={() => void save()}>{t('common.save')}</Button></div>
    </div>}
    <Dialog open={!!editing} title={editing?.index === -1 ? t('policy.newRule') : t('policy.editRule')} width={840} onClose={close}
      actions={<><Button onClick={close}>{t('common.cancel')}</Button><Button variant="primary" disabled={!!editorUnfinished} onClick={apply}>{t('policy.applyRule')}</Button></>}>
      {editing && <div className="stack policy-rule-editor">
        <Field label={t('policy.ruleName')} htmlFor="policy-rule-name"><Input id="policy-rule-name" maxLength={100} value={editing.rule.name ?? ''} onChange={(name) => setEditing({ ...editing, rule: { ...editing.rule, name } } as Editing)} /></Field>
        <div className="row"><span className="note">{t('policy.ruleType')}</span>{editing.index < 0 ? <Segmented<'row' | 'column'> aria-label={t('policy.ruleType')} value={editing.kind} onChange={(type) => open(type)} options={[{ value: 'row', label: t('policy.rowType') }, { value: 'column', label: t('policy.columnType') }]} /> : <span className={`policy-badge policy-badge--${editing.kind}`}>{t(editing.kind === 'row' ? 'policy.rowType' : 'policy.columnType')}</span>}</div>
        {editing.kind === 'row' ? <>
          <section className="stack"><h4>{t('policy.ruleContent')}</h4>
            <PolicyCondition datasetId={dataset.id} fields={spec.fields} attributes={attributeList} filter={editing.rule.filter} onChange={(filter) => setEditing({ ...editing, rule: { ...editing.rule, filter: filter ?? {} } })} />
          </section>
          <section className="stack"><h4>{t('policy.members')}</h4><SubjectPicker wrap aria-label={t('policy.members')} directory={directory} value={editing.rule.subjects} onChange={(subjects) => setEditing({ ...editing, rule: { ...editing.rule, subjects } })} /></section>
        </> : <>
          <section className="stack"><h4>{t('policy.sensitiveFields')}</h4><MultiSelect<string> wrap aria-label={t('policy.sensitiveFields')} value={editing.rule.fields} options={spec.fields.map((f) => ({ value: f.key, label: f.label }))} onChange={(fields) => setEditing({ ...editing, rule: { ...editing.rule, fields } })} /></section>
          <section className="stack"><h4>{t('policy.members')}</h4><SubjectPicker wrap aria-label={t('policy.members')} directory={directory} value={editing.rule.visibleTo} onChange={(visibleTo) => setEditing({ ...editing, rule: { ...editing.rule, visibleTo } })} /></section>
        </>}
      </div>}
    </Dialog>
    <Dialog open={closing} title={t('policy.discard')} width={420} onClose={() => setClosing(false)} actions={<><Button onClick={() => setClosing(false)}>{t('common.cancel')}</Button><Button danger onClick={() => { setClosing(false); setEditing(undefined) }}>{t('policy.discard')}</Button></>}><p>{t('policy.discardRuleHint')}</p></Dialog>
    <Dialog open={!!removing} title={t('policy.deleteRule')} width={420} onClose={() => setRemoving(undefined)} actions={<><Button onClick={() => setRemoving(undefined)}>{t('common.cancel')}</Button><Button danger onClick={() => { if (removing) setDraft(removing.kind === 'row' ? { ...draft, rows: draft.rows.filter((_, i) => i !== removing.index) } : { ...draft, columns: draft.columns.filter((_, i) => i !== removing.index) }); setRemoving(undefined) }}>{t('common.delete')}</Button></>}><p>{t(draft.rows.length + draft.columns.length === 1 ? 'policy.deleteLastHint' : 'policy.deleteHint')}</p></Dialog>
    <Dialog open={previewing} title={t('policy.previewTitle')} width={640} onClose={() => setPreviewing(false)}>
      {previewing && <PreviewAs key={JSON.stringify(policy)} datasetId={dataset.id} spec={spec} directory={directory} policy={policy} />}
    </Dialog>
  </div>
}

function PolicyEditor({ dataset, onDirtyChange }: { dataset: Dataset; onDirtyChange?: (dirty: boolean) => void }) {
  const loaded = useAsync(async () => {
    const [policy, directory, attributes] = await Promise.all([
      unwrap(api.GET('/datasets/{id}/policy', { params: { path: { id: dataset.id } } })),
      loadDirectory(),
      unwrap(api.GET('/user-attributes')),
    ])
    return { policy, directory, attributes }
  }, [dataset.id])
  return (
    <div className="stack dataset-permissions">
      <Async state={loaded} reload={loaded.reload}>
        {({ policy, directory, attributes }) => <PolicyForm dataset={dataset} initial={policy} directory={directory} attributes={attributes} onDirtyChange={onDirtyChange} />}
      </Async>
    </div>
  )
}

/** Everyone who can edit a dataset can configure its data permissions. */
export function DatasetPermissions({ dataset, onDirtyChange }: { dataset: Dataset; onDirtyChange?: (dirty: boolean) => void }) {
  const canEdit = useSession().atLeast('developer')
  return canEdit ? <PolicyEditor key={dataset.id} dataset={dataset} onDirtyChange={onDirtyChange} /> : null
}
