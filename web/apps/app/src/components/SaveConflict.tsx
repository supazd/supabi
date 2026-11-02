import { Alert, Button, Dialog, Radio } from '@supabi/ui'
import type { TFunction } from 'i18next'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, unwrap, type ApiError, type Chart, type Dashboard, type Dataset } from '../api/client'
import { toApiError, useAsync } from '../api/useAsync'
import { mergeSuggestions, saveDifferences, saveMerge, type MergeChoices, type MergeEntry, type SaveChoice, type SaveContent, type SaveDifference, type SaveMerge } from '../lib/saveConflict'
import { datasetSaveMerge } from '../lib/datasetSaveConflict'
import { canonicalJSON } from '../lib/datasetHistory'
import { Async } from './Async'
import { ErrorAlert } from './ErrorAlert'
import { Icon } from './Icon'
import './saveConflict.css'

type Resources = { dataset: Dataset; chart: Chart; dashboard: Dashboard }
type Kind = keyof Resources

/** The base advances only after a successful save or an explicit resolution. */
export function useSaveConflict<K extends Kind>(kind: K, initial?: Resources[K] | (() => Resources[K] | undefined)) {
  // A function is called once, for a base that is costly to derive.
  const [base, setBase] = useState(() => {
    const value = typeof initial === 'function' ? initial() : initial
    return value && structuredClone(value)
  })
  const [needed, setNeeded] = useState(false)
  const [open, setOpen] = useState(false)
  const accept = useCallback((next: Resources[K]) => { setBase(structuredClone(next)); setNeeded(false); setOpen(false) }, [])
  return {
    kind, base, needed, open,
    show: () => setOpen(true),
    close: () => setOpen(false),
    capture: (error: ApiError) => {
      if (error.code !== 'resource_revision_conflict' || !base) return false
      setNeeded(true); setOpen(true)
      return true
    },
    accept,
  }
}

type ConflictState<K extends Kind> = ReturnType<typeof useSaveConflict<K>>
type Props<K extends Kind> = { state: ConflictState<K>; local: SaveContent; onApply: (content: SaveContent, latest: Resources[K]) => void | Promise<void>; prepareLatest?: (latest: Resources[K]) => Resources[K] | Promise<Resources[K]> }

function readLatest<K extends Kind>(kind: K, id: string): Promise<Resources[K]> {
  const options = { params: { path: { id } } }
  const request = kind === 'dataset' ? unwrap(api.GET('/datasets/{id}', options)) : kind === 'chart' ? unwrap(api.GET('/charts/{id}', options)) : unwrap(api.GET('/dashboards/{id}', options))
  return request as Promise<Resources[K]>
}

/** Show changed properties across all three versions, including removed values. */
function Value({ value, before, compare = false, depth = 0, difference, property = '' }: { value: unknown; before?: unknown; compare?: boolean; depth?: number; difference?: SaveDifference; property?: string }) {
  const { t } = useTranslation()
  const changed = compare && canonicalJSON(value) !== canonicalJSON(before)
  if (property === 'hidden' && (value === undefined || typeof value === 'boolean')) return <span className={changed ? 'changed-value' : undefined}>{t(`saveConflict.visibility.${value ? 'hidden' : 'shown'}`)}</span>
  if (value === undefined || value === null || value === '') return <span className={changed ? 'changed-value' : 'muted-inline'}>{t('saveConflict.empty')}</span>
  if (typeof value === 'boolean') return <span className={changed ? 'changed-value' : undefined}>{t(`dataset.history.${value ? 'yes' : 'no'}`)}</span>
  if (typeof value !== 'object') {
    const text = String(value)
    const label = property === 'type' ? t([`vizTypes.${text}`, `dataset.types.${text}`], { defaultValue: text })
      : property === 'mode' ? t(`explore.tableModes.${text === 'aggregate' ? 'table' : text}`, { defaultValue: text }) : text
    return <span className={`save-conflict-text${changed ? ' changed-value' : ''}`}>{label}</span>
  }
  const previous = before && typeof before === 'object' ? before as Record<string, unknown> : {}
  const current = value as Record<string, unknown>
  const keys = difference && difference !== true ? Object.keys(difference) : [...new Set([...Object.keys(current), ...(compare ? Object.keys(previous) : [])])]
  if (!keys.length) return <span className="muted-inline">{t('saveConflict.empty')}</span>
  return <dl className="save-conflict-properties">{keys.map((key) => {
    const item = current[key], old = previous[key]
    const changed = compare && canonicalJSON(item) !== canonicalJSON(old)
    const childDifference = difference && difference !== true ? difference[key] : undefined
    const named = (item ?? old) as { label?: string; name?: string } | null
    const label = Array.isArray(value) ? String(named?.label ?? named?.name ?? t('saveConflict.item', { n: Number(key) + 1 })) : t([`saveConflict.properties.${key}`, `dataset.history.properties.${key}`], { defaultValue: key })
    return <div key={key} className={changed ? 'changed' : undefined}><dt>{label}</dt><dd>{item && typeof item === 'object'
      ? <details open={depth < 1 || changed || Boolean(childDifference)}><summary>{t('saveConflict.details')}</summary><Value value={item} before={old} compare={compare} depth={depth + 1} difference={childDifference} property={key} /></details>
      : <Value value={item} before={old} compare={compare} depth={depth + 1} property={key} />}</dd></div>
  })}</dl>
}

function entryLabel(entry: MergeEntry, kind: Kind, t: TFunction) {
  if (entry.section === 'field') {
    const field = t('saveConflict.field', { name: entry.field })
    return entry.property ? `${field} · ${t(`dataset.history.properties.${entry.property}`)}` : field
  }
  if (entry.section === 'definition') return t(`saveConflict.definition.${kind}`)
  return entry.section === 'name' || entry.section === 'description' ? t(`common.${entry.section}`) : t(`saveConflict.${entry.section}`)
}

function EntryValue({ entry, side, difference, compare = true }: { entry: MergeEntry; side: 'base' | SaveChoice; difference?: SaveDifference; compare?: boolean }) {
  const { t } = useTranslation()
  return entry.section === 'field' && !entry.property && entry[side] === undefined
    ? <span className="muted-inline">{t('saveConflict.fieldAbsent')}</span>
    : <Value value={entry[side]} before={entry.base} compare={compare && side !== 'base'} difference={difference} property={entry.property} />
}

/** Keep the choice next to the content it selects, with the original as context. */
function EntryComparison({ entry, label, choice, onChoose, disabled, selectable }: {
  entry: MergeEntry; label: string; choice?: SaveChoice; onChoose: (choice: SaveChoice) => void; disabled: boolean; selectable: boolean
}) {
  const { t } = useTranslation()
  const difference = saveDifferences(entry.base, entry.local, entry.latest)
  return <>
    {entry.note && <p className="save-conflict-note">{t(`saveConflict.notes.${entry.note}`)}</p>}
    <div className="save-conflict-columns" role="group" aria-label={label}>
      {(['base', 'local', 'latest'] as const).map((side) => <div key={side} className={`save-conflict-version ${side}${side === choice ? ' selected' : ''}${selectable && side !== 'base' ? ' selectable' : ''}`}>
        <div className="save-conflict-version-heading">
          {side !== 'base' && selectable
            ? <Radio disabled={disabled} checked={choice === side} onChange={() => onChoose(side)} aria-label={t(side === 'local' ? 'saveConflict.useLocal' : 'saveConflict.useLatest')}>{t(`saveConflict.${side}`)}</Radio>
            : <span>{t(`saveConflict.${side}`)}</span>}
          {side === choice && <span className="save-conflict-selected"><Icon name="check" size={13} />{t('saveConflict.selected')}</span>}
        </div>
        <div className="save-conflict-value"><EntryValue entry={entry} side={side} difference={difference} /></div>
      </div>)}
    </div>
  </>
}

function Comparison({ kind, baseRevision, latest, plan, choices, onChoose, applying }: {
  kind: Kind; baseRevision: number; latest: Resources[Kind]; plan: SaveMerge; choices: MergeChoices; onChoose: (id: string, side: SaveChoice) => void; applying: boolean
}) {
  const { t } = useTranslation()
  const conflicts = plan.entries.filter((entry) => entry.change === 'conflict')
  const automatic = plan.entries.filter((entry) => entry.change !== 'same' && entry.change !== 'conflict')
  const remaining = conflicts.filter((entry) => !choices[entry.id]).length
  const [showAutomatic, setShowAutomatic] = useState(conflicts.length === 0)
  return <div className="save-conflict-comparison">
    <div className="save-conflict-overview">
      <div className="save-conflict-resource"><Icon name={kind} /><strong>{latest.name}</strong><span>{t('saveConflict.revisions', { base: baseRevision, latest: latest.revision })}</span></div>
      <div className="save-conflict-status" role="status">
        <span className={`save-conflict-badge ${remaining ? 'pending' : 'complete'}`}><Icon name={remaining ? 'swap' : 'check'} size={14} />{remaining ? t('saveConflict.pending', { count: remaining }) : t('saveConflict.ready')}</span>
        {automatic.length > 0 && <span className="save-conflict-count">{t('saveConflict.autoCount', { count: automatic.length })}</span>}
      </div>
    </div>
    <div className="save-conflict-guidance">
      <p>{t(conflicts.length ? 'saveConflict.chooseHint' : 'saveConflict.readyHint')}</p>
      <details className="save-conflict-rules"><summary>{t('saveConflict.rules')}<Icon name="chevronDown" size={12} /></summary><p>{t(`saveConflict.groupHint.${kind}`)}</p></details>
    </div>
    {conflicts.length > 0 && <div className="save-conflict-sections">{conflicts.map((entry) => {
      const label = entryLabel(entry, kind, t)
      return <section className="save-conflict-section" key={entry.id}>
        <header><h3>{label}</h3><span className={`save-conflict-entry-status${choices[entry.id] ? ' resolved' : ''}`}>{choices[entry.id] ? <><Icon name="check" size={13} />{t('saveConflict.resolved')}</> : t('saveConflict.needsChoice')}</span></header>
        <EntryComparison entry={entry} label={label} choice={choices[entry.id]} onChoose={(side) => onChoose(entry.id, side)} disabled={applying} selectable />
      </section>
    })}</div>}
    {automatic.length > 0 && <section className="save-conflict-automatic">
      <button type="button" className="save-conflict-auto-toggle" aria-expanded={showAutomatic} onClick={() => setShowAutomatic((value) => !value)}>
        <span className="save-conflict-auto-check"><Icon name="check" size={14} /></span>
        <strong>{t('saveConflict.autoCount', { count: automatic.length })}</strong>
        <span>{t('saveConflict.autoHint')}</span><Icon name="chevronDown" size={14} />
      </button>
      {showAutomatic && <div className="save-conflict-auto-list">{automatic.map((entry) => {
        const label = entryLabel(entry, kind, t), choice = choices[entry.id]!
        return <details className="save-conflict-auto-entry" key={entry.id}>
          <summary><span className="save-conflict-auto-label">{label}</span><span className="save-conflict-auto-value">{entry[choice] !== null && typeof entry[choice] === 'object' ? t('saveConflict.updated') : <EntryValue entry={entry} side={choice} compare={false} />}</span><span className="save-conflict-auto-source">{t(`saveConflict.kept.${entry.change === 'both' ? 'both' : choice}`)}</span><Icon name="chevronDown" size={12} /></summary>
          <EntryComparison entry={entry} label={label} choice={choice} onChoose={(side) => onChoose(entry.id, side)} disabled={applying} selectable={kind !== 'dataset'} />
        </details>
      })}</div>}
    </section>}
  </div>
}

function ConflictDialog<K extends Kind>(props: Props<K>) {
  const { t } = useTranslation()
  const [local, setLocal] = useState(() => structuredClone(props.local))
  const [applying, setApplying] = useState(false)
  const [selected, setSelected] = useState<MergeChoices>({})
  const [error, setError] = useState<ApiError>()
  const state = props.state, base = state.base!
  // SQL replies and field detection may still update the editor behind this
  // dialog. A choice is valid only for the draft the author actually reviewed.
  const stale = canonicalJSON(props.local) !== canonicalJSON(local)
  const comparison = useAsync(async () => {
    const value = await readLatest(props.state.kind, props.state.base!.id)
    const latest = props.prepareLatest ? await props.prepareLatest(value) : value
    return { local, latest, plan: (state.kind === 'dataset' ? datasetSaveMerge : saveMerge)(base, local, latest) }
  }, [props.state.kind, props.state.base!.id, local])
  // Invalidate the old result immediately, before the loading effect runs.
  const loaded = comparison.status === 'ok' && comparison.data.local === local ? comparison.data : undefined
  const choices = { ...(loaded && mergeSuggestions(loaded.plan.entries)), ...selected }
  const remaining = loaded?.plan.entries.filter((entry) => !choices[entry.id]).length ?? 0
  const refresh = () => {
    if (applying) return
    setLocal(structuredClone(props.local))
    setSelected({})
    setError(undefined)
  }
  const apply = async () => {
    if (!loaded || stale || remaining || applying) return
    setApplying(true); setError(undefined)
    try {
      await props.onApply(loaded.plan.resolve(choices), loaded.latest)
      state.accept(loaded.latest)
    } catch (error) { setError(toApiError(error)) } finally { setApplying(false) }
  }
  return <Dialog open title={<span className="save-conflict-title"><span><Icon name="swap" size={18} /></span>{t('saveConflict.title')}</span>} width={1040} onClose={() => { if (!applying) state.close() }} actions={loaded && <div className="save-conflict-footer">
    <p><Icon name="edit" size={14} />{t('saveConflict.draftHint')}</p>
    <div className="save-conflict-actions"><Button variant="ghost" disabled={applying} onClick={state.close}>{t('saveConflict.keepEditing')}</Button><Button variant="primary" disabled={stale || remaining > 0} loading={applying} onClick={() => void apply()}>{t('saveConflict.apply')}</Button></div>
  </div>}>
    {stale && !applying
      ? <div className="save-conflict-comparison"><Alert tone="warning" title={t('saveConflict.draftChanged')}><p>{t('saveConflict.draftChangedHint')}</p><Button size="sm" onClick={refresh}>{t('saveConflict.refresh')}</Button></Alert></div>
      : <Async state={comparison.status === 'ok' && !loaded ? { status: 'loading' } : comparison} reload={comparison.reload}>{({ latest, plan }) => <Comparison kind={state.kind} baseRevision={base.revision} latest={latest} plan={plan} choices={choices} onChoose={(id, side) => setSelected((value) => ({ ...value, [id]: side }))} applying={applying} />}</Async>}
    {error && <div className="save-conflict-error"><ErrorAlert error={error} /></div>}
  </Dialog>
}

export function SaveConflict<K extends Kind>(props: Props<K>) {
  const { t } = useTranslation()
  if (!props.state.needed || !props.state.base) return null
  return <div className="save-conflict">
    <Alert tone="warning" title={t('errors.resource_revision_conflict')}><Button size="sm" onClick={props.state.show}>{t('saveConflict.review')}</Button></Alert>
    {props.state.open && <ConflictDialog {...props} />}
  </div>
}
