import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { NavLink, Navigate, Route, Routes } from 'react-router'
import { useSession } from '../../auth/session'
import { Icon, type IconName } from '../../components/Icon'
import { NotFound } from '../NotFound'
import { Account } from './Account'
import { Announcements } from './Announcements'
import { AIModels } from './AIModels'
import { AIUsage } from './AIUsage'
import { EmailSettingsPage } from './EmailSettings'
import { Audit } from './Audit'
import { Groups } from './Groups'
import { Mcp } from './Mcp'
import { Members } from './Members'
import { Users } from './Users'
import { UserAttributes } from './UserAttributes'
import { SystemGeneral } from './SystemGeneral'
import { Workspace } from './Workspace'
import { Workspaces } from './Workspaces'

interface Section {
  path: string
  label: string
  icon: IconName
  element: ReactNode
  allowed?: boolean
}

/**
 * Each area has its own navigation and an explicit management scope. It fills
 * the window as the dashboards do: see .agents/design/access-control.md 2.2.1.
 */
function SettingsArea({ base, title, sections, allowed = true, unavailable }: { base: string; title: string; sections: Section[]; allowed?: boolean; unavailable?: string }) {
  const { t } = useTranslation()
  if (!allowed) return <section className="card"><p>{unavailable ?? t('auth.forbidden')}</p></section>
  const visible = sections.filter((section) => section.allowed !== false)
  return (
    <div className="settings">
      <aside className="wb-side settings-side">
        <div className="wb-side-header">
          <h1 className="wb-side-title" title={title}>{title}</h1>
        </div>
        <nav className="wb-tree" aria-label={title}>
          {visible.map((section) => (
            <NavLink key={section.path} className="wb-row" to={`${base}/${section.path}`}>
              <Icon name={section.icon} />
              <span className="wb-row-name">{section.label}</span>
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="island settings-content">
        <Routes>
          <Route index element={<Navigate to={`${base}/${visible[0]!.path}`} replace />} />
          {sections.map((section) => <Route key={section.path} path={section.path} element={section.allowed === false ? <p>{t('auth.forbidden')}</p> : section.element} />)}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </div>
    </div>
  )
}

export function Settings({ onManageWorkspace, onCurrentWorkspaceDeleted, busy = false }: { onManageWorkspace: (id: string) => void; onCurrentWorkspaceDeleted: () => void; busy?: boolean }) {
  const { t } = useTranslation()
  const session = useSession()
  const workspace = session.state.status === 'ok' ? session.state.data.workspace : undefined
  // Without a current workspace, there may still be some to choose from: the one it was in was deleted.
  const choosable = session.state.status === 'ok' && Boolean(session.state.data.workspaces?.length)
  const admin = session.atLeast('admin')

  return (
    <Routes>
      <Route index element={<Navigate to="/settings/personal/account" replace />} />
      <Route path="personal/*" element={<SettingsArea base="/settings/personal" title={t('topbar.accountSettings')} sections={[
        { path: 'account', label: t('settings.account'), icon: 'user', element: <Account /> },
        { path: 'mcp', label: t('settings.mcp'), icon: 'link', element: <Mcp /> },
      ]} />} />
      <Route path="system/*" element={<SettingsArea base="/settings/system" title={t('topbar.systemSettings')} allowed={session.isOrgAdmin} sections={[
        { path: 'users', label: t('settings.users'), icon: 'user', element: <Users /> },
        { path: 'groups', label: t('settings.groups'), icon: 'users', element: <Groups /> },
        { path: 'workspaces', label: t('settings.workspaces'), icon: 'layers', element: <Workspaces onManage={onManageWorkspace} onCurrentDeleted={onCurrentWorkspaceDeleted} busy={busy} /> },
        { path: 'ai', label: t('settings.ai'), icon: 'assistant', element: <AIModels /> },
        { path: 'ai-usage', label: t('settings.aiUsage'), icon: 'chart', element: <AIUsage /> },
        { path: 'email', label: t('settings.email'), icon: 'mail', element: <EmailSettingsPage /> },
        { path: 'announcements', label: t('settings.announcements'), icon: 'megaphone', element: <Announcements scope="system" /> },
        { path: 'audit', label: t('settings.audit'), icon: 'clock', element: <Audit /> },
        { path: 'general', label: t('settings.systemGeneral'), icon: 'settings', element: <SystemGeneral /> },
      ]} />} />
      <Route path="workspace/*" element={<SettingsArea key={workspace?.id} base="/settings/workspace" title={t('settings.workspaceTitle', { name: workspace?.name ?? '' })} allowed={Boolean(workspace) && session.atLeast('developer')} unavailable={!workspace ? t(choosable ? 'auth.chooseWorkspace' : 'auth.noWorkspace') : undefined} sections={[
        { path: 'general', label: t('settings.general'), icon: 'settings', allowed: admin, element: <Workspace /> },
        { path: 'members', label: t('member.title'), icon: 'users', allowed: admin, element: <Members /> },
        { path: 'announcements', label: t('settings.announcements'), icon: 'megaphone', allowed: admin, element: <Announcements scope="workspace" /> },
        { path: 'attributes', label: t('attribute.title'), icon: 'format', element: <UserAttributes /> },
      ]} />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}
