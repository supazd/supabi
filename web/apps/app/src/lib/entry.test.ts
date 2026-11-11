import { describe, expect, it } from 'vitest'
import { entryFor, loginAddress, nextAddress } from './entry'

const origin = 'https://bi.example.com'
const at = (address: string) => {
  const url = new URL(address, origin)
  return { pathname: url.pathname, search: url.search, hash: url.hash }
}

describe('the sign-in page', () => {
  it('says where to come back to, unless that is the first page or itself', () => {
    expect(loginAddress(at('/w/ws_main/dashboards/db1?view=dv1#top'))).toBe('/login?next=%2Fw%2Fws_main%2Fdashboards%2Fdb1%3Fview%3Ddv1%23top')
    expect(loginAddress(at('/'))).toBe('/login')
    expect(loginAddress(at('/login?next=/x'))).toBe('/login')
    expect(loginAddress()).toBe('/login')
  })

  it('leads on only to a path of this site', () => {
    expect(nextAddress('?next=%2Fw%2Fws_main%2Fdashboards%2Fdb1%3Fview%3Ddv1%23top', origin)).toBe('/w/ws_main/dashboards/db1?view=dv1#top')
    expect(nextAddress('', origin)).toBe('/')
    for (const elsewhere of ['https://evil.example/', '//evil.example/x', '/\\evil.example', 'javascript:alert(1)', 'dashboards', '/login', '/login?next=/login']) {
      expect(nextAddress(`?${new URLSearchParams({ next: elsewhere })}`, origin)).toBe('/')
    }
  })
})

describe('where an address leads', () => {
  const nobody = { signedIn: false }
  const someone = { signedIn: true, workspaceId: 'ws_main' }

  it('sends someone not signed in to the sign-in page, to come back', () => {
    expect(entryFor(nobody, at('/w/ws_main/workbench/charts/ch1'), origin)).toEqual({ go: '/login?next=%2Fw%2Fws_main%2Fworkbench%2Fcharts%2Fch1' })
    expect(entryFor(nobody, at('/oauth/consent/abc?x=1'), origin)).toEqual({ go: '/login?next=%2Foauth%2Fconsent%2Fabc%3Fx%3D1' })
    expect(entryFor(nobody, at('/'), origin)).toEqual({ go: '/login' })
    expect(entryFor(nobody, at('/login?next=/w/ws_main/explore'), origin)).toEqual({ show: 'signIn' })
  })

  it('does not bring the next person back to where the last one signed out', () => {
    expect(entryFor({ signedIn: false, left: true }, at('/w/ws_main/dashboards/db1'), origin)).toEqual({ go: '/login' })
  })

  it('leads on from the sign-in page once signed in', () => {
    expect(entryFor(someone, at('/login?next=%2Fw%2Fws_sales%2Fexplore'), origin)).toEqual({ go: '/w/ws_sales/explore' })
    expect(entryFor(someone, at('/login'), origin)).toEqual({ go: '/' })
    expect(entryFor(someone, at('/login?next=https%3A%2F%2Fevil.example'), origin)).toEqual({ go: '/' })
  })

  it('puts an address that names no workspace in the one last chosen, or the one an old link carries', () => {
    expect(entryFor(someone, at('/'), origin)).toEqual({ go: '/w/ws_main/' })
    expect(entryFor(someone, at('/dashboards/db1?ws=ws_sales&view=dv1'), origin)).toEqual({ go: '/w/ws_sales/dashboards/db1?view=dv1' })
  })

  it('shows the app at an address in a workspace, the consent page at its own, and the app to someone with no workspace', () => {
    expect(entryFor(someone, at('/w/ws_sales/dashboards'), origin)).toEqual({ show: 'app' })
    expect(entryFor(someone, at('/oauth/consent/abc'), origin)).toEqual({ show: 'consent' })
    expect(entryFor({ signedIn: true }, at('/settings/account'), origin)).toEqual({ show: 'app' })
  })
})
