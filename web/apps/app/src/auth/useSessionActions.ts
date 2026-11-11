import { useRef, useState } from 'react'
import { api, unwrap, type ApiError } from '../api/client'
import { toApiError } from '../api/useAsync'
import { useUnsavedActions } from '../components/UnsavedChanges'
import { useSession } from './session'

/** Keeps the current editors intact until the server has accepted a session change. */
export function useSessionActions(reloadWorkspace: (destination?: string, workspaceId?: string) => void) {
  const session = useSession()
  const { confirmDiscard, confirming, leaveDocument, beginSessionChange } = useUnsavedActions()
  const running = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const recovery = useRef<(() => Promise<void>) | null>(null)
  const checking = useRef(false)
  const [needsRecovery, setNeedsRecovery] = useState(false)
  const [recovering, setRecovering] = useState(false)

  const run = (request: () => Promise<unknown>, complete: () => void, reloadChangedSession = () => reloadWorkspace()) => {
    if (running.current || session.state.status !== 'ok') return
    const before = session.state.data
    setError(null)
    confirmDiscard(() => {
      if (running.current) return
      running.current = true
      const endSessionChange = beginSessionChange()
      setPending(true)
      void (async () => {
        try {
          await request()
          complete()
          // Success replaces the whole workspace or unmounts the signed-in shell.
          // Keep controls locked until then so an old editor cannot write to the new session.
        } catch (failure) {
          const originalError = toApiError(failure)
          // A failed response does not mean the server rolled back: the session
          // may already have changed before the response was lost or failed.
          const reconcile = async () => {
            if (checking.current) return
            checking.current = true
            setRecovering(true)
            try {
              const current = await unwrap(api.GET('/auth/session'))
              if (!current.authenticated) {
                session.set(current)
              } else if (current.user?.id !== before.user?.id || current.workspace?.id !== before.workspace?.id) {
                leaveDocument(reloadChangedSession)
              } else {
                setError(originalError)
                endSessionChange()
                running.current = false
                setPending(false)
              }
              recovery.current = null
              setNeedsRecovery(false)
            } catch (verificationFailure) {
              // Preserve the draft, but do not let it write to an unknown workspace.
              setError(toApiError(verificationFailure))
              recovery.current = reconcile
              setNeedsRecovery(true)
            } finally {
              checking.current = false
              setRecovering(false)
            }
          }
          await reconcile()
        }
      })()
    })
  }

  const switchWorkspace = (workspaceId: string, destination?: string) => {
    if (session.state.status !== 'ok' || workspaceId === session.state.data.workspace?.id) return
    run(
      () => unwrap(api.POST('/auth/workspace', { body: { workspaceId } })),
      () => leaveDocument(() => reloadWorkspace(destination, workspaceId)),
      () => reloadWorkspace(destination, workspaceId),
    )
  }
  const signOut = () => run(
    () => unwrap(api.POST('/auth/logout')),
    // Signed out, not cut off: the sign-in page does not lead back here.
    () => session.set({ authenticated: false, setupRequired: false }, true),
  )

  const retryRecovery = () => { void recovery.current?.() }
  return { switchWorkspace, signOut, busy: pending || confirming, pending, error, needsRecovery, recovering, retryRecovery }
}
