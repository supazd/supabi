import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import i18n from 'i18next'
import '../i18n'
import { lazyPage, PageFrame } from './LazyPage'

beforeEach(async () => {
  sessionStorage.clear()
  await i18n.changeLanguage('en-US')
})
afterEach(cleanup)

it('shows the page once its code has arrived', async () => {
  const Page = lazyPage(async () => ({ name }: { name: string }) => <p>Hello {name}</p>)
  render(<PageFrame><Page name="Kim" /></PageFrame>)
  expect(screen.getByText(i18n.t('common.loading'))).toBeTruthy()
  expect(await screen.findByText('Hello Kim')).toBeTruthy()
})

it('reloads once when the code of an old version is gone, then says it failed', async () => {
  const reload = vi.fn()
  const missing = () => Promise.reject(new Error('Failed to fetch dynamically imported module'))
  const First = lazyPage(missing, reload)
  render(<PageFrame><First /></PageFrame>)
  await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
  cleanup()

  // The reload came back to the same missing code: no second reload.
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const Again = lazyPage(missing, reload)
  render(<PageFrame><Again /></PageFrame>)
  expect(await screen.findByText(/Failed to fetch dynamically imported module/)).toBeTruthy()
  expect(screen.getByRole('button', { name: i18n.t('common.retry') })).toBeTruthy()
  expect(reload).toHaveBeenCalledTimes(1)
})
