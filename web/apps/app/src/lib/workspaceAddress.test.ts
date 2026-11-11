import { describe, expect, it } from 'vitest'
import { addressIn, withinWorkspace, workspaceOf } from './workspaceAddress'

describe('the workspace in an address', () => {
  it('is what follows /w/ at the front, and nothing else', () => {
    expect(workspaceOf('/w/ws_sales/dashboards/db1')).toBe('ws_sales')
    expect(workspaceOf('/w/ws_sales')).toBe('ws_sales')
    expect(workspaceOf('/w/ws%20a/')).toBe('ws a')
    expect(workspaceOf('/dashboards/db1')).toBeUndefined()
    expect(workspaceOf('/workbench/w/ws_sales')).toBeUndefined()
    expect(workspaceOf('/w/')).toBeUndefined()
    expect(workspaceOf('/w/%E0%A4%A/x')).toBeUndefined()
  })

  it('goes in front of the app’s own path', () => {
    expect(withinWorkspace('ws_sales')).toBe('/w/ws_sales/')
    expect(withinWorkspace('ws_sales', '/settings/workspace/general')).toBe('/w/ws_sales/settings/workspace/general')
    expect(withinWorkspace('ws a', '/explore')).toBe('/w/ws%20a/explore')
  })

  it('leads an address that names none to the same page in the workspace last chosen', () => {
    expect(addressIn({ pathname: '/', search: '', hash: '' }, 'ws_main')).toBe('/w/ws_main/')
    expect(addressIn({ pathname: '/workbench/charts/ch1', search: '?tab=data', hash: '#top' }, 'ws_main')).toBe('/w/ws_main/workbench/charts/ch1?tab=data#top')
  })

  it('leads an old share link to the workspace it carries, whichever was last chosen', () => {
    expect(addressIn({ pathname: '/dashboards/db1', search: '?ws=ws_sales&view=dv1', hash: '' }, 'ws_main')).toBe('/w/ws_sales/dashboards/db1?view=dv1')
    expect(addressIn({ pathname: '/dashboards/db1', search: '?ws=ws_sales', hash: '' }, undefined)).toBe('/w/ws_sales/dashboards/db1')
  })

  it('leads nowhere for someone with no workspace', () => {
    expect(addressIn({ pathname: '/settings/account', search: '', hash: '' }, undefined)).toBeUndefined()
  })
})
