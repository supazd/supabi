// Charts drawn as HTML rather than on a canvas: tables, pivot tables and KPI tiles.
import { Fragment, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type ThHTMLAttributes } from 'react'
import { layoutColumns, maxGroupLabel, toHeaderRows } from './columnGroups'
import type { ChartTexts } from './echartsAdapter'
import { formatCell, formatNumber } from './format'
import { highlightInk, hueColor, inkFor, type ChartColorScheme, type Hue, type Ink } from './palette'
import type { Cell, ClickPoint, QueryResult, ResultColumn } from './result'
import type { Style, Viz } from './spec'
import { highlightOf, toComparedTiles, toMergedSpans, toNumber, toPivot, type PivotLine } from './transform'


const isNumeric = (column: ResultColumn) => column.type === 'integer' || column.type === 'decimal' || column.type === 'float'
const minWidth = 40
const maxWidth = 800
/** A cell's padding at each density: above and below, then at the sides. */
const paddings = { compact: [3, 8], normal: [6, 10], comfortable: [10, 12] } as const
type Density = keyof typeof paddings
/**
 * A header's line, set rather than inherited, so a row of a header is as
 * tall as its line, its padding and its bottom border, whatever the page
 * around it sets: the rows can then each stay in view under the one above.
 */
const headerLine = 20
const headerRowHeight = (density: Density) => headerLine + 2 * paddings[density][0] + 1
/** How tall the bar under a paged table is. */
const pagerHeight = 32
/** How many rows a page holds when the chart does not say. */
const defaultPageSize = 20

/** What lets the author pick a table's headers to group and name the groups; without it, headers are only read. */
export interface HeaderEditing {
  /**
   * Every column of the chart in order, the layout's paths being over them:
   * one the result leaves out, such as a dynamic dimension left empty, keeps
   * its place in its group, so editing the groups cannot drop it.
   */
  columns: string[]
  /** The headers picked, by path in the column layout. */
  selected: number[][]
  /** The group whose name is being written, by path. */
  renaming?: number[]
  onSelect: (path: number[], extend: boolean) => void
  onRenameStart: (path: number[]) => void
  /** Called with the name written, or with none when it is to stay as it was. */
  onRename: (path: number[], label?: string) => void
}

interface TableProps {
  viz: Viz
  result: QueryResult
  scheme: ChartColorScheme
  /** The colour the table is drawn on, when not the scheme's own surface. */
  surface?: string
  locale?: string
  /** How many days of a year's first week are in that year, which numbers weeks. */
  firstWeekDays?: number
  height: number
  label: string
  texts: ChartTexts
  /** Called with a column's new width when its edge is dragged; without it, widths are not changed here. */
  onColumnResize?: (column: string, width: number) => void
  onCellSelect?: (column: string, value: Cell, at: ClickPoint) => void
  selectableColumns?: string[]
  cellSelections?: Record<string, Cell>
  headerEditing?: HeaderEditing
  /** What the rows answer: when it changes a paged table goes back to its first page, and the same rows again keep the page. */
  pageKey?: string
}

/** What every cell of a table shares, from the chart's style. */
function cellStyles(style: Style | undefined, ink: Ink) {
  const [above, side] = paddings[style?.density ?? 'normal']
  // A line set rather than inherited, as the header's, so every row is as tall as headerRowHeight says.
  const cell: CSSProperties = { padding: `${above}px ${side}px`, lineHeight: `${headerLine}px`, borderBottom: `1px solid ${ink.grid}`, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }
  // A stripe over the surface, opaque so a frozen column hides what scrolls beneath it.
  const stripe = `linear-gradient(color-mix(in srgb, ${ink.text} 4%, transparent), color-mix(in srgb, ${ink.text} 4%, transparent)), ${ink.surface}`
  const background = (index: number) => (style?.striped && index % 2 === 1 ? stripe : ink.surface)
  const frozen = (first: boolean, header = false): CSSProperties => (style?.freeze && first ? { position: 'sticky', left: 0, zIndex: header ? 3 : 1, boxShadow: `1px 0 0 ${ink.grid}` } : {})
  const align = (column: ResultColumn) => style?.columnAlign?.[column.name] ?? (column.role === 'measure' || isNumeric(column) ? 'right' : 'left')
  return { cell, background, frozen, align }
}

const glyphs = { up: '▲', down: '▼', dot: '●' } as const

/**
 * How a number's cell is drawn by the rule of its column's conditional format
 * the value meets: the cell's shade, and the rule's icon before the number.
 * Nothing when it meets none.
 */
function highlighter(style: Style | undefined, scheme: ChartColorScheme, ink: Ink) {
  // Mixed once for each hue, not for each cell.
  const inks = new Map<Hue, ReturnType<typeof highlightInk>>()
  return (column: ResultColumn, value: Cell | undefined) => {
    const rule = isNumeric(column) ? highlightOf(style?.highlights?.[column.name], value) : undefined
    if (!rule) return undefined
    if (!inks.has(rule.color)) inks.set(rule.color, highlightInk(rule.color, scheme, ink))
    const colors = inks.get(rule.color)!
    return {
      background: colors.background,
      icon: rule.icon && <span aria-hidden="true" style={{ color: colors.icon, fontSize: '0.75em', marginRight: 4 }}>{glyphs[rule.icon]}</span>,
    }
  }
}

/**
 * A header cell whose right edge can be dragged to set the column's width.
 * The width follows the pointer while dragging and is handed on when let go.
 */
function HeaderCell({ column, width, onResize, style, children, ...rest }: { column?: string; width?: number; onResize?: (column: string, width: number) => void; style: CSSProperties; children: ReactNode } & Omit<ThHTMLAttributes<HTMLTableCellElement>, 'style' | 'children'>) {
  const cell = useRef<HTMLTableCellElement>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const shown = dragging ?? width
  return (
    <th ref={cell} {...rest} style={{ ...style, position: style.position ?? 'relative', ...(shown ? { width: shown, minWidth: shown, maxWidth: shown } : {}) }}>
      {children}
      {onResize && column && (
        <span
          role="separator"
          aria-orientation="vertical"
          aria-label={column}
          style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: 6, cursor: 'col-resize', touchAction: 'none' }}
          // Setting a width is not picking the header.
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => {
            event.preventDefault()
            const start = event.clientX
            const from = cell.current?.getBoundingClientRect().width ?? width ?? 120
            const clamp = (value: number) => Math.round(Math.min(maxWidth, Math.max(minWidth, value)))
            const move = (e: PointerEvent) => setDragging(clamp(from + e.clientX - start))
            const up = (e: PointerEvent) => {
              window.removeEventListener('pointermove', move)
              window.removeEventListener('pointerup', up)
              setDragging(null)
              onResize(column, clamp(from + e.clientX - start))
            }
            window.addEventListener('pointermove', move)
            window.addEventListener('pointerup', up)
          }}
        />
      )}
    </th>
  )
}

/**
 * A group's name being written in its header. Enter or leaving the field
 * keeps what was written; Escape keeps the name as it was.
 */
function GroupName({ label, accent, surface, onDone }: { label: string; accent: string; surface: string; onDone: (label?: string) => void }) {
  // Enter and then the blur it brings must not both end the edit.
  const done = useRef(false)
  const finish = (value?: string) => {
    if (done.current) return
    done.current = true
    onDone(value)
  }
  return (
    <input
      autoFocus
      defaultValue={label}
      aria-label={label}
      maxLength={maxGroupLabel}
      onFocus={(event) => event.currentTarget.select()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Enter') finish(event.currentTarget.value)
        if (event.key === 'Escape') finish()
      }}
      onBlur={(event) => finish(event.currentTarget.value)}
      style={{ boxSizing: 'border-box', width: '100%', minWidth: 60, height: headerLine, margin: 0, padding: 0, border: 0, outline: `1px solid ${accent}`, background: surface, color: 'inherit', font: 'inherit', lineHeight: `${headerLine}px`, textAlign: 'center' }}
    />
  )
}

/**
 * The rows as they came, with the chart's hidden columns omitted. An
 * aggregated table can end in the database's grand total.
 */
export function Table({ viz, result, scheme, surface, locale, firstWeekDays, height, label, texts, onColumnResize, onCellSelect, selectableColumns, cellSelections, headerEditing, pageKey }: TableProps) {
  const ink = inkFor(scheme, surface)
  const style = viz.style
  // Keep original indexes: visibility never changes row values or grouping.
  const columns = result.columns.map((column, index) => ({ column, index })).filter(({ column }) => !viz.hiddenColumns?.includes(column.name))
  const shown = new Map(columns.map(({ column }) => [column.name, column]))
  const headerRows = toHeaderRows(
    layoutColumns(
      viz.columnGroups,
      headerEditing?.columns ?? result.columns.map((column) => column.name),
    ),
    (name) => shown.has(name),
  )
  const { cell, background, frozen, align } = cellStyles(style, ink)
  const highlight = highlighter(style, scheme, ink)
  const grand = result.totals?.find((total) => total.by.length === 0)
  const rowHeight = headerRowHeight(style?.density ?? 'normal')

  // A page of the rows already taken, see .agents/design/chart-dashboard.md §2.7. Automatic pages hold as many rows as fit
  // under the header and over the totals, the bar under the table and a horizontal scrollbar, if there is one.
  const paged = style?.paging === 'pages' || style?.paging === 'auto'
  const box = useRef<HTMLDivElement>(null)
  const [scrollbar, setScrollbar] = useState(0)
  // Whether the table is wider than its box depends on the rows, the columns and their widths.
  useLayoutEffect(() => {
    if (style?.paging !== 'auto' || !box.current) return
    const bar = box.current.offsetHeight - box.current.clientHeight
    if (bar !== scrollbar) setScrollbar(bar)
  }, [style?.paging, scrollbar, height, result, viz])
  const footHeight = grand || result.meta?.totalsOmitted ? rowHeight + 1 : 0
  const perPage = style?.paging === 'auto' ? Math.max(1, Math.floor((height - pagerHeight - headerRows.length * rowHeight - footHeight - scrollbar) / rowHeight)) : (style?.pageSize ?? defaultPageSize)
  // The row a page starts from is kept, not the page's number: when automatic pages hold more or fewer rows, the page
  // shown is the one with the rows being read.
  const [paging, setPaging] = useState({ key: pageKey, from: 0 })
  const pages = Math.max(1, Math.ceil(result.rows.length / perPage))
  // Rows that answer something else start again from the first page; fewer of the same rows keep the last there is.
  const page = Math.min(Math.floor((paging.key === pageKey ? paging.from : 0) / perPage), pages - 1)
  const first = paged ? page * perPage : 0
  const rows = paged ? result.rows.slice(first, first + perPage) : result.rows
  const turn = (next: number) => {
    setPaging({ key: pageKey, from: next * perPage })
    if (box.current) box.current.scrollTop = 0
  }
  // Back on the first page for rows that answer something else, at its top too.
  useLayoutEffect(() => {
    if (paged && box.current) box.current.scrollTop = 0
  }, [paged, pageKey])
  const spans = style?.merge ? toMergedSpans(columns, rows) : undefined
  const totalOf = (column: ResultColumn): Cell | undefined => {
    const at = grand?.columns.findIndex((other) => other.name === column.name) ?? -1
    return at < 0 ? undefined : (grand!.rows[0]?.[at] ?? null)
  }
  const head: CSSProperties = { ...cell, position: 'sticky', top: 0, zIndex: 2, background: ink.tableHeader, color: ink.text, fontWeight: 600, borderBottom: `1px solid ${ink.axis}` }
  // A group's line stops short of its ends, so groups side by side read as separate.
  const groupLine = `linear-gradient(${ink.axis}, ${ink.axis}) center bottom / calc(100% - 12px) 1px no-repeat`
  const accent = hueColor('blue', scheme)
  const isPicked = (path: number[]) => headerEditing?.selected.some((picked) => picked.length === path.length && picked.every((index, i) => index === path[i])) ?? false
  const picking = (path: number[]): ThHTMLAttributes<HTMLTableCellElement> =>
    headerEditing
      ? {
          tabIndex: 0,
          'aria-selected': isPicked(path),
          onClick: (event) => headerEditing.onSelect(path, event.shiftKey),
          onKeyDown: (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            headerEditing.onSelect(path, event.shiftKey)
          },
        }
      : {}
  const pickedLook = (path: number[], under: string): CSSProperties =>
    isPicked(path) ? { background: `${under ? `${under}, ` : ''}color-mix(in srgb, ${accent} 22%, ${ink.tableHeader})`, boxShadow: `inset 0 0 0 1px ${accent}` } : {}
  const table = (
    <div ref={box} style={{ maxHeight: paged ? Math.max(height - pagerHeight, rowHeight) : height, overflow: 'auto' }}>
      <table aria-label={label} style={{ width: 'max-content', minWidth: '100%', borderCollapse: 'separate', borderSpacing: 0, fontSize: 13, color: ink.text }}>
        <thead>
          {headerRows.map((row, level) => (
            <tr key={level}>
              {row.map((header) => {
                if (header.kind === 'group') {
                  const renaming = headerEditing?.renaming?.join() === header.path.join()
                  return (
                    <th
                      key={header.path.join()}
                      scope="colgroup"
                      colSpan={header.colSpan}
                      {...picking(header.path)}
                      onDoubleClick={headerEditing && (() => headerEditing.onRenameStart(header.path))}
                      style={{ ...head, top: level * rowHeight, borderBottom: '1px solid transparent', background: `${groupLine}, ${ink.tableHeader}`, textAlign: 'center', cursor: headerEditing ? 'pointer' : undefined, ...pickedLook(header.path, groupLine) }}
                    >
                      {renaming ? <GroupName label={header.label} accent={accent} surface={ink.surface} onDone={(name) => headerEditing!.onRename(header.path, name)} /> : header.label}
                    </th>
                  )
                }
                const column = shown.get(header.name)!
                return (
                  <HeaderCell
                    key={header.name}
                    column={header.name}
                    scope="col"
                    rowSpan={header.rowSpan > 1 ? header.rowSpan : undefined}
                    width={style?.widths?.[header.name]}
                    onResize={onColumnResize}
                    {...picking(header.path)}
                    style={{ ...head, top: level * rowHeight, ...frozen(header.name === columns[0]?.column.name, true), textAlign: align(column), verticalAlign: 'bottom', cursor: headerEditing ? 'pointer' : undefined, ...pickedLook(header.path, '') }}
                  >
                    {column.label ?? column.name}
                  </HeaderCell>
                )
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {columns.map(({ column, index: originalIndex }, i) => {
                // A merged cell is written once at the top of its run, without the stripes it would cross.
                const span = spans?.[i]?.[index]
                if (span === 0) return null
                const value = row[originalIndex] ?? null
                const selected = cellSelections !== undefined && column.name in cellSelections && JSON.stringify(cellSelections[column.name]) === JSON.stringify(value)
                // A shaded cell is drawn without the stripe it would have.
                const shade = highlight(column, value)
                return <td key={column.name} rowSpan={span} style={{ ...cell, ...frozen(i === 0), background: shade?.background ?? (span === undefined ? background(index) : ink.surface), verticalAlign: span === undefined ? undefined : 'top', textAlign: align(column), fontVariantNumeric: 'tabular-nums' }}>
                  {shade?.icon}
                  {onCellSelect && selectableColumns?.includes(column.name) ? <button type="button" aria-pressed={selected}
                    style={{ color: 'inherit', font: 'inherit', fontWeight: selected ? 700 : undefined, background: 'none', border: 0, cursor: 'pointer', textDecoration: 'underline', padding: 0 }}
                    onClick={(event) => {
                      // From the keyboard there is no pointer: what it offers opens below the value.
                      const box = event.currentTarget.getBoundingClientRect()
                      onCellSelect(column.name, value, event.detail === 0 ? { x: box.left, y: box.bottom } : { x: event.clientX, y: event.clientY })
                    }}>{value === '' ? '""' : formatCell(value, column, locale, firstWeekDays)}</button> : formatCell(value, column, locale, firstWeekDays)}
                </td>
              })}
            </tr>
          ))}
        </tbody>
        {(grand || result.meta?.totalsOmitted) && (
          <tfoot>
            <tr>
              {result.meta?.totalsOmitted ? (
                <td colSpan={columns.length} style={{ ...cell, color: ink.textSecondary, background: ink.surface }}>{texts.totalsOmitted}</td>
              ) : (
                columns.map(({ column }, i) => {
                  const value = column.role === 'measure' ? totalOf(column) : undefined
                  return (
                    <td key={column.name} style={{ ...cell, ...frozen(i === 0), position: 'sticky', bottom: 0, zIndex: i === 0 && style?.freeze ? 3 : 2, background: ink.surface, borderTop: `1px solid ${ink.axis}`, fontWeight: 600, textAlign: align(column), fontVariantNumeric: 'tabular-nums' }}>
                      {/* Over fewer groups than there are, the total, which is of all of them, says so. */}
                      {i === 0 && column.role !== 'measure' ? (result.meta?.truncated ? texts.totalOfAll : texts.total) : value === undefined ? '' : formatCell(value, column, locale, firstWeekDays)}
                    </td>
                  )
                })
              )}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  )
  if (!paged) return table
  const count = (n: number) => n.toLocaleString(locale)
  return (
    <div>
      {table}
      <Pager page={page} pages={pages} count={count} label={label} range={rows.length ? texts.rowRange(count(first + 1), count(first + rows.length), count(result.rows.length), Boolean(result.meta?.truncated)) : texts.noRows} ink={ink} texts={texts} onTurn={turn} />
    </div>
  )
}

/** The bar under a paged table: which rows are shown, and turning the page. */
function Pager({ page, pages, count, label, range, ink, texts, onTurn }: { page: number; pages: number; count: (n: number) => string; label: string; range: string; ink: Ink; texts: ChartTexts; onTurn: (page: number) => void }) {
  const turn = (label: string, to: number, glyph: string) => {
    const disabled = to < 0 || to >= pages
    return (
      <button type="button" aria-label={label} disabled={disabled} onClick={() => onTurn(to)}
        style={{ display: 'grid', placeItems: 'center', width: 24, height: 24, padding: 0, border: 0, borderRadius: 4, background: 'none', color: ink.text, opacity: disabled ? 0.35 : 1, cursor: disabled ? 'default' : 'pointer', font: 'inherit', fontSize: 16, lineHeight: 1 }}>
        {glyph}
      </button>
    )
  }
  return (
    // A group named after its table, not a landmark: a dashboard of paged tables would list one for each, all alike.
    <div role="group" aria-label={`${label} · ${texts.pages}`} style={{ boxSizing: 'border-box', height: pagerHeight, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, padding: '0 4px', fontSize: 12, color: ink.textSecondary, whiteSpace: 'nowrap' }}>
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', marginRight: 6 }}>{range}</span>
      {turn(texts.previousPage, page - 1, '‹')}
      <span style={{ color: ink.text, fontVariantNumeric: 'tabular-nums' }}>{texts.pageOf(count(page + 1), count(pages))}</span>
      {turn(texts.nextPage, page + 1, '›')}
    </div>
  )
}

/**
 * A pivot table: the row dimensions down the side, the column dimensions
 * across the top, a cell for each measure where they meet. Repeated values
 * of an outer dimension are written once, spanning the rows or columns they
 * head; a group's subtotal comes after it, and the total after everything.
 */
export function Pivot({ viz, result, scheme, surface, locale, firstWeekDays, height, label, texts, onColumnResize }: TableProps) {
  const ink = inkFor(scheme, surface)
  const style = viz.style
  const { cell, background, frozen, align } = cellStyles(style, ink)
  const highlight = highlighter(style, scheme, ink)
  const { rows, columns, measures, rowLines, columnLines, cells } = toPivot(viz, result)
  const named = (column: ResultColumn) => column.label ?? column.name
  const measureRow = measures.length > 1 || columns.length === 0
  const headerRows = columns.length + (measureRow ? 1 : 0)
  const head: CSSProperties = { ...cell, background: ink.tableHeader, color: ink.text, fontWeight: 600, borderBottom: `1px solid ${ink.axis}`, position: 'sticky', zIndex: 2 }
  const total: CSSProperties = { fontWeight: 600, background: `linear-gradient(color-mix(in srgb, ${ink.text} 6%, transparent), color-mix(in srgb, ${ink.text} 6%, transparent)), ${ink.surface}` }
  const rowHeight = headerRowHeight(style?.density ?? 'normal')
  const top = (level: number): CSSProperties => ({ top: level * rowHeight })
  const value = (cellValue: Cell | undefined, measure: ResultColumn) => (cellValue === undefined ? '' : formatCell(cellValue, measure, locale, firstWeekDays))
  const totalLine = rowLines.at(-1)?.depth === 0 && rows.length > 0 ? rowLines.at(-1) : undefined
  const bodyLines = totalLine ? rowLines.slice(0, -1) : rowLines
  // What heads a subtotal or the total: the value of the group it closes, or that it is the total.
  const totalName = (line: PivotLine, dimensions: ResultColumn[]) => (line.depth === 0 ? texts.total : texts.subtotal(formatCell(line.key[line.depth - 1], dimensions[line.depth - 1]!, locale, firstWeekDays)))

  // A header at `level` spans a group's data and the subtotals of its inner groups, not its own subtotal.
  const inSpan = (line: PivotLine, level: number, full: number) => line.depth === full || line.depth > level + 1
  const same = (a: PivotLine, b: PivotLine, level: number) => JSON.stringify(a.key.slice(0, level + 1)) === JSON.stringify(b.key.slice(0, level + 1))
  const starts = (lines: PivotLine[], at: number, level: number, full: number) => inSpan(lines[at]!, level, full) && (at === 0 || !inSpan(lines[at - 1]!, level, full) || !same(lines[at - 1]!, lines[at]!, level))
  const span = (lines: PivotLine[], at: number, level: number, full: number) => {
    let n = 1
    while (at + n < lines.length && inSpan(lines[at + n]!, level, full) && same(lines[at + n]!, lines[at]!, level)) n++
    return n
  }
  const isData = (line: PivotLine, full: number) => line.depth === full
  const lineKey = (line: PivotLine) => JSON.stringify([line.depth, line.key])

  return (
    <div style={{ maxHeight: height, overflow: 'auto' }}>
      <table aria-label={label} style={{ width: 'max-content', minWidth: '100%', borderCollapse: 'separate', borderSpacing: 0, fontSize: 13, color: ink.text }}>
        <thead>
          {Array.from({ length: Math.max(headerRows, 1) }, (_, level) => {
            const isMeasureRow = measureRow && level === headerRows - 1
            return (
              <tr key={level}>
                {level === 0 &&
                  rows.map((row, i) => (
                    <HeaderCell key={row.name} column={row.name} scope="col" rowSpan={Math.max(headerRows, 1)} width={style?.widths?.[row.name]} onResize={onColumnResize} style={{ ...head, ...top(0), ...frozen(i === 0, true), zIndex: i === 0 && style?.freeze ? 4 : 2, textAlign: 'left', verticalAlign: 'bottom' }}>
                      {named(row)}
                    </HeaderCell>
                  ))}
                {isMeasureRow
                  ? columnLines.flatMap((line) =>
                      measures.map((measure) => {
                        const data = isData(line, columns.length)
                        return (
                          <HeaderCell key={`${lineKey(line)}:${measure.name}`} column={data ? measure.name : undefined} scope="col" width={data ? style?.widths?.[measure.name] : undefined} onResize={data ? onColumnResize : undefined} style={{ ...head, ...top(level), ...(data ? {} : total), textAlign: align(measure) }}>
                            {named(measure)}
                          </HeaderCell>
                        )
                      }),
                    )
                  : columnLines.map((line, at) => {
                      if (starts(columnLines, at, level, columns.length))
                        return (
                          <th key={lineKey(line)} scope="colgroup" colSpan={span(columnLines, at, level, columns.length) * measures.length} style={{ ...head, ...top(level), textAlign: 'center' }}>
                            {formatCell(line.key[level], columns[level]!, locale, firstWeekDays)}
                          </th>
                        )
                      // A subtotal or the total is named once, at the level of the group it closes, down to the measures.
                      if (!isData(line, columns.length) && level === Math.max(line.depth - 1, 0))
                        return (
                          <th key={lineKey(line)} scope="colgroup" colSpan={measures.length} rowSpan={columns.length - level} style={{ ...head, ...top(level), ...total, textAlign: 'center' }}>
                            {totalName(line, columns)}
                          </th>
                        )
                      return null
                    })}
              </tr>
            )
          })}
        </thead>
        <tbody>
          {bodyLines.map((line, index) => {
            const data = isData(line, rows.length)
            return (
              <tr key={lineKey(line)}>
                {data
                  ? rows.map((row, depth) =>
                      starts(bodyLines, index, depth, rows.length) ? (
                        <th key={row.name} scope="row" rowSpan={span(bodyLines, index, depth, rows.length)} style={{ ...cell, ...frozen(depth === 0), background: ink.surface, fontWeight: 400, textAlign: 'left', verticalAlign: 'top' }}>
                          {formatCell(line.key[depth], row, locale, firstWeekDays)}
                        </th>
                      ) : null,
                    )
                  : (
                      <th scope="row" colSpan={rows.length - line.depth + 1} style={{ ...cell, ...frozen(line.depth === 1), ...total, textAlign: 'left' }}>
                        {totalName(line, rows)}
                      </th>
                    )}
                {columnLines.flatMap((column, at) =>
                  measures.map((measure, m) => {
                    const inData = data && isData(column, columns.length)
                    // Subtotals and totals are not shaded: a threshold for a city means nothing for a region.
                    const shade = inData ? highlight(measure, cells[index]![at]![m]) : undefined
                    return (
                      <td key={`${lineKey(column)}:${measure.name}`} style={{ ...cell, background: shade?.background ?? background(index), ...(inData ? {} : total), textAlign: align(measure), fontVariantNumeric: 'tabular-nums' }}>
                        {shade?.icon}
                        {value(cells[index]![at]![m], measure)}
                      </td>
                    )
                  }),
                )}
              </tr>
            )
          })}
        </tbody>
        {(totalLine || result.meta?.totalsOmitted) && (
          <tfoot>
            <tr>
              {result.meta?.totalsOmitted ? (
                <td colSpan={rows.length + columnLines.length * measures.length} style={{ ...cell, color: ink.textSecondary, background: ink.surface }}>{texts.totalsOmitted}</td>
              ) : (
                <Fragment>
                  <th scope="row" colSpan={Math.max(rows.length, 1)} style={{ ...cell, ...frozen(true), ...total, position: 'sticky', bottom: 0, zIndex: style?.freeze ? 3 : 2, borderTop: `1px solid ${ink.axis}`, textAlign: 'left' }}>
                    {texts.total}
                  </th>
                  {columnLines.flatMap((column, at) =>
                    measures.map((measure, m) => (
                      <td key={`${lineKey(column)}:${measure.name}`} style={{ ...cell, ...total, position: 'sticky', bottom: 0, zIndex: 2, borderTop: `1px solid ${ink.axis}`, textAlign: align(measure), fontVariantNumeric: 'tabular-nums' }}>
                        {value(cells[rowLines.length - 1]![at]![m], measure)}
                      </td>
                    )),
                  )}
                </Fragment>
              )}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  )
}

const sizes = { small: { label: 12, value: 22 }, normal: { label: 13, value: 30 }, large: { label: 15, value: 44 } } as const

/**
 * KPI tiles: the first row of each measure. A tile compared with another
 * measure says how far it is above or below it, with an arrow, so the
 * colour is never all that says which way.
 */
export function Tiles({ viz, result, scheme, surface, locale, firstWeekDays, texts }: { viz: Viz; result: QueryResult; scheme: ChartColorScheme; surface?: string; locale?: string; firstWeekDays?: number; texts: ChartTexts }) {
  const ink = inkFor(scheme, surface)
  const style = viz.style
  const size = sizes[style?.size ?? 'normal']
  const center = style?.textAlign === 'center'
  const as = style?.compareAs ?? 'percent'
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'center', justifyContent: center ? 'center' : 'flex-start', height: '100%' }}>
      {toComparedTiles(viz, result).map((tile) => {
        const value = toNumber(tile.value)
        const reference = tile.reference ? toNumber(tile.reference.value) : null
        const change = value !== null && reference !== null ? value - reference : null
        const share = change !== null && reference ? change / Math.abs(reference) : null
        const rising = change !== null && change > 0
        const falling = change !== null && change < 0
        const color = rising ? (style?.redUp ? ink.down : ink.up) : falling ? (style?.redUp ? ink.up : ink.down) : ink.textSecondary
        const percent = share === null ? '—' : `${(Math.abs(share) * 100).toFixed(1)}%`
        const difference = change === null ? '—' : formatNumber(Math.abs(change), tile.column.format, locale)
        const written = as === 'diff' ? difference : as === 'both' ? `${difference}（${percent}）` : percent
        return (
          <div key={tile.column.name} style={{ minWidth: 0, textAlign: center ? 'center' : 'left' }}>
            <div style={{ fontSize: size.label, color: ink.textSecondary }}>{tile.label}</div>
            <div style={{ fontSize: size.value, fontWeight: 600, lineHeight: 1.25, color: ink.text }}>{formatCell(tile.value, tile.column, locale, firstWeekDays)}</div>
            {tile.reference && (
              <div style={{ fontSize: size.label, marginTop: 2, color: ink.textSecondary, fontVariantNumeric: 'tabular-nums' }}>
                <span style={{ color, fontWeight: 600 }}>
                  <span aria-hidden="true">{rising ? '▲ ' : falling ? '▼ ' : ''}</span>
                  {written}
                </span>{' '}
                {texts.compareWith(tile.reference.label, rising ? 'up' : falling ? 'down' : 'flat')}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
