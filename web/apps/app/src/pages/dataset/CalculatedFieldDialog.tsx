import { formatCell } from '@supabi/charts'
import { Button, CodeEditor, Dialog, Field, Input, Select, TextArea, Tooltip, type CodeEditorHandle } from '@supabi/ui'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, indexOfCharacter, unwrap, type ApiError, type ExpressionCheck, type ExpressionFunction, type LogicalType, type QueryResult } from '../../api/client'
import { fieldRoles, foldLabel, isNumeric, logicalTypes, makeKey, refsOf, toStoredExpr, validLabel, withRole, type FieldRole, type SpecField } from '../../api/spec'
import { toApiError, useAsync } from '../../api/useAsync'
import { ErrorAlert } from '../../components/ErrorAlert'
import { Icon } from '../../components/Icon'
import { TypeMark } from '../../components/TypeMark'

/** The language an expression is written in: the platform's functions, or the data source's own SQL. */
export type Syntax = 'standard' | 'native'

/** A calculated field while it is being written. Its expression is in the written form, with names. */
export interface Draft {
  /** The field being edited; absent for a new one. */
  key?: string
  label: string
  role: FieldRole
  type: LogicalType
  expr: string
  syntax: Syntax
  description: string
}

/** How many rows a trial shows: enough to see what the expression gives, and no more. */
const trialRows = 8

/** What a trial was of, to tell whether what is written has moved on since. */
type Trial = { of: string } & ({ status: 'loading' } | { status: 'error'; error: ApiError } | { status: 'ok'; result: QueryResult; field: SpecField })

/** CASE is part of the language rather than a function, and is offered among them. */
const caseWhen: ExpressionFunction = { name: 'CASE', category: 'logic', aggregate: false, extended: false }
const caseTemplate = 'CASE WHEN  THEN  ELSE  END'

const functionCategories = ['aggregate', 'logic', 'math', 'text', 'date', 'convert', 'native'] as const

/** A failure that says nothing about what was written: the database could not be asked. */
const unreachable = (error: ApiError) => error.status === 0 || error.code === 'datasource_unreachable'

export function CalculatedFieldDialog({
  draft,
  fields,
  datasourceId,
  dialect,
  preview,
  onChange,
  onDone,
  onCancel,
}: {
  draft: Draft
  fields: SpecField[]
  datasourceId: string
  dialect?: string
  /** The first rows of the dataset as it would be with these fields. */
  preview: (fields: SpecField[], limit: number) => Promise<QueryResult>
  onChange: (draft: Draft) => void
  onDone: (field: SpecField) => void
  onCancel: () => void
}) {
  const { t, i18n } = useTranslation()
  const [problem, setProblem] = useState<{ at: 'label' | 'expr'; text: string } | null>(null)
  const [trial, setTrial] = useState<Trial | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [search, setSearch] = useState('')
  const [functionSearch, setFunctionSearch] = useState('')
  const [chosenFunction, setChosenFunction] = useState<string | null>(null)
  const [functionsShown, setFunctionsShown] = useState(true)
  // The functions are a tree by what they are for. The conditions are what is reached for most, so they start open.
  const [openCategories, setOpenCategories] = useState<ReadonlySet<string>>(new Set(['logic']))
  const toggleCategory = (category: string) =>
    setOpenCategories((current) => {
      const next = new Set(current)
      if (!next.delete(category)) next.add(category)
      return next
    })
  const editor = useRef<CodeEditorHandle>(null)
  // Until a type is chosen for a new field, it follows what the field is used as: what is measured is a number.
  const [typeChosen, setTypeChosen] = useState(Boolean(draft.key))

  const standard = draft.syntax === 'standard'
  const metric = draft.role === 'metric'
  const others = useMemo(() => fields.filter((field) => field.key !== draft.key), [fields, draft.key])
  const set = (patch: Partial<Draft>) => {
    setProblem(null)
    onChange({ ...draft, ...patch })
  }
  const pickRole = (role: FieldRole) => {
    // A type the expression gives stays: a measure that is not a number is
    // refused when it is confirmed, rather than given another type.
    if (inferred) return set({ role })
    // Only a number can be a measure; any other type a dimension may keep.
    if ((typeChosen || standard) && (role !== 'measure' || isNumeric(draft.type))) return set({ role })
    set({ role, type: role === 'dimension' ? 'string' : 'decimal' })
  }
  const withType = (type: LogicalType): Partial<Draft> => ({ type })

  // The functions this data source can compute. Without them the expression can still be written.
  const functions = useAsync(() => unwrap(api.GET('/datasources/{id}/functions', { params: { path: { id: datasourceId } } })), [datasourceId])
  const offeredFunctions = useMemo(() => {
    if (functions.status !== 'ok') return []
    const all = [...functions.data]
    all.splice(Math.max(0, all.findIndex((fn) => fn.category === 'logic')), 0, caseWhen)
    return all
  }, [functions])

  // ---- what the expression gives, read by the server as it is written ----

  const checkable = standard && draft.expr.trim() !== ''
  const scope = useMemo(() => others.map((field) => ({ label: field.label, type: field.type, metric: field.role === 'metric' })), [others])
  const checkOf = checkable ? JSON.stringify([draft.expr, metric, scope]) : null
  const [checked, setChecked] = useState<{ of: string; result: ExpressionCheck } | null>(null)
  const runCheck = () => unwrap(api.POST('/datasources/{id}/check-expression', { params: { path: { id: datasourceId } }, body: { expr: draft.expr, metric, fields: scope } }))
  useEffect(() => {
    if (checkOf === null) return
    let current = true
    const timer = setTimeout(() => {
      // Reading it is a help while writing: confirming reads it again, and says so when it cannot.
      runCheck().then(
        (result) => current && setChecked({ of: checkOf, result }),
        () => undefined,
      )
    }, 300)
    return () => {
      current = false
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- checkOf is everything the check reads
  }, [checkOf])
  const check = checked !== null && checked.of === checkOf ? checked.result : null

  // An expression in the platform's language says what it gives, so the type follows it.
  const inferred = standard ? check?.type : undefined
  useEffect(() => {
    if (inferred && inferred !== draft.type) onChange({ ...draft, ...withType(inferred) })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a newly worked out type moves the draft
  }, [inferred])

  const typeName = (type: string) => (i18n.exists(`dataset.types.${type}`) ? t(`dataset.types.${type}`) : type)
  /** A mistake the server found, in words. Types are named as they are everywhere else. */
  const mistakeText = (error: NonNullable<ExpressionCheck['error']>) => {
    const params: Record<string, string> = { ...error.params }
    for (const name of ['expected', 'actual', 'left', 'right']) {
      if (params[name] !== undefined) params[name] = params[name].split(',').map(typeName).join(' / ')
    }
    const key = `dataset.exprErrors.${error.code}`
    return i18n.exists(key) ? t(key, params) : error.message
  }
  // A reference to no field is marked by the editor itself, as it is typed.
  const mistake = check?.error && check.error.code !== 'expr_unknown_field' ? check.error : undefined
  const marked = mistake ? { at: indexOfCharacter(draft.expr, mistake.from), to: indexOfCharacter(draft.expr, mistake.to), message: mistakeText(mistake) } : null

  // ---- the field as written ----

  /** The field as written, or what is wrong with it. */
  const build = (): SpecField | null => {
    const label = draft.label.trim()
    const wrong = (at: 'label' | 'expr', text: string) => {
      setProblem({ at, text })
      return null
    }
    if (!validLabel(label)) return wrong('label', t('dataset.labelInvalid'))
    if (others.some((field) => foldLabel(field.label) === foldLabel(label))) return wrong('label', t('dataset.labelDuplicate', { label }))
    if (!draft.expr.trim()) return wrong('expr', t('dataset.exprRequired'))
    const { expr, unknown } = toStoredExpr(draft.expr.trim(), others)
    if (unknown.length > 0) return wrong('expr', t('dataset.unknownNames', { names: [...new Set(unknown)].join('、') }))
    if (draft.role === 'measure' && !isNumeric(draft.type)) return wrong('expr', t('dataset.measureNeedsNumber', { type: t(`dataset.types.${draft.type}`) }))

    const existing = fields.find((field) => field.key === draft.key)
    const taken = new Set(fields.map((field) => field.key))
    const base: SpecField = { ...existing, key: existing?.key ?? makeKey(label, taken), label, expr, type: draft.type, role: draft.role }
    // What is not said is left out, as the server stores it.
    if (standard) base.syntax = 'standard'
    else delete base.syntax
    if (draft.description.trim()) base.description = draft.description.trim()
    else delete base.description
    return withRole(base, draft.role)
  }

  /** What a trial or a confirmation is of: everything that decides what the field gives. */
  const written = JSON.stringify([draft.expr, draft.syntax, draft.role, draft.type])

  /**
   * Reads the field once more before it is used: the server says what an
   * expression in the platform's language gives, or what is wrong with it.
   * Null when it has a mistake, which is then shown.
   */
  const settle = async (field: SpecField): Promise<SpecField | null> => {
    if (!standard) return field
    let result: ExpressionCheck
    try {
      result = await runCheck()
    } catch {
      // The server will read it again when the dataset is saved.
      return field
    }
    if (checkOf !== null) setChecked({ of: checkOf, result })
    if (result.error) return null
    if (!result.type || result.type === field.type) return field
    // A measure the expression makes text or a date is said to be wrong, not quietly made a dimension.
    if (field.role === 'measure' && !isNumeric(result.type)) {
      setProblem({ at: 'expr', text: t('dataset.measureNeedsNumber', { type: t(`dataset.types.${result.type}`) }) })
      return null
    }
    return withRole({ ...field, type: result.type }, field.role)
  }

  const tryOut = async () => {
    if (metric || trial?.status === 'loading') return
    const built = build()
    if (!built) return
    setTrial({ of: written, status: 'loading' })
    const field = await settle(built)
    if (!field) return setTrial(null)
    try {
      const result = await preview([...others, field], trialRows)
      setTrial({ of: written, status: 'ok', result, field })
      // SQL of the data source does not say what it gives; the database just did.
      const actual = result.columns.find((column) => column.name === field.key)?.type
      if (!standard && !typeChosen && actual && actual !== draft.type) onChange({ ...draft, ...withType(actual) })
    } catch (e) {
      setTrial({ of: written, status: 'error', error: toApiError(e) })
    }
  }

  const confirm = async () => {
    const built = build()
    if (!built) return
    setConfirming(true)
    try {
      const field = await settle(built)
      if (!field) return
      // A field with a value on every row can be asked of the database here,
      // where a mistake is still in front of whoever made it.
      if (!metric) {
        try {
          await preview([...others, field], 1)
        } catch (e) {
          const error = toApiError(e)
          if (!unreachable(error)) return setTrial({ of: written, status: 'error', error })
        }
      }
      onDone(field)
    } finally {
      setConfirming(false)
    }
  }

  // ---- what is shown ----

  const matching = others.filter((field) => !search.trim() || foldLabel(field.label).includes(foldLabel(search)))
  // A field computed per row cannot read a metric, which has no value on a row.
  const offered = fieldRoles.map((role) => ({ role, fields: matching.filter((field) => field.role === role) })).filter((group) => group.fields.length > 0 && (metric || group.role !== 'metric'))

  const functionText = (fn: ExpressionFunction, part: 'title' | 'syntax' | 'desc' | 'example') => (i18n.exists(`dataset.fn.${fn.name}.${part}`) ? t(`dataset.fn.${fn.name}.${part}`) : '')
  const wanted = functionSearch.trim().toLowerCase()
  const matchingFunctions = offeredFunctions.filter((fn) => !wanted || fn.name.toLowerCase().includes(wanted) || functionText(fn, 'title').toLowerCase().includes(wanted) || functionText(fn, 'desc').toLowerCase().includes(wanted))
  const shownFunction = offeredFunctions.find((fn) => fn.name === chosenFunction)
  const insertFunction = (fn: ExpressionFunction) => (fn.name === 'CASE' ? editor.current?.insert(caseTemplate, caseTemplate.length - 'CASE WHEN '.length) : editor.current?.insert(`${fn.name}()`, 1))

  // The rows of a trial: what the expression read, then what it gave.
  const tried = (() => {
    if (trial?.status !== 'ok') return null
    const { result, field } = trial
    const read = new Set(refsOf(field.expr ?? ''))
    const shown = result.columns.map((column, index) => ({ column, index })).filter(({ column }) => column.name === field.key || read.has(column.name))
    // What was read comes first, the result last.
    shown.sort((a, b) => Number(a.column.name === field.key) - Number(b.column.name === field.key))
    const names = new Map([...others, field].map((item) => [item.key, item.label]))
    return { shown, names, rows: result.rows, key: field.key }
  })()
  const stale = trial !== null && trial.of !== written

  const below = (() => {
    if (problem?.at === 'expr') return <span className="field-error">{problem.text}</span>
    if (marked) return <span className="field-error">{marked.message}</span>
    return (
      <span className="note small">
        {t(`dataset.syntaxHints.${draft.syntax}`)}
        {check?.native && <span className="calc-flag"> {t('dataset.nativeInside')}</span>}
      </span>
    )
  })()

  return (
    <Dialog
      open
      title={draft.key ? t('dataset.editCalculated') : t('dataset.addCalculated')}
      onClose={onCancel}
      width={standard && functionsShown ? 1180 : 920}
      actions={
        <>
          <Button onClick={onCancel}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={confirming} onClick={() => void confirm()}>
            {t('common.confirm')}
          </Button>
        </>
      }
    >
      <div className={standard && functionsShown ? 'calc-dialog with-functions' : 'calc-dialog'}>
        <aside className="calc-side" aria-label={t('dataset.fieldsTitle')}>
          <div className="calc-side-title">
            {t('dataset.fieldsTitle')}
            <span className="note small">{t('dataset.insertField')}</span>
          </div>
          <Input size="sm" clearable aria-label={t('dataset.searchFields')} placeholder={t('dataset.searchFields')} value={search} onChange={setSearch} />
          <div className="calc-side-list">
            {offered.map((group) => (
              <section key={group.role}>
                <h3 className={group.role}>{t(`dataset.${group.role}s`)}</h3>
                <ul>
                  {group.fields.map((field) => (
                    <li key={field.key}>
                      <button type="button" className={`outline-item ${field.role}`} onClick={() => editor.current?.insert(`\${${field.label}}`)}>
                        <TypeMark type={field.type} />
                        <span className="outline-name">{field.label}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            {offered.length === 0 && <div className="note small">{t('dataset.noMatch')}</div>}
          </div>
        </aside>

        <div className="calc-form">
          <div className="calc-head">
            <Field label={t('dataset.label')} htmlFor="calc-label" required hint={problem?.at === 'label' ? <span className="field-error">{problem.text}</span> : undefined}>
              <Input id="calc-label" invalid={problem?.at === 'label'} placeholder={t('dataset.labelPlaceholder')} value={draft.label} onChange={(label) => set({ label })} />
            </Field>
            <Field label={t('dataset.role')} hint={t(`dataset.roleHints.${draft.role}`)}>
              <div className="calc-segments role-choice" role="radiogroup" aria-label={t('dataset.role')}>
                {fieldRoles.map((role) => (
                  <button key={role} type="button" role="radio" aria-checked={draft.role === role} className={draft.role === role ? `${role} chosen` : role} onClick={() => pickRole(role)}>
                    <span className="role-name">{t(`dataset.roles.${role}`)}</span>
                  </button>
                ))}
              </div>
            </Field>
          </div>

          <div className="calc-expr">
            <div className="calc-expr-head">
              <label htmlFor="calc-expr">
                {t('dataset.expr')}
                <span aria-hidden="true" className="required">
                  {' '}
                  *
                </span>
              </label>
              <Tooltip title={metric ? t('dataset.metricHint') : standard ? t('dataset.exprHintStandard') : t('dataset.exprHint')}>
                <span className="wb-icon-button help" aria-label={t('dataset.exprHelp')}>
                  <Icon name="help" size={14} />
                </span>
              </Tooltip>
              <div className="calc-segments" role="radiogroup" aria-label={t('dataset.syntax')}>
                {(['standard', 'native'] as const).map((syntax) => (
                  <button key={syntax} type="button" role="radio" aria-checked={draft.syntax === syntax} className={draft.syntax === syntax ? 'chosen' : undefined} onClick={() => set({ syntax })}>
                    {t(`dataset.syntaxes.${syntax}`)}
                  </button>
                ))}
              </div>
              <span className="spacer" />
              {/* A metric has no value on a row to show: it is checked when the dataset is saved. */}
              <Tooltip title={metric ? t('dataset.trialMetric') : t('dataset.trialHint')}>
                <span>
                  <Button size="sm" icon={<Icon name="play" size={14} />} loading={trial?.status === 'loading'} disabled={metric || !draft.expr.trim()} onClick={() => void tryOut()}>
                    {t('dataset.trial')}
                  </Button>
                </span>
              </Tooltip>
              {standard && (
                <Tooltip title={functionsShown ? t('dataset.hideFunctions') : t('dataset.showFunctions')}>
                  <button type="button" className={functionsShown ? 'wb-icon-button calc-toggle on' : 'wb-icon-button calc-toggle'} aria-label={t('dataset.functionsTitle')} aria-pressed={functionsShown} onClick={() => setFunctionsShown(!functionsShown)}>
                    <Icon name="chevronRight" size={14} />
                  </button>
                </Tooltip>
              )}
            </div>
            <CodeEditor
              id="calc-expr"
              aria-label={t('dataset.expr')}
              dialect={dialect}
              minLines={8}
              maxLines={14}
              placeholder={metric ? t('dataset.exprExampleMetric') : t('dataset.exprExample')}
              value={draft.expr}
              onChange={(expr) => set({ expr })}
              references={others.map((field) => ({ name: field.label, detail: t(`dataset.types.${field.type}`) }))}
              functions={standard ? offeredFunctions.filter((fn) => fn.name !== 'CASE').map((fn) => ({ name: fn.name, detail: functionText(fn, 'title') })) : undefined}
              unknownReference={(name) => t('dataset.unknownNames', { names: name })}
              problem={marked}
              onRun={() => void tryOut()}
              handle={editor}
            />
            {below}
          </div>

          <div className="calc-pair">
            <Field label={t('dataset.type')} htmlFor="calc-type" hint={inferred ? t('dataset.inferred') : undefined}>
              <Select<LogicalType>
                id="calc-type"
                block
                disabled={Boolean(inferred)}
                value={draft.type}
                // A measure is a number.
                options={logicalTypes.filter((value) => draft.role !== 'measure' || isNumeric(value)).map((value) => ({ value, label: t(`dataset.types.${value}`), icon: <TypeMark type={value} named /> }))}
                onChange={(type) => {
                  setTypeChosen(true)
                  set(withType(type))
                }}
              />
            </Field>
          </div>

          {/* What was tried stays in view while the expression is worked on, marked as no longer current. */}
          <div className={stale ? 'calc-trial stale' : 'calc-trial'}>
            {trial?.status === 'error' && <ErrorAlert error={trial.error} />}
            {tried && (
              <>
                <div className="note small">{stale ? t('dataset.trialStale') : t('dataset.trialRows', { count: tried.rows.length })}</div>
                <div className="calc-trial-scroll">
                  <table aria-label={t('dataset.trial')}>
                    <thead>
                      <tr>
                        {tried.shown.map(({ column }) => (
                          <th key={column.name} className={column.name === tried.key ? 'result' : undefined} style={{ textAlign: isNumeric(column.type) ? 'right' : 'left' }}>
                            {tried.names.get(column.name) ?? column.name}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {tried.rows.map((row, at) => (
                        <tr key={at}>
                          {tried.shown.map(({ column, index }) => (
                            <td key={column.name} className={column.name === tried.key ? 'result tabular' : 'tabular'} style={{ textAlign: isNumeric(column.type) ? 'right' : 'left' }}>
                              {formatCell(row[index] as never, column, i18n.language)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            {!metric && (trial === null || trial.status === 'loading') && <div className="calc-trial-empty note small">{t('dataset.trialEmpty')}</div>}
          </div>

          <Field label={t('dataset.fieldDescription')} htmlFor="calc-description">
            <TextArea id="calc-description" rows={2} placeholder={t('dataset.descriptionPlaceholder')} value={draft.description} onChange={(description) => onChange({ ...draft, description })} />
          </Field>
        </div>

        {standard && functionsShown && (
          <aside className="calc-side calc-functions" aria-label={t('dataset.functionsTitle')}>
            <div className="calc-side-title">{t('dataset.functionsTitle')}</div>
            <Input size="sm" clearable aria-label={t('dataset.searchFunctions')} placeholder={t('dataset.searchFunctions')} value={functionSearch} onChange={setFunctionSearch} />
            <div className="calc-side-list">
              {functions.status === 'error' && <ErrorAlert error={functions.error} />}
              {functionCategories.map((category) => {
                const group = matchingFunctions.filter((fn) => fn.category === category)
                if (group.length === 0) return null
                // A search opens every branch that has what is looked for.
                const open = wanted !== '' || openCategories.has(category)
                return (
                  <section key={category} className="calc-branch">
                    <button type="button" className="outline-item calc-branch-head" aria-expanded={open} onClick={() => toggleCategory(category)}>
                      <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
                      <Icon name="folder" size={14} />
                      <span className="outline-name">{t(`dataset.fn.categories.${category}`)}</span>
                      <span className="note small">{group.length}</span>
                    </button>
                    {open && (
                      <ul>
                        {group.map((fn) => (
                          <li key={fn.name}>
                            <button type="button" className={fn.name === chosenFunction ? 'outline-item active' : 'outline-item'} onClick={() => setChosenFunction(fn.name)} onDoubleClick={() => insertFunction(fn)}>
                              <span className="calc-fx" aria-hidden>
                                fx
                              </span>
                              <span className="outline-name">
                                {functionText(fn, 'title')} <code>{fn.name}</code>
                              </span>
                              {fn.extended && <span className="calc-badge">{t('dataset.extended')}</span>}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                )
              })}
              {functions.status === 'ok' && matchingFunctions.length === 0 && <div className="note small">{t('dataset.noFunctionMatch')}</div>}
            </div>
            <div className="calc-function">
              {shownFunction ? (
                <>
                  <div className="calc-function-head">
                    <strong>{functionText(shownFunction, 'title')}</strong>
                    <span className="spacer" />
                    <Button size="sm" onClick={() => insertFunction(shownFunction)}>
                      {t('dataset.insertFunction')}
                    </Button>
                  </div>
                  <code className="calc-function-syntax">{functionText(shownFunction, 'syntax')}</code>
                  <p>{functionText(shownFunction, 'desc')}</p>
                  {shownFunction.aggregate && !metric && <p className="note small">{t('dataset.aggregateOnly')}</p>}
                  {shownFunction.extended && <p className="note small">{t('dataset.extendedNote')}</p>}
                  <div className="note small">{t('dataset.fnExample')}</div>
                  <pre>{functionText(shownFunction, 'example')}</pre>
                </>
              ) : (
                <p className="note small">{t('dataset.pickFunction')}</p>
              )}
            </div>
          </aside>
        )}
      </div>
    </Dialog>
  )
}
