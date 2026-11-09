import { Menu, Tooltip, locales, type ColorScheme, type Locale, type MenuItem } from '@supabi/ui'
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, NavLink, useLocation, useNavigate } from 'react-router'
import { useSession, type SessionInfo } from '../auth/session'
import { ExportCenter } from './Exports'
import { BrandMark } from './BrandMark'
import { Icon, type IconName } from './Icon'

interface TopbarProps {
  info: SessionInfo
  colorScheme: ColorScheme
  locale: Locale
  onLocaleChange: (locale: Locale) => void
  onColorSchemeChange: (scheme: ColorScheme) => void
  onSwitchWorkspace: (workspaceId: string) => void
  onSignOut: () => void
  busy: boolean
  /** An active request; confirmation dialogs disable actions without showing a spinner. */
  pending?: boolean
}

function MenuLabel({ icon, children, detail }: { icon?: IconName; children: ReactNode; detail?: ReactNode }) {
  return (
    <span className="topbar-menu-label">
      {icon && <Icon name={icon} />}
      <span className="topbar-menu-text">{children}</span>
      {detail && <> <span className="topbar-menu-detail">{detail}</span></>}
    </span>
  )
}

/** The workspace provides context; the everyday destinations stay in the bar. */
export function Topbar({ info, colorScheme, locale, onLocaleChange, onColorSchemeChange, onSwitchWorkspace, onSignOut, busy, pending = busy }: TopbarProps) {
  const { t } = useTranslation()
  const session = useSession()
  const navigate = useNavigate()
  const location = useLocation()
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  const [narrow, setNarrow] = useState(() => window.matchMedia?.('(max-width: 640px)').matches ?? false)
  useEffect(() => {
    const query = window.matchMedia?.('(max-width: 640px)')
    if (!query) return
    const update = () => setNarrow(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  const inWorkbench = location.pathname === '/workbench' || location.pathname.startsWith('/workbench/')
  const inExplore = location.pathname === '/explore'
  const lastExplore = useRef('/explore')
  const lastWorkbench = useRef('/workbench')
  useEffect(() => {
    if (inExplore) lastExplore.current = `${location.pathname}${location.search}${location.hash}`
    if (inWorkbench) lastWorkbench.current = `${location.pathname}${location.search}${location.hash}`
  }, [inWorkbench, inExplore, location.pathname, location.search, location.hash])

  const displayName = info.user?.displayName.trim() || info.user?.email || t('settings.account')
  const workspaceName = info.workspace?.name || t('topbar.noWorkspace')
  const navigateTo = (path: string) => { if (!busy) void navigate(path) }
  const preventBusyNavigation = (event: MouseEvent<HTMLAnchorElement>) => { if (busy) event.preventDefault() }
  const chooseWorkbench = (event: MouseEvent<HTMLAnchorElement>) => {
    // Replacing an already-open editor's location would give it a new draft key.
    if (busy || (inWorkbench && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey)) event.preventDefault()
  }
  const workspaceItems: MenuItem[] = (info.workspaces ?? (info.workspace ? [info.workspace] : [])).map((workspace) => ({
    key: `workspace-${workspace.id}`,
    label: <MenuLabel detail={workspace.id === info.workspace?.id ? <Icon name="check" /> : undefined}><span title={workspace.name}>{workspace.name}</span></MenuLabel>,
    disabled: busy || workspace.id === info.workspace?.id,
    onSelect: () => { if (!busy && workspace.id !== info.workspace?.id) onSwitchWorkspace(workspace.id) },
  }))

  const accountItems: MenuItem[] = [
    {
      key: 'account',
      label: <MenuLabel icon="user"><span className="topbar-account-heading"><strong title={displayName}>{displayName}</strong> <span>{t('topbar.accountSettings')}</span></span></MenuLabel>,
      disabled: busy,
      onSelect: () => navigateTo('/settings/personal/account'),
    },
    {
      key: 'language',
      label: narrow ? t('language.label') : <MenuLabel icon="language" detail={t(`language.${locale}`)}>{t('language.label')}</MenuLabel>,
      separated: true,
      disabled: busy,
      group: narrow,
      children: locales.map((value) => ({
        key: `language-${value}`,
        label: <MenuLabel detail={value === locale ? <Icon name="check" /> : undefined}>{t(`language.${value}`)}</MenuLabel>,
        disabled: busy,
        onSelect: () => { if (!busy) onLocaleChange(value) },
      })),
    },
  ]
  if (session.isOrgAdmin) accountItems.push({ key: 'admin', label: <MenuLabel icon="settings">{t('topbar.systemSettings')}</MenuLabel>, separated: true, disabled: busy, onSelect: () => navigateTo('/settings/system/users') })
  accountItems.push({ key: 'sign-out', label: <MenuLabel icon="signOut">{t('auth.signOut')}</MenuLabel>, separated: true, disabled: busy, onSelect: () => { if (!busy) onSignOut() } })

  return (
    <header className="topbar" aria-busy={pending}>
      <div className="topbar-context">
        <Link to="/" className="brand" aria-label={`${t('app.name')} · ${t('nav.home')}`} aria-disabled={busy || undefined} tabIndex={busy ? -1 : undefined} onClick={preventBusyNavigation} onAuxClick={preventBusyNavigation}><BrandMark />{t('app.name')}</Link>
        <span className="topbar-divider" aria-hidden />
        <Menu items={workspaceItems} className="topbar-menu topbar-workspaces-menu" placement="bottomLeft" disabled={busy || workspaceItems.length === 0} open={!busy && workspaceOpen} onOpenChange={setWorkspaceOpen}>
          <button type="button" className="topbar-control topbar-workspace" disabled={busy || workspaceItems.length === 0} aria-label={`${t('workspace.current')}: ${workspaceName}`} aria-haspopup="menu" aria-expanded={!busy && workspaceOpen} title={workspaceName}>
            <span className="topbar-workspace-name">{workspaceName}</span>
            <Icon name="chevronDown" size={14} />
          </button>
        </Menu>
      </div>
      <nav className="topbar-nav" aria-label={t('topbar.navigation')}>
        {session.atLeast('viewer') && <NavLink to="/dashboards" aria-disabled={busy || undefined} tabIndex={busy ? -1 : undefined} onClick={preventBusyNavigation} onAuxClick={preventBusyNavigation}><Icon name="dashboard" />{t('nav.dashboards')}</NavLink>}
        {session.atLeast('viewer') && <NavLink to="/assistant" aria-disabled={busy || undefined} tabIndex={busy ? -1 : undefined} onClick={preventBusyNavigation} onAuxClick={preventBusyNavigation}><Icon name="assistant" />{t('nav.assistant')}</NavLink>}
        {session.atLeast('developer') && <Link to={inWorkbench ? `${location.pathname}${location.search}${location.hash}` : lastWorkbench.current} className={inWorkbench ? 'active' : undefined} aria-current={inWorkbench ? 'page' : undefined} aria-disabled={busy || undefined} tabIndex={busy ? -1 : undefined} onClick={chooseWorkbench} onAuxClick={preventBusyNavigation}><Icon name="workbench" />{t('nav.workbench')}</Link>}
        {session.atLeast('developer') && <Link to={inExplore ? `${location.pathname}${location.search}${location.hash}` : lastExplore.current} className={inExplore ? 'active' : undefined} aria-current={inExplore ? 'page' : undefined} aria-disabled={busy || undefined} tabIndex={busy ? -1 : undefined} onClick={(event) => { if (busy || (inExplore && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey)) event.preventDefault() }} onAuxClick={preventBusyNavigation}><Icon name="explore" />{t('nav.explore')}</Link>}
        {/* An org administrator is an admin of every workspace. */}
        {info.workspace && session.atLeast('developer') && <NavLink to="/settings/workspace" aria-disabled={busy || undefined} tabIndex={busy ? -1 : undefined} onClick={preventBusyNavigation} onAuxClick={preventBusyNavigation}><Icon name="settings" />{t('topbar.workspaceSettings')}</NavLink>}
      </nav>
      <div className="topbar-account">
        {info.user && <ExportCenter key={info.user.id} disabled={busy} showWorkspace={(info.workspaces?.length ?? 0) > 1} />}
        {pending && <span className="topbar-spinner" role="status" aria-label={t('common.loading')} />}
        <Tooltip title={colorScheme === 'dark' ? t('theme.toLight') : t('theme.toDark')}>
          <button
            type="button"
            className="topbar-control topbar-theme"
            disabled={busy}
            aria-label={colorScheme === 'dark' ? t('theme.toLight') : t('theme.toDark')}
            onClick={() => { if (!busy) onColorSchemeChange(colorScheme === 'dark' ? 'light' : 'dark') }}
          >
            <Icon name={colorScheme === 'dark' ? 'sun' : 'moon'} size={18} />
          </button>
        </Tooltip>
        <Menu items={accountItems} className="topbar-menu topbar-account-menu" placement="bottomRight" disabled={busy} open={!busy && accountOpen} onOpenChange={setAccountOpen}>
          <button type="button" className="topbar-control topbar-account-trigger" disabled={busy} aria-label={t('topbar.accountMenu', { name: displayName })} aria-haspopup="menu" aria-expanded={!busy && accountOpen} title={displayName}>
            <span className="topbar-avatar" aria-hidden>{Array.from(displayName)[0]!.toLocaleUpperCase()}</span>
            <Icon name="chevronDown" size={12} />
          </button>
        </Menu>
      </div>
    </header>
  )
}
