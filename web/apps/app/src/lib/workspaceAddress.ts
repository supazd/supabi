/**
 * Every page of the app is at `/w/{workspaceId}/…`: a browser tab is in the
 * workspace its address names, and says so with every call it makes. See
 * .agents/design/access-control.md §2.4.
 */

/** The header a call names its workspace in. */
export const workspaceHeader = 'X-SupaBI-Workspace'

/** The workspace an address names at its front, if it names one. */
export function workspaceOf(pathname: string): string | undefined {
  const match = /^\/w\/([^/]+)(?:\/|$)/.exec(pathname)
  if (!match) return undefined
  try {
    return decodeURIComponent(match[1]!)
  } catch {
    return undefined
  }
}

/** The address of a path of the app in a workspace; `/` is the workspace's first page. */
export function withinWorkspace(workspaceId: string, path = '/'): string {
  return `/w/${encodeURIComponent(workspaceId)}${path.startsWith('/') ? path : `/${path}`}`
}

/**
 * Where an address that names no workspace leads: the same page in the
 * workspace an old share link carries as `ws`, or else in the one given, which
 * is the one the session last chose. Undefined when there is neither.
 */
export function addressIn(location: Pick<Location, 'pathname' | 'search' | 'hash'>, workspaceId: string | undefined): string | undefined {
  const search = new URLSearchParams(location.search)
  const carried = search.get('ws') || undefined
  search.delete('ws')
  const target = carried ?? workspaceId
  if (!target) return undefined
  const rest = search.toString()
  return `${withinWorkspace(target, location.pathname)}${rest ? `?${rest}` : ''}${location.hash}`
}

/** The workspace this page is in. It changes only by loading another address. */
export const addressWorkspace = workspaceOf(window.location.pathname)

/** What the app's own paths follow in the address: `/w/{id}`, or nothing at an address that names no workspace. */
export const workspaceBase = addressWorkspace ? `/w/${encodeURIComponent(addressWorkspace)}` : ''
