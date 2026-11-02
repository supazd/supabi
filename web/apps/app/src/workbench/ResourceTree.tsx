import { Button, Dialog, Field, Input, Menu, Select, Tooltip, type MenuItem } from '@supabi/ui'
import { useEffect, useMemo, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useMatch, useNavigate } from 'react-router'
import { api, unwrap, type Folder, type FolderKind } from '../api/client'
import { ErrorAlert } from '../components/ErrorAlert'
import { Icon, type IconName } from '../components/Icon'
import { useAction } from '../pages/settings/shared'
import { folderPath, sectionOf, useWorkbench } from './context'
import { useStored } from '../lib/useStored'
import { afterSave } from './slots'

interface Item {
  id: string
  name: string
  folderId?: string
}

interface ResourceTreeProps {
  kind: FolderKind
  filter?: string
  id?: string
  /** A read-only choice from the same tree, without resource management actions. */
  selection?: { value?: string; onSelect: (id: string) => void }
  /** Browse the same folders to copy resources into another editor. */
  addition?: {
    items: Item[]
    added: ReadonlySet<string>
    onAdd: (id: string) => void
    label: string
    addedLabel: string
    dragType: string
  }
}

/** What a dialog of the tree is about. */
type Task =
  // Naming: a new folder, or another name for an existing folder.
  | { type: 'name'; parentId?: string; folder?: Folder }
  | { type: 'move'; item?: Item; folder?: Folder }
  | { type: 'delete'; item?: Item; folder?: Folder }

const icons: Record<FolderKind, IconName> = { dashboard: 'dashboard', chart: 'chart', dataset: 'dataset' }
const dragType = 'application/x-supabi-node'
const root = '__root__'

function deleteResource(kind: FolderKind, id: string) {
  const params = { params: { path: { id } } }
  if (kind === 'dashboard') return unwrap(api.DELETE('/dashboards/{id}', params))
  if (kind === 'chart') return unwrap(api.DELETE('/charts/{id}', params))
  return unwrap(api.DELETE('/datasets/{id}', params))
}

/**
 * The dashboards, charts or datasets of the workspace as a tree of folders.
 * Folders are made, renamed, moved and deleted here; resources are opened,
 * moved and deleted. Dragging onto a folder moves.
 */
export function ResourceTree({ kind, filter: outerFilter, id, selection, addition }: ResourceTreeProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { resources, reload, loaded, error } = useWorkbench()
  const section = sectionOf[kind]
  const items: Item[] = addition?.items ?? resources[section as 'dashboards' | 'charts' | 'datasets']
  const folders = useMemo(() => resources.folders.filter((folder) => folder.kind === kind), [resources.folders, kind])
  const routeActiveId = useMatch(`/workbench/${section}/:id`)?.params.id
  const activeId = selection ? selection.value : addition ? undefined : routeActiveId
  const [storedExpanded, setStoredExpanded] = useStored<string[]>(`supabi.workbench.expanded.${kind}${addition ? '.addition' : ''}`, [])
  const selectedFolderId = selection ? items.find((item) => item.id === selection.value)?.folderId : undefined
  // Compared by what it holds: reloading the resources must not reveal the selection again.
  const selectedPath = folderPath(folders, selectedFolderId).map((folder) => folder.id).join('/')
  const selectedParents = useMemo(() => (selectedPath ? selectedPath.split('/') : []), [selectedPath])
  const [selectionExpanded, setSelectionExpanded] = useState<string[]>(selectedParents)
  const expanded = selection ? selectionExpanded : storedExpanded
  const setExpanded = selection ? setSelectionExpanded : setStoredExpanded
  const choosing = Boolean(selection)
  const readOnly = Boolean(selection || addition)
  const [ownFilter, setFilter] = useState('')
  const filter = outerFilter ?? ownFilter
  const [task, setTask] = useState<Task | null>(null)
  const [name, setName] = useState('')
  const [destination, setDestination] = useState(root)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const action = useAction()

  // The picker reveals its selection without changing the sidebar's saved state.
  useEffect(() => {
    if (choosing) setSelectionExpanded((current) => [...new Set([...current, ...selectedParents])])
  }, [choosing, selectedParents])

  // A dataset starts as SQL in data exploration; the others in their editor.
  const newPath = (folderId?: string) => `${kind === 'dataset' ? '/explore' : `/workbench/${section}/new`}${folderId ? `?folder=${folderId}` : ''}`
  const open = (folderId: string) => !expanded.includes(folderId) && setExpanded([...expanded, folderId])
  const toggle = (folderId: string) => setExpanded(expanded.includes(folderId) ? expanded.filter((id) => id !== folderId) : [...expanded, folderId])
  const pathLabel = (folderId: string | undefined) => folderPath(folders, folderId).map((folder) => folder.name).join(' / ')

  /** The folders inside a folder, at any depth, and the folder itself. */
  const within = (folderId: string): Set<string> => {
    const found = new Set([folderId])
    for (let grew = true; grew; ) {
      grew = false
      for (const folder of folders) {
        if (folder.parentId && found.has(folder.parentId) && !found.has(folder.id)) {
          found.add(folder.id)
          grew = true
        }
      }
    }
    return found
  }

  const start = (next: Task) => {
    setTask(next)
    if (next.type === 'name') setName(next.folder?.name ?? '')
    if (next.type === 'move') setDestination((next.item ? next.item.folderId : next.folder?.parentId) ?? root)
  }
  const finish = () => {
    setTask(null)
    void reload()
  }

  const create = (folderId?: string) => void navigate(newPath(folderId))

  const moveItem = (item: Item, folderId: string | undefined) => unwrap(api.POST('/folders/move', { body: { kind, id: item.id, folderId } }))
  const moveFolder = (folder: Folder, parentId: string | undefined) => unwrap(api.PUT('/folders/{id}', { params: { path: { id: folder.id } }, body: { name: folder.name, parentId } }))

  const confirm = () => {
    if (!task) return
    if (task.type === 'name') {
      const { folder, parentId } = task
      void action.run(
        async () => {
          if (folder) await unwrap(api.PUT('/folders/{id}', { params: { path: { id: folder.id } }, body: { name, parentId: folder.parentId } }))
          else await unwrap(api.POST('/folders', { body: { kind, name, parentId } }))
        },
        () => {
          if (parentId) open(parentId)
          finish()
        },
      )
    } else if (task.type === 'move') {
      const to = destination === root ? undefined : destination
      void action.run(
        () => (task.item ? moveItem(task.item, to) : moveFolder(task.folder!, to)),
        () => {
          if (to) open(to)
          finish()
        },
      )
    } else {
      const { item, folder } = task
      void action.run(
        () => (item ? deleteResource(kind, item.id) : unwrap(api.DELETE('/folders/{id}', { params: { path: { id: folder!.id } } }))),
        () => {
          finish()
          // What was open is gone; there is nothing left to ask about.
          if (item && item.id === activeId) void navigate(`/workbench/${section}`, { state: afterSave })
        },
      )
    }
  }

  // ---- dragging ----

  const drag = (event: DragEvent, node: { item?: string; folder?: string }) => {
    event.dataTransfer.setData(dragType, JSON.stringify(node))
    event.dataTransfer.effectAllowed = 'move'
  }
  const over = (event: DragEvent, target: string) => {
    if (!event.dataTransfer.types.includes(dragType)) return
    event.preventDefault()
    event.stopPropagation()
    setDropTarget(target)
  }
  const drop = (event: DragEvent, target: string) => {
    event.preventDefault()
    event.stopPropagation()
    setDropTarget(null)
    let node: { item?: string; folder?: string }
    try {
      node = JSON.parse(event.dataTransfer.getData(dragType)) as typeof node
    } catch {
      return
    }
    const to = target === root ? undefined : target
    const item = items.find((candidate) => candidate.id === node.item)
    const folder = folders.find((candidate) => candidate.id === node.folder)
    if (item && item.folderId !== to) {
      void action.run(() => moveItem(item, to), finish)
    } else if (folder && folder.parentId !== to && !(to && within(folder.id).has(to))) {
      void action.run(() => moveFolder(folder, to), finish)
    } else {
      return
    }
    if (to) open(to)
  }

  // ---- rows ----

  const more = (menu: MenuItem[], label: string) => (
    <Menu items={menu}>
      <button
        type="button"
        className="wb-icon-button wb-row-more"
        aria-label={label}
        onClick={(event) => {
          // The row is a link or a toggle; its menu is neither.
          event.preventDefault()
          event.stopPropagation()
        }}
      >
        <Icon name="more" />
      </button>
    </Menu>
  )

  const renderItem = (item: Item, depth: number, detail?: string): ReactNode => {
    const menu: MenuItem[] = [
      { key: 'move', label: t('workbench.moveTo'), onSelect: () => start({ type: 'move', item }) },
      { key: 'delete', label: t('common.delete'), danger: true, onSelect: () => start({ type: 'delete', item }) },
    ]
    const content = (
      <>
        <Icon name={icons[kind]} />
        <span className="wb-row-name">{item.name}</span>
        {detail && <span className="wb-row-detail">{detail}</span>}
        {addition?.added.has(item.id) && <span className="wb-row-detail">{addition.addedLabel}</span>}
        {!readOnly && more(menu, `${t('common.actions')} ${item.name}`)}
      </>
    )
    if (addition) return (
      <div
        key={item.id}
        role="treeitem"
        aria-label={item.name}
        aria-level={depth + 1}
        data-resource-id={item.id}
        data-parent-folder-id={item.folderId}
        tabIndex={0}
        className="wb-row chart-source"
        style={{ paddingLeft: 8 + depth * 14 + 16 }}
        title={detail ? `${item.name} — ${detail}` : item.name}
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData(addition.dragType, item.id)
          event.dataTransfer.setData('text/plain', item.name)
          event.dataTransfer.effectAllowed = 'copy'
        }}
      >
        {content}
        <Tooltip title={addition.label}>
          <button type="button" data-tree-add className="wb-icon-button wb-row-more" aria-label={`${addition.label} ${item.name}`} onClick={() => addition.onAdd(item.id)}>
            <Icon name="plus" />
          </button>
        </Tooltip>
      </div>
    )
    if (selection) return (
      <button
        key={item.id}
        type="button"
        role="treeitem"
        aria-selected={item.id === activeId}
        aria-level={depth + 1}
        data-resource-id={item.id}
        data-parent-folder-id={item.folderId}
        className={item.id === activeId ? 'wb-row active' : 'wb-row'}
        style={{ paddingLeft: 8 + depth * 14 + 16 }}
        title={detail ? `${item.name} — ${detail}` : item.name}
        onClick={() => selection.onSelect(item.id)}
      >
        {content}
      </button>
    )
    return (
      <Menu key={item.id} items={menu} trigger="context">
        <Link
          to={`/workbench/${section}/${item.id}`}
          className={item.id === activeId ? 'wb-row active' : 'wb-row'}
          style={{ paddingLeft: 8 + depth * 14 + 16 }}
          draggable
          onDragStart={(event) => drag(event, { item: item.id })}
          title={item.name}
        >
          {content}
        </Link>
      </Menu>
    )
  }

  const renderFolder = (folder: Folder, depth: number): ReactNode => {
    const isOpen = expanded.includes(folder.id)
    const menu: MenuItem[] = [
      { key: 'new', label: t(`workbench.new.${kind}`), onSelect: () => create(folder.id) },
      { key: 'folder', label: t('workbench.newFolder'), onSelect: () => start({ type: 'name', parentId: folder.id }) },
      { key: 'rename', label: t('workbench.rename'), onSelect: () => start({ type: 'name', folder }) },
      { key: 'move', label: t('workbench.moveTo'), onSelect: () => start({ type: 'move', folder }) },
      { key: 'delete', label: t('common.delete'), danger: true, onSelect: () => start({ type: 'delete', folder }) },
    ]
    const row = (
      <div
        className={dropTarget === folder.id ? 'wb-row folder drop' : 'wb-row folder'}
        style={{ paddingLeft: 8 + depth * 14 }}
        role={readOnly ? 'treeitem' : 'button'}
        tabIndex={0}
        aria-expanded={isOpen}
        aria-level={readOnly ? depth + 1 : undefined}
        data-folder-id={readOnly ? folder.id : undefined}
        data-parent-folder-id={readOnly ? folder.parentId : undefined}
        title={readOnly ? folder.name : undefined}
        draggable={readOnly ? undefined : true}
        onDragStart={readOnly ? undefined : (event) => drag(event, { folder: folder.id })}
        onDragOver={readOnly ? undefined : (event) => over(event, folder.id)}
        onDragLeave={readOnly ? undefined : () => setDropTarget(null)}
        onDrop={readOnly ? undefined : (event) => drop(event, folder.id)}
        onClick={() => toggle(folder.id)}
        onKeyDown={readOnly ? undefined : (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            toggle(folder.id)
          }
        }}
      >
        <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={12} />
        <Icon name="folder" />
        <span className="wb-row-name">{folder.name}</span>
        {!readOnly && more(menu, `${t('common.actions')} ${folder.name}`)}
      </div>
    )
    return (
      <div key={folder.id} role="group" aria-label={folder.name}>
        {readOnly ? row : <Menu items={menu} trigger="context">{row}</Menu>}
        {isOpen && renderLevel(folder.id, depth + 1)}
      </div>
    )
  }

  const renderLevel = (parentId: string | undefined, depth: number): ReactNode => {
    const inside = [...folders.filter((folder) => folder.parentId === parentId).map((folder) => renderFolder(folder, depth)), ...items.filter((item) => item.folderId === parentId).map((item) => renderItem(item, depth))]
    return inside.length === 0 && parentId ? (
      <div className="wb-row-empty" style={{ paddingLeft: 8 + depth * 14 + 16 }}>
        {t('workbench.emptyFolder')}
      </div>
    ) : (
      inside
    )
  }

  const wanted = filter.trim().toLowerCase()
  const matches = wanted ? items.filter((item) => item.name.toLowerCase().includes(wanted)) : []

  const navigateTree = (event: KeyboardEvent<HTMLDivElement>) => {
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]'))
    const current = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]')
    const index = current ? rows.indexOf(current) : -1
    let next: HTMLElement | undefined
    if (event.key === 'ArrowDown') next = rows[Math.min(index + 1, rows.length - 1)]
    else if (event.key === 'ArrowUp') next = rows[index < 0 ? rows.length - 1 : Math.max(0, index - 1)]
    else if (event.key === 'Home') next = rows[0]
    else if (event.key === 'End') next = rows.at(-1)
    else if (event.key === 'ArrowRight' && current?.dataset.folderId) {
      if (current.getAttribute('aria-expanded') === 'false') toggle(current.dataset.folderId)
      else if (rows[index + 1]?.dataset.parentFolderId === current.dataset.folderId) next = rows[index + 1]
    } else if (event.key === 'ArrowLeft' && current) {
      if (current.dataset.folderId && current.getAttribute('aria-expanded') === 'true') toggle(current.dataset.folderId)
      else next = rows.find((row) => row.dataset.folderId === current.dataset.parentFolderId && row.dataset.folderId !== undefined)
    } else if ((event.key === 'Enter' || event.key === ' ') && current) {
      // An add button handles its native activation; the focused row offers the same action.
      if (event.target !== current) return
      const add = current.querySelector<HTMLButtonElement>('[data-tree-add]')
      if (add) add.click()
      else current.click()
    } else return
    event.preventDefault()
    event.stopPropagation()
    next?.focus()
  }

  // ---- dialogs ----

  const subject = task?.type === 'name' ? undefined : (task?.item?.name ?? task?.folder?.name)
  // A folder cannot go into itself or into a folder it holds.
  const excluded = task?.type === 'move' && task.folder ? within(task.folder.id) : new Set<string>()
  const title = !task
    ? ''
    : task.type === 'name'
      ? task.folder ? t('workbench.renameFolder') : t('workbench.newFolder')
      : task.type === 'move'
        ? t('workbench.moveTitle', { name: subject })
        : t('workbench.deleteTitle', { name: subject })

  return (
    <>
      {!readOnly && <div className="wb-side-header">
        <span className="wb-side-title">{t(`workbench.sections.${section}`)}</span>
        <Tooltip title={t('workbench.newFolder')}>
          <button type="button" className="wb-icon-button" aria-label={t('workbench.newFolder')} onClick={() => start({ type: 'name' })}>
            <Icon name="folderPlus" />
          </button>
        </Tooltip>
        <Tooltip title={t(`workbench.new.${kind}`)}>
          <button type="button" className="wb-icon-button" aria-label={t(`workbench.new.${kind}`)} onClick={() => create()}>
            <Icon name="plus" />
          </button>
        </Tooltip>
      </div>}
      {outerFilter === undefined && (
        <div className="wb-side-filter">
          <Input size="sm" aria-label={t('workbench.filter')} placeholder={t('workbench.filter')} value={filter} onChange={setFilter} />
        </div>
      )}
      {error && <ErrorAlert error={error} />}
      {!readOnly && action.error && !task && <ErrorAlert error={action.error} />}
      <div
        id={id}
        className={dropTarget === root ? 'wb-tree drop' : 'wb-tree'}
        role="tree"
        aria-label={t(`workbench.sections.${section}`)}
        onKeyDown={readOnly ? navigateTree : undefined}
        onDragOver={readOnly ? undefined : (event) => over(event, root)}
        onDragLeave={readOnly ? undefined : () => setDropTarget(null)}
        onDrop={readOnly ? undefined : (event) => drop(event, root)}
      >
        {wanted ? (
          matches.length > 0 ? (
            matches.map((item) => renderItem(item, 0, pathLabel(item.folderId)))
          ) : (
            <p className="wb-side-empty">{t('workbench.noMatches')}</p>
          )
        ) : items.length + folders.length === 0 ? (
          <p className="wb-side-empty">{loaded ? t(`workbench.empty.${kind}`) : t('common.loading')}</p>
        ) : (
          renderLevel(undefined, 0)
        )}
      </div>

      {!readOnly && <Dialog
        open={task !== null}
        title={title}
        width={420}
        onClose={() => setTask(null)}
        actions={
          <>
            <Button onClick={() => setTask(null)}>{t('common.cancel')}</Button>
            <Button variant={task?.type === 'delete' ? 'secondary' : 'primary'} danger={task?.type === 'delete'} loading={action.busy} disabled={task?.type === 'name' && !name.trim()} onClick={confirm}>
              {task?.type === 'delete' ? t('common.confirmDelete') : t('common.confirm')}
            </Button>
          </>
        }
      >
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault()
            if (task?.type !== 'name' || name.trim()) confirm()
          }}
        >
          {task?.type === 'name' && (
            <Field label={t('common.name')} htmlFor="folder-name" required>
              <Input id="folder-name" value={name} onChange={setName} />
            </Field>
          )}
          {task?.type === 'move' && (
            <Field label={t('workbench.destination')} htmlFor="move-destination">
              <Select
                id="move-destination"
                block
                value={destination}
                options={[{ value: root, label: t('workbench.topLevel') }, ...folders.filter((folder) => !excluded.has(folder.id)).map((folder) => ({ value: folder.id, label: pathLabel(folder.id) }))]}
                onChange={setDestination}
              />
            </Field>
          )}
          {task?.type === 'delete' && <p>{task.folder ? t('workbench.deleteFolderBody') : t('workbench.deleteBody')}</p>}
          {action.error && <ErrorAlert error={action.error} />}
        </form>
      </Dialog>}
    </>
  )
}
