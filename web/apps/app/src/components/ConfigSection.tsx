import { useId, type ReactNode } from 'react'
import { useStored } from '../lib/useStored'
import { Icon } from './Icon'

/**
 * A group of settings under a heading that folds it away. Whether it is
 * folded is the viewer's own, kept in the browser under `storageKey`, not in
 * what is being edited. Folded, its settings stay where they are, only out of
 * sight, so a value being typed is not lost.
 */
export function ConfigSection({ storageKey, title, children }: { storageKey: string; title: string; children: ReactNode }) {
  const [collapsed, setCollapsed] = useStored(storageKey, false)
  const id = useId()
  return (
    <section className="config-section" aria-labelledby={`${id}-title`}>
      <h2>
        <button type="button" id={`${id}-title`} className="config-section-toggle" aria-expanded={!collapsed} aria-controls={`${id}-body`} onClick={() => setCollapsed(!collapsed)}>
          {title}
          {/* At the end of the bar, pointing up while open and down while folded. */}
          <Icon name="chevronDown" size={12} />
        </button>
      </h2>
      <div id={`${id}-body`} className="config-section-body" hidden={collapsed}>
        {children}
      </div>
    </section>
  )
}
