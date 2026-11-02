import { Button, DataTable, Dialog, Field, Input, MultiSelect } from '@supabi/ui'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, unwrap, type Group, type User } from '../../api/client'
import { useAsync } from '../../api/useAsync'
import { Async } from '../../components/Async'
import { ErrorAlert } from '../../components/ErrorAlert'
import { ConfirmDialog, KeptAsync, RowMenu, SettingsPage, useAction } from './shared'

function GroupDialog({ group, users, onClose }: { group?: Group; users: User[]; onClose: (saved: boolean) => void }) {
  const { t } = useTranslation()
  const [name, setName] = useState(group?.name ?? '')
  const [userIds, setUserIds] = useState<string[]>(group?.userIds ?? [])
  const action = useAction()
  const body = { name, userIds }
  const save = () => void action.run(
    () => (group ? unwrap(api.PUT('/groups/{id}', { params: { path: { id: group.id } }, body })) : unwrap(api.POST('/groups', { body }))),
    () => onClose(true),
  )
  return (
    <Dialog
      open
      width={560}
      title={group ? t('group.editNamed', { name: group.name }) : t('group.add')}
      onClose={() => !action.busy && onClose(false)}
      actions={<>
        <Button disabled={action.busy} onClick={() => onClose(false)}>{t('common.cancel')}</Button>
        <Button variant="primary" loading={action.busy} disabled={!name.trim()} onClick={save}>{t('common.save')}</Button>
      </>}
    >
      <form className="stack" onSubmit={(event) => { event.preventDefault(); if (name.trim()) save() }}>
        <Field label={t('common.name')} htmlFor="group-name" required>
          <Input id="group-name" value={name} onChange={setName} />
        </Field>
        <Field label={t('group.users')} htmlFor="group-users">
          <MultiSelect id="group-users" value={userIds} options={users.map((user) => ({ value: user.id, label: `${user.displayName} (${user.email})` }))} onChange={setUserIds} />
        </Field>
        {action.error && <ErrorAlert error={action.error} />}
      </form>
    </Dialog>
  )
}

export function Groups() {
  const { t } = useTranslation()
  const groups = useAsync(() => unwrap(api.GET('/groups')), [], { keepData: true })
  const users = useAsync(() => unwrap(api.GET('/users')), [])
  const [editing, setEditing] = useState<Group | 'new'>()
  const [deleting, setDeleting] = useState<Group>()

  return (
    <SettingsPage title={t('settings.groups')} hint={t('group.hint')} actions={<Button variant="primary" onClick={() => setEditing('new')}>{t('group.add')}</Button>}>
      <Async state={users} reload={users.reload}>
        {(directory) => (
          <>
            <KeptAsync state={groups} reload={groups.reload}>
              {(rows) => (
                <DataTable
                  aria-label={t('settings.groups')}
                  rows={rows}
                  rowKey={(row) => row.id}
                  empty={t('common.none')}
                  columns={[
                    { key: 'name', title: t('common.name'), width: 240, render: (row) => row.name },
                    {
                      key: 'users',
                      title: t('group.users'),
                      render: (row) => {
                        const names = row.userIds.map((id) => directory.find((user) => user.id === id)?.displayName ?? id).join('、')
                        return <span className="settings-clip" title={names}><span className="note">{t('group.count', { count: row.userIds.length })}</span>{names && ` · ${names}`}</span>
                      },
                    },
                    {
                      key: 'actions',
                      title: '',
                      width: 48,
                      render: (row) => <RowMenu label={t('settings.actionsOf', { name: row.name })} items={[
                        { key: 'edit', label: t('common.edit'), onSelect: () => setEditing(row) },
                        { key: 'delete', label: t('common.delete'), danger: true, separated: true, onSelect: () => setDeleting(row) },
                      ]} />,
                    },
                  ]}
                />
              )}
            </KeptAsync>
            {editing && (
              <GroupDialog
                key={editing === 'new' ? 'new' : editing.id}
                group={editing === 'new' ? undefined : editing}
                users={directory}
                onClose={(saved) => { setEditing(undefined); if (saved) groups.reload() }}
              />
            )}
          </>
        )}
      </Async>
      {deleting && (
        <ConfirmDialog
          title={t('group.deleteNamed', { name: deleting.name })}
          confirmLabel={t('common.confirmDelete')}
          onConfirm={() => unwrap(api.DELETE('/groups/{id}', { params: { path: { id: deleting.id } } }))}
          onClose={(done) => { setDeleting(undefined); if (done) groups.reload() }}
        >
          {t('group.deleteNote')}
        </ConfirmDialog>
      )}
    </SettingsPage>
  )
}
