import { formatCategory, type Cell } from '@supabi/charts'
import { Button, Dialog, Field, Input, Select } from '@supabi/ui'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ApiError, Chart } from '../api/client'
import { isTemporal } from '../api/spec'
import { useFirstWeekDays } from '../auth/session'
import type { FilterField } from '../lib/filters'
import type { ChartHolder } from '../lib/layout'
import { linkSources, widgetName, type DashboardLink } from '../lib/links'
import { ErrorAlert } from './ErrorAlert'
import { Icon } from './Icon'
import './dashboardLinksDialog.css'

type Source = ReturnType<typeof linkSources>[number]
const sameSource = (a: DashboardLink['source'], b: DashboardLink['source']) => a.item === b.item && a.column === b.column
const accepts = (source: Source | undefined, field: FilterField) => Boolean(source && field.item !== source.item && !field.aggregate && field.target.field &&
  (field.type === source.type || isTemporal(field.type) && isTemporal(source.type)) &&
  !(field.type === 'date' && source.type === 'timestamp' && (!source.grain || ['hour', 'minute'].includes(source.grain))))

export function DashboardLinksDialog({ links, items, charts, fields, error, loading, onRetry, onDone, onCancel }: {
  links: DashboardLink[]; items: ChartHolder[]; charts: Chart[]; fields: FilterField[]
  error?: ApiError; loading?: boolean; onRetry?: () => void
  onDone: (links: DashboardLink[]) => void; onCancel: () => void
}) {
  const { t } = useTranslation()
  const id = useId()
  const [draft, setDraft] = useState(links)
  const [selected, setSelected] = useState(links[0]?.id)
  const [removed, setRemoved] = useState<{ link: DashboardLink; index: number }>()
  const [notice, setNotice] = useState('')
  const sources = linkSources(items, charts, fields)
  const link = draft.find((entry) => entry.id === selected)
  const source = link && sources.find((entry) => sameSource(entry, link.source))
  const chartName = (itemId: string) => {
    const item = items.find((entry) => entry.id === itemId)
    return item ? widgetName(item, items, charts) : itemId
  }
  const fieldLabel = (entry: Source) => {
    const label = fields.find((field) => field.item === entry.item && field.target.field === entry.field)?.label ?? entry.field
    return label + (entry.column !== entry.field ? ` (${entry.column})` : '')
  }
  const issue = (entry: DashboardLink) => {
    if (!entry.label.trim()) return t('dashboard.linkEditor.missingName')
    const origin = sources.find((source) => sameSource(source, entry.source))
    if (!origin) return t('dashboard.linkEditor.missingSource')
    if (!entry.targets.length) return t('dashboard.linkEditor.missingTargets')
    if (new Set(entry.targets.map((target) => target.item)).size !== entry.targets.length) return t('dashboard.linkEditor.multipleFields')
    if (entry.targets.some((target) => !fields.some((field) => accepts(origin, field) && field.item === target.item && field.target.field === target.field))) return t('dashboard.linkEditor.missingField')
    return ''
  }
  const invalid = draft.filter((entry) => issue(entry)).length
  const editable = !loading && !error
  const change = (patch: Partial<DashboardLink>) => setDraft((current) => current.map((entry) => entry.id === selected ? { ...entry, ...patch } : entry))
  const select = (id: string) => { setSelected(id); setNotice('') }
  const add = () => {
    const origin = sources[0]
    if (!origin) return
    const entry: DashboardLink = { id: `link_${crypto.randomUUID().replaceAll('-', '')}`, label: origin.label, source: { item: origin.item, column: origin.column }, targets: [] }
    setDraft((current) => [...current, entry]); select(entry.id)
  }
  const changeSource = (next: Source) => {
    if (!link) return
    const targets = link.targets.filter((target) => fields.some((field) => accepts(next, field) && field.item === target.item && field.target.field === target.field))
    const count = link.targets.length - targets.length
    change({ source: { item: next.item, column: next.column }, targets, ...(!link.label || link.label === source?.label ? { label: next.label } : {}) })
    setNotice(count ? t('dashboard.linkEditor.removedMappings', { count }) : '')
  }
  const sourceItems = [...new Set(sources.map((source) => source.item))]
  const targetItems = items.filter((item) => item.chartId && item.id !== link?.source.item)
  const selectedItems = [...new Set(link?.targets.map((target) => target.item))]
  const choicesFor = (item: string) => fields.filter((field) => field.item === item && accepts(source, field))
  const availableTargets = targetItems.filter((item) => !selectedItems.includes(item.id))
  const canAddTarget = availableTargets.some((item) => choicesFor(item.id).length)
  const addTarget = (item: string) => {
    if (!link || selectedItems.includes(item)) return
    const sourceField = fields.find((field) => field.item === source?.item && field.target.field === source.field)
    const match = choicesFor(item).find((field) => field.datasetId === sourceField?.datasetId && field.target.field === source?.field)
    change({ targets: [...link.targets, match ? match.target : { item, field: '' }] })
  }
  const setTargetField = (item: string, field: string) => {
    if (!link) return
    const first = link.targets.findIndex((target) => target.item === item)
    // An older definition may contain several fields. Keep them until the user
    // explicitly chooses their replacement, rather than silently dropping one.
    change({ targets: link.targets.flatMap((target, index) => target.item !== item ? [target] : index === first ? [{ item, field }] : []) })
  }
  return <Dialog open title={t('dashboard.links')} width={1160} onClose={onCancel} actions={<>
    {invalid > 0 && !loading && !error && <span className="link-footer-hint">{t('dashboard.linkEditor.incompleteCount', { count: invalid })}</span>}
    <Button onClick={onCancel}>{t('common.cancel')}</Button><Button variant="primary" disabled={!editable || invalid > 0} onClick={() => onDone(draft.map((entry) => ({ ...entry, label: entry.label.trim() })))}>{t('common.confirm')}</Button>
  </>}>
    <div className="dashboard-links-dialog">
      <aside className="link-sidebar">
        <div className="link-sidebar-heading"><strong>{t('dashboard.linkEditor.rules')}</strong><span>{draft.length}</span></div>
        <Button icon={<Icon name="plus" />} disabled={!editable || !sources.length} onClick={add}>{t('dashboard.addLink')}</Button>
        <nav className="link-rule-list" aria-label={t('dashboard.linkEditor.rules')}>
          {draft.map((entry) => <button type="button" className={`link-rule${selected === entry.id ? ' active' : ''}`} aria-current={selected === entry.id ? 'true' : undefined} key={entry.id} onClick={() => select(entry.id)}>
            <span className="link-rule-title">{entry.label || t('dashboard.linkEditor.untitled')}</span>
          </button>)}
        </nav>
      </aside>
      <main className="link-editor" key={selected ?? 'empty'}>
        {loading && <p role="status">{t('common.loading')}</p>}
        {error && <div className="link-load-error"><ErrorAlert error={error} />{onRetry && <Button onClick={onRetry}>{t('common.retry')}</Button>}</div>}
        {removed && <div className="link-notice" role="status"><span>{t('dashboard.linkEditor.deleted', { name: removed.link.label })}</span><Button size="sm" variant="ghost" disabled={!editable} onClick={() => {
          setDraft((current) => { const next = [...current]; next.splice(removed.index, 0, removed.link); return next }); select(removed.link.id); setRemoved(undefined)
        }}>{t('dashboard.linkEditor.undo')}</Button></div>}
        {link ? <>
          <div className="link-editor-heading"><Field label={t('common.name')} htmlFor={`${id}-name`} required><Input id={`${id}-name`} disabled={!editable} value={link.label} onChange={(label) => change({ label })} /></Field>
            <Button size="sm" variant="ghost" danger disabled={!editable} icon={<Icon name="trash" />} onClick={() => {
              const index = draft.findIndex((entry) => entry.id === link.id)
              const next = draft.filter((entry) => entry.id !== link.id)
              setRemoved({ link, index }); setDraft(next); setSelected(next[Math.min(index, next.length - 1)]?.id); setNotice('')
            }}>{t('common.delete')}</Button>
          </div>
          <div className="link-editor-columns">
            <section className="link-section link-source-section">
              <h3>{t('dashboard.linkEditor.source')}</h3>
              <div className="link-source-fields">
                <Field label={t('dashboard.linkEditor.sourceChart')} htmlFor={`${id}-chart`}><Select block search searchBy="label" id={`${id}-chart`} aria-label={t('dashboard.linkEditor.sourceChart')} disabled={!editable} value={link.source.item} options={[...sourceItems.map((item) => ({ value: item, label: chartName(item) })), ...(!sourceItems.includes(link.source.item) ? [{ value: link.source.item, label: chartName(link.source.item), disabled: true }] : [])]} onChange={(item) => { const next = sources.find((source) => source.item === item); if (next) changeSource(next) }} /></Field>
                <Field label={t('dashboard.linkEditor.sourceField')} htmlFor={`${id}-field`}><Select block search searchBy="label" id={`${id}-field`} aria-label={t('dashboard.linkEditor.sourceField')} disabled={!editable} placeholder={t('dashboard.linkEditor.chooseSourceField')} value={link.source.column} options={sources.filter((source) => source.item === link.source.item).map((source) => ({ value: source.column, label: fieldLabel(source) }))} onChange={(column) => { const next = sources.find((source) => source.item === link.source.item && source.column === column); if (next) changeSource(next) }} /></Field>
              </div>
              {notice && <p className="link-notice" role="status">{notice}</p>}
            </section>
            <section className="link-section link-target-section">
              <div className="link-target-heading"><h3>{t('dashboard.linkEditor.targets')}</h3><span>{t('dashboard.linkEditor.selectedCount', { count: selectedItems.length })}</span></div>
              <div className="link-target-add">
                <Select block search searchBy="label" aria-label={t('dashboard.linkEditor.addTarget')} value={undefined} placeholder={t(canAddTarget ? 'dashboard.linkEditor.addTarget' : 'dashboard.linkEditor.noAvailableTargets')} disabled={!editable || !source || !canAddTarget} options={availableTargets.map((item) => ({ value: item.id, label: chartName(item.id) + (!choicesFor(item.id).length ? ` · ${t('dashboard.linkEditor.noCompatibleFields')}` : ''), icon: <Icon name="chart" />, disabled: !choicesFor(item.id).length }))} onChange={addTarget} />
              </div>
              {selectedItems.length > 0 ? <div className="link-target-table-wrap"><table className="link-target-table">
                <thead><tr><th>{t('dashboard.linkEditor.targetChart')}</th><th>{t('dashboard.linkEditor.filterField')}</th><th><span className="link-visually-hidden">{t('common.actions')}</span></th></tr></thead>
                <tbody>{selectedItems.map((item) => {
                  const mappings = link.targets.filter((target) => target.item === item)
                  const field = mappings.length === 1 ? mappings[0]?.field : undefined
                  const choices = choicesFor(item)
                  const invalidField = !field || !choices.some((choice) => choice.target.field === field)
                  return <tr key={item}>
                    <td><div className="link-target-name"><Icon name="chart" /><span>{chartName(item)}</span></div></td>
                    <td><div className="link-target-field" data-invalid={!loading && !error && invalidField || undefined}>
                      <Select block search searchBy="label" aria-label={t('dashboard.linkEditor.targetField', { name: chartName(item) })} disabled={!editable} value={field || undefined} placeholder={t('dashboard.linkEditor.chooseField')} options={[
                        ...choices.map((choice) => ({ value: choice.target.field!, label: choice.label })),
                        ...(field && !choices.some((choice) => choice.target.field === field) ? [{ value: field, label: field, disabled: true }] : []),
                      ]} onChange={(field) => setTargetField(item, field)} />
                      {mappings.length > 1 && <span className="link-target-field-hint">{t('dashboard.linkEditor.multipleFields')}</span>}
                    </div></td>
                    <td><Button size="sm" variant="ghost" icon={<Icon name="close" />} aria-label={t('dashboard.linkEditor.removeTarget', { name: chartName(item) })} disabled={!editable} onClick={() => change({ targets: link.targets.filter((target) => target.item !== item) })} /></td>
                  </tr>
                })}</tbody>
              </table></div> : <div className="link-target-empty"><Icon name="chart" size={28} /><p>{t(canAddTarget ? 'dashboard.linkEditor.emptyTargets' : 'dashboard.linkEditor.noAvailableTargets')}</p></div>}
              {!loading && !error && issue(link) && <p className="link-validation" role="status">{issue(link)}</p>}
            </section>
          </div>
        </> : <div className="link-empty"><Icon name="link" size={36} /><h3>{t('dashboard.linkEditor.emptyTitle')}</h3><p>{t('dashboard.linksHint')}</p><Button variant="primary" icon={<Icon name="plus" />} disabled={!editable || !sources.length} onClick={add}>{t('dashboard.addLink')}</Button>{!sources.length && !loading && !error && <p>{t('dashboard.linkEditor.noSources')}</p>}</div>}
      </main>
    </div>
  </Dialog>
}

/** How the value a link carries is written: as the chart it was clicked in writes it. */
export function useLinkValueText(state: import('../lib/links').DashboardLinksState): (id: string, value: Cell | undefined) => string {
  const { t } = useTranslation()
  const firstWeekDays = useFirstWeekDays()
  return (id, value) => value === null || value === undefined ? t('dashboard.linkNull') : value === '' ? t('dashboard.linkEmpty') : formatCategory(value, state.columnOf(id), firstWeekDays)
}

export function DashboardLinkChips({ state }: { state: import('../lib/links').DashboardLinksState }) {
  const { t } = useTranslation()
  const text = useLinkValueText(state)
  if (!Object.keys(state.values).length) return null
  return <div className="row" role="group" aria-label={t('dashboard.activeLinks')} style={{ flexWrap: 'wrap', padding: '8px 12px' }}>
    <span className="note">{t('dashboard.activeLinks')}</span>
    {state.links.filter((link) => link.id in state.values).map((link) => <Button key={link.id} size="sm" aria-label={t('dashboard.clearLink', { name: link.label })} onClick={() => state.clear(link.id)}>{link.label}: {text(link.id, state.values[link.id])} ×</Button>)}
  </div>
}
