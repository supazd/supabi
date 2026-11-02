import { Button, Dialog } from '@supabi/ui'
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useBlocker, type Location } from 'react-router'

interface UnsavedChanges {
  register: () => () => void
  confirmDiscard: (action: () => void) => void
  confirming: boolean
  isSessionChanging: () => boolean
  beginSessionChange: () => () => void
  /** Only after a successful session change: the departure was already confirmed. */
  leaveDocument: (leave: () => void) => void
}

const Context = createContext<UnsavedChanges | null>(null)

/** Session changes must ask before changing the server session, not during the subsequent reload. */
export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const dirty = useRef(new Set<symbol>())
  const departing = useRef(false)
  const changing = useRef(false)
  const pending = useRef<(() => void) | null>(null)
  const [confirming, setConfirming] = useState(false)

  const register = useCallback(() => {
    const key = Symbol()
    dirty.current.add(key)
    return () => { dirty.current.delete(key) }
  }, [])

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!departing.current && dirty.current.size > 0) event.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])

  const confirmDiscard = useCallback((action: () => void) => {
    // Repeated clicks cannot replace an action that is waiting for an answer.
    if (pending.current) return
    if (dirty.current.size === 0) return action()
    pending.current = action
    setConfirming(true)
  }, [])

  const leaveDocument = useCallback((leave: () => void) => {
    departing.current = true
    try {
      leave()
    } catch (error) {
      departing.current = false
      throw error
    }
  }, [])

  const isSessionChanging = useCallback(() => pending.current !== null || changing.current, [])
  const beginSessionChange = useCallback(() => {
    changing.current = true
    return () => { changing.current = false }
  }, [])

  const cancel = () => {
    pending.current = null
    setConfirming(false)
  }
  const proceed = () => {
    const action = pending.current
    cancel()
    action?.()
  }
  const value = useMemo(() => ({ register, confirmDiscard, confirming, leaveDocument, isSessionChanging, beginSessionChange }), [register, confirmDiscard, confirming, leaveDocument, isSessionChanging, beginSessionChange])

  return (
    <Context.Provider value={value}>
      {children}
      <Dialog
        open={confirming}
        title={t('workbench.leaveTitle')}
        width={420}
        onClose={cancel}
        actions={<><Button onClick={cancel}>{t('workbench.stay')}</Button><Button danger onClick={proceed}>{t('workbench.leave')}</Button></>}
      >
        <p>{t('workbench.leaveBody')}</p>
      </Dialog>
    </Context.Provider>
  )
}

export function useUnsavedActions() {
  const value = useContext(Context)
  if (!value) throw new Error('useUnsavedActions must be used inside UnsavedChangesProvider')
  return value
}

/** Each mounted editor owns its registration, including SQL tabs that are currently hidden. */
export function useUnsavedChanges(dirty: boolean) {
  const { register } = useUnsavedActions()
  useLayoutEffect(() => dirty ? register() : undefined, [dirty, register])
}

/**
 * Asks before work that is not saved is left behind: for another page, for
 * another workspace, or out of the app. `discards` tells of a move within the
 * page that would lose the work all the same.
 */
export function LeaveGuard({ dirty, discards }: { dirty: boolean; discards?: (next: Location) => boolean }) {
  const { t } = useTranslation()
  useUnsavedChanges(dirty)
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && (currentLocation.pathname !== nextLocation.pathname || Boolean(discards?.(nextLocation))) && !(nextLocation.state as { saved?: boolean } | null)?.saved,
  )
  return (
    <Dialog
      open={blocker.state === 'blocked'}
      title={t('workbench.leaveTitle')}
      width={420}
      onClose={() => blocker.reset?.()}
      actions={
        <>
          <Button onClick={() => blocker.reset?.()}>{t('workbench.stay')}</Button>
          <Button danger onClick={() => blocker.proceed?.()}>
            {t('workbench.leave')}
          </Button>
        </>
      }
    >
      <p>{t('workbench.leaveBody')}</p>
    </Dialog>
  )
}
