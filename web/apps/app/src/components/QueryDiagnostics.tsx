import { Alert, CodeEditor, Tooltip } from '@supabi/ui'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { QueryResult } from '../api/client'
import { useClipboard } from '../lib/useClipboard'
import { Icon } from './Icon'
import './queryDiagnostics.css'

export type QueryNotice = 'cancelled' | 'failed' | null

type Diagnostics = NonNullable<QueryResult['diagnostics']>
type Statement = Diagnostics['statements'][number]

/** Diagnostics belong to the returned rows, never to the editor's current draft. */
export function QueryDiagnostics({ result, stale, running, notice }: { result?: QueryResult; stale: boolean; running: boolean; notice: QueryNotice }) {
  const { t } = useTranslation()
  // One message at a time: a running or failed query already says whose details are below.
  const message = running
    ? <Alert tone="info" title={t(result ? 'diagnostics.runningPrevious' : 'explore.running')} />
    : notice
      ? <Alert tone={notice === 'failed' ? 'error' : 'warning'} title={t(`diagnostics.${notice}`)} />
      : stale && result && <Alert tone="warning" title={t('diagnostics.stale')} />
  return (
    <section className="query-diagnostics" aria-label={t('diagnostics.title')}>
      {message}
      {result?.diagnostics
        ? <DiagnosticResult key={result.diagnostics.requestId} result={result} diagnostics={result.diagnostics} />
        : <p className="empty">{t(result ? 'diagnostics.unavailable' : 'diagnostics.empty')}</p>}
    </section>
  )
}

function DiagnosticResult({ result, diagnostics }: { result: QueryResult; diagnostics: Diagnostics }) {
  const { t, i18n } = useTranslation()
  const [selected, setSelected] = useState(0)
  const tabs = useRef<(HTMLButtonElement | null)[]>([])
  const { statements } = diagnostics
  const statement = statements[selected]
  const day = (value: string) => new Date(value).toDateString()
  const time = (value: string) => new Date(value).toLocaleString(i18n.language, { hour12: false })
  // A statement fetched on the day of the request only needs its time.
  const fetched = (value: string) => day(value) === day(diagnostics.requestedAt) ? new Date(value).toLocaleTimeString(i18n.language, { hour12: false }) : time(value)
  const name = (item: Statement) => {
    const by = item.by.map((field) => result.columns.find((column) => column.name === field)?.label ?? field).join(', ')
    return by ? `${t(`diagnostics.${item.kind}`)} · ${t('diagnostics.by', { fields: by })}` : t(`diagnostics.${item.kind}`)
  }
  const choose = (index: number) => {
    setSelected(index)
    tabs.current[index]?.focus()
  }
  const move = (event: KeyboardEvent) => {
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key]
    if (event.key === 'Home') choose(0)
    else if (event.key === 'End') choose(statements.length - 1)
    else if (step) choose((selected + step + statements.length) % statements.length)
    else return
    event.preventDefault()
  }
  return (
    <>
      <dl className="query-diagnostics-summary">
        <div><dt>{t('diagnostics.requestedAt')}</dt><dd>{time(diagnostics.requestedAt)}</dd></div>
        <div><dt>{t('diagnostics.statements')}</dt><dd>{statements.length}</dd></div>
        <div><dt>{t('diagnostics.totalDuration')}</dt><dd>{result.meta.durationMs} ms</dd></div>
        <div><dt>{t('diagnostics.requestId')}</dt><dd><code>{diagnostics.requestId}</code></dd></div>
      </dl>
      {result.meta.totalsOmitted && <Alert tone="info" title={t('charts.totalsOmitted')} />}
      {statement && (
        <div className={`query-diagnostics-body${statements.length > 1 ? '' : ' single'}`}>
          {statements.length > 1 && (
            <div className="query-diagnostics-statements" role="tablist" aria-orientation="vertical" aria-label={t('diagnostics.statement')} onKeyDown={move}>
              {statements.map((item, index) => (
                <button
                  key={index}
                  ref={(element) => { tabs.current[index] = element }}
                  type="button"
                  role="tab"
                  id={`${diagnostics.requestId}-tab-${index}`}
                  aria-selected={index === selected}
                  aria-controls={`${diagnostics.requestId}-panel`}
                  tabIndex={index === selected ? 0 : -1}
                  onClick={() => setSelected(index)}
                >
                  <span className="query-diagnostics-index">{index + 1}</span>
                  <span className="query-diagnostics-name">{name(item)}</span>
                  <span className="query-diagnostics-time">{item.durationMs} ms</span>
                  <span className="query-diagnostics-marks">
                    <Source statement={item} />
                    {item.truncated && <span className="query-diagnostics-chip warning">{t('diagnostics.truncated')}</span>}
                  </span>
                </button>
              ))}
            </div>
          )}
          <StatementDetail
            key={selected}
            id={`${diagnostics.requestId}-panel`}
            labelledBy={statements.length > 1 ? `${diagnostics.requestId}-tab-${selected}` : undefined}
            title={name(statement)}
            statement={statement}
            fetchedAt={fetched(statement.fetchedAt)}
          />
        </div>
      )}
    </>
  )
}

function Source({ statement }: { statement: Statement }) {
  const { t } = useTranslation()
  const source = statement.cached ? 'cached' : statement.shared ? 'shared' : 'executed'
  return <span className={`query-diagnostics-chip ${source}`}>{t(`diagnostics.${source}`)}</span>
}

function StatementDetail({ id, labelledBy, title, statement, fetchedAt }: { id: string; labelledBy?: string; title: string; statement: Statement; fetchedAt: string }) {
  const { t } = useTranslation()
  const args = JSON.stringify(statement.args, null, 2)
  return (
    <div className="query-diagnostics-detail" id={id} role={labelledBy ? 'tabpanel' : undefined} aria-labelledby={labelledBy}>
      <header className="query-diagnostics-header">
        <strong>{title}</strong>
        <Source statement={statement} />
        {statement.truncated && <span className="query-diagnostics-chip warning">{t('diagnostics.truncated')}</span>}
        <span className="query-diagnostics-meta">
          <span>{t('diagnostics.duration', { ms: statement.durationMs })}</span>
          <span>{t('diagnostics.rows', { count: statement.rowCount })}</span>
          <span>{t('diagnostics.fetchedAt', { time: fetchedAt })}</span>
        </span>
      </header>
      {statement.cached && <p className="query-diagnostics-hint">{t('diagnostics.cachedDuration')}</p>}
      <div className="query-diagnostics-content">
        <section className="query-diagnostics-sql" aria-label={t('diagnostics.sql')}>
          <Heading label={t('diagnostics.sql')} copy={t('diagnostics.copySql')} text={statement.sql} />
          <CodeEditor value={statement.sql} onChange={() => {}} readOnly lineNumbers minLines={3} maxLines={18} aria-label={t('diagnostics.sql')} />
        </section>
        <section className="query-diagnostics-args" aria-label={t('diagnostics.args')}>
          <Heading label={t('diagnostics.args')} count={statement.args.length} copy={t('diagnostics.copyArgs')} text={args} />
          {statement.args.length
            ? (
              <ol className="query-diagnostics-values">
                {statement.args.map((value, index) => (
                  <li key={index}>
                    <span className="query-diagnostics-index">{index + 1}</span>
                    <code className={`value ${value === null ? 'null' : typeof value}`}>{JSON.stringify(value)}</code>
                  </li>
                ))}
              </ol>
            )
            : <p className="query-diagnostics-none">{t('diagnostics.noArgs')}</p>}
        </section>
      </div>
    </div>
  )
}

/** A section title with a copy button that reports, beside itself, whether the copy worked. */
function Heading({ label, count, copy, text }: { label: string; count?: number; copy: string; text: string }) {
  const { t } = useTranslation()
  const { status, copy: write, reset } = useClipboard()
  useEffect(() => {
    if (status !== 'copied') return
    const timer = setTimeout(reset, 2000)
    return () => clearTimeout(timer)
  }, [status, reset])
  return (
    <div className="query-diagnostics-heading">
      <strong>{label}{count !== undefined && <span className="query-diagnostics-count">{count}</span>}</strong>
      <span className={`query-diagnostics-copied${status === 'failed' ? ' warning' : ''}`} role="status">
        {status && t(status === 'copied' ? 'diagnostics.copied' : 'diagnostics.copyFailed', { target: label })}
      </span>
      <Tooltip title={copy}>
        <button type="button" className="wb-icon-button" aria-label={copy} onClick={() => void write(text)}><Icon name={status === 'copied' ? 'check' : 'copy'} size={14} /></button>
      </Tooltip>
    </div>
  )
}
