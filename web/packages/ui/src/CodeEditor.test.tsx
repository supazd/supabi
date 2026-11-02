// @vitest-environment jsdom
import { CompletionContext, type CompletionSource } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { createRef } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodeEditor, formatSql, type CodeEditorHandle } from './CodeEditor'
import { sqlLanguage } from './codeEditor/language'
import { suggest } from './codeEditor/scope'
import { referenceCompletions, unknownReferences } from './codeEditor/references'

afterEach(cleanup)

const fields = [{ name: '订单金额', detail: 'decimal' }, { name: 'Region' }]

/** What is offered with the cursor at the end of the text. */
function offered(text: string, explicit = false) {
  const state = EditorState.create({ doc: text })
  const result = referenceCompletions(fields)(new CompletionContext(state, text.length, explicit))
  return result && { from: result.from, labels: result.options.map((option) => option.label), apply: result.options.map((option) => option.apply) }
}

describe('references', () => {
  it('finds the ones to unknown names, comparing without regard to case', () => {
    const text = 'SUM(${订单金额}) / ${ region } + ${nope} + ${}'
    expect(unknownReferences(text, ['订单金额', 'Region'])).toEqual([
      { from: text.indexOf('${nope}'), to: text.indexOf('${nope}') + 7, name: 'nope' },
      { from: text.indexOf('${}'), to: text.length, name: '' },
    ])
  })

  it('offers names inside an open reference, from after the brace', () => {
    expect(offered('SUM(${订单')).toMatchObject({ from: 6, labels: ['订单金额', 'Region'] })
    expect(offered('1 + ${')).toMatchObject({ from: 6 })
  })

  it('offers to turn a word into a reference', () => {
    expect(offered('SUM(reg')).toMatchObject({ from: 4, apply: ['${订单金额}', '${Region}'] })
  })

  it('offers nothing after punctuation unless asked', () => {
    expect(offered('SUM(')).toBeNull()
    expect(offered('SUM(', true)).toMatchObject({ from: 4 })
  })
})

const tables = [
  { schema: 'demo', name: 'orders', columns: [{ name: 'id', type: 'bigint' }, { name: 'status', type: 'text' }, { name: 'amount', type: 'numeric' }] },
  { schema: 'demo', name: 'regions', columns: [{ name: 'id' }, { name: 'name' }] },
  { name: 'users', columns: [{ name: 'email' }, { name: 'Full Name' }] },
]

/** The names offered where the | is. */
function names(sql: string, explicit = false) {
  const pos = sql.indexOf('|')
  return suggest(sql.replace('|', ''), pos, tables, explicit)?.options.map((option) => option.label) ?? null
}

describe('names in SQL', () => {
  it('offers the columns of the tables the query reads from, and their aliases', () => {
    expect(names('select s| from demo.orders')).toEqual(['id', 'status', 'amount', 'orders'])
    expect(names('select * from demo.orders o join demo.regions r on o.id = r.id where n|')).toEqual(['id', 'status', 'amount', 'name', 'o', 'r'])
    expect(names('select | from users', true)).toEqual(['email', 'Full Name', 'users'])
  })

  it('offers nothing where no name is being written, and nothing inside text', () => {
    expect(names('select | from users')).toBeNull()
    // A table that is not known has no columns, but can still be named.
    expect(names('select s| from nowhere')).toEqual(['nowhere'])
    expect(names("select 'st|' from users")).toBeNull()
    expect(names('select 1 -- st|\nfrom users')).toBeNull()
  })

  it('offers what a subquery selects to the query around it, and its own tables inside it', () => {
    const sql = (outer: string, inner: string) => `select ${outer} from (select id as order_id, o.status, amount * 2 doubled, sum(amount) from demo.orders o where ${inner}) t`
    expect(names(sql('x|', 'true'))).toEqual(['order_id', 'status', 'doubled', 't'])
    expect(names(sql('*', 'a|'))).toEqual(['id', 'status', 'amount', 'o'])
    expect(names(sql('t.|', 'true'))).toEqual(['order_id', 'status', 'doubled'])
    // A star passes on every column of what the subquery reads.
    expect(names('select x| from (select * from demo.regions) r')).toEqual(['id', 'name', 'r'])
    expect(names('select x| from (select r.*, 1 as one from demo.regions r, users) q')).toEqual(['id', 'name', 'one', 'q'])
  })

  it('reads a WITH query like a table, also from the queries after it', () => {
    const sql = 'with paid as (select id, amount from demo.orders where status = 1), big as (select id big_id from paid) select | from paid p join big on true'
    expect(names(sql, true)).toEqual(['id', 'amount', 'big_id', 'p', 'big'])
    expect(names('with paid as (select id from demo.orders where s|) select 1')).toEqual(['id', 'status', 'amount', 'orders'])
  })

  it('keeps the queries of a UNION apart, and looks past the parentheses of a function', () => {
    expect(names('select id from demo.regions union all select e| from users')).toEqual(['email', 'Full Name', 'users'])
    expect(names('select coalesce(sum(a|), 0) from demo.orders')).toEqual(['id', 'status', 'amount', 'orders'])
    expect(names('select 1 from demo.regions where id in (select i| from demo.orders)')).toEqual(['id', 'status', 'amount', 'orders'])
  })

  it('offers columns after a table or alias and a dot, tables after a schema', () => {
    expect(names('select o.| from demo.orders o')).toEqual(['id', 'status', 'amount'])
    expect(names('select demo.orders.s| from demo.orders')).toEqual(['id', 'status', 'amount'])
    expect(names('select * from demo.|')).toEqual(['orders', 'regions'])
    // An alias of the query around a subquery can be used inside it.
    expect(names('select * from demo.orders o where exists (select 1 from users where o.|)')).toEqual(['id', 'status', 'amount'])
    expect(names('select nope.| from users')).toBeNull()
  })

  it('offers tables where one is expected, and nothing where an alias is', () => {
    expect(names('select * from |')).toEqual(['users', 'demo'])
    expect(names('with paid as (select 1) select * from users join p|')).toEqual(['paid', 'users', 'demo'])
    expect(names('select * from users, d|')).toEqual(['users', 'demo'])
    expect(names('select * from users u|')).toBeNull()
    expect(names('select * from users as |', true)).toBeNull()
  })
})

/** Everything offered at the end of the text, as the list would order it. */
async function suggestions(dialect: string, doc: string) {
  const state = EditorState.create({ doc, extensions: [sqlLanguage(dialect, tables).extension] })
  const options = []
  for (const source of state.languageDataAt<CompletionSource>('autocomplete', doc.length)) {
    const result = await source(new CompletionContext(state, doc.length, false))
    if (result) options.push(...result.options)
  }
  const typed = /[\p{L}\p{N}_]*$/u.exec(doc)![0].toLowerCase()
  return options.filter((option) => option.label.toLowerCase().startsWith(typed)).sort((a, b) => (b.boost ?? 0) - (a.boost ?? 0) || a.label.localeCompare(b.label))
}

describe('SQL suggestions', () => {
  it.each(['postgres', 'mysql', 'clickhouse', 'starrocks', 'other'])('puts the everyday keywords first in %s', async (dialect) => {
    expect((await suggestions(dialect, 's'))[0]).toMatchObject({ label: 'SELECT', type: 'keyword' })
    expect((await suggestions(dialect, 'select 1 f'))[0]).toMatchObject({ label: 'FROM' })
  })

  it('puts names ahead of keywords, and says what each suggestion is', async () => {
    const offered = await suggestions('postgres', 'select * from demo.orders where s')
    expect(offered.slice(0, 2)).toMatchObject([{ label: 'status', type: 'column', detail: 'text' }, { label: 'SELECT', type: 'keyword' }])
    expect(offered.find((option) => option.label === 'SUM')).toMatchObject({ type: 'function' })
    expect((await suggestions('postgres', 'select * from d'))[0]).toMatchObject({ label: 'demo', type: 'schema' })
  })

  it('quotes a name that cannot be written bare, the way the database does', async () => {
    const quoted = async (dialect: string) => (await suggestions(dialect, 'select f')).find((option) => option.label === 'Full Name')?.apply
    expect(await suggestions('postgres', 'select * from users where f')).toContainEqual(expect.objectContaining({ label: 'Full Name', apply: '"Full Name"' }))
    expect(await quoted('mysql')).toBeUndefined() // no table read yet, so no column offered
    expect(await suggestions('mysql', 'select * from users where f')).toContainEqual(expect.objectContaining({ label: 'Full Name', apply: '`Full Name`' }))
  })
})

describe('CodeEditor', () => {
  it('shows a loading placeholder until highlighted SQL and line numbers are ready together', async () => {
    const onChange = vi.fn()
    const { container } = render(<CodeEditor id="sql" aria-label="Source SQL" value="SELECT 1" onChange={onChange} lineNumbers />)
    const loading = screen.getByRole('status', { name: 'Source SQL' })
    expect(loading.getAttribute('aria-busy')).toBe('true')
    expect((loading.querySelector('[aria-hidden="true"]') as HTMLElement).style.visibility).toBe('hidden')
    expect(screen.queryByRole('textbox', { name: 'Source SQL' })).toBeNull()

    const editor = await screen.findByRole('textbox', { name: 'Source SQL' })
    expect(editor.id).toBe('sql')
    expect(editor.textContent).toContain('SELECT 1')
    expect(container.querySelector('.cm-lineNumbers')).not.toBeNull()
    expect(container.querySelector('.cm-line span')?.textContent).toBe('SELECT')
    expect(screen.queryByRole('status', { name: 'Source SQL' })).toBeNull()
    // Showing a value is not a change to it.
    expect(onChange).not.toHaveBeenCalled()
  })

  it('follows the value when it changes from outside, without reporting a change', async () => {
    const onChange = vi.fn()
    const { rerender } = render(<CodeEditor aria-label="code" value="a" onChange={onChange} />)
    const editor = await screen.findByRole('textbox', { name: 'code' })
    rerender(<CodeEditor aria-label="code" value="SELECT ${x}" onChange={onChange} references={[{ name: 'x' }]} />)
    await waitFor(() => expect(editor.textContent).toContain('SELECT ${x}'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('puts text where the cursor is, and says what is selected', async () => {
    const onChange = vi.fn()
    const onSelectionChange = vi.fn()
    const handle = createRef<CodeEditorHandle>()
    render(<CodeEditor aria-label="code" value="SELECT a FROM t" onChange={onChange} onSelectionChange={onSelectionChange} handle={handle} />)
    const view = EditorView.findFromDOM(await screen.findByRole('textbox', { name: 'code' }))!
    expect(handle.current!.selection()).toBeNull()

    // After a word, a space keeps the name apart from it; the cursor ends after the name.
    view.dispatch({ selection: { anchor: 8 } })
    handle.current!.insert(', b')
    expect(onChange).toHaveBeenLastCalledWith('SELECT a , b FROM t')
    handle.current!.insert('c')
    expect(onChange).toHaveBeenLastCalledWith('SELECT a , b c FROM t')
    // After a dot the name belongs to what is before it.
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'SELECT t. FROM t' }, selection: { anchor: 9 } })
    handle.current!.insert('a')
    expect(onChange).toHaveBeenLastCalledWith('SELECT t.a FROM t')
    expect(onSelectionChange).not.toHaveBeenCalled()

    view.dispatch({ selection: { anchor: 7, head: 10 } })
    expect(handle.current!.selection()).toEqual({ from: 7, text: 't.a' })
    expect(onSelectionChange).toHaveBeenLastCalledWith(true)
    // What is selected is what the text takes the place of.
    handle.current!.insert('x')
    expect(onChange).toHaveBeenLastCalledWith('SELECT x FROM t')
    expect(onSelectionChange).toHaveBeenLastCalledWith(false)
    expect(onSelectionChange).toHaveBeenCalledTimes(2)
  })

  it('formats on Shift+Alt+F wherever the key types a letter, and types nothing', async () => {
    const onFormat = vi.fn()
    const onChange = vi.fn()
    render(<CodeEditor aria-label="code" value="select 1" onChange={onChange} onFormat={onFormat} />)
    const editor = await screen.findByRole('textbox', { name: 'code' })
    // On a Mac, Option and Shift with F type "Ï".
    const key = new KeyboardEvent('keydown', { key: 'Ï', code: 'KeyF', shiftKey: true, altKey: true, bubbles: true, cancelable: true })
    editor.dispatchEvent(key)
    expect(onFormat).toHaveBeenCalledTimes(1)
    expect(key.defaultPrevented).toBe(true)
    // The same key without the two is a letter like any other.
    const plain = new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', bubbles: true, cancelable: true })
    editor.dispatchEvent(plain)
    expect(onFormat).toHaveBeenCalledTimes(1)
    expect(plain.defaultPrevented).toBe(false)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('cannot be edited while disabled', async () => {
    render(<CodeEditor aria-label="code" value="a" onChange={() => {}} disabled />)
    const editor = await screen.findByRole('textbox', { name: 'code' })
    expect(editor.getAttribute('contenteditable')).toBe('false')
  })

  it('keeps the body tooltip host free of editor borders that would make the page scroll', async () => {
    const { unmount } = render(<CodeEditor aria-label="Saved SQL" value="SELECT 1" onChange={() => {}} lineNumbers disabled />)
    const editor = EditorView.findFromDOM(await screen.findByRole('textbox', { name: 'Saved SQL' }))!
    const tooltipHost = [...document.body.children].find((element) => element.className === editor.themeClasses)!
    expect(tooltipHost).toBeDefined()
    // JSDOM does not resolve borders using CSS variables. Check which actual
    // theme rules match each element; browser checks cover the page height.
    const framed = [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules])
      .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule && Boolean(rule.style.border))
    expect(framed.some((rule) => editor.dom.matches(rule.selectorText))).toBe(true)
    expect(framed.some((rule) => tooltipHost.matches(rule.selectorText))).toBe(false)
    unmount()
    expect(document.body.contains(tooltipHost)).toBe(false)
  })
})

describe('parameters in SQL', () => {
  it('are shown as such where they are code, and as text inside a string or a comment', async () => {
    const sql = "SELECT 1 WHERE status = {{status}} AND tag = '{{tag}}' -- AND day = {{day}}\n/* {{note}} */ AND region = {{region}}"
    const { container } = render(<CodeEditor aria-label="SQL" dialect="postgres" value={sql} onChange={() => undefined} />)
    await waitFor(() => expect(container.querySelector('.cm-lb-parameter')).not.toBeNull())
    expect([...container.querySelectorAll('.cm-lb-parameter')].map((mark) => mark.textContent)).toEqual(['{{status}}', '{{region}}'])
  })
})

describe('formatting SQL', () => {
  it('puts each clause on its own line, with keywords in capitals', async () => {
    expect(await formatSql('select a, b from t where a = 1', 'postgres')).toBe('SELECT\n  a,\n  b\nFROM\n  t\nWHERE\n  a = 1')
  })

  it('keeps parameters and references as they were written', async () => {
    expect(await formatSql('select * from t where d >= {{start date}} and r in ({{ regions }})')).toContain('d >= {{start date}}\n  AND r IN ({{ regions }})')
    expect(await formatSql('sum(${订单金额})/count(*)')).toContain('${订单金额}')
  })

  it('keeps the marks of an optional part whole, so that it is still one', async () => {
    const formatted = await formatSql('select id as `订单id` from demo.orders where status = {{status}} [[and user_id = {{user_id}}]] [[ and channel in {{channels}} ]]', 'clickhouse')
    expect(formatted).toBe('SELECT\n  id AS `订单id`\nFROM\n  demo.orders\nWHERE\n  status = {{status}}\n  [[ AND user_id = {{user_id}} ]]\n  [[ AND channel IN {{channels}} ]]')
    expect(await formatSql(formatted, 'clickhouse')).toBe(formatted)
    expect(await formatSql('select * from t [[where a = {{a}}]] limit 10', 'postgres')).toBe('SELECT\n  *\nFROM\n  t\n[[ WHERE\n  a = {{a}} ]]\nLIMIT\n  10')
  })

  it('reads what each kind of database writes', async () => {
    expect(await formatSql('select `a` from t final prewhere x = 1', 'clickhouse')).toContain('PREWHERE')
    expect(await formatSql('select `a` from `t` limit 1', 'starrocks')).toContain('`a`')
    expect(await formatSql('select a::text from t', 'postgres')).toContain('a::text')
  })

  it('rejects what it cannot read', async () => {
    await expect(formatSql('select (a from t')).rejects.toThrow()
  })
})
