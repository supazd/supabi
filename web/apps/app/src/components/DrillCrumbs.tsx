import { useTranslation } from 'react-i18next'
import { stepText, type DrillPosition } from '../lib/drill'
import { Icon } from './Icon'
import './drill.css'

/**
 * Where a chart has been drilled down to: the first level, then each value
 * clicked on the way. Any but the last goes back there. Nothing at the first
 * level. See .agents/design/chart-dashboard.md §2.10.
 */
export function DrillCrumbs({ position, onBack }: { position: DrillPosition | undefined; onBack: (depth: number) => void }) {
  const { t } = useTranslation()
  if (!position?.steps.length) return null
  const crumbs = [position.root, ...position.steps.map((step) => stepText(step, t))]
  return (
    <nav className="drill-crumbs" aria-label={t('drill.levels')}>
      <span className="drill-crumbs-label"><Icon name="layers" size={14} />{t('drill.levelsLabel')}</span>
      <ol>
        {crumbs.map((text, depth) => (
          <li key={depth}>
            {depth === crumbs.length - 1
              ? <span aria-current="location" title={text}>{text}</span>
              : <button type="button" title={t('drill.back', { name: text })} onClick={() => onBack(depth)}>{text}</button>}
          </li>
        ))}
      </ol>
    </nav>
  )
}
