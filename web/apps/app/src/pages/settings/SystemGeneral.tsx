import { Button, Checkbox, Input, useToast } from '@supabi/ui'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, unwrap, type Schemas } from '../../api/client'
import { useAsync } from '../../api/useAsync'
import { useSession } from '../../auth/session'
import { Async } from '../../components/Async'
import { ErrorAlert } from '../../components/ErrorAlert'
import { LeaveGuard } from '../../components/UnsavedChanges'
import { ConfirmDialog, SettingsPage, useAction } from './shared'

type SystemSettings = Schemas['SystemSettings']
type Values = Schemas['SystemSettingValues']
/** The settings typed as numbers; the MCP switch is drawn apart. */
type Setting = Exclude<keyof Schemas['SystemSettingDefaults'], 'mcpEnabled'>

/** The settings in their groups, with what each may be: .agents/design/configuration.md 10.1, 10.7. */
const groups: { name: 'exports' | 'audit' | 'query' | 'workspaces' | 'signIn'; settings: { key: Setting; min: number; max: number }[] }[] = [
  {
    name: 'exports',
    settings: [
      { key: 'exportRetentionHours', min: 1, max: 8760 },
      { key: 'exportTimeoutMinutes', min: 1, max: 1440 },
      { key: 'exportMaxRows', min: 1, max: 100_000_000 },
      { key: 'exportMaxSizeMb', min: 1, max: 1 << 20 },
    ],
  },
  { name: 'audit', settings: [{ key: 'auditRetentionDays', min: 0, max: 36500 }] },
  {
    name: 'query',
    settings: [
      { key: 'queryTimeoutSeconds', min: 1, max: 3600 },
      { key: 'queryDefaultRows', min: 1, max: 100_000 },
      { key: 'queryMaxRows', min: 1, max: 100_000 },
      { key: 'queryCacheTtlMinutes', min: 1, max: 1440 },
    ],
  },
  { name: 'workspaces', settings: [{ key: 'workspaceRetentionDays', min: 1, max: 3650 }] },
  { name: 'signIn', settings: [{ key: 'sessionLifetimeHours', min: 1, max: 8760 }] },
]
const settings = groups.flatMap((group) => group.settings)

/** What is typed in each box; empty takes the default. */
type Draft = Record<Setting, string>

const draftOf = (values: Values): Draft =>
  Object.fromEntries(settings.map(({ key }) => [key, values[key] === undefined ? '' : String(values[key])])) as Draft

/** A whole number within the setting's range, or null. */
function parse(text: string, min: number, max: number) {
  const n = Number(text)
  return /^\d+$/.test(text.trim()) && n >= min && n <= max ? n : null
}

/** What a setting comes to as typed: left empty, its default. */
const inForce = (draft: Draft, defaults: SystemSettings['defaults'], key: Setting) => (draft[key].trim() === '' ? defaults[key] : Number(draft[key]))

/** Keeping things fewer days, or no longer for ever, deletes some within the hour. */
const shortens = (before: number, after: number) => after > 0 && (before === 0 || after < before)

function GeneralForm({ initial }: { initial: SystemSettings }) {
  const { t, i18n } = useTranslation()
  const toast = useToast()
  const session = useSession()
  const [saved, setSaved] = useState(() => draftOf(initial.values))
  const [draft, setDraft] = useState(saved)
  // Once set, the switch is kept as set rather than following the default: configuration.md 10.8.
  const [savedMcp, setSavedMcp] = useState(initial.values.mcpEnabled)
  const [mcp, setMcp] = useState(initial.values.mcpEnabled ?? initial.defaults.mcpEnabled)
  const [confirming, setConfirming] = useState(false)
  const action = useAction()
  const { defaults } = initial
  const dirty = settings.some(({ key }) => draft[key].trim() !== saved[key]) || mcp !== (savedMcp ?? defaults.mcpEnabled)
  const defaultAboveMax = inForce(draft, defaults, 'queryDefaultRows') > inForce(draft, defaults, 'queryMaxRows')
  const invalid = defaultAboveMax || settings.some(({ key, min, max }) => draft[key].trim() !== '' && parse(draft[key], min, max) === null)
  const shortened = (['auditRetentionDays', 'workspaceRetentionDays'] as const).filter((key) => shortens(inForce(saved, defaults, key), inForce(draft, defaults, key)))
  const save = async () => {
    const body: Values = {}
    for (const { key } of settings) {
      if (draft[key].trim() !== '') body[key] = Number(draft[key])
    }
    if (savedMcp !== undefined || mcp !== defaults.mcpEnabled) body.mcpEnabled = mcp
    const result = await unwrap(api.PUT('/system/settings', { body }))
    const next = draftOf(result.values)
    setSaved(next)
    setDraft(next)
    setSavedMcp(result.values.mcpEnabled)
    setMcp(result.values.mcpEnabled ?? defaults.mcpEnabled)
    // The session says how many rows queries return.
    session.reload()
    toast(t('settings.saved'))
  }
  const days = (n: number) => (n === 0 ? t('systemSettings.forever') : t('systemSettings.days', { count: n }))
  return (
    <form
      className="settings-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (!dirty || invalid) return
        if (shortened.length > 0) setConfirming(true)
        else void action.run(save)
      }}
    >
      <LeaveGuard dirty={dirty} />
      {groups.map((group) => (
        <div key={group.name} className="settings-group">
          <h3>{t(`systemSettings.groups.${group.name}`)}</h3>
          <dl className="settings-rows">
            {group.settings.map(({ key, min, max }) => {
              const text = draft[key]
              const wrong = text.trim() !== '' && parse(text, min, max) === null
              return [
                <dt key={`${key}-label`}><label htmlFor={`system-${key}`}>{t(`systemSettings.${key}.label`)}</label></dt>,
                <dd key={key}>
                  <span className="settings-number">
                    <Input
                      id={`system-${key}`}
                      type="number"
                      min={min}
                      max={max}
                      step={1}
                      value={text}
                      invalid={wrong}
                      placeholder={String(defaults[key])}
                      onChange={(value) => setDraft({ ...draft, [key]: value })}
                    />
                    <span>{t(`systemSettings.${key}.unit`)}</span>
                  </span>
                  {wrong && <span className="note danger">{t('systemSettings.range', { min: min.toLocaleString(i18n.language), max: max.toLocaleString(i18n.language) })}</span>}
                  {key === 'queryDefaultRows' && defaultAboveMax && <span className="note danger">{t('systemSettings.defaultAboveMax')}</span>}
                  <span className="note">{t(`systemSettings.${key}.hint`, { value: defaults[key].toLocaleString(i18n.language) })}</span>
                </dd>,
              ]
            })}
          </dl>
        </div>
      ))}
      <div className="settings-group">
        <h3>{t('systemSettings.groups.mcp')}</h3>
        <dl className="settings-rows">
          <dt>{t('systemSettings.mcpEnabled.label')}</dt>
          <dd>
            <Checkbox checked={mcp} onChange={setMcp} aria-label={t('systemSettings.mcpEnabled.label')}>{t('systemSettings.mcpEnabled.allow')}</Checkbox>
            <span className="note">{t('systemSettings.mcpEnabled.hint')}</span>
          </dd>
        </dl>
      </div>
      {action.error && <ErrorAlert error={action.error} />}
      <div>
        <Button variant="primary" type="submit" loading={action.busy} disabled={!dirty || invalid}>
          {t('common.save')}
        </Button>
      </div>
      {confirming && (
        <ConfirmDialog title={t('systemSettings.shortenTitle')} confirmLabel={t('common.save')} onConfirm={save} onClose={() => setConfirming(false)}>
          {shortened.map((key) => t(`systemSettings.shorten.${key}`, { from: days(inForce(saved, defaults, key)), to: days(inForce(draft, defaults, key)) })).join(' ')}
        </ConfirmDialog>
      )}
    </form>
  )
}

/** The settings the organization has one value of, which every instance reads where it uses them. */
export function SystemGeneral() {
  const { t } = useTranslation()
  const settingsState = useAsync(() => unwrap(api.GET('/system/settings')), [])
  return (
    <SettingsPage title={t('settings.systemGeneral')} hint={t('systemSettings.hint')}>
      <Async state={settingsState} reload={settingsState.reload}>
        {(data) => <GeneralForm initial={data} />}
      </Async>
    </SettingsPage>
  )
}
