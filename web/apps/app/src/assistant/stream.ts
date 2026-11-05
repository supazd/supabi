import { ApiError, unauthenticatedEvent, type Schemas } from '../api/client'

export type AssistantEvent = Schemas['AssistantEvent']
export type AssistantMessage = Schemas['AssistantMessage']
export type AssistantMessagePart = Schemas['AssistantMessagePart']
export type AnswerSource = Schemas['AnswerSource']
export type Calculation = Schemas['Calculation']
export type AnswerChart = Schemas['AnswerChart']
export type Conversation = Schemas['Conversation']

/**
 * Sends a request whose answer comes as server-sent events, passing each on
 * as it arrives, and resolves when the server has finished. Aborting the
 * signal stops the answer on the server too; it then resolves quietly. A
 * refusal throws an ApiError, as unwrap does.
 */
export async function streamEvents(path: string, body: unknown, onEvent: (event: AssistantEvent) => void, signal: AbortSignal): Promise<void> {
  let response: Response
  try {
    response = await fetch(`/api/v1${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
  } catch {
    if (signal.aborted) return
    throw new ApiError(0, 'network_error', 'the server cannot be reached')
  }
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as Partial<Schemas['Error']>
    if (response.status === 401 && error.code === 'unauthenticated') window.dispatchEvent(new Event(unauthenticatedEvent))
    throw new ApiError(response.status, error.code ?? 'unexpected_response', error.message ?? response.statusText, error.params)
  }
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const parse = eventParser(onEvent)
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      parse(decoder.decode(value, { stream: true }))
    }
  } catch {
    if (signal.aborted) return
    throw new ApiError(0, 'network_error', 'the connection to the server was lost')
  }
}

/**
 * Splits what arrives into server-sent events, which may be cut anywhere,
 * and passes on the data of each. Comments, which keep the connection open,
 * are skipped.
 */
export function eventParser(onEvent: (event: AssistantEvent) => void): (chunk: string) => void {
  let buffer = ''
  return (chunk) => {
    buffer += chunk
    for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
      const block = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n')
      if (data) onEvent(JSON.parse(data) as AssistantEvent)
    }
  }
}

/** The text of a message: its text parts together. */
export function messageText(message: AssistantMessage): string {
  return message.parts.map((part) => (part.type === 'text' ? (part.text ?? '') : '')).join('')
}

/** The parts of an answer with more text written: onto the text being written, or after a tool as text anew. */
export function withText(parts: AssistantMessagePart[], text: string): AssistantMessagePart[] {
  if (!text) return parts
  const last = parts[parts.length - 1]
  if (last?.type === 'text') return [...parts.slice(0, -1), { ...last, text: (last.text ?? '') + text }]
  return [...parts, { type: 'text', text }]
}

/** The parts of an answer with a tool as it starts, or as it is done in place of how it started. */
export function withTool(parts: AssistantMessagePart[], part: AssistantMessagePart): AssistantMessagePart[] {
  const at = parts.findIndex((entry) => entry.type === 'tool' && entry.callId === part.callId)
  return at < 0 ? [...parts, part] : parts.map((entry, i) => (i === at ? part : entry))
}

/** A run of an answer's parts: its text, tools called one after another, or a chart drawn. */
export type PartGroup = { kind: 'text'; text: string } | { kind: 'tools'; parts: AssistantMessagePart[] } | { kind: 'chart'; chart: AnswerChart }

/** An answer's parts in the order they came, the tools called one after another together. */
export function groupParts(parts: AssistantMessagePart[]): PartGroup[] {
  const out: PartGroup[] = []
  for (const part of parts) {
    const last = out[out.length - 1]
    // A chart drawn is shown where it was drawn, not folded into the steps.
    if (part.chart && part.done && !part.failed) out.push({ kind: 'chart', chart: part.chart })
    else if (part.type === 'tool') {
      if (last?.kind === 'tools') last.parts.push(part)
      else out.push({ kind: 'tools', parts: [part] })
    } else if (part.text) out.push({ kind: 'text', text: part.text })
  }
  return out
}

/** What an answer cites: a chart its figures came from, a figure it worked out from them, or a chart of its own that worked series out. */
export type Cited =
  | { n: number; source: AnswerSource; calculation?: undefined; chart?: undefined }
  | { n: number; calculation: Calculation; source?: undefined; chart?: undefined }
  | { n: number; chart: AnswerChart; source?: undefined; calculation?: undefined }

/** What an answer cites, in the order it numbers them. */
export const citedOf = (parts: AssistantMessagePart[]): Cited[] =>
  parts
    .flatMap((part): Cited[] => {
      if (part.type !== 'tool') return []
      if (part.source) return [{ n: part.source.n, source: part.source }]
      if (part.calculation) return [{ n: part.calculation.n, calculation: part.calculation }]
      if (part.chart?.n) return [{ n: part.chart.n, chart: part.chart }]
      return []
    })
    .sort((a, b) => a.n - b.n)
