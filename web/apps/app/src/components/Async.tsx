import { Button } from '@supabi/ui'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { AsyncState } from '../api/useAsync'
import { ErrorAlert } from './ErrorAlert'

/** Renders the loading and error states of a request, and children once it has data. */
export function Async<T>({ state, reload, children }: { state: AsyncState<T>; reload: () => void; children: (data: T) => ReactNode }) {
  const { t } = useTranslation()
  if (state.status === 'loading') return <p className="muted">{t('common.loading')}</p>
  if (state.status === 'error') {
    return (
      <div className="stack">
        <ErrorAlert error={state.error} />
        <div>
          <Button size="sm" onClick={reload}>
            {t('common.retry')}
          </Button>
        </div>
      </div>
    )
  }
  return <>{children(state.data)}</>
}
