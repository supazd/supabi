import { Button, Select, ThemeProvider, locales, type ColorScheme, type Locale } from '@supabi/ui'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Route, RouterProvider, Routes, createBrowserRouter, useLocation, useNavigate } from 'react-router'
import { SessionProvider, useSession, type Role, type SessionInfo } from './auth/session'
import { useSessionActions } from './auth/useSessionActions'
import { detectColorScheme, saveColorScheme } from './colorScheme'
import { Async } from './components/Async'
import { ErrorAlert } from './components/ErrorAlert'
import { Icon } from './components/Icon'
import { lazyPage, PageFrame } from './components/LazyPage'
import { AnnouncementBanner, NotificationsProvider } from './components/Notifications'
import { Topbar } from './components/Topbar'
import { UnsavedChangesProvider, useUnsavedActions } from './components/UnsavedChanges'
import { saveLocale } from './i18n'
import { showTitle } from './lib/documentTitle'
import { Home } from './pages/Home'
import { NotFound } from './pages/NotFound'
import { OAuthConsent } from './pages/OAuthConsent'
import { SignIn } from './pages/SignIn'

// Each area is fetched when first shown: viewers never download the editors,
// and nobody downloads the charts to sign in.
const MyDashboards = lazyPage(() => import('./pages/Dashboards').then((m) => m.MyDashboards))
const Settings = lazyPage(() => import('./pages/settings/Settings').then((m) => m.Settings))
const Explore = lazyPage(() => import('./explore/Explore').then((m) => m.Explore))
const Workbench = lazyPage(() => import('./workbench/Workbench').then((m) => m.Workbench))
const Assistant = lazyPage(() => import('./assistant/Assistant').then((m) => m.Assistant))

/** Shows a page only to users whose role is at least the given one. */
function Guard({ role, children }: { role: Role; children: ReactNode }) {
  const { t } = useTranslation()
  const { atLeast } = useSession()
  if (atLeast(role)) return <>{children}</>
  return (
    <section className="card">
      <p>{t('auth.forbidden')}</p>
    </section>
  )
}

interface ShellProps {
  info: SessionInfo
  colorScheme: ColorScheme
  locale: Locale
  onLocaleChange: (locale: Locale) => void
  onColorSchemeChange: (scheme: ColorScheme) => void
}

// The router is made once and its one route draws the frame, which reads what
// it shows from here.
const ShellContext = createContext<ShellProps | null>(null)

function Frame() {
  const { info, colorScheme, ...preferences } = useContext(ShellContext)!
  const { t } = useTranslation()
  // All mounted editors belong to this workspace; a successful switch starts a fresh shell.
  const navigate = useNavigate()
  const actions = useSessionActions((destination = '/') => window.location.assign(destination))
  const manageWorkspace = (id: string) => {
    if (actions.busy) return
    if (id === info.workspace?.id) void navigate('/settings/workspace/general')
    else actions.switchWorkspace(id, '/settings/workspace/general')
  }
  // Deleting the current workspace has moved the session to another, as a
  // switch does. Editors keep their drafts in the browser for the new shell.
  const { leaveDocument } = useUnsavedActions()
  const currentWorkspaceDeleted = () => leaveDocument(() => window.location.assign('/settings/system/workspaces'))
  // The workbench, the dashboards, the assistant and the settings fill the window and scroll inside themselves; other pages are documents.
  const first = useLocation().pathname.split('/')[1]
  const exploring = first === 'explore'
  const [explored, setExplored] = useState(exploring)
  useEffect(() => { if (exploring) setExplored(true) }, [exploring])
  const settings = first === 'settings'
  const fills = first === 'workbench' || first === 'dashboards' || first === 'assistant' || exploring || settings

  return (
    // The bell and the banner share what is read for the signed-in person.
    <NotificationsProvider key={info.user?.id}>
    <div className={fills ? 'frame fill' : 'frame'}>
      <Topbar
        info={info}
        colorScheme={colorScheme}
        {...preferences}
        onSwitchWorkspace={actions.switchWorkspace}
        onSignOut={actions.signOut}
        busy={actions.busy}
        pending={actions.pending}
      />
      <AnnouncementBanner />
      {actions.error && (
        <div className="session-error stack">
          <ErrorAlert error={actions.error} />
          {actions.needsRecovery && <div className="row"><span>{t('topbar.sessionUncertain')}</span><Button loading={actions.recovering} onClick={actions.retryRecovery}>{t('common.retry')}</Button></div>}
        </div>
      )}
      {info.workspace && (explored || exploring) && <main className="workbench-host" hidden={!exploring} inert={actions.pending}>
        <Guard role="developer"><PageFrame><Explore active={exploring} /></PageFrame></Guard>
      </main>}
      {/* The settings need no workspace: some of them are the organisation's or the user's own. */}
      {settings ? (
        <main className="workbench-host" inert={actions.pending}>
          <PageFrame>
            <Routes>
              <Route path="/settings/*" element={<Settings onManageWorkspace={manageWorkspace} onCurrentWorkspaceDeleted={currentWorkspaceDeleted} busy={actions.busy} />} />
            </Routes>
          </PageFrame>
        </main>
      ) : (!exploring || !info.workspace) && (fills && info.workspace ? (
        <main className="workbench-host" inert={actions.pending}>
          <PageFrame>
            <Routes>
              <Route path="/workbench/*" element={<Guard role="developer"><Workbench colorScheme={colorScheme} /></Guard>} />
              <Route path="/dashboards" element={<Guard role="viewer"><MyDashboards colorScheme={colorScheme} /></Guard>} />
              <Route path="/dashboards/:id" element={<Guard role="viewer"><MyDashboards colorScheme={colorScheme} /></Guard>} />
              <Route path="/assistant/:id?" element={<Guard role="viewer"><Assistant colorScheme={colorScheme} /></Guard>} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </PageFrame>
        </main>
      ) : (
        <main className="content wide" inert={actions.pending}>
          {!info.workspace && (
            <section className="card">
              {/* A session can be left without a workspace while its user still has some: when the one it was in is deleted. */}
              <p>{t(info.workspaces?.length ? 'auth.chooseWorkspace' : 'auth.noWorkspace')}</p>
            </section>
          )}
          <Routes>
            <Route path="/" element={<Home />} />
            {/* Without a workspace there is nothing to show; the notice above says so. */}
            <Route path="/workbench/*" element={null} />
            <Route path="/explore" element={null} />
            <Route path="/dashboards/*" element={null} />
            <Route path="/assistant/*" element={null} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </main>
      ))}
    </div>
    </NotificationsProvider>
  )
}

// A data router, which is what lets a page ask before it is left with unsaved work.
const router = createBrowserRouter([{ path: '*', element: <Frame /> }])

function Shell(props: ShellProps) {
  return (
    <ShellContext.Provider value={props}>
      <UnsavedChangesProvider>
        <RouterProvider router={router} />
      </UnsavedChangesProvider>
    </ShellContext.Provider>
  )
}

export function App() {
  const { t, i18n } = useTranslation()
  const locale = i18n.language as Locale
  const [colorScheme, setColorScheme] = useState<ColorScheme>(detectColorScheme)

  // The app's name follows the language; a page may put its own name before it.
  useEffect(() => {
    showTitle()
  }, [t])

  const changeLocale = (next: Locale) => {
    saveLocale(next)
    void i18n.changeLanguage(next)
  }

  const changeColorScheme = (next: ColorScheme) => {
    saveColorScheme(next)
    setColorScheme(next)
  }

  // Language and theme can be changed before signing in, too.
  const controls = (
    <>
      <Select
        size="sm"
        aria-label={t('language.label')}
        value={locale}
        options={locales.map((value) => ({ value, label: t(`language.${value}`) }))}
        onChange={changeLocale}
      />
      <Button
        size="sm"
        variant="ghost"
        icon={<Icon name={colorScheme === 'dark' ? 'sun' : 'moon'} />}
        aria-label={colorScheme === 'dark' ? t('theme.toLight') : t('theme.toDark')}
        onClick={() => changeColorScheme(colorScheme === 'dark' ? 'light' : 'dark')}
      />
    </>
  )

  return (
    <ThemeProvider colorScheme={colorScheme} locale={locale}>
      <SessionProvider>
        <Gate colorScheme={colorScheme} locale={locale} onLocaleChange={changeLocale} onColorSchemeChange={changeColorScheme} controls={controls} />
      </SessionProvider>
    </ThemeProvider>
  )
}

function Gate({ controls, ...preferences }: Omit<ShellProps, 'info'> & { controls: ReactNode }) {
  const session = useSession()
  // An MCP client's consent page stands alone, after signing in if need be.
  const consent = window.location.pathname.startsWith('/oauth/consent')
  return (
    <Async state={session.state} reload={session.reload}>
      {(info) =>
        info.authenticated ? (
          consent ? <><div className="signin-controls row">{controls}</div><OAuthConsent info={info} /></> : <Shell info={info} {...preferences} />
        ) : (
          <>
            <div className="signin-controls row">{controls}</div>
            <SignIn setup={info.setupRequired} />
          </>
        )
      }
    </Async>
  )
}
