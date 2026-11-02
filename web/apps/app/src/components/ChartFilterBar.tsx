import { Popover, Segmented } from '@supabi/ui'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { defaultFilterStyle, type FilterStyle } from '../lib/filterStyle'
import { Icon } from './Icon'
import './chartFilterBar.css'

/** Chart authors choose the layout; dashboards use the saved presentation. */
export function ChartFilterBar({ children, style = defaultFilterStyle, onStyleChange, disabled = false, className = '' }: {
  children: ReactNode
  style?: FilterStyle
  onStyleChange?: (style: FilterStyle) => void
  disabled?: boolean
  className?: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <div className={`widget-filters chart-filter-bar ${className}`} data-layout={style.layout} data-density={style.density} role="group" aria-label={t('explore.filters')}>
      {children}
      {onStyleChange && <Popover open={open && !disabled} onOpenChange={setOpen} width={304} content={
        <FilterStyleSettings style={style} onChange={onStyleChange} />
      }>
        <button type="button" className="wb-icon-button chart-filter-settings-trigger" aria-label={t('filterStyle.title')} title={t('filterStyle.title')} disabled={disabled}>
          <Icon name="settings" size={16} />
        </button>
      </Popover>}
    </div>
  )
}

/** The same presentation controls are used by chart bars and the query container. */
export function FilterStyleSettings({ style = defaultFilterStyle, onChange }: { style?: FilterStyle; onChange: (style: FilterStyle) => void }) {
  const { t } = useTranslation()
  return (
    <div className="chart-filter-settings">
      <strong>{t('filterStyle.title')}</strong>
      <div className="chart-filter-setting">
        <span className="note small">{t('filterStyle.layout')}</span>
        <Segmented block aria-label={t('filterStyle.layout')} value={style.layout} onChange={(layout) => onChange({ ...style, layout })}
          options={(['horizontal', 'vertical'] as const).map((value) => ({ value, label: <span className="filter-layout-option"><span className={`filter-layout-icon ${value}`} aria-hidden="true"><i /><i /></span>{t(`filterStyle.${value}`)}</span> }))} />
      </div>
      <div className="chart-filter-setting">
        <span className="note small">{t('filterStyle.density')}</span>
        <Segmented block aria-label={t('filterStyle.density')} value={style.density} onChange={(density) => onChange({ ...style, density })}
          options={(['compact', 'normal', 'comfortable'] as const).map((value) => ({ value, label: t(`filterStyle.${value}`) }))} />
      </div>
    </div>
  )
}
