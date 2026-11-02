import { Suspense, lazy } from 'react'
import { codeFont, lineHeight, verticalPadding } from './codeEditor/metrics'
import type { CodeEditorProps } from './codeEditor/types'
import { useStrings } from './locale'

export type { CodeEditorHandle, CodeEditorProps, CodeFunction, CodeProblem, CodeReference, CodeTable } from './codeEditor/types'

// The editor is a large library that few pages need, so it is fetched when
// one is first shown.
const Editor = lazy(() => import('./codeEditor/Editor'))

/**
 * SQL laid out one clause to a line, as the given kind of database writes
 * it. Rejects when the SQL cannot be read. The library that does it is
 * fetched when first asked for.
 */
export async function formatSql(text: string, dialect?: string): Promise<string> {
  const { format } = await import('./codeEditor/format')
  return format(text, dialect)
}

/** A multi-line editor for SQL: highlighted, with names completed and mistakes marked. */
export function CodeEditor(props: CodeEditorProps) {
  const { value, minLines = 4, maxLines = 24, fill, lineNumbers } = props
  const t = useStrings()
  return (
    <Suspense
      fallback={
        // Reserve the same wrapped text and gutter dimensions, but do not flash
        // unstyled SQL before the highlighted, numbered editor is ready.
        <div
          role="status"
          aria-label={props['aria-label'] ?? t.loading}
          aria-busy="true"
          style={{
            position: 'relative',
            minHeight: fill ? undefined : minLines * lineHeight + 2 * verticalPadding + 2,
            maxHeight: fill ? undefined : Math.max(minLines, maxLines) * lineHeight + 2 * verticalPadding + 2,
            height: fill ? '100%' : undefined,
            border: fill ? 'none' : '1px solid var(--lb-color-border)',
            borderRadius: 'var(--lb-radius)',
            background: fill ? 'transparent' : 'var(--lb-color-surface)',
            font: `13px/${lineHeight}px ${codeFont}`,
            whiteSpace: 'break-spaces',
            overflowWrap: 'anywhere',
            overflow: 'hidden',
            boxSizing: 'border-box',
          }}
        >
          <div aria-hidden="true" style={{ visibility: 'hidden', display: 'flex', padding: `${fill ? 8 : verticalPadding}px 0` }}>
            {lineNumbers && <div style={{ minWidth: 30, flexShrink: 0, padding: '0 4px 0 10px', boxSizing: 'border-box' }}>{value.split(/\r\n?|\n/).length}</div>}
            <div style={{ minWidth: 0, flex: 1, padding: '0 11px' }}>{value || '\u00a0'}</div>
          </div>
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--lb-color-text-secondary)', fontFamily: 'var(--lb-font-family)' }}>{t.loading}</div>
        </div>
      }
    >
      <Editor {...props} />
    </Suspense>
  )
}
