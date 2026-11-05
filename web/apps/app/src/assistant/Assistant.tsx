import type { Viz } from '@supabi/charts'
import { Alert, Button, ChatCite, ChatFigure, ChatInput, ChatMarkdown, ChatMessage, ChatPending, ChatSources, ChatSteps, ChatThread, Dialog, Input, Menu, useChatThread, type ChatSource, type ChatStep, type ColorScheme, type MenuItem } from '@supabi/ui'
import type { TFunction } from 'i18next'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Link, NavLink, useNavigate, useParams } from 'react-router'
import { api, unwrap, type ApiError, type QueryResult } from '../api/client'
import { toApiError, useAsync } from '../api/useAsync'
import { useSession } from '../auth/session'
import { Async } from '../components/Async'
import { ChartView } from '../components/ChartView'
import { ErrorAlert } from '../components/ErrorAlert'
import { Icon } from '../components/Icon'
import { dashboardLink } from '../components/ShareDashboardDialog'
import { usePageTitle } from '../lib/documentTitle'
import { citedOf, groupParts, messageText, streamEvents, withText, withTool, type AnswerChart, type AnswerSource, type AssistantEvent, type AssistantMessage, type AssistantMessagePart, type Calculation, type Cited, type Conversation } from './stream'
import './assistant.css'

/** An answer being written in this page: what has arrived of it so far. */
interface Live {
  conversationId: string
  answerId: string
  parts: AssistantMessagePart[]
  status?: AssistantEvent['status']
}

/** Puts a message in its place in a conversation: replaces the one with its id, or adds it in order. */
function upsert(items: AssistantMessage[], message: AssistantMessage | undefined): AssistantMessage[] {
  if (!message) return items
  return [...items.filter((item) => item.id !== message.id), message].sort((a, b) => a.seq - b.seq)
}

/** How long deltas gather before the answer is drawn again, so that a fast model does not redraw it for every few characters. */
const drawEvery = 50

/** The AI assistant: a person's conversations in the current workspace, and the one open. See .agents/design/ai-assistant.md. */
export function Assistant({ colorScheme }: { colorScheme: ColorScheme }) {
  const { t } = useTranslation()
  const { id } = useParams()
  const navigate = useNavigate()
  const status = useAsync(() => unwrap(api.GET('/assistant')), [])
  const conversations = useAsync(() => unwrap(api.GET('/assistant/conversations')), [], { keepData: true })
  const [messages, setMessages] = useState<{ id: string; items: AssistantMessage[] } | null>(null)
  const [loadError, setLoadError] = useState<ApiError | null>(null)
  const [live, setLiveState] = useState<Live | null>(null)
  // What is being written, for the handlers that end it to read.
  const liveRef = useRef<Live | null>(null)
  const setLive = (next: Live | null | ((l: Live | null) => Live | null)) => {
    liveRef.current = typeof next === 'function' ? next(liveRef.current) : next
    setLiveState(liveRef.current)
  }
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<{ conversationId: string | undefined; error: ApiError } | null>(null)
  const controller = useRef<AbortController | null>(null)
  // A conversation just started here has no messages to load yet.
  const started = useRef<string | null>(null)

  // Leaving the page stops the answer being written, as closing it does.
  useEffect(() => () => controller.current?.abort(), [])

  useEffect(() => {
    setLoadError(null)
    if (!id) {
      setMessages(null)
      return
    }
    if (started.current === id) {
      started.current = null
      return
    }
    let current = true
    setMessages((m) => (m?.id === id ? m : null))
    unwrap(api.GET('/assistant/conversations/{id}/messages', { params: { path: { id } } })).then(
      // Messages that arrived here meanwhile are kept.
      (items) => current && setMessages((m) => ({ id, items: m?.id === id ? m.items.reduce(upsert, items) : items })),
      (error: unknown) => current && setLoadError(toApiError(error)),
    )
    return () => {
      current = false
    }
  }, [id])

  const list = conversations.status === 'ok' ? conversations.data : []
  const conversation = list.find((c) => c.id === id)
  usePageTitle(conversation?.title || t('assistant.title'))

  /** Runs a request that writes an answer, showing it as it arrives. */
  const write = (conversationId: string, path: string, body: unknown) => {
    const abort = new AbortController()
    controller.current = abort
    // The answer this request writes. The request stays open after it is
    // done while the conversation is named, and another may start meanwhile.
    let answerId: string | undefined
    const mine = (l: Live | null): l is Live => l !== null && l.answerId === answerId
    let pending = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    const draw = () => {
      timer = undefined
      const piece = pending
      pending = ''
      setLive((l) => (mine(l) ? { ...l, parts: withText(l.parts, piece), status: undefined } : l))
    }
    const onEvent = (event: AssistantEvent) => {
      switch (event.type) {
        case 'start':
          setSending(false)
          setDraft('')
          // Unless another conversation was opened meanwhile.
          setMessages((m) => (m && m.id !== conversationId ? m : { id: conversationId, items: upsert(upsert(m?.items ?? [], event.question), event.answer) }))
          answerId = event.answer!.id
          setLive({ conversationId, answerId, parts: [], status: 'thinking' })
          break
        case 'status':
          if (pending) draw()
          setLive((l) => (mine(l) ? { ...l, status: event.status } : l))
          break
        case 'tool':
          if (pending) draw()
          setLive((l) => (mine(l) && event.part ? { ...l, parts: withTool(l.parts, event.part), status: undefined } : l))
          break
        case 'delta':
          pending += event.text ?? ''
          timer ??= setTimeout(draw, drawEvery)
          break
        case 'done':
          clearTimeout(timer)
          timer = undefined
          setLive((l) => (mine(l) ? null : l))
          setMessages((m) => (m?.id === conversationId ? { id: conversationId, items: upsert(m.items, event.answer) } : m))
          conversations.reload()
          break
        case 'title':
          conversations.reload()
          break
      }
    }
    void streamEvents(path, body, onEvent, abort.signal)
      .catch((error: unknown) => setSendError({ conversationId, error: toApiError(error) }))
      .finally(() => {
        clearTimeout(timer)
        if (controller.current !== abort) return
        controller.current = null
        setSending(false)
        // Stopped, or the connection was lost: the server keeps what it had.
        const ended = liveRef.current
        if (mine(ended)) {
          setLive(null)
          setMessages((m) =>
            m?.id === conversationId
              ? { id: conversationId, items: m.items.map((item) => (item.id === ended.answerId ? { ...item, status: 'stopped', parts: withText(ended.parts.filter((part) => part.type !== 'tool' || part.done), pending) } : item)) }
              : m,
          )
        }
      })
  }

  const send = async () => {
    const text = draft
    if (!text.trim() || sending || live) return
    setSending(true)
    setSendError(null)
    let conversationId = id
    if (!conversationId) {
      try {
        const created = await unwrap(api.POST('/assistant/conversations'))
        conversationId = created.id
      } catch (error) {
        setSending(false)
        setSendError({ conversationId: undefined, error: toApiError(error) })
        return
      }
      started.current = conversationId
      setMessages({ id: conversationId, items: [] })
      void navigate(`/assistant/${conversationId}`, { replace: true })
      conversations.reload()
    }
    write(conversationId, `/assistant/conversations/${conversationId}/messages`, { text })
  }

  const retry = (message: AssistantMessage) => {
    if (!id || live) return
    setSendError(null)
    write(id, `/assistant/messages/${message.id}/retry`, undefined)
  }

  const removed = (conversationId: string) => {
    if (liveRef.current?.conversationId === conversationId) controller.current?.abort()
    conversations.reload()
    if (conversationId === id) void navigate('/assistant')
  }

  const configured = status.status === 'ok' && status.data.configured
  const items = messages && messages.id === id ? messages.items : []
  const error = sendError && sendError.conversationId === id ? sendError.error : null

  return (
    <div className="assistant">
      <aside className="island assistant-list" aria-label={t('assistant.conversations')}>
        <div className="assistant-list-head">
          <Button variant="primary" size="sm" icon={<Icon name="plus" size={14} />} onClick={() => void navigate('/assistant')}>
            {t('assistant.new')}
          </Button>
        </div>
        <Async state={conversations} reload={conversations.reload}>
          {(rows) =>
            rows.length === 0 ? (
              <p className="assistant-list-empty note">{t('assistant.noConversations')}</p>
            ) : (
              <nav className="assistant-conversations">
                {rows.map((c) => (
                  <ConversationLink key={c.id} conversation={c} writing={live?.conversationId === c.id} onRenamed={conversations.reload} onDeleted={() => removed(c.id)} />
                ))}
              </nav>
            )
          }
        </Async>
      </aside>
      <section className="island assistant-chat" aria-label={conversation?.title || t('assistant.new')}>
        <Messages
          key={id ?? 'new'}
          items={items}
          loading={Boolean(id) && !messages && !loadError}
          loadError={loadError}
          live={live}
          writing={Boolean(live) || sending}
          onRetry={retry}
          colorScheme={colorScheme}
        />
        <div className="assistant-footer">
          {status.status === 'ok' && !configured && <NotConfigured />}
          {status.status === 'error' && <ErrorAlert error={status.error} />}
          {error && <ErrorAlert error={error} />}
          <ChatInput
            value={draft}
            onChange={setDraft}
            disabled={!configured || Boolean(loadError)}
            busy={sending}
            writing={live?.conversationId === id && Boolean(id)}
            // While an answer is written in another conversation.
            sendDisabled={Boolean(live) && live?.conversationId !== id}
            placeholder={t('assistant.placeholder')}
            aria-label={t('assistant.message')}
            onSend={() => void send()}
            onStop={() => controller.current?.abort()}
          />
        </div>
      </section>
    </div>
  )
}

function NotConfigured() {
  const { t } = useTranslation()
  const { isOrgAdmin } = useSession()
  return (
    <Alert tone="info" title={t('assistant.notConfigured')}>
      {isOrgAdmin && <Link to="/settings/system/ai">{t('assistant.configure')}</Link>}
    </Alert>
  )
}

function ConversationLink({ conversation, writing, onRenamed, onDeleted }: { conversation: Conversation; writing: boolean; onRenamed: () => void; onDeleted: () => void }) {
  const { t } = useTranslation()
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const title = conversation.title || t('assistant.untitled')
  const items: MenuItem[] = [
    { key: 'rename', label: t('assistant.rename'), onSelect: () => setRenaming(true) },
    { key: 'delete', label: t('common.delete'), danger: true, onSelect: () => setDeleting(true) },
  ]
  return (
    <div className="assistant-conversation">
      <NavLink to={`/assistant/${conversation.id}`} title={title}>
        <span className="assistant-conversation-title">{title}</span>
        {writing && <span className="assistant-writing-dot" aria-label={t('assistant.writing')} />}
      </NavLink>
      <Menu items={items} placement="bottomRight">
        <button type="button" className="assistant-conversation-more" aria-label={t('assistant.actionsOf', { title })}>
          <Icon name="more" size={14} />
        </button>
      </Menu>
      {renaming && <RenameDialog conversation={conversation} onClose={(renamed) => { setRenaming(false); if (renamed) onRenamed() }} />}
      {deleting && <DeleteDialog conversation={conversation} title={title} onClose={(deleted) => { setDeleting(false); if (deleted) onDeleted() }} />}
    </div>
  )
}

function RenameDialog({ conversation, onClose }: { conversation: Conversation; onClose: (renamed: boolean) => void }) {
  const { t } = useTranslation()
  const [title, setTitle] = useState(conversation.title)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const save = () => {
    setBusy(true)
    setError(null)
    unwrap(api.PATCH('/assistant/conversations/{id}', { params: { path: { id: conversation.id } }, body: { title } })).then(
      () => onClose(true),
      (e: unknown) => {
        setBusy(false)
        setError(toApiError(e))
      },
    )
  }
  return (
    <Dialog
      open
      width={420}
      title={t('assistant.rename')}
      onClose={() => onClose(false)}
      actions={
        <>
          <Button variant="ghost" onClick={() => onClose(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy} disabled={!title.trim()} onClick={save}>{t('common.save')}</Button>
        </>
      }
    >
      <div className="stack">
        <Input aria-label={t('assistant.conversationTitle')} value={title} maxLength={100} onChange={setTitle} />
        {error && <ErrorAlert error={error} />}
      </div>
    </Dialog>
  )
}

function DeleteDialog({ conversation, title, onClose }: { conversation: Conversation; title: string; onClose: (deleted: boolean) => void }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const remove = () => {
    setBusy(true)
    setError(null)
    unwrap(api.DELETE('/assistant/conversations/{id}', { params: { path: { id: conversation.id } } })).then(
      () => onClose(true),
      (e: unknown) => {
        setBusy(false)
        setError(toApiError(e))
      },
    )
  }
  return (
    <Dialog
      open
      width={420}
      title={t('assistant.deleteTitle')}
      onClose={() => onClose(false)}
      actions={
        <>
          <Button variant="ghost" onClick={() => onClose(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" danger loading={busy} onClick={remove}>{t('common.delete')}</Button>
        </>
      }
    >
      <div className="stack">
        <p>{t('assistant.deleteConfirm', { title })}</p>
        {error && <ErrorAlert error={error} />}
      </div>
    </Dialog>
  )
}

interface MessagesProps {
  items: AssistantMessage[]
  loading: boolean
  loadError: ApiError | null
  live: Live | null
  writing: boolean
  onRetry: (message: AssistantMessage) => void
  colorScheme: ColorScheme
}

/** The messages of a conversation. An answer that starts takes the reader to the end. */
function Messages({ items, loading, loadError, live, writing, onRetry, colorScheme }: MessagesProps) {
  const { t } = useTranslation()
  let body
  if (loadError) body = <ErrorAlert error={loadError} />
  else if (loading) body = <p className="note assistant-loading">{t('common.loading')}</p>
  else if (items.length === 0)
    body = (
      <div className="assistant-welcome">
        <h2>{t('assistant.welcome')}</h2>
        <p className="note">{t('assistant.welcomeNote')}</p>
      </div>
    )
  else
    body = items.map((m, i) =>
      m.role === 'user' ? (
        <ChatMessage key={m.id} from="user">
          {messageText(m)}
        </ChatMessage>
      ) : (
        <Answer key={m.id} message={m} live={live?.answerId === m.id ? live : undefined} last={i === items.length - 1} writing={writing} onRetry={() => onRetry(m)} colorScheme={colorScheme} />
      ),
    )
  return (
    <ChatThread latest={live?.answerId} aria-label={t('assistant.thread')}>
      {body}
    </ChatThread>
  )
}

function Answer({ message, live, last, writing, onRetry, colorScheme }: { message: AssistantMessage; live?: Live; last: boolean; writing: boolean; onRetry: () => void; colorScheme: ColorScheme }) {
  const { t, i18n } = useTranslation()
  const parts = live ? live.parts : message.parts
  const generating = Boolean(live) || message.status === 'generating'
  const code = message.error || 'internal'
  const groups = groupParts(parts)
  const cited = citedOf(parts)
  const sourceId = (n: number) => `source-${message.id}-${n}`
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const thread = useChatThread()
  // A citation takes the reader to its source, unfolding the sources first, which shows it is the one.
  const cite = useCallback(
    (n: number) => {
      flushSync(() => setSourcesOpen(true))
      const element = document.getElementById(`source-${message.id}-${n}`)
      if (element) thread.reveal(element)
    },
    [message.id, thread],
  )
  // While nothing is being written, say what the answer is doing; a tool running says so itself.
  const busy = parts.some((part) => part.type === 'tool' && !part.done)
  const pending = generating && !busy && (live ? live.status !== undefined || parts.length === 0 : parts.length === 0)
  return (
    <ChatMessage from="assistant" busy={generating}>
      {groups.map((group, i) =>
        group.kind === 'text' ? (
          <ChatMarkdown key={i} text={group.text} streaming={generating && i === groups.length - 1} sources={cited.length} onCite={cite} />
        ) : group.kind === 'chart' ? (
          <Figure key={i} chart={group.chart} cited={cited} colorScheme={colorScheme} onCite={cite} />
        ) : (
          <ChatSteps key={i} steps={group.parts.map((part) => toolStep(part, t))} summary={t('assistant.steps', { count: group.parts.filter((part) => part.done).length })} />
        ),
      )}
      {pending && <ChatPending>{t(live?.status === 'compressing' ? 'assistant.compressing' : 'assistant.thinking')}</ChatPending>}
      {!live && message.status === 'generating' && parts.length > 0 && <p className="note small">{t('assistant.stillWriting')}</p>}
      {cited.length > 0 && <Sources cited={cited} id={sourceId} open={sourcesOpen} onOpenChange={setSourcesOpen} onCite={cite} />}
      {message.status === 'stopped' && <p className="note small">{t('assistant.stopped')}</p>}
      {message.status === 'failed' && (
        <Alert tone="error" title={i18n.exists(`assistant.errors.${code}`) ? t(`assistant.errors.${code}`) : t('assistant.errors.internal')}>
          {last ? (
            <Button size="sm" disabled={writing} onClick={onRetry}>
              {t('common.retry')}
            </Button>
          ) : undefined}
        </Alert>
      )}
    </ChatMessage>
  )
}

/** A tool an answer called, as a step it took: what it did, and to what. */
function toolStep(part: AssistantMessagePart, t: TFunction): ChatStep {
  const tool = part.tool ?? ''
  const known = ['list_dashboards', 'describe_dashboard', 'filter_options', 'query_chart', 'calculate', 'draw_chart'].includes(tool)
  const state = !part.done ? 'running' : part.failed ? 'failed' : 'done'
  const what = known ? t(`assistant.tools.${tool}.${state === 'running' ? 'running' : 'done'}`) : t('assistant.tools.other', { name: tool })
  const label = part.subject && state !== 'running' ? t('assistant.tools.on', { what, subject: part.subject }) : what
  return { key: part.callId ?? tool, label: state === 'failed' ? t('assistant.tools.failed', { label }) : label, state }
}

/** A value of a condition in words: a list as its items, a missing value named. */
function valueText(value: unknown, t: TFunction): string {
  if (value === null || value === undefined) return t('assistant.source.null')
  if (Array.isArray(value)) return value.map((item) => valueText(item, t)).join(t('assistant.source.and'))
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** A result as people write numbers: grouped, as many places as it has. Past what a number holds exactly, as it came. */
function resultText(value: string, locale: string): string {
  const n = Number(value)
  return Number.isFinite(n) && Math.abs(n) < 1e15 ? n.toLocaleString(locale, { maximumFractionDigits: 10 }) : value
}

/**
 * An expression with its inputs by what they are, each citing its source, and
 * what it came to: a calculation's figure, or the name of a chart's series
 * worked out row by row, which is written before it.
 */
function Formula({ expression, inputs: given, result, name, onCite }: { expression: string; inputs: { name: string; label: string; source?: number }[]; result?: string; name?: string; onCite: (n: number) => void }) {
  const { i18n } = useTranslation()
  const inputs = new Map(given.map((input) => [input.name, input]))
  const signs: Record<string, string> = { '*': ' × ', '×': ' × ', '/': ' ÷ ', '÷': ' ÷ ', '-': ' − ', '−': ' − ', '+': ' + ' }
  return (
    <>
      {name !== undefined && `${name} = `}
      {(expression.match(/[\p{L}_][\p{L}\p{N}_]*|[\d.]+|\S/gu) ?? []).map((token, i) => {
        const input = inputs.get(token)
        if (input) return <span key={i}>{input.label || input.name}{input.source !== undefined && <ChatCite n={input.source} onCite={onCite} />}</span>
        return <span key={i}>{signs[token] ?? token}</span>
      })}
      {result !== undefined && (
        <>
          {' = '}
          <strong>{resultText(result, i18n.language)}</strong>
        </>
      )}
    </>
  )
}

/** How a chart's series were worked out, each written out in full. */
function ChartFormulas({ chart, onCite }: { chart: AnswerChart; onCite: (n: number) => void }) {
  const { t } = useTranslation()
  return chart.calculations.map((calculation, i) => (
    <span key={i}>
      {i > 0 && t('assistant.source.separator')}
      <Formula expression={calculation.expression} inputs={calculation.inputs} name={calculation.name} onCite={onCite} />
    </span>
  ))
}

/**
 * A chart the answer drew, where it drew it: drawn as charts on dashboards are,
 * from the rows the answer looked up, with the sources it came from below it.
 * Clicking it does nothing: to look further, a source opens the dashboard.
 */
function Figure({ chart, cited, colorScheme, onCite }: { chart: AnswerChart; cited: Cited[]; colorScheme: ColorScheme; onCite: (n: number) => void }) {
  const { t } = useTranslation()
  const result = useMemo((): QueryResult => ({ columns: chart.columns, rows: chart.rows, meta: { truncated: false, durationMs: 0, cached: false } }), [chart])
  // A lookup the model read only some rows of draws only those.
  const cut = chart.sources.filter((n) => cited.some((c) => c.n === n && c.source?.truncated))
  // A series worked out is empty where an input is, or where it divides by zero.
  const worked = chart.calculations.map((calculation) => chart.columns.findIndex((column) => column.name === calculation.series)).filter((at) => at >= 0)
  const unworked = chart.rows.filter((row) => worked.some((at) => row[at] === null)).length
  const details: React.ReactNode[] = [
    <>
      {t('assistant.chart.data')}
      {chart.sources.map((n) => (
        <ChatCite key={n} n={n} onCite={onCite} />
      ))}
    </>,
  ]
  if (chart.n !== undefined)
    details.push(
      <>
        {t('assistant.source.workedOut')}
        <ChartFormulas chart={chart} onCite={onCite} />
        <ChatCite n={chart.n} onCite={onCite} />
      </>,
    )
  if (cut.length) details.push(t('assistant.chart.someRows', { sources: cut.map((n) => `[${n}]`).join(t('assistant.source.and')) }))
  if (unworked) details.push(t('assistant.chart.notWorkedOut', { count: unworked }))
  return (
    <ChatFigure title={chart.title} details={details}>
      <ChartView viz={chart.viz as unknown as Viz} result={result} colorScheme={colorScheme} height={280} label={chart.title} />
    </ChatFigure>
  )
}

/** What an answer cites: the charts its figures came from, each to open as it was read, and what it worked out from them. Folded, it names the dashboards. */
function Sources({ cited, id, open: unfolded, onOpenChange, onCite }: { cited: Cited[]; id: (n: number) => string; open: boolean; onOpenChange: (open: boolean) => void; onCite: (n: number) => void }) {
  const { t, i18n } = useTranslation()
  const session = useSession()
  const workspaceId = session.state.status === 'ok' ? session.state.data.workspace?.id : undefined
  const [error, setError] = useState<ApiError | null>(null)
  // The conditions are kept again as a share link would keep them, which an old answer's link may have outlived.
  const open = (source: AnswerSource) => {
    setError(null)
    const tab = window.open('', '_blank')
    const shown = Object.keys(source.state).length > 0
    ;(shown ? unwrap(api.POST('/dashboards/{id}/views', { params: { path: { id: source.dashboardId } }, body: { state: source.state, validDays: 30 } })) : Promise.resolve(undefined)).then(
      (view) => {
        const link = dashboardLink(source.dashboardId, workspaceId, view?.id)
        if (tab) tab.location.href = link
        else window.location.href = link
      },
      (e: unknown) => {
        tab?.close()
        setError(toApiError(e))
      },
    )
  }
  const calculated = (calculation: Calculation): ChatSource => ({
    n: calculation.n,
    id: id(calculation.n),
    title: (
      <>
        {t('assistant.source.calculated')}
        <Formula expression={calculation.expression} inputs={calculation.inputs} result={calculation.result} onCite={onCite} />
      </>
    ),
    details: [calculation.inputs.map((input) => t('assistant.source.condition', { name: input.label || input.name, value: input.value })).join(t('assistant.source.separator'))],
  })
  const charted = (n: number, chart: AnswerChart): ChatSource => ({
    n,
    id: id(n),
    title: (
      <>
        {t('assistant.source.workedOut')}
        <ChartFormulas chart={chart} onCite={onCite} />
      </>
    ),
    details: [t('assistant.source.inChart', { title: chart.title })],
  })
  const items: ChatSource[] = cited.map(({ n, source, calculation, chart }) => {
    if (chart) return charted(n, chart)
    if (!source) return calculated(calculation)
    const conditions = source.conditions.map((c) => {
      const name = c.kind === 'drill' ? t('assistant.source.drill') : c.label
      const value = c.text || valueText(c.value, t)
      return t('assistant.source.condition', { name, value }) + (c.default ? t('assistant.source.default') : '')
    })
    const at = source.dataAt ? new Date(source.dataAt).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }) : undefined
    return {
      n: source.n,
      id: id(source.n),
      title: `${source.dashboardName} › ${source.chartName}`,
      details: [
        conditions.length ? conditions.join(t('assistant.source.separator')) : t('assistant.source.noConditions'),
        [at && t('assistant.source.at', { time: at }), t(source.truncated ? 'assistant.source.someRows' : 'assistant.source.rows', { count: source.rows })].filter(Boolean).join(t('assistant.source.separator')),
      ],
      action: (
        <Button size="sm" variant="ghost" onClick={() => open(source)}>
          {t('assistant.source.open')}
        </Button>
      ),
    }
  })
  const dashboards = [...new Set(cited.flatMap(({ source }) => (source ? [source.dashboardName] : [])))]
  const summary = t('assistant.source.summary', { count: cited.length, dashboards: dashboards.join(t('assistant.source.and')) })
  return (
    <>
      <ChatSources sources={items} summary={summary} open={unfolded} onOpenChange={onOpenChange} aria-label={t('assistant.source.label')} />
      {error && <ErrorAlert error={error} />}
    </>
  )
}
