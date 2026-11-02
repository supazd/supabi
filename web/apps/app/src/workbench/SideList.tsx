import { Tooltip } from '@supabi/ui'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useMatch } from 'react-router'
import { ErrorAlert } from '../components/ErrorAlert'
import { Icon, type IconName } from '../components/Icon'
import { useWorkbench, type Section } from './context'

/** The side panel of a part whose resources are few and flat: a list of names. */
export function SideList({ section, icon, items, newPath, newLabel, empty }: { section: Section; icon: IconName; items: { id: string; name: string; detail?: ReactNode; icon?: ReactNode }[]; newPath?: string; newLabel?: string; empty: string }) {
  const { t } = useTranslation()
  const { loaded, error } = useWorkbench()
  const activeId = useMatch(`/workbench/${section}/:id`)?.params.id
  return (
    <>
      <div className="wb-side-header">
        <span className="wb-side-title">{t(`workbench.sections.${section}`)}</span>
        {newPath && (
          <Tooltip title={newLabel}>
            <Link to={newPath} className="wb-icon-button" aria-label={newLabel}>
              <Icon name="plus" />
            </Link>
          </Tooltip>
        )}
      </div>
      {error && <ErrorAlert error={error} />}
      <div className="wb-tree" role="list" aria-label={t(`workbench.sections.${section}`)}>
        {items.length === 0 && <p className="wb-side-empty">{loaded ? empty : t('common.loading')}</p>}
        {items.map((item) => (
          <Link key={item.id} role="listitem" to={`/workbench/${section}/${item.id}`} className={item.id === activeId ? 'wb-row active' : 'wb-row'} style={{ paddingLeft: 12 }} title={item.name}>
            {item.icon ?? <Icon name={icon} />}
            <span className="wb-row-name">{item.name}</span>
            {item.detail && <span className="wb-row-detail">{item.detail}</span>}
          </Link>
        ))}
      </div>
    </>
  )
}
