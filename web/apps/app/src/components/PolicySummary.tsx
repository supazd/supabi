import { useTranslation } from 'react-i18next'
import { api, unwrap } from '../api/client'
import { useAsync } from '../api/useAsync'
import { Async } from './Async'

/**
 * The data permissions of a dataset, in a sentence: developers are not
 * limited by them, so they are told viewers may see less.
 */
export function PolicySummary({ datasetId }: { datasetId: string }) {
  const { t } = useTranslation()
  const policy = useAsync(() => unwrap(api.GET('/datasets/{id}/policy', { params: { path: { id: datasetId } } })), [datasetId])
  return (
    <div className="stack policy-summary">
      <Async state={policy} reload={policy.reload}>
        {(p) => (
          <p>
            {p.rows.length === 0 && p.columns.length === 0
              ? t('policy.summaryNone')
              : t('policy.summary', { unmatched: t(p.unmatched === 'all' ? 'policy.summaryAll' : 'policy.summaryNoneSee'), rows: p.rows.length, columns: p.columns.length })}
          </p>
        )}
      </Async>
    </div>
  )
}
