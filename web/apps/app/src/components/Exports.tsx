import { Button, Dialog, Input, Select, Tooltip } from '@supabi/ui'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { api, unwrap, type Schemas } from '../api/client'
import { toApiError } from '../api/useAsync'
import { ErrorAlert } from './ErrorAlert'
import { Icon } from './Icon'
import './exports.css'

type ExportItem = Schemas['Export']
type ExportPage = Schemas['ExportPage']
type ExportFormat = ExportItem['format']
type SqlExportRequest = Omit<Schemas['ExportInput'], 'format' | 'name'> & { name: string }
type ChartExportRequest = Omit<Schemas['DashboardExportInput'], 'format' | 'name'>
const changed = 'supabi:exports-changed'

/** Asks for a file name and format, queues the export with submit, and opens the export center. */
/** A suggested file name the server accepts: no slashes or control characters, at most 120 characters. */
export function exportFileName(name: string) {
  return name.replace(/[\\/]/g, '-').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, 120)
}

function ExportDialog({ title, explanation, name: initialName, submit, children, onClose }: {
  title: string
  explanation: string
  name: string
  submit: (input: { format: ExportFormat; name: string }) => Promise<ExportItem>
  children?: ReactNode
  onClose: () => void
}) {
  const { t, i18n } = useTranslation()
  const [format, setFormat] = useState<ExportFormat>('xlsx')
  const [name, setName] = useState(() => exportFileName(initialName))
  const [limits, setLimits] = useState<ExportPage>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ReturnType<typeof toApiError>>()
  useEffect(() => {
    const control = new AbortController()
    void unwrap(api.GET('/exports', { signal: control.signal })).then(setLimits, (e: unknown) => { if (!control.signal.aborted) setError(toApiError(e)) })
    return () => control.abort()
  }, [])
  const start = async () => {
    setBusy(true); setError(undefined)
    try {
      const item = await submit({ format, name: name.trim() })
      onClose()
      window.dispatchEvent(new CustomEvent(changed, { detail: { open: true, item } }))
    } catch (e) { setError(toApiError(e)) } finally { setBusy(false) }
  }
  return <Dialog open title={title} onClose={() => { if (!busy) onClose() }} width={560} actions={<>
    <Button disabled={busy} onClick={onClose}>{t('common.cancel')}</Button>
    <Button variant="primary" loading={busy} disabled={!limits || !name.trim()} onClick={() => void start()}>{t('exports.start')}</Button>
  </>}>
    <div className="export-form">
      <p className="note">{explanation}</p>
      <label><span>{t('exports.fileName')}</span><Input aria-label={t('exports.fileName')} value={name} onChange={setName} maxLength={120} disabled={busy} /></label>
      <label><span>{t('exports.format')}</span><Select block aria-label={t('exports.format')} value={format} onChange={setFormat} disabled={busy} options={[{ value: 'xlsx', label: t('exports.xlsx') }, { value: 'csv', label: t('exports.csv') }]} /></label>
      {limits && <p className="note small">{t('exports.limits', { rows: limits.maxRows.toLocaleString(i18n.language), size: Math.round(limits.maxBytes / 1048576), hours: limits.retentionSeconds / 3600, minutes: limits.timeoutSeconds / 60 })}</p>}
      {format === 'xlsx' && <p className="note small">{t('exports.xlsxNote')}</p>}
      {children}
      {error && <ErrorAlert error={error} />}
    </div>
  </Dialog>
}

/** Exports what data exploration's SQL returns, in full. */
export function SqlExportDialog({ request, onClose }: { request: SqlExportRequest; onClose: () => void }) {
  const { t } = useTranslation()
  return <ExportDialog title={t('exports.create')} explanation={t('exports.explanation')} name={request.name} onClose={onClose}
    submit={(input) => unwrap(api.POST('/exports', { body: { ...request, ...input } }))}>
    <details><summary>{t('exports.sqlSnapshot')}</summary><pre className="export-sql">{request.sql}</pre></details>
  </ExportDialog>
}

/** Exports a dashboard widget's complete data, for the values it shows now. */
export function ChartExportDialog({ dashboardId, itemId, name, request, onClose }: { dashboardId: string; itemId: string; name: string; request: ChartExportRequest; onClose: () => void }) {
  const { t } = useTranslation()
  return <ExportDialog title={t('exports.createChart')} explanation={t('exports.chartExplanation')} name={name} onClose={onClose}
    submit={(input) => unwrap(api.POST('/dashboards/{id}/items/{itemId}/exports', { params: { path: { id: dashboardId, itemId } }, body: { ...request, ...input } }))} />
}

function active(e: ExportItem) { return e.status === 'queued' || e.status === 'running' }

/** A file's size the way people say it: small exports are a few KB, not 0 MB. */
function fileSize(bytes: number, language: string) {
  const [value, unit] = bytes < 1048576 ? [bytes / 1024, 'KB'] : [bytes / 1048576, 'MB']
  return `${value.toLocaleString(language, { maximumFractionDigits: value < 10 ? 1 : 0 })} ${unit}`
}

/**
 * Everyone's exports, from data exploration and from dashboards, behind one
 * entry. A finished result is new until its owner opens the list. Polling is
 * faster while a job is active; hidden windows pause polling and immediately
 * refresh when visible again.
 */
export function ExportCenter({ disabled }: { disabled: boolean }) {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState<ExportPage>()
  const [older, setOlder] = useState<ExportItem[]>([])
  // undefined: pagination has not started; null: the final page was reached.
  const [cursor, setCursor] = useState<string | null>()
  // New results stay marked while the list that showed them is open.
  const [fresh, setFresh] = useState<Set<string>>(new Set())
  const [error, setError] = useState<ReturnType<typeof toApiError>>()
  const [listError, setListError] = useState<ReturnType<typeof toApiError>>()
  const [acting, setActing] = useState<string>()
  const [toast, setToast] = useState<string>()
  const observed = useRef<Set<string> | null>(null)
  const pending = useRef(false)
  const opened = useRef(false)
  const controller = useRef<AbortController | null>(null)
  const actionController = useRef<AbortController | null>(null)

  const refresh = useCallback(async () => {
    if (disabled || (controller.current && !controller.current.signal.aborted) || document.visibilityState === 'hidden') return
    const control = new AbortController()
    controller.current = control
    try {
      const next = await unwrap(api.GET('/exports', { signal: control.signal }))
      if (control.signal.aborted) return
      setPage(next); setListError(undefined)
      pending.current = next.items.some(active)
      const unseen = next.items.filter((item) => item.unseen)
      if (opened.current && unseen.length) {
        // The list is open, so what arrives is seen as it arrives.
        setFresh((current) => new Set([...current, ...unseen.map((item) => item.id)]))
        await unwrap(api.POST('/exports/seen', { signal: control.signal }))
        if (!control.signal.aborted) setPage({ ...next, unseen: 0, items: next.items.map((item) => ({ ...item, unseen: false })) })
      } else if (observed.current) {
        const arrival = unseen.find((item) => !observed.current!.has(item.id))
        if (arrival) setToast(t(`exports.notice.${arrival.status === 'failed' ? 'failed' : 'succeeded'}`, { name: `${arrival.name}.${arrival.format}` }))
      }
      observed.current = new Set(unseen.map((item) => item.id))
    } catch (e) {
      if (!control.signal.aborted) setListError(toApiError(e))
    } finally { if (controller.current === control) controller.current = null }
  }, [disabled, t])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    const poll = async () => {
      await refresh()
      if (!stopped) { clearTimeout(timer); timer = setTimeout(() => void poll(), pending.current ? 3000 : 15000) }
    }
    void poll()
    const wake = () => { clearTimeout(timer); void poll() }
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ open?: boolean }>).detail
      if (detail?.open && !disabled) show()
      pending.current = true
      clearTimeout(timer); void poll()
    }
    window.addEventListener(changed, onChanged)
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('focus', wake)
    return () => {
      stopped = true; clearTimeout(timer); controller.current?.abort()
      window.removeEventListener(changed, onChanged)
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('focus', wake)
    }
    // show only sets state; listening again for each render is not needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, disabled])

  useEffect(() => () => actionController.current?.abort(), [])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(undefined), 8000)
    return () => clearTimeout(timer)
  }, [toast])

  const act = async (id: string, request: (signal: AbortSignal) => Promise<unknown>) => {
    if (actionController.current || disabled) return
    const control = new AbortController()
    actionController.current = control
    setActing(id); setError(undefined)
    try {
      await request(control.signal)
      if (!control.signal.aborted) await refresh()
    } catch (e) { if (!control.signal.aborted) setError(toApiError(e)) } finally {
      if (actionController.current === control) { actionController.current = null; setActing(undefined) }
    }
  }
  const nextBefore = cursor === undefined ? page?.nextBefore : cursor
  const more = async () => {
    if (!nextBefore) return
    await act('more', async (signal) => {
      const next = await unwrap(api.GET('/exports', { params: { query: { before: nextBefore } }, signal }))
      if (signal.aborted) return
      setOlder((previous) => [...previous, ...next.items]); setCursor(next.nextBefore ?? null)
    })
  }
  function show() {
    opened.current = true
    setOpen(true); setOlder([]); setCursor(undefined); setError(undefined); setToast(undefined)
    setFresh(new Set(page?.items.filter((item) => item.unseen).map((item) => item.id)))
    pending.current = true
    void refresh()
  }
  const close = () => { opened.current = false; setOpen(false); setFresh(new Set()) }
  const items = [...(page?.items ?? []), ...older.filter((item) => !page?.items.some((current) => current.id === item.id))]
  const time = (value: string) => new Date(value).toLocaleString(i18n.language)
  const title = t('exports.center')
  const visibleError = error ?? listError
  const unseen = page?.unseen ?? 0

  return <>
    <Tooltip title={title}><button type="button" className="topbar-control export-center-trigger" disabled={disabled} onClick={show} aria-label={title}>
      <Icon name="download" size={18} />
      {unseen > 0 && <span className="export-badge" aria-label={t('exports.unseen', { count: unseen })}>{unseen > 99 ? '99+' : unseen}</span>}
      {!unseen && page?.items.some(active) && <span className="export-active-dot" />}
    </button></Tooltip>
    {toast && !disabled && <div className="export-toast" role="status"><span>{toast}</span><button type="button" onClick={show}>{t('exports.view')}</button><button type="button" aria-label={t('common.close')} onClick={() => setToast(undefined)}><Icon name="close" /></button></div>}
    <Dialog open={open && !disabled} title={title} onClose={close} width={880}>
      <div className="export-center">
        <div className="export-center-toolbar"><p className="note small">{t('exports.historyNote')}</p><Button size="sm" icon={<Icon name="refresh" />} onClick={() => void refresh()}>{t('exports.refresh')}</Button></div>
        {visibleError && <ErrorAlert error={visibleError} />}
        {!page && !visibleError && <p className="empty">{t('common.loading')}</p>}
        {page && items.length === 0 && <div className="export-empty"><Icon name="download" size={32} /><p>{t('exports.empty')}</p></div>}
        <div className="export-list">{items.map((e) => {
          const expired = e.status === 'expired' || (e.expiresAt && Date.parse(e.expiresAt) <= Date.now())
          // A file its owner may no longer download is not ready for them, whatever the task did.
          const status = expired ? 'expired' : e.status === 'succeeded' && e.denied ? 'denied' : e.status
          const origin = e.source === 'chart' ? t('exports.fromChart', { dashboard: e.dashboardName, chart: e.chartName }) : t('exports.fromSql')
          return <article className={`export-item${fresh.has(e.id) ? ' new' : ''}`} key={e.id} aria-label={`${e.name}.${e.format}`}>
            <span className={`export-file-icon ${e.format}`}><Icon name={e.format === 'xlsx' ? 'table' : 'rows'} size={20} /><small>{e.format.toUpperCase()}</small></span>
            <div className="export-item-content"><div className="export-item-title"><strong title={e.name}>{e.name}.{e.format}</strong><span className={`export-status ${status}`}>{t(e.cancelRequested && active(e) ? 'exports.cancelling' : `exports.status.${status}`)}</span>{fresh.has(e.id) && <span className="export-new">{t('exports.new')}</span>}</div>
              <p className="note small export-origin" title={origin}>{origin}</p>
              <p className="note small"><time dateTime={e.createdAt}>{time(e.createdAt)}</time><span> · {t('exports.rows', { rows: e.rows.toLocaleString(i18n.language) })}</span>{e.sizeBytes > 0 && <span> · {fileSize(e.sizeBytes, i18n.language)}</span>}</p>
              {status === 'succeeded' && e.expiresAt && <p className="note small">{t('exports.expires', { time: time(e.expiresAt) })}</p>}
              {status === 'denied' && <p className="note small danger">{t(`exports.denied.${e.denied}`, { defaultValue: t('exports.denied.default') })}</p>}
              {e.errorCode && <p className="note small danger">{t(`exports.errors.${e.errorCode}`, { defaultValue: t('exports.errors.export_failed') })}</p>}
            </div>
            <div className="export-item-actions">{active(e) && <Button size="sm" disabled={Boolean(acting) || e.cancelRequested} loading={acting === e.id} onClick={() => void act(e.id, (signal) => unwrap(api.POST('/exports/{id}/cancel', { params: { path: { id: e.id } }, signal })))}>{t('exports.cancel')}</Button>}
              {status === 'succeeded' && <a className="export-download" href={`/api/v1/exports/${encodeURIComponent(e.id)}/file`} download={`${e.name}.${e.format}`}><Icon name="download" />{t('exports.download')}</a>}
            </div>
          </article>
        })}</div>
        {nextBefore && <Button loading={acting === 'more'} disabled={Boolean(acting)} onClick={() => void more()}>{t('exports.more')}</Button>}
      </div>
    </Dialog>
  </>
}
