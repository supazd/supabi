import type { Ref } from 'react'

/** A table whose name and columns are offered while writing SQL. */
export interface CodeTable {
  /** Absent when the table is named without one. */
  schema?: string
  name: string
  columns: { name: string; type?: string }[]
}

/** Something a piece of code can refer to as ${name}. */
export interface CodeReference {
  name: string
  /** Shown next to the name when it is offered, such as its type. */
  detail?: string
}

/** A function of the platform's own language for expressions. */
export interface CodeFunction {
  name: string
  /** Shown next to the name when it is offered, such as what it is for. */
  detail?: string
}

/** A mistake to point out in the code. */
export interface CodeProblem {
  /** Where it is, as an index into the value. */
  at: number
  /** Where it ends. Without it, the name or the character it starts at is marked. */
  to?: number
  message: string
}

/** What a page can ask of the editor it shows. */
export interface CodeEditorHandle {
  /**
   * Puts text where the cursor is, in place of what is selected, and leaves
   * the cursor after it, or `back` characters before its end: inside the
   * parentheses of a function, say. A space keeps it apart from a word right
   * before it.
   */
  insert(text: string, back?: number): void
  /** What is selected and where it starts in the value, or null when nothing is. */
  selection(): { from: number; text: string } | null
  /** Puts text in place of what is selected, and leaves it selected. */
  replace(text: string): void
}

export interface CodeEditorProps {
  value: string
  onChange: (value: string) => void
  /** The kind of database whose SQL this is. It decides the keywords and how names are quoted. */
  dialect?: string
  /** Tables to offer the names and columns of. */
  tables?: CodeTable[]
  /**
   * What the code can refer to as ${name}. When given, names are offered
   * while writing, and a reference to none of them is marked as a mistake.
   * Names are matched without regard to case.
   */
  references?: CodeReference[]
  /**
   * The functions of the platform's own language. When given, the code is an
   * expression in that language rather than a database's SQL: these are what
   * is offered, and the words of a database are not.
   */
  functions?: CodeFunction[]
  /** Says that a name is not among the references. */
  unknownReference?: (name: string) => string
  /** A mistake found elsewhere, such as by the database. */
  problem?: CodeProblem | null
  lineNumbers?: boolean
  /** The height when there is less text than this. */
  minLines?: number
  /** Beyond this the editor scrolls instead of growing. */
  maxLines?: number
  /**
   * Takes the whole height of what it is in, without a frame, and scrolls
   * inside: for a page that is an editor. minLines and maxLines do not apply.
   */
  fill?: boolean
  placeholder?: string
  disabled?: boolean
  /** Shown for reading: it can still be focused, scrolled and selected, but not changed. */
  readOnly?: boolean
  id?: string
  'aria-label'?: string
  /** Called on Ctrl+Enter, or Cmd+Enter on a Mac. */
  onRun?: () => void
  /** Called on Shift+Alt+F, the key editors format code with. */
  onFormat?: () => void
  /** Called when something comes to be selected, and when nothing is any more. */
  onSelectionChange?: (selected: boolean) => void
  /** Set to the editor once it is there. Until then it is null. */
  handle?: Ref<CodeEditorHandle>
}
