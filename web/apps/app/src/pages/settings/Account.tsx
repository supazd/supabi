import { Button, Field, Input, useToast } from '@supabi/ui'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, unwrap } from '../../api/client'
import { useSession } from '../../auth/session'
import { ErrorAlert } from '../../components/ErrorAlert'
import { SettingsPage, SettingsPart, useAction } from './shared'

export function Account() {
  const { t } = useTranslation()
  const toast = useToast()
  const session = useSession()
  const user = session.state.status === 'ok' ? session.state.data.user : undefined
  const [currentPassword, setCurrent] = useState('')
  const [newPassword, setNew] = useState('')
  const action = useAction()

  const save = () => {
    void action.run(
      () => unwrap(api.POST('/auth/password', { body: { currentPassword, newPassword } })),
      () => {
        setCurrent('')
        setNew('')
        toast(t('account.changed'))
      },
    )
  }

  return (
    <SettingsPage title={t('settings.account')}>
      <dl className="facts">
        <dt>{t('auth.displayName')}</dt>
        <dd>{user?.displayName}</dd>
        <dt>{t('auth.email')}</dt>
        <dd>{user?.email}</dd>
      </dl>
      <SettingsPart title={t('account.changePassword')}>
        <form
          className="stack narrow"
          onSubmit={(event) => {
            event.preventDefault()
            save()
          }}
        >
          <Field label={t('account.currentPassword')} htmlFor="account-current" required>
            <Input id="account-current" type="password" value={currentPassword} onChange={setCurrent} />
          </Field>
          <Field label={t('account.newPassword')} htmlFor="account-new" required hint={t('account.newPasswordHint')}>
            <Input id="account-new" type="password" value={newPassword} onChange={setNew} />
          </Field>
          {action.error && <ErrorAlert error={action.error} />}
          <div>
            <Button variant="primary" type="submit" loading={action.busy} disabled={!currentPassword || !newPassword}>
              {t('account.changePassword')}
            </Button>
          </div>
        </form>
      </SettingsPart>
    </SettingsPage>
  )
}
