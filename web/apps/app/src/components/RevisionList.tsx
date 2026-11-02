import { Button } from '@supabi/ui'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, unwrap, type Schemas } from '../api/client'
import { toApiError, useAsync } from '../api/useAsync'
import { compactTime } from '../lib/compactTime'
import { Async } from './Async'
import { ErrorAlert } from './ErrorAlert'
import './revisionList.css'

type Kind = 'chart' | 'dashboard'
type Page = Schemas['RevisionPage']

const readPage = (kind: Kind, id: string, before?: number) => unwrap(kind === 'chart'
  ? api.GET('/charts/{id}/revisions', { params: { path: { id }, query: { before } } })
  : api.GET('/dashboards/{id}/revisions', { params: { path: { id }, query: { before } } }))

/**
 * Who saved a chart or dashboard, and when, newest first. Each saved
 * definition is kept on the server but not shown: an old one cannot be
 * brought back on its own (.agents/design/chart-dashboard.md 4.1). revision is
 * the one the editor has as saved, so the list reads again after each save.
 */
export function RevisionList({ kind, id, revision }: { kind: Kind; id?: string; revision?: number }) {
  const { t } = useTranslation()
  const loaded = useAsync(() => (id ? readPage(kind, id) : Promise.resolve(undefined)), [kind, id, revision])
  if (!id) return <p className="note small">{t('revisions.unsaved')}</p>
  return <Async state={loaded} reload={loaded.reload}>{(page) => page && <Revisions key={`${id}:${revision}`} kind={kind} id={id} initial={page} />}</Async>
}

function Revisions({ kind, id, initial }: { kind: Kind; id: string; initial: Page }) {
  const { t, i18n } = useTranslation()
  const [page, setPage] = useState(initial)
  const [more, setMore] = useState(false)
  const [error, setError] = useState<ReturnType<typeof toApiError>>()
  const loadMore = async () => {
    setMore(true); setError(undefined)
    try {
      const next = await readPage(kind, id, page.nextBefore)
      setPage((current) => ({ items: [...current.items, ...next.items], nextBefore: next.nextBefore }))
    } catch (error) { setError(toApiError(error)) } finally { setMore(false) }
  }
  const [latest] = page.items
  const oldest = page.items.at(-1)
  return <div className="content-revisions">
    <ol aria-label={t('revisions.title')}>
      {page.items.map((item) => {
        const at = new Date(item.createdAt)
        const author = item.createdByName || t('revisions.system')
        return <li key={item.revision}>
          <span className="content-revision-label">v{item.revision}</span>
          <time dateTime={item.createdAt} title={at.toLocaleString(i18n.language, { dateStyle: 'full', timeStyle: 'medium' })}>{compactTime(at)}</time>
          <span className="content-revision-author" title={author}>{author}</span>
          {item === latest && <small className="content-revision-current">{t('revisions.current')}</small>}
          {item.name !== latest?.name && <span className="content-revision-name">{t('revisions.namedThen', { name: item.name })}</span>}
        </li>
      })}
    </ol>
    {error && <ErrorAlert error={error} />}
    {page.nextBefore
      ? <div><Button size="sm" loading={more} onClick={() => void loadMore()}>{t('revisions.loadMore')}</Button></div>
      : oldest && oldest.revision > 1 && <p className="note small">{t('revisions.notRecordedBefore', { revision: oldest.revision })}</p>}
  </div>
}
