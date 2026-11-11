import { Alert, Button, CodeEditor, DataTable, Segmented, Select, Tooltip } from '@supabi/ui'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, unwrap, type Datasource, type Schemas } from '../../api/client'
import { toWrittenExpr, type DatasetSpec } from '../../api/spec'
import { toApiError, useAsync } from '../../api/useAsync'
import { Async } from '../../components/Async'
import { ErrorAlert } from '../../components/ErrorAlert'
import { compactTime } from '../../lib/compactTime'
import { diffLines, revisionChanges, type Revision } from '../../lib/datasetHistory'
import './datasetHistory.css'

type Page = Schemas['RevisionPage']
type Props = { datasetId: string; currentRevision: number; datasources: Datasource[]; busy: boolean; onRestore: (revision: Revision) => void }
const readRevision = (id: string, revision: number) => unwrap(api.GET('/datasets/{id}/revisions/{revision}', { params: { path: { id, revision } } }))

/** Saved values use the same field names people see in the editor. */
function Value({ value, property = '', revision }: { value: unknown; property?: string; revision: Revision }) {
  const { t } = useTranslation()
  if (value === undefined || value === null || value === '') return <span className="muted-inline">—</span>
  if (typeof value === 'boolean') return <>{t(`dataset.history.${value ? 'yes' : 'no'}`)}</>
  if (Array.isArray(value)) return <>{value.map((item, i) => <span key={i}>{i > 0 && ' · '}<Value value={item} property={property} revision={revision} /></span>)}</>
  if (typeof value === 'object') return <dl className="revision-properties">{Object.entries(value).filter(([key]) => key !== 'key').map(([key, item]) => <div key={key}><dt>{t(`dataset.history.properties.${key}`, { defaultValue: key })}</dt><dd><Value value={item} property={key} revision={revision} /></dd></div>)}</dl>
  if (property === 'expr') return <code>{toWrittenExpr(String(value), (revision.spec as DatasetSpec).fields)}</code>
  if (property === 'role') return <>{t(`dataset.roles.${String(value)}`, { defaultValue: String(value) })}</>
  if (property === 'type') return <>{t(`dataset.types.${String(value)}`, { defaultValue: String(value) })}</>
  if (property === 'datasourceId') return <>{revision.datasourceName}</>
  return <>{String(value)}</>
}

function Definition({ revision }: { revision: Revision }) {
  const { t } = useTranslation()
  const spec = revision.spec as DatasetSpec
  const params = (spec.params ?? []) as Record<string, unknown>[]
  const settings = Object.fromEntries(Object.entries(spec).filter(([key]) => !['source', 'params', 'fields', 'specVersion'].includes(key)))
  return <div className="revision-definition">
    <Value revision={revision} value={{ name: revision.name, description: revision.description, datasourceId: revision.datasourceId }} />
    <section><h3>{t('dataset.history.source')}</h3>
      {spec.source.type === 'sql' ? <CodeEditor aria-label={t('dataset.history.savedSql')} disabled lineNumbers minLines={4} maxLines={18} value={spec.source.sql ?? ''} onChange={() => undefined} /> : <Value revision={revision} value={spec.source} />}
    </section>
    <section><h3>{t('dataset.history.parameters', { count: params.length })}</h3>
      {params.length ? <div className="revision-entries">{params.map((param) => <details key={String(param.name)}><summary>{String(param.label || param.name)}</summary><Value revision={revision} value={param} /></details>)}</div> : <p className="note small">{t('dataset.history.noParameters')}</p>}
    </section>
    <section><h3>{t('dataset.history.fields', { count: spec.fields.length })}</h3>
      <DataTable rows={spec.fields} rowKey={(f) => f.key} pageSize={20} pageKey={revision} columns={[
        { key: 'name', title: t('dataset.label'), render: (f) => f.label },
        { key: 'source', title: t('dataset.history.source'), render: (f) => f.column ?? <Value revision={revision} property="expr" value={f.expr} /> },
        { key: 'type', title: t('dataset.type'), render: (f) => <Value revision={revision} property="type" value={f.type} /> },
        { key: 'role', title: t('dataset.role'), render: (f) => <Value revision={revision} property="role" value={f.role} /> },
        { key: 'details', title: t('dataset.history.attributes'), render: (f) => <details><summary>{t('dataset.history.attributes')}</summary><Value revision={revision} value={f} /></details> },
      ]} />
    </section>
    {Object.keys(settings).length > 0 && <section><h3>{t('dataset.history.settings')}</h3><Value revision={revision} value={settings} /></section>}
  </div>
}

function Comparison({ left, right }: { left: Revision; right: Revision }) {
  const { t } = useTranslation()
  const [before, after] = left.revision < right.revision ? [left, right] : [right, left]
  const changes = useMemo(() => revisionChanges(before, after), [before, after])
  const oldSQL = (before.spec as DatasetSpec).source.sql ?? '', newSQL = (after.spec as DatasetSpec).source.sql ?? ''
  const lines = useMemo(() => diffLines(oldSQL, newSQL), [oldSQL, newSQL])
  return <div className="revision-comparison">
    <p className="note">{t('dataset.history.direction', { before: before.revision, after: after.revision })}</p>
    {oldSQL === newSQL && changes.length === 0 && <p className="empty">{t('dataset.history.identical')}</p>}
    {oldSQL !== newSQL && <section><h3>{t('dataset.sql')}</h3><div className="revision-sql-diff"><table aria-label={t('dataset.history.sqlDiff')}><tbody>{lines.map((line, index) => <tr key={index} className={line.kind}>
      <td className="line-number">{line.before}</td><td className="line-number">{line.after}</td><td className="diff-sign" aria-label={t(`dataset.history.line.${line.kind}`)}>{line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}</td><td><pre>{line.text || ' '}</pre></td>
    </tr>)}</tbody></table></div></section>}
    {changes.length > 0 && <section><h3>{t('dataset.history.definitionChanges')}</h3><div className="revision-changes"><table><thead><tr>
      <th>{t('dataset.history.change')}</th><th>{t('dataset.history.version', { revision: before.revision })}</th><th>{t('dataset.history.version', { revision: after.revision })}</th>
    </tr></thead><tbody>{changes.map((change, index) => <tr key={index}>
      <th scope="row"><span>{t(`dataset.history.sections.${change.section}`)}{change.name && ` · ${change.name}`}</span><small>{t(`dataset.history.properties.${change.property}`, { defaultValue: change.property })}</small></th>
      <td><Value revision={before} property={change.property} value={change.before} /></td><td><Value revision={after} property={change.property} value={change.after} /></td>
    </tr>)}</tbody></table></div></section>}
  </div>
}

function RevisionView({ selected, compare, mode, ...props }: Props & { selected: number; compare: number; mode: 'view' | 'compare' }) {
  const { t, i18n } = useTranslation()
  const loaded = useAsync(async () => {
    const [revision, other] = await Promise.all([readRevision(props.datasetId, selected), mode === 'compare' && compare !== selected ? readRevision(props.datasetId, compare) : Promise.resolve(undefined)])
    return { revision, other }
  }, [props.datasetId, selected, compare, mode])
  return <Async state={loaded} reload={loaded.reload}>{({ revision, other }) => <>
    <div className="revision-actions"><div>
      <h3>{t('dataset.history.version', { revision: revision.revision })}</h3>
      <p className="revision-metadata"><time dateTime={revision.createdAt}>{new Date(revision.createdAt).toLocaleString(i18n.language)}</time><span>·</span><span>{revision.createdByName || t('dataset.history.system')}</span></p>
    </div><Button disabled={props.busy} onClick={() => props.onRestore(revision)}>{t('dataset.history.restore')}</Button></div>
    <p className="note small">{t('dataset.history.restoreHint')}</p>
    {!props.datasources.some((source) => source.id === revision.datasourceId) && <Alert tone="warning" title={t('dataset.history.sourceMissing', { name: revision.datasourceName })} />}
    {mode === 'compare' ? <Comparison left={revision} right={other ?? revision} /> : <Definition revision={revision} />}
  </>}</Async>
}

function HistoryList({ initial, ...props }: Props & { initial: Page }) {
  const { t, i18n } = useTranslation()
  const [page, setPage] = useState(initial)
  const [selected, setSelected] = useState(initial.items[0]?.revision ?? props.currentRevision)
  const [compare, setCompare] = useState(initial.items[1]?.revision ?? selected)
  const [mode, setMode] = useState<'view' | 'compare'>('view')
  const [more, setMore] = useState(false)
  const [error, setError] = useState<ReturnType<typeof toApiError>>()
  const loadMore = async () => {
    setMore(true); setError(undefined)
    try {
      const next = await unwrap(api.GET('/datasets/{id}/revisions', { params: { path: { id: props.datasetId }, query: { before: page.nextBefore } } }))
      setPage((current) => ({ items: [...current.items, ...next.items], nextBefore: next.nextBefore }))
    } catch (error) { setError(toApiError(error)) } finally { setMore(false) }
  }
  if (!page.items.length) return <p className="empty">{t('dataset.history.empty')}</p>
  return <div className="dataset-history">
    <aside className="revision-list" aria-label={t('dataset.history.versions')}>
      <h3 className="revision-list-title">{t('dataset.history.versions')}</h3>
      {page.items.map((revision) => {
        const date = new Date(revision.createdAt)
        const details = `${date.toLocaleString(i18n.language)} · ${revision.createdByName || t('dataset.history.system')}`
        const current = revision.revision === initial.items[0]?.revision
        const label = `${t('dataset.history.version', { revision: revision.revision })} · ${details}${current ? ` · ${t('dataset.history.current')}` : ''}`
        return <Tooltip key={revision.revision} title={details} placement="right"><button type="button" aria-label={label} aria-pressed={selected === revision.revision} onClick={() => { if (compare === revision.revision) setCompare(selected); setSelected(revision.revision) }}>
          <span className="revision-label">v{revision.revision}</span>
          <time className="revision-time" dateTime={revision.createdAt}>{compactTime(date)}</time>
          {current && <small className="revision-current">{t('dataset.history.current')}</small>}
        </button></Tooltip>
      })}
      {error && <ErrorAlert error={error} />}
      {page.nextBefore && <Button loading={more} onClick={() => void loadMore()}>{t('dataset.history.loadMore')}</Button>}
    </aside>
    <div className="revision-content">
      <div className="revision-toolbar"><Segmented value={mode} onChange={setMode} options={[{ value: 'view', label: t('dataset.history.view') }, { value: 'compare', label: t('dataset.history.compare') }]} />
        {mode === 'compare' && <Select<number> aria-label={t('dataset.history.compareWith')} value={compare} options={page.items.map((r) => ({ value: r.revision, label: t('dataset.history.version', { revision: r.revision }) }))} onChange={setCompare} />}
      </div>
      <RevisionView key={`${selected}:${compare}:${mode}`} {...props} selected={selected} compare={compare} mode={mode} />
    </div>
  </div>
}

export function DatasetHistory(props: Props) {
  const loaded = useAsync(() => unwrap(api.GET('/datasets/{id}/revisions', { params: { path: { id: props.datasetId } } })), [props.datasetId, props.currentRevision])
  return <Async state={loaded} reload={loaded.reload}>{(page) => <HistoryList key={`${props.datasetId}:${props.currentRevision}`} {...props} initial={page} />}</Async>
}
