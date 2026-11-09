import { Button, Dialog, Markdown, Popover, Tabs } from '@supabi/ui'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { api, unwrap, type Schemas } from '../api/client'
import { toApiError } from '../api/useAsync'
import { ErrorAlert } from './ErrorAlert'
import { Icon } from './Icon'
import './notifications.css'

// The bell and the banner, which show what administrators announce:
// .agents/design/announcements.md 4.

type Notification = Schemas['Notification']
type Summary = Schemas['NotificationSummary']
type Category = 'all' | 'system' | 'workspace'

const changed = 'supabi:notifications-changed'

/** Has the bell and the banner read again at once, as after publishing an announcement. */
export function notificationsChanged() {
  window.dispatchEvent(new Event(changed))
}

interface Notifications {
  summary?: Summary
  /** Marks one read; the badge and the banner follow at once. */
  read: (notification: Notification) => Promise<void>
  readAll: () => Promise<void>
  bellOpen: boolean
  setBellOpen: (open: boolean) => void
}

const NotificationsContext = createContext<Notifications | null>(null)

/**
 * Reads the badge and the banner when the page loads, when it is shown again,
 * when an announcement changes, and every refresh interval while it is
 * visible. The server says how long the interval is with each read.
 */
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const [summary, setSummary] = useState<Summary>()
  const [bellOpen, setBellOpen] = useState(false)
  const interval = useRef(60)
  const controller = useRef<AbortController | null>(null)

  const refresh = useCallback(async () => {
    if (document.visibilityState === 'hidden') return
    controller.current?.abort()
    const control = new AbortController()
    controller.current = control
    try {
      const next = await unwrap(api.GET('/notifications/summary', { signal: control.signal }))
      if (control.signal.aborted) return
      interval.current = next.refreshSeconds
      setSummary(next)
    } catch {
      // What was shown stays; the next read tries again.
    }
  }, [])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    let run = 0
    const poll = async () => {
      clearTimeout(timer)
      const mine = ++run
      await refresh()
      if (!stopped && mine === run) timer = setTimeout(() => void poll(), interval.current * 1000)
    }
    void poll()
    const wake = () => { if (document.visibilityState !== 'hidden') void poll() }
    document.addEventListener('visibilitychange', wake)
    window.addEventListener(changed, wake)
    return () => {
      stopped = true
      clearTimeout(timer)
      controller.current?.abort()
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener(changed, wake)
    }
  }, [refresh])

  const read = useCallback(async (notification: Notification) => {
    setSummary((current) => current && {
      ...current,
      unread: Math.max(0, current.unread - (notification.unread ? 1 : 0)),
      banner: current.banner.filter((item) => item.id !== notification.id),
      bannerTotal: Math.max(0, current.bannerTotal - (current.banner.some((item) => item.id === notification.id) ? 1 : 0)),
    })
    try {
      await unwrap(api.POST('/notifications/{id}/read', { params: { path: { id: notification.id } } }))
    } finally {
      // The banner fills up again from those it could not hold.
      void refresh()
    }
  }, [refresh])

  const readAll = useCallback(async () => {
    setSummary((current) => current && { ...current, unread: 0, banner: [], bannerTotal: 0 })
    try {
      await unwrap(api.POST('/notifications/read'))
    } finally {
      void refresh()
    }
  }, [refresh])

  const value = useMemo(() => ({ summary, read, readAll, bellOpen, setBellOpen }), [summary, read, readAll, bellOpen])
  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>
}

/** Where a notification comes from: the system, or a workspace by its name. */
function useSource() {
  const { t } = useTranslation()
  return (notification: Notification) => (notification.category === 'system' ? t('notifications.system') : notification.workspaceName ?? '')
}

function usePeriod() {
  const { t, i18n } = useTranslation()
  const format = (value: string) => new Date(value).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' })
  return (notification: Notification) => t('notifications.period', { start: format(notification.startsAt), end: format(notification.endsAt) })
}

/** The bell in the top bar, with the number of unread notifications. */
export function NotificationBell({ disabled }: { disabled: boolean }) {
  const notifications = useContext(NotificationsContext)
  if (!notifications) return null
  return <Bell notifications={notifications} disabled={disabled} />
}

function Bell({ notifications, disabled }: { notifications: Notifications; disabled: boolean }) {
  const { t } = useTranslation()
  const { summary, bellOpen, setBellOpen } = notifications
  const unread = summary?.unread ?? 0
  const title = t('notifications.title')
  return (
    <Popover open={bellOpen && !disabled} onOpenChange={setBellOpen} width={448} content={<BellPanel notifications={notifications} />}>
      <button type="button" className="topbar-control notification-trigger" disabled={disabled} aria-label={title} title={title} aria-haspopup="dialog" aria-expanded={bellOpen}>
        <Icon name="bell" size={18} />
        {unread > 0 && <span className="notification-badge" aria-label={t('notifications.unread', { count: unread })}>{unread > 99 ? '99+' : unread}</span>}
      </button>
    </Popover>
  )
}

/** What the bell holds, newest first, a page at a time. */
function BellPanel({ notifications }: { notifications: Notifications }) {
  const { t, i18n } = useTranslation()
  const source = useSource()
  const period = usePeriod()
  const [category, setCategory] = useState<Category>('all')
  const [items, setItems] = useState<Notification[]>()
  const [next, setNext] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<ReturnType<typeof toApiError>>()
  const [open, setOpen] = useState<string>()
  const controller = useRef<AbortController | null>(null)

  const load = useCallback(async (from: Category, before?: string) => {
    controller.current?.abort()
    const control = new AbortController()
    controller.current = control
    setLoading(true); setError(undefined)
    try {
      const page = await unwrap(api.GET('/notifications', { params: { query: { category: from === 'all' ? undefined : from, before } }, signal: control.signal }))
      if (control.signal.aborted) return
      setItems((current) => (before ? [...(current ?? []), ...page.items] : page.items))
      setNext(page.nextBefore)
    } catch (e) {
      if (!control.signal.aborted) setError(toApiError(e))
    } finally {
      if (controller.current === control) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(category)
    return () => controller.current?.abort()
  }, [category, load])

  const toggle = (item: Notification) => {
    setOpen((current) => (current === item.id ? undefined : item.id))
    if (item.unread) {
      setItems((current) => current?.map((other) => (other.id === item.id ? { ...other, unread: false } : other)))
      void notifications.read(item).catch((e: unknown) => setError(toApiError(e)))
    }
  }
  const readAll = () => {
    setItems((current) => current?.map((item) => ({ ...item, unread: false })))
    void notifications.readAll().catch((e: unknown) => setError(toApiError(e)))
  }
  const started = (value: string) => new Date(value).toLocaleDateString(i18n.language, { month: 'short', day: 'numeric' })

  return (
    <div className="notification-panel" role="dialog" aria-label={t('notifications.title')}>
      <header className="notification-panel-header">
        <strong>{t('notifications.title')}</strong>
        <Button size="sm" variant="ghost" disabled={!notifications.summary?.unread} onClick={readAll}>{t('notifications.markAllRead')}</Button>
      </header>
      <Tabs
        value={category}
        onChange={(value) => { setCategory(value); setItems(undefined); setOpen(undefined) }}
        aria-label={t('notifications.title')}
        items={(['all', 'system', 'workspace'] as const).map((value) => ({ value, label: t(`notifications.tabs.${value}`) }))}
      />
      <div className="notification-list">
        {error && <ErrorAlert error={error} />}
        {!items && !error && <p className="note notification-empty">{t('common.loading')}</p>}
        {items?.length === 0 && <p className="note notification-empty">{t('notifications.empty')}</p>}
        {items?.map((item) => (
          <article key={item.id} className={`notification-item${item.unread ? ' unread' : ''}`}>
            <button type="button" className="notification-item-head" aria-expanded={open === item.id} onClick={() => toggle(item)}>
              <span className="notification-dot" aria-hidden />
              <span className="notification-item-title" title={item.title}>{item.title}</span>
              <span className="note notification-item-meta">{source(item)} · {started(item.startsAt)}</span>
            </button>
            {open === item.id && (
              <div className="notification-item-body">
                <p className="note">{period(item)}</p>
                {item.body && <Markdown text={item.body} />}
              </div>
            )}
          </article>
        ))}
        {next && <Button size="sm" loading={loading} onClick={() => void load(category, next)}>{t('notifications.more')}</Button>}
      </div>
    </div>
  )
}

/**
 * The announcements in effect that the person has not read, under the top
 * bar: the system's, then the current workspace's.
 */
export function AnnouncementBanner() {
  const notifications = useContext(NotificationsContext)
  const { t } = useTranslation()
  const [viewing, setViewing] = useState<Notification>()
  const summary = notifications?.summary
  if (!notifications || !summary || summary.banner.length === 0) return viewing ? <AnnouncementDialog notification={viewing} onClose={() => setViewing(undefined)} /> : null
  const more = summary.bannerTotal - summary.banner.length
  return (
    <section className="announcement-banner" aria-label={t('notifications.banner')}>
      {summary.banner.map((item) => (
        <div key={item.id} className="announcement-line">
          <Icon name="megaphone" />
          <span className="announcement-title" title={item.title}>{item.title}</span>
          {item.body && <button type="button" onClick={() => setViewing(item)}>{t('notifications.view')}</button>}
          <button type="button" onClick={() => void notifications.read(item).catch(() => undefined)}>{t('notifications.gotIt')}</button>
        </div>
      ))}
      {more > 0 && <button type="button" className="announcement-more" onClick={() => notifications.setBellOpen(true)}>{t('notifications.more', { count: more })}</button>}
      {viewing && <AnnouncementDialog notification={viewing} onClose={(read) => { setViewing(undefined); if (read) void notifications.read(viewing).catch(() => undefined) }} />}
    </section>
  )
}

/** An announcement in full, opened from the banner. */
function AnnouncementDialog({ notification, onClose }: { notification: Notification; onClose: (read: boolean) => void }) {
  const { t } = useTranslation()
  const source = useSource()
  const period = usePeriod()
  return (
    <Dialog open title={notification.title} width={600} onClose={() => onClose(false)} actions={<>
      <Button onClick={() => onClose(false)}>{t('common.close')}</Button>
      <Button variant="primary" onClick={() => onClose(true)}>{t('notifications.gotIt')}</Button>
    </>}>
      <div className="stack">
        <p className="note">{source(notification)} · {period(notification)}</p>
        <Markdown text={notification.body} />
      </div>
    </Dialog>
  )
}
