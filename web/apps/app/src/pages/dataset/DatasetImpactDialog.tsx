import { Alert, Button, Dialog } from '@supabi/ui'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import type { ApiError, Schemas } from '../../api/client'
import { ErrorAlert } from '../../components/ErrorAlert'
import { Icon } from '../../components/Icon'
import './datasetImpactDialog.css'

/** Describes the saved resources that the proposed dataset definition affects. */
export function DatasetImpactDialog({ impact, saving, error, onCancel, onConfirm }: {
  impact: Schemas['DatasetImpact']
  saving: boolean
  error?: ApiError
  onCancel: () => void
  onConfirm: () => void
}) {
  const { t } = useTranslation()
  const changeText = (index: number) => {
    const change = impact.changes[index]
    if (!change) return ''
    return t(`dataset.impact.reasons.${change.kind}.${change.reason}`, { name: change.label || change.key })
  }
  const reasons = (indexes: number[]) => [...new Set(indexes.map(changeText).filter(Boolean))]
  return <Dialog open title={t('dataset.impact.title')} width={720} onClose={onCancel} actions={<>
    <Button disabled={saving} onClick={onCancel}>{t('dataset.impact.keepEditing')}</Button>
    <Button variant="primary" danger loading={saving} onClick={onConfirm}>{saving ? t('common.saving') : t('dataset.impact.confirm')}</Button>
  </>}>
    <div className="dataset-impact-dialog">
      <Alert tone="warning" title={t('dataset.impact.summary', { charts: impact.charts.length, dashboards: impact.dashboards.length })}>
        {t('dataset.impact.description')}
      </Alert>
      {error && <ErrorAlert error={error} />}
      <p className="note small">{t('dataset.impact.openHint')}</p>
      <section>
        <h3>{t('dataset.impact.changes')}</h3>
        <ul className="dataset-impact-changes">{impact.changes.map((change, index) => <li key={`${change.kind}:${change.key}:${change.reason}`}>{changeText(index)}</li>)}</ul>
      </section>
      {impact.charts.length > 0 && <section>
        <h3>{t('dataset.impact.charts', { count: impact.charts.length })}</h3>
        <ul className="dataset-impact-resources">{impact.charts.map((chart) => <li key={chart.id}>
          <Link to={`/workbench/charts/${encodeURIComponent(chart.id)}`} target="_blank" rel="noopener noreferrer"><Icon name="chart" /><span>{chart.name}</span><Icon name="external" /></Link>
          <ul>{reasons(chart.changeIndexes).map((reason) => <li key={reason}>{reason}</li>)}</ul>
        </li>)}</ul>
      </section>}
      {impact.dashboards.length > 0 && <section>
        <h3>{t('dataset.impact.dashboards', { count: impact.dashboards.length })}</h3>
        <ul className="dataset-impact-resources">{impact.dashboards.map((dashboard) => <li key={dashboard.id}>
          <Link to={`/workbench/dashboards/${encodeURIComponent(dashboard.id)}`} target="_blank" rel="noopener noreferrer"><Icon name="dashboard" /><span>{dashboard.name}</span><Icon name="external" /></Link>
          <ul>{reasons(dashboard.changeIndexes).map((reason) => <li key={reason}>{reason}</li>)}</ul>
        </li>)}</ul>
      </section>}
    </div>
  </Dialog>
}
