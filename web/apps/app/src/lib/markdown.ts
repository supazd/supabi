// Markdown that dashboard authors write for every viewer to read. Only the
// Markdown is rendered: HTML in it is shown as text, links go to the web or
// to mail only, and images are not loaded. See .agents/design/chart-dashboard.md 3.12.
import MarkdownIt from 'markdown-it'

const markdown = new MarkdownIt({
  // Shown as text, not run: the author's HTML could carry a script.
  html: false,
  // Addresses written out become links, checked like any other.
  linkify: true,
  // A line break typed in the editor is a line break on the board.
  breaks: true,
})
  // An image makes each viewer's browser ask the author's address for it, which tells who looked when.
  .disable('image')

// `javascript:`, `data:` and the like stay text, and so do relative addresses.
markdown.validateLink = (url) => /^(https?:|mailto:)/i.test(url)

const renderLink = markdown.renderer.rules.link_open ?? ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options))
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  // Opened beside the board, without telling the page it opens where it came from.
  tokens[index]!.attrSet('target', '_blank')
  tokens[index]!.attrSet('rel', 'noopener noreferrer')
  return renderLink(tokens, index, options, env, self)
}

/** The HTML of what an author wrote in Markdown, safe to show to anyone. */
export function renderMarkdown(source: string): string {
  return markdown.render(source)
}
