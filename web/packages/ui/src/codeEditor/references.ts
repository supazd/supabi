// References: code refers to named things as ${name}.
import { pickedCompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { syntaxTree } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { Decoration, MatchDecorator, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view'
import type { CodeReference } from './types'

const referencePattern = /\$\{([^}\n]*)\}/g

/** The form in which names are compared. */
const fold = (name: string) => name.trim().toLowerCase()

/** The references in text to names that are not among the given ones. */
export function unknownReferences(text: string, names: string[]): { from: number; to: number; name: string }[] {
  const known = new Set(names.map(fold))
  return [...text.matchAll(referencePattern)]
    .filter((match) => !known.has(fold(match[1]!)))
    .map((match) => ({ from: match.index, to: match.index + match[0].length, name: match[1]!.trim() }))
}

// What the language reads as text rather than code: a match in one of these is not what it looks like.
const textNodes = new Set(['String', 'LineComment', 'BlockComment', 'QuotedIdentifier'])

/**
 * Marks every match of a pattern with a class. With `codeOnly`, a match
 * inside a string, a quoted name or a comment is left alone: there it is text.
 */
export function marks(pattern: RegExp, className: (match: RegExpExecArray) => string, codeOnly = false): Extension {
  const matcher = new MatchDecorator({
    regexp: pattern,
    decorate: (add, from, to, match, view) => {
      if (codeOnly && textNodes.has(syntaxTree(view.state).resolveInner(from, 1).name)) return
      add(from, to, Decoration.mark({ class: className(match) }))
    },
  })
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = matcher.createDeco(view)
      }
      update(update: ViewUpdate) {
        this.decorations = matcher.updateDeco(update, this.decorations)
      }
    },
    { decorations: (plugin) => plugin.decorations },
  )
}

/** Shows references as such, and the ones to unknown names as mistakes. */
export function referenceMarks(references: CodeReference[]): Extension {
  const known = new Set(references.map((reference) => fold(reference.name)))
  return marks(referencePattern, (match) => (known.has(fold(match[1]!)) ? 'cm-lb-reference' : 'cm-lb-reference cm-lb-unknown'))
}

/**
 * Offers the names: inside an open ${ to finish the reference, and for a
 * word being typed to turn it into one.
 */
export function referenceCompletions(references: CodeReference[]) {
  // Writes the name and the closing brace, taking over a brace that is already there.
  const finish = (view: EditorView, completion: Completion, from: number, to: number) => {
    const closed = view.state.sliceDoc(to, to + 1) === '}'
    const insert = `${completion.label}}`
    view.dispatch({
      changes: { from, to: closed ? to + 1 : to, insert },
      selection: { anchor: from + insert.length },
      annotations: pickedCompletion.of(completion),
      userEvent: 'input.complete',
    })
  }
  const option = (reference: CodeReference): Completion => ({ label: reference.name, detail: reference.detail, type: 'field', boost: 10 })

  return (context: CompletionContext): CompletionResult | null => {
    const open = context.matchBefore(/\$\{[^}\n]*/)
    if (open) {
      return { from: open.from + 2, options: references.map((reference) => ({ ...option(reference), apply: finish })), validFor: /^[^}\n]*$/ }
    }
    const word = context.matchBefore(/[\p{L}\p{N}_]+/u)
    if (!word && !context.explicit) return null
    return {
      from: word ? word.from : context.pos,
      options: references.map((reference) => ({ ...option(reference), apply: `\${${reference.name}}` })),
      validFor: /^[\p{L}\p{N}_]*$/u,
    }
  }
}
