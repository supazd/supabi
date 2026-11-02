import { Button } from '@supabi/ui'
import { Component, lazy, Suspense, type ComponentType, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { toApiError } from '../api/useAsync'
import { ErrorAlert } from './ErrorAlert'

const reloadedKey = 'supabi.pageReloaded'

function reloadedOnce(): boolean {
  try {
    if (sessionStorage.getItem(reloadedKey)) return true
    sessionStorage.setItem(reloadedKey, '1')
  } catch {
    // Without storage, a reload could repeat forever; show the error instead.
    return true
  }
  return false
}

/**
 * A page whose code is fetched when it is first shown, so that signing in,
 * and viewers opening dashboards, do not download the editors.
 *
 * After a new version is deployed, the files of the old one are gone and an
 * open tab cannot fetch them: it reloads once to get the new version.
 */
export function lazyPage<P extends object>(load: () => Promise<ComponentType<P>>, reload = () => window.location.reload()) {
  return lazy(async () => {
    try {
      const page = await load()
      try {
        sessionStorage.removeItem(reloadedKey)
      } catch {
        // see reloadedOnce
      }
      return { default: page }
    } catch (error) {
      if (reloadedOnce()) throw error
      reload()
      return new Promise<never>(() => {})
    }
  })
}

/** Where a lazy page is drawn: a note while its code arrives, and an error if it cannot. */
export function PageFrame({ children }: { children: ReactNode }) {
  return (
    <PageBoundary>
      <Suspense fallback={<Loading />}>{children}</Suspense>
    </PageBoundary>
  )
}

function Loading() {
  const { t } = useTranslation()
  return <p className="muted">{t('common.loading')}</p>
}

function PageFailed({ error }: { error: unknown }) {
  const { t } = useTranslation()
  return (
    <section className="card stack">
      <ErrorAlert error={toApiError(error)} />
      <div>
        <Button size="sm" onClick={() => window.location.reload()}>{t('common.retry')}</Button>
      </div>
    </section>
  )
}

class PageBoundary extends Component<{ children: ReactNode }, { error?: unknown }> {
  state: { error?: unknown } = {}

  static getDerivedStateFromError(error: unknown) {
    return { error }
  }

  render() {
    return this.state.error === undefined ? this.props.children : <PageFailed error={this.state.error} />
  }
}
