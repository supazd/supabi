import { Dialog } from '@supabi/ui'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { Icon, type IconName } from '../components/Icon'
import { folderPath, useWorkbench, type Section } from './context'

interface Entry {
  key: string
  icon: IconName
  label: string
  /** Where it is, or what it does. */
  detail: string
  path: string
}

export const sectionIcons: Record<Section, IconName> = { dashboards: 'dashboard', charts: 'chart', datasets: 'dataset', datasources: 'database', lineage: 'lineage' }
const shown = 50

/**
 * Finds anything in the workbench by name and opens it. With nothing typed
 * it lists what was open lately, which makes it the way back and forth
 * between a few resources.
 */
export function Palette({ open, onClose, allowed }: { open: boolean; onClose: () => void; allowed: Section[] }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { resources, recent } = useWorkbench()
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLUListElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setIndex(0)
    // The dialog takes the focus as it opens; take it back once it has.
    const timer = setTimeout(() => input.current?.focus(), 60)
    return () => clearTimeout(timer)
  }, [open])

  const { all, commands } = useMemo(() => {
    const has = (section: Section) => allowed.includes(section)
    const all: Entry[] = []
    const listed = (section: 'dashboards' | 'charts' | 'datasets') => {
      if (!has(section)) return
      for (const item of resources[section]) {
        const folders = folderPath(resources.folders, item.folderId).map((folder) => folder.name)
        all.push({ key: `${section}/${item.id}`, icon: sectionIcons[section], label: item.name, detail: [t(`workbench.sections.${section}`), ...folders].join(' / '), path: `/workbench/${section}/${item.id}` })
      }
    }
    listed('dashboards')
    listed('charts')
    listed('datasets')
    if (has('datasources')) {
      for (const source of resources.datasources) {
        all.push({ key: `datasources/${source.id}`, icon: 'database', label: source.name, detail: t('workbench.sections.datasources'), path: `/workbench/datasources/${source.id}` })
      }
    }
    const commands: Entry[] = []
    const command = (section: Section, key: string, path: string) => has(section) && commands.push({ key: `do/${key}`, icon: sectionIcons[section], label: t(`workbench.${key}`), detail: t('workbench.command'), path })
    command('lineage', 'sections.lineage', '/workbench/lineage')
    command('dashboards', 'new.dashboard', '/workbench/dashboards/new')
    command('charts', 'new.chart', '/workbench/charts/new')
    command('datasources', 'new.datasource', '/workbench/datasources/new')
    return { all, commands }
  }, [resources, allowed, t])

  const wanted = query.trim().toLowerCase()
  const entries = useMemo(() => {
    if (wanted) return [...all, ...commands].filter((entry) => entry.label.toLowerCase().includes(wanted)).slice(0, shown)
    const byKey = new Map(all.map((entry) => [entry.key, entry]))
    const lately = recent.map((item) => byKey.get(`${item.section}/${item.id}`)).filter((entry): entry is Entry => entry !== undefined)
    return [...lately, ...commands]
  }, [wanted, all, commands, recent])
  const at = Math.min(index, Math.max(entries.length - 1, 0))

  useEffect(() => {
    list.current?.children[at]?.scrollIntoView({ block: 'nearest' })
  }, [at])

  const choose = (entry: Entry | undefined) => {
    if (!entry) return
    onClose()
    void navigate(entry.path)
  }

  return (
    <Dialog open={open} title={t('workbench.search')} onClose={onClose} width={560}>
      <input
        ref={input}
        className="wb-palette-input"
        aria-label={t('workbench.search')}
        placeholder={t('workbench.searchPlaceholder')}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setIndex(0)
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') setIndex(Math.min(at + 1, entries.length - 1))
          else if (event.key === 'ArrowUp') setIndex(Math.max(at - 1, 0))
          else if (event.key === 'Enter') choose(entries[at])
          else return
          event.preventDefault()
        }}
      />
      {!wanted && entries.length > commands.length && <div className="wb-palette-heading">{t('workbench.recent')}</div>}
      {entries.length === 0 ? (
        <p className="empty">{t('workbench.noMatches')}</p>
      ) : (
        <ul ref={list} className="wb-palette-list" role="listbox" aria-label={t('workbench.search')}>
          {entries.map((entry, position) => (
            <li key={entry.key} role="option" aria-selected={position === at} className={position === at ? 'active' : undefined} onMouseEnter={() => setIndex(position)} onClick={() => choose(entry)}>
              <Icon name={entry.icon} />
              <span className="wb-row-name">{entry.label}</span>
              <span className="wb-row-detail">{entry.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  )
}
