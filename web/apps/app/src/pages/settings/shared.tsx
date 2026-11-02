import { Button, Dialog, Input, Menu, type MenuItem } from '@supabi/ui'
import { useId, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiError } from '../../api/client'
import { toApiError, type AsyncState } from '../../api/useAsync'
import { roles, type Role } from '../../auth/session'
import { Async } from '../../components/Async'
import { ErrorAlert } from '../../components/ErrorAlert'
import { Icon } from '../../components/Icon'

/** The instant a day (YYYY-MM-DD) starts in the browser's time zone, days after the one given. */
export function dayStart(day: string, after = 0) {
  const date = new Date(`${day}T00:00:00`)
  date.setDate(date.getDate() + after)
  return date.toISOString()
}

/** Runs a request, tracking whether it is in flight and how it failed. */
export function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const run = async (request: () => Promise<unknown>, then?: () => void) => {
    setBusy(true)
    setError(null)
    try {
      await request()
      then?.()
    } catch (e) {
      setError(toApiError(e))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run }
}

/** The roles to choose from, named in the user's language, least able first. */
export function useRoleOptions(): { value: Role; label: string }[] {
  const { t } = useTranslation()
  return roles.map((role) => ({ value: role, label: t(`member.roles.${role}`) }))
}

/**
 * A settings page: its name, a line about it and its main buttons, above what
 * it holds. See .agents/design/access-control.md 2.2.1.
 */
export function SettingsPage({ title, hint, actions, children }: { title: string; hint?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  const id = useId()
  return (
    <section className="settings-page" aria-labelledby={id}>
      <header className="settings-page-header">
        <div>
          <h2 id={id}>{title}</h2>
          {hint && <p className="note">{hint}</p>}
        </div>
        {actions && <div className="row nowrap">{actions}</div>}
      </header>
      {children}
    </section>
  )
}

/** A part of a settings page, under a heading of its own. */
export function SettingsPart({ title, hint, actions, children }: { title: string; hint?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  const id = useId()
  return (
    <section className="settings-part" aria-labelledby={id}>
      <header className="settings-part-header">
        <div>
          <h3 id={id}>{title}</h3>
          {hint && <p className="note">{hint}</p>}
        </div>
        {actions && <div className="row nowrap">{actions}</div>}
      </header>
      {children}
    </section>
  )
}

/** What narrows a list down, as typed: people by their name or email, unless it says otherwise. */
export function SearchBox({ value, onChange, label }: { value: string; onChange: (value: string) => void; label?: string }) {
  const { t } = useTranslation()
  const text = label ?? t('settings.search')
  return (
    <div className="settings-search">
      <Input aria-label={text} placeholder={text} value={value} onChange={onChange} clearable />
    </div>
  )
}

/**
 * A list that stays on the page while it is loaded again after a change.
 * When that load fails, it says so above what may now be out of date.
 */
export function KeptAsync<T>({ state, reload, children }: { state: AsyncState<T>; reload: () => void; children: (data: T) => ReactNode }) {
  const { t } = useTranslation()
  return (
    <Async state={state} reload={reload}>
      {(data) => <>
        {state.status === 'ok' && state.failed && (
          <div className="stack">
            <ErrorAlert error={state.failed} />
            <div><Button size="sm" onClick={reload}>{t('common.retry')}</Button></div>
          </div>
        )}
        {children(data)}
      </>}
    </Async>
  )
}

/** Whether any of the texts holds what was typed, letter case aside. */
export function found(wanted: string, ...texts: (string | undefined)[]) {
  const needle = wanted.trim().toLocaleLowerCase()
  return !needle || texts.some((text) => text?.toLocaleLowerCase().includes(needle))
}

/** Someone in one line: the name, then the email and what else is to be known about them. */
export function Person({ name, email, marks }: { name: string; email?: string; marks?: ReactNode }) {
  return (
    <span className="settings-person">
      <span>{name}</span>
      {email && <span className="note">{email}</span>}
      {marks}
    </span>
  )
}

/** The actions on a row, in a menu that opens from the button at its end. */
export function RowMenu({ label, items }: { label: string; items: MenuItem[] }) {
  if (items.length === 0) return null
  return (
    <Menu items={items} placement="bottomRight">
      <button type="button" className="wb-icon-button" aria-label={label}>
        <Icon name="more" />
      </button>
    </Menu>
  )
}

/**
 * Asks before something hard to take back is done, saying what it will do.
 * It closes with true once done, with false when nothing was.
 */
export function ConfirmDialog({ title, confirmLabel, danger = true, onConfirm, onClose, children }: { title: string; confirmLabel: string; danger?: boolean; onConfirm: () => Promise<unknown>; onClose: (done: boolean) => void; children: ReactNode }) {
  const { t } = useTranslation()
  const action = useAction()
  return (
    <Dialog
      open
      title={title}
      width={440}
      onClose={() => !action.busy && onClose(false)}
      actions={
        <>
          <Button disabled={action.busy} onClick={() => onClose(false)}>{t('common.cancel')}</Button>
          <Button variant={danger ? 'secondary' : 'primary'} danger={danger} loading={action.busy} onClick={() => void action.run(onConfirm, () => onClose(true))}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="stack">
        <p>{children}</p>
        {action.error && <ErrorAlert error={action.error} />}
      </div>
    </Dialog>
  )
}
