import { createContext, useContext, type ReactNode } from 'react'
import { useStored } from '../lib/useStored'

/** DOM destinations owned by an editor's frame. */
export type Slots = Record<'side' | 'aside' | 'bottom' | 'status', HTMLElement | null>

interface EditorPanels {
  slots: Slots
  storageKey: string
  bottomOpen: boolean
  setBottomOpen: (open: boolean) => void
  bottomHeight: number
  setBottomHeight: (height: number) => void
}

const Context = createContext<EditorPanels | null>(null)

export function EditorPanelsProvider({ slots, storageKey, children }: { slots: Slots; storageKey: string; children: ReactNode }) {
  const [bottomOpen, setBottomOpen] = useStored(`${storageKey}.bottomOpen`, true)
  const [bottomHeight, setBottomHeight] = useStored(`${storageKey}.bottomHeight`, 280)
  return <Context.Provider value={{ slots, storageKey, bottomOpen, setBottomOpen, bottomHeight, setBottomHeight }}>{children}</Context.Provider>
}

export function useEditorPanels(): EditorPanels {
  const context = useContext(Context)
  if (!context) throw new Error('Editor panels need an EditorPanelsProvider')
  return context
}
