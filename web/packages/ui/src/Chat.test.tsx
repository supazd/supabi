// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatInput, ChatMarkdown, ChatMessage, ChatPending, ChatThread } from './Chat'
import { LocaleContext } from './locale'

afterEach(cleanup)

describe('ChatMarkdown', () => {
  it('shows an image as a link, and loads nothing', () => {
    // The address is the answer's to choose, and could carry what the answer read to wherever it points.
    const { container } = render(<ChatMarkdown text={'![季度图](https://example.com/q.png?d=42) ![](https://example.com/bare.png) ![坏](javascript:alert(1))'} />)
    expect(container.querySelector('img')).toBeNull()
    const links = [...container.querySelectorAll('a')]
    expect(links.map((link) => [link.textContent, link.getAttribute('href'), link.target, link.rel])).toEqual([
      ['季度图', 'https://example.com/q.png?d=42', '_blank', 'noopener noreferrer'],
      ['https://example.com/bare.png', 'https://example.com/bare.png', '_blank', 'noopener noreferrer'],
    ])
    expect(container.textContent).toContain('坏')
  })

  it('makes citations of the sources there are buttons, but not in code', () => {
    const onCite = vi.fn()
    const { container } = render(<ChatMarkdown text={'华东 100 [1]，华南 [3]，`rows[1]`\n\n```\nx[2]\n```'} sources={2} onCite={onCite} />)
    const cites = container.querySelectorAll('sup.lb-chat-cite button')
    expect([...cites].map((button) => button.textContent)).toEqual(['1'])
    expect(container.textContent).toContain('华南 [3]')
    expect(container.querySelector('p code')?.textContent).toBe('rows[1]')
    expect(container.querySelector('pre code')?.textContent).toBe('x[2]\n')
    fireEvent.click(cites[0]!)
    expect(onCite).toHaveBeenCalledWith(1)
  })

  it('renders Markdown with tables, and a single tilde as itself', () => {
    const { container } = render(<ChatMarkdown text={'**加粗** 复购率 20~25%\n\n| 大区 | 销售额 |\n|---|---:|\n| 华东 | 1 |'} />)
    expect(container.querySelector('strong')?.textContent).toBe('加粗')
    expect(container.querySelector('del')).toBeNull()
    expect(container.textContent).toContain('20~25%')
    expect(container.querySelector('table th')?.textContent).toBe('大区')
  })

  it('opens links in a new tab and shows HTML as text', () => {
    const { container } = render(<ChatMarkdown text={'见 [文档](https://example.com/docs)。<b>粗</b><script>alert(1)</script>'} />)
    const link = screen.getByRole('link', { name: '文档' })
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    expect(container.querySelector('b')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
  })

  it('closes what is left open while the answer is written', () => {
    const { container, rerender } = render(<ChatMarkdown text="写到**一半" streaming />)
    expect(container.querySelector('strong')?.textContent).toBe('一半')
    rerender(<ChatMarkdown text="写到**一半" />)
    expect(container.querySelector('strong')).toBeNull()
  })
})

describe('ChatInput', () => {
  function Box({ onSend = vi.fn(), onStop = vi.fn(), writing = false, sendDisabled = false }) {
    const [value, setValue] = useState('')
    return <ChatInput value={value} onChange={setValue} onSend={onSend} onStop={onStop} writing={writing} sendDisabled={sendDisabled} aria-label="Message" />
  }
  const box = () => screen.getByRole('textbox', { name: 'Message' })

  it('sends with Enter, but not with Shift or while an input method picks a word', () => {
    const onSend = vi.fn()
    render(<Box onSend={onSend} />)
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled() // nothing written yet
    fireEvent.change(box(), { target: { value: '你好' } })
    fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true })
    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true })
    fireEvent.keyDown(box(), { key: 'Enter', keyCode: 229 })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(onSend).toHaveBeenCalledTimes(2)
  })

  it('stops the answer being written, and sends nothing while another is', () => {
    const onStop = vi.fn()
    const { rerender } = render(<Box onStop={onStop} writing />)
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(onStop).toHaveBeenCalledTimes(1)
    rerender(<Box sendDisabled />)
    fireEvent.change(box(), { target: { value: '再问' } })
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('names its buttons in the interface language', () => {
    render(
      <LocaleContext value="zh-CN">
        <Box />
      </LocaleContext>,
    )
    expect(screen.getByRole('button', { name: '发送' })).toBeTruthy()
  })
})

describe('ChatThread', () => {
  it('lists the messages of a conversation, the person’s as plain text', () => {
    render(
      <ChatThread aria-label="Conversation">
        <ChatMessage from="user">{'第一行\n第二行'}</ChatMessage>
        <ChatMessage from="assistant" busy>
          <ChatPending>Thinking…</ChatPending>
        </ChatMessage>
      </ChatThread>,
    )
    const log = screen.getByRole('log', { name: 'Conversation' })
    expect(log.querySelector('[data-from="user"]')?.textContent).toBe('第一行\n第二行')
    expect(log.querySelector('[data-from="assistant"]')?.getAttribute('aria-busy')).toBe('true')
    expect(screen.getByRole('status').textContent).toBe('Thinking…')
  })
})
