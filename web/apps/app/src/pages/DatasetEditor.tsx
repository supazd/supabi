import { formatCell, formatNumber, isPlain } from '@supabi/charts'
import { Alert, Button, Checkbox, CodeEditor, DataTable, Dialog, Input, Select, TextArea, Tooltip, useToast } from '@supabi/ui'
import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { ApiError, api, unwrap, type Dataset, type Datasource, type LogicalType, type QueryResult, type Schemas } from '../api/client'
import {
  canBeMeasure,
  fieldFromColumn,
  fieldRoles,
  foldLabel,
  isColumn,
  isNumeric,
  isTemporal,
  labelProblems,
  logicalTypes,
  makeKey,
  referencedBy,
  toWrittenExpr,
  uniqueLabel,
  withRole,
  type DatasetSpec,
  type FieldRole,
  type SpecField,
} from '../api/spec'
import { toApiError, useAsync } from '../api/useAsync'
import { Async } from '../components/Async'
import { ErrorAlert } from '../components/ErrorAlert'
import { FieldLabel } from '../components/FieldLabel'
import { FormatDialog, dateSample, formatSamples } from '../components/FormatDialog'
import { Icon } from '../components/Icon'
import { TitleText } from '../components/TitleText'
import { TypeMark } from '../components/TypeMark'
import { useUnsavedActions } from '../components/UnsavedChanges'
import { fieldsUsed } from '../lib/builder'
import { draftsFor, toDraft, type SqlParam } from '../lib/params'
import { profileColumn } from '../lib/profile'
import { openSqlEditor, readSqlHandoff, type SqlHandoff } from '../lib/sqlHandoff'
import { useWorkbench } from '../workbench/context'
import { useStored } from '../lib/useStored'
import { Resizer, UnsavedGuard, afterSave } from '../workbench/slots'
import { Usages } from '../workbench/Usages'
import { DatasetPermissions } from './dataset/DatasetPermissions'
import { CalculatedFieldDialog, type Draft } from './dataset/CalculatedFieldDialog'
import { DatasetImpactDialog } from './dataset/DatasetImpactDialog'
import { DatasetHistory } from './dataset/DatasetHistory'
import { canonicalJSON, type Revision } from '../lib/datasetHistory'
import { SaveConflict, useSaveConflict } from '../components/SaveConflict'
import type { SaveContent } from '../lib/saveConflict'

const emptySpec: DatasetSpec = { specVersion: 1, source: { type: 'sql', sql: '' }, fields: [] }
type Pane = 'preview' | 'details' | 'usages' | 'permissions' | 'history'
// The revision is the one being edited; only updates send it.
type SaveProposal = { body: Schemas['DatasetInput']; revision?: number; snapshot: string }
type PendingImpact = { proposal: SaveProposal; impact: Schemas['DatasetImpact'] }

/** What decides the rows of a preview. Names are left out: renaming a field changes no data. */
const previewSignature = (datasourceId: string, source: DatasetSpec['source'], fields: SpecField[], params: unknown) =>
  canonicalJSON([datasourceId, source, params, fields.map((field) => [field.key, field.column, field.expr, field.syntax, field.type, field.role === 'metric'])])

/** What saving would store, as text: the editor has unsaved work when it differs from what was stored last. */
const snapshot = (name: string, description: string, datasourceId: string, spec: DatasetSpec) => canonicalJSON([name, description, datasourceId, spec])

/** What a field being moved among the details is carried as. */
const fieldDragType = 'application/x-supabi-field'

function Editor({ datasources, existing, handed }: { datasources: Datasource[]; existing?: Dataset; handed?: SqlHandoff }) {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const toast = useToast()
  const { reload, resources } = useWorkbench()
  const { isSessionChanging } = useUnsavedActions()
  const [activeHandoff, setActiveHandoff] = useState(handed)
  const [restored, setRestored] = useState<Revision>()
  const [restoreCandidate, setRestoreCandidate] = useState<Revision>()
  const [rebased, setRebased] = useState<SaveContent>()
  const conflict = useSaveConflict('dataset', existing)
  const sqlReturn = useRef<(() => void) | undefined>(undefined)
  useEffect(() => () => sqlReturn.current?.(), [])
  // Parts of the spec this form does not edit (synonyms, groups…) are kept
  // from here and sent back unchanged. Parameters are declared with the SQL, in data
  // exploration, and arrive with it.
  const storedSpec = (existing?.spec as DatasetSpec | undefined) ?? emptySpec
  const workingSpec = (rebased?.spec as DatasetSpec | undefined) ?? (restored?.spec as DatasetSpec | undefined) ?? storedSpec
  const base = useMemo<DatasetSpec>(() => {
    if (!activeHandoff?.params) return workingSpec
    const rest = Object.fromEntries(Object.entries(workingSpec).filter(([key]) => key !== 'params')) as DatasetSpec
    return activeHandoff.params.length ? { ...rest, params: activeHandoff.params } : rest
  }, [workingSpec, activeHandoff])

  const [search] = useSearchParams()
  const [name, setName] = useState(existing?.name ?? '')
  const [description, setDescription] = useState(existing?.description ?? '')
  // The SQL is written in data exploration and arrives from there; this
  // editor shows it and decides what its columns mean.
  const datasourceId = activeHandoff?.datasourceId ?? rebased?.datasourceId ?? restored?.datasourceId ?? existing?.datasourceId ?? ''
  const sql = activeHandoff?.sql ?? base.source.sql ?? ''
  // Fields are held as they are stored: expressions refer to other fields by internal ID.
  const [fields, setFields] = useState<SpecField[]>(base.fields)
  const latestFields = useRef(fields)
  latestFields.current = fields
  const detectionRequest = useRef(0)
  // The columns the source returned when it was last detected; unknown until then.
  const [detected, setDetected] = useState<string[] | null>(null)
  // Fields proposed by detection that the author has not touched yet.
  const [proposed, setProposed] = useState<Set<string>>(new Set())
  const [draft, setDraft] = useState<Draft | null>(null)
  /** The field whose display format is being set. */
  const [formatting, setFormatting] = useState<string | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [saved, setSaved] = useState<Dataset | null>(null)
  const [pendingImpact, setPendingImpact] = useState<PendingImpact | null>(null)

  const [sourceOpen, setSourceOpen] = useState(false)
  // A dataset that is already there opens locked, so looking at it changes
  // nothing by accident. One being made, or given new SQL, is being worked on.
  const [locked, setLocked] = useState(Boolean(existing) && !handed)
  const [pane, setPane] = useState<Pane>('preview')
  const [permissionsOpened, setPermissionsOpened] = useState(false)
  const [permissionsDirty, setPermissionsDirty] = useState(false)
  const [outlineWidth, setOutlineWidth] = useStored('supabi.dataset.outlineWidth', 240)
  const [filter, setFilter] = useState('')
  const [focused, setFocused] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ signature: string; result?: QueryResult; error?: ApiError } | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const previewRequest = useRef(0)
  // The fields ticked among the details, to be changed together.
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // A field being moved among the details, and where it would land.
  const [moving, setMoving] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<{ key: string; after: boolean } | null>(null)
  // Fields asked to be deleted that charts read: deleting them is asked about first.
  const [doomed, setDoomed] = useState<string[] | null>(null)

  const datasource = datasources.find((item) => item.id === datasourceId)
  const dialect = datasource?.type
  // What is stored, to tell whether there is anything to save.
  const [stored, setStored] = useState(() => snapshot(existing?.name ?? '', existing?.description ?? '', existing?.datasourceId ?? '', storedSpec))
  const source = activeHandoff ? { type: 'sql', sql } : base.source
  const dirty = snapshot(name, description, datasourceId, { ...base, source, fields }) !== stored
  const signature = previewSignature(datasourceId, source, fields, base.params)
  // The parameters the SQL names, as they were declared where it was written. They are read here, not changed.
  const params = useMemo(() => draftsFor(sql, ((base.params as SqlParam[] | undefined) ?? []).map(toDraft)), [sql, base])

  const missing = (field: SpecField) => detected !== null && field.column !== undefined && !detected.includes(field.column)
  const problems = labelProblems(fields)
  const missingCount = fields.filter(missing).length
  const blocked = missingCount > 0 || problems.size > 0
  // Saving what is already stored would only make a revision that says nothing new.
  const savable = dirty && Boolean(name.trim()) && fields.length > 0 && !blocked

  const fetchPreview = (withFields: SpecField[], limit?: number, refresh?: boolean) => {
    const spec = { ...base, source, fields: withFields }
    return unwrap(api.POST('/datasets/preview', { body: { datasourceId, spec: spec as unknown as Record<string, unknown>, limit, ...(refresh ? { refresh } : {}) } }))
  }

  /** refresh asks the database again rather than for rows kept from before. */
  const loadPreview = async (withFields: SpecField[] = fields, refresh = false) => {
    const at = previewSignature(datasourceId, source, withFields, base.params)
    const request = ++previewRequest.current
    setPreviewing(true)
    try {
      const result = await fetchPreview(withFields, undefined, refresh)
      if (request === previewRequest.current && !isSessionChanging()) setPreview({ signature: at, result })
    } catch (e) {
      if (request === previewRequest.current && !isSessionChanging()) setPreview({ signature: at, error: toApiError(e) })
    } finally {
      if (request === previewRequest.current) setPreviewing(false)
    }
  }

  // The preview loads once by itself; after that the author refreshes it.
  const previewWanted = preview === null && fields.length > 0 && !blocked
  useEffect(() => {
    if (previewWanted) void loadPreview()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new draft also restarts an unfinished preview of identical SQL
  }, [previewWanted, signature, restored, rebased, activeHandoff])
  // The rows shown are of a definition that has since been changed.
  const stale = preview !== null && preview.signature !== signature

  // What the rows of the preview say about each field: a few of its values, and how varied and how full it is.
  const profiles = useMemo(() => {
    const result = preview?.result
    return new Map((result?.columns ?? []).map((column, index) => [column.name, { column, profile: profileColumn(result!.rows, index) }]))
  }, [preview])

  // The charts made from this dataset and the fields each reads, so deleting a field can say what it would break.
  const charts = useMemo(() => (existing ? resources.charts.filter((chart) => chart.datasetId === existing.id) : []), [resources.charts, existing])
  const chartIds = charts.map((chart) => chart.id).join(',')
  const [chartFields, setChartFields] = useState<Map<string, Set<string>>>(new Map())
  useEffect(() => {
    let current = true
    void Promise.all(
      charts.map(async (chart) => {
        // A chart that cannot be read is taken to read nothing: the server still has the last word.
        const spec = await unwrap(api.GET('/charts/{id}', { params: { path: { id: chart.id } } })).then(
          (full) => full.spec,
          () => undefined,
        )
        return [chart.id, fieldsUsed(spec)] as const
      }),
    ).then((entries) => current && setChartFields(new Map(entries)))
    return () => {
      current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the charts are the same while their IDs are
  }, [chartIds])
  const chartsReading = (keys: string[]) => charts.filter((chart) => keys.some((key) => chartFields.get(chart.id)?.has(key)))

  // How much reads this dataset, for the tab that shows it.
  const usage = useAsync(() => (existing ? unwrap(api.GET('/usage', { params: { query: { kind: 'dataset', id: existing.id } } })) : Promise.resolve(undefined)), [existing?.id])
  const usageCount = usage.status === 'ok' && usage.data ? usage.data.charts.length + usage.data.dashboards.length : undefined

  const detect = async () => {
    const request = ++detectionRequest.current
    setDetecting(true)
    setError(null)
    try {
      const columns = await unwrap(
        api.POST('/datasources/{id}/describe', {
          params: { path: { id: datasourceId } },
          body: { source, params: base.params as Record<string, unknown>[] | undefined },
        }),
      )
      if (request !== detectionRequest.current || isSessionChanging()) return
      // Nothing is removed: a field whose column is gone is flagged, so the
      // author can point it at the column's new name and keep what refers to it.
      const known = new Set(latestFields.current.map((field) => field.column))
      const taken = new Set(latestFields.current.map((field) => field.key))
      const all = [...latestFields.current]
      const added: SpecField[] = []
      for (const column of columns) {
        if (known.has(column.name)) continue
        const field = fieldFromColumn(column, taken, all)
        all.push(field)
        added.push(field)
      }
      // Merge into the current draft: edits made while describe was running
      // must not be replaced by the fields captured at request start.
      setFields((current) => [...current, ...added.filter((field) => !current.some((item) => item.key === field.key || item.column === field.column))])
      setDetected(columns.map((column) => column.name))
      setProposed((current) => new Set([...current, ...added.map((field) => field.key)]))
      setPreview(null)
    } catch (e) {
      if (request === detectionRequest.current && !isSessionChanging()) setError(toApiError(e))
    } finally {
      if (request === detectionRequest.current) setDetecting(false)
    }
  }

  // SQL that just arrived has not been looked at yet: find its columns.
  const arrived = Boolean(activeHandoff) && (activeHandoff!.sql !== base.source.sql || activeHandoff!.datasourceId !== existing?.datasourceId || !existing)
  useEffect(() => {
    if (arrived && sql.trim() && datasourceId) void detect()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per SQL handoff; keep the current field edits
  }, [activeHandoff])

  const analyze = (proposal: SaveProposal) => unwrap(api.POST('/datasets/{id}/impact', { params: { path: { id: existing!.id } }, body: { ...proposal.body, expectedRevision: proposal.revision! } }))

  // The confirmation belongs to this exact proposal, even if an edit finishes
  // while the request is in flight. Later edits remain unsaved.
  const writeProposal = async (proposal: SaveProposal, impact?: Schemas['DatasetImpact'], confirmed = false) => {
    setSaving(true)
    setError(null)
    try {
      const result = existing
        ? await unwrap(api.PUT('/datasets/{id}', { params: { path: { id: existing.id } }, body: { ...proposal.body, expectedRevision: impact!.revision, ...(confirmed ? { impactToken: impact!.confirmationToken } : {}) } }))
        : await unwrap(api.POST('/datasets', { body: proposal.body }))
      const folder = search.get('folder')
      // A dataset made from a folder's menu belongs in that folder.
      if (!existing && folder) await unwrap(api.POST('/folders/move', { body: { kind: 'dataset', id: result.id, folderId: folder } })).catch(() => undefined)
      void reload()
      toast(`${t('dataset.saved')} · ${t('dataset.revision')} ${result.revision}`)
      if (existing) {
        setSaved(result)
        conflict.accept(result)
        setStored(proposal.snapshot)
      } else void navigate(`/workbench/datasets/${result.id}`, { replace: true, state: afterSave })
      setPendingImpact(null)
    } catch (e) {
      const failure = toApiError(e)
      if (conflict.capture(failure)) {
        // A newer dataset must be compared with the retained draft. An impact
        // refresh cannot grant permission to overwrite that newer definition.
        setPendingImpact(null)
      } else setError(failure)
      if (existing && failure.code === 'dataset_impact_required') {
        setPendingImpact(null)
        try {
          // Downstream charts may have changed. Review the new result, even if
          // it now has no affected resources; never reuse the old confirmation.
          setPendingImpact({ proposal, impact: await analyze(proposal) })
        } catch (e) {
          const failure = toApiError(e)
          if (!conflict.capture(failure)) setError(failure)
        }
      }
    } finally {
      setSaving(false)
    }
  }

  const save = async () => {
    // Enter in a field submits the form whether or not there is anything to save.
    if (!savable || saving || pendingImpact) return
    if (conflict.needed) { conflict.show(); return }
    setSaving(true)
    setError(null)
    const spec: DatasetSpec = { ...base, source, fields }
    const proposal: SaveProposal = {
      body: { name, description, datasourceId, spec: spec as unknown as Record<string, unknown> },
      revision: existing && (saved ?? existing).revision,
      snapshot: snapshot(name, description, datasourceId, spec),
    }
    try {
      if (existing) {
        const impact = await analyze(proposal)
        if (impact.charts.length || impact.dashboards.length) setPendingImpact({ proposal, impact })
        else await writeProposal(proposal, impact)
      } else await writeProposal(proposal)
    } catch (e) {
      const failure = toApiError(e)
      if (!conflict.capture(failure)) setError(failure)
    } finally {
      setSaving(false)
    }
  }

  const replaceDraft = (content: SaveContent) => {
    // Outstanding SQL handoffs and source requests belong to the previous draft.
    sqlReturn.current?.()
    sqlReturn.current = undefined
    detectionRequest.current++
    previewRequest.current++
    setActiveHandoff(undefined)
    setName(content.name)
    setDescription(content.description)
    setFields((content.spec as DatasetSpec).fields)
    setDetected(null)
    setProposed(new Set())
    setDetecting(false)
    setPreviewing(false)
    setPreview(null)
    setSelected(new Set())
    setFilter('')
    setFocused(null)
    setDraft(null)
    setFormatting(null)
    setDoomed(null)
    setError(null)
    setLocked(false)
    setRestoreCandidate(undefined)
    setPane('details')
  }

  const restore = (revision: Revision) => {
    if (saving || pendingImpact || isSessionChanging()) return
    setRebased(undefined)
    setRestored(revision)
    replaceDraft(revision)
  }

  const applyConflict = (content: SaveContent, latest: Dataset) => {
    setRebased(content)
    setRestored(undefined)
    replaceDraft(content)
    setPendingImpact(null)
    setSaved(latest)
    setStored(snapshot(latest.name, latest.description, latest.datasourceId, latest.spec as DatasetSpec))
  }

  const touch = (key: string) => setProposed((current) => new Set([...current].filter((item) => item !== key)))
  const replaceField = (key: string, change: (field: SpecField) => SpecField) => {
    touch(key)
    setFields((current) => current.map((field) => (field.key === key ? change(field) : field)))
  }
  const updateField = (key: string, patch: Partial<SpecField>) => replaceField(key, (field) => ({ ...field, ...patch }))

  // Pointing a field at another column. When the column was renamed in the
  // source, detection proposed a new field for the new name: that proposal
  // is dropped, since this field now stands for the column.
  const repoint = (key: string, column: string) => {
    touch(key)
    setFields((current) =>
      current
        .filter((field) => !(field.key !== key && field.column === column && proposed.has(field.key) && referencedBy(field.key, current).length === 0))
        .map((field) => (field.key === key ? { ...field, column } : field)),
    )
  }

  const duplicate = (field: SpecField) => {
    const taken = new Set(fields.map((item) => item.key))
    const copy = { ...field, key: makeKey(field.key, taken), label: uniqueLabel(`${field.label} ${t('dataset.copySuffix')}`, fields) }
    setFields((current) => current.flatMap((item) => (item.key === field.key ? [item, copy] : [item])))
  }

  // Fields other fields are computed from stay: only what nothing left behind refers to can go.
  const removable = (keys: string[]) => keys.filter((key) => referencedBy(key, fields).every((user) => keys.includes(user.key)))

  /** Deletes fields at once, and offers to take it back for a moment. */
  const remove = (keys: string[]) => {
    const gone = fields.map((field, index) => ({ field, index })).filter(({ field }) => keys.includes(field.key))
    if (gone.length === 0) return
    setFields((current) => current.filter((field) => !keys.includes(field.key)))
    setSelected((current) => new Set([...current].filter((key) => !keys.includes(key))))
    toast(gone.length === 1 ? t('dataset.fieldDeleted', { name: gone[0]!.field.label }) : t('dataset.fieldsDeleted', { count: gone.length }), {
      tone: 'info',
      action: {
        label: t('common.undo'),
        // Each goes back where it was, among whatever has been changed since.
        onSelect: () =>
          setFields((current) => {
            const next = [...current]
            for (const { field, index } of gone) if (!next.some((item) => item.key === field.key)) next.splice(Math.min(index, next.length), 0, field)
            return next
          }),
      },
    })
  }

  /** Deletes fields, asking first when charts read them. */
  const askRemove = (asked: string[]) => {
    const keys = removable(asked)
    if (chartsReading(keys).length > 0) setDoomed(keys)
    else remove(keys)
  }

  /** Puts a field right before or after another of its kind. */
  const move = (key: string, to: string, after: boolean) =>
    setFields((current) => {
      const field = current.find((item) => item.key === key)
      const rest = current.filter((item) => item.key !== key)
      const at = rest.findIndex((item) => item.key === to)
      if (!field || at < 0) return current
      rest.splice(after ? at + 1 : at, 0, field)
      return rest
    })

  const select = (keys: string[], on: boolean) =>
    setSelected((current) => {
      const next = new Set(current)
      for (const key of keys) {
        if (on) next.add(key)
        else next.delete(key)
      }
      return next
    })
  const picked = fields.filter((field) => selected.has(field.key))
  const giveRole = (role: 'dimension' | 'measure') => {
    for (const field of picked) touch(field.key)
    // A metric aggregates in its own expression, so it is neither.
    setFields((current) => current.map((field) => (selected.has(field.key) && field.role !== 'metric' ? withRole(field, role) : field)))
  }

  const editCalculated = (field?: SpecField, role: FieldRole = 'dimension') =>
    setDraft(
      field
        ? {
            key: field.key,
            label: field.label,
            role: field.role,
            type: field.type,
            expr: toWrittenExpr(field.expr ?? '', fields),
            syntax: field.syntax === 'standard' ? 'standard' : 'native',
            description: field.description ?? '',
          }
        : // A new field is written with the platform's functions, which any data source can run.
          { label: '', role, type: role === 'dimension' ? 'string' : 'decimal', expr: '', syntax: 'standard', description: '' },
    )

  const finishDraft = (field: SpecField) => {
    setFields((current) => (current.some((item) => item.key === field.key) ? current.map((item) => (item.key === field.key ? field : item)) : [...current, field]))
    setDraft(null)
    setFocused(field.key)
    setPane('details')
  }

  // Choosing a field in the outline shows it where the author is looking:
  // its row among the details, or its column in the preview.
  const rows = useRef(new Map<string, HTMLTableRowElement>())
  const previewBody = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!focused) return
    if (pane === 'details') rows.current.get(focused)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    if (pane === 'preview') previewBody.current?.querySelector('th.col-focused')?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' })
  }, [focused, pane])
  const choose = (field: SpecField) => {
    setFocused(field.key)
    // A metric has no value on a row, so the preview has no column for it.
    if (pane === 'usages' || pane === 'permissions' || (pane === 'preview' && (field.role === 'metric' || blocked))) setPane('details')
  }

  const filtering = Boolean(filter.trim())
  const matches = (field: SpecField) => !filtering || foldLabel(field.label).includes(foldLabel(filter)) || (field.column ?? field.expr ?? '').toLowerCase().includes(filter.trim().toLowerCase())
  const byRole = (role: FieldRole) => fields.filter((field) => field.role === role)
  const matched = fields.filter(matches)
  /** How many fields of a kind there are, and how many of them the search leaves. */
  const countOf = (role: FieldRole) => (filtering ? `${byRole(role).filter(matches).length} / ${byRole(role).length}` : String(byRole(role).length))

  const outline = (role: FieldRole) => {
    const all = byRole(role)
    return (
      <div className="outline-group">
        <div className={`outline-title ${role}`}>
          {t(`dataset.${role}s`)} <span className="muted-inline">· {countOf(role)}</span>
        </div>
        <ul>
          {all.filter(matches).map((field) => (
            <li key={field.key}>
              <button type="button" className={focused === field.key ? 'active' : undefined} aria-current={focused === field.key || undefined} onClick={() => choose(field)}>
                <TypeMark type={field.type} />
                <span className="outline-name">{field.label || '—'}</span>
                {field.hidden && <span className="chip-tag">{t('dataset.hidden')}</span>}
                {missing(field) && <Tooltip title={t('dataset.missingColumn')}><span className="outline-flag" /></Tooltip>}
              </button>
            </li>
          ))}
        </ul>
        {/* A kind with nothing in it says how it comes to have something. */}
        {role === 'metric' && all.length === 0 && !filtering && (
          <div className="outline-none">
            <span className="note small">{t('dataset.noMetrics')}</span>
            {!locked && (
              <Button size="sm" variant="ghost" icon={<Icon name="plus" size={14} />} onClick={() => editCalculated(undefined, 'metric')}>
                {t('dataset.addMetric')}
              </Button>
            )}
          </div>
        )}
      </div>
    )
  }

  /** Where a field's values come from: a column of the source, or an expression. */
  const sourceCell = (row: SpecField) => {
    if (!isColumn(row)) {
      const written = toWrittenExpr(row.expr ?? '', fields)
      return (
        <span className="row nowrap">
          <span className="chip">{t('dataset.calculated')}</span>
          <Tooltip title={written}>
            <code className="field-expr">{written}</code>
          </Tooltip>
          {!locked && (
            <Tooltip title={t('dataset.editCalculated')}>
              <span>
                <Button size="sm" variant="ghost" icon={<Icon name="edit" />} aria-label={`${t('dataset.editCalculated')} ${row.label}`} onClick={() => editCalculated(row)} />
              </span>
            </Tooltip>
          )}
        </span>
      )
    }
    if (!missing(row)) return <code>{row.column}</code>
    return (
      <span className="row nowrap">
        <span className="chip warning">
          <code>{row.column}</code> {t('dataset.missingColumn')}
        </span>
        {!locked && <Select size="sm" aria-label={`${t('dataset.repoint')} ${row.label}`} placeholder={t('dataset.repoint')} value={undefined} options={(detected ?? []).map((column) => ({ value: column, label: column }))} onChange={(column) => repoint(row.key, column)} />}
      </span>
    )
  }

  /** A few of the values the preview has for a field. */
  const valuesCell = (row: SpecField) => {
    const known = profiles.get(row.key)
    if (!known || known.profile.total === 0) return <span className="muted-inline">—</span>
    const { column, profile } = known
    const nulls = `${Math.round((profile.nulls / profile.total) * 100)}%`
    return (
      <Tooltip title={t('dataset.profile', { total: profile.total, distinct: profile.distinct, nulls })}>
        <span className="field-values">
          <span className="chip-tag">{t('dataset.distinct', { count: profile.distinct })}</span>
          <span className="field-samples">{profile.samples.map((value) => formatCell(value as never, column, i18n.language)).join(' · ') || '—'}</span>
        </span>
      </Tooltip>
    )
  }

  const startMove = (event: DragEvent<HTMLElement>, key: string) => {
    event.dataTransfer.setData(fieldDragType, key)
    event.dataTransfer.effectAllowed = 'move'
    const row = rows.current.get(key)
    if (row) event.dataTransfer.setDragImage(row, 12, 16)
    setMoving(key)
  }
  const endMove = () => {
    setMoving(null)
    setDropAt(null)
  }
  /** Whether what is being moved may land beside this field: fields keep to their own kind. */
  const lands = (row: SpecField) => moving !== null && moving !== row.key && fields.find((field) => field.key === moving)?.role === row.role

  // A format is shown by what it makes of a number or a date, which says more than its settings.
  // A date without one is written the default way, which is shown dimmed.
  const formatSummary = (field: SpecField) =>
    isTemporal(field.type) ? (
      <span className={field.format ? 'tabular nowrap' : 'tabular nowrap muted-inline'}>{dateSample(field.format, field.type)}</span>
    ) : !isPlain(field.format) ? (
      <span className="tabular">{formatNumber(formatSamples(field.format, field.type)[0]!, field.format, i18n.language)}</span>
    ) : (
      <span className="muted-inline">{t('format.styles.none')}</span>
    )
  const formattingField = fields.find((field) => field.key === formatting)

  const detailRow = (row: SpecField) => {
    const users = referencedBy(row.key, fields)
    const readers = chartsReading([row.key])
    const classes = [focused === row.key && 'focused', moving === row.key && 'moving', dropAt?.key === row.key && (dropAt.after ? 'drop-after' : 'drop-before')].filter(Boolean).join(' ')
    const common = {
      className: classes || undefined,
      ref: (element: HTMLTableRowElement | null) => {
        if (element) rows.current.set(row.key, element)
        else rows.current.delete(row.key)
      },
    }
    // Locked, the fields are read rather than filled in: text, with nothing that looks like it could be typed into.
    if (locked) {
      return (
        <tr key={row.key} {...common}>
          <td className="field-name">{row.label}</td>
          <td>{t(row.hidden ? 'dataset.hidden' : 'dataset.visible')}</td>
          <td>{sourceCell(row)}</td>
          <td>
            <span className="row nowrap">
              <TypeMark type={row.type} named />
              {t(`dataset.types.${row.type}`)}
            </span>
          </td>
          <td>{(isNumeric(row.type) || isTemporal(row.type)) && formatSummary(row)}</td>
          <td><span className="field-description">{row.description || <span className="muted-inline">—</span>}</span></td>
          <td>{valuesCell(row)}</td>
        </tr>
      )
    }
    return (
      <tr
        key={row.key}
        {...common}
        onDragOver={(event) => {
          if (!lands(row)) return
          event.preventDefault()
          const box = event.currentTarget.getBoundingClientRect()
          const after = event.clientY > box.top + box.height / 2
          if (dropAt?.key !== row.key || dropAt.after !== after) setDropAt({ key: row.key, after })
        }}
        onDrop={(event) => {
          if (!lands(row) || !moving) return
          event.preventDefault()
          move(moving, row.key, dropAt?.key === row.key ? dropAt.after : false)
          endMove()
        }}
      >
        <td className="field-pick">
          <span className="row nowrap">
            <Tooltip title={t('dataset.moveField')}>
              <span className="drag-handle" draggable onDragStart={(event) => startMove(event, row.key)} onDragEnd={endMove}>
                <Icon name="grip" />
              </span>
            </Tooltip>
            <Checkbox aria-label={`${t('dataset.selectField')} ${row.label}`} checked={selected.has(row.key)} onChange={(on) => select([row.key], on)} />
          </span>
        </td>
        <td>
          <Input size="sm" aria-label={`${t('dataset.label')} ${row.label}`} invalid={problems.has(row.key)} value={row.label} onChange={(label) => updateField(row.key, { label })} />
        </td>
        <td>
          <Checkbox aria-label={t('dataset.hideField', { name: row.label })} checked={Boolean(row.hidden)} onChange={(hidden) => updateField(row.key, { hidden: hidden || undefined })} />
        </td>
        <td>{sourceCell(row)}</td>
        <td>
          <Select<LogicalType>
            size="sm"
            block
            aria-label={`${t('dataset.type')} ${row.label}`}
            value={row.type}
            options={logicalTypes.map((value) => ({ value, label: t(`dataset.types.${value}`), icon: <TypeMark type={value} named /> }))}
            // A measure that is no longer a number becomes a dimension.
            onChange={(type) => replaceField(row.key, (field) => withRole({ ...field, type }, field.role))}
          />
        </td>
        <td>
          {(isNumeric(row.type) || isTemporal(row.type)) && (
            <Tooltip title={t('format.titleOf', { name: row.label })}>
              <span>
                <Button size="sm" variant="ghost" aria-label={t('format.titleOf', { name: row.label })} onClick={() => setFormatting(row.key)}>
                  {formatSummary(row)}
                </Button>
              </span>
            </Tooltip>
          )}
        </td>
        <td>
          <TextArea
            rows={1}
            aria-label={`${t('dataset.fieldDescription')} ${row.label}`}
            placeholder={t('common.addDescription')}
            value={row.description ?? ''}
            onChange={(description) => updateField(row.key, { description: description || undefined })}
          />
        </td>
        <td>{valuesCell(row)}</td>
        <td className="field-actions">
          <span className="row nowrap actions">
            {/* The slot stays when there is nothing to convert, so the other actions line up down the column. */}
            <span className="action-slot">
              {/* Only a number can be a measure. */}
              {(row.role === 'measure' || (row.role === 'dimension' && canBeMeasure(row))) && (
                <Button size="sm" variant="ghost" onClick={() => replaceField(row.key, (field) => withRole(field, row.role === 'measure' ? 'dimension' : 'measure'))}>
                  {row.role === 'measure' ? t('dataset.toDimension') : t('dataset.toMeasure')}
                </Button>
              )}
            </span>
            <Tooltip title={t('dataset.duplicate')}>
              <span>
                <Button size="sm" variant="ghost" icon={<Icon name="copy" />} aria-label={`${t('dataset.duplicate')} ${row.label}`} onClick={() => duplicate(row)} />
              </span>
            </Tooltip>
            <Tooltip
              title={
                users.length > 0
                  ? t('dataset.referencedBy', { names: users.map((field) => field.label).join('、') })
                  : readers.length > 0
                    ? t('dataset.deleteRead', { count: readers.length })
                    : t('common.delete')
              }
            >
              <span>
                <Button size="sm" variant="ghost" danger icon={<Icon name="trash" />} aria-label={`${t('common.delete')} ${row.label}`} disabled={users.length > 0} onClick={() => askRemove([row.key])} />
              </span>
            </Tooltip>
          </span>
        </td>
      </tr>
    )
  }

  const shownKeys = matched.map((field) => field.key)
  const allPicked = shownKeys.length > 0 && shownKeys.every((key) => selected.has(key))
  const span = locked ? 7 : 9
  const details =
    matched.length === 0 ? (
      <p className="empty">{t('dataset.noMatchFor', { text: filter.trim() })}</p>
    ) : (
      <div className={locked ? 'field-details locked' : 'field-details'}>
        <table aria-label={t('dataset.details')}>
          <thead>
            <tr>
              {!locked && (
                <th className="field-pick">
                  <Checkbox aria-label={t('dataset.selectAll')} checked={allPicked} onChange={(on) => select(shownKeys, on)} />
                </th>
              )}
              <th className="col-name">{t('dataset.label')}</th>
              <th><FieldLabel label={t('dataset.hidden')} hint={t('dataset.hiddenHint')} /></th>
              <th>{t('dataset.column')}</th>
              <th className="col-type">{t('dataset.type')}</th>
              <th className="col-format">{t('format.title')}</th>
              <th className="col-description">{t('dataset.fieldDescription')}</th>
              <th>
                <Tooltip title={t('dataset.valuesHint')}>
                  <span>{t('dataset.values')}</span>
                </Tooltip>
              </th>
              {!locked && <th className="field-actions">{t('common.actions')}</th>}
            </tr>
          </thead>
          {fieldRoles
            .filter((role) => byRole(role).some(matches) || (!filtering && role !== 'metric'))
            .map((role) => (
              <tbody key={role}>
                <tr className={`group ${role}`}>
                  <td colSpan={span}>
                    {t(`dataset.${role}s`)} · {countOf(role)}
                  </td>
                </tr>
                {byRole(role).filter(matches).map(detailRow)}
              </tbody>
            ))}
        </table>
      </div>
    )

  const labels = new Map(fields.map((field) => [field.key, field]))
  // The preview is written the way the fields now say, saved or not.
  const previewColumn = (column: QueryResult['columns'][number]) => {
    const field = labels.get(column.name)
    return field ? { ...column, format: field.format } : column
  }
  const previewPane: ReactNode = blocked ? (
    <p className="empty">{t('dataset.previewBlocked')}</p>
  ) : (
    <div className={stale ? 'stack preview-body stale' : 'stack preview-body'} ref={previewBody}>
      {preview?.error && <ErrorAlert error={preview.error} />}
      {/* Until the first rows arrive, their place is held by the shape of a table. */}
      {!preview && (
        <div className="preview-skeleton" role="status" aria-label={t('common.loading')}>
          {Array.from({ length: 12 }, (_, index) => (
            <div key={index} />
          ))}
        </div>
      )}
      {preview?.result && (
        <DataTable
          aria-label={t('dataset.preview')}
          loading={previewing}
          rows={preview.result.rows.map((cells) => ({ cells }))}
          rowKey={(_, index) => String(index)}
          pageSize={20}
          pageKey={preview.result}
          columns={preview.result.columns.map((column, index) => ({
            key: column.name,
            // A heading is tinted by what its field is used as, so a number that is a dimension is not taken for a measure.
            className: [`col-${labels.get(column.name)?.role ?? column.role}`, focused === column.name && 'col-focused'].filter(Boolean).join(' '),
            title: (
              <span className="row nowrap">
                <TypeMark type={column.type} />
                {labels.get(column.name)?.label ?? column.label ?? column.name}
              </span>
            ),
            align: isNumeric(column.type) ? ('right' as const) : ('left' as const),
            render: (row: { cells: unknown[] }) => <span className="tabular">{formatCell(row.cells[index] as never, previewColumn(column), i18n.language)}</span>,
          }))}
        />
      )}
    </div>
  )

  const current = saved ?? existing
  // SQL has its own tab; returning it updates only the source, keeping field,
  // name and permission drafts mounted in this editor.
  const editSql = () => {
    if (isSessionChanging()) return
    try {
      sqlReturn.current?.()
      sqlReturn.current = openSqlEditor({ sql, datasourceId, params: (base.params ?? []) as SqlHandoff['params'] }, {
        datasetName: name || t('workbench.unnamed'),
        onApply: (next) => {
          if (isSessionChanging()) return false
          detectionRequest.current++
          previewRequest.current++
          setDetecting(false)
          setPreviewing(false)
          setActiveHandoff(next)
          setPendingImpact(null)
          setLocked(false)
          setDetected(null)
          setPreview(null)
          setSourceOpen(false)
        },
      })
    } catch (e) {
      setSourceOpen(false)
      setError(toApiError(e))
    }
  }
  const panes: { key: Pane; label: string }[] = [
    { key: 'preview', label: t('dataset.preview') },
    { key: 'details', label: t('dataset.details') },
    ...(existing ? [{ key: 'usages' as const, label: usageCount ? `${t('workbench.usages')} · ${usageCount}` : t('workbench.usages') }, { key: 'history' as const, label: t('dataset.history.title') }, { key: 'permissions' as const, label: t('policy.tab') }] : []),
  ]
  const noFields = <p className="empty">{detecting ? t('dataset.detecting') : t('dataset.noFields')}</p>

  // The data source is named, and opened from here by those who may.
  const datasourceName = datasource ? datasource.name : '—'
  const datasourcePath = !datasource ? null : `/workbench/datasources/${datasource.id}`
  const datasourceMark = (
    <>
      <Icon name="database" />
      {datasourceName}
    </>
  )

  // What stands in the way of saving, said once and together.
  const notes = [missingCount > 0 && t('dataset.missingNote', { count: missingCount }), problems.size > 0 && t('dataset.labelNote')].filter((note): note is string => Boolean(note))
  const doomedReaders = doomed ? chartsReading(doomed) : []

  return (
    <form
      className="dataset-editor"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <UnsavedGuard dirty={dirty || permissionsDirty} />
      <header className="editor-header">
        <div className="editor-title">
          <TitleText className="name" label={t('common.name')} placeholder={t('dataset.namePlaceholder')} locked={locked} value={name} onChange={setName} />
          {/* Locked, a dataset with no description has nothing to say here. */}
          {(!locked || description) && <TitleText className="description" label={t('common.description')} placeholder={t('common.addDescription')} locked={locked} value={description} onChange={setDescription} />}
        </div>
        {current && (
          <Link to={`/workbench/charts/new?dataset=${current.id}`} target="_blank" rel="noopener noreferrer">
            <Button icon={<Icon name="chart" />}>{t('workbench.new.chart')}</Button>
          </Link>
        )}
        {existing &&
          (locked ? (
            <Tooltip title={t('dataset.unlock')}>
              <span>
                <Button icon={<Icon name="edit" />} onClick={() => setLocked(false)}>
                  {t('common.edit')}
                </Button>
              </span>
            </Tooltip>
          ) : (
            <Tooltip title={t('dataset.lock')}>
              <span>
                <Button
                  icon={<Icon name="lock" />}
                  onClick={() => {
                    setLocked(true)
                    setSelected(new Set())
                  }}
                >
                  {t('dataset.lockShort')}
                </Button>
              </span>
            </Tooltip>
          ))}
        {/* Locked, there is nothing to save, unless something was changed before locking. */}
        {(!locked || dirty) && (
          <Button variant="primary" type="submit" loading={saving} disabled={!savable}>
            {saving ? t('common.saving') : t('common.save')}
          </Button>
        )}
      </header>

      <div className="editor-toolbar">
        <Button icon={<Icon name="sql" />} onClick={() => setSourceOpen(true)}>
          {t('dataset.showSource')}
        </Button>
        {!locked && (
          <>
            <Button icon={<Icon name="plus" />} onClick={() => editCalculated()} disabled={fields.length === 0}>
              {t('dataset.addCalculated')}
            </Button>
            <Tooltip title={t('dataset.detectHint')}>
              <span>
                <Button icon={<Icon name="refresh" />} onClick={() => void detect()} loading={detecting} disabled={!sql.trim() || !datasourceId}>
                  {detecting ? t('dataset.detecting') : t('dataset.detect')}
                </Button>
              </span>
            </Tooltip>
          </>
        )}
        <span className="spacer" />
        <Tooltip title={t('dataset.datasource')}>
          {datasourcePath ? (
            <Link className="row nowrap small editor-source" to={datasourcePath} target="_blank" rel="noopener noreferrer">
              {datasourceMark}
            </Link>
          ) : (
            <span className="row nowrap muted-inline small">{datasourceMark}</span>
          )}
        </Tooltip>
        {current && (
          <>
            <span className="muted-inline small nowrap">
              {t('dataset.revision')} {current.revision}
            </span>
            <Tooltip title={current.validationStatus === 'unvalidated' ? t('dataset.unvalidatedNote') : undefined}>
              <span className={`status-mark ${current.validationStatus}`}>{t(`dataset.statuses.${current.validationStatus}`)}</span>
            </Tooltip>
          </>
        )}
      </div>

      {notes.length > 0 && (
        <Alert tone="warning" title={notes[0]}>
          {notes[1]}
        </Alert>
      )}
      {error && !pendingImpact && <ErrorAlert error={error} />}
      <SaveConflict state={conflict} local={{ name, description, datasourceId, spec: { ...base, source, fields } as unknown as Record<string, unknown> }} onApply={applyConflict} />
      {restored && dirty && <Alert tone="info" title={t('dataset.history.restored', { revision: restored.revision })} />}

      <div className="editor-body">
        <aside className="field-outline" style={{ width: outlineWidth }}>
          <h2>{t('dataset.outline')}</h2>
          <Input size="sm" clearable aria-label={t('dataset.searchFields')} placeholder={t('dataset.searchFields')} value={filter} onChange={setFilter} />
          {/* The title and the search stay; the fields scroll under them. */}
          <div className="outline-list">
            {fields.length === 0 ? (
              <p className="empty">{t('dataset.noFields')}</p>
            ) : matched.length === 0 ? (
              <div className="outline-none">
                <span className="note small">{t('dataset.noMatchFor', { text: filter.trim() })}</span>
                <Button size="sm" variant="ghost" onClick={() => setFilter('')}>
                  {t('dataset.clearSearch')}
                </Button>
              </div>
            ) : (
              <>
                {outline('dimension')}
                {outline('measure')}
                {outline('metric')}
              </>
            )}
          </div>
          <section className="outline-params" aria-label={t('params.title')}>
            <h2>
              {t('params.title')} <span className="muted-inline">· {params.length}</span>
            </h2>
            {params.length === 0 ? (
              <span className="note small">{t('dataset.noParams')}</span>
            ) : (
              <ul>
                {params.map((param) => (
                  <Tooltip key={param.name} placement="right" title={`${String(param.rest.label || param.name)} · {{${param.name}}} · ${t(`dataset.types.${param.type}`)} · ${param.text ? `${t('dataset.paramDefault')} ${param.text}` : t('params.noDefault')}`}>
                    <li tabIndex={0}>
                      <div className="outline-param-heading">
                        <TypeMark type={param.type} named />
                        <span className="outline-param-name">{String(param.rest.label || param.name)}</span>
                        {Boolean(param.rest.multi) && <span className="chip-tag">{t('params.multi')}</span>}
                        {Boolean(param.rest.required) && <span className="chip-tag">{t('params.required')}</span>}
                      </div>
                      <div className="outline-param-values">
                        {Boolean(param.rest.label) && <code>{param.name}</code>}
                        <span className={param.text ? 'outline-param-default' : 'outline-param-default none'}>{param.text ? `${t('dataset.paramDefault')} ${param.text}` : t('params.noDefault')}</span>
                      </div>
                    </li>
                  </Tooltip>
                ))}
              </ul>
            )}
          </section>
        </aside>
        <Resizer direction="horizontal" grows="forward" size={outlineWidth} min={160} max={520} onResize={setOutlineWidth} label={t('dataset.resizeOutline')} />
        <section className="editor-main">
          <div className="wb-bottom-bar editor-tabs" role="tablist">
            {panes.map((item) => (
              <button key={item.key} type="button" role="tab" aria-selected={item.key === pane} className={item.key === pane ? 'active' : undefined} onClick={() => { setPane(item.key); if (item.key === 'permissions') setPermissionsOpened(true) }}>
                {item.label}
              </button>
            ))}
            <span className="spacer" />
            {pane === 'preview' && (
              <>
                {stale ? (
                  <span className="preview-stale small">{t('dataset.previewStale')}</span>
                ) : (
                  <span className="muted-inline small">{preview?.result ? t('dataset.previewRows', { count: preview.result.rows.length }) : ''}</span>
                )}
                <Button size="sm" variant={stale ? 'primary' : 'secondary'} icon={<Icon name="refresh" size={14} />} onClick={() => void loadPreview(fields, true)} loading={previewing} disabled={fields.length === 0 || blocked}>
                  {t('dataset.previewRefresh')}
                </Button>
              </>
            )}
            {pane === 'details' && !locked && picked.length > 0 && (
              <span className="row nowrap field-bulk">
                <span className="muted-inline small">{t('dataset.selectedCount', { count: picked.length })}</span>
                <Button size="sm" disabled={!picked.some((field) => field.role === 'dimension' && canBeMeasure(field))} onClick={() => giveRole('measure')}>
                  {t('dataset.toMeasure')}
                </Button>
                <Button size="sm" disabled={!picked.some((field) => field.role === 'measure')} onClick={() => giveRole('dimension')}>
                  {t('dataset.toDimension')}
                </Button>
                <Button size="sm" danger disabled={removable(picked.map((field) => field.key)).length === 0} onClick={() => askRemove(picked.map((field) => field.key))}>
                  {t('common.delete')}
                </Button>
                <Tooltip title={t('dataset.clearSelection')}>
                  <button type="button" className="wb-icon-button" aria-label={t('dataset.clearSelection')} onClick={() => setSelected(new Set())}>
                    <Icon name="close" />
                  </button>
                </Tooltip>
              </span>
            )}
          </div>
          {/* Each tab is a pane of its own, so it keeps to its own scrolling. */}
          <div key={pane} className={`editor-pane ${pane}`} role="tabpanel" hidden={pane === 'permissions'}>
            {pane === 'preview' && (fields.length === 0 ? noFields : previewPane)}
            {pane === 'details' && (fields.length === 0 ? noFields : details)}
            {pane === 'usages' && existing && <Usages kind="dataset" id={existing.id} stamp={saved?.revision} />}
            {pane === 'history' && current && <DatasetHistory datasetId={current.id} currentRevision={current.revision} datasources={datasources} busy={saving || !!pendingImpact}
              onRestore={(revision) => { if (!isSessionChanging()) { if (dirty) setRestoreCandidate(revision); else restore(revision) } }} />}
          </div>
          {/* Keep permission drafts when switching to another dataset tab. */}
          {permissionsOpened && current && (
            <div className="editor-pane permissions" role="tabpanel" hidden={pane !== 'permissions'}>
              <DatasetPermissions dataset={current} onDirtyChange={setPermissionsDirty} />
            </div>
          )}
        </section>
      </div>

      <Dialog
        open={sourceOpen}
        title={t('dataset.sql')}
        onClose={() => setSourceOpen(false)}
        width={820}
        actions={
          <>
            <Button onClick={() => setSourceOpen(false)}>{t('common.close')}</Button>
            <Button variant="primary" icon={<Icon name="explore" />} onClick={editSql}>
              {t('dataset.editInExplore')}
            </Button>
          </>
        }
      >
        {/* Shown as it is written, coloured, and not to be changed here: SQL is written in data exploration. */}
        {sourceOpen && <CodeEditor aria-label={t('dataset.sql')} dialect={dialect} lineNumbers disabled minLines={8} maxLines={24} value={sql} onChange={() => undefined} />}
      </Dialog>

      {pendingImpact && <DatasetImpactDialog impact={pendingImpact.impact} saving={saving} error={error ?? undefined}
        onCancel={() => { if (!saving) { setPendingImpact(null); setError(null) } }}
        onConfirm={() => { if (!saving) void writeProposal(pendingImpact.proposal, pendingImpact.impact, true) }} />}

      <Dialog open={!!restoreCandidate} title={t('dataset.history.replaceTitle')} onClose={() => setRestoreCandidate(undefined)} width={460}
        actions={<><Button onClick={() => setRestoreCandidate(undefined)}>{t('common.cancel')}</Button><Button variant="primary" disabled={saving || !!pendingImpact} onClick={() => restoreCandidate && restore(restoreCandidate)}>{t('dataset.history.restore')}</Button></>}>
        <p>{t('dataset.history.replaceBody', { revision: restoreCandidate?.revision })}</p>
      </Dialog>

      <Dialog
        open={doomed !== null}
        title={t('dataset.deleteReadTitle', { count: doomed?.length ?? 0, name: labels.get(doomed?.[0] ?? '')?.label ?? '' })}
        width={460}
        onClose={() => setDoomed(null)}
        actions={
          <>
            <Button onClick={() => setDoomed(null)}>{t('common.cancel')}</Button>
            <Button
              danger
              onClick={() => {
                if (doomed) remove(doomed)
                setDoomed(null)
              }}
            >
              {t('common.confirmDelete')}
            </Button>
          </>
        }
      >
        <p>{t('dataset.deleteReadBody', { count: doomedReaders.length })}</p>
        <ul className="doomed-readers">
          {doomedReaders.map((chart) => (
            <li key={chart.id}>
              <Icon name="chart" />
              {chart.name}
            </li>
          ))}
        </ul>
      </Dialog>

      {formattingField && (
        <FormatDialog
          name={formattingField.label}
          value={formattingField.format}
          type={formattingField.type}
          onDone={(format) => {
            replaceField(formattingField.key, (field) => {
              const next = { ...field }
              delete next.format
              return format ? { ...next, format } : next
            })
            setFormatting(null)
          }}
          onCancel={() => setFormatting(null)}
        />
      )}
      {draft && <CalculatedFieldDialog draft={draft} fields={fields} datasourceId={datasourceId} dialect={dialect} preview={fetchPreview} onChange={setDraft} onDone={finishDraft} onCancel={() => setDraft(null)} />}
    </form>
  )
}

export function DatasetEditor() {
  const { t } = useTranslation()
  const { id } = useParams()
  const location = useLocation()
  const { resources, loaded } = useWorkbench()
  const existing = useAsync(() => (id ? unwrap(api.GET('/datasets/{id}', { params: { path: { id } } })) : Promise.resolve(undefined)), [id])
  const state = location.state as Partial<SqlHandoff> | null
  const handed = typeof state?.sql === 'string' && typeof state.datasourceId === 'string' ? (state as SqlHandoff) : readSqlHandoff(location.search)?.handoff

  if (!loaded) return <p className="muted">{t('common.loading')}</p>
  // A dataset begins as SQL; with none there is nothing to configure yet.
  if (!id && !handed) {
    return (
      <div className="wb-landing">
        <Icon name="explore" size={40} />
        <p>{t('dataset.startInExplore')}</p>
        <Link to={`/explore${location.search}`} target="_blank" rel="noopener noreferrer">
          <Button variant="primary">{t('nav.explore')}</Button>
        </Link>
      </div>
    )
  }
  return (
    <Async state={existing} reload={existing.reload}>
      {/* The key resets the form when another dataset is opened, or other SQL arrives for this one. */}
      {(dataset) => <Editor key={`${dataset?.id ?? 'new'}:${handed ? location.key : ''}`} datasources={resources.datasources} existing={dataset} handed={handed} />}
    </Async>
  )
}
