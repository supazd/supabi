import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { api, unwrap } from '../api/client'
import { useAsync } from '../api/useAsync'
import { useSession, type Role } from '../auth/session'
import { Async } from '../components/Async'
import { Icon, type IconName } from '../components/Icon'

type Action = 'dashboards' | 'explore' | 'datasets' | 'datasources'

// Where each way in leads, and who it is for: a viewer only reads dashboards.
const actions: { key: Action; to: string; icon: IconName; role: Role }[] = [
  { key: 'dashboards', to: '/dashboards', icon: 'dashboard', role: 'viewer' },
  { key: 'explore', to: '/explore', icon: 'explore', role: 'developer' },
  { key: 'datasets', to: '/workbench/datasets', icon: 'dataset', role: 'developer' },
  { key: 'datasources', to: '/workbench/datasources', icon: 'database', role: 'developer' },
]

export function Home() {
  const { t } = useTranslation()
  const { atLeast, state } = useSession()
  const version = useAsync(() => unwrap(api.GET('/version')), [])
  const info = state.status === 'ok' ? state.data : undefined
  const name = info?.user?.displayName.trim() || info?.user?.email || ''
  const shown = actions.filter((action) => atLeast(action.role))

  return (
    <>
      <section className="home-hero">
        {info?.workspace && <p className="home-eyebrow">{t('home.workspace', { name: info.workspace.name })}</p>}
        <h1>{name ? t('home.welcome', { name }) : t('app.name')}</h1>
        <p className="muted">{t('home.intro')}</p>
      </section>
      {shown.length > 0 && (
        <section aria-labelledby="home-start">
          <h2 id="home-start" className="home-section-title">{t('home.quickStart')}</h2>
          <ul className="home-actions">
            {shown.map((action) => (
              <li key={action.key}>
                <Link to={action.to} className={`home-action ${action.key}`}>
                  <span className="home-action-icon"><Icon name={action.icon} size={20} /></span>
                  <span className="home-action-text">
                    <strong>{t(`home.actions.${action.key}.title`)}</strong>
                    <span>{t(`home.actions.${action.key}.body`)}</span>
                  </span>
                  <span className="home-action-go">{t('home.open')}<Icon name="chevronRight" size={14} /></span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="home-server" aria-labelledby="server-title">
        <h2 id="server-title">{t('server.title')}</h2>
        <Async state={version} reload={version.reload}>
          {(server) => (
            <dl className="home-facts">
              <div><dt>{t('server.version')}</dt><dd>{server.version}</dd></div>
              <div><dt>{t('server.commit')}</dt><dd><code>{server.commit}</code></dd></div>
            </dl>
          )}
        </Async>
      </section>
    </>
  )
}
