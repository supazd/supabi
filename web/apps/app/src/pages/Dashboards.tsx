import { Input, Tooltip, type ColorScheme } from '@supabi/ui'
import { useCallback, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router'
import { api, unwrap, type DashboardSummary, type Folder } from '../api/client'
import { useAsync } from '../api/useAsync'
import { useSession } from '../auth/session'
import { ErrorAlert } from '../components/ErrorAlert'
import { Icon } from '../components/Icon'
import { folderPath } from '../workbench/context'
import { useStored } from '../lib/useStored'
import { ScrollArea, useArea } from '../lib/nearby'
import { Resizer } from '../workbench/slots'
import { DashboardView } from './DashboardPage'

/**
 * The dashboards there are to read: their folders on the left, the chosen
 * dashboard on the right. Nothing is changed here; dashboards are made and
 * put into folders in the workbench. On a narrow screen the list and the
 * dashboard are two screens, see .agents/design/chart-dashboard.md §3.16.
 */
export function MyDashboards({ colorScheme }: { colorScheme: ColorScheme }) {
  const { t } = useTranslation()
  const { id } = useParams()
  const canEdit = useSession().atLeast('developer')
  const list = useAsync(() => Promise.all([unwrap(api.GET('/dashboards')), unwrap(api.GET('/folders'))]), [])
  const [width, setWidth] = useStored('supabi.dashboards.sideWidth', 260)
  // Folders start open: a reader is looking for a dashboard, not tidying.
  const [closed, setClosed] = useStored<string[]>('supabi.dashboards.closed', [])
  const [filter, setFilter] = useState('')
  // The chosen dashboard scrolls here, which its charts watch to ask for their data as they come near.
  const content = useRef<HTMLDivElement>(null)
  const area = useArea(useCallback(() => content.current, []))

  const dashboards: DashboardSummary[] = list.status === 'ok' ? list.data[0] : []
  const folders: Folder[] = list.status === 'ok' ? list.data[1].filter((folder) => folder.kind === 'dashboard') : []
  const toggle = (folderId: string) => setClosed(closed.includes(folderId) ? closed.filter((item) => item !== folderId) : [...closed, folderId])

  const renderItem = (item: DashboardSummary, depth: number, detail?: string): ReactNode => (
    <Link key={item.id} to={`/dashboards/${item.id}`} className={item.id === id ? 'wb-row active' : 'wb-row'} style={{ paddingLeft: 8 + depth * 14 + 16 }} title={item.description || item.name}>
      <Icon name="dashboard" />
      <span className="wb-row-name">{item.name}</span>
      {detail && <span className="wb-row-detail">{detail}</span>}
    </Link>
  )

  /** Whether a folder holds a dashboard at any depth. Empty folders are not shown to readers. */
  const holds = (folderId: string): boolean => dashboards.some((item) => item.folderId === folderId) || folders.some((folder) => folder.parentId === folderId && holds(folder.id))

  const renderLevel = (parentId: string | undefined, depth: number): ReactNode => [
    ...folders
      .filter((folder) => folder.parentId === parentId && holds(folder.id))
      .map((folder) => {
        const isOpen = !closed.includes(folder.id)
        return (
          <div key={folder.id} role="group" aria-label={folder.name}>
            <div
              className="wb-row folder"
              style={{ paddingLeft: 8 + depth * 14 }}
              role="button"
              tabIndex={0}
              aria-expanded={isOpen}
              onClick={() => toggle(folder.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  toggle(folder.id)
                }
              }}
            >
              <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={12} />
              <Icon name="folder" />
              <span className="wb-row-name">{folder.name}</span>
            </div>
            {isOpen && renderLevel(folder.id, depth + 1)}
          </div>
        )
      }),
    ...dashboards.filter((item) => item.folderId === parentId).map((item) => renderItem(item, depth)),
  ]

  const wanted = filter.trim().toLowerCase()
  const matches = wanted ? dashboards.filter((item) => item.name.toLowerCase().includes(wanted)) : []
  // Shown above the dashboard only when the list beside it is not: the name is then nowhere else.
  const name = dashboards.find((item) => item.id === id)?.name

  return (
    <div className={id ? 'board-browser has-board' : 'board-browser'}>
      {/* The width is the stylesheet's to drop on a narrow screen, where the list takes the whole of it. */}
      <aside className="wb-side" style={{ '--board-side-width': `${width}px` } as CSSProperties}>
        <div className="wb-side-header">
          <span className="wb-side-title">{t('nav.dashboards')}</span>
          {canEdit && (
            <Tooltip title={t('dashboard.manage')}>
              <Link target="_blank" rel="noopener noreferrer" to={id ? `/workbench/dashboards/${id}` : '/workbench/dashboards'} className="wb-icon-button" aria-label={t('dashboard.manage')}>
                <Icon name="external" />
              </Link>
            </Tooltip>
          )}
        </div>
        <div className="wb-side-filter">
          <Input size="sm" aria-label={t('workbench.filter')} placeholder={t('workbench.filter')} value={filter} onChange={setFilter} />
        </div>
        {list.status === 'error' && <ErrorAlert error={list.error} />}
        <nav className="wb-tree" aria-label={t('nav.dashboards')}>
          {list.status === 'loading' ? (
            <p className="wb-side-empty">{t('common.loading')}</p>
          ) : wanted ? (
            matches.length > 0 ? (
              matches.map((item) => renderItem(item, 0, folderPath(folders, item.folderId).map((folder) => folder.name).join(' / ')))
            ) : (
              <p className="wb-side-empty">{t('workbench.noMatches')}</p>
            )
          ) : dashboards.length === 0 ? (
            <p className="wb-side-empty">{t('dashboard.empty')}</p>
          ) : (
            renderLevel(undefined, 0)
          )}
        </nav>
      </aside>
      <Resizer direction="horizontal" grows="forward" size={width} min={180} max={560} onResize={setWidth} label={t('workbench.resizeSide')} />
      <div ref={content} className="board-content">
        {id ? (
          <>
            <div className="board-back">
              <Link to="/dashboards" className="wb-icon-button" aria-label={t('dashboard.backToList')}>
                <Icon name="chevronLeft" />
              </Link>
              {name && <span className="board-back-name" title={name}>{name}</span>}
            </div>
            <ScrollArea value={area}><DashboardView key={id} colorScheme={colorScheme} /></ScrollArea>
          </>
        ) : (
          <div className="wb-landing">
            <Icon name="dashboard" size={40} />
            <p>{dashboards.length > 0 ? t('dashboard.choose') : t('dashboard.empty')}</p>
          </div>
        )}
      </div>
    </div>
  )
}
