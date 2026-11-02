import { EditorPanelsProvider, type Slots } from '../components/EditorPanels'
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ApiError, api, unwrap, type ChartSummary, type DashboardSummary, type DatasetSummary, type Datasource, type Folder, type FolderKind } from '../api/client'
import { toApiError } from '../api/useAsync'

/** The parts of the workbench, in the order they are listed. Each is also the first segment of its path. */
export const sections = ['dashboards', 'charts', 'datasets', 'datasources', 'lineage'] as const
export type Section = (typeof sections)[number]

/** The section in which resources of a kind are listed and edited. */
export const sectionOf: Record<FolderKind, Section> = { dashboard: 'dashboards', chart: 'charts', dataset: 'datasets' }

/** Everything the workbench lists by name. Lists the user may not read are empty. */
export interface Resources {
  dashboards: DashboardSummary[]
  charts: ChartSummary[]
  datasets: DatasetSummary[]
  folders: Folder[]
  datasources: Datasource[]
}

const none: Resources = { dashboards: [], charts: [], datasets: [], folders: [], datasources: [] }

/** A resource opened lately, as the path it is edited at. */
export interface Recent {
  section: Section
  id: string
}

interface WorkbenchContext {
  resources: Resources
  /** False until the lists have arrived once. */
  loaded: boolean
  error: ApiError | null
  /** Fetches the lists again, after something was created, renamed, moved or deleted. */
  reload: () => Promise<void>
  recent: Recent[]
}

const Context = createContext<WorkbenchContext | null>(null)

export function useWorkbench(): WorkbenchContext {
  const context = useContext(Context)
  if (!context) throw new Error('useWorkbench must be used inside the workbench')
  return context
}

export function WorkbenchProvider({ slots, recent, children }: { slots: Slots; recent: Recent[]; children: ReactNode }) {
  const [resources, setResources] = useState<Resources>(none)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)

  const reload = useCallback(async () => {
    // The workbench is for developers, who may list everything in it.
    try {
      const [dashboardList, chartList, datasetList, folderList, datasourceList] = await Promise.all([
        unwrap(api.GET('/dashboards')),
        unwrap(api.GET('/charts')),
        unwrap(api.GET('/datasets')),
        unwrap(api.GET('/folders')),
        unwrap(api.GET('/datasources')),
      ])
      setResources({ dashboards: dashboardList, charts: chartList, datasets: datasetList, folders: folderList, datasources: datasourceList })
      setError(null)
    } catch (e) {
      setError(toApiError(e))
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const value = useMemo<WorkbenchContext>(
    () => ({ resources, loaded, error, reload, recent }),
    [resources, loaded, error, reload, recent],
  )
  return <Context.Provider value={value}><EditorPanelsProvider slots={slots} storageKey="supabi.workbench">{children}</EditorPanelsProvider></Context.Provider>
}

/** The folders a folder is inside, outermost first, then the folder itself. */
export function folderPath(folders: Folder[], folderId: string | undefined): Folder[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const path: Folder[] = []
  // The bound guards against a loop the server would never store.
  for (let id = folderId; id && path.length < 50; ) {
    const folder = byId.get(id)
    if (!folder) break
    path.unshift(folder)
    id = folder.parentId
  }
  return path
}
