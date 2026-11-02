import { maxGroupDepth, type ColumnItem } from '@supabi/charts'
import { Button } from '@supabi/ui'
import { useTranslation } from 'react-i18next'
import { fitsInGroup, pickedGroup, type HeaderPick } from '../lib/columnGroups'

/**
 * The bar above a table in the chart editor for grouping its headers: how to
 * pick them, and what can be done with what is picked. It is there whether or
 * not anything is picked, so picking does not move the table.
 */
export function ColumnGroupTools({ layout, pick, onGroup, onRename, onUngroup }: { layout: ColumnItem[]; pick?: HeaderPick; onGroup: () => void; onRename: () => void; onUngroup: () => void }) {
  const { t } = useTranslation()
  const group = pick && pickedGroup(layout, pick)
  return (
    <div className="column-group-tools" role="toolbar" aria-label={t('explore.columnGroups.tools')}>
      {!pick ? null : group ? (
        <>
          <Button size="sm" variant="ghost" onClick={onRename}>{t('explore.columnGroups.rename')}</Button>
          <Button size="sm" variant="ghost" onClick={onUngroup}>{t('explore.columnGroups.ungroup')}</Button>
        </>
      ) : (
        <Button size="sm" variant="ghost" onClick={onGroup} disabled={!fitsInGroup(layout, pick)}>{t('explore.columnGroups.group')}</Button>
      )}
      <span className="note small">{!pick ? t('explore.columnGroups.hint') : !group && !fitsInGroup(layout, pick) ? t('explore.columnGroups.tooDeep', { max: maxGroupDepth }) : t('explore.columnGroups.picked')}</span>
    </div>
  )
}
