import { ArrowDownIcon, ArrowUpIcon, ChevronRightIcon, CircleCheckIcon, CircleXIcon, SquareIcon } from 'lucide-react'
import { createContext, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import Markdown, { type Components, type Options } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remend from 'remend'
import { useStickToBottom } from 'use-stick-to-bottom'
import { Button } from './Button'
import { useStrings } from './locale'
import './chat.css'

// A conversation with the AI assistant: its messages, which follow the end
// while an answer is written, and the box to write in. See
// .agents/design/ai-assistant.md 4.

export interface ChatThreadProps {
  children: ReactNode
  /** Changes when the reader sends something, which takes them back to the end. */
  latest?: unknown
  'aria-label'?: string
}

/**
 * The messages of a conversation, scrolled to the end when it opens. While
 * the reader is at the end it follows what is written; once they scroll up
 * it stays put, and a button takes them back.
 */
export function ChatThread({ children, latest, 'aria-label': ariaLabel }: ChatThreadProps) {
  const t = useStrings()
  const { scrollRef, contentRef, isAtBottom, scrollToBottom, stopScroll } = useStickToBottom({ initial: 'instant', resize: 'smooth' })
  useEffect(() => {
    if (latest !== undefined) void scrollToBottom()
  }, [latest, scrollToBottom])
  const controls = useMemo<ChatThreadControls>(
    () => ({
      reveal: (element) => {
        // At the end, the thread would otherwise follow what was unfolded to show it, and take the reader past it.
        stopScroll()
        bringIntoView(element)
      },
    }),
    [stopScroll],
  )
  return (
    <div className="lb-chat-thread">
      <div ref={scrollRef} className="lb-chat-scroll" role="log" aria-label={ariaLabel}>
        <div ref={contentRef} className="lb-chat-content">
          <ThreadContext value={controls}>{children}</ThreadContext>
        </div>
      </div>
      {!isAtBottom && (
        <span className="lb-chat-latest">
          <Button size="sm" icon={<ArrowDownIcon />} onClick={() => void scrollToBottom()}>
            {t.latest}
          </Button>
        </span>
      )}
    </div>
  )
}

/** What the messages of a thread can do with it. */
export interface ChatThreadControls {
  /** Takes the reader to an element of a message, such as a source, which it focuses; the thread stops following the end. */
  reveal: (element: HTMLElement) => void
}

function bringIntoView(element: HTMLElement) {
  element.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  element.focus({ preventScroll: true })
}

const ThreadContext = createContext<ChatThreadControls>({ reveal: bringIntoView })

/** The thread a message is in. */
export function useChatThread(): ChatThreadControls {
  return useContext(ThreadContext)
}

export interface ChatMessageProps {
  /** Who wrote it. The person's message is plain text in a bubble; the assistant's takes the width. */
  from: 'user' | 'assistant'
  /** Still being written. */
  busy?: boolean
  children: ReactNode
}

export function ChatMessage({ from, busy, children }: ChatMessageProps) {
  return (
    <div className="lb-chat-message" data-from={from} aria-busy={busy || undefined}>
      {from === 'user' ? <div className="lb-chat-bubble">{children}</div> : children}
    </div>
  )
}

/** What an answer is doing before its text arrives, such as thinking. */
export function ChatPending({ children }: { children: ReactNode }) {
  return (
    <p className="lb-chat-pending" role="status">
      <span className="lb-chat-pulse" aria-hidden />
      {children}
    </p>
  )
}

// A single tilde stays itself: Chinese writes ranges as 20~25.
const remarkPlugins: Options['remarkPlugins'] = [[remarkGfm, { singleTilde: false }]]

/** A citation as a link the renderer can tell from others. */
const citePrefix = '#cite-'

/** Code, in a block (still open, while it is written) or inline: its [n] are not citations. */
const code = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/

/** Makes [n] a link to source n, for each n there is, outside code; [n](…) is a link already. */
function linkCitations(text: string, sources: number): string {
  if (!sources) return text
  return text
    .split(code)
    .map((piece, i) => (i % 2 ? piece : piece.replace(/\[(\d{1,3})\](?!\()/g, (whole, n: string) => (Number(n) >= 1 && Number(n) <= sources ? `[${n}](${citePrefix}${n})` : whole))))
    .join('')
}

/** A citation of source n: a small number that goes to it. */
export function ChatCite({ n, onCite }: { n: number; onCite?: (n: number) => void }) {
  return (
    <sup className="lb-chat-cite">
      <button type="button" onClick={() => onCite?.(n)}>
        {n}
      </button>
    </sup>
  )
}

export interface ChatMarkdownProps {
  text: string
  /** Still being written: what is left open at its end is closed first. */
  streaming?: boolean
  /** How many sources the answer has, which it cites as [1], [2] and so on. */
  sources?: number
  /** Called when a citation is clicked, with its number. */
  onCite?: (n: number) => void
}

/**
 * An answer in Markdown, with GitHub's tables and strikethrough. While it is
 * written, what is left open at its end (bold, code, a link) is closed, so
 * that it does not jump about as the rest arrives. HTML in it is not rendered.
 * An image is shown as a link to it and is not loaded.
 * Citations of its sources, [1] and the like, are small numbered buttons.
 */
export const ChatMarkdown = memo(function ChatMarkdown({ text, streaming, sources = 0, onCite }: ChatMarkdownProps) {
  const components = useMemo<Components>(
    () => ({
      a: ({ href, title, children }) => {
        if (href?.startsWith(citePrefix)) return <ChatCite n={Number(href.slice(citePrefix.length))} onCite={onCite} />
        // A link still being written has no address yet.
        return href ? (
          <a href={href} title={title} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        ) : (
          <span>{children}</span>
        )
      },
      // An image is not loaded: the browser would ask for an address the answer chose, and what the answer says can be
      // steered by text in the data it read, so the address could carry what was read out. It is a link to follow by choice.
      img: ({ src, alt }) => {
        const address = typeof src === 'string' ? src : ''
        return address ? (
          <a href={address} target="_blank" rel="noopener noreferrer">
            {alt || address}
          </a>
        ) : (
          <span>{alt}</span>
        )
      },
    }),
    [onCite],
  )
  return (
    <div className="lb-chat-markdown">
      <Markdown remarkPlugins={remarkPlugins} components={components}>
        {linkCitations(streaming ? remend(text) : text, sources)}
      </Markdown>
    </div>
  )
})

export interface ChatStep {
  key: string
  /** What the step does or did, such as reading a chart. */
  label: ReactNode
  state: 'running' | 'done' | 'failed'
}

export interface ChatStepsProps {
  steps: ChatStep[]
  /** Says what was done, on the line that unfolds the steps. */
  summary: ReactNode
}

/**
 * The steps an answer took to look things up, folded into a line that
 * unfolds them. A step that is running shows on its own, as what the answer
 * is doing.
 */
export function ChatSteps({ steps, summary }: ChatStepsProps) {
  const [open, setOpen] = useState(false)
  const running = steps.find((step) => step.state === 'running')
  const finished = steps.filter((step) => step.state !== 'running')
  return (
    <div className="lb-chat-steps">
      {finished.length > 0 && (
        <button type="button" className="lb-chat-steps-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <ChevronRightIcon aria-hidden />
          {summary}
        </button>
      )}
      {open && finished.length > 0 && (
        <ol className="lb-chat-steps-list">
          {finished.map((step) => (
            <li key={step.key} data-state={step.state}>
              {step.state === 'failed' ? <CircleXIcon aria-hidden /> : <CircleCheckIcon aria-hidden />}
              <span>{step.label}</span>
            </li>
          ))}
        </ol>
      )}
      {running && <ChatPending>{running.label}</ChatPending>}
    </div>
  )
}

export interface ChatFigureProps {
  title: ReactNode
  /** The chart, drawn by whoever uses the frame: this package does not draw charts. */
  children: ReactNode
  /** Lines under it, such as where its data came from. */
  details?: ReactNode[]
}

/** A chart in an answer, with its title above it and what to know about it below. */
export function ChatFigure({ title, children, details }: ChatFigureProps) {
  return (
    <figure className="lb-chat-figure">
      <div className="lb-chat-figure-title">{title}</div>
      <div className="lb-chat-figure-body">{children}</div>
      {details && details.length > 0 && (
        <figcaption className="lb-chat-figure-details">
          {details.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </figcaption>
      )}
    </figure>
  )
}

export interface ChatSource {
  n: number
  /** The element's id, which a citation of the source scrolls to. */
  id: string
  title: ReactNode
  /** Lines under the title, such as the conditions the data was read under. */
  details?: ReactNode[]
  /** What can be done with it, such as opening it. */
  action?: ReactNode
}

export interface ChatSourcesProps {
  sources: ChatSource[]
  /** Says what the sources are, on the line that unfolds them. */
  summary: ReactNode
  /** Unfolded. The answer unfolds them itself when a citation is clicked. */
  open: boolean
  onOpenChange: (open: boolean) => void
  'aria-label'?: string
}

/**
 * Where an answer's figures came from, each numbered as the answer cites it,
 * folded into a line that unfolds them: listed out, they can be longer than
 * the answer.
 */
export function ChatSources({ sources, summary, open, onOpenChange, 'aria-label': ariaLabel }: ChatSourcesProps) {
  return (
    <div className="lb-chat-sources">
      <button type="button" className="lb-chat-sources-toggle" aria-expanded={open} onClick={() => onOpenChange(!open)}>
        <ChevronRightIcon aria-hidden />
        <span>{summary}</span>
      </button>
      {open && (
        <ol className="lb-chat-sources-list" aria-label={ariaLabel}>
          {sources.map((source) => (
            <li key={source.n} id={source.id} className="lb-chat-source" tabIndex={-1}>
              <span className="lb-chat-source-n">{source.n}</span>
              <div className="lb-chat-source-body">
                <div className="lb-chat-source-title">{source.title}</div>
                {source.details?.map((line, i) => (
                  <div key={i} className="lb-chat-source-detail">
                    {line}
                  </div>
                ))}
              </div>
              {source.action && <div className="lb-chat-source-action">{source.action}</div>}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

export interface ChatInputProps {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  onStop: () => void
  /** An answer is being written: the button stops it. */
  writing: boolean
  /** Nothing can be sent now, though the box can still be typed in. */
  sendDisabled?: boolean
  /** Nothing can be typed. */
  disabled?: boolean
  /** Sending has started. */
  busy?: boolean
  placeholder?: string
  'aria-label'?: string
}

/**
 * The box a message is written in, which grows with it up to a few lines.
 * Enter sends and Shift+Enter starts a new line; Enter that picks a word in
 * an input method does neither.
 */
export function ChatInput({ value, onChange, onSend, onStop, writing, sendDisabled, disabled, busy, placeholder, 'aria-label': ariaLabel }: ChatInputProps) {
  const t = useStrings()
  const box = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [value])
  const canSend = !disabled && !sendDisabled && !writing && value.trim() !== ''
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Safari ends composing before the Enter that picks the word; 229 marks that Enter.
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
      event.preventDefault()
      if (canSend && !busy) onSend()
    }
  }
  return (
    <div className="lb-chat-input">
      <textarea
        ref={box}
        rows={1}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={ariaLabel}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {writing ? (
        <Button icon={<SquareIcon />} onClick={onStop}>
          {t.stop}
        </Button>
      ) : (
        <Button variant="primary" icon={<ArrowUpIcon />} loading={busy} disabled={!canSend} onClick={onSend}>
          {t.send}
        </Button>
      )}
    </div>
  )
}
