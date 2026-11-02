import { Button, DataTable, Dialog } from '@supabi/ui'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, unwrap, type Workspace } from '../../api/client'
import { useAsync } from '../../api/useAsync'
import { useSession } from '../../auth/session'
import { ErrorAlert } from '../../components/ErrorAlert'
import { ConfirmDialog, KeptAsync, RowMenu, SettingsPage, useAction } from './shared'
import { WorkspaceFields, type WorkspaceSettings } from './Workspace'

/** What can be done to a workspace from the list. See .agents/design/access-control.md §2.3. */
type Step = 'delete' | 'restore' | 'purge'

const steps: Record<Step, (id: string) => Promise<unknown>> = {
  delete: (id) => unwrap(api.DELETE('/workspaces/{id}', { params: { path: { id } } })),
  restore: (id) => unwrap(api.POST('/workspaces/{id}/restore', { params: { path: { id } } })),
  purge: (id) => unwrap(api.POST('/workspaces/{id}/purge', { params: { path: { id } } })),
}

function NewWorkspace({ onClose }: { onClose: (created: boolean) => void }) {
  const { t } = useTranslation()
  const [value, setValue] = useState<WorkspaceSettings>({ name: '', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, weekStart: 1, firstWeekDays: 4 })
  const action = useAction()
  const save = () => void action.run(() => unwrap(api.POST('/workspaces', { body: value })), () => onClose(true))
  return (
    <Dialog
      open
      width={600}
      title={t('workspace.add')}
      onClose={() => !action.busy && onClose(false)}
      actions={<>
        <Button disabled={action.busy} onClick={() => onClose(false)}>{t('common.cancel')}</Button>
        <Button variant="primary" loading={action.busy} disabled={!value.name.trim()} onClick={save}>{t('workspace.add')}</Button>
      </>}
    >
      <form className="settings-form" onSubmit={(event) => { event.preventDefault(); if (value.name.trim()) save() }}>
        <WorkspaceFields idPrefix="new-ws" value={value} onChange={setValue} />
        {action.error && <ErrorAlert error={action.error} />}
      </form>
    </Dialog>
  )
}

/** The system-wide list is separate from the current workspace's settings. */
export function Workspaces({ onManage, onCurrentDeleted, busy }: { onManage: (id: string) => void; onCurrentDeleted: () => void; busy: boolean }) {
  const { t, i18n } = useTranslation()
  const session = useSession()
  // Only system administrators come here, who can read how long a deleted workspace is kept.
  const list = useAsync(async () => {
    const [rows, settings] = await Promise.all([unwrap(api.GET('/workspaces')), unwrap(api.GET('/system/settings'))])
    return { rows, keptDays: settings.values.workspaceRetentionDays ?? settings.defaults.workspaceRetentionDays }
  }, [], { keepData: true })
  const [adding, setAdding] = useState(false)
  const [pending, setPending] = useState<{ step: Step; row: Workspace }>()
  const currentId = session.state.status === 'ok' ? session.state.data.workspace?.id : undefined
  const day = (value: string) => new Date(value).toLocaleDateString(i18n.language, { dateStyle: 'medium' })
  const ask = (step: Step, row: Workspace) => () => setPending({ step, row })
  return (
    <SettingsPage title={t('workspace.all')} hint={t('workspace.hint')} actions={<Button variant="primary" disabled={busy} onClick={() => setAdding(true)}>{t('workspace.add')}</Button>}>
      <KeptAsync state={list} reload={list.reload}>
        {({ rows }) => <DataTable aria-label={t('workspace.all')} rows={rows} rowKey={(row) => row.id} columns={[
          { key: 'name', title: t('common.name'), render: (row) => (
            <span className="settings-person">
              <span>{row.name}</span>
              {row.id === currentId && <span className="note">{t('workspace.youAreHere')}</span>}
              {row.purgeAt && <span className="chip warning">{t('workspace.deleted', { date: day(row.purgeAt) })}</span>}
            </span>
          ) },
          { key: 'timezone', title: t('workspace.timezone'), width: 200, render: (row) => row.timezone },
          { key: 'week', title: t('workspace.weekStart'), width: 120, render: (row) => t(row.weekStart === 7 ? 'workspace.sunday' : 'workspace.monday') },
          { key: 'actions', title: '', width: 112, render: (row) => {
            const named = { name: row.name }
            // The step most often taken is a button; the rest are in the menu.
            return row.deletedAt ? (
              <span className="row nowrap">
                <Button size="sm" variant="ghost" disabled={busy} aria-label={t('workspace.restoreNamed', named)} onClick={ask('restore', row)}>{t('workspace.restore')}</Button>
                <RowMenu label={t('settings.actionsOf', named)} items={[{ key: 'purge', label: t('workspace.purge'), danger: true, disabled: busy, onSelect: ask('purge', row) }]} />
              </span>
            ) : (
              <span className="row nowrap">
                <Button size="sm" variant="ghost" disabled={busy} aria-label={t('workspace.manageNamed', named)} onClick={() => onManage(row.id)}>{t('workspace.manage')}</Button>
                <RowMenu label={t('settings.actionsOf', named)} items={[{ key: 'delete', label: t('workspace.delete'), danger: true, disabled: busy, onSelect: ask('delete', row) }]} />
              </span>
            )
          } },
        ]} />}
      </KeptAsync>
      {adding && <NewWorkspace onClose={(created) => { setAdding(false); if (created) { session.reload(); list.reload() } }} />}
      {pending && list.status === 'ok' && (
        <ConfirmDialog
          title={t(`workspace.${pending.step}Named`, { name: pending.row.name })}
          confirmLabel={t(`workspace.${pending.step}Confirm`)}
          danger={pending.step !== 'restore'}
          onConfirm={() => steps[pending.step](pending.row.id)}
          onClose={(done) => {
            const { step, row } = pending
            setPending(undefined)
            if (!done) return
            // Deleting the workspace this session is in moves the session.
            // Otherwise the switcher only gains or loses an entry.
            if (step === 'delete' && row.id === currentId) onCurrentDeleted()
            else session.reload()
            list.reload()
          }}
        >
          {t(`workspace.${pending.step}Note`, { days: t('systemSettings.days', { count: list.data.keptDays }) })}
        </ConfirmDialog>
      )}
    </SettingsPage>
  )
}
