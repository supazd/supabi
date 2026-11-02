import {
  createPaginatedRowModel,
  createSortedRowModel,
  flexRender,
  rowPaginationFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
} from '@tanstack/react-table'
import { cn } from 'cn'
import { ArrowDownIcon, ArrowUpIcon, ChevronLeftIcon, ChevronRightIcon, ChevronsUpDownIcon, Loader2Icon } from 'lucide-react'
import { useMemo, type ReactNode } from 'react'
import { useStrings } from './locale'
import { Button as BaseButton } from './shadcn/button.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './shadcn/table.tsx'

export interface DataTableColumn<Row> {
  key: string
  title: ReactNode
  /** Numbers read best right-aligned. */
  align?: 'left' | 'right'
  render: (row: Row) => ReactNode
  width?: number
  /** A class on the column's heading and on each of its cells, for a column that is to look apart from the rest. */
  className?: string
  /** Orders two rows by this column. When given, clicking the column's title sorts the rows by it. */
  sort?: (a: Row, b: Row) => number
  /** What a cell of this column is as text. When given, double-clicking a cell hands it to onCopy. */
  text?: (row: Row) => string
}

export interface DataTableProps<Row> {
  columns: DataTableColumn<Row>[]
  rows: Row[]
  rowKey: (row: Row, index: number) => string
  /** Shown instead of rows when there are none. */
  empty?: ReactNode
  loading?: boolean
  /** Rows per page; omit to show every row. */
  pageSize?: number
  /** Called with the text of a cell that was double-clicked, to be copied. */
  onCopy?: (text: string) => void
  'aria-label'?: string
}

const features = tableFeatures({
  rowSortingFeature,
  rowPaginationFeature,
  sortedRowModel: createSortedRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
})

/** The pages to offer: the first, the last, and those around the current one, with gaps between. */
function pagesAround(current: number, count: number): (number | 'gap')[] {
  const shown = [...new Set([0, current - 1, current, current + 1, count - 1])].filter((page) => page >= 0 && page < count).sort((a, b) => a - b)
  return shown.flatMap((page, index) => (index > 0 && page - shown[index - 1]! > 1 ? ['gap' as const, page] : [page]))
}

/** Read-only table. */
export function DataTable<Row extends object>({ columns, rows, rowKey, empty, loading, pageSize, onCopy, 'aria-label': ariaLabel }: DataTableProps<Row>) {
  const t = useStrings()
  const paged = pageSize !== undefined && rows.length > pageSize
  const columnDefs = useMemo(
    () =>
      columns.map((column) => ({
        id: column.key,
        // TanStack sorts only columns with an accessor; the row itself is what the column's sort compares.
        accessorFn: (row: Row) => row,
        header: () => column.title,
        cell: ({ row }: { row: { original: Row } }) => column.render(row.original),
        enableSorting: Boolean(column.sort),
        // Ascending first, then descending, then as given.
        sortDescFirst: false,
        sortFn: column.sort && ((a: { original: Row }, b: { original: Row }) => column.sort!(a.original, b.original)),
      })),
    [columns],
  )
  const table = useTable({
    features,
    columns: columnDefs,
    data: rows,
    getRowId: (row, index) => rowKey(row, index),
    initialState: { pagination: { pageIndex: 0, pageSize: pageSize ?? 10 } },
  })
  const byKey = new Map(columns.map((column) => [column.key, column]))
  const visible = paged ? table.getRowModel().rows : table.getSortedRowModel().rows
  const { pageIndex } = table.state.pagination
  const pageCount = paged ? table.getPageCount() : 1

  return (
    <div className="lb-table tw:relative tw:min-w-0" aria-busy={loading || undefined}>
      <Table aria-label={ariaLabel} className="tw:w-max tw:min-w-full">
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id} className="tw:hover:bg-transparent">
              {group.headers.map((header) => {
                const column = byKey.get(header.column.id)!
                const sorted = header.column.getIsSorted()
                return (
                  <TableHead
                    key={header.id}
                    data-align={column.align}
                    aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}
                    className={cn('tw:h-9 tw:bg-muted/70 tw:px-2.5 tw:text-xs tw:font-semibold tw:text-muted-foreground', column.sort && 'tw:cursor-pointer tw:select-none', column.align === 'right' && 'tw:text-right', column.className)}
                    style={column.width ? { width: column.width } : undefined}
                    // The whole heading sorts; the button inside is what the keyboard reaches, and its click comes up here.
                    onClick={column.sort ? header.column.getToggleSortingHandler() : undefined}
                  >
                    {column.sort ? (
                      <button
                        type="button"
                        className={cn('tw:inline-flex tw:cursor-pointer tw:items-center tw:gap-1 tw:border-0 tw:bg-transparent tw:p-0 tw:font-medium tw:text-inherit', column.align === 'right' && 'tw:flex-row-reverse')}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {sorted === 'asc' ? <ArrowUpIcon className="tw:size-3.5" aria-hidden="true" /> : sorted === 'desc' ? <ArrowDownIcon className="tw:size-3.5" aria-hidden="true" /> : <ChevronsUpDownIcon className="tw:size-3.5 tw:text-muted-foreground" aria-hidden="true" />}
                      </button>
                    ) : (
                      flexRender(header.column.columnDef.header, header.getContext())
                    )}
                  </TableHead>
                )
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {visible.length === 0 ? (
            <TableRow className="tw:hover:bg-transparent">
              <TableCell colSpan={columns.length} className="tw:h-24 tw:text-center tw:text-muted-foreground">
                {loading ? null : (empty ?? t.noData)}
              </TableCell>
            </TableRow>
          ) : (
            visible.map((row) => (
              <TableRow key={row.id}>
                {row.getAllCells().map((cell) => {
                  const column = byKey.get(cell.column.id)!
                  return (
                    <TableCell
                      key={cell.id}
                      data-align={column.align}
                      className={cn('tw:px-2.5 tw:py-1.5 tw:tabular-nums', column.align === 'right' && 'tw:text-right', column.className)}
                      onDoubleClick={column.text && onCopy ? () => onCopy(column.text!(row.original)) : undefined}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  )
                })}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      {loading && (
        <div className="tw:absolute tw:inset-0 tw:flex tw:items-center tw:justify-center tw:bg-background/50" role="status" aria-label={t.loading}>
          <Loader2Icon className="tw:size-5 tw:animate-spin tw:text-primary" aria-hidden="true" />
        </div>
      )}
      {paged && (
        <nav className="lb-pagination tw:flex tw:items-center tw:justify-end tw:gap-1 tw:py-2" aria-label={ariaLabel}>
          <BaseButton variant="ghost" size="icon-sm" className="tw:size-6" aria-label={t.previousPage} disabled={!table.getCanPreviousPage()} onClick={() => table.previousPage()}>
            <ChevronLeftIcon aria-hidden="true" />
          </BaseButton>
          {pagesAround(pageIndex, pageCount).map((page, index) =>
            page === 'gap' ? (
              <span key={`gap-${index}`} className="tw:px-1 tw:text-muted-foreground" aria-hidden="true">
                …
              </span>
            ) : (
              <BaseButton
                key={page}
                variant={page === pageIndex ? 'outline' : 'ghost'}
                size="sm"
                className="tw:h-6 tw:min-w-6 tw:px-1.5 tw:tabular-nums"
                aria-label={t.page.replace('{n}', String(page + 1))}
                aria-current={page === pageIndex ? 'page' : undefined}
                onClick={() => table.setPageIndex(page)}
              >
                {page + 1}
              </BaseButton>
            ),
          )}
          <BaseButton variant="ghost" size="icon-sm" className="tw:size-6" aria-label={t.nextPage} disabled={!table.getCanNextPage()} onClick={() => table.nextPage()}>
            <ChevronRightIcon aria-hidden="true" />
          </BaseButton>
        </nav>
      )}
    </div>
  )
}
