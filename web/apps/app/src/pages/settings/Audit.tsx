import { Alert, Button, CodeEditor, DataTable, DateRangeInput, Dialog, Select } from '@supabi/ui'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { api, unwrap, type AuditCategory, type AuditEvent, type AuditOutcome } from '../../api/client'
import { useAsync } from '../../api/useAsync'
import { Async } from '../../components/Async'
import { ErrorAlert } from '../../components/ErrorAlert'
import { dayStart, SettingsPage, useAction } from './shared'
import './audit.css'

const categories: AuditCategory[] = ['auth', 'account', 'workspace', 'access', 'content', 'query', 'export', 'ai', 'system']
const outcomes: AuditOutcome[] = ['success', 'failure', 'denied']

interface Filters {
  /** First and last day, both included, in the browser's time zone. */
  dates: [string | undefined, string | undefined]
  workspaceId: string
  userId: string
  category: AuditCategory | ''
  outcome: AuditOutcome | ''
}

const noFilters: Filters = { dates: [undefined, undefined], workspaceId: '', userId: '', category: '', outcome: '' }

function auditQuery(f: Filters, cursor?: string) {
  return {
    workspaceId: f.workspaceId || undefined,
    userId: f.userId || undefined,
    category: f.category || undefined,
    outcome: f.outcome || undefined,
    from: f.dates[0] && dayStart(f.dates[0]),
    to: f.dates[1] && dayStart(f.dates[1], 1),
    cursor,
  }
}

/** Detail keys shown in their own place rather than among the other details. */
const shownApart = new Set(['statements', 'request', 'previousName', 'reason', 'requiredRole', 'error'])

interface Statement {
  kind: string
  datasetId?: string
  datasourceId: string
  sql: string
  sqlClipped?: boolean
  args: unknown[]
  durationMs: number
  rows: number
  truncated?: boolean
  cached?: boolean
  error?: string
}

function useLabels() {
  const { t, i18n } = useTranslation()
  return {
    time: (value: string) => new Date(value).toLocaleString(i18n.language, { hour12: false }),
    day: (value: string) => new Date(value).toLocaleDateString(i18n.language),
    clock: (value: string) => new Date(value).toLocaleTimeString(i18n.language, { hour12: false }),
    action: (action: string) => t(`audit.actions.${action}`, { defaultValue: action }),
    /** Its type, and its name if it has one: a refused creation has none. */
    objectOf: (o: NonNullable<AuditEvent['object']>) => [o.type && t(`audit.objects.${o.type}`, { defaultValue: o.type }), o.name || o.id].filter(Boolean).join(' · '),
    reason: (reason: string) => t(`audit.reasons.${reason}`, { defaultValue: reason }),
  }
}

/** Who did what, across the organisation, for system administrators. */
export function Audit() {
  const { t } = useTranslation()
  const label = useLabels()
  const [filters, setFilters] = useState(noFilters)
  const first = useAsync(() => unwrap(api.GET('/audit-events', { params: { query: auditQuery(filters) } })), [filters])
  // Later pages belong to the filters they were loaded for.
  const [later, setLater] = useState<{ filters: Filters; items: AuditEvent[]; next?: string }>()
  const more = useAction()
  const users = useAsync(() => unwrap(api.GET('/users')), [])
  const workspaces = useAsync(() => unwrap(api.GET('/workspaces')), [])
  const [shown, setShown] = useState<AuditEvent>()
  const change = (patch: Partial<Filters>) => setFilters((current) => ({ ...current, ...patch }))
  const filtered = Object.values(filters).some((value) => (Array.isArray(value) ? value.some(Boolean) : Boolean(value)))

  return (
    <SettingsPage title={t('settings.audit')} hint={t('audit.hint')}>
      <div className="settings-toolbar">
        <DateRangeInput size="sm" value={filters.dates} onChange={(dates) => change({ dates })} placeholder={[t('audit.dateFrom'), t('audit.dateTo')]} aria-label={t('audit.dates')} />
        <Select
          size="sm"
          aria-label={t('audit.workspace')}
          value={filters.workspaceId}
          onChange={(workspaceId) => change({ workspaceId })}
          options={[{ value: '', label: t('audit.allWorkspaces') }, ...(workspaces.status === 'ok' ? workspaces.data.map((w) => ({ value: w.id, label: w.name })) : [])]}
        />
        <Select
          size="sm"
          search
          searchBy="label"
          aria-label={t('audit.actor')}
          value={filters.userId}
          onChange={(userId) => change({ userId })}
          options={[{ value: '', label: t('audit.allUsers') }, ...(users.status === 'ok' ? users.data.map((u) => ({ value: u.id, label: `${u.displayName} · ${u.email}` })) : [])]}
        />
        <Select<AuditCategory | ''>
          size="sm"
          aria-label={t('audit.event')}
          value={filters.category}
          onChange={(category) => change({ category })}
          options={[{ value: '', label: t('audit.allCategories') }, ...categories.map((c) => ({ value: c, label: t(`audit.categories.${c}`) }))]}
        />
        <Select<AuditOutcome | ''>
          size="sm"
          aria-label={t('audit.outcome')}
          value={filters.outcome}
          onChange={(outcome) => change({ outcome })}
          options={[{ value: '', label: t('audit.allOutcomes') }, ...outcomes.map((o) => ({ value: o, label: t(`audit.outcomes.${o}`) }))]}
        />
        {filtered && <Button size="sm" variant="ghost" onClick={() => setFilters(noFilters)}>{t('audit.reset')}</Button>}
      </div>
      <Async state={first} reload={first.reload}>
        {(page) => {
          const loaded = later?.filters === filters ? later : undefined
          const rows = [...page.items, ...(loaded?.items ?? [])]
          const next = loaded ? loaded.next : page.nextCursor
          const loadMore = () => void more.run(async () => {
            const older = await unwrap(api.GET('/audit-events', { params: { query: auditQuery(filters, next) } }))
            setLater({ filters, items: [...(loaded?.items ?? []), ...older.items], next: older.nextCursor })
          })
          return (
            <>
              <DataTable
                aria-label={t('settings.audit')}
                rows={rows}
                rowKey={(row) => row.id}
                empty={t('audit.empty')}
                columns={[
                  { key: 'time', title: t('audit.time'), render: (row) => <time className="audit-stacked" dateTime={row.occurredAt}>{label.day(row.occurredAt)}<span className="note small">{label.clock(row.occurredAt)}</span></time> },
                  { key: 'actor', title: t('audit.actor'), render: (row) => <Actor event={row} /> },
                  // The event opens its details.
                  { key: 'event', title: t('audit.event'), render: (row) => <button type="button" className="audit-open" aria-label={t('audit.detailsOf', { event: label.action(row.action) })} onClick={() => setShown(row)}>{label.action(row.action)}</button> },
                  { key: 'object', title: t('audit.object'), render: (row) => row.object ? <span className="audit-object" title={label.objectOf(row.object)}>{label.objectOf(row.object)}</span> : <span className="note">—</span> },
                  { key: 'workspace', title: t('audit.workspace'), render: (row) => row.workspace ? row.workspace.name || row.workspace.id : <span className="note">—</span> },
                  { key: 'outcome', title: t('audit.outcome'), render: (row) => <Outcome event={row} /> },
                ]}
              />
              {more.error && <ErrorAlert error={more.error} />}
              {next && <div><Button size="sm" loading={more.busy} onClick={loadMore}>{t('audit.more')}</Button></div>}
            </>
          )
        }}
      </Async>
      {shown && <AuditDetail event={shown} onClose={() => setShown(undefined)} />}
    </SettingsPage>
  )
}

function Actor({ event }: { event: AuditEvent }) {
  const { t } = useTranslation()
  const { actor } = event
  if (!actor.id && !actor.email) return <span className="note">{t('audit.noActor')}</span>
  return actor.displayName
    ? <span className="audit-stacked">{actor.displayName}<span className="note small">{actor.email}</span></span>
    : <span>{actor.email}</span>
}

function Outcome({ event }: { event: AuditEvent }) {
  const { t } = useTranslation()
  const label = useLabels()
  const reason = typeof event.detail.reason === 'string' ? event.detail.reason : undefined
  const text = t(`audit.outcomes.${event.outcome}`)
  if (event.outcome === 'success') return <span>{text}</span>
  return <span className="chip warning audit-outcome">{reason ? `${text} · ${label.reason(reason)}` : text}</span>
}

function AuditDetail({ event, onClose }: { event: AuditEvent; onClose: () => void }) {
  const { t } = useTranslation()
  const label = useLabels()
  const { detail } = event
  const statements = Array.isArray(detail.statements) ? (detail.statements as Statement[]) : []
  const other = Object.fromEntries(Object.entries(detail).filter(([key]) => !shownApart.has(key)))
  const fact = (term: string, value: ReactNode) => value !== undefined && value !== '' && <div><dt>{term}</dt><dd>{value}</dd></div>
  const text = (value: unknown) => (typeof value === 'string' ? value : undefined)
  return (
    <Dialog open title={t('audit.detailTitle')} width={760} onClose={onClose}>
      <div className="stack audit-detail">
        <dl className="facts">
          {fact(t('audit.time'), label.time(event.occurredAt))}
          {fact(t('audit.actor'), <Actor event={event} />)}
          {fact(t('audit.event'), `${label.action(event.action)} · ${t(`audit.categories.${event.category}`)}`)}
          {fact(t('audit.outcome'), <Outcome event={event} />)}
          {fact(t('audit.requiredRole'), text(detail.requiredRole) && (detail.requiredRole === 'org_admin' ? t('user.orgAdmin') : t(`member.roles.${text(detail.requiredRole)}`, { defaultValue: text(detail.requiredRole) })))}
          {fact(t('audit.error'), text(detail.error))}
          {fact(t('audit.object'), event.object && <span>{label.objectOf(event.object)} {event.object.id && <code className="note small">{event.object.id}</code>}</span>)}
          {fact(t('audit.previousName'), text(detail.previousName))}
          {fact(t('audit.workspace'), event.workspace && (event.workspace.name || event.workspace.id))}
          {fact(t('audit.clientIp'), event.clientIp)}
          {fact(t('audit.forwardedFor'), event.forwardedFor && <span>{event.forwardedFor} <span className="note small">{t('audit.forwardedForHint')}</span></span>)}
          {fact(t('audit.userAgent'), event.userAgent && <span className="audit-agent">{event.userAgent}</span>)}
        </dl>
        {statements.length > 0 && (
          <section className="stack" aria-label={t('audit.statements')}>
            <h3>{t('audit.statements')}</h3>
            {statements.map((statement, index) => <AuditStatement key={index} index={index} statement={statement} />)}
          </section>
        )}
        {detail.request !== undefined && (
          <section className="stack" aria-label={t('audit.request')}>
            <h3>{t('audit.request')}</h3>
            <pre className="audit-json">{JSON.stringify(detail.request, null, 2)}</pre>
          </section>
        )}
        {Object.keys(other).length > 0 && (
          <section className="stack" aria-label={t('audit.other')}>
            <h3>{t('audit.other')}</h3>
            <pre className="audit-json">{JSON.stringify(other, null, 2)}</pre>
          </section>
        )}
      </div>
    </Dialog>
  )
}

function AuditStatement({ index, statement }: { index: number; statement: Statement }) {
  const { t } = useTranslation()
  return (
    <div className="audit-statement stack">
      <div className="row">
        <strong>{index + 1}. {t(`audit.kinds.${statement.kind}`, { defaultValue: statement.kind })}</strong>
        {!statement.error && <span className="note small">{t('audit.duration', { ms: statement.durationMs })} · {t('audit.rows', { count: statement.rows })}</span>}
        {statement.cached && <span className="chip">{t('audit.cached')}</span>}
        {statement.truncated && <span className="chip">{t('audit.truncated')}</span>}
      </div>
      {statement.error && <Alert tone="error" title={statement.error} />}
      {statement.sqlClipped && <p className="note small">{t('audit.sqlClipped')}</p>}
      <CodeEditor value={statement.sql} onChange={() => {}} readOnly lineNumbers minLines={2} maxLines={14} aria-label={`SQL ${index + 1}`} />
      {statement.args.length > 0 && <pre className="audit-json">{JSON.stringify(statement.args)}</pre>}
    </div>
  )
}
