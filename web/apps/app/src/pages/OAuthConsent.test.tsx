import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import i18n from 'i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../i18n'
import type { SessionInfo } from '../auth/session'

const server = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
vi.mock('../api/client', async (original) => ({
  ...(await original<typeof import('../api/client')>()),
  api: { GET: server.get, POST: server.post },
}))
import { OAuthConsent } from './OAuthConsent'

const info = { authenticated: true, setupRequired: false, user: { id: 'u', displayName: 'Viewer', email: 'viewer@example.com', isOrgAdmin: false } } as SessionInfo
const response = (data: unknown, status = 200) => (status === 200 ? { data, response: { ok: true, status } } : { error: data, response: { ok: false, status } })

function open(pathname: string, search = '') {
  const go = vi.fn()
  render(<OAuthConsent info={info} location={{ pathname, search }} go={go} />)
  return go
}

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  server.get.mockReset().mockResolvedValue(response({ clientName: 'Test Agent', redirectHost: '127.0.0.1', loopback: true, mcpEnabled: true }))
  server.post.mockReset().mockResolvedValue(response({ redirectTo: 'http://127.0.0.1:33418/callback?code=c&state=st' }))
})
afterEach(cleanup)

describe('consent of an MCP client', () => {
  it('names the client, where the answer goes and who is signed in, and allows it', async () => {
    const go = open('/oauth/consent/oar_1')
    expect(await screen.findByRole('heading', { name: 'Allow Test Agent?' })).toBeTruthy()
    expect(screen.getByText(/a program on this computer \(127\.0\.0\.1\)/)).toBeTruthy()
    expect(screen.getByText('Signed in as Viewer (viewer@example.com)')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    await waitFor(() => expect(server.post).toHaveBeenCalledExactlyOnceWith('/oauth/requests/{id}/approve', { params: { path: { id: 'oar_1' } } }))
    expect(go).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:33418/callback?code=c&state=st')
    expect(screen.getByRole('status').textContent).toContain('Returning to Test Agent')
  })

  it('denies it', async () => {
    open('/oauth/consent/oar_1')
    fireEvent.click(await screen.findByRole('button', { name: 'Deny' }))
    await waitFor(() => expect(server.post).toHaveBeenCalledExactlyOnceWith('/oauth/requests/{id}/deny', { params: { path: { id: 'oar_1' } } }))
  })

  it('cannot allow while MCP is off', async () => {
    server.get.mockResolvedValue(response({ clientName: 'Test Agent', redirectHost: 'claude.ai', loopback: false, mcpEnabled: false }))
    open('/oauth/consent/oar_1')
    expect(await screen.findByText('If you allow it, the answer goes to claude.ai.')).toBeTruthy()
    expect(screen.getByText(/no client can be allowed/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Allow' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('says when the request is gone', async () => {
    server.get.mockResolvedValue(response({ code: 'not_found', message: 'not found' }, 404))
    open('/oauth/consent/oar_1')
    expect(await screen.findByText(/expired or was already answered/)).toBeTruthy()
  })

  it('says what was wrong when there was no request to answer', async () => {
    open('/oauth/consent', '?error=invalid_client')
    expect(screen.getByText(/not registered with SupaBI/)).toBeTruthy()
    expect(server.get).not.toHaveBeenCalled()
  })
})
