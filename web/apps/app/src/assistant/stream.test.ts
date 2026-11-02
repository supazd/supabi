import { describe, expect, it } from 'vitest'
import { citedOf, eventParser, groupParts, messageText, withText, withTool, type AnswerSource, type AssistantEvent, type AssistantMessagePart } from './stream'

describe('eventParser', () => {
  it('passes on each event, however what arrives is cut', () => {
    const events: AssistantEvent[] = []
    const parse = eventParser((event) => events.push(event))
    const stream = 'data: {"type":"status","status":"thinking"}\n\n: ping\n\ndata: {"type":"delta","text":"你好"}\n\ndata: {"type":"delta","text":"，世界"}\n\n'
    for (const piece of [stream.slice(0, 7), stream.slice(7, 50), stream.slice(50, 51), stream.slice(51)]) parse(piece)
    expect(events).toEqual([
      { type: 'status', status: 'thinking' },
      { type: 'delta', text: '你好' },
      { type: 'delta', text: '，世界' },
    ])
  })

  it('waits for the end of an event', () => {
    const events: AssistantEvent[] = []
    const parse = eventParser((event) => events.push(event))
    parse('data: {"type":"title","title":"销售"}\n')
    expect(events).toEqual([])
    parse('\n')
    expect(events).toEqual([{ type: 'title', title: '销售' }])
  })
})

describe('messageText', () => {
  it('joins the text parts', () => {
    expect(messageText({ id: 'm', seq: 1, role: 'assistant', status: 'done', createdAt: '', parts: [{ type: 'text', text: '一' }, { type: 'text', text: '二' }] })).toBe('一二')
  })
})

describe('the parts of an answer as it is written', () => {
  it('writes text on until a tool is called, and anew after it', () => {
    let parts: AssistantMessagePart[] = []
    parts = withText(withText(parts, '我查'), '一下')
    parts = withTool(parts, { type: 'tool', callId: 'c1', tool: 'query_chart', done: false })
    parts = withTool(parts, { type: 'tool', callId: 'c1', tool: 'query_chart', done: true, subject: '看板 › 营收' })
    parts = withText(parts, '是 100 [1]')
    expect(parts).toEqual([
      { type: 'text', text: '我查一下' },
      { type: 'tool', callId: 'c1', tool: 'query_chart', done: true, subject: '看板 › 营收' },
      { type: 'text', text: '是 100 [1]' },
    ])
  })

  it('puts tools called one after another together, and numbers the sources', () => {
    const source = (n: number) => ({ n }) as AnswerSource
    const parts: AssistantMessagePart[] = [
      { type: 'tool', callId: 'a', source: source(2) },
      { type: 'tool', callId: 'b' },
      { type: 'text', text: '好' },
      { type: 'tool', callId: 'c', source: source(1) },
      { type: 'tool', callId: 'd', calculation: { n: 3, expression: 'a - b', inputs: [], result: '1' } },
    ]
    expect(groupParts(parts).map((group) => (group.kind === 'text' ? group.text : group.parts.map((part) => part.callId).join('')))).toEqual(['ab', '好', 'cd'])
    expect(citedOf(parts).map((cited) => `${cited.n}${cited.calculation ? '=' : ''}`)).toEqual(['1', '2', '3='])
  })
})
