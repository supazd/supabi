import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { openPopup } from '@supabi/ui/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from 'i18next'
import '../../i18n'
import type { Schemas } from '../../api/client'

const server = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), remove: vi.fn() }))
vi.mock('../../api/client', async (original) => ({
  ...(await original<typeof import('../../api/client')>()),
  api: { GET: server.get, POST: server.post, PUT: server.put, DELETE: server.remove },
}))
import { Announcements } from './Announcements'

const response = (data?: unknown) => Promise.resolve({ data, response: { ok: true } })
const day = 86_400_000
const at = (offset: number) => new Date(Date.now() + offset).toISOString()
const announcement = (id: string, title: string, starts: number, ends: number): Schemas['Announcement'] => ({
  id, title, body: '', startsAt: at(starts), endsAt: at(ends), createdBy: 'Alex', createdAt: at(starts), updatedAt: at(starts),
})
const rows = [
  announcement('a1', 'Upgrade next week', 2 * day, 3 * day),
  announcement('a2', 'Maintenance tonight', -day, day),
  announcement('a3', 'Old news', -10 * day, -9 * day),
]

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  server.get.mockReset().mockImplementation(() => response(rows))
  for (const call of [server.post, server.put, server.remove]) call.mockReset().mockImplementation(() => response(rows[0]))
})
afterEach(cleanup)

describe('Announcements', () => {
  it('lists each with its state, and ends only one in effect', async () => {
    render(<Announcements scope="workspace" />)
    const table = await screen.findByRole('table', { name: 'Announcements' })
    expect(server.get).toHaveBeenCalledWith('/workspace/announcements')
    const row = (title: string) => within(table).getByText(title).closest('tr')!
    expect(within(row('Upgrade next week')).getByText('Scheduled')).toBeTruthy()
    expect(within(row('Maintenance tonight')).getByText('Active')).toBeTruthy()
    expect(within(row('Old news')).getByText('Ended')).toBeTruthy()

    openPopup(screen.getByRole('button', { name: 'More actions for Upgrade next week' }))
    expect(await screen.findByRole('menuitem', { name: 'Delete' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: 'End now' })).toBeNull()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })

    openPopup(screen.getByRole('button', { name: 'More actions for Maintenance tonight' }))
    await act(async () => { fireEvent.click(await screen.findByRole('menuitem', { name: 'End now' })) })
    expect(server.post).toHaveBeenCalledWith('/workspace/announcements/{id}/end', { params: { path: { id: 'a2' } } })
  })

  it('publishes one now for seven days, with a preview of its Markdown', async () => {
    render(<Announcements scope="system" />)
    fireEvent.click(await screen.findByRole('button', { name: 'New announcement' }))
    const dialog = await screen.findByRole('dialog', { name: 'New announcement' })
    fireEvent.change(within(dialog).getByLabelText(/Title/), { target: { value: 'Maintenance on Saturday' } })
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Body/ }), { target: { value: 'Stops **at 22:00**' } })
    // Tabs switch on the press of the pointer.
    fireEvent.mouseDown(within(dialog).getByRole('tab', { name: 'Preview' }), { button: 0, ctrlKey: false })
    await waitFor(() => expect(within(dialog).getByText('at 22:00').tagName).toBe('STRONG'))

    const before = Date.now()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'New announcement' })) })
    await waitFor(() => expect(server.post).toHaveBeenCalled())
    const [path, { body }] = server.post.mock.calls[0] as [string, { body: Schemas['AnnouncementInput'] }]
    expect(path).toBe('/system/announcements')
    expect(body.title).toBe('Maintenance on Saturday')
    expect(body.body).toBe('Stops **at 22:00**')
    // Now is the server's to decide; the end is a week from the browser's now.
    expect(body.startsAt).toBeUndefined()
    expect(Math.abs(Date.parse(body.endsAt) - before - 7 * day)).toBeLessThan(5000)
  })

  it('keeps the period of an ended one as it was when only its text changes', async () => {
    render(<Announcements scope="system" />)
    const table = await screen.findByRole('table', { name: 'Announcements' })
    fireEvent.click(within(within(table).getByText('Old news').closest('tr')!).getByRole('button', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit announcement' })
    fireEvent.change(within(dialog).getByLabelText(/Title/), { target: { value: 'Old news, corrected' } })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Save' })) })
    await waitFor(() => expect(server.put).toHaveBeenCalled())
    expect(server.put).toHaveBeenCalledWith('/system/announcements/{id}', { params: { path: { id: 'a3' } }, body: { title: 'Old news, corrected', body: '', startsAt: rows[2]!.startsAt, endsAt: rows[2]!.endsAt } })
  })
})
