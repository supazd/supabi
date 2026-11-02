import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { openPopup } from '@supabi/ui/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from 'i18next'
import '../../i18n'
import { ApiError, type Schemas } from '../../api/client'

const server = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), remove: vi.fn() }))
vi.mock('../../api/client', async (original) => ({
  ...(await original<typeof import('../../api/client')>()),
  api: { GET: server.get, POST: server.post, PUT: server.put, PATCH: server.patch, DELETE: server.remove },
}))
import { AIModels } from './AIModels'

const response = (data: unknown) => ({ data, response: { ok: true } })
/** Picks an action from the menu of a provider or a model. */
async function choose(of: string, action: string) {
  openPopup(await screen.findByRole('button', { name: `More actions for ${of}` }))
  fireEvent.click(await screen.findByRole('menuitem', { name: action }))
}
const config: Schemas['AIConfig'] = {
  providers: [{ id: 'p1', name: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', hasApiKey: true }],
  models: [
    { id: 'm1', providerId: 'p1', model: 'deepseek-chat', contextTokens: 64000, maxOutputTokens: 8000, currency: 'CNY', inputPrice: '2', cachedInputPrice: '0.5', outputPrice: '8' },
    { id: 'm2', providerId: 'p1', model: 'deepseek-lite', contextTokens: 32000, maxOutputTokens: 4000, currency: 'CNY', inputPrice: '1', outputPrice: '2' },
  ],
  settings: { chatModelId: 'm1', titleModelId: 'm2' },
}

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  server.get.mockReset().mockResolvedValue(response(config))
  for (const call of [server.post, server.put, server.patch, server.remove]) call.mockReset().mockResolvedValue(response({}))
})
afterEach(cleanup)

describe('AIModels', () => {
  it('lists each provider with its models and prices', async () => {
    render(<AIModels />)
    const table = await screen.findByRole('table', { name: 'Models of DeepSeek' })
    expect(within(table).getByText('deepseek-chat')).toBeTruthy()
    // Token counts as providers write them.
    expect(within(table).getByText('64K')).toBeTruthy()
    expect(within(table).getByText('8K')).toBeTruthy()
    expect(within(table).getByText('2 / 0.5 / — / 8 CNY')).toBeTruthy()
    expect(within(table).getByText('1 / — / — / 2 CNY')).toBeTruthy()
    expect(screen.getByText(/OpenAI-compatible · https:\/\/api.deepseek.com\/v1 · Key set/)).toBeTruthy()
  })

  it('sets what each model is for at once; titles may follow the chat model', async () => {
    render(<AIModels />)
    const titles = await screen.findByRole('combobox', { name: 'Titles' })
    expect(titles.textContent).toContain('deepseek-lite · DeepSeek')
    openPopup(titles)
    fireEvent.click(await screen.findByRole('option', { name: 'Same as chat' }))
    await waitFor(() => expect(server.put).toHaveBeenCalledWith('/ai/settings', { body: { chatModelId: 'm1', titleModelId: undefined } }))
  })

  it('suggests what a provider is called', async () => {
    render(<AIModels />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add provider' }))
    expect(screen.getByLabelText(/^Name/).getAttribute('placeholder')).toBe('Such as OpenAI or OpenRouter')
    expect(screen.getByLabelText(/^API address/).getAttribute('placeholder')).toBe('https://api.openai.com/v1')
  })

  it('sends a provider’s key only when it changes', async () => {
    render(<AIModels />)
    await choose('DeepSeek', 'Edit')
    fireEvent.change(screen.getByLabelText(/^API address/), { target: { value: 'https://api.deepseek.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(server.patch).toHaveBeenCalledWith('/ai/providers/{id}', { params: { path: { id: 'p1' } }, body: { name: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com' } }))

    await choose('DeepSeek', 'Edit')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Remove the saved key' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(server.patch).toHaveBeenLastCalledWith('/ai/providers/{id}', expect.objectContaining({ body: expect.objectContaining({ apiKey: '' }) })))
  })

  it('adds a model with optional prices left out', async () => {
    render(<AIModels />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add a model to DeepSeek' }))
    expect(screen.getByLabelText(/^Model ID/).getAttribute('placeholder')).toBe('The model’s name in calls to the provider')
    fireEvent.change(screen.getByLabelText(/^Model ID/), { target: { value: 'deepseek-reasoner' } })
    fireEvent.change(screen.getByLabelText(/^Context length/), { target: { value: '1.0M' } })
    fireEvent.change(screen.getByLabelText(/^Max output/), { target: { value: '256K' } })
    fireEvent.change(screen.getByLabelText(/^Input/), { target: { value: '4' } })
    fireEvent.change(screen.getByLabelText(/^Output/), { target: { value: '16' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(server.post).toHaveBeenCalledWith('/ai/providers/{id}/models', {
        params: { path: { id: 'p1' } },
        body: { model: 'deepseek-reasoner', contextTokens: 1_000_000, maxOutputTokens: 256_000, currency: 'CNY', inputPrice: '4', outputPrice: '16', cachedInputPrice: undefined, cacheWritePrice: undefined, thinkingLevel: undefined },
      }),
    )
  })

  it('says a thinking level only when one is given', async () => {
    render(<AIModels />)
    await choose('deepseek-chat', 'Edit')
    const level = screen.getByLabelText(/^Thinking level/) as HTMLInputElement
    expect(level.value).toBe('')
    fireEvent.change(level, { target: { value: ' max ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(server.patch).toHaveBeenCalledWith('/ai/models/{id}', expect.objectContaining({ body: expect.objectContaining({ thinkingLevel: 'max' }) })))
  })

  it('takes token counts only as numbers, K or M', async () => {
    render(<AIModels />)
    await choose('deepseek-chat', 'Edit')
    const context = screen.getByLabelText(/^Context length/) as HTMLInputElement
    expect(context.value).toBe('64K')
    fireEvent.change(context, { target: { value: '64 thousand' } })
    expect(context.getAttribute('aria-invalid')).toBe('true')
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(context, { target: { value: '128,000' } })
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('finds a currency by its name or symbol', async () => {
    render(<AIModels />)
    await choose('deepseek-chat', 'Edit')
    const currency = screen.getByRole('combobox', { name: 'Currency' })
    expect(currency.textContent).toBe('CNY · CN¥ · Chinese Yuan')
    openPopup(currency)
    fireEvent.change(await screen.findByRole('combobox', { expanded: true, name: '' }), { target: { value: 'US Dollar' } })
    fireEvent.click(await screen.findByRole('option', { name: 'USD · $ · US Dollar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(server.patch).toHaveBeenCalledWith('/ai/models/{id}', expect.objectContaining({ body: expect.objectContaining({ currency: 'USD', contextTokens: 64000 }) })))
  })

  it('deletes a model only once asked, and says why one in use cannot be', async () => {
    server.remove.mockRejectedValueOnce(new ApiError(409, 'ai_model_in_use', 'the model is set for the assistant'))
    render(<AIModels />)
    await choose('deepseek-chat', 'Delete')
    expect(server.remove).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('dialog', { name: 'Delete model: deepseek-chat' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm delete' }))
    await waitFor(() => expect(server.remove).toHaveBeenCalledExactlyOnceWith('/ai/models/{id}', { params: { path: { id: 'm1' } } }))
    // It stays open with the reason, and nothing else is asked of the server.
    expect(await within(dialog).findByRole('alert')).toBeTruthy()
    expect(server.get).toHaveBeenCalledOnce()
  })

  it('tells how a test call went, in the provider’s words when it failed', async () => {
    server.post.mockResolvedValueOnce(response({ ok: true, durationMs: 820, reply: 'OK' }))
    render(<AIModels />)
    const table = await screen.findByRole('table', { name: 'Models of DeepSeek' })
    fireEvent.click(within(table).getByRole('button', { name: 'Test deepseek-chat' }))
    expect(await screen.findByText('deepseek-chat works: 820 ms, replied “OK”.')).toBeTruthy()

    server.post.mockResolvedValueOnce(response({ ok: false, durationMs: 120, error: { code: 'unauthorized', status: 401, message: 'Incorrect API key provided' } }))
    fireEvent.click(within(table).getByRole('button', { name: 'Test deepseek-lite' }))
    expect(await screen.findByText('deepseek-lite failed: The model service refused access. Ask an administrator to check the API key. (HTTP 401)')).toBeTruthy()
    expect(screen.getByText('Incorrect API key provided')).toBeTruthy()
  })
})
