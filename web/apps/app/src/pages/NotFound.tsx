import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

export function NotFound() {
  const { t } = useTranslation()
  return (
    <section className="card">
      <h2>{t('notFound.title')}</h2>
      <Link to="/">{t('notFound.back')}</Link>
    </section>
  )
}
