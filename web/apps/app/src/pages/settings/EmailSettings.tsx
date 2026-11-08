import { Alert, Button, Checkbox, Input, Select, useToast } from '@supabi/ui'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, unwrap, type ApiError, type Schemas } from '../../api/client'
import { toApiError, useAsync } from '../../api/useAsync'
import { useSession } from '../../auth/session'
import { Async } from '../../components/Async'
import { ErrorAlert } from '../../components/ErrorAlert'
import { LeaveGuard } from '../../components/UnsavedChanges'
import { SettingsPage, useAction } from './shared'
import './emailSettings.css'

type EmailSettings = Schemas['EmailSettings']
type EmailSecurity = Schemas['EmailSecurity']
type EmailTest = Schemas['EmailTest']

const securities: EmailSecurity[] = ['starttls', 'tls', 'none']

/** What is typed in the form. An empty password keeps the saved one unless removePassword. */
interface Draft {
  host: string
  port: string
  security: EmailSecurity
  username: string
  password: string
  removePassword: boolean
  fromAddress: string
  fromName: string
}

const draftOf = (v: EmailSettings): Draft => ({
  host: v.host ?? '',
  port: v.port === undefined ? '' : String(v.port),
  security: v.security,
  username: v.username ?? '',
  password: '',
  removePassword: false,
  fromAddress: v.fromAddress ?? '',
  fromName: v.fromName ?? '',
})

/** The settings as the API takes them; the password only when it changes. */
const inputOf = (d: Draft): Schemas['EmailSettingsInput'] => ({
  host: d.host.trim(),
  security: d.security,
  username: d.username.trim(),
  fromAddress: d.fromAddress.trim(),
  fromName: d.fromName.trim(),
  ...(d.port.trim() ? { port: Number(d.port) } : {}),
  ...(d.password ? { password: d.password } : d.removePassword ? { password: '' } : {}),
})

const validPort = (text: string) => /^\d+$/.test(text.trim()) && Number(text) >= 1 && Number(text) <= 65535

/**
 * The SMTP server the organization sends email through, and a test email to
 * check it with before anything relies on it. See .agents/design/email.md.
 */
export function EmailSettingsPage() {
  const { t } = useTranslation()
  const settings = useAsync(() => unwrap(api.GET('/system/email')), [])
  return (
    <SettingsPage title={t('settings.email')} hint={t('email.hint')}>
      <Async state={settings} reload={settings.reload}>
        {(data) => <EmailForm initial={data} />}
      </Async>
    </SettingsPage>
  )
}

function EmailForm({ initial }: { initial: EmailSettings }) {
  const { t } = useTranslation()
  const toast = useToast()
  const [saved, setSaved] = useState(initial)
  const [draft, setDraft] = useState(() => draftOf(initial))
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }))
  const action = useAction()
  const { defaults } = saved

  const dirty = JSON.stringify(inputOf(draft)) !== JSON.stringify(inputOf(draftOf(saved)))
  const portWrong = draft.port.trim() !== '' && !validPort(draft.port)
  const signsIn = draft.username.trim() !== ''
  const unencryptedSignIn = draft.security === 'none' && signsIn
  const fromMissing = draft.host.trim() !== '' && draft.fromAddress.trim() === ''
  const passwordMissing = signsIn && !draft.password && (!saved.hasPassword || draft.removePassword)
  const invalid = portWrong || unencryptedSignIn || fromMissing || passwordMissing
  const on = Boolean(saved.host && saved.fromAddress)

  const save = async () => {
    const result = await unwrap(api.PUT('/system/email', { body: inputOf(draft) }))
    setSaved(result)
    setDraft(draftOf(result))
    toast(t('settings.saved'))
  }

  return (
    <>
      <form
        className="settings-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (dirty && !invalid) void action.run(save)
        }}
      >
        <LeaveGuard dirty={dirty} />
        <Alert tone={on ? 'success' : 'info'} title={on ? t('email.on', { server: `${saved.host}:${saved.port ?? defaults.ports[saved.security]}` }) : t('email.off')} />
        <div className="settings-group">
          <h3>{t('email.groups.server')}</h3>
          <dl className="settings-rows">
            <dt><label htmlFor="email-host">{t('email.host.label')}</label></dt>
            <dd>
              <Input id="email-host" value={draft.host} placeholder="smtp.example.com" onChange={(host) => set({ host })} />
              <span className="note">{t('email.host.hint')}</span>
            </dd>
            <dt><label htmlFor="email-security">{t('email.security.label')}</label></dt>
            <dd>
              <Select id="email-security" value={draft.security} options={securities.map((value) => ({ value, label: t(`email.security.${value}`) }))} onChange={(security) => set({ security })} />
              <span className="note">{t(`email.security.${draft.security}Hint`)}</span>
            </dd>
            <dt><label htmlFor="email-port">{t('email.port.label')}</label></dt>
            <dd>
              <span className="settings-number">
                <Input id="email-port" type="number" min={1} max={65535} step={1} value={draft.port} invalid={portWrong} placeholder={String(defaults.ports[draft.security])} onChange={(port) => set({ port })} />
              </span>
              {portWrong && <span className="note danger">{t('systemSettings.range', { min: 1, max: 65535 })}</span>}
              <span className="note">{t('email.port.hint', { port: defaults.ports[draft.security] })}</span>
            </dd>
            <dt><label htmlFor="email-username">{t('email.username.label')}</label></dt>
            <dd>
              <Input id="email-username" value={draft.username} invalid={unencryptedSignIn} onChange={(username) => set({ username })} />
              {unencryptedSignIn ? <span className="note danger">{t('email.username.unencrypted')}</span> : <span className="note">{t('email.username.hint')}</span>}
            </dd>
            <dt><label htmlFor="email-password">{t('email.password.label')}</label></dt>
            <dd>
              <Input
                id="email-password"
                type="password"
                value={draft.password}
                invalid={passwordMissing}
                disabled={draft.removePassword}
                placeholder={saved.hasPassword ? t('email.password.set') : ''}
                onChange={(password) => set({ password })}
              />
              {saved.hasPassword && (
                <Checkbox checked={draft.removePassword} onChange={(removePassword) => set({ removePassword, password: '' })}>
                  {t('email.password.remove')}
                </Checkbox>
              )}
              {passwordMissing && <span className="note danger">{t('email.password.required')}</span>}
              {saved.hasPassword && !draft.removePassword && <span className="note">{t('email.password.kept')}</span>}
            </dd>
          </dl>
        </div>
        <div className="settings-group">
          <h3>{t('email.groups.sender')}</h3>
          <dl className="settings-rows">
            <dt><label htmlFor="email-from">{t('email.fromAddress.label')}</label></dt>
            <dd>
              <Input id="email-from" value={draft.fromAddress} invalid={fromMissing} placeholder="bi@example.com" onChange={(fromAddress) => set({ fromAddress })} />
              {fromMissing ? <span className="note danger">{t('email.fromAddress.required')}</span> : <span className="note">{t('email.fromAddress.hint')}</span>}
            </dd>
            <dt><label htmlFor="email-from-name">{t('email.fromName.label')}</label></dt>
            <dd>
              <Input id="email-from-name" value={draft.fromName} maxLength={100} placeholder={defaults.fromName} onChange={(fromName) => set({ fromName })} />
              <span className="note">{t('email.fromName.hint', { name: defaults.fromName })}</span>
            </dd>
          </dl>
        </div>
        {action.error && <ErrorAlert error={action.error} />}
        <div>
          <Button variant="primary" type="submit" loading={action.busy} disabled={!dirty || invalid}>
            {t('common.save')}
          </Button>
        </div>
      </form>
      <TestEmail settings={inputOf(draft)} blocked={draft.host.trim() === '' ? 'needsServer' : invalid ? 'fixFirst' : undefined} />
    </>
  )
}

/** Sends with what the form holds, saved or not, to one address. */
function TestEmail({ settings, blocked }: { settings: Schemas['EmailSettingsInput']; blocked?: 'needsServer' | 'fixFirst' }) {
  const { t, i18n } = useTranslation()
  const session = useSession()
  const own = session.state.status === 'ok' ? (session.state.data.user?.email ?? '') : ''
  const [to, setTo] = useState(own)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ to: string; test?: EmailTest; error?: ApiError }>()
  const send = () => {
    const recipient = to.trim()
    setBusy(true)
    setResult(undefined)
    const locale = i18n.language === 'en-US' ? 'en-US' : 'zh-CN'
    unwrap(api.POST('/system/email/test', { body: { settings, to: recipient, locale } }))
      .then(
        (test) => setResult({ to: recipient, test }),
        (error: unknown) => setResult({ to: recipient, error: toApiError(error) }),
      )
      .finally(() => setBusy(false))
  }
  return (
    <div className="settings-form">
      <div className="settings-group">
        <h3>{t('email.groups.test')}</h3>
        <dl className="settings-rows">
          <dt><label htmlFor="email-test-to">{t('email.test.to')}</label></dt>
          <dd>
            <span className="row email-test-to">
              <Input id="email-test-to" value={to} placeholder="name@example.com" onChange={setTo} />
              <Button loading={busy} disabled={Boolean(blocked) || !to.trim()} onClick={send}>{t('email.test.send')}</Button>
            </span>
            <span className="note">{t(blocked ? `email.test.${blocked}` : 'email.test.hint')}</span>
          </dd>
        </dl>
        {result && <TestResult {...result} />}
      </div>
    </div>
  )
}

function TestResult({ to, test, error }: { to: string; test?: EmailTest; error?: ApiError }) {
  const { t } = useTranslation()
  if (error) return <ErrorAlert error={error} />
  if (!test) return null
  if (test.ok) {
    return (
      <Alert tone="success" title={t('email.test.ok', { to, ms: test.durationMs })}>
        {t('email.test.okNote')}
      </Alert>
    )
  }
  return (
    <Alert tone="error" title={t(`email.stages.${test.stage ?? 'connect'}`)}>
      <span className="email-test-message">{test.message}</span>
    </Alert>
  )
}
