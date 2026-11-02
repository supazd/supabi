import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { codeFont, lineHeight, verticalPadding } from './metrics'

const tint = (color: string, percent: number) => `color-mix(in srgb, var(${color}) ${percent}%, transparent)`

const badge = (color: string) => ({ color: `var(${color})`, backgroundColor: tint(color, 16) })

// The kinds of suggestion: the letter that stands for each, and its colour.
const kinds: Record<string, [letter: string, color: string]> = {
  column: ['C', '--lb-code-number'],
  table: ['T', '--lb-code-string'],
  schema: ['S', '--lb-code-string'],
  field: ['$', '--lb-color-primary'],
  function: ['ƒ', '--lb-code-keyword'],
  keyword: ['K', '--lb-color-text-secondary'],
  type: ['D', '--lb-color-text-secondary'],
}

// Everything is drawn from the design tokens, through their CSS variables, so
// the editor follows the colour scheme without being told about it.
const frame = EditorView.theme({
  // Body-mounted tooltip containers also receive the theme classes. Only the
  // editor gets a frame; a border on the empty tooltip host adds page height.
  '&.cm-editor': {
    border: '1px solid var(--lb-color-border)',
    borderRadius: 'var(--lb-radius)',
    backgroundColor: 'var(--lb-color-surface)',
    color: 'var(--lb-color-text)',
    fontSize: '13px',
  },
  // Like the other fields, it keeps its border when focused.
  '&.cm-focused': { outline: 'none' },
  '&.cm-lb-disabled': { opacity: 0.6, borderColor: 'var(--lb-color-border)' },
  '.cm-scroller': { fontFamily: codeFont, lineHeight: `${lineHeight}px`, borderRadius: 'inherit' },
  '.cm-content': { padding: `${verticalPadding}px 0`, caretColor: 'var(--lb-color-text)' },
  '.cm-line': { padding: '0 11px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--lb-color-text)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: tint('--lb-color-primary', 24) },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '&.cm-focused .cm-activeLine': { backgroundColor: tint('--lb-color-text', 4) },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--lb-color-text-secondary)', border: 'none', borderRadius: 'inherit' },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '30px', padding: '0 4px 0 10px', opacity: 0.7 },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '&.cm-focused .cm-activeLineGutter': { color: 'var(--lb-color-text)', opacity: 1 },
  '.cm-placeholder': { color: 'var(--lb-color-text-secondary)', opacity: 0.7 },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: tint('--lb-color-primary', 22), outline: 'none' },
  '&.cm-focused .cm-nonmatchingBracket': { backgroundColor: tint('--lb-color-danger', 22) },

  // References and parameters stand for something else, so they look like tokens rather than text.
  '.cm-lb-reference, .cm-lb-parameter': { borderRadius: '3px', padding: '1px 0' },
  '.cm-lb-reference': { backgroundColor: tint('--lb-color-primary', 13) },
  '.cm-lb-reference, .cm-lb-reference *': { color: 'var(--lb-color-primary)' },
  '.cm-lb-unknown': { backgroundColor: tint('--lb-color-danger', 13) },
  '.cm-lb-unknown, .cm-lb-unknown *': { color: 'var(--lb-color-danger)' },
  '.cm-lb-parameter': { backgroundColor: tint('--lb-code-number', 14) },
  '.cm-lb-parameter, .cm-lb-parameter *': { color: 'var(--lb-code-number)' },

  // Above dialogs, which the pop-ups are drawn outside of so as not to be clipped.
  '.cm-tooltip': {
    zIndex: 1100,
    backgroundColor: 'var(--lb-color-surface)',
    color: 'var(--lb-color-text)',
    border: '1px solid var(--lb-color-border)',
    borderRadius: 'var(--lb-radius)',
    boxShadow: '0 6px 16px rgb(0 0 0 / 0.14)',
    overflow: 'hidden',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: codeFont, fontSize: '12px', maxHeight: '16em', minWidth: '220px' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '0 12px 0 0', lineHeight: '24px' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: tint('--lb-color-primary', 16), color: 'var(--lb-color-text)' },
  // What kind of thing each suggestion is, as a letter in a coloured square
  // at the start of its row.
  '.cm-completionIcon': {
    width: '24px',
    marginRight: '8px',
    padding: 0,
    opacity: 1,
    boxSizing: 'border-box',
    fontFamily: 'var(--lb-font-family)',
    fontSize: '11px',
    fontWeight: 600,
    textAlign: 'center',
    ...badge('--lb-color-text-secondary'),
  },
  ...Object.fromEntries(Object.entries(kinds).flatMap(([kind, [letter, color]]) => [
    [`.cm-completionIcon-${kind}`, badge(color)],
    [`.cm-completionIcon-${kind}::after`, { content: `"${letter}"` }],
  ])),
  '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: 600, color: 'var(--lb-color-primary)' },
  '.cm-completionDetail': { marginLeft: '16px', fontStyle: 'normal', color: 'var(--lb-color-text-secondary)' },
  '.cm-diagnostic': { padding: '5px 10px', fontFamily: 'var(--lb-font-family)', fontSize: '12px', borderLeft: 'none' },
  '.cm-diagnostic-error': { borderLeft: '3px solid var(--lb-color-danger)' },
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--lb-color-danger)', textUnderlineOffset: '3px', textDecorationSkipInk: 'none' },
})

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: 'var(--lb-code-keyword)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--lb-code-string)' },
  { tag: [tags.number, tags.bool, tags.null, tags.typeName], color: 'var(--lb-code-number)' },
  { tag: [tags.lineComment, tags.blockComment], color: 'var(--lb-code-comment)', fontStyle: 'italic' },
])

export const theme: Extension = [frame, syntaxHighlighting(highlight)]

/**
 * An editor that is the page: as tall as what it is in, with no frame of its
 * own. The selectors name the editor twice over so that these rules win over
 * the frame's, whichever of the two the editor happens to apply last.
 */
export const filling: Extension = EditorView.theme({
  '&.cm-editor': { height: '100%', border: 'none', borderRadius: '0', backgroundColor: 'transparent' },
  '&.cm-editor.cm-focused': { outline: 'none' },
  '&.cm-editor .cm-scroller': { overflow: 'auto', borderRadius: '0' },
  '&.cm-editor .cm-content': { padding: '8px 0' },
})

/** How tall the editor is with little text, and when it starts to scroll. */
export function sizing(minLines: number, maxLines: number): Extension {
  return EditorView.theme({
    '.cm-content, .cm-gutter': { minHeight: `${minLines * lineHeight + 2 * verticalPadding}px` },
    '.cm-scroller': { maxHeight: `${maxLines * lineHeight + 2 * verticalPadding}px`, overflow: 'auto' },
  })
}
