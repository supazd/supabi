import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from 'i18next'
import '../i18n'
import type { Schemas } from '../api/client'

type Notification = Schemas['Notification']
type Options = { signal?: AbortSignal; params?: { path?: Record<string, string>; query?: Record<string, string | undefined> } }

const server = vi.hoisted(() => ({
  get: vi.fn<(path: string, options?: Options) => Promise<unknown>>(),
  post: vi.fn<(path: string, options?: Options) => Promise<unknown>>(),
}))
vi.mock('../api/client', async (original) => ({
  ...(await original<typeof import('../api/client')>()),
  api: { GET: server.get, POST: server.post },
}))
import { AnnouncementBanner, NotificationBell, NotificationsProvider } from './Notifications'

const response = (data?: unknown) => Promise.resolve({ data, response: { ok: true } })
const notice = (id: string, title: string, extra: Partial<Notification> = {}): Notification => ({
  id, kind: 'announcement', category: 'system', title, body: '', startsAt: '2026-11-09T01:00:00Z', endsAt: '2099-11-16T01:00:00Z', unread: true, ...extra,
})
const maintenance = notice('n1', 'Maintenance on Saturday', { body: 'The service stops **from 22:00**.' })
const late = notice('n2', 'Sales data is late', { category: 'workspace', workspaceId: 'ws_main', workspaceName: 'Main' })
const other = notice('n3', 'New dashboard in Other', { category: 'workspace', workspaceId: 'ws_other', workspaceName: 'Other' })

let summary: Schemas['NotificationSummary']
beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  summary = { unread: 4, banner: [maintenance, late], bannerTotal: 3, refreshSeconds: 60 }
  server.get.mockReset().mockImplementation((path, options) => {
    if (path === '/notifications/summary') return response(summary)
    const category = options?.params?.query?.category
    const items = [maintenance, late, other].filter((item) => !category || item.category === category)
    return response({ items })
  })
  server.post.mockReset().mockImplementation((path, options) => {
    if (path === '/notifications/{id}/read') {
      const id = options?.params?.path?.id
      summary = { ...summary, unread: summary.unread - 1, banner: summary.banner.filter((item) => item.id !== id), bannerTotal: summary.bannerTotal - 1 }
    }
    if (path === '/notifications/read') summary = { ...summary, unread: 0, banner: [], bannerTotal: 0 }
    return response()
  })
})
afterEach(cleanup)

function show() {
  render(<NotificationsProvider><NotificationBell disabled={false} /><AnnouncementBanner /></NotificationsProvider>)
}

describe('notifications', () => {
  it('shows the unread count and the banner, and reads one from it', async () => {
    show()
    expect(await screen.findByLabelText('Unread notifications: 4')).toBeTruthy()
    const banner = screen.getByRole('region', { name: 'Announcements' })
    expect(within(banner).getByText('Maintenance on Saturday')).toBeTruthy()
    expect(within(banner).getByText('Sales data is late')).toBeTruthy()
    expect(within(banner).getByRole('button', { name: '1 more announcement' })).toBeTruthy()
    // Only one with a body can be opened in full.
    expect(within(banner).getAllByRole('button', { name: 'View' })).toHaveLength(1)

    fireEvent.click(within(banner).getByRole('button', { name: 'View' }))
    const dialog = await screen.findByRole('dialog', { name: 'Maintenance on Saturday' })
    expect(within(dialog).getByText('from 22:00').tagName).toBe('STRONG')
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Got it' })) })
    expect(server.post).toHaveBeenCalledWith('/notifications/{id}/read', { params: { path: { id: 'n1' } } })
    await waitFor(() => expect(screen.queryByText('Maintenance on Saturday')).toBeNull())
    expect(await screen.findByLabelText('Unread notifications: 3')).toBeTruthy()
  })

  it('lists every workspace in the bell, by tab, and marks what is opened read', async () => {
    show()
    await screen.findByLabelText('Unread notifications: 4')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Notifications' })) })
    const panel = await screen.findByRole('dialog', { name: 'Notifications' })
    expect(await within(panel).findByText('New dashboard in Other')).toBeTruthy()
    expect(within(panel).getByText(/^Other ·/)).toBeTruthy()
    expect(within(panel).getByText(/^System ·/)).toBeTruthy()

    // Tabs switch on the press of the pointer.
    fireEvent.mouseDown(within(panel).getByRole('tab', { name: 'System announcements' }), { button: 0, ctrlKey: false })
    await waitFor(() => expect(within(panel).queryByText('New dashboard in Other')).toBeNull())
    expect(server.get).toHaveBeenLastCalledWith('/notifications', expect.objectContaining({ params: { query: { category: 'system', before: undefined } } }))

    await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: /Maintenance on Saturday/ })) })
    expect(within(panel).getByText('from 22:00')).toBeTruthy()
    expect(server.post).toHaveBeenCalledWith('/notifications/{id}/read', { params: { path: { id: 'n1' } } })

    await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: 'Mark all as read' })) })
    expect(server.post).toHaveBeenCalledWith('/notifications/read')
    await waitFor(() => expect(screen.queryByLabelText(/Unread notifications/)).toBeNull())
  })

  it('opens the bell from the line that says there are more', async () => {
    show()
    fireEvent.click(await screen.findByRole('button', { name: '1 more announcement' }))
    expect(await screen.findByRole('dialog', { name: 'Notifications' })).toBeTruthy()
  })
})
