import { Button, Input, Select, useToast } from '@supabi/ui'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, unwrap } from '../../api/client'
import { useSession } from '../../auth/session'
import { ErrorAlert } from '../../components/ErrorAlert'
import { LeaveGuard } from '../../components/UnsavedChanges'
import { timeZoneOptions } from '../../lib/timeZones'
import { SettingsPage, useAction } from './shared'

export type WorkspaceSettings = { name: string; timezone: string; weekStart: number; firstWeekDays: number }

/** Which week is a year's first, by how many of its days are in that year: ISO 8601's when weeks start on Monday first. */
const firstWeekChoices = [4, 1, 7] as const

const settingsOf = ({ name, timezone, weekStart, firstWeekDays }: WorkspaceSettings): WorkspaceSettings => ({ name, timezone, weekStart, firstWeekDays })

/** A workspace's settings a row each: its name, then how it reckons days and weeks. */
export function WorkspaceFields({ value, onChange, idPrefix }: { value: WorkspaceSettings; onChange: (value: WorkspaceSettings) => void; idPrefix: string }) {
  const { t } = useTranslation()
  const zoneOptions = useMemo(() => timeZoneOptions(value.timezone), [value.timezone])
  const set = (patch: Partial<WorkspaceSettings>) => onChange({ ...value, ...patch })
  return (
    <>
      <div className="settings-group">
        <dl className="settings-rows">
          <dt><label htmlFor={`${idPrefix}-name`}>{t('common.name')}</label></dt>
          <dd><Input id={`${idPrefix}-name`} value={value.name} onChange={(name) => set({ name })} /></dd>
        </dl>
      </div>
      <div className="settings-group">
        <h3>{t('workspace.dates')}</h3>
        <dl className="settings-rows">
          <dt><label htmlFor={`${idPrefix}-tz`}>{t('workspace.timezone')}</label></dt>
          <dd>
            <Select id={`${idPrefix}-tz`} aria-label={t('workspace.timezone')} block search value={value.timezone} options={zoneOptions} onChange={(timezone) => set({ timezone })} />
            <span className="note">{t('workspace.timezoneHint')}</span>
          </dd>
          <dt><label htmlFor={`${idPrefix}-week`}>{t('workspace.weekStart')}</label></dt>
          <dd>
            <Select
              id={`${idPrefix}-week`}
              aria-label={t('workspace.weekStart')}
              block
              value={value.weekStart}
              options={[
                { value: 1, label: t('workspace.monday') },
                { value: 7, label: t('workspace.sunday') },
              ]}
              onChange={(weekStart) => set({ weekStart })}
            />
          </dd>
          <dt><label htmlFor={`${idPrefix}-first-week`}>{t('workspace.firstWeek')}</label></dt>
          <dd>
            <Select<number>
              id={`${idPrefix}-first-week`}
              aria-label={t('workspace.firstWeek')}
              block
              value={value.firstWeekDays}
              options={firstWeekChoices.map((days) => ({ value: days, label: t(`workspace.firstWeekDays.${days}`) }))}
              onChange={(firstWeekDays) => set({ firstWeekDays })}
            />
            <span className="note">{t('workspace.firstWeekHint')}</span>
          </dd>
        </dl>
      </div>
    </>
  )
}

/** The current workspace's settings, saved together; there is nothing to save until one changes. */
function GeneralForm({ initial }: { initial: WorkspaceSettings }) {
  const { t } = useTranslation()
  const session = useSession()
  const toast = useToast()
  const saved = settingsOf(initial)
  const [value, setValue] = useState(saved)
  const dirty = JSON.stringify(value) !== JSON.stringify(saved)
  const action = useAction()
  return (
    <form
      className="settings-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (!dirty || !value.name.trim()) return
        void action.run(
          () => unwrap(api.PUT('/workspace', { body: value })),
          () => {
            toast(t('settings.saved'))
            session.reload()
          },
        )
      }}
    >
      <LeaveGuard dirty={dirty} />
      <WorkspaceFields idPrefix="ws" value={value} onChange={setValue} />
      {action.error && <ErrorAlert error={action.error} />}
      <div>
        <Button variant="primary" type="submit" loading={action.busy} disabled={!dirty || !value.name.trim()}>
          {t('common.save')}
        </Button>
      </div>
    </form>
  )
}

export function Workspace() {
  const { t } = useTranslation()
  const session = useSession()
  const current = session.state.status === 'ok' ? session.state.data.workspace : undefined
  if (!current) return null
  return (
    <SettingsPage title={t('settings.general')}>
      <GeneralForm key={current.id} initial={current} />
    </SettingsPage>
  )
}
