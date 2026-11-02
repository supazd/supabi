import { Button, Checkbox, DataTable, Dialog, Field, Input, useToast } from '@supabi/ui'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, unwrap, type User } from '../../api/client'
import { useAsync } from '../../api/useAsync'
import { useSession } from '../../auth/session'
import { ErrorAlert } from '../../components/ErrorAlert'
import { ConfirmDialog, found, KeptAsync, Person, RowMenu, SearchBox, SettingsPage, useAction } from './shared'

function NewUser({ onClose }: { onClose: (created: boolean) => void }) {
  const { t } = useTranslation()
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [isOrgAdmin, setOrgAdmin] = useState(false)
  const action = useAction()
  const ready = Boolean(email && displayName.trim() && password)
  const save = () => void action.run(() => unwrap(api.POST('/users', { body: { email, displayName, password, isOrgAdmin } })), () => onClose(true))

  return (
    <Dialog
      open
      width={480}
      title={t('user.add')}
      onClose={() => !action.busy && onClose(false)}
      actions={<>
        <Button disabled={action.busy} onClick={() => onClose(false)}>{t('common.cancel')}</Button>
        <Button variant="primary" loading={action.busy} disabled={!ready} onClick={save}>{t('common.save')}</Button>
      </>}
    >
      <form className="stack" onSubmit={(event) => { event.preventDefault(); if (ready) save() }}>
        <Field label={t('auth.email')} htmlFor="user-email" required>
          <Input id="user-email" value={email} onChange={setEmail} />
        </Field>
        <Field label={t('auth.displayName')} htmlFor="user-name" required>
          <Input id="user-name" value={displayName} onChange={setDisplayName} />
        </Field>
        <Field label={t('member.initialPassword')} htmlFor="user-password" required hint={t('member.initialPasswordHint')}>
          <Input id="user-password" type="password" value={password} onChange={setPassword} />
        </Field>
        <Checkbox checked={isOrgAdmin} onChange={setOrgAdmin}>
          {t('user.orgAdmin')} · <span className="note">{t('user.orgAdminHint')}</span>
        </Checkbox>
        {action.error && <ErrorAlert error={action.error} />}
      </form>
    </Dialog>
  )
}

/** An administrator sets someone's password. */
function ResetPassword({ user, onClose }: { user: User; onClose: (changed: boolean) => void }) {
  const { t } = useTranslation()
  const [password, setPassword] = useState('')
  const action = useAction()
  const save = () => void action.run(() => unwrap(api.PATCH('/users/{id}', { params: { path: { id: user.id } }, body: { password } })), () => onClose(true))
  return (
    <Dialog
      open
      width={440}
      title={t('user.resetPasswordOf', { name: user.displayName })}
      onClose={() => !action.busy && onClose(false)}
      actions={<>
        <Button disabled={action.busy} onClick={() => onClose(false)}>{t('common.cancel')}</Button>
        <Button variant="primary" loading={action.busy} disabled={!password} onClick={save}>{t('common.save')}</Button>
      </>}
    >
      <form className="stack" onSubmit={(event) => { event.preventDefault(); if (password) save() }}>
        <Field label={t('account.newPassword')} htmlFor="user-new-password" required hint={t('member.initialPasswordHint')}>
          <Input id="user-new-password" type="password" value={password} onChange={setPassword} invalid={Boolean(action.error)} />
        </Field>
        {action.error && <ErrorAlert error={action.error} />}
      </form>
    </Dialog>
  )
}

/** What is asked before it is done to someone's account. */
type Step = 'password' | 'admin' | 'disable'

export function Users() {
  const { t } = useTranslation()
  const toast = useToast()
  const session = useSession()
  const me = session.state.status === 'ok' ? session.state.data.user?.id : undefined
  const users = useAsync(() => unwrap(api.GET('/users')), [], { keepData: true })
  const [adding, setAdding] = useState(false)
  const [search, setSearch] = useState('')
  const [pending, setPending] = useState<{ step: Step; user: User }>()
  const action = useAction()
  const change = (user: User, body: { status?: User['status']; isOrgAdmin?: boolean }) => unwrap(api.PATCH('/users/{id}', { params: { path: { id: user.id } }, body }))
  const named = (user: User) => ({ name: user.displayName })

  return (
    <SettingsPage title={t('settings.users')} hint={t('user.hint')} actions={<Button variant="primary" onClick={() => setAdding(true)}>{t('user.add')}</Button>}>
      <div className="settings-toolbar"><SearchBox value={search} onChange={setSearch} /></div>
      {action.error && <ErrorAlert error={action.error} />}
      <KeptAsync state={users} reload={users.reload}>
        {(rows) => (
          <DataTable
            aria-label={t('settings.users')}
            rows={rows.filter((user) => found(search, user.displayName, user.email))}
            rowKey={(row) => row.id}
            pageSize={20}
            empty={t('common.none')}
            columns={[
              {
                key: 'user',
                title: t('member.users'),
                render: (row) => <Person name={row.displayName} email={row.email} marks={<>
                  {row.isOrgAdmin && <span className="chip">{t('user.orgAdmin')}</span>}
                  {row.status === 'disabled' && <span className="chip warning">{t('member.statuses.disabled')}</span>}
                  {row.id === me && <span className="note small">{t('member.you')}</span>}
                </>} />,
              },
              {
                key: 'actions',
                title: '',
                width: 48,
                // No one changes their own standing; their password is changed in their own settings.
                render: (row) => row.id === me ? null : <RowMenu label={t('settings.actionsOf', named(row))} items={[
                  { key: 'password', label: t('user.resetPassword'), onSelect: () => setPending({ step: 'password', user: row }) },
                  { key: 'admin', label: t(row.isOrgAdmin ? 'user.removeOrgAdmin' : 'user.makeOrgAdmin'), onSelect: () => setPending({ step: 'admin', user: row }) },
                  row.status === 'active'
                    ? { key: 'disable', label: t('member.disable'), danger: true, separated: true, onSelect: () => setPending({ step: 'disable', user: row }) }
                    : { key: 'enable', label: t('member.enable'), separated: true, onSelect: () => void action.run(() => change(row, { status: 'active' }), users.reload) },
                ]} />,
              },
            ]}
          />
        )}
      </KeptAsync>
      {adding && <NewUser onClose={(created) => { setAdding(false); if (created) users.reload() }} />}
      {pending?.step === 'password' && <ResetPassword user={pending.user} onClose={(changed) => { setPending(undefined); if (changed) toast(t('user.passwordReset', named(pending.user))) }} />}
      {pending?.step === 'admin' && (
        <ConfirmDialog
          title={t(pending.user.isOrgAdmin ? 'user.removeOrgAdmin' : 'user.makeOrgAdmin')}
          confirmLabel={t(pending.user.isOrgAdmin ? 'user.removeOrgAdmin' : 'user.makeOrgAdmin')}
          danger={false}
          onConfirm={() => change(pending.user, { isOrgAdmin: !pending.user.isOrgAdmin })}
          onClose={(done) => { setPending(undefined); if (done) users.reload() }}
        >
          {t(pending.user.isOrgAdmin ? 'user.removeOrgAdminNote' : 'user.makeOrgAdminNote', named(pending.user))}
        </ConfirmDialog>
      )}
      {pending?.step === 'disable' && (
        <ConfirmDialog
          title={t('user.disableNamed', named(pending.user))}
          confirmLabel={t('member.disable')}
          onConfirm={() => change(pending.user, { status: 'disabled' })}
          onClose={(done) => { setPending(undefined); if (done) users.reload() }}
        >
          {t('user.disableNote', named(pending.user))}
        </ConfirmDialog>
      )}
    </SettingsPage>
  )
}
