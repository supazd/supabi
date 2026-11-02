import { Alert, Button, Field, Input, Select } from '@supabi/ui'
import { Fragment, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, Route, Routes, useNavigate, useParams } from 'react-router'
import { ApiError, api, unwrap, type Datasource, type DatasourceInput, type DatasourceType, type Schemas } from '../api/client'
import { toApiError, useAsync } from '../api/useAsync'
import { Async } from '../components/Async'
import { DatabaseLogo, databaseLabel } from '../components/DatabaseLogo'
import { ErrorAlert, useErrorText } from '../components/ErrorAlert'
import { FieldLabel } from '../components/FieldLabel'
import { Icon } from '../components/Icon'
import { lineageOf, withoutKinds } from '../lib/lineage'
import { timeZoneOptions } from '../lib/timeZones'
import { useWorkbench } from '../workbench/context'
import { SideList } from '../workbench/SideList'
import { BottomPanel, SidePanel, StatusItem, afterSave } from '../workbench/slots'
import { Usages } from '../workbench/Usages'
import { useAction } from './settings/shared'
import { NotFound } from './NotFound'

type SettingField = DatasourceType['settings'][number]
type TestState = { status: 'idle' } | { status: 'running' } | { status: 'ok' } | { status: 'failed'; message: string }

/** A setting is named in the user's language when we know it, else as its driver names it. */
function useSettingLabel() {
  const { t, i18n } = useTranslation()
  return (field: string) => (i18n.exists(`datasource.settings.${field}`) ? t(`datasource.settings.${field}`) : field)
}

/** Where a data source is, as one would say it: the host, the port and the database. */
function addressOf(source: Datasource): string {
  const { host, port, database } = source.settings
  return `${host ?? ''}${host && port ? `:${port}` : ''}${database ? `/${database}` : ''}`
}

// The settings are the driver's to name, so they are put in their part of the
// form by what can be told of them: who connects, and what is a choice
// between ways of connecting rather than where to connect.
const partOf = (field: SettingField) => (field.name === 'user' ? 'account' : field.options ? 'advanced' : 'connection')

/** One part of the form: what it is about on the left, its fields on the right. */
type CacheMode = 'default' | 'off' | 'custom'

function cacheModeOf(seconds: number | undefined): CacheMode {
  if (seconds === undefined) return 'default'
  return seconds === 0 ? 'off' : 'custom'
}

/** A whole number within bounds, or undefined when the text is not one. */
function wholeNumber(text: string, min: number, max: number): number | undefined {
  if (!/^\d+$/.test(text.trim())) return undefined
  const n = Number(text)
  return n >= min && n <= max ? n : undefined
}

function FormPart({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="form-part">
      <div className="form-part-head">
        <h2>{title}</h2>
        {hint && <p className="note small">{hint}</p>}
      </div>
      <div className="form-grid">{children}</div>
    </section>
  )
}

/** What a failed connection test says: a failure the server recognised in the reader's language, any other as the database put it. */
function useTestFailure() {
  const { t, i18n } = useTranslation()
  return (result: Schemas['ConnectionTest']) => {
    const key = `datasource.testErrors.${result.code}`
    return result.code && i18n.exists(key) ? t(key, result.params ?? {}) : result.message ?? ''
  }
}

/** The form of a new data source of one kind, or of an existing one being changed. */
function DatasourceForm({ definition, existing, onSaved, onCancel }: { definition: DatasourceType; existing?: Datasource; onSaved: (saved: Datasource) => void; onCancel: () => void }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const testFailure = useTestFailure()
  const settingLabel = useSettingLabel()
  const [name, setName] = useState(existing?.name ?? '')
  const [settings, setSettings] = useState<Record<string, string>>(existing?.settings ?? {})
  const [password, setPassword] = useState('')
  const [dataTimezone, setDataTimezone] = useState(() => existing?.dataTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)
  const [cacheMode, setCacheMode] = useState<CacheMode>(() => cacheModeOf(existing?.cacheTtlSeconds))
  // A time set through the API need not be whole minutes; it is kept as it is unless the minutes are changed.
  const [shownMinutes] = useState(() => (existing?.cacheTtlSeconds ? String(Math.round(existing.cacheTtlSeconds / 60)) : '10'))
  const [cacheMinutes, setCacheMinutes] = useState(shownMinutes)
  const [maxConcurrent, setMaxConcurrent] = useState(() => (existing?.maxConcurrentQueries ? String(existing.maxConcurrentQueries) : ''))
  const [test, setTest] = useState<TestState>({ status: 'idle' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const zoneOptions = useMemo(() => timeZoneOptions(dataTimezone), [dataTimezone])

  const minutes = wholeNumber(cacheMinutes, 1, 1440)
  const concurrent = maxConcurrent.trim() === '' ? undefined : wholeNumber(maxConcurrent, 1, 64)
  const queryInvalid = (cacheMode === 'custom' && minutes === undefined) || (maxConcurrent.trim() !== '' && concurrent === undefined)
  const input = (): DatasourceInput => ({
    name,
    type: definition.name,
    settings,
    password: password || undefined,
    dataTimezone,
    // An invalid number is sent as it is, so the server says what is wrong with it.
    ...(cacheMode === 'off'
      ? { cacheTtlSeconds: 0 }
      : cacheMode === 'custom'
        ? { cacheTtlSeconds: cacheMinutes === shownMinutes && existing?.cacheTtlSeconds ? existing.cacheTtlSeconds : (minutes ?? Number(cacheMinutes)) * 60 }
        : {}),
    ...(maxConcurrent.trim() !== '' ? { maxConcurrentQueries: concurrent ?? Number(maxConcurrent) } : {}),
  })
  // What a test said is about the settings it tried, and no longer holds once they change.
  const changing =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value)
      setTest({ status: 'idle' })
    }

  const runTest = async () => {
    setTest({ status: 'running' })
    try {
      // The name is irrelevant to a connection test but required by the API.
      const body = { ...input(), name: name || 'test' }
      const result = await unwrap(existing ? api.POST('/datasources/{id}/test', { params: { path: { id: existing.id } }, body }) : api.POST('/datasources/test', { body }))
      setTest(result.ok ? { status: 'ok' } : { status: 'failed', message: testFailure(result) })
    } catch (e) {
      setTest({ status: 'failed', message: errorText(toApiError(e)) })
    }
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      onSaved(await unwrap(existing ? api.PUT('/datasources/{id}', { params: { path: { id: existing.id } }, body: input() }) : api.POST('/datasources', { body: input() })))
    } catch (e) {
      setError(toApiError(e))
      setSaving(false)
    }
  }

  const fields = (part: ReturnType<typeof partOf>) =>
    definition.settings
      .filter((field) => partOf(field) === part)
      .map((field) => {
        const id = `ds-setting-${field.name}`
        const value = settings[field.name] ?? ''
        const set = changing((next: string) => setSettings((current) => ({ ...current, [field.name]: next })))
        return (
          <Field key={field.name} label={settingLabel(field.name)} htmlFor={id} required={field.required}>
            {field.options ? (
              <Select id={id} block value={value || field.default} options={field.options.map((option) => ({ value: option, label: option }))} onChange={set} />
            ) : (
              <Input id={id} value={value} onChange={set} placeholder={field.default} />
            )}
          </Field>
        )
      })

  return (
    <form
      className="form-parts"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <FormPart title={t('datasource.parts.basic')}>
        <Field label={t('common.name')} htmlFor="ds-name" required>
          <Input id="ds-name" value={name} onChange={setName} />
        </Field>
      </FormPart>
      <FormPart title={t('datasource.parts.connection')}>
        {fields('connection')}
      </FormPart>
      <FormPart title={t('datasource.parts.account')} hint={t('datasource.readOnlyHint')}>
        {fields('account')}
        <Field label={<FieldLabel label={t('datasource.password')} hint={existing?.hasPassword ? t('datasource.passwordKeep') : t('datasource.passwordHint')} />} htmlFor="ds-password">
          <Input id="ds-password" aria-label={t('datasource.password')} type="password" value={password} onChange={changing(setPassword)} placeholder={existing?.hasPassword ? '••••••••' : undefined} />
        </Field>
      </FormPart>
      <FormPart title={t('datasource.parts.advanced')}>
        {fields('advanced')}
        <Field label={<FieldLabel label={t('datasource.dataTimezone')} hint={t('datasource.dataTimezoneHint')} />} htmlFor="ds-timezone">
          <Select id="ds-timezone" aria-label={t('datasource.dataTimezone')} block search value={dataTimezone} options={zoneOptions} onChange={changing(setDataTimezone)} />
        </Field>
      </FormPart>
      <FormPart title={t('datasource.parts.query')}>
        <Field label={<FieldLabel label={t('datasource.cache')} hint={t('datasource.cacheHint')} />} htmlFor="ds-cache">
          <Select<CacheMode> id="ds-cache" aria-label={t('datasource.cache')} block value={cacheMode} options={(['default', 'off', 'custom'] as const).map((value) => ({ value, label: t(`datasource.cacheModes.${value}`) }))} onChange={setCacheMode} />
        </Field>
        {cacheMode === 'custom' && (
          <Field label={t('datasource.cacheMinutes')} htmlFor="ds-cache-minutes" hint={minutes === undefined ? t('errors.invalid_cache_ttl') : t('datasource.cacheMinutesHint')}>
            <Input id="ds-cache-minutes" value={cacheMinutes} onChange={setCacheMinutes} invalid={minutes === undefined} />
          </Field>
        )}
        <Field label={<FieldLabel label={t('datasource.maxConcurrent')} hint={t('datasource.maxConcurrentHint')} />} htmlFor="ds-max-concurrent" hint={maxConcurrent.trim() !== '' && concurrent === undefined ? t('errors.invalid_max_concurrent_queries') : undefined}>
          <Input id="ds-max-concurrent" aria-label={t('datasource.maxConcurrent')} value={maxConcurrent} onChange={setMaxConcurrent} placeholder="8" invalid={maxConcurrent.trim() !== '' && concurrent === undefined} />
        </Field>
      </FormPart>
      {test.status === 'failed' && (
        <Alert tone="error" title={t('datasource.testFailed')}>
          {test.message}
        </Alert>
      )}
      {error && <ErrorAlert error={error} />}
      <div className="row form-actions">
        <Button variant="primary" type="submit" loading={saving} disabled={queryInvalid}>
          {saving ? t('common.saving') : t('common.save')}
        </Button>
        <Button onClick={() => void runTest()} loading={test.status === 'running'}>
          {test.status === 'running' ? t('datasource.testing') : t('datasource.test')}
        </Button>
        {test.status === 'ok' && (
          <span className="health ok" role="status">
            {t('datasource.testOk')}
          </span>
        )}
        <span className="spacer" />
        <Button variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  )
}

/** Deleting takes two clicks, the second on a differently labelled button. `note` is what to know before the second. */
export function DeleteButton({ onDelete, note }: { onDelete: () => Promise<void>; note?: ReactNode }) {
  const { t } = useTranslation()
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!armed) {
    return (
      <Button size="sm" variant="ghost" danger onClick={() => setArmed(true)}>
        {t('common.delete')}
      </Button>
    )
  }
  return (
    <span className="row">
      {note && <span className="delete-note small">{note}</span>}
      <Button
        size="sm"
        danger
        loading={busy}
        onClick={() => {
          setBusy(true)
          void onDelete().finally(() => {
            setBusy(false)
            setArmed(false)
          })
        }}
      >
        {t('common.confirmDelete')}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setArmed(false)}>
        {t('common.cancel')}
      </Button>
    </span>
  )
}

/** The tables of a data source and their columns, to be looked through before writing SQL against them. */
function Schema({ source }: { source: Datasource }) {
  const { t } = useTranslation()
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const catalog = useAsync(() => unwrap(api.GET('/datasources/{id}/tables', { params: { path: { id: source.id } } })), [source.id, source.updatedAt])
  const wanted = filter.trim().toLowerCase()
  const has = (text: string) => text.toLowerCase().includes(wanted)
  // What was looked for is marked where it was found.
  const marked = (text: string) => {
    const at = wanted ? text.toLowerCase().indexOf(wanted) : -1
    return at < 0 ? (
      text
    ) : (
      <>
        {text.slice(0, at)}
        <mark>{text.slice(at, at + wanted.length)}</mark>
        {text.slice(at + wanted.length)}
      </>
    )
  }
  return (
    <section className="card stack" aria-labelledby="source-tables">
      <Async state={catalog} reload={catalog.reload}>
        {(found) => {
          const keyOf = (table: (typeof found.tables)[number]) => [...table.path, table.name].join('.')
          const groupOf = (table: (typeof found.tables)[number]) => table.path.join('.')
          const tables = found.tables.filter((table) => !wanted || has(table.name) || table.columns.some((column) => has(column.name)))
          const grouped = new Set(found.tables.map(groupOf)).size > 1
          const groups = new Map<string, typeof tables>()
          for (const table of tables) groups.set(grouped ? groupOf(table) : '', [...(groups.get(grouped ? groupOf(table) : '') ?? []), table])
          const allOpen = tables.length > 0 && tables.every((table) => open.has(keyOf(table)))
          return (
            <>
              <StatusItem>{t('workbench.tableCount', { count: found.tables.length })}</StatusItem>
              <div className="row spread">
                <h2 id="source-tables">
                  {t('workbench.schema')} <span className="muted-inline small">{t('workbench.tableCount', { count: found.tables.length })}</span>
                </h2>
                <div className="row nowrap">
                  {!wanted && tables.length > 0 && (
                    <Button size="sm" variant="ghost" onClick={() => setOpen(allOpen ? new Set() : new Set(tables.map(keyOf)))}>
                      {allOpen ? t('workbench.collapseAll') : t('workbench.expandAll')}
                    </Button>
                  )}
                  <div style={{ width: 240 }}>
                    <Input size="sm" aria-label={t('workbench.filterTables')} placeholder={t('workbench.filterTables')} value={filter} onChange={setFilter} />
                  </div>
                </div>
              </div>
              {tables.length === 0 ? (
                <p className="empty">{wanted ? t('workbench.noMatches') : t('workbench.noTables')}</p>
              ) : (
                <div className="schema-list">
                  {[...groups].map(([group, members]) => (
                    <div key={group} className="schema-group">
                      {grouped && (
                        <h3>
                          <Icon name="schema" size={14} />
                          {group} <span className="muted-inline small">{members.length}</span>
                        </h3>
                      )}
                      {members.map((table) => {
                        const key = keyOf(table)
                        // While looking for something, a table shows its columns when one of them is what was found.
                        const shown = wanted ? table.columns.some((column) => has(column.name)) : open.has(key)
                        const toggle = () =>
                          setOpen((current) => {
                            const next = new Set(current)
                            if (!next.delete(key)) next.add(key)
                            return next
                          })
                        return (
                          <div key={key} className="schema-table">
                            <button type="button" className="schema-table-head" aria-expanded={shown} disabled={Boolean(wanted)} onClick={toggle}>
                              <Icon name={shown ? 'chevronDown' : 'chevronRight'} size={12} />
                              <Icon name="table" />
                              <span className="schema-table-name">{marked(grouped ? table.name : [table.catalog, table.schema, table.name].filter(Boolean).join('.'))}</span>
                              {table.comment && <span className="schema-comment small">{table.comment}</span>}
                              <span className="spacer" />
                              <span className="muted-inline small">{t('workbench.columnCount', { count: table.columns.length })}</span>
                            </button>
                            {shown && (
                              <ul>
                                {table.columns.map((column) => (
                                  <li key={column.name}>
                                    <code>{marked(column.name)}</code>
                                    <span className="muted-inline small">{column.dbType}</span>
                                    <span className="schema-comment small">{column.comment}</span>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  ))}
                  {found.truncated && <p className="note small">{t('workbench.schemaTruncated')}</p>}
                </div>
              )}
            </>
          )
        }}
      </Async>
    </section>
  )
}

/** One data source: how it connects, whether it does, what it holds, what reads it. */
function Detail() {
  const { t, i18n } = useTranslation()
  const { id } = useParams()
  const navigate = useNavigate()
  const { resources, loaded, reload } = useWorkbench()
  const action = useAction()
  const testFailure = useTestFailure()
  const settingLabel = useSettingLabel()
  const source = resources.datasources.find((item) => item.id === id)
  const health = useAsync(() => (source ? unwrap(api.POST('/datasources/{id}/test', { params: { path: { id: source.id } } })) : Promise.resolve(null)), [source?.id, source?.updatedAt])
  const lineage = useAsync(() => (source ? unwrap(api.GET('/lineage')) : Promise.resolve(null)), [source?.id])

  if (!loaded) return <p className="muted">{t('common.loading')}</p>
  if (!source) return <NotFound />
  // Its tables are part of it, not something that reads it.
  const readers = lineage.status === 'ok' && lineage.data ? lineageOf(withoutKinds(lineage.data, new Set(['table'])), source.id).downstream.size : 0
  const failure = health.status === 'error' ? health.error.message : health.status === 'ok' && health.data && !health.data.ok ? testFailure(health.data) : null
  const others = Object.entries(source.settings).filter(([name]) => name !== 'host' && name !== 'port')
  return (
    <div className="wb-page">
      <header className="editor-header">
        <DatabaseLogo type={source.type} size={24} />
        <h1 className="page-title">{source.name}</h1>
        <span className="chip">{databaseLabel(source.type)}</span>
        {health.status === 'loading' ? (
          <span className="health" role="status">
            {t('datasource.health.checking')}
          </span>
        ) : (
          <span className={failure === null ? 'health ok' : 'health failed'} role="status">
            {failure === null ? t('datasource.health.ok') : t('datasource.health.failed')}
          </span>
        )}
        <span className="spacer" />
        <Link target="_blank" rel="noopener noreferrer" to={`/explore?datasource=${source.id}`}>
          <Button icon={<Icon name="explore" />}>{t('workbench.queryIt')}</Button>
        </Link>
        <Button icon={<Icon name="refresh" />} loading={health.status === 'loading'} onClick={health.reload}>
          {t('datasource.health.retest')}
        </Button>
        <Link to={`/workbench/datasources/${source.id}/edit`}>
          <Button>{t('common.edit')}</Button>
        </Link>
        <DeleteButton
          note={readers > 0 ? t('datasource.inUse', { count: readers }) : undefined}
          onDelete={() => action.run(() => unwrap(api.DELETE('/datasources/{id}', { params: { path: { id: source.id } } })), () => void reload().then(() => navigate('/workbench/datasources', { state: afterSave })))}
        />
      </header>
      {action.error && <ErrorAlert error={action.error} />}
      {failure !== null && (
        <Alert tone="error" title={t('datasource.testFailed')}>
          {failure}
        </Alert>
      )}
      <section className="card">
        <dl className="facts">
          <dt>{t('datasource.address')}</dt>
          <dd>
            <code>{`${source.settings.host ?? ''}${source.settings.port ? `:${source.settings.port}` : ''}`}</code>
          </dd>
          {others.map(([name, value]) => (
            <Fragment key={name}>
              <dt>{settingLabel(name)}</dt>
              <dd>{value}</dd>
            </Fragment>
          ))}
          <dt>{t('datasource.password')}</dt>
          <dd>{source.hasPassword ? t('datasource.passwordSet') : t('datasource.passwordNone')}</dd>
          <dt>{t('datasource.dataTimezone')}</dt>
          <dd>{source.dataTimezone}</dd>
          <dt>{t('datasource.cache')}</dt>
          <dd>
            {source.cacheTtlSeconds === undefined
              ? t('datasource.cacheModes.default')
              : source.cacheTtlSeconds === 0
                ? t('datasource.cacheModes.off')
                : source.cacheTtlSeconds % 60
                  ? t('datasource.cacheSecondsValue', { count: source.cacheTtlSeconds })
                  : t('datasource.cacheMinutesValue', { count: source.cacheTtlSeconds / 60 })}
          </dd>
          <dt>{t('datasource.maxConcurrent')}</dt>
          <dd>{source.maxConcurrentQueries ?? t('datasource.maxConcurrentDefault')}</dd>
          <dt>{t('common.updatedAt')}</dt>
          <dd>{new Date(source.updatedAt).toLocaleString(i18n.language)}</dd>
        </dl>
      </section>
      <Schema source={source} />
      <BottomPanel tabs={[{ key: 'usages', label: t('workbench.usages'), content: <Usages kind="datasource" id={source.id} /> }]} />
    </div>
  )
}

const categories = ['oltp', 'olap'] as const

/** The first step of adding a data source: which kind of database it is. */
function ChooseType() {
  const { t } = useTranslation()
  const types = useAsync(() => unwrap(api.GET('/datasource-types')), [])
  return (
    <div className="wb-page">
      <header className="editor-header">
        <h1 className="page-title">{t('datasource.add')}</h1>
        <span className="muted-inline">{t('datasource.chooseType')}</span>
      </header>
      <Async state={types} reload={types.reload}>
        {(loaded) =>
          categories.map((category) => {
            const members = loaded.filter((type) => type.category === category).sort((a, b) => databaseLabel(a.name).localeCompare(databaseLabel(b.name)))
            return members.length === 0 ? null : (
              <section key={category} className="db-category" aria-labelledby={`db-category-${category}`}>
                <h2 id={`db-category-${category}`}>{t(`datasource.categories.${category}.name`)}</h2>
                <p className="note small">{t(`datasource.categories.${category}.hint`)}</p>
                <div className="db-cards">
                  {members.map((type) => (
                    <Link key={type.name} to={`/workbench/datasources/new/${type.name}`} className="db-card">
                      <DatabaseLogo type={type.name} size={36} />
                      <span>{databaseLabel(type.name)}</span>
                    </Link>
                  ))}
                </div>
              </section>
            )
          })
        }
      </Async>
    </div>
  )
}

/** The second step: how a database of the chosen kind is connected to. */
function Create() {
  const { t } = useTranslation()
  const { type } = useParams()
  const navigate = useNavigate()
  const { reload } = useWorkbench()
  const types = useAsync(() => unwrap(api.GET('/datasource-types')), [])
  return (
    <Async state={types} reload={types.reload}>
      {(loaded) => {
        const definition = loaded.find((item) => item.name === type)
        if (!definition) return <NotFound />
        return (
          <div className="wb-page">
            <header className="editor-header">
              <DatabaseLogo type={definition.name} size={24} />
              <h1 className="page-title">{t('datasource.addOf', { type: databaseLabel(definition.name) })}</h1>
              <span className="spacer" />
              <Link to="/workbench/datasources/new">
                <Button variant="ghost">{t('datasource.changeType')}</Button>
              </Link>
            </header>
            <DatasourceForm definition={definition} onCancel={() => void navigate('/workbench/datasources')} onSaved={(created) => void reload().then(() => navigate(`/workbench/datasources/${created.id}`, { state: afterSave }))} />
          </div>
        )
      }}
    </Async>
  )
}

/** Changing how an existing data source connects. */
function Edit() {
  const { t } = useTranslation()
  const { id } = useParams()
  const navigate = useNavigate()
  const { resources, loaded, reload } = useWorkbench()
  const types = useAsync(() => unwrap(api.GET('/datasource-types')), [])
  const source = resources.datasources.find((item) => item.id === id)
  if (!loaded) return <p className="muted">{t('common.loading')}</p>
  if (!source) return <NotFound />
  const back = () => navigate(`/workbench/datasources/${source.id}`, { state: afterSave })
  return (
    <Async state={types} reload={types.reload}>
      {(found) => {
        const definition = found.find((item) => item.name === source.type)
        if (!definition) return <NotFound />
        return (
          <div className="wb-page">
            <header className="editor-header">
              <DatabaseLogo type={source.type} size={24} />
              <h1 className="page-title">{source.name}</h1>
              <span className="chip">{databaseLabel(source.type)}</span>
            </header>
            <DatasourceForm key={source.id} definition={definition} existing={source} onCancel={() => void back()} onSaved={() => void reload().then(back)} />
          </div>
        )
      }}
    </Async>
  )
}

/** Every data source of the workspace at a glance, or the way to the first one. */
function Overview() {
  const { t } = useTranslation()
  const { resources } = useWorkbench()
  const add = (
    <Link to="/workbench/datasources/new">
      <Button variant="primary" icon={<Icon name="plus" />}>
        {t('datasource.add')}
      </Button>
    </Link>
  )
  if (resources.datasources.length === 0) {
    return (
      <div className="wb-landing">
        <Icon name="database" size={40} />
        <p>{t('workbench.landing.datasources')}</p>
        {add}
      </div>
    )
  }
  return (
    <div className="wb-page">
      <header className="editor-header">
        <h1 className="page-title">{t('workbench.sections.datasources')}</h1>
        <span className="spacer" />
        {add}
      </header>
      <div className="db-cards wide">
        {resources.datasources.map((source) => (
          <Link key={source.id} to={`/workbench/datasources/${source.id}`} className="db-card source">
            <DatabaseLogo type={source.type} size={32} />
            <span className="db-card-text">
              <strong>{source.name}</strong>
              <span className="note small">{`${databaseLabel(source.type)} · ${addressOf(source)}`}</span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  )
}

/** Data sources: the connections everything else reads through. */
export function DatasourcesSection() {
  const { t } = useTranslation()
  const { resources } = useWorkbench()
  return (
    <>
      <SidePanel>
        <SideList
          section="datasources"
          icon="database"
          newPath="/workbench/datasources/new"
          newLabel={t('datasource.add')}
          empty={t('datasource.empty')}
          items={resources.datasources.map((item) => ({ id: item.id, name: item.name, icon: <DatabaseLogo type={item.type} /> }))}
        />
      </SidePanel>
      <Routes>
        <Route index element={<Overview />} />
        <Route path="new" element={<ChooseType />} />
        <Route path="new/:type" element={<Create />} />
        <Route path=":id" element={<Detail />} />
        <Route path=":id/edit" element={<Edit />} />
      </Routes>
    </>
  )
}
