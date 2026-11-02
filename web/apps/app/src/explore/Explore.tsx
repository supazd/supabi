import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EditorPanelsProvider, type Slots } from '../components/EditorPanels'
import { SqlExplore } from './SqlExplore'

/** Data exploration owns its frame, independently of the workbench's resource trees. */
export function Explore({ active }: { active: boolean }) {
  const { t } = useTranslation()
  const [slots, setSlots] = useState<Slots>({ side: null, aside: null, bottom: null, status: null })
  const aside = useCallback((node: HTMLElement | null) => setSlots((current) => ({ ...current, aside: node })), [])
  const bottom = useCallback((node: HTMLElement | null) => setSlots((current) => ({ ...current, bottom: node })), [])
  const status = useCallback((node: HTMLElement | null) => setSlots((current) => ({ ...current, status: node })), [])
  return (
    <EditorPanelsProvider slots={slots} storageKey="supabi.explore">
      <div className="wb explore-page">
        <div className="explore-schema-slot" ref={aside} />
        <div className="wb-center">
          <div className="wb-main"><SqlExplore active={active} /></div>
          <div className="wb-bottom" ref={bottom} />
        </div>
        <footer className="wb-status">
          <span className="wb-status-path">{t('nav.explore')}</span>
          <span className="spacer" />
          <span className="wb-status-items" ref={status} />
        </footer>
      </div>
    </EditorPanelsProvider>
  )
}
