import { Button, Dialog } from '@supabi/ui'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, unwrap, type ApiError, type Subject } from '../api/client'
import { toApiError, useAsync } from '../api/useAsync'
import { Async } from './Async'
import { ErrorAlert } from './ErrorAlert'
import { SubjectPicker, loadDirectory, type Directory } from './SubjectPicker'

function Grants({ dashboardId, directory, initial, onClose }: { dashboardId: string; directory: Directory; initial: Subject[]; onClose: () => void }) {
  const { t } = useTranslation()
  const [subjects, setSubjects] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await unwrap(api.PUT('/dashboards/{id}/grants', { params: { path: { id: dashboardId } }, body: { subjects } }))
      onClose()
    } catch (e) {
      setError(toApiError(e))
    } finally {
      setSaving(false)
    }
  }
  return (
    <Dialog open title={t('dashboard.grants.title')} onClose={onClose}
      actions={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={saving} onClick={() => void save()}>{t('common.save')}</Button></>}>
      <div className="stack">
        <p className="note">{t('dashboard.grants.hint')}</p>
        <SubjectPicker wrap aria-label={t('dashboard.grants.title')} directory={directory} value={subjects} onChange={setSubjects} />
        {error && <ErrorAlert error={error} />}
      </div>
    </Dialog>
  )
}

/** Who may see a dashboard. Saved on its own, apart from the dashboard. */
export function DashboardGrantsDialog({ dashboardId, onClose }: { dashboardId: string; onClose: () => void }) {
  const { t } = useTranslation()
  const loaded = useAsync(async () => {
    const [directory, grants] = await Promise.all([loadDirectory(), unwrap(api.GET('/dashboards/{id}/grants', { params: { path: { id: dashboardId } } }))])
    return { directory, subjects: grants.subjects }
  }, [dashboardId])
  if (loaded.status === 'ok') return <Grants dashboardId={dashboardId} directory={loaded.data.directory} initial={loaded.data.subjects} onClose={onClose} />
  return (
    <Dialog open title={t('dashboard.grants.title')} onClose={onClose} actions={<Button onClick={onClose}>{t('common.cancel')}</Button>}>
      <Async state={loaded} reload={loaded.reload}>{() => null}</Async>
    </Dialog>
  )
}
