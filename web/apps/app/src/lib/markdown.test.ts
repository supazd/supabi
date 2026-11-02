import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'

describe('renderMarkdown', () => {
  it('renders Markdown, with a typed line break kept', () => {
    expect(renderMarkdown('**口径**：已支付订单\n不含退款')).toBe('<p><strong>口径</strong>：已支付订单<br>\n不含退款</p>\n')
    expect(renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |')).toContain('<td>2</td>')
    expect(renderMarkdown('~~旧口径~~')).toBe('<p><s>旧口径</s></p>\n')
  })

  it('shows HTML as text', () => {
    expect(renderMarkdown('<script>alert(1)</script>')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>\n')
    expect(renderMarkdown('<img src=x onerror=alert(1)>')).not.toContain('<img')
  })

  it('links to the web and to mail, opened beside the board', () => {
    expect(renderMarkdown('[说明](https://example.com/a?b=1&c=2)')).toBe('<p><a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">说明</a></p>\n')
    expect(renderMarkdown('[联系](mailto:bi@example.com)')).toContain('href="mailto:bi@example.com"')
    expect(renderMarkdown('详见 https://example.com')).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">https://example.com</a>')
  })

  it('leaves every other link as text', () => {
    for (const link of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', '%6Aavascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', 'vbscript:x', '/dashboards/db_1']) {
      expect(renderMarkdown(`[x](${link})`)).not.toContain('<a')
    }
    expect(renderMarkdown('<javascript:alert(1)>')).not.toContain('<a')
  })

  it('does not load images', () => {
    expect(renderMarkdown('![图](https://example.com/p.png)')).toBe('<p>!<a href="https://example.com/p.png" target="_blank" rel="noopener noreferrer">图</a></p>\n')
  })
})
