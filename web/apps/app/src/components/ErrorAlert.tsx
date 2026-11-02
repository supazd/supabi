import { Alert } from '@supabi/ui'
import { useTranslation } from 'react-i18next'
import type { ApiError } from '../api/client'

/** Translates an API error by its code, falling back to the server's own message. */
export function useErrorText() {
  const { t, i18n } = useTranslation()
  return (error: ApiError) => {
    const key = `errors.${error.code}`
    const values = { ...error.params, label: error.params.label || error.params.key, message: error.message }
    return i18n.exists(key) ? t(key, values) : t('errors.fallback', values)
  }
}

export function ErrorAlert({ error }: { error: ApiError }) {
  const text = useErrorText()
  return <Alert tone="error" title={text(error)} />
}
