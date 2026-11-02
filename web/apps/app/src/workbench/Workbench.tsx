import type { Slots } from '../components/EditorPanels'
import { Button, Tooltip, type ColorScheme } from '@supabi/ui'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router'
import type { FolderKind } from '../api/client'
import { useSession } from '../auth/session'
import { Icon } from '../components/Icon'
import { useUnsavedActions } from '../components/UnsavedChanges'
import { ChartEditor } from '../pages/ChartEditor'
import { DashboardEditor } from '../pages/DashboardPage'
import { DatasetEditor } from '../pages/DatasetEditor'
import { DatasourcesSection } from '../pages/Datasources'
import { NotFound } from '../pages/NotFound'
import { WorkbenchProvider, folderPath, sectionOf, sections, useWorkbench, type Recent, type Section } from './context'
import { useStored } from '../lib/useStored'
import { Palette, sectionIcons } from './Palette'
import { LineageSection } from './Lineage'
import { ResourceTree } from './ResourceTree'
import { Resizer, SidePanel, foldClass, useFolding } from './slots'

// Parts whose pages are resources that can be opened again by path.
const reopenable: Section[] = ['dashboards', 'charts', 'datasets', 'datasources']
const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)

/** What a part shows before anything in it is opened. */
function Landing({ section, action }: { section: Section; action?: ReactNode }) {
  const { t } = useTranslation()
  return (
    <div className="wb-landing">
      <Icon name={sectionIcons[section]} size={40} />
      <p>{t(`workbench.landing.${section}`)}</p>
      {action}
      <p className="note small">{t('workbench.searchHint', { key: isMac ? '⌘K' : 'Ctrl+K' })}</p>
    </div>
  )
}

/** A part whose resources are kept in folders. */
function TreeSection({ kind, colorScheme }: { kind: FolderKind; colorScheme: ColorScheme }) {
  const { t } = useTranslation()
  const section = sectionOf[kind]
  const editor = kind === 'dashboard' ? <DashboardEditor colorScheme={colorScheme} /> : kind === 'chart' ? <ChartEditor colorScheme={colorScheme} /> : <DatasetEditor />
  // A dataset is made from SQL written in data exploration.
  const create = kind === 'dataset' ? '/explore' : `/workbench/${section}/new`
  return (
    <>
      <SidePanel>
        <ResourceTree kind={kind} />
      </SidePanel>
      <Routes>
        <Route
          index
          element={
            <Landing
              section={section}
              action={
                <Link to={create}>
                  <Button variant="primary">{t(`workbench.new.${kind}`)}</Button>
                </Link>
              }
            />
          }
        />
        <Route path="new" element={editor} />
        <Route path=":id" element={editor} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </>
  )
}

function Frame({ colorScheme, setSlot }: { colorScheme: ColorScheme; setSlot: (name: keyof Slots, node: HTMLElement | null) => void }) {
  const { t } = useTranslation()
  const session = useSession()
  const location = useLocation()
  const navigate = useNavigate()
  const { resources } = useWorkbench()
  const { isSessionChanging } = useUnsavedActions()
  const [sideOpen, setSideOpen] = useStored('supabi.workbench.sideOpen', true)
  const [sideWidth, setSideWidth] = useStored('supabi.workbench.sideWidth', 260)
  const sideFolding = useFolding(sideOpen)
  const [searching, setSearching] = useState(false)
  // Stable, or each render would take the slots away and hand them back.
  const sideRef = useCallback((node: HTMLElement | null) => setSlot('side', node), [setSlot])
  const asideRef = useCallback((node: HTMLElement | null) => setSlot('aside', node), [setSlot])
  const bottomRef = useCallback((node: HTMLElement | null) => setSlot('bottom', node), [setSlot])
  const statusRef = useCallback((node: HTMLElement | null) => setSlot('status', node), [setSlot])

  // Every part is for developers, as the server has it.
  const allowed = useMemo<Section[]>(() => (session.atLeast('developer') ? [...sections] : []), [session])
  const [, , first, openId] = location.pathname.split('/')
  const current = sections.find((section) => section === first)

  // Coming back to a part shows what was open in it.
  const last = useRef<Partial<Record<Section, string>>>({})
  useEffect(() => {
    if (current) last.current[current] = location.pathname + location.search
  }, [current, location])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        if (!isSessionChanging()) setSearching(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isSessionChanging])

  const choose = (section: Section) => {
    if (section === current) return setSideOpen(!sideOpen)
    setSideOpen(true)
    void navigate(last.current[section] ?? `/workbench/${section}`)
  }

  // Where the open page is: the part, the folders, the name.
  const crumbs: string[] = []
  if (current) {
    crumbs.push(t(`workbench.sections.${current}`))
    if (openId === 'new') crumbs.push(t('workbench.unnamed'))
    else if (openId) {
      const listed = current === 'lineage' ? [] : resources[current]
      const item = (listed as { id: string; name: string; folderId?: string }[]).find((candidate) => candidate.id === openId)
      if (item) crumbs.push(...folderPath(resources.folders, item.folderId).map((folder) => folder.name), item.name)
    }
  }

  const guard = (section: Section, page: ReactNode) => (allowed.includes(section) ? page : <p className="wb-landing">{t('auth.forbidden')}</p>)

  return (
    <div className="wb">
      <nav className="wb-stripe" aria-label={t('nav.workbench')}>
        {allowed.map((section) => (
          // Beside the stripe, where it covers nothing of the panel it opens.
          <Tooltip key={section} placement="right" title={t(`workbench.sections.${section}`)}>
            <button type="button" className={section === current ? (sideOpen ? 'active' : 'current') : undefined} aria-label={t(`workbench.sections.${section}`)} aria-pressed={section === current} onClick={() => choose(section)}>
              <Icon name={sectionIcons[section]} size={18} />
            </button>
          </Tooltip>
        ))}
        <span className="spacer" />
        <Tooltip placement="right" title={`${t('workbench.search')} (${isMac ? '⌘K' : 'Ctrl+K'})`}>
          <button type="button" aria-label={t('workbench.search')} onClick={() => setSearching(true)}>
            <Icon name="search" size={18} />
          </button>
        </Tooltip>
      </nav>
      <div className={`wb-side-fold ${foldClass('x', sideFolding)}`} style={{ width: `calc(${sideWidth}px + var(--island-gap))` }} hidden={!sideOpen && !sideFolding}>
        <aside className="wb-side" style={{ '--wb-panel': `${sideWidth}px` } as CSSProperties} ref={sideRef} />
        <Resizer direction="horizontal" grows="forward" size={sideWidth} min={180} max={560} onResize={setSideWidth} label={t('workbench.resizeSide')} />
      </div>
      <div className="wb-center">
        <div className="wb-top">
          <div className="wb-aside-slot" ref={asideRef} />
          <div className="wb-main">
            <Routes>
              <Route index element={allowed[0] ? <Navigate to={allowed[0]} replace /> : <p className="wb-landing">{t('auth.forbidden')}</p>} />
              <Route path="dashboards/*" element={guard('dashboards', <TreeSection kind="dashboard" colorScheme={colorScheme} />)} />
              <Route path="charts/*" element={guard('charts', <TreeSection kind="chart" colorScheme={colorScheme} />)} />
              <Route path="datasets/*" element={guard('datasets', <TreeSection kind="dataset" colorScheme={colorScheme} />)} />
              <Route path="datasources/*" element={guard('datasources', <DatasourcesSection />)} />
              <Route path="lineage/*" element={guard('lineage', <LineageSection />)} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </div>
        </div>
        <div className="wb-bottom" ref={bottomRef} />
      </div>
      <footer className="wb-status">
        <span className="wb-status-path">{[session.state.status === 'ok' ? session.state.data.workspace?.name : undefined, ...crumbs].filter(Boolean).join(' › ')}</span>
        <span className="spacer" />
        <span className="wb-status-items" ref={statusRef} />
      </footer>
      <Palette open={searching} onClose={() => setSearching(false)} allowed={allowed} />
    </div>
  )
}

/**
 * Where everything is made: dashboards, charts, datasets and data sources. Laid out like a code editor: a strip
 * of parts, a panel listing what the chosen part holds, the editor, a panel
 * under it for results, and a status bar.
 */
export function Workbench({ colorScheme }: { colorScheme: ColorScheme }) {
  const session = useSession()
  const location = useLocation()
  const [slots, setSlots] = useState<Slots>({ side: null, aside: null, bottom: null, status: null })
  const setSlot = useMemo(() => (name: keyof Slots, node: HTMLElement | null) => setSlots((current) => (current[name] === node ? current : { ...current, [name]: node })), [])

  const workspaceId = session.state.status === 'ok' ? (session.state.data.workspace?.id ?? '') : ''
  const [recent, setRecent] = useStored<Recent[]>(`supabi.workbench.recent.${workspaceId}`, [])
  const [, , first, openId] = location.pathname.split('/')
  useEffect(() => {
    const section = reopenable.find((candidate) => candidate === first)
    if (!section || !openId || openId === 'new') return
    if (recent[0]?.section === section && recent[0].id === openId) return
    setRecent([{ section, id: openId }, ...recent.filter((item) => !(item.section === section && item.id === openId))].slice(0, 12))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recorded when the page changes, not when the list does
  }, [first, openId])

  return (
    <WorkbenchProvider slots={slots} recent={recent}>
      <Frame colorScheme={colorScheme} setSlot={setSlot} />
    </WorkbenchProvider>
  )
}
