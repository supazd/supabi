import { CircleCheckIcon, InfoIcon } from 'lucide-react'
import { createContext, useCallback, useContext, type CSSProperties, type ReactNode } from 'react'
import { Toaster, toast } from 'sonner'
import type { ColorScheme } from './tokens'

export interface ToastOptions {
  tone?: 'success' | 'info'
  /** Something to do about what was said, such as taking it back. Doing it puts the message away. */
  action?: { label: string; onSelect: () => void }
}

type Show = (text: ReactNode, options?: ToastOptions) => void

const Context = createContext<Show>(() => undefined)

// shadcn's colours for sonner, which otherwise brings its own.
const style = {
  '--normal-bg': 'var(--popover)',
  '--normal-text': 'var(--popover-foreground)',
  '--normal-border': 'var(--border)',
  '--border-radius': 'var(--radius)',
} as CSSProperties

/**
 * A few words said over the page about something that just happened, which
 * go away by themselves: for what need not stay on the page to be read.
 */
export function ToastHost({ colorScheme = 'light', children }: { colorScheme?: ColorScheme; children: ReactNode }) {
  const show = useCallback<Show>((text, { tone = 'success', action } = {}) => {
    toast(text, {
      icon: tone === 'success' ? <CircleCheckIcon className="tw:size-4 tw:text-(--lb-color-success)" /> : <InfoIcon className="tw:size-4 tw:text-primary" />,
      action: action && { label: action.label, onClick: () => action.onSelect() },
      // One that can be acted on stays long enough to be.
      duration: action ? 6000 : 2500,
    })
  }, [])
  return (
    <Context.Provider value={show}>
      {children}
      <Toaster theme={colorScheme} position="top-center" style={style} toastOptions={{ className: 'lb-toast' }} />
    </Context.Provider>
  )
}

/** Says something over the page. Outside a ThemeProvider nothing is said. */
export const useToast = (): Show => useContext(Context)
