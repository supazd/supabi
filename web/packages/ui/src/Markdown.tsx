import { memo } from 'react'
import ReactMarkdown, { type Components, type Options } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './markdown.css'

// The rules of the AI assistant's answers (.agents/design/ai-assistant.md 4),
// for text that is written in full rather than streamed: a single tilde stays
// itself, as Chinese writes ranges as 20~25.
const remarkPlugins: Options['remarkPlugins'] = [[remarkGfm, { singleTilde: false }]]

const components: Components = {
  a: ({ href, title, children }) => (
    <a href={href} title={title} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
}

export interface MarkdownProps {
  text: string
}

/**
 * Text someone wrote in Markdown, with GitHub's tables and strikethrough.
 * HTML in it is shown as text, never run, and links open in a new tab.
 */
export const Markdown = memo(function Markdown({ text }: MarkdownProps) {
  return (
    <div className="lb-markdown">
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
