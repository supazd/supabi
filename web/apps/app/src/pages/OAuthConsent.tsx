import { Alert, Button } from '@supabi/ui'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { api, unwrap, type ApiError } from '../api/client'
import { toApiError, useAsync } from '../api/useAsync'
import type { SessionInfo } from '../auth/session'
import { Async } from '../components/Async'
import { BrandMark } from '../components/BrandMark'
import { ErrorAlert } from '../components/ErrorAlert'

/** What went wrong before there was a request to answer, as the server names it. */
const knownErrors = ['mcp_disabled', 'invalid_client', 'invalid_redirect_uri', 'server_error']

function Frame({ children }: { children: ReactNode }) {
  return (
    <main className="signin">
      <div className="signin-panel">
        <div className="signin-brand">
          <BrandMark size="lg" />
        </div>
        <section className="card stack signin-card consent-card">{children}</section>
      </div>
    </main>
  )
}

/** Sends the browser on, to the client or into the app. */
type Go = (url: string) => void

function Request({ id, info, go }: { id: string; info: SessionInfo; go: Go }) {
  const { t } = useTranslation()
  const request = useAsync(() => unwrap(api.GET('/oauth/requests/{id}', { params: { path: { id } } })), [id])
  const [answering, setAnswering] = useState<'approve' | 'deny'>()
  const [returning, setReturning] = useState(false)
  const [error, setError] = useState<ApiError>()
  const answer = async (choice: 'approve' | 'deny') => {
    setAnswering(choice)
    setError(undefined)
    try {
      const path = choice === 'approve' ? '/oauth/requests/{id}/approve' : '/oauth/requests/{id}/deny'
      const { redirectTo } = await unwrap(api.POST(path, { params: { path: { id } } }))
      setReturning(true)
      go(redirectTo)
    } catch (e) {
      setError(toApiError(e))
      setAnswering(undefined)
    }
  }
  if (request.status === 'error' && request.error.status === 404) {
    return <Alert tone="warning" title={t('consent.failed')}>{t('consent.expired')}</Alert>
  }
  return (
    <Async state={request} reload={request.reload}>
      {(data) => {
        const client = data.clientName
        if (returning) return <p role="status">{t('consent.returning', { client })}</p>
        return (
          <>
            <h1 className="consent-title">{t('consent.title', { client })}</h1>
            <p>{t('consent.intro', { client })}</p>
            <p className="note">{t(data.loopback ? 'consent.loopback' : 'consent.answerTo', { host: data.redirectHost })}</p>
            <p className="note">{t('consent.unvouched', { client })}</p>
            <p className="note small">{t('consent.signedInAs', { name: info.user?.displayName, email: info.user?.email })}</p>
            {!data.mcpEnabled && <Alert tone="warning" title={t('consent.off')} />}
            {error && <ErrorAlert error={error} />}
            <div className="row consent-actions">
              <Button loading={answering === 'deny'} disabled={Boolean(answering)} onClick={() => void answer('deny')}>{t('consent.deny')}</Button>
              <Button variant="primary" loading={answering === 'approve'} disabled={Boolean(answering) || !data.mcpEnabled} onClick={() => void answer('approve')}>{t('consent.allow')}</Button>
            </div>
          </>
        )
      }}
    </Async>
  )
}

/**
 * Where an MCP client sends the person to allow it, outside the app's frame:
 * .agents/design/ai-assistant.md 14.4. The server sends the browser here with
 * the request, or with what was wrong when there is none.
 */
export function OAuthConsent({ info, location = window.location, go = (url) => window.location.assign(url) }: { info: SessionInfo; location?: Pick<Location, 'pathname' | 'search'>; go?: Go }) {
  const { t } = useTranslation()
  const id = location.pathname.split('/')[3]
  const error = new URLSearchParams(location.search).get('error')
  return (
    <Frame>
      {id ? (
        <Request id={decodeURIComponent(id)} info={info} go={go} />
      ) : (
        <>
          <Alert tone="error" title={t('consent.failed')}>{t(`consent.errors.${error && knownErrors.includes(error) ? error : 'server_error'}`)}</Alert>
          <div className="row consent-actions">
            <Button onClick={() => go('/')}>{t('consent.home')}</Button>
          </div>
        </>
      )}
    </Frame>
  )
}
