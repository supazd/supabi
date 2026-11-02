import { Button, Field, Input } from '@supabi/ui'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiError, api, unwrap } from '../api/client'
import { toApiError } from '../api/useAsync'
import { useSession } from '../auth/session'
import { BrandMark } from '../components/BrandMark'
import { ErrorAlert } from '../components/ErrorAlert'

/** The sign-in form, or the form that creates the first administrator. */
export function SignIn({ setup }: { setup: boolean }) {
  const { t } = useTranslation()
  const session = useSession()
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const info = setup
        ? await unwrap(api.POST('/auth/setup', { body: { email, displayName, password } }))
        : await unwrap(api.POST('/auth/login', { body: { email, password } }))
      session.set(info)
    } catch (e) {
      setError(toApiError(e))
      setBusy(false)
    }
  }

  return (
    <main className="signin">
      <div className="signin-panel">
        <div className="signin-brand">
          <BrandMark size="lg" />
          <h1>{t('app.name')}</h1>
          <p className="muted">{setup ? t('auth.setupIntro') : t('auth.signInIntro')}</p>
        </div>
        <form
          className="card stack signin-card"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <Field label={t('auth.email')} htmlFor="signin-email" required>
            <Input id="signin-email" value={email} onChange={setEmail} />
          </Field>
          {setup && (
            <Field label={t('auth.displayName')} htmlFor="signin-name" required>
              <Input id="signin-name" value={displayName} onChange={setDisplayName} />
            </Field>
          )}
          <Field label={t('auth.password')} htmlFor="signin-password" required hint={setup ? t('auth.passwordHint') : undefined}>
            <Input id="signin-password" type="password" value={password} onChange={setPassword} />
          </Field>
          {error && <ErrorAlert error={error} />}
          <Button variant="primary" type="submit" loading={busy} disabled={!email || !password || (setup && !displayName.trim())}>
            {setup ? t('auth.createAdmin') : t('auth.signIn')}
          </Button>
        </form>
        <p className="signin-tagline">{t('auth.tagline')}</p>
      </div>
    </main>
  )
}
