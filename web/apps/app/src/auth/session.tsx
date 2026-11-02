import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, unauthenticatedEvent, unwrap, type Schemas } from '../api/client'
import { toApiError, type AsyncState } from '../api/useAsync'

export type SessionInfo = Schemas['SessionInfo']

/** A member's role in a workspace; see internal/authz/role.go. */
export type Role = Schemas['WorkspaceRole']

/** The roles from least to most able: each can do what those before it can. */
export const roles: Role[] = ['viewer', 'developer', 'admin']

/** Whether role can do what min can. No role is below every role. */
export function atLeast(role: Role | undefined, min: Role): boolean {
  return role !== undefined && roles.indexOf(role) >= roles.indexOf(min)
}

interface SessionContext {
  state: AsyncState<SessionInfo>
  /** Replaces the session after signing in or out. */
  set: (info: SessionInfo) => void
  reload: () => void
  /** The user's role in the current workspace, if they hold one. */
  role?: Role
  /** Whether the user's role is at least min. Hides what the server would refuse anyway. */
  atLeast: (min: Role) => boolean
  /** Organisation administrators manage accounts, groups and workspaces. */
  isOrgAdmin: boolean
}

const Context = createContext<SessionContext | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AsyncState<SessionInfo>>({ status: 'loading' })

  const reload = useCallback(() => {
    unwrap(api.GET('/auth/session')).then(
      (data) => setState({ status: 'ok', data }),
      (error: unknown) => setState({ status: 'error', error: toApiError(error) }),
    )
  }, [])

  useEffect(() => {
    reload()
    // Any call answered with 401 means the session ended; ask the server where we stand.
    window.addEventListener(unauthenticatedEvent, reload)
    return () => window.removeEventListener(unauthenticatedEvent, reload)
  }, [reload])

  const value = useMemo<SessionContext>(() => {
    const role = state.status === 'ok' ? state.data.role : undefined
    return {
      state,
      reload,
      set: (data) => setState({ status: 'ok', data }),
      role,
      atLeast: (min) => atLeast(role, min),
      isOrgAdmin: state.status === 'ok' && Boolean(state.data.user?.isOrgAdmin),
    }
  }, [state, reload])

  return <Context.Provider value={value}>{children}</Context.Provider>
}

export function useSession(): SessionContext {
  const context = useContext(Context)
  if (!context) throw new Error('useSession must be used inside SessionProvider')
  return context
}

/** How many rows queries return, whatever the page asks for; unknown until the session is. */
export function useQueryRows() {
  const context = useContext(Context)
  return context?.state.status === 'ok' ? context.state.data.queryRows : undefined
}

/** The ISO weekday weeks start on in the workspace; Monday until the session says otherwise. */
export function useWeekStart(): number {
  const context = useContext(Context)
  return context?.state.status === 'ok' ? context.state.data.workspace?.weekStart ?? 1 : 1
}

/** The workspace's time zone, in which queries take today to be; undefined until the session says. */
export function useWorkspaceTimezone(): string | undefined {
  const context = useContext(Context)
  return context?.state.status === 'ok' ? context.state.data.workspace?.timezone : undefined
}

/** How many days of a year's first week the workspace counts in that year, which numbers weeks; 4, ISO 8601's, until the session says otherwise. */
export function useFirstWeekDays(): number {
  const context = useContext(Context)
  return context?.state.status === 'ok' ? context.state.data.workspace?.firstWeekDays ?? 4 : 4
}
