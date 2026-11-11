import { formatCell, type ResultColumn } from '@supabi/charts'
import { Button, Checkbox, CodeEditor, DataTable, Dialog, Input, Select, Tooltip, formatSql, type CodeEditorHandle, type CodeProblem } from '@supabi/ui'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation, useNavigate } from 'react-router'
import { ApiError, api, indexOfCharacter, unwrap, type Datasource, type LogicalType, type QueryResult, type Schemas, type SourceColumn } from '../api/client'
import { isNumeric, logicalTypes, makeKey, type DatasetSpec, type SpecField } from '../api/spec'
import { toApiError, useAsync } from '../api/useAsync'
import { useSession } from '../auth/session'
import { ErrorAlert, useErrorText } from '../components/ErrorAlert'
import { SqlExportDialog } from '../components/Exports'
import { Icon } from '../components/Icon'
import { useUnsavedActions, useUnsavedChanges } from '../components/UnsavedChanges'
import { KindMark, TypeMark } from '../components/TypeMark'
import { kindOf } from '../lib/dbType'
import { draftsFor, paramNames, remember, toDraft, toParam, validDefault, withLabel, withMulti, withRequired, type ParamDraft, type SqlParam } from '../lib/params'
import { canonicalJSON } from '../lib/datasetHistory'
import { historyLimit, recorded, type SqlRun } from '../lib/sqlHistory'
import { openSqlDataset, readSqlHandoff, reserveSqlDestination, returnSqlHandoff, type SqlHandoff } from '../lib/sqlHandoff'
import { closed as tabsClosed, opened as tabsOpened, type Tab, type Tabs } from '../lib/sqlTabs'
import { useEditorPanels } from '../components/EditorPanels'
import { useStored } from '../lib/useStored'
import { AsidePanel, BottomPanel, Resizer, StatusItem } from '../workbench/slots'

const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)
const runKey = isMac ? '⌘↵' : 'Ctrl+Enter'
const formatKey = isMac ? '⇧⌥F' : 'Shift+Alt+F'

/** How many rows a run shows. The point is to look at the data, not to take it away. */
const rowLimit = 1000
/** How many rows of a table are shown when it is only looked at. */
const peekRows = 100

type SourceTable = Schemas['SourceTable']
type Plan = Schemas['Plan']

interface Outcome {
  columns: SourceColumn[]
  result: QueryResult
  /** The table this is a look at, when it is not what the SQL returned. */
  of?: string
}

/** What is being written in a tab. */
interface Draft {
  datasourceId: string
  sql: string
  params?: SqlParam[]
}

/** What a tab says of itself to the row of tabs. */
interface Meta {
  name: string
  dirty: boolean
  running: boolean
}

/** The list of queries as it is kept in the browser, or nothing when none is, or it cannot be read. */
function keptTabs(key: string): Tabs | null {
  try {
    const kept = JSON.parse(localStorage.getItem(key) ?? 'null') as Tabs | null
    return kept && Array.isArray(kept.open) ? kept : null
  } catch {
    return null
  }
}

function forget(key: string) {
  try {
    localStorage.removeItem(key)
  } catch {
    // storage can be unavailable (private mode, embedded frames)
  }
}

function readHistory(key: string, fallback: SqlRun[] = []): SqlRun[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(saved) ? saved as SqlRun[] : fallback
  } catch {
    return fallback
  }
}

/** The parameters as they are declared: a default that is not a value of its type is left out until it is one. */
const declare = (drafts: ParamDraft[]): SqlParam[] => drafts.map((draft) => toParam(draft) ?? { ...draft.rest, name: draft.name, type: draft.type })
/** What a tab holds, as one text: two tabs hold the same when these are equal. */
const snapshot = (datasourceId: string, sql: string, params: SqlParam[]) => canonicalJSON([datasourceId, sql, params])

/**
 * Whether what is kept of a query holds unsaved work, by the rule its tab applies once it is
 * shown: a tab not shown since the page loaded has reported nothing of itself.
 */
function keptDirty(key: string, forDataset: boolean): boolean {
  try {
    const stored = localStorage.getItem(key)
    // With nothing kept, the tab shows what it was opened with.
    if (!stored) return false
    const kept = JSON.parse(stored) as Draft & { applied?: string }
    if (!forDataset) return kept.sql.trim() !== ''
    return kept.applied === undefined || snapshot(kept.datasourceId, kept.sql, kept.params ?? []) !== canonicalJSON(JSON.parse(kept.applied))
  } catch {
    return false
  }
}

/** Orders two cells of a result: numbers by size, the rest as text, and nothing after everything. */
function compareCells(a: unknown, b: unknown): number {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1
  if (b === null || b === undefined) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b)
  return String(a).localeCompare(String(b), undefined, { numeric: true })
}

/** How long something has been going on, counted while it is shown. */
function Elapsed() {
  const { i18n } = useTranslation()
  const [started] = useState(() => Date.now())
  const [now, setNow] = useState(started)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(timer)
  }, [])
  return <span className="tabular">{new Intl.NumberFormat(i18n.language, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format((now - started) / 1000)} s</span>
}

/** What was run, newest first: when, the SQL, where, and what came of it. Picking one puts it back in the editor. */
function History({ runs, datasources, onUse, onChange }: { runs: SqlRun[]; datasources: Datasource[]; onUse: (run: SqlRun) => void; onChange: (runs: SqlRun[]) => void }) {
  const { t, i18n } = useTranslation()
  const [filter, setFilter] = useState('')
  // Today's runs are told apart by the time alone; older ones need their day.
  const formats = useMemo(
    () => ({
      time: new Intl.DateTimeFormat(i18n.language, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
      day: new Intl.DateTimeFormat(i18n.language, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }),
      whole: new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'medium' }),
      number: new Intl.NumberFormat(i18n.language),
    }),
    [i18n.language],
  )
  if (runs.length === 0) return <p className="empty">{t('workbench.historyEmpty')}</p>

  const today = new Date().toDateString()
  const wanted = filter.trim().toLowerCase()
  const shown = wanted ? runs.filter((run) => run.sql.toLowerCase().includes(wanted)) : runs
  return (
    <div className="sql-history">
      <div className="sql-history-head">
        <Input size="sm" aria-label={t('workbench.historyFilter')} placeholder={t('workbench.historyFilter')} value={filter} onChange={setFilter} />
        <span className="note small">{t('workbench.historyNote', { count: historyLimit })}</span>
        <span className="spacer" />
        <button type="button" className="wb-tool" onClick={() => onChange([])}>
          {t('workbench.historyClear')}
        </button>
      </div>
      {shown.length === 0 && <p className="empty">{t('workbench.noMatches')}</p>}
      <div role="list">
        {shown.map((run) => {
          const from = datasources.find((item) => item.id === run.datasourceId)
          const failed = run.error !== undefined
          return (
            <div key={`${run.at}:${run.datasourceId}`} role="listitem" className="sql-history-row">
              {/* The whole SQL is a hover away: a line of it is often not enough to know it by. */}
              <button type="button" className="sql-history-use" title={run.sql} onClick={() => onUse(run)}>
                <span className={failed ? 'sql-history-mark failed' : 'sql-history-mark'} />
                <span className="sql-history-when tabular" title={formats.whole.format(run.at)}>
                  {new Date(run.at).toDateString() === today ? formats.time.format(run.at) : formats.day.format(run.at)}
                </span>
                <span className="sql-history-sql">{run.sql.replace(/\s+/g, ' ').trim()}</span>
                <span className="sql-history-source">{from ? from.name : ''}</span>
                {failed ? (
                  <span className="sql-history-result failed" title={run.error}>
                    {run.error || t('workbench.historyFailed')}
                  </span>
                ) : (
                  <span className="sql-history-result tabular">
                    {t('workbench.historyRows', { count: run.rows ?? 0, rows: formats.number.format(run.rows ?? 0), ms: formats.number.format(run.ms ?? 0) })}
                  </span>
                )}
              </button>
              <Tooltip title={t('workbench.historyRemove')}>
                <button type="button" className="wb-icon-button sql-history-remove" aria-label={t('workbench.historyRemove')} onClick={() => onChange(runs.filter((other) => other !== run))}>
                  <Icon name="close" size={12} />
                </button>
              </Tooltip>
            </div>
          )
        })}
      </div>
    </div>
  )
}

interface ConsoleProps {
  tabKey: string
  /** Whether this is the tab that shows, on the page that is open. Only then does it fill the frame's panels. */
  shown: boolean
  datasources: Datasource[]
  datasetName?: string
  folderId?: string
  /** Where a still-open dataset editor receives the changed SQL. */
  returnTo?: string
  initial: Draft
  /** Last SQL accepted by the dataset editor. */
  applied?: string
  draftKey: string
  ensureTabStored: (key: string) => void
  untitled: string
  history: SqlRun[]
  onRecord: (run: SqlRun) => void
  onHistory: (runs: SqlRun[]) => void
  onMeta: (key: string, meta: Meta) => void
}

/** One tab: an editor of SQL, the data source it is run against, and what running it gave. */
function Console({ tabKey, shown, datasources, datasetName, folderId, returnTo, initial, applied: previousApplied, draftKey, ensureTabStored, untitled, history, onRecord, onHistory, onMeta }: ConsoleProps) {
  const { t, i18n } = useTranslation()
  const errorText = useErrorText()
  const { setBottomOpen } = useEditorPanels()
  const [datasourceId, setDatasourceId] = useState(initial.datasourceId)
  const [sql, setSqlText] = useState(initial.sql)
  // What has been said about parameters, by name. Only those the SQL names are shown and used.
  const [knownParams, setKnownParams] = useState<ParamDraft[]>(() => (initial.params ?? []).map(toDraft))
  const [paramsWidth, setParamsWidth] = useStored('supabi.explore.paramsWidth', 260)
  const [schemaOpen, setSchemaOpen] = useStored('supabi.explore.schemaOpen', true)
  const [problem, setProblem] = useState<CodeProblem | null>(null)
  const [running, setRunning] = useState(false)
  // The run that is on its way, so that it can be called off.
  const flight = useRef<AbortController | null>(null)
  const editor = useRef<CodeEditorHandle>(null)
  const [selected, setSelected] = useState(false)
  const [formatFailed, setFormatFailed] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [bottomTab, setBottomTab] = useState('result')
  const [copied, setCopied] = useState(false)
  const [exportRequest, setExportRequest] = useState<{ datasourceId: string; sql: string; params: SqlParam[]; name: string }>()
  const [filter, setFilter] = useState('')
  // Tables start closed and what they are in starts open: the tree shows where things are, then what they hold.
  const [openTables, setOpenTables] = useState<string[]>([])
  const [closedPlaces, setClosedPlaces] = useState<string[]>([])
  const [handoffMessage, setHandoffMessage] = useState<'applied' | 'unavailable' | null>(null)
  const [applying, setApplying] = useState(false)
  const [handoffError, setHandoffError] = useState<ApiError | null>(null)

  const source = datasources.find((item) => item.id === datasourceId)
  // The parameters follow the SQL: naming one in it is what declares it.
  const drafts = useMemo(() => draftsFor(sql, knownParams), [sql, knownParams])
  const misnamed = useMemo(() => paramNames(sql).invalid, [sql])
  const declared = useMemo(() => declare(drafts), [drafts])
  const setParam = (changed: ParamDraft) => setKnownParams((known) => remember(known, changed))

  const name = datasetName ?? untitled
  const now = snapshot(datasourceId, sql, declared)
  const [applied, setApplied] = useState(() => {
    // Older drafts used insertion order for parameter properties. Opening one
    // must not count as an edit merely because the form reordered those keys.
    try { return previousApplied === undefined ? undefined : canonicalJSON(JSON.parse(previousApplied)) }
    catch { return undefined }
  })
  const [persisted, setPersisted] = useState<string>()
  const dirty = returnTo ? now !== applied : sql.trim() !== ''
  // A temporary query is safe to leave only when its tab and current draft can be restored.
  useUnsavedChanges(dirty && (Boolean(returnTo) || persisted !== now))
  const { isSessionChanging } = useUnsavedActions()

  useEffect(() => onMeta(tabKey, { name, dirty, running }), [onMeta, tabKey, name, dirty, running])

  // Queries stay local, including after their SQL has been applied to a dataset.
  useEffect(() => {
    try {
      localStorage.setItem(draftKey, JSON.stringify({ sql, datasourceId, params: declared, applied }))
      ensureTabStored(tabKey)
      setPersisted(now)
    } catch {
      // Keep editing in memory, with departure protection until a write succeeds.
      setPersisted(undefined)
    }
  }, [draftKey, sql, datasourceId, declared, applied, now, ensureTabStored, tabKey])

  useEffect(() => setHandoffMessage(null), [now])
  // The accepted SQL is no longer dirty before the browser handles its departure.
  useEffect(() => { if (handoffMessage === 'applied') window.close() }, [handoffMessage])

  const setSql = (text: string) => {
    setSqlText(text)
    setProblem(null)
    setFormatFailed(false)
  }

  const catalog = useAsync(() => (datasourceId ? unwrap(api.GET('/datasources/{id}/tables', { params: { path: { id: datasourceId } } })) : Promise.resolve(null)), [datasourceId])
  const found = catalog.status === 'ok' ? catalog.data : null
  const tables = useMemo(() => (found ? found.tables.map((table) => ({ schema: table.schema, name: table.name, columns: table.columns.map((column) => ({ name: column.name, type: column.dbType })) })) : []), [found])

  // Closing the tab calls off what is still running: nobody is waiting for it.
  useEffect(() => () => flight.current?.abort(), [])

  /** What there is to run or explain: what is selected, or all of it. */
  const subject = () => {
    const picked = editor.current?.selection()
    const part = picked?.text.trim() ? picked : null
    const text = part ? part.text : sql
    const used = paramNames(text).names
    return { text, from: part?.from ?? 0, params: declared.filter((param) => used.includes(param.name)) }
  }

  /** Runs a request that can be called off, and says where in the editor the database found a mistake. */
  const attempt = async (text: string, from: number, request: (signal: AbortSignal) => Promise<void>, failed?: (message: string) => void) => {
    const control = new AbortController()
    flight.current = control
    setRunning(true)
    setError(null)
    setProblem(null)
    setBottomOpen(true)
    try {
      await request(control.signal)
    } catch (e) {
      // Called off: what was there before stays as it was.
      if (control.signal.aborted) return
      const failure = toApiError(e)
      setError(failure)
      failed?.(errorText(failure))
      // The database counts from where what it was given starts.
      if (failure.position !== undefined) setProblem({ at: from + indexOfCharacter(text, failure.position), message: errorText(failure) })
    } finally {
      if (flight.current === control) {
        flight.current = null
        setRunning(false)
      }
    }
  }

  // The same two steps a dataset takes: ask what the SQL returns, then read
  // its rows as a dataset with one field per column.
  const rowsOf = async (text: string, params: SqlParam[], limit: number, signal: AbortSignal): Promise<Outcome> => {
    const columns = await unwrap(api.POST('/datasources/{id}/describe', { params: { path: { id: source!.id } }, body: { source: { type: 'sql', sql: text }, params }, signal }))
    const taken = new Set<string>()
    const fields: SpecField[] = columns.map((column) => ({ key: makeKey(column.name, taken), label: column.name, column: column.name, type: column.type, role: 'dimension' }))
    const spec: DatasetSpec = { specVersion: 1, source: { type: 'sql', sql: text }, ...(params.length ? { params } : {}), fields }
    const result = await unwrap(api.POST('/datasets/preview', { body: { datasourceId: source!.id, limit, spec: spec as unknown as Record<string, unknown> }, signal }))
    return { columns, result }
  }

  const run = () => {
    if (!sql.trim() || !source || running) return
    // With something selected, that is what runs: a part of the SQL can be tried by itself.
    const { text, from, params } = subject()
    const ran: SqlRun = { sql: text, datasourceId: source.id, at: Date.now(), ...(params.length ? { params } : {}) }
    setBottomTab('result')
    void attempt(
      text,
      from,
      async (signal) => {
        const got = await rowsOf(text, params, rowLimit, signal)
        setOutcome(got)
        onRecord({ ...ran, rows: got.result.rows.length, ms: got.result.meta.durationMs })
      },
      (message) => onRecord({ ...ran, error: message }),
    )
  }

  /** Shows the first rows of a table, without touching what is being written. */
  const peek = (table: string) => {
    if (!source || running) return
    const text = `SELECT * FROM ${table}`
    setBottomTab('result')
    void attempt(text, 0, async (signal) => setOutcome({ ...(await rowsOf(text, [], peekRows, signal)), of: table }))
  }

  const explain = () => {
    if (!sql.trim() || !source || running) return
    const { text, from, params } = subject()
    setBottomTab('plan')
    void attempt(text, from, async (signal) => setPlan(await unwrap(api.POST('/datasources/{id}/explain', { params: { path: { id: source.id } }, body: { source: { type: 'sql', sql: text }, params }, signal }))))
  }

  const format = async () => {
    setFormatFailed(false)
    // With something selected, that is what is laid out, and the rest is left as it is.
    const picked = editor.current?.selection()
    const part = picked?.text.trim() ? picked : null
    try {
      const formatted = await formatSql(part ? part.text : sql, source?.type)
      if (part) editor.current?.replace(formatted)
      else if (formatted !== sql) setSql(formatted)
    } catch {
      setFormatFailed(true)
    }
  }

  const restore = (past: SqlRun) => {
    setSql(past.sql)
    if (datasources.some((item) => item.id === past.datasourceId)) setDatasourceId(past.datasourceId)
    if (past.params) setKnownParams((known) => past.params!.map(toDraft).reduce(remember, known))
  }

  // SQL is part of the dataset draft. Exploration never writes a saved resource.
  const publish = async () => {
    if (isSessionChanging() || applying) return
    setHandoffError(null)
    setHandoffMessage(null)
    const handoff: SqlHandoff = { sql, datasourceId, params: declared }
    if (returnTo) {
      setApplying(true)
      const accepted = await returnSqlHandoff(returnTo, handoff)
      setApplying(false)
      setHandoffMessage(accepted ? 'applied' : 'unavailable')
      if (accepted) {
        setApplied(now)
        // Persist before returning to the original browser tab.
        try { localStorage.setItem(draftKey, JSON.stringify({ ...handoff, applied: now })) } catch { /* Browser storage can be unavailable. */ }
      }
      return
    }
    const destination = reserveSqlDestination()
    if (!destination) {
      setHandoffError(new ApiError(0, 'browser_popup_blocked', t('workbench.newTabBlocked')))
      return
    }
    try {
      openSqlDataset(handoff, { folderId }, destination)
    } catch (e) {
      destination.close()
      setHandoffError(toApiError(e))
    }
  }

  // ---- the tables ----

  const wanted = filter.trim().toLowerCase()
  const says = (text: string | undefined) => Boolean(text && text.toLowerCase().includes(wanted))
  const matches = (table: SourceTable) => says(table.name) || says(table.comment)
  const listedTables = found ? found.tables.filter((table) => !wanted || matches(table) || table.columns.some((column) => says(column.name) || says(column.comment))) : []
  const qualified = (table: { catalog?: string; schema?: string; name: string }) => [table.catalog, table.schema, table.name].filter(Boolean).join('.')
  // Naming a table or column puts it where the cursor is; an empty editor gets a whole query.
  const insert = (text: string, table?: string) => {
    if (!sql.trim()) setSql(table ? `SELECT * FROM ${table}` : text)
    else if (editor.current) editor.current.insert(text)
    // The editor is not there yet: at the end is the only place there is.
    else setSql(`${sql.replace(/\s+$/, '')} ${text}`)
  }

  const types = new Map<string, LogicalType>(outcome?.columns.map((column) => [column.name, column.type]))
  // What SQL returns is shown as it is: no dataset says how its numbers are written yet.
  const raw = (column: ResultColumn): ResultColumn => ({ ...column, format: undefined })
  const count = outcome?.result.rows.length ?? 0
  const limit = outcome?.of ? peekRows : rowLimit

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const renderTable = (table: SourceTable, depth: number): ReactNode => {
    const full = qualified(table)
    const key = [...table.path, table.name].join('\u0000')
    const isOpen = openTables.includes(key) || Boolean(wanted && !matches(table))
    return (
      <div key={key} role="group" aria-label={full}>
        <div className="wb-row folder" style={{ paddingLeft: 8 + depth * 14 }}>
          <button type="button" className="wb-icon-button wb-row-toggle" aria-label={t('workbench.columnsOf', { name: full })} aria-expanded={isOpen} onClick={() => setOpenTables(isOpen ? openTables.filter((item) => item !== key) : [...openTables, key])}>
            <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={12} />
          </button>
          <button type="button" className="wb-row-text" title={[full, table.comment, t('workbench.insertName')].filter(Boolean).join('\n')} onClick={() => insert(full, full)}>
            <Icon name="table" />
            <span className="schema-name">{table.name}</span>
            <span className="schema-comment">{table.comment}</span>
          </button>
          <Tooltip title={t('workbench.peek', { count: peekRows })}>
            <button type="button" className="wb-icon-button wb-row-more" aria-label={`${t('workbench.peek', { count: peekRows })} ${full}`} disabled={running} onClick={() => peek(full)}>
              <Icon name="rows" size={14} />
            </button>
          </Tooltip>
        </div>
        {isOpen &&
          table.columns
            .filter((column) => !wanted || matches(table) || says(column.name) || says(column.comment))
            .map((column) => {
              const kind = kindOf(column.dbType)
              return (
                <button key={column.name} type="button" className="wb-row schema-column" style={{ paddingLeft: 8 + depth * 14 + 20 }} title={[`${column.name} · ${column.dbType}`, column.comment, t('workbench.insertName')].filter(Boolean).join('\n')} onClick={() => insert(column.name)}>
                  {/* What kind of value it holds, at a glance; the database's own name for it is at the end of the row. */}
                  <KindMark kind={kind} />
                  <span className="schema-name">{column.name}</span>
                  <span className="schema-comment">{column.comment}</span>
                  <span className="schema-type">{column.dbType}</span>
                </button>
              )
            })}
      </div>
    )
  }

  // The tables under one place, as a tree: first the places inside it, in
  // the order the database listed them, then the tables that are right there.
  const renderLevel = (inside: SourceTable[], depth: number): ReactNode => {
    const places: string[] = []
    for (const table of inside) {
      const place = table.path[depth]
      if (place !== undefined && !places.includes(place)) places.push(place)
    }
    return (
      <>
        {places.map((place) => {
          const members = inside.filter((table) => table.path[depth] === place)
          const key = members[0]!.path.slice(0, depth + 1).join('\u0000')
          const isOpen = !closedPlaces.includes(key)
          const toggle = () => setClosedPlaces(isOpen ? [...closedPlaces, key] : closedPlaces.filter((item) => item !== key))
          // The outermost of two levels is a catalog or database; what is inside it is a schema.
          const deepest = Math.max(...members.map((table) => table.path.length))
          return (
            <div key={key} role="group" aria-label={place}>
              <div
                className="wb-row folder"
                style={{ paddingLeft: 8 + depth * 14 }}
                role="button"
                tabIndex={0}
                aria-expanded={isOpen}
                onClick={toggle}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    toggle()
                  }
                }}
              >
                <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={12} />
                <Icon name={depth === 0 && deepest > 1 ? 'database' : 'schema'} />
                <span className="wb-row-name">{place}</span>
                <span className="wb-row-detail">{members.length}</span>
              </div>
              {isOpen && renderLevel(members, depth + 1)}
            </div>
          )
        })}
        {inside.filter((table) => table.path.length === depth).map((table) => renderTable(table, depth))}
      </>
    )
  }

  const hasParams = drafts.length + misnamed.length > 0
  const publishable = Boolean(sql.trim() && source) && !applying

  return (
    <>
      {exportRequest && <SqlExportDialog request={exportRequest} onClose={() => setExportRequest(undefined)} />}
      <div className="sql-toolbar" role="toolbar" aria-label={t('nav.explore')}>
        {running ? (
          <Tooltip title={t('workbench.cancelRun')}>
            <button type="button" className="wb-tool stop" aria-label={t('workbench.cancelRun')} onClick={() => flight.current?.abort()}>
              <Icon name="stop" />
            </button>
          </Tooltip>
        ) : (
          <Tooltip title={`${t(selected ? 'workbench.runSelection' : 'workbench.run')} (${runKey})`}>
            <button type="button" className="wb-tool run" aria-label={t(selected ? 'workbench.runSelection' : 'workbench.run')} disabled={!sql.trim() || !source} onClick={run}>
              <Icon name="play" />
            </button>
          </Tooltip>
        )}
        <Tooltip title={t('workbench.explain')}>
          <button type="button" className="wb-tool" aria-label={t('workbench.explain')} disabled={!sql.trim() || !source || running} onClick={explain}>
            <Icon name="plan" />
          </button>
        </Tooltip>
        <Tooltip title={`${t('workbench.format')} (${formatKey})`}>
          <button type="button" className="wb-tool" aria-label={t('workbench.format')} disabled={!sql.trim()} onClick={() => void format()}>
            <Icon name="format" />
          </button>
        </Tooltip>
        <span className="divider" />
        <Tooltip title={t(schemaOpen ? 'workbench.hideSchema' : 'workbench.showSchema')}>
          <button type="button" className={schemaOpen ? 'wb-tool on' : 'wb-tool'} aria-label={t(schemaOpen ? 'workbench.hideSchema' : 'workbench.showSchema')} aria-pressed={schemaOpen} onClick={() => setSchemaOpen(!schemaOpen)}>
            <Icon name="schema" />
          </button>
        </Tooltip>
        <button type="button" className="wb-tool" disabled={!publishable} onClick={() => void publish()}>
          <Icon name="dataset" />
          {t(returnTo ? 'workbench.applyAndReturn' : 'workbench.createDataset')}
        </button>
        <button type="button" className="wb-tool" disabled={!sql.trim() || !source || running} onClick={() => {
          if (!source || isSessionChanging()) return
          const current = subject()
          setExportRequest({ datasourceId: source.id, sql: current.text, params: current.params, name: (datasetName || t('exports.defaultName')).slice(0, 120) })
        }}><Icon name="download" />{t('exports.create')}</button>
        {returnTo && <span className="note small">{t('workbench.editingDatasetSql', { name: datasetName ?? untitled })}</span>}
        <span className="spacer" />
        {handoffMessage && <span className={`note small${handoffMessage === 'applied' ? '' : ' warning'}`} role="status">{t(handoffMessage === 'applied' ? 'workbench.sqlApplied' : 'workbench.sqlApplyUnavailable')}</span>}
        {handoffError && <span className="note small warning">{errorText(handoffError)}</span>}
        {formatFailed && <span className="note small warning">{t('workbench.formatFailed')}</span>}
        {running && (
          <span className="note small">
            {t('explore.running')} <Elapsed />
          </span>
        )}
        {/* The data source is chosen above its tables; here it is only said, for when they are put away. */}
        {source && (
          <span className="sql-source">
            <Icon name="database" size={14} />
            {source.name}
          </span>
        )}
      </div>
      <div className="sql-work">
        <div className="sql-editor">
          <CodeEditor
            aria-label={t('dataset.sql')}
            dialect={source?.type}
            tables={tables}
            problem={problem}
            lineNumbers
            fill
            placeholder={t('workbench.sqlHint', { count: rowLimit })}
            value={sql}
            onChange={setSql}
            onRun={run}
            onFormat={() => void format()}
            onSelectionChange={setSelected}
            handle={editor}
          />
        </div>
        {/* There only while the SQL names a parameter: it is the SQL that declares them. */}
        {hasParams && (
          <>
            <Resizer direction="horizontal" grows="backward" size={paramsWidth} min={200} max={480} onResize={setParamsWidth} label={t('params.resize')} />
            <aside className="sql-params" style={{ width: paramsWidth }} aria-label={t('params.title')}>
              <div className="wb-side-header">
                <span className="wb-side-title">
                  {t('params.title')} <span className="muted-inline">· {drafts.length}</span>
                </span>
                {/* How parameters are written is said once, on demand, and takes no room from them. */}
                <Tooltip title={t('params.hint', { placeholder: `{{${t('params.exampleName')}}}` })}>
                  <span className="wb-icon-button help" role="img" aria-label={t('params.help')} tabIndex={0}>
                    <Icon name="help" />
                  </span>
                </Tooltip>
              </div>
              {/* Most who write a parameter want rows of a date or a region, which a filter in the chart does better. */}
              <p className="note small sql-params-guide">{t('params.guide')}</p>
              <div className="sql-params-list">
                {drafts.map((draft) => {
                  const invalid = !validDefault(draft)
                  const multi = Boolean(draft.rest.multi)
                  return (
                    <div key={draft.name} className="sql-param" role="group" aria-label={draft.name}>
                      <div className="sql-param-head">
                        <span className="sql-param-name">{draft.name}</span>
                        <Select<LogicalType>
                          size="sm"
                          plain
                          aria-label={t('params.typeOf', { name: draft.name })}
                          value={draft.type}
                          options={logicalTypes.map((type) => ({ value: type, label: t(`dataset.types.${type}`), icon: <TypeMark type={type} named /> }))}
                          onChange={(type) => setParam({ ...draft, type })}
                        />
                      </div>
                      <Input size="sm" aria-label={t('params.labelOf', { name: draft.name })} placeholder={t('params.labelPlaceholder')} value={String(draft.rest.label ?? '')} onChange={(label) => setParam(withLabel(draft, label))} />
                      <div className="sql-param-options">
                        <Tooltip title={t('params.multiHint', { placeholder: `{{${draft.name}}}` })}>
                          <span>
                            <Checkbox aria-label={t('params.multiOf', { name: draft.name })} checked={multi} onChange={(on) => setParam(withMulti(draft, on))}>
                              {t('params.multi')}
                            </Checkbox>
                          </span>
                        </Tooltip>
                        <Tooltip title={t('params.requiredHint')}>
                          <span>
                            <Checkbox aria-label={t('params.requiredOf', { name: draft.name })} checked={Boolean(draft.rest.required)} onChange={(on) => setParam(withRequired(draft, on))}>
                              {t('params.required')}
                            </Checkbox>
                          </span>
                        </Tooltip>
                      </div>
                      {draft.type === 'boolean' && !multi ? (
                        <Select<string>
                          size="sm"
                          block
                          aria-label={t('params.defaultOf', { name: draft.name })}
                          value={draft.text === 'true' || draft.text === 'false' ? draft.text : ''}
                          options={[
                            { value: '', label: t('params.noDefault') },
                            { value: 'true', label: 'true' },
                            { value: 'false', label: 'false' },
                          ]}
                          onChange={(text) => setParam({ ...draft, text })}
                        />
                      ) : (
                        <Input size="sm" aria-label={t('params.defaultOf', { name: draft.name })} placeholder={multi ? t('params.multiPlaceholder') : t(`params.placeholders.${draft.type}`)} invalid={invalid} value={draft.text} onChange={(text) => setParam({ ...draft, text })} />
                      )}
                      {invalid && <span className="sql-param-note warning">{t('params.invalidDefault', { type: t(`dataset.types.${draft.type}`) })}</span>}
                    </div>
                  )
                })}
                {misnamed.map((item) => (
                  <div key={`!${item}`} className="sql-param" role="group" aria-label={item}>
                    <div className="sql-param-head">
                      <span className="sql-param-name invalid">{item || '{{ }}'}</span>
                    </div>
                    <span className="sql-param-note warning">{t('params.invalidName')}</span>
                  </div>
                ))}
              </div>
            </aside>
          </>
        )}
      </div>

      {/* The data source and the tables it has to read, in a panel of their own before the editor. */}
      {shown && (
        <AsidePanel label={t('workbench.schema')} open={schemaOpen}>
          {/* The data source is what the panel is of, so choosing it is the panel's heading. */}
          <div className="schema-head">
            <Select
              size="sm"
              block
              aria-label={t('dataset.datasource')}
              value={source ? datasourceId : undefined}
              placeholder={t('dataset.datasource')}
              options={datasources.map((item) => ({ value: item.id, label: `${item.name} · ${item.type}` }))}
              onChange={setDatasourceId}
            />
            <Tooltip title={t('workbench.refreshSchema')}>
              <button type="button" className="wb-icon-button" aria-label={t('workbench.refreshSchema')} disabled={!datasourceId || catalog.status === 'loading'} onClick={catalog.reload}>
                <Icon name="refresh" />
              </button>
            </Tooltip>
          </div>
          <div className="wb-side-filter">
            <Input size="sm" aria-label={t('workbench.filter')} placeholder={t('workbench.filterTables')} value={filter} onChange={setFilter} />
          </div>
          <div className="wb-tree" role="tree" aria-label={t('workbench.schema')}>
            {!datasourceId && <p className="wb-side-empty">{t('workbench.chooseSource')}</p>}
            {datasourceId && catalog.status === 'loading' && <p className="wb-side-empty">{t('common.loading')}</p>}
            {catalog.status === 'error' && <p className="wb-side-empty">{errorText(catalog.error)}</p>}
            {found && listedTables.length === 0 && <p className="wb-side-empty">{wanted ? t('workbench.noMatches') : t('workbench.noTables')}</p>}
            {renderLevel(listedTables, 0)}
            {found?.truncated && <p className="wb-side-empty">{t('workbench.schemaTruncated')}</p>}
          </div>
        </AsidePanel>
      )}

      {shown && outcome && <StatusItem>{t('explore.rows', { count, ms: outcome.result.meta.durationMs })}</StatusItem>}
      {shown && source && <StatusItem>{source.type}</StatusItem>}
      {shown && returnTo && dirty && <StatusItem tone="warning">{t('workbench.unsaved')}</StatusItem>}

      {shown && (
        <BottomPanel
          tab={bottomTab}
          onTab={setBottomTab}
          // Said beside the tabs, where it reads as a fact about the result and takes no room from the rows.
          extra={
            copied ? (
              <span className="wb-bottom-note">{t('workbench.copied')}</span>
            ) : outcome && !error && bottomTab === 'result' && (count >= limit || outcome.result.meta.truncated) ? (
              <Tooltip title={t('workbench.limited', { count })}>
                <span className="wb-bottom-note warning">{t('workbench.limitedShort', { count })}</span>
              </Tooltip>
            ) : outcome?.of && bottomTab === 'result' ? (
              <span className="wb-bottom-note">{outcome.of}</span>
            ) : undefined
          }
          tabs={[
            {
              key: 'result',
              label: t('workbench.result'),
              content:
                error && bottomTab === 'result' ? (
                  <ErrorAlert error={error} />
                ) : !outcome ? (
                  <p className="empty">{running ? t('explore.running') : t('workbench.notRun')}</p>
                ) : (
                  <DataTable
                    aria-label={t('workbench.result')}
                    rows={outcome.result.rows.map((cells) => ({ cells }))}
                    rowKey={(_, index) => String(index)}
                    pageSize={100}
                    pageKey={outcome.result}
                    empty={t('common.none')}
                    onCopy={copy}
                    columns={outcome.result.columns.map((column, index) => {
                      const title = column.label ?? column.name
                      return {
                        key: column.name,
                        title,
                        align: isNumeric(types.get(title) ?? column.type) ? ('right' as const) : ('left' as const),
                        sort: (a: { cells: unknown[] }, b: { cells: unknown[] }) => compareCells(a.cells[index], b.cells[index]),
                        text: (row: { cells: unknown[] }) => (row.cells[index] === null || row.cells[index] === undefined ? '' : String(row.cells[index])),
                        render: (row: { cells: unknown[] }) => (
                          <span className="tabular" title={t('workbench.copyHint')}>
                            {formatCell(row.cells[index] as never, raw(column), i18n.language)}
                          </span>
                        ),
                      }
                    })}
                  />
                ),
            },
            {
              key: 'columns',
              label: t('workbench.columns'),
              content: !outcome ? (
                <p className="empty">{t('workbench.notRun')}</p>
              ) : (
                <DataTable
                  aria-label={t('workbench.columns')}
                  rows={outcome.columns}
                  rowKey={(_, index) => String(index)}
                  columns={[
                    { key: 'name', title: t('common.name'), render: (column) => <code>{column.name}</code> },
                    { key: 'type', title: t('dataset.type'), render: (column) => t(`dataset.types.${column.type}`) },
                    { key: 'dbType', title: t('workbench.dbType'), render: (column) => <code>{column.dbType}</code> },
                  ]}
                />
              ),
            },
            {
              key: 'plan',
              label: t('workbench.plan'),
              content:
                error && bottomTab === 'plan' ? (
                  <ErrorAlert error={error} />
                ) : !plan ? (
                  <p className="empty">{running && bottomTab === 'plan' ? t('explore.running') : t('workbench.noPlan')}</p>
                ) : plan.columns.length === 1 ? (
                  // One column is the plan as text, where the indentation is the plan.
                  <pre className="sql-plan">{plan.rows.map((row) => String(row[0] ?? '')).join('\n')}</pre>
                ) : (
                  <DataTable
                    aria-label={t('workbench.plan')}
                    rows={plan.rows.map((cells) => ({ cells }))}
                    rowKey={(_, index) => String(index)}
                    columns={plan.columns.map((title, index) => ({ key: `${index}:${title}`, title, render: (row: { cells: unknown[] }) => <span className="sql-plan-cell">{row.cells[index] === null || row.cells[index] === undefined ? '' : String(row.cells[index])}</span> }))}
                  />
                ),
            },
            {
              key: 'history',
              label: t('workbench.history'),
              content: <History runs={history} datasources={datasources} onUse={restore} onChange={onHistory} />,
            },
          ]}
        />
      )}

    </>
  )
}

interface BodyProps extends Omit<ConsoleProps, 'initial' | 'applied'> {
  tab: Tab
  given?: Draft
}

function TabBody({ tab, given, ...rest }: BodyProps) {
  const transfer = tab.handoff ? readSqlHandoff(`?handoff=${tab.handoff}`) : undefined
  let kept: (Draft & { applied?: string }) | undefined
  try {
    const stored = localStorage.getItem(rest.draftKey)
    if (stored) kept = JSON.parse(stored) as typeof kept
  } catch { /* A missing local draft starts from the incoming SQL. */ }
  const initial = kept ?? given ?? transfer?.handoff ?? { sql: '', datasourceId: rest.datasources[0]?.id ?? '' }
  const original = given ?? transfer?.handoff
  const applied = kept?.applied ?? (original ? snapshot(original.datasourceId, original.sql, original.params ?? []) : undefined)
  return <Console {...rest} returnTo={tab.handoff} datasetName={tab.datasetName} folderId={tab.folderId} initial={initial} applied={applied} />
}

/** Local query tabs, with an explicit return destination when editing a dataset. */
export function SqlExplore({ active }: { active: boolean }) {
  const { t } = useTranslation()
  const session = useSession()
  const location = useLocation()
  const navigate = useNavigate()
  const [sources, setSources] = useState<Datasource[]>()
  const [sourceError, setSourceError] = useState<ApiError | null>(null)
  const [sourceAttempt, setSourceAttempt] = useState(0)
  const reloadSources = () => setSourceAttempt((attempt) => attempt + 1)
  // This page stays mounted. Refresh connections when returning from their
  // editor without unmounting query tabs, results or work still running.
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    let latest = 0
    const load = () => {
      const request = ++latest
      void unwrap(api.GET('/datasources', { signal: controller.signal })).then(
        (data) => {
          if (controller.signal.aborted || request !== latest) return
          setSources(data)
          setSourceError(null)
        },
        (error: unknown) => {
          if (!controller.signal.aborted && request === latest) setSourceError(toApiError(error))
        },
      )
    }
    load()
    window.addEventListener('focus', load)
    return () => { controller.abort(); window.removeEventListener('focus', load) }
  }, [active, sourceAttempt])
  const loaded = sources !== undefined
  const datasources = sources ?? []
  const workspaceId = session.state.status === 'ok' ? (session.state.data.workspace?.id ?? '') : ''
  const userId = session.state.status === 'ok' ? (session.state.data.user?.id ?? '') : ''
  const scope = `${userId}.${workspaceId}`
  const draftKey = (key: string) => `supabi.explore.draft.${scope}.${key}`
  // Keep the window's tab collection across reloads, even after another query
  // or page removes the handoff from the address. An explicit handoff
  // wins over session storage copied from the opener of a new browser window.
  const [browserNamespace] = useState(() => {
    const handoff = new URLSearchParams(location.search).get('handoff')
    const key = `supabi.explore.window.${scope}`
    try {
      if (handoff) sessionStorage.setItem(key, handoff)
      return handoff || sessionStorage.getItem(key)
    } catch {
      return handoff
    }
  })
  const tabsKey = `supabi.explore.tabs.${scope}${browserNamespace ? `.${browserNamespace}` : ''}`
  const [tabs, setShownTabs] = useState<Tabs>(() => keptTabs(tabsKey) ?? { open: [], active: '' })
  // Changes are worked out from what the tabs are now, which a render may not have caught up with.
  const latest = useRef(tabs)
  // Set while the list this window has could not be written, when it is the only copy of it.
  const unwritten = useRef(false)
  // Windows of the same workspace share the list of queries, and each shows its own one of them.
  // Every change starts from the list as it is kept, so that a query another window opened or
  // closed since is not undone by what this window last knew.
  const shared = useCallback((): Tabs => {
    const mine = latest.current
    const kept = unwritten.current ? null : keptTabs(tabsKey)
    if (!kept || JSON.stringify(kept.open) === JSON.stringify(mine.open)) return mine
    // The query it shows was closed elsewhere: the one in its place shows, as when it is closed here.
    const place = Math.max(mine.open.findIndex((tab) => tab.key === mine.active), 0)
    const active = kept.open.some((tab) => tab.key === mine.active) ? mine.active : (kept.open[Math.min(place, kept.open.length - 1)]?.key ?? '')
    return { open: kept.open, active }
  }, [tabsKey])
  const setTabs = useCallback(
    (change: (current: Tabs) => Tabs) => {
      latest.current = change(shared())
      setShownTabs(latest.current)
      try {
        localStorage.setItem(tabsKey, JSON.stringify(latest.current))
        unwritten.current = false
      } catch {
        // storage can be unavailable (private mode, embedded frames)
        unwritten.current = true
      }
    },
    [shared, tabsKey],
  )
  const ensureTabStored = useCallback((key: string) => {
    if (keptTabs(tabsKey)?.open.some((tab) => tab.key === key)) return
    // A failed tab-list write must recover too, or a saved draft is unreachable after reload.
    localStorage.setItem(tabsKey, JSON.stringify(latest.current))
    unwritten.current = false
  }, [tabsKey])
  // Visit tabs lazily and keep their running queries and results when switching.
  const [visited, setVisited] = useState<string[]>([])
  const [meta, setMeta] = useState<Record<string, Meta>>({})
  const given = useRef(new Map<string, Draft>())
  const [closing, setClosing] = useState<Tab | null>(null)
  const historyKey = `supabi.explore.history.${scope}`
  const [history, setHistory] = useState<SqlRun[]>(() => readHistory(historyKey))
  const runs = useRef(history)

  const onMeta = useCallback((key: string, next: Meta) => setMeta((current) => (current[key]?.name === next.name && current[key].dirty === next.dirty && current[key].running === next.running ? current : { ...current, [key]: next })), [])
  const onHistory = useCallback(
    (next: SqlRun[]) => {
      runs.current = next
      setHistory(next)
      try { localStorage.setItem(historyKey, JSON.stringify(next)) } catch { /* History remains available in memory. */ }
    },
    [historyKey],
  )
  // Dataset editors open separate exploration windows. A run must append to
  // their shared history, rather than overwrite it with this window's copy.
  const onRecord = useCallback((run: SqlRun) => onHistory(recorded(readHistory(historyKey, runs.current), run)), [historyKey, onHistory])
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== historyKey && event.key !== null) return
      const next = readHistory(historyKey, runs.current)
      runs.current = next
      setHistory(next)
    }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [historyKey])

  const pathOf = (tab: Tab | undefined) => `/explore${tab?.handoff ? `?handoff=${tab.handoff}` : ''}`
  /** The handoff remains in the address so a reload retains its return destination. */
  const show = (tab: Tab, replace = false) => void navigate(pathOf(tab), { replace, state: { tab: tab.key } })

  // Another window opened or closed a query: this one follows, and keeps showing its own.
  const follow = useRef<() => void>(() => undefined)
  follow.current = () => {
    const next = shared()
    if (next === latest.current) return
    const moved = next.active !== latest.current.active
    latest.current = next
    setShownTabs(next)
    const shown = next.open.find((tab) => tab.key === next.active)
    if (active && moved) void navigate(pathOf(shown), { replace: true, state: shown ? { tab: shown.key } : undefined })
  }
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === tabsKey) follow.current()
    }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [tabsKey])

  // Incoming SQL starts a tab; returning through navigation restores the active one.
  const handled = useRef('')
  useEffect(() => {
    if (!active || !loaded || datasources.length === 0 || handled.current === location.key) return
    handled.current = location.key
    const state = location.state as (Partial<SqlHandoff> & { tab?: string }) | null
    const search = new URLSearchParams(location.search)
    const transfer = readSqlHandoff(location.search)
    const handoff = search.get('handoff') ?? undefined
    const current = latest.current
    if (handoff) {
      const previous = current.open.find((tab) => tab.handoff === handoff)
      if (previous) setTabs((now) => ({ ...now, active: previous.key }))
      else setTabs((now) => {
        const next = tabsOpened(now, { datasetName: transfer?.datasetName, handoff })
        if (transfer) given.current.set(next.active, transfer.handoff)
        return next
      })

    } else if (state?.tab && current.open.some((tab) => tab.key === state.tab)) {
      setTabs((now) => ({ ...now, active: state.tab! }))
    } else {
      const folderId = search.get('folder') ?? undefined
      const table = search.get('table')
      const datasource = search.get('datasource') ?? ''
      // Coming with SQL, from a dataset or a data source, starts a tab with it.
      const start: Draft | undefined =
        typeof state?.sql === 'string'
          ? { sql: state.sql, datasourceId: state.datasourceId ?? '', params: state.params }
          : table && /^[A-Za-z_][A-Za-z0-9_]*$/.test(table)
            ? { sql: `SELECT * FROM "${table}"`, datasourceId: datasource }
            : datasource
              ? { sql: '', datasourceId: datasource }
              : undefined
      if (start || folderId || current.open.length === 0) {
        setTabs((now) => {
          const next = tabsOpened(now, { folderId })
          if (start) given.current.set(next.active, start)
          return next
        })
        show(latest.current.open.find((tab) => tab.key === latest.current.active)!, true)
      } else {
        const shown = current.open.find((tab) => tab.key === current.active) ?? current.open[0]!
        if (shown.key !== current.active) setTabs((now) => ({ ...now, active: shown.key }))
        if (shown.handoff) void navigate(pathOf(shown), { replace: true })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- acted on when the address changes, not when what it is read with does
  }, [active, loaded, location.key, datasources.length])

  useEffect(() => {
    if (tabs.active && !visited.includes(tabs.active)) setVisited([...visited, tabs.active])
  }, [tabs.active, visited])

  const close = (tab: Tab) => {
    setClosing(null)
    forget(draftKey(tab.key))
    given.current.delete(tab.key)
    setMeta((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== tab.key)))
    const wasShowing = latest.current.active === tab.key
    setTabs((now) => tabsClosed(now, tab.key))
    const next = latest.current.open.find((other) => other.key === latest.current.active)
    if (active && wasShowing) void navigate(pathOf(next), { replace: true, state: next ? { tab: next.key } : undefined })
  }

  const sourceFailure = sourceError && <div className="row"><ErrorAlert error={sourceError} /><Button onClick={reloadSources}>{t('common.retry')}</Button></div>
  if (!loaded && sourceFailure) return <div className="wb-landing">{sourceFailure}</div>

  if (!loaded) return <p className="muted">{t('common.loading')}</p>
  if (datasources.length === 0) {
    return (
      <div className="wb-landing">
        {sourceFailure}
        <Icon name="explore" size={40} />
        <p>{t('dataset.needDatasource')}</p>
        <Link target="_blank" rel="noopener noreferrer" to="/workbench/datasources/new">{t('datasource.add')}</Link>
      </div>
    )
  }

  const untitled = (tab: Tab) => t('workbench.untitledQuery', { n: tab.n ?? 1 })
  const nameOf = (tab: Tab) => meta[tab.key]?.name ?? tab.datasetName ?? untitled(tab)
  return (
    <div className="sql-explore">
      {sourceFailure}
      <div className="sql-tabs" role="tablist" aria-label={t('workbench.openQueries')}>
        {tabs.open.map((tab) => {
          const showing = tab.key === tabs.active
          const about = meta[tab.key]
          const dirty = about ? about.dirty : keptDirty(draftKey(tab.key), Boolean(tab.handoff))
          return (
            <div key={tab.key} className={showing ? 'sql-tab active' : 'sql-tab'}>
              <button type="button" role="tab" aria-selected={showing} className="sql-tab-name" title={nameOf(tab)} onClick={() => show(tab)}>
                <Icon name="sql" size={14} />
                <span>{nameOf(tab)}</span>
              </button>
              {/* Where the mark of unsaved work is, pointing at it offers to close. */}
              <button type="button" className={dirty ? 'wb-icon-button sql-tab-close dirty' : 'wb-icon-button sql-tab-close'} aria-label={`${t('workbench.closeTab')} ${nameOf(tab)}`} onClick={() => (dirty ? setClosing(tab) : close(tab))}>
                <Icon name="close" size={12} />
              </button>
            </div>
          )
        })}
        <Tooltip title={t('workbench.newTab')}>
          <button
            type="button"
            className="wb-icon-button"
            aria-label={t('workbench.newTab')}
            onClick={() => {
              setTabs((now) => tabsOpened(now, {}))
              show(latest.current.open.find((tab) => tab.key === latest.current.active)!)
            }}
          >
            <Icon name="plus" />
          </button>
        </Tooltip>
      </div>
      {tabs.open.map(
        (tab) =>
          visited.includes(tab.key) && (
            <div key={tab.key} className="sql-tab-body" role="tabpanel" hidden={tab.key !== tabs.active}>
              <TabBody
                tab={tab}
                tabKey={tab.key}
                given={given.current.get(tab.key)}
                shown={active && tab.key === tabs.active}
                datasources={datasources}
                draftKey={draftKey(tab.key)}
                ensureTabStored={ensureTabStored}
                untitled={untitled(tab)}
                history={history}
                onRecord={onRecord}
                onHistory={onHistory}
                onMeta={onMeta}
              />
            </div>
          ),
      )}

      <Dialog
        open={closing !== null}
        title={t('workbench.closeTitle', { name: closing ? nameOf(closing) : '' })}
        width={420}
        onClose={() => setClosing(null)}
        actions={
          <>
            <Button onClick={() => setClosing(null)}>{t('common.cancel')}</Button>
            <Button danger onClick={() => closing && close(closing)}>
              {t('workbench.closeDiscard')}
            </Button>
          </>
        }
      >
        <p>{t('workbench.closeBody')}</p>
      </Dialog>
    </div>
  )
}
