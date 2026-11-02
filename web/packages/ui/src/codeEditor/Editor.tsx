import { acceptCompletion, autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, completionStatus } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, indentOnInput, indentUnit } from '@codemirror/language'
import { forceLinting, linter, type Diagnostic } from '@codemirror/lint'
import { Annotation, Compartment, EditorState, Prec, StateEffect, type Extension } from '@codemirror/state'
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, placeholder as placeholderText, tooltips } from '@codemirror/view'
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { expressionLanguage, sqlLanguage } from './language'
import { marks, referenceCompletions, referenceMarks, unknownReferences } from './references'
import { filling, sizing, theme } from './theme'
import type { CodeEditorProps } from './types'

/** Marks a change that came from the value, not from the person typing. */
const fromOutside = Annotation.define<boolean>()
/** Asks for the mistakes to be worked out again though the text is the same. */
const recheck = StateEffect.define<null>()

// Source SQL can hold {{parameters}}, which stand for values. Inside a string
// or a comment the braces are only text, and are not shown as one.
const parameterMarks = marks(/\{\{[^}\n]*\}\}/g, () => 'cm-lb-parameter', true)

function language({ dialect, tables, references, functions }: CodeEditorProps): Extension {
  const sql = functions ? expressionLanguage(functions) : sqlLanguage(dialect, tables ?? [])
  if (!references) return [sql.extension, parameterMarks]
  return [sql.extension, sql.language.data.of({ autocomplete: referenceCompletions(references) }), referenceMarks(references)]
}

function attributes({ id, disabled, readOnly, 'aria-label': ariaLabel }: CodeEditorProps): Extension {
  const content: Record<string, string> = { 'aria-multiline': 'true' }
  if (id) content.id = id
  if (ariaLabel) content['aria-label'] = ariaLabel
  return [
    EditorView.contentAttributes.of(content),
    EditorView.editorAttributes.of({ class: disabled ? 'cm-lb-disabled' : '' }),
    EditorView.editable.of(!disabled),
    EditorState.readOnly.of(Boolean(disabled || readOnly)),
  ]
}

const layout = ({ lineNumbers: numbered, minLines = 4, maxLines = 24, fill, placeholder }: CodeEditorProps): Extension => [
  numbered ? [lineNumbers(), highlightActiveLineGutter()] : [],
  fill ? filling : sizing(minLines, Math.max(minLines, maxLines)),
  placeholder ? placeholderText(placeholder) : [],
]

/** The editor itself. It is loaded on demand, through CodeEditor. */
export default function Editor(props: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const [parts] = useState(() => ({ language: new Compartment(), attributes: new Compartment(), layout: new Compartment() }))
  // What the editor's callbacks read is whatever was rendered last.
  const latest = useRef(props)
  useEffect(() => {
    latest.current = props
  })

  // Replace the loading placeholder with a complete editor before painting.
  useLayoutEffect(() => {
    const problems = (editor: EditorView): Diagnostic[] => {
      const { references, unknownReference, problem } = latest.current
      const text = editor.state.doc.toString()
      const found: Diagnostic[] = []
      if (references) {
        const names = references.map((reference) => reference.name)
        for (const { from, to, name } of unknownReferences(text, names)) {
          found.push({ from, to, severity: 'error', message: unknownReference?.(name) ?? name })
        }
      }
      if (problem && text.length > 0) {
        // The whole name it starts at, dots and quotes included, or the one
        // character when it is something else. At the end, the last character.
        const at = Math.min(Math.max(problem.at, 0), text.length - 1)
        const name = /^[\p{L}\p{N}_$.`"]+/u.exec(text.slice(at))
        const to = problem.to !== undefined && problem.to > at ? Math.min(problem.to, text.length) : at + (name ? name[0].length : 1)
        found.push({ from: at, to, severity: 'error', message: problem.message })
      }
      return found
    }

    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: latest.current.value,
        extensions: [
          // Escape closes the list of suggestions. It must not go on to close
          // a dialog the editor is in, and what was written with it. This
          // has to look before the key is handled, while the list is open.
          // The key that formats is looked for here too, before it types anything.
          Prec.highest(
            EditorView.domEventHandlers({
              keydown: (event, editor) => {
                if (event.key === 'Escape' && completionStatus(editor.state) !== null) event.stopPropagation()
                // Shift+Alt+F formats. It is told by where the key is, not by what it
                // types: on a Mac the two with F type a letter, which is then not typed.
                if (event.code === 'KeyF' && event.shiftKey && event.altKey && !event.metaKey && !event.ctrlKey && latest.current.onFormat) {
                  event.preventDefault()
                  latest.current.onFormat()
                  return true
                }
                return false
              },
            }),
          ),
          history(),
          drawSelection(),
          highlightActiveLine(),
          bracketMatching(),
          closeBrackets(),
          indentOnInput(),
          indentUnit.of('  '),
          EditorState.tabSize.of(2),
          EditorView.lineWrapping,
          autocompletion(),
          // Pop-ups are drawn in the page, where a dialog cannot clip them.
          tooltips({ parent: document.body }),
          linter(problems, { delay: 300, needsRefresh: (update) => update.transactions.some((tr) => tr.effects.some((effect) => effect.is(recheck))) }),
          keymap.of([
            {
              key: 'Mod-Enter',
              run: () => {
                latest.current.onRun?.()
                return Boolean(latest.current.onRun)
              },
            },
            { key: 'Tab', run: acceptCompletion },
            ...closeBracketsKeymap,
            ...completionKeymap,
            ...historyKeymap,
            ...defaultKeymap.filter((binding) => binding.key !== 'Mod-Enter'),
            indentWithTab,
          ]),
          theme,
          parts.language.of(language(latest.current)),
          parts.attributes.of(attributes(latest.current)),
          parts.layout.of(layout(latest.current)),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !update.transactions.some((tr) => tr.annotation(fromOutside))) {
              latest.current.onChange(update.state.doc.toString())
            }
            const selected = !update.state.selection.main.empty
            if (selected === update.startState.selection.main.empty) latest.current.onSelectionChange?.(selected)
          }),
        ],
      }),
    })
    view.current = editor
    return () => {
      view.current = null
      editor.destroy()
    }
  }, [parts])

  useImperativeHandle(
    props.handle,
    () => ({
      insert: (text, back = 0) => {
        const editor = view.current
        if (!editor) return
        const { from, to } = editor.state.selection.main
        const apart = /[\p{L}\p{N}_$`")\]}]/u.test(editor.state.sliceDoc(Math.max(0, from - 1), from)) ? ` ${text}` : text
        editor.dispatch({ changes: { from, to, insert: apart }, selection: { anchor: from + apart.length - back }, scrollIntoView: true, userEvent: 'input' })
        editor.focus()
      },
      replace: (text) => {
        const editor = view.current
        if (!editor) return
        const { from, to } = editor.state.selection.main
        editor.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from, head: from + text.length }, userEvent: 'input' })
        editor.focus()
      },
      selection: () => {
        const editor = view.current
        if (!editor || editor.state.selection.main.empty) return null
        const { from, to } = editor.state.selection.main
        return { from, text: editor.state.sliceDoc(from, to) }
      },
    }),
    [],
  )

  // The value is the truth: when it is not what was typed, the text follows it.
  useEffect(() => {
    const editor = view.current
    if (editor && props.value !== editor.state.doc.toString()) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: props.value }, annotations: fromOutside.of(true) })
    }
  }, [props.value])

  // Lists are compared by content: callers build them anew on each render,
  // and reconfiguring closes the list of suggestions.
  const tablesKey = JSON.stringify(props.tables ?? null)
  const referencesKey = JSON.stringify(props.references ?? null)
  const functionsKey = JSON.stringify(props.functions ?? null)
  useEffect(() => {
    view.current?.dispatch({ effects: parts.language.reconfigure(language(latest.current)) })
  }, [parts, props.dialect, tablesKey, referencesKey, functionsKey])

  const ariaLabel = props['aria-label']
  useEffect(() => {
    view.current?.dispatch({ effects: parts.attributes.reconfigure(attributes(latest.current)) })
  }, [parts, props.id, props.disabled, props.readOnly, ariaLabel])

  useEffect(() => {
    view.current?.dispatch({ effects: parts.layout.reconfigure(layout(latest.current)) })
  }, [parts, props.lineNumbers, props.minLines, props.maxLines, props.fill, props.placeholder])

  // A mistake reported from outside is shown at once rather than after the usual pause.
  const problemKey = JSON.stringify(props.problem ?? null)
  useEffect(() => {
    const editor = view.current
    if (!editor) return
    editor.dispatch({ effects: recheck.of(null) })
    forceLinting(editor)
  }, [problemKey, referencesKey])

  // A label names a control by its id, but only focuses the kinds of control
  // the browser knows. This one is focused by hand.
  const { id } = props
  useEffect(() => {
    if (!id) return
    const labels = [...document.querySelectorAll('label')].filter((label) => label.htmlFor === id)
    const focus = () => view.current?.focus()
    for (const label of labels) label.addEventListener('click', focus)
    return () => {
      for (const label of labels) label.removeEventListener('click', focus)
    }
  }, [id])

  return <div ref={host} style={props.fill ? { height: '100%' } : undefined} />
}
