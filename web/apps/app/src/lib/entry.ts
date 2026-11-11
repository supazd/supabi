import { addressIn, workspaceOf } from './workspaceAddress'

/**
 * Where an address of the app leads, by who is asking: to the sign-in page
 * and back, to a workspace, or to what it shows. See
 * .agents/design/access-control.md §2.4 and §8.
 */

type Address = Pick<Location, 'pathname' | 'search' | 'hash'>

/** The sign-in page, which is in no workspace. */
export const loginPath = '/login'

const atLogin = (pathname: string) => pathname === loginPath || pathname === `${loginPath}/`

/** The sign-in page, to come back from to the address given; none, or the first page, needs no saying. */
export function loginAddress(from?: Address): string {
  const back = from && !atLogin(from.pathname) ? `${from.pathname}${from.search}${from.hash}` : '/'
  return back === '/' ? loginPath : `${loginPath}?${new URLSearchParams({ next: back })}`
}

/**
 * Where signing in leads: the address `next` carries when it is a path of
 * this site, and the first page otherwise. A link to the sign-in page must
 * not be able to send anyone to another site.
 */
export function nextAddress(search: string, origin: string): string {
  const next = new URLSearchParams(search).get('next')
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return '/'
  let parsed: URL
  try {
    parsed = new URL(next, origin)
  } catch {
    return '/'
  }
  if (parsed.origin !== origin || atLogin(parsed.pathname)) return '/'
  return `${parsed.pathname}${parsed.search}${parsed.hash}`
}

/** What an address shows, or the address to load in its place. */
export type Entry = { go: string } | { show: 'signIn' | 'consent' | 'app' }

/**
 * signedIn is whether anyone is; left, that they have just signed out, and
 * so are not coming back to this address; workspaceId, the workspace the
 * session last chose.
 */
export function entryFor(who: { signedIn: boolean; left?: boolean; workspaceId?: string }, address: Address, origin: string): Entry {
  if (!who.signedIn) {
    if (atLogin(address.pathname)) return { show: 'signIn' }
    return { go: loginAddress(who.left ? undefined : address) }
  }
  if (atLogin(address.pathname)) return { go: nextAddress(address.search, origin) }
  // An MCP client's consent page stands alone, in no workspace.
  if (address.pathname.startsWith('/oauth/consent')) return { show: 'consent' }
  // An address that names no workspace, such as `/`, an old bookmark or an
  // old share link, is replaced with the same page in one.
  if (!workspaceOf(address.pathname)) {
    const within = addressIn(address, who.workspaceId)
    if (within) return { go: within }
  }
  return { show: 'app' }
}
